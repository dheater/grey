# Build `grey`: a read-only TDD navigator as a pure Lua nvim plugin

## Goal
`grey` is an nvim plugin. It runs the `claude` CLI through `jobstart`. One read-only mentor session lives for each TDD cycle. `:GreyTest` runs a `just test` recipe and sends the result to the mentor as a checkpoint, but only while `.agent/notes/plan.md` has unchecked tests. The first red-to-green in a cycle runs a fresh `review`, which writes a refactor checklist for you to trim. `jj new` ends the cycle. Every turn appends carl-schema events to `~/.config/grey/events.jsonl`, so cost, speed and quality stay measurable.

## Steps

### The TDD cycle
1. **Plan.** Write your goal in the prompt buffer and run `:GreyPlan`. It writes `.agent/notes/plan.md`, whose `## Tests` section is a `- [ ]` list, one behaviour per cycle.
2. **Red.** Write the test for the first unchecked item and run `:GreyTest`. The mentor confirms it fails for the right reason.
3. **Green.** Write the code and run `:GreyTest`. On the first fail-to-pass transition in this cycle, `grey` runs a fresh `review` in place of a mentor checkpoint. It writes `.agent/notes/refactor.md`.
4. **Triage.** Delete the findings you do not want.
5. **Refactor.** Work the list, running `:GreyTest` as you go. The mentor tracks what is left and calls out regressions.
6. **Close.** Check the item off in `plan.md` and run `jj new`. The next turn sees a new change id and starts a new mentor session.

`:GreyAsk` sends the prompt buffer to the mentor at any time, with or without a plan, and writes the result to `.agent/notes/ask.md`

### Decisions
- **A pure Lua plugin that runs `claude` itself.**
  - The Agent SDK runs this same CLI as a child and passes its JSON lines through. `src/session.ts` and `src/recorder.ts` read those messages today.
  - Rejected: a node process between nvim and `claude`. It would put a second JSON protocol in front of the CLI's own, and only pass messages through.
  - The TypeScript from the earlier step 1.2 gets ported to Lua, then deleted with the node scaffolding.
- **Every session starts with these flags:**
  ```
  claude -p --input-format stream-json --output-format stream-json --verbose
    --tools Read,Glob,Grep --allowed-tools Read,Glob,Grep
    --permission-mode dontAsk --restricted
    --setting-sources "" --no-session-persistence
    --settings '{"includeGitInstructions":false}'
    --system-prompt <persona> --model <bedrock id> [--effort <level>]
  ```
  - **Read-only:** `--tools` is the whole tool list. `--restricted` is a second guard: it strips the tools that run code unless `--tools` names them, ignores user and project settings, and keeps file tools inside the working directory.
  - **No git:** `includeGitInstructions: false` drops Claude Code's commit and PR instructions, as `src/options.ts` does now. With no `Bash`, the model cannot run git anyway.
  - **Bedrock:** the `env` block from `src/options.ts:48-57` goes into `jobstart`'s `env`.
  - `jobstart` takes a list, so the persona needs no shell quoting.
- **Model and effort are session state you change.**
  - `--model` and `--effort` set them at session start. The defaults are `sonnet5.5` and `default`. `default` passes no `--effort`.
  - Mid-session, write control requests, as the SDK does:
    - model: `{"type":"control_request","request_id":<id>,"request":{"subtype":"set_model","model":<id>}}`;
    - effort: `{"subtype":"apply_flag_settings","settings":{"effortLevel":<level or null>}}`.
  - Wait for the `control_response` with the same `request_id`.
  - A change applies to the live mentor session and to every session started after it.
  - Control requests are not a documented interface. If they stop working, restart the mentor session with new flags.
