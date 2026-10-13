# Build `grey`: a read-only TDD navigator inside nvim

## Goal
`:Grey` in nvim starts a node process through `jobstart`. It holds one read-only mentor session per TDD cycle. `:GreyTest` runs a `just` recipe, shows the output, and sends the result to the mentor as a checkpoint. The first red-to-green in a cycle runs a fresh `review` that writes a refactor checklist you trim. `jj new` ends the cycle and the mentor session with it. Every turn appends carl-schema events to `~/.config/grey/events.jsonl`.

## Steps

### The TDD cycle
1. **Red.** You write a test and run `:GreyTest`. The mentor confirms the test fails for the right reason.
2. **Green.** You write the code and run `:GreyTest`. On the first fail-to-pass in this cycle, `grey` runs a fresh `review` session instead of a mentor checkpoint. It writes `.agent/grey/refactor.md`.
3. **Triage.** You delete the findings you do not want. What is left is the refactor phase.
4. **Refactor.** You work the list, running `:GreyTest` as you go. The mentor tracks the list and calls out regressions.
5. **`jj new`.** The next turn sees a new change id, drops the mentor session and starts a new one.

### Decisions
- **nvim only. The node process is a `jobstart` child that speaks NDJSON on stdin and stdout.**
  - Lua owns the UI: the prompt buffer, the transcript split, the test output buffer and the commands.
  - Node owns the SDK sessions, `jj`, the events log and the transcript file.
  - This replaces the scissors file and `$EDITOR`. `src/editor.ts` and `src/editor.test.ts` are deleted.
  - Rejected: a TUI or a REPL. Prompts in an nvim buffer keep your keybindings.
- **Lua runs the tests. Node never runs a test or a recipe.**
  - `:GreyTest [recipe]` runs `just <recipe>` through `jobstart`, with `test` as the default. Recipe names complete from `just --summary`.
  - Lua sends the exit code, the output and the duration as a `checkpoint` request.
  - The human always triggers a test run. The model has no way to start one.
- **The mentor gets one live session per cycle.**
  - A cycle is one jj change. Before each turn, node reads `jj log -r @ --no-graph -T change_id --ignore-working-copy`. With `--ignore-working-copy`, jj takes no snapshot and no lock.
  - When the change id differs from the one the session started on, node closes the mentor session and starts a new one for this turn.
  - `:GreyNew` drops the mentor session mid-cycle.
  - Sessions start lazily on the first turn that needs them.
- **`plan` and `review` get one fresh session per run, as in carl.** carl's log backs this:
  - 407 priced read-only runs cost $129 (`~/.config/carl/events.jsonl`, 2026-07-21 to 2026-10-13).
  - Rewriting the first-turn prefix in every run cost $5.21 in total.
  - The median gap between runs in one sitting is 8.3 minutes, longer than the 5-minute default cache lifetime.
  - Checkpoints differ: test runs land a minute or two apart, so the mentor's cache stays warm.
- **Review runs once per cycle**: on the first fail-to-pass after the cycle starts. A later pass in the same cycle sends a normal mentor checkpoint. `:GreyReview` runs it again by hand.
  - A first run that passes is not a red-to-green transition. It runs no review, and the mentor flags that the test never failed.
- **You own every file the mentor reads. The model writes nothing.**
  - The test list is the `## Tests` section of `.agent/notes/plan.md`, written as `- [ ]` items. You check items off.
  - `.agent/grey/refactor.md` holds the review reply verbatim. You delete the lines you reject.
  - Node writes both files from replies, and only from `plan` and `review` replies.
- **Each session's system prompt is the rules plus one skill.**
  - `buildPersona(workspaceRoot, skill)` returns `rules/*.md`, then `skills/<skill>.md`, the workspace root and `AGENTS.md`.
  - `skills/mentor.md` comes back, holding the TDD rules. The `## Mentoring` section moves out of `rules/grey.md` into it.
  - This removes the per-turn `# Skill:` header and the risk of mentor rules blending into plan replies.
