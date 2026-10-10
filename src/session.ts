import type {
  Options,
  Query,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk" with {
  "resolution-mode": "import",
};

/**
 * Effort strings from the model cards. `default` sends no effort, so the model
 * uses its own default, which is adaptive thinking where the model has it. Which
 * levels a given model accepts is the runtime's call: it fails the run with
 * UNSUPPORTED_REASONING_EFFORT for one the model lacks.
 */
export const EFFORT_LEVELS = [
  "default",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return (EFFORT_LEVELS as readonly unknown[]).includes(value);
}

export interface ToolCallEvent {
  tool: string;
  inputSummary?: string;
  outputBytes?: number;
  durationMs?: number;
  error: boolean;
  // The failing result's text, one-lined; absent on success.
  errorMessage?: string;
}

/** One model request's usage, as the provider reported it. */
export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface UsageSummary {
  source: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  latencyMs?: number;
  turns?: number;
  /**
   * The first model request's usage — the cold-start tax.
   *
   * grey starts every run from an empty conversation, so turn 1 pays to
   * establish the whole prefix: persona, workspace context, instruction. A
   * harness that preserved the session across prompts would read most of that
   * from cache instead. The totals cannot separate the two, because a long run
   * writes cache on later turns as well, so the tax is only visible if turn 1 is
   * recorded on its own.
   */
  firstTurn?: TurnUsage;
  /**
   * Billed prompt size per turn — input + cache read + cache write — in request
   * order. The run's context-growth curve, and the counterweight to the tax
   * above: a preserved context starts every curve where the last one ended.
   */
  turnPromptTokens?: number[];
  /**
   * Compactions during the run. Zero on every Bedrock run measured so far, which
   * is itself the finding: one-shot runs do not live long enough to compact.
   */
  compactions?: number;
}

export class AgentRunError extends Error {
  readonly usage: UsageSummary;

  constructor(message: string, usage: UsageSummary) {
    super(message);
    this.name = "AgentRunError";
    this.usage = usage;
  }
}

/** Attaches rather than wraps so transient-fetch detection keeps working. */
export function attachUsage<E>(err: E, usage: UsageSummary): E {
  if (err && typeof err === "object" && !("usage" in err)) {
    (err as { usage?: UsageSummary }).usage = usage;
  }
  return err;
}

/**
 * grey's model aliases mapped to Bedrock catalog ids.
 *
 * The ids are `us.`-prefixed inference profiles because a bare `anthropic.*` id
 * has no on-demand throughput on Bedrock and cannot be invoked at all. The
 * prefix names a cross-region profile, which is priced at the in-region rate
 * with no transfer fee, so routing is free to spread across
 * us-east-1/us-east-2/us-west-2.
 *
 * Grey prices its own runs, and MODEL_RATES is keyed on these ids.
 */
export const BEDROCK_MODEL_IDS = {
  "sonnet5.5": "us.anthropic.claude-sonnet-5-5",
  "haiku5.5": "us.anthropic.claude-haiku-5-5",
  "opus5.5": "us.anthropic.claude-opus-5-5",
} as const;

export type ModelAlias = keyof typeof BEDROCK_MODEL_IDS;

export function isModelAlias(s: string): s is ModelAlias {
  return Object.hasOwn(BEDROCK_MODEL_IDS, s);
}

// The source every run records.
export const USAGE_SOURCE = "claude-bedrock";

// Per-run limits, so one runaway run cannot spend a week's budget.
export const MAX_TURNS = 80;

// The tools a skill may call. Everything else Claude Code ships stays off.
const READ_TOOLS = ["Read", "Glob", "Grep"];

// Minimal shapes for the SDK messages carl reads; the SDK union is larger.
type ContentBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

type MessageUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type ModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

export type SdkMessage = {
  type?: string;
  subtype?: string;
  message?: {
    id?: string;
    content?: string | ContentBlock[];
    usage?: MessageUsage;
  };
  attempt?: number;
  max_retries?: number;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  terminal_reason?: string;
  modelUsage?: Record<string, ModelUsage>;
};

interface SessionOptions {
  workspaceRoot: string;
  model: ModelAlias;
  effort: EffortLevel;
  persona: string;
  query: typeof sdkQuery;
}

