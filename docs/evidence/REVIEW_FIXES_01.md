# REVIEW_FIXES_01 — independent-review fixes on `release/v1.3.0`

## Scope

One PR on `v1/review-fixes-01`, started at `origin/release/v1.3.0` head `028a0826` and merged the
release head `b253ee3d` into the slice before pushing. All confirmed findings from the independent
review are fixed here. No merge, tag or publish is part of this slice.

The one finding rejected by direct verification needs no change: the copy-on-write fallback still uses
chunked `readSync`/`writeSync` with per-chunk `onBytesCopied` callbacks
(`cli/src/upgrade_journal.ts:374-389`), so it preserves incremental backup progress. The fallback test
asserts that behavior.

## Changes

| Finding | Fix |
| ------- | --- |
| rustfmt gate can be a no-op in a shallow PR checkout | `scripts/check_fmt.sh` no longer falls back to `HEAD~1`; it fails closed when no base resolves. CI fetches full history and passes the PR base SHA as `NEXUS_FMT_BASE`. |
| `npm run test:coverage` default `--out` resolves to `process.argv[0]` | Shared `cli/scripts/script_args.mjs` rejects a missing value and resolves the lcov path against the CLI root; `NEXUS_COVERAGE_OUT` still works. |
| `diff_coverage.mjs` derives the repo root from `new URL(...).pathname` | Uses `fileURLToPath`; lcov and `--json` paths resolve against the repository root. |
| `docs/releases/v1.2.2.md` says an evidence file may not exist | Replaced with the accurate archive-scoped statement: the recorded evidence is RC/published-v1.2.1 specific, and no stable-v1.2.2 conformance measurement is included. |
| Nested `backups/` directories | The exclusion already propagates recursively in `copyPrivateTree`; the test now covers `.nexus/tasks/context-checkpoints/<op>/backups` explicitly. |
| Malformed/under-reported/oversized `Content-Length` | Strict decimal parsing; malformed and oversized headers fail before the destination is opened. A body that overruns a declared length drops the total from progress instead of reporting 100%. |
| Progress tests did not exercise the real wiring | `performUpgrade` is now asserted through a real local release server in `upgrade_acceptance.test.ts`; new tests cover throwing consumers, malformed/oversized parsing and an under-reported header. |
| `++` added lines skipped by the diff parser | File headers are only skipped before the first hunk, so an added source line beginning with `++` is counted. |
| `test_shards.mjs` fails from the repository root | Byte accounting resolves files against the CLI root. |
| Evidence/doc drift | Updated TEST_MATURITY_01, INSTALL_BACKUP_01 and DOWNLOAD_PROGRESS_01 to match the code and measurements. |
| Standalone config backup counted but not manifested | `config.env` is recorded as a config manifest entry; entries now match counted files. |
| Stale quickstart prerelease pin | The examples now describe the published `v1.2.2` stable tag. |
| Protocol golden `hello` omitted required `commands` | The shared corpus carries a typed slash-command catalogue, with a test asserting its shape on both sides. The newer protocol-schema test's "known gap" exception for `hello` was removed because that gap is now closed. |
| Duration metrics imply full-process timing | Documented that timing starts at the first top-level `node:test` event and excludes startup/module load. |

## Verification

Measured on this worktree with a throwaway `HOME`:

- `npm --prefix cli run build`: pass (TypeScript build).
- Affected test files on Node 22: 43 tests, 43 pass, 0 fail, 0 skipped.
- Same affected test files on Node 24 (via `npx node@24`): 43 tests, 43 pass, 0 fail, 0 skipped.
- `cargo test --locked --manifest-path core/Cargo.toml golden_protocol_v1_corpus`: 1 pass.
- `node cli/scripts/test_shards.mjs test/diff_coverage.test.ts` from the repository root: pass.
- `run_coverage.mjs --tier=unit --out <absolute path>` from the repository root: lcov written.
- `NEXUS_COVERAGE_OUT=<absolute path> run_coverage.mjs --tier=unit` from the repository root: lcov written.
- `diff_coverage.mjs --lcov <absolute path> --base b253ee3d --include-worktree --json <absolute path>`:
  report written; the advisory percent is `null` because the unit tier does not include the changed
  upgrade tests.
- `bash scripts/check_fmt.sh` with `NEXUS_FMT_BASE=b253ee3d`: no changed Rust files, exit 0.
- `.github/workflows/ci.yml` parses as YAML. The full required CI run is still pending.

## Reference coding

XERJ v1.0.0-rc.104 was installed and the node was active. This project's sources were indexed under
`nexusreviewproj` (22,086 docs; `eval/`, build output and `cli/.env` excluded) and shallow clones were
indexed under `nxpeer-vitest` (10,857 docs), `nxpeer-rustup` (3,323) and `nxpeer-istanbul` (1,011).
Identifier-rich lexical searches (`lcovonly`, `shardIndex`, `content_length`) gave citable passages;
natural-language queries were weak.

- **Took / adapted:** istanbuljs `packages/istanbul-lib-report/lib/file-writer.js:171` resolves paths
  from an explicit base directory, not the process cwd. Both lcov scripts now do the same.
- **Took / adapted:** rustup `src/download/tests.rs:333` declares a length and then truncates a body;
  that shaped the under-reported-header test. rustup
  `src/cli/self_update/stage.rs:168` refuses an atomicity-weakening fallback, which shaped fail-closed
  `Content-Length` parsing and base resolution.
- **Took / adapted:** Vitest `docs/guide/improving-performance.md:226` shards whole test files with a
  validated index/count. Nexus keeps its 1-or-2 shard validation and fixes path resolution.
- **Rejected:** rustup's `indicatif` progress bars and Vitest's blob reporter — dependencies and
  reporting machinery unnecessary for these small fixes.
- No code was copied verbatim. A XERJ field report was submitted through the documented API fallback
  (`HTTP 200`, `stored: true`) after the searches.