- **Attachments go only when they changed.** `Attachments.take(key, text)` covers `diff`, `plan` and `refactor`. On a new cycle, node resets `Attachments` and sends `refactor` only after a review in this cycle wrote it. A stale list from the last cycle never reaches the mentor.
- **The diff is the whole cycle: `jj diff --git`.** Each cycle is one change, so no baseline is stored. Cap it at 40,000 characters and append a line naming the cut.
- **Test output keeps the last 8,000 characters.** Lua sets `NO_COLOR=1` and `FORCE_COLOR=0`. Node strips any ANSI escapes that remain. Most runners print failures and the summary last.
- **One request at a time.** Node handles requests in arrival order. A checkpoint sent during a turn waits for it.
- **Never lose a typed message.** Lua clears the prompt buffer on send and keeps the text by request id. On an `error` reply, it puts the text back.
- **The model gets only `Read`, `Glob` and `Grep`. No `Bash`, no sandbox.** Node, which has no sandbox, runs `jj` and attaches the results. This is already in `src/options.ts`.
- **Kept from the earlier plan:**
  - `persistSession: false`, `settingSources: []` and `includeGitInstructions: false`;
  - per-model baseline subtraction for per-turn usage, already in `src/recorder.ts` and `src/session.ts`;
  - `:GreyModel` and `:GreyEffort` as session state the human changes, defaulting to `sonnet5.5` and `default`. A change applies to the live mentor session through `setModel` and `setEffort`, and to every session started after it;
  - no retry loop;
  - carl's event schema byte for byte;
  - CommonJS with a dynamic `import()` of the SDK.
- **A poisoned session drops only the mentor session.** When `isPoisonedSession` (`../carl/src/skill.ts:830-835`) matches, node closes the mentor session and replies with the reason. The next turn starts fresh, and the process stays up.