export class Session {
  private modelId: string;
  private model: ModelAlias;
  private effort: EffortLevel;
  private readonly inbox = new Inbox();
  private readonly q: Query;
  private replies: AsyncIterator<unknown>;
  private baseline: Record<string, ModelUsage> = {};

  constructor(opts: SessionOptions) {
    this.model = opts.model;
    this.modelId = BEDROCK_MODEL_IDS[opts.model];
    this.effort = opts.effort;
    this.q = opts.query({
      prompt: this.inbox,
      options: buildQueryOptions({
        workspaceRoot: opts.workspaceRoot,
        modelId: this.modelId,
        persona: opts.persona,
        effort: opts.effort,
      }),
    });
    this.replies = this.q[Symbol.asyncIterator]();
  }

  static async create(opts: Omit<SessionOptions, "query">): Promise<Session> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    return new Session({ ...opts, query });
  }

  async send(
    message: string,
    {
      onProgress,
      onToolCall,
    }: {
      onProgress?: (line: string) => void;
      onToolCall?: (event: ToolCallEvent) => void;
    } = {},
  ): Promise<{ text: string; usage: UsageSummary }> {
    const started = Date.now();
    const recorder = new RunRecorder(
      this.modelId,
      onProgress,
      onToolCall,
      this.baseline,
    );
    recorder.start();
    this.inbox.push(message);

    try {
      while (true) {
        const next = await this.replies.next();
        if (next.done) break;
        const m = next.value as SdkMessage;
        recorder.record(m);
        if (m.type === "result") break;
      }
    } catch (err) {
      throw attachUsage(err, recorder.usage(Date.now() - started));
    } finally {
      this.baseline = recorder.resultModelUsage();
    }

    const usage = recorder.usage(Date.now() - started);
    const outcome = recorder.outcome();
    if ("failure" in outcome) throw new AgentRunError(outcome.failure, usage);
    return { text: outcome.text, usage };
  }

  async setModel(alias: string): Promise<void> {
    if (!isModelAlias(alias)) {
      throw new Error(
        `Model "${alias}" is not a known Bedrock model.\n` +
          `Bedrock models: ${Object.keys(BEDROCK_MODEL_IDS).join("; ")}`,
      );
    }
    const id = BEDROCK_MODEL_IDS[alias];
    await this.q.setModel(id);
    this.model = alias;
    this.modelId = id;
  }

  async setEffort(level: EffortLevel): Promise<void> {
    await this.q.applyFlagSettings({
      effortLevel: level === "default" ? null : level,
    });
    this.effort = level;
  }

  close() {
    this.inbox.close();
    this.q.close();
  }
}

/**
 * The Agent SDK options
 *
 * - `systemPrompt` is grey's persona and nothing else, so Claude Code's own
 *   prompt does not sit ahead of the rules' `[ABSOLUTE — overrides all]` block.
 * - `settingSources: []` keeps the user's `~/.claude` settings, hooks, and
 *   CLAUDE.md out of the run: grey composes its own workspace context.
 * - `includeGitInstructions: false` drops Claude Code's commit and PR workflow
 *   text from every run's prompt.
 * - `persistSession: false` because the human, not a transcript, carries state
 *   from one run to the next.
 * - `dontAsk` because nothing can answer a prompt mid-run. grey's approval is the editor.
 * - `maxTurns` stop a runaway run before it spends a week's
 *   budget.
 */