- **One mentor session per cycle. One fresh session per `plan` or `review`.** carl's log backs this split:
  - 407 priced read-only runs cost $129 (`~/.config/carl/events.jsonl`, 2026-07-21 to 2026-10-13).
  - Rewriting the first-turn prefix in every run cost $5.21 in total.
  - The median gap between runs is 8.3 minutes, longer than the 5-minute default cache lifetime. Test runs land a minute or two apart, so the mentor's cache stays warm.
  - `ask` goes to the live mentor session.
  - Rejected: one session shared by `ask`, `plan` and `review`. It would save only the first-turn prefix, about $5 of $129. It would also break two things:
    - The system prompt is fixed at session start, so each skill's rules would need a per-message `# Skill:` header again. That brings back the risk of mentor rules blending into plan replies.
    - `review` would see the mentor's history of the cycle and stop judging the diff with fresh eyes.
- **A cycle is one jj change.**
  - Before each mentor turn, run `jj diff --git`, which snapshots the working copy. Then run `jj log -r @ --no-graph --ignore-working-copy -T 'change_id ++ " " ++ commit_id ++ " " ++ bookmarks'`. Run them in that order so `commit_id` is fresh.
  - A changed change id closes the mentor session and resets the cycle state.
  - `:GreyNew` drops the mentor session mid-cycle.
  - Sessions start lazily.
  - nvim stops non-detached jobs when it exits (`:help jobstart`).
- **The plan gate is hard, and only on checkpoints.**
  - A plan is active when `.agent/notes/plan.md` exists and its `## Tests` section has at least one `- [ ]` item. The path is fixed.
  - Without an active plan, `:GreyTest` still runs the recipe and shows the output. It sends no checkpoint and shows: `No active plan: .agent/notes/plan.md has no unchecked items under ## Tests. Write your goal in the prompt buffer and run :GreyPlan.`
  - `:GreyAsk`, `:GreyPlan` and `:GreyReview` never check the plan.
  - Each mentor message carries `Current test: <first unchecked item>` whenever a plan is active.
- **Review runs once per cycle**, on the first fail-to-pass. A later pass in the same cycle sends a normal checkpoint. `:GreyReview` runs it by hand. A first run that passes runs no review, and the mentor flags that the test never failed.
- **You own every file the mentor reads.** `grey` writes `plan.md` from a `plan` reply and `refactor.md` from a `review` reply. The model writes nothing. You check items off and delete findings.
- **Each session's system prompt is the rules plus one skill:** `rules/*.md`, then `skills/<skill>.md`, the workspace root and `AGENTS.md`.
- **Attachments go only when they changed.** `diff`, `plan` and `refactor` are tracked by hash. A new cycle resets them. `refactor` goes only after a review in this cycle wrote it.
- **Caps:** the diff keeps its first 40,000 characters. Test output keeps its last 8,000. Each cap appends a line naming the cut. The test job runs with `NO_COLOR=1` and `FORCE_COLOR=0`, and ANSI escapes are stripped.
- **One request at a time.** A queue in `grey.core` runs requests in arrival order.
- **Never lose a typed message.** The prompt buffer clears on send. On an error, the text goes back.
- **A poisoned session drops only the mentor session.** That is a message containing `toolUse.name` and `failed to satisfy constraint` (`../carl/src/skill.ts:830-835`). The next turn starts fresh.
- **No retry loop.** The CLI retries model requests itself.
- **Metrics keep carl's event schema byte for byte:** `timestamp, run_id, invocation_id, event, subject, duration_ms, skill, model, effort, workspace, git_branch, git_sha, meta` (`../carl/src/skill.ts:126-140`).
  - Cost comes from `usage`, `modelUsage` and `total_cost_usd` on each `result`. In a live session `modelUsage` is cumulative (`sdk.d.ts:5679-5691`), so subtract the previous result's values per model.
  - Speed comes from `duration_ms`, `duration_api_ms`, `ttft_ms` and `num_turns`.
  - Tool calls come from `tool_use` blocks, with output size from the matching `tool_result`.
  - Quality has only indirect signals: checkpoints per cycle, test runs from red to green, and cost and time per cycle. Logging which findings you keep is out of scope.
  - `invocation_id` is one nvim job set: a new id when `:Grey` starts. `run_id` is one turn.
