# Nexus Code v1.1.3 Plan

**Status:** Draft for owner review. **Base:** `main` after the v1.1.2 merge and tag.
**Scope (owner, 2026-11-04):** (1) resolve every open finding from v1.1.2; (2) add Worktrunk functionality in the best-integrated way.

## 1. Principles

- Close findings with the fix first, the regression test red first, and an independent review per work package. Findings are closed with evidence, never by editing the finding.
- No new runtime dependency (gate G1.1-5: zero deprecated packages, `cargo deny`, SBOM, notices). Anything Worktrunk-shaped must be built on Node, git and the system `cp`.
- Project-supplied commands are untrusted input. Nothing a repository file declares runs without an approval that lives outside the repository.
- One exact-head gate per release candidate, run with the CI fixture variables set so `make test` runs through, in a clean worktree with its own `npm ci`.

## 2. Findings ledger

Sources: my independent reviews on PR #402 (WP-1105 evaluators, WP-1107 provider work), Entire trail 145 (15 open findings after the `--step` HIGH was fixed in v1.1.2), Entire trail 140, and the known limitations in `docs/releases/v1.1.2.md`. Every item below must end as FIXED (with a test), WITHDRAWN (with evidence it is not a defect) or DEFERRED (owner decision, with a reason). Work packages are ordered by risk.

### WP-1301 Single-step mode and the TUI (WP-1106)
- TUI `/step` calls `agent.runTurn` directly: no rollback checkpoint, no live tool events, no saved session, a blocked turn reported as success. Route it through the normal sidecar turn runner (`prepareTurnCheckpoint` + `runInteractiveTurn`).
- `/step` is not `cancellable`.
- The step pause overwrites a `STAGNATION_DETECTED` stop and skips `endStep()`; guard on `!stopReason` and call `endStep()` before pausing, so stagnation detection advances across `/step` calls.
- Tests: drive the real REPL `/step` handler and the TUI `stepSlash`; the current REPL test re-implements the logic and would pass if the handler were deleted.

### WP-1302 Code evaluators (WP-1105)
- **Fail-open overlay (HIGH in review):** build and `typecheck_clean` overlay only `.ts .mts .cts .tsx .js .mjs .cjs .jsx .rs .py` candidate files on the baseline. Carry every candidate build input (additions and deletions), or fail closed and report ignored changed paths.
- Shadowing through `node_modules` and in-repo build helpers (`build.rs`, `setup.py`, `conftest.py`, `tools/*.js`) that are overlaid as source.
- Two full workspace snapshots refuse large `node_modules` (5 s deadline, 50,000 entries).
- Evaluator commands have no memory, pid or disk limits; parsers have no timeout (65 MB `.ts` blocked 62.9 s); a command path that resolves outside the workspace through a symlink or `..`.
- `typecheck_clean`: coded diagnostics only (document or make the recogniser task-supplied); line-shift false failures; identical recognised config errors (TS5057) pass; `--pretty` output.
- `node --check` accepts an ESM-syntax `.js` file that contains a syntax error.
- `diff_boundary` counts evaluator-staged hidden tests as agent changes for non-hardened tasks with `hidden.dir` (run evaluators before staging, or snapshot separately).
- Candidate edits to build configuration are silently ignored: report them.
- Dangling-symlink overlay fails closed with `EEXIST`; pinned workspace under `os.tmpdir()`; `spec.candidate.cwd` overridden; README stale.
- `toolCallSyntax` does not count legacy text-mode calls.

### WP-1303 Provider handling (WP-1107)
- `serverKindCache`: add a TTL, invalidate on endpoint, provider and account switch, key by more than the endpoint string. Fix the gateway-on-404 case that sends `X-Task-Class` to a replaced non-gateway server (REQ-PRV-109 must hold for every path, not only the success path).
- Normalise nullable optional arguments once, at parse, for repaired and text-mode calls too; keep an explicit `null` where the schema allows null; remove the duplicate layer.
- A retained vLLM kind keeps `advertised.via` so request counting does not turn off; transient `/version` and Ollama `/api/version` failures must not downgrade a known kind.
- Matrix provenance: bind the archive to the verified checkout content, not only to the commit id.
- Decide the GBNF compiler: wire it to a consumer (llama.cpp `grammar`, vLLM `guided_json`, Ollama `format`) or remove the dead code. Hybrid reasoning grammars from the v1.1.0 roadmap are still unimplemented.
- **Measure G1.1-4** (at least 99.5% valid tool-call JSON across supported provider endpoints) against live endpoints; this needs the shared `GATEWAY` claim. Until measured it stays "not met".
- Test gaps: 404 and thrown-exception kind retention, `agent_observer` isolation of the two normaliser layers, required-null rejection.

