# Nexus Code v1.3 plan: the platform track

Status: PLAN, written 2026-11-15 against `main` plus the v1.2.0-rc.1 notes, at the owner's request ("draft the v1.3 platform track as recommended"). It follows v1.2.1 and v1.2.2 ([`docs/v1.2.1/PLAN.md`](../v1.2.1/PLAN.md), decision D12). Nothing here is a claim that Nexus Code is frontier-grade, and no unit starts without the decisions in section 7.

## 1. Purpose and theme

Frontier clients are platforms: a CLI plus a desktop app, IDE integration, background and scheduled agents, an SDK or managed API, installable plugin bundles, and enterprise policy (web sources of 2026-11-15, mostly third-party; see [`docs/v1.2.1/GAP_ANALYSIS.md`](../v1.2.1/GAP_ANALYSIS.md) §2). Nexus is a single-binary Linux CLI and TUI. It cannot match breadth or first-party model fit, and a worse copy of three funded platforms is not a goal.

The v1.3 theme: **let other programs drive Nexus and let teams govern it, without weakening the gate.** Every new surface (an IDE over ACP, a scheduler, a hook, a plugin, an SDK caller, a managed policy) goes through the same approval and verification gates as the terminal does. The differentiator to build on is the one nobody else ships by default: a completion you can audit (independent verification, receipts, evidence). Two consequences shape the plan:

1. **Nexus as the verification layer for other harnesses.** `nexus verify` and an MCP/ACP `verify` tool let a Codex, Claude Code or Aider session ask Nexus to independently check its work. This costs little (the machinery exists) and is positioned where the platforms are weakest.
2. **Governance as a product.** Managed policy with fixed precedence, a hash-chained and optionally signed audit export, and hooks that can only tighten.

Non-goals: a marketplace, a desktop or mobile app, a Nexus-specific VS Code extension (ACP clients already exist), hosted or multi-tenant operation (dropped 2026-11-15, decision D8), plugin auto-update, any new runtime dependency without a decision.

## 2. Evidence and its limits

- **Nexus today** (read-only inventory, 2026-11-15; "present" means present in source or docs, nothing was run): sidecar/TUI protocol is NDJSON over the sidecar's stdio with `PROTOCOL_VERSION = 1`, an event `v`, a one-way `hello`, typed unions in `cli/src/protocol.ts:53-204` hand-mirrored in `core/src/bin/nexus_tui/protocol.rs`, **no schema file, no socket**; `nexus run --json` returns `TaskExecutionResult` (`cli/src/core/app.ts:44`) with no schema or version, exit codes defined only in code (0 verified, 2 completed-unverified, 130 interrupted, 1 otherwise); `ApplicationCore` is an accidental re-export (`cli/src/index.ts:1240`) and `cli/package.json` has `main` and `bin` but no `exports` or `types`; operations are durable and resumable (per-operation lock, 12 h wait survives restart, `maxConcurrentUnits` capped at 64 and clamped to 1 without `git.isolate`) but **foreground-only**, with no scheduler, cron, trigger or daemon in the code; plugins are plain JS modules with no manifest, checksum or install command, workspace plugins load after `nexus trust` with full process authority, hooks cover pre/post tool only; policy is the workspace-local `.nexus-security.json`, **fails open to defaults on a parse error**, with no system or admin layer; session export is `nexus-session-export/2` reachable only through `/export`; the flight log is append-only by convention (no hash chain found) and the CERI evidence store hashes files but has no signature or verify command; local OTLP-style traces are written on every session with no opt-in gate and no network exporter found; a goal (objective ledger) persists across sessions via `--resume`, but nothing re-launches a task on its own.
- **Peers, read from source** (shallow clones of 2026-11-13/14; Codex at commit 336b19a; untrusted code, nothing run): ACP servers in goose (`crates/goose/src/acp`), Cline (`apps/cli/src/acp/acpAgent.ts`), Gemini CLI (`packages/cli/src/acp`) and opencode (`packages/cli/src/acp/agent.ts`), the Codex `app-server` (JSON-RPC 2.0 over stdio, websocket or UDS; schema generated from Rust types and checked in); schedulers in goose (`scheduler/full.rs`), Cline (`*.cron.md` and event specs) and opencode (a `ScheduleTable` with `in`/`at`/`every`/`cron` and an optional deterministic wake `check`); hooks in Gemini CLI (`docs/hooks/reference.md`), goose (`hooks/mod.rs`), Cline and Codex; extension manifests in Gemini CLI (`gemini-extension.json`), goose (Open Plugins and Gemini formats) and opencode; policy tiers in Gemini CLI (`core/src/policy/config.ts:67-71`), opencode (`managed-policy.ts`) and Codex (`requirements.toml`); goal state in opencode (`schema/src/goal.ts`) and Codex (`thread/goal/*`).
- **XERJ reference queries** (2026-11-15, local node, read-only; the `opencode` index is flagged "not verified complete", so a miss there is not proof of absence): `xerj code opencode` for ACP, scheduling and plugin manifests; `xerj search --prefix goose` for ACP, scheduler and extension manifests; `xerj search --prefix xc-opencode` for managed policy. **Took:** opencode's wire-level ACP fixture pattern (`packages/cli/test/acp/wire-fixture.ts`) for protocol conformance tests; opencode's schedule model (`schema/src/schedule.ts`, `core/src/schedule/sql.ts`: `next_due_at`, `remaining_runs`, `last_outcome`, deterministic wake check with hard limits) and its documented GitHub scheduled-workflow example; goose's cron-on-a-recipe scheduler shape (`scheduler/full.rs`, `commands/schedule.rs`); goose's checked-in ACP schema and method metadata (`acp-meta.json`); goose's plugin formats (`plugins/formats/gemini.rs`, `open_plugins.rs`); opencode's managed policy as config statements with an action, a resource and an effect (`config/plugin/policy.ts`). **Rejected:** opencode's in-process Effect plugin hooks (a JS-in-process model is what Nexus is trying to move away from), goose's per-run `Auto` mode for scheduled runs (unattended runs must never get allow-always), and any code copied verbatim: reference code is read-only inspiration.
- **Not covered:** Claude Code and agy were not read (web sources only); parts of Cline's daemon, Codex's hook handler types and plugin manifest, and goose's managed policy were sampled, not read in full; peer behaviour under load was not measured.