- **Tests run headless:** `nvim --headless -u NONE -l tests/run.lua`, with plain `assert` and no test framework. Every module except `grey.ui` takes its I/O as arguments, so tests pass fakes.

### Findings behind the decisions
- `claude` is at `~/.local/bin/claude`, now at 2.1.299 (the first probes ran on 2.1.296). `--help` lists every flag above.
- The SDK's `setModel` sends `{subtype:"set_model",model}`. `applyFlagSettings` sends `{subtype:"apply_flag_settings",settings}`. The envelope is `{request_id, type:"control_request", request}` (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`).
- The SDK always sends an `initialize` control request before anything else. The CLI also has `--await-initialize`, which suggests initialize is optional without it. The live probes below confirm it is optional.
- Step 1.1 live answers (CLI 2.1.299, `haiku5.5` through Bedrock, the full flag set above, 2026-10-13):
  - The init line shows `tools: ["Glob","Grep","Read"]`, `permissionMode: "dontAsk"` and the Bedrock model id.
  - The CLI writes a fresh `system`/`init` line to stdout before every user message, not just once. All three init lines in one probe carried the same `session_id`, so it is a status line for that message, not a new session. Nothing goes to the model because of it. `session` must not treat a second `init` as a new session.
  - **`modelUsage` is cumulative.** Over three messages, haiku's `outputTokens` went 5, 187, 192, and `cacheReadInputTokens` went 0, 5503, 8803. `costUSD` and `total_cost_usd` are cumulative too. The baseline subtraction stays.
  - **`usage` on a `result` is per message.** The second message's `usage` (input 4, output 182, cache read 5503, cache write 784) equals the `modelUsage` delta. It covers every model request in that message, so either source works. Keep `modelUsage`, since it splits by model.
  - **`num_turns` counts per message.** The three messages reported 1, 3 (two `Glob` calls, then the answer) and 1. grey passes no `--max-turns`, so nothing caps a message.
  - **`set_model` works with no `initialize`.** It returned `{"subtype":"success","request_id":"r1"}`, and the next init line and `modelUsage` showed `us.anthropic.claude-sonnet-5-5`. `session` sends no `initialize`.
  - `apply_flag_settings` with `{"effortLevel":"low"}` and with `{"effortLevel":null}` both returned `success` with no `initialize`. The probe did not check that the effort changed the model's output.
  - A `control_response` carries the result under `response`: `{"type":"control_response","response":{"subtype":"success","request_id":<id>}}`. Match on `response.request_id`.
  - **Bedrock can use the 1-hour cache.** With `ENABLE_PROMPT_CACHING_1H_BEDROCK=1` in the env, cache writes went to `usage.cache_creation.ephemeral_1h_input_tokens` and `ephemeral_5m_input_tokens` was 0. Without it, every write went to the 5-minute bucket. The CLI also reads `CLAUDE_CODE_PROMPT_CACHE_TTL` and `FORCE_PROMPT_CACHING_5M`, which were not tested.

### Layout
The repo root is the plugin. Add it to the runtimepath, for example lazy.nvim's `dir = "~/src-dheater/grey"`. Modules import one way, top to bottom:
- `lua/grey/models.lua`
- `lua/grey/options.lua`
- `lua/grey/recorder.lua`
- `lua/grey/session.lua`
- `lua/grey/prompt.lua`, `lua/grey/plan.lua`, `lua/grey/cycle.lua`, `lua/grey/vcs.lua`
- `lua/grey/events.lua`, `lua/grey/cost.lua`
- `lua/grey/core.lua`
- `lua/grey/ui.lua`
- `plugin/grey.lua`, which defines the commands and calls `ui`

### Milestone 1: mentor, checkpoints and plan

