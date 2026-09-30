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
| `/plan` | Render the current multi-phase execution plan |
| `/checkpoint [name]` | Create a safe rollback snapshot of the workspace |
| `/checkpoints` | List all saved workspace rollback snapshots |
| `/undo` | Roll back workspace changes to the last checkpoint |
| `/diff` | Display colored syntax-highlighted git diff |
| `/git` | Show uncommitted files and git status |
| `/compact` | Condense earlier conversation messages to preserve token budget |
| `/mode [auto\|review]` | Toggle autonomous execution vs human approval before edits |
| `/sessions` | List saved past sessions |
| `/save [name]` | Save current conversation session to `~/.nexus/sessions/` |
| `/resume [id]` | Resume an existing session |
| `/export [md\|json]` | Export session conversation transcript to a file in workspace |
| `/skills` | List discovered agent skills (`SKILL.md`) |
| `/skill <name>` | Inspect full instructions of a specialized skill |
| `/mcp` | List connected MCP servers and external tools |
| `/plugins` | List loaded custom plugins and lifecycle hooks |
| `/tokens` | Display token usage stats and memory message count |
| `/init` | Scaffold `AGENTS.md` project rules file |
| `/model [name]` | Inspect or switch active model |
| `/shell [bash\|zsh]` | Switch execution shell |
| `/cd <path>` | Switch active workspace directory |
| `/history` | Show recent prompt history |
| `/exit` or `/quit` | Exit session cleanly |

---

## 3. High-Efficiency Tooling Parity

Nexus Code provides high-performance tools executed via compiled native 64-bit Rust ELF:

1. **`read_file`**: Read file lines with line numbering and range slices.
2. **`batch_read`**: Read multiple files in parallel in a single turn.
3. **`file_tree`**: Render directory tree hierarchy respecting `.gitignore`.
4. **`file_info`**: Inspect file size, permissions, line count, binary status, and modified timestamps.
5. **`edit_file`**: Precise search-and-replace using unique snippet matching.
6. **`patch_file`**: Apply standard unified diffs and patch hunks.
7. **`search_code`**: Multi-threaded ripgrep code search across workspace.
8. **`search_symbols`**: AST-level symbol search for function, struct, interface declarations.
9. **`run_command`**: Execute bash/zsh commands with timeouts and safety guards.
10. **`update_plan`**: Maintain multi-phase milestone tracking.
11. **`spawn_subagent`**: Delegate subtasks to isolated sub-agents.
12. **`activate_skill`**: Load specialized agent knowledge into context dynamically.
13. **`task_completed`**: Finalize turn with comprehensive report.

---

## 4. Safety & Compliance
- **Workspace Path Jail**: Restricts file operations to workspace directory; prevents path traversal (`../`) or accessing `/etc/shadow`, `/root`, `~/.ssh`.
- **Dangerous Command Guard**: Blocks destructive commands (`rm -rf /`, `mkfs`, raw device writes, fork bombs) from executing.
- **Secret Redaction**: Redacts Bearer tokens, private keys, and passwords before printing or logging.
- **Audit Logging**: Every tool execution is recorded with timestamps, parameters, duration, and status in `~/.nexus/audit.log`.