## 3. Principles

1. **Protocol first.** Nothing else in this plan is safe to build until the client protocol is published, schema'd, versioned and conformance-tested.
2. **One gate.** A new surface can request an approval but can never answer one on behalf of Nexus's own gates (SI-2, CS-* rules, verification). A client that answers "allow" to a denied action must have no effect; this is tested.
3. **Tighten only.** Hooks and managed policy may deny, require a human, or rewrite arguments toward safer values. They never grant.
4. **Unattended means stricter.** Scheduled and detached runs never get allow-always, run in a fresh worktree, and record that they were unattended in every receipt.
5. **Explicit trust.** Project-defined hooks, plugins and policy run only after a trust decision keyed by a content hash; a changed file asks again.
6. **Schemas come from types.** Generate JSON Schema from the TypeScript types and check it in with a parity test, so the Rust mirror cannot drift (reference: Codex `app-server-protocol` schema export, goose `acp-schema.json`).
7. **No new runtime dependency** without a decision. ACP is plain JSON-RPC; hash chains and ed25519 signing use `node:crypto`.
8. **Experimental is a flag.** New methods sit behind `experimental` at `initialize` (reference: Codex `experimentalApi`) until a conformance suite has run against two real clients.

## 4. Workstreams and units

Size: S = one PR; M = two to four PRs; L = a program. P0 = prerequisite, P1 = core, P2 = stretch.

### PF: protocol and embedding foundation

| Unit | What | Accept | Size | Pri |
|---|---|---|---|---|
| PF-1 | Publish the client protocol: JSON Schema generated from `cli/src/protocol.ts`, a checked-in copy, a TS/Rust parity test replacing hand-sync, capability negotiation in `hello` / `initialize` (version range, `experimental` flag), `docs/PROTOCOL.md`; wire-level conformance fixtures (reference: opencode `packages/cli/test/acp/wire-fixture.ts`) | schema diff fails CI when a type changes without a version decision; a recorded session replays through the fixture harness | M | P0 |
| PF-2 | `nexus run --json` result schema with a `schema_version`, documented exit codes in the manual, `--input-json` or stdin for the task | schema validated in tests; a consumer test parses the output | S | P0 |
| PF-3 | Transport beyond a parent's stdio: a unix domain socket (default) with a token and origin check for any localhost HTTP/WebSocket listener (reference: goose `acp/transport/auth.rs`, constant-time compare); several clients may attach and reattach | a second client attaches to a running session; a wrong token is refused; the socket is mode 0600 | M | P1 |
| PF-4 | Library entry point: a `lib` entry that does not run commander on import, `exports` and `types` in `cli/package.json`, a package name decision, a documented minimal embedding example that spawns the sidecar | an example script runs a verified task through the entry point in CI | M | P1 |

