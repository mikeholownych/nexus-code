# Power of Ten Adversarial Test Report

**Source revision:** `a0329e72ea796a306ea138ab2870d15920e4af61` (`origin/main`).
**Execution platform:** Linux x86_64, Node.js v24.11.1, Rust 1.95.0.
**Isolation:** tests/builds ran in `/home/mike/nexus-wt/power-of-ten-audit` with throwaway `HOME`/XDG locations and a worktree-local or temporary Cargo target. No live user workspace or production source was used.
**Disposition meanings:** PASS means the expected enforcement was executed and observed; FAIL means a violation was reproduced; INCONCLUSIVE means setup/execution did not establish the result; NOT TESTED means no experiment was executed. Reading a test source is not a pass.

## 1. Commands actually executed

### Rust tests

Command (environment added `HOME=$(mktemp -d)` and a temporary `CARGO_TARGET_DIR`):

```sh
cargo test --locked --manifest-path core/Cargo.toml
```

**Result:** exit 0. 387 library tests, 1 adversarial path traversal test, 4 RPC shutdown tests, and 1 segregation test passed (393 total). This includes bounded output, cancellation, process cleanup, and path-boundary fixtures. This is source-level evidence for Rust paths, not installed-binary acceptance.

### TypeScript build

```sh
npm ci --prefix cli
npm --prefix cli run build
```

`npm ci` exited 0 (27 packages; npm audit summary: zero vulnerabilities). `npm run build` exited 0 and executed `tsc`, data copy and build-info generation. The initial build attempt failed because this fresh disposable worktree had no `cli/node_modules`; dependency installation corrected the environment. No implementation source changed.

### Rust warning check

```sh
cargo clippy --locked --manifest-path core/Cargo.toml -- -D warnings
```

**Result:** exit 0; no warnings. This was executed locally; the CI workflow does not execute this command, so it is not a mandatory repository gate.

### GitHub ruleset read

```sh
gh api repos/mikeholownych/nexus-code/rulesets/25340146
```

**Result:** active ruleset for `main` and `v1/integration`; required checks are `test-matrix (22)`, `test-matrix (24)`, and `linux-x86_64`; strict/up-to-date policy is false; required approval count is 0; no code-owner or last-push approval is required; no bypass actors were listed. This is live configuration read on 2026-11-18, not commit-bound repository source.

### CLI targeted-test bootstrap attempt

The command below was first run from the repository root, before CLI dependencies had been installed in the isolated worktree:

```sh
node --import tsx --test --test-name-pattern='the total step budget ends a long task' cli/test/objective_continuation.test.ts
```

**Result:** exit 1, `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx' imported from .../power-of-ten-audit/`. This is an environment/setup failure, not a product test failure. After `npm ci`, the exact command must be rerun from `cli/` (module lookup is relative to the current directory); it is not counted as pass evidence here.

The complete CLI suite was started from the isolated worktree after `npm ci` using a throwaway HOME. It exceeded the repository's stated 45-minute CI timeout without reaching an aggregate summary, so it was interrupted with Ctrl-C (process exit 130). This is an incomplete run, not a pass or a test-suite verdict. Streamed output showed multiple failing tests, including dataset/evaluation sandbox cases, and explicit skips because `NEXUS_EVAL_TEST_WORKSPACE_ROOT` was unset; the isolated run did not provide a final report that would let this audit safely classify every failure. Treat these results as INCONCLUSIVE pending the documented `make test-ci` host setup and a bounded complete run.

## 2. Adversarial cases

