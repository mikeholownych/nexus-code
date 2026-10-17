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
