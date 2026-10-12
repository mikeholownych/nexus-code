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

### Live TUI: activity, steering, paste buffers and diffs

- **Activity line.** While the agent works, the line above the composer animates (`⠋ thinking · 0:42 · step 31 of
  300 · segment 2`) from the clock, not from model output, and names the phase: thinking, the running tool and its
  subject, waiting for the provider, verifying, compacting. The step budget is always shown; the time limit appears
  (`12 min left`) in its last quarter or last 15 minutes. It stops on completion, cancellation, failure or
  disconnection; an approval request replaces it with the approval hint. Lines too long for the window end in `…`.
- **Transcript.** Replies are rendered Markdown: headings, emphasis, inline code, lists with hanging indents, block
  quotes, fenced code in a gutter block with syntax colours (long lines wrap onto rows marked `↪`), and tables
  aligned in columns (listed row by row when too wide). Each model reply is its own paragraph; when Nexus asks the
  agent to continue on its own (open requirements, a repeated action), a quiet line says so. Commands show their exit
  code and line count, the exact number of earlier lines not shown (`… 115 earlier lines`) and the last 6 lines; Tab, `[`/`]` and
  Enter open the full record. Tools that took noticeable time show their duration. A pasted prompt shows the text that
  was sent under its `[Pasted text #n]` label.
- **Outcomes.** A turn ends with one line in words — `Done`, `Done · verified`, `Done · not verified`, `Verification
  failed`, `Requirements still open` (with the open items), `Cancelled`, `Stopped at …` (a budget), `Model request
  failed`, `Context is full` — the cause, and the next action; `v` opens the receipt with the raw fields.
- **Scrolling.** Scrolled back, the view stays where you are while output arrives; the badge then says `new output`.
  PgDn or Ctrl+End returns to the newest line.
- **Status.** The top line shows identity only: workspace, branch with the number of changed files (`●3 changed`),
  model, mode (`review mode` in review mode) and the session id (what `/resume` takes), dropping the least important
  on narrow terminals. Activity is shown once, on the composer line.
- **Composer.** An empty composer says what Enter does (send, or steer while the agent works); a draft taller than
  six rows shows `line n of m`. Drafts are kept while panels are open and across a sidecar crash.
- **Approvals.** A panel sized to its content states what is proposed and on which target (`Proposed: create
  config.json · +1 −0`), shows file changes with the diff view, and offers three buttons — Approve (`y`), Approve all
  later actions (`a`), Deny (`n`). Nothing is focused at first, so Enter alone decides nothing; ←/→ choose a button
  (marked `▸`) and Enter takes it. `a` only selects "approve all later actions"; Enter confirms it. A decision key
  counts only once the panel has been on screen briefly **and** you have paused typing (about half a second): keys
  typed before the panel appeared or in the middle of typing, bursts and pastes never answer it; Esc denies once the
  panel has been shown. The panel is not answerable until its change is visible — on a window too small to show it,
  it asks you to enlarge the terminal. An approval that arrives while another panel (help, a diff review) is open
  waits behind it; the composer line says so, and it opens when you close that panel.
- **Recovery.** If the agent sidecar stops, the screen names the exit code or signal, keeps the last relevant
  diagnostic lines (progress chatter is dropped) and your draft; `r` starts a new agent, after which `/resume` reloads
  the saved conversation. Resuming (`-r` or `/resume`) shows the earlier conversation under a divider: your prompts,
  steering, the agent's replies, the tools it called (`· Read src/cache.ts`), and how the last turn ended. Diagnostics
  from turns that already finished are not shown as the cause of a later stop. Enter pressed while the agent is still
  starting sends the draft once it is ready.
- **Steering.** Enter while the agent works sends the draft as steering. It shows in the transcript as
  `↳ text · steering · queued`, then `applied` once the agent takes it at its next step. Steering that arrives as
  the turn finishes starts a follow-up turn; steering that cannot be applied (the turn was cancelled, a command was
  running, the agent stopped) is put back into the composer. Slash commands wait for idle, except read-only `/doctor`,
  `/help` and `/receipt`.
- **Paste buffers.** A multi-line or long paste becomes `[Pasted text #1: 24 lines]` in the composer; its content is
  submitted exactly as pasted (newlines in it never send, and a pasted `/exit` is text). Ctrl+O shows a buffer,
  Ctrl+X turns it back into editable text, Backspace after it removes it. Terminals without bracketed paste: a burst
  of keys with a line break inside it is treated as a paste.
