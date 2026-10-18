# Running multiple agents on this plan without collisions

These rules apply to every agent (Claude Code, Codex, Cursor, Nexus itself, or a human) that implements any part of this package at the same time as another. The repository's root `AGENTS.md` points here. The rules come from incidents recorded in `tasks/lessons.md`:

- a concurrent agent overwrote newer evidence;
- full test suites were contaminated by edits made mid-run;
- `pkill -f` killed the agent's own shell;
- HEAD moved during a pause.

They also follow from audit finding PER-03: the test suite writes into the real `~/.nexus`.

## 1. Unit of work: one claimed PR slice per agent

- The unit of concurrent work is **one PR slice** from a plan, for example `PLAN-01/PR-1a`. Every slice lists its tasks and its safe change boundary in its plan.
- An agent works on exactly one claimed slice at a time.
- An agent must not edit files outside its slice's boundary. The exceptions are the ledger rows and the shared files covered by §4. If the work needs a file outside the boundary, the agent stops and records a **boundary request** (§6). It does not edit the file.

## 2. Claiming a slice (atomic and machine-local)

Claims live in the repository's shared git directory. They are visible to every worktree, and they are never committed.

```sh
CLAIMS="$(git rev-parse --git-common-dir)/nexus-claims"
mkdir -p "$CLAIMS"
SLICE="PLAN-01_PR-1a"
if mkdir "$CLAIMS/$SLICE" 2>/dev/null; then          # mkdir is atomic: exactly one agent wins
  printf '{"agent":"%s","branch":"%s","since":"%s","pid":%s}\n' \
    "$AGENT_NAME" "v1/plan-01-pr-1a" "$(date -u +%FT%TZ)" "$$" > "$CLAIMS/$SLICE/owner.json"
else
  echo "claimed by: $(cat "$CLAIMS/$SLICE/owner.json")"; exit 1
fi
```

- **Release** the claim by deleting its directory (`rm -r "$CLAIMS/$SLICE"`) after the slice merges or is abandoned. Write one line about the outcome to `$CLAIMS/../nexus-claims.log`.
- **Hot-file claims** use the same mechanism with the name `FILE_<path with / replaced by _>`, for example `FILE_cli_src_agent.ts`. See §4.
- **Stale claims.** A claim older than 24 h whose PID is gone may be broken, but only by the owner, or by an agent that first records the broken claim in the log.
- If the MCP Agent Mail server is available, its file reservations (`file_reservation_paths`) may be used as well. The git-common-dir claim stays authoritative, because every agent can see it without extra tooling.

## 3. Isolation: worktree, branch, HOME, ports, processes

| Resource | Rule |
|---|---|
| Source | One `git worktree` per claimed slice: `git worktree add ../nexus-wt/<slice> -b v1/<plan>-<slice> origin/main`. Never edit `~/nexus-code` itself. It is the owner's checkout, and `/usr/local/bin/nexus` runs from it. |
| Branch | `v1/plan-NN-pr-Nx`. One branch per slice. Never commit to `main` directly. |
| HOME and state | Until PLAN-08 PR-8a lands, every test, build and probe run sets `HOME=$(mktemp -d)` and `XDG_CONFIG_HOME="$HOME/.config"`. After PR-8a, the test setup enforces this, but scripts and probes outside `npm test` must still set it. **Never** run anything that writes to the real `~/.nexus` or `~/.config/nexus`. |
| Test runs | Full suites run on a **snapshot copy** of the worktree (`git worktree add` at the commit under test, or `git archive`), never on the tree being edited. `tsx` reads `src/` live. |
| Builds | Each worktree builds into its own `core/target`, and `cli/dist` is per worktree. To share the Rust build cache, set `CARGO_TARGET_DIR` per worktree, never to one shared directory. |
| Ports | Mock servers bind `127.0.0.1:0` (an ephemeral port) and publish the chosen port to a file. Fixed ports are forbidden. |
| Processes | Kill only PIDs you started, taken from `$!` or `ps -eo pid,args \| grep -v grep`. **Never `pkill -f` or `killall`.** Long background jobs are stopped through the agent's own task controls. |
| Full test suites | The PTY and provider tests are timing-sensitive. Take the claim `SUITE` before running a full suite (`make test`, or `npm test` over all files). While anyone holds `SUITE`, nobody runs other suites or targeted test files on the same machine. Concurrent load caused a false failure on 2026-10-15: `cloud_providers` saw an extra provider request after a load-induced timeout. Release the claim when the run ends. |
| Inference | There is one inference host (DEC-16). Any run that uses the gateway takes the claim `GATEWAY` first. That includes eval runs, live checks and stripped-proxy runs. One gateway run at a time, which keeps eval timings valid and prevents overload. Small cloud checks (E5) take `CLOUD` to avoid duplicate spend. |
| Credentials | Agents never read or copy `~/.config/nexus/credentials.json`, `config.env` values, or gateway tokens. The stripped proxy reads the token file itself. |

