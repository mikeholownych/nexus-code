# PA-4: bounded `/loop` lifecycle

## Architecture

`/loop` stores its controller receipt in the existing durable task state (`DurableTaskState.loop`) and stores each attempt as a child operation in the existing `OperationStore`. Work is scheduled by `driveOperation` and the existing convergence scheduler. The loop does not create a second task graph or provider client. Loop state has its own schema version so existing task schema version 2 records remain readable without migration.

A child attempt is a `/team full` operation with a deterministic tester and the existing independent reviewer. The reviewer depends on the verifier. Completion requires the operation to finish, the verifier receipt to report executed tests and `PASSED`, and the independent reviewer receipt to say `ACCEPT`; artifact conditions additionally require a regular file whose real path remains inside the workspace. Agent statements cannot satisfy a deterministic verifier condition.

Only provider-reported token totals are placed in `reportedTokens`. Mixed or estimated request totals go in `estimatedTokens`; inference request counts are recorded only when available from the durable child task. Missing child accounting remains zero and is not presented as a measurement.

## Command grammar

Options must precede the objective. Arguments use the shared shell-like word parser: single or double quotes group whitespace, backslash escapes the next character, and unmatched quotes or a trailing escape are rejected. Unicode text is preserved. The first word is reserved for lifecycle actions (`status`, `list`, `pause`, `resume`, `stop`), so an objective beginning with one of those words must be quoted as a single objective argument after a harmless prefix, for example `/loop "status the new behavior"` is still treated as the status action; use `/loop objective: status the new behavior`.

```text
/loop [--until <condition>] [--max-iterations <n>] [--max-duration <duration>] <objective>
/loop status [id]
/loop list
/loop pause [id]
/loop resume [id]
/loop stop [id]
/loop reconcile <id> --confirm-no-effect
```

Conditions are one quoted token:

- `test=<command>` requires the verifier receipt to match that exact command.
- `artifact=<relative-path>::<command>` requires the matching verifier and a regular artifact under the workspace (symlink escapes are refused).
- `criteria=<text>` gives criteria to the independent reviewer; it still requires a passing deterministic test receipt.

Duration values are positive integers followed by `ms`, `s`, `m`, or `h`. The minimum is one second and the maximum is 24 hours. The default is three iterations and one hour. Iterations are bounded to 1..100. Repeating an option uses its last value. Unknown options, malformed numbers, unknown conditions, and missing values are errors. Maximum iterations and duration produce `EXHAUSTED`, never `COMPLETE`.

When an ID is omitted, exactly one active loop is selected; otherwise an error asks for the ID. If no loop is active, a sole historical loop can be inspected. Multiple historical loops require an explicit ID. `pause` takes effect at a durable child-operation boundary. Ctrl-C requests the same safe-boundary pause. `stop` requests cancellation and is acknowledged after the current operation settles; it does not assert that a running external effect was undone.

A child operation found with a stale `RUNNING` unit is marked `UNKNOWN_EFFECT` and is not replayed. A child cancellation is converted to a durable unknown-effect block because the current shared scheduler maps cancelled units back to runnable; this prevents `/loop` from repeatedly invoking an uncertain effect. Resume refuses unknown-effect loops. An operator who has inspected the child and confirmed no effect occurred can explicitly run `/loop reconcile <id> --confirm-no-effect`; the existing terminal approval prompt must approve this action, and the decision and child operation identity are persisted before a new iteration can start. The underlying scheduler cancellation behavior is recorded as a boundary request for the PA-1 owner.

A stop request has priority over late child success. Once the current operation settles, the loop records `CANCELLED`; a child completion that arrives after the stop request cannot complete the parent loop.

## Integration and evidence

The shared slash catalogue feeds command completion in terminal interfaces. The REPL and sidecar call the same `executeLoopCommand`; read-only mode permits only `status` and `list`. State records retain bounded summaries, verifier/reviewer receipts, operation references, fingerprints, and usage labels, not the child transcript. Detailed child evidence remains in the existing durable operation records.

Focused lifecycle coverage is in `cli/test/loop_lifecycle.test.ts`; task schema and migration coverage remains in `cli/test/state_migration.test.ts`. Local run evidence is recorded in the implementation PR and may be updated after the release branch is rebased.
