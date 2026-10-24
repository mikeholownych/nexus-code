# Nexus Code Architecture

Nexus Code utilizes a split architecture designed for performance, modularity, and security:

```
┌─────────────────────────────────────────────────────────────┐
│                 TypeScript Orchestration Layer              │
│   • REPL / TUI Interface        • Agent Intelligence        │
│   • Skills Engine               • MCP JSON-RPC Client       │
│   • Plugin Lifecycle System     • Checkpoint & Undo Engine  │
│   • Secret Redactor             • Session Persistence       │
└──────────────────────────────┬──────────────────────────────┘
                               │ IPC / CLI Subprocess
┌──────────────────────────────▼──────────────────────────────┐
│                    Rust Core Engine (ELF)                   │
│   • Path Resolution Jail        • Ripgrep Fast Search       │
│   • Atomic File Ops             • AST Symbol Parser         │
│   • Patch / Diff Applicator     • Tree & Metadata Inspector │
│   • POSIX Command Runner        • Destructive Command Guard │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP / SSE Gateway
┌──────────────────────────────▼──────────────────────────────┐
│          OpenAI-compatible inference endpoint               │
│   • Local server: llama.cpp, vLLM, LM Studio, Ollama        │
│   • Optional gateway or cloud provider (operator-selected)  │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. Rust Core Engine (`core/`)

The core engine is implemented in Rust 2024 edition and compiled into an optimized 64-bit ELF binary (`harness-core`).
- **`file_ops.rs`**: Safe reading with 8 MB cap and paging hints (`offset`, `length`), writing, atomic replacement, metadata inspection (`file_info`), batch reading (`batch_read` with 8 MB cap per entry), unified patch application (`patch_file`), and path traversal prevention (`resolve_safe_path`).
- **`search.rs`**: Fast ripgrep search using `ignore` and `grep` crates, regex symbol extraction across multi-language ASTs, and Unicode file tree formatting (`file_tree`).
- **`runner.rs`**: Child process execution and process ownership tracking via `ProcessRegistry`. Tracks process group IDs (`pgid`) mapped to request IDs. Implements `cancel` RPC (`SIGTERM` then `SIGKILL` after 2s), PTY `pgid` killing, shutdown sweeps on stdin EOF, `SIGTERM`, `SIGHUP` and `SIGINT` with Linux `PR_SET_PDEATHSIG` parent-death cleanup, background services registry, bounded head/tail output ring buffers (RSS ≤ 64 MB for 400 MB output), timeout clamping to `NEXUS_MAX_TOOL_TIMEOUT_SECS`, and destructive pattern detection (`is_dangerous_command`).

---

## 2. TypeScript Orchestration Layer (`cli/`)

- **`AutonomousAgent` (`agent.ts`)**: Manages the iterative decision loop, token budgeting, prompt construction, and tool execution.
- **`InteractiveRepl` (`repl.ts`)**: Readline REPL with tab autocompletion, multiline input, direct shell escapes, and slash commands. Used when no terminal is attached, or with `nexus repl`.
- **`SidecarServer` (`sidecar.ts`)**: Runs the agent for the Rust live TUI (`core/src/bin/nexus_tui`), speaking NDJSON over stdio. The TUI owns all keyboard input, including approval input safety.
- **`LocalLlmClient` (`client.ts`)**: Streaming SSE OpenAI-compatible client with automatic auth token discovery and token rotation retry.
- **`CheckpointManager` (`checkpoint.ts`)**: Creates safe git and tree checkpoints before every turn and manages workspace rollbacks (`/undo`).
- **`McpClientManager` (`mcp.ts`)**: Stdio JSON-RPC 2.0 client connecting external MCP servers from `~/.config/nexus/mcp.json`.
- **`SkillManager` (`skills.ts`)**: Auto-discovers and dynamically loads `SKILL.md` documents on-demand.
- **`PluginManager` (`plugins.ts`)**: Lifecycle hook manager supporting `onTurnStart`, `onToolCall`, `onToolResult`, and custom tool registration.
- **`TerminalUI` (`ui.ts`)**: Formatted terminal output with live spinners, colored diffs, milestone plans, and secret scrubber.

---

## 3. Controls and their limits

Each control below is stated with what it does **not** cover. The v1.0.0 plan (`docs/v1.0.0/`) tracks the open gaps.

1. **Workspace path jail (file tools).** The Rust file tools (read, write, edit, delete, list, search) canonicalize every path against the workspace root and reject `..`, absolute paths and symlink escapes, rechecking the opened descriptor. *Limit:* for `run_command`, path protection is advisory. Host commands have the user's filesystem access unless the sandbox (`--sandbox`) or read-only HOME masking (`--read-only` with `bwrap`) is enabled.
2. **Destructive-command tripwire.** Shell-words tokenization in TypeScript (`cli/src/security.ts`) and Rust (`core/src/runner.rs`) stops obviously destructive commands (`rm -rf /`, `mkfs`, raw block device writes, fork bombs) without false positives on legitimate project commands (`rm -rf ./build`, `rm -rf /tmp/x`, `grep reboot`, `echo shutdown`, `chown -R me /srv`). *Limit:* this is explicitly a convenience tripwire to catch obvious mistakes, **not** a security boundary. Alternative invocations (`find / -delete`, `/bin/rm -rf /`, `rm -r -f /`, Python scripts) are documented non-goals that pass through by design. The sandbox (`--sandbox`) and approval posture (`review`) form the security boundary.
3. **Approvals and posture defaults.** Per amended DEC-01, unset permission mode defaults to `review` regardless of folder trust. `--mode auto` permits writes and commands while retaining first-use egress approval per origin; `--yes` and `NEXUS_APPROVAL_MODE=auto` enable full access and bypass approval prompts, including egress. Folder trust only controls project instructions and workspace integrations. Input safety is strictly enforced across surfaces (REQ-SEC-103): lone Enter defaults to No, a 400ms grace period discards typed-ahead input, and approve-all requires explicit confirmation (`all` in REPL, confirmation Enter in TUI). *Limit:* in explicit `auto` posture, commands and file writes execute autonomously regardless of folder trust.
4. **Workspace trust.** Trust is managed via `nexus trust` and stored in `~/.config/nexus/trusted_workspaces.json`; interactive startup asks for trust before loading project instructions (`AGENTS.md`, `CLAUDE.md`, `CODEX.md`, `.nexusrules`). In untrusted workspaces, project instructions, workspace MCP configs, plugins, skills, and `.nexus/knowledge.json` are not loaded (REQ-SEC-113, REQ-SEC-114). The operator may continue without trust under the existing permission mode or exit. *Limit:* configuration in the operator's home directory (`~/.config/nexus/`, `~/.nexus/`) is always trusted.
5. **Secret redaction.** Terminal output, audit logs and durable state pass through pattern-based scrubbers, and outbound content is classified and tokenized. *Limit:* it is pattern-based, so secrets with no recognizable shape are not detected.
6. **Container sandbox and argv isolation.** `--sandbox` confines execution using Linux Bubblewrap (`bwrap`) or Docker. The sandbox argv is constructed as a direct array without shell wrapping (REQ-SEC-109), preventing shell escaping flaws on complex workspace paths. In `--read-only` mode, `$HOME` is mounted as `--tmpfs $HOME`, completely masking SSH keys and dotfiles from commands (REQ-SEC-104); without bwrap, strict path confinement rejects paths outside the workspace. *Limit:* full container sandboxing requires `bwrap` or Docker on the host.
7. **Process group lifecycle and residual setsid escape risk.** The runner registers child process groups at spawn and terminates entire groups (`killpg`) on turn cancel, client crash, or process shutdown (REQ-AGT-109, REQ-SEC-106). Background services explicitly registered survive turn cancel but are cleaned on client exit. *Limit:* commands that explicitly invoke `setsid()` or create a new session ID escape the process group boundary unless Bubblewrap (`--sandbox`) or Docker isolation is enabled (`bwrap` uses `--die-with-parent` and PID namespaces to guarantee all descendants are swept). Documented residual risk: in unsandboxed mode, processes that detach with `setsid()` will outlive cancel sweeps.

## Compaction and continuity

Long-task continuity (no step ceiling, state-aware repetition, objective-scoped execution tracking), the durable
compaction commit, queued operator `/compact`, and optional provider capabilities with labelled token accounting are
described in `docs/COMPACTION_AND_CONTINUITY.md`.
