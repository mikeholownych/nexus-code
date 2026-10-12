# Peer coding-harness reference (documented capabilities only)

Researched 2026-10-12 from primary sources (official docs, official repos/releases, vendor posts). Every fact below is
**documented** by the vendor/project; nothing here is measured. Citation keys are in brackets; the citation list gives
URL and the version/date seen. Benchmark figures are **vendor claims about models, not harness measurements**, and are
not parity evidence for Nexus.

Peers: OpenAI **Codex CLI** (stable 0.162.1), Anthropic **Claude Code** (2.1.296), **OpenCode** (v1.19.0, anomalyco/opencode),
**Goose** (v1.54.0, AAIF/Linux Foundation), **Aider** (0.86.2). OpenCode, Goose and Aider were chosen because they
document local-model support (Ollama / LM Studio / OpenAI-compatible) and a terminal interface.

## 1. Comparison table

| Area | Codex CLI | Claude Code | OpenCode | Goose | Aider |
|---|---|---|---|---|---|
| **1. Objective completion** | `/plan` toggles plan mode; `/goal` sets a persistent objective whose text "becomes both the first prompt and the completion criteria"; docs tell users to include verification (tests/measurements) in the goal; goal keeps the existing sandbox/approval policy and pauses for decisions [CX-LONG][CX-SLASH]. `/review` reviews uncommitted changes or vs a base branch [CX-SLASH]. | `plan` permission mode blocks edits until the user approves a plan (`ExitPlanMode` needs approval) [CC-PERM][CC-TOOLS]; task list tools `TaskCreate/TaskList/TaskUpdate` (TodoWrite legacy) [CC-TOOLS]; goals carry over on resume [CC-SESS]; Stop/SubagentStop `prompt` hooks judge whether to stop (2.1.294 fix to reduce early stops) [CC-CHG]. | Plan agent (edits and bash default to `ask`) vs Build agent, toggled with Tab [OC-INTRO][OC-AGENTS]. No todo tool on the tools page [OC-TOOLS]. | `GOOSE_MAX_TURNS` (default 1000) caps consecutive actions, then asks to continue [GS-CTX]. Recipes/subrecipes for repeatable tasks [GS-HOME]. | `--test-cmd` + `--auto-test` run tests after each edit; lint runs by default; on non-zero exit aider "will try and fix any errors" [AI-LINT]. Architect mode = planner model + editor model [AI-EDIT]. |
| **2. Context / long tasks** | `/compact`; `model_auto_compact_token_limit`, `model_context_window`; `/status` shows context usage; `codex resume`; `/fork` copies a chat to a new chat or worktree; `tool_output_token_limit`; resumable state in a SQLite DB (`sqlite_home`); AGENTS.md (`project_doc_max_bytes`, fallback filenames); memories [CX-CFG][CX-SLASH][CX-CLI]. | Auto-compaction at a per-model threshold, `/autocompact <tokens>`, `/compact [focus]`, `/context`; after compaction re-injects CLAUDE.md/startup content, a structured summary, up to 5 most-recent files and invoked skill bodies (5k cap each) [CC-CTX]. Rewind menu can "summarize from/up to here" [CC-CKPT]. `--continue/--resume`, `/branch`, `--fork-session`; resume-from-summary dialog for idle >1h, >100k-token sessions [CC-SESS]. CLAUDE.md, AGENTS.md, auto memory [CC-OV]. Subagent `autoCompactWindow` (2.1.296) [CC-CHG]. | `compaction.auto` (default true), `compaction.prune` (old tool outputs, default false), `compaction.reserved` token buffer [OC-CFG]. Per-model `limit.context/output` for custom providers [OC-PROV]. `instructions` file globs [OC-CFG]. | Auto-compact at min(80% of window, 225k tokens) (`GOOSE_AUTO_COMPACT_THRESHOLD`/`_TOKEN_LIMIT`); `/compact`; fallback strategies summarize/truncate/clear/prompt (`GOOSE_CONTEXT_STRATEGY`); headless defaults to summarize [GS-CTX]. | Ollama: warns 2k default ctx "silently discards context"; aider sets `num_ctx` to fit each request + 8k reply [AI-OLLAMA]. (No compaction feature verified this session.) |
| **3. Tools / execution** | Shell tool on by default; background terminals (`background_terminal_max_timeout` 300000 ms); MCP `tool_timeout_sec` 60, `startup_timeout_sec` 10; subagents; managed git worktree tools (0.162.0); `/worktree` [CX-CFG][CX-REL][CX-SLASH]. Edit/patch format not verified on fetched pages. | `Edit` = exact string replacement (no regex/fuzzy), read-before-edit check [CC-TOOLS]; Bash per-call `timeout` chosen by model, background commands default 30 min / max 2 h (`BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS`), 10 min in text `-p` runs; `Monitor` streams background output lines [CC-TOOLS]; `Agent` subagents with own context, background agents [CC-TOOLS][CC-OV]; checkpoints per turn (100 kept), `/rewind`/Esc Esc restores code and/or conversation; Bash-made changes and most subagent edits **not** tracked [CC-CKPT]. | `edit` = exact text replacement; `apply_patch`; `write`, `read` (line ranges), `grep`, `glob`, `bash` (no timeout documented), experimental `lsp`, `question` [OC-TOOLS]. Subagents General/Explore/Scout via Task tool, General can run units in parallel [OC-AGENTS]. Snapshots on by default enabling `/undo` `/redo` [OC-CFG][OC-INTRO]. | Subagents guide [GS-HOME]; extensions = MCP servers [GS-HOME]. Tool details not verified this session. | Edit formats: whole, diff (search/replace blocks), diff-fenced, udiff, editor-diff/whole [AI-EDIT]. Auto-commits every edit, commits pre-existing dirty changes separately first, `/undo`, `/diff`, "(aider)" attribution [AI-GIT]. |
| **4. Operator control / trust** | Sandbox modes `read-only` / `workspace-write` / `danger-full-access`; macOS Seatbelt, Linux bubblewrap (PATH or bundled helper needing unprivileged userns), WSL2 Linux sandbox, native Windows sandbox; `writable_roots`; `sandbox_workspace_write.network_access`; approvals `on-request`/`never`/granular (`untrusted` retired, `on-failure` deprecated); `approvals_reviewer = auto_review` delegates eligible prompts to a reviewer agent without widening the sandbox [CX-SBX][CX-CFG]. `shell_environment_policy` (inherit all/core/none; KEY/SECRET/TOKEN name exclusion when `ignore_default_excludes=false`); project-local config cannot set provider/notify/otel; command + MCP-tool hooks [CX-CFG]. | Modes default(Manual)/acceptEdits/plan/auto(classifier)/dontAsk/bypassPermissions; auto is the starting mode since v2.1.283; deny rules apply in every mode; critical-path `rm` and protected paths never auto-approved; `blockReadsOutsideWorkingDirectories` [CC-PERM]. Bash sandbox: Seatbelt (macOS), bubblewrap+socat+seccomp (Linux/WSL2), network through local proxy with domain allowlist, built on open-source `@anthropic-ai/sandbox-runtime`; file tools, MCP and hooks run outside it; native Windows unsandboxed; unsandboxed retry needs approval [CC-SBX]. Hooks incl. `onFailure:"block"` (2.1.295) [CC-CHG]; managed settings, `allowedProviders` pin [CC-GW]. | Per-tool `allow/ask/deny` with glob patterns, last match wins; `external_directory` and `doom_loop` (3 identical calls) default `ask`; `*.env` reads denied by default; `--auto` keeps explicit denies [OC-PERM]. No OS sandbox documented [OC-PERM]. | Modes auto (default per docs) / approve / smart_approve (risk-based) / chat; per-tool Always/Ask/Never in approve & smart modes; first-run mode prompt (v1.54.0); adversary-mode reviewer; prompt-injection detection mentioned [GS-PERM][GS-REL][GS-HOME]. OS sandbox not verified. | No approval/sandbox model documented on pages read; safety relies on git commits + `/undo` [AI-GIT]. |
| **5. Inference compatibility** | Built-in providers `openai`, `ollama`, `lmstudio`; `--oss` with `oss_provider = lmstudio|ollama`; custom `model_providers.<id>.base_url`; `wire_api` only `responses` (Responses API required); `request_max_retries` 4, `stream_max_retries` 5, `stream_idle_timeout_ms` 300000 [CX-CFG]. | Anthropic API, Bedrock, Google Agent Platform (Vertex), Microsoft Foundry, LLM gateways exposing a supported (Anthropic-format) API; Anthropic "doesn't support routing Claude Code to non-Claude models through any gateway" [CC-GW]. Cost/token metrics via OTel; `-p --output-format json` returns usage and cost [CC-OTEL][CC-SESS]. | "75+" providers; Ollama, LM Studio, llama.cpp (llama-server) via `@ai-sdk/openai-compatible` + `options.baseURL`; `@ai-sdk/openai` for `/v1/responses`; per-model context/output limits [OC-PROV]. | ~60 providers; Ollama (warns 4096 default ctx, `OLLAMA_CONTEXT_LENGTH`), LM Studio, Docker Model Runner (llama.cpp path), Ramalama (`--jinja` required), vLLM via `OPENAI_HOST`, custom providers in OpenAI/Anthropic/Ollama formats; "models without [tool calling] can only do chat completion" [GS-PROV]. | OpenAI, Anthropic, Gemini, Groq, LM Studio, xAI, Azure, Cohere, DeepSeek, Ollama, OpenAI-compatible, OpenRouter, Copilot, Vertex, Bedrock; text edit formats (no native tool calls needed); warns weaker models may fail to produce applicable edits [AI-LLMS][AI-EDIT]. |
| **6. Terminal experience** | Live commands/diffs, syntax theme (`tui.theme`), remappable keymap incl. `approval` context, vim mode, status line, notifications (OSC9/BEL), alternate-screen control, raw output toggle; `file_opener` for IDE links; IDE extension; desktop app [CX-CFG][CX-CLI][CX-REPO]. | Shift+Tab mode cycling, rewind menu, session picker with search/branch filters, keybinding customisation, OSC 7501 status (2.1.295); VS Code/JetBrains with inline diffs; desktop and web [CC-PERM][CC-SESS][CC-CHG][CC-OV]. | TUI with `@` fuzzy file search, image drag-drop, slash commands, themes, keybinds; IDE, desktop, web, ACP [OC-INTRO]. | Desktop app + CLI; token usage indicator with "Compact now"; HTML session export viewer [GS-CTX][GS-REL]. | Terminal chat; `/diff`, `/undo`, `/test` [AI-GIT][AI-LINT]. |
| **7. Persistence / audit** | `history.jsonl` (`history.persistence save-all|none`, `max_bytes`); `log_dir`; SQLite runtime state; OTel logs/traces/metrics exporters (`otlp-http`/`otlp-grpc`), metrics default `statsig`, raw prompt export opt-in (`otel.log_user_prompt`); `/feedback` with logs [CX-CFG]. | JSONL transcripts `~/.claude/projects/<project>/<id>.jsonl`, 30-day retention (`cleanupPeriodDays`), `/export`, `claude purge`, `--no-session-persistence`; format documented as internal/unstable [CC-SESS]. OTel metrics (cost USD, tokens, LOC, commits), events (prompt, tool_decision, tool_result, api_error) with `prompt.id` correlation, beta traces; prompt/tool content redacted by default; repo settings cannot enable telemetry [CC-OTEL]. | `/share` links (default manual; `disabled` option) [OC-CFG]. | Session export to HTML (v1.54.0) [GS-REL]. | Git history is the audit trail (commit per edit) [AI-GIT]. |
| **8. Product delivery** | Install script (`releases.openai.com`, GitHub fallback), npm, Homebrew cask, GitHub binaries; macOS arm64/x86_64, Linux x86_64/arm64 (musl), Windows; Apache-2.0; signed PowerShell installer (0.162.0); near-daily releases (0.162.0 Oct 8, 0.162.1 Oct 9, alphas Oct 9-10); security via Bugcrowd [CX-REPO][CX-REL][CX-SEC]. | Native installer with background auto-update; Homebrew stable (≈1 week behind) / latest casks; WinGet; apt/dnf/apk; npm deprecated; macOS/Linux/WSL/Windows; releases 2.1.294-2.1.296 within Oct 8-9; security via HackerOne; license file not read [CC-OV][CC-REPO][CC-CHG][CC-SEC]. | Install script, npm/bun/pnpm/yarn, Homebrew tap, Arch, Chocolatey, Scoop, Docker; macOS/Linux/Windows (WSL recommended); MIT; v1.19.0 (2026-10-11) moves to manual `/update` and offers `opencode upgrade --major` to OpenCode 2; SECURITY.md present [OC-INTRO][OC-REL][OC-REPO]. | Desktop (macOS/Linux/Windows), CLI install script (sh/ps1), Docker build guide; Apache-2.0; v1.54.0 (2026-10-08) [GS-REPO][GS-REL]. | PyPI `aider-chat` 0.86.2 (2026-02-12), Apache-2.0, Python 3.10-3.12; last GitHub release v0.86.0 (Aug 2025) - slow cadence [AI-PYPI][AI-REL]. |
| **9. Evaluation (vendor claims)** | OpenAI claims for **models** (not the CLI harness): GPT-5.5 82.7% Terminal-Bench 2.0, 58.6% SWE-Bench Pro [EV-OAI]. | Anthropic claims for **models**: Claude Opus 4.6 65.4% Terminal-Bench 2.0 (max effort), 80.8% SWE-bench Verified (25-trial avg); footnote says runs used the Terminus-2 harness, i.e. not Claude Code [EV-ANT]. | None found. | None found. | Aider publishes its own LLM leaderboards (not read this session). |

