# Nexus Code User Manual

Welcome to **Nexus Code**, a local-first, autonomous and interactive AI coding harness. Nexus Code connects to local inference servers (vLLM, LM Studio) and executes inside a native Linux shell environment.

---

## 1. Quick Start

### Starting the Interactive Environment (TUI & REPL)
To launch the interactive coding environment in the current workspace:
```bash
nexus
```
- **TTY default:** Running `nexus` with no arguments in a terminal launches the live Ratatui TUI (`nexus-tui`).
- **Non-TTY / Headless fallback:** Running `nexus` without a TTY (in pipes or scripts) falls back to the interactive REPL.
- **Explicit REPL:** Pass `nexus repl` (or `nexus --repl`) to explicitly launch the command-line REPL.
```bash
nexus repl
```
- On each interactive launch from an untrusted folder, Nexus asks whether to trust the folder, continue without trust, or exit. Trust loads project instructions when present and enables trusted workspace integrations. Folder trust is separate from tool permissions: an explicit mode controls approvals, and an unset mode defaults to `review` in every folder. Non-interactive launches do not prompt and do not load project instructions unless the folder is already trusted.

### Execution Postures & Approval Modes

Nexus Code resolves tool approval posture from permission settings, independently of workspace trust (amended DEC-01):
- **Default:** `review` posture, requiring human confirmation before executing shell commands, file modifications, network requests, or verifier test runs, regardless of folder trust.
- **Auto:** Select with `--mode auto`. Writes and commands run without approval; network egress by the network tools (`fetch_web`, `search_web`, `browser_*`) still asks on first use of each origin. Shell commands are not covered by egress approval: only the `--sandbox` network setting limits what a shell command can reach. This is independent of folder trust.
- **Full access:** Select with `--yes` or `NEXUS_APPROVAL_MODE=auto` to bypass approval prompts, including egress. `--yes` does not turn on network access inside `--sandbox`; that needs `--sandbox-network` (see the sandbox entry under Security).

Flags and commands:
- **Trust your workspace:** Run `nexus trust .` to load project instructions and workspace integrations. It does not change tool permission settings.
- **Review mode (human-in-the-loop):** Run `nexus --approve` (or `nexus --mode review`) to require explicit approval for all actions regardless of workspace trust.
- **Auto mode:** Pass `nexus --mode auto` for autonomous writes and commands, with first-use egress prompts for the network tools (not for shell commands).
- **Full access (scripts and CI):** Pass `nexus --yes` or set `NEXUS_APPROVAL_MODE=auto` to run without interactive approval prompts.
- **Read-only mode:** Run `nexus --read-only` to explore and analyze code without permitting any modifications or non-read commands.

To resume your latest session:
```bash
nexus -r
# or resume a specific session by ID:
nexus -r sess_1727668541234
```

If the earlier turn was suspended when the provider asked for a wait (for example 429/503 with `Retry-After`) or a recovery wait was in progress, the resumed turn waits out the rest of that window before its first request.
This applies to `nexus run --resume`, the TUI (`--resume` or `/resume`) and `nexus operation resume`.
The wait is shown as the usual provider-wait status.
It is bounded by `LOCAL_LLM_RECOVERY_DEADLINE_MS` (default 20 minutes), skipped when you resume against a different endpoint, and Ctrl-C during it suspends again with the same eligible time.
Until the wait is over, a resumed session sends nothing else to that provider either: the startup reachability check, the model-list lookup, model auto-detection (a resumed start takes the model from the session record when you pass no `--model`, or detects it after the wait; a resume that finds no saved session detects it at once, like a fresh start), embedding requests for `hybrid_search` (the search stays lexical), `/compact --llm` and subagents are held back or declined.
With failover endpoints configured, the window covers each of them.
Endpoints are saved in session, task and flight records as origin and path only (no user, password, query string or fragment). A secret placed in the path itself (`/v1/KEY123`) is part of the path and is saved with it.

### Running Autonomous Non-Interactive Tasks
To run a one-off objective and exit automatically when verified:
```bash
nexus run "Refactor the authentication handler to support JWT rotation and add unit tests"
```
Free-text task execution requires the explicit `nexus run "<prompt>"` subcommand. Passing unknown subcommand names or free text without `run` is treated as a command error (REQ-REL-104 / DEC-14).

### `nexus run --json`
`nexus run --json` (or `--output json`) writes exactly one JSON document to stdout and nothing else; progress and diagnostics go to stderr. The document is a contract for scripts and CI:

- Its first member is `schema_version` (an integer, now `1`). Adding an optional member keeps the version; removing or renaming a member, or changing a member's type or meaning, raises it. Ignore members you do not know, and refuse a `schema_version` you do not know.
- The schema is published as `docs/protocol/run-result-v1.schema.json` (JSON Schema draft 2020-12), generated from the types in `cli/src/run_contract.ts`; each change is recorded in `docs/protocol/RUN_RESULT_VERSIONS.json` (see `docs/protocol/README.md`).
- A task that ran to an ending, whatever the ending, prints a **result**: `schema_version`, `taskId`, `success`, `status` (`completed`, `failed` or `interrupted`), `prompt`, `output`, `plan`, `milestones`, `candidateId`, `candidateIdentity`, `validationReceipts`, `worktreeBinding`, `tokenStats`, `durationMs`, `error` (when the task raised one), `logs`, `turn` (the authoritative ending: `turn.execution`, `turn.outcome`, `turn.reason`), `exitCode` (the process exit code), and `cloudUsage` when a cloud provider was used.
- A run that throws before it has a result (for example `--resume <id>` of a task with no saved state) prints an **error document** instead: `schema_version`, `taskId`, `success` (`false`), `status` (`failed`), `prompt`, `output`, `plan`, `milestones`, `validationReceipts`, `tokenStats`, `durationMs` and `error`. It has no `turn` and no `exitCode`: that is how to tell it from a result.
- A usage error (exit code 2 before the run starts) prints its message on stderr and nothing on stdout.
- `--output stream-json` (`docs/STREAM_JSON.md`) is a separate, line-by-line format with its own `schemaVersion` on every event. Its final `result` event carries the same result object, so that event also has `schema_version`; its `error` event (`taskId`, `message`) is a different shape from the error document above.

The task can be given without putting it on the command line:

```bash
nexus run --json --input-json task.json     # a JSON document in a file
nexus run --json --input-json - < task.json # the same document on stdin
echo "Fix the failing test" | nexus run --json   # plain task text on stdin
```

- `--input-json <file|->` reads `{ "schema_version": 1, "task": "<text>" }`. `schema_version` must be `1` and `task` a non-empty string. Only `task` is read: every other member is ignored, so the document cannot choose the approval mode, `--yes`, the sandbox, the endpoint, credentials or the workspace. Those come from the command line and your configuration only.
- With no task argument, no `--input-json` and no `--resume` or `--fork-session`, a stdin that is not a terminal is read as the task text. If that stdin is never closed, `nexus run` waits for it.
- The input is limited to 1048576 bytes (1 MiB) and must be UTF-8; a larger input is refused, never cut short. A task given both as an argument and with `--input-json`, an invalid document, or an empty stdin is a usage error (exit code 2).

### Exit codes of `nexus run`
| Code | Name | When |
|---|---|---|
| 0 | `ok` | The task completed and its changes were verified (`VERIFIED`), or it changed nothing that needs verifying (`NOT_REQUIRED`). |
| 1 | `failed` | Any other ending: the task failed, was blocked (a question for the operator, a capacity or convergence stop), reached a limit, or completed without establishing a result; or the run threw an error. |
| 1 | `missing_prompt` | No task was given as an argument and `--resume` was not used (with a terminal on stdin and no `--input-json`). |
| 1 | `option_parse` | The command line could not be parsed: an unknown option or an option without its value (the option parser exits before the command runs). |
| 2 | `unverified` | The task completed but nothing verifies the change (`UNVERIFIED`), or the tests passed without covering it (`REGRESSION_FREE`). |
| 2 | `usage` | A usage error before the run started: an invalid option value or combination, or an invalid, oversized or empty `--input-json` or stdin task. |
| 2 | `resume_unavailable` | `--resume` found no task in the workspace, or `--fork-session` could not make the copy. |
| 2 | `task_not_found` | The task named by `--resume <id>` has no saved state. |
| 130 | `interrupted` | The task was interrupted (SIGINT). A second SIGINT exits at once with this code and may leave no JSON document. |

Exit code 2 has four meanings and exit code 1 has three, so the exit code alone cannot tell them apart. With `--json`, read the document: a result with `turn.outcome` `UNVERIFIED` or `REGRESSION_FREE` is the `unverified` row; an error document (no `turn`) is `task_not_found` or a thrown error; an empty stdout means the run never started (`usage`, `resume_unavailable`, `missing_prompt`, `option_parse`), and stderr has the message. For a result, `exitCode` in the document equals the process exit code.

### `nexus verify`
`nexus verify` gives a verdict on a change that Nexus did not necessarily make: a pull request, a patch, another tool's output, your own edits. It uses no model. It runs the project's verifier on the code before the change and on the code after it, and applies the rules `nexus run` applies to its own work.

```bash
nexus verify --deliverable-file src/parser.ts                         # the working tree against HEAD
nexus verify --base origin/main --head my-branch --deliverable-file src/parser.ts   # one commit against another
nexus verify --base origin/main --verifier "npm test" --json --receipt verify.json
nexus verify --base origin/main --head my-branch -y --approve-verification-edit test/parser.test.ts   # after reading that edit
nexus verify --base origin/main --head their-branch --verifier "npm test"                 # sandboxed by default
```

To run it on pull requests, see [Using `nexus verify` in CI](VERIFY_IN_CI.md): the composite action `action/verify`, the example workflow, the exit-code handling and the table of attacks the test suite covers.

**Two modes.** Without `--head`, the change is the working tree of `--worktree` (default: the current directory, which must be the top of the Git working tree): tracked and untracked files that are not ignored, compared with `--base` (default `HEAD`). With `--head <ref>`, the change is that commit compared with `--base`. In both modes each side is written to its own scratch directory and the verifier runs there; your checkout, its index and its `.git` are not written, and the scratch directories are removed when the command ends, on an error or an interrupt too.

**Which verifier runs.** `--verifier <command>` is your own command (source `configured`) and needs no approval. Without it, one is discovered from the files of the **base** tree, never the head: the head is the change under test, so a head that rewrites `scripts.test` or adds a test script of its own does not get to choose the judge. A discovered verifier runs repository code, so it needs your approval: `nexus verify` stops with `BLOCKED` (exit code 3) and prints the command, the script it resolves to and a sha256 digest of both. Approve that exact verifier with `--approve-verifier <digest>`, or whatever is discovered with `--yes`. A base tree that defines no verifier gives `UNVERIFIED` (`NO_APPLICABLE_VERIFIER`). Each verifier run has a deadline (`--timeout-secs`, else `NEXUS_VERIFIER_TIMEOUT_SECS`, else 300 seconds); the type-checks of each side share one deadline of the same length.