### AC: ACP and IDE access

| Unit | What | Accept | Size | Pri |
|---|---|---|---|---|
| AC-1 | ACP adapter over the sidecar protocol (stdio), hand-rolled JSON-RPC with no dependency: `initialize` with a capability list, `session/new`, `session/load`, `session/prompt`, `session/cancel`; streaming `tool_call` and `tool_call_update` with diff content; a `verification` update carrying receipt ids and verifier results; client-bound `session/request_permission` with allow-once and reject only (no "allow always" at first); one extension, `_nexus/receipt/get`. Reference: goose, Cline, opencode, Gemini CLI ACP servers and the Codex app-server (all four ACP servers use the same three-option permission request; opencode attaches the diff to the request so the user decides with the change in view) | a scripted ACP client completes a task; an `allow` reply to an action the gates deny has no effect (gate test G-3); the receipt is retrievable | L | P1 |
| AC-2 | ACP conformance: fixture suite plus runs against two real ACP clients (decision D14), recorded as fixtures; no live model | both clients complete the basic flow; fixtures committed | M | P1 |

This supersedes v1.2.1 unit RD-5 (ACP server mode), which moves here.

### VR: Nexus as the verification layer

| Unit | What | Accept | Size | Pri |
|---|---|---|---|---|
| VR-1 | `nexus verify` (no agent run): given a worktree or a base and head, run the discovered or configured verifier, the type-check evidence (CG-4), the verification-file guard and the independent reviewer, and print a verdict VERIFIED / REGRESSION_FREE / UNVERIFIED / BLOCKED with the receipt; exit code per the documented contract; usable as a CI gate (pairs with the v1.2.1 GitHub Action, RD-4) | a known-bad diff (weakened test) is not VERIFIED; the same diff produced by another harness gives the same verdict | M | P1 |
| VR-2 | Expose verification as an MCP tool and an ACP extension so another harness can call Nexus to check its own work (`serve-mcp` today exposes workspace tools, not verification); the caller can read the verdict but cannot change it | an external client's session gets a verdict and a receipt id; tampering with the request cannot raise the verdict | M | P1 (decision D20) |

### BG: background and scheduled runs

| Unit | What | Accept | Size | Pri |
|---|---|---|---|---|
| BG-1 | Detached runner: a user-level job runner that owns durable operations so a run survives its CLI process (decision D15: a documented `systemd --user` unit versus a self-daemonizing mode); foreground mode unchanged | kill the CLI, the run continues and resumes cleanly; the SI-7 kill test passes against the runner | L | P1 |
| BG-2 | Schedules: a spec (trigger `cron`, `every` or `once`; objective ledger id; `max_rounds`; timeout; policy `read-only` or `worktree-write`; optional deterministic wake `check` command with hard limits, reference opencode `schedule/check.ts:23-39`: 30 s, 20 tool calls, 32 KB, cannot create schedules or worktrees) stored beside operations (`next_due_at`, `remaining_runs`, `last_outcome` as in opencode `core/src/schedule/sql.ts`); `nexus schedule add\|list\|rm\|run-now`; each run in a fresh worktree; unattended flag in every receipt; no allow-always; delivery is a receipt plus a pointer file | a scheduled run on a seeded failing verifier ends BLOCKED and says so; an unattended run asking for approval is denied, not blocked forever; missed runs are reported, not silently skipped | L | P1 |
| BG-3 | Event triggers (file change, webhook) | deferred: needs a trust and abuse model first | M | P2 (v1.4) |

### GV: governance

