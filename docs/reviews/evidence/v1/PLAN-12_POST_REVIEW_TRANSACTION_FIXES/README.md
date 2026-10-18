# PLAN-12 post-review transaction fixes — PR #51

Implementation source: `b590be268b37790bfe4568694a9378f2016749b0` on `v1/plan-12-post-review-transaction-fixes`. This follow-up preserves rejected PR #48 and its branch/history. It incorporates the explicitly handed-off component-coherence and bounded legacy-policy commits from the release coordinator. No independent verdict is authored here.

## Fresh validation

- Local WSL, Node 20.18.1, isolated test-runner HOME: TypeScript `--noEmit` succeeded. Five focused test files passed **107/107**, 13 suites, no skips (retained TAP). This is a source snapshot extracted from the exact committed tree, not the live editing worktree.
- Fault coverage includes six crash filesystem/journal windows, five actual upgrade exception boundaries, an actual SIGKILL after replacing the package, post-install wrong-version rejection, missing runtime rejection, hung descendant cleanup, redirected recovery paths, failed link restoration with retained artifacts, read-only checks over pending journals, invalid-recovery exit code, exact previous-package binary rollback, and complete session/config backup restoration.
- Official public alpha.2 archive SHA-256 `56227e58366d21f67bfb46fde4d0e916cadf4c5eed1fdc65d39e01b1d57c60c7` matched the independently fetched public SHA256SUMS. Its core reported `harness-core 1.2.1` on WSL; the complete bounded runtime helper returned `healthy: true`. These are runtime observations, not an end-to-end upgrade or RC acceptance result.
- The release coordinator independently observed both public alpha core binaries reporting 1.2.1 on mike-dev. Its retained observation record is included unchanged. Historical component exceptions are bound to exact official component hashes, platform, target identities, and schemas, rather than arbitrary version mismatch.
- No inference, private held-out data, canonical dirty checkout edits, shared-host test overlap, merges, tags, deployment, or publication occurred in this slice.

## Acceptance mapping and limits

| Criterion | Evidence supplied here | Still required |
|---|---|---|
| ACC-UPG-01/02 | Existing release comparison fixtures plus pending-journal check-only purity regression | Installed-RC checks against published releases |
| ACC-UPG-03/04 | Existing command/upgrade/downgrade fixtures | Installed interactive/noninteractive acceptance |
| ACC-UPG-05 | Startup integration preserves CLI/TUI entry path; deliberate approval implementation unchanged | Real installed TUI approval/queued-input acceptance |
| ACC-UPG-06 | Live package exception and actual-kill rollback regressions; canonical-root/path checks | Installed package upgrade acceptance |
| ACC-UPG-07 | Component coherence, requested-target binding, bounded legacy/config/state policy fixtures | Workflow-produced metadata and installed legacy upgrade |
| ACC-UPG-08 | Existing tar/download safety fixtures rerun | Required RC artifact gates |
| ACC-UPG-09 | Complete private state/config snapshot restoration and distinct binary rollback tests | Installed migration/rollback matrix |
| ACC-UPG-10 | Existing provenance fixtures; journal identity/rename boundary regressions | Installed provenance acceptance |
| ACC-UPG-11 | Same-version durable backup recovery, actual process kill, nonzero invalid/manual recovery, startup integration | Installed startup/crash matrix and independent review |
| ACC-UPG-12 | Exact version/core/TUI probes, bounded process-group cleanup, missing/wrong runtime tests | Real package/Rust build and installed verification |
| ACC-UPG-13 | Official historical alpha.2 runtime health only | Full real prior-public-release → RC upgrade with state, doctor, CLI, TUI, restart |
| ACC-UPG-14 | Existing trust-boundary document preserved and runtime/legacy caveats clarified | Required workflow provenance and publication checks |

Full `make test`, Rust build/tests, exact-head CI, independent review, installed-RC qualification, terminal/operator evidence, and release acceptance are **pending**. The focused suite and historical runtime observation do not qualify the product. Requirement statuses and frozen thresholds are unchanged.
