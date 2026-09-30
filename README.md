# Nexus Code: Local AI Coding Harness & TUI

> An autonomous & interactive software engineering harness comparable to **OpenAI Codex CLI** and **Anthropic Claude Code**, engineered specifically for **local LLMs** (vLLM, LM Studio) on **Linux** using **Rust + TypeScript**.

---

## ⚡ Core Highlights

| Feature | Nexus Code | Codex / Claude Code Equivalent |
| :--- | :--- | :--- |
| **Interactive REPL & TUI** | Default interactive prompt with model/git status badges | `claude` / `codex` interactive terminal |
| **Autonomous Multi-Step Agent** | Multi-turn ReAct loop with self-correcting error recovery | `claude -p "..."` / `codex exec` |
| **Human Review / Approval Mode** | Colorized unified diff preview before modifying files | Claude Code interactive permission prompts |
| **Project Memory & Rules** | Automatically loads `AGENTS.md`, `CLAUDE.md`, or `CODEX.md` | Claude Code Memory (`CLAUDE.md`) |
| **Git Repository Intelligence** | Live branch and uncommitted change indicators in prompt | Git status context awareness |
| **Persistent Prompt History** | Arrow-key navigation saved across sessions to `~/.nexus_history` | Readline / shell history |
| **Context Compaction** | `/compact` command to prune history and retain token headroom | Claude Code `/compact` |
| **Engine Speed** | Rust-powered Ripgrep search, safe diff patcher, and file finder | Native Ripgrep / AST engine |

---

## 🏗️ Architecture

```
                  ┌───────────────────────────────────────────────┐
                  │    Interactive REPL  OR  Single-Shot CLI      │
                  │   nexus (engineering/b0) [my-app:main*1] ❯    │
                  └───────────────────────┬───────────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────┐
                         │   TypeScript Autonomous Agent   │
                         │   • Slash Commands (/compact)   │
                         │   • Project Rules (AGENTS.md)   │
                         │   • Hybrid Tool Extractor       │
                         │   • Approval Mode (Y/N/Always)  │
                         └───────────────┬─────────────────┘
                                         │
                 ┌───────────────────────┴───────────────────────┐
                 │                                               │
                 ▼                                               ▼
      ┌────────────────────┐                          ┌────────────────────┐
      │  Local LLM Server  │                          │  Rust Core Engine  │
      │ (vLLM / LM Studio) │                          │   (harness-core)   │
      └──────────┬─────────┘                          └──────────┬─────────┘
                 │                                               │
                 │ 1. OpenAI /v1 protocol                        │ 2. Ripgrep search_code
                 │ 2. Streaming inference                        │ 3. Fast find_files glob
                 │ 3. Fallback XML/JSON parsing                  │ 4. Fuzzy diff edit_file
                 │                                               │ 5. Native Linux shell
                 │                                               │
                 └───────────────────────┬───────────────────────┘
                                         │
                                         ▼
                         ┌─────────────────────────────────┐
                         │  Target Workspace & Filesystem  │
                         └─────────────────────────────────┘
```

---

## 🚀 Quick Start

### 1. Interactive Session (REPL / TUI)
Simply run `harness` (or `nexus`) from any directory or git repository:
```bash
harness
```
*Prompt:*
```
╔════════════════════════════════════════════════════════════════╗
║           NEXUS CODE HARNESS - CODEX / CLAUDE-CODE REPL        ║
╚════════════════════════════════════════════════════════════════╝
Type your prompt or task, or type /help for slash commands.

Session Status:
  • Workspace:   /home/mike/Projects/my-app (my-app) [git: main *2]
  • Model:       engineering/b0
  • Endpoint:    http://127.0.0.1:18010/v1
  • Shell:       bash
  • Mode:        auto (autonomous execution)
  • Context:     1 messages in memory

nexus (engineering/b0) my-app:main*2 ❯ 
```

### 2. Autonomous Single-Shot Mode
To run a specific task and exit:
```bash
harness run "Inspect the project, write comprehensive unit tests, and verify with cargo test"
```

---

## 🎮 Slash Commands Cheatsheet

Inside the interactive REPL:

| Command | Action |
| :--- | :--- |
| **`/help`** | Display command cheatsheet and usage tips |
| **`/status`** | View active model, endpoint, workspace, and git state |
| **`/clear`** | Clear conversation context memory and start fresh |
| **`/compact`** | Condense earlier messages to keep context window fresh |
| **`/mode`** | Toggle between `auto` (autonomous) and `review` (confirm actions) |
| **`/git`** | Show `git status` and changed files |
| **`/init`** | Generate an `AGENTS.md` file in the current workspace |
| **`/model`** | View active model or list/switch loaded models from vLLM |
| **`/shell`** | Switch execution shell (`bash` vs `zsh`) |
| **`/cd <dir>`** | Switch active workspace directory without exiting |
| **`/history`** | Display recent prompt history from `~/.nexus_history` |
| **`/exit`** / **`/quit`** | Exit interactive session |

---

## 🛡️ Human-in-the-Loop Review Mode

By default, the harness operates in `auto` mode. To require confirmation before files are written or shell commands are executed:

Launch with approval mode:
```bash
harness --approve
```
Or switch dynamically inside the REPL:
```bash
nexus ❯ /mode review
```

When the model proposes a file edit:
```
⚠️  Action Approval Required:
  Target: src/auth.rs
  Snippet to replace:
    pub fn verify_password(hash: &str, password: &str) -> bool
  Replacement:
    pub fn verify_password(hash: &str, password: &str) -> Result<bool, AuthError>
  Approve [y]es, [n]o, [a]lways allow session? [Y/n/a]: 
```

---

## 🛠️ Tool Suite (Rust Accelerated)

1. **`read_file`**: Read file lines with 1-indexed line numbers and range slicing.
2. **`write_file`**: Atomically create or overwrite files.
3. **`edit_file`**: Safe search-and-replace patch engine with **whitespace & newline normalization** and unified diff generator.
4. **`delete_file`**: Safe file or directory removal.
5. **`list_dir`**: Rapid `.gitignore`-aware directory explorer.
6. **`find_files`**: Fast glob/substring file locator (e.g. `*.rs`, `**/*.tsx`).
7. **`search_code`**: Ripgrep-speed regex and literal text searching across the codebase.
8. **`run_command`**: Native Linux shell runner (`bash`, `zsh`) with real-time output capture, timeout enforcement, and buffer protection.
9. **`task_completed`**: Marks task completion with structured summary and notes.

---

## ⚙️ Configuration Hierarchy

Settings are loaded with the following precedence:
1. **CLI Flags** (`-e`, `-m`, `-w`, `--shell`, `--approve`)
2. **Current Directory** (`.env` in current workspace)
3. **Global User Config** (`~/.config/nexus/config.env`)
4. **Installation Defaults** (`/home/mike/nexus-code/cli/.env`)