### WP-1304 Evaluation CLI, tracing and redaction hygiene
- `--isolated-home` is honoured only when `eval` is `argv[0]`; parse after options or reject the flag when it is not applied (currently silently uses the real HOME).
- `core-v1/tasks/*` duplicates `eval/tasks/*`, and the evaluator runtime file list exists in two places that already differ.
- OTLP scope version is hard-coded `1.1.0`; use `getBuildIdentity().version`.
- Sidecar text is redacted per field and again per event (paths corrupted, special case for `session.state`); choose one layer. Four identical diagnostic helpers (`formatCliDiagnostic`, `formatReplDiagnostic`, `formatProviderDiagnostic`, `formatUpgradeDiagnostic`) and `formatSafeSidecarText`: one shared helper next to `redactDiagnosticForOutput`; the REPL step error path skips redaction.
- Secret-shaped directory names still appear verbatim in `workspace` and `workspace_name` (known nit).

### WP-1305 Release hygiene
- Make the CI fixture variables part of the documented local `make test` invocation (or a `make test-ci` target) so a local gate runs through; make `make test` run the terminal-scope and security steps even when the CLI suite fails, or document the abort.
- Keep the findings ledger in `docs/v1.1.3/FINDINGS.md`, updated per closed item with the commit.

## 3. Worktrunk integration

### 3.1 What Worktrunk is (survey, 2026-11-04)
A Rust CLI `wt` (v0.81.0, pre-1.0, MIT OR Apache-2.0, about 12 releases in 83 days with breaking changes in each). Branch-addressed `switch/list/remove/merge`, a configurable path template (default sibling `repo.branch`), `copy-ignored` build-cache sharing with `.worktreeinclude`, hooks (`pre-start/post-start/pre-merge/...`), per-branch variables, aliases, PR checkout, CI status, LLM commit messages, a picker, and Claude Code and Codex plugins. It shells out to `git`. Its library crate is declared unstable.

### 3.2 Decision: native subset first, optional pass-through second
| Option | Verdict |
|---|---|
| A. Adapter only (`wt` on PATH) | Not enough alone: no offline or trust story under Nexus's control, and it only works for users who install `wt`. Kept as phase 2. |
| B. Native subset in TypeScript | **Phase 1.** Built on Nexus's own git handling. No dependency, no packaging change. |
| C. Embed the `worktrunk` crate | **Rejected.** About 100 new crates, MSRV 1.98, unstable API; breaks G1.1-5 and the SBOM. |
| D. Vendor or fork | **Rejected.** Large, fast-moving, and it would tie the release cadence to upstream. |
| E. B plus an optional `wt` pass-through | **Chosen.** Phase 2 adds a read-only adapter that detects `wt` by `--version` output. |

Licence: reimplementing ideas needs no licence. Do not copy code. Credit Worktrunk in the docs, and do not reuse its name for the feature. The Nexus command is `nexus worktree` (alias `nexus wt` only if no collision is detected at install; `wt` collides with Windows Terminal).

### 3.3 Design constraints from the Nexus inventory
1. **A new managed worktree kind.** The existing `isManagedWorktreePath` and `hasValidatedOperationGitPaths` accept only `<gitRoot>/.nexus/worktrees/<taskId>` on `nexus/<taskId>`. User-named worktrees at a path template such as `../repo.feature` need their own state kind and validators. Do not loosen the existing ones.
2. **Anchor on the git common dir.** The repo root must come from `git rev-parse --git-common-dir`, not `--show-toplevel`, so Nexus run inside a linked worktree finds the main checkout and sees all siblings. This also fixes a latent bug in `WorktreeManager`.
3. **Registry.** Named worktrees are recorded in `<git-common-dir>/nexus/worktrees.json` (atomic write, no symlinks, 64 KiB cap), so `list`, `remove` and state recovery do not depend on the path layout.
4. **Safe removal.** `remove` refuses a dirty worktree (including untracked and ignored files) and an unmerged branch unless `--force` / `--delete-unmerged` is given. Do not reuse `WorktreeManager.discardWorktree` (it is `--force` plus `branch -D`).
5. **Git hooks off during creation.** Creating a worktree runs `post-checkout`; use the existing `envWithoutConfiguredHooks` suppression (extend it to cover Git 2.54 correctly) for every Nexus-initiated git call.
6. **Config without a TOML dependency.** Operator config is JSON (`~/.config/nexus/config.json`, version 1, existing validator). Reading Worktrunk's `.config/wt.toml` and `~/.config/worktrunk/config.toml` uses a small strict TOML-subset reader (tables, strings, string arrays; anything else is an error, never guessed). It is read-only interoperability, not a requirement.
7. **Read-only gating in both places.** Every new slash command must be added to `replReadOnlyAllowed` (repl.ts) and `readOnlySlashAllowed` (sidecar.ts) with a test; mutating subcommands are refused in read-only mode.
8. **Docs gates.** Fenced `nexus …` examples are executed by `scripts/doc_commands.mjs`; they must parse. Gate 4 scans only top-level `docs/*.md`.

