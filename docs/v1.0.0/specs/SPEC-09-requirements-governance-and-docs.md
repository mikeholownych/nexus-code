# SPEC-09: Requirements governance and documentation truth

| | |
|---|---|
| Status | Ready. Issue #12 dispositions per [DEC-04](../DECISIONS.md#dec-04-issue-12-open-normative-blockers). |
| Release class | **BLOCKER**: a single authoritative v1 ledger, with each blocker bound to a test, and a written disposition for Issue #12's open blockers. RELEASE-REQUIRED: documentation corrections. |
| Requirements | REQ-OPS-101, REQ-OPS-102, REQ-OPS-103, REQ-DX-105, REQ-DX-106 |
| Findings | HIST-01, HIST-02, HIST-03, HIST-06, HIST-09, HIST-10, HIST-11, DOC-01, PRV-17, AGT-07, CON-012, EVL-006, VER-07 (EXEC-011 claim) |
| Plan | [PLAN-09](../plans/PLAN-09-requirements-governance-and-docs.md) |
| Acceptance | ACC-GOV-01 to ACC-GOV-06 |

## 1. Problem

**Two requirement regimes, neither current.** Issue #12 defined 122 normative IDs and ended **OPEN**, with CTX-001, CTX-002 and EXT-004 blocking. From 2026-10-03 the project moved to review-driven qualification (B1–B8, Q1–Q8, compaction ledger) without mapping those reviews back to the 122 IDs (F §2).

**Stale DEMONSTRATED labels.** At least 10 rows labelled DEMONSTRATED or SATISFIED were reproduced as broken 11 days later (HIST-02). Most were fixed in `3290234`, but the matrix was never updated. This audit found more contradictions at HEAD:

| Requirement | Claim | Contradicting finding |
|---|---|---|
| EXEC-009, SUBP-004 | Subprocesses terminated on cancel | TUI-01 |
| EXEC-011 | Evaluators score the exact candidate | VER-07 |
| UI-004 | The TUI is the default surface | REL-01 |

**Documentation promises behaviour the code does not have.**
- A worker-thread plugin sandbox (HIST-03).
- "Parity with Codex and Claude Code" (HIST-06).
- Wrong commands such as `nexus --approve`, `nexus -r` and `harness repl`.
- Homelab hardware in ARCHITECTURE.md.
- The denylist and path jail presented as boundaries (DOC-01).
- Redaction on every error path, and "no catalog cache" (PRV-17).
- A 15-step team cap (AGT-07).
- A stale contest critical-path document (CON-012).
- Eval README status (EVL-006).

**Untracked open work.** Open work lives only in markdown across about 40 documents. GitHub has 0 issues (HIST-10). Supersessions (UI-006/007, DEDUP-003, "no Git remote") were never recorded (HIST-11).

**Unaccepted alpha.2 changes.** The compaction/continuity changes shipped in alpha.2 still say "Independent acceptance is pending" (HIST-09).

## 2. Requirements

1. **REQ-OPS-101.** `docs/v1.0.0/REQUIREMENTS.md` is the single authoritative ledger for v1. Each row has:
   - a stable ID and source;
   - a status in {implemented, tested, visually-accepted, product-qualified, open};
   - a test reference (`file::case`) or an acceptance ID;
   - the last-verified commit.

   The Issue #12 matrices and the `PHASE*`/`WP*`/`CRED003`/`PERS002` documents are marked **HISTORICAL** by the index `docs/HISTORICAL.md`. They are not edited, because many are pinned by SHA-256 in later documents. Older `docs/reviews/*` carry an in-file banner, since nothing pins them.