1.2 **`tests/run.lua` and the justfile.**
- The runner prepends the repo to `runtimepath` and loads every `tests/*_spec.lua`. Each spec returns a table of name to function.
- It runs each test with `pcall`, prints the failures, and calls `os.exit(1)` if any failed.
- `just test` runs `nvim --headless -u NONE -l tests/run.lua`.

1.3 **`grey.models` and `grey.options`.**
- `models`: `BEDROCK_MODEL_IDS`, `EFFORT_LEVELS`, `is_model_alias` and `is_effort_level`, ported from `src/models.ts`.
- `options`: `READ_TOOLS`, `build_argv({ model_id, effort, persona })` with the flags above, and `build_env()`.

1.4 **`grey.recorder`.** Port `RunRecorder` (`src/recorder.ts:97-267`) and its helpers (`:269-330`):
- `Recorder.new(model_id, baseline, on_tool_call)`, with `record(msg)`, `usage(latency_ms)`, `outcome()` and `result_model_usage()`;
- `describe_failure`: drop the max-turns message and the budget message, since grey sets neither limit.

1.5 **`grey.session`.** It takes `spawn` as an argument: `vim.fn.jobstart` in nvim, a fake in tests.
- `Session.new({ argv, env, cwd, model, effort, spawn })` starts the job.
- `on_stdout` joins chunks into lines. `jobstart` splits output at any byte: the first item of each chunk continues the last line, and the last item may be partial. Each complete line goes through `vim.json.decode`.
- `send(text, { on_progress, on_tool_call, on_done })` writes one `{"type":"user",...}` line with `chansend`. It feeds messages to a fresh `Recorder` on the stored baseline until the `result`, then calls `on_done(err, { text, usage })`. It updates the baseline either way. A second `send` while one is in flight is a programming error, so `assert`.
- `set_model(alias, cb)` and `set_effort(level, cb)` send control requests and match the `control_response` by `request_id`. An unknown alias calls `cb` with carl's error (`../carl/src/carl.ts:48-52`), without the config hint, and sends nothing.
- If the job exits mid-turn, `on_done` gets: `claude exited with code <n> during a turn: <last 20 stderr lines>`.
- `close()` calls `jobstop`.

1.6 **`grey.prompt` and `grey.plan`.**
- `prompt.build_persona(root, skill)` assembles the rules, the skill, the workspace and `AGENTS.md`.
- `prompt.Attachments` provides `take(key, text)` and `reset()`.
- `prompt.build_turn_message({ test, current, diff, plan, refactor, body })` joins its parts with `---`, in this order:
  - `# Test run` with the recipe, `pass` or `fail (exit N)`, the previous result this cycle, and the output;
  - `Current test:`;
  - `# Working-copy diff`;
  - `# Current plan`;
  - `# Refactor list`;
  - `# Message`.
  - It skips `nil` parts.
- `plan.active(text)` returns the first unchecked item under `## Tests`, or `nil`. It reads no files.

1.7 **`grey.cycle` and `grey.vcs`.**
- `cycle`: as in the earlier design. `observe(change_id)` resets the state on a new id. `record_test(passed)` returns `{ previous, run_review }`. `mark_reviewed()`.
- `vcs`: `snapshot(root, cb)` runs the two jj commands above through `vim.system` and returns `{ diff, change_id, commit_id, bookmarks }`. It also provides `cap(text, max, from)`.
- Outside a jj repo, `snapshot` fails with: `grey needs a jj repo: jj log failed in <root>: <stderr>. Run jj git init --colocate to add jj to a git repo.`

1.8 **`grey.events` and `grey.cost`.**
- `events.config_dir()` reads `GREY_CONFIG_DIR`, falling back to `~/.config/grey`.
- `events.write(event)` appends one `vim.json.encode` line.
- `events.new_id()` builds a v4 UUID from `vim.uv.random(16)`.
- Timestamps are ISO 8601 UTC with milliseconds, from `vim.uv.gettimeofday()`.
- `git_sha` is the commit id. `git_branch` is the first bookmark, or `null` when there is none.
- The events are `prompt`, `skill` and `tool_call`, as carl writes them, with `skill` set to `mentor`, `plan` or `review`, plus:
  - `meta.change_id` on every `prompt` event;
  - one `test` event per checkpoint, with `subject` as the recipe, `duration_ms`, and `meta` holding `exit_code` and `output_chars`.
