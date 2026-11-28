# Harness Improvement Runs (HIR)

Harness Improvement Runs are a Nexus-native, evidence-gated workflow for improving harnesses without mutating live harness state.

## Safety model

- **No live mutation:** HIR never writes active profile, global config, installed skills, or repo-managed harness files.
- **Pinned policy:** probe runs cannot weaken approval/sandbox/redaction invariants.
- **Deterministic evidence first:** mock/real probes require deterministic verifiers or artifact checks in v1.3.1; no deterministic oracle blocks/reviews.
- **Review-only promotion:** HIR emits promotion reports and draft library entries. Operators must review and manually apply accepted changes.

## CLI

```bash
nexus harness init --task-suite <suite.json> --base <path> [--base-kind path|profile|fixture] [--max-rounds N] [--max-candidates-per-round N] [--max-probes N] [--json]
nexus harness run <hir-id> --mock [--candidate <path> ...] [--json]
nexus harness run <hir-id> --real [--allow-unsandboxed-real-probe] [--candidate <path> ...] [--json]
nexus harness run <hir-id> --nexus-agent [--nexus-propose] [--nexus-model ... --nexus-endpoint ...] [--candidate <path> ...] [--json]
nexus harness status [hir-id] [--json]
nexus harness show <hir-id> [--json]
nexus harness report <hir-id> [--json] [--out report.md]
nexus harness apply-preview <hir-id> [--json]
nexus harness cancel <hir-id> [--json]
nexus harness library list|show <id>|accept <id>|reject <id> [--json]
```

`--nexus-agent` runs probes through the Nexus agent in an isolated copied candidate workspace and requires deterministic verifier/artifact oracles. `--nexus-propose` enables model-backed round>1 proposal generation in isolated workspace; proposals/reflections/library lessons are advisory and never auto-applied.

## Slash command

The sidecar/TUI exposes `/harness ...` with the same subcommands. Output is bounded/JSON-formatted where possible.

## Task suite format

```json
{
  "schemaVersion": 1,
  "id": "suite-id",
  "cases": [
    {
      "id": "case-1",
      "description": "Checks expected artifact exists",
      "prompt": "Operator prompt/context",
      "expected": {
        "artifactPath": "artifact.txt",
        "verifierCommand": "test -f artifact.txt"
      }
    }
  ]
}
```

`verifierCommand` and `artifactPath` are deterministic checks. Commands run only in isolated real-probe workspaces with scrubbed environment.

## State layout

HIR stores durable state under `<state>/harness/` (default `~/.nexus/harness` or `NEXUS_STATE_DIR/harness`):

- `runs/<hir-id>/run.json`, `events.jsonl`, `evidence.jsonl`, `report.json`, `report.md`
- `bases/<harness-id>/manifest.json`, `tree/...`
- `candidates/<candidate-id>/manifest.json`
- `probes/<probe-id>/result.json`
- `library/entries/<hlesson-id>.json`

## Limits / invariants

- **No live mutation / no auto-apply.** Library accept/reject and apply-preview are review-only; manual reviewed apply is required.
- Real/Nexus-agent probes run in isolated temp workspaces and require deterministic verifier/artifact oracles in v1.3.1.
- Nexus agent/proposal modes require explicit model/endpoint config; credentials should come from env/config, not committed files.
- Profile snapshot copies files from an explicit path/profile source; review snapshots/reports for sensitive content before sharing. Redaction is heuristic.

## Real probe sandbox policy

`--real` runs verifier commands in isolated temp workspaces and attempts OS sandboxing via Nexus sandbox backends (bwrap/docker, network off). If no OS sandbox is available, HIR blocks real probes unless `--allow-unsandboxed-real-probe` is explicitly set (unsafe, owner-approved only).

## v1.3.1 hardening notes

- Scorecards include confidence and cost/latency dimensions where evidence exists.
- Advisory scorecard entries are explicitly labeled `advisory` and include `advisoryReason`; they are non-authoritative and must not be auto-promoted. Rubric references are recorded as advisory evidence only.
- Orchestrator enforces probe/wall-clock/token budgets and uses bounded parallel case probing (`maxConcurrentProbes`, capped). Round completion events record probe concurrency.
- Library retrieval ranks by base/profile/tag/status/confidence/evidence recency and dedupes normalized statements.
- Promotion reports include confidence calibration summaries (deterministic vs advisory avg confidence) and explicit non-authoritative advisory labeling.
- Apply preview remains review-only and includes rollback guidance (preview.json/md include `rollbackPlan` and explicit no-live-mutation warning); Nexus HIR never mutates live harness/profile state.