2. **REQ-OPS-102.** A CI script (`scripts/check_requirements.mjs`) parses the ledger. It fails if any BLOCKER or RELEASE-REQUIRED row lacks a test or acceptance reference, or references a test name that does not exist in the suite.
3. **REQ-OPS-103.** Issue #12's open blockers (CTX-001, CTX-002, EXT-004) and the quietly superseded items (UI-006/007, DEDUP-003, "no remote", SUBP-004/005 deferrals) each have a written disposition in the ledger (implemented, waived with rationale, or superseded), per DEC-04.
4. **REQ-DX-105.** User-facing docs (README, quickstart, USER_MANUAL, CLIENT_GUIDE, ARCHITECTURE, CLOUD_PROVIDERS, MCP_GUIDE, SKILLS_AND_PLUGINS, DOCTOR_TROUBLESHOOTING):
   - make no claims contradicted by source at the RC;
   - contain no homelab identifiers;
   - make no parity or marketing claims without evidence;
   - describe the tripwire, path jail and egress controls with their real limits.

   A doc-review checklist (§3.2) is signed off for the RC.
5. **REQ-DX-106.** Open v1 work is tracked as GitHub issues under a `v1.0.0` milestone, one per plan task group, linked from the ledger. This is RELEASE-REQUIRED as a process, not a blocker.
6. **REQ-AGT-110** (from SPEC-04). Independent acceptance of the alpha.2 continuity and truncation work is recorded.

## 3. Design

### 3.1 Ledger mechanics

- Ledger rows use `REQ-<AREA>-<NNN>`. Rows 001–099 are reserved for carried-over historical commitments, with a cross-reference column naming the original ID. Rows 100 and above are new v1 requirements.
- The test reference format is `cli/test/<file>.test.ts::"<test name substring>"`, `core/...::<fn>`, or `ACC-<ID>`.
- `check_requirements.mjs` greps test sources for the substring and fails when it is missing. It also emits a coverage table into the CI summary.

### 3.2 Doc review checklist (per RC)

| Doc | Required change |
|---|---|
| `USER_MANUAL.md:3` | Remove the parity claim. |
| `USER_MANUAL.md:12-26` | Commands match SPEC-06. |
| `USER_MANUAL.md:294-295` | State the real plugin trust model and directories. |
| `ARCHITECTURE.md` | Remove homelab hardware and port 18010. Name the Rust TUI and the sidecar. Rewrite §3 as "controls and their limits". Remove "permanently recorded" or match it to retention. |
| `CLOUD_PROVIDERS.md` | Use neutral examples. Correct the redaction and catalog claims. |
| `EXECUTION_CONVERGENCE.md` | Correct the team step semantics. |
| `quickstart.md` | Fix the duplicated "another version" example. Make the posture language match DEC-01. |
| `MCP_GUIDE.md` | Remove the `file:///home/mike/...` link. |
| `CLOUDFLARE_CONTEST_CRITICAL_PATH_ASSESSMENT.md` | Add a HISTORICAL banner. |
| `eval/README.md` | Correct the status table. |

## 4. Acceptance criteria

| ID | Check |
|---|---|
| ACC-GOV-01 | `node scripts/check_requirements.mjs` passes in CI and fails on a fixture row whose test name is missing. |
| ACC-GOV-02 | Every BLOCKER row in REQUIREMENTS.md links a SPEC, a PLAN and an ACC ID. This is checked by the same script. |
| ACC-GOV-03 | `docs/HISTORICAL.md` lists every Issue #12, PHASE, WP, CRED003 and PERS002 document, and points at the ledger. Every `docs/reviews/*.md` older than 2026-10-14 starts with the historical banner. The hash-pinned documents are byte-unchanged. |
| ACC-GOV-04 | The doc checklist (§3.2) is signed off in the RC acceptance record. `grep -rnE "t5820\|engineering/b0\|A770\|18010\|parity with" README.md quickstart.md docs/*.md` returns nothing. |
| ACC-GOV-05 | The `v1.0.0` GitHub milestone exists, and its issue count matches the open plan task groups. |
| ACC-GOV-06 | An independent acceptance report for continuity and truncation recovery is filed in `docs/reviews/`. |

## 5. Dependencies

- DEC-04 (resolved).
- All other specs feed the ledger.
