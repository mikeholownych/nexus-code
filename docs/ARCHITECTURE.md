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
- **`runner.rs`**: Child process execution and process ownership tracking via `ProcessRegistry`. Tracks process group IDs (`pgid`) mapped to request IDs. Implements `cancel` RPC (`SIGTERM` then `SIGKILL` after 2s), PTY `pgid` killing, shutdown sweeps on stdin EOF, `SIGTERM`, `SIGHUP` and `SIGINT` with Linux `PR_SET_PDEATHSIG` parent-death cleanup, background services registry, bounded head/tail output ring buffers (RSS ≤ 64 MB for 400 MB output), timeout clamping to `NEXUS_MAX_TOOL_TIMEOUT_SECS` (default 1,800s, hard maximum 86,400s), and destructive pattern detection (`is_dangerous_command`).

Rust RPC calls can set an operator-chosen per-tool timeout with `NEXUS_TOOL_TIMEOUT_SECS_<TOOL>` (uppercase RPC method suffix, for example `NEXUS_TOOL_TIMEOUT_SECS_READ_FILE`). A valid value from 1 to 86,400 seconds becomes that tool's default and cap; request-level values can shorten it. `NEXUS_MAX_TOOL_TIMEOUT_SECS` remains the global hard ceiling and wins when lower. If a non-command RPC reaches its deadline, the bridge retires its shared Rust worker and reports the in-flight result as unknown; this setting does not govern in-process TypeScript handlers or model API requests.

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
3. **Approvals and posture defaults.** Per amended DEC-01, unset permission mode defaults to `review` regardless of folder trust. `--mode auto` permits writes and commands while retaining first-use egress approval per origin; `--yes` and `NEXUS_APPROVAL_MODE=auto` enable full access and bypass approval prompts, including egress. Folder trust only controls project instructions and workspace integrations. Input safety is strictly enforced across surfaces (REQ-SEC-103): lone Enter defaults to No, a 400ms grace period discards typed-ahead input, and approve-all requires explicit confirmation (`all` in REPL, confirmation Enter in TUI). *Limit:* in explicit `auto` posture, commands and file writes execute autonomously regardless of folder trust. Egress approval covers the network tools (`fetch_web`, `search_web` and the `browser_*` tools, classed `egress`); it does **not** cover shell commands. `run_command` is classed `exec`, so a shell command such as `curl` or `git push` is never checked against the egress origin list, and the only thing that confines its network access is the network setting of `--sandbox` (item 6). In `review` mode the operator sees the command and approves it as a whole; with `--sandbox` the approval prompt also states whether the sandbox has network access.
4. **Workspace trust.** Trust is managed via `nexus trust` and stored in `~/.config/nexus/trusted_workspaces.json`; interactive startup asks for trust before loading project instructions (`AGENTS.md`, `CLAUDE.md`, `CODEX.md`, `.nexusrules`). In untrusted workspaces, project instructions, workspace MCP configs, plugins, skills, and `.nexus/knowledge.json` are not loaded (REQ-SEC-113, REQ-SEC-114). The operator may continue without trust under the existing permission mode or exit. *Limit:* configuration in the operator's home directory (`~/.config/nexus/`, `~/.nexus/`) is always trusted.
5. **Secret redaction.** Terminal output, audit logs and durable state pass through pattern-based scrubbers, and outbound content is classified and tokenized. *Limit:* it is pattern-based, so secrets with no recognizable shape are not detected.
6. **Container sandbox and argv isolation.** `--sandbox` confines execution using Linux Bubblewrap (`bwrap`) or Docker. The sandbox argv is constructed as a direct array without shell wrapping (REQ-SEC-109), preventing shell escaping flaws on complex workspace paths. The write-mode `bwrap` sandbox (`cli/src/sandbox.ts`) is built as follows:
   - *Filesystem:* the host root is bound read-only (`--ro-bind / /`, remounted read-only) with a fresh `/dev`, `/proc` and an empty `/tmp`; the workspace is bound writable. `$HOME` is replaced by an empty tmpfs, so `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/nexus` and browser profiles do not exist inside. Only toolchain directories are bound back read-only: `~/.cargo`, `~/.rustup`, `~/.nvm`, `~/.local/bin`, `~/.npm`, `~/.cache/pip`, `~/go/pkg`, the `PATH` entries that lie under `$HOME` (with their `<prefix>` for a `.../bin` entry), and the paths the operator lists in `NEXUS_SANDBOX_HOME_READONLY` (comma-separated; operator environment or `config.env` only, never a project `.env`). A candidate that is, contains or sits inside a credential location (the same list plus `~/.config`, `~/.local/share`, `~/.cache` as whole directories) is refused, including through a symlink. `~/.cargo/credentials` and `~/.cargo/credentials.toml` are masked with `/dev/null`. `/run/user/<uid>` (ssh/gpg agents, user bus) is an empty tmpfs, and `/run/docker.sock` and `/var/run/docker.sock` are masked. The workspace bind is applied on top of the masked `$HOME`, so when the workspace is `$HOME`, or contains a credential path, those paths are overlaid (a tmpfs for a directory, `/dev/null` for a file) after the workspace bind; they appear empty. `nexus doctor` (`sandbox.confinement`) lists the effective mounts, masks and refusals.
   - *Environment:* `--clearenv`, then only the scrubbed command environment (`cli/src/command_env.ts`) is set. Variables that came from `~/.config/nexus/config.env`, names that look like credentials (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `AWS_*`, `GH_TOKEN`, `SSH_AUTH_SOCK`, ...) and proxy URLs with embedded credentials are removed. The operator can pass a named variable through with `NEXUS_COMMAND_ENV_PASSTHROUGH` (comma-separated, trailing `*` for a prefix; operator environment or `config.env` only, never a project `.env`). The same scrubbed environment applies to `run_command` without `--sandbox`, and the Rust runner (`core/src/runner.rs`) removes credential-looking names again as a second layer.
   - *Network:* off by default (`--unshare-net`; Docker `--network none`). The operator opts in with `--sandbox-network` or `NEXUS_SANDBOX_NETWORK=1` in the operator environment. `--yes` does not enable it. `--sandbox-network` without `--sandbox` has no effect and warns. `--read-only` mode is always offline.
   - *Process isolation:* `--unshare-pid` with a fresh `/proc` (host processes and their `/proc/<pid>/environ` are invisible) and `--die-with-parent` (every descendant dies with the runner). These flags are on both the write-mode and the read-only `bwrap` branches. `--new-session` is deliberately not used: it makes `bwrap` its own session leader, so the runner's `killpg` on cancel or deadline no longer reached the sandbox. Keystroke injection into the operator's terminal (TIOCSTI) is closed by the kernel default `legacy_tiocsti=0` (Linux 6.2 and later), not by the sandbox.
   - *Docker:* the image is pinned by digest in one constant, `DOCKER_SANDBOX_IMAGE` (`alpine:3.23@sha256:469c9ea4...`). The operator may substitute another with `NEXUS_SANDBOX_DOCKER_IMAGE` (operator environment or `config.env`); it must match `name@sha256:<64 hex>`, otherwise no container is started. The container runs with `--user <uid>:<gid>` of the invoking user, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 512`, `--read-only` and `--tmpfs /tmp:rw,nosuid,nodev,size=256m`. The network is `--network none` unless the same opt-in as `bwrap` is set (`--sandbox-network` / `NEXUS_SANDBOX_NETWORK=1`; read-only mode is always offline). Only the scrubbed command environment is passed, one `--env` per variable, with `HOME`, `PATH` and `TMPDIR` replaced by container paths. When the workspace is, contains or sits above `$HOME`, credential paths inside it are overlaid after the workspace mount (`sandboxWorkspaceOverlays`: a tmpfs for a directory, `/dev/null` for a file). Consequence: commands that wrote outside the workspace and `/tmp`, relied on root, or used the network now fail in Docker mode.
   - In `--read-only` mode, `$HOME` is mounted as `--tmpfs $HOME` and the host root is not exposed (REQ-SEC-104); without bwrap, strict path confinement rejects paths outside the workspace.

   *Limits, stated plainly:* (a) **Without `--sandbox`** a command runs as the same user as Nexus. The scrubbed environment keeps credentials out of what the command inherits (`env`, `printenv`), but the command can still read the operator's files (for example `~/.config/nexus/config.env`, `~/.ssh`) and the environment of its parent processes through `/proc/<pid>/environ` (same user; Yama `ptrace_scope=1` does not block that read). Inside the `bwrap` sandbox host processes are invisible. (b) **Under `--sandbox`**, files outside `$HOME` are still readable (`--ro-bind / /`), for example other users' home directories and world-readable system files; only `$HOME` and the locations listed above are masked. (c) The sandbox does not protect against a command the operator approves while the network opt-in is enabled: such a command can send any file it can read to the network. Full container sandboxing requires `bwrap` or Docker on the host.
7. **Process group lifecycle and residual setsid escape risk.** The runner registers child process groups at spawn and terminates entire groups (`killpg`) on turn cancel, client crash, or process shutdown (REQ-AGT-109, REQ-SEC-106). Background services explicitly registered survive turn cancel but are cleaned on client exit. *Limit:* commands that explicitly invoke `setsid()` or create a new session ID escape the process group boundary unless Bubblewrap (`--sandbox`) or Docker isolation is enabled (`bwrap` uses `--die-with-parent` and a PID namespace on both its branches, so all descendants are swept when the runner exits). Documented residual risk: in unsandboxed mode, processes that detach with `setsid()` will outlive cancel sweeps.

## Compaction and continuity

Long-task continuity (no step ceiling, state-aware repetition, objective-scoped execution tracking), the durable
compaction commit, queued operator `/compact`, and optional provider capabilities with labelled token accounting are
described in `docs/COMPACTION_AND_CONTINUITY.md`.
