# Nexus Code v1.0.0 readiness audit

| | |
|---|---|
| Audit date | 2026-10-14 |
| Tested revision | `db1ca55` (`main`, `v0.1.0-alpha.2-2-gdb1ca55`) |
| Scope | Full first-party repository. Coverage ledger in §4. |
| Conclusion | **v1.0.0 readiness is NOT established. It is BLOCKED.** There are 31 open blocker requirements across 11 workstreams, plus qualification evidence that does not yet exist. |

This document reports implementation state and audit evidence only. It is not an independent acceptance (see §8). Client release readiness and contest readiness are assessed separately (§7).

## 1. Project identity

| Item | Value | Evidence |
|---|---|---|
| Repository root | `/home/mike/nexus-code` | RT |
| Remote | `origin` = `github.com/mikeholownych/nexus-code` (https fetch, ssh push). This is the expected canonical repository. The checkout is a clone of it. `main` = `origin/main` + 1 local docs commit as of audit start (`db1ca55` on top of `adb7d17`). The commit is pushed (git status clean apart from one untracked directory). | RT (`git remote -v`, `git status`) |
| Working tree | Clean except the untracked `nexus-continuity-validation/` (user's; preserved). Two stashes (`stash@{0}` continuity and instruction-precedence work; `stash@{1}` pre-sync) preserved untouched. 90 worktrees exist (not inspected). | RT |
| Versions | `package.json` and `cli/package.json`: `0.1.0-alpha.2`. **`core/Cargo.toml`: `1.2.1`** (mismatch, REL-04). Tags on origin: `v0.1.0-alpha.1` and `v0.1.0-alpha.2`, both GitHub prereleases. Local-only tags `v1.1.0`, `v1.2.0`, `v1.2.1` (never on the remote, per the owner and `git ls-remote`). | RT |
| Build entry points | `make build` (cargo release + `tsc`), `make test` (cargo test + `npm --prefix cli test` + `scripts/security_gates.sh`), `scripts/package-linux.sh`, `scripts/smoke-package.sh`, `scripts/installer-smoke.sh`. CI: `.github/workflows/ci.yml` (contest contract job + `linux-x86_64`), `release.yml` (tag-triggered). A dead `.gitlab-ci.yml` also exists. | SRC |
| Toolchain at audit | node v24.21.0, npm 11.19.0, cargo/rustc 1.95.0, Ubuntu (kernel 6.8), glibc 2.39 | RT |
| Installed launchers | `~/.local/bin/nexus` → published package `v0.1.0-alpha.2` (`a2e94f3`), **first on PATH**. `/usr/local/bin/nexus` → `~/nexus-code/harness.sh` (checkout build, reports `0.1.0-alpha.2 (db1ca5580860, main)`). Plain `nexus` on this host therefore runs the published package, not the checkout. | RT |
| Runtime services | The local inference gateway is configured in `~/.config/nexus/config.env`: endpoint `https://10.0.8.5:8443/v1`, model `engineering/b0`, key redacted, `LOCAL_HARNESS_SHELL=bash`. The repo-tracked `cli/.env` holds LM Studio defaults (`localhost:1234`, key "local"). **The audit sent no requests to the gateway.** With owner authorization (2026-10-14, small spend), it made live cloud calls through the existing ChatGPT sign-in and OpenRouter connections: two `providers verify` runs and one `nexus run` bug-fix task. See EVIDENCE §3. | RT (values redacted) |
| External dependencies | Node ≥ 20 (runtime), GitHub Releases (installer), optional bubblewrap/Docker (sandbox), optional cloud providers (OpenRouter, OpenAI, Anthropic, ChatGPT/Copilot OAuth, compatible), optional MCP servers, DuckDuckGo (default `search_web`). | SRC |
| Issue tracker | GitHub: 0 issues, 0 PRs. Historical Issues #10–#13 lived in a prior tracker and are referenced only in docs. | RT (`gh`) |

## 2. Product contract for v1.0.0

### 2.1 Established commitments (sources: README, quickstart, USER_MANUAL, COMPACTION_AND_CONTINUITY, CLOUD_PROVIDERS, release notes, Issue #12 and later reviews; ledger in REQUIREMENTS §2)

- **Users and workflows.** A single developer or operator runs supervised coding tasks in local repositories on Linux x86-64. The workflows are:
  - the interactive live TUI (primary);
  - the REPL;
  - headless `nexus run` with JSON output and exit codes;
  - resume (`-r`, `/resume`, `run --resume`);
  - `nexus doctor`;
  - workspace trust;
  - providers and connect;
  - checkpoints and undo;
  - MCP client and server;
  - skills and plugins;
  - `/team` and `nexus operation`.
- **Local inference is first class.** Nexus works against any OpenAI-compatible local server (LM Studio, vLLM). The homelab-ai gateway is an optional integration, and Nexus must operate without it.
- **Honest outcomes.** VERIFIED only from a real, bound verifier pass. UNVERIFIED, REGRESSION_FREE, BLOCKED and LIMIT_REACHED are distinct.
- **No default step ceiling.** Turns end on completion, cancel, stagnation or failure.
- **Safety promises.**
  - Path jail.
  - Workspace extensions only after `nexus trust`.
  - Secrets tokenized on egress.
  - Credential origin scoping.
  - Cloud destinations only by operator choice.
  - Approvals cannot be decided by stray typing.
- **Distribution.** A one-line non-root installer with SHA-256 verification, version pinning, upgrade and rollback by re-running, manual uninstall that keeps user data, and Linux x86-64 / glibc ≥ 2.35 / Node ≥ 20 only.

### 2.2 Proposed v1.0.0 maturity definition

Nexus v1.0.0 means all of the following:

1. **Safe by default on untrusted input.** Content from a repository, a web page, a skill or a tool output cannot cause unapproved host execution, egress, or configuration changes.
2. **Owns its processes.** Stop means stopped.
3. **Truthful.** No false VERIFIED. Bounded, typed failures.
4. **Continuous.** Resume and compaction never silently lose state.
5. **Standalone.** Qualified live on at least 2 non-gateway local servers.
6. **Shippable.** The installed product equals the tested product, and the documented commands work. One version identity, license notices, SBOM and provenance.
7. **Qualified.** Held-out matched evaluation, plus fault injection, meeting the pre-registered thresholds in DEC-05.

### 2.3 Classification

| Category | Location |
|---|---|
| Blockers, release-required work, post-v1 work | REQUIREMENTS.md §3, §5 |
| Decisions | DECISIONS.md. All resolved under delegated owner authority (2026-10-14). |
| Optional improvements after v1 | REQUIREMENTS §5 |

Each blocker is justified by a workflow, a safety requirement, a compatibility commitment or a reproduced failure (see its "Rationale" and "Finding" columns).

## 3. Architecture as implemented

```
 operator ─┬─► nexus (packaged: node index.js → REPL)          ◄── REL-01: no route to TUI
           └─► harness.sh (checkout) ─► nexus-tui --live (Rust, Ratatui)
                                           │ NDJSON protocol (stdin/stdout)
                                           ▼
                                 node sidecar.js  ──or──  node index.js repl/run
                                           │ (in-process)
                                           ▼
            ApplicationCore / AutonomousAgent.runTurn  (cli/src/agent.ts, 5.4k lines)
              steering drain → capability refresh → admission (compaction ladder, findings,
              token count) → ProviderRecoveryController → streaming inference (client.ts)
              → parse (parser.ts) → dispatch (approval gate) → ExecutionSpine/authority
              → RustCoreBridge (tools.ts) ── JSON-RPC stdio ──► harness-core rpc (Rust)
              → observe/ExecutionTracker → endStep → durable state (~/.nexus/tasks, sessions)
                                                                 │
     inference: OpenAI-compatible (local/gateway) | Responses | Anthropic | OAuth providers
     verifier: tester.ts discoverVerifier → harness-core run_command (repo test script)
     extensions: MCP (stdio/remote), plugins (in-process import), skills (prompt injection)
```

### 3.1 Trust boundaries and their state at HEAD

| Boundary | Intended control | Actual state (finding) |
|---|---|---|
| Model → host shell | Approval or sandbox | Default auto with no sandbox (SEC-01); verifier runs bypass even review mode (VER-01); prose and reasoning JSON executed (VER-02/03) |
| Model → network | Egress classification, approval | Ungated in review mode (HIST-05); SSRF guard is string-based (SEC-03) |
| Workspace → configuration | Only allowlisted project settings | `.env` overrides any env, including TLS (PRV-01) |
| Workspace → prompt | Trust-gated | MCP and plugins are gated; skills and knowledge are not (SEC-05, AGT-10) |
| Destination locality | IP-based | Prefix strings (PRV-02, PRV-08) |
| Operator cancel → processes | Kill the tree | Not propagated; orphans on exit (TUI-01, SEC-07) |
| File tools → filesystem | Jail | **Sound** (C §4 R1) |
| Credentials → destinations | Origin-bound | **Sound** (B §5), except the TLS downgrade path |
| Durable state → other users | 0600/0700 | Mostly 664/775 (PER-01) |

### 3.2 Data flow for persistence and recovery

- **Task state.** `~/.nexus/tasks/<id>.json`, written as a full atomic rewrite on each progress event. The compaction archive is `<id>.history.jsonl` (append + fsync).
- **Sessions.** `~/.nexus/sessions`.
- **Other stores.** Checkpoints at `~/.nexus/checkpoints` plus `refs/nexus/checkpoints/*`. The audit log at `~/.nexus/audit.log`. Flights at `<ws>/.nexus/flights`.
- **Recovery.** `recoverFromTaskState` restores messages and objective, and filters uncommitted archive entries. **Except:** `run --resume` discards the restored conversation (AGT-01), and work units skip the commit protocol (AGT-02).

## 4. Coverage ledger and methods

Methods:

- Seven parallel scoped audits plus one gap-fill audit. Each produced a per-file coverage table (`evidence/*_*.md` §1).
- A clean-snapshot baseline build and test, plus a git-clone baseline run in CI order.
- PTY-driven terminal sessions against a local mock gateway.
- Probes against local mock servers.
- Installer runs in scratch HOMEs and in docker.
- Read-only inspection of the operator's state directories.
- Source greps for spot checks.

| Area (tracked files) | Files | Method | Evidence file | Exclusions |
|---|---|---|---|---|
| Agent loop and core (`cli/src/agent.ts`, `core/{turn,app,execution_tracking,objective,provider_recovery,operation_runner}.ts`, `team.ts`) | 9 | Full read | A_core_agent | — |
| Core (partial): `core/state.ts`, `core/spine.ts`, `core/candidate.ts` | 3 | Targeted read | A, C | Remaining regions skimmed |
| Verification and parsing: `parser, tester, evaluator, synthesizer, stager, tokens, fewshots, image, clipboard, build_identity`, `core/{findings, operation, candidate, roles}` | 14 | Full read (findings and operation: targeted) + probes | A2_verification | — |
| Providers: `client.ts`, `protocols/*`, `providers, provider_cli, provider_connect, model_catalog, credentials, oauth, config, usage, search_web, onboard, embeddings`, `core/{provider_capabilities, egress}` | 17 | Full read (embeddings, egress: targeted) + mock probes | B_providers; this file (provider_connect, read by lead) | `evaluateEgress` deep logic reviewed only for classification |
| Tools, security, persistence: `tools, safe_fs, sandbox, security, session, session_export, checkpoint, flight, evidence, git, worktree, mcp, plugins, skills, browser, lsp, file_diff, syntax, diagnostics, workspace_trust`, `core/{authority, resources, durable_file, persistence_protection, capabilities, workspace_path, independent_check, tool_groups}` | 28 | Full read for security-critical files. Grep or skim for session_export, file_diff, syntax, diagnostics, resources, browser, lsp, mcp transports. | C_tools_security_persistence; this file (workspace_trust, workspace_path, tool_groups, independent_check, approval_review, read by lead) | MCP remote transports, browser.ts and lsp.ts got only a skim review: **qualification gap** |
| Rust harness-core: `core/src/{main, file_ops, runner, search, git_ops, cst, trigram}.rs`, `core/tests` | 9 | main/runner full read; file_ops mostly full (delimiter validator 400-575 skipped); others grep + runtime | C | file_ops.rs:400-575 not reviewed |
| Rust TUI: `core/src/bin/nexus_tui.rs` + 14 modules | 15 | Targeted read of the approval, input and cancel paths + **real PTY runs**. composer, diff_view, markdown, highlight, models, review, slash, sidecar.rs, redact are exercised indirectly and by the repo PTY suites. | D_terminal + D_pty/ | Line review of the rendering modules: excluded (covered by PTY behaviour) |
| TS UI: `sidecar, protocol, repl, tui, ui, theme, index, slash/*, approval_review` | 12 | Targeted read + PTY | D, E | ui.ts and theme.ts skimmed |
| Distribution and CI: `install.sh, harness.sh, Makefile, package.json` ×2, lockfiles, `scripts/*`, workflows, `.gitlab-ci.yml`, `LICENSE`, `doctor.ts` | 20 | Full read + installer runs (6 scratch HOMEs + docker) + CI log | E_distribution | Lockfiles audited by tool, not by line |
| Generated `cli/dist` (86 files) | 86 | Byte-diffed against a fresh build of HEAD: identical except build-info | E | Not reviewed as source (generated) |
| Contest: `experiments/cloudflare-artifacts-vertical-slice` (84), `demo/` (14) | 98 | Worker, broker transport and launcher: full read. Experiments: grep. Tests executed. | G_contest_eval | Vendored Node upstream (`pubring.kbx`, SHASUMS): signature verified with gpgv, not line-reviewed. Static ELF `bin/nexus-cf-broker`: `file` + `strings` only. Historical experiment scripts: grep. Video: binary, excluded. |
| Eval harness `eval/` (43) | 43 | Full read of run/score/infra/configs. 2 of 7 tasks read. | G | Hidden tests of the other 5 tasks not read (by design) |
| Experiments archives (routing, thermal, context-validation; 147) | 147 | READMEs + `sha256sum -c` | G | Raw data not re-analysed |
| Docs (324): requirement and acceptance history, reviews, product docs | 324 | Product docs: full read. Issue #12 set: P2 reconciled + final matrix full, the rest skimmed. 24 review docs: 6 full, the rest by verdict line. ~183 evidence files excluded (raw). | F_requirements_history | `PHASE2S_SECURITY_AND_DATA_REVIEW.md`: skimmed only |
| tasks/, AGENTS.md, README, quickstart | 5 | Full read | lead | — |

Every first-party subsystem appears above. Known unreviewed regions are named, and they are qualification gaps, not cleared code. The `.nexus/` directory and `nexus-continuity-validation/` are untracked and were excluded. The graphify knowledge graph was not used for conclusions.

## 5. Findings register

Severity is the auditing reviewer's rating:

| Rating | Meaning |
|---|---|
| S1 | blocker severity |
| S2 | major |
| S3 | minor |
| S4 | note |

"Class" is this package's release disposition (B / RR / P / contest). Evidence labels are defined in REQUIREMENTS §1. Full evidence, reproductions and line references are in `evidence/<scope>.md` under the same ID.

### 5.1 Safety and execution

| ID | Sev | Class | Workflow | Location | Evidence | User impact | Disposition |
|---|---|---|---|---|---|---|---|
| SEC-01 | S1 | B | Every interactive run | `repl.ts:69`, `sidecar.ts:935`, `index.ts:93,115`, `runner.rs:116-157` | SRC | Prompt-injected host commands run without a prompt or sandbox | REQ-SEC-101 (SPEC-01) |
| VER-01 | S2 | B | Untrusted repo, any edit, even review mode | `agent.ts:1602-1630,3432`; `tester.ts:113-136` | SRC | The repo's test script runs on the host unprompted | REQ-SEC-119 |
| VER-02 | S2 | B | Every turn | `parser.ts:382-434`; `fewshots.ts` | RT (probe) | Echoed or quoted JSON becomes an executed action | REQ-AGT-112 (SPEC-11) |
| VER-03 | S2 | B | Reasoning models | `parser.ts:320-332` | RT (probe) | Rejected ideas inside reasoning get executed | REQ-AGT-113 |
| HIST-05 | S2 | B | Review mode | `capabilities.ts` (`mutating:false` network tools); `agent.ts:3946` | SRC | Egress never needs approval | REQ-SEC-102 |
| TUI-02 | S2 | B | REPL approval | `repl.ts:353,385` | RT (PTY) | A lone Enter approves | REQ-SEC-103 |
| TUI-03 | S2 | B | REPL approval | `repl.ts:270-276` | RT (PTY) | Typed-ahead `y` approves | REQ-SEC-103 |
| TUI-07 | S2 | B | Default posture | `sidecar.ts:935`; `quickstart.md:55` | SRC + DOC | Docs imply review; the default is auto | REQ-SEC-101 |
| SEC-02 | S2 | RR | run_command | `security.ts:12-23,78-89`; `runner.rs:64-107` | RT | Denylist bypassed; false positives | REQ-SEC-108 |
| SEC-03 | S2 | RR | fetch_web | `tools.ts:52-111,653-662` | RT | Loopback/LAN reachable; body unbounded | REQ-SEC-112 |
| SEC-04 | S2 | RR | Read-only mode | `core/authority.ts:44-136` | RT | Home secrets readable | REQ-SEC-104 |
| SEC-05 | S2 | RR | Untrusted repo | `skills.ts:31-33`; `agent.ts:3301` | SRC | Persistent prompt injection through skills | REQ-SEC-113 |
| SEC-06 | S3 | RR | Protected paths | `security.ts:25-32,91-108` | RT | `.env.local` etc. readable | REQ-SEC-118 |
| SEC-07 | S2 | B | Cancel and exit | `tools.ts:247-347`; `runner.rs:164-223` | RT | Orphaned processes | REQ-SEC-106, REQ-AGT-109 |
| SEC-08 | S3 | RR | Output and reads | `runner.rs:177-193`; `file_ops.rs:205-277` | MEAS (785 MB / 590 MB RSS) | OOM risk | REQ-SEC-107 |
| SEC-09 | S3 | RR | Plugins | `plugins.ts:254-300` | SRC | Misleading "sandbox" | REQ-SEC-117 |
| SEC-10 | S3 | RR | Sandbox | `sandbox.ts:131-181` | SRC | Breaks on paths with spaces; networked docker | REQ-SEC-109 |
| SEC-11 | S4 | K | Git tools | `git_ops.rs` | SRC | None. libgit2 with no shell. | Note |
| TUI-01 | S1 | B | Cancel or quit during a tool | `tools.ts`; `runner.rs:167`; `live_state.rs:1566` | RT (PTY s8/s9) | Stop does not stop; orphans after quit | REQ-AGT-109, REQ-SEC-106 (SPEC-02) |
| TUI-08 | S3 | RR | Cancel feedback | `live_state.rs:1566` | RT | No "cancelling" on Esc | REQ-TUI-107 |
| TUI-09 | S3 | RR | Approval keys | `live_state.rs:1329-1335` | RT + SRC | Arrow direction inverted | PLAN-01 task 13 |
| TUI-10 | S3 | RR | Narrow terminal | `live_view.rs` | RT (40×14) | Decision hint truncated | PLAN-01 task 13 |
| TUI-11 | S3 | RR | Cancel latency | live / sidecar | RT (1 of 4 runs ≥ 11 s) | Possible slow cancel | ACC-PROC-07 (UNV) |
| TUI-12 | S4 | P | Steering vs consent | `live_state.rs` | RT | "yes" text reaches the model | Docs note |
| TUI-13 | S4 | P | Quit | `live_state.rs:1605-1609` | RT | Single Ctrl-C at idle exits | Optional |
| TUI-14 | S4 | P | Rendering | `protocol.ts:314` | RT | Cosmetic wrapping | Post-v1 |
| AGT-16 | S4 | RR | Headless output | `agent.ts:773-780,4932` | SRC | BEL/notify-send in headless mode | REQ-AGT-109a |

### 5.2 Untrusted inputs, providers and inference

| ID | Sev | Class | Workflow | Location | Evidence | User impact | Disposition |
|---|---|---|---|---|---|---|---|
| PRV-01 | S2 | B | Opening any repo | `config.ts:36-39` | RT (TLS repro) | A repo `.env` disables TLS; keys can be intercepted | REQ-SEC-110 (SPEC-03) |
| PRV-02 | S2 | B | Disclosure gate | `core/egress.ts:134-139` | RT | `10.attacker.example` is treated as local | REQ-SEC-111 |
| PRV-08 | S3 | RR | LAN/Tailscale servers | `egress.ts:129-141` | RT | Legitimate local hosts are treated as cloud | REQ-SEC-111 |
| HIST-04 | S2 | B | Startup | `plugins.ts:47-54` | SRC | Imports `~/.config/opencode/plugins` | REQ-SEC-115 |
| HIST-01 | S2 | B | Plugins (EXT-004) | `plugins.ts:150-200` | SRC + DOC | Silent rewriting of tool I/O | REQ-SEC-116 |
| HIST-03 | S2 | RR | Docs, plugins | `USER_MANUAL.md:294` | SRC | False sandbox claim | REQ-SEC-117 |
| AGT-10 | S3 | RR | Every turn | `knowledge.ts:34-43,206-231` | SRC | Prompt fragments become standing rules; read-only mode writes | REQ-SEC-114 |
| PRV-15 | S3 | RR | search_web | `search_web.ts:49,94,143-152` | SRC | Fabricated "result"; DuckDuckGo default | REQ-PRV-108 |
| PRV-06 | S2 | B | Standalone LM Studio and llama.cpp | `provider_capabilities.ts:29,72` | SRC + INF | 65536 default; overflow ends the turn | REQ-PRV-101, REQ-PRV-102 (SPEC-05) |
| PRV-07 | S3 | B (via 102) | llama.cpp overflow | `provider_recovery.ts:82,106` | RT | Overflow misclassified | REQ-PRV-102 |
| PRV-03 | S3 | RR | Errors | `client.ts:903,1636,1689` | RT (200 KB, key passed through) | Floods; secret echo | REQ-PRV-103 |
| PRV-04 | S3 | RR | Streaming | `client.ts:1406` | RT | `read_fileread_file` | REQ-PRV-105 |
| PRV-05 | S3 | RR | Discovery and embeddings | `client.ts:890-913,1676` | RT (hang) | Hangs with no cancel | REQ-PRV-104 |
| PRV-09 | S3 | RR | Empty stream | `client.ts:1118-1135,1472` | RT | Second, uncapped execution | PLAN-05 task 8 |
| PRV-10 | S3 | RR | Timeouts | `client.ts:744-747` | SRC + RT | 15-minute stall; long generations killed and replayed | REQ-PRV-104 |
| PRV-11 | S4 | RR | Homelab coupling | `client.ts:63-69,644` | SRC | Homelab names in product | REQ-PRV-109 |
| PRV-12 | S4 | RR | Error typing | `client.ts:1091-1113` | SRC | Wrong failure class | PLAN-05 task 13 |
| PRV-13 | S4 | RR | Fallback | `client.ts:785-793` | SRC | Pin ignored | PLAN-05 task 13 |
| PRV-14 | S4 | RR | Picker | `model_catalog.ts:128-136` | SRC | Key-less provider hidden | PLAN-05 task 13 |
| PRV-16 | S4 | RR | Responses API | `openai_responses.ts:108` | SRC | Wrong replay class | PLAN-05 task 13 |
| PRV-17 | S4 | RR | Docs | `CLOUD_PROVIDERS.md`, `USER_MANUAL.md:3` | DOC vs SRC | Overstated claims | REQ-DX-105 |
| PRV-18 | S4 | RR | Custom CA | (none) | SRC | Users are pushed toward disabling TLS | REQ-PRV-110 |
| TUI-06 | S2 | RR | Unreachable endpoint | `protocol.ts:306-315` | RT (PTY) | Indefinite wait with no guidance | REQ-TUI-105 |
| HIST-08 | S2 | B | Standalone | (evidence gap) | DOC/HIST | Quickstart path never run live | REQ-PRV-106 |

### 5.3 Completion truth, continuity and verification

| ID | Sev | Class | Workflow | Location | Evidence | User impact | Disposition |
|---|---|---|---|---|---|---|---|
| VER-04 | S2 | B | VERIFIED claims | `tester.ts:356-360` | RT (probe) | False VERIFIED by basename coincidence | REQ-AGT-114 |
| VER-05 | S3 | RR | Zero-test pass | `tester.ts:263-282` | RT | REGRESSION_FREE without any tests run | REQ-AGT-115 |
| VER-06 | S3 | RR | run_tests, /test | `tester.ts:21-138` | RT | Wrong command, wrong timeout | REQ-AGT-116 |
| VER-07 | S2 | RR | `nexus eval` | `evaluator.ts:128-213` | SRC | Invalid scores; checks out the operator's workspace | REQ-AGT-119; DEC-07 |
| VER-08 | S2 | RR | /tdd | `synthesizer.ts:239-326` | SRC + INF | Phases not enforced | DEC-07 (experimental) |
| VER-09 | S3 | RR | Admission | `tokens.ts:5-26` | MEAS + INF | 4–6× undercount on CJK, digits, base64 | REQ-AGT-118 |
| VER-10 | S3 | RR | Truncated arguments | `parser.ts:189-231` | RT | Partial file writes on misbehaving servers | REQ-AGT-117 |
| VER-11 | S4 | RR | Malformed native call | `parser.ts:336-345` | RT | Turn crash | REQ-AGT-117 |
| VER-12 | S3 | RR | /copy on X11 | `clipboard.ts:21-27` | SRC | Copy goes to PRIMARY | PLAN-11 task 12 |
| VER-13 | S3 | RR | Team roles | `roles.ts:20-76` | SRC | Reviewer can edit | REQ-AGT-119 |
| VER-14 | S3 | B (with VER-01) | /test, eval | `tester.ts:143-163` | SRC | Unsandboxed, UI freeze | REQ-SEC-119 |
| VER-15 | S4 | RR | Image attach | `image.ts:25-74` | SRC | Oversized requests | PLAN-11 task 12 |
| VER-16 | S4 | RR | Hunk UI | `stager.ts:45-47` | RT | Wrong names displayed | PLAN-11 task 12 |
| AGT-01 | S2 | B | `run --resume` | `agent.ts:5236`; `app.ts:174`; `index.ts:176` | RT | Resume restarts from scratch; `latest` always fails | REQ-AGT-101 (SPEC-04) |
| AGT-02 | S2 | B (a) / RR (b–d) | /team, operations | `agent.ts` depth gates | SRC + DOC | Compaction originals lost; history reset | REQ-AGT-102/103 |
| AGT-03 | S3 | RR | Accounting | `agent.ts:5298-5431` | RT | Under-reported tokens and cost | REQ-AGT-104 |
| AGT-04 | S3 | RR | Subagents | `agent.ts:1148` | RT | Orphan task records | REQ-AGT-105 |
| AGT-05 | S3 | P (doc RR) | Subagent loop | `agent.ts:5298-5431` | SRC | Divergent guarantees | REQ-AGT-111 |
| AGT-06 | S4 | RR | Obligation write | `agent.ts:3610-3641` | SRC | Crash window | PLAN-04 task 7 |
| AGT-07 | S3 | RR | Docs | `EXECUTION_CONVERGENCE.md:117` | SRC + DOC | Wrong team cap stated | REQ-DX-105 |
| AGT-08 | S3 | RR | Unexpected error | `turn.ts:444-460` | SRC | "No pending changes" reported after edits | REQ-AGT-106 |
| AGT-09 | S3 | RR | Large repos | `agent.ts:2026-2047` | INF | False stagnation | REQ-AGT-108 |
| AGT-11 | S3 | RR | Team outcome | `operation_runner.ts:651-663` | SRC | COMPLETE without a change | REQ-AGT-107 |
| AGT-12 | S4 | RR | Operation bound | `operation_runner.ts:95-137` | SRC | Dead-end decision | REQ-AGT-107 |
| AGT-13 | S4 | RR | Attempt numbers | `objective.ts` | SRC | Ambiguous receipts | PLAN-04 task 11 |
| AGT-14 | S4 | RR | Durable writes | `agent.ts` (several) | SRC | Silent loss of crash detection | REQ-AGT-106 |
| AGT-15 | S4 | RR (measure) | Persistence cost | `state.ts` | INF | Possible latency | ACC-CONT-08 |
| HIST-09 | S3 | RR | Alpha.2 changes | review ledger | DOC | Unaccepted stop semantics | REQ-AGT-110 |

### 5.4 Packaging, release, diagnostics and maintainability

| ID | Sev | Class | Workflow | Location | Evidence | User impact | Disposition |
|---|---|---|---|---|---|---|---|
| REL-01 | S2 | B | Install → first run | `package-linux.sh:24-30`; `index.ts:747` | RT | The installed product lacks the TUI | REQ-REL-101 (SPEC-06) |
| TUI-04 | S2 | B | Same | `live.rs:126-131` | RT | Packaged `nexus-tui` cannot find its sidecar | REQ-REL-101 |
| REL-02 / TUI-05 | S2 | B | Docs → CLI | `USER_MANUAL.md:12-26` | RT | Documented commands fail | REQ-REL-102 |
| REL-04 | S2 | B | Versioning | `core/Cargo.toml:3` | RT | Doctor warns on every install | REQ-REL-103 |
| REL-03 | S2 | RR | Dev launcher | `harness.sh:39-42` | SRC | Typos start agent runs | REQ-REL-104 |
| REL-05 | S2 | B | Compliance | release archive | RT + SRC | No third-party notices | REQ-REL-107 (SPEC-07) |
| REL-06 | S3 | RR | SBOM | `generate_sbom.sh` | SRC | Wrong versions; incomplete | REQ-REL-108 |
| REL-07 | S3 | RR | Security gate | `audit_rust_deps.py` | SRC + CI | Toy fallback says "clean" | REQ-REL-110 |
| REL-08 | S3 | RR | Installer | `install.sh:21-24` | RT | Opaque no-version failure | REQ-REL-105 |
| REL-09 | S3 | RR | Integrity | `release.yml` | SRC | No provenance | REQ-REL-109 |
| REL-10 | S3 | RR | Reinstall | `install.sh:48-49` | RT | Cannot repair | REQ-REL-105 |
| REL-11 | S4 | RR | Tag validation | `install.sh:26` | RT | Loose regex | REQ-REL-105 |
| REL-12 | S4 | RR | Installer UX | `install.sh:32-33` | RT | Noisy output | REQ-REL-105 |
| REL-13 | S3 | RR | CI | `ci.yml` | SRC + CI | Node 20 only; floating Rust | REQ-REL-111 |
| MNT-01 | S3 | RR | dist tracking | `cli/dist` | MEAS (in sync today) | Staleness risk | DEC-10 |
| MNT-02 | S4 | RR | Dead CI | `.gitlab-ci.yml` | SRC | Misleading | REQ-REL-113 |
| MNT-03 | S4 | RR | Repro target | `Makefile:36-45` | SRC | Weak local check | PLAN-07 task 8 |
| MNT-04 | S4 | RR | Naming | `index.ts:63` | RT | "Usage: harness" | PLAN-06 task 1 |
| MNT-05 | S4 | RR | Changelog | `release.yml:47` | RT | Curated notes not shown | REQ-REL-112 |
| MNT-06 | S4 | P | Dependency duplicates | `Cargo.lock` | MEAS | Minor bloat | None |
| DX-01 | S3 | RR | Doctor | `doctor.ts:751,757` | RT | Warning on every run | REQ-DX-101 |
| DX-02 | S3 | RR | Doctor (package) | `doctor.ts:316-520` | RT | Wrong remedies | REQ-DX-101 |
| DX-03 | S3 | RR | Doctor redaction | `doctor.ts:103-110` | RT | Path hidden | REQ-DX-103 |
| DX-04 | S3 | RR | Doctor | `doctor.ts` | RT | World-readable key not flagged | REQ-DX-102 |
| DX-05 | S4 | RR | Doctor | `doctor.ts:517-529` | RT | Misleading PASS | REQ-DX-104 |
| PER-01 | S2 | RR | State privacy | `checkpoint.ts`, `flight.ts`, … | MEAS | Other users can read code copies and prompts | REQ-PER-101 (SPEC-08) |
| PER-02 | S2 | RR | Retention | `state.ts` | MEAS (916 MB, 52,687 files) | Unbounded growth | REQ-PER-102 |
| PER-03 | S2 | RR (M0) | Tests | `state.ts:278-288` | MEAS | Tests pollute real HOME | REQ-PER-103 |
| PER-04 | S3 | P | Durability | `file_ops.rs:101-188` | SRC | Edge-case power loss | REQ-PER-107 |
| PER-05 | S3 | RR | Resume | `session.ts:113-239` | SRC | Corruption shown as "not found" | REQ-PER-104 |
| PER-06 | S3 | RR | Flight logs | `flight.ts:55-59` | SRC | Telemetry committable | REQ-PER-105 |
| DOC-01 | S3 | RR | Docs | `ARCHITECTURE.md:55-58` | DOC vs RT | Overstated guarantees | REQ-DX-105 |
| PERF-01 | S4 | RR (measure) | Cost per task | prompt assembly | MEAS (live 2026-10-14): a one-line bug fix used 7 requests, 83,331 input and 376 output tokens (about 12k input tokens per request) on ChatGPT | High token cost per small task. This matters most for slow local inference, where prompt size adds latency. | Report tokens per correct task in qualification (REQ-QUAL-104). Compare with peers. Optimization is post-v1 unless a DEC-05 threshold fails. |
| PERF-02 | S4 | P | Developer loop | `cli` test suite | MEAS: CLI suite takes 1,169 s (905 tests, serial `--test-concurrency=1`); Rust suite about 30 s | Slow feedback for contributors | Post-v1: parallelize safe suites |
| PRV-06b | S3 | B (via REQ-PRV-101) | Cloud context sizing | `provider_capabilities.ts` | RT (live): ChatGPT run reported `context_limit=65536 (client_default)` | Large-window cloud models are under-used, and small-window ones overflow | Covered by REQ-PRV-101, extended to provider catalog limits |

### 5.5 Governance, evaluation and contest

| ID | Sev | Class | Workflow | Location | Evidence | User impact | Disposition |
|---|---|---|---|---|---|---|---|
| HIST-02 | S2 | B | Governance | ISSUE12 matrices | HIST | DEMONSTRATED labels unreliable | REQ-OPS-101/102 (SPEC-09) |
| HIST-06 | S3 | RR | Docs | USER_MANUAL, ARCHITECTURE, quickstart | SRC/DOC | Wrong commands; parity claim | REQ-DX-105 |
| HIST-07 | S2 | RR | Supply chain | SBOM, SECURITY.md | SRC | No vulnerability intake | REQ-REL-108/112 |
| HIST-10 | S3 | RR | Tracking | GitHub | RT | Open work invisible | REQ-DX-106 |
| HIST-11 | S4 | B (via OPS-103) | Governance | P2 requirements | DOC | Unrecorded supersessions | REQUIREMENTS §2.2 |
| EVL-001 | S1 | B | v1 quality claim | `eval/` | DOC + SRC | No qualifying evidence | REQ-QUAL-101..105 (SPEC-10) |
| EVL-002 | S2 | B | Scoring | `infra.mjs:31` | SRC | Bias in Nexus's favour | REQ-QUAL-106 |
| EVL-003 | S3 | B (via 106) | Contamination | `run.mjs:57-59` | SRC | Leak goes undetected | REQ-QUAL-106 |
| EVL-004 | S3 | B (via 102) | Matching | `run.mjs` | SRC | Unrecorded conditions | REQ-QUAL-102 |
| EVL-005 | S3 | B (via 104) | Metrics | `score.mjs` | SRC | Missing dimensions | REQ-QUAL-104 |
| EVL-006 | S4 | RR | Docs | `eval/README.md` | SRC | Stale status | REQ-DX-105 |
| EVL-007 | S4 | RR | Hygiene | tracked `*.pyc` | SRC | Noise | REQ-REL-113 |
| CON-001…014 | S1–S4 | contest | Contest service | `experiments/…`, `demo/` | RT/SRC | See SPEC-C1 | Post-contest (DEC-13) |

## 6. Reproducible defects (index)

Reproduction commands and outputs are in the evidence files.

| Defect | Reproduction | Evidence |
|---|---|---|
| AGT-01, 03, 04 | `evidence/repro/agt_repro.test.ts` | A §4 |
| PRV-01, 02, 03, 04, 05, 07, 08, 09 | `evidence/prv/{probe,tls,err}.mts` | B §4 |
| SEC-01..08 | Path jail, classifier probes, SSRF, orphan, memory | C §4 R1–R7; `evidence/probes/` |
| TUI-01, 02, 03, 04, 05, 06 | PTY scripts in `evidence/D_pty/` | D §4 |
| REL-01, 02, 04, 08, 10, 11; DX-01..05 | Installer and doctor runs | E §4 |
| CON-001, 005 | Build output and `sha256sum -c` | G §4 |
| VER-02..07, 10, 11, 16 | `evidence/a2probe/*.ts` | A2 §4 |

The scripts reference the audit scratchpad paths (`/tmp/claude-1000/...`). Re-point them to a fresh snapshot to rerun.

## 7. Readiness assessments, kept separate

| Assessment | Verdict | Basis |
|---|---|---|
| **Implementation self-assessment** (what the code does) | **Blocked.** 31 blocker requirements (REQUIREMENTS §3), plus the partially met carried commitment REQ-AGT-002. Five themes: (1) unsafe defaults and injection-to-action paths; (2) process ownership; (3) shipped-product parity; (4) continuity gaps in resume and work units; (5) standalone context sizing. | Source + reproductions above |
| **Independent acceptance** | **Not performed.** This audit is one reviewer's evidence pass. Independent acceptance exists historically only for the TUI approval surface (round 5, "accepted with defects") and for some Issue #12 work packages, several later contradicted. Compaction/continuity acceptance is pending. | F §2, §0.2 |
| **Client release readiness (v1.0.0)** | **Blocked**, and **unverified** for task quality, standalone operation and real-terminal coverage. Alpha prereleases are appropriately labelled. | §5, SPEC-10 |
| **Contest submission readiness** | **Closed as submitted** (owner, 2026-10-14; revision `ce7e58b9`). Reproducibility is limited to the operator host (CON-002, CON-005). The documented deploy targets the legacy Worker (CON-001). Hardening runs after judging (DEC-13). | G, SPEC-C1 |

## 8. Strengths supported by evidence

- **Test discipline.**
  - 905/905 CLI tests (including PTY TUI end-to-end suites), 266/266 Rust tests and the security gates pass in a clean clone run in CI order. Evidence: `evidence/baseline/baseline2.log`.
  - CI runs the same suite before every release.
- **Outcome-honesty architecture.**
  - A single result derivation with invariants.
  - Fail-before/pass-after independence for discovered verifiers.
  - Truncated replies are never executed.
  - Positive completion evidence is required before tool calls run.
  - Evidence: A §5, B §5.
- **No artificial step ceiling.** Evidence-based stagnation detection. Bounded provider recovery with a well-typed failure taxonomy. Evidence: A §5, B §5.
- **Live TUI approval input safety** held under every adversarial PTY test: typing across the panel, paste, bursts and resize. Evidence: D §5.
- **Sound file-tool path jail.** Credential origin scoping. Trust gating for MCP and plugins. Evidence: C §5, B §5.
- **Release engineering.**
  - The release is gated on main.
  - Same-runner byte-reproducible packages.
  - Installer and package smoke tests.
  - A safe non-root installer with working upgrade and rollback.
  - A well-built `doctor` with narrow, confirmed, idempotent repairs.
  - Evidence: E §5.
- **Self-critical history.** The project's own reviews repeatedly refused to over-claim: Issue #12 left open, the eval pilot self-graded NOT QUALIFIED. Evidence: F §5.

## 9. Limitations of this audit

- No live local inference ran: neither the gateway nor any local server. Owner constraint: the gateway is the only inference path, and it is reserved for M5 qualification.
- Live cloud inference was limited to two provider verifications and one small end-to-end task, all at db1ca55. Every other inference behaviour comes from mocks, fixtures and historical records.
- No Cloudflare deployment.
- No real-terminal emulators: pyte emulation only.
- No macOS or other distributions.
- No cross-runner reproducibility check.
- Unreviewed regions are listed in §4.
- Severity ratings are the reviewers' judgement. Several INF items (AGT-09, PRV-06 server behaviour, VER-08, VER-09 ratios) need the qualification procedures in the evidence files.
- The baseline test runs wrote task records into the operator's real `~/.nexus/tasks` (PER-03). See EVIDENCE §5.
