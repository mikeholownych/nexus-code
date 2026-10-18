# Nexus Code: top-tier qualification assessment (2026-10-12)

> **Historical record.** This document is kept for provenance. Current requirements and status: [docs/v1.0.0/REQUIREMENTS.md](../v1.0.0/REQUIREMENTS.md). Statuses here may have been superseded or contradicted since it was written.

Read-only, evidence-based assessment of the gaps between Nexus Code and a top-tier coding harness. No implementation,
branch, build of the installed runtime, service or configuration was changed. All reproductions ran in isolated
`git archive` extracts with temporary `HOME` directories and a deterministic mock gateway (no live inference).

Appendices (same directory tree): `evidence/qualification_2026-10-12/` — `RULES.md` (shared evidence rules),
`peers.md`, `context.md`, `tui.md`, `tools_persistence.md`, `trust_inference.md`, `own.md`, and `repro/` (scripts).
Finding IDs below (A1, D1, CTX-xx, Tn, Pn, T-xx, I-xx, Fn) refer to those files, which carry the full trigger,
expected/observed behaviour, exact citations, remediation and acceptance test for each.

**Independence.** The coordinating agent implemented the recent diff and TUI-surface work. That area was reviewed by a
separate agent with no implementation context (`tui.md`); its result overturned one self-assessed claim (approval
input, F1). Every other area was assessed by separate agents and spot-checked by the coordinator against source.

---

## 1. Executive verdict

**Nexus is not yet a top-tier coding harness, and its maturity on representative coding objectives is unmeasured.**

What it is qualified for today (with evidence):
- **Supervised, single-operator use on trusted repositories** where the operator reads every change: the agent loop,
  continuation budgets, objective ledger, steering, per-operation diffs, provider recovery (429/503, stream resets
  without duplicate tool execution) and the TUI work as designed in deterministic tests and reproductions.
- **Read-only analysis**: `--read-only` is enforced by an allowlist plus a read-only bubblewrap sandbox; a write
  attempted through a test script changed nothing (`trust_inference.md`, "what is solid").
- **Diagnostics**: `nexus doctor` (18 checks, symlink-safe repairs) and exact, provider-reported token accounting.

What remains unproven:
- Completion rate and artifact correctness on representative tasks (no matched evaluation exists, E1).
- Long-task reliability with local inference after compaction (the context branch has no accepted run, CTX-05).
- Supportability for anyone but the developer on this host (no CI, no versioned install, no build identity).

What blocks top-tier status (all reproduced unless noted):
1. **Execution boundaries can be bypassed in review mode** (P0): `delete_file "."` deleted the workspace including
   `.git` without approval (T-01); subagents run every tool unapproved (T-02); `run_tests.filter` is shell-injected and
   ungated (T-06/T11); opening a cloned repository executes its plugins and MCP servers without a trust prompt, even
   with `--read-only --approve` (T-03).
2. **VERIFIED can be printed for wrong work** (P0): a deliberately wrong implementation ended `COMPLETED/VERIFIED`
   with its requirement `verified`, because the verifier is any green generic suite (A1; also CTX-03, T-09).
3. **Tools and the parser can change the wrong thing** (P1): `edit_file`'s silent fuzzy fallback deleted code the
   model never named (T1) and edits only the first of several matches while reporting all (T2); `patch_file` drops the
   executable bit, replaces symlinks and strips CRLF (T4); tool calls inside `<think>` reasoning are executed — a
   deletion the model explicitly declined was performed (I-01); JSON repair rewrites Python file content (I-02); a
   shell command can swallow queued engine requests (T6).
4. **Secrets leave the boundary or persist in plaintext** (P1): `batch_read` returns `.env` (T-05); a quarantined
   secret was rehydrated into a `search_web` query (T-07); common secret formats reach the model and durable stores
   (T-08, T10).
5. **Approval input in the TUI is not safe against ordinary typing** (P1): typing across the panel's appearance
   approves, and the `a` in "add" granted "approve all later actions" (F1); approvals replace open panels so keys meant
   for them decide (F3) — on the installed build and on main.
6. **No evidence base for qualification**: no task-level evaluation (E1), no CI (D2), no build identity (D1).

Passing suites (Rust 237, CLI 728 at 804c5df), VERIFIED outcomes and self-assessed acceptance do not change this
verdict: the defects above all sit in paths those suites do not exercise.

---

## 2. Scope and identity (verified 2026-10-12)

