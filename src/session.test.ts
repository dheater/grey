import type { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk" with {
  "resolution-mode": "import",
};

import {
  AgentRunError,
  BEDROCK_MODEL_IDS,
  Inbox,
  RunRecorder,
  Session,
  buildQueryOptions,
  type SdkMessage,
} from "./session";

const SONNET = BEDROCK_MODEL_IDS["sonnet5.5"];
const OPUS = BEDROCK_MODEL_IDS["opus5.5"];

const READ_TOOLS = ["Read", "Glob", "Grep"];

function content(result: IteratorResult<{ message: { content: string } }>) {
  return result.done ? "done" : result.value.message.content;
}
type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

function assistant(id: string, input: number, output: number): SdkMessage {
  return {
    type: "assistant",
    message: {
      id,
      content: [{ type: "text", text: "working" }],
      usage: { input_tokens: input, output_tokens: output },
    },
  };
}

function success(text: string, modelUsage: Record<string, Usage>): SdkMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    modelUsage,
  };
}

function failure(modelUsage: Record<string, Usage>): SdkMessage {
  return {
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    modelUsage,
  };
}

/**
 * A stand-in for the SDK's `query`. Each message the session pushes into the
 * inbox gets the next scripted turn back. A push with no script left throws,
 * so a wrong test fails fast instead of waiting forever.
 */
function fakeQuery(turns: SdkMessage[][]) {
  const calls = {
    options: undefined as unknown,
    prompts: [] as string[],
    setModel: [] as Array<string | undefined>,
    applyFlagSettings: [] as unknown[],
    close: 0,
  };
  const query = ((params: {
    prompt: AsyncIterable<{ message: { content: string } }>;
    options?: unknown;
  }) => {
    calls.options = params.options;
    async function* run() {
      let i = 0;
      for await (const input of params.prompt) {
        calls.prompts.push(input.message.content);
        const turn = turns[i++];
        if (!turn) throw new Error(`fake query has no script for turn ${i}`);
        for (const m of turn) yield m;
      }
    }
    return Object.assign(run(), {
      setModel: async (model?: string) => {
        calls.setModel.push(model);
      },
      applyFlagSettings: async (settings: unknown) => {
        calls.applyFlagSettings.push(settings);
      },
      close: () => {
        calls.close += 1;
      },
    });
  }) as unknown as typeof sdkQuery;
  return { query, calls };
}

const sessions: Session[] = [];

function newSession(turns: SdkMessage[][]) {
  const fake = fakeQuery(turns);
  const session = new Session({
    workspaceRoot: "/work",
    model: "sonnet5.5",
    effort: "default",
    persona: "persona",
    query: fake.query,
  });
  sessions.push(session);
  return { session, calls: fake.calls };
}

afterEach(() => {
  for (const s of sessions.splice(0)) s.close();
});

describe("Inbox", () => {
  test("a message pushed before anyone else reads it waits in the queue", async () => {
    const inbox = new Inbox();
    inbox.push("first");
    inbox.push("second");
    const it = inbox[Symbol.asyncIterator]();
    expect(content(await it.next())).toBe("first");
    expect(content(await it.next())).toBe("second");
  });

  test("a reader waiting on an empty inbox gets the next push", async () => {
    const inbox = new Inbox();
    const it = inbox[Symbol.asyncIterator]();
    const pending = it.next();
    inbox.push("hello");
    const result = await pending;
    expect(result.done).toBe(false);
    expect(content(result)).toBe("hello");
  });

  test("close ends a waiting reader", async () => {
    const inbox = new Inbox();
    const it = inbox[Symbol.asyncIterator]();
    const pending = it.next();
    inbox.close();
    expect((await pending).done).toBe(true);
  });

  test("close still delivers what was queued, then ends", async () => {
    const inbox = new Inbox();
    inbox.push("last");
    inbox.close();
    const it = inbox[Symbol.asyncIterator]();
    expect(content(await it.next())).toBe("last");
    expect((await it.next()).done).toBe(true);
  });

  describe("buildQueryOptions", () => {
    const options = buildQueryOptions({
      workspaceRoot: "/work",
      modelId: SONNET,
      effort: "default",
      persona: "persona",
    });

    test("offers only read-only and keeps no session state", () => {
      expect(options.tools).toEqual(READ_TOOLS);
      expect(options.allowedTools).toEqual(READ_TOOLS);
      expect(options).toMatchObject({
        persistSession: false,
        settingSources: [],
        settings: { includeGitInstructions: false },
        permissionMode: "dontAsk",
      });
      expect(options).not.toHaveProperty("sandbox");
    });

    test("sets no budget cap", () => {
      expect(options).not.toHaveProperty("maxDudgetUsd");
    });
  });
});

