# Test evidence bound to snapshot `8cf3e82` (branch `v1/gov-dec-amendments`)

| | |
|---|---|
| Date | 2026-10-17 (runs 18:56–19:24Z; record 20:2xZ) |
| Snapshot | detached worktree `/tmp/opencode/gov-suite/snapshot` at `8cf3e820668adb8644a82c5405f8560e96ae39c3` (`git -C worktree worktree add --detach`); `cli/node_modules` symlinked from `/home/mike/nexus-wt/p10g-oracle/cli/node_modules`; per-run `HOME=$(mktemp -d)` + `XDG_CONFIG_HOME` isolated; `CARGO_HOME`/`RUSTUP_HOME` pointed at the existing toolchain |
| Claim protocol | `SUITE` taken atomically (`mkdir`), **ownership recheck before every phase** (owner.json agent+pid must match the watcher's own), released **only if still owned** at exit (claim log 18:56:33Z CLAIM → 19:24:21Z RELEASE; codex re-took at 19:24:39Z — no overlap) |
| PR-head delta | `git diff 8cf3e82..168d574 -- cli/ core/ eval/ scripts/ Makefile` is **empty** — the PR head `168d574` differs only in `docs/`; CI on the PR head therefore exercises identical product code to this snapshot |

## Result 1 — focused tokenizer test: PASS (behavioural evidence for the changed tests)

`node scripts/run_tests.mjs test/tokens.test.ts` → **exit 0**, **3/3 pass** (`focused.log`):

- ACC-VER-07 (floor-bound corpora excepted per DEC-17) ✔ 13.9ms
- REQ-AGT-118 conservative script/symbol rules ✔ 2.9ms
- REQ-AGT-118 `/tokenize` llama.cpp root + vLLM count ✔ 162.7ms

## Result 2 — full suite, first attempt: exit 2 — **INVALID run, qualifies nothing about product behaviour**

`make test` → 1103 tests / 1071 pass / **30 fail** / 0 cancelled (`full.log`). Cause: the snapshot had **no built artifacts** — `make test` does not build (Makefile `test:` = `cargo test` + `npm --prefix cli test` + security gates; PLAN-08's record requires `make build` first). The 30 failures are built-artifact consumers: `build_identity` ("the build writes the commit…"), harness entry/T4 smokes and SPEC-06 package requirements (they execute the built CLI), TUI e2e ("missing `core/target/release/nexus-tui` (run make build)"), engine entry-point sharing. The remaining `✖` lines in the log (ECONNREFUSED:1234, HTTP 429, "Working: …"/"Tool Error:") are harness-internal interaction logs, not test failures.

**Disposition:** rerun queued (watcher v3): `make build` → `make test` on the same snapshot, same claim protocol. This attempt is preserved as evidence of the invalid-run condition only.

## Status of REQ-AGT-118 acceptance evidence

- Changed tests: **executed and passing** (Result 1, this snapshot).
- Full-suite green: **pending** (Result 2 rerun) and/or CI `test-matrix` green on the PR head (product code identical, verified above).
- Independent review of DEC-17: done (approve-with-issues; all findings addressed on-branch).
- Ledger row REQ-AGT-118 therefore stays **`partial`** until Result 2 rerun and/or CI is recorded green; it will then move to `tested` citing this snapshot + the PR-head CI run.

## Binding rule

These results qualify **snapshot `8cf3e82` only**. `168d574` and later docs-only commits are covered by the empty product-code delta above plus CI; any future change to `cli/`, `core/`, `eval/`, `scripts/`, or the Makefile invalidates the binding and requires fresh runs on the new revision.

## Result 3 — full suite, built run (v4, `/tmp` snapshot): exit 2 — 1098/1103, 5 failures attributed to the sandbox-mount environment

`make build` **exit 0** (2m18s; `build-info.json`: commit `8cf3e820668a`, commitTime `2026-10-17T18:38:11+00:00`, `dirty:false`, branch null — detached worktree) → `make test` exit 2: **1103 tests / 1098 pass / 5 fail / 0 cancelled** (`full2.log`). The 5 failures all throw from `eval/isolate.mjs:149` (`mountProblem` in the bubblewrap sandbox setup): A1 deliverable verification, standalone server-profile discovery, both T4 smokes, task-path traversal. The identical suite passes **1149/1149** (plus Rust 281/281, evaluator rerun 21/21) on this machine from codex's `/home/mike/nexus-wt/p10g-oracle` worktree (claim-log release line 20:38:32Z). Working hypothesis: the harness sandbox's runtime-mount check rejects snapshots located under `/tmp/opencode`; product code is not implicated (my diff touches `cli/src/tokens.ts` comments + `cli/test/tokens*` only).

**Attribution run queued (v5):** `make build` + `make test` on the same commit in a `/home/mike/nexus-wt/gov-8cf3e82` snapshot, same claim protocol. A green v5 is the valid full-suite result for this revision; if v5 reproduces the 5 failures, they are real on this revision and belong to the PLAN-10/eval owners (boundary request).

## Protocol incident (diagnostic, resolved)

Watcher v3 aborted fail-closed immediately after taking the claim (20:38:51Z) and left its own dead-pid claim in place: its `owns_claim` pid pattern was corrupted by a quoted heredoc (`\$` escaped the dollar → the pattern never matched). The stale claim was logged and released by the owner-of-record at 20:51:47Z; v4/v5 use a `printf`-built fixed-string pattern. codex's 20:44:48Z "REQUEST SUITE release … codex will wait" was honoured. No suites overlapped at any point.

## Corpus progress (custodian-verified)

Batches 1–4: **16/40 tasks**; **16/16 manifest hash pairs re-derive exactly**; `check_schema.mjs` OK × 16; perfectly balanced 4×4 languages × classes; all external repos at pinned commits. Live `bin/validate.py` runs deferred to a bounded window after the attribution run. Coordination comments posted on PRs #10 and #9 (ACCEPTANCE/READINESS edits + continuity M1/M3/N1–N3 bundling).