| Item | Value |
|---|---|
| Repository | `/home/mike/nexus-code`, no git remote; ~90 worktrees from earlier campaigns (`git worktree list`) |
| AGENTS.md | build `make build`, test `make test`, lint `cargo clippy` / `npm run lint`; keep comments; modular typed code |
| main | `3727938` |
| Checked-out branch | `feat/tui-surface` @ `696178a` = main + `83e7405` (TUI surface), `fc64aaf` (evidence), `804c5df` (approval input), `696178a` (report); unmerged |
| Dirty state | untracked `docs/reviews/NEXUS_APPLICATION_MATURITY_REVIEW_2026-10-12.md`, `nexus-session-session_20261011_191846_i3c3.json` (plus this report and its appendices, untracked) |
| fix/context-convergence | `31d6622`; merge base `e9422c9`; 32 commits not on main; lacks main's `35ef104`, `5e8cfd1`, `3727938`; merges cleanly into main and feat/tui-surface (`context.md`) |
| Installed launcher | `/usr/local/bin/nexus` → `/home/mike/nexus-code/harness.sh` → artefacts in that checkout, i.e. **users run the unmerged feat/tui-surface build** |
| Runtime artefacts | `nexus-tui` sha256 `c56080de19078f20…` (built 07:18 UTC, = clean build of 804c5df), `cli/dist/sidecar.js` `55e65b28cb50cba6…`, `cli/dist/index.js` `b63f464d598b18cd…`, `harness-core` `08b7890393d9830d…` (built 2026-10-11 16:17; engine sources unchanged since) |
| Running processes | none (`ps`) |
| Installed vs main, agent/context code | identical except an observer hook (`onContinuation`) on the branch; main's context findings apply to the installed runtime |

---

## 3. Qualification standard

A top-tier harness, for this assessment, must meet all of:

| ID | Criterion | Observable test |
|---|---|---|
| Q1 | Completes representative coding objectives reliably | pass rate on a matched task set (fixed repos, hidden acceptance tests, ≥5 runs/task) at or above a pre-registered threshold |
| Q2 | Produces correct changes and reports outcomes truthfully | artifact correctness by hidden tests; false-VERIFIED rate 0 on a mutation set; tools never change unintended text |
| Q3 | Preserves operator intent and evidence through long tasks | constraints and facts introduced early are honoured/retained after compaction, resume and continuation; no false absence claims |
| Q4 | Enforces trustworthy execution boundaries | every mutating/egress capability gated by mode and context; untrusted workspaces cannot execute code; secrets never leave or persist in plaintext |
| Q5 | Provides a usable, safe terminal experience | independent visual acceptance; approvals cannot be decided by stray input; keyboard-only, narrow/short terminals, escaping |
| Q6 | Recovers from failures | provider faults, context-limit errors, crashes and resume end in a correct state or a truthful bounded failure |
| Q7 | Ships as a supportable product | identified, reproducible, versioned builds; CI; install/upgrade/rollback; docs that match behaviour; vulnerability process |
| Q8 | Treats local inference as first-class | the above hold with local OpenAI-compatible servers (vLLM, llama.cpp, LM Studio, Ollama) including their error/streaming shapes |

---

## 4. Qualification matrix