| ID | Hypothesis and setup | Expected safe behavior | Actual observation / evidence | Status |
|---|---|---|---|---|
| AT-01 repeated same tool | Default direct run, same tool and arguments, unchanged workspace. Existing test: `cli/test/objective_continuation.test.ts`, “a stuck task stops boundedly: recovery notes, then STAGNATION_DETECTED” (`:92-113`). | Repetition is refused/escalated and turn ends non-success within the configured window. | Test source asserts `STAGNATION_DETECTED`, refusal receipts and <=10 gateway requests. The focused CLI test was not successfully rerun after dependency setup. | INCONCLUSIVE |
| AT-02 recoverable tool errors | Tool repeatedly returns recoverable errors without workspace change. | Retry count/deadline bounds; final status must preserve failure/unknown. | Tool RPC deadline code is present in `cli/src/tools.ts:528-539,1010-1082`; no dedicated end-to-end repeated-tool-error probe executed. | NOT TESTED |
| AT-03 malformed model responses | Model emits malformed/truncated response repeatedly against deterministic gateway. | Bounded correction attempts; malformed output never executes partial arguments or yields completion. | `cli/src/core/run_turn.ts:667-674,809-824` has truncation/empty-response handling; no adversarial repeated-malformed-response run executed. | NOT TESTED |
| AT-04 compaction does not reduce context | Fill context and force repeated ineffective compaction. | Fail closed with capacity/error outcome; no unbounded compaction retry. | Context admission and compaction failure handling exist in `run_turn.ts`; no failure-injection run executed in this audit. | NOT TESTED |
| AT-05 deep escalation/fallback | Provider recovery/fallback returns to prior provider/model repeatedly. | Acyclic/limited fallback path; endpoint eligibility and replay budgets cannot reset task limits. | `ProviderRecoveryController` has 20-minute default deadline, 1,000 iteration cap and one unknown replay (`provider_recovery.ts:150-177,383-432`). The operation scheduler has 10,000 transitions per invocation. No live/deep-routing adversarial run executed; task aggregate budget remains absent. | NOT TESTED |
| AT-06 resume near exhausted budget | Configure a total step limit, progress to it, then resume and observe whether a task-wide budget resets. | If advertised as task-wide, resume must retain remaining budget; otherwise scope must be clearly per-turn and autonomous recovery must not silently reset it. | Focused command from `cli/`: `node --import tsx --test --test-name-pattern='the total step budget ends a long task' test/objective_continuation.test.ts`; exit 0, 1 passed/0 failed. With `maxTotalSteps=12` and `maxSteps=5`, the run crosses 3 segments and ends at 12 as `STEP_BUDGET_EXHAUSTED`. This proves explicit budget propagation across in-process segments only. Source shows each new `runTurnImpl` initializes `currentStep` at 1 and compares against `maxTotalSteps`; `cumulativeSteps` is observability only (`run_turn.ts:137-145,220-267`; `turn.ts:348-359`). No resume-reset runtime probe was executed. | INCONCLUSIVE |
| AT-07 hanging tool | Run a never-exiting shell command in a disposable workspace. | Command is terminated by a per-call deadline and parent reports timeout/unknown outcome. | Rust suite passed tests for named command cancellation and shutdown, but the specific long-hang timeout probe was not executed. `run_command` default is 60s and max configured default is 1,800s (`tools.ts:515-539`). | NOT TESTED |
| AT-08 cancel during external call | Abort during provider request or tool side effect. | Wait/abort semantics are recorded; no false completion; side-effect outcome remains unknown if unobserved. | Rust cancellation/shutdown tests passed. The partial CLI stream showed cancellation and process-kill fixture cases passing; overall suite was interrupted before summary. No live external call was made. | INCONCLUSIVE |
| AT-09 stale verification evidence | Mutate candidate or verifier after a pass, then attempt completion/reuse after restore. | Invalidate evidence and refuse VERIFIED until verifier is rerun on the current candidate. | Mutation invalidation in `agent.ts:527-530`, candidate and definition checks in `spine_handlers.ts:92-155`; partial CLI output streamed green cases for stale evidence and recovery, but aggregate process exited 130 before summary. | INCONCLUSIVE |
| AT-10 false-success statement | Model says “tests passed/complete” without running verifier, or verifier fails. | Model prose does not produce `VERIFIED`; failure yields nonzero result. | `TurnResult` invariant and exit-code mapping inspected at `turn.ts:420-479`; partial CLI output includes fixture cases ending UNVERIFIED/REGRESSION_FREE when appropriate. Aggregate process exited 130 before summary. | INCONCLUSIVE |
| AT-11 interrupted persistence | Inject failure between write/rename/fsync and recovery. | Previous durable state remains valid; incomplete run is interrupted/blocked, not complete. | `writePrivateFile` uses temp+rename and optional fsync (`durable_file.ts:115-160`); operation persistence and recovery tests exist; no write fault injection executed. | NOT TESTED |
| AT-12 cross-session contamination | Concurrent independent sessions mutate/read state and release resources after cancellation. | Session/workspace isolation; bounded global resources; no stale cross-session state. | Client lease and state-store guards exist. Rust segregation boundary passed. No multi-session race/host resource experiment executed; global memory/provider budgets remain unproven. | NOT TESTED |
| AT-13 acceptance bypass by workspace/agent | Modify test command/config or workflow to claim green without running mandatory checks. | Protected verification files and external acceptance authority reject bypass. | Local verifier edit guard exists. GitHub ruleset requires 0 approving reviews; candidate can change workflow source in its own PR. This governance gap is confirmed by live ruleset plus workflow source; no PR mutation was created. | FAIL (policy configuration counterexample; no exploit PR run) |
| AT-14 log loss/tampering | Force flight-log append failure or edit a prior record. | Required evidence loss is explicit; tampering is detected. | `FlightRecorder.appendEvent` catches append errors and returns the event anyway (`flight.ts:77-108`); records have no chain/signature. No filesystem fault/tampering experiment run. | INCONCLUSIVE |