### Findings behind the decisions
- `Query.setModel` and `Query.applyFlagSettings({ effortLevel })` work mid-session in streaming input mode (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2891-2896`, `:2935`, `:2951-2953`).
- A streaming session's `modelUsage` is cumulative (`sdk.d.ts:5679-5691`). `RunRecorder` already subtracts the baseline.
- nvim stops the jobs it started when it exits, unless they were started with `detach` (`:help jobstart`).
- On this repo: `jj` 0.45.1 accepts `--ignore-working-copy` and `diff --git`. `just --summary` prints the recipe names on one line.
- Steps 1.1 and 1.2 of the earlier plan are done: `src/models.ts`, `src/options.ts`, `src/recorder.ts` and `src/session.ts`, with tests.

### Protocol
One JSON object per line. Every request carries an `id`, and every reply echoes it.

Requests, from Lua to node:
- `{ type: "ask", id, text }`: a question to the mentor.
- `{ type: "checkpoint", id, recipe, exitCode, output, durationMs }`.
- `{ type: "plan", id, text }`.
- `{ type: "review", id }`.
- `{ type: "model", id, alias }` and `{ type: "effort", id, level }`.
- `{ type: "new", id }`.

Replies, from node to Lua:
- `{ type: "progress", id, line }`: a tool call or a retry, as carl prints to stderr.
- `{ type: "reply", id, kind, text, status }`, where `kind` is `mentor`, `plan`, `review` or `setting`.
- `{ type: "error", id, message }`.

Only `src/grey.ts` writes to stdout. Everything else logs to stderr, which Lua shows through `vim.notify` at debug level.

### Milestone 1: mentor and checkpoints

1.3 **Delete the scissors work.** Remove `src/editor.ts` and `src/editor.test.ts`. Remove the `## Mentoring` section from `rules/grey.md`.

1.4 **`src/prompt.ts`.**
- `loadRules()`: every `rules/*.md`, sorted.
- `loadSkill(name)`: `skills/<name>.md`.
- `buildPersona(workspaceRoot, skill)`: `# Rules`, the skill body, `# Workspace` with the root, then `AGENTS.md` when it exists (`../carl/src/skill.ts:505-515`).
- `class Attachments` with `take(key, text)` and `reset()`.
- `buildTurnMessage({ test, diff, plan, refactor, body })` joins these, with `---` between them:
  - `# Test run` with `Recipe: just <name>`, `Result: pass|fail (exit N)`, `Previous run this cycle: pass|fail|none`, then the output;
  - `# Working-copy diff`;
  - `# Current plan`;
  - `# Refactor list`;
  - `# Message` with the body.
  - It skips any part that is `null`.

1.5 **`skills/mentor.md`.** No frontmatter. It holds the `## Mentoring` bullets from `rules/grey.md`, with three changes: drop the scissors-line sentence, drop "Give a snippet only when the snippet is the answer", and drop "For a whole design or implementation, suggest `:plan` and stop". Then add:
- You are the navigator in a TDD pair. The human types every edit.
- Open every checkpoint reply with the phase: `Red`, `Green` or `Refactor`. Judge it from this result, the previous result and the diff.
- Name each violation in one line, then help anyway:
  - production code changed with no failing test for it;
  - a new test passed on its first run;
  - a test failed for the wrong reason, such as a compile error or a typo, not the missing behaviour;
  - the green step did more than the test needs;
  - refactoring while red;
  - a test pinning implementation details, not behaviour.
- Red: quote the failing assertion from the output and say whether it fails for the right reason.
- Green: say whether the code is the least that passes.
- Refactor:
  - Track only the items left in `# Refactor list`. Report them as "N of M left".
  - Speak unprompted only about a regression: a red test, or a bug the refactor adds.
  - Put a new idea in one line under `Later:`, once, and do not raise it again.
  - When the list is empty, say so and say `jj new`.
- Next test: suggest the smallest unchecked item in the plan's `## Tests`. Never rewrite the plan.
- Show as much code as helps, up to whole functions.
- Keep a checkpoint reply to the phase line and a few bullets unless the human asks for more.

1.6 **`src/vcs.ts`.**
- `changeId(root)` runs `jj log -r @ --no-graph -T change_id --ignore-working-copy`.
- `workingDiff(root)` runs `jj diff --git`.
- `capText(text, max, where)` cuts from the end for the diff and from the start for test output, and appends a line naming the cut.
- Use async `execFile`, not `execSync`, so `progress` replies keep flowing during a turn.
- Outside a jj repo, throw: `grey needs a jj repo: \`jj log\` failed in <root>: <stderr>. Run \`jj git init --colocate\` to add jj to a git repo.`

1.7 **`src/cycle.ts`.** Pure state, no I/O.
- `class Cycle` holds `changeId`, `lastResult` (`pass`, `fail` or `null`) and `reviewed`.
- `observe(changeId)` returns `true` and resets the state when the id changed.
- `recordTest(passed)` returns `{ previous, runReview }`. `runReview` is true when `previous` is `fail`, `passed` is true and `reviewed` is false.
- `markReviewed()`.

1.8 **`src/events.ts` and `src/cost.ts`.** As in the earlier plan's step 1.6, with these changes:
- `skill` is `mentor`, `plan` or `review`.
- Every `prompt` event's `meta` carries `change_id`.
- Each checkpoint writes one `test` event: `subject` is the recipe, `duration_ms` comes from Lua, and `meta` has `exit_code` and `output_chars`. These events measure the real gap between test runs, which settles the cache question below.
- `formatStatus` returns, for example, `[sonnet5.5 default · cycle xxpnvkzu · turn 7 · 43 requests · 84k context · $1.42]`. Turn, requests and context belong to the mentor session. Cost is the process total.

1.9 **`src/server.ts`.**
- `parseRequest(line)` returns a typed request or `{ error }` naming the bad field and its value.
- `class Server` takes its dependencies: `createSession`, `vcs`, `writeEvent`, `appendTranscript`, `send` and `workspaceRoot`. Tests pass fakes for all of them.
- `handle(request)` is serialised through one promise chain.
- `ask` and `checkpoint`:
  - Run `observe(changeId)`. On a new cycle, close the mentor session and reset `Attachments`.
  - Call `take` for the diff, the plan and the refactor list. Build the message, send it to the mentor session, and reply with `kind: "mentor"`.
  - A `checkpoint` also calls `recordTest`. When `runReview` is true, run the review path (step 2.2) in place of the mentor turn. Until then, treat `runReview` as false.
- `model` and `effort`: validate, apply to the live mentor session if one exists, store for later sessions, and reply with `kind: "setting"`.
- `new`: close the mentor session and reply with `kind: "setting"`.
- On a thrown error, reply `error`. On `isPoisonedSession`, close the mentor session first.
- Append to `.agent/grey/transcript.md`:
  - `# Cycle <change id>` when a new cycle starts;
  - `## You` and the message, or `## Test run (just <recipe>: pass|fail)`;
  - `## grey (<kind>, <model>)`, the reply and the status line.

1.10 **`src/grey.ts`.**
- Parse `--model`, `--effort` and `--version`.
- If stdin is a TTY, exit 1 with: `grey runs inside nvim through :Grey. Add <repo>/nvim to your runtimepath.`
- Read stdin with `readline`, pass each line to `Server.handle`, and write replies as JSON lines.
- On stdin close, close every session and exit 0.

1.11 **`nvim/plugin/grey.lua` and `nvim/lua/grey/init.lua`.**
- `:Grey` starts `jobstart({ "grey" }, { cwd = root, on_stdout, on_stderr })` once. `root` is `vim.fs.root(0, ".jj")`. It then opens:
  - `.agent/grey/prompt.md` in a split;
  - `.agent/grey/transcript.md` in a split with `autoread`.
- `on_stdout` buffers partial lines, since `jobstart` splits output at arbitrary points. It decodes each complete line with `vim.json.decode`.
- `:GreySend` sends the prompt buffer as `ask`. Map it in your config. The plugin defines no keymaps.
- `:GreyTest [recipe]` runs `just <recipe>` with `stdout_buffered`, `stderr_buffered` and `NO_COLOR=1`. It measures time with `vim.uv.hrtime`, shows the output in a `grey://test` scratch buffer, and sends `checkpoint`.
- `:GreyPlan` sends the prompt buffer as `plan`. `:GreyReview` sends `review`.
- `:GreyModel {alias}`, `:GreyEffort {level}`, `:GreyNew` and `:GreyStop` (`jobstop`).
- On `reply`: run `:checktime` on the transcript and scroll it to the end. Set `vim.g.grey_status` for your statusline. On `kind: "review"`, open `.agent/grey/refactor.md`.
- On `progress`, show the line with `vim.notify`. On `error`, show it at error level and restore the prompt text.

1.12 **Check by hand.**
- In this repo, write a failing test, then `:GreyTest`. Confirm the reply opens with `Red` and quotes the assertion.
- Make it pass, `:GreyTest`, then `jj new`, then `:GreySend` a question. Confirm the transcript shows a new `# Cycle` heading and the status line shows turn 1.
- Read `num_turns` from each result to learn whether `maxTurns` counts per message or across the session. Then set `MAX_TURNS`.
- `:GreyModel opus5.5`, then a turn. Confirm the result's `modelUsage` is keyed by the opus id.
- Quit nvim and confirm no `grey` process is left: `pgrep -fl grey.mjs`.

### Milestone 2: plan, review and the refactor list

2.1 **`plan`.** Start a fresh session with `buildPersona(root, "plan")`, then send the prompt text and the diff. Write the reply to `.agent/notes/plan.md`, close the session, and reply with `kind: "plan"`.
- In `skills/plan.md`, the `## Tests` section becomes `- [ ]` items, one behaviour each, smallest first. Each item names the test file.

2.2 **`review`.** Start a fresh session with `buildPersona(root, "review")`, then send the diff and the last test output. Write the reply to `.agent/grey/refactor.md`, then `markReviewed()`, close the session, and reply with `kind: "review"`.
- In `skills/review.md`, the output is only `- [ ] path:line: <change>` lines, most valuable first, followed by one `Not read:` line. `gF` in nvim jumps to `path:line`.
- Turn on `runReview` in step 1.9.

2.3 **Check by hand.**
- Run `:GreyPlan` with a goal. Check off the first `## Tests` item and confirm the next mentor turn suggests the second.
- Go red, then green. Confirm `refactor.md` opens and no mentor checkpoint runs. Delete one line, `:GreyTest`, and confirm the mentor reports the shorter list.
- Pass again in the same cycle and confirm no second review runs.

2.4 **README.**
- Cover the cycle, the commands, adding `nvim/` to the runtimepath, and mapping `:GreySend`.
- Say that `jj new` ends the mentor session.

## Tests
- `src/prompt.test.ts`:
  - `buildPersona` holds every rules file and only the named skill;
  - `Attachments.take` returns the text once, `null` while it is unchanged, the text again after a change, and the text again after `reset()`;
  - `buildTurnMessage` skips `null` parts and puts `# Message` last.
- `src/cycle.test.ts`:
  - fail then pass returns `runReview: true`;
  - pass on the first run returns `runReview: false`;
  - fail, pass, `markReviewed`, fail, pass returns `runReview: false` the second time;
  - `observe` with a new id resets `lastResult` and `reviewed`.
- `src/vcs.test.ts`:
  - `capText` keeps the end of test output and the start of a diff, and names the cut;
  - `changeId` outside a jj repo throws the message from step 1.6. Use a temp dir.
- `src/server.test.ts`, with fake sessions and vcs, and `GREY_CONFIG_DIR` set to a temp dir:
  - two `ask` requests on the same change id use one session;
  - a changed change id closes the old session and starts a new one;
  - an unchanged diff goes out once;
  - `refactor` is not attached in a new cycle until a review runs;
  - fail then pass runs a review and no mentor turn, and writes `refactor.md`;
  - `model` with an unknown alias replies `error` and changes nothing;
  - a poisoned-session error closes the mentor session and the next `ask` starts a new one;
  - a request sent during a turn is handled after it;
  - one `ask` writes `prompt`, `skill` and `tool_call` events sharing `run_id` and `invocation_id`, with `meta.change_id` set;
  - a `checkpoint` writes one `test` event;
  - `parseRequest` rejects a missing `id` and an unknown `type`.
- Lua has no automated tests. Steps 1.12 and 2.3 cover it.

## Out of scope
- **Logging which refactor findings you kept.**
- **git without jj.** The cycle is a jj change. carl's `git diff HEAD` fallback is not copied.
- **Streaming reply text** through `includePartialMessages`. `progress` lines show the turn is alive.
- **Interrupting a turn.** `Query.interrupt()` exists (`sdk.d.ts:2860`).
- **Running two turns at once**, for example a review alongside a mentor turn.
- **Per-skill default models.** One setting covers every session.
- **Write tools or a code mode.** `grey` navigates and the human drives.
- **A config file, `grey stats` and benchmarks**, as in the earlier plan.
- **Changing carl.**

## Risks
- **The cache lifetime.** The design assumes test runs land within 5 minutes of each other. If the `test` events show longer gaps, each checkpoint pays cache-write rates on the whole session. Check whether the SDK can request the 1-hour cache on Bedrock before tuning anything else. I did not check.
- **Diff growth in long cycles.** Each changed diff goes out whole, so a long cycle sends the same lines many times. If `instruction_chars` climbs, send only the files changed since the last checkpoint.
- **Phase judgement.** The model judges the phase from facts. If it misjudges often, add the changed test files to `# Test run` before adding any harness state machine.
- **Review output format.** If replies stray from `- [ ]` lines, the mentor's "N of M left" breaks. Check the first few `refactor.md` files by hand.
- **`jobstart` line splitting.** A reply larger than one pipe read arrives in pieces. Step 1.11's buffering handles it, and a large review reply tests it.
- **`setModel` with a Bedrock profile id** and **effort per model** are still unchecked, as in the earlier plan. Step 1.12 checks the model.
- **No `Bash`.** If the mentor keeps asking for history, attach `jj log -r 'ancestors(@, 5)'` like the diff. Do not give the model `Bash`.
- **Not read:** your nvim config, `:help channel` beyond `jobstart`, and the carl stats modules.

## Files
`../carl/...` marks carl source to copy from. `carl` is another agent harness that serves as inspiration for `grey`.
