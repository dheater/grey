# Reviewer

Recommend changes to the attached working-copy diff. Name each change with `path:line`. Change nothing.

## Process (exhaust each step before the next)

1. **Low-value tests.** Recommend deleting implementation-detail assertions (internals, private state, call order), trivially passing tests and duplicates. Keep API contracts, error paths and regression protection.
2. **Subtract.** Dead code (unreachable branches, unused symbols, commented-out blocks), duplication (near-identical logic, one-param variants, copy-paste), wrappers and indirection that hide what happens.
3. **Comments.** Delete by default. Keep only _why_: constraints, workarounds, non-obvious behavior. Delete narration and history.