| Unit | What | Accept | Size | Pri |
|---|---|---|---|---|
| GV-1 | Managed policy with fixed precedence **system > user > project**: `/etc/nexus/policy.toml` (path per decision D16), `~/.config/nexus/policy.toml`, then the existing `.nexus-security.json`; restrict-only semantics (deny, require a human, disable auto/yolo, allowlist MCP servers and plugins, set verification-path modes); the effective tier is printed beside every decision; a parse error in the system or user tier **fails closed**; a project policy file is hashed and a changed one asks again (reference: Gemini CLI tiers, MATCH/MISMATCH/NEW integrity check and system settings paths; opencode managed policy; Codex `requirements.toml`) | a project policy cannot loosen a system policy; a corrupted system policy refuses to start with a clear message instead of failing open; precedence table covered by tests | M | P1 |
| GV-2 | Audit export: `nexus audit export <task\|session>` writes a bundle (session export, receipts, evidence, verification attempts, flight log excerpt) with a manifest of SHA-256 hashes and a hash chain, optionally signed with an operator-provided ed25519 key (`node:crypto`, decision D17); `nexus audit verify` | a bundle with one altered byte fails verification and names the file; an unsigned bundle verifies by hash only and says so | M | P1 |
| GV-3 | Hash-chain the flight recorder and the verification-attempt log (today append-only by convention only) and verify the chain on `nexus flights replay` | truncating or editing a record is detected | S | P1 |
| GV-4 | Telemetry transparency (this also settles v1.2.1 unit PC-5): document what the local traces contain, add a setting to disable them and a retention limit, state plainly that nothing leaves the host (no network exporter found) | doc plus a test that no network call is made | S | P1 |
| GV-5 | Admin controls from the system policy: a strict mode that disables auto and full-access, an MCP and plugin allowlist | strict mode refuses `--yes` and `--mode auto` with the policy source named | S | P1 |

### HK: hooks and plugins

| Unit | What | Accept | Size | Pri |
|---|---|---|---|---|
| HK-1 | Declarative command hooks: events `pre-tool`, `post-tool`, `pre-verify`, `post-verify`, `permission-request`, `session-start`, `session-end`, `stop`, `pre-compact`; JSON on stdin (`session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`) and on stdout (`decision`, `reason`, `hookSpecificOutput`), exit 2 blocks with stderr as the reason, a timeout, a scrubbed environment (reuse `buildMcpEnvironment`), results written to the receipt. A hook may only deny or tighten arguments, never grant (Gemini CLI also ignores `allow` from lower tiers). Project-defined hooks need a trust decision keyed by a hash of the command (reference: Gemini CLI `trusted_hooks.json`, goose `hooks/mod.rs`, Codex hook trust). Handler types: command only (no peer shipped http, prompt or subagent handlers in what was read) | a hook that returns `allow` for a denied action has no effect; a changed project hook asks again; the contract is documented so existing hook scripts of that shape transfer | M | P1 |
| HK-2 | Plugin manifest `nexus-plugin.json` (name, version, declared contributions: hooks, skills, verifiers, MCP servers; required permissions); install from a local path or a git URL **pinned to a commit hash**; capabilities shown at install, resolved commit recorded in an install receipt; `nexus plugins install\|list\|remove\|verify`; no marketplace and no auto-update (reference: Gemini CLI `gemini-extension.json`, goose `.goose-plugin-install.json`). Also fix the documented example in `docs/SKILLS_AND_PLUGINS.md` that does not match the code (`onTurnStart` positional arguments versus a context object) and stop swallowing plugin load errors silently | installing a plugin whose declared permissions exceed the system policy is refused; `verify` detects a modified install | M | P1 |
| HK-3 | Per-plugin trust instead of per-directory, and run workspace-defined plugin hooks as subprocesses rather than in-process (a trusted workspace today runs every `.js` file in it with full process authority) | decision D18; migration note for existing plugins | M | P2 |

### PA: parallel agents and goals

| Unit | What | Accept | Size | Pri |
|---|---|---|---|---|
| PA-1 | Parallel run visibility: `nexus operation watch` (CLI view first) showing units, worktrees and owners; a worktree owner id recorded in the receipt (reference: Codex `worktree` crate `owner` and `bind_thread`); a concurrency cap tied to a CPU and memory budget instead of a count only | two parallel units show their owners and states; the cap refuses a third when the budget is exhausted | M | P1 |
| PA-2 | Verified merge arbitration: when parallel units integrate, apply each diff, run verification on the merged tree, reject on failure. No peer read does more than isolate; this is where Nexus can differ | two units whose changes conflict semantically (each passes alone) fail verification on the merged tree and neither is integrated silently | M | P1 |
| PA-3 | Goal semantics: a ledger entry active from an earlier process resumes **paused** (opencode `goal.ts` boot id), stall counting by failure fingerprint and not turn count, completion decided only by a verifier receipt, an optional token budget rolling up from sub-operations (reference: Codex goal budget); `/team` leaves experimental only after PA-1 and PA-2 | stale goal resumes paused with a visible reason; a model "I am done" does not complete a goal | M | P2 |

