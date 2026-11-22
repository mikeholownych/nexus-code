# PA-4 comparative workflow evaluation

Status: protocol implemented; development-harness tests pass; comparative inference results and held-out qualification are pending.

## Scope and arms

The harness compares identical versioned tasks through five bounded Nexus execution paths:

1. **Serial:** the existing single-agent `nexus run` adapter.
2. **Independent agents:** one parent turn requests three separate read-only subagent analyses before doing the unchanged objective.
3. **Specialist-assisted:** `/team full --independent-review <objective>`.
4. **Durable goal:** `/goal <objective>`.
5. **Bounded batch:** `/batch <generated-spec>` with a sequential research, design, implementation, verification, and review graph.

Each arm reuses `eval/run.mjs`, its isolated model proxy, workspace and HOME creation, task snapshots, hidden evaluators, and result receipts. Workflow commands run through the same sidecar protocol used by terminal clients. The generated batch specification is removed after execution; bounded command output, including rendered unit outcomes, is retained in the run record and raw sidecar events in the run logs. Per-run HOME state is removed after scoring, so this protocol does not claim restart/recovery evidence. The ordinary serial arm stays on the standard one-shot CLI adapter.

The independent-agent arm is counted as compliant only when the sidecar observes exactly three successful `spawn_subagent` tool completions. A model that ignores the treatment instruction produces a non-compliant trial rather than evidence for multi-agent execution.

## Controls and scoring

The input provider config, dataset digest, task objective, budgets, model, context/output limits, and sampling are common to all arms. Each run receives a fresh isolated workspace and HOME. Arm order rotates by task and replicate. Failed and interrupted runs retain their logs and are included in the denominator. The evaluator verifies the same deterministic artifact and regression criteria after each arm.

The score reports deterministic task success first, then end-to-end `eval/run.mjs` process wall time and inference request counts. Wall time includes preparation and deterministic post-run evaluation, and failed invocations remain in the wall-time and success-rate denominators. Efficiency comparison requires complete task/replicate coverage for all five arms, at least one serial success, ten attempts per arm, no lower observed success, a no-worse 95% Wilson lower bound, and one complete matching model fingerprint across every attempt. Model identity must include a valid served-weight SHA-256 and server build; an alias alone is insufficient. Independent acceptance is not collected by this development scorer and remains a separate review gate. Token fields retain runner provenance; estimates remain estimates, and absent telemetry remains unavailable. A comparison does not establish improvement from latency or throughput alone. The batch reviewer role is not treated as an independent acceptance verdict.

## Evidence and limits

Local deterministic tests cover arm mapping, operation-spec graph construction, Unicode/objective retention, sidecar terminal-receipt handling, runner tier admission, scorer denominators, zero-acceptance handling, and model-fingerprint mismatch. No inference comparison was run while the repository's GATEWAY claim was held by another workstream. The harness refuses `qualification: true` and rejects T3/T4 datasets until their interaction semantics are preserved across all arms: this implementation is a repeatable T1/T2 development protocol, not held-out evidence. It does not claim measured comparative outcomes, security qualification, or acceptance superiority. A separately authorized held-out run and independent review remain required.

## Reproduction

See `eval/README.md`, section “PA-4 orchestration comparison (development protocol),” for commands and required inputs. Each output directory has a pinned dataset/config manifest, per-arm runner manifests and raw logs, `runs.jsonl`, and an aggregate score generated with `eval/score_workflows.mjs`.