| Criterion | Status | Evidence for | Gaps (finding IDs) |
|---|---|---|---|
| Q1 completion | **UNPROVEN** | dogfood runs reached COMPLETED on supervised tasks (docs/reviews/*DOGFOOD*, historical); continuation beyond 30 steps works in PTY tests | no matched task evaluation (E1); context branch's only rerun produced no artifact (CTX-05) |
| Q2 correctness & truth | **FAILS** | per-operation diffs accurate; patch_file atomic on mismatch; verifier reuse keyed to workspace state (`tools_persistence.md`) | false VERIFIED (A1, CTX-03, T-09); wrong-text edits (T1, T2); patch damage (T4); non-atomic/stale writes (T3); JSON repair corrupts content (I-02); empty reply = completed (I-03) |
| Q3 intent & evidence | **PARTIAL** | pinned objective ledger never compacted; operator-only descoping (verified); context branch keeps findings in full with ids (31d6622) | steering beyond last 10/600 chars dropped after compaction (CTX-02, both branches); crash loses mid-turn findings and ids collide (CTX-01, branch); harness prompts treated as operator text (CTX-06); archive not retrievable by the model; false absence claim in d88a897 review (`context.md`) |
| Q4 boundaries | **FAILS** | read-only mode sandboxed; Rust path canonicalisation; TLS never disabled; failover never to a less-trusted endpoint | review-mode bypasses (T-01/T5, T-02/T14, T-06/T11); workspace code execution (T-03); secrets (T-05, T-07, T-08, T10); listing outside workspace (T15); dry-run executes (T13); TOCTOU (T-11); network tools ungated (T-12) |
| Q5 terminal | **PARTIAL** | independent visual verdict: *accepted with defects*; no control-sequence escape path found; ~1.1–1.6 ms frames at 100k entries; idle redraw 0 bytes (`tui.md`) | approval input not accepted (F1–F3); PTY scenario intermittently loses a submission (F5); open items O1–O3; visual defects list (`tui.md`) |
| Q6 recovery | **PARTIAL** | 429/503 recovery with Retry-After; stream reset → one retry, one execution; timeouts kill process groups; corrupt/future state files fail closed | context-length 400 ends the turn, llama.cpp shape unrecognised (I-05); silent persistence failures (P1); timeout not bounding background children (T7); multibyte panic loses results (T8); crash findings loss (CTX-01) |
| Q7 product | **FAILS** | doctor with safe repairs; security gates (npm/cargo audit, secret scan); SBOM script | no build identity (D1); no CI (D2); dev checkout = installation (D3); no LICENSE/SECURITY/CHANGELOG, partial reproducibility (D4); Linux-only (D6); tracked transcript (D5) |
| Q8 local first-class | **PARTIAL** | streaming decode robust (split UTF-8, truncated streams detected); OpenAI-compatible endpoints; provider recovery | `<think>` tool extraction (I-01); prose JSON executed (I-04); `data:` without space ignored (I-06); usage from plain endpoints ignored (I-07); llama.cpp context error (I-05); fixed ~5k-token overhead per request (estimate, P-1) |

---

## 5. Peer reference (documented capabilities, not measured parity)

From `peers.md` (primary sources, versions as of 2026-10-12): Codex CLI 0.162.1, Claude Code 2.1.296, OpenCode 1.19.0,
Goose 1.54.0, Aider 0.86.2. Behaviours peers document that Nexus lacks or does differently, phrased as tests:

- **OS-level sandboxing of commands** (Codex, Claude Code: Seatbelt/bubblewrap; network allowlists). Nexus sandboxes
  only in read-only mode; review mode is an approval list with bypasses (Q4).
- **Workspace trust before executing project configuration** (Claude Code and Codex document trust prompts for
  project-scoped settings/hooks/MCP). Nexus auto-loads workspace plugins and MCP servers (T-03).
- **Local backends with context-window sizing** (Aider sizes Ollama `num_ctx` per request; Goose warns about silent
  truncation). Nexus has capacity admission but no reactive handling of provider context errors (I-05).
- **Interrupted-tool awareness on resume** (Claude Code marks cut-off tool calls for the model to check). Nexus records
  in-flight operations in a single slot (P4) and the context branch loses mid-turn findings on crash (CTX-01).
- **Checkpoints/rewind with documented limits** (Claude Code rewind excludes shell-made changes). Nexus has checkpoints
  and `/undo`; its limits for shell changes are documented for diffs only.
- **Release discipline**: Codex and Claude Code ship signed/packaged releases several times a week with changelogs;
  Nexus has none of these (Q7).
- Claude Code documents no support for non-Claude models; it cannot be a matched local-inference comparator. Codex
  (`--oss`, built-in Ollama/LM Studio providers; Responses wire format), OpenCode, Goose and Aider can be.
- Benchmark figures found are vendor claims about models under other harnesses; none establishes harness parity.

---

## 6. Findings by area (consolidated)

Duplicates across reviewers are merged; the canonical ID is first. Priority: P0 blocks top-tier/unsafe, P1
reliability blocker, P2 important, P3 polish. "Affects" applies to main and the installed feat/tui-surface build
unless noted; fix/context-convergence shares the tool/trust/inference code paths (diff-verified by the reviewers).

### 6.1 Objective completion and correctness (Q1, Q2)
| ID | P | Label | Summary | Key citation (main 3727938) |
|---|---|---|---|---|
| A1 (=CTX-03, T-09) | P0 | REPRODUCED | Wrong deliverable ends VERIFIED; requirement `verified` from any passing run, even a filtered run executing no tests | `cli/src/tester.ts:77-104`; `cli/src/core/objective.ts:335-340`; repro `repro/repro_false_verified.test.ts` |
| I-03 | P2 | REPRODUCED | Empty assistant reply reported as a completed turn | `trust_inference.md` |
| E1 | P1 | EVIDENCE GAP | No matched task-level evaluation; only harness tests, dogfood runs and one n=4 experiment | `experiments/context-validation-2026-10-04/RESULTS.md:52-53` |

### 6.2 Context and long-task reliability (Q3)
| ID | P | Label | Summary | Affects |
|---|---|---|---|---|
| CTX-02 | P1 | REPRODUCED (unit) | Pinned objective keeps only the last 10 steering records, 600 chars each; originals compacted away; no retrieval | main, installed, branch |
| CTX-01 | P1 | REPRODUCED | Findings recorded mid-turn not persisted until turn end; after crash/resume `read_findings` returns none and new ids collide | fix/context-convergence |
| CTX-05 | P1 | REPORTED BUT UNVERIFIED (cause) | Only rerun of 31d6622 failed at step 119 with no artifact: a long write exceeded the gateway stream deadline and was replayed identically | branch |
| CTX-06 | P2 | SOURCE | Harness-generated user messages treated as operator requests by compaction/findings | all |
| CTX-07 | P2 | SOURCE | 27 of 30 findings shown as names only; recall depends on the model calling `read_findings` | branch |
| CTX-04 | P2 | REPRODUCED | Cut-off output notice misses `grep -m`, `sed -n`, `awk NR`; main has no notice | branch / main |
| — | P2 | SOURCE | Archived (compacted) history is an audit record only; no tool reads it back | all |

Status of the known compaction investigation: d88a897 reached VERIFIED while losing the "Rust-core launch" finding
(cut to fit a 24K budget; a later `| head -20` re-check missed `cli/src/tools.ts`) and the review falsely claimed no
TypeScript spawns the Rust core. 31d6622 retains the fact (F16/F20/F24/F27 in the r1 session) and marks head/tail
truncation, but has no accepted run; acceptance remains failed/open (`context.md`, exit criteria listed there).

### 6.3 Tool and execution quality (Q2, Q6)
| ID | P | Label | Summary |
|---|---|---|---|
| T1 | P1 | REPRODUCED | `edit_file` 0.85 fuzzy fallback edits non-matching text silently (deleted `audit_log(a)` for a snippet naming `check_permissions(a)`) |
| T2 | P1 | REPRODUCED | Multiple matches: first replaced, `replacements: 2` reported |
| T3 | P1 | REPRODUCED/SOURCE | Non-atomic writes, no stale-content guard, CRLF→LF rewrite, `write_file` reports `overwritten` for new files |
| T4 | P1 | REPRODUCED | `patch_file` clobbers `<stem>.tmp_patch`, drops +x, replaces symlinks, strips CRLF, ignores hunk line numbers |
| T6 | P1 | REPRODUCED | `run_command` child inherits the RPC daemon's stdin; `cat` consumed a queued `write_file` request (never executed, never answered) |
| T7 | P2 | REPRODUCED | Timeout stops bounding once the shell exits; background children held a 3 s call for 8 s |
| T8 | P2 | REPRODUCED | >32 KB output cut mid-UTF-8 panics the engine; side effects ran, result lost |
| T13 | P2 | REPRODUCED | Dry-run executes "read-only-looking" commands (`echo x > file`); prefix-only allow regex |
| T15 | P2 | REPRODUCED | `list_dir`, `file_tree`, `cst_symbols` list outside the workspace (`/etc/ssh`) |
| T16 | P2 | REPRODUCED | Search capped at 50 without truncation flag; 200 KB single lines returned |
| T9, T12 | P3 | SOURCE | Unbounded output buffering before truncation; parallel path skips cancellation; engine cannot cancel a running command |
| T-04 | P2 | REPRODUCED | MCP/plugin tools advertised but always fail (FAIL-001) |

### 6.4 Operator control and trust (Q4, Q5)
| ID | P | Label | Summary | Key citation |
|---|---|---|---|---|
| T-01 (=T5) | P0 | REPRODUCED | Review mode gates only edit/write/patch/run_command; `delete_file "."` removed the repo incl. `.git` | `cli/src/agent.ts:2502-2508` |
| T-02 (=T14) | P0 | REPRODUCED | Subagent tool calls dispatched without a confirm handler | `cli/src/agent.ts:2466-2470`, `:3648` |
| T-06 (=T11) | P0 | REPRODUCED | `run_tests.filter` interpolated into shell; ungated; scheduled as parallel read-only; trailing `echo` can turn a failing suite into a pass | `cli/src/tester.ts:30-55` |
| T-03 | P0 | REPRODUCED | Workspace `plugins/`, `.nexus/plugins/` imported and workspace `.mcp.json` servers started with the full environment, no trust prompt, under `--read-only --approve` | `cli/src/plugins.ts:46-52`; `cli/src/mcp.ts:479-484` |
| F1 | P1 | REPRODUCED (unit) | Ordinary typing across the approval panel's appearance decides (incl. "approve all"); default focus Approve | `core/src/bin/nexus_tui/live_state.rs:1156-1172`, `:812-822` (804c5df) |
| F3 | P2 | REPRODUCED (unit) | Approval replaces any open panel; the key meant for that panel decides; connect-panel input lost | `tui.md` |
| F2 | P2 | REPRODUCED (unit) | Below 40×10 the approval is marked shown while invisible; `y` approves | `live_state.rs:1094-1096` |
| T-05 | P1 | REPRODUCED | `batch_read` returns `.env` while `read_file` blocks it | `trust_inference.md` |
| T-07 | P1 | REPRODUCED | Quarantined secret placeholder rehydrated into `search_web` arguments | `trust_inference.md` |
| T-08, T10 | P1/P2 | REPRODUCED | URL passwords, JWTs, unquoted `PASSWORD=` and `LOCAL_LLM_API_KEY` reach the model; plaintext in sessions, diffs, audit, task state, flight log; commands inherit the full environment | `trust_inference.md`, `tools_persistence.md` |
| T-12 | P2 | SOURCE | Auto mode default; `fetch_web`/`search_web`/`browser_*` never gated | — |
| T-11 | P3 | SOURCE | Lexical confinement in TS, check-then-act in Rust | — |

What held (independently confirmed): 804c5df discards input queued before the panel, ignores bursts and bracketed
paste, ctrl+c cancels, sidecar crash closes the approval (F4); operator-only descoping.

### 6.5 Inference compatibility and recovery (Q6, Q8)
| ID | P | Label | Summary |
|---|---|---|---|
| I-01 | P1 | REPRODUCED | Tool calls "rescued" from `<think>` reasoning and executed (`cli/src/parser.ts:314`); a declined deletion was performed |
| I-02 | P1 | REPRODUCED | Lenient JSON repair rewrites argument content (`None`→`null`, `True`→`true`, trailing commas) |
| I-04 | P2 | REPRODUCED | Prose containing JSON with a `name` field executed as a tool call (`my-app`) |
| I-05 | P2 | REPRODUCED | Provider context-length 400 ends the turn; llama.cpp error shape unrecognised; no reactive compaction |
| I-06 | P2 | REPRODUCED | SSE `data:` without the optional space ignored; turn fails |
| I-07 | P2 | SOURCE | Usage reported by plain local endpoints ignored; receipts only for connected providers |
| I-08 | P3 | REPRODUCED | Malformed tool-call JSON yields a misleading "missing parameter" error |

### 6.6 Terminal experience (Q5) — independent result
Visual: **accepted with defects** (`tui.md`): hierarchy, Markdown, diffs, outcomes, status and recovery screens read
well; defects include ~25 empty rows in a one-line approval, the change card drawn before its "approved" line, wrapped
code losing its background, command previews hiding the informative last line, help clipped without a scroll
indicator, the crash screen's contradictory "(no exit code)" after a named signal and a misleading stale diagnostic,
review-mode indicator dropped at 40 columns, and the diff screenshots captured at 35ef104 (pre-surface) never
re-captured. Approval input: **not accepted** (F1–F3). Open items O1 (live budget), O2 (session id in status), O3
(earlier tools/outcomes in resumed history) confirmed open. PTY suites fail when run in parallel and the surface
scenario lost a `/resume` submission in 2 of 8 runs under load (F5; cause not established).

### 6.7 Persistence and auditability (Q6, Q2)
| ID | P | Label | Summary |
|---|---|---|---|
| P1 | P1 | REPRODUCED | Durable writes wrapped in empty catches: with a read-only state dir the turn modified the workspace while saved state stayed at 0 messages, no warning |
| P2 | P2 | REPRODUCED | Each `update_plan` re-records all completed phases as new milestones |
| P3 | P2 | REPRODUCED/SOURCE | State files mode 664, no fsync, no writer lock |
| P4–P6 | P3 | SOURCE | Single-slot in-flight operation; substring session lookup with catch-all "not found"; `findings` field added on the branch without a schema bump |
What held: atomic state saves, fail-closed load of corrupt/future files, migration tests, stable tool-call ids,
redaction that keeps SHAs/UUIDs, verifier-reuse keyed to the workspace fingerprint.

### 6.8 Product delivery and support (Q7)
D1 build identity not observable (`nexus --version` → `1.2.1` on the branch build; doctor has no commit), P1,
REPRODUCED · D2 no CI and no remote, P1 · D3 installation is the dev checkout (no versioned install/upgrade/rollback),
P1 · D4 no LICENSE (MIT declared), SECURITY.md or CHANGELOG; reproducibility check covers only TS; no signing/provenance,
P2 · D5 tracked session transcript and hard-coded `/home/mike` paths, P3 · D6 Linux-only (declared), P2 scope. Prior
untracked review `NEXUS_APPLICATION_MATURITY_REVIEW_2026-10-12.md` (2026-10-11, no tests run) raised the same
egress/supportability themes; this assessment adds reproductions.

### 6.9 Performance and resource governance (Q8)
P-1 (P2, EVIDENCE GAP): first request of the installed build carries 38 tool schemas (17,784 chars incl. 5 browser
tools) + 2,342-char system prompt ≈ 5.1k tokens (chars/4 estimate, `repro/repro_overhead.test.ts`). Measured,
provider-reported: the 2026-10-11 dogfood session sent 2,506,632 prompt tokens over 87 requests (≈28.8k/request),
reconciling exactly with session tokenStats. Not measured: latency per phase, overhead share per request, repeated-read
frequency, memory/CPU of long sessions (TUI frame cost measured: 1.1–1.6 ms). Claims of efficiency are unsupported.

### 6.10 Evaluation quality (Q1)
Existing tests are numerous and deterministic (Rust 237, CLI 728 at 804c5df, incl. 4 PTY scenarios) but test harness
behaviour against scripted models. They did not catch A1, T1–T4, T6, T-01–T-06, I-01/I-02, F1 because none asserts
artifact correctness under a wrong-but-green suite, exact-match edit semantics, or the full capability × mode matrix.
Verifier design (A1) means the strongest outcome label is not evidence of correctness. PTY scenarios are timing-
sensitive under parallel execution (F5).

---

## 7. Prioritized remediation backlog

### 7.1 Acceptance blockers (must close before any top-tier claim)
| # | Work item | Closes | Exit test |
|---|---|---|---|
| B1 | **One execution authority**: every capability declares mutating/egress/exec effects (the `CanonicalCapability.mutating` metadata exists); a single gate applies mode policy (auto/review/read-only/dry-run) to all dispatch paths — top-level, subagent, parallel, MCP, plugin, slash/`!` — deny-by-default for undeclared; `run_tests` filter passed as argv, never via shell; dry-run never executes | T-01, T-02, T-06, T13, T-12, T5, T11, T14 | capability × mode × context matrix test enumerating all registered tools (fails when a new tool lacks a policy row); adversarial suite: `delete_file "."`, subagent write, `run_tests` filter `"; touch X; "`, dry-run `echo x > f` — all prompted or refused, workspace unchanged |
| B2 | **Workspace trust**: never import workspace plugins or start workspace MCP servers until the operator trusts that workspace (per-path trust record); `--read-only` disables both; MCP children get an environment allowlist | T-03 | clone a repo containing `plugins/x.mjs` and `.mcp.json` that touch a sentinel → no sentinel without explicit trust, in every mode |
| B3 | **Truthful verification**: separate REGRESSION_FREE (generic suite) from VERIFIED (deliverable-bound checks: operator-accepted acceptance commands per requirement, fail-before/pass-after against the checkpoint, changed-file coverage); requirement `verified` only from its own check | A1, CTX-03, T-09 | mutation set of ≥10 wrong deliverables with green unrelated suites → 0 VERIFIED; correct deliverables with accepted checks → VERIFIED |
| B4 | **Exact edits**: `edit_file` requires a unique exact match (ambiguous → error naming occurrences; fuzzy only on explicit opt-in and disclosed in the result); atomic temp+rename with fsync; stale-content guard (hash from the last read); preserve mode/symlink/CRLF/BOM; `patch_file` honours hunk positions | T1–T4 | property tests over random files/edits incl. CRLF, +x, symlinks, duplicates; concurrent-modification test returns a stale error and leaves the file intact |
| B5 | **Parser safety**: never execute calls found inside reasoning or prose when the provider supports native tool calls; text-embedded calls only from configured local formats and outside reasoning; arguments must parse as JSON (repair limited to transport framing, never content) | I-01, I-02, I-04, I-08 | parser corpus (think, prose JSON, Python literals, malformed) → no execution or byte-exact content |
| B6 | **Secrets**: protected paths enforced for every read tool; no placeholder rehydration toward public destinations; redaction corpus (URL creds, JWT, PASSWORD=, provider keys by value); durable stores redact before write; commands get an environment allowlist | T-05, T-07, T-08, T10 | seeded-secret corpus never appears in model requests (mock gateway capture) or any file under `~/.nexus`/workspace `.nexus` |
| B7 | **Approval input**: a decision requires deliberate input — no decision keys within N ms of composer typing, default focus none (or Deny), Enter only after explicit focus; approvals queue behind open panels with a visible notice; never mark shown when not rendered | F1–F3 | PTY: typing "please add tests" continuously across the panel → no decision; approval during help/diff review/connect → queued, panel state preserved; 39×9 terminal → no decision possible |
| B8 | **Evidence base**: build identity (D1), CI on every branch with required checks (D2), and the evaluation harness of §9 at least in its smoke tier | D1, D2, E1 | `--version`/doctor show commit+dirty; CI blocks a failing branch; eval smoke tier reproducible from a clean clone |

### 7.2 Reliability work
R1 RPC isolation: commands get `/dev/null` stdin and their own process group; per-call cancellation in the engine
(T6, T12) · R2 surface persistence failures as a blocked/notice state and stop mutating when state cannot be saved (P1)
· R3 shell runtime: total-time bound incl. background children, UTF-8-safe truncation, streaming bounded buffers
(T7–T9) · R4 confinement: workspace-bound listing tools; fd-based (openat) checks in Rust (T15, T-11) · R5 inference:
reactive compaction-and-retry on context errors incl. llama.cpp/vLLM shapes; SSE spec conformance; empty reply →
retry/notice, never "completed"; record provider usage from any endpoint (I-03, I-05–I-07) · R6 context: steering
preserved in full with a retrieval tool; harness prompts tagged as harness, not operator; archive retrievable;
findings persisted on record (CTX-01, CTX-02, CTX-06, archive gap) · R7 context branch acceptance: rebase on main,
fix CTX-01/CTX-05 (chunked long writes / no identical replay), rerun with fact-check (CTX exit criteria in
`context.md`) · R8 persistence integrity: milestone dedupe, fsync + 0600 + writer lock, multi-slot in-flight records,
exact session ids, schema version bump discipline (P2–P6) · R9 MCP/plugin tools either execute through the authority
or are not advertised (T-04) · R10 PTY test determinism: serialise PTY suites, wait on sidecar acknowledgements rather
than sleeps (F5) · R11 product: versioned install with rollback (D3), LICENSE/SECURITY.md/CHANGELOG, Rust
reproducibility and release SBOM/checksums (D4).

### 7.3 Polish
TUI visual defects and open items O1–O3 (`tui.md`); search truncation disclosure (T16); misleading statuses
(`write_file` "overwritten", read-only `run_tests` shown as test failure: T-10); consistent visible stand-ins for
control characters on all surfaces (F7); crash-screen text; per-request token composition in receipts and tool-set
admission by need (P-1); repository hygiene (D5); explicit platform statement (D6).

---

## 8. Dependency-ordered implementation sequence

| Stage | Contents | Depends on | Exit criteria (measurable) |
|---|---|---|---|
| 0 | D1 build identity; D2 CI pipeline (self-hosted GitLab) running `make build`, `make test` (PTY suites serialised, R10), security gates | — | every artefact reports commit+dirty; pipeline green on main; a seeded failing test blocks a branch |
| 1 | B1 execution authority + B2 workspace trust (+ R4 listing confinement, T13 dry-run) | 0 | capability × mode × context matrix complete and enforced; adversarial suite blocked; no regression in existing suites |
| 2 | B4 exact edits + R1 RPC isolation + R3 shell runtime | 1 (tools dispatch through the authority) | property/concurrency tests pass; T1–T4, T6–T8 repros fail-closed |
| 3 | B5 parser safety + R5 inference recovery | 0 | parser corpus and provider-shape tests (OpenAI, vLLM, llama.cpp, LM Studio, Ollama captures) pass; I-01–I-08 repros fixed |
| 4 | B6 secrets | 1 | seeded-secret corpus absent from all captures and stores |
| 5 | B3 truthful verification (needs checkpoints and the objective ledger) | 1, 2 | mutation set: 0 false VERIFIED; outcome labels documented; TUI/export/receipt show REGRESSION_FREE vs VERIFIED consistently |
| 6 | B7 approval input + R2 persistence failure handling + R8 persistence integrity | 1 | approval PTY tests incl. continuous typing; persistence fault injection ends BLOCKED with no further mutation |
| 7 | R6 context fixes on main; R7 rebase and accept fix/context-convergence | 3, 5 | CTX exit criteria met; long-task evaluation tier (§9 T3) with fact checks: 0 false absence claims, steering honoured after compaction |
| 8 | §9 evaluation, full tiers, local + cloud; peer comparison where matched | 0–7 | pre-registered thresholds met (below) with ≥5 runs per task-config |
| 9 | R9, R11 product delivery, polish (§7.3), O1–O3 | 0 | install/upgrade/rollback test; independent visual acceptance re-run on the release build |

Top-tier qualification may be claimed only after Stage 8 meets its thresholds and an independent reviewer (not the
implementer) re-runs the acceptance suites on an identified release build.

---

## 9. Compact evaluation plan

**Fixed conditions per configuration** (recorded in a run manifest): harness build identity; task repository and
commit; objective text; model id and quantisation; endpoint software and version; sampling (temperature 0.2 or the
model's recommended value, top-p, max output tokens); context length; budgets (steps 300, wall 120 min, verifier
timeout 300 s); mode (auto, and review with a scripted approver); network policy; hardware.

**Task set (pilot 12, target 24)**, external repositories at pinned commits (not Nexus itself), each with hidden
acceptance tests and the repository's own suite as a regression check:
| Tier | Tasks | Purpose |
|---|---|---|
| T1 Smoke (CI, scripted model) | the adversarial and mutation suites from B1–B7 | boundary and truthfulness regressions, every commit |
| T2 Standard (live model) | 4 bug fixes from failing tests, 4 small features, 2 multi-file refactors, 2 debugging-from-logs | completion and correctness |
| T3 Long-task | 4 tasks needing >60 steps with an early operator constraint and mid-task steering; 2 read-only analyses scored against a fact sheet (absence claims checked) | context retention, intent, false-absence rate |
| T4 Fault-injected | T2 tasks under: provider 503 bursts, stream cut mid-tool-call, context-length error (OpenAI and llama.cpp shapes), sidecar SIGKILL + resume, concurrent external file edit, slow command beyond timeout | recovery and bounded failure |

**Scores (reported separately, never combined into one number):** completion claimed; artifact correct (hidden
tests); regressions introduced; false VERIFIED (claimed VERIFIED while hidden tests fail); recovery success under
faults; bounded failure (stopped within budget with a truthful status); operator interventions (count, by type);
tokens (provider-reported), wall time, steps.

**Pre-registered thresholds for qualification (proposal):** false VERIFIED = 0 across all runs; hidden-test pass rate
on T2 ≥ the best matched peer on the same local model minus a margin fixed before the run (or an absolute target if no
peer can be matched); T3 false-absence claims = 0 and steering constraints honoured in ≥95 % of runs; T4 truthful
bounded outcome in 100 % of fault runs; ≥5 runs per task-config with per-task results and 95 % intervals.

**Configurations:** local primary — the appliance's served model (current default `engineering/b0`) via its
OpenAI-compatible gateway, plus one llama.cpp-server and one Ollama configuration to exercise their error/streaming
shapes; cloud — one supported provider configuration, evaluated and reported separately (it cannot substitute for local
qualification). Matched peers on the same local endpoint: OpenCode, Goose, Aider, and Codex CLI where its Responses
wire format can be served; Claude Code only in a cloud comparison. Record every deviation (unsupported features,
different tool sets, retries).

---

## 10. Evidence manifest

| Item | Value |
|---|---|
| Commits assessed | main `3727938`; feat/tui-surface `696178a` (installed; incl. `83e7405`, `804c5df`); fix/context-convergence `31d6622` |
| Runtime identity | §2 table (sha256 of nexus-tui, sidecar.js, index.js, harness-core) |
| Extracts | `git archive` of 696178a (coordinator), 3727938 (tools/trust reviewers), 31d6622 (context), 83e7405 and 804c5df (TUI) under the session scratchpad; no worktrees created |
| Checks run (coordinator) | identity commands; `ps`; extract build (npm, cargo) 0/0; false-VERIFIED repro → VERIFIED for a wrong deliverable; overhead probe → 38 tools, 20,383 chars; `nexus --version` → 1.2.1; `nexus doctor --json` → 18 pass, no commit identity; source spot-checks of T-01, T-02, T-03, T-06, I-01 citations (all confirmed) |
| Checks run (reviewers) | see each appendix's "Checks actually run"; highlights: context branch `make build` OK, Rust 192/192, CLI 759/763 (3 extract-only, 1 flaky); TUI clean builds byte-match evidence (823fae68…) and installed (c56080de…), Rust TUI 220/220, PTY suites pass serially, fail in parallel, surface scenario 2/8 intermittent; tool and trust repros on main, key ones re-run on 696178a |
| Peer sources | `peers.md` citation list (official docs/repos/releases, accessed 2026-10-12) |
| Not run | live inference of any kind; peer harnesses; long benchmarks; crash/concurrent-writer tests for persistence; macOS/Windows |

## 11. Limitations

- All model behaviour is scripted; reproductions show what the harness accepts and executes, not how often a real model
  triggers it. Frequencies require the §9 evaluation.
- Peer facts are documented capabilities from summarising fetches of primary sources; no peer was run.
- Some findings are source-supported only (labelled); the llama.cpp context-error shape was not captured live.
- The TUI unit-level reproductions of F1–F3 did not use real keystroke timing in a terminal.
- One reviewer probe printed a real API key from its own shell environment into its local transcript; it does not
  appear in any deliverable or appendix (scanned by value). Rotating that key is advisable.
- The coordinator implemented the TUI work under review; mitigated by an independent reviewer, not eliminated.