**Deliverables.** `--deliverable-file <path>` (repeatable) names a product file the change is meant to deliver. `VERIFIED` requires at least one, requires every changed file that is not a test to be one, and requires every one to be imported by a test file that already existed on the base. Without `--deliverable-file` the verdict is never `VERIFIED`.

**Test-oracle access.** With the Bubblewrap sandbox on Linux, Nexus traces successful file opens by verifier processes and compares access to the baseline test files on the candidate with the base run. If the candidate opens one of those files more often, it has consulted its oracle, so the run can be `REGRESSION_FREE` but not `VERIFIED`; the receipt lists those paths in `runs[].testFixtureReads`. If Bubblewrap file tracing is unavailable (including Docker-only hosts or hosts without `strace`), Nexus fails closed to `REGRESSION_FREE`. This check covers direct read opens of captured baseline test files; it does not prove that the tests cover the full product specification.

| Verdict | Meaning |
|---|---|
| `VERIFIED` | Evidence independent of the change shows it (see below). |
| `REGRESSION_FREE` | The tests pass on the change, which shows only that nothing they cover broke. |
| `UNVERIFIED` | Nothing was established. `outcome` and `reason` in the result say why: the verifier or an enforced type-check failed or timed out, the verifier ran no test or does not exist, or base and head are the same tree. |
| `BLOCKED` | A person must decide before anything is run or concluded: approve the verifier, or read and approve an edit to the verification itself. |

Another harness can ask for the same verdict over MCP: `nexus serve-mcp` offers it as the tool `nexus_verify`, with the verifier, deliverables, base and sandbox fixed by whoever started the server (see [MCP_GUIDE.md](MCP_GUIDE.md), section 4).

#### Exit codes of `nexus verify`
| Code | Name | When |
|---|---|---|
| 0 | `verified` | `VERIFIED`: the change is shown by evidence independent of it. |
| 1 | `failed` | `UNVERIFIED` with outcome `NOT_ESTABLISHED`: the verifier failed or timed out on the head, an enforced type-check failed, timed out or could not be run, or the head changed the verifier's own definition so it was not run. |
| 1 | `error` | `UNVERIFIED` with reason `INTERNAL_ERROR`: `nexus verify` itself could not finish, so nothing was established. |
| 1 | `option_parse` | The command line could not be parsed: an unknown option or an option without its value (the option parser exits before the command runs; no JSON document). |
| 2 | `unverified` | `REGRESSION_FREE` (the tests pass without showing the change), or `UNVERIFIED` because there is no verifier, no test executed, base and head are the same tree, or an enforced type-check project of the base has no counterpart in the head. |
| 2 | `usage` | A usage error: not a Git working tree, a base or head that does not name a commit, or an invalid option value or combination. |
| 3 | `blocked` | `BLOCKED`: a person must decide. The discovered verifier is not approved, the change edits verification files or weakens a test without approval, the changed files could not all be classified, the checkout is not trusted, a tree exceeds the limits or holds something that is not materialised (a submodule), or the default/selected sandbox engine is not usable, or the independent reviewer rejected contradictory evidence. |
| 130 | `interrupted` | Interrupted (SIGINT or SIGTERM). The signal is acted on when the running verifier process ends; a second signal exits at once and may leave no JSON document. |

Only `VERIFIED` exits 0. An empty change is not a success: you chose the base. Codes 1 and 2 each have several meanings; with `--json`, read `verdict`, `outcome` and `reason` in the document.

**Type-checks.** When the verifier passes on the head, the project's type-checks run as they do at the end of a `nexus run` task: one per configured project (`tsconfig.json` with `tsc`, `Cargo.toml` with `cargo check --offline --locked`, `go.mod` with `go vet`, a configured `pyright` or `mypy`), found in the head tree, each run on the base too so that an error can be told apart from one that was already there. They run in scratch copies of their own (never in your checkout, and never in the copy the head is judged on), with the verifier's scrubbed environment and deadline. Approving the verifier (`--yes`, `--approve-verifier`) also covers these runs: there is no separate approval, and the head's code has by then already run as the tests. A discovered verifier makes the checks **enforced**; with your own `--verifier` they are **recorded only** unless `NEXUS_TYPECHECK=enforce`; `NEXUS_TYPECHECK=off` disables them (no check runs, none can lower the verdict, and the variable is named in `environment`). What each status of an enforced check does to the verdict, which is what `nexus run` does:

| Status | Meaning | Enforced: verdict |
|---|---|---|
| `PASSED` | No error. | Not lowered. |
| `PREEXISTING` | Errors exist, none in a changed file and none that the base did not have. | Not lowered. |
| `FAILED` | An error in a changed file, or one the base did not have (a caller the change broke in a file it did not touch). | `UNVERIFIED` (`TYPECHECK_FAILED`), exit 1. |
| `TIMED_OUT` | The check, or the shared deadline, ran out. | `UNVERIFIED` (`TYPECHECK_TIMED_OUT`), exit 1. |
| `UNAVAILABLE` | The tool is not installed, or the project scan was cut short. | `UNVERIFIED` (`TYPECHECK_UNAVAILABLE`), exit 1. If the tool was found but could not be started when probed: recorded, **not lowered**. |
| `NOT_APPLICABLE` | No project, or type-checking is off: not lowered. A configuration the checker cannot run (a solution-style `tsconfig.json`) also has this status. | For the configuration that cannot be run: `UNVERIFIED` (`TYPECHECK_UNAVAILABLE`), exit 1. |
| `ENVIRONMENT` | The check ran and its failure cannot be attributed: no error has a file location (a configuration error, missing type packages), or it ended without an exit status. | Recorded, **not lowered**. |

So a change can be `VERIFIED` while a type-check ended `ENVIRONMENT`, `PREEXISTING`, or `UNAVAILABLE` at the probe: `VERIFIED` does not claim the change type-checks unless the status is `PASSED`. Read `typecheck.status`, and `verification.typecheck.projects` for each project's tool, configuration path and hash, tool hash and version, exit code and error counts (`errorCount`, `introducedCount` against the base, `baselineErrorCount`). When the base run of a project did not pass cleanly or with located errors, there is no baseline for it, and an error in an untouched file then counts as `PREEXISTING`; `typecheck.baseline` shows each base run. One rule goes beyond `nexus run`: when the checks are enforced and the base has a project the head no longer has, a passing result is withheld as `UNVERIFIED` (`TYPECHECK_NOT_RUN`, exit 2), because nothing can be type-checked under a project that is gone. (For TypeScript this does not arise: every `tsconfig.json` is part of the verifier's definition, so removing or editing one is `VERIFIER_DEFINITION_CHANGED`.) No type-check runs when the verifier did not pass.

**The verification-file guard.** Every changed file is classified, and the ones that decide how the change is verified are listed in `guard.findings` with their `class`, `kind` (`added`, `modified`, `deleted`) and, for a test file, `weakening`:

- **Verification configuration** (`ci`, `build`, `test_config`, `verifier_script`, `package_scripts`, `policy`): CI workflows, `Makefile` and similar, test-runner configuration, scripts named for testing or checking, `.nexus-security.json`, and `package.json`, `pyproject.toml` and `setup.cfg` when the edit touches the keys or sections that decide how tests run. Adding, changing or deleting one needs approval.
- **Test files.** A new test file is recorded and needs nothing. A changed one is recorded, and needs approval only when the edit looks like a weakening: `removed` (the file is deleted or emptied), `skipped` (a skip marker was added), `fewer-assertions`, `neutered` (the added lines hold `.only`, an early exit or return, or an unclosed comment), or `unverifiable-change` (the file could not be read to tell). These are heuristics over the text: they can flag a harmless edit and miss a subtle one. The independence rule below is what keeps a weakened test from making a change `VERIFIED`.

A finding that needs approval and does not have it makes the verdict `BLOCKED` (`VERIFICATION_EDIT_BLOCKED`, exit 3). Read the edit, then approve it with `--approve-verification-edit <path>` (repeatable; the path as listed). **Approval lifts `BLOCKED` and nothing else**: a change with an approved finding is never `VERIFIED`, however the tests come out; its best verdict is `REGRESSION_FREE`, and the verifier rules still apply (an approved edit to `scripts.test` is still `VERIFIER_DEFINITION_CHANGED`). If a changed verification file cannot be classified (not a regular file, larger than 256 KiB), or there are more than 1000 findings, `guard.complete` is false and the verdict is `BLOCKED` (`GUARD_INCOMPLETE`) whatever was approved.

The guard's policy is the **base** tree's `.nexus-security.json` (`guard.policySource` is `base_tree`, or `default` when the base has none), read as an untrusted repository's: its `verificationPaths` can tighten the guard (`mode: "block"` refuses these edits even when you approve them; `extra` adds paths) and cannot relax it (`off`, `record` and `allow` are ignored). The head's `.nexus-security.json` is never read as policy; it is a finding. `nexus verify` does not consult your list of trusted workspaces, and `NEXUS_TRUST_WORKSPACE=1` does not change this (it is named in `environment` when set): trusting a checkout is not trusting the commit under review.

**When several things are true.** A head that was run and did not pass keeps its own reason and exit 1 (`VERIFIER_FAILED`, `VERIFIER_TIMED_OUT`, `TYPECHECK_FAILED`, `TYPECHECK_TIMED_OUT`, `TYPECHECK_UNAVAILABLE`), with the guard's findings still listed: "it fails" is reported before "a person must decide". A discovered verifier that is not approved keeps `VERIFIER_NOT_APPROVED` (nothing was run). In every other case an unapproved finding or an incomplete scan is `BLOCKED`: over `REGRESSION_FREE`, over an `UNVERIFIED` that would exit 2, and over a head that was not run because it redefines the verifier. A reviewer `REJECT` only withholds an otherwise `VERIFIED` result (`REVIEW_REJECTED`); it never raises a lower verdict. `detail` then says what the result was without the finding.

**The sandbox.** By default the verifier, the type-checks and the tests run in `--sandbox auto`: Bubblewrap when usable, otherwise Docker. This confines every process `nexus verify` starts on repository code: the verifier on the base and on the head, the base's tests run against the head, and the type-checks. Inside the box the process can write its own scratch tree and a private `/tmp` and nothing else; the other scratch trees, the copy the head is judged on and the scratch Git index are not visible; your checkout and its Git common directory are covered before any dependency directory is bound back, so they are not visible by absolute path even when they sit outside HOME and `/tmp`; the linked dependency directories are bound read-only; HOME is masked, with only toolchain directories bound back read-only; other processes are not visible and nothing outlives the run; the environment is the same allowlist as without a sandbox; and there is no network unless you add `--sandbox-network` (the sandbox is on by default; `NEXUS_SANDBOX_NETWORK` is not consulted here). `--sandbox bwrap` and `--sandbox docker` select an engine. `--sandbox none` is an explicit opt-out for changes you trust; code under review can then alter the verification state and forge the verdict. If the default or selected engine is not usable, the verdict is `BLOCKED` (`SANDBOX_UNAVAILABLE`, exit 3) and nothing is run: there is no fallback to running unconfined. The result records the effective `sandbox.engine` (`bwrap`, `docker`, or `none`), whether `--sandbox` was explicitly supplied in `sandbox.requested`, `sandbox.network`, and `sandboxed` on every entry of `runs`. A sandbox changes no verdict rule: it only takes authority away from the code under test. With Docker the commands run in the pinned Alpine image of `nexus run --sandbox docker`, which has a shell and no toolchain; name your own digest-pinned image with `NEXUS_SANDBOX_DOCKER_IMAGE`.