## 3. Required adversarial scenarios not established

The following requested scenarios are explicitly not represented as passes: an infinite progression task bounded by a hard global ceiling; retries across repeated `resume`; compaction repeatedly failing to shrink context; deep escalation that returns to the original model; external calls under cancellation; process/host restart at each durable write point; memory/file-descriptor/disk measurement under many concurrent sessions; and a full CI mutation test that attempts to disable required verification. Existing tests cover selected subcases, but no complete end-to-end adversarial campaign was run.

## 4. Reproduction notes

From a clean checkout of the audited revision, install CLI dependencies with `npm ci --prefix cli`; use a throwaway `HOME` and XDG directories for tests; for Rust, set a worktree-local `CARGO_TARGET_DIR`. `npm --prefix cli test` was interrupted after exceeding 45 minutes without an aggregate summary (exit 130). The stream included failures and skips; do not treat the partial suite as green. The repository directs evaluation/resource tests to `make test-ci` with a dedicated `NEXUS_EVAL_TEST_WORKSPACE_ROOT`; that setup was not available in this audit environment. The no-ceiling behavior is reproducible from `DEFAULT_CONTINUATION` and loop guards cited in AT-06; an empirical reset test should use the repository’s `startGateway` fixture and should preserve its source/output transcript outside the main checkout.

## 5. Follow-up: mandatory candidate receipt persistence now fails closed (2026-11-25)

**Original failure:** The injected `recordCandidateAndReceipt` exception was first reproduced on `main` at `387647343ab5293549324756441cfa688f230ff0` (candidate test commit `296d6dc39`). The turn reported `persistence.durable=false` but returned `VERIFIED`; the pre-fix test exited 1. This was a confirmed P10-03 acceptance gap.

**Remediation:** PR #850 merged as `8cc750bc3213cc5c79852394894c78c8b798df1e`. A failed mandatory write now clears `verifiedWorktreeCompletion` and the active receipt (`cli/src/agent.ts:1695-1700`); the turn promotes that failure to `PERSISTENCE_FAILED` before constructing its result (`cli/src/core/run_turn.ts:56-63,1232-1236,1477-1480`). Receipt identity binds source revision, candidate digest, verifier command and definition, runtime, and acceptance-policy hash (`cli/src/core/spine_handlers.ts:466-515`). The receipt also explicitly records that independent approval is unavailable in this single-maintainer repository.

**Reproduction on fixed code:** On Node 24.11.1, in a detached worktree at `fa6c2eb65120a1a96ce737a967182e0ca4d5f364`, the focused fault-injection test passed 1/1. The test uses a local fixture gateway and a disposable candidate repository; it does not use a live provider or user workspace. It asserts that the injected persistence call occurred, `persistence.durable=false`, outcome is not `VERIFIED`, execution is `FAILED` with reason `PERSISTENCE_FAILED`, the worktree is not marked complete, and the candidate remains available for recovery. It also checks the bound receipt identity and that verifier source is represented by a digest.

**Reproduction commands:** From a clean checkout, install dependencies and build the Rust worker into the worktree-local target directory so the CLI resolves it:

```sh
npm ci --prefix cli
CARGO_TARGET_DIR="$PWD/core/target" cargo build --release --manifest-path core/Cargo.toml
TEST_HOME=$(mktemp -d)
(cd cli && HOME="$TEST_HOME" XDG_CONFIG_HOME="$TEST_HOME/.config" node --import tsx --test test/p10_receipt_persistence.test.ts)
```

**Status:** PASS for the tested candidate-receipt persistence path. This does not establish signed or externally immutable evidence, independent approval, or complete export-time binding across every acceptance path. The full CLI test suite was not rerun for this slice; hosted PR #850 checks passed, and post-merge CI and CodeQL passed on `e0139857ba189b2c7f695a4cdd6990ff4521c520` after PR #827.