- **File diffs.** Each successful edit replaces its tool line with a card: `✓ Edited src/a.ts  +3 −1` (`Created`,
  `Deleted`), then up to 14 diff lines in a block marked by a gutter bar — aligned old/new line numbers (blank where a
  number does not apply), an explicit `+`/`−` marker, the content with tabs expanded to 4-column stops and syntax
  colours, on a muted green (added) or red (removed) background that spans the row; unchanged lines stay neutral.
  Hunks are separated by `⋯ N unchanged lines`, a file without a final newline is marked `\ no newline at end of
  file` under the line concerned, and long lines wrap with a faint repeated marker. A longer diff ends with the exact
  count of what is not shown and the control that opens it: `… 48 more lines in 1 more hunk · ctrl+d to review`.
  The diff is the operation's own before/after, so uncommitted changes that were already in the file are never
  attributed to the agent; a failed edit shows its error (`× Edit a.ts — …`) and never a change. Binary, oversized
  (over 2 MB) or unreadable files say so instead of showing lines. Control characters in file content are shown as
  visible stand-ins (`␛` for ESC, `␍` for CR, `<U+202E>` for direction overrides), never sent to the terminal.
- **Reviewing a complete diff.** Ctrl+D opens the selected edit (or the newest one, or the newest `/diff`) in a
  full panel: `n`/`p` next/previous hunk, `]`/`[` next/previous edit (files, for `/diff`), arrows or `j`/`k` and
  PgUp/PgDn to scroll, `←`/`→` to pan long lines (`‹`/`›` mark clipped content, `0` returns to the start), `w` to wrap
  instead, `i` for the edit's tool-call record, Esc to return — the transcript position and the draft in the composer
  are kept. Enter on a selected edit (Tab, then `[`/`]`) opens it too. The panel says which diff it is: `Edit diff ·
  this operation only` (with `edit 3 of 8`) or `Workspace diff · unstaged changes to tracked files (git diff)`, which
  includes changes not made in the session. Every operation's complete diff is also written, redacted, to
  `~/.nexus/sessions/<session>.diffs/` (mode 0600); when a diff is larger than the 256,000 characters kept in memory,
  the panel says how much it shows and names that file.
- **What diffs cover.** File-edit tools (`write_file`, `edit_file`, `patch_file`, `delete_file`) get per-operation
  diffs. Changes made by shell commands (`run_command`, `!command`) do not; they appear in `/diff` only. Renames are
  shown when git reports them in `/diff`; no edit tool renames files.
- **Colour.** 24-bit colour with `COLORTERM=truecolor`; otherwise 256 colours for a `TERM` naming them, else the 16
  standard colours (no row backgrounds: the changed text itself is green or red). `NO_COLOR` or `TERM=dumb` removes
  colour; `NEXUS_COLOR=truecolor|256|16|none` overrides. The `+`/`−` markers and labels carry the meaning at every
  depth.

### Long tasks: continuation instead of a 30-step stop

`--max-steps` (default 30) is now a segment: at each segment boundary the turn checkpoints and continues on its own
while it makes progress. It stops with a stated reason on `--max-total-steps` (300), `--max-turn-minutes` (120),
`--stagnation-steps` without progress (12), a repeated identical action after two recovery notes, cancellation, or
the model finishing. `--no-continuation` restores the old single-segment turn. The operator's objective and its
numbered requirements are pinned for the model on every request (never summarised away); the agent records
requirement progress with evidence, and a turn that stops with requirements open ends `REQUIREMENTS_INCOMPLETE`
with the remaining items, failed check and next action (see `/receipt`). Only the operator can reduce scope: a
requirement the agent marks descoped stays unresolved until you run `/requirements accept <id>` (`/requirements`
lists them). While an objective with listed requirements is unfinished, every message you send — however long, even
with its own numbered list — continues it (numbered items are added as further requirements, and a notice says so);
`/requirements clear` (or `/clear`) starts a new objective. A requirement counts as *verified* only when a passing
verifier run (`run_tests`, or the completion verifier) is recorded on the current workspace; any later change demotes
it to *implemented (model-reported)*. Each requirement keeps its complete wording; when the objective is too long to
repeat on every request, the unresolved requirements are carried in full and the agent reads the rest with
`read_objective`. A verifier failure is not re-run while nothing it depends on has changed (same workspace files, no
mutating command since, same dependency/environment markers, same process).

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
| `/tui` | REPL only: open the session dashboard (not offered in the live TUI, where it had no purpose) |
| `/doctor [--deep] [--fix [--yes]]` | Diagnose this session's configuration, endpoint, engine, shell and state (see `docs/DOCTOR_TROUBLESHOOTING.md`) |
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
