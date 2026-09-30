# Nexus Code User Manual

Welcome to **Nexus Code**, a local-first, autonomous, and interactive AI coding harness engineered for direct parity with OpenAI Codex and Anthropic Claude Code. Nexus Code connects to local inference servers (vLLM, LM Studio) and executes inside a native Linux shell environment.

---

## 1. Quick Start

### Starting the Interactive REPL / TUI
To launch the interactive coding environment in the current workspace:
```bash
nexus
# or
harness repl
```

To launch with human approval required before changes are written:
```bash
nexus --approve
```

To resume your latest session:
```bash
nexus -r
# or resume a specific session by ID:
nexus -r sess_1727668541234
```

### Running Autonomous Non-Interactive Tasks
To run a one-off objective and exit automatically when verified:
```bash
nexus run "Refactor the authentication handler to support JWT rotation and add unit tests"
```

### Viewing Tool Audit Logs
To inspect recent tool executions, filter errors, or track latency:
```bash
nexus audit --limit 20
nexus audit --errors
nexus audit --tool run_command
```

### Exposing Nexus Tools via Model Context Protocol (MCP)
To expose Nexus Code's native Rust tools to external LLM clients (Claude Desktop, Cursor, Zed):
```bash
nexus serve-mcp --workspace /path/to/project
```
See [MCP_GUIDE.md](file:///home/mike/nexus-code/docs/MCP_GUIDE.md) for full configuration details.

---

## 2. Interactive REPL / TUI Features

### Command Autocompletion
Press `<TAB>` at any prompt to autocomplete slash commands and directory paths.

### Multiline Input
- Enter triple quotes (`"""`) or triple backticks (` ``` `) to open a multiline input block. Complete the block by closing with `"""` or ` ``` `.
- Alternatively, end any line with a trailing backslash (`\`) to continue on the next line.

### Direct Shell Execution (`!`)
Run raw bash/zsh commands instantly inside the active workspace without invoking the LLM:
```text
nexus (engineering/b0) my-app ❯ !git status
nexus (engineering/b0) my-app ❯ !cargo check
nexus (engineering/b0) my-app ❯ !npm test
```

### Slash Commands Cheatsheet

| Command | Description |
| :--- | :--- |
| `/help` | Display cheatsheet of all available commands |
| `/status` | View active model, endpoint, shell, and git badge |
| `/plan [add\|done\|start\|clear]` | Formulate and manage multi-phase milestone execution plan |
| `/tui` | Launch full-screen interactive TUI dashboard with split-pane view |
| `/theme [name]` | View or switch terminal color theme (Catppuccin, Nord, Dracula, etc.) |
| `/team <role\|full> <task>` | Orchestrate multi-agent team (Researcher, Architect, Implementer, Tester) |
| `/image <path> [prompt]` | Ingest multi-modal image / screenshot into vision model context |
| `/checkpoint [name]` | Create a safe rollback snapshot of the workspace |
| `/checkpoint diff <id>` | View file diff between current workspace and a checkpoint |
| `/checkpoint prune [keep]` | Prune older checkpoints, retaining the latest N (default: 5) |
| `/checkpoints` | List all saved workspace rollback snapshots |
| `/undo` | Roll back workspace changes to the last checkpoint |
| `/diff` | Display colored syntax-highlighted git diff |
| `/git` | Show uncommitted files and git status |
| `/commit [msg]` | Generate or execute Conventional Commit from staged changes |
| `/audit [count]` | Inspect visual tool execution audit trail (recent N entries) |
| `/compact [--llm]` | Distill earlier conversation into structured memory to preserve context |
| `/mode [auto\|review]` | Toggle autonomous execution vs human approval before edits |
| `/sessions` | List saved past sessions |
| `/save [name]` | Save current conversation session to `~/.nexus/sessions/` |
| `/resume [id]` | Resume an existing session |
| `/export [md\|json]` | Export session conversation transcript to a file in workspace |
| `/skills` | List discovered agent skills (`SKILL.md`) |
| `/skill [init <name>\|<name>]` | Scaffold new skill template or inspect full instructions |
| `/mcp [add\|resources\|prompts]` | Manage MCP servers, tools, resources, and prompt templates |
| `/plugins` | List loaded custom plugins and lifecycle hooks |
| `/tokens` | Display visual BPE token accounting gauge and context breakdown |
| `/onboard` | Scan workspace tech stack and generate customized `AGENTS.md` & diagram |
| `/test [filter]` | Auto-detect and run test suite with compiler diagnostic parsing |
| `/init` | Scaffold `AGENTS.md` project rules file |
| `/model [name]` | Inspect or switch active model |
| `/shell [bash\|zsh]` | Switch execution shell |
| `/cd <path>` | Switch active workspace directory |
| `/history [query\|!n]` | Fuzzy history search or re-execute item by index |
| `/copy [diff\|code\|last]` | Copy diff, code blocks, or response to system clipboard |
| `/paste` | Paste clipboard content into prompt |
| `/exit` or `/quit` | Exit session cleanly |

---

## 3. High-Efficiency Tooling Parity

Nexus Code provides high-performance tools executed via compiled native 64-bit Rust ELF, persistent JSON-RPC stdio daemon, and async Tokio runtime:

1. **`read_file`**: Read file lines with line numbering and range slices using zero-copy `memmap2`.
2. **`batch_read`**: Read multiple files in parallel in a single turn.
3. **`file_tree`**: Render directory tree hierarchy respecting `.gitignore`.
4. **`file_info`**: Inspect file size, permissions, line count, binary status, and modified timestamps.
5. **`edit_file`**: Precise search-and-replace using unique snippet matching with fuzzy recovery.
6. **`patch_file`**: Apply standard unified diffs and patch hunks.
7. **`search_code`**: Multi-threaded ripgrep code search across workspace.
8. **`trigram_search`**: Ultra-fast code search accelerated by Rust inverted trigram index.
9. **`search_symbols`**: AST-level symbol search for function, struct, interface declarations.
10. **`cst_symbols`**: Concrete Syntax Tree parser extracting multiline signatures, doc comments, visibility, and scopes.
11. **`git_status`**: Native repository status (branch, clean/dirty, staged, modified, untracked) via `git2`.
12. **`git_diff`**: Native unified diff generation via `git2`.
13. **`git_log`**: Native commit history retrieval via `git2`.
14. **`run_command`**: Execute commands with non-blocking pipes, safety guards, and PTY pseudo-terminal support.
15. **`run_tests`**: Auto-detect and run project test suites with structured failure parsing and compiler diagnostics.
16. **`lsp_hover`**: Query Language Server Protocol hover documentation and type signatures.
17. **`lsp_definition`**: Query LSP symbol definition locations.
18. **`lsp_diagnostics`**: Query LSP compiler diagnostics and inline errors.
19. **`search_web`**: Technical web search engine for API documentation and solutions.
20. **`update_plan`**: Maintain multi-phase milestone tracking.
21. **`spawn_subagent`**: Delegate subtasks to isolated sub-agents.
22. **`activate_skill`**: Load specialized agent knowledge into context dynamically.
23. **`fetch_web`**: Outbound HTTP scraper with SSRF protection and allowed domain filtering.
24. **`task_completed`**: Finalize turn with comprehensive report.

---

## 4. Safety, Compliance & Resilience

- **Workspace Symlink Boundary Confinement**: Native Rust canonicalization verifies that neither relative paths nor symlinks can escape the workspace jail directory.
- **Configurable Security Policy (`.nexus-security.json`)**: Declare repository-specific blocked shell commands, protected files (`.git`, `.env`, keys), and allowed outbound network domains.
- **Dry-Run & Read-Only Modes**:
  - `--dry-run`: Intercepts file writes and mutating commands to simulate changes without touching disk.
  - `--read-only`: Rejects all file modifications and non-read shell commands with an immediate error.
- **Lightweight Container Sandboxing (`--sandbox`)**: Restricts filesystem mutation strictly to the target workspace using Linux Bubblewrap (`bwrap`) or Docker isolation.
- **Worker Thread Plugin Sandboxing**: Untrusted or custom plugin handlers execute in isolated Node.js `worker_threads` with strict timeout boundaries and memory caps.
- **Pseudo-Terminal (PTY) Allocation**: Commands requiring TTY capabilities run inside allocated virtual pseudo-terminals via `portable-pty`.
- **Multi-Provider Failover**: Specify secondary fallback endpoints via `--fallback <url1,url2>` or `$LOCAL_LLM_FALLBACK_ENDPOINTS`. Automatic failover occurs if the primary LLM server drops connection or runs out of GPU VRAM (HTTP 503).
- **BPE Token Accounting & Context Gauge**: Real-time token breakdown across system instructions, tools schema, user messages, assistant thinking, and tool output payloads with visual ANSI progress gauge.
- **Structured Context Compaction**: `/compact` distills discarded messages into structured memory (files touched, commands run, architectural decisions) instead of discarding context blindly.
- **Dynamic Few-Shot Injection**: Context-aware injection of valid tool exemplars (edits, test repair, batch reads) tailored to the active task, eliminating tool hallucination in local models (Qwen 2.5, DeepSeek Coder).
- **Dangerous Command Guard**: Blocks destructive commands (`rm -rf /`, `mkfs`, raw device writes, fork bombs) from executing.
- **SSRF Network Protection**: Blocks outbound access to loopback (`127.0.0.1`), cloud metadata (`169.254.169.254`), and private RFC-1918 subnets in `fetch_web`.
- **Non-Blocking Pipe Execution**: Drains stdout and stderr concurrently to prevent 64KB Linux buffer saturation deadlocks during intensive builds.
- **Secret Redaction**: Redacts Bearer tokens, private keys, and passwords before printing or logging.
- **Audit Logging**: Every tool execution is recorded with timestamps, parameters, duration, and status in `~/.nexus/audit.log`. Visual inspection available via `/audit` and `nexus audit`.
- **Workspace Snapshots & Rollback**: Automatic Git-backed and filesystem snapshot rollback. Inspect diffs anytime with `/checkpoint diff <id>`, and manage disk footprint with `/checkpoint prune [keep]`.
- **Real-Time Hot-Reloading**: Automatically detects edits or additions in `skills/` and `AGENTS.md` and reloads them dynamically without restarting the REPL.