### 3.4 Work packages
**WP-1310 Core: named worktrees**
- `nexus worktree switch <branch> [-c] [--base B] [--no-copy]`, `list [--json]`, `remove <branch>... [--force] [--delete-unmerged]`, `path <branch>`. Branch shortcuts: `^` default branch, `@` current, `-` previous. Accept a worktree path wherever a branch is accepted.
- Path template: default `{{ repo_path }}/../{{ repo }}.{{ branch | sanitize }}`; variables `repo_path`, `repo`, `owner`, `branch`; filters `sanitize`, `hash_port`, `codename`; implemented by a small expression evaluator (no template dependency). A rendered path outside the repository's parent directory, or into an existing non-worktree directory, is refused unless the operator config allows it.
- `list` from one `git status --porcelain=v2 -z` call per worktree plus `rev-list --left-right --count`: dirty, ahead and behind the default branch, integrated (same commit, ancestor, empty three-dot diff, equal tree, patch-id), age, agent marker. JSON schema versioned from day one.
- Slash commands `/worktree switch|list|remove` (the existing `/worktree status|merge|discard` keep working), CLI subcommand, sidecar catalogue entry, completion in the TUI, read-only rules, redaction of branch names and paths.
- `nexus run --worktree` keeps its behaviour. A new `--worktree-branch <name>` creates a named worktree for the task instead of `nexus/<taskId>` (opt-in, same sandbox requirement).

**WP-1311 Shared build caches**
- `nexus worktree copy-ignored [--from B] [--to B] [--force] [--dry-run]` and the automatic step in `switch -c`. Source set: files that are both gitignored and listed in `.worktreeinclude`. Default is include-only; the "copy every ignored file" mode needs `--all-ignored` because it can copy `.env` secrets into every worktree.
- Implementation: `fs.cp` with `COPYFILE_FICLONE` where supported, `cp --reflink=auto` fallback, plain copy elsewhere; preserve mtimes (so cargo does not rebuild a copied `target/`); skip existing files unless `--force`; exclude `.git`, `.nexus`, `.entire`, nested worktrees; refuse symlinks that leave the tree; cap on count and bytes with a clear error.
- Never copy Python virtualenvs (absolute paths); say so.

