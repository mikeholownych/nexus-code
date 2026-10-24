# SPEC-01: Safe execution defaults and approval integrity

| | |
|---|---|
| Status | Updated by [DEC-01](../DECISIONS.md#dec-01-default-execution-posture): permission mode is independent of folder trust; unset mode defaults to review. |
| Release class | **BLOCKER** |
| Requirements | REQ-SEC-101, REQ-SEC-102, REQ-SEC-103, REQ-SEC-104, REQ-TUI-102, REQ-SEC-108, REQ-SEC-109, REQ-SEC-119 |
| Findings | SEC-01, VER-01, HIST-05, TUI-07, TUI-02, TUI-03, TUI-12, SEC-02, SEC-04, SEC-10, VER-14, TUI-09, TUI-10 |
| Plan | [PLAN-01](../plans/PLAN-01-safe-execution-defaults.md) |
| Acceptance | ACC-SAFE-01 to ACC-SAFE-06 in [ACCEPTANCE.md](../ACCEPTANCE.md) |

## 1. Original finding (historical baseline)

The observations in this section describe the original audit baseline and are not assertions about the amended DEC-01 behavior. In particular, the reported trust-derived `auto` default was the defect identified by SEC-01; DEC-01 was amended on 2026-10-24 to make permission mode independent of folder trust and default to `review`.

Nexus's default interactive mode is `auto` on both surfaces (`cli/src/sidecar.ts:935`, `cli/src/index.ts:93,115`, `cli/src/repl.ts:69`). In `auto`:

- `run_command` executes `bash -c <string>` on the host as the user (`core/src/runner.rs:116-157`). The only confinement is the working directory. No sandbox is applied unless `--sandbox` is passed (`cli/src/config.ts:107`).
- The only guard is a substring denylist, implemented twice (`cli/src/security.ts:12-23,78-89`; `core/src/runner.rs:64-107`). It is bypassed by `rm -r -f /`, `rm -rf "$HOME"` and `find / -delete`, and it blocks legitimate `rm -rf ./build` (SEC-02, reproduced).

Review mode (`--approve`) gates only capabilities with `mutating: true` (`cli/src/agent.ts:3946-3947`). The following are declared `mutating: false` (`cli/src/core/capabilities.ts`), so **review mode never asks before they run**:

- `fetch_web`, `search_web`, `browser_navigate`, `browser_click`
- `spawn_subagent`, `activate_skill`

The consequences are HIST-05 and SEC-03. A prompt-injected instruction from a file, fetched page, skill, MCP result or tool output can therefore run any host command, or exfiltrate data through a URL, without the operator seeing a prompt (SEC-01).

The REPL approval prompt is `[Y/n/d/a]` with Yes as the default (`cli/src/repl.ts:353,385`):

- A lone Enter approves the action (TUI-02, reproduced in a PTY).
- Text typed during the turn is merged into the answer, so a `y` typed early followed by Enter approves (TUI-03, reproduced).

The packaged `nexus` opens the REPL by default (see SPEC-06), so this weaker surface is what release users get.

**Verifier runs bypass the gate entirely (VER-01).** Before the first edit (change baseline, `agent.ts:1602-1617`) and at every `task_completed` (`agent.ts:3432-3436`), Nexus runs the repository's own test command (`make test` / `npm test` / `cargo test` / `pytest`, chosen by `tester.ts:113-136`) through `bridge.executeTool` directly. These calls skip `dispatchToolCall`, so even review mode never asks, and no workspace-trust check applies. Opening a hostile repo and approving one `edit_file` therefore runs that repo's arbitrary test script on the host. `/test` and `nexus eval` run `execSync` on the host, bypassing the sandbox and blocking the event loop (VER-14).

`--read-only` admits `cat ~/.ssh/id_rsa` and `cat /etc/passwd` (`cli/src/core/authority.ts:44-136`), and its sandbox ro-binds `/` (SEC-04).

The live Ratatui TUI's approval guard is strong. It held under continuous typing, bracketed and unbracketed paste, key bursts and resize to 40x14 (D_terminal §4/§5, `core/src/bin/nexus_tui/live_state.rs:1249-1395`, `live.rs:317-481`). That design is the reference for this spec.

## 2. Evidence

| Finding | Label | Reference |
|---|---|---|
| SEC-01 default auto, no sandbox | SOURCE | evidence/C_tools_security_persistence.md §3 |
| SEC-02 denylist bypass and false positives | RUNTIME (classifier calls; only `echo` executed) | C §4 R2/R3 |
| HIST-05 egress tools ungated in review | SOURCE | evidence/F_requirements_history.md §3 |
| TUI-02 Enter approves | RUNTIME (PTY r1a) | evidence/D_terminal.md §4 |
| TUI-03 typed-ahead approves | RUNTIME (PTY r1d) | D §4 |
| SEC-04 read-only reads home secrets | RUNTIME (classifier) | C §4 R2 |
| SEC-10 bwrap argv joined by spaces | SOURCE | `cli/src/sandbox.ts:131-158,181` |
| TUI guard strength | RUNTIME (PTY s2/s3) | D §5 |

## 3. Requirements

1. **REQ-SEC-101.** Without operator opt-in, no command execution and no network egress initiated by the model happens without either an operator decision or an enforced sandbox. Which one is the default is decided in DEC-01.
2. **REQ-SEC-102.** Every capability has an explicit **effect class**. Review mode gates every class except `read_workspace`. The gate is enforced at dispatch from the registry, not from the offered tool list, so hidden tools are gated the same way (`cli/src/core/tool_groups.ts` comment: "hidden tools still execute").
3. **REQ-SEC-103.** In every surface, no approval is decided by Enter alone, by typed-ahead input, by pasted input, or by input that arrives within the grace window after the prompt is displayed.
4. **REQ-SEC-104.** `--read-only` cannot read outside the workspace through `run_command`. The sandboxed read-only domain masks `$HOME` except the workspace.
5. **REQ-TUI-102.** At session start, both surfaces state the active posture, how to change it, and whether the workspace is trusted.
6. **REQ-SEC-108.** The command denylist is documented and labelled as a convenience tripwire, not a boundary. Its known false positives are removed.
7. **REQ-SEC-109.** The sandbox command line is built as an argv array and never re-parsed by a shell.
8. **REQ-SEC-119.** Verifier executions that Nexus initiates itself (change baseline, completion oracle, independence copy, `run_tests`, `/test`) are `exec`-class actions. They are subject to the same permission mode as `run_command`.
   - In review mode, the first verifier run requires a one-time approval. The approval shows the exact command and the script body it resolves to (for example the `scripts.test` entry, or the Makefile `test:` recipe).
   - An explicitly configured auto posture runs without asking regardless of workspace trust; folder trust controls project instructions and integrations only.
   - All of them go through the Rust runner (sandbox, cancel and output bounds apply), never host `execSync`.

## 4. Scope

**In scope:**

- Effect classes in `CanonicalCapability`.
- The gating rule in `dispatchToolCall`.
- Default posture wiring for the CLI, REPL and sidecar.
- REPL approval input handling.
- Read-only HOME masking.
- Denylist relabel and false-positive fixes.
- Sandbox argv construction.
- Startup posture banner.
- Approval panel arrow direction and narrow-width hints (TUI-09/10, release-required polish).

**Out of scope:**

- Network sandboxing beyond bwrap `--unshare-net` in read-only mode.
- A seccomp profile.
- Per-command allowlists ("always allow `npm test`"). These are optional post-v1. The design below keeps the `a` (approve-all for session) answer.

## 5. Proposed behaviour

### 5.1 Effect classes

Add `effect: EffectClass` to `CanonicalCapability` (`cli/src/core/capabilities.ts:22-45`), alongside the existing `mutating` flag. `mutating` stays as the read-only-mode switch.

| Effect class | Examples | Read-only mode | Review mode | Auto mode |
|---|---|---|---|---|
| `read_workspace` | read_file, search_code, list_dir, git_status | allowed | allowed | allowed |
| `write_workspace` | write_file, edit_file, patch_file, delete_file | refused | ask | allowed |
| `exec` | run_command, run_tests, LSP server spawn, plugin and MCP tool calls | refused, except the confined read-only allowlist | ask | allowed under explicit auto mode regardless of folder trust |
| `egress` | fetch_web, search_web, browser_*, MCP remote tools | refused | ask | ask on the first call per origin per session, then allowed for that origin (DEC-01 option C) |
| `delegate` | spawn_subagent | allowed (the child inherits the parent mode) | allowed (the child is gated individually) | allowed |
| `context_inject` | activate_skill, manage_knowledge write | refused (write) | ask when the source is untrusted (see SPEC-03) | ask only when the source is untrusted; folder trust does not decide |

Each capability declaration must state its class. A unit test enumerates the registry and fails on any capability without a class. MCP and plugin tools registered at runtime default to `exec`.

### 5.2 Gate

In `cli/src/agent.ts:3945-3947`, replace `onConfirm && isMutating` with `policy.requiresDecision(cap.effect, context)`. `context` contains the permission mode, source trust, sandbox state and per-origin egress memory. Workspace trust is reported separately and never selects authority.

When no `onConfirm` handler exists (headless `nexus run`) and a decision is required, the call is DENIED with a typed reason. It is not silently allowed. `nexus run` keeps its current semantics only when `--yes` or `--mode auto` is explicit. The `nexus run --help` text must say so.

### 5.3 REPL approval

In `cli/src/repl.ts:270-276,353,385`:

1. Before asking, clear the readline line buffer: `rl.write(null, { ctrl: true, name: 'u' })` plus an internal "typed-ahead discarded" notice.
2. Drop keystrokes received in the 400 ms after the prompt is drawn. This is the same grace constant as the TUI (`live_state.rs`).
3. Change the prompt to `[y/N/d/a]`. Empty input means **No**. Only `y`/`yes` approves.
4. `a` (approve all for this session) requires a confirm line: `type 'all' to confirm`.

### 5.4 Read-only HOME masking

In `cli/src/sandbox.ts`, when the read-only domain is active, mount a tmpfs over `$HOME` and ro-bind only the workspace. When bwrap is not available, read-only mode must refuse `run_command` unless the command matches the read-only allowlist **and** every path argument resolves inside the workspace. Use the Rust jail through a `resolve_paths` RPC, or reject any argument containing `~`, `$` or an absolute path.

### 5.5 Denylist

Keep both implementations, rename them to "destructive-command tripwire" in UI and docs, and fix the false positives:

- `rm -rf ./x` and `rm -rf /tmp/x` must pass.
- `grep reboot` and `echo shutdown` must pass.

Do this by tokenizing the command with a shell-words parser instead of matching substrings. Add the bypass cases from C §4 R3 as **documented non-goals** in the test file. These are expected to pass through, which shows the test author knows the filter is not a boundary.

### 5.6 Startup banner

Line 1 of the TUI header and the REPL banner: `mode: review · sandbox: off · workspace: untrusted (nexus trust .)`. `nexus doctor` reports the same three facts.

## 6. Interfaces and state changes

- `CanonicalCapability.effect` is a new required field. The registry validates it at registration.
- `HarnessConfig.approvalMode: "auto" | "review" | "read-only"`. This replaces the boolean `autoApprove` flags in the REPL and sidecar. `--mode auto` selects auto with per-origin egress approval; `--yes` and `NEXUS_APPROVAL_MODE=auto` select full access and bypass egress approval too. `--approve` selects review and `--read-only` selects read-only.
- Sidecar protocol: `session.state` gains `posture { mode, sandbox, trusted }`. The Rust TUI renders it (`core/src/bin/nexus_tui/protocol.rs`). The new optional field is backward-compatible.
- Persisted sessions do **not** persist an approval mode. Resume uses the current launch posture. This avoids resurrecting authority, per PERS-004.

## 7. Compatibility and migration

- Unset approval mode defaults to review regardless of folder trust. Release notes and startup messaging must distinguish permission mode from folder trust. Use `--mode auto` for automatic writes and commands with per-origin egress approval; use `NEXUS_APPROVAL_MODE=auto` or `--yes` for full access.
- `nexus run` in CI and eval contexts (`eval/run.mjs`) must pass `--yes` explicitly. Update the eval adapters in the same PR.
- The test suites that assume auto default (`cli/test/harness.test.ts`, `sidecar*.test.ts`) must be updated to set the mode explicitly. This is a large but mechanical change.

## 8. Failure handling and security

- An unknown capability, or one without a class, is DENIED (fail closed).
- An approval handler error is DENIED with a reason. It is never treated as approved.
- Subagent calls go through the same gate. This is already true for `onConfirm` (`agent.ts:3609,5384`); keep it.
- The egress per-origin memory is in-memory only, and is cleared on `/mode` change and on resume.

## 9. Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Keep auto default and only document it | Contradicts REQ-SEC-101. Quickstart already says "review requested actions" (TUI-07). |
| Make the sandbox mandatory | bwrap is not available on all hosts (WSL, containers without userns), and Docker fallback is unpinned and networked (SEC-10). DEC-01 rejected it as the default (option B). |
| Mark egress tools `mutating: true` | Would make read-only mode refuse web search, which is a legitimate read-only research workflow. It conflates two axes. |
| Improve the denylist into a boundary | Not achievable with string matching. Approval or sandbox is the boundary. |

## 10. Acceptance criteria

| ID | Check | Type |
|---|---|---|
| ACC-SAFE-01 | Fresh HOME; run `nexus` and `nexus repl` in both trusted and untrusted fixture workspaces with explicit `--mode review` and `--mode auto`. A mock gateway calls `run_command "echo x > ../outside"`: review asks in both folders; auto permits according to the configured execution boundary in both folders. With no mode configured, both folders default to review. Trust affects only project instruction/integration loading. | PTY |
| ACC-SAFE-02 | Capability × mode matrix test: enumerate the registry. For each mode, the expected decision matches §5.1 for every capability, including MCP and plugin-registered tools. | unit |
| ACC-SAFE-03 | REPL PTY: lone Enter → DENIED. `y` typed before the prompt + Enter → DENIED. Paste `y\n` → DENIED. Deliberate `y` + Enter after 500 ms → APPROVED. | PTY (r1a/r1d scripts) |
| ACC-SAFE-04 | `--read-only` + `run_command "cat ~/.ssh/id_rsa"` with a fixture HOME → refused, or fails with "No such file" inside the masked home. | integration |
| ACC-SAFE-05 | Sandbox with workspace path `/tmp/a b/'q` → sandboxed `pwd` prints the path. | integration |
| ACC-SAFE-06 | Startup screen of both surfaces shows mode/sandbox/trust. Doctor JSON contains `posture`. | PTY + unit |
| ACC-SAFE-07 | Tripwire tests: the false-positive list passes, the documented bypass list is asserted as "not blocked (by design)". | unit |
| ACC-SAFE-08 | Existing `tui_approval_input_e2e` stays green. | PTY (CI) |
| ACC-SAFE-09 | Fixture repo whose `package.json` `scripts.test` writes a sentinel file. In review mode, the sentinel is not written until a verifier approval is given, and the approval panel shows `npm test` and the script body, regardless of folder trust. In auto mode, execution follows the configured permission mode regardless of folder trust. | integration + PTY |
| ACC-SAFE-10 | `/test` runs through the runner: Esc cancels it within 5 s, and in sandbox mode it runs inside bwrap (`/proc/self/mountinfo` probe). | PTY |

## 11. Dependencies and open decisions

- **DEC-01** is resolved as amended: review by default; explicit permission mode controls approvals independently of folder trust. Nothing in this spec is blocked by the decision.
- **DEC-02** is resolved: the REPL stays a supported secondary surface, so §5.3 is required.
- SPEC-03 provides the trust state for skills and knowledge (`context_inject`).
- SPEC-06 makes the TUI the packaged default, which reduces exposure to the REPL but does not remove it.