describe("runRocorder", () => {
  test("subtracts its baseloine per model", () => {
    const recorder = new RunRecorder(OPUS, undefined, undefined, {
      [SONNET]: { inputTokens: 100, outputTokens: 10 },
      [OPUS]: { inputTokens: 20, outputTokens: 2 },
    });
    const totals = {
      [SONNET]: { inputTokens: 130, outputTokens: 14 },
      [OPUS]: { inputTokens: 50, outputTokens: 5 },
    };
    recorder.record(success("ok", totals));
    expect(recorder.usage()).toMatchObject({
      inputTokens: 60,
      outputTokens: 7,
    });
    expect(recorder.resultModelUsage()).toEqual(totals);
  });
});

describe("Session", () => {
  test("hands the SDK the read-only options", () => {
    const { calls } = newSession([]);
    expect(calls.options).toMatchObject({
      cwd: "/work",
      model: SONNET,
      systemPrompt: "persona",
      tools: READ_TOOLS,
    });
  });

  test("two sends report per-turn tokens, not running totals", async () => {
    const { session, calls } = newSession([
      [
        assistant("m1", 100, 10),
        success("one", { [SONNET]: { inputTokens: 100, outputTokens: 10 } }),
      ],
      [
        assistant("m2", 40, 5),
        success("two", { [SONNET]: { inputTokens: 140, outputTokens: 15 } }),
      ],
    ]);
    const first = await session.send("hello");
    const second = await session.send("again");
    expect(first).toMatchObject({
      text: "one",
      usage: { inputTokens: 100, outputTokens: 10 },
    });
    expect(second).toMatchObject({
      text: "two",
      usage: { inputTokens: 40, outputTokens: 5 },
    });
  });

  test("two turns on two models report per-turn usage for each", async () => {
    const { session } = newSession([
      [
        assistant("m1", 100, 10),
        success("one", { [SONNET]: { inputTokens: 100, outputTokens: 10 } }),
      ],
      [
        assistant("m2", 60, 6),
        success("two", {
          [SONNET]: { inputTokens: 100, outputTokens: 10 },
          [OPUS]: { inputTokens: 60, outputTokens: 6 },
        }),
      ],
    ]);
    const first = await session.send("hello");
    await session.setModel("opus5.5");
    const second = await session.send("again");
    expect(first.usage).toMatchObject({
      modelId: SONNET,
      inputTokens: 100,
      outputTokens: 10,
    });
    expect(second.usage).toMatchObject({
      modelId: OPUS,
      inputTokens: 60,
      outputTokens: 6,
    });
  });

  test("a failed result throws AgentRunError with that turn's usage", async () => {
    const { session } = newSession([
      [
        assistant("m1", 100, 10),
        success("one", { [SONNET]: { inputTokens: 100, outputTokens: 10 } }),
      ],
      [
        assistant("m2", 40, 10),
        failure({ [SONNET]: { inputTokens: 140, outputTokens: 15 } }),
      ],
      [
        assistant("m3", 20, 2),
        success("three", { [SONNET]: { inputTokens: 160, outputTokens: 17 } }),
      ],
    ]);
  });

  test("setModel sends the alias's Bedrock id", async () => {
    const { session, calls } = newSession([]);
    await session.setModel("sonnet5.5");
    expect(calls.setModel).toEqual(["us.anthropic.claude-sonnet-5-5"]);
  });

  test("an unknown alias throws and calls nothing", async () => {
    const { session, calls } = newSession([]);
    await expect(session.setModel("gpt5")).rejects.toThrow(
      'Model "gpt5" is not a known Bedrock model.',
    );
    expect(calls.setModel).toEqual([]);
  });

  test("setEffort sends null for default and the level otherwise", async () => {
    const { session, calls } = newSession([]);
    await session.setEffort("default");
    await session.setEffort("high");
    expect(calls.applyFlagSettings).toEqual([
      { effortLevel: null },
      { effortLevel: "high" },
    ]);
  });

  test("close closes the query", () => {
    const { session, calls } = newSession([]);
    session.close();
    expect(calls.close).toBe(1);
  });
});
