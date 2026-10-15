# Nexus Code User Manual

Welcome to **Nexus Code**, a local-first, autonomous and interactive AI coding harness. Nexus Code connects to local inference servers (vLLM, LM Studio) and executes inside a native Linux shell environment.

---

## 1. Quick Start

### Starting the Interactive REPL / TUI
To launch the interactive coding environment in the current workspace:
```bash
nexus
# or
harness repl
```

### Execution Postures & Approval Modes

Nexus Code resolves execution posture per workspace trust (DEC-01 option C):
- **Untrusted workspaces:** Default to `review` posture, requiring human confirmation before executing shell commands, file modifications, network requests, or verifier test runs.
- **Trusted workspaces:** Default to `auto` posture, permitting autonomous execution.

Flags and commands:
- **Trust your workspace:** Run `nexus trust .` to mark the current repository trusted and enable default `auto` execution.
- **Review mode (human-in-the-loop):** Run `nexus --approve` (or `nexus --mode review`) to require explicit approval for all actions regardless of workspace trust.
- **Autonomous mode (scripts and CI):** Pass `nexus --yes` (or `nexus --mode auto`, or set `NEXUS_APPROVAL_MODE=auto`) to run autonomously without interactive approval prompts.
- **Read-only mode:** Run `nexus --read-only` to explore and analyze code without permitting any modifications or non-read commands.

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
See [MCP_GUIDE.md](MCP_GUIDE.md) for full configuration details.

---

## 2. Interactive REPL / TUI Features

### Command Autocompletion
Press `<TAB>` at any prompt to autocomplete slash commands and directory paths.

