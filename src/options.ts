import type { Options } from "@anthropic-ai/claude-agent-sdk" with {
  "resolution-mode": "import",
};

import { BEDROCK_MODEL_IDS, EffortLevel } from "./models";

// Per-run limits, so one runaway run cannot spend a week's budget.
export const MAX_TURNS = 80;

// The tools a skill may call. Everything else Claude Code ships stays off.
const READ_TOOLS = ["Read", "Glob", "Grep"];

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
