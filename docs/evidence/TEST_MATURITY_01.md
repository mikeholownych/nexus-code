# TEST_MATURITY_01 — testing-suite maturity evidence

Slice `TEST_MATURITY_01`, branch `v1/test-maturity-01`, based on `origin/main` at `f3dc49dc`.
No commit, push, PR, tag or merge has been made for this slice. All numbers below are measured locally
unless the source column says otherwise; CI is still the arbiter.

## Tier model

| Tier | When | Gate |
| ---- | ---- | ---- |
| T0 | inner loop | `npm --prefix cli run test:unit`, `make lint`, `tsc` — seconds, no network |
| T1 | PR required | existing `test-matrix (22)`, `test-matrix (24)`, `linux-x86_64` checks plus the new static-gate step |
| T2 | post-merge / nightly | advisory diff coverage from the T0 tier; weekly flake budget; real-provider and real-LSP workflows remain advisory |
| T3 | release qualification | unchanged: real-capability evidence must be measured on the candidate RC before any stable tag |

T0 is a smoke tier, not a completeness claim. `npm test` remains the PR-required suite.

## Reference coding

XERJ was installed in this environment (`xerj v1.0.0-rc.104`, checksum verified, user service on
`http://localhost:9200`). The hub catalogue had no opencode/OpenHands test-harness pack, so the two peer
checkouts were indexed locally under prefix `tmrefs` (12 files, 133 records, 1.1 s). Retrieval is lexical;
queries used identifiers and exact words from the peer sources.

| Citation | What it says | Licence |
| -------- | ------------ | ------- |
| `opencode_QUARANTINE.md:7` (local copy of `~/opencode/packages/app/e2e/QUARANTINE.md`) | Tag known-red tests `@quarantine`, skip them in gate runs, fix or delete within 14 days, record failure signature / first red / owner | MIT |
| `opencode_check-test.yml:19` (`~/opencode/.github/workflows/check-test.yml`) | Whole spec files sharded by test count; release gate runs Linux legs only; quarantined legs report without failing | MIT |
| `opencode_wire-fixture.ts:585,660` (`~/opencode/packages/cli/test/acp/wire-fixture.ts`) | Reusable wire fixture exposing encode/emit for protocol conformance tests | MIT |
| `openhands_stryker-diff.mjs:58` (`~/OpenHands/scripts/stryker-diff.mjs`) | Mutate only production TypeScript changed against a base ref via `git diff --name-only`, then `--incremental` | MIT |
| `openhands_stryker.config.mjs:1` (`~/OpenHands/stryker.config.mjs`) | Exclude tests, fixtures, generated and mock files from mutation | MIT |

- **Took:** diff-scoped analysis from `stryker-diff.mjs` (only changed production source is counted), applied
  to coverage rather than mutation; the wire-fixture idea of one shared corpus checked by both language
  sides, applied to the sidecar NDJSON protocol; advisory artifacts for a flaky-test report.
- **Borrowed:** the quarantine table shape (failure signature, first red, owner) as the intended format for
  a future Nexus quarantine list; the "release gate uses a narrower stable leg set" principle, already
  present in Nexus's required checks and left unchanged.
- **Rejected:** Playwright's test-*count* sharding — Nexus has 435 CLI test files with very different
  runtimes, so the sharder now prefers measured duration with a size fallback. Stryker itself — a new
  dependency and a long CI leg with no measured benefit yet; diff coverage and targeted tests are cheaper.
  `continue-on-error` on PR gate legs — flake reporting stays advisory and the required checks stay strict.

Field report: drafted with `xerj feedback --dry-run`, then submitted; GitHub was unavailable (no git
identity), so the API path returned `HTTP 200` and `stored: true` on 2026-11-21.

## Implemented in this slice

- `cli/scripts/test_shards.mjs`: duration-aware best-fit sharding; `cli/scripts/test_durations.json` is the
  checked-in manifest, `NEXUS_TEST_DURATIONS` overrides it, and a missing/malformed manifest falls back to
  source size. Pinned evaluator-mount tests still share shard 1.
- `cli/scripts/run_tests_driver.mjs` → `cli/scripts/run_tests.mjs`: per-file wall time reported on fd 3 and
  written to `NEXUS_TEST_DURATIONS_OUT`. The throwaway `HOME` and 300 s per-file watchdog are unchanged.