- `cost`: `MODEL_RATES` and `compute_cost` (`../carl/src/skill.ts:582-659`), plus `format_status`, for example `[sonnet5.5 default · cycle xxpnvkzu · turn 7 · 43 requests · 84k context · $1.42]`.

1.9 **`grey.core`.** `core.new(deps)` takes `new_session`, `snapshot`, `read_file`, `write_file`, `write_event`, `append_transcript`, `now` and `root`. It exposes `ask`, `checkpoint`, `plan`, `review`, `set_model`, `set_effort` and `new_cycle`. Each takes a callback and goes on the queue.
- `ask(text)` and `checkpoint({ recipe, exit_code, output, duration_ms })`:
  - Snapshot, then run `cycle.observe`. On a new cycle, close the mentor session and reset `Attachments`.
  - Read `plan.md` and `refactor.md`. A checkpoint with no active plan returns the gate error without starting a session.
  - Build the message and send it to the mentor session.
  - A checkpoint calls `record_test` first. Treat `run_review` as false until step 2.1.
- `plan(text)`:
  - Start a session with `build_persona(root, "plan")`.
  - Send the text and the diff.
  - Write the reply to `.agent/notes/plan.md`, then close the session.
- Write the events and append to `.agent/grey/transcript.md`:
  - `# Cycle <change id>` when a cycle starts;
  - `## You` or `## Test run (just <recipe>: pass|fail)`;
  - `## grey (<skill>, <model>)`, the reply and the status line.
- On a poisoned-session error, close the mentor session before reporting the error.
- Test: with fake `new_session` and `write_file`, `core.plan("goal")` calls `write_file` with `.agent/notes/plan.md` and the reply text, then closes the session. Check the write happens before the close and that `plan.active` on the written text returns the first `- [ ]` item.

1.10 **`grey.ui` and `plugin/grey.lua`.**
- `:Grey` finds the root with `vim.fs.root(0, ".jj")` and builds `core` with real deps. It opens `.agent/grey/prompt.md` and `.agent/grey/transcript.md` in splits, with `autoread` on the transcript.
- `:GreyAsk` sends the prompt buffer. `:GreyPlan` sends it as a plan.
- `:GreyTest [recipe]` runs `just <recipe>`:
  - with `stdout_buffered`, `stderr_buffered` and `NO_COLOR=1`;
  - timed with `vim.uv.hrtime`;
  - with its output shown in a `grey://test` buffer;
  - followed by a call to `core.checkpoint`.
  - Recipes complete from `just --summary`. The default is `test`.
- `:GreyModel {alias}`, `:GreyEffort {level}`, `:GreyNew`, and `:GreyStop`, which closes every session.
- Each callback that touches a buffer goes through `vim.schedule`, since `vim.system` and job callbacks run in a fast event context.
- After each reply: `:checktime` the transcript, scroll it to the end, and set `vim.g.grey_status`. `progress` lines go to `vim.notify`. Errors go to `vim.notify` at error level, and the prompt text comes back.
- The plugin defines no keymaps.

1.11 **`skills/mentor.md` and the rules.**
- Move `## Mentoring` from `rules/grey.md` into a new `skills/mentor.md` with no frontmatter. Drop three things from it:
  - the scissors-line sentence;
  - "Give a snippet only when the snippet is the answer";
  - "For a whole design or implementation, suggest `:plan` and stop".