## 4. Hot files: serialise, do not merge blindly

These files are touched by several plans. An agent editing one must hold its `FILE_` claim for the **shortest** period: edit, test, push, merge, then release.

| File | Plans that touch it | Rule |
|---|---|---|
| `cli/src/agent.ts` | 01, 02, 03, 04, 05, 11 | Claim required. Keep each change local to the line ranges the plan names. Rebase immediately before merge and re-run that slice's tests on the rebased snapshot. |
| `cli/src/index.ts` | 01, 03, 04, 06, 08, 10, 11 | Claim required. **PLAN-06 PR-6b (unified launcher) lands first.** Other plans add commands and flags afterwards. |
| `cli/src/tools.ts` | 01, 02, 03, 06, 11 | Claim required. **PLAN-02 PR-2b (signal plumbing) lands before PLAN-03 PR-3c (`safeFetch`)**. |
| `cli/src/sidecar.ts` | 01, 02, 03, 05, 08 | Claim required |
| `cli/src/doctor.ts` | 01, 03, 05, 06, 08 | Claim required. Each plan adds **new check functions** in separate blocks. Only PLAN-06 PR-6d changes existing checks. |
| `cli/src/client.ts` | 03, 05, 08, 11 | Claim required. **PLAN-03 PR-3a (env layering) lands before any PLAN-05 slice.** |
| `cli/src/repl.ts` | 01, 05, 08 | Claim required |
| `cli/src/config.ts`, `security.ts`, `sandbox.ts`, `mcp.ts`, `plugins.ts` | 01, 03 | Claim required. PLAN-01 PR-1e and PLAN-03 must not run at the same time on `sandbox.ts` or `security.ts`. |
| `cli/src/core/capabilities.ts` | 01, 02 | **PLAN-01 PR-1a (effect classes) lands first.** PLAN-02 PR-2c adds schema fields afterwards. |
| `cli/src/tester.ts` | 01, 11 | **PLAN-01 PR-1c lands before PLAN-11 PR-11b/11c.** |
| `cli/src/core/state.ts` | 04, 08 | **PLAN-08 PR-8a (HOME isolation) lands before everything.** |
| `core/src/runner.rs`, `core/src/main.rs` | 01, 02, 06 | Claim required. The protocol version number is owned by PLAN-02 PR-2a. PLAN-06 PR-6c only reads it. |
| `core/src/bin/nexus_tui/{live_state,live_view}.rs` | 01, 02 | Claim required |
| `package.json`, `cli/package.json`, `core/Cargo.toml`, lockfiles | 01, 06, 07, 08 | **Only one agent at a time.** Version fields are written only by `scripts/sync-version.mjs`. Dependency changes are separate commits that touch only the lockfile and manifest. |
| `harness.sh`, `install.sh`, `scripts/package-linux.sh`, `.github/workflows/*` | 05, 06, 07, 09, C1 | Claim required. Workflow edits are separate commits. |
| `cli/dist/**` | all, while tracked | Do not commit `cli/dist` from slices. PLAN-07 PR-7d untracks it (DEC-10). Until that merges, only the merging agent rebuilds and commits dist, in a final separate commit, after rebasing. |
| `docs/USER_MANUAL.md`, `ARCHITECTURE.md`, `CLOUD_PROVIDERS.md`, `quickstart.md` | 05, 09 and doc tasks in every plan | Edit only the sections your slice changes. Hold a short `FILE_` claim. |

### Ledger updates (`docs/v1.0.0/REQUIREMENTS.md`)

