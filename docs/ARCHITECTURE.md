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
│                  Local Inference Hardware                   │
│   • vLLM / LM Studio Gateway (port 18010/v1)                │
│   • Dual Intel Arc A770 XPUs (engineering/b0 model)         │
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
- **`InteractiveRepl` (`repl.ts`)**: TUI terminal interface with tab autocompletion, multiline input, direct shell escapes, and slash commands.
- **`LocalLlmClient` (`client.ts`)**: Streaming SSE OpenAI-compatible client with automatic auth token discovery and token rotation retry.
- **`CheckpointManager` (`checkpoint.ts`)**: Creates safe git and tree checkpoints before every turn and manages workspace rollbacks (`/undo`).
- **`McpClientManager` (`mcp.ts`)**: Stdio JSON-RPC 2.0 client connecting external MCP servers from `~/.config/nexus/mcp.json`.
- **`SkillManager` (`skills.ts`)**: Auto-discovers and dynamically loads `SKILL.md` documents on-demand.
- **`PluginManager` (`plugins.ts`)**: Lifecycle hook manager supporting `onTurnStart`, `onToolCall`, `onToolResult`, and custom tool registration.
- **`TerminalUI` (`ui.ts`)**: Formatted terminal output with live spinners, colored diffs, milestone plans, and secret scrubber.

---

## 3. Extensibility & Security Boundaries

1. **Workspace Path Jail**: All file operations canonicalize paths against the root workspace directory. Traversal outside the root or requests targeting sensitive system directories (`/etc/shadow`, `~/.ssh`) are rejected with `Security Violation`.
2. **Dangerous Command Filter**: Shell commands are analyzed for destructive signatures (`rm -rf /`, `mkfs`, raw device writes, fork bombs) and prevented before child execution.
3. **Secret Redaction**: Terminal outputs and audit logs are filtered through regular expression scrubbers that mask Bearer tokens, private keys, passwords, and API credentials.
4. **Audit Trail**: Every tool invocation is permanently recorded in `~/.nexus/audit.log`.
