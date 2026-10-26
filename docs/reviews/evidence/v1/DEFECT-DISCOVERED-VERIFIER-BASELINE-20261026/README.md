# Discovered verifier pre-mutation regression

## Scope

This slice captures the discovered verifier's definition, test set, and declared deliverables before the first workspace-mutating tool. The regression covers a shell command that writes the fix and a subagent that edits the fix.

## Source and snapshot identity

- Base source commit: `bbafae868939084ccd49f21621695dff6b05f752`
- Branch: `v1/defect-discovered-verifier-baseline`
- Immutable test snapshot: `/var/tmp/nexus-discovered-verifier-snapshot.PqKAFh`
- Tracked source patch SHA-256: `46e6d370787d72eb2c6d350c89abe78bd6575ac9332a087c3591f87fd188e4d6`
- `cli/src/agent.ts` SHA-256: `c7515330a2e8b5ce7495d9cd5a3800e4d200c3d1a362c9fcece556701a51c14b`
- `cli/test/agent_discovered_verifier_premutation.test.ts` SHA-256: `38ebe2bab3ffa8e38a51833c084400337d9c399894de82069b1e3035bd2d6b32`
- Snapshot `cli/package-lock.json` SHA-256: `ed2179886e386e7ff9101dd86d3acff23c70523543a673bfeb83991ffaf0812f`

## Environment

- Node.js `v24.11.1`, npm `11.19.0`
- Rust/Cargo `1.95.0`
- `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` were isolated for install, build, and test commands.
- The snapshot used its own `core/target` directory.

## Validation

- `npm ci --prefix <snapshot>/cli`: completed; npm reported 0 vulnerabilities.
- `cargo build --manifest-path <snapshot>/core/Cargo.toml`: PASS.
- `<snapshot>/core/target/debug/harness-core --version`: PASS, reported `harness-core 1.0.0-rc.8`.
- `npm --prefix <snapshot>/cli run build`: PASS.
- `node scripts/run_tests.mjs test/independent_verification.test.ts test/agent_discovered_verifier_premutation.test.ts`: PASS, 35 tests, 0 failures, 0 skipped. Full output is in `focused-run.log`.
- `git diff --check`: PASS; added test file has no trailing whitespace.

The first isolated attempt was incomplete because the Rust core had not yet been built. The final passing run above includes the built core and was executed under the shared `SUITE` claim. Earlier fixture iterations were corrected: the fixture now declares `./math.js` as its package entry, clears inherited `NODE_TEST_CONTEXT` for its nested Node test command, and explicitly declares `math.js` as the deliverable.
