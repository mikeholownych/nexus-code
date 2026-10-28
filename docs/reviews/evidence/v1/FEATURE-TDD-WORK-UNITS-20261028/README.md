# TDD-first durable work units: implementation evidence

| | |
|---|---|
| Base | `59f07c46` (`origin/main`, RC10 + runner decomposition #287) |
| Branch | `v1/feature-tdd-work-units` |
| Entry point | `NEXUS_TDD=1 nexus operation run …` (programmatic `tdd: true`; CLI flag is a follow-up) |
| Scope | Implementer/default units only; tester and read-only roles unchanged |

## Behaviour verified

`cli/test/tdd_work_units.test.ts` — 13 cases — covers:

1. **RED then GREEN** — the first turn receives the RED protocol and must return `FAILED` verifier evidence with
   `hasExecutedTests`, plus a test file whose candidate hash changed; the evidence is written to
   `~/.nexus/tdd/<task>.json` (unit id + prompt hash keyed) and the second turn receives the GREEN protocol with the
   command and test paths.
2. **No switch** — exactly one ordinary turn, no protocol text.
3. **Invalid RED** — a completed RED turn without a failing executed test fails the unit before any implementation and
   does not run GREEN.
4. **Resume / compaction** — a unit whose conversation state is lost but whose private sidecar still holds valid,
   hash-matching evidence skips RED and runs GREEN once; a sidecar for a different prompt does not skip RED.
5. **Revise invalidation** — a sidecar written for the old prompt does not skip RED for the revised task.
6. **Restart** — an explicit operator restart deletes the sidecar and reruns RED.
7. **No test-file change** — a failing verifier without a new/changed test file fails RED.
8. **Role exclusion** — tester units never enter the protocol.
9. **Real RED turn** — a deterministic gateway writes a failing `node --test` file and calls `task_completed`; the RED
   turn ends `COMPLETED / VERIFIER_FAILED` with `hasExecutedTests: true`. The test prefixes the verifier with
   `env -u NODE_TEST_CONTEXT` because the test runner exports that variable and a child `node --test` inherits it;
   production commands do not.
10. **Real RED→GREEN** — the first test added to a repository that had no tests: RED records `VERIFIER_FAILED`, the
    verifier baseline is rebased onto the RED test set, GREEN edits the product file and the unit completes with
    outcome `VERIFIED` through the full verifier, test-stability and deliverable-binding gates.
11. **Narrowed oracle refused** — RED rewrites `package.json`'s `scripts.test` and adds its own test: the bounded rebase
    refuses (`the RED phase changed the verification oracle`) and the unit fails before GREEN.
12. **Created oracle refused** — with no verifier before RED, a RED-created `package.json` gives no pre-RED baseline, so
    the rebase refuses and the unit fails.
13. **No `tddRed`, no failing completion** — the same failing `node --test` file submitted without the per-turn boundary
    is rejected by `task_completed` and the turn is not `VERIFIED`.

`tdd_work_units` + `convergence_scheduling` + `operation_runner_refactor`: **54/54 pass**, including four real-agent turns
against the fixture gateway; `tsc --noEmit` and `git diff --check` clean, isolated `HOME`/`XDG_CONFIG_HOME`.

## Residuals

- RED evidence is a private sidecar, not an authenticated attestation; a local operator who can write it can forge it.
  The GREEN verifier gate remains authoritative.
- TDD requires a Git workspace for the test-change diff; a non-Git workspace fails RED.
- The RED turn skips only the workspace-verifier **definition-binding** early return, because adding the reproduction
  test changes that definition. The executor then rebases the baseline onto exactly the reported RED test set: any other
  test or verifier-definition change, a changed command, or a pre-existing test change with no pre-RED definition
  snapshot refuses the rebase and fails the unit. GREEN itself has no relaxation and editing the RED test during GREEN
  fails test-set stability.
- A resumed unit with valid RED evidence runs GREEN without a rebase (no fresh pre-RED tree); the existing recovered-unit
  posture still caps it below `VERIFIED`, and restart is the path to a bound result.
- The sidecar is keyed by task id and prompt hash and is not deleted on completion; committing the RED test outside the
  harness makes `testHashes` stale and reruns RED.
- RED uses the verifier the agent selects for that turn (configured or discovered); it does not require a specific test
  framework beyond the existing verifier rules.
- Two turns consume two per-turn step budgets; the unit still counts as one scheduler run.
- CLI activation is `NEXUS_TDD=1` for now; the `--tdd` flag waits on the operation option surface owned by the
  policy-config refactor.
- Automatic test generation, coverage-guided exploration and regression scoring beyond the existing verifier and
  independence checks are not included in this slice.
