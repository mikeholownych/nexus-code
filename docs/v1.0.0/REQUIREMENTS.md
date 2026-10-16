# Nexus Code v1.0.0: requirement ledger

This is the authoritative v1 ledger (REQ-OPS-101). It supersedes the Issue #12 matrices (`docs/ISSUE12_*.md`) and the phase and work-package documents, which become historical records. All historical commitments are carried forward in §2. None are silently dropped. Each one is either retained, superseded or descoped, with a written disposition.

**Tested revision for every status below:** `db1ca55` (main, `v0.1.0-alpha.2-2-gdb1ca55`), audited 2026-10-14.

## 1. Legend

### Status ladder

| Status | Meaning |
|---|---|
| `open` | Not implemented, or contradicted at HEAD. |
| `partial` | Partly implemented, or implemented with a known defect. |
| `implemented` | Present in source. Not proven by an automated test of this requirement. |
| `tested` | An automated test exercises it and passes at the tested revision (baseline: 905/905 CLI, 266/266 Rust). |
| `visually-accepted` | A human or independent PTY review accepted the rendered behaviour. |
| `product-qualified` | Passed the v1 qualification in ACCEPTANCE.md on the RC. **No requirement holds this status today.** |

Independent acceptance is recorded separately in the "Indep." column: **Y** = an independent review accepted it; **N** = self-assessed only; **—** = not applicable.

### Release classes

| Class | Meaning |
|---|---|
| **B** | BLOCKER. v1.0.0 cannot ship without it. |
| **RR** | Release-required. Must be done for v1.0.0; it is not a safety or workflow blocker on its own, but the release gate checks it. |
| **P** | Post-v1. |
| **K** | Keep: already met; protected by regression tests. |

### Evidence labels

| Label | Kind of evidence |
|---|---|
| SRC | source inspection |
| TEST | automated test |
| RT | live runtime observation (including PTY) |
| MEAS | measurement |
| DOC | documentation claim |
| HIST | historical or reported evidence |
| INF | inference |
| UNV | unknown or unverified |

### Links

- Findings are defined in [AUDIT.md](AUDIT.md).
- Specs are in [specs/](specs/), plans in [plans/](plans/), acceptance IDs in [ACCEPTANCE.md](ACCEPTANCE.md).

## 2. Carried-over commitments (REQ-*-0xx)

### 2.1 Retained commitments (already met or partly met; must not regress)

