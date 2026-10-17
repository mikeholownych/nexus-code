# Handoff to the codex agent: ACCEPTANCE §6.2 T4 class count (claimed file)

| | |
|---|---|
| Date | 2026-10-17 |
| From | `opencode` slice `GOV_DEC_AMENDMENTS` |
| To | `codex` (holder of `FILE_docs_v1.0.0_ACCEPTANCE.md`, branch `v1/plan-10-readiness-current`) |
| Reason | `ACCEPTANCE.md` is under an active codex file claim; the governance slice must not edit a claimed file. |

## Change requested

`docs/v1.0.0/ACCEPTANCE.md` §6.2 currently reads (line 189):

```
8 fault classes × 5 runs on the Nexus RC, via `eval/faults/proxy.mjs` and the fixture hooks:
```

The block then enumerates **nine** distinct scenarios (refused connection; 5xx/overloaded; stream cut mid-tool-call; output-limit truncation; hanging test command; disk full; context overflow at 32k; malformed tool-call JSON; SIGTERM then `run --resume`).

**Edit:** change the count from `8` to `9`:

```
9 fault classes × 5 runs on the Nexus RC, via `eval/faults/proxy.mjs` and the fixture hooks:
```

This aligns ACCEPTANCE §6.2 with the DEC-05 amendment (2026-10-17) and with SPEC-10 §2.5, both already updated by the governance slice. The union of the distinct scenarios is retained; no scenario is dropped or merged.

## Consistency check (already satisfied)

- `eval/model_proxy.mjs` `FAULT_KINDS` injects 6 kinds (`refuse`, `overloaded`, `stream_cut`, `truncate`, `context_overflow`, `malformed_tool_json`).
- `eval/README.md` §"Fault injection (T4)" states the remaining classes come from task fixtures (hanging test command, disk full) and the SIGTERM-then-resume runner case → 6 + 3 = **9**.
- **No `eval/` code change is required** for this correction.

## Also for the custodian (not a code change)

REQ-QUAL-101 requires the held-out corpus manifest to be committed to the repository (`eval/heldout-manifest.json`, per CONCURRENCY §8 / PLAN-10) **before RC1**. It currently exists only in `~/nexus-heldout/` and is not yet reproducible in the hidden-test half. Coordinate with the custodian before treating any corpus as held-out evidence. See `custody-report-2026-10-17.md`.
