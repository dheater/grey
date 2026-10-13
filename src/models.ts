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