**What `VERIFIED` claims.** Tests that existed on the base, run under the verifier definition the base had, failed on the base and pass on the change (when the change edits test files, the base's test files are run against the change's code and must pass), or your own `--verifier` command passed with the test files unchanged; and those pre-existing tests import every declared deliverable; no enforced type-check failed, timed out or was unavailable; and the change edits no verification configuration and weakens no test by the guard's heuristics. It does not claim that the change is correct beyond what those tests check, that it type-checks when a check could not run or be attributed (see the table above), that it is free of security problems, or that a person or a model reviewed it.

**The result.** The text output states the verdict, the reason, both sides (commit and tree), the verifier, each run, the type-checks, the guard's findings and what was not run. `--json` prints exactly one JSON document on stdout (progress goes to stderr) and `--receipt <file>` writes the same document to a file. Its first member is `schema_version` (now `3`); `exitCode` equals the process exit code. A result has `verdict`, `outcome`, `reason`, `detail`, `base` and `head` (`ref`, `commit`, `tree`), `changedFiles`, `verifier` (`command`, `source`, `digest`, `approval`), `deliverables`, `approvedVerificationEdits`, `runs` (one entry per verifier process, with a sha256 of its output), `baseline`, `verification` (with the type-check evidence under `typecheck`), `typecheck` (`status`, `mode`, `baseline`, `missingFromHead`), `guard` (`status`, `mode`, `policySource`, `findings`, `complete`), `review` (`NOT_RUN` when no head verifier ran; otherwise `COMPLETE` with the structured `ACCEPT`/`REJECT` observations, suspected defects, unproven criteria, scope violations and confidence note), `sandbox` (`requested`, `engine`, `network`; each run also has `sandboxed`), optional `sandboxEvents` (typed refusals with `kind`, `engine`, `profile`, `operation`, `category`, `reason` and `at`; present only when one happened and never a verdict), `linkedDependencyDirs`, `limits` and `environment`: the names, never the values, of the variables that can affect a verdict and were set (`NEXUS_TRUST_WORKSPACE`, `NEXUS_TYPECHECK`, `NEXUS_VERIFIER_TIMEOUT_SECS`, `NEXUS_VERIFIER_ENV_PASSTHROUGH`). A usage error or an interrupt prints an error document instead (`schema_version`, `error`, `exitCode`); a command line that cannot be parsed prints no document. The document's JSON Schema is `docs/protocol/verify-result-v3.schema.json`, generated from the types in `cli/src/verify_contract.ts`; `docs/protocol/VERIFY_RESULT_VERSIONS.json` records each version decision (an added optional member keeps `schema_version`; a removed or renamed member, or a changed type or meaning, bumps it). Objects are open: ignore members you do not know.

**Limits.**
- `--sandbox none` runs the verifier and type-checks as repository code with your privileges. The default uses `auto` and blocks if neither sandbox engine is usable. Only opt out for changes whose code you trust; an unconfined change can alter verification state and forge its own verdict.
- A verifier you supply with `--verifier` is trusted as yours. A command that prints a test runner's summary without running tests is not detected.
- The tests run the change's own code in their process. A change written to deceive its tests from inside that process (product code that alters the test runner) is not detected. Files a run writes into its own scratch tree do not affect the verdict, which is judged on a second copy written after the run; without `--sandbox`, code that deliberately attacks the other scratch directories (it can rewrite the scratch index the second copy is written from, and so be reported `VERIFIED` while fixing nothing), your checkout or the `nexus` process itself is not defended against. With `--sandbox` those directories are not visible to it.
- Dependency directories of your checkout that neither tree holds itself (`node_modules`, `vendor`, `.venv`, `venv`) are linked into both scratch trees so both sides run with the same installed packages; without `--sandbox` a verifier that writes into them writes into your checkout's copy (with it they are read-only). Whoever installed them chose part of what runs: do not install a change's dependencies before verifying it. A dependency directory that the base or the head tracks is never linked into the other side, and a head that adds one has changed the verifier's definition. With a `node_modules` directory an `npm test` verifier cannot be bound to the base, so the verdict is at most `REGRESSION_FREE`. Build output directories are not linked.
- The type-checker a project names is the one that runs: for TypeScript the tree's own `node_modules/.bin/tsc` when it has one (through the linked `node_modules`, your checkout's), else `tsc` on `PATH`. Its hash is recorded (`toolSha256`), not judged.
- A Cargo type-check builds into a directory of its own, removed when the command ends, so every run compiles the dependencies again (offline).
- The independent reviewer is deterministic: it reads only the recorded evidence package (no model, no implementer narrative) and can withhold `VERIFIED` when the receipts contradict the claim (`REVIEW_REJECTED`, `BLOCKED`, exit 3). It does not review correctness: no person or model has read the change, and unproven criteria are reported, not promoted. When nothing was run on the head (no applicable verifier, an unapproved verifier, or an earlier refusal), `review` stays `NOT_RUN`.
- A change to a file the base's tests import that is not a declared deliverable counts as a change to the verifier: the verifier is not run on the head and the result is `UNVERIFIED` (`VERIFIER_DEFINITION_CHANGED`).
- A tree with more than 20000 files or 512 MiB, one that holds a submodule, or one with a path that is not valid UTF-8, is `BLOCKED`: it is never verified in part. A tree with a path the file system cannot hold ends `UNVERIFIED` (`INTERNAL_ERROR`).
- Git hooks, `core.fsmonitor` and content filters (`filter.<name>.clean`, `.smudge`, `.process`) defined in the repository's own configuration (`.git/config`) are not run while the trees are read and written, so a file such a filter would convert is read and written as stored. A filter defined in your own Git configuration (global or system, as Git LFS installs it) is yours and does run when the tree's `.gitattributes` selects it.
- For a `make test` verifier, a head that adds or edits `GNUmakefile` or `makefile` (which `make` reads before `Makefile`) has changed the verifier: it is not run on the head (`VERIFIER_DEFINITION_CHANGED`).
- An edit you approve with `--approve-verification-edit` is your decision. It never yields `VERIFIED`, but an approved runner configuration (a `conftest.py` that passes every test) can make failing tests report `REGRESSION_FREE`: read the file first.
- Names and output from the repository are data: control characters are escaped in the document and in the text, and the verifier's output never reaches stdout except as an escaped tail behind a margin.
- An interrupt is acted on when the running verifier process ends (within its deadline).

### Viewing Tool Audit Logs
To inspect recent tool executions, filter errors, or track latency:
```bash
nexus audit --limit 20
nexus audit --errors
nexus audit --tool run_command
```

### `nexus audit export` / `nexus audit verify`
`nexus audit export <id>` writes the evidence of one saved task or session as an **audit bundle**: a directory holding the session export, the validation receipts, the last turn, the verifier attempts, the verification-configuration attempts, the requirement evidence, the operation diffs and the flight logs, with a `manifest.json` that records the SHA-256 of every file. `nexus audit verify <bundle-dir>` checks such a directory against its manifest. Neither uses a model, and `verify` checks integrity only: it re-runs nothing. The full description is [`docs/AUDIT.md`](AUDIT.md).

```bash
nexus audit export task-20261122-1 --out ./audit/task-1       # prints the manifest hash: record it somewhere else
nexus audit export session_20261122_101500_ab12cd34 --store sessions --flight flight-2026-11-22T10-15-00-000Z-1a2b3c --receipt-file verify.json
nexus audit export task-20261122-1 --sign-key ./operator-ed25519-private.pem --out ./audit/signed-task
nexus audit verify ./audit/task-1
nexus audit verify ./audit/signed-task --public-key ./operator-ed25519-public.pem
nexus audit verify ./audit/task-1 --expect-manifest-sha256 <the hash recorded at export> --json
```

- **The id is exact.** A prefix is not accepted, and an id that is both a task and a session needs `--store tasks` or `--store sessions`. Exporting never changes the task or session it reads.
- **`--out` must not exist** (default `./nexus-audit-<id>-<UTC time>`); a bundle is never written over anything, and the command reports success only when the bundle is complete and in place.
- **A bundle is secret-redacted, not confidential.** `--redact standard` (the only redaction in this version) removes what Nexus classifies as a credential. Prompts, model replies, tool output, source code in diffs, absolute paths, the model name and the endpoint remain. Whatever was left out is listed in the output and in the manifest, with the reason.
- **Signing is optional.** `--sign-key` reads an operator-held Ed25519 private key for this export; Nexus never copies the key into the bundle. Verify with the matching `--public-key`. A signed bundle without a public key is `signature_unchecked` (exit 2). Unsigned bundles say: “This bundle is NOT SIGNED: anyone able to write it could have replaced its files and the manifest together.” Record the manifest hash separately when signatures are not used.
- **Flight logs** carry no task id. Name them with `--flight <id>` (repeatable); otherwise the flights of the workspace that started between the subject's creation and its last update are taken, which is a heuristic and can pick up another task's flight. `-w` names the workspace to look in.
- With `--json` each command prints exactly one document on stdout (`docs/protocol/audit-verify-result-v1.schema.json`); its `exitCode` is the process exit code.
- `nexus audit` without a subcommand still prints the tool audit log (above); any other word after it is a usage error.

#### Exit codes of `nexus audit export` and `nexus audit verify`

| Code | Name | When |
|---|---|---|
| 0 | `exported` | `audit export`: the bundle was written. |
| 0 | `intact_signed` | `audit verify`: every file matches the manifest, and the manifest is signed by the key given with `--public-key`. |
| 0 | `intact_unsigned` | `audit verify`: every file matches the manifest and the bundle is not signed. The result rests on the manifest alone, and the output says so every time. |
| 1 | `tampered` | `audit verify`: a file is altered, missing, extra or unsafe (a symbolic link, not a regular file); the manifest is malformed or inconsistent; a chained log does not match its recorded head; a limit was exceeded; the signature is invalid; or a key was given and the bundle has no signature. |
| 1 | `error` | The command itself failed (the bundle directory cannot be read, an export could not be written), so nothing was established. |
| 1 | `option_parse` | The command line could not be parsed: an unknown option or an option without its value (the option parser exits before the command runs; no JSON document). |
| 2 | `signature_unchecked` | `audit verify`: every file matches the manifest, and the bundle carries a signature that was not checked because no `--public-key` was given. |
| 2 | `unsupported_version` | `audit verify`: the bundle declares a schema version this Nexus does not read. Nothing was checked. |
| 2 | `usage` | A usage error: an invalid option value or combination, an id that is not a valid name or is in both stores without `--store`, an `--out` that already exists, an `audit verify` path that is not an existing directory, or an unknown `audit` subcommand. |
| 2 | `subject_not_found` | `audit export`: no task or session has the given id. |
| 130 | `interrupted` | Interrupted (SIGINT). |

