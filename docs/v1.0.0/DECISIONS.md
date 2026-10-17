# Decisions: Nexus Code v1.0.0

This file records only consequential decisions that were unresolved when the audit finished. On 2026-10-14 the owner authorized applying the recommended option for every outstanding decision. ("You are authorized to apply your recommendations for the best decisions for the project on any outstanding decisions in the plans/specs.") Each entry is therefore marked **RESOLVED (delegated)**. The options, tradeoffs and affected requirements are kept so the owner can reverse any decision later. A reversal would change the linked specs, plans and gates.

Some decisions cannot be carried out by an implementer alone. They need an external action, and those actions are listed in the last section. The audit did not perform any of them.

| ID | Decision | Resolution | Blocks execution? |
|---|---|---|---|
| [DEC-01](#dec-01-default-execution-posture) | Default execution posture | Review by default; auto only in trusted workspaces | No (resolved) |
| [DEC-02](#dec-02-role-of-the-repl) | Role of the REPL | Supported secondary surface; TUI primary; top-level flags implemented | No |
| [DEC-03](#dec-03-team-and-operation-scope-in-v1) | `/team` and `nexus operation` in v1 | Shipped as **experimental**; data-loss fix still a blocker | No |
| [DEC-04](#dec-04-issue-12-open-normative-blockers) | Issue #12 open blockers | EXT-004 implemented; CTX-001 partially implemented; CTX-002 descoped post-v1 | No |
| [DEC-05](#dec-05-v1-evaluation-protocol-and-thresholds) | Evaluation protocol and thresholds | 40 held-out T2 tasks, 5 runs, 2 peers, thresholds below | Needs an external author (see actions) |
| [DEC-06](#dec-06-supported-providers-for-v1) | Supported providers | Local OpenAI-compatible + OpenRouter supported; others experimental until live-verified | No |
| [DEC-07](#dec-07-experimental-surfaces-nexus-eval-tdd-team-roles) | `nexus eval`, `/tdd`, team roles | eval and tdd experimental; eval's workspace mutation fixed; role tool sets enforced | No |
| [DEC-08](#dec-08-version-identity-and-stale-v1x-tags) | Version identity, stale v1.x tags | `package.json` is the source of truth; local v1.x tags deleted (owner action) | No |
| [DEC-09](#dec-09-release-provenance-mechanism) | Release provenance | GitHub artifact attestations | No |
| [DEC-10](#dec-10-tracking-of-clidist) | Tracking of `cli/dist` | Untrack | No |
| [DEC-11](#dec-11-retention-defaults) | Retention defaults | 90 days / 2 GB; audit log 10 MB × 5; first GC needs acknowledgement | No |
| [DEC-12](#dec-12-platform-scope) | Platform scope | Linux x86-64 glibc only for v1.0.0 | No |
| [DEC-13](#dec-13-contest-track-disposition) | Contest track | Submission already completed; it is frozen until judging ends, then PLAN-C1 runs as post-contest hardening | No |
| [DEC-14](#dec-14-free-text-on-the-command-line) | Free text on the command line | Explicit `nexus run` required | No |
| [DEC-15](#dec-15-knowledge-auto-extraction) | Knowledge auto-extraction | Off by default, opt-in | No |
| [DEC-16](#dec-16-standalone-qualification-under-a-gateway-only-environment) | Standalone qualification with no direct worker access | Stripping proxy over the gateway for live runs, plus server-kind conformance fixtures | No |

---

## DEC-01: Default execution posture

**Question.** What protects the user by default from model-initiated command execution and network egress? See SEC-01, VER-01, HIST-05 and TUI-07.

| Option | Description | Tradeoffs |
|---|---|---|
| A | Review by default: write, exec and egress ask | Safest. More prompts. Changes existing users' habits. |
| B | Auto with an enforced sandbox by default | Few prompts. bwrap is unavailable on some hosts (WSL, rootless containers), and the Docker fallback is unpinned and networked. Egress is unsolved. |
| **C (chosen)** | Posture follows workspace trust. **Untrusted workspace → review** for `write_workspace`, `exec`, `egress` and `context_inject`. **Trusted workspace → auto** for `write_workspace` and `exec`; `egress` asks once per origin per session. `--yes` or `NEXUS_APPROVAL_MODE=auto` force auto. `--sandbox` stays available. | Safe for cloned or unknown repos. Low friction on the operator's own repos after one `nexus trust .`. Reuses the existing trust store, so there is no new concept. |
| D | Keep auto | Contradicts REQ-SEC-101; rejected. |

**Rationale.** The threat that matters is content from an untrusted repository or the web. Trust is the existing per-workspace boundary that MCP and plugins already honour. Option C closes SEC-01 and VER-01 on exactly the inputs that cause them, and keeps the daily-driver experience on trusted repos.

**Further rules:**
- Headless `nexus run` with no TTY: decision-required calls are DENIED with a typed reason unless `--yes` is given.
- The eval and demo runners pass `--yes` explicitly.

**Affected requirements:** REQ-SEC-101, 102 and 119; REQ-TUI-102; SPEC-01; PLAN-01; ACC-SAFE-01.

## DEC-02: Role of the REPL

**Options.** (A) Remove the REPL. **(B, chosen)** The REPL is a supported secondary surface: used for non-TTY input, scripting and fallback, with its approvals fixed to the TUI's standard. (C) The REPL stays the default.

**Rationale.** The REPL is the only interactive surface when stdin or stdout is not a terminal, and when the Rust TUI is missing. Removing it loses a fallback. Keeping it as the default contradicts UI-004.

**Also decided.** The top-level flags `--approve`, `-r/--resume [id]`, `--repl` and `--live` are **implemented** rather than removed from the docs, because USER_MANUAL already teaches them.

**Affected requirements:** REQ-REL-101, REQ-REL-102, REQ-SEC-103.

## DEC-03: Team and operation scope in v1

**Options.** (A) Fully supported. **(B, chosen)** Shipped and labelled **experimental** in help and docs. Excluded from the qualification task-quality claims. But the following are still fixed for v1:
- **AGT-02a** (compaction originals lost on resume): BLOCKER, because it silently loses durable state behind a documented guarantee.
- **AGT-02b–d and AGT-11**: RELEASE-REQUIRED.

(C) Remove the commands.

**Rationale.** Evidence for multi-unit convergence is thin. EXECUTION_CONVERGENCE lists I3, I4 and a stale-lock race as open, and post-remediation dogfooding was INTEGRATION_BLOCKED. Removing the commands throws away working code. Silent data loss is not acceptable even in experimental features.

**Affected requirements:** REQ-AGT-102, 103, 107; SPEC-04.

## DEC-04: Issue #12 open normative blockers

| Item | Resolution | Rationale |
|---|---|---|
| EXT-004 (middleware before/after audit) | **Implement** (SPEC-03 §3.5) | Small change. Plugins can rewrite tool I/O silently today. |
| CTX-001 (per-item provenance for injected context) | **Partially implement**: skills, knowledge and other injected context carry source path and trust state (SPEC-03 §3.4). The full provenance graph is post-v1. | The risky injected sources are covered. A full implementation is a large redesign with low marginal safety benefit once trust gating exists. |
| CTX-002 (freshness and version applicability of knowledge) | **Descoped to post-v1**, with this written rationale: auto-extraction is off by default (DEC-15) and knowledge is trust-gated, so stale knowledge can only come from the operator's own explicit saves. | Accepted risk, recorded. |
| UI-006/007, DEDUP-003, "no Git remote", SUBP-004/005 deferrals | **Recorded as superseded** in REQUIREMENTS §2 (Ratatui adopted; on-demand tool groups; public GitHub). SUBP-004 and SUBP-005 are replaced by SPEC-02. | Governance hygiene (HIST-11). |

## DEC-05: v1 evaluation protocol and thresholds

**Chosen protocol (SPEC-10):**
- 40 held-out T2 tasks, at least 20 from external repositories at pinned commits, across JS/TS, Python, Rust and Go, with at least 6 per class (bugfix, feature, refactor, debug).
- 5 runs per task and configuration.
- Peers: Goose and OpenCode, on the same model and budgets.
- 8 T4 fault classes × 5 runs.
- 8 T3 long tasks × 5 runs.

**Thresholds, all must hold:**

| Metric | Threshold |
|---|---|
| False VERIFIED | **0** (hard) |
| Held-out T2 pooled hidden-test correctness | **≥ 60% absolute** and **≥ (best matched peer − 10 points)** |
| Correctness per task class | ≥ 40% |
| Crash rate | ≤ 2% |
| Regression rate | ≤ 5% |
| T4 outcome truthfulness | 100% |
| T4 hangs beyond budget + 5 min | 0 |
| T3 false-absence | 0 |
| T3 steering honoured | ≥ 95% |
| `run`-mode operator interventions | 0 |

**Task authorship.** The owner authorized agent authorship for the T2 tasks on 2026-10-14. A separately-run agent session authors the held-out tasks. It is given only the task schema and the external repositories, with no access to Nexus source, the development set, or tuning history. Its sha256 manifest is committed before the RC freeze. The qualification report must state that the authors were agents, not humans.

**Inference environment.** All runs go through the homelab-ai gateway, which is the only inference path (owner, 2026-10-14). There is no direct worker access and no extra GPU. Every run, Nexus and peers alike, is serial on one gateway-backed model. Wall time is the critical-path cost (PLAN-10). Live cloud connections (ChatGPT sign-in, OpenRouter) may be used for small-spend checks, but are not used for matched comparisons. One reason: `openrouter/free` routed 3 requests to 3 different models in the 2026-10-14 verify run, which breaks model matching.

**Rationale.** These figures are the pilot's pre-registered thresholds (eval/README), tightened where the pilot showed weakness: false VERIFIED, crash accounting. The absolute floor prevents "beat a weak peer" from passing. Thresholds are fixed **before** the RC run.

## DEC-06: Supported providers for v1

| Tier | Providers | Condition |
|---|---|---|
| **Supported** | OpenAI-compatible local servers (llama.cpp server, vLLM, LM Studio, Ollama) | The release notes name the server kinds that pass the standalone matrix (≥ 2 required). Others are listed as "compatible, not qualified". |
| **Supported (optional integration)** | homelab-ai gateway | Never required (standalone gate). |
| **Supported** | OpenRouter | Live-verified 2026-10-14 at db1ca55 (`evidence/live/verify_openrouter.json`); re-verify at RC with a **pinned** model (not `openrouter/free`). |
| **Experimental → Supported if live-verified at RC** | OpenAI API key (Responses), Anthropic (Messages), generic compatible cloud | Not connected on the owner's install. They stay experimental unless keys are added and `nexus providers verify` passes at RC. |
| **Experimental (always)** | ChatGPT sign-in (the owner's OpenAI OAuth connection), Copilot sign-in | They use unofficial OAuth flows with terms-of-service and stability risk. Opt-in with a visible warning. ChatGPT sign-in was live-verified on 2026-10-14 (`evidence/live/verify_chatgpt.json`), and a live end-to-end run reached a correct VERIFIED (`evidence/live/run1_chatgpt_bugfix.log`). It is still labelled experimental because the sign-in flow is unofficial. |

## DEC-07: Experimental surfaces (`nexus eval`, `/tdd`, team roles)

- **`nexus eval`.** Labelled experimental. Its scoring is not fixed in v1, but its unsafe `git checkout` in the operator's workspace **is** fixed: it must run in a worktree (VER-07a). It is excluded from all claims. The SPEC-10 harness (`eval/`) is the qualification tool.
- **`/tdd` / `--tdd`.** Labelled experimental. Fixing the phase enforcement is post-v1.
- **Team roles.** Reviewer and researcher units run with a **read-only tool set** (cheap and safety-relevant). Other role allowlists are post-v1.

## DEC-08: Version identity and stale v1.x tags

- `package.json` is the single source of truth. `scripts/sync-version.mjs` updates `cli/package.json` and `core/Cargo.toml`. Release CI asserts that all three equal the tag.
- Release line: `v1.0.0-rc.N` prereleases, then `v1.0.0`.
- The local-only tags `v1.1.0`, `v1.2.0` and `v1.2.1` are to be **deleted locally**: `git tag -d v1.1.0 v1.2.0 v1.2.1`. The owner confirmed on 2026-10-14 that they never existed on the remote, and the audit's `git ls-remote --tags origin` agrees. They are not ancestors of main. Their impact is local only. They sort above v1.0.0 and would confuse `git describe` and the tooling. This is an owner action (see the last section) because it removes local references.

## DEC-09: Release provenance mechanism

**Chosen:** GitHub artifact attestations (`actions/attest-build-provenance`). Users verify with `gh attestation verify`. SHA256SUMS is kept. There is no separate GPG or minisign key to manage.

**Tradeoff:** verification needs the `gh` CLI or the Sigstore tooling. The installer verifies only when `gh` is present, and checksums are always verified.

## DEC-10: Tracking of `cli/dist`

**Chosen:** stop tracking `cli/dist`. Remove it from git, add it to `.gitignore`, and build it in CI and packaging. Checkout users already need `make build` for the Rust binaries.

**Tradeoff:** a fresh clone needs one build step for the TS side too; the docs already state `make build`.

## DEC-11: Retention defaults

**Chosen:**
- Keep tasks, sessions, checkpoints and flights for 90 days or up to 2 GB in total, whichever limit is hit first. Never remove the current session or pinned sessions.
- Rotate `audit.log` at 10 MB, keeping 5 files.
- Automatic GC runs at most daily. The first run after upgrade needs acknowledgement, or `NEXUS_GC=auto`.

## DEC-12: Platform scope

**Chosen:** Linux x86-64, glibc ≥ 2.35, Node ≥ 20 for v1.0.0, which is what is built and tested. The docs keep the conservative "≥ 2.35" claim; the binaries reference glibc symbols ≤ 2.34. macOS, arm64 and musl are post-v1 roadmap items.

## DEC-13: Contest track disposition

**Context:** the owner confirmed on 2026-10-14 that the contest entry submission is complete. Operator work state records submission id `e05006b6-…` at revision `ce7e58b9ca3f…`.

**Chosen:**
- The contest is a separate track (SPEC-C1). It never gates the client.
- **Freeze:** the submitted material (contest docs, `experiments/cloudflare-artifacts-vertical-slice/`, `demo/`, contest CI job) is not changed while judging is open. Post-deadline edits to submission-referenced files could be read as amending the entry. The audit findings CON-001 to CON-014 are recorded, not acted on.
- After judging concludes, PLAN-C1 runs as **post-contest hardening**. Its first task is the CON-001 correction, with a dated "post-submission correction" note in CONTEST.md.
- One exception is allowed during the freeze: if the contest rules permit errata, a single erratum may state that the documented deploy builds the legacy Experiment-1 Worker and that reproduction is operator-host only. The owner checks the rules first; the default is no change.
- Client work that touches `demo/lib/real-agent-runner.mjs` (PLAN-01 task 8, `--yes`) is deferred until after judging. Until then, the client keeps backward-compatible behaviour for `nexus run` invoked by the demo. In practice the demo passes the auto posture explicitly via `NEXUS_APPROVAL_MODE=auto` in its own environment once the client changes, and no demo file needs editing, because the env var is read by the client.

**Tradeoff:** judges who follow the documented deploy may deploy the legacy Worker. That Worker deploys into their own account, so the exposure is confined to their own test deployment.

## DEC-14: Free text on the command line

**Chosen:** an unknown first word is an error. Free text runs only through `nexus run "<text>"` or the interactive prompt. This removes REL-03's accidental agent launches.

## DEC-15: Knowledge auto-extraction

**Chosen:** off by default; opt-in with `NEXUS_KNOWLEDGE_AUTOEXTRACT=1`, with a visible notice each time a rule is saved. Workspace knowledge is loaded only when the workspace is trusted.

---

## DEC-16: Standalone qualification under a gateway-only environment

**Constraint (owner, 2026-10-14):** there is no separately accessible worker and no extra GPU. Gateway access to the workers must be sufficient, and direct workload requests to workers are not allowed.

**Options:**

| Option | Description | Assessment |
|---|---|---|
| A | Require a second GPU host running plain servers | Not available. Rejected. |
| B | Qualify standalone only by mocks | Too weak: it never exercises real model behaviour. Rejected as the only evidence. |
| **C (chosen)** | Two-part standalone gate | See below. |

**Option C, part 1: live gateway-stripped runs (REQ-PRV-106 part a).**
- Nexus runs in a clean HOME with no homelab configuration: no `config.env` gateway entries, no gateway token file, no `X-Task-Class`.
- It talks to `eval/standalone/plain_proxy.mjs` on `127.0.0.1`. The proxy forwards to the gateway with the gateway token injected on the proxy side. It strips every gateway extension: `/v1/models` is reduced to `{id, object, owned_by}`, `/v1/tokenize` returns 404, and `X-AIHost-*` response headers and admission headers are removed.
- In a second profile, the proxy rewrites the `/models` and overflow-error shapes into the documented formats of llama.cpp `server`, vLLM and Ollama. That exercises each server kind's discovery and capacity-error path against real model output.
- The standalone T2 subset (≥ 10 tasks) and the T4 subset run in both profiles.
- The proxy only **removes** information. The gateway itself is unchanged, and all workload still flows through it, as the owner requires.

**Option C, part 2: server-kind conformance (REQ-PRV-106 part b).**
- Response-shape fixtures for llama.cpp, vLLM, LM Studio and Ollama are written from each project's published API documentation, with source references and versions recorded. They cover `/models`, `/props`, `/api/v0/models`, `/api/show`, SSE tool-call deltas, think tags and overflow bodies.
- The fixtures run in CI.
- Optionally, a CPU-only llama.cpp `server` built without AVX (this dev box is a Xeon X5650) with a ≤ 1.5B model is used for a protocol smoke test: one streamed reply, one tool call, one overflow. That is real server code, but task quality is out of scope.

**Release statement:**
- Release notes say: "Live-qualified against llama.cpp-served models through a plain OpenAI-compatible interface (gateway extensions removed). vLLM, LM Studio and Ollama: protocol-conformance tested, not live-qualified."
- LM Studio stays "compatible, not live-qualified" unless a user-run report is added.

**Tradeoff:** live evidence for server kinds other than llama.cpp is limited to emulated shapes. This is stated plainly rather than over-claimed.

**Affected:** REQ-PRV-106, REQ-QUAL-107; SPEC-05; SPEC-10; PLAN-05 task 7; PLAN-10; ACCEPTANCE §4.2. Owner action X3 (separate host) is withdrawn.

## Owner and external actions required (not performed by the audit)

| # | Action | Why | When |
|---|---|---|---|
| X1 | ~~`git tag -d v1.1.0 v1.2.0 v1.2.1`~~ **Done by the owner on 2026-10-14.** Verified: `git tag -l` now lists only `v0.1.0-alpha.1` and `v0.1.0-alpha.2`. | DEC-08 | Done |
| X2 | ~~Provide an independent task author~~. **Resolved 2026-10-14:** agent authorship authorized for T2 (DEC-05). Remaining action: approve the T3 task author (agent authorship is assumed to extend to T3 unless the owner objects). | DEC-05 | Before M5 |
| X3 | ~~Separate standalone host~~. **Withdrawn:** no worker or GPU is available apart from the gateway. Replaced by DEC-16 (stripping proxy plus conformance fixtures). Remaining action: none. Optional: approve a CPU-only llama.cpp container on the dev box for the protocol smoke test. | DEC-16 | — |
| X4 | **Partly resolved 2026-10-14:** the existing ChatGPT sign-in and OpenRouter connections are authorized for small-spend checks; both were live-verified at db1ca55. Optional: add OpenAI API-key or Anthropic keys if those providers should be listed as supported. | DEC-06 | M5 (optional) |
| X5 | Independent reviewer for continuity/compaction acceptance and RC acceptance | REQ-AGT-110, ACCEPTANCE §8 | M5/M6 |
| X6 | After judging: provide a clean Cloudflare account and VM for CON-106. During judging: check whether contest rules permit an erratum (default: no change) | DEC-13 | Post-contest |
| X7 | Approve publishing `v1.0.0-rc.N` and `v1.0.0` (tag push triggers public release) | Release | M6 |
| X8 | Decide whether to clean the 52k test-polluted records in the real `~/.nexus/tasks` (PER-03). Safe to remove: `task-*.json` whose `workspacePath` starts with `/tmp/nexus-app-test-`. | Hygiene | Any time |