## 5. Sequencing

Phase A (foundation, parallelisable): PF-1, PF-2, GV-4, VR-1, GV-3. These unblock the rest and cost little.
Phase B: AC-1, HK-1, GV-1, GV-2, PF-4, PA-2, VR-2.
Phase C: BG-1, BG-2, HK-2, PF-3, AC-2, PA-1, GV-5.
Phase D (stretch, may roll to v1.4): PA-3, HK-3, BG-3.

Dependencies on earlier plans: v1.2.1 RD-3 (`stream-json` output) feeds PF-2; RD-4 (GitHub Action) pairs with VR-1; CS-9 (per-command approval rules, v1.2.2) and GV-1 must agree on rule semantics (allow < prompt < forbidden, deciding rule recorded); MT-1 (the `agent.ts` split) makes AC-1 and BG-1 much easier and should land first if possible; PR-* (provider registry) is independent; MQ-* (measurement) should publish at least one result before this release claims anything.

## 6. Release gates

| Gate | Condition |
|---|---|
| G-1 | `make test` green at the exact head; required CI green; main CI green on the merge commit |
| G-2 | Protocol conformance: schema parity test and the wire-fixture suite green; AC-1 passes against two real clients or the release says "experimental" |
| G-3 | **Gate-bypass suite:** a hostile client, hook, plugin, schedule or policy file cannot approve a denied action, raise a verdict, widen a policy tier, or remove a verification-file protection |
| G-4 | Unattended runs: tests show no allow-always, a fresh worktree, the unattended flag in receipts, and a kill-and-resume pass |
| G-5 | Audit round trip: export, verify, tamper one byte, verify fails and names the file |
| G-6 | Docs and examples for every new surface (`docs/PROTOCOL.md`, hooks, plugins, policy, schedules, audit) with runnable examples in CI |
| G-7 | Notes keep the framing: "ledger closed, qualification pending" unless an external result (E2 per the v1.2.1 plan §7) exists |

## 7. Decisions needed

| Id | Decision | Default if unanswered |
|---|---|---|
| D13 | Publish an npm package or SDK (PF-4)? Package name and licence; external publishing is yours to authorise | no publish; the entry point is documented but not published |
| D14 | Which two ACP clients to test against (AC-2) | the two most widely used open-source ones that run on Linux without an account |
| D15 | Detached runner model: a documented `systemd --user` unit, or a self-daemonizing mode (BG-1) | the `systemd --user` unit only |
| D16 | System policy location and whether the system and user tiers fail closed on a parse error (GV-1) | `/etc/nexus/policy.toml`; fail closed |
| D17 | Audit signing: where the operator's ed25519 key lives and whether signing is required or optional (GV-2) | optional; key path supplied by the operator, never stored by Nexus |
| D18 | Whether in-process workspace JS plugins stay supported after HK-1/HK-2 (HK-3) | keep, but move to per-plugin trust with a deprecation note |
| D19 | Unattended-run defaults (BG-2): `read-only` only, or `worktree-write` allowed | `read-only` by default; `worktree-write` per schedule with an explicit flag |
| D20 | Position Nexus as a verifier for other harnesses (VR-2)? | yes |
| D21 | Event triggers and remote (SSH) execution: v1.4 or never | v1.4 candidate, no work in v1.3 |

## 8. Risks

| Risk | Mitigation |
|---|---|
| A new socket or listener widens the attack surface | unix socket mode 0600 by default; token and origin check for any HTTP listener; G-3 |
| A client answers approvals in a way that bypasses a gate | the gate decides first; the client only supplies a human's yes or no; G-3 tests it |
| Fail-closed policy locks an operator out | a clear message naming the file and tier, and a documented recovery path; tested |
| Unattended runs burn the shared gateway or contend with live measurements | schedules use the `GATEWAY` claim protocol; read-only default; run budget in every spec |
| Plugin supply chain | commit-pinned installs, capabilities shown, no auto-update, install receipt, `verify` |
| Protocol churn after publication | `experimental` flag, version range in `hello`, schema diff in CI |
| Scope: this track is as large as v1.2.0 plus v1.2.1 | the sequencing above; Phase D rolls without ceremony; a unit is never half-merged |
| An unreviewed peer assumption | sources and limits are listed in section 2; each unit's PR repeats the reference coding record (XERJ queries, what was taken or rejected) |
