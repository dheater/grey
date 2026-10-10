# Build `grey`: a read-only navigator you talk to through `$EDITOR`

## Goal
Running `grey` in a workspace starts one read-only Claude session. Every message you send and every reply you read sits in a file that `grey` opens in `$EDITOR`, so you write and read with full vim and newlines need no tricks. `:model` and `:effort` switch the model and effort mid-session. Every turn appends carl-schema events to `~/.config/grey/events.jsonl`.

## Steps

### Decisions taken from carl
- **No chat prompt. The editor is the only input.**
  - Each turn, `grey` writes `.agent/grey/turn.md` and opens `$EDITOR` on it.
  - You write above a scissors line and `:wq` to send.
  - The last reply sits below the line.
  - Everything from the scissors line down is dropped, as in `git commit --cleanup=scissors`, so vim users know the flow already.
  - This replaces both carl's readline loop (`../carl/src/mentor.ts:122-166`) and the earlier session plan's `> ` prompt.
- **Never strip `#` lines from a message.** carl's `collectPrompt` drops every line starting with `#` (`../carl/src/editor.ts:113-116`), which eats markdown headings. The scissors line is the only cut.
- **Never lose a typed message.** If a turn fails or a directive is unknown, the editor reopens with your text still above the line and the error below it.
- **The model gets only `Read`, `Glob` and `Grep`. No `Bash`, no sandbox.**
  - carl's read-only sandbox denies writes to the workspace (`../carl/src/claude-runner.ts:94`).
  - Every `jj` command snapshots the working copy and takes a lock under `.jj/`, so the sandbox refuses it. This planning session hit exactly that error running `jj log` in `../grey`.
  - A mentor turn needs the diff, and `jj diff` would fail. Instead, `grey`'s own process, which has no sandbox, runs `getGitDiff` (`../carl/src/git.ts:100-120`, jj first) and attaches the diff.
  - With no tool that writes or runs commands, the sandbox and `failIfUnavailable` have nothing left to guard.
- **One process is one session.** Keep `persistSession: false`, `settingSources: []` and `includeGitInstructions: false` (`../carl/src/claude-runner.ts:76-82`). Quitting `grey` is how you start a clean context. `.agent/grey/transcript.md` carries the history.
- **Per-turn usage needs a baseline.** In a streaming session, the result's `modelUsage` and `total_cost_usd` are running totals ("cumulative across turns in streaming-input sessions", `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:5679-5691`). `RunRecorder.usage` (`../carl/src/claude-runner.ts:325-333`) would bill turn 1 again on every later turn. Subtract the previous result's `modelUsage` per model.
- **The model and effort are session state the human changes.**
  - `:model <alias>` calls `query.setModel(BEDROCK_MODEL_IDS[alias])`. The default is `sonnet5.5`.
  - `:effort <level>` calls `applyFlagSettings({ effortLevel })`. `default` maps to `null`.
  - Both stay in force until changed again. The status line shows the current model and effort.
- **Skills are per-turn instructions, not persona sections.**
  - The system prompt holds `rules/*.md`, the workspace root and `AGENTS.md`. It never changes during the session.
  - A `:plan` or `:review` turn prepends `# Skill: <name> (this reply only)` and the skill body to that message.
  - A bare message is a mentor turn. Its rules already sit in the system prompt as `rules/grey.md`.
- **No retry loop.** The SDK already retries model requests (the `api_retry` message, `../carl/src/claude-runner.ts:244`). Pushing a failed message again would duplicate it in the transcript. Keep `isPoisonedSession` (`../carl/src/skill.ts:830-835`). On that error, end the session and tell the human to rerun `grey`.
- **Keep carl's event schema byte for byte.** The fields are `timestamp, run_id, invocation_id, event, subject, duration_ms, skill, model, effort, workspace, git_branch, git_sha, meta` (`../carl/src/skill.ts:126-140`).
  - With the same schema, carl's `metrics-db.ts` ingests `grey` events almost unchanged.
  - `run_id` is one turn and `invocation_id` is one session. Ordering by `started_at` within an `invocation_id` gives the turn index, so no new field is needed.
- **CommonJS with a dynamic `import()` of the SDK**, as in `../carl/src/claude-runner.ts:406-409`. Rejected: native ESM, because jest under ESM costs more setup than it saves.
- **Build milestone 1 with carl as it is today.** `carl code` can still write files (`../carl/src/carl.ts:581-601`), and `grey` never will. From milestone 2 on, run `grey` as navigator while you type.

