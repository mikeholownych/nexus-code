# Changelog

All notable changes to Nexus Code are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Detailed per-release documentation is maintained in [`docs/releases/`](docs/releases/).

## [Unreleased]

Inventory of work already on `release/v1.3.0` toward v1.3.0 (version strings still 1.2.2). Full unit table and open gaps: [`docs/releases/v1.3.0-READINESS.md`](docs/releases/v1.3.0-READINESS.md). External qualification pending; not a frontier-grade claim.

### Added
- Client protocol schemas and docs (PF-1), `nexus run --json` result contract (PF-2).
- ACP adapter and conformance fixtures against Zed and CodeCompanion (AC-1, AC-2).
- `nexus verify`, MCP/ACP verify surfaces, sandbox-denial receipt records (VR-1, VR-2, VR-3).
- Managed policy tiers, audit export/verify, flight hash chain, telemetry transparency and opt-out, admin strict mode and allowlists (GV-1–GV-5).
- LSP lifecycle, bounds, position encodings and project roots (LS-1, LS-2).
- Experimental detached jobs: a supervised Linux runner, isolated worktrees, unattended policy, bounded budgets, receipts, recovery, and operator commands (BG-1).
- Experimental unattended schedules (BG-2): `nexus schedule add|list|status|remove|pause|resume|run-now` with `--cron`, `--every` and `--at` (UTC); the runner starts each run as an unattended job through the same path as `nexus job start`. A schedule needs a trusted workspace, fixes its permission level when added and is a path the agent's file tools refuse; missed runs are counted and reported (an optional single catch-up job with `--on-missed run-once`, never a burst), overlapping runs are skipped and recorded, and a clock stepped backwards never runs a slot twice. The job receipt gains `schedule_occurrence` and a filled-in `missed` (additive, version 1); new schedule file schema `docs/protocol/schedule-v1.schema.json` and [`docs/SCHEDULES.md`](docs/SCHEDULES.md).
- CI CLI-suite shard fan-out under stable required check names.
- Experimental unix-socket transport for the sidecar (PF-3): `sidecar.js --listen` binds a socket (mode 0600) in a private 0700 directory and prints its path on one stdout line; other clients attach with a per-start random token from a 0600 descriptor file, as one controller or as read-only observers, and may detach and attach again. A wrong, missing or late token is refused with one fixed line before any command is parsed. No client can grant allow-always or change the mode over the socket, and `--listen` is refused under auto approval. No TCP, HTTP or WebSocket listener. Protocol stays 1 (new error codes `UNAUTHORIZED`, `NOT_CONTROLLER`, `NOT_PERMITTED`); `docs/PROTOCOL.md` "Socket transport", `examples/attach/`.
- Experimental event triggers (BG-3): `.nexus/triggers.json` specs approved per trigger with `nexus triggers approve` (a person at a terminal, the exact word `yes`); the runner fires them as unattended read-only jobs on a file change or a signed loopback webhook (`nexus runner serve --webhook-port`), with a persisted, validated rate limiter and quarantine, a loop guard, counted drops, and receipts that name the trigger and event. New `nexus triggers status|release|fire-test`. Job `origin` and receipt gain trigger fields (schemas additive, version unchanged). See `docs/TRIGGERS.md`.
- Command hooks (HK-1): `pre-tool` and `post-tool` programs declared in `~/.config/nexus/hooks.json` or an approved `<workspace>/.nexus/hooks.json`; a hook can deny a tool call and can never approve one or change its input. Approving project hooks needs a person at a terminal and covers the workspace scripts the hooks run. `nexus hooks list|approve|revoke|test`, a `hooks.config` doctor finding, `docs/HOOKS.md`.

### Fixed
- BG-2 schedule recovery after a crash between job submit and schedule update: restore `lastFire`, decrement `remainingRuns`, and disable at zero so `--max-runs 1` cannot fire again; treat an in-flight job for the same slot as recovery, not overlap.

### Changed
- Parallel resource admission for operations (PA-1 partial); staged PA-4 workflow surfaces as documented under `docs/v1.3.0/`.

### Not yet in Unreleased (still open on the plan)
- PF-3 (UDS transport), HK-2 (plugins) and the other hook events of HK-1, PA-2 and remaining PA-1/PA-4 items. Context-maturity and WP-P10-02 remain Codex-owned.

## [v1.2.2] - 2026-11-21

### Changed
- VC-8: the implementer and tester roles are refused the tools that reach outside the task. Both lose the browser tools and `manage_knowledge`; the tester also loses `fetch_web`, `search_web` and `spawn_subagent`. The agent neither offers a refused tool nor runs it when the model calls it anyway; the denial names the role and says why. Editing, testing, shell, git, LSP and objective tools are unchanged, and the path guards, verifier and review remain the controls for what they may change. Owner choice: network and side-channel tools (2026-11-21).
- Redaction variants (MT-3, part 2): `formatSafeSidecarText` calls the shared `safeTerminal` instead of restating it, with output byte-identical; the remaining variants are kept and each has a reason in `docs/v1.2.1/REDACTION_VARIANTS.md`. New `cli/test/mt3_redaction_characterization.test.ts` pins the exact output of 23 redaction and terminal-safe variants over a shared corpus.

