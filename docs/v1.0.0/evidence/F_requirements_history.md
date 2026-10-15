# SCOPE F — Requirements history, product commitments, provenance (HIST-)

Repo HEAD db1ca55 (v0.1.0-alpha.2-2). Read-only. All "claimed status" values are DOC-CLAIM unless marked otherwise.

## 0. Requirement ledger (most important section)

Legend: Orig = ID in source doc. Claim = status in latest doc that assessed it. IQ = independently qualified per docs
(Y = named independent qualification doc; P = independent review of a package, not the requirement; N = self-assessed).
"Superseded-by" = later review that contradicts or narrows the claim.

### 0.1 Issue #12 normative set (docs/PHASE2_RECONCILED_REQUIREMENTS.md v1.2.0, §5–27; 122 IDs; status from docs/ISSUE12_FINAL_ACCEPTANCE_MATRIX.md @ a4f3e16, plus PERS002 qualification @ a2d3051/5774a1a)

| Proposed ID | Orig | Requirement (short) | Source § | Claim (evidence cited) | IQ | Later contradiction / note |
|---|---|---|---|---|---|---|
| REQ-AGT-01 | EXEC-001 | Single task lifecycle across CLI/TUI/REPL/headless; states initialized..incomplete; never `completed` without criteria | P2 §5 | DEMONSTRATED (core/spine.ts; spine.test, system_journey.test) | P (WP01 review) | Top-tier 2026-10-12 A1: wrong work ended COMPLETED/VERIFIED; EXECUTION_CONVERGENCE §1: /team returned success on inference failure (fixed 9f103ee+) |
| REQ-AGT-02 | EXEC-002 | Unique immutable invocation id bound to task; retries distinct | P2 §5 | DEMONSTRATED (spine) | P | — |
| REQ-AGT-03 | EXEC-003 | All effects bound to verified effective root; atomic rebind on switch | P2 §5 | DEMONSTRATED | P | — |
| REQ-AGT-04 | EXEC-004 | Validation bound to immutable candidate; post-validation mutation invalidates | P2 §5 | DEMONSTRATED (candidate.ts) | P (WP04 review+corr.) | — |
| REQ-AGT-05 | EXEC-005 | Model claims/TDD indicators never confer merge authority; authoritative verifier required | P2 §5 | DEMONSTRATED | P | Contradicted 10-12 (A1 false VERIFIED); remediated 3290234/fe576f1; eval rerun 4add897 "0 false VERIFIED" (n small) |
| REQ-AGT-06 | EXEC-006 | Advertised tools == dispatchable (CLI/TUI/MCP) | P2 §5 | DEMONSTRATED | P | Contradicted 10-12 T-04 (MCP/plugin tools advertised but always fail) |
| REQ-AGT-07 | EXEC-007 | Secret-safe causality chain task→merge | P2 §5 | DEMONSTRATED | P | 10-12 T-08/T10: secrets plaintext in sessions/diffs/audit/flight |
| REQ-AGT-08 | EXEC-008 | Operator actions (`/test`, `!`) attributed to operator; never satisfy agent verification | P2 §5 | DEMONSTRATED | P | — |
| REQ-AGT-09 | EXEC-009 | All task subprocesses terminated on cancel/timeout | P2 §5 | DEMONSTRATED ("setpgid deferred") | P | 10-12 T7: background children outlived timeout |
| REQ-AGT-10 | EXEC-010 | Simulated/replayed effects labeled | P2 §5 | DEMONSTRATED | P | — |
| REQ-AGT-11 | EXEC-011 | Evaluators score exact candidate tree | P2 §5 | DEMONSTRATED | P | — |
| REQ-AGT-12 | EXEC-012 | Composite workflows declared or refused pre-effect | P2 §5 | DEMONSTRATED | P | — |
| REQ-AGT-13 | EXEC-013 | Extension domains declare boundaries; no silent core authority | P2 §5 | DEMONSTRATED | P | 10-12 T-03 (workspace plugins/MCP auto-executed) — contradicts |
| REQ-AGT-14..20 | CAP-001..007 | Capability identity by operation; availability≠admission (DENIED/OUT_OF_SCOPE); evidence per invocation; no phantom tools; backends equal contract | P2 §6 | DEMONSTRATED (spine.ts; capabilities.test) | P | CAP-006 contradicted by T-04 (10-12) |
| REQ-SEC-01..12 | AUTH-001..012 | Invocation-scoped authority; no sibling inheritance; 3-state admission; configurable breadth incl. full access; full access keeps invariants; monotonic delegation; fail closed w/o backend (no silent host fallback); requested vs admitted auditable; operator≠model | P2 §7 | DEMONSTRATED (core/authority.ts; authority.test) | P (WP02 review + 2 corrections) | 10-12 T-01 (review mode let `delete_file "."` delete repo), T-02 (subagent tools unapproved), T-06 (run_tests filter shell injection), T-12 (network tools ungated) — all contradict AUTH-001/008 at that date |
| REQ-AGT-21..24 | ACT-001..004 | Actor taxonomy; delegation depth bound (default ≤2) fail-closed; subagent advisory only; INTEGRATED/BOUNDED/INDEPENDENT | P2 §8 | DEMONSTRATED | P | 10-14 release notes: spawn_subagent `max_steps` removed; depth bound not re-verified |
| REQ-SEC-13..16 | RES-001..004 | Effective-resource authority (symlink/hardlink/alias); cwd confinement; race-resistant; equivalent path forms | P2 §9 | DEMONSTRATED (authority.ts, core/src/file_ops.rs; segregation_boundary.rs) | P | 10-12 T15 (list_dir/file_tree/cst_symbols outside workspace), T-11 (lexical TS + check-then-act Rust) |
| REQ-SEC-17..21 | SUBP-001..005 | Configurable subprocess domains; ambient creds scrubbed in bounded domains; no egress via subprocess; lifecycle ownership; registered background processes | P2 §10 | SATISFIED_BY_INTEGRATED_SYSTEM / DEMONSTRATED (SUBP-004: "setpgid deferred"; SUBP-005: "background registration in DurableTaskState deferred") | P | 10-12 T-08: "commands inherit the full environment"; SUBP-004/005 carried explicit deferrals while marked Satisfied |
| REQ-AGT-25..28 | CAND-001..004 | Receipt {candidateId,verifier,status,ts}; invalidate on candidate mutation; merge requires identity equality; clean target root | P2 §11 | DEMONSTRATED (core/candidate.ts; candidate.test) | P (WP04) | — |
| REQ-AGT-29 | CTX-001 | Every injected context item carries provenance+classification metadata | P2 §12 | **PARTIALLY_DEMONSTRATED_BLOCKING** (Issue #12 closure blocker) | Y (final closure review) | Still open per CLOUDFLARE_CONTEST_CRITICAL_PATH_ASSESSMENT.md:42 and cloudflare/OVERNIGHT_CHECKPOINT.md:54; no later closure found |
| REQ-AGT-30 | CTX-002 | Provenance/version/freshness/workspace applicability preserved; stale knowledge not authoritative | P2 §12 | **PARTIALLY_DEMONSTRATED_BLOCKING** | Y | Still open (same refs) |
| REQ-AGT-31..39 | CTX-003..011 | Durable vs retrieved distinction; role policy; budget vs actual route capacity, fail closed (`ContextBudgetError`); cross-boundary failover re-admission; same-boundary failover cheap; compaction removes only disposable; admission evidence; resume≠recovery; manual==auto compaction semantics | P2 §12 | DEMONSTRATED / SBIS (CTX-006: client.ts executeWithFailover; egress.test) | P (WP05 qual for CTX-006) | 10-12 I-05 (provider context-length 400 ends turn), CTX-02 (steering truncated after compaction; fixed ee70f68), d88a897 false-absence; 10-13 compaction ledger self-assessed only |
| REQ-SEC-22..25 | DATA-001..004 | Tripartite+uncertain classification; no destructive redaction of code identifiers; uncertain → non-destructive | P2 §13 | DEMONSTRATED (core/egress.ts classifyText; egress.test) | Y (WP05_INDEPENDENT_QUALIFICATION) | 10-12 T-08 URL passwords/JWT/PASSWORD= reached model; 3290234 claims fixed |
| REQ-PRV-01..02 | DEST-001..002 | 4 trust boundaries (HOST_LOCAL, LOCAL_APPLIANCE, EXTERNAL_BOUNDED, EXTERNAL_PUBLIC); downward crossing = egress event | P2 §14 | DEMONSTRATED (egress.ts classifyDestination) | Y (WP05) | Maturity review 10-12 P0: workspace `.env` can select public endpoint; disclosure authorization not enforced (cites CLOUD_PROVIDERS_ASSESSMENT 10-11) |
| REQ-SEC-26..30 | DISC-001..005 | Execution authority≠disclosure; protect all outbound sinks (prompts, tool results, subagents, git push, subprocess net, MCP, plugins, browser, sync, telemetry); at shared boundary; non-destructive locally; select redaction/tokenization/encryption | P2 §15 | DEMONSTRATED; DISC-005 SATISFIED_WITH_BOUNDED_ENVELOPE (encryption nominal only) | Y (WP05) | 10-12 T-05 (`batch_read` returns `.env`), T-07 (secret rehydrated into `search_web`) |
| REQ-SEC-31..35 | REHYD-001..005 | Unforgeable task-scoped tokens (`[NEXUS_SEC_REF_<hex32>]`); possession ≠ authority; authorized local sinks incl. file writes; invalid tokens inert | P2 §16 | DEMONSTRATED (egress.ts generateToken/rehydrate) | Y (WP05) | T-07 contradicted (10-12); 3290234 "vault restore needs an explicit authorized sink" |
| REQ-SEC-36..38 | CRED-001..003 | Creds from secure stores, never committed; not exposed to bounded subprocesses; scrubbed from logs/flight/audit/crash | P2 §17 | SBIS / DEMONSTRATED; CRED-003 SATISFIED_WITH_BOUNDED_ENVELOPE (no crash writer; exception display not qualified) | Y (CRED003_INDEPENDENT_QUALIFICATION) | Top-tier §11: a reviewer probe printed a real API key into a local transcript |
| REQ-SEC-39 | PERS-001 | Distinguish volatile/durable/outbound/export/retention/deletion/recovery | P2 §18 | DEMONSTRATED | P | — |
| REQ-SEC-40 | PERS-002 | No unredacted durable copies (sessions, flights, audit, checkpoints, caches, crash) | P2 §18 | Blocker at a4f3e16 → **operator-accepted with bounded envelope** (typed WorkspacePath rule; legacy identity-sensitive files remain plaintext) a2d3051/5774a1a | Y (PERS002_INDEPENDENT_QUALIFICATION) | 10-12 T-08/T10: plaintext in sessions, diffs, audit, task state, flight log — regression vs accepted claim; MCP config not covered (qual Q17) |
| REQ-SEC-41..42 | PERS-003..004 | Non-destructive protection; resume never resurrects authority/receipts | P2 §18 | DEMONSTRATED | P (WP07) | — |
| REQ-SEC-43..45 | EXT-001..003 | Extensions in declared domains; presence ≠ execution authority; preconfigured trust without prompts | P2 §19 | SBIS | P | **Contradicted 10-12 T-03** (workspace plugins + `.mcp.json` executed with no trust, even `--read-only --approve`); remediated 3290234 (`nexus trust`) |
| REQ-SEC-46 | EXT-004 | Middleware altering args/results emits before/after audit | P2 §19 | **PARTIALLY_DEMONSTRATED_BLOCKING** | Y | Still open (contest doc: "disable plugins for demo") |
| REQ-OPS-01..04 | EVID-001..004 | Bounded, attributable evidence; negative claims need boundary; record fields; no fabricated success on log failure | P2 §20 | DEMONSTRATED / SBIS | P | 10-12 P1: durable writes in empty catches (state saved 0 messages silently) contradicts EVID-004/FAIL-004; 73489bd adds PERSISTENCE_FAILED |
| REQ-SEC-47..50 | FAIL-001..004 | Explicit failure semantics; fail closed per effect; degraded mode only configured and visible | P2 §21 | DEMONSTRATED (FAIL-003 evidence text actually describes classifier fail-closed, not degraded-mode config — evidence mismatch) | P | see EVID |
| REQ-REL-01..05 | SCAN-001..005 | Mandatory dep/SAST/secret scanning; no bypass; indeterminate = fail; zero High/Critical in release; Med/Low dispositioned | P2 §22 | DEMONSTRATED (scripts/security_gates.sh, audit_rust_deps.py; security_gates.test) | P (WP11 qual) | Bounded: secret scan only tracked/staged files (F-WP11-OBS-01). No SAST tool named in gates (maturity review: scanner ≠ runtime security) |
| REQ-REL-06..09 | REL-001..004 | Lockfile provenance; SHA-256 + commit-bound release identity; SBOM hooks; patch obligations for supported public lines, EOL marking | P2 §23 | DEMONSTRATED (generate_sbom.sh; make verify-reproducibility) | P | Maturity review 10-12 P1: SBOM from direct deps only, not CycloneDX-validated; top-tier D4 no signing/provenance. Since 10-13: deterministic archive + CI reproducibility (87360e6, fa0959f), SHA256SUMS in releases. REL-004 now live obligation (repo PUBLIC, releases published) with no SECURITY.md process (D4) |
| REQ-TUI-01..05 | UI-001..005 | CLI/TUI projections over one model; same admission for TUI approve and `--yes`; CLI structured/exit codes; TUI default human surface; UI never expands authority | P2 §24 | DEMONSTRATED (core/app.ts, **cli/src/tui.ts**, index.ts; app.test) | P (WP10 review+qual) | Evidence cites TS `tui.ts`; product TUI is now Rust `nexus-tui` via sidecar — UI-001/004 evidence stale; F1 (10-12) typing approved actions incl. approve-all (contradicts UI-005); fixed 10-12/13, TUI "accepted with defects" (7029709) |
| REQ-TUI-06..07 | UI-006..007 | Ratatui only a hypothesis; Issue #10 deferred, must not be implemented | P2 §24 | DEMONSTRATED | — | **Superseded** by operator decision (Ratatui nexus-tui shipped; docs/superpowers/specs/2026-10-04-nexus-ratatui-live-default-design.md) — no recorded formal supersession of UI-006/007 |
| REQ-AGT-40..42 | SEGR-001..003 | INTEGRATED/BOUNDED/INDEPENDENT; independent evaluators get only artifact/spec; no accidental duplication | P2 §25 | DEMONSTRATED (core/tests/segregation_boundary.rs) | P | EXECUTION_CONVERGENCE §10: runSubagent remains a second loop |
| REQ-AGT-43..46 | DEDUP-001..004 | 3-question dedup; baseline 36-tool surface at be829ec retained pending ablation evidence | P2 §26 | DEMONSTRATED | P | **Quietly dropped**: tool surface changed (38 tools 10-12 incl. browser; 0090f9c "offer rare tools on demand"); eval evidence partial (eval_pilot) — no DEDUP-003 ablation record found |
| REQ-CON-01..04 | TEST-001..004 | Every security invariant has local automated test; negative fixtures (no effect on deny); synthetic secret egress fixtures; candidate mutation fixtures | P2 §27 | DEMONSTRATED | P | Top-tier §6.10: suites missed A1, T1–T4, T-01..T-06 — TEST-001 "every invariant" not true at 10-12 |

Issue #12 overall: **OPEN** — disposition `ISSUE_12_REMAINING_REQUIREMENTS_IDENTIFIED` (ISSUE12_FINAL_ACCEPTANCE_ASSESSMENT.md:7,236). Blockers CTX-001, CTX-002, EXT-004 never closed in any later doc. Counts: 104 DEMONSTRATED, 12 SBIS, 2 bounded, 4 blocking (PERS-002 later accepted bounded).

### 0.2 Post-Issue-#12 commitments (reviews 2026-10-03 → 10-14, product docs)

| Proposed ID | Orig | Commitment | Source | Claimed status (evidence) | IQ |
|---|---|---|---|---|---|
| REQ-AGT-50 | Q1/E1 | Completes representative objectives at pre-registered threshold (≥5 runs/task, T1–T4 tiers) | TOP_TIER §3,§9; eval/README | T2 pilot only (6 fixture tasks): first run NOT QUALIFIED (2 false VERIFIED); rerun ed17e99 87% (26/30), 0 false VERIFIED vs Goose 80% (evidence/eval_pilot_2026-10-13/SCORES_rerun_ed17e99.md). T3/T4 never run; "qualification needs the full task set" (RESULT.md) | N (self-run, pre-registered) |
| REQ-AGT-51 | Q2/B3/A1 | VERIFIED only with change-bound, Nexus-independent evidence; else REGRESSION_FREE (exit 2); requirements `verified` only from bound verifier run | TOP_TIER B3; USER_MANUAL §2 Outcomes | Implemented 3290234, fe576f1 (fail-before/pass-after), eval rerun 0 false VERIFIED | N (eval self-run) |
| REQ-SEC-60 | B1 | One execution authority: every capability gated by mode (auto/review/read-only/dry-run) on every dispatch path; deny-by-default | TOP_TIER B1 | Partly: delete_file/run_tests now `mutating` → review gate; subagent receives onConfirm. **Network/browser tools still `mutating:false` → never gated (T-12 open)** | N |
| REQ-SEC-61 | B2/T-03 | Workspace plugins / `.mcp.json` only after `nexus trust`; never in `--read-only` | TOP_TIER B2; USER_MANUAL §4 | Implemented (workspace_trust.ts; plugins.ts:47-54,76; mcp.ts:509-511) | N |
| REQ-AGT-52 | B4 | Exact edits; atomic writes; preserve mode/symlink/CRLF | TOP_TIER B4; USER_MANUAL §3 #5 | Claimed 3290234 | N |
| REQ-PRV-10 | B5 | Never execute tool calls from `<think>`/prose; JSON repair never changes content | TOP_TIER B5 | Claimed 3290234 (parser.ts:319-331 strips reasoning before parsing) | N |
| REQ-SEC-62 | B6 | Protected paths on every read tool; no rehydration to public destinations; durable stores redact | TOP_TIER B6 | batch_read now checked (tools.ts:457-468); lexical match only | N |
| REQ-TUI-10 | B7/F1-F3 | Approvals cannot be decided by stray typing; approve-all deliberate | TOP_TIER B7; USER_MANUAL Approvals | **ACCEPTED WITH DEFECTS** (independent round 5, NEXUS_TUI_SURFACE_2026-10-12.md:165,259); 028ca90 follow-up implementer-verified only | Y (round 5), N (follow-up) |
| REQ-REL-10 | B8/D1/D2 | Build identity in `--version`/doctor; CI on every branch | TOP_TIER B8 | Implemented (cli/src/build_identity.ts; .github/workflows/ci.yml, release.yml; legacy .gitlab-ci.yml also present) | N |
| REQ-REL-11 | D3/R11 | Versioned install, upgrade, rollback; LICENSE/SECURITY/CHANGELOG | TOP_TIER D3/D4 | install.sh + GitHub prereleases v0.1.0-alpha.1/.2 with SHA256SUMS; LICENSE present; **no SECURITY.md, no CHANGELOG, no rollback procedure, no signing/provenance** | N |
| REQ-OPS-10 | R2/P1 | Persistence failure visible; stop mutating when state cannot be saved | TOP_TIER R2; COMPACTION §Compaction | 73489bd: `PERSISTENCE_FAILED` for compaction commits; mid-turn saves "shown once" (continue) | N |
| REQ-AGT-53 | Compaction A–D | No default step/time ceiling; state-aware repetition; durable compaction commit (archive→task→session, fsync); queued `/compact`; provider-advertised capacity; labelled token counts | COMPACTION_AND_CONTINUITY.md; reviews/2026-10-13-compaction-continuity-acceptance.md | "Met"/"Met (scripted)"; 1 completed live run (run 3, REGRESSION_FREE); **"Independent acceptance is pending"** (ledger line 3) | **N** |
| REQ-PRV-11 | Standalone | Works identically without homelab-ai gateway; counting optional; labelled estimates | COMPACTION_AND_CONTINUITY.md:7-9; handoff doc | "Accepted under scripted evidence"; **no live run against LM Studio/llama.cpp/vLLM standalone** (ledger "Not done"; release notes Known limits) | N |
| REQ-PRV-12 | Truncation | Output-limit cut-off reply: nothing runs, one retry, second ends INFERENCE_FAILED | release notes alpha.2; COMPACTION doc | Scripted tests only; "not observed live"; tasks/todo.md:60 full `make test` + docs unchecked | N |
| REQ-PRV-13 | Cloud authority | Only operator selects cloud destination; project `.env` cannot; first-request disclosure notice; local→cloud fallback off unless allowlisted; per-origin credential binding; receipts in `.nexus/inference_receipts.jsonl`; NEXUS_CLOUD_MAX_* limits; embeddings never to cloud | CLOUD_PROVIDERS.md "Authority and disclosure", "Usage, cost and limits" | Live-qualified connectivity for openrouter + chatgpt only (NEXUS_CLOUD_PROVIDERS_LIVE_QUALIFICATION); openai/anthropic/copilot/compatible **not live-qualified** | N |
| REQ-AGT-54 | Convergence | `/team`, `nexus operation`: no false success; BLOCKED with typed decision; restart resume; independence constraint for review | EXECUTION_CONVERGENCE.md §3–9 | Implemented; open I3 (502/504 blocks instead of park), I4 (advisory work hides decision), stale-lock race, corrupt lock never stale (§10); post-remediation dogfood **INTEGRATION_BLOCKED** (NEXUS_POST_REMEDIATION_DOGFOOD_QUALIFICATION.md:5) — later status not recorded | N |
| REQ-SEC-63 | Cred origin | Stored gateway token / config.env key only to configured origin; project `.env` never re-homes credentials | EXECUTION_CONVERGENCE §7 | Implemented; reads homelab path `~/.config/opencode/t5820-client-token` (cli/src/client.ts:65) | N |
| REQ-TUI-11 | TUI surface rows 1–20, O1–O3 | Markdown, outcomes in words, bounded output, approvals, crash/recovery, resume history, narrow terminals, 0-byte idle | NEXUS_TUI_SURFACE_2026-10-12.md | PASS rows; independent "ACCEPTED WITH DEFECTS" | Y |
| REQ-DX-01 | Install promise | Linux x86-64 glibc≥2.35, Node≥20; installer verifies SHA-256; no root, no shell rc edits; manual uninstall keeps user data | quickstart.md:7-27,59-68; DEVELOPMENT.md:19 | Published alpha.2 (release run 38539108878) | N |
| REQ-DX-02 | Outcome honesty | "VERIFIED only when its selected verifier passes"; UNVERIFIED/BLOCKED/LIMIT_REACHED distinct | quickstart.md:57 | (as REQ-AGT-51) | — |
| REQ-DX-03 | Manual feature promises | 24 native tools (incl. LSP, trigram, CST); `--sandbox` bwrap/Docker; `--dry-run`, `--read-only`; plugin worker-thread sandbox with memory caps; SSRF guard; audit log; checkpoints/`/undo`; hot reload; failover `--fallback` | USER_MANUAL.md §3–4 | All 24 tool names present in core/capabilities.ts (SOURCE). **Worker-thread plugin sandbox claim false at HEAD** (see HIST-03) | N |
| REQ-DX-04 | Positioning | "engineered for direct parity with OpenAI Codex and Anthropic Claude Code" | USER_MANUAL.md:3 | Contradicted by TOP_TIER §1 ("not yet top-tier"); no parity evidence | — |

## 1. Coverage ledger (docs read instead of code)

| File(s) | Method |
|---|---|
| docs/PHASE2_RECONCILED_REQUIREMENTS.md | full read |
| docs/ISSUE12_FINAL_ACCEPTANCE_MATRIX.md | full read |
| docs/ISSUE12_FINAL_ACCEPTANCE_ASSESSMENT.md | targeted (§1–13) |
| docs/ISSUE12_FINAL_CLOSURE_ASSESSMENT.md, ISSUE12_POST_WP05_*, ISSUE12_REQUIREMENT_CLOSURE_MATRIX.md | skim (grep disposition; superseded by FINAL_ACCEPTANCE per its §2) |
| docs/PERS002_INDEPENDENT_QUALIFICATION.md | targeted (disposition, Q1–18) |
| docs/CLOUDFLARE_CONTEST_CRITICAL_PATH_ASSESSMENT.md, docs/cloudflare/OVERNIGHT_CHECKPOINT.md | targeted (blocker status lines) |
| docs/PHASE1_SYSTEM_RECONSTRUCTION.md, PHASE2_REQUIREMENTS_AND_PLAN.md, PHASE2_REQUIREMENTS_INDEPENDENT_REVIEW.md, PHASE2S_SECURITY_AND_DATA_REVIEW.md | skim (reconciled into PHASE2_RECONCILED §3, §31–32 traceability; one targeted grep on Issue #11) |
| docs/PHASE3_*.md, PHASE4_*.md, WP01–WP11 reviews/qualifications, CRED003_*, WP05_* | skim by title; statuses taken through FINAL_ACCEPTANCE_MATRIX which cites them |
| docs/DEC01, DEC02 ADRs | targeted (decision + disposition) |
| docs/EXECUTION_CONVERGENCE.md, docs/COMPACTION_AND_CONTINUITY.md, docs/USER_MANUAL.md, docs/ARCHITECTURE.md, README.md, quickstart.md, docs/DEVELOPMENT.md, docs/releases/*.md, tasks/todo.md, tasks/lessons.md | full read |
| docs/CLOUD_PROVIDERS.md | read first ~120 lines (authority, credentials, failures, cost) |
| docs/CLIENT_GUIDE.md, MCP_GUIDE.md, SKILLS_AND_PLUGINS.md, DOCTOR_TROUBLESHOOTING*.md, NEXUS-CLOUD-PROVIDERS-PLAN.md, CLOUDFLARE_CONTEST.md | excluded/skim by title (contest = separate product; others covered by other scopes) |
| docs/reviews/NEXUS_APPLICATION_MATURITY_REVIEW_2026-10-12.md, NEXUS_TOP_TIER_QUALIFICATION_ASSESSMENT_2026-10-12.md, 2026-10-13-compaction-continuity-acceptance.md, 2026-10-13-homelab-ai-gateway-capability-handoff.md, NEXUS_CODEBASE_REVIEW_FEAT_TUI_SURFACE_2026-10-12.md, NEXUS_CLOUD_PROVIDERS_LIVE_QUALIFICATION_2026-10-11.md | full read |
| docs/reviews/NEXUS_TUI_SURFACE_2026-10-12.md | targeted (matrix, O-items, round 5 verdict, status) |
| docs/reviews/NEXUS_CLOUD_PROVIDERS_ASSESSMENT_2026-10-11.md | targeted (§1, §4 absent abstractions) |
| docs/reviews/evidence/eval_pilot_2026-10-13/RESULT.md, SCORES_rerun_ed17e99.md | full read |
| Remaining 13 review docs (DOGFOODING_READINESS, SUPERVISED_REASSESSMENT, TRUTHFUL_INTERRUPTIBLE_TURNS, DEFECT_RECONCILIATION, PARALLEL_DEFECT, TUI_MULTILINE, ACCEPTANCE_BLOCKERS(+REMEDIATION), CONVERGENCE_INVARIANT, POST_REMEDIATION_DOGFOOD, CONTEXT_CONVERGENCE, MATURITY_FIXES(+REQUEST), DOCTOR_RECOVERED_REQUEST, TUI_DIFF_OUTPUT) | skim: verdict/disposition lines only |
| docs/reviews/evidence/** (~180 files: casts, screenshots, logs, repro scripts) | excluded (raw evidence; not re-executed) |
| docs/research/context-engineering/* (8 md + 4 tools), docs/superpowers/plans+specs (6) | skim by title (design plans; Ratatui adoption spec noted) |
| GitHub issues/PRs (mikeholownych/nexus-code) | queried: 0 issues, 0 PRs (repo created 2026-10-13) |
| Spot-check source at HEAD | targeted greps listed in §8 |

Note: task brief said docs/reviews has 205 files; actual = 24 review markdown files + ~183 evidence files (207 total).

## 2. Provenance / architecture notes

- **Two requirement regimes.** (a) Issue #12 (2026-09-30 → 10-02): formal 122-ID normative contract, WP-01..11, independent qualifications, ending OPEN with 3 blockers. (b) From 10-03 onward: review-driven qualification (dogfood readiness → acceptance blockers I1–I6 → convergence → maturity fixes → top-tier Q1–Q8/B1–B8 → TUI acceptance → compaction ledger → alpha releases). Regime (b) never re-baselined against the 122 IDs; no doc maps B1–B8 back to EXEC/AUTH/DISC IDs. Many regime-(a) "DEMONSTRATED" rows were later contradicted (§0.1 last column) without the matrix being updated.
- **Issue tracker discontinuity.** Issue #10/#11/#12/#13 lived in a pre-GitHub tracker (docs state "NO Git remote", PHASE2_RECONCILED:32). GitHub repo created 2026-10-13, public, 0 issues/PRs. Open blockers exist only in markdown.
- **Independence.** Issue #12 used separate qualification docs. Post-10-12 work is mostly implementer self-assessment; independent acceptance only for TUI approval/visuals (round 5). Compaction/continuity (shipped in alpha.2) states "Independent acceptance is pending".
- **Trust boundaries in commitments:** operator config (`~/.config/nexus`) = credential authority; project `.env` may configure endpoints but not cloud destinations or credential origins; workspace extensions require `nexus trust`; home plugin dirs always trusted — including `~/.config/opencode/plugins` (undocumented, cli/src/plugins.ts:51).
- **homelab-ai relationship (as stated):** optional integration. Gateway at `https://10.0.8.5:8443/v1`, alias `engineering/b0`, advertises `context_length`/`max_completion_tokens`/`limits_version` via `/v1/models`, offers `/v1/tokenize`, returns `X-AIHost-*` headers. "Nexus works the same way with or without the homelab-ai gateway… Neither product requires the other" (COMPACTION_AND_CONTINUITY.md:7-9); handoff: "Nexus works without any of this. It is an integration improvement, not a dependency." Residual homelab coupling in shipped artifacts: client.ts:65 token path `~/.config/opencode/t5820-client-token`; ARCHITECTURE.md:24-25 ("vLLM / LM Studio Gateway (port 18010/v1)", "Dual Intel Arc A770 XPUs (engineering/b0)"); CLOUD_PROVIDERS.md:3 "runs against the local appliance by default", `/model appliance engineering/b0`.

## 3. Findings

| ID | Sev | Workflow | Location | Evidence | User impact | Disposition |
|---|---|---|---|---|---|---|
| HIST-01 | S2 | Extensions/MCP, release gating | docs/ISSUE12_FINAL_ACCEPTANCE_ASSESSMENT.md:7,112-121; cli/src/plugins.ts:150-200 | DOC-CLAIM+SOURCE: Issue #12 remains OPEN; CTX-001, CTX-002, EXT-004 never closed in any later doc. EXT-004 still unmet at HEAD: `executeToolPipeline` pre/post middleware can rewrite args/results with no before/after audit record | Plugins can silently alter what tools did; prompt provenance not reconstructable | Either implement or record an explicit operator waiver/supersession before v1; do not ship v1 with silently-open normative blockers |
| HIST-02 | S2 | Requirements governance | docs/ISSUE12_FINAL_ACCEPTANCE_MATRIX.md (EXT-002, AUTH-001, DISC-002, CAP-006, PERS-002 rows) vs reviews/NEXUS_TOP_TIER_QUALIFICATION_ASSESSMENT_2026-10-12.md §6 | HISTORICAL: ≥10 rows marked DEMONSTRATED/SATISFIED were reproduced as violated 11 days later (T-01, T-02, T-03, T-04, T-05, T-07, T-08, T15, A1, F1). Matrix never updated; no requirement-level regression suite enforces the 122 IDs | "DEMONSTRATED" labels in the repo are not reliable evidence; future regressions go unnoticed | Re-baseline: one current requirements ledger (v1) with each ID bound to a named test; retire or annotate Issue #12 matrices as historical |
| HIST-03 | S2 | Extensions, docs truth | docs/USER_MANUAL.md:294; cli/src/plugins.ts:93-96,139-145,256 | SOURCE: manual promises plugin handlers "execute in isolated Node.js worker_threads with strict timeout boundaries and memory caps". Plugins are loaded with in-process `await import()` and custom tools run `handler(args)` directly; `executeSandboxed` has no caller | Users trust untrusted plugins based on a nonexistent sandbox | Fix the manual (or wire the sandbox); RELEASE-REQUIRED doc correction |
| HIST-04 | S2 | Extensions, standalone | cli/src/plugins.ts:47-54 | SOURCE: home plugin dirs include `~/.config/opencode/plugins` — every `*.js/*.mjs` there is imported in-process at turn start; USER_MANUAL.md:295 lists only `~/.config/nexus/`, `~/.nexus/` | Another product's plugins execute inside Nexus with full authority, undocumented | Remove the opencode dir or make it opt-in + documented |
| HIST-05 | S2 | Review mode / egress | cli/src/core/capabilities.ts (`fetch_web`, `search_web`, `browser_navigate`, `browser_click` → `"mutating": false`); cli/src/agent.ts:3946-3947 | SOURCE: approval gate is `onConfirm && isMutating`; network/browser tools are non-mutating so review mode never asks before egress. TOP_TIER T-12 still open; B1 "every egress capability gated" unmet | `--approve` users may assume outbound actions need approval; browser_click can act on external sites | Add an egress/exec effect class gated in review mode, or document explicitly |
| HIST-06 | S3 | Install/positioning docs | docs/USER_MANUAL.md:3,14,19; docs/ARCHITECTURE.md:24-25,43; quickstart.md:21-23 | SOURCE/DOC: manual claims "direct parity with OpenAI Codex and Anthropic Claude Code"; `harness repl` (installed binary is `nexus`); `nexus --approve` vs quickstart `nexus repl --approve`; ARCHITECTURE names homelab hardware/port 18010 and calls `repl.ts` the TUI; quickstart "install another specific version" example is identical to the pinned command; MCP_GUIDE link is `file:///home/mike/...` | New users get wrong commands and inflated expectations | Reconcile docs to shipped binary (RELEASE-REQUIRED) |
| HIST-07 | S2 | Release/supply chain | scripts/generate_sbom.sh:32-94; .github/workflows/release.yml | SOURCE: SBOM from direct deps only; not part of release workflow; no signing/attestation; no SECURITY.md. REL-002/003/004 marked DEMONSTRATED; REL-004 patch obligation now live (public prereleases) | No vulnerability intake path; SBOM incomplete | Lockfile-derived SBOM in release, SECURITY.md, provenance |
| HIST-08 | S2 | Standalone local inference | reviews/2026-10-13-compaction-continuity-acceptance.md "Not done"; docs/releases/v0.1.0-alpha.2.md:33 | DOC-CLAIM: all live evidence is homelab gateway (llama.cpp behind aihost). No live run on plain LM Studio/vLLM/llama.cpp/Ollama although quickstart's first-run path is LM Studio | Primary documented setup unqualified | v1 must include live standalone qualification on ≥2 servers |
| HIST-09 | S3 | Long tasks | reviews/2026-10-13-compaction-continuity-acceptance.md:3; tasks/todo.md:60 | DOC-CLAIM: continuity/compaction (73489bd) and truncation recovery (d19fb29) shipped in alpha.2 with independent acceptance pending and final `make test`/docs unchecked | Unreviewed changes to completion/stop semantics | Independent acceptance before v1 |
| HIST-10 | S3 | Governance | tasks/todo.md; GitHub repo | INFERENCE: zero GitHub issues; open items (I3, I4, stale-lock race, CTX/EXT blockers, TUI P3s, B1 egress gating, eval T3/T4) live only in markdown across ~40 docs | Open work invisible to contributors; easy to drop | Migrate open items to issues with v1 milestone |
| HIST-11 | S4 | Requirements drift | PHASE2_RECONCILED §24 UI-006/007, §26 DEDUP-003, §2 "NO Git remote" | DOC: three normative constraints superseded by later operator decisions (Ratatui adopted, tool surface changed 36→38 and on-demand, GitHub remote) with no recorded supersession | Matrix contradicts product | Record supersessions |

## 4. Reproductions / spot-checks (claims vs HEAD db1ca55; SOURCE greps, nothing executed)

| # | Claim (source) | HEAD check | Result |
|---|---|---|---|
| 1 | EXT-002 / B2 workspace plugins+MCP need trust | plugins.ts:47-54,76; mcp.ts:509-511; workspace_trust.ts present | HOLDS (regressed 10-12, fixed 3290234) |
| 2 | T-01 review mode gates delete_file | capabilities.ts delete_file mutating:true; agent.ts:3946-3947; forbiddenDeletion agent.ts:3914 | HOLDS |
| 3 | T-02 subagent tools get approval | agent.ts:3609 passes onConfirm; :5384 dispatch with onConfirm | HOLDS |
| 4 | T-05 batch_read protected paths | tools.ts:457-468 | HOLDS (lexical policy match only) |
| 5 | T-06 run_tests filter not injectable | tester.ts:25-31 allowlist `^[A-Za-z0-9_:./ -]+$`, no leading `-` | HOLDS (still shell-interpolated, but charset-safe) |
| 6 | REHYD-001 128-bit CSPRNG tokens | egress.ts:1,520 randomBytes(16).hex; `[NEXUS_SEC_REF_` | HOLDS |
| 7 | CTX-005 ContextBudgetError | agent.ts:223 | HOLDS (exists) |
| 8 | CAND-003/004 merge requires receipt + identity, clean root | worktree.ts:278-310; agent.ts:1400-1405 always passes tracker → validation required | HOLDS |
| 9 | ACT-002 configurable depth bound | agent.ts:3574 hard-coded `depth >= 2` or actor subagent | PARTIAL (bound exists; not policy-configurable as REQ states) |
| 10 | DEC-01 descriptor-level confinement | file_ops.rs:59-75 + 7 call sites | HOLDS for opens; final placement still path-based (not proven race-free) |
| 11 | T15 listing confined | search.rs:67,387 resolve_safe_path | HOLDS |
| 12 | SCAN-002 non-bypassable gates | security_gates.sh:14-23; run in ci.yml:58, release.yml:37 | HOLDS |
| 13 | REL-003 SBOM metadata | generate_sbom.sh:32-94 direct deps only | STALE/PARTIAL |
| 14 | UI-001/004 evidence cli/src/tui.ts | tui.ts exists but only imported by repl.ts:28 (legacy dashboard); live TUI is Rust nexus-tui | STALE evidence |
| 15 | EXT-004 middleware audit | plugins.ts executeToolPipeline, no audit | STILL UNMET (as docs say) |
| 16 | USER_MANUAL worker-thread plugin sandbox | plugins.ts:93-96,144; executeSandboxed unused | FALSE |
| 17 | D1 build identity, D2 CI | build_identity.ts; .github/workflows/{ci,release}.yml | HOLDS |
| 18 | B1 egress tools gated | capabilities.ts fetch_web/search_web/browser_* mutating:false | NOT MET |
| 19 | USER_MANUAL 24 tool names | all 24 present in capabilities.ts (36 modelToolName entries) | HOLDS (names only) |

Summary: 13 hold, 2 partial, 2 stale, 1 false, 1 not met; 1 known-open confirmed.

## 5. Strengths (with evidence)

- Unusually explicit normative contract with traceability (PHASE2_RECONCILED §31) and honest final disposition refusing to close Issue #12 (ISSUE12_FINAL_ACCEPTANCE_ASSESSMENT §5–6).
- Later reviews are self-critical and reproduction-backed (TOP_TIER §1 "not yet top-tier"; eval RESULT "NOT QUALIFIED" on first run) and most P0s were remediated in 3290234 (spot-checks 1–5, 11, 17 hold).
- Pre-registered evaluation with peers and CIs (eval_pilot_2026-10-13).
- Standalone-vs-homelab boundary stated explicitly and degraded paths labelled (COMPACTION_AND_CONTINUITY.md; handoff doc).
- Release notes state known limits plainly (v0.1.0-alpha.2.md:31-35).

## 6. Qualification gaps

| Gap | Procedure to qualify |
|---|---|
| None of the 122 Issue-#12 IDs are bound to current tests | Build a v1 ledger: each REQ-* → named test file:case; CI job fails if a REQ lacks a test |
| B6 secrets corpus at HEAD (T-07/T-08/T10) not re-run since 3290234 | Re-run docs/reviews/evidence/qualification_2026-10-12/repro/zz_trust_repro.test.ts against snapshot; seeded-secret scan of ~/.nexus and .nexus after a scripted turn |
| A1 false-VERIFIED regression set | Re-run repro_false_verified.test.ts + eval T1 mutation set on HEAD |
| Standalone live (LM Studio/vLLM/Ollama/llama.cpp) | Install alpha.2 tarball in clean HOME; config.env per quickstart; run T2 pilot subset against each server |
| Compaction/continuity independent acceptance | Independent reviewer re-runs compaction_continuity.test.ts + one live long task on release build |
| Eval T3/T4 tiers | Run eval/ T3 (long-task, steering) and T4 (fault injected) per TOP_TIER §9 thresholds |
| `~/.config/opencode/plugins` presence on user hosts | `ls ~/.config/opencode/plugins` on dogfood host; add test asserting not loaded |
| EXECUTION_CONVERGENCE I3/I4/stale-lock status | grep operation_runner for 502/504 park + lock CAS; add tests |

## 7. Proposed v1.0.0 requirements (Scope F)

| ID | Requirement | Rationale | Blocker? | Acceptance test |
|---|---|---|---|---|
| REQ-REL-V1-01 | Single authoritative v1 requirements ledger supersedes Issue #12 matrices; every row has status, owner test, and last-verified commit | Prior DEMONSTRATED claims went stale (HIST-02) | BLOCKER | CI script parses ledger, runs each referenced test, fails on missing/failed |
| REQ-SEC-V1-01 | EXT-004 met or formally waived: middleware arg/result changes emit before/after audit | Normative MUST open since 10-01 | BLOCKER (or written waiver + plugins documented as fully trusted) | Plugin rewriting args → audit record with both states |
| REQ-AGT-V1-01 | CTX-001/002 met or formally descoped with written rationale | Open blockers | RELEASE-REQUIRED (decision) | Ledger row shows decision; if implemented, per-item provenance test |
| REQ-SEC-V1-02 | Review/approve mode gates all exec and egress capabilities (fetch_web, search_web, browser_*, MCP, plugin tools) | HIST-05; B1 | BLOCKER | capability×mode matrix test enumerating registry |
| REQ-SEC-V1-03 | No implicit loading of other products' plugin dirs | HIST-04 | BLOCKER | Plugin in ~/.config/opencode/plugins not imported (sentinel test) |
| REQ-DX-V1-01 | Docs match shipped behaviour: no parity claim, correct commands, no worker-sandbox claim unless wired, no homelab hardware in ARCHITECTURE | HIST-03/06 | RELEASE-REQUIRED | Doc-command smoke: every command in README/quickstart/USER_MANUAL runs `--help` OK on package |
| REQ-PRV-V1-01 | Live standalone qualification on ≥2 non-homelab OpenAI-compatible servers | HIST-08; standalone requirement | BLOCKER | Recorded runs with manifest; T2 subset pass ≥ pre-registered threshold |
| REQ-AGT-V1-02 | Independent acceptance of continuity/compaction and truncation recovery | HIST-09 | RELEASE-REQUIRED | Reviewer report in docs/reviews |
| REQ-AGT-V1-03 | Eval T2 full set + T3 + T4 meet TOP_TIER §9 thresholds (false VERIFIED = 0) | Q1/Q3/Q6 unproven | RELEASE-REQUIRED | eval run artefacts |
| REQ-REL-V1-02 | SECURITY.md + CHANGELOG + lockfile-derived validated SBOM + checksum signing/provenance in release workflow | REL-002..004 obligations now live | RELEASE-REQUIRED | release.yml produces SBOM validated by cyclonedx-cli; attestation present |
| REQ-OPS-V1-01 | Open items tracked as GitHub issues with v1 milestone | HIST-10 | POST-V1 (process) | `gh issue list --milestone v1` non-empty, matches ledger |
| REQ-DX-V1-02 | Record supersession of UI-006/007, DEDUP-003, "no remote" | HIST-11 | POST-V1 | ledger rows |

## 8. Deferred, waived, or quietly dropped requirements (do not lose)

| Item | Origin | How it left | Current state |
|---|---|---|---|
| CTX-001 per-item provenance | P2 §12 | Blocker; "DEMO_RELIABILITY_RISK" for contest | Open, never closed |
| CTX-002 freshness/version/workspace applicability | P2 §12 | Same | Open |
| EXT-004 middleware audit | P2 §19 | "REGISTER_AND_DEFER" (contest) | Open; confirmed unmet at HEAD |
| PERS-002 legacy identity-sensitive files | PERS002 qual | Accepted limitation | Registered limitation |
| CRED-003 crash/exception display | CRED003 qual | Bounded envelope | Unqualified |
| DISC-005 recipient-readable encryption | WP05 | "nominal only" bounded | Not implemented |
| SUBP-004 setpgid process trees; SUBP-005 background-process registration | Final matrix rows | "deferred" text inside a Satisfied row | Quietly deferred (TOP_TIER T7 later reproduced orphan children) |
| WP-06 (context) and WP-08 (extensions) | PHASE4 | DEFERRED_WITH_CLOSURE_BLOCKERS | Not implemented |
| F-WP11-OBS-01 secret scan tracked/staged only | WP11 | Accepted bounded | Unchanged |
| F-WP10-OBS-01 narrow-terminal receipt truncation | WP10 | Follow-up not blocking | Superseded by Rust TUI (unverified) |
| UI-006/UI-007 "Ratatui only hypothesis, Issue #10 must not be implemented" | P2 §24 | Quietly superseded (Ratatui shipped) | No supersession record |
| DEDUP-003 retain 36-tool surface pending ablation | P2 §26 | Quietly dropped (38 tools, on-demand rare tools 0090f9c) | No ablation evidence beyond eval pilot |
| "No Git remote" | P2 §2/§28.7 | Quietly superseded (public GitHub) | — |
| REL-001 byte-identical builds | IR-05 | Deferred to future maturity | Partially addressed (87360e6 deterministic archive) |
| Issue #10 (TUI) | P2 UI-007 | Deferred | Implicitly done via nexus-tui; never closed |
| Default 300-step/120-min ceiling | earlier releases | Removed by design in alpha.2 | Operator limits only |
| `spawn_subagent max_steps` argument | tool schema | Removed alpha.2 | API change, pre-1.0 |
| EXECUTION_CONVERGENCE I3 (502/504/ENOTFOUND park), I4 (advisory hides decision), stale-lock race, corrupt lock | EXECUTION_CONVERGENCE §10 | "Open" | No later closure found |
| runSubagent folded into runTurn; parallel roles | EXECUTION_CONVERGENCE §10 | Follow-up | Open |
| POST_REMEDIATION_DOGFOOD "INTEGRATION_BLOCKED" (completion truth across process death; retry launders unverified changes) | reviews 10-09 | Not re-dispositioned in a later doc | Unknown — qualify |
| TUI P3s (one-letter "a" + Enter approve-all path; y/n first word on armed panel); 028ca90 not independently re-reviewed | NEXUS_TUI_SURFACE round 5 | Accepted residual | Open P3 |
| TOP_TIER R1–R11 (RPC isolation, shell runtime bounds, reactive context-error compaction I-05, usage from plain endpoints I-07, persistence integrity P2–P6, MCP/plugin advertised-but-failing T-04, PTY determinism) | TOP_TIER §7.2 | Only partially referenced by later commits | Status unrecorded — qualify |
| Eval T3/T4 tiers; full 24-task set | TOP_TIER §9 | Not run | Open |
| Live standalone run; live capacity/worker-change observation; live TUI `/compact` queue | compaction ledger "Not done" | Not done | Open |
| Admission-equivalent token counting | handoff | External (homelab-ai) | Unmet externally, labelled |
| Live qualification of openai, anthropic, copilot, compatible providers | CLOUD_PROVIDERS_LIVE | Not run | Open |
| Maturity review P0–P2 (egress authorization, state migration/compat policy, threat model, SLOs/support bundle, cost governance) | MATURITY_REVIEW 10-12 | Partially addressed (cloud authority section) | Migration policy, threat model, SLOs open |

## 9. Product summary as stated in docs

- **Intended users:** a single developer/operator running supervised coding tasks on trusted local repos, Linux x86-64; "qualified today for supervised single-operator use on trusted repositories" (TOP_TIER §1). Contest judges use Nexus only as the demo harness (README:10).
- **Supported workflows:** interactive Ratatui TUI (`nexus`), REPL (`nexus repl`, `--approve`), headless `nexus run` with JSON/exit codes (0 verified, 2 REGRESSION_FREE), resume (`-r`, `/resume`), `nexus doctor`, `nexus trust`, providers/connect, `/team` and `nexus operation` durable multi-unit work, checkpoints/undo, MCP client + `serve-mcp`, skills/plugins, eval.
- **Public promises:** one-line installer pinned to v0.1.0-alpha.2 with SHA-256 verification, no root; Linux x86-64 glibc≥2.35 + Node≥20 only; OpenAI-compatible local endpoint first (LM Studio/vLLM), cloud opt-in; honest outcome labels (VERIFIED only from passing verifier); no default step ceiling; secrets tokenized on egress; workspace code needs trust; uninstall keeps user data. Maturity explicitly "alpha, pre-1.0".
- **homelab-ai:** optional gateway (capability discovery, tokenize, admitted-count headers); Nexus must and claims to work standalone; standalone proven only by scripted fixtures.

## 10. GitHub issues relevant to v1

`gh issue list -R mikeholownych/nexus-code --state all --limit 100` → `[]`; `gh pr list` → `[]`. Repo public, created 2026-10-13; releases v0.1.0-alpha.1 (10-13), v0.1.0-alpha.2 (10-14). Historical Issue #10/#11/#12/#13 referenced in docs are from a prior tracker not reachable; #12 OPEN per docs, #10 deferred. No v1 milestone exists (HIST-10).

## 11. Commands run

```
cat BRIEF.md
ls docs; wc -c docs/*.md; find docs/reviews docs/research docs/superpowers docs/releases -type f
git log -1 --format=%cs -- <each doc>; git log --since=2026-10-11; git show --stat 3290234
grep -n (dispositions/blocker lines) across ISSUE12_*, PERS002_*, CLOUDFLARE_CONTEST_CRITICAL_PATH_ASSESSMENT.md, reviews/*.md, DEC01/02
gh issue list -R mikeholownych/nexus-code --state all --limit 100   # []
gh pr list -R mikeholownych/nexus-code --state all; gh repo view ... ; gh release list
Spot-checks: grep in cli/src/{plugins,mcp,agent,tools,security,tester,parser,worktree,client,index,sandbox}.ts, cli/src/core/{capabilities,egress,candidate}.ts, core/src/{file_ops,search}.rs, scripts/{security_gates,generate_sbom}.sh, install.sh, .github/workflows/*.yml
```
No builds/tests executed; no repo writes.
