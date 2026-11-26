# Harness Improvement Runs (HIR)

Harness Improvement Runs are a Nexus-native, evidence-gated workflow for improving harnesses without mutating live harness state.

## Safety model

- **No live mutation:** HIR never writes active profile, global config, installed skills, or repo-managed harness files.
- **Pinned policy:** probe runs cannot weaken approval/sandbox/redaction invariants.
- **Deterministic evidence first:** mock/real probes require deterministic verifiers or artifact checks in v1.3.1; no deterministic oracle blocks/reviews.
- **Review-only promotion:** HIR emits promotion reports and draft library entries. Operators must review and manually apply accepted changes.

## CLI

```bash
nexus harness init --task-suite <suite.json> --base <path> [--base-kind path|profile|fixture] [--json]
nexus harness run <hir-id> --mock [--candidate <path>] [--json]
nexus harness run <hir-id> --real [--candidate <path>] [--json]
nexus harness status [hir-id] [--json]
nexus harness show <hir-id> [--json]
nexus harness report <hir-id> [--json] [--out report.md]
nexus harness cancel <hir-id> [--json]
nexus harness library list|show <id>|accept <id>|reject <id> [--json]
```

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

## Limits (v1.3.1 MVP)

- Real probes support deterministic verifier/artifact cases and run in isolated temp workspaces.
- No auto-apply. Library accept/reject records operator decision only; it does not mutate live harnesses.
- Profile snapshot copies files from an explicit path/profile source; review snapshots/reports for sensitive content before sharing.
