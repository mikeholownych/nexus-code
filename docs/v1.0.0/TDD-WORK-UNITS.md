# TDD-first durable work units

Test-first execution is opt-in per operation. Until the `--tdd` flag lands with the operation option surface, enable it
for the CLI with the environment:

```sh
NEXUS_TDD=1 nexus operation run spec.json
```

Programmatic callers can pass `tdd: true` to `AgentWorkUnitExecutor`. Without the switch the operation model is
unchanged.

## Behaviour

For each unit whose role is unset (implementer) or `implementer`:

1. **RED.** The unit agent gets the normal unit prompt plus a RED protocol: author or update a test that reproduces the
   task, run the project's verifier, and do not implement the fix yet. `task_completed` is allowed to record the failing
   verifier for this turn only (`runTurn(..., { tddRed: true })`); normal completion still requires a passing verifier.
   The RED turn is accepted only when the turn's verification evidence is `FAILED`, executed at least one test, and a
   test file was added or its content hash changed (candidate diff against HEAD, using the tester's path rule). For this
   turn only, the workspace-resolved verifier definition binding is skipped: adding the reproduction test legitimately
   changes that definition, and RED does not claim verification.
2. **Evidence.** The accepted verifier command, test paths and their content hashes are written to a private sidecar
   under `~/.nexus/tdd/<unit-task-id>.json`, keyed by the unit id and a hash of its task prompt. It survives conversation
   compaction and a crashed process. It is ignored (and RED reruns) after an operator revise or restart, or when a
   recorded test file was changed again.
3. **Baseline rebase.** The verifier baseline is re-snapshotted onto the verified RED test set, so adding the first
   reproduction test (and the resulting change in the workspace-resolved verifier definition) does not wedge GREEN. The
   rebase records `failed: true` and never clears a recovered unit's fail-closed verification posture.
4. **GREEN.** The unit continues in the same conversation with the normal prompt plus the GREEN protocol: implement the
   smallest product/source change, keep the test intact, and run the same verifier until it passes. Completion then
   follows the ordinary `TurnResult` classification and verifier gates, including test-set stability, deliverable binding
   and independence. Editing the RED test during GREEN therefore fails verification, as it should.

`tester` and read-only roles are unchanged. Provider, interruption and capacity failures during RED take their normal
scheduler recovery path, not the TDD failure path.

## Scope and residuals

- RED evidence is a private sidecar, not an authenticated attestation: a local operator who can write it can forge it.
  The GREEN verifier gate remains authoritative.
- The RED and GREEN turns share one unit run and one conversation; they do not add a scheduler phase or operation state
  field, so unit retries after a completed RED skip straight to GREEN. A changed task prompt or an explicit restart
  invalidates the sidecar and reruns RED.
- The one TDD-specific relaxation is the RED turn's `tddRed` boundary (a failing verifier is the expected RED result).
  GREEN has no relaxation: it can only complete through the same verifier, baseline and independence gates as any other
  unit.
- TDD requires a Git workspace (the test-change evidence is a candidate diff against HEAD). A non-Git operation falls
  back to failing the RED phase. Automatic test generation, coverage guidance and mutation scoring are not included.
- Tests: `cli/test/tdd_work_units.test.ts` (11 cases: RED→GREEN, no switch, invalid RED, no test change, resume via
  sidecar, stale sidecar after a revise, restart, role exclusion, a real-agent RED turn, a real RED→GREEN unit where the
  first test is added to a test-less repo, and a failing `task_completed` still rejected without `tddRed`). The
  real-agent cases use the deterministic fixture gateway; no external inference is required. A `--tdd` CLI flag is a
  follow-up once the operation option surface is free.
- Not included: automatic test generation from requirements, coverage-guided exploration, and mutation/regression
  scoring beyond the existing verifier and independence rules.
