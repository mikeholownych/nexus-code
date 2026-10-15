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
- **`file_ops.rs`**: Safe reading, writing, atomic replacement, metadata inspection (`file_info`), batch reading (`batch_read`), unified patch application (`patch_file`), and path traversal prevention (`resolve_safe_path`).
- **`search.rs`**: Fast ripgrep search using `ignore` and `grep` crates, regex symbol extraction across multi-language ASTs, and Unicode file tree formatting (`file_tree`).
- **`runner.rs`**: Child process execution with strict timeouts, buffer truncations, and destructive pattern detection (`is_dangerous_command`).

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

1. **Workspace path jail (file tools).** The Rust file tools (read, write, edit, delete, list, search) canonicalize every path against the workspace root and reject `..`, absolute paths and symlink escapes, rechecking the opened descriptor. *Limit:* it does not apply to `run_command`. A shell command runs with the user's full filesystem access unless the sandbox (`--sandbox`) is enabled.
2. **Destructive-command tripwire.** Two substring denylists (TypeScript and Rust) stop some obviously destructive commands (`rm -rf /`, `mkfs`, fork bombs). *Limit:* this is a convenience tripwire, not a security boundary. Trivial rewrites bypass it, and it also blocks some legitimate commands. Approvals (`--approve`) and the sandbox are the boundary.
3. **Approvals.** In review mode (`--approve`), tools that change the workspace or run commands ask first. *Limit:* the default mode does not ask. Network tools (`fetch_web`, `search_web`, browser) and verifier runs started by Nexus itself do not ask, even in review mode. See `docs/v1.0.0/specs/SPEC-01-safe-execution-defaults.md`.
4. **Workspace trust.** Workspace MCP configs and plugins load only after `nexus trust`, and never in `--read-only`. *Limit:* workspace skills and `.nexus/knowledge.json` are not yet gated by trust.
5. **Secret redaction.** Terminal output, audit logs and durable state pass through pattern-based scrubbers, and outbound content is classified and tokenized. *Limit:* it is pattern-based, so secrets with no recognizable shape are not detected.
6. **Audit trail.** Tool invocations are recorded in `~/.nexus/audit.log`. *Limit:* there is no rotation or retention policy yet, and the file is created with default permissions.

## Compaction and continuity

Long-task continuity (no step ceiling, state-aware repetition, objective-scoped execution tracking), the durable
compaction commit, queued operator `/compact`, and optional provider capabilities with labelled token accounting are
described in `docs/COMPACTION_AND_CONTINUITY.md`.