| ID | Source | Requirement | Location | Evidence @db1ca55 | Status | Indep. | Open risk | Acceptance | Class | Links |
|---|---|---|---|---|---|---|---|---|---|---|
| REQ-AGT-001 | COMPACTION_AND_CONTINUITY §A; operator directive | No default cumulative step or time ceiling. Turns end on completion, cancel, demonstrated stagnation, actionable failure or an operator-set budget. Resource-safety valves (provider iterations, 10k scheduler transitions, 5 compaction attempts) are allowed and labelled. | `types.ts:127-133`; `agent.ts:4379-4445` | TEST + SRC (A §5) | tested | N | — | ACC-CONT-04, ACC-QUAL-T3 | K | SPEC-04 |
| REQ-AGT-002 | quickstart; TOP_TIER B3; EXEC-005 | Truthful outcome taxonomy. VERIFIED requires a passing, deliverable-bound verifier run, plus fail-before/pass-after independence for discovered verifiers. UNVERIFIED, REGRESSION_FREE, BLOCKED and LIMIT_REACHED are distinct, with exit codes 0/2/1/130. | `agent.ts:5007-5173`; `turn.ts:318-351` | TEST; HIST eval rerun 0 false VERIFIED (tuned set); **RT 2026-10-14:** live ChatGPT bug-fix run reached a correct VERIFIED (fail-before/pass-after, test untouched; `evidence/live/run1_chatgpt_bugfix.log`) | partial | N | VER-04 can produce a false VERIFIED; VER-05 a zero-test REGRESSION_FREE | ACC-VER-03/04/09, ACC-QUAL-T2 | B | SPEC-11 |
| REQ-AGT-003 | COMPACTION §B | State-aware repetition and stagnation (action/outcome/state identity; polls vs loops; compaction re-acquisition is not repetition). | `execution_tracking.ts` | TEST (ACC-CONT-09; test:cli/test/execution_tracking.test.ts) | tested | N | — | ACC-CONT-09 | K | SPEC-04 |
| REQ-AGT-004 | COMPACTION §C | Durable compaction commit order archive → task → session (fsync). Failure stops the turn with PERSISTENCE_FAILED. Queued `/compact`. | `agent.ts:3070-3153` | TEST; HIST 1 live run | tested (depth 0) | **N (pending)** | AGT-02a: not applied to work units | ACC-CONT-03, ACC-CONT-10 | B (work units) / K (depth 0) | SPEC-04 |
| REQ-AGT-005 | TOP_TIER; USER_MANUAL | Steering is queued, applied once at a step boundary, never silently dropped, and survives restore. | `agent.ts:1935-1973` | TEST + RT (PTY s4a/s6) | tested | N | — | ACC-TUI-STEER | K | — |
| REQ-AGT-006 | EXEC-001; USER_MANUAL | Cancel during inference gives a truthful INTERRUPTED outcome naming the phase, within 5 s. | `agent.ts:4179-4190,4359-4372` | RT (PTY s5/s6: 0.2–2.4 s) | tested | N | TUI-11: one 11 s observation (UNV) | ACC-PROC-07 | K | SPEC-02 |
| REQ-AGT-007 | release notes alpha.2 | Output-truncated reply: nothing from it runs; one in-turn retry; a second consecutive truncation ends the turn. | `agent.ts:4671-4683`; `client.ts:1459-1468` | TEST (6/6, scripted) | tested | **N (pending)** | Never observed live | ACC-CONT-10, ACC-QUAL-T4 | K | SPEC-04 |
| REQ-AGT-008 | provider recovery design | Bounded provider recovery: 20 min deadline, jittered backoff, Retry-After honoured, probe before an UNKNOWN replay, ≤ 2 replays. | `provider_recovery.ts` | TEST 23/23 + 15/15 | tested | N | A never-reachable endpoint waits too long (TUI-06) | ACC-INF-07 | K | SPEC-05 |
| REQ-AGT-009 | EXEC-001..004, CAND-001..004 | One task lifecycle. Effects bound to a verified root. Validation bound to an immutable candidate. Merge requires receipt and identity equality. | `core/spine.ts`, `core/candidate.ts`, `worktree.ts:278-310` | TEST; HIST spot-check holds (F §4 #8) | tested | P (WP01/WP04 reviews) | — | existing suites | K | — |
| REQ-AGT-010 | CTX-001 (Issue #12 blocker) | Injected context carries provenance and classification metadata. | `agent.ts:3301,3789` | SRC | partial | Y (closure review: blocking) | DEC-04: partial implementation via REQ-SEC-113; full graph post-v1 | ACC-TRUST-04 | RR (partial), P (rest) | SPEC-03 |
| REQ-TUI-001 | TOP_TIER B7, TUI surface F1–F3 | An approval is never decided by stray typing, bursts, pastes or resize. "Approve all" is deliberate. | `live.rs:317-481`; `live_state.rs:1249-1395` | RT (PTY s2/s3, this audit); TEST `tui_approval_input_e2e`; HIST round 5 | tested | **Y** | TUI-09 arrow keys resolved per button layout; hints complete at 40 cols (TUI-10) | ACC-SAFE-08 | K | SPEC-01 |
| REQ-TUI-002 | USER_MANUAL | NO_COLOR is honoured. States are distinguishable without colour. | `theme.rs:19-47` | RT (0 colour SGR in 867) | tested | N | — | ACC-TUI-A11Y | K | — |
| REQ-TUI-003 | USER_MANUAL | Session resume in the TUI (`-r`, `/sessions`). | sidecar, `slash/session_commands.ts` | RT (PTY s7b) | tested | N | PER-05 corrupt-session messaging | ACC-PER-04 | K | SPEC-08 |
| REQ-SEC-001 | RES-001..004; DEC-01 ADR | File tools are confined to the workspace (lexical, symlink, parent-symlink, `/proc/self/fd` recheck). | `file_ops.rs:59-87,731-791` | RT (C §4 R1) | tested | P | TOCTOU swap race is untested; macOS branch is a no-op | ACC-SEC-JAIL (+ race test, P) | K | — |
| REQ-SEC-002 | EXT-002, TOP_TIER B2 | Workspace MCP configs and plugins load only after `nexus trust`, and never in `--read-only`. | `workspace_trust.ts`; `mcp.ts:509-531`; `plugins.ts:47-76` | TEST + SRC | tested | N | Skills and knowledge are not gated (→ REQ-SEC-113) | ACC-TRUST-04 | K | SPEC-03 |
| REQ-SEC-003 | CRED-001..002; EXECUTION_CONVERGENCE §7 | Credentials are scoped to their origin. A project `.env` never re-homes credentials. credentials.json is 0600. | `client.ts:77-133`; `credentials.ts:68-75` | TEST | tested | Y (CRED003 bounded) | `.env` can still disable TLS (→ REQ-SEC-110) | ACC-TRUST-01 | K | SPEC-03 |
| REQ-SEC-004 | DATA/DISC/REHYD (Issue #12) | Outbound content is classified. Secrets are tokenized on egress. Tokens are task-scoped and unforgeable. | `core/egress.ts` | TEST; HIST WP05 qualification | tested | Y (WP05) | Non-pattern secrets in URLs (UNV); B6 corpus not re-run since 3290234 | ACC-SEC-B6 | RR (re-qualify) | SPEC-03 |
| REQ-PRV-001 | CLOUD_PROVIDERS Authority | Only the operator selects a cloud destination. A project `.env` cannot. | `config.ts:53-72` | TEST (test:cli/test/egress.test.ts::"ACC-TRUST-02: CIDR classification table, reason codes, and operator origins") | tested | N | — | ACC-TRUST-02 | B (via REQ-SEC-111) | SPEC-03 |
| REQ-PRV-002 | protocol design | A model result (and its tool calls) is used only with positive completion evidence. | `client.ts:1436-1443`; protocols | TEST + RT | tested | N | — | existing | K | — |
| REQ-PRV-003 | COMPACTION:7-9; handoff doc | Nexus works without homelab-ai. Gateway features are optional and absent-safe. | `provider_capabilities.ts:184-195` | TEST (scripted) | implemented | N | No live standalone evidence (HIST-08) | ACC-INF-10 | B (via REQ-PRV-106) | SPEC-05 |
| REQ-PRV-004 | CLOUD_PROVIDERS | Cloud spend limits and receipts; disclosure notice on first request. | `usage.ts`; `client.ts:509-569` | TEST (mock); HIST live (openrouter, chatgpt); RT 2026-10-14 receipts written with provider-reported usage | tested | N | Other providers mock-only | ACC-PRV-LIVE | RR | SPEC-05 |
| REQ-REL-001 | quickstart | Installer: non-root; SHA-256 verified; no shell-rc edits; refuses a foreign `nexus`; atomic symlink swap; failure leaves HOME untouched. | `install.sh` | RT (E §4); TEST installer-smoke | tested | N | — | ACC-PKG-05 | K | SPEC-06 |
| REQ-REL-002 | release.yml | Release is gated on main ancestry, a version match, the full suite, a same-runner byte-reproducible package, and package and installer smoke tests. | `.github/workflows/release.yml` | RT (CI log 905/905) | tested | N | Cross-runner reproducibility unproven | ACC-SUP-08 | K | SPEC-07 |
| REQ-REL-003 | DEVELOPMENT.md; DEC-12 | Supported platform: Linux x86-64, glibc ≥ 2.35, Node ≥ 20. Clear failure messages elsewhere. | `install.sh` | RT (docker ubuntu 22.04: no node, node 12) | tested | N | Other distros and Node 22/24 untested | ACC-PLAT | RR | SPEC-07 |
| REQ-REL-004 | quickstart | Upgrade and rollback by re-running the installer with a tag. Manual uninstall keeps user data. | `install.sh` | RT (alpha.1→2→1) | tested | N | Reinstall does not repair (REL-10) | ACC-PKG-05 | K | SPEC-06 |
| REQ-REL-005 | SCAN-001..005 | Dependency and secret gates; zero High/Critical in a release. | `scripts/security_gates.sh` | RT (CI, real cargo audit) | partial | P (WP11) | Toy fallback (REL-07); no SAST | ACC-SUP-04 | RR (via REQ-REL-110) | SPEC-07 |
| REQ-DX-001 | DOCTOR_TROUBLESHOOTING | Doctor runs with no config, model or session. Versioned JSON. Distinct exit codes. Narrow, confirmed, backed-up, idempotent repairs. Redaction. | `doctor.ts` | RT (E §4) | tested | N | DX-01..05 | ACC-PKG-06..09 | K + RR | SPEC-06 |
| REQ-DX-002 | TOP_TIER B8 | `--version` shows version and commit. | `build_identity.ts` | RT | tested | N | — | ACC-PKG-03 | K | — |
| REQ-OPS-001 | TOP_TIER R2; EVID-004 | Persistence failure is visible. Compaction-commit failure stops the turn. | `agent.ts` (PERSISTENCE_FAILED) | TEST (ACC-CONT-06; test:cli/test/durable_continuity.test.ts) | tested | N | — | ACC-CONT-06 | RR (via REQ-AGT-106) | SPEC-04 |

### 2.2 Historical items that are superseded, contradicted or descoped (written dispositions; REQ-OPS-103)

| Historical item | Claimed status | Finding at HEAD | Disposition |
|---|---|---|---|
| Issue #12 (122 IDs, `PHASE2_RECONCILED_REQUIREMENTS.md`) | OPEN; 104 DEMONSTRATED | ≥ 10 DEMONSTRATED rows were later contradicted (HIST-02). More found here: EXEC-009, EXEC-011, UI-004. | **Superseded** by this ledger. The matrices are historical. Requirements still in force are carried in §2.1 and §3. |
| EXEC-009 / SUBP-004 (terminate subprocesses on cancel) | DEMONSTRATED ("setpgid deferred") | **Contradicted**: TUI-01 and SEC-07 reproduced orphans | Replaced by REQ-AGT-109 and REQ-SEC-106 (B) |
| SUBP-005 (registered background processes) | Satisfied with deferral | Not implemented | Replaced by REQ-SEC-106 (services, §3.4 of SPEC-02) |
| EXEC-011 (evaluators score the exact candidate) | DEMONSTRATED | **Contradicted** for `nexus eval` (VER-07) | `nexus eval` is experimental (DEC-07). The qualification harness is `eval/` (REQ-QUAL-106). |
| UI-004 (TUI is the default human surface) | DEMONSTRATED (evidence cites the old `tui.ts`) | **False for the package** (REL-01) | Replaced by REQ-REL-101 (B) |
| UI-006/007 ("Ratatui only a hypothesis; Issue #10 must not be implemented") | DEMONSTRATED | Ratatui TUI shipped | **Superseded** by an operator decision (docs/superpowers specs 2026-10-04) |
| DEDUP-003 (retain the 36-tool surface pending ablation) | DEMONSTRATED | 38 tools; rare groups offered on demand (0090f9c) | **Superseded**. Ablation evidence is partial (eval pilot). Tool-group behaviour is protected by `tool_groups.test.ts`. |
| "No Git remote" (P2 §2) | constraint | Public GitHub repository | **Superseded** |
| CTX-001 (per-item provenance) | PARTIALLY_DEMONSTRATED_BLOCKING | Open | DEC-04: **partial** in v1 (REQ-AGT-010 via REQ-SEC-113); remainder post-v1 |
| CTX-002 (knowledge freshness and applicability) | PARTIALLY_DEMONSTRATED_BLOCKING | Open | DEC-04: **descoped to post-v1**, with written rationale (auto-extract off and knowledge trust-gated) |
| EXT-004 (middleware before/after audit) | PARTIALLY_DEMONSTRATED_BLOCKING | Open (HIST-01) | DEC-04: **implement** → REQ-SEC-116 (B) |
| PERS-002 legacy identity-sensitive files | accepted limitation | Unchanged | Retained limitation. Permissions mitigate it (REQ-PER-101). |
| CRED-003 crash/exception display | bounded envelope | Unqualified | RR re-qualify under REQ-PRV-103 (error bounding and redaction) |
| DISC-005 recipient-readable encryption | nominal only | Not implemented | **Descoped to post-v1** (no v1 sink requires it) |
| REL-001 byte-identical builds | deferred | Same-runner proven | REQ-REL-114 (RR, cross-runner once for the RC) |
| ACT-002 configurable delegation depth | DEMONSTRATED | Hard-coded `depth >= 2` | Accepted as a fixed bound for v1 (documented). Configurability is post-v1. |
| EXECUTION_CONVERGENCE I3 (502/504 park), I4 (advisory hides decision), stale-lock race, corrupt lock | open | Not re-verified | Covered by DEC-03 (team/operation experimental). **Post-v1**, tracked as issues. |
| TOP_TIER R1–R11 residuals (RPC isolation, shell bounds, reactive context compaction I-05, usage from plain endpoints I-07, P2–P6 persistence integrity, T-04 advertised-but-failing MCP/plugin tools, PTY determinism) | open / partially referenced | Mapped: I-05 → REQ-PRV-102; I-07 → REQ-PRV-107; shell bounds → REQ-SEC-107; P2–P6 → REQ-PER-104/106; T-04 → verify under ACC-SAFE-02 (registry enumeration); RPC isolation and PTY determinism → post-v1 | Mapped as shown |
| Default 300-step / 120-min ceiling | removed in alpha.2 | — | Retired by design (REQ-AGT-001) |
| `spawn_subagent max_steps` argument | removed in alpha.2 | — | Retired (pre-1.0 API change, noted in release notes) |
| POST_REMEDIATION_DOGFOOD "INTEGRATION_BLOCKED" (completion truth across process death; retry launders unverified changes) | not re-dispositioned | Covered by REQ-AGT-101/106 and T4 class 9 | Re-qualify through ACC-QUAL-T4 |

## 3. v1.0.0 requirements (REQ-*-1xx)

Every row has status **open** at `db1ca55` unless stated otherwise. In the "Evidence" column, the cited finding is the evidence that the requirement is unmet.

### 3.1 Safety and execution boundary

| ID | Source | Requirement (short; full text in spec) | Rationale | Implementation location | Evidence | Status | Acceptance | Class | Finding | Spec / Plan |
|---|---|---|---|---|---|---|---|---|---|---|
| REQ-SEC-101 | Audit; DEC-01 | Without opt-in, no model-initiated exec or egress happens without a decision. Untrusted workspace → review; trusted → auto. | safety | `config.ts`, `sidecar.ts:935`, `repl.ts:69`, `index.ts:93,115` | TEST `approval_policy.test.ts`, `tui_surface_e2e.test.ts`, `repl_approval_e2e.test.ts` | tested | ACC-SAFE-01 | **B** | SEC-01, TUI-07 | SPEC-01 / PLAN-01 |
| REQ-SEC-102 | Audit; TOP_TIER B1 | Every capability has an effect class. Review gates every class except read. The gate is enforced at dispatch from the registry. | safety | `core/capabilities.ts`, `agent.ts:3945` | TEST `approval_policy.test.ts` | tested | ACC-SAFE-02 | **B** | HIST-05, SEC-03 | SPEC-01 / PLAN-01 |
| REQ-SEC-103 | Audit | No approval is decided by Enter alone, typed-ahead input, paste, or input inside the grace window, on any surface. | safety | `repl.ts:291-355,444-495`, `tui_approval_input_e2e.test.ts`, `repl_approval_e2e.test.ts` | PTY (ACC-SAFE-03, ACC-SAFE-08) | tested | ACC-SAFE-03, ACC-SAFE-08 | **B** | TUI-02, TUI-03 | SPEC-01 / PLAN-01 |
| REQ-SEC-119 | Audit | Nexus-initiated verifier runs are `exec` class: trust or one-time approval showing the script body; routed through the runner. | safety | `agent.ts:1654,3544,4255`; `tester.ts:145`; `verifier_gating.test.ts` | SRC (VER-01, VER-14) | tested | ACC-SAFE-09, ACC-SAFE-10 | **B** | VER-01, VER-14 | SPEC-01 / PLAN-01 |
| REQ-SEC-104 | Audit | `--read-only` cannot read outside the workspace through commands. HOME is masked. | safety | `sandbox.ts`, `core/authority.ts:44-136` | RT (SEC-04) | tested | ACC-SAFE-04 | RR | SEC-04 | SPEC-01 / PLAN-01 |
| REQ-TUI-102 | Audit | The startup banner states mode, sandbox and trust. Doctor reports the posture. | safety / UX | `sidecar.ts`, `live_view.rs`, `repl.ts`, `doctor.ts` | TEST `tui_surface_e2e.test.ts`, `doctor.test.ts` | tested | ACC-SAFE-06 | RR | TUI-07 | SPEC-01 / PLAN-01 |
| REQ-SEC-108 | Audit | The command denylist is labelled a tripwire, and its false positives are fixed. | honesty / workflow | `security.ts`, `runner.rs:64-107` | RT (SEC-02) | tested | ACC-SAFE-07 | RR | SEC-02, DOC-01 | SPEC-01 / PLAN-01 |
| REQ-SEC-109 | Audit | The sandbox argv is built as an array, with no shell re-parse. | compatibility | `sandbox.ts:131-181` | SRC (SEC-10) | tested | ACC-SAFE-05 | RR | SEC-10 | SPEC-01 / PLAN-01 |
| REQ-AGT-109 | EXEC-009 (carried) | Cancel kills in-flight tool process groups within 5 s. | safety | `runner.rs`, `tools.ts`, `agent.ts` | TEST (ACC-PROC-01, ACC-PROC-04; `cli/test/process_lifecycle.test.ts`, `core::runner::tests::cancel_ends_the_command_group`) | tested | ACC-PROC-01, ACC-PROC-04 | **B** | TUI-01, SEC-07 | SPEC-02 / PLAN-02 |
| REQ-SEC-106 | SUBP-004/005 (carried) | No task-owned process survives client exit, crash, SIGTERM or SIGHUP. Services are registered. | safety | `main.rs`, `runner.rs` | TEST (ACC-PROC-02, ACC-PROC-03; `cli/test/process_lifecycle.test.ts`, `core/tests/rpc_shutdown.rs`, `core::runner::tests::background_processes_left_by_a_command_are_ended`) | tested | ACC-PROC-02, ACC-PROC-03 | **B** | SEC-07, TUI-01 | SPEC-02 / PLAN-02 |
| REQ-SEC-107 | Audit; TOP_TIER R2 shell bounds | Bounded memory for command output, reads and fetch. `timeout_secs` is clamped. | failure | `runner.rs:177-193`, `file_ops.rs:205-277`, `tools.ts` | TEST (ACC-PROC-05, ACC-PROC-06; `cli/test/process_bounds_and_services.test.ts`, `core::file_ops::tests::test_read_file_and_batch_read_8mb_cap_and_paging`, `core::runner::tests::output_is_truncated_when_it_exceeds_max_output_chars`) | tested | ACC-PROC-05, ACC-PROC-06 | RR | SEC-08 | SPEC-02 / PLAN-02 |
| REQ-TUI-107 | Audit | A cancel is acknowledged within one frame and names what it is waiting for. | UX / failure | `live_state.rs:1566` | TEST (ACC-PROC-01; `core::live_view::tests::cancel_during_running_tool_shows_waiting_for_tool_in_hint`, `core::live_state::tests::a_second_ctrl_c_while_busy_force_quits_but_esc_only_cancels`) | tested | ACC-PROC-01 | RR | TUI-08, TUI-11 | SPEC-02 / PLAN-02 |
| REQ-AGT-109a | Audit | Notifications and BEL only on an interactive TTY surface. | compatibility | `agent.ts:773-780,4932` | TEST (ACC-PROC-08; `cli/test/notification_gating.test.ts`) | tested | ACC-PROC-08 | RR | AGT-16 | SPEC-02 / PLAN-02 |
| REQ-SEC-110 | Audit | A project `.env` may set only allowlisted keys and never touches `process.env`. | safety (credential MITM) | `config.ts:36-39` and env readers | TEST (PRV-01; test:cli/test/project_env_allowlist.test.ts::"per-project settings apply through effective config without touching process.env (REQ-SEC-110)") | tested | ACC-TRUST-01 | **B** | PRV-01 | SPEC-03 / PLAN-03 |
| REQ-SEC-111 | CLOUD_PROVIDERS Authority (carried) | Locality comes from parsed IP and CIDR, or operator-listed origins. Hostnames are external. | safety (disclosure) | `core/egress.ts:107-160` | TEST (PRV-02; test:cli/test/egress.test.ts::"ACC-TRUST-02: CIDR classification table, reason codes, and operator origins") | tested | ACC-TRUST-02 | **B** | PRV-02, PRV-08 | SPEC-03 / PLAN-03 |
| REQ-SEC-112 | TOP_TIER T-12; Audit | `fetch_web` pins DNS, checks every redirect hop, caps the body at 5 MB, and is gated as egress. | safety | `tools.ts:52-111,653-662` | TEST (SEC-03; test:cli/test/fetch_web_ssrf.test.ts::"ACC-TRUST-03: SSRF protection, DNS pinning, redirect hop checks, and streaming 5 MB cap") | tested | ACC-TRUST-03 | RR | SEC-03 | SPEC-03 / PLAN-03 |
| REQ-SEC-113 | Audit; CTX-001 partial | Workspace skills and knowledge load only when the workspace is trusted. Injected items are annotated with their source. | safety | `skills.ts:31-33`, `knowledge.ts`, `agent.ts:3301` | TEST (SEC-05, AGT-10; test:cli/test/workspace_trust.test.ts::"ACC-TRUST-04: workspace skills and knowledge load only when workspace is trusted, with source annotations") | tested | ACC-TRUST-04 | RR | SEC-05, AGT-10 | SPEC-03 / PLAN-03 |
| REQ-SEC-114 | Audit; DEC-15 | No implicit standing rules (auto-extract is opt-in). No workspace writes in read-only mode. | safety | `knowledge.ts`, `agent.ts:4934` | TEST (AGT-10; test:cli/test/workspace_trust.test.ts::"ACC-TRUST-05: no implicit standing rules (autoExtract opt-in) and read-only mode creates no .nexus/") | tested | ACC-TRUST-05 | RR | AGT-10 | SPEC-03 / PLAN-03 |
| REQ-SEC-115 | Audit | Plugins load only from Nexus's own documented directories. The opencode directory is removed. | safety (foreign code) | `plugins.ts:47-54` | TEST (HIST-04; test:cli/test/plugins_dirs.test.ts::"ACC-TRUST-06: plugin directories (REQ-SEC-115)") | tested | ACC-TRUST-06 | **B** | HIST-04 | SPEC-03 / PLAN-03 |
| REQ-SEC-116 | EXT-004 (carried) | A middleware rewrite of tool I/O emits a before/after audit record. | normative blocker | `plugins.ts:150-200` | TEST (HIST-01; test:cli/test/ext004_audit.test.ts::"ACC-TRUST-07: EXT-004 middleware audit (REQ-SEC-116)") | tested | ACC-TRUST-07 | **B** | HIST-01 | SPEC-03 / PLAN-03 |
| REQ-SEC-117 | Audit | No false plugin-sandbox claim. `executeSandboxed` is removed. | honesty | `plugins.ts:254-300`; `USER_MANUAL.md:294` | TEST (SEC-09, HIST-03; test:cli/test/harness.test.ts::"PluginManager executes custom plugins in-process without false sandbox (REQ-SEC-117)") | tested | ACC-GOV-04 | RR | SEC-09, HIST-03 | SPEC-03 / PLAN-03 |
| REQ-SEC-118 | B6 (carried) | Protected-path matching covers `.env*` and canonical, case-insensitive names on every read tool. | safety (advisory) | `security.ts:25-32,91-108` | TEST (SEC-06; test:cli/test/security.test.ts::"ACC-TRUST-09: protected paths matching covers .env* and canonical, case-insensitive names (REQ-SEC-118)") | tested | ACC-TRUST-09 | RR | SEC-06 | SPEC-03 / PLAN-03 |
| REQ-PRV-108 | Audit | `search_web` does not fabricate results, discloses its destination, and is gated. | honesty / disclosure | `search_web.ts` | TEST (PRV-15; test:cli/test/search_web.test.ts::"ACC-TRUST-08: search_web with mock returning no results returns success:false without fabricated results") | tested | ACC-TRUST-08 | RR | PRV-15 | SPEC-03 / PLAN-03 |
| REQ-AGT-112 | TOP_TIER B5 (carried) | Native tool calls only on native connections. Prose JSON is never executed. | safety | `parser.ts:382-434`, `fewshots.ts` | TEST (VER-02; test:cli/test/parser_safety.test.ts::"ACC-VER-01: prose JSON and quoted code blocks are never executed") | tested | ACC-VER-01 | **B** | VER-02 | SPEC-11 / PLAN-11 |
| REQ-AGT-113 | TOP_TIER B5 (carried) | Reasoning is never parsed for tools (lone `</think>`, unclosed `<think>`). | safety | `parser.ts:320-332` | TEST (VER-03; test:cli/test/parser_safety.test.ts::"ACC-VER-01: lone </think> and unclosed <think> strip rejected reasoning") | tested | ACC-VER-01 | **B** | VER-03 | SPEC-11 / PLAN-11 |
| REQ-AGT-117 | Audit | Structurally repaired arguments are rejected for write and exec tools. Malformed native calls are dropped, not crashed on. | safety / failure | `parser.ts:189-231,336-345` | RT (VER-10, VER-11) | open | ACC-VER-02, ACC-VER-06 | RR | VER-10, VER-11 | SPEC-11 / PLAN-11 |

### 3.2 Completion truth, continuity and recovery

| ID | Source | Requirement | Rationale | Location | Evidence | Status | Acceptance | Class | Finding | Spec / Plan |
|---|---|---|---|---|---|---|---|---|---|---|
| REQ-AGT-114 | quickstart promise | Deliverable binding uses path tokens, not basename substrings. | outcome honesty (false VERIFIED) | `tester.ts:488-570` | TEST (ACC-VER-03; test:cli/test/verification_binding.test.ts, test:cli/test/repro_false_verified.test.ts) | tested | ACC-VER-03 | **B** | VER-04 | SPEC-11 / PLAN-11 |
| REQ-AGT-115 | Audit | A zero-executed-tests pass is UNVERIFIED (NO_TESTS_EXECUTED) and keeps the obligation. | honesty | `tester.ts:356-430`; `agent.ts:3516-3675,5360-5410` | TEST (ACC-VER-04; test:cli/test/verification_binding.test.ts) | tested | ACC-VER-04 | RR | VER-05 | SPEC-11 / PLAN-11 |
| REQ-AGT-116 | Audit | One verifier selector. `run_tests` uses the verifier deadline. | consistency | `tester.ts:21-138`; `tools.ts:589` | RT (VER-06) | open | ACC-VER-05 | RR | VER-06 | SPEC-11 / PLAN-11 |
| REQ-AGT-118 | Audit | Conservative token estimation; `/tokenize` used when available. | failure (context overflow) | `tokens.ts` | MEAS + INF (VER-09) | open | ACC-VER-07 | RR | VER-09 | SPEC-11 / PLAN-11 |
| REQ-AGT-119 | DEC-07 | Experimental surfaces are labelled. `nexus eval` never mutates the operator checkout. Reviewer and researcher roles are read-only. | honesty / safety | `index.ts`, `evaluator.ts:128`, `roles.ts` | SRC (VER-07/08/13) | open | ACC-VER-08 | RR | VER-07, VER-08, VER-13 | SPEC-11 / PLAN-11 |
| REQ-AGT-101 | USER_MANUAL; CLIENT_GUIDE (resume) | `run --resume <id>` continues the conversation, objective and id. A bare `--resume` resolves the latest task. | workflow | `agent.ts:5236`; `app.ts:174`; `index.ts:176` | RT (AGT-01; test:cli/test/durable_continuity.test.ts) | tested | ACC-CONT-01, ACC-CONT-02 | **B** | AGT-01 | SPEC-04 / PLAN-04 |
| REQ-AGT-102 | COMPACTION §C (carried) | Durability is decided by an explicit property. Work units commit compactions durably. | data loss | `agent.ts` depth gates | SRC (AGT-02; test:cli/test/durable_continuity.test.ts) | tested | ACC-CONT-03 | **B** | AGT-02a | SPEC-04 / PLAN-04 |
| REQ-AGT-103 | Audit | Work units persist tracking and the change baseline across resume. | convergence | `execution_tracking.ts` | SRC (AGT-02c/d; test:cli/test/durable_continuity.test.ts) | tested | ACC-CONT-04 | RR | AGT-02 | SPEC-04 / PLAN-04 |
| REQ-AGT-104 | Audit | Accounting includes subagent and findings inference. | cost honesty | `agent.ts:5298-5431` | RT (AGT-03; test:cli/test/durable_continuity.test.ts) | tested | ACC-CONT-05 | RR | AGT-03 | SPEC-04 / PLAN-04 |
| REQ-AGT-105 | Audit | In-turn subagents write no durable records. | hygiene | `agent.ts:1148` | RT (AGT-04; test:cli/test/durable_continuity.test.ts) | tested | ACC-CONT-05 | RR | AGT-04 | SPEC-04 / PLAN-04 |
| REQ-AGT-106 | EVID-004 (carried) | An escaping exception gives a truthful UNHANDLED_ERROR result with the real obligation. Durable-write failures are reported. | honesty / failure | `agent.ts:4254-4995`; `turn.ts:444-460` | TEST (ACC-CONT-06; test:cli/test/durable_continuity.test.ts) | tested | ACC-CONT-06 | RR | AGT-08, AGT-14, VER-11 | SPEC-04 / PLAN-04 |
| REQ-AGT-107 | Audit | Implementer and tester units cannot be COMPLETE with no change. | honesty | `operation_runner.ts:651-663` | SRC (AGT-11; test:cli/test/team_convergence.test.ts) | tested | ACC-CONT-07 | RR | AGT-11, AGT-12 | SPEC-04 / PLAN-04 |
| REQ-AGT-108 | Audit | No false stagnation when state identity is unknown. | workflow | `execution_tracking.ts` | TEST (ACC-CONT-09; test:cli/test/execution_tracking.test.ts) | tested | ACC-CONT-09 | RR | AGT-09 | SPEC-04 / PLAN-04 |
| REQ-AGT-110 | HIST-09 | Independent acceptance of continuity, compaction and truncation recovery. | qualification | — | DOC ("pending") | open | ACC-CONT-10, ACC-GOV-06 | RR | HIST-09 | SPEC-04 / PLAN-09 |
| REQ-AGT-111 | EXECUTION_CONVERGENCE §10 | A single step implementation for the main and subagent loops. | maintainability | `agent.ts:5298-5431` | SRC (AGT-05) | open | — | P (v1: document and add `measureAdmission`) | AGT-05 | SPEC-04 / PLAN-04 |

### 3.3 Local inference and providers

| ID | Source | Requirement | Rationale | Location | Evidence | Status | Acceptance | Class | Finding | Spec / Plan |
|---|---|---|---|---|---|---|---|---|---|---|
| REQ-PRV-101 | Standalone commitment | Context discovery for vLLM, llama.cpp, LM Studio and Ollama, with the source labelled. | standalone workflow | `provider_capabilities.ts` | TEST (PRV-06; test:cli/test/server_context_discovery.test.ts::"discovery against a local server") | tested | ACC-INF-01 | **B** | PRV-06 | SPEC-05 / PLAN-05 |
| REQ-PRV-102 | TOP_TIER I-05 (carried) | A capacity rejection leads to one compact-and-retry, then an actionable error. llama.cpp, LM Studio and Ollama bodies are classified. | standalone / failure | `provider_recovery.ts:82,106`; `agent.ts:5072` | TEST (PRV-07; test:cli/test/provider_recovery_agent.test.ts::"capacity rejection handling (ACC-INF-02)") | tested | ACC-INF-02 | **B** | PRV-06, PRV-07 | SPEC-05 / PLAN-05 |
| REQ-PRV-103 | CRED-003 (carried) | Error text is bounded and redacted on every path. | safety | `client.ts:903,1636,1689`, `oauth.ts` | TEST (PRV-03; test:cli/test/provider_robustness.test.ts::"listModels and generateEmbedding huge error bodies are bounded and redacted (ACC-INF-03)") | tested | ACC-INF-03 | RR | PRV-03 | SPEC-05 / PLAN-05 |
| REQ-PRV-104 | Audit | Timeouts and cancel on every network call. First-byte, idle and total timeouts. Bounded replays. | failure | `client.ts`, `embeddings.ts`, `model_catalog.ts` | TEST (PRV-05, PRV-10; test:cli/test/provider_robustness.test.ts::"watchdog first-byte and idle timeouts reject when server hangs or stalls (ACC-INF-04)") | tested | ACC-INF-04 | RR | PRV-05, PRV-10 | SPEC-05 / PLAN-05 |
| REQ-PRV-105 | Audit | Stream parser robustness, with recorded real-server fixtures. | compatibility | `client.ts:1326-1483` | TEST (PRV-04; test:cli/test/provider_fixes.test.ts::"stream parser handles tool name chunks, repeated tool names, and object arguments (PRV-04 / REQ-PRV-105)", test:cli/test/provider_robustness.test.ts::"empty stream re-request records executions: 2 in receipt (ACC-INF-06)") | tested | ACC-INF-05, ACC-INF-06 | RR | PRV-04 | SPEC-05 / PLAN-05 |
| REQ-PRV-106 | Standalone commitment; HIST-08; DEC-16 | Standalone qualification: (a) live runs through the gateway-stripping proxy, in plain and emulated-server profiles; (b) server-kind conformance fixtures. | standalone (product principle) | — | HIST (gateway-only live runs) | open | ACC-INF-10, ACCEPTANCE §4.2 | **B** | HIST-08 | SPEC-05 / PLAN-05, PLAN-10 |
| REQ-PRV-107 | TOP_TIER I-07 | Local receipts (opt-out). | evidence | `client.ts:561-569`, `usage.ts` | TEST (B §6 G1; test:cli/test/provider_robustness.test.ts::"local receipts are recorded with origin_class: local and opt out with NEXUS_RECEIPTS=0 (REQ-PRV-107)") | tested | ACC-INF-06 | RR | B §6 G1 | SPEC-05 / PLAN-05 |
| REQ-PRV-109 | Standalone commitment | No homelab identifiers in code or docs. The gateway token path is configurable. | standalone / honesty | `client.ts:66-79,751-764`, `docs/LOCAL_SERVERS.md` | TEST (PRV-11, PRV-17; test:cli/test/task_class.test.ts::"ACC-INF-08: code and docs carry no homelab-specific identifiers (t5820, engineering/b0, A770, 18010)") | tested | ACC-INF-08 | RR | PRV-11, PRV-17 | SPEC-05 / PLAN-05 |
| REQ-PRV-110 | Audit | Custom CA is documented and validated by doctor. | safety (prevents an insecure workaround) | launcher, `doctor.ts` | TEST (PRV-18; test:cli/test/inference_transport.test.ts::"ACC-INF-09: doctor validates NODE_EXTRA_CA_CERTS in ~/.config/nexus/config.env") | tested | ACC-INF-09 | RR | PRV-18 | SPEC-05 / PLAN-05 |
| REQ-PRV-111 | DEC-06 | Live `providers verify` for each provider listed as supported. The others are labelled experimental. | compatibility claims | `provider_cli.ts` | **RT 2026-10-14 @db1ca55:** chatgpt (gpt-6-luna) PASS, openrouter (openrouter/free) PASS (`evidence/live/verify_*.json`). openai-key and anthropic not connected. | partial (re-run at RC with a pinned OpenRouter model) | ACC-PRV-LIVE | RR | B §6 G2 | SPEC-05 / PLAN-10 |
| REQ-TUI-105 | Audit | Startup endpoint probe with a fix hint. A never-reachable endpoint is bounded to 2 minutes. | onboarding | `sidecar.ts`, `repl.ts`, `provider_recovery.ts` | TEST (TUI-06; test:cli/test/startup_unreachable_e2e.test.ts::"ACC-INF-07 (REQ-TUI-105): Startup endpoint probe and first-contact deadline") | tested | ACC-INF-07 | RR | TUI-06 | SPEC-05 / PLAN-05 |

### 3.4 Packaging, release and diagnostics

| ID | Source | Requirement | Rationale | Location | Evidence | Status | Acceptance | Class | Finding | Spec / Plan |
|---|---|---|---|---|---|---|---|---|---|---|
| REQ-REL-101 | UI-004 (carried) | The packaged `nexus` opens the live TUI on a TTY. One launcher grammar. | primary workflow | `index.ts:747`; `package-linux.sh:24-30`; `live.rs:126-131` | TEST (ACC-PKG-01; test:cli/test/harness_entry.test.ts) | tested | ACC-PKG-01 | **B** | REL-01, TUI-04, DX-05 | SPEC-06 / PLAN-06 |
| REQ-REL-102 | USER_MANUAL promise | Every documented command parses on the package. | public promise | `index.ts`; docs | TEST (ACC-PKG-02; test:scripts/doc_commands.mjs) | tested | ACC-PKG-02 | **B** | REL-02, TUI-05, HIST-06 | SPEC-06 / PLAN-06 |
| REQ-REL-103 | Audit | A single version across tag, package.json files, Cargo and the core handshake. | compatibility / supportability | `core/Cargo.toml:3`; `release.yml` | TEST (ACC-PKG-03; test:cli/test/engine_handshake.test.ts, core/tests/rpc_shutdown.rs) | tested | ACC-PKG-03 | **B** | REL-04 | SPEC-06 / PLAN-06 |
| REQ-REL-104 | Audit; DEC-14 | An unknown subcommand is an error. Free text needs `run`. | safety (accidental agent run) | `harness.sh:39-42` | TEST (ACC-PKG-04; test:cli/test/harness_entry.test.ts) | tested | ACC-PKG-04 | RR | REL-03 | SPEC-06 / PLAN-06 |
| REQ-REL-105 | Audit | Installer: strict tag check, clear no-stable message, repair on reinstall, quiet output. | onboarding | `install.sh` | TEST (ACC-PKG-05; test:scripts/installer-smoke.sh) | tested | ACC-PKG-05 | RR | REL-08, REL-10, REL-11, REL-12 | SPEC-06 / PLAN-06 |
| REQ-REL-106 | Audit | `nexus self uninstall`/`prune`. | convenience | — | — | open | — | P (docs RR, already met) | REL-10 | SPEC-06 |
| REQ-DX-101 | Audit | Doctor stderr is clean, and its remedies match the install type. | supportability | `doctor.ts` | TEST (ACC-PKG-06, ACC-PKG-07; test:cli/test/doctor.test.ts) | tested | ACC-PKG-06, ACC-PKG-07 | RR | DX-01, DX-02 | SPEC-06 / PLAN-06 |
| REQ-DX-102 | quickstart chmod advice | Doctor checks `config.env` permissions and offers a repair. | safety | `doctor.ts` | TEST (ACC-PKG-08; test:cli/test/doctor.test.ts) | tested | ACC-PKG-08 | RR | DX-04 | SPEC-06 / PLAN-06 |
| REQ-DX-103 | Audit | Doctor never redacts paths wholesale. | supportability | `doctor.ts:103-110` | TEST (ACC-PKG-09; test:cli/test/doctor.test.ts) | tested | ACC-PKG-09 | RR | DX-03 | SPEC-06 / PLAN-06 |
| REQ-DX-104 | Audit | `tui.launch` checks real launchability. | honesty | `doctor.ts:517-529` | TEST (ACC-PKG-01; test:cli/test/doctor.test.ts) | tested | ACC-PKG-01 | RR | DX-05 | SPEC-06 / PLAN-06 |
| REQ-REL-107 | License obligations | Third-party notices for all redistributed dependencies. | legal / compliance | `package-linux.sh` | TEST (ACC-SUP-01; test:scripts/check_notices.mjs, scripts/smoke-package.sh) | tested | ACC-SUP-01 | **B** | REL-05 | SPEC-07 / PLAN-07 |
| REQ-REL-108 | REL-003 (carried) | Lockfile-derived, validated SBOM. | supply chain | `generate_sbom.sh` | TEST (ACC-SUP-02; test:scripts/generate_sbom.sh, cyclonedx validate) | tested | ACC-SUP-02 | RR | REL-06, HIST-07 | SPEC-07 / PLAN-07 |
| REQ-REL-109 | TOP_TIER D4 | Provenance attestation; tag-pinned installer asset. | supply chain | `release.yml` | TEST (ACC-SUP-03; test:release.yml, install.sh) | tested | ACC-SUP-03 | RR | REL-09 | SPEC-07 / PLAN-07 |
| REQ-REL-110 | SCAN-003 (carried) | The vulnerability gate fails closed. | security gate honesty | `security_gates.sh` | TEST (ACC-SUP-04; test:cli/test/security_gates.test.ts, scripts/security_gates.sh) | tested | ACC-SUP-04 | RR | REL-07 | SPEC-07 / PLAN-07 |
| REQ-REL-111 | Audit | CI matrix for Node 20/22/24, pinned toolchain and MSRV, engines field, dist freshness (untracked). | compatibility | `ci.yml` | TEST (ACC-SUP-05; test:.github/workflows/ci.yml, .gitignore) | tested | ACC-SUP-05 | RR | REL-13, MNT-01 | SPEC-07 / PLAN-07 |
| REQ-REL-112 | REL-004 (carried) | SECURITY.md, CHANGELOG.md, release body taken from release notes. | supportability | root, `release.yml` | TEST (ACC-SUP-06; test:SECURITY.md, CHANGELOG.md, release.yml) | tested | ACC-SUP-06 | RR | HIST-07, MNT-05 | SPEC-07 / PLAN-07 |
| REQ-REL-113 | Audit | Remove dead CI and tracked bytecode. | maintainability | `.gitlab-ci.yml`, `*.pyc` | TEST (ACC-SUP-07) | tested | ACC-SUP-07 | RR | MNT-02, EVL-007 | SPEC-07 / PLAN-07 |
| REQ-REL-114 | REL-001 (carried) | Cross-runner reproducibility, demonstrated once for the RC. | supply chain | `repro.yml` | UNV | open | ACC-SUP-08 | RR | E §6 | SPEC-07 / PLAN-07 |

### 3.5 Persistence

| ID | Source | Requirement | Rationale | Location | Evidence | Status | Acceptance | Class | Finding | Spec / Plan |
|---|---|---|---|---|---|---|---|---|---|---|
| REQ-PER-101 | PERS-002 (carried) | `~/.nexus` is 0700 and files are 0600. Doctor repairs both. | privacy on multi-user hosts | `checkpoint.ts`, `flight.ts`, `session.ts`, etc. | MEAS (PER-01) | tested | ACC-PER-01 | RR | PER-01 | SPEC-08 / PLAN-08 |
| REQ-PER-102 | Audit; DEC-11 | Retention and GC; audit log rotation; indexed session listing. | resource / failure | new `retention.ts` | MEAS (PER-02: 916 MB) | tested | ACC-PER-02, ACC-PER-06 | RR | PER-02 | SPEC-08 / PLAN-08 |
| REQ-PER-103 | Audit | The test suite never writes to the real HOME. | hygiene; prerequisite | `state.ts:278-288`; test setup | TEST (ACC-PER-03; test:cli/test/home_isolation.test.ts, scripts/run_tests.mjs) | tested | ACC-PER-03 | RR (M0 prerequisite) | PER-03 | SPEC-08 / PLAN-08 |
| REQ-PER-104 | TOP_TIER P2–P6 | Corrupt and future-schema state is reported and quarantined. Resume ids are unambiguous. | failure | `session.ts:113-239` | TEST (ACC-PER-04; test:cli/test/state_migration.test.ts, cli/test/state.test.ts) | tested | ACC-PER-04 | RR | PER-05 | SPEC-08 / PLAN-08 |
| REQ-PER-105 | Audit | Telemetry is never committable by default. | privacy | `flight.ts:55-59` | TEST (ACC-PER-05; test:cli/test/flight_exclude.test.ts) | tested | ACC-PER-05 | RR | PER-06 | SPEC-08 / PLAN-08 |
| REQ-PER-106 | MATURITY_REVIEW (migration policy) | Documented schema and migration policy with tests. | compatibility | docs, `state.ts` | TEST (ACC-PER-07; test:cli/test/state_migration.test.ts, docs/STATE_COMPATIBILITY.md) | tested | ACC-PER-07 | RR | — | SPEC-08 / PLAN-08 |
| REQ-PER-107 | Audit | Rust atomic write fsyncs the parent directory. | durability | `file_ops.rs:156-182` | SRC (PER-04; core/src/file_ops.rs:188-194) | implemented | — | P | PER-04 | SPEC-08 / PLAN-08 |

### 3.6 Governance and documentation

| ID | Source | Requirement | Rationale | Location | Evidence | Status | Acceptance | Class | Finding | Spec / Plan |
|---|---|---|---|---|---|---|---|---|---|---|
| REQ-OPS-101 | HIST-02 | This ledger is authoritative. The historical matrices carry banners. | governance | this file; docs banners | DOC | partial (ledger exists; banners pending) | ACC-GOV-02, ACC-GOV-03 | **B** | HIST-02 | SPEC-09 / PLAN-09 |
| REQ-OPS-102 | HIST-02 | A CI checker binds rows to tests and acceptance IDs. | governance | `scripts/check_requirements.mjs` | — | open | ACC-GOV-01 | RR | HIST-02 | SPEC-09 / PLAN-09 |
| REQ-OPS-103 | HIST-01, HIST-11 | Written dispositions for the Issue #12 open blockers and superseded items. | governance | §2.2 | DOC (this file) | implemented (§2.2) | ACC-GOV-02 | **B** | HIST-01, HIST-11 | SPEC-09 / PLAN-09 |
| REQ-DX-105 | Audit | User docs make no claim contradicted by source, contain no homelab IDs, and make no parity claims. | honesty | docs | SRC (HIST-03, HIST-06, DOC-01, PRV-17, AGT-07) | open | ACC-GOV-04 | RR | as listed | SPEC-09 / PLAN-09 |
| REQ-DX-106 | HIST-10 | Open v1 work is tracked as GitHub issues under a milestone. | process | GitHub | RT (0 issues) | open | ACC-GOV-05 | RR | HIST-10 | SPEC-09 / PLAN-09 |

### 3.7 Qualification

| ID | Source | Requirement | Rationale | Location | Evidence | Status | Acceptance | Class | Finding | Spec / Plan |
|---|---|---|---|---|---|---|---|---|---|---|
| REQ-QUAL-101 | TOP_TIER Q1; DEC-05 | Held-out T2 evaluation: 40 tasks, ≥ 50% external, sealed manifest. | product maturity | `eval/` | HIST (6 tuned tasks) | open | ACCEPTANCE §6.1 | **B** | EVL-001 | SPEC-10 / PLAN-10 |
| REQ-QUAL-102 | DEC-05 | Matched conditions with a model fingerprint. | validity | `eval/run.mjs`, `fingerprint.mjs` | SRC (EVL-004) | open | ACCEPTANCE §6.1 | **B** | EVL-004 | SPEC-10 / PLAN-10 |
| REQ-QUAL-103 | DEC-05 | 5 runs per task and configuration; Goose and OpenCode as peers. | statistics | `eval/` | — | open | ACCEPTANCE §6.1 | **B** | EVL-001 | SPEC-10 / PLAN-10 |
| REQ-QUAL-104 | DEC-05 | Separately reported metrics, including false VERIFIED = 0. | honesty | `eval/score.mjs` | SRC (EVL-005) | open | ACCEPTANCE §6.1 | **B** | EVL-005 | SPEC-10 / PLAN-10 |
| REQ-QUAL-105 | TOP_TIER Q6; DEC-05 | T4 fault injection: 8 classes × 5 runs, 100% truthful outcomes. | failure / recovery | `eval/faults/` | — | open | ACCEPTANCE §6.2 | **B** | EVL-001 | SPEC-10 / PLAN-10 |
| REQ-QUAL-106 | Audit | Scoring integrity (symmetric infra handling, contamination, hidden tests). | validity | `eval/infra.mjs`, `eval/score.mjs`, `eval/run.mjs` | SRC (EVL-002, EVL-003) | open | ACCEPTANCE §6.1 | **B** | EVL-002, EVL-003, VER-07 | SPEC-10 / PLAN-10 |
| REQ-QUAL-107 | Standalone; DEC-06 | Standalone and provider live matrix. | standalone | — | HIST | open | ACCEPTANCE §4.2, §4.3 | **B** | HIST-08 | SPEC-10 / PLAN-10 |
| REQ-QUAL-108 | Audit | PTY CI plus a manual real-terminal matrix. | terminal acceptance | `cli/test/tui_*`; ACCEPTANCE §5.3 | TEST (PTY suites in CI); UNV (real terminals) | partial | ACCEPTANCE §5 | RR | D §6 | SPEC-10 / PLAN-10 |
| REQ-QUAL-109 | eval/README T3 | T3 long tasks: 8 × 5. | long-task workflow | `eval/` | — | open | ACCEPTANCE §6.3 | RR | EVL-001 | SPEC-10 / PLAN-10 |
| REQ-QUAL-110 | Audit | T1 self-test and a T4 smoke run in `make test`. | regression | `eval_harness.test.ts` | TEST (T1 present) | partial | ACC-QUAL-SMOKE | RR | — | SPEC-10 / PLAN-10 |

## 4. Contest requirements (separate product; not client gates)

These are REQ-CON-101 to REQ-CON-107, specified in [SPEC-C1](specs/SPEC-C1-contest-submission-track.md). The submission was **completed** (owner, 2026-10-14) and is frozen until judging ends (DEC-13). Every row is post-contest hardening with status `open`. The evidence is `evidence/G_contest_eval.md` (CON-001 to CON-014).

## 5. Post-v1 backlog (recorded, not dropped)

- REQ-AGT-111: single step loop.
- CTX-001 full provenance graph.
- CTX-002: knowledge freshness.
- DISC-005: encryption sinks.
- ACT-002: configurable delegation depth.
- EXECUTION_CONVERGENCE I3, I4, stale-lock race, corrupt lock.
- `/tdd` phase enforcement (VER-08).
- `nexus eval` scoring fix (VER-07b–e).
- Per-role allowlists beyond reviewer and researcher.
- cgroup containment.
- Network-isolated sandbox for generated code.
- macOS, arm64 and musl builds (DEC-12).
- REQ-REL-106 (self uninstall).
- REQ-PER-107 (directory fsync).
- Persistence split-record schema (only if ACC-CONT-08 fails).
- RPC worker isolation.
- PTY determinism.
- Per-command approval allowlists.

## 6. Counts at db1ca55

Counts are from the tables above.

| Group | Rows | Breakdown |
|---|---|---|
| New v1 rows (§3) | 92 | **31 B**, 58 RR, 3 P. 79 open, 9 partial (REQ-SEC-118, REQ-PRV-101, REQ-PRV-103, REQ-PRV-105, REQ-PRV-111, REQ-PER-106, REQ-OPS-101, REQ-QUAL-108, REQ-QUAL-110), 1 implemented (REQ-OPS-103), 4 tested (REQ-SEC-103, REQ-SEC-119, REQ-PER-101, REQ-PER-102). |
| Carried rows (§2.1) | 29 | 14 tested and unchanged (Keep). 1 visually-accepted (REQ-TUI-001). The rest are partial, or have open items mapped to §3. |
| Contest rows (§4) | 7 | Separate product. |

**No requirement is `product-qualified`.**