### Added
- VC-9 (the two remaining cases): in `nexus run`, a requirement the model marks blocked now ends the run `BLOCKED / NEEDS_INPUT` (`kind: blocked_requirement`) with the blocker as the question, answered in free text with `--answer <id>=reply:<text>`; before it ended `COMPLETED / REQUIREMENTS_INCOMPLETE` with the reason only in a note (other surfaces are unchanged; the task status for this case is now `failed`, exit code still 1). Steering that would drop a requirement and got no decision before its turn ended now ends that turn `BLOCKED / NEEDS_INPUT` (`kind: steering_conflict`) and can be decided afterwards: `--answer <id>=approve|decline`, or the new sidecar command `answer`; before, the conflict stayed `unresolved` with nothing at turn level and could not be decided later. Details and limits: `docs/v1.2.1/VC-9-needs-input-audit.md`.
- CS-10 (Docker and phase 2): on Linux, `--sandbox docker` now runs the native worker inside the hardened container as well (before, Docker confined commands only and the worker kept the operator's access). The worker is mounted read-only with the loader and libraries it was linked against in a private directory, so it starts in the pinned Alpine image without changing the image; its commands run in that container with the image's `sh`, as they did. `--sandbox docker` fails closed when the container cannot be built; plain `--sandbox` tries Bubblewrap, then Docker. Whenever the worker is sandboxed (either engine), file, search, parse and git tools go to a second worker started with `harness-core --files-only`: it refuses `run_command`, `cancel`, `end_background` and `list_services`, and its sandbox has no network even with `--sandbox-network`. The command worker starts only when a command is first run. A core that does not report files-only mode in `hello` is not used for that role. Behaviour change: with a containerised worker, commands in one session share the container's `/tmp` instead of each getting a fresh container. Design: `docs/v1.2.2/CS10_WORKER_ISOLATION.md`.
- Significant independent reviews now require eight non-empty engineering-assessment fields when a diff touches core code, five or more files, or at least 300 added/removed lines. The parser derives significance from the diff, fails closed on malformed or incomplete assessments, and never lets the assessment override verifier, scope, boundary, defect, or unproven-criteria rejection. This records review evidence; it does not prove the model's assessment is correct or independent.
- CS-9: operator command rules in `~/.config/nexus/command_rules.json` (operator home only; a project file is never read). Prefix rules decide a shell command as `allow` (no prompt in review mode), `prompt` (asks even in auto mode, unless `--yes`) or `forbidden` (refused in every mode); the strictest rule wins. `allow` needs every part of a chained command to match and no shell-active character; `prompt` and `forbidden` match any part. `match` and `notMatch` examples are checked when the file loads and a contradicting one rejects the whole file (reported once; the normal policy applies). The deciding rule is recorded and appears in the session export. Read-only mode, the sandbox and verification protection still apply to an allowed command. See `docs/COMMAND_RULES.md`.
- VC-2: an authorised regression obligation is discharged only when the verifier output reports a recognised result for that exact test. A green suite that does not show the test, a skipped result, and older pass records without test-name binding remain unresolved and block completion.
- CS-11: a command that fails with only volatile text changing (a retry counter, request or job number, ephemeral port, temp directory name, counter after a transfer verb, compound duration; an HTTP status, a build step index and outcome counts stay distinct) is now the same failure to the non-progress tracker and to CS-3: it is noted and, with continuation on, stopped, instead of running to the step limit. The volatile-text patterns are anchored to a context word or unit, never to a bare number, and were measured on a new 86-pair labelled corpus (`cli/test/fixtures/volatile_text_corpus.json`): same-failure pairs merged 6 of 38 before, 34 of 38 after; genuinely different failures merged 0 of 48 before and after. Four same-failure pairs stay unmerged on purpose (`docs/LOOP_PATTERNS.md`).
- VC-9: a delegated subagent's headless decision (tool approval, verification-file edit, verifier approval) is no longer lost. The subagent stops at it and returns the question (same id and shape, plus `subagent: { depth, objective }`) to its parent, whose headless run ends BLOCKED / NEEDS_INPUT; `--answer` resumes it (the re-spawned subagent receives the answers). Further questions raised in the same turn are listed in `furtherNeedsInput`. The subagent itself still never approves. Interactive runs and top-level behaviour are unchanged. The child is spawned again on resume, not resumed. The requirement-verifier approval now has its own test.

### Fixed
- A failing type-check whose output is coloured is `FAILED`, not `ENVIRONMENT`. With `FORCE_COLOR=1` in the operator's environment `tsc` wraps the file, line and column in escape sequences; the diagnostics parser then located no file and the check was classified "could not run", which does not block completion (VC-6, CG-4). Escape sequences are removed before parsing.
- A native worker that exits right after launch (for example a Docker worker whose container fails to start) no longer raises an uncaught `EPIPE` that ended the CLI: the worker's stdin stream has an error listener and the waiting request is answered as a disconnect.
- Saving progress no longer fails on a worktree binding left over from an earlier turn ("Task state worktree path has no selected workspace identity"); it showed only when the workspace directory name tripped the secret classifier's high-entropy check.
- VC-6: Cargo projects are part of the pre-change type-check baseline (the per-workspace target directory is reused, so dependencies are not built twice); a regression case covers a pre-existing Rust diagnostic against a new one in an untouched caller.
- MCP and plugin tools now run. They were offered to the model but never registered in the capability registry, so the execution spine answered every call with `FAIL-001: Tool ... is not registered`; the server never received `tools/call`. They are now registered after connection as `extension` capabilities with conservative defaults: mutating (read-only sessions refuse them), `egress` for a remote server and `exec` for a local process or plugin (review mode asks first), and only local ones count as changing the workspace. Reproduced against a local MCP server first (`cli/test/mcp_tool_through_spine.test.ts`).
- The real language-server job's Rust setup: rust-analyzer is now added to the default toolchain (the product launches servers outside the repository, where the repository's pinned toolchain does not apply), and the test's availability probe runs in the fixture directory, as the product does.