### Findings behind the model and skill decisions
- The SDK switches models mid-session. `Query.setModel(model?)` will "Change the model used for subsequent responses", in streaming input mode only (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2891-2896`).
- `Query.applyFlagSettings({ effortLevel })` sets effort mid-session. `null` resets it to the model's default (`sdk.d.ts:2935`, `:2951-2953`).
- The SDK's `EffortLevel` is `'low' | 'medium' | 'high' | 'xhigh' | 'max'` (`sdk.d.ts:691`). That matches carl's `EFFORT_LEVELS` (`../carl/src/types.ts:7-14`) without `default`.
- `modelUsage` is keyed by model. The per-model baseline subtraction above already gives correct per-turn usage across a switch.
- The scaffold already exists in this repo: `package.json`, `tsconfig.json`, `tsconfig.test.json`, `jest.config.js`, `build.mjs`, `justfile`. `node_modules` is installed too, with the SDK at 0.3.289, the same version as `../carl`.

### Milestone 1: the smallest `grey` that can navigate its own build

1.1 **Install.**
- Run `npm install`.
- Check: `just build` emits `dist/grey.mjs`, and `node dist/grey.mjs --version` prints the version.

1.2 **`src/session.ts`.**
- `buildQueryOptions({ workspaceRoot, modelId, persona, effort })`:
  - `tools` and `allowedTools` are `["Read", "Glob", "Grep"]`.
  - `permissionMode: "dontAsk"`.
  - Carry over `maxTurns` and the Bedrock `env` block (`../carl/src/claude-runner.ts:96-105`). Leave out the budget cap, as listed under Dropped from carl.
  - No `sandbox` key.
- `RunRecorder(modelId, onProgress, onToolCall, baseline?)`: copy `../carl/src/claude-runner.ts:211-362`. When summing usage, subtract `baseline[model]` from each `modelUsage[model]`. Expose `resultModelUsage()` so the next turn can take it as its baseline.
- `describeFailure`: the max-turns message says "End grey and start a new session" instead of "Split the request" (`:366-369`). Drop the budget message.
- `class Session`:
  - The constructor takes `{ workspaceRoot, model, effort, persona, query? }`. It starts `query({ prompt: inbox, options })` once, as in `../carl/src/mentor.ts:92-103`.
  - `send(message, { onProgress, onToolCall }): Promise<{ text, usage }>` pushes the message to the inbox.
  - It reads messages until the next `result`, feeding each into a fresh `RunRecorder` built on the stored baseline and the current model id.
  - It throws `AgentRunError` on failure, as in `../carl/src/claude-runner.ts:430-433`, and updates the baseline either way.
  - `setModel(alias)` calls `query.setModel(BEDROCK_MODEL_IDS[alias])` and stores the alias and id. An unknown alias throws carl's error (`../carl/src/carl.ts:48-52`) without the config hint, and calls nothing.
  - `setEffort(level)` calls `query.applyFlagSettings({ effortLevel })`, with `null` for `default`, and stores the level.
  - Both run between turns: after one `result` and before the next `inbox.push`.
  - `close()` closes the inbox and the query.
- Check: the `session.test.ts` tests pass.

1.3 **`src/editor.ts`.**
- `SCISSORS = "# ------------------------ >8 ------------------------"`.
- `buildTurnFile({ draft, reply, status })` produces, in order:
  - the draft (empty on a fresh turn);
  - a blank line, then `SCISSORS`;
  - one hint line: `# Above: your message. :wq sends. Empty, :q or :cq ends grey. Lines starting :plan, :review, :model <name>, :effort <level> come first.`;
  - a blank line, the reply, a blank line, the status.
- `parseTurnFile(text)` returns the text above the first line equal to `SCISSORS`, trimmed.
- `editTurn(file, parts): Promise<string | null>`:
  - Write the file and run the editor with `child_process.spawn` and `stdio: "inherit"`, then await `exit`.
  - Do not use `spawnSync`. It blocks the event loop while the SDK child process is alive.
  - A non-zero exit (`:cq`) returns `null`. So does an empty message or a message of exactly `:q`.
  - With no tty, throw the error from `../carl/src/editor.ts:95-100`, reworded for `grey`.

1.4 **`src/prompt.ts`.**
- `loadRules()`: every `rules/*.md`, sorted. Load all of them, which removes carl's per-skill rule tables (`../carl/src/skill.ts:210-242`).
- `loadSkill(name)` returns `skills/<name>.md`. `listSkills()` returns the `skills/*.md` base names.
- `buildPersona(workspaceRoot)` returns, in order:
  - `# Rules` with every `rules/*.md` file;
  - `# Workspace` with the workspace root;
  - `AGENTS.md`, when it exists, as in `../carl/src/skill.ts:505-515`.
- `class Attachments` remembers a hash per key. `take(key, text)` returns the text when it changed since the last call and `null` otherwise. Two keys use it: `diff` and `plan`.
- `buildTurnMessage({ skill, skillBody, body, diff, plan, branch })` joins these, separated by `---`:
  - `# Skill: <name> (this reply only)` and the skill body, on skill turns only;
  - `# Current plan`, when `plan` is set;
  - `# Working-copy diff`, when `diff` is set;
  - `Branch: <name>`, on review turns only;
  - `# Message` with the body.

1.5 **Skill and rule files.** These are in their final form:
- `rules/grey.md` holds the mentor rules, merged from carl's `ask` and `mentor` skills. It loads with every other rules file.
- `skills/plan.md` and `skills/review.md` have no frontmatter. `skills/review.md` states the ticket-prefix rule.
- `skills/mentor.md` and `skills/ask.md` are gone.
- Check: `rg -n '^---$' skills` finds nothing, and `ls skills` shows only `plan.md` and `review.md`.

1.6 **`src/events.ts` and `src/cost.ts`.**
- `getConfigDir()` reads `GREY_CONFIG_DIR`, falling back to `~/.config/grey`.
- `writeEvent` appends one JSON line (`../carl/src/skill.ts:418-423`).
- `INVOCATION_ID` is a `randomUUID()` taken at module load.
- `formatStatus(session)` returns one line, for example `[opus5.5 high · turn 7 · 43 requests · 84k context · $1.42]`:
  - the current model alias and effort;
  - turn count;
  - total model requests;
  - context: the last `turnPromptTokens` of the last turn;
  - cost: the sum of `computeCost` over all turns.
- The request count matters because carl's failures cluster past 40 requests (`../carl/docs/one-shot.md:166-181`).

1.7 **`src/loop.ts`.**
- `parseDirectives(text, skills)` reads the leading lines that start with `:`. It returns `{ skill, model, effort, body }` or `{ error }`:
  - The skill names come from `listSkills()`. At most one skill directive per message.
  - The first line that does not start with `:` begins the body. Later lines starting with `:` stay in the body.
  - An unknown directive or a second skill returns `{ error }`.
- `runTurn(session, ctx, skill, message)`:
  - Emit `tool_call` events through `onToolCall` and progress lines to stderr, as in `../carl/src/skill.ts:936-949`.
  - Then emit one `prompt` event with `persona_chars` (0 after the first turn), `instruction_chars`, `response_chars` and `usage`.
  - Then emit one `skill` event with `status` and, on error, `usage`. Its `model` and `effort` fields carry that turn's settings.
  - For `plan`, also write the reply to `.agent/notes/plan.md`, reply text only.
  - Append `## You`, the message, `## grey (<skill>, <model>)`, the reply and the status line to `.agent/grey/transcript.md`.
- `runSession(workspaceRoot, model, effort)`:
  - Build the `Session`, then loop on `editTurn`.
  - Run `parseDirectives` on each message. On `{ error }`, reopen the editor with the draft kept and the directive list below the line.
  - Apply `:model` and `:effort` through `session.setModel` and `session.setEffort` before the turn. When the body is empty and no skill is given, send no turn: reopen the editor, and the status line shows the new setting.
  - A message with no skill directive is a `mentor` turn.
  - Before each turn, call `attachments.take("diff", getGitDiff(...))`. Cap the diff at 40,000 characters and append a line naming the cut.
  - A `review` turn always attaches the diff and `Branch: <name>`. A `plan` turn always attaches `plan.md`. Either way, call `take` afterwards so the next turn does not send the same text again.
  - On a thrown error, show it below the line and keep the draft.
  - If `isPoisonedSession` matches, print the reason and end the session.
  - Close the session in a `finally`.

1.8 **`src/grey.ts`.**
- `grey [--model m] [--effort e]` runs `runSession`.
- The default model is `sonnet5.5` at effort `default`.
- An unknown model gets carl's error message (`../carl/src/carl.ts:44-53`) without the config hint.

1.9 **Check by hand before writing tests for the loop.**
- Run `grey` with `EDITOR=vi`, then `EDITOR=nvim`. Send three turns.
- Confirm the editor gets the tty while the SDK child is alive.
- Read `num_turns` from each result to learn whether `maxTurns` counts per message or across the whole session. Then set `MAX_TURNS`.
- Send a turn, then `:model opus5.5`, then another turn. Confirm the second result's `modelUsage` is keyed by the opus id.
- Repeat with `:effort high` on `haiku5.5`. Record whether the SDK rejects it.

### Milestone 2: plan, review and model switching
- Run `:plan` with a goal and confirm `.agent/notes/plan.md` is written. A later bare-text turn should see `# Current plan` only after you edit the file.
- Run `:review` and confirm the diff and `Branch:` reach the model, and that the proposed commit message follows the ticket-prefix rule.
- Run `:model opus5.5` alone. Confirm no turn is sent, the status line shows `opus5.5`, and the next transcript heading names it.
- Write the README:
  - why the editor is the interface;
  - the scissors file and `:plan`, `:review`, `:model` and `:effort`;
  - how to end and restart a session;
  - the nvim recipe from the Risks section.

## Tests
- `src/session.test.ts`:
  - `Inbox` tests, copied from `../carl/src/mentor.test.ts`;
  - `buildQueryOptions` offers exactly `Read`, `Glob` and `Grep`, sets `persistSession: false` and `settingSources: []`, and has no `Bash`, `Edit` or `Write`;
  - `buildQueryOptions` has no `maxBudgetUsd`;
  - `RunRecorder` subtracts its baseline per model;
  - with a fake `query`, two `send` calls report per-turn tokens, not running totals;
  - two turns on two models report per-turn usage for each;
  - a failed result throws `AgentRunError` carrying that turn's usage;
  - `setModel("sonnet5.5")` calls the fake query's `setModel` with `us.anthropic.claude-sonnet-5-5`;
  - an unknown alias throws and calls nothing;
  - `setEffort("default")` sends `effortLevel: null`.
- `src/editor.test.ts`:
  - `parseTurnFile` keeps markdown `#` headings above the scissors line;
  - it drops everything from the first scissors line down;
  - an empty message returns `""`;
  - `buildTurnFile` then `parseTurnFile` returns the draft unchanged;
  - `splitCommand` cases, copied from `../carl/src/editor.test.ts`.
- `src/prompt.test.ts`:
  - `buildPersona` contains every rules file and no skill file;
  - `Attachments.take` returns text once, `null` while it is unchanged, and text again after a change;
  - `buildTurnMessage` adds the skill header only on skill turns, and the branch only on review turns.
- `src/loop.test.ts`, with a fake `Session` and `GREY_CONFIG_DIR` set to a temp dir:
  - `parseDirectives` handles `:model x` with no body, `:plan` plus a body, two skills (error), an unknown `:word` (error), and a body line starting with `:` after the first plain line, which stays in the body;
  - a model-only message sends no turn;
  - one turn writes `prompt`, `skill` and `tool_call` events that share `run_id` and `invocation_id`;
  - the `skill` event carries the model of that turn;
  - `persona_chars` is 0 on turn 2;
  - a `review` turn attaches an unchanged diff;
  - a `plan` turn writes `.agent/notes/plan.md`. A `mentor` or `review` turn writes no notes file;
  - an unknown directive sends nothing and keeps the draft.

## Out of scope
- **Changing carl.** The carl session plan this file replaces is superseded. carl stays as it is and builds milestone 1.
- **Write tools or a `:code` mode.** `grey` navigates and the human drives.
- **A config file.** Flags and defaults cover one user. Add `~/.config/grey/config.json` when a second setting appears.
- **Per-skill default models.** Rejected under "The model and effort are session state the human changes".
- **Session resume** through `persistSession: true` and the SDK's `resume`. Quitting still clears the context. Revisit if losing a long session hurts.
- **`grey stats`**, the carl stats modules, and comparing carl with grey. `ingestFile` (`../carl/src/metrics-db.ts:728`) could load both logs later. Events keep accruing in carl's schema, so this can come later with data.
- **Renaming `rules/carl.md`** and its `# CARL` heading. The implementer decides.
- **Ctrl-C to stop a turn.** `Query.interrupt()` exists (`sdk.d.ts:2860`).
- **Opening the turn file in the nvim you already run** rather than a nested one. See Risks.
- **Benchmarks.** carl's `bench` grades `carl code` on fixture tasks, which does not fit a read-only interactive tool.

## Risks
- **nvim inside nvim.**
  - `EDITOR="nvim --server … --remote"` returns at once, so `editTurn` would read an empty message and end the session.
  - The working recipe is a plain `nvim` as `$EDITOR`, with `grey` running in a separate terminal or a `:terminal` split. The split means nvim nested inside nvim.
  - Neither `nvr` nor `tmux` is installed here. nvim 0.12.4's `--help` lists `--remote[-subcommand]`, but I did not check whether `--remote-wait` works. Check `:help --remote-wait` before planning any "use my running nvim" work.
- **Cursor position.** A vim config that restores the last cursor position on `BufReadPost` will open `turn.md` in the reply area. If that happens, pass `+1` to vi-family editors or use a new file name per turn.
- **`setModel` with a Bedrock profile id.** I did not check that it works. Step 1.9 checks it before any test depends on it.
- **Session cost.**
  - Each turn re-sends the whole transcript. After a pause longer than the cache lifetime, the next turn pays cache-write rates on all of it (`../carl/docs/one-shot.md:62-73`).
  - Each model switch sends the whole history uncached to the new model.
  - The status line is the only guard. With no budget cap, nothing stops a runaway session. If that worries the implementer, set `maxBudgetUsd` high, but know that hitting it ends the session.
- **Mentor rules in a plan turn.** The mentor rules sit in the system prompt during plan and review turns. The `(this reply only)` header should let the skill shape win. If replies blend the two modes, move the mentor rules into bare-turn messages instead.
- **Effort per model.** `applyFlagSettings` may reject an effort a model does not support. carl reports `UNSUPPORTED_REASONING_EFFORT` from the runtime (`../carl/src/types.ts:2-6`), while the SDK says `max` runs as `high` on a model without it (`sdk.d.ts:2946-2948`). The error should show below the scissors line with the draft kept.
- **Large diffs.** A full diff goes out on every turn where the working copy changed. The 40,000-character cap is a guess, and the implementer should tune it from the `instruction_chars` field in the events.
- **No `Bash`.** The model cannot run `jj log` or `rg`. If mentor turns keep asking for history, attach `jj log -r 'ancestors(@, 5)'` the same way as the diff. Do not give the model `Bash` back.
- **Not read:**
  - the parts of `../carl/src/claude-runner.ts` this plan does not cite;
  - the carl stats modules;
  - how `maxTurns` counts in streaming mode;
  - every carl test file;
  - your nvim `keymaps.lua`.

## Files
`../carl/...` marks carl source to copy from. `carl` is another agent harness that serves as inspiration for `grey`.

- `src/session.ts`: `Inbox` (`../carl/src/mentor.ts:43-82`), `buildQueryOptions`, `RunRecorder` with a baseline, `describeFailure`, `oneLine`, `BEDROCK_MODEL_IDS`, `isPoisonedSession`, and the new `class Session` with `send`, `setModel(alias)`, `setEffort(level)` and `close`. `Session` holds the current model id and passes it to each turn's `RunRecorder`.
- `src/editor.ts`: `splitCommand`, `getEditorCommand`, `isInteractive` (`../carl/src/editor.ts:6-63`), plus new `editTurn`, `buildTurnFile` and `parseTurnFile`.
- `src/prompt.ts`: `loadRules`, `loadSkill`, `listSkills`, `buildPersona(workspaceRoot)`, `buildTurnMessage`, `Attachments`.
- `src/events.ts`: `getConfigDir`, `EVENTS_LOG_FILE`, `INVOCATION_ID`, `writeEvent`, and the `TimingEvent` and meta types.
- `src/cost.ts`: `MODEL_RATES`, `RATES_FINGERPRINT`, `computeCost` (`../carl/src/skill.ts:574-659`), and `formatStatus`.
- `src/vcs.ts`: copy `../carl/src/git.ts` and drop `detectGit` if nothing calls it.
- `src/loop.ts`: `parseDirectives`, `runTurn` and `runSession`, the editor loop.
- `src/grey.ts`: `main`, `usage`, flag parsing (`--model`, `--effort`, `--version`).