- Then add:
  - You are the navigator in a TDD pair. The human types every edit.
  - Open every checkpoint reply with `Red`, `Green` or `Refactor`. Judge it from this result, the previous result and the diff.
  - Name each violation in one line, then help anyway:
    - production code changed with no failing test for it;
    - a new test passed on its first run;
    - a test failed for the wrong reason, not the missing behaviour;
    - the green step did more than the test needs;
    - refactoring while red;
    - a test pinning implementation details.
  - Red: quote the failing assertion and say whether it fails for the right reason.
  - Green: say whether the code is the least that passes.
  - Refactor:
    - Track only the items left in `# Refactor list`, as "N of M left".
    - Speak unprompted only about a regression.
    - Put a new idea in one line under `Later:`, once.
    - When the list is empty, say to check off `Current test` in the plan and run `jj new`.
  - In the first turn of a cycle, if the plan's previous item is still unchecked and the diff is empty, ask whether it is done.
  - Next test: suggest the `Current test` item. Never rewrite the plan.
  - Show as much code as helps, up to whole functions.
  - Keep a checkpoint reply to the phase line and a few bullets unless asked for more.
- In `skills/plan.md`, `## Tests` becomes `- [ ]` items in build order, smallest first. Each item is one behaviour and one cycle, and names its test file.

1.12 **Delete the node scaffolding**, once the Lua specs for 1.3 to 1.5 pass:
- `src/`, `dist/`, `node_modules/`, `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.test.json`, `jest.config.js` and `build.mjs`;
- `nodejs` and `typescript-language-server` from `devbox.json`;
- the `build`, `format`, `lint`, `run` and `install` recipes from the `justfile`;
- the node entries from `.gitignore`.

1.13 **Check by hand in this repo.**
- `:GreyTest` with no plan shows the gate message, and `:GreyAsk` still answers.
- Run `:GreyPlan` with a small goal. Confirm `plan.md` has a `## Tests` checklist.
- Write the first test, then `:GreyTest`. The reply opens with `Red` and quotes the assertion.
- Make it pass, then `:GreyTest`, `jj new` and `:GreyAsk`. The transcript shows a new `# Cycle` and the status line shows turn 1.
- `:GreyModel opus5.5`, then a turn. The `prompt` event's `usage.modelId` is the opus id.
- Quit nvim. `pgrep -fl 'claude -p'` shows nothing.

### Milestone 2: review and the refactor list

2.1 **`core.review()`.**
- Start a fresh session with `build_persona(root, "review")`.
- Send the diff and the last test output.
- Write the reply to `.agent/grey/refactor.md`, call `mark_reviewed()`, and close the session.
- Turn on `run_review` in `checkpoint`.
- `grey.ui` opens `refactor.md` after a review.

2.2 **`skills/review.md`.** The output is only `- [ ] path:line: <change>` lines, most valuable first, then one `Not read:` line. `gF` jumps to `path:line`.

2.3 **Check by hand.**
- Go red, then green. `refactor.md` opens, and no mentor checkpoint runs.
- Delete a line, then `:GreyTest`. The mentor reports the shorter list.
- Pass again in the same cycle. No second review runs.

2.4 **README.**
- Cover the cycle, the commands, adding the repo to the runtimepath, mapping `:GreyAsk` and `:GreyTest`, and how `jj new` ends a session.

## Tests
All under `tests/`, run by `just test`.
- `options_spec.lua`:
  - argv names exactly `Read,Glob,Grep` in `--tools` and `--allowed-tools`;
  - argv has `--restricted`, `--no-session-persistence` and `includeGitInstructions: false`;
  - `default` effort adds no `--effort`;
  - argv has no `--max-budget-usd`.
- `recorder_spec.lua`: ported from `src/recorder.test.ts`, including subtracting the baseline per model.
- `session_spec.lua`, with a fake `spawn` that records `chansend` writes and feeds stdout chunks:
  - a JSON line split across three chunks decodes once;
  - two `send` calls report per-turn tokens, not running totals;
  - two turns on two models report per-turn usage for each;
  - a failed `result` calls `on_done` with an error carrying that turn's usage;
  - `set_model("sonnet5.5")` writes a `set_model` request with `us.anthropic.claude-sonnet-5-5` and calls back on the matching `control_response`;
  - an unknown alias writes nothing;
  - `set_effort("default")` sends `effortLevel: null`;
  - a job exit mid-turn calls `on_done` with the exit code.