**WP-1312 Merge and clean**
- `nexus worktree merge [target] [--no-squash] [--no-rebase] [--no-remove]`: commit (optionally LLM-generated through Nexus's configured provider, never an external command by default), squash, rebase onto target, fast-forward only, then remove the worktree and branch. Back up swept-in working-tree changes to `refs/nexus-backup/<branch>` before squashing. Rebase conflicts stay open in the worktree with a clear message. Uses the existing validation receipt gate (CAND-001..004) when a verifier is configured.
- `nexus worktree prune [--dry-run] [--min-age 1d]`: remove worktrees whose branch is integrated, with the minimum-age guard.

**WP-1313 Hooks under Nexus's trust model**
- Supported events first: `post-start` (after create) and `pre-merge` (blocking). Others later.
- Sources: operator config (trusted) and project `.config/wt.toml`/`.nexus/worktree.json` (untrusted). Project hooks run only after an approval recorded outside the repository (`~/.config/nexus/worktree_approvals.json`) keyed by repository identity, hook name and a hash of the exact command template. Any change re-prompts. No TTY or no approval: skip and say so; never run silently. Never executed with `--yes`-style bypass in unattended or read-only mode.
- Execution goes through the existing `run_command` bridge so the sandbox and approval policy apply, with the same digest-and-script approval display as `/test`. Output is redacted and bounded.
- A branch checkout cannot introduce an unreviewed command: the approval key includes the template hash, and project config is read from the primary checkout, not from the worktree being created.

**WP-1314 Per-branch state and agent markers**
- `nexus worktree vars get|set|clear` stored in the registry (not git config). Hook templates can read `vars`.
- Activity marker (idle/working/waiting) written by the sidecar for the worktree its session runs in, shown in `list`.

**WP-1315 Optional `wt` pass-through (phase 2)**
- Detect `wt` by running `wt --version` and checking the product string; minimum version pin; never bundle it.
- `/wt <args>` forwards to the user's `wt` (read-only subcommands allowed in read-only mode: `list`, `config show`), and `nexus worktree list --source wt` merges `wt list --format=json` after validating it against a recorded schema fixture. A schema mismatch degrades to a warning, never to a guess.
- `wt` aliases and the picker are reachable only through this pass-through.

### 3.5 Measured on this host (2026-11-04, `wt` 0.81.0 installed at `~/.cargo/bin/wt`)
- `wt list --format=json` (schema 2) works against this repository: top-level `schema`, `repo`, `collected`, `items[]` with `branch`, `head`, `worktree{path,main,current,previous,detached,branch_mismatch,duplicate_branch,changes}`, `upstream{remote,branch,ahead,behind}` and `display{state,symbols,statusline}` (ANSI-coloured). The recorded output is the fixture for the phase 2 adapter contract test (`wt-list-0.81.0.json`, 1.2 MB, 874 items).
- **Scale matters.** This repository has 874 registered worktrees (397 of them detached) holding about 205 GB under `~/nexus-wt`, and `wt list --format=json` returned 874 items (1.2 MB) and took longer than 30 s on its first run. Native `list` must stay fast and bounded (one status call per worktree, a per-entry timeout, pagination or a `--limit`), and the adapter must have a timeout and a size cap and degrade to the native list. `prune` is not a nice-to-have: most of those worktrees are finished review and gate worktrees.
- No user config exists (`~/.config/worktrunk/config.toml` absent) and the project has no `.config/wt.toml`, so interoperability with `wt` config files is optional; the native config comes first.
- Add to acceptance: a live smoke test that runs only when `wt` is on PATH and reports `wt 0.81.0` or newer, and a contract test against the recorded fixture otherwise.

**Deferred beyond v1.1.3:** the skim-style picker, CI status columns (forge CLIs), PR checkout (`pr:N`, needs `gh`; reconsider after WP-1310), `relocate/promote/tether`, a shell `cd` wrapper (the harness changes its own directory), exposing worktree tools to the model.

## 4. Sequencing

1. **Week 0 (day 1):** branch `v1/v113-plan` from `main`, this plan and the findings ledger committed; claims taken per work package.
2. **Findings first, in parallel with the Worktrunk core:** WP-1301 and WP-1303 (they touch `agent.ts`, `client.ts`, `slash/*`), WP-1302 (`eval/` only, owner of the claim must be explicit), WP-1304, WP-1305. Worktrunk WP-1310 starts with the git-common-dir anchor and the registry because WP-1311 to WP-1314 depend on them.
3. WP-1311 and WP-1312 after WP-1310. WP-1313 after WP-1312 (merge needs `pre-merge`). WP-1314 and WP-1315 last.
4. Each work package: red test, fix, focused tests (SUITE claim for any run), independent reviewer on the diff with the findings text in the brief, then the exact-head gate on the integration branch. Release candidate only after every finding in `FINDINGS.md` is FIXED, WITHDRAWN or DEFERRED with an owner decision.

## 5. Acceptance (v1.1.3)
- `FINDINGS.md`: 0 open findings; every FIXED row names its commit and test; every DEFERRED row names the owner decision.
- Entire trail for the release PR: 0 unresolved high findings.
- `make test` exits 0 on the exact head with the CI fixtures set (CLI, Rust, terminal scope, security) without separate reruns.
- `nexus worktree` commands pass an end-to-end test against a real temporary repository (create, copy-ignored, list, merge, prune, remove), including: a dirty worktree refuses removal, a path template that escapes is refused, a project hook without approval does not run, a hook template change re-prompts, Git hooks do not run during creation, read-only mode refuses every mutating subcommand.
- G1.1-4 measured or still explicitly "not met".
- No new runtime dependency, no SBOM component change, `cargo deny` and `npm audit` clean.

## 6. Open decisions for the owner
1. **Named worktree location.** Default sibling layout `../repo.branch` (Worktrunk-compatible, outside the repository) versus staying under `.nexus/worktrees/` (safer for confinement, not compatible with existing Worktrunk worktrees). Recommended: sibling layout, opt-in through a one-time operator config line, with `.nexus/worktrees/` as the default until set.
2. **Project hooks.** Run project-declared hooks after a recorded approval (recommended) versus operator-config hooks only in v1.1.3.
3. **`eval/` ownership.** WP-1302 is entirely under `eval/`, which agents are told not to touch. Name who edits it (codex-root, or explicit permission for this agent) before work starts.
4. **G1.1-4 measurement** needs the shared `GATEWAY` claim; say who schedules it.
