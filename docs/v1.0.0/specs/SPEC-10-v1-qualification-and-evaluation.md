# SPEC-10: v1 qualification and task-quality evaluation

| | |
|---|---|
| Status | Ready. Protocol and thresholds fixed by [DEC-05](../DECISIONS.md#dec-05-v1-evaluation-protocol-and-thresholds); task authorship needs owner action X2. |
| Release class | **BLOCKER** for any v1 maturity claim: held-out matched evaluation, fault-injection qualification, standalone live qualification, scoring integrity. RELEASE-REQUIRED: T3 long tasks, a T4 smoke test in CI, a PTY terminal matrix. |
| Requirements | REQ-QUAL-101, REQ-QUAL-102, REQ-QUAL-103, REQ-QUAL-104, REQ-QUAL-105, REQ-QUAL-106, REQ-QUAL-107, REQ-QUAL-108 |
| Findings | EVL-001, EVL-002, EVL-003, EVL-004, EVL-005, HIST-08, PRV G1/G2, TUI gaps (kitty/real terminals), VER-07 |
| Plan | [PLAN-10](../plans/PLAN-10-v1-qualification-and-evaluation.md) |
| Acceptance | ACCEPTANCE.md §4–§7 |

## 1. Problem

The only scored task-quality evidence is a 6-task, in-repo T2 fixture pilot (`docs/reviews/evidence/eval_pilot_2026-10-13/RESULT.md`), and its own write-up says it was used for tuning: "it does not qualify Nexus".

| Run | Result | Peer |
|---|---|---|
| First pilot | NOT QUALIFIED (2 false VERIFIED) | — |
| Rerun on ed17e99 | 26/30, 0 false VERIFIED | Goose 80% |

Both results are on tuned tasks. The following are missing entirely:

- a held-out task set;
- T3 long tasks;
- T4 fault injection;
- a run on the release commit (db1ca55 was never evaluated).

Scoring integrity issues:

- **EVL-002.** Any Nexus run without a parsed turn (for example a crash) is rerun as "infrastructure". Peers are rerun only on a connection-error signature. This biases results in Nexus's favour and hides the crash rate.
- **EVL-003.** Hidden tests are readable by the agent, and contaminated runs still count in pooled rates.
- **EVL-004.** Model identity is recorded as an alias only. No sampling settings are recorded. The full operator env is inherited.
- **EVL-005.** Recovery, intervention and cost metrics are missing.

`nexus eval` (the SWE-bench-style command) scores the repo's last commit instead of the agent's change, and runs `git checkout` in the operator's workspace (VER-07). It must not be used for any published number.

Standalone live inference evidence is absent (HIST-08; SPEC-05). Real-terminal coverage (kitty, tmux, VS Code, xterm) is not established. pyte emulation cannot answer kitty keyboard queries (D §6).

## 2. Requirements

1. **REQ-QUAL-101. Held-out matched evaluation.**
   - At least 40 tasks (DEC-05).
   - At least 50% come from external repositories at pinned commits, covering JS/TS, Python, Rust and Go.
   - The held-out half is authored by someone other than the implementer and stored outside the repo until the freeze. Its manifest of sha256 hashes is committed before the RC freeze.
   - The pilot tasks and the routing engx tasks are the *development* set only.
2. **REQ-QUAL-102. Matched conditions.** Each run records:
   - a clean RC commit;
   - a model fingerprint: weights sha256, server kind and build, and sampling (temperature 0, or a fixed seed where supported);
   - identical step and minute budgets;
   - an allow-listed environment;
   - serial execution, or recorded queueing.

   A run with any field missing is invalid.
3. **REQ-QUAL-103. Repetitions and peers.** At least 5 runs per (task, config). Matched peers are Goose and OpenCode on the same model (DEC-05).
4. **REQ-QUAL-104. Metrics, reported separately.**
   - hidden-test correctness;
   - completion claimed;
   - **false VERIFIED** (hard gate = 0);
   - regressions (repo suite, plus a pre/post diff of previously passing tests);
   - crash rate and timeout rate;
   - bounded-failure truthfulness;
   - operator interventions (= 0 in `run` mode);
   - tokens and wall time per correct task.
5. **REQ-QUAL-105. T4 fault injection.** 9 fault classes × 5 runs (DEC-05 amendment, 2026-10-17: the union of the distinct scenarios below):
   1. gateway refuses connections mid-turn;
   2. 5xx/overloaded;
   3. stream cut mid-tool-call;
   4. output-limit truncation;
   5. hanging test command;
   6. workspace disk full;
   7. context overflow at 32k;
   8. malformed tool-call JSON;
   9. SIGTERM mid-turn, then resume.

   Gate (proposal): 100% truthful outcome, 0 false VERIFIED, 0 hangs beyond budget + 5 minutes.
6. **REQ-QUAL-106. Scoring integrity.**
   - Infrastructure reruns are symmetric and evidence-based: the endpoint was unreachable before the first model call.
   - Contaminated runs are excluded from pooled rates.
   - Hidden tests are not readable by the agent uid.
   - The scorer logs every replacement.
   - `nexus eval` is labelled experimental and excluded from claims (DEC-07).
7. **REQ-QUAL-107. Standalone and provider matrix.** The live standalone set (a T2 subset of ≥ 10 tasks plus a T4 subset) is run through the gateway-stripping proxy in its plain profile and its emulated-server profiles (DEC-16). `providers verify` is run live for each provider listed as supported (DEC-06). Receipts are archived.
8. **REQ-QUAL-108. Terminal matrix.** PTY scripted runs in CI (existing `tui_*_e2e`, plus the new ACC-SAFE and ACC-PROC scripts) are mandatory. A manual matrix covers {xterm, kitty, tmux, VS Code terminal, GNOME Terminal} × {80x24, 40x14, 200x60}, checking: approval safety, paste, resize, cancel, narrow hints and NO_COLOR. All 15 cells require actual operator execution and per-cell verdict/evidence bound to the exact installed RC; automated terminal evidence does not replace this gate. Screenshot artifacts alone are waived by [DEC-18](../DECISIONS.md#dec-18-v100-terminal-screenshot-artifact-waiver). [DEC-19](../DECISIONS.md#dec-19-v100-manual-terminal-matrix-waiver) withdraws the prior matrix waiver record.
9. **REQ-QUAL-109 (RELEASE-REQUIRED).** T3 long tasks: at least 8 tasks × 5 runs, each over 60 steps and with at least 2 compactions. Gates: false-absence = 0, false-presence = 0 (DEC-05 amendment, 2026-10-18), and steering honoured ≥ 95% (eval/README thresholds).
10. **REQ-QUAL-110 (RELEASE-REQUIRED).** A T4 smoke (scripted model, 2 fault cases) and the T1 self-test run in `make test`.

## 3. Design

- **Harness fixes** in `eval/infra.mjs:31` and `eval/score.mjs:16-21,48-84`:
  - classify a run as infrastructure only when `first_model_request_at` is missing **and** an endpoint-unreachable signature is present, for every agent;
  - add `replaced_by` logging;
  - exclude `contaminated: true` runs from pooled rates;
  - add the new metric columns.
- **Hidden-test isolation.** Private validators and expected answers must remain outside every task process's readable namespace. A task workspace may contain only its permitted baseline and task inputs; evaluation of private expectations must be performed outside that task boundary. Corpus custody and evaluator execution isolation are separate acceptance gates: the custodian's sealed-store disposition does not establish that the runner prevents task processes from reading validators. On the current integration candidate, evaluator-boundary acceptance remains open; PR #33 is not qualified for held-out use until the actual workspace-construction and execution path demonstrates this boundary and passes independent review. Do not use filesystem ownership of the custodian store as a substitute for validating the task-process boundary.
- **Fingerprint.** `eval/fingerprint.mjs` queries `/v1/models` and the server-specific endpoints (SPEC-05 `ServerKind`) and records the weights hash supplied in the config. A run is refused without it.
- **Fault injector.** `eval/faults/proxy.mjs` is an HTTP proxy in front of the model server that injects faults 1–4 and 7–8 by schedule. Faults 5, 6 and 9 are injected by the task fixture or the runner.
- **Task authoring.** Use a `task.json` schema with `{repo, commit, prompt, hidden_tests, fail_to_pass, pass_to_pass, class, difficulty}`. Calibrate so that no task is solved 5/5 by every agent (EVL G6).

## 4. Procedure and evidence

- See [ACCEPTANCE.md](../ACCEPTANCE.md) §4–§7 for the qualification runbook, environments and pass/fail table.
- All runs are archived under `docs/reviews/evidence/v1-qualification/<rc>/`, with the manifest, raw JSONL, the scorer output and SHA256SUMS.

## 5. Dependencies

- SPEC-01 (`run` mode needs an explicit `--yes`).
- SPEC-02 (cancel and SIGTERM semantics).
- SPEC-04 (resume).
- SPEC-05 (server kind, receipts).
- DEC-05, DEC-06 and DEC-07 (all resolved). Owner actions X2, X3 and X4 are needed.
- Hardware: the homelab inference host, reached through its gateway only, is the sole inference path (DEC-16). Every agent's runs are serial on it.