### Multiline Input
- Enter triple quotes (`"""`) or triple backticks (` ``` `) to open a multiline input block. Complete the block by closing with `"""` or ` ``` `.
- Alternatively, end any line with a trailing backslash (`\`) to continue on the next line.

### Live TUI: activity, steering, paste buffers and diffs

- **Activity line.** While the agent works, the line above the composer animates (`⠋ thinking · 0:42 · step 31 ·
  segment 2`) from the clock, not from model output, and names the phase: thinking, the running tool and its
  subject, waiting for the provider, verifying, compacting. A step limit is shown (`step 31 of 40`) only when you set
  one; a time limit you set appears (`12 min left`) in its last quarter or last 15 minutes. It stops on completion, cancellation, failure or
  disconnection; an approval request replaces it with the approval hint. Lines too long for the window end in `…`.
- **Transcript.** Replies are rendered Markdown: headings, emphasis, inline code, lists with hanging indents, block
  quotes, fenced code in a gutter block with syntax colours (long lines wrap onto rows marked `↪`), and tables
  aligned in columns (listed row by row when too wide). Each model reply is its own paragraph; when Nexus asks the
  agent to continue on its own (open requirements, a repeated action), a quiet line says so. Commands show their exit
  code and line count, the exact number of earlier lines not shown (`… 115 earlier lines`) and the last 6 lines; Tab, `[`/`]` and
  Enter open the full record. Tools that took noticeable time show their duration. A pasted prompt shows the text that
  was sent under its `[Pasted text #n]` label.
- **Outcomes.** A turn ends with one line in words — `Done`, `Done · verified`, `Done · tests passed, change not
  covered`, `Done · not verified`, `Verification failed`, `Requirements still open` (with the open items),
  `Cancelled`, `Stopped at …` (a budget), `Model request failed`, `Context is full` — the cause, and the next action;
  `v` opens the receipt with the raw fields. **Verified** means the passing test run — whether you configured the
  verifier or Nexus found it — is evidence about the change: it
  ran tests (its output reports at least one), ran the whole suite (no name filter), and covers the changed files — a
  changed file is a test, the run names a changed file, a test imports a changed module, or the change has inline
  tests the run executes (Rust `#[cfg(test)]` under `cargo test`, Go `_test.go` files under `go test`). A passing run
  that shows none of that only shows nothing else broke: the outcome is `tests passed, change not covered`
  (`REGRESSION_FREE`, exit code 2), and requirements cannot be marked `verified` on it. When Nexus found the test
  command itself, a covering pass is VERIFIED only if it is also **independent of Nexus**: before its first edit Nexus
  runs the tests once, and the tests as they were then (Nexus's own new or edited tests set aside) must have failed
  before the change and pass after it. Tests Nexus wrote in the same change cannot catch its own misreading of what you
  asked, so a change checked only by them — or by tests that already passed before it, as for a new feature or a
  refactor — ends `Done · tests pass (own tests only)` (`REGRESSION_FREE`); the receipt's `independenceDetail` says
  which. A verifier you configure is your own check and is not held to this. Python projects without configuration
  (`test_*.py` in `tests/`, `test/` or the root) are run with `python3 -m unittest`. A verifier checks what it
  checks — for a review or analysis it may check structure only — so when the work may rest on tool output that left
  the context during the turn and was not read again, the outcome says so (`Done · verified (some context lost)`, and
  `contextNotRetained` in the receipt): check such a result against the source.
- **Scrolling.** Scrolled back, the view stays where you are while output arrives; the badge then says `new output`.
  PgDn or Ctrl+End returns to the newest line.
- **Status.** The top line shows identity only: workspace, branch with the number of changed files (`●3 changed`),
  model, mode (`review mode` in review mode) and the session id (what `/resume` takes), dropping the least important
  on narrow terminals. Activity is shown once, on the composer line.
- **Composer.** An empty composer says what Enter does (send, or steer while the agent works); a draft taller than
  six rows shows `line n of m`. Drafts are kept while panels are open and across a sidecar crash.
- **Approvals.** A panel sized to its content states what is proposed and on which target (`Proposed: create
  config.json · +1 −0`), shows file changes with the diff view, and offers Approve, Approve all later actions and Deny.
  No key decides until the panel has been on screen briefly, you have paused typing (about half a second, counted from
  when it appeared or your last key) and, after you answered a previous request, a moment has passed (so a repeated `y`
  answers only one request). Then:
  - `y` approves and `n` denies — only if you were not typing or holding a draft when the panel appeared and have typed
    nothing into it. Otherwise the panel says `typing ignored` and hides those letters.
  - ←/→ choose Approve or Deny; Enter takes the choice once it has been on screen a moment (2 seconds on a panel you were
    typing into, where ←/→ are easily cursor keys). On such a panel Approve takes Enter twice (the second confirms);
    Deny takes one.
  - **Approve all later actions** (switches to auto mode) is only reached with `a`, on a panel that shows the letters,
    then Enter, then Enter again; Esc denies at that point and any other key cancels. Arrows never reach it.
  - Esc denies (it too waits for the moment after a previous answer). Keys with Ctrl, Alt, Super or Meta never answer,
    nor do Tab, bursts of keys or pastes. Delete and Backspace count as typing.
  The panel is answerable only while its change is visible — on a window too small to show it, it asks you to enlarge
  the terminal (Esc still denies), and timing starts again when it is drawn. Approvals that arrive while another panel
  or approval is open wait in order; the panel title shows how many are waiting.
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

### Long tasks: no step ceiling

`--max-steps` (default 30) is a segment: at each segment boundary the turn writes a durable checkpoint and continues
on its own. Progressing work has no step or time ceiling: a turn stops on completion, cancellation, demonstrated lack
of progress (`--stagnation-steps`, default 12 consecutive steps without progress, or a repeated action on an unchanged
workspace after two recovery notes), an actionable failure, or a limit **you** set (`--max-total-steps`,
`--max-turn-minutes`). Progress is judged against workspace content, not tool-call equality: plan edits, identical
rewrites and timestamp-only output changes do not count, and a retry after a real change is legitimate. Polls and
transient failures are spaced with backoff instead of being treated as loops. `--no-continuation` restores the
single-segment turn. Tracking (cumulative steps, loops, failed approaches, compactions) belongs to the objective and
survives compaction, follow-ups ("continue") and `/resume`. See `docs/COMPACTION_AND_CONTINUITY.md`.

The operator's objective and its
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
`read_objective`. Your steering and follow-up messages are carried verbatim the same way, however many and however
long, after compaction and after a crash and resume: the newest are repeated in full (about 12,000 characters), and
any older one that does not fit is named with its size so the agent reads it with `read_objective`. A verifier
failure is not re-run while nothing it depends on has changed (same workspace files, no mutating command since, same
dependency/environment markers, same process).

### Compaction and context sizing

`/compact [--llm]` during work is queued (acknowledged at once) and runs once the current inference and its tool
batch — approvals included — have settled, before the next request; its outcome is reported for its request. Every
compaction archives the originals first, then writes the task state and the session; a write failure is reported
and never shown as success. The context window and output allowance come from the provider when it advertises them
(the homelab-ai gateway; vLLM `max_model_len`), else from `--context-limit` or labelled defaults; `/status` shows
both with their source and how the last request was counted (`exact_admitted`, `exact_sampled_worker`,
`gateway_conservative`, `client_estimate`). `--strict-token-count` refuses requests that could not be counted on a
worker. See `docs/COMPACTION_AND_CONTINUITY.md`.

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
| `/status` | View active model, endpoint, shell, git badge, context sizing with sources, last request count, objective progress |
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
| `/compact [--llm]` | Distill earlier conversation into structured memory; queued while work runs, committed durably (archive, task state, session) |
| `/mode [auto\|review]` | Toggle autonomous execution vs human approval. Review mode asks before file changes, commands (including MCP and plugin tools) and network access; network access is asked once per destination per session |
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
5. **`edit_file`**: Exact search-and-replace of a snippet that must occur once (or every occurrence with `replace_all`). Blank lines around the snippet are tolerated; a snippet that matches only with different indentation is refused with the file's exact lines quoted. CRLF files keep CRLF.
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
- **Configurable Security Policy (`.nexus-security.json`)**: Declare repository-specific blocked shell commands, protected files (`.git`, `.env*`, keys), and allowed outbound network domains. Protected-path checks cover case-insensitive variants, `.env*` prefixes, and canonical targets across all file read/write/edit tools; for `run_command` path protection is advisory because shell commands execute in the host shell environment.
- **Dry-Run & Read-Only Modes (REQ-SEC-104)**:
  - `--dry-run`: Intercepts file writes and mutating commands to simulate changes without touching disk.
  - `--read-only`: Rejects all file modifications and non-read shell commands with an immediate error. Under container sandboxing (`bwrap`), `--tmpfs $HOME` is mounted to completely mask SSH keys (`~/.ssh`), credentials, and dotfiles from `run_command`. Without `bwrap`, strict path confinement rejects paths referencing `~`, `$HOME`, environment variables (`$`), absolute paths outside the workspace, or escaping `..` sequences.
- **Lightweight Container Sandboxing & Direct Argv Spawning (`--sandbox`, REQ-SEC-109)**: Restricts filesystem mutation strictly to the target workspace using Linux Bubblewrap (`bwrap`) or Docker isolation. Sandbox commands are constructed as direct `argv` argument arrays and executed without passing through a host shell (`sh -c` / `bash -c`), preventing shell escaping vulnerabilities with paths containing spaces or quotes.
- **In-Process Plugin Execution & Middleware Auditing**: Custom plugin handlers and middleware execute in-process with full user authority. Plugins are loaded only from documented directories: `~/.config/nexus/plugins/`, `~/.nexus/plugins/`, and trusted workspace directories (`.nexus/plugins/`, `plugins/`). The undocumented foreign directory `~/.config/opencode/plugins` has been removed (REQ-SEC-115), and the legacy worker-thread sandbox claim has been retired (`executeSandboxed` deleted, REQ-SEC-117). Any middleware rewriting of tool I/O (`preToolExecution` or `postToolExecution`) is cryptographically audited with before-and-after SHA-256 digests in both `~/.nexus/audit.log` (`kind: "middleware_rewrite"`) and the flight log (EXT-004, REQ-SEC-116).
- **Workspace Trust & Context Provenance (REQ-SEC-113, CTX-001)**: An opened workspace is data until explicitly trusted by the operator. Workspace trust covers:
  - Workspace `.mcp.json` / `mcp.json` server definitions.
  - Workspace plugins (`.nexus/plugins/`, `plugins/`).
  - Workspace skills (`skills/`, `.nexus/skills/`, `.claude/skills/`).
  - Workspace knowledge graph (`.nexus/knowledge.json`).
  Trust is managed via `nexus trust [path]` (undo with `nexus trust --remove`, list with `nexus trust --list`; stored in `~/.config/nexus/trusted_workspaces.json`, which the agent's file tools cannot write). In an untrusted workspace:
  - Workspace MCP servers and plugins are not loaded.
  - Workspace skills are not loaded into context; `/skills` lists them as "untrusted (not loaded)". Attempting to use `/skill <name>` or the `activate_skill` tool on an untrusted skill is refused with: `Skill '<name>' belongs to an untrusted workspace. Run 'nexus trust .' to trust this workspace.`.
  - Workspace knowledge is ignored and not loaded into context.
  - Injected prompt blocks from skills and knowledge are explicitly annotated with source path and trust state (`[source: <path>] [trust: <state>]`).
  - In `--read-only` mode, untrusted components are never loaded, no writes occur, and `.nexus/` is never created.
  Servers, plugins, and skills in your home configuration (`~/.config/nexus/`, `~/.nexus/`) are always trusted and loaded.
- **Knowledge Graph Hygiene & Auto-Extraction Gating (REQ-SEC-114)**: The `KnowledgeGraph` has a lazy constructor that performs no filesystem creation until a write is explicitly requested. In `--read-only` mode, all mutations are blocked. Implicit standing instruction creation via automatic prompt mining (`autoExtract`) is disabled by default per DEC-15. It can only be enabled explicitly via `NEXUS_KNOWLEDGE_AUTOEXTRACT=1`, which prints a notification whenever a new rule is recorded into `<workspace>/.nexus/knowledge.json`.
- **MCP Server Environment**: MCP servers start with basic process, locale, proxy (`HTTPS_PROXY`, `NO_PROXY`, …) and CA-trust (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, …) variables only — not Nexus's own credentials. Give a server the token it needs in its `env` block in `mcp.json`.
- **Build Identity**: `nexus --version` and `nexus doctor` show the commit the running build was made from, its branch, and whether the source had uncommitted changes (`1.2.1 (cc177be91d15-dirty, feat/tui-surface)`), recorded at `make build`.
- **Pseudo-Terminal (PTY) Allocation**: Commands requiring TTY capabilities run inside allocated virtual pseudo-terminals via `portable-pty`.
- **Multi-Provider Failover**: Specify secondary fallback endpoints via `--fallback <url1,url2>` or `$LOCAL_LLM_FALLBACK_ENDPOINTS`. Automatic failover occurs if the primary LLM server drops connection or runs out of GPU VRAM (HTTP 503).
- **BPE Token Accounting & Context Gauge**: Real-time token breakdown across system instructions, tools schema, user messages, assistant thinking, and tool output payloads with visual ANSI progress gauge.
- **Structured Context Compaction**: `/compact` distills discarded messages into structured memory (files touched, commands run, architectural decisions) instead of discarding context blindly.
- **Dynamic Few-Shot Injection**: Context-aware injection of valid tool exemplars (edits, test repair, batch reads) tailored to the active task, eliminating tool hallucination in local models (Qwen 2.5, DeepSeek Coder).
- **Destructive Command Convenience Tripwire (REQ-SEC-108)**: Shell-words tokenization in TypeScript and Rust blocks obviously destructive commands (`rm -rf /`, `mkfs`, raw block device writes, fork bombs) without false positives on legitimate project commands (`rm -rf ./build`, `rm -rf /tmp/x`, `grep reboot`, `echo shutdown`, `chown -R me /srv`). This denylist is a **convenience tripwire** to catch obvious mistakes, **not a security boundary**. Known bypasses (such as `find / -delete`, `/bin/rm -rf /`, `rm -r -f /`, Python scripts) are documented non-goals that pass by design; the sandbox (`--sandbox`) and approval posture (`review`) form the security boundary.
- **Verifier Execution Gating (REQ-SEC-119)**: Automated test runs and verifiers (`run_tests`, `/test`, completion oracle) are classified as `exec` capabilities subject to the approval policy. In untrusted workspaces, the first verifier execution prompts for approval, displaying the exact test command and resolved script body from `package.json`, `Makefile`, or `Cargo.toml`.
- **Approval Input Safety & Surface Integrity (REQ-SEC-103, TUI-09, TUI-10)**:
  - In `InteractiveRepl`: Prompts display `[y/N/d/a]`. Lone Enter safely defaults to No (`N`). A 400ms grace period discards typed-ahead input and pastes. Selecting `a` (approve all) requires explicit typing of `all` to confirm.
  - In the Ratatui TUI: The approval modal lays out `Approve` (left) · `All later` (center) · `Deny` (right). Left arrow (`←`) selects `Approve` and Right arrow (`→`) selects `Deny`. On narrow terminals (<60 columns), short-form hints fit within 38 columns without clipping.
- **SSRF Network Protection (`safeFetch`, REQ-SEC-112)**: Outbound HTTP scraping via `fetch_web` enforces rigorous SSRF protections:
  - Resolves hostnames and rejects non-public addresses (loopback `127.0.0.0/8` / `::1`, RFC-1918 private subnets, CGNAT `100.64.0.0/10`, link-local `169.254.0.0/16` / `fe80::/10`, IPv6 ULA `fc00::/7`, and IPv4-mapped loopback/private addresses).
  - Pins the resolved public IP address to the connection to prevent DNS-rebinding attacks.
  - Handles HTTP redirects manually (maximum 5 hops), re-validating the resolved IP on every redirect hop.
  - Streams the response body with a strict 5 MB cap (RSS < 100 MB) to prevent denial-of-service memory exhaustion.
  - Requests are gated by the SPEC-01 egress policy.
- **Web Search Honesty & Disclosure (REQ-PRV-108)**: `search_web` queries technical search providers and returns `success: false` and empty results when no search hits are found (no fabricated or placeholder results). Its search destination is disclosed on first use and routed through the egress disclosure gate.
- **Non-Blocking Pipe Execution**: Drains stdout and stderr concurrently to prevent 64KB Linux buffer saturation deadlocks during intensive builds.
- **Secret Redaction**: Redacts Bearer tokens, private keys, and passwords before printing or logging.
- **Audit Logging**: Every tool execution is recorded with timestamps, parameters, duration, and status in `~/.nexus/audit.log`. Visual inspection available via `/audit` and `nexus audit`.
- **Workspace Snapshots & Rollback**: Automatic Git-backed and filesystem snapshot rollback. Inspect diffs anytime with `/checkpoint diff <id>`, and manage disk footprint with `/checkpoint prune [keep]`.
- **Real-Time Hot-Reloading**: Automatically detects edits or additions in `skills/` and `AGENTS.md` and reloads them dynamically without restarting the REPL.
