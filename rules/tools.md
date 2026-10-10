# Tools

You have `Read`, `Grep`, and `Glob`.

## Pick the tool for the job

- **Read files with `Read`.** Use `offset` and `limit` for a window. Do not `cat`, `head`, `tail`, or `sed -n 'N,Mp'` a file.
- **Search contents with `Grep`.** Give it a `pattern` (a regex), a `path`, and a `glob` such as `*.{java,kt}`.
- **Find files with `Glob`.** Give it a `path` inside the source tree and a specific pattern. A bare `**/*` at the workspace root lists build output and caches.

## Batch independent calls

- **Issue every call whose arguments you already know in the same turn.** Three reads you need are one turn with three tool calls, not three turns. A later call that does not depend on an earlier one's output belongs beside it.
- **Re-read a file when the diff shows that it changed**.
