# PLAN-08 PR-8a validation record

- Requirement: REQ-PER-103; acceptance: ACC-PER-03.
- Source revision: `3b8a11036f50cedd8899af8a185f080d4fe094ec` (`v1/plan-08-pr-8a`).
- Product build: source CLI built from this revision by `make build`; Rust test target built by `cargo test`.
- Runtime: Ubuntu Linux x86-64, Node `v24.11.1`, npm `11.19.0`, Rust/Cargo `1.95.0`.
- Launcher: `make test` → Cargo core/TUI tests, `npm --prefix cli test` → `cli/scripts/run_tests.mjs`, then `scripts/security_gates.sh`.
- HOME/XDG: a fresh temporary HOME was supplied for each build/test command; `CARGO_HOME` and `RUSTUP_HOME` pointed to the existing toolchain installations. The CLI runner created a second per-suite temporary HOME and exposed only the outer temporary HOME as `NEXUS_TEST_REAL_HOME`.
- Setup: `npm ci --prefix cli`, then `make build`.
- Validation: `make test` passed: core 24/24, TUI 240/240, CLI 906/906, and all security lifecycle gates. The first test attempt preceded dependency installation and the required build, so the real-sidecar integration failed; after running the repository's CI setup sequence, the complete suite passed.
- Built artifact SHA-256: `cli/dist/index.js` `e229ce7c811cab75e6fd651ad2064d76a591c64992d150b966a071f59c8a796a`; `cli/dist/sidecar.js` `b48d44bbdcbf7f68aaa88c854cd1c1ceab11bfede3db43ac3821888a6d5b0f9d`; `harness-core` `cbea89b952c923a2f41529a7b13374a6e60b60c151b9ed9e4aaaead33101112f`; `nexus-tui` `5183f3ed8606655b07bed2f601f9ec8ca8fe7caef5d08d86b823ee0623fceb84`.
- Diff review: `git diff --check` passed; the isolated branch had no source changes during validation. Generated build outputs remained ignored/untracked.
- Evidence limits: automated HOME isolation and real-sidecar tests only. No human terminal interaction or release qualification is claimed.
