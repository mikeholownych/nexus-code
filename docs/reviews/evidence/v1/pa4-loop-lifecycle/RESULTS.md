# PA-4 `/loop` implementation evidence

Evidence collected on branch `v1/pa4-loop-lifecycle`, based on `release/v1.3.0` at `1fdef239478d50eecea1b694d6111a07bd23abda`.

## Local validation

- `HOME=<isolated-temp> XDG_CONFIG_HOME=<isolated-temp> npm --prefix cli run build` — passed (TypeScript build and generated CLI data).
- From `cli/`: `HOME=<isolated-temp> XDG_CONFIG_HOME=<isolated-temp> node --import tsx --test test/loop_lifecycle.test.ts` — 9 passed, 0 failed.
- From `cli/`: `HOME=<isolated-temp> XDG_CONFIG_HOME=<isolated-temp> node --import tsx --test test/state_migration.test.ts` — 6 passed, 0 failed.
- `git diff --check` — passed.

The lifecycle cases cover catalogue/sidecar routing and read-only access; verifier plus independent-review acceptance; max-iteration exhaustion; stagnation blocking; deadline exhaustion; pause and resume using a fresh `OperationStore`; cancellation/late-child handling; explicit approval and persisted unknown-effect reconciliation; flag, condition, duration, quoting and Unicode parsing.

## Architecture and provider boundary

The loop controller uses the existing task store, `/team full` role plan, operation records and convergence scheduler. It introduces no provider-specific transport or required provider extension. Tests use injected mock work-unit executors and do not make inference calls. Optional token counters remain labeled reported or estimated.

## Known limitation / boundary request

The existing `ConvergenceScheduler.apply()` turns a cancelled unit back into `RUNNABLE`, which produced an unbounded retry in the cancellation fault test. `cli/src/core/scheduler.ts` is claimed by PA-1, so this slice does not change it. The loop adapts cancellation into a durable `EXECUTION_UNKNOWN` block, refuses automatic resume, and requires the existing operator approval prompt plus `/loop reconcile <id> --confirm-no-effect` before retrying. A boundary request was recorded in the shared claim log for the PA-1 owner. The broader scheduler defect remains open pending that owner’s remediation.

Hosted PR checks and the full release branch regression suite are not yet recorded here; update this evidence after CI qualification.
