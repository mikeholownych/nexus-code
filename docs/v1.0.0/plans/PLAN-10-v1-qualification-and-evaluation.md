# PLAN-10: v1 qualification and task-quality evaluation

Implements [SPEC-10](../specs/SPEC-10-v1-qualification-and-evaluation.md). Harness fixes are milestone **M3**. Task authoring runs in parallel from M1. Runs are **M5**.

- Requirements: REQ-QUAL-101 to REQ-QUAL-110.
- Decisions: DEC-05, DEC-06, DEC-07.
- Owner actions: X2, X3, X4, X5.

## Safe change boundary

- `eval/run.mjs`, `eval/score.mjs`, `eval/infra.mjs`
- new `eval/fingerprint.mjs`
- new `eval/faults/`
- `eval/tasks/`
- `eval/configs/`
- `eval/README.md`
- `cli/test/eval_harness.test.ts`
- `Makefile` (T4 smoke)

## Tasks

| # | Task | Location | Depends on |
|---|---|---|---|
| 1 | Symmetric infrastructure classification. A run counts as infrastructure only when `first_model_request_at` is missing **and** there is an unreachable signature. Same rule for every agent. Crash and timeout rates are reported. | `infra.mjs:31`; `run.mjs` (record `first_model_request_at` from the proxy log) | — |
| 2 | Scorer: log replacements; exclude contaminated runs from pooled rates; add metric columns for intervention, recovery, bounded-failure truthfulness, cost per correct task, and pre/post regression diff. | `score.mjs:16-21,48-84` | 1 |
| 3 | Hidden-test isolation. Hidden tests are stored under a separate uid (`nexus-eval`, created by the operator, owner action under X3) with mode 0700, and copied in after the agent exits. The agent runs with an allow-listed env. | `run.mjs:57-59,114,178` | — |
| 4 | Fingerprint. Record server kind, build, weights sha256 (from config), and sampling settings. Refuse the run if the fingerprint is missing. Temperature 0 or a fixed seed for every agent where the agent supports it. | new `fingerprint.mjs`; `configs/*.json` | PLAN-05 task 1 |
| 5 | Fault proxy for T4 classes 1–4 and 7–8, scheduled per run. Fixture hooks for 5 (hanging test), 6 (disk full via a small loop-mounted fs or `ulimit -f`), and 9 (SIGTERM then `run --resume`). | new `eval/faults/proxy.mjs`; task fixtures | PLAN-04 task 1 |
| 6 | T4 smoke in `make test`: scripted model plus 2 fault cases. The T1 self-test stays. | `cli/test/eval_harness.test.ts`; `Makefile` | 5 |
| 7 | Task schema `{repo, commit, prompt, hidden_tests, fail_to_pass, pass_to_pass, class, difficulty}`, with a validator. | `eval/tasks/schema.json`; `run.mjs` | — |
| 8 | Author tasks (owner action X2). Development set: the existing 6 plus routing engx T01–T12. Held-out set: 40 T2 tasks, of which at least 20 are external, at least 6 per class, across 4 languages. Plus 8 T3 tasks. The sha256 manifest is committed before RC freeze. Calibrate on the development set only. | external store; `eval/heldout-manifest.json` | 7 |
| 9 | Peer adapters: confirm Goose and OpenCode on the same model and budgets, and record peer versions. | `run.mjs:120-143` | 4 |
| 10 | Mark `nexus eval` experimental (help and docs). Fix its operator-workspace checkout: run in a worktree (VER-07a). | `index.ts:663-688`; `evaluator.ts:128` | — |
| 11 | M5 runs: T2 held-out (5×), T3 (5×), T4 (9×5), standalone subset (PLAN-05), provider verify (DEC-06). Archive everything under `docs/reviews/evidence/v1-qualification/<rc>/`. | runbook in ACCEPTANCE §4–§6 | all, RC build |
| 13 | `eval/standalone/plain_proxy.mjs`: a forward proxy to the gateway. It injects the gateway token server-side. It strips `/v1/models` to `{id,object,owned_by}`, returns 404 for `/v1/tokenize`, and drops `X-AIHost-*` and admission headers. The `--emulate {llamacpp,vllm,ollama}` profiles add that server's `/models`, `/props`, `/api/show` and overflow-error shapes, derived from the real gateway limits. Unit-tested against a mock gateway. | new `eval/standalone/` | — |
| 12 | Manual terminal matrix: waived for v1.0.0 by [DEC-19](../DECISIONS.md#dec-19-v100-manual-terminal-matrix-waiver), not passed; no manual cells or evidence are required. Retain the five-environment × three-size procedure in ACCEPTANCE §5.3 for a successor release. CI PTY and installed-RC scripted PTY scenarios in ACCEPTANCE §5.1–§5.2 remain required for v1.0.0. | ACCEPTANCE §5.1–§5.3; DEC-19 | v1.0.0 automated PTY gates; manual matrix for a successor release |

## PR slices

- **PR-10a:** tasks 1, 2.
- **PR-10b:** tasks 3, 4, 7.
- **PR-10c:** tasks 5, 6.
- **PR-10d:** tasks 9, 10.
- **PR-10e:** task 13 (standalone proxy).

Task 8 is data work. Tasks 11 and 12 are operations work.

## Tests

- `eval_harness.test.ts`:
  - infra symmetry: a Nexus crash is counted as a failure, not rerun;
  - contamination: an agent that `cat`s the hidden path is flagged and excluded from the pool;
  - fingerprint refusal;
  - T4 smoke.

## Effort and uncertainty

| Work | Estimate | Main uncertainty |
|---|---|---|
| Harness fixes | 4–6 engineer-days | — |
| Task authoring | 40 T2 tasks at 1–2 hours each, plus 8 T3 tasks at 3–4 hours each: roughly 10–14 days of author time | Author availability (X2) |
| Run wall time (historical estimate; see below) | (40×5 + 8×5 + 40) runs per agent × 3 agents ≈ 840 runs. At a median 6 min/run serial on one inference host, about 84 hours, roughly 4 days of continuous inference. T3 runs are longer. | Inference-host availability and thermal behaviour (see the `experiments/thermal-soak` history). This is the critical-path risk for M5. |

The original run-wall-time estimate above predates the nine-class T4 correction and applies three agents uniformly. It is retained as historical planning evidence, not a current run count or schedule. Before qualification, derive the schedule from the frozen workload and agent matrix in ACCEPTANCE §6: T2 specifies three agents; T4 specifies the Nexus RC only.

## Definition of done

- Applicable evidence for REQ-QUAL-101 to REQ-QUAL-108 is archived. For REQ-QUAL-108, record ACC-TUI-MANUAL as waived, not passed, under DEC-19; the CI and installed-RC scripted PTY criteria remain required.
- The DEC-05 thresholds were evaluated with the scorer verdict table, signed off before the run and reported after it.
- REQ-QUAL-109/110 are met.