### Fixed
- `lsp_diagnostics` for Rust no longer reports a file with type errors as clean: rust-analyzer sends an empty first `publishDiagnostics` before it has loaded the Cargo project and analysed types, and the client returned on it. Servers that analyse in stages are marked `awaitProgress` (rust-analyzer is); the client now advertises work-done progress, answers the server's own requests (`window/workDoneProgress/create`, `workspace/configuration`, ...), and waits for the server's progress to end (within the caller's timeout) before trusting a list.

### Changed
- The weekly real language-server job requires typescript, python and go (all three passed on the first hosted run); the rust-analyzer case still runs but reports as a todo, because the product could not start rust-analyzer on the runner although its `--version` probe passed (cause undiagnosed).

### Added
- Behavioural differential against a declared reference (plan unit VC-3, rest): `/requirements differential <R> --inputs <file>` runs the objective's latest verifier command and the operator-authorised reference command on each input (a JSON array of at most 50 strings, each at most 64 KiB) in the sandbox without network (30 s per run, output capped at 1 MiB), compares normalised output and exit code, and reports "run: N agree, M diverge" with the first differing line per divergence. A timed-out, errored or over-cap run is inconclusive, not agreement. Agreement on tested inputs is not equivalence; the model cannot trigger it or name the reference.
- Real language servers (CS-6): `cli/test/lsp_real_servers.test.ts` runs the product's LSP client against typescript-language-server, pyright, rust-analyzer and gopls on a tiny fixture project (a deliberate error is reported; a clean file is a real empty report, not `unavailable`), skipping a server that is not installed unless `NEXUS_LSP_REQUIRE` names it. A weekly, non-required `lsp-real-servers` workflow installs the servers and requires TypeScript and Python. Not yet run on a hosted runner. See `docs/LSP_REAL_SERVERS.md`.

### Fixed
- `lsp_diagnostics`, `lsp_hover` and `lsp_definition` never worked for TypeScript, JavaScript or Python files: the default commands started `typescript-language-server` and `pyright-langserver` without `--stdio`, so both exited at once and every query was `unavailable`. Found by the real-server test (CS-6).

### Fixed
- The nightly real-project smoke (MQ-3) failed on its first hosted run on the pytest repository: the workflow installed pytest with `pip install --user`, the smoke runs the CLI under a throwaway `HOME`, and the verifier could not import it, while the script's own pytest probe ran under the real home and said it was available. The probe now runs under an isolated home (and says to install system-wide), and the workflow installs pytest system-wide.

### Changed
- The verifier convergence stop (DV-2: a stalled, oscillating or diverging failure history ends the turn BLOCKED with the attempt history) is now also judged when a verifier command is run through `run_tests` (or `run_command`), not only when the model calls `task_completed` (VC-7). A loop that only edits and re-runs the tests no longer waits for the step limit. A failure that changes each time, or a re-run on unchanged files, does not trip it.

### Added
- `scripts/gateway_conformance.mjs` and `docs/GATEWAY_CONFORMANCE.md` (MQ-4): a scheduled gateway conformance job for a local scheduler. It takes the `GATEWAY` claim without waiting (a held claim skips the run, exit 75), runs the unmodified tool-call matrix, judges each alias's native-valid ratio against the 99.5% bar and a baseline, and alerts (alert file and an operator command) on a drop, a run that produces nothing, or an alias below the bar; the claim is released on every exit path. Tested through the script with a fake runner; not yet run against the live gateway, and nothing is scheduled by the repository.

### Added
- `cli/test/loop_patterns.test.ts` and `docs/LOOP_PATTERNS.md` (CS-11): OpenHands' stuck-detector patterns replayed as deterministic scripted transcripts against the real agent turn, asserting what Nexus actually does with and without continuation. One gap is documented, not fixed: a command that fails with different text each time is neither noted nor stopped (bounded by the step limit).

### Fixed
- Regression obligations (v1.2.1 plan VC-2): `task_completed` is now refused while an operator-authorised obligation is unmet, naming the obligation, its test and the command that replays it; a passing run of that command lets completion proceed, and a run with no obligations is unchanged. A weakening edit to an obligated test is now recorded for edits made through `run_command` as well (from the CS-2 shell snapshot and diff), and for file-tool edits when no UI observer is attached, which was previously never recorded.
- A user asking the model to show an example tool call (a message with an example word and a call word) no longer triggers the call-written-as-text recovery for that turn (CS-5): the client does not ask again or force `tool_choice: required`, so under auto or full-access approval a demonstration cannot end as an executed call. A request such as "add an example to the README" does not switch the recovery off.

### Changed

- Cross-runner reproducibility (`repro.yml`) now also runs weekly against the newest published RC pre-release; manual dispatch is unchanged. It is not a required check (v1.2.1 plan PC-4).
- CI runs `check_requirements.mjs --enforce` in `test-matrix` (v1.2.1 plan DH-6).

### Fixed

- The compiler-exposure inventory could fail a qualification scan on a loaded host with `enumeration_exit_batch_N_signal_sigterm`, because it signalled a `find` that had already finished writing (v1.2.1 plan PC-7).

### Added

- Type-check gaps closed (plan unit VC-6). A type-check run before the change (tsc, `go vet`, pyright or mypy; not cargo, whose first check compiles dependencies) records the errors that already exist, so an error that newly appears in a file the task never touched (a caller the change broke) now blocks `VERIFIED`, while an error the baseline already had stays `PREEXISTING`. Files changed through the shell (a command, formatter or generator) count as modified, read from the workspace diff minus what was already changed when the task began. Go projects (`go.mod`) run `go vet ./...` offline; Python projects run pyright or mypy only when the project configures one (`pyrightconfig.json`, `[tool.pyright]`, `mypy.ini`, `.mypy.ini`, `[tool.mypy]` or `[mypy]` in `setup.cfg`), from `.venv/bin` or `PATH`. A tool that is not installed is reported `UNAVAILABLE` (nothing was checked, no approval is asked, never a pass). `NEXUS_TYPECHECK=off` still disables all of it. A resumed task has no baseline and keeps the earlier behaviour.
- Headless needs-input (plan unit VC-9, partial). A headless run that needs an approval nobody is there to give (a write, command or egress in review mode, a verification-file edit, the verifier or type-check at completion) now ends `BLOCKED` with reason `NEEDS_INPUT` and a machine-readable `needsInput` question (`id`, `kind`, `prompt`, `subject`, `options` approve and decline) instead of letting the model work around a refusal. `nexus run --resume <task> --answer <id>=approve|decline` answers it; an answer covers only that exact action. The audit of every path, with file and line, is `docs/v1.2.1/VC-9-needs-input-audit.md`; a blocked requirement, an unresolved steering conflict and a subagent's question are not covered yet.
- Tool-output masking (plan unit CX-4, opt-in): with `NEXUS_TOOL_OUTPUT_MASK_TOKENS=<n>`, a tool result larger than n estimated tokens that the model has already acted on is replaced in later requests by a short marker with a content id. The full output stays in the conversation and resolves with `read_archive` and the query `tool-output:<id>`. Results not yet acted on, retrieval results, the pinned ledger, findings and the independent reviewer's evidence are never masked, and the saved session is unchanged. Off by default.
- Session fork (plan unit RD-6): `/fork [message-count]` continues in a copy of the current session (optionally only its first N messages, backed up to a complete tool exchange); the original is never modified and both can be resumed. Compaction records and archive lines are copied for the compactions the fork keeps, so the resume audit still verifies them. The start-up flag is below.
- Session fork start flag (plan unit RD-6, rest): `nexus run --fork-session <task-id> [--fork-at <n>] <prompt>` forks the task into a new id (printed on stderr), then runs the prompt in the fork; `nexus repl --fork-session <id> [--fork-at <n>]` (and `nexus --fork-session <id>`, which opens the REPL) starts the REPL in a fork of a saved session. The source is never modified. An unknown source, a bad `--fork-at`, `--fork-at` without `--fork-session`, and `--fork-session` together with `--resume` (ambiguous) are refused with exit code 2. A session bound to a git worktree is refused, and creates nothing: a fork would share the checkout with the original (`/fork` in the REPL and TUI refuses the same way while a worktree is active). `run --fork-session` takes the same ids as `run --resume` (the task store). The fork's `forkedFrom` note is not kept once the fork's own turns are saved.
- Operator-authorised regression obligations (plan unit VC-2): `/requirements obligate <attempt> <test>` promotes a confirmed failing test; it is replayed by every later attempt of its verifier command, keeps its original failure record when minimised (`minimise`), and an edit that removes, skips or thins the test is recorded. Nothing the agent can call promotes an obligation
- Attempt lineage (plan unit VC-3, part): each verification attempt records its parent attempt and a hash of the step between candidate identities; `/requirements reference <R> <ref>` records an operator-named behavioural reference. The differential against it is not implemented
- Project instruction files expand `@path` imports (plan unit CX-7): in `AGENTS.md`, `CLAUDE.md`, `CODEX.md` or `.nexusrules`, a token such as `@docs/rules.md` or `@AGENTS.md` is replaced by that file's contents. Imports resolve against the importing file, must stay inside the workspace by real path (a symlink out is refused), must be regular files of at most 64 KiB (256 KiB in total), are read once each, and nest at most 5 levels, so a cycle ends at once. Code spans, code fences, `@mentions` and anything unresolvable stay literal. Only a trusted workspace is expanded. The heading of the instruction block lists the file and every import that was read (`loaded from CLAUDE.md; imports: AGENTS.md`). Still the first non-empty file only; the files are not merged.
- Prompt-cache hints for Anthropic (plan unit CX-6, opt-in): with `NEXUS_PROMPT_CACHE=1`, requests to a provider that declares `promptCache: "anthropic"` (built-in Anthropic only) send `system` as blocks with `cache_control: {"type":"ephemeral"}` on the first block (the system prompt, which also covers the tools) and the last (the pinned ledger), two of the four breakpoints. Off by default and not verified against the live API (the request shape is covered by tests and a local mock). The usage summary (`/tokens`, run summaries) now reports the cached share of input tokens, for example `cached 300 of 500 input tokens (60%)`, from the provider's reported cache counts, counting Anthropic and Bedrock input as separate from cache reads and writes.

### Changed

- One shared helper for escape-stripped redaction (`redactPlain`), one terminal-safe helper (`safeTerminal`) and one sanitisation-failure constant replace identical copies; no output changed (plan unit MT-3, `docs/v1.2.1/REDACTION_VARIANTS.md`)

### Security

- CS-10: with `--sandbox bwrap` (and plain `--sandbox` where Bubblewrap is installed) the native worker `harness-core` runs inside the same Bubblewrap box as sandboxed commands: read-only root, only the workspace writable, `$HOME` masked, scrubbed environment, no network unless `--sandbox-network` (one switch for the worker and its commands), and it ends with the CLI. Before, only commands were confined and the worker ran with the operator's full access (a test acting as a compromised worker read a canary under `$HOME` and wrote outside the workspace; it now cannot). Commands are no longer wrapped a second time inside the worker's box. `--sandbox bwrap` fails closed if the box cannot be built, instead of starting the worker unconfined; plain `--sandbox` without Bubblewrap and `--sandbox docker` behave as before (Docker confines commands only). `nexus doctor` reports where the worker runs. Design: `docs/v1.2.2/CS10_WORKER_ISOLATION.md`.

## [v1.2.1] - 2026-11-18

### Security

- Commands run through `run_command` no longer inherit credentials from the Nexus process. Variables from `~/.config/nexus/config.env`, plus anything named like a key, token, secret or password, `AWS_*`, `GH_TOKEN` and similar, are removed from the command environment, including inside the write-mode bwrap sandbox. To pass a variable through deliberately, list its name in `NEXUS_COMMAND_ENV_PASSTHROUGH` (operator environment or `config.env` only). Commands that relied on `SSH_AUTH_SOCK`, `GH_TOKEN` and similar must now opt in. Without `--sandbox` a command still runs as your user and can read your files and its parent processes' environment.
- `--sandbox` now actually confines. Write-mode sandboxed commands run with `$HOME` masked, so `~/.ssh`, `~/.aws`, `~/.gnupg` and `~/.config/nexus` are unreadable, even when the workspace is, contains, or sits above `$HOME`. Only toolchain directories (`~/.cargo`, `~/.rustup`, `~/.nvm`, `~/.local/bin`, `~/.npm`, `~/.cache/pip`, `~/go/pkg`, `PATH` entries under HOME) are mounted read-only; extend them with `NEXUS_SANDBOX_HOME_READONLY`. The network is off by default; opt in with `--sandbox-network` or `NEXUS_SANDBOX_NETWORK=1` (not implied by `--yes`). Sandboxed commands die with the runner and cannot see host processes. `nexus doctor` lists the effective mounts and overlays. Files outside `$HOME` remain readable inside the sandbox.
- The legacy task-worktree merge refuses a worktree whose `.git` was replaced, and runs Git with hooks and fsmonitor disabled; a planted `core.fsmonitor` or hook in an agent-writable worktree no longer runs code outside it. The repository's own hooks no longer fire on that commit and merge.
- The `--sandbox docker` engine runs a digest-pinned image (alpine 3.23) as the invoking uid with all capabilities dropped, `no-new-privileges`, a read-only root plus a tmpfs `/tmp`, a 512-process limit, and no network unless `--sandbox-network` / `NEXUS_SANDBOX_NETWORK=1` is set. Only the scrubbed command environment reaches the container, and credential locations under a workspace that is or contains `$HOME` are masked. `NEXUS_SANDBOX_DOCKER_IMAGE` (operator setting) may substitute another image but it must be digest-pinned, otherwise no container is started. Commands that wrote outside the workspace and `/tmp`, relied on root, or used the network now fail in Docker mode.
- A compaction summary (including `compact --llm`) is now labelled in every request as untrusted data with its source, under the "Structured Context Memory" header: text from earlier tool output or fetched pages that reached the summary is information about the task, never instructions. The label is added to the request copy only; the stored conversation and its provenance are unchanged (plan unit CX-1).
- Per-provider spending limits (PR-10): `NEXUS_CLOUD_LIMITS` (JSON keyed by provider id with `maxRequests`, `maxTokens`, `maxCostUsd`) on top of the process-wide limits. A provider that reports no cost is priced from the models snapshot; with no price the cost limit is refused as unenforceable, and a malformed value refuses every cloud request.
- `nexus doctor` reports effective containment (CS-1): with no `--sandbox` the `sandbox.confinement` finding says "Effective containment: none", whether bubblewrap is available, and the flag that turns confinement on. Containment stays opt-in (decision D1); nothing about how commands run changes.
- Prompt-injection scanner (CS-7): a tool result that carries instruction-like text aimed at the assistant, hidden or bidirectional Unicode, fake chat or tool-call markup, or an encoded payload of those is labelled and fenced (`<<<UNTRUSTED RESULT BEGIN/END>>>`, content kept, hidden characters shown as `<U+XXXX>`), reported on the `security.injection_suspected` stream event, and gates the next step's state-changing calls on operator approval when an operator is present. A heuristic, not a guarantee: on the labelled corpus it caught 54/64 attacks it was tuned on and 15/30 written after it was frozen (0/12 deliberate evasions) and flagged 5/45 and 2/24 benign samples. See the User Manual for the limits.

### Fixed

- CERI evidence store (audit F06, MQ-7 slice B): evidence paths are checked by resolved path, not by string prefix. A symlinked evaluation or run directory that leads outside the store is refused. Run ids must start with a letter or digit, be at most 128 characters, and avoid `..` and the `.abandoned-` marker. A run id that differs from an existing one only by case is refused. See `docs/CERI_EVIDENCE.md` for what the integrity record does and does not prove.
- CERI baseline comparison (audit F02, MQ-7 slice C): a baseline is bound only when manifest hash, model name, digest and quantization, sampling, fixture identity (new `fixtureSha256`, `hashFixture`), evaluator and evaluation versions, configuration and toolchain all match. A mismatch gives a non-certifying result whose `identityBinding.mismatchedFields` names every differing field. `loadVerifiedBaseline` and `compareToVerifiedBaseline` are the certifying path. CONFIRMED_REGRESSION is no longer reachable from the `isRepeatReproduction` / `isPriorRegressionCandidate` flags (they are ignored for confirmation); it needs a verified baseline and a second verified run (`priorRunId`) that regressed the same assertion. The runner option `isRepeatReproduction` is replaced by `priorRunId`.

### Added

- Real-project smoke (MQ-3): `scripts/real_project_smoke.mjs` and a nightly, non-required `real-project-smoke` workflow run the built CLI on pinned synthetic repositories (JS with `node_modules`, a Makefile with a large reference graph, a deeply nested tree, a Python project with pytest config) against a scripted local gateway, and fail when a completion errors, hangs or ends in anything but REGRESSION_FREE or VERIFIED. This is the check that would have caught the v1.1.4 every-completion error. `--seed-regression` proves the job can go red. Mock gateway and synthetic repositories only. See `docs/REAL_PROJECT_SMOKE.md`.
- Amazon Bedrock Converse protocol (`"protocol": "bedrock-converse"`, `"auth": "sigv4"` in `providers.json`): SigV4 signing on `node:crypto` with no new dependency, the AWS event-stream parser for ConverseStream, and a read-only AWS credential chain from the environment and the shared credentials and config files. Credentials are never printed or logged. Verified against AWS's published SigV4 test vectors and recorded fixtures (plan unit PR-7).
- Google Vertex AI over the Gemini protocol (`"protocol": "gemini-generate-content"`, `"auth": "gcp-adc"` in `providers.json`; no credentialEnv): a service-account key file (`GOOGLE_APPLICATION_CREDENTIALS`) is exchanged for a bearer token with an RS256 JWT signed on `node:crypto`, cached and refreshed one minute before expiry (concurrent requests share one refresh); with no key file the token comes from `gcloud auth print-access-token` (no shell, 15 s bound). The URL is `https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:streamGenerateContent` (`global` uses `aiplatform.googleapis.com`), with project and location from `GOOGLE_CLOUD_PROJECT` (else the key file) and `GOOGLE_CLOUD_LOCATION`, both validated. The key, assertion and tokens never appear in errors or logs. Verified against fixtures and a local mock only; no live call (plan unit PR-8). `nexus doctor` no longer reports `sigv4` and `gcp-adc` providers as missing a credential.
- CERI `semantic_integrity` gains the frozen scenario `repeated-call-01` (CS-3): identical tool calls with identical results, repeated with other calls between them, end the turn BLOCKED `TOOL_CALL_LOOP` whatever the timing, and a varied-argument sequence is never stopped. The frozen file and its sha256 manifest were updated together; 26 scenarios are now active, none pending.

### Added

- Gemini native wire protocol (`gemini-generate-content`, plan unit PR-6): `generateContent` and `streamGenerateContent` with `functionCall` parts (parallel calls included) mapped to tool calls, thought summaries kept out of the answer, and `thoughtSignature` parts replayed only to the model that produced them. Declare a provider with `"protocol": "gemini-generate-content"`, `"auth": "header"` and `"authHeader": "x-goog-api-key"` in `~/.config/nexus/providers.json`; the key travels in the header, never the URL. No built-in provider uses it yet (Gemini's OpenAI-compatible endpoint stays as shipped).
- `nexus` model listing understands Gemini's `models/<id>` catalog and offers only models that support `generateContent`.
- Security fixes from the v1.2.1 release review: the egress inspector's policy now comes only from the operator's environment (`NEXUS_EGRESS_POLICY`); a repository's `.nexus-security.json` can no longer switch it off or allow-list a host (the request is ignored and reported). A network tool behind a wrapper (`env`, `sudo`, `timeout`, `nice`, `nohup`, `command`, `xargs`, `sh -c`, `eval`) is now inspected. A variable is a secret by a whole name part (`API_KEY`, `DB_PASS`, `ACCESSTOKEN`), so `$PWD`, `BYPASS_CACHE` and `COMPASS_DIR` no longer block a network command. The models.dev refresh enforces its 30 MiB cap in bytes while streaming. A prompt-injection suspicion no longer carries into the next turn (it gated the early steps of the following turn with a warning about the previous one).

### Changed

- `cli/src/agent.ts` is split along its seams (MT-1): the spine handlers, the turn loop, tool dispatch, the completion oracle (verifier approval, type-check, baseline, independence) and the module-level helpers now live in `cli/src/core/`. `AutonomousAgent` keeps the same public API and the same member names as thin delegating methods; no behaviour change.
- The dependency deprecation check retries a transient npm registry failure (network error, timeout, truncated body, HTTP 429 or 5xx) up to 3 times, 1 s then 3 s apart, before failing closed; a 404 or 403 is a real answer and is not retried. A single registry blip had turned main red.
- Egress inspector (CS-8): before `fetch_web`, `search_web`, `browser_navigate`, `browser_type` or a `run_command` network command (`curl`, `wget`, `nc`, `ssh`, `scp`, `rsync`...) runs, Nexus checks it for the workspace's own secrets (secret-named values in the root `.env` files as written, URL-encoded or base64; a set secret variable the command expands; a credential file it reads) and refuses it with `EGRESS_SECRET_BLOCKED`, naming the secret and never its value. Local and private-network destinations are not inspected. `egressInspector` in `.nexus-security.json` sets `mode` (`block` default, `record`, `off`) and `allowDestinations`. It does not see secrets a command builds at run time.
- Operators can declare boundary rules in an operation spec (`boundaries`: import deny/allow lists, protected public files, interface and schema files, import cycles). The review gate checks them on each candidate diff by deterministic line analysis and REJECTs a violation whatever the model says; an undeclared dependency and a potentially breaking or unclassifiable interface or schema change are advisories, and every verdict carries what was and was not analysed. The CERI scenario `cumulative-change-03` is now active, so no scenario is pending (VC-1, VC-4).
- `/compact --llm` now checks the model's summary against the gating requirements with a second bounded call before using it; a summary the check says dropped a requirement, or that could not be verified, is replaced by the deterministic summary and the reply says why. The pinned-ledger check remains the hard guarantee (CX-3).
- Each compaction now leaves an auditable record on its first archive line (the ids of the messages it covered, one digest over them, and where its summary block was inserted). On resume the archive is checked against it: a mismatch is reported with the covered ids and that compaction's archived messages are not used, and when the compaction's own output is gone from the saved conversation but the archive verifies, the full transcript is restored from the archive (CX-2). Older archives without a record resume exactly as before.
- `verificationPaths.mode: "block"` now also stops shell writes to verification files (CS-2, opt-in per the recorded decision D2; the default modes stay record-only): each `run_command` is fingerprinted before and after by file contents, and a change to a verification file (Makefile, CI, test config, verifier scripts, `package.json` scripts) is restored, refused as `VERIFICATION_CONFIG_PROTECTED` with the changed lines, and recorded as blocked. New runnable test files and non-verification `package.json` edits are unaffected.
- The literal secret patterns now live in one table, `cli/src/redaction_patterns.json`, which the TypeScript redactor is built from; the Rust sidecar-stderr redactor mirrors it. `cli/test/redaction_parity.test.ts` fails when either side adds, drops or edits a pattern without the other, and both sides run one shared corpus (`cli/test/fixtures/redaction_corpus.json`, with no key-shaped literal committed). Redaction behaviour is unchanged: the old and new TypeScript redactors agreed on 20,000 generated inputs. The other redaction and terminal-safe helpers are layered, not duplicates, and are unchanged (MT-3, part).
- `scripts/flake_report.mjs` and a weekly `flake-report` workflow record CI rerun events (a run that failed and then passed unchanged), name the failing tests from the earlier attempts' logs, and fail when a test needed a rerun in 2 of the last 20 runs; the JSON report is kept as an artifact. A failure fixed by pushing a new commit is not a rerun and is not counted (PC-3).
- `action/` is a composite GitHub Action that installs a pinned release and runs `nexus run --json`, failing the step unless the task completed and verified (exit code is the gate; `success`, `status`, `task-id` outputs; inputs reach the script only as environment variables). `examples/` adds a verified-completion task, a worktree run, an operation spec with `git.isolate` and a pull-request workflow; every one is run by `cli/test/examples.test.ts` (RD-4, DH-3).
- `nexus run --output stream-json` streams NDJSON events (start, assistant text, tool start/end, notices, result) on stdout and nothing else; `--output json` is `--json`. Schema in `docs/STREAM_JSON.md` (RD-3).
- A shipped catalog (`providers.catalog.json`) adds the OpenAI-compatible long tail as data: Mistral, Groq, Together AI, DeepSeek, xAI, Fireworks AI, Cerebras, Perplexity, Gemini, Cloudflare Workers AI, Azure OpenAI and Bedrock (OpenAI-compatible). Each has a recorded-fixture conversation test (text, tool call, reasoning, truncation, error); none was run against the live services (PR-5). An operator `providers.json` base URL is now optional.
- Behaviour now follows the selected model's listed capabilities (models.dev data), never assumed when absent: a model that lists no `tool_choice: required` is not sent a forced re-ask after the corrective note; per-model context and output limits sit between the operator/advertised values and the 65,536/8,192 defaults (source `snapshot`); `nexus doctor` warns when the configured reasoning effort is not one the model lists (PR-4).
- `nexus models refresh` (explicit, the only command that contacts models.dev) validates fresh model data and writes a private local cache that overrides the bundled snapshot; `nexus providers` shows which is in use and its date (PR-3).
- `nexus providers` marks operator-declared providers, `nexus doctor` gains `config.providers_file` (a declared provider without a credential warns), and `docs/CLOUD_PROVIDERS.md` documents `providers.json` (PR-12).
- Added a per-provider-definition wire matrix test (PR-11): every key-authenticated definition, built-in and operator-declared, is exercised for a streamed text reply and a tool call against a local mock, asserting path, query, the single credential header, static headers and omitted parameters.
- Operators can declare their own providers in `~/.config/nexus/providers.json` (operator home only; a project file is never read): id, label, protocol, a base URL template with validated `{variables}`, fixed query parameters, extra headers, and `bearer`, `x-api-key` or custom-header auth, with several named providers instead of one compatible slot. Errors name the field. Example: Azure OpenAI with a deployment path, `api-version` query and `api-key` header (PR-2 slice 3).
- Added `provider_safety` validation for operator-declared providers (id grammar, https-only unless local, no URL credentials, validated template variables, forbidden and auth headers refused); a provider base URL containing credentials is now refused (PR-9, groundwork for the operator providers file).
- Provider enumeration goes through one accessor (`allProviders()`/`providerIds()`), and a provider id that matches an inherited object key (`constructor`) is no longer treated as known (PR-2 slice 2).
- Provider definitions now carry per-model protocol rules (`protocolRules`) and a header-name auth style (`auth: "header"` with `authHeader`), replacing the hard-coded Copilot gpt-5 check. Built-in providers behave identically (PR-2 slice 1).

- Tool-call arguments a weak model writes as text are converted when the tool's schema makes the type unambiguous: `"20"` for an integer or number, `"true"`/`"false"` for a boolean, a JSON string for an array or object. Unions, enums, nested properties and guesses (wrapping a scalar in an array) are left alone. Such a call is counted as `schema` in `toolCallSyntax` and scores 0.5 in `json_repair_rate`, never as native valid (plan unit WM-1).
- The CLI parser moved to commander 14 (from 12). Commander 13 made extra positional arguments an error; Nexus keeps ignoring them as before (`nexus doctor extra` still runs doctor), so command-line behaviour is unchanged. The supported Node.js floor stays 22. Commander 15 needs Node.js 22.12.0 and is deferred until the floor moves.

### Fixed

- Protected-path matching is relative to the workspace root, so projects under directories such as `~/.env-tools/` are no longer blocked wholesale; symlinks to protected targets are still refused.

### Removed

- The unread `allowExternalSymlinks` policy key (files that set it still load; the key is ignored).

## [v1.2.0] - 2026-11-15

Release notes: [`docs/releases/v1.2.0.md`](docs/releases/v1.2.0.md). Candidate: [`rc.1`](docs/releases/v1.2.0-rc.1.md). Plan: [`docs/v1.2.0/SEMANTIC_AND_ARCHITECTURAL_INTEGRITY.md`](docs/v1.2.0/SEMANTIC_AND_ARCHITECTURAL_INTEGRITY.md).

### Changed

- **Breaking validation change:** `nexus operation run` now rejects a spec whose own `policy.maxConcurrentUnits` is above 1 unless it sets `git.isolate: true`, because concurrent units otherwise write the same worktree. Fix: add `"git": { "isolate": true }` or set the limit to 1. Records already on disk are not refused: `nexus operation resume` and `decide` clamp such a record to one unit at a time and warn. The library API `newOperation` is unchanged.

## [v1.1.4] - 2026-11-14

Release notes: [`docs/releases/v1.1.4.md`](docs/releases/v1.1.4.md). Candidate notes: [`rc.3`](docs/releases/v1.1.4-rc.3.md), [`rc.2`](docs/releases/v1.1.4-rc.2.md), [`rc.1`](docs/releases/v1.1.4-rc.1.md).

### Fixed

- A turn suspended while waiting out a provider's Retry-After (429/503) now resumes inside that window correctly: `nexus run --resume`, the TUI (`--resume`) and `nexus operation resume` wait until the recorded eligible time before the first request, shown as the usual provider-wait status, instead of sending it at once. The wait is skipped when you resume against a different endpoint, and bounded by the recovery deadline (`LOCAL_LLM_RECOVERY_DEADLINE_MS`, default 20 min); Ctrl-C during it suspends again with the same eligible time (#471).


## [v1.1.3] - 2026-11-05

See [`docs/releases/v1.1.3.md`](docs/releases/v1.1.3.md) (and candidate notes [`docs/releases/v1.1.3-rc.1.md`](docs/releases/v1.1.3-rc.1.md)). This release carries the whole v1.1.2 scope unchanged, with the same known limitations.

## [v1.1.2] - Not released (shipped as v1.1.3)

The `v1.1.2` tag was rejected by the release workflow (no `v1.1.2-rc.N` parent) and nothing was published; see [`docs/releases/v1.1.3.md`](docs/releases/v1.1.3.md).

See [`docs/releases/v1.1.2.md`](docs/releases/v1.1.2.md) for the full release notes and [`docs/releases/v1.1.2-qualification.md`](docs/releases/v1.1.2-qualification.md) for the qualification record. The date is set when the release is tagged.
Delivers the WP-1101 to WP-1108 roadmap (local OpenTelemetry tracing, flight-recorder redaction, versioned evaluation datasets, standalone `nexus eval`, deterministic code evaluators, single-step loop mode, bounded tool schemas with vLLM strict schemas, dependency modernisation), non-progress recovery and specialist orchestration, and fixes the duplicate re-injection of a multi-message prompt after a crash-resume. Ships with known limitations accepted by the owner; the 99.5% constrained-decoding target was not measured. Version numbers: no `v1.1.2-rc.*` was published.

## [v1.1.1] - 2026-11-01

See [`docs/releases/v1.1.1.md`](docs/releases/v1.1.1.md) (and candidate notes [`docs/releases/v1.1.1-rc.1.md`](docs/releases/v1.1.1-rc.1.md)) for full release notes.
Promoted release line delivering multi-agent orchestration, serialized git integration, typed inter-agent channels, operation replay, context-budget provenance, cancellation idempotency, durability-positive message acknowledgment, structured prompt provenance, and protected replay envelope error propagation.

## [v1.1.0] - 2026-10-31

See [`docs/releases/v1.1.0.md`](docs/releases/v1.1.0.md) (and candidate notes [`docs/releases/v1.1.0-rc.1.md`](docs/releases/v1.1.0-rc.1.md)) for full release notes. Scope and acceptance:
[`docs/v1.1.0/SPEC.md`](docs/v1.1.0/SPEC.md), [`docs/v1.1.0/REQUIREMENTS.md`](docs/v1.1.0/REQUIREMENTS.md).

### Added
- **Deterministic parallel work units:** `policy.maxConcurrentUnits` (default 1, bounded at 64) and
  `resources[].maxConcurrentUnits` (default 1). The scheduler returns an ordered due-set — required units first, then
  the longest unfinished dependent chain, then declaration order — and reserves per-resource slots. A unit whose
  qualified slots are busy stays runnable instead of being parked or blocked.
- **Serialised git integration queue:** concurrent isolated units merge one at a time into the operation branch, with
  `INTEGRATION_QUEUED` / `INTEGRATION_SKIPPED` events and receipts that now name the candidate digest, the executed
  tests and the 1-based merge sequence.
- **Typed inter-agent channel:** `request`, `observation`, `artifact` and `verdict` messages persisted in the operation
  record, delivered at most once to a unit or the whole operation; completed units publish their verified summary, and
  `nexus operation message` lets the operator publish one.
- **Operation replay:** `nexus operation status --replay [--json]` renders the recorded timeline, oldest first, with
  contiguous step indices. The view document is now schema version 2.
- **Context-budget provenance:** a `CONTEXT_BUDGET` block names the binding bound, the estimate and its source
  (`operator-budget` or `agent-estimate`), and `unit.context` records the source.

### Changed
- **Operation document schema 2:** a v1.0.0 operation record migrates in memory, gains `schemaVersion: 2`, and is
  copied byte-for-byte to `<record>.pre-migration-v1` before its first v2 write. A record from a newer build is refused
  with a one-line error and is **not** quarantined.
- **Strict operation specs:** unknown top-level, unit, `requires`, `policy`, `git` and resource keys are rejected with
  exit 2 and a suggested key. `git.publish` is rejected explicitly instead of being silently ignored.
- **View schema 2:** the checked-in `operation-view.schema.json` version and its test validator now agree; the
  validator enforces `minimum`, `maximum`, `minItems`, `pattern` and `maxLength` as well as the structural keywords.

### Fixed
- **Terminal safety in the operation view:** `view.status` and `unit.status` are rendered through `safeTerminal`, so a
  tampered or corrupt record cannot emit control or OSC sequences through a status field.

### Deferred
- PR publication (`git.publish`), the TUI operation pane, in-view decision interaction, semantic retrieval over
  operation records, and a unit-authored message tool. Each has a dated rationale in
  [`docs/v1.1.0/DECISIONS.md`](docs/v1.1.0/DECISIONS.md).

## [v1.0.0] - 2026-10-31

See [`docs/releases/v1.0.0.md`](docs/releases/v1.0.0.md) for full release notes.

### Added
- **Packaged Product Parity:** Packaged binary launches the live Ratatui terminal UI on interactive TTYs, while falling back cleanly to the REPL when standard input is redirected (`</dev/null`).
- **Third-Party Notices:** Automated third-party notice generation (`THIRD_PARTY_NOTICES.txt`) covering 100% of Rust crates and npm production dependencies with license texts (`about.toml`, `about.hbs`).
- **CycloneDX SBOM:** Merged CycloneDX 1.5 JSON Software Bill of Materials (`sbom.cdx.json`) derived directly from lockfiles and validated in CI.
- **Build Provenance:** Cryptographic build provenance attestations via GitHub Actions artifact attestations (`actions/attest-build-provenance`). The installer supports optional verification using `gh attestation verify`.
- **Security Policy:** Private vulnerability intake and disclosure policy defined in [`SECURITY.md`](SECURITY.md).
- **Toolchain Pinning:** Rust toolchain pinned to 1.95.0 (`rust-toolchain.toml`, `rust-version = "1.85.0"`), Node.js pinned to `>=22`.
- **CI Test Matrix:** Multi-version Node testing across Node 22 and 24.
- **Reproducible Builds:** Byte-identical package generation across clean builds (`make verify-reproducibility`, `repro.yml`).

### Changed
- **Launcher Syntax:** Unknown commands fail explicitly; arbitrary execution requires explicit `nexus run "<task>"`.
- **Distribution Hygiene:** Untracked built TypeScript artifacts (`cli/dist`) from version control. `harness.sh` warns helpfully if `cli/dist` is not yet built.
- **Security Gates:** Security gate script (`security_gates.sh`) hardened to fail closed if neither `cargo-deny` nor `cargo-audit` is installed; removed toy fallback.

### Fixed
- **Upgrade Power-Loss Durability:** The extracted release package is fsynced before it is renamed into place and the launcher is switched. Previously a rename persisted only the directory entry, so a power loss shortly after an upgrade could leave the live launcher pointing at zero-length binaries, making `nexus upgrade --recover` itself unavailable.

## [v0.1.0-alpha.2] - 2026-10-14

See [`docs/releases/v0.1.0-alpha.2.md`](docs/releases/v0.1.0-alpha.2.md) for full release notes.

### Added
- **Durable Compaction:** State compactions are committed in sequence with fsync; compaction errors fail closed as `PERSISTENCE_FAILED`.
- **Provider Discovery:** Context size and output allowance dynamically discovered from provider `/models` endpoints.
- **Token Accounting:** Exact request token counting via `/v1/tokenize` when advertised by gateway.

### Changed
- **Long Tasks & Compaction:** Removed arbitrary 300-step / 120-minute defaults; turn continues across durable segment checkpoints while making progress.
- **Loop & Repetition Detection:** State-aware action repetition checks against workspace snapshot diffs.
- **Length Recovery:** Clean handling of truncated model replies (`finish_reason=length`) without aborting on first occurrence.

## [v0.1.0-alpha.1] - 2026-10-13

See [`docs/releases/v0.1.0-alpha.1.md`](docs/releases/v0.1.0-alpha.1.md) for full release notes.

### Added
- **Initial Alpha:** Initial package release for Linux x86-64 with glibc 2.35+.
- **Components:** Combined TypeScript CLI/sidecar, Rust `harness-core` workspace tools, and Ratatui `nexus-tui`.
- **Installer:** Self-contained one-line shell installer (`install.sh`) with SHA-256 integrity validation.
