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

For worktree-isolated runs, automatic merge requires an explicitly trusted verifier command. Configure it with `--authoritative-verifier "make test"` (or the corresponding `authoritativeVerifierCommand` in `HarnessConfig`). Automatically discovered test commands can still provide diagnostic evidence, but success alone does not authorize merging a worktree.

### Turn outcomes and exit codes

Every turn returns one structured result with three independent dimensions (`cli/src/core/turn.ts`):

| Dimension | Values |
| :--- | :--- |
| `execution` | `COMPLETED`, `INTERRUPTED`, `FAILED`, `BLOCKED`, `LIMIT_REACHED` |
| `outcome` | `VERIFIED` (selected verifier ran and passed), `UNVERIFIED` (changes made, not verified; see `reason`, e.g. `NO_APPLICABLE_VERIFIER`, `VERIFICATION_NOT_RUN`), `NOT_ESTABLISHED`, `NOT_REQUIRED` (no workspace change) |
| `acceptance` | `NOT_REQUESTED` (Nexus never sets `ACCEPTED`) |

A model that stops calling tools has only stopped; it has not demonstrated anything. `harness run` exits **0** for verified or nothing-to-verify completion, **2** for completed-but-unverified, **130** when interrupted, and **1** for failure, blocked, step-limit or unverified-verifier-failure. `--json` output carries the full `turn` object and `exitCode`.

Ctrl-C while a turn is running requests cancellation: no new inference request or tool dispatch is admitted, and a tool that is already executing is awaited (it cannot be force-stopped). A second Ctrl-C terminates immediately. At an idle prompt Ctrl-C exits the REPL.

### Legacy readline REPL (`harness --repl`)

The default interface is the live TUI, which has a real multi-line composer. The legacy REPL reads one line at a time: lines that arrive together with a prompt (a multi-line paste, piped input) or while a turn is running cannot become prompts. They are not silently dropped: the REPL prints how many lines were ignored and the first one. To submit multi-line input there, wrap it in `"""` … `"""` (or ```` ``` ````), or use the TUI.

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

Cloud destinations and credentials are the exception: only CLI flags, the operator's own environment and
`~/.config/nexus/config.env` can select a cloud provider (`--provider`, `NEXUS_PROVIDER`) or decide where a stored
credential is sent. A project `.env` cannot.

## ☁️ Cloud Providers (opt-in)

The appliance stays the default. OpenRouter, OpenAI (Responses), Anthropic (Messages) and any OpenAI-compatible
service can be selected explicitly, each with its own key:

```bash
nexus providers                                              # providers, credential status, destinations
nexus providers verify --provider anthropic --model <id>     # live completion + tool round trip, no workspace content
nexus run --provider openrouter --model anthropic/claude-sonnet-4.5 "..."
```

See [docs/CLOUD_PROVIDERS.md](docs/CLOUD_PROVIDERS.md) for setup, disclosure rules, roles, limits and receipts.