- `prompt_spec.lua`:
  - the persona holds every rules file and only the named skill;
  - `Attachments` returns the text once, `nil` while it is unchanged, and the text again after a change or `reset()`;
  - `build_turn_message` skips `nil` parts and puts `# Message` last.
- `plan_spec.lua`:
  - `active` returns the first unchecked item under `## Tests`;
  - it returns `nil` when every item is checked;
  - it ignores `- [ ]` items in other sections;
  - it returns `nil` for an empty file.
- `cycle_spec.lua`:
  - fail then pass returns `run_review = true`;
  - pass first returns `run_review = false`;
  - a second fail then pass after `mark_reviewed` returns `run_review = false`;
  - a new id resets the state.
- `vcs_spec.lua`: `cap` keeps the start of a diff and the end of test output, and names the cut.
- `core_spec.lua`, with fake deps:
  - two `ask` calls on one change id use one session;
  - a new change id closes it and starts another;
  - a checkpoint with no active plan starts no session and returns the gate message;
  - `ask` with no plan still sends;
  - an unchanged diff goes out once;
  - `refactor` is not attached in a new cycle before a review;
  - fail then pass runs a review and no mentor turn (milestone 2);
  - a call made during a turn runs after it;
  - a poisoned-session error closes the mentor session;
  - one `ask` writes `prompt`, `skill` and `tool_call` events sharing `run_id` and `invocation_id`, with `meta.change_id`;
  - a checkpoint writes one `test` event.
- `grey.ui` has no automated tests. Steps 1.13 and 2.3 cover it.

## Out of scope
- **Logging which refactor findings you kept.**
- **git without jj.**
- **Streaming reply text** with `--include-partial-messages`. `progress` lines show the turn is alive.
- **Interrupting a turn.** The CLI has an `interrupt` control request.
- **Two turns at once**, such as a review alongside a mentor turn.
- **Per-skill default models.**
- **Write tools or a code mode.**
- **A config file, `grey stats`, benchmarks and changes to carl.**

## Risks
- **The CLI's stream-json and control requests change without notice.** `~/.local/bin/claude` updates itself, while the SDK pinned its own copy. If a change breaks `grey`, point `options` at a pinned binary. Step 1.1's findings show the shapes `grey` depends on.
- **`initialize`.** The CLI does not need it before control requests today (Findings). If a later CLI starts refusing them, `session` sends it first.
- **`--restricted` keeps file tools in the working directory.** The mentor cannot read `../carl` unless you add `--add-dir`.
- **The cache lifetime.** The design assumes test runs land within 5 minutes of each other. The `test` events show the real gaps. The CLI can use the 1-hour cache on Bedrock with `ENABLE_PROMPT_CACHING_1H_BEDROCK=1` (Findings). 1-hour cache writes cost more than 5-minute ones, so turn it on only if the gaps run past 5 minutes.
- **Diff growth.** Each changed diff goes out whole. If `instruction_chars` climbs in long cycles, send only the files changed since the last checkpoint.
- **Phase judgement.** If the model misjudges the phase often, add the changed test files to `# Test run` before adding any harness state machine.
- **Review output format.** If replies stray from `- [ ]` lines, "N of M left" breaks. Check the first few `refactor.md` files.
- **Fast event context.** A buffer call made directly from a `vim.system` callback errors. Every such call needs `vim.schedule`.
- **Effort per model.** `apply_flag_settings` may reject a level the model lacks. The error shows through `vim.notify`, and the setting does not change.
- **Not read:**
  - your nvim config;
  - `:help channel` beyond `jobstart`;
  - the CLI's stream-json docs, if any exist;
  - carl's stats modules.