export function buildQueryOptions(opts: {
  workspaceRoot: string;
  modelId: string;
  effort: EffortLevel;
  persona: string;
}): Options {
  const { workspaceRoot, modelId, persona, effort } = opts;
  const tools = READ_TOOLS;
  return {
    cwd: workspaceRoot,
    model: modelId,
    systemPrompt: persona,
    settingSources: [],
    settings: { includeGitInstructions: false },
    persistSession: false,
    tools,
    allowedTools: tools,
    permissionMode: "dontAsk",
    maxTurns: MAX_TURNS,
    ...(effort === "default" ? {} : { effort }),
    env: {
      ...process.env,
      CLAUDE_CODE_USE_BEDROCK: "1",
      // Every model is invoked through a us-east-1 inference profile.
      AWS_REGION: "us-east-1",
      // Claude Code's background requests default to a model id Bedrock does
      // not serve; point them at the grey's Haiku profile.
      ANTHROPIC_DEFAULT_HAIKU_MODEL: BEDROCK_MODEL_IDS["haiku5.5"],
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  };
}

type UserMessage = {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
};

/**
 * The questions the human types, as the SDK's streaming input: one live
 * conversation, fed a message at a time, ended by `close()`.
 */
export class Inbox implements AsyncIterable<UserMessage> {
  private readonly queued: UserMessage[] = [];
  private waiting: ((result: IteratorResult<UserMessage>) => void) | undefined;
  private closed = false;

  push(content: string): void {
    const message: UserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    };
    if (this.waiting) {
      this.waiting({ value: message, done: false });
      this.waiting = undefined;
    } else {
      this.queued.push(message);
    }
  }

  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<UserMessage> {
    return {
      next: () => {
        const message = this.queued.shift();
        if (message) return Promise.resolve({ value: message, done: false });
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

/**
 * Folds SDK message stream into what grey records: progress lines as
 * they happen, tool calls as they settle, and the usage summary at the end.
 */
export class RunRecorder {
  private readonly pending = new Map<
    string,
    { tool: string; inputSummary: string; startedAt: number }
  >();
  // Per model request, in request order, keyed by message id.
  private readonly requests = new Map<string, TurnUsage>();
  private compactions = 0;
  private result: SdkMessage | undefined;

  constructor(
    private readonly modelId: string,
    private readonly onProgress?: (line: string) => void,
    private readonly onToolCall?: (event: ToolCallEvent) => void,
    private readonly baseline: Record<string, ModelUsage> = {},
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.onProgress?.("thinking…");
  }

  record(message: SdkMessage): void {
    switch (message.type) {
      case "assistant":
        this.recordAssistant(message);
        return;
      case "user":
        this.recordToolResults(message);
        return;
      case "result":
        this.result = message;
        return;
      case "system":
        if (message.subtype === "api_retry") {
          this.onProgress?.(
            `model request failed, retrying (${message.attempt ?? "?"}/${message.max_retries ?? "?"})…`,
          );
        } else if (message.subtype === "compact_boundary") {
          this.compactions += 1;
          this.onProgress?.("compacted context");
        }
        return;
    }
  }

  private recordAssistant(message: SdkMessage): void {
    const id = message.message?.id;
    const usage = message.message?.usage;
    // The SDK emits one message per content block, all sharing the request's
    // id. Input and cache counts are final on the first; output is not, which
    // is why the run's totals come from the result's modelUsage instead.
    if (id && usage) {
      this.requests.set(id, {
        ...(usage.input_tokens && { inputTokens: usage.input_tokens }),
        ...(usage.output_tokens && { outputTokens: usage.output_tokens }),
        ...(usage.cache_read_input_tokens && {
          cacheReadTokens: usage.cache_read_input_tokens,
        }),
        ...(usage.cache_creation_input_tokens && {
          cacheWriteTokens: usage.cache_creation_input_tokens,
        }),
      });
    }

    for (const block of blocks(message)) {
      if (block.type === "text" && block.text?.trim()) {
        this.onProgress?.(oneLine(block.text, PROGRESS_LIMIT));
      } else if (block.type === "tool_use" && block.id) {
        const tool = (block.name ?? "unknown").toLowerCase();
        this.pending.set(block.id, {
          tool,
          inputSummary: summarizeArguments(block.input),
          startedAt: this.now(),
        });
        this.onProgress?.(
          `${tool} ${summarizeArguments(block.input, PROGRESS_LIMIT)}`,
        );
      }
    }
  }

  private recordToolResults(message: SdkMessage): void {
    let settled = false;
    for (const block of blocks(message)) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      const call = this.pending.get(block.tool_use_id);
      this.pending.delete(block.tool_use_id);
      settled = true;
      const error = block.is_error === true;
      const tool = call?.tool ?? "unknown";
      if (error) this.onProgress?.(`${tool} failed`);
      this.onToolCall?.({
        tool,
        inputSummary: call?.inputSummary ?? "",
        outputBytes: contentBytes(block.content),
        durationMs: call ? this.now() - call.startedAt : undefined,
        error,
        errorMessage: error ? errorText(block.content) : undefined,
      });
    }
    // The next model request starts once every call it is waiting on settles.
    if (settled && this.pending.size === 0) this.onProgress?.("thinking…");
  }

  usage(latencyMs?: number): UsageSummary {
    const usage: UsageSummary = {
      source: USAGE_SOURCE,
      modelId: this.modelId,
      turns: this.requests.size,
    };
    const turns = [...this.requests.values()];
    // A stream that threw has no result, so the per-request counts are the only
    // record of what the run spent. Their output counts may run low.
    const modelUsage = this.result?.modelUsage;
    const totals: TurnUsage[] = modelUsage
      ? Object.entries(modelUsage).map(([model, m]) => {
          const b = this.baseline[model];
          return {
            inputTokens: (m.inputTokens ?? 0) - (b?.inputTokens ?? 0),
            outputTokens: (m.outputTokens ?? 0) - (b?.outputTokens ?? 0),
            cacheReadTokens:
              (m.cacheReadInputTokens ?? 0) - (b?.cacheReadInputTokens ?? 0),
            cacheWriteTokens:
              (m.cacheCreationInputTokens ?? 0) -
              (b?.cacheCreationInputTokens ?? 0),
          };
        })
      : turns;
    const inputTokens = sum(totals.map((m) => m.inputTokens));
    const outputTokens = sum(totals.map((m) => m.outputTokens));
    const cacheReadTokens = sum(totals.map((m) => m.cacheReadTokens));
    const cacheWriteTokens = sum(totals.map((m) => m.cacheWriteTokens));
    if (inputTokens) usage.inputTokens = inputTokens;
    if (outputTokens) usage.outputTokens = outputTokens;
    if (cacheReadTokens) usage.cacheReadTokens = cacheReadTokens;
    if (cacheWriteTokens) usage.cacheWriteTokens = cacheWriteTokens;
    if (turns.length > 0) {
      usage.firstTurn = turns[0];
      usage.turnPromptTokens = turns.map(promptTokens);
    }
    usage.compactions = this.compactions;
    if (latencyMs !== undefined) usage.latencyMs = latencyMs;
    return usage;
  }

  // The final answer, or a failure that names why the run ended without one.
  outcome(): { text: string } | { failure: string } {
    const result = this.result;
    if (!result) return { failure: "The agent ended without a result." };
    if (result.subtype === "success" && !result.is_error) {
      return { text: result.result ?? "" };
    }
    return { failure: describeFailure(result) };
  }

  // The next turn's baseline. A run with no result keeps the old one.
  resultModelUsage(): Record<string, ModelUsage> {
    return this.result?.modelUsage ?? this.baseline;
  }
}

export function describeFailure(result: SdkMessage): string {
  if (result.subtype === "error_max_turns") {
    return `The agent hit its ${MAX_TURNS}-turn limit before finishing the skill. End grey and start a new session.`;
  }
  const reason = result.terminal_reason ?? result.subtype ?? "unknown";
  const detail =
    result.errors?.filter(Boolean).join("; ") ||
    (result.is_error ? result.result : undefined);
  return `The agent turn ended as ${reason}${detail ? `: ${oneLine(detail, 500)}` : ""}`;
}

/** Collapses whitespace and truncates, so any text fits one terminal line. */
export function oneLine(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

/** A one-line stand-in for a tool's arguments, for the tool_call event log. */
function summarizeArguments(args: unknown, limit = 200): string {
  return oneLine(
    typeof args === "string" ? args : JSON.stringify(args ?? ""),
    limit,
  );
}

/** Longest progress line carl prints. */
const PROGRESS_LIMIT = 120;

function blocks(message: SdkMessage): ContentBlock[] {
  const content = message.message?.content;
  return Array.isArray(content) ? content : [];
}

function contentBytes(content: unknown): number {
  if (content === undefined) return 0;
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return Buffer.byteLength(text, "utf-8");
}

/** Text of a failed result, one line, capped. */
function errorText(content: unknown): string | undefined {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block: ContentBlock) =>
              typeof block?.text === "string" ? block.text : "",
            )
            .join(" ")
        : "";
  return text.trim().length > 0 ? oneLine(text, 200) : undefined;
}

function sum(values: Array<number | undefined>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function promptTokens(turn: TurnUsage): number {
  return (
    (turn.inputTokens ?? 0) +
    (turn.cacheReadTokens ?? 0) +
    (turn.cacheWriteTokens ?? 0)
  );
}