## 2. Evaluation suites (for a matched Nexus evaluation)

- **SWE-bench / SWE-bench Verified** [EV-SWE][EV-SWEDOC]: given a real GitHub repository and issue, the system must produce
  a patch that resolves it; graded by the project's tests in a Docker-based harness. Verified = "500 engineer-confirmed
  solvable problems" (released 2024-08-13). Leaderboard variants: Verified, Lite, Full, Multilingual, Multimodal, plus a
  "Bash Only" filter (mini-SWE-agent). Measures patch correctness on Python repo issues; does not measure UX, approvals or
  long-session behaviour.
- **Terminal-Bench** [EV-TB][EV-TBGH][EV-TBDOC]: each task = English instruction + test script that verifies completion +
  reference ("oracle") solution, executed in an isolated terminal sandbox; measures end-to-end terminal work ("compiling
  code to training models and setting up servers"). Original beta ~100 tasks (`tb` CLI); 2.0+ run via the Harbor framework;
  tbench.ai currently shows version 4.0 with a leaderboard of model+agent pairs (resolution rate, cost, tokens, 95% CIs);
  example run: `terminal-bench/terminal-bench@4.0.0`, `-e modal`, agent `claude-code`, `-k 5`. Some tasks need GPUs.
- Matched-evaluation implication: Terminal-Bench (via Harbor) evaluates **agent+model pairs**, so Nexus, Codex CLI,
  OpenCode and Goose can be compared with the *same local model* and same task set; SWE-bench Verified compares patch
  outcomes. Vendor model scores above use different harnesses/models and cannot stand in for such a run.

## 3. Behavioural reference points for Nexus (testable)

Each line is a behaviour at least one peer documents; phrased so a test can pass/fail it. Source keys in brackets.

Objective completion
1. An operator can enter a read-only plan mode in which file edits are blocked until the operator approves a plan [CC-PERM][OC-AGENTS][CX-SLASH].
2. An operator can set a persistent goal with explicit completion/verification criteria; the agent keeps working across turns until those criteria are checked, and the goal survives resume [CX-LONG][CC-SESS].
3. With a configured test command, the harness runs it after edits and feeds non-zero-exit output back for a fix attempt [AI-LINT].
4. A visible task list is maintained and updated as steps complete [CC-TOOLS].
5. A hard cap on consecutive autonomous actions exists; on reaching it the harness asks rather than silently stopping [GS-CTX].
6. Identical repeated tool calls (e.g. 3x same input) are detected and escalated to the operator [OC-PERM].

Context / long tasks
7. Automatic compaction triggers before the context window is exceeded, with a configurable threshold, and a manual `/compact [focus]` exists [CC-CTX][GS-CTX][OC-CFG][CX-CFG].
8. After compaction, project instructions (AGENTS.md-equivalent) and recently edited files are re-injected [CC-CTX].
9. Context usage is visible on demand (status/context command or indicator) [CX-SLASH][CC-SESS][GS-CTX].
10. With a local backend whose server-side context is smaller than the request, the harness does not silently lose context (sets/validates `num_ctx`/context length or warns) [AI-OLLAMA][GS-PROV].
11. Sessions resume after exit, and can be forked/branched leaving the original intact [CC-SESS][CX-SLASH].
12. On resume after a crash, a tool call that was in flight is marked interrupted and is not blindly re-executed [CC-SESS].
13. Old tool output can be pruned/limited by a token budget [OC-CFG][CX-CFG].

Tools / execution
14. Edits apply only when the targeted text matches exactly (no fuzzy write), and a file must be read before it is edited [CC-TOOLS][OC-TOOLS].
15. Every shell command has a timeout; long commands can run in the background with their own limit, and the agent is told when a limit kills a command [CC-TOOLS][CX-CFG].
16. The operator can rewind file changes made by the agent to a prior turn and/or restore the conversation; limits (shell-made changes) are disclosed [CC-CKPT][OC-CFG][AI-GIT].
17. Delegated subagents run with their own context and return a summary to the parent [CC-TOOLS][OC-AGENTS][CX-CLI].
18. MCP tool calls and server startup have bounded timeouts [CX-CFG].

Operator control / trust
19. A read-only mode exists in which the agent cannot write files or run mutating commands without approval [CX-SBX][CC-PERM].
20. Shell commands run under an OS-enforced filesystem boundary (writable roots = workspace) on Linux and macOS [CX-SBX][CC-SBX].
21. Network egress from sandboxed commands is off or allowlisted by default and changeable only by explicit operator setting [CX-CFG][CC-SBX].
22. Explicit deny rules hold in every mode, including the most permissive [CC-PERM][OC-PERM].
23. Reads/writes outside the workspace prompt by default [OC-PERM][CC-PERM].
24. Secret files (`.env`) are not read by default, and secret-looking env vars can be stripped from the shell environment [OC-PERM][CX-CFG].
25. Repository-local config cannot redirect the model endpoint, telemetry destination or notification command [CX-CFG][CC-OTEL].
26. Hooks can block an action, and a hook that fails/times out can be configured to fail closed [CC-CHG][CX-CFG].
27. Approval prompts never auto-resolve on idle [CC-TOOLS].

Inference compatibility
28. Works against Ollama, LM Studio and llama.cpp/vLLM OpenAI-compatible endpoints with per-model context/output limits configurable [OC-PROV][GS-PROV][CX-CFG].
29. Transient provider/stream failures are retried with bounded, configurable counts and an idle-stream timeout [CX-CFG].
30. Models lacking tool calling are detected/handled explicitly rather than failing silently [GS-PROV][AI-LLMS].
31. Token (and, where priced, cost) usage is reported per session and in machine-readable output [CC-OTEL][CC-SESS].

Terminal / persistence / delivery
32. Diffs of proposed/applied changes are shown in the TUI; keybindings (including in the approval context) are remappable [CX-CFG][CC-SESS].
33. Transcripts are persisted locally with documented location, retention, opt-out and export [CC-SESS][CX-CFG].
34. Optional OpenTelemetry export with prompt/tool content redacted by default [CC-OTEL][CX-CFG].
35. A non-interactive mode returns structured JSON (result, session id, usage) with a proper exit code [CC-SESS][CX-CLI].
36. Install via script and package manager, with a documented update path (auto-update or explicit `/update`), a signed installer, and a published vulnerability-reporting channel [CX-REL][CC-OV][OC-REL][CX-SEC][CC-SEC].

## 4. Citation list (all accessed 2026-10-12)

| Key | URL | Title / version seen |
|---|---|---|
| CX-REPO | https://github.com/openai/codex | openai/codex README (Apache-2.0, install/platforms) |
| CX-REL | https://github.com/openai/codex/releases | Releases: 0.162.1 (2026-10-09), 0.162.0 (2026-10-08), 0.163.0-alpha.2-5 |
| CX-CLI | https://learn.chatgpt.com/docs/codex/cli (redirect from developers.openai.com/codex/cli) | Codex CLI overview |
| CX-SBX | https://learn.chatgpt.com/docs/sandboxing | Sandboxing |
| CX-CFG | https://learn.chatgpt.com/docs/config-file/config-reference | Config reference (read in two parts, full page) |
| CX-SLASH | https://learn.chatgpt.com/docs/reference/slash-commands | Slash commands (28 listed; unified app/CLI page) |
| CX-LONG | https://learn.chatgpt.com/docs/long-running-work | Long-running work (/goal) |
| CX-SEC | https://github.com/openai/codex/blob/main/SECURITY.md | Security policy (Bugcrowd) |
| CC-OV | https://code.claude.com/docs/en/overview | Claude Code overview |
| CC-PERM | https://code.claude.com/docs/en/permission-modes.md | Choose a permission mode |
| CC-SBX | https://code.claude.com/docs/en/sandboxing.md | Configure the sandboxed Bash tool |
| CC-CKPT | https://code.claude.com/docs/en/checkpointing.md | Checkpointing |
| CC-CTX | https://code.claude.com/docs/en/context-window.md | Explore the context window |
| CC-SESS | https://code.claude.com/docs/en/sessions.md | Manage sessions |
| CC-TOOLS | https://code.claude.com/docs/en/tools-reference.md | Tools reference |
| CC-OTEL | https://code.claude.com/docs/en/monitoring-usage.md | Monitoring (first 100k chars read) |
| CC-GW | https://code.claude.com/docs/en/llm-gateway.md | Other LLM gateways |
| CC-CHG | https://code.claude.com/docs/en/changelog.md | Changelog: 2.1.296 (2026-10-09), 2.1.295, 2.1.294 (2026-10-08) |
| CC-REPO | https://github.com/anthropics/claude-code | anthropics/claude-code README |
| CC-SEC | https://raw.githubusercontent.com/anthropics/claude-code/main/SECURITY.md | Security policy (HackerOne) |
| OC-INTRO | https://opencode.ai/docs/ | OpenCode intro |
| OC-PROV | https://opencode.ai/docs/providers/ | Providers |
| OC-PERM | https://opencode.ai/docs/permissions/ | Permissions |
| OC-CFG | https://opencode.ai/docs/config/ | Config |
| OC-AGENTS | https://opencode.ai/docs/agents/ | Agents |
| OC-TOOLS | https://opencode.ai/docs/tools/ | Tools |
| OC-REL | https://github.com/anomalyco/opencode/releases | v1.19.0 (2026-10-11) |
| OC-REPO | https://github.com/anomalyco/opencode | Repo (MIT, SECURITY.md) |
| GS-REPO | https://github.com/block/goose (now aaif-goose/goose) | goose README (Apache-2.0, AAIF) |
| GS-REL | https://github.com/aaif-goose/goose/releases | v1.54.0 (2026-10-08) |
| GS-HOME | https://goose-docs.ai/ | goose docs home |
| GS-CTX | https://goose-docs.ai/docs/guides/sessions/smart-context-management | Smart context management |
| GS-PROV | https://goose-docs.ai/docs/getting-started/providers | Providers |
| GS-PERM | https://goose-docs.ai/docs/guides/goose-permissions (via official-domain search result; direct fetch returned empty) | goose Permission Modes |
| AI-LLMS | https://aider.chat/docs/llms.html | Connecting to LLMs |
| AI-OLLAMA | https://aider.chat/docs/llms/ollama.html | Ollama |
| AI-EDIT | https://aider.chat/docs/more/edit-formats.html | Edit formats |
| AI-GIT | https://aider.chat/docs/git.html | Git integration |
| AI-LINT | https://aider.chat/docs/usage/lint-test.html | Linting and testing |
| AI-PYPI | https://pypi.org/project/aider-chat/ | aider-chat 0.86.2 (2026-02-12) |
| AI-REL | https://github.com/Aider-AI/aider/releases | v0.86.0 (09 Aug, year inferred 2025) |
| EV-SWE | https://www.swebench.com/ | SWE-bench leaderboards |
| EV-SWEDOC | https://www.swebench.com/SWE-bench/ | SWE-bench docs (Verified: 500 problems, 2024-08-13) |
| EV-TB | https://www.tbench.ai/ | Terminal-Bench home (v4.0) |
| EV-TBDOC | https://www.tbench.ai/docs | Terminal-Bench docs (Harbor run instructions) |
| EV-TBGH | https://github.com/laude-institute/terminal-bench | terminal-bench repo (task structure) |
| EV-OAI | https://openai.com/index/introducing-gpt-5-5/ | Introducing GPT-5.5 (figures seen via official-domain search snippet) |
| EV-ANT | https://www.anthropic.com/news/claude-opus-4-6 ; https://www.anthropic.com/claude-opus-4-6-system-card | Claude Opus 4.6 post/system card, Feb 2026 (via official-domain search snippet) |

## 5. Limitations

- **Pages fetched through a summarising fetch tool.** Facts were extracted by a model reading each page; long pages were
  partly read (CC-OTEL first 100k chars; CC-CHG only the top). Exact quotes should be rechecked before publication.
- **Benchmark figures (EV-OAI, EV-ANT) come from official-domain search snippets, not full page reads**; openai.com
  returned 403 to direct fetch. They are model claims under vendor harnesses (Anthropic: Terminus-2), not harness
  measurements, and newer models (GPT-5.6/GPT-6, later Claude models) may have newer claims not captured here.
- **Codex:** edit/patch model, `update_plan`/todo tool, Esc backtrack/undo, CLI-specific slash commands (`/resume`,
  `/diff`, `/approvals`) and Linux seccomp/Landlock use were not confirmed on fetched pages; the slash-command page is a
  unified app/CLI page. Local `--oss` details (auto-detect vs prompt) come from the config reference only; third-party
  guides were not used as evidence. Network default for `workspace-write` is not stated on the sandbox page.
- **Claude Code:** licence text not read; foreground Bash default timeout not isolated from background limits; plan-mode
  details read from the permission-modes summary only. Local/non-Claude models are explicitly unsupported per CC-GW.
- **OpenCode:** docs at opencode.ai/docs may describe 1.x while v1.19.0 offers an upgrade to "OpenCode 2"; 2.x behaviour
  was not researched. Compaction, todo tool, bash timeout not documented on pages read.
- **Goose:** permission-modes page fetched empty; facts come from an official-domain search result. Sandbox, session
  storage, telemetry/OTel and recipe/subagent internals not verified.
- **Aider:** no approval/sandbox/compaction/telemetry pages read; GitHub release year inferred; cadence looks slow
  (last PyPI release 2026-02-12). Crush and OpenHands were not assessed.
- No peer was installed or run; nothing here is measured, and mechanism similarity does not imply parity.

## Checks actually run

- WebFetch/WebSearch on each URL in the citation list (2026-10-12); grep over locally saved copies of long Claude Code
  pages (permission-modes, sandboxing, context-window, tools-reference) to extract exact sentences.
- No commands run against /home/mike/nexus-code (web-only task; RULES.md read-only constraints respected).