### Exposing Nexus Tools via Model Context Protocol (MCP)
To expose Nexus Code's native Rust tools to external LLM clients (Claude Desktop, Cursor, Zed):
```bash
nexus serve-mcp --workspace /path/to/project
```
See [MCP_GUIDE.md](MCP_GUIDE.md) for full configuration details.

The server also offers the tool `nexus_verify`: `nexus verify` for the client, on the working tree against the commit that was `HEAD` when the server started. The client passes no arguments. Only the verifier and deliverables you give at start are used (`nexus --authoritative-verifier "npm test" --deliverable-file src/parser.ts serve-mcp`); without `--authoritative-verifier` the tool runs no verifier and reports `BLOCKED` (or `UNVERIFIED` when the repository defines no verifier). The result carries a receipt id, and the receipt is read back at `nexus://verify-receipt/<id>` while the server runs. The ACP server offers `_nexus/verify` for an active session, using the verifier and deliverables fixed by the operator when Nexus starts; `_nexus/receipt/get` retrieves its receipt by id within that session. Verification is refused while a session is changing the same workspace. A client that can run commands as your user can still tamper outside the protocol (installed dependencies, your Git configuration); see [MCP_GUIDE.md](MCP_GUIDE.md).

### Upgrading Nexus Code (`nexus upgrade` & `/upgrade`)
To check whether an update is available without making changes:
```bash
nexus upgrade --check
```
Exit codes for `--check`:
- `0`: Up to date (already on latest or requested version).
- `1`: Update available.
- `2`: Operational error (network, rate limit, release not found).

To perform an in-place upgrade to the latest published stable release:
```bash
nexus upgrade
```
Prompts for confirmation unless `--yes` is passed. In non-interactive environments (scripts or CI), `--yes` is mandatory to perform modifications.

To target an explicit release (including prereleases):
```bash
nexus upgrade --version <tag>   # a tag from GitHub Releases, for example an rc tag
```

#### Recovery, Rollback and Backup Restoration
Nexus maintains a transaction journal (`$PREFIX/lib/nexus/.upgrade-journal.json`) and creates protected pre-migration configuration backups (mode `0600`) before modifications:

- Recover from an interrupted upgrade using the transaction journal:
  ```bash
  nexus upgrade --recover
  ```
- Revert the launcher symlink to the previous installed version:
  ```bash
  nexus upgrade --rollback-binary
  ```
- Restore configuration from a pre-migration backup:
  ```bash
  nexus upgrade --restore-backup ~/.config/nexus/backups/config.env.bak
  ```

Inside the interactive live TUI, run `/upgrade` or `/upgrade --check`. The TUI displays the installed vs target version, destination, and requires deliberate modal confirmation before modifying any files. Running TUI sessions continue uninterrupted on their loaded code and notify when a restart is required.

### Uninstalling Nexus Code (`nexus uninstall`)

From a managed installer installation, run:

```bash
nexus uninstall
```

Uninstall holds the installer upgrade lock while it verifies every installed package against its `MANIFEST.sha256` and removes the managed packages and launcher. If an upgrade is active, a package is modified, unlisted files are present, or an upgrade is incomplete, uninstall stops before removing packages; resolve an interrupted upgrade with `nexus upgrade --recover` first. Development checkouts and package-manager installations are not removed by this command.

By default, task/session state and operator configuration remain in `~/.nexus` and `~/.config/nexus`. To remove those paths too, use `nexus uninstall --purge`. This does not remove workspace files. A custom `NEXUS_STATE_DIR` is left untouched.

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
  quotes, fenced code in a gutter block with syntax colours (long lines wrap onto rows that start with `↪` in place of the bar, the code staying in
  its column), and tables
  aligned in columns (listed row by row when too wide). Without colour (`NO_COLOR`) a glyph names each heading level (`◆` for `#`, `▸` for `##`, `·` for deeper ones), because bold alone reads as emphasis. Each model reply is its own paragraph; when Nexus asks the
  agent to continue on its own (open requirements, a repeated action), a quiet line says so. Commands show their exit
  code and line count, the exact number of earlier lines not shown (`… 115 earlier lines`) and the last 6 lines; Tab, `[`/`]` and
  Enter open the full record. Tools that took noticeable time show their duration. A pasted prompt shows the text that
  was sent under its `[Pasted text #n]` label.
- **Outcomes.** A turn ends with one line in words — `Done`, `Done · verified`, `Done · tests passed, change not
  covered`, `Done · not verified`, `Verification failed`, `Requirements still open` (with the open items),
  `Cancelled`, `Stopped at …` (a budget), `Model request failed`, `Context is full` — the cause, and the next action;
  `v` opens the receipt with the raw fields. The line describes this turn: `Done · not verified` says when no file changed in this turn
  and the unverified changes are from an earlier one, and when the only verifier run was the baseline Nexus takes before
  the change (`npm test ran before the change; nothing checked the change itself`). A turn whose actions you denied, or
  whose commands left the workspace as they found it, ends `Done` (`No files changed: you denied 1 action.`; `nexus run`
  exits 0). "As they found it" means the workspace files git does not ignore, the git index, and a fixed list of
  ignored dependency and environment files (`node_modules/.package-lock.json`, `.venv/pyvenv.cfg`, `target/.rustc_info.json`,
  `.env` and the like) are unchanged; a command that changes only other ignored files, empty directories, file modes other
  than the executable bit, anything outside the workspace, or git refs and config is not noticed. Files marked `git update-index --assume-unchanged` or `--skip-worktree` are compared by content, so an edit to them is noticed. Where git is configured to ignore the executable bit (`core.filemode=false`), the executable bit of every tracked file is compared too. If a git command used for the comparison does not finish within 30 seconds (`NEXUS_GIT_TIMEOUT_MS`), or a file name is not valid UTF-8, the workspace state is unknown and the turn keeps its verification step. The same happens in a very large sparse-checkout or `--assume-unchanged` repository, where comparing the marked files takes longer than the 1.5 second budget for the comparison. A command that
  keeps a process running after it returns can still change files later, so such a command is never treated as
  "changed nothing": `run_command` with `background` or a `service_name`, and a command line that shows a lone `&`,
  `nohup`, `setsid`, `disown`, `systemd-run` or `daemonize`. Nexus reads only the command line: a script or Makefile
  target that backgrounds work internally, `coproc`, `tmux`, `screen`, `docker run -d`, `pm2`, `at` and `cron` are not
  recognised. The check can also be wrongly cautious (a URL with `a=1&b=2`, `|&`, a quoted `&`, or the word `setsid`
  in an `echo` keep the turn `UNVERIFIED`), which only keeps the verification step. A file-write tool
  (`write_file`, `edit_file`, `patch_file`, `delete_file`) always counts as a change, so it still needs a verifier
  (`UNVERIFIED`, exit code 2), as does a command that changes a file. Nexus's own `.nexus/` state is not part of that comparison, so a turn that only records knowledge (`manage_knowledge`, which writes `.nexus/knowledge.json`) also ends `Done`. The receipt's `turnEvidence`
  records what the turn did: whether the workspace changed, changes carried in, actions denied and verifier runs.
  **Verified** means the passing test run — whether you configured the
  verifier or Nexus found it — is evidence about the change: it
  ran tests (its output reports at least one), ran the whole suite (no name filter), and covers the changed files — a
  changed file is a test, the run names a changed file, a test imports a changed module, or the change has inline
  tests the run executes (Rust `#[cfg(test)]` under `cargo test`, Go `_test.go` files under `go test`). A passing run
  that shows none of that only shows nothing else broke: the outcome is `tests passed, change not covered`
  (`REGRESSION_FREE`, exit code 2), and requirements cannot be marked `verified` on it. When resuming (`nexus run --resume`),
  if no prior task exists in the workspace (or a specified task ID cannot be found), the command exits with exit code 2. When Nexus found the test
  command itself, a covering pass is VERIFIED only if it is also **independent of Nexus**: before its first edit Nexus
  runs the tests once, and the tests as they were then (Nexus's own new or edited tests set aside) must have failed
  before the change and pass after it. Tests Nexus wrote in the same change cannot catch its own misreading of what you
  asked, so a change checked only by them — or by tests that already passed before it, as for a new feature or a
  refactor — ends `Done · tests pass (own tests only)` (`REGRESSION_FREE`); the receipt's `independenceDetail` says
  which. A verifier you configure is your own check and is not held to this.
  **Verifiers that cannot be bound.** Nexus also snapshots the verifier's own definition (package.json test script, Makefile
  and the scripts it names) before the first edit, so the model cannot rewrite the check it is judged by. When that
  definition cannot be bound — a local `node_modules` directory under `npm test`, a Makefile referencing more than 128
  files or files outside the workspace, directories nested deeper than 5 levels, and similar — the task still completes, but
  as `REGRESSION_FREE`: `Tests pass, but the verifier's definition could not be bound (<reason>), so it was not verified
  unchanged ... and the pass is regression evidence only`. The receipt carries `definitionBound: false`, no worktree merge
  receipt is issued, and requirements cannot be marked `verified` on it. Inline programs (`bash -c`, `python -c`, `node -e`)
  are not accepted this way at all. To get `VERIFIED`, use a verifier whose definition is bindable (for example a plain
  `node --test` or `make test` with a small Makefile, or run in a clean checkout without `node_modules`). Limitation: the
  baseline is kept in memory only, so after a restart or `--resume` following an unbound pass the "no matching pre-change
  baseline" error returns for that resumed task (a fresh task recovers); within one session every later completion
  reruns the verifier because the obligation stays pending. Python projects without configuration
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
  Every kind of approval (file changes, commands, the verifier) uses this one panel, and it answers at once:
  - `y` approves and `n` denies. Enter takes the highlighted option, which is Approve when the panel opens; ←/→ (and
    Tab/Shift+Tab) move the highlight across all three options.
  - **Approve all later actions** (switches to auto mode) is never one key: `a`, or Enter on it, asks
    `approve all later actions?` (a shorter form on a narrow panel), and Enter or `a` confirms only after that question
    has been drawn, and only 1 second or more after it was asked
    (and after any ignored press), so a double tap or a held key does not, including a held key's first repeat. ←/→ go back, and other answers (`y`, `n`,
    Esc) still answer.
  - Esc denies, at any time. Keys with Ctrl, Alt, Super or Meta never answer, nor do bursts of keys or pastes (letters
    go to your draft in the order typed; Enter does nothing; Backspace and the arrows act as usual).
  - Other typing goes to your draft (steering), so nothing you type is lost; it does not switch the letters off. While
    you are in a run of typing (a key within about 0.3 seconds of the previous one), a `y`, `n` or `a` is a letter of
    your text and goes to the draft, Enter is ignored, and the panel says `ignored: you were typing`; after a pause the
    same key answers.
  - Guards against accidents, and what they do not cover: when a key, Tab or paste was pressed in the second before the
    panel was drawn (the Enter that sent the prompt, a letter you were typing, the `y` that answered the previous
    request), decision keys are ignored with `ignored: panel just opened` until that input has been quiet for 1 second,
    and each ignored key restarts the full second, so a held key (whose auto-repeat starts after an initial delay, 0.66
    seconds by default on X11) stays inert until you let go. So a request that opens right after a key needs a pause of
    about a second before it answers; one that opens after you were idle answers at once. Not covered: typing slower
    than about 0.3 seconds per key that starts when no key was pressed in the second before the panel appeared; and a
    held key whose first repeat comes more than 1 second after the press (a long repeat delay set for accessibility).
    Terminals that do not report key release cannot tell a held key from fast presses.
  - A command, script or diff longer than the panel shows `↓ n more rows below`. Approve and Approve all are refused
    (with a notice) until every row of it has been on screen, read from the top with ↓ or PageDown (End and other jumps
    do not count the rows they skip, and a new terminal width starts the reading again); Deny never waits. Long lines
    wrap.
  - Characters that a terminal would act on or that draw as nothing are shown as visible stand-ins in the panel's text
    (the heading, paths, hunk labels, commands, scripts, arguments and file contents): control characters as control
    pictures (`␍`, `␛`, `␡`), and these as `<U+XXXX>`: U+0080 to U+009F, U+061C, U+200E and U+200F, U+202A to U+202E and
    U+2066 to U+2069 (bidirectional marks and overrides), U+00A0, U+00AD, U+034F, U+115F, U+1160, U+1680, U+17B4 and
    U+17B5, U+180B to U+180F, U+2000 to U+200D (spaces, zero-width space, joiners), U+2028 to U+202F, U+205F to U+206F,
    U+2800, U+3000, U+3164, U+FE00 to U+FE0F (variation selectors), U+FEFF, U+FFA0, U+FFF0 to U+FFFB, U+1BCA0 to
    U+1BCA3, U+1D173 to U+1D17A and U+E0000 to U+E0FFF (tag characters). This also applies inside emoji and
    right-to-left text, since an invisible character in a command is something to see before approving. Other zero-width
    characters (combining marks, for example) are drawn as the terminal draws them.
  The panel can be answered only while the screen shows its heading, the three buttons, the hint line under them (the
  question when you asked to approve all later actions, or the reason a key did not answer) and at least one row of the
  change. On a terminal too small for that, the panel shows only `enlarge the terminal` with `esc denies`; Esc still
  denies and no other key answers. A one-line command fits at 60 columns by 11 rows with an empty draft, and a one-line
  file change at 40 columns by 11 rows; text longer than the panel needs more rows, since the fold marker has its own row.
  Approvals that arrive while another panel or approval is open wait in order; the panel title shows how many are
  waiting.
