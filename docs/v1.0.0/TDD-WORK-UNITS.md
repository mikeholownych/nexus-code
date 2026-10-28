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

1. **RED.** The unit agent gets the normal unit prompt plus a RED protocol: add a test that reproduces the
   task, run the project's verifier, and do not implement the fix yet. `task_completed` is allowed to record the failing
   verifier for this turn only (`runTurn(..., { tddRed: true })`); normal completion still requires a passing verifier.
   The RED turn is accepted only when the turn's verification evidence is `FAILED`, executed at least one test, and
   at least one reported test file was newly added (candidate diff against HEAD, using the tester's path rule). For this
   turn only, the workspace-resolved verifier definition binding is skipped: adding the reproduction test legitimately
   changes that definition, and RED does not claim verification.
2. **Evidence.** The accepted verifier command, test paths and their content hashes are written to a private sidecar
   under `~/.nexus/tdd/<unit-task-id>.json`, keyed by the unit id and a hash of its task prompt. It survives conversation
   compaction and a crashed process. It is ignored (and RED reruns) after an operator revise or restart, or when a
   recorded test file was changed again.
3. **Bounded RED definition validation.** RED legitimately changes the workspace-resolved verifier definition by
   adding its reproduction test. The validator records that exact post-RED definition separately so GREEN can use it
   only while the definition and RED test bytes remain unchanged. **RED may only add tests:** every pre-RED test must
   still be present and byte-identical, every verifier-definition entry (package manifest, Make include, referenced
   script, runtime definition, absent-path marker) must be unchanged except for reported RED tests, and the command
   must be the same. Anything else fails the unit with "the RED phase changed the verification oracle" instead of
   letting GREEN verify against a narrowed oracle. The independent-evidence baseline is never rebased: its original
   `failed` result and test snapshot remain intact, and RED-authored tests stay in separate metadata. A repository with
   no test file at all can use the exact validated definition for GREEN only with a test-set runner (`node --test`,
   `tsx --test`, `bun test`, `deno test`); a manifest- or config-authored verifier (`npm test`, `make test`, `pytest`, a
   script) must exist before RED. A shell-written manifest that hides itself from git does not help it.
4. **GREEN.** The unit continues in the same conversation with the normal prompt plus the GREEN protocol: implement the
   smallest product/source change, keep the test intact, and run the same verifier until it passes. Completion then
   follows the ordinary `TurnResult` classification and verifier gates, including test-set stability, deliverable binding
   and independence. Editing the RED test during GREEN therefore fails verification, as it should. A passing
   verifier that relies only on the test written during RED is `REGRESSION_FREE`, not `VERIFIED`, and the implementer
   work unit remains incomplete until independent evidence establishes the result.

`tester` and read-only roles are unchanged. Provider, interruption and capacity failures during RED take their normal
scheduler recovery path, not the TDD failure path.

## Scope and residuals

- RED evidence is a private sidecar, not an authenticated attestation: a local operator who can write it can forge it.
  The GREEN verifier gate remains authoritative.
- The RED and GREEN turns share one unit run and one conversation; they do not add a scheduler phase or operation state
  field, so unit retries after a completed RED skip straight to GREEN. A changed task prompt or an explicit restart
  invalidates the sidecar and reruns RED.
- The only TDD-specific relaxation is the RED turn's `tddRed` boundary (a failing verifier is the expected RED result).
  RED tests are recorded separately and never become the pre-change independent test set or establish a fail-before
  result. GREEN has no relaxation: it can only complete through the same verifier, baseline and independence gates as
  any other unit.
- A resumed unit never rebases: recovery treats the saved baseline as untrusted and the workspace already holds the RED
  edits, so no fresh pre-RED tree exists. A resumed unit with a workspace-bound verifier therefore cannot complete at
  all (the definition guard rejects `task_completed`), and every TDD unit uses a workspace-bound gate in practice; a
  bound result needs a fresh task.
- A refusal is terminal for the unit rather than retryable: a retry or revise resumes the same task, where no fresh
  baseline can be captured, so it would loop. The RED edits stay in the workspace; the operator restores the files named
  in the decision and starts a new operation.
- In a repository with no test file, the allowance ends as soon as any non-marker file is in the verifier definition: a
  pre-existing manifest or config, or an undeclared helper the first test imports, refuses the rebase. Declare the
  deliverable (or establish the verifier) before RED if the unit needs one of those.
- The guard watches the verifier definition, never the command's extra flags: an operator who points the verifier at a
  file the agent writes (for example `node --test --import ./test/loader.mjs`) makes the model part of the oracle. The
  model cannot add such flags itself, but the configuration is the operator's to review.
- The sidecar is not deleted when the unit completes; it is keyed by task id and prompt hash, so it is inert for a new
  unit and removed on restart. `testHashes` compares uncommitted candidate changes, so committing the RED test outside
  the harness makes the evidence stale and reruns RED.
- TDD requires a Git workspace (the test-change evidence is a candidate diff against HEAD). A non-Git operation falls
  back to failing the RED phase. Automatic test generation, coverage guidance and mutation scoring are not included.
- Tests: `cli/test/tdd_work_units.test.ts` (21 cases: RED→GREEN, no switch, invalid RED, no test change, resume via
  sidecar, stale sidecar after a revise, restart, role exclusion, a real-agent RED turn, a real RED→GREEN unit confirming
  a new RED test alone cannot establish independent completion, RED narrowing the verifier refused, RED creating a verifier where none existed
  refused, RED modifying an existing test refused, a verifier definition the baseline could not capture refused, a
  shell-authored manifest refused, a git-hidden shell-authored manifest refused, a RED-authored runner the command
  executes directly refused, a pre-existing manifest refused as the definition, and a failing `task_completed` still
  rejected without `tddRed`). The real-agent cases use the
  deterministic fixture gateway; no external inference is required. A `--tdd` CLI flag is a
  follow-up once the operation option surface is free.
- Not included: automatic test generation from requirements, coverage-guided exploration, and mutation/regression
  scoring beyond the existing verifier and independence rules.
