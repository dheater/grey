import type {
  Query,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk" with {
  "resolution-mode": "import",
};

import {
  BEDROCK_MODEL_IDS,
  EffortLevel,
  isModelAlias,
  ModelAlias,
} from "./models";

import { buildQueryOptions, MAX_TURNS } from "./options";

import {
  type ContentBlock,
  type ModelUsage,
  RunRecorder,
  type SdkMessage,
  ToolCallEvent,
  TurnUsage,
  UsageSummary,
} from "./recorder";

class AgentRunError extends Error {
  readonly usage: UsageSummary;

  constructor(message: string, usage: UsageSummary) {
    super(message);
    this.name = "AgentRunError";
    this.usage = usage;
  }
}

/** Attaches rather than wraps so transient-fetch detection keeps working. */
function attachUsage<E>(err: E, usage: UsageSummary): E {
  if (err && typeof err === "object" && !("usage" in err)) {
    (err as { usage?: UsageSummary }).usage = usage;
  }
  return err;
}

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