- **Recovery.** If the agent sidecar stops, the screen names the exit code or signal, keeps the last relevant
  diagnostic lines (progress chatter is dropped) and your draft. Typing on that screen fills the draft, which is shown in
  the composer and kept across the restart. While the draft is empty, `r` starts a new agent and `q` quits; once it
  holds text, `r` and `q` are just text and the same actions are `ctrl+r` and `esc`. Over a draft the first `esc` only asks (`esc again quits and discards your draft`); a second `esc` in a row quits, any other key or a paste cancels the ask, and `ctrl+c` quits at once. So a typed `r` can never restart
  by accident; a draft that begins with `r` or `q` has to be started with another character and edited). Enter does not
  send to a stopped agent. After a restart, `/resume` reloads the saved conversation. Resuming (`-r` or `/resume`; `/resume` with no id loads the most recent saved session of this workspace other than the one you are in) shows the earlier conversation under a divider: your prompts,
  steering, the agent's replies, the tools it called (`· Read src/cache.ts`), and how the last turn ended. Diagnostics
  from turns that already finished are not shown as the cause of a later stop. Enter pressed while the agent is still
  starting sends the draft once it is ready.
- **Steering.** Enter while the agent works sends the draft as steering. It shows in the transcript as
  `↳ text · steering · applies at the next step`, then `applied` once the agent takes it. Each message stays its own
  user message for the agent. A message that arrives as the turn finishes runs as its own follow-up turn (`runs as its
  own turn next`); several of them run one turn each, in the order sent, never joined. Steering that cannot be applied
  (the turn was cancelled, a command was running, the agent stopped) is put back into the composer; when more than one
  comes back the draft holds them one per line, a notice says that Enter sends the draft as one message, and you can
  edit the draft if you want them sent separately. Slash commands wait for idle, except read-only `/doctor`,
  `/help` and `/receipt`.
- **Paste buffers.** A multi-line or long paste becomes `[Pasted text #1: 24 lines]` in the composer (a paste of up to
  six lines also shows its first line beside the label: `[Pasted text #1: 4 lines] alpha…`); its content is
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
  depth. On the 16 standard colours Nexus writes the classic `30-37`/`90-97` (foreground) and `40-47`/`100-107`
  (background) codes, never 256-colour `38;5;n`, so 8/16-colour terminals and the Linux console show them; 256-colour
  codes are used only where `TERM` names 256 colours.

  Receipts and toolchain changes: a worktree validation receipt records the versions of the toolchain that ran the verifier
  (node, the installed typescript, rustc for Cargo projects) and hashes of the build configuration (package.json, lockfiles,
  tsconfig, Makefile, Cargo and similar). If one of those changes, including a node upgrade between a session and its
  `--resume`, the receipt is invalidated and the verifier must run again. A tool that cannot be read at the time of the check
  is reported as unverifiable and does not invalidate the receipt; receipts recorded before this was added are marked legacy.

### Live TUI: newline key and mouse