A slice changes only the rows for its own requirement IDs: the status, test-reference and evidence cells, in place. It never reorders, adds or removes rows, and never edits another slice's rows. New requirements discovered during work go to §6, not into the ledger. Because rows are independent lines, git merges these edits cleanly. If a conflict appears anyway, resolve it row by row, keeping both changes.

## 5. Commit and merge discipline

1. Before **every** commit, compare `git rev-parse HEAD` with the commit you last made. Then run `git log <yours>..HEAD` on the branch. If anything foreign appears, stop and reconcile. Never commit generated artifacts (evidence, dist, lockfiles) over a branch that moved (lessons 2026-10-13).
2. Commits are scoped to the slice. Do not reformat or clean up files outside the boundary.
3. Merge order follows the precedence rules in §4 and the ROADMAP milestone order. Within a milestone, the slice with fewer hot-file claims merges first.
4. Rebase onto `origin/main` immediately before merging. Re-run the slice's targeted tests, plus `make test`, on a snapshot of the rebased commit. Merge only if both pass.
5. Pushing, tagging, publishing and changing GitHub state (issues, milestones, releases) are **owner-approved actions** (DECISIONS X-list). Agents prepare them and do not perform them.
6. Preserve unrelated user work: the untracked `nexus-continuity-validation/`, the stashes, and any dirty files you did not create. Never stash, reset, clean or check out over them.

## 6. Coordination records

| Record | Where | Purpose |
|---|---|---|
| Claims | `$(git rev-parse --git-common-dir)/nexus-claims/` | Who owns which slice or file right now |
| Claim log | `$(git rev-parse --git-common-dir)/nexus-claims.log` (append-only, one line per event) | Claim, release, broken claim, boundary request |
| Boundary requests and discovered requirements | The PR description, under the heading `Needs from other slices`. Mirrored as one line in the claim log. | So the owning slice's agent can pick it up. Never fixed silently out of scope. |
| Slice evidence | `docs/reviews/evidence/v1/<plan>-<slice>/` (new directory per slice) | No shared evidence files, so agents cannot overwrite each other's evidence |

## 7. Safe parallel lanes

The following groupings can run at the same time with no hot-file contention beyond §4 claims. They are listed by milestone.

| Phase | Parallel lanes |
|---|---|
| M0 | (a) PLAN-08 PR-8a, which must merge first. Then in parallel: (b) PLAN-06 PR-6a, (c) PLAN-09 PR-9a. |
| M1 | (a) PLAN-01 PR-1a → PR-1b → PR-1c (sequential, owns `capabilities.ts`, `agent.ts` dispatch). (b) PLAN-02 PR-2a (Rust only). (c) PLAN-03 PR-3a → PR-3b (config/egress). (d) PLAN-11 PR-11a (`parser.ts`) and PR-11b (`tester.ts`, after PR-1c). Lanes (b), (c) and (d) do not touch `capabilities.ts`. |
| M2 (alongside M1) | (a) PLAN-07 PR-7a/7b/7c (workflows, scripts). (b) PLAN-06 PR-6b after PLAN-01 PR-1b (shares `index.ts` flags). |
| M3 | (a) PLAN-04 (`agent.ts` turn, operation runner). (b) PLAN-05 (`client.ts`, provider modules). (c) PLAN-10 harness (`eval/`, no product files). (d) Held-out task authoring by the agent author, **outside the repository**: no access to Nexus source or the development set (DEC-05). |
| M4 (alongside M3) | PLAN-08 PR-8b..8e. Coordinate with PLAN-04 on `state.ts` through `FILE_` claims. |
| M5 | **Serial on `GATEWAY`.** The eval runner, the stripped-proxy runs and the independent reviewer's live task each take the `GATEWAY` claim. The terminal matrix (E3) and the install matrix (E2) can run in parallel with gateway runs. |

## 8. Independence constraints

- The held-out task author must not see Nexus source, the development tasks or tuning history. It runs in a separate session with only the task schema and external repositories. Its output is sealed by a sha256 manifest committed before RC1.
- The independent reviewer in ACCEPTANCE §8 must not be the agent or session that implemented the slices under review.
- An implementing agent never edits `eval/heldout-manifest.json`, scorer thresholds or ACCEPTANCE §6.4 after the freeze.