- `cli/scripts/test_tiers.mjs` + `npm run test:unit`: curated T0 unit tier (11 files, `--list` for reporting).
- `cli/scripts/run_coverage.mjs` + `cli/scripts/diff_coverage.mjs`: Node's built-in lcov coverage and a
  changed-lines gate; lines without a DA record are not coverable. `make lint` adds typecheck, clippy
  (`-D warnings`) and a **changed-Rust-file-only** rustfmt check (the core has legacy whole-tree drift).
- `cli/test/fixtures/protocol_v1_golden.jsonl` with tests on both sides: TS checks its event encoder and
  command parser; Rust checks `parse_event` and `encode_command` against the same bytes.
- `.github/workflows/ci.yml`: `make lint` in the two required test jobs; a new **advisory** `diff-coverage`
  job that uploads lcov and a JSON report. Required check names and the 45-minute CLI timeout are unchanged.

## Metrics ledger

| ID | Metric | Baseline | Current (this slice) | Status |
| -- | ------ | -------- | -------------------- | ------ |
| PC-1 | median PR CI duration | 27:12, range 23:02–55:20 (20 runs) | not remeasured; duration capture added but no CI report yet | open |
| PC-2 | PR CI success rate | 12/20 (60%) | not remeasured | open |
| PC-3 | intermittent tests | `vc9_subagent_needs_input` (1 of 20 runs) | weekly flake budget unchanged; no quarantine list yet. New local observation: `a denial is asked again next time, never silently allowed` (`cli/test/approval_policy.test.ts:127`) failed once in two T0 runs on 2026-11-21 and passed in isolation — below the quarantine threshold | open |
| MQ-4 | gateway conformance | deep 198/200 (99.0%), lead-reasoning 155/200 (77.5%) vs 99.5% | no RC measurement; **unqualified** | open |
| T0-1 | inner-loop unit tier | no tiered script | 11 files, 94 tests, ~5.25 s; first run 0 failures, second run 1 flaky failure (see PC-3) | measured locally |
| T0-2 | static gates in inner loop | none | `make lint` = 0 (typecheck + clippy + changed-file rustfmt) | measured locally |
| T0-3 | Rust suite | not recorded before this slice | `cargo test --locked`: 458 tests across six binaries, 0 failures (396 in `nexus-tui`, including the new golden corpus test); `tsc` build = 0 | measured locally |
| T1-1 | duration-based sharding | file size only | measured duration preferred; 2 new sharder tests pass | measured locally |
| T1-2 | protocol golden corpus | mirrored types, no shared bytes | 8 records; TS 3/3 and Rust 1/1 tests pass | measured locally |
| T2-1 | diff coverage | none | advisory CI job added; threshold held at 0 until measured | wired, not calibrated |
| T3-1 | real-capability release evidence | absent | unchanged; no stable-tag claim made | open |

Scale reference (unchanged): nexus ~264k source LOC / 435 test files; opencode ~1.47M / 1,927;
OpenHands Agent Canvas ~492k / 977. `~/OpenHands` is the Agent Canvas UI repo, not the old Python monorepo.

## Deferred, in priority order

1. Seed `cli/scripts/test_durations.json` from a full CI run and publish PC-1/PC-2 from CI data.
2. Fuzz/property tests for `patch_file` (`core/src/file_ops.rs`) and capped `search_code` (`core/src/search.rs`)
   — the two GA-44/GA-45 defects; no property-test dependency has been chosen yet.
3. Security negative tests for flight-log sanitization/tamper evidence, and a quarantine list with a strict
   14-day expiry (the XERJ-borrowed table shape).
4. Real-capability T3 gates for provider breadth, gateway conformance and LSP, measured on an RC.
5. Raise the diff-coverage threshold from measured data rather than a guessed number.

## Reproduce

```sh
# Requires node 22+, the pinned rust toolchain, and a built core release binary for security.test.ts.
npm --prefix cli ci
npm --prefix cli run test:unit
npm --prefix cli run typecheck
make lint
CARGO_TARGET_DIR=<isolated> cargo test --locked --manifest-path core/Cargo.toml
node cli/scripts/run_coverage.mjs --tier=unit --out cli/coverage/unit-lcov.info
node cli/scripts/diff_coverage.mjs --lcov cli/coverage/unit-lcov.info --base HEAD~1 --include-worktree
```

Every Node test run above used a throwaway `HOME`; the XERJ corpus lives outside the worktree.