- **New line.** `Ctrl+J` inserts a newline in the draft in every terminal; `Alt+Enter` does where the terminal sends it
  (not in Windows Terminal's default bindings, nor in macOS Terminal unless Option is set to act as Meta). Plain
  `Enter` sends. `Shift+Enter` also inserts a newline, but only on terminals that answer the kitty keyboard-protocol
  query at startup (kitty, WezTerm, foot and Ghostty do); elsewhere it arrives as a
  plain `Enter` and sends the draft. The footer and `?` help name `shift+enter` only when the terminal answered, and
  `alt+enter or ctrl+j` otherwise. The xterm `modifyOtherKeys` encoding of Shift+Enter is not read. tmux and screen
  are treated as unsupported unless they pass the query through; use `Ctrl+J` there.
- **Mouse.** Capture is on by default. On Unix it asks the terminal only for button presses and the wheel (on
  Windows crossterm's mouse capture also reports motion and drag). The wheel scrolls the
  transcript (three rows a notch), or the open panel, an approval's change included. A left click on a tool call
  selects it; a second click on the selected call opens its details, as `Enter` does. The mouse never approves anything
  and clicks do nothing while a panel is open (a split report on a slow link, below, is the one way a mouse can end up
  denying). Hold Shift while dragging (Option in iTerm2
  and macOS Terminal) to select text with the terminal's own selection; `NEXUS_TUI_MOUSE=off` turns capture off
  (`0`, `false`, `no` and `none` also do). Under tmux or screen the terminal only passes mouse events when mouse mode
  is on (`set -g mouse on`). On a slow or high-latency link a mouse report can arrive split: the first byte then reads
  as `Esc` (which denies an open approval and cancels a running turn, as it always does) and the rest as stray
  characters in the draft (never `y`, `n` or `a` as a decision); set `NEXUS_TUI_MOUSE=off` there. On exit the mouse mode
  is switched off, input still in flight is dropped for up to 0.3 s before and after the sidecar shuts down, and the
  unread terminal input is flushed; that also drops anything you typed ahead during the shutdown, and a report still
  in flight on a slow link after that can reach the shell.

### Cancellation & Process Ownership

- **Cancelling in the TUI:** While a turn is running, pressing `Esc` or `Ctrl-C` sets `cancel_requested`. The footer immediately acknowledges the request:
  ```
  ⠋ cancelling — waiting for <tool> (<n>s) · ctrl-c again to quit
  ```
  Within one frame, the cancellation signal reaches the command runner and inference engine.
- **Process Group Termination (REQ-AGT-109, REQ-SEC-106):** Cancellation terminates the entire process group (`killpg`) of in-flight commands: `SIGTERM` is sent immediately, followed by `SIGKILL` after a 2-second grace period. The turn reaches an idle state within 5 seconds.
- **Repeated Cancel Input:** While cancelling, a second `Esc` has no effect. A second `Ctrl-C` force-quits the TUI and sidecar, initiating an automatic shutdown sweep that terminates all child processes.
- **Background Services:** Commands launched with `run_command { background: true, service_name }` (such as background dev servers) are registered as managed services. They survive turn cancellation and are listed in `/status`. On client exit or application shutdown, all registered background services are cleaned up. Background processes spawned without registration (`cmd &`) are terminated on turn cancellation.
- **Inference deadlines:** A model request has a 15-minute whole-request deadline, including streams that keep sending chunks. First-byte and idle-between-chunks timeouts remain separate. The operator may set `LOCAL_LLM_TIMEOUT_MS` up to 60 minutes; zero or an invalid value uses the 15-minute default and cannot disable the deadline. Cancellation aborts the in-flight request.
- **Notification Gating (REQ-AGT-109a):** Turn completion notifications (desktop `notify-send` and terminal `BEL` `\x07`) are gated to interactive TTY environments running on the REPL or TUI surface. Headless runs (`nexus run --json`) emit no BEL characters and spawn no notifications.

### Long tasks: bounded automatic continuation

`--max-steps` (default 30) is a segment: at each segment boundary the turn writes a durable checkpoint and continues
on its own. The objective has a finite default ceiling of 500 total steps and each invocation has a 480-minute ceiling.
Operator overrides are bounded at 5,000 steps and 4,320 minutes. A turn also stops on completion, cancellation, demonstrated lack
of progress (`--stagnation-steps`, default 12 consecutive steps without progress, or a repeated action on an unchanged
workspace after two recovery notes), an actionable failure, or a limit **you** set (`--max-total-steps`,
`--max-turn-minutes`). Progress is judged against workspace content, not tool-call equality: plan edits, identical
rewrites and timestamp-only output changes do not count, and a retry after a real change is legitimate. Polls and
transient failures are spaced with backoff instead of being treated as loops. `--no-continuation` restores the
single-segment turn. Tracking (cumulative steps, loops, failed approaches, compactions) belongs to the objective and
survives compaction, follow-ups ("continue") and `/resume`; the total-step budget is shared with in-turn delegated
helpers. The time limit currently applies to each active invocation and is not accumulated across process restarts.
See `docs/COMPACTION_AND_CONTINUITY.md`.

A single model response may request at most 16 tool calls. A larger batch is rejected in full before any of its calls
run, and Nexus reports the rejection in the next model context. This bounds tool fan-out from one response; it does
not replace the objective-wide step budget.

The objective also has a durable tool-dispatch ceiling: 1,000 calls by default, configurable with
`--max-tool-invocations` or `NEXUS_MAX_TOOL_INVOCATIONS` up to 10,000. It applies even when automatic continuation is
disabled. The first run saves its ceiling with the objective; later runs may lower it but cannot raise or renew it.
Older objectives without a complete dispatch history retain an explicitly incomplete count, so the displayed total is
a lower bound rather than an observed zero. Direct agent turns and their in-turn delegated child loops share this
counter; each child dispatch reserves its allowance before execution. Exhaustion stops the objective as
`LIMIT_REACHED` and cannot establish successful completion.

A second, independent brake watches the verifier itself: when `task_completed` fails the same verifier
`NEXUS_VERIFIER_CONVERGENCE_ATTEMPTS` times in a row (default 3; a check-only failure with no test names needs one
more) with the same failing tests across changed workspace states, with the failure alternating between two sets
(A/B/A/B), or with a rising failing-test count, the turn ends `BLOCKED` / `NOT_ESTABLISHED` with reason
`VERIFIER_NOT_CONVERGING` and the attempt history attached; you decide how to proceed. Environment failures, timeouts
and runs skipped on unchanged inputs are ignored, and a changing failure set never trips it. Only `task_completed`
is covered: a loop of `run_tests` calls alone is bounded by `--stagnation-steps` (`STAGNATION_DETECTED`) instead.

A third brake counts identical tool calls regardless of timing: a call with the same tool name and the same arguments
(compared as stable JSON) that returns the same result (timings and ids ignored), seen in the last 64 calls even with
other calls between them. At `NEXUS_REPEATED_CALL_SOFT` repeats (default 3) the model gets a corrective note naming the
call. At the hard threshold, in a step that changed nothing in the workspace, the turn ends `BLOCKED` /
`NOT_ESTABLISHED` with reason `TOOL_CALL_LOOP` and the repeated call and recent call history (arguments redacted)
attached. The hard threshold depends on the call, with `NEXUS_REPEATED_CALL_HARD` (default 5) as the base:

| Call | Soft | Hard |
|---|---|---|
| Workspace reads (`read_file`, `list_dir`, `search_code`, `git_status`, ...): counted only while the workspace is unchanged | 3 | 5 |
| `run_command`, writes and other tools: a failing rerun between edits with identical output is a loop | 3 | 10 |
| An unchanged successful external poll (`tail build.log`, `docker ps`), which Nexus already spaces with backoff | 3 | 20 |

A repeat whose result changed, a read after an edit, and a turn whose workspace state cannot be established are never
stopped (the note still appears). Both settings are whole numbers (soft at least 2, hard above soft); other values are
ignored and `nexus doctor` warns. They work with `--no-continuation`. A project `.env` can only lower them: the
effective value is the smaller of the project's and your own.

The operator's objective and its
numbered requirements are pinned for the model on every request (never summarised away); the agent records
requirement progress with evidence, and a turn that stops with requirements open ends `REQUIREMENTS_INCOMPLETE`
with the remaining items, failed check and next action (see `/receipt`). Only the operator can reduce scope: a
requirement the agent marks descoped stays unresolved until you run `/requirements accept <id>` (`/requirements`
lists them). While an objective with listed requirements is unfinished, every message you send — however long, even
with its own numbered list — continues it (numbered items are added as further requirements, and a notice says so);
`/requirements clear` (or `/clear`) starts a new objective. For a requirement you wrote, `/requirements reference <id> <command>` names a reference command, and `/requirements differential <id> --inputs <file>` (a JSON array of strings, at most 50, each at most 64 KiB) runs your latest verifier command and the reference on each input (stdin, sandboxed, no network, 30 s each) and reports how many agree, diverge or were inconclusive (timeout or error). Agreement on those inputs says nothing about other inputs; it is not equivalence. The agent cannot name a reference or run this. A requirement counts as *verified* only when a passing
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
and never shown as success. The context window and output allowance are discovered from the active endpoint: vLLM (`/v1/models` `max_model_len`),
llama.cpp (`/props` `n_ctx`), LM Studio (`/api/v0/models` `loaded_context_length`), Ollama (`/api/show` `num_ctx` or
`model_info.*.context_length`), or gateway capability advertisements, else from `--context-limit` (`NEXUS_CONTEXT_LIMIT`)
or the labelled 65536 default (`client_default`). `/status` and `nexus doctor` show both with their source (`provider_advertised`,
`server_probe (<kind>)`, `operator_override`, or `client_default`) and how the last request was counted (`exact_admitted`,
`exact_sampled_worker`, `gateway_conservative`, `client_estimate`). `--strict-token-count` refuses requests that could not
be counted on a worker. See `docs/LOCAL_SERVERS.md` and `docs/COMPACTION_AND_CONTINUITY.md`.

### Direct Shell Execution (`!`)
Run raw bash/zsh commands instantly inside the active workspace without invoking the LLM:
```text
nexus (qwen2.5-coder) my-app ❯ !git status
nexus (qwen2.5-coder) my-app ❯ !cargo check
nexus (qwen2.5-coder) my-app ❯ !npm test
```

### Slash Commands Cheatsheet

| Command | Description |
| :--- | :--- |
| `/help` | Display cheatsheet of all available commands |
| `/status` | View active model, endpoint, shell, git badge, context sizing with sources, last request count, objective progress |
| `/plan [add\|done\|start\|clear]` | Formulate and manage multi-phase milestone execution plan |
| `/tui` | REPL only: open the session dashboard (not offered in the live TUI, where it had no purpose) |
| `/doctor [--deep] [--fix [--yes]]` | Diagnose this session's configuration, endpoint, engine, shell and state (see `docs/DOCTOR_TROUBLESHOOTING.md`) |
| `/upgrade [--check\|--version <v>\|--yes]` | Check for updates or safely upgrade to the latest stable or pinned release with deliberate approval |

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
| `/copy [diff\|code\|last]` | Copy diff, code blocks, or response to system clipboard. With no clipboard tool (`wl-copy`, `xclip`, `xsel`, `pbcopy`: SSH, tmux, headless) the live TUI asks the terminal to copy it with an OSC 52 request instead (up to 74,994 bytes; larger text is refused, never cut). The terminal does not confirm it: terminals may ignore OSC 52, tmux needs `set -g set-clipboard on`, GNU screen is not supported. The text reaches the terminal only base64-encoded, after the same credential redaction and control-character handling as every sidecar message. `NEXUS_OSC52=off` (also `0`, `false`, `no`, `none`) turns the fallback off, and the older line-mode REPL does not use it. |
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

### Behaviour changes in v1.2.0

Release notes: `docs/releases/v1.2.0.md`. These changes affect existing workflows.

- **Verification-file edits ask or are denied.** Agent edits to tests, CI, build and verifier files need an operator decision (interactive) or are denied headless (`VERIFICATION_CONFIG_PROTECTED`). `verificationPaths.mode` in `.nexus-security.json` is `approve` (default), `record`, `block` or `off`; see "Verification-configuration guard" under Safety below.
- **Operations that run units concurrently must isolate them.** `nexus operation run` rejects a spec whose `policy.maxConcurrentUnits` is above 1 unless it sets `"git": { "isolate": true }` (otherwise concurrent units write the same worktree). Fix the spec by adding `git.isolate` or setting the limit to 1. Operation records already on disk are not refused: `nexus operation resume` and `decide` clamp them to one unit at a time and print a warning.
- **Boundary rules (`boundaries` in an operation spec).** The operator can declare what a reviewed change must not do, and the review gate checks it on the candidate diff by deterministic analysis; a violation is REJECTed whatever the model says. Fields (all optional, but at least one; unknown keys are refused and every error names its field): `imports` (a list of `{ name, from: [globs], deny: [globs], allow: [globs] }`: an added import in a `from` file whose target matches `deny` is a violation; one outside `allow` is an advisory, an undeclared dependency; `node:` built-ins are always fine), `protected` (public files whose change needs the unit's `authorizedScope`), `interfaces` and `schemas` (files whose change is classified compatible, potentially breaking or unknown, as an advisory) and `acyclic` (modules among which no import cycle may exist). Rules apply to reviewer units of `nexus operation run`; with no `boundaries` nothing changes. **Limits, reported with every verdict (`boundaryReport.coverage`):** it reads the lines the diff adds and removes, not a build, so path aliases, re-exports, computed imports and multi-line imports are not resolved; classification reads top-level declarations and key-level schema changes only; Rust, Python and Go imports are matched as module paths, not files; a cycle is found among the imports the diff adds (a cycle needing an import already in the repository is not found); sections hidden from the reviewer's diff are not analysed; a file header it cannot read is itself a violation. It is a guard on what a diff shows, not a proof of architecture.
- **A verifier that cannot be bound no longer blocks completion.** When the verifier definition cannot be snapshotted, tests still run and the task ends `REGRESSION_FREE` with the reason, never `VERIFIED`, with no receipt or worktree merge (see the verification section above).
- **Type-check evidence.** After the test verifier passes, `tsc --noEmit` or `cargo check` runs through the same approval gate. A type error in a file the task modified blocks `VERIFIED`; errors only in untouched files are recorded as `PREEXISTING` and do not block. `NEXUS_TYPECHECK=off` disables the check and `NEXUS_TYPECHECK=enforce` makes it blocking; without the variable it enforces, except that a project with its own configured verifier records only. A baseline run before the change (tsc, `go vet`, pyright, mypy; not cargo) records the errors that already exist, so a new error in an untouched file, such as a caller the change broke, also blocks `VERIFIED`. Files changed through shell commands count as modified (workspace diff, minus what was changed when the task began). Go (`go vet ./...`, when `go.mod` exists) and Python (pyright or mypy, only when the project configures one) are checked; a tool that is not installed is reported `UNAVAILABLE` and is never a pass. A resumed task has no baseline. One check runs per project: the first found among tsc, cargo, go, then Python.
- **Verifier convergence.** A repeating, alternating or worsening verifier failure ends the turn `BLOCKED` (`VERIFIER_NOT_CONVERGING`). The threshold is `NEXUS_VERIFIER_CONVERGENCE_ATTEMPTS` (default 3); see "Long tasks" above.
- **Headless decisions end BLOCKED with a question.** A headless run (`nexus run`, no operator) that needs an approval (a write, command or egress in review mode, a verification-file edit, the verifier or the type-check at completion) stops at that point with `execution=BLOCKED`, `reason=NEEDS_INPUT` and `turn.needsInput` (`id`, `kind`, `prompt`, `subject`, `options`). Answer it with `nexus run --resume <task> --answer <id>=approve` (or `=decline`, repeatable). An answer covers only that exact action (the id is a digest of the tool and arguments, the path, or the verifier command and script); anything else asks again. Exit code stays 1; read `reason`. Two more questions use the same result. **A blocked requirement** (`kind: blocked_requirement`, `nexus run` only): when the model marks one of your requirements blocked, the run ends BLOCKED / NEEDS_INPUT with the blocker instead of `COMPLETED / REQUIREMENTS_INCOMPLETE`; its only option is `reply`, answered in your own words with `--answer <id>=reply:<what to do>` (up to 2000 characters), which the resumed run gives to the model. The same blocker left in place asks again; a new reason is a new question. **An undecided steering conflict** (`kind: steering_conflict`): steering sent during a turn that would drop a requirement, and that got no decision before the turn ended, ends that turn BLOCKED / NEEDS_INPUT; `approve` applies the steering at the next turn (the requirement is descoped as accepted by you), `decline` keeps the requirement. Through the sidecar, send `{"type":"answer","id":"<request id>","question":"<needsInput.id>","option":"approve|decline"}`, or send the steering again and decide at the prompt. Only the turn that left the conflict undecided reports it; later turns do not ask again. A subagent's question is covered too (`docs/v1.2.1/VC-9-needs-input-audit.md`).
- **Start from a copy of a session.** `nexus run --fork-session <task> [--fork-at <n>] "<prompt>"` copies the task (its first `n` messages, backed up to a complete tool exchange; default all) into a new id, prints that id on stderr, and runs the prompt in the copy; the original is never changed. `nexus repl --fork-session <session> [--fork-at <n>]` does the same for the REPL. Exit code 2 for an unknown source, a bad `--fork-at`, or `--fork-session` with `--resume`. If the source is bound to a git worktree, the fork gets a separate branch and checkout with the source's tracked edits and non-ignored untracked files copied at fork time. Ignored files and generated output are not copied; forks are refused if the source branch changed or the untracked snapshot exceeds the safety limits. A fork at an earlier message still uses the workspace snapshot as it exists when the fork is created.
- **Steering conflicts.** Steering that negates a numbered requirement does not replace the requirements. The ledger stays intact and you are asked to decide; headless runs record the conflict as unresolved. A request that would replace a ledger with unmet requirements keeps a `superseded` record. Steering that does not conflict behaves as before.

### Verifier environment (`NEXUS_VERIFIER_ENV_PASSTHROUGH`)

The operation runner re-runs a unit's approved verifier on the merged tree in a child whose inherited **environment variables** are scrubbed: the MCP allowlist (`PATH`, `HOME`, `LANG`, proxy and CA settings, ...) plus common toolchain variables (`CARGO_HOME`, `RUSTUP_*`, `GOPATH`, `GOCACHE`, `GOFLAGS`, `NODE_OPTIONS`, `NVM_DIR`, `VOLTA_HOME`, `PYENV_ROOT`, `VIRTUAL_ENV`, `PYTHONPATH`, `JAVA_HOME`, `CI`, `XDG_CACHE_HOME`, `LD_LIBRARY_PATH`, `UV_*`, `GRADLE_*`, `MAVEN_*`, `DOTNET_*`). Any name containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL` is never passed by default, and no `NEXUS_*` variable is.

To pass more, set `NEXUS_VERIFIER_ENV_PASSTHROUGH` to a comma-separated list of names (a trailing `*` is a prefix), for example `NEXUS_EVAL_TEST_*,ANSIBLE_CONFIG,VIRTUAL_ENV`. Names you list are passed even if they look secret. The setting is read from the operator environment or `~/.config/nexus/config.env` only; a project `.env` cannot set it. This scrubs inherited variables only: files under `HOME` (`~/.config/nexus/config.env`, `~/.ssh`, `~/.aws`, `.npmrc`, `.netrc`, `~/.cargo/credentials.toml`) remain readable by the verifier. A verifier that exits 126/127 is reported as an environment problem (naming this setting), not as a candidate failure. `nexus doctor` shows the current value.

### Durable operation scheduling policy

Operation defaults can be set in the operator-owned `~/.config/nexus/config.json`, the legacy `~/.config/nexus/config.env`, or the operator's shell environment. The initial structured config schema supports `operationPolicy`:

```json
{
  "version": 1,
  "operationPolicy": {
    "maxWaitMs": 43200000,
    "unknownResumeBudget": 2,
    "maxRunsPerUnit": 25,
    "minWaitMs": 1000
  }
}
```

The file is read only from the operator's home directory; a repository-level `nexus.config.json` cannot set operator policy. Unsupported fields, invalid values, symlinks and files larger than 64 KiB are rejected. Values resolve from the shell environment first, then `config.json`, then `config.env`, then built-in defaults. Existing `config.env` installations remain supported.

The equivalent environment settings are:

```sh
NEXUS_OPERATION_MAX_WAIT_MS=43200000
NEXUS_OPERATION_UNKNOWN_RESUME_BUDGET=2
NEXUS_OPERATION_MAX_RUNS_PER_UNIT=25
NEXUS_OPERATION_MIN_WAIT_MS=1000
```

These values configure the maximum time an operation waits without runnable work, the automatic replay budget after
an unknown execution outcome, the per-unit run limit, and the minimum delay between wait wake-ups.
Values must be safe integers; wait values and the run limit must be positive, while the unknown-resume budget may be
zero. Each wait value is capped at 2,147,483,647 ms, the maximum delay supported by Node.js timers, and the minimum
wait may not exceed the maximum wait. Malformed or unsupported operator configuration in `~/.config/nexus/config.json` prevents client commands that load this file from starting, with a `Configuration error` naming the problem. `nexus doctor` and `nexus check` remain available for recovery guidance, as do `--help` and `--version` requests. Run `nexus doctor`, then fix or remove `~/.config/nexus/config.json` as directed.
Project `.env` files cannot set these operator-owned values. A policy explicitly supplied in an operation
specification overrides the configured defaults for that operation, subject to the same wait-interval consistency
check. Invalid effective settings are reported when an operation is created; a specification override can repair
otherwise contradictory operator wait defaults for that operation. Already persisted operations keep their stored
policy when resumed.

### Managed policy (`nexus policy`)

An administrator can restrict Nexus on a machine with `/etc/nexus/policy.toml` (root-owned), and an operator can
restrict their own sessions with `~/.config/nexus/policy.toml`. A policy only restricts: it can disable `--yes` and
approval mode `auto`, require the sandbox, forbid or always ask before named commands, protect paths, and limit which
MCP servers start and which plugin files are imported (`mcp.allow`, `plugins.allow`, and `disable_workspace` for
each). A server or plugin the policy does not admit is not started or imported, and Nexus says which policy file and
key decided. A policy file that exists and cannot be read or parsed stops Nexus with exit code 2; there is no bypass.
The format, every key and the exact rules are in [MANAGED_POLICY.md](MANAGED_POLICY.md).

```bash
nexus policy show                       # every key, its effective value, and the tier that decides it
nexus policy show --json
nexus policy check                      # validate the installed files; exit 2 when Nexus would refuse to start
nexus policy check ./policy.toml        # validate a file before rolling it out
```

Both commands only read, and both run when a policy file is broken, as `nexus doctor` does. `nexus doctor` reports
the policy as the findings `policy.system`, `policy.user`, `policy.project` and `policy.effective`; `nexus doctor
--fix` never changes a policy file. Under `approval.disable_auto` (or `approval.strict`) an "always" answer to an
approval prompt approves that one call and is not remembered, and `/mode auto` is refused with the policy source.
`nexus verify` honours the same policy: `--yes`, `--sandbox none` and `--sandbox-network` are refused (exit code 2)
when `approval.disable_yes`, `sandbox.required` or `sandbox.forbid_network` is set.

- **Workspace Symlink Boundary Confinement**: Native Rust canonicalization verifies that neither relative paths nor symlinks can escape the workspace jail directory.
- **Configurable Security Policy (`.nexus-security.json`)**: Declare repository-specific blocked shell commands, protected files (`.git`, `.env*`, keys), and allowed outbound network domains. Protected-path checks cover case-insensitive variants, `.env*` prefixes, and canonical targets across all file read/write/edit tools. Patterns match the path relative to the workspace root, so a workspace that sits under a directory with a protected-looking name (for example `~/.env-tools/project`) is not blocked wholesale; a symlink that leaves the workspace for a protected target is still refused. The old `allowExternalSymlinks` key was never read and has been removed; a policy file that still sets it loads, and the key is ignored; for `run_command` path protection is advisory because shell commands execute in the host shell environment.
- **Prompt-injection scanner (CS-7).** Text that enters the model from outside (a fetched page, a file, command output, a tool server's reply) is checked for: instruction-like text aimed at the assistant ("ignore the previous instructions", "do not tell the user", "send the credentials to ..."); characters a reader cannot see (Unicode tag characters that spell hidden text, bidirectional overrides, runs of zero-width characters); markup posing as a chat turn or a tool call; and a base64 or percent-encoded payload that decodes to one of these. A result that trips a strong signal, or two weak ones, reaches the model with a notice first, between `<<<UNTRUSTED RESULT BEGIN>>>` and `<<<UNTRUSTED RESULT END>>>`, with its content unchanged except that hidden characters are shown as `<U+XXXX>`; nothing is deleted. The `security.injection_suspected` stream event and the operator console say it happened. While an operator is present, the next step's state-changing calls (writes, commands, network, delegation; not reads) ask for approval even in `--mode auto`, naming the tool whose result looked wrong. With no operator present (headless, `--yes`) nothing is blocked: the label and fence are the whole response. Nexus's own memory tools are not scanned. **Limits:** it is a heuristic, not a guarantee. It reads English phrasing; a paraphrase, another language, text split by punctuation, look-alike letters, reversed or leetspeak text, and an instruction with none of the trigger words are not seen, and ordinary text that quotes an attack (a security article, a test for this very scanner) is flagged. On the labelled corpus in `cli/test/fixtures/injection_corpus.json`: phrasings the scanner was tuned on, 54 of 64 attacks caught and 5 of 45 benign samples flagged; phrasings written after it was frozen, 15 of 30 caught and 2 of 24 flagged; 0 of 12 deliberate evasions caught. Treat the second line as the realistic figure. The only complete defence is not letting untrusted content steer actions you did not ask for: keep approvals on, and use `--sandbox`.
- **Egress inspector (`NEXUS_EGRESS_POLICY`).** Before a call that sends data outside your network runs (`fetch_web`, `search_web`, `browser_navigate`, `browser_type`, and a `run_command` line that starts a network command such as `curl`, `wget`, `nc`, `ssh`, `scp` or `rsync`), Nexus checks it for your workspace's own secrets: the value of any secret-named variable (a name containing KEY, TOKEN, SECRET, PASSWORD, AUTH and the like) in the workspace root's `.env` and `.env.*` files, as written, URL-encoded or base64-encoded; a `$VAR` a network command expands when that variable is set to a secret in the environment; and a credential file a network command reads (`.env`, `id_rsa`, `.npmrc`, `.netrc`, `.aws/credentials`...). A hit is refused before anything runs (`EGRESS_SECRET_BLOCKED`), naming the secret and where it was found, never its value, and the decision is recorded (`getEgressDecisions`). Loopback, localhost, private-network and appliance destinations are not inspected. The policy is a JSON object in **your own environment**, `NEXUS_EGRESS_POLICY='{"mode":"record","allowDestinations":["api.github.com"]}'`; the workspace's `.nexus-security.json` is deliberately not read for it, because a repository you clone must not be able to switch the guard off (a request to relax it there is ignored and reported on stderr). `mode` is `block` (default), `record` (runs it and records the decision) or `off`; an invalid value falls back to `block`. `allowDestinations` lists hosts that may receive secrets (`api.github.com`, `*.corp.example`); a call that names no host (a search, a browser form) cannot be allow-listed. A command run through a wrapper (`env`, `sudo`, `timeout`, `nice`, `nohup`, `command`, `xargs`, `sh -c '...'`, `eval`) is inspected as the command it runs. **Limits:** it cannot see a secret the command builds at run time (`$(cat .env | base64)`, a script the model wrote), one split across arguments, or one transformed in any way other than URL or base64 encoding. It is a guard against the careless and the common, not against a determined adversary inside the shell; containment (`--sandbox`, no network) is the guard for that.
- **Verification-configuration guard (`verificationPaths` in `.nexus-security.json`)**: File-tool edits by the agent to tests, CI, build and verifier files (`Makefile`, `.github/workflows/**`, `conftest.py`, `.coveragerc`, `pyproject.toml`/`setup.cfg` (only when pytest, coverage, tox or script sections change), `.husky/**`, `.pre-commit-config.yaml`, `jest|vitest.config.*`, `scripts/**/test*`, `package.json` when `scripts`/`jest`/`vitest`/`mocha`/`ava`/`nyc`/`c8`/`workspaces` change, existing runnable test files, and the policy file itself) need an operator decision, at any depth. `mode` is `approve` (default; denied with `VERIFICATION_CONFIG_PROTECTED` when no operator is present; `--yes` passes and records), `record`, `block` or `off`; `extra` and `allow` are glob lists. Creating a new test file is free; creating a new config or CI file is gated, so a headless greenfield project that must create such files needs `--yes` (fullAccess) or `verificationPaths.mode` `record`. Edits arriving over MCP have no operator and are denied. The tester role may append cases to an existing test through `write_file` or `edit_file` (text that skips tests or exits early is refused); `patch_file` on an existing test always asks, and nothing may weaken or delete one. Every attempt is recorded in the session export (`verificationConfigAttempts`). **Shell commands: by default `run_command` writes (`sed -i`, `tee`, redirects, `mv`...) are detected best-effort and recorded only, never blocked, so in the default modes this guard does not stop a shell-capable agent from changing how work is verified. In `block` mode it does: Nexus fingerprints the verification files before and after each `run_command` (by contents, so the command need not be recognised), and if any changed it restores them, refuses the call with `VERIFICATION_CONFIG_PROTECTED` and the changed lines, and records the attempt as blocked. A new runnable test file is still free to create, and a dependency edit in `package.json` is not a change (only the keys that decide how tests run count). The scan covers up to 20,000 workspace entries, files up to 2 MiB are fingerprinted, and files up to 64 KiB can be restored; beyond those limits the result says coverage was partial or the file could not be restored.**
- **Dry-Run & Read-Only Modes (REQ-SEC-104)**:
  - `--dry-run`: Intercepts file writes and mutating commands to simulate changes without touching disk.
  - `--read-only`: Rejects all file modifications and non-read shell commands with an immediate error. Under container sandboxing (`bwrap`), `--tmpfs $HOME` is mounted to completely mask SSH keys (`~/.ssh`), credentials, and dotfiles from `run_command`. Without `bwrap`, strict path confinement rejects paths referencing `~`, `$HOME`, environment variables (`$`), absolute paths outside the workspace, or escaping `..` sequences.
- **Lightweight Container Sandboxing & Direct Argv Spawning (`--sandbox`, REQ-SEC-109)**: Restricts filesystem mutation strictly to the target workspace using Linux Bubblewrap (`bwrap`) or Docker isolation. Sandbox commands are constructed as direct `argv` argument arrays and executed without passing through a host shell (`sh -c` / `bash -c`), preventing shell escaping vulnerabilities with paths containing spaces or quotes. With `bwrap` the write-mode sandbox:
  - replaces `$HOME` with an empty tmpfs (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/nexus` are not visible, also when the workspace is `$HOME`) and binds back, read-only, only toolchain directories (`~/.cargo`, `~/.rustup`, `~/.nvm`, `~/.local/bin`, `~/.npm`, `~/.cache/pip`, `~/go/pkg`, `PATH` entries under `$HOME`). Extend the list with `NEXUS_SANDBOX_HOME_READONLY` (comma-separated paths, operator environment or `config.env` only). Cargo credential files, `/run/user/<uid>` and the docker socket are hidden. `nexus doctor` prints the effective mounts.
  - starts commands with the scrubbed command environment only (see below);
  - has **no network by default**. Opt in with `--sandbox-network` or `NEXUS_SANDBOX_NETWORK=1` in the operator environment; `--yes` does not enable it, and `--read-only` is always offline. In review mode the approval prompt states whether the sandbox has network access.
  - runs commands in a PID namespace with a fresh `/proc` (host processes are invisible) and kills them when the runner exits (`--unshare-pid`, `--die-with-parent`).
  - Docker (`--sandbox docker`): a digest-pinned image (`alpine:3.23@sha256:...`, constant `DOCKER_SANDBOX_IMAGE`; override with the operator setting `NEXUS_SANDBOX_DOCKER_IMAGE`, which must be `name@sha256:<64 hex>` or no container starts), run as your uid:gid with `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 512`, a read-only root and a 256 MB tmpfs `/tmp`, no network unless `--sandbox-network` / `NEXUS_SANDBOX_NETWORK=1`, the scrubbed environment only (`--env` per variable), and credential paths masked when the workspace is, contains or sits above `$HOME`. Commands that wrote outside the workspace and `/tmp`, relied on root, or used the network now fail in Docker mode.
  - **Limits:** under `--sandbox`, files outside `$HOME` stay readable (the host root is bound read-only), for example other users' home directories and world-readable system files. The sandbox does not protect against a command you approve while the network opt-in is on.
- **Command Environment Scrubbing**: `run_command` no longer inherits credentials from the Nexus process, with or without `--sandbox`. Variables set in `~/.config/nexus/config.env`, names that look like credentials (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `AWS_*`, `GH_TOKEN`, `SSH_AUTH_SOCK`, ...) and proxy URLs with embedded credentials are removed. To pass a variable through deliberately, list its name in `NEXUS_COMMAND_ENV_PASSTHROUGH` (comma-separated, trailing `*` for a prefix; operator environment or `config.env` only, never a project `.env`). Commands that relied on `SSH_AUTH_SOCK`, `GH_TOKEN` and similar must now opt in. **Limit:** without `--sandbox` the command runs as your user: it can still read your files (`~/.config/nexus/config.env`, `~/.ssh`) and its parent processes' environment through `/proc/<pid>/environ`. Use `--sandbox` to hide host processes and `$HOME`.
- **Worktree merge hardening**: the legacy task-worktree merge (`WorktreeManager.mergeWorktree`, used for `--worktree` task worktrees) refuses a worktree whose `.git` was replaced, and runs Git pinned to that worktree with hooks and `core.fsmonitor` disabled, so a planted hook or fsmonitor in an agent-writable worktree no longer runs code outside it. The repository's own hooks no longer fire on that commit and merge.
- **In-Process Plugin Execution & Middleware Auditing**: Custom plugin handlers and middleware execute in-process with full user authority. Plugins are loaded only from documented directories: `~/.config/nexus/plugins/`, `~/.nexus/plugins/`, and trusted workspace directories (`.nexus/plugins/`, `plugins/`). The undocumented foreign directory `~/.config/opencode/plugins` has been removed (REQ-SEC-115), and the legacy worker-thread sandbox claim has been retired (`executeSandboxed` deleted, REQ-SEC-117). Any middleware rewriting of tool I/O (`preToolExecution` or `postToolExecution`) is cryptographically audited with before-and-after SHA-256 digests in both `~/.nexus/audit.log` (`kind: "middleware_rewrite"`) and the flight log (EXT-004, REQ-SEC-116).
- **Workspace Trust & Context Provenance (REQ-SEC-113, CTX-001)**: An opened workspace is data until explicitly trusted by the operator. Workspace trust covers:
  - Project instructions (`AGENTS.md`, `CLAUDE.md`, `CODEX.md`, `.nexusrules`). In a trusted workspace `@path` imports inside them are expanded (workspace-confined by real path, read once, 5 levels deep at most, regular files up to 64 KiB); the instruction heading lists the loaded files. An untrusted workspace gets neither the file nor its imports.
  - Workspace `.mcp.json` / `mcp.json` server definitions.
  - Workspace plugins (`.nexus/plugins/`, `plugins/`).
  - Workspace skills (`skills/`, `.nexus/skills/`, `.claude/skills/`).
  - Workspace knowledge graph (`.nexus/knowledge.json`).
  Trust is managed via `nexus trust [path]` (undo with `nexus trust --remove`, list with `nexus trust --list`; stored in `~/.config/nexus/trusted_workspaces.json`, which the agent's file tools cannot write). In an untrusted workspace:
  - Project instructions are not injected into the agent prompt.
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
- **Verifier Execution Gating (REQ-SEC-119)**: Automated test runs and verifiers (`run_tests`, `/test`, completion oracle) are classified as `exec` capabilities subject to the configured approval mode. In review mode, the first verifier execution prompts for approval, displaying the exact test command and resolved script body from `package.json`, `Makefile`, or `Cargo.toml`; folder trust alone does not authorize it.
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

## 5. Detached background jobs

The experimental Linux runner lets an unattended job continue after its submitting CLI exits. Jobs use a fresh worktree pinned to the submitted `HEAD`, bounded budgets and a deadline, and a stricter approval policy. The default is read-only; `--allow-worktree-write` is limited to the job's sandboxed worktree. Jobs never use auto-approval and are not merged automatically. A required decision leaves the job `BLOCKED` for you to inspect. Install and run the supervised service with `nexus runner install-unit` and `systemctl --user`; see [`RUNNER.md`](RUNNER.md) for setup, commands, recovery and limits.
