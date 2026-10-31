# Test fixtures

## `operation-v1.json`

A real **v1.0.0** durable operation record, produced by running the `v1.0.0` tag's own `OperationStore.save`
(`cli/src/core/operation_runner.ts` at `501eab68`) over a two-unit operation whose first unit had completed. It is not
hand-written: `operation.schemaVersion` is 1 and the envelope is the shape that release wrote.

The only edit is `workspacePath`/`workspace`, replaced with `<recorded-workspace>`: the store binds a record to the
workspace it was written in, and a checked-in absolute path would not load anywhere else. The test that consumes it
rewrites both fields to its own temporary workspace before loading.

Regenerate (only if the v1.0.0 shape ever needs a new sample) with the `v1.0.0` tag checked out:

```sh
git worktree add /tmp/v10 v1.0.0
# script: newOperation(...) + OperationStore.save, then copy <id>.json
```
