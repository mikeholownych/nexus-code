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

## Also requested: `docs/v1.0.0/READINESS.md` (codex-claimed)

`READINESS.md` still describes both decisions as open. Requested edits:

- **Line 17:** "The T4 denominator conflict (eight stated classes versus nine enumerated cases) and CJK/Hangul tokenizer acceptance conflict remain unresolved owner/spec decisions." → both are now resolved: T4 denominator by the **DEC-05 amendment (2026-10-17, nine classes retained)** and the tokenizer conflict by **DEC-17**. Remaining pending items in that sentence (T3 authoring, manual terminal acceptance, M5 execution, independent acceptance, exact-RC package checks, cross-runner reproducibility, publication) are unchanged.
- **Line 39 (`REQ-AGT-118` row):** replace the "conflicts with … keep both criteria and the requirement open" text with: conflict **resolved by DEC-17** (admission-safety floor takes precedence; `≤ 1.5×` accuracy band scoped to corpora the floor does not dominate; failed measurements preserved). Status stays **`partial`**: changed-test execution and independent review of the amendment are still pending. The "do not call `ACC-VER-07` passed" instruction remains correct and in force.
- **Line 49 (`REQ-QUAL-105` row):** the documented conflict ("DEC-05 says eight classes, ACCEPTANCE §6.2 lists nine") is **resolved — nine classes retained** (DEC-05 amendment, 2026-10-17; SIGTERM/resume is the ninth class). What remains is unchanged: the ACCEPTANCE §6.2 one-line edit (above) and the frozen 9 × 5 execution evidence.

- **Line 33 (`REQ-AGT-004` row):** the ledger's stale claim "the durable-work-unit path does not yet apply the behavior" was corrected in REQUIREMENTS.md on this branch (AGT-02a applied to work units by PR-4b; crash-boundary evidence remains depth-0 — see `../INDEP-REVIEW-CONTINUITY/findings-verification.md` M2 and `dispositions.md`). Mirror the same correction in the READINESS row.

## Also for the custodian (not a code change)

REQ-QUAL-101 requires the held-out corpus manifest to be committed to the repository (`eval/heldout-manifest.json`, per CONCURRENCY §8 / PLAN-10) **before RC1**. It currently exists only in `~/nexus-heldout/` and is not yet reproducible in the hidden-test half. Coordinate with the custodian before treating any corpus as held-out evidence. See `custody-report-2026-10-17.md`.

Independent review of this amendment (approve-with-issues; issues addressed on-branch): `independent-review-dec17.md`.
