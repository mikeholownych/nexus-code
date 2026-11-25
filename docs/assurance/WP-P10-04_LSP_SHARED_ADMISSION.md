# WP-P10-04: Cross-session LSP process admission

## Scope

This slice extends the existing `SharedResourceAdmission` kernel-lock mechanism so language-server processes are bounded across Nexus CLI processes that share one credential home and filesystem. The limit defaults to the existing per-manager value (8) and can be configured from 1 through 64 with `NEXUS_MAX_LSP_SERVER_PROCESSES`.

Each language server is launched beneath a small trusted supervisor. Nexus passes the admission lock descriptor to that supervisor; the supervisor retains it but does not pass it to the language server. This preserves the slot if the Nexus parent exits unexpectedly. Admission denial and inability to establish admission are reported as unavailable and do not launch a language server.

## Evidence

- Source baseline: `b5dc77b73871fdfeda9576c592b48a8c74ad340b`.
- `npm --prefix cli run build`: passed in the isolated worktree.
- `HOME=$(mktemp -d) node --import tsx --test test/lsp_lifecycle.test.ts`: 18 passed, 0 failed, 0 skipped. This includes a two-process capacity-one probe: the second Nexus worker is refused while the first server supervisor holds a slot, remains refused after the first Nexus process is killed, then starts after that supervisor exits.
- `HOME=$(mktemp -d) node --import tsx --test test/operation_resource_admission.test.ts`: 13 passed, 0 failed, 0 skipped.

## Reproduction

From `cli/` in the implementation branch, with dependencies installed:

```sh
npm run build
HOME=$(mktemp -d) node --import tsx --test test/lsp_lifecycle.test.ts
HOME=$(mktemp -d) node --import tsx --test test/operation_resource_admission.test.ts
```

## Limits and remaining verification

The guarantee covers processes using the same operator credential home and a local filesystem with functioning kernel file locks. It does not coordinate across hosts, independent credential homes, or filesystems without the expected lock semantics. The process-death test is skipped on Windows; platform-specific behavior needs Windows CI evidence. The test exercises a fake language server, not every real server implementation. A child server that daemonizes outside its process group may outlive normal manager shutdown, although its supervisor retains the slot while alive.

Hosted required checks and exact-head CI have not yet been run for this branch. This note records local evidence only and is not a release or independent-review claim.
