import { RunRecorder, type SdkMessage } from "./recorder";
import { BEDROCK_MODEL_IDS } from "./models";

const SONNET = BEDROCK_MODEL_IDS["sonnet5.5"];
const OPUS = BEDROCK_MODEL_IDS["opus5.5"];

type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

describe("RunRecorder", () => {
  test("subtracts its baseline per model", () => {
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

function success(text: string, modelUsage: Record<string, Usage>): SdkMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    modelUsage,
  };
}
