# PLAN-12: CLI and TUI upgrade commands

Implements [SPEC-12](../specs/SPEC-12-cli-and-tui-upgrade.md). Milestone **M2/M6** scope addition authorized by the project owner.

- Requirements: REQ-REL-115.
- Acceptance: ACC-UPG-01 to ACC-UPG-06.

## Safe change boundary

- `cli/src/upgrade.ts` (new upgrade engine: SemVer, release lookup, installer logic, provenance detection)
- `cli/src/index.ts` (register `nexus upgrade` CLI command)
- `cli/src/slash/catalog.ts` (register `/upgrade` command spec in `SLASH_COMMANDS`)
- `cli/src/slash/session_commands.ts` (implement `/upgrade` slash command handler)
- `cli/src/sidecar.ts` (wire host approval request for slash commands)
- `cli/src/repl.ts` (completion and slash command support for `/upgrade`)
- `harness.sh` (pass `upgrade` subcommand to CLI)
- `docs/v1.0.0/REQUIREMENTS.md` (record REQ-REL-115)
- `docs/v1.0.0/ROADMAP.md` (record Workstream 12)
- `docs/v1.0.0/ACCEPTANCE.md` (record ACC-UPG-01..06)
- `docs/USER_MANUAL.md` (document CLI upgrade and /upgrade command)
- `quickstart.md` (document upgrade path)
- `cli/test/upgrade.test.ts` (unit tests for SemVer, release resolution, provenance, and installation)
- `cli/test/upgrade_cli.test.ts` (CLI argument, option, and exit code tests)
- `cli/test/upgrade_tui.test.ts` (TUI slash command and approval interaction tests)

## Tasks

| # | Task | Code locations | Depends on |
|---|---|---|---|
| 1 | SemVer parser and comparator: implement strict SemVer 2.0.0 parsing, precedence comparison, tag normalization (`vX.Y.Z`), and channel classification. | `cli/src/upgrade.ts` | — |
| 2 | Provenance and layout resolver: detect packaged installation (`NEXUS_HOME` / `$PREFIX/lib/nexus/$VERSION` + `$PREFIX/bin/nexus`) vs development checkout (`git` / source tree). Check filesystem write permissions and concurrent locks. | `cli/src/upgrade.ts` | 1 |
| 3 | Release resolver: fetch latest stable release or pinned release tag from GitHub Releases API; parse asset metadata; exclude drafts/prereleases from default selection; handle rate limits, network errors, and missing tags. | `cli/src/upgrade.ts` | 1 |
| 4 | Upgrade engine: download release tarball and `SHA256SUMS`; verify checksum integrity; stage and extract; verify binaries and manifest; execute atomic symlink swap; verify new installation; recover cleanly on errors. | `cli/src/upgrade.ts` | 2, 3 |
| 5 | CLI command: register `nexus upgrade` with options `--check`, `--version <v>`, `--yes`, `--allow-downgrade`, `--force`, `--json`, and `--timeout <ms>`. Implement exit codes (0: success/current, 1: update available/declined, 2: error). | `cli/src/index.ts`, `harness.sh` | 4 |
| 6 | Slash command: register `/upgrade` in slash catalog; implement handler in `session_commands.ts`; integrate deliberate approval via `Sidecar` and `SlashHost`; support `--check`, `--version`, `--yes`, and `--force`. | `cli/src/slash/catalog.ts`, `cli/src/slash/session_commands.ts`, `cli/src/sidecar.ts`, `cli/src/repl.ts` | 4 |
| 7 | Tests: comprehensive unit and integration test suites covering SemVer comparison, release selection, error recovery, checksum verification, CLI exit codes, and deliberate TUI approval. | `cli/test/upgrade.test.ts`, `cli/test/upgrade_cli.test.ts`, `cli/test/upgrade_tui.test.ts` | 5, 6 |
| 8 | Documentation & governance: update USER_MANUAL, quickstart, REQUIREMENTS ledger (REQ-REL-115), ROADMAP, and ACCEPTANCE criteria. | docs | 7 |

## PR Slices

1. **PLAN-12_PR-12a**: Complete upgrade engine, CLI command, TUI slash command, unit/integration tests, and documentation.
