# Configured Git Hook Suppression and Checkpoint Retention Failure Handling

| | |
|---|---|
| Base revision | `7a860c091297abc13371d92ae9633a9f06d67f7a` |
| Branch | `v1/configured-hook-race-retention-errors-20261027` |
| Scope | Close the configured-hook discovery race and preserve checkpoint metadata/ref consistency when retention cleanup fails. |

## Changes

- Protected Git operations now disable all configured hooks for each relevant event with the event-wide `hook.<event>.enabled=false` setting. They do not enumerate friendly names before the operation, which would permit a newly added hook to escape suppression.
- Git 2.54 is rejected for protected operations. That release supports named configured hooks but does not implement the event-wide disable switch; continuing would silently leave them executable. Git versions before 2.54 do not implement named configured hooks, and Git 2.55 or later supports the event-wide switch.
- Retention validates checkpoint record and directory identities before ref deletion, deletes refs with an expected old object ID, and restores a deleted ref with a create-only update if final record cleanup rejects the item. Ref deletion errors are reported and leave the record available for retry.
- Manual checkpoint pruning resolves the hook-suppression guard before changing metadata, uses expected-old ref deletion, restores the ref if metadata removal fails, and includes per-checkpoint failures in its returned message instead of swallowing them.

## Verification

- `node scripts/run_tests.mjs test/retention_git_hook.test.ts test/checkpoint_git_hook.test.ts` using system Git 2.43.0: **12 passed, 1 skipped, 0 failed**. The skip is the repository-configured late-hook race test, which requires Git 2.55 or later.
- The same focused suite using an official source build of Git 2.55.0: **13 passed, 0 skipped, 0 failed**. The archive was `https://www.kernel.org/pub/software/scm/git/git-2.55.0.tar.xz`, SHA-256 `457fdb04dc8728e007d4688695e6912e6f680727920f2a40bf11eacc17505357`; the source-built `git` executable reported version 2.55.0. `GIT_TEMPLATE_DIR=/usr/share/git-core/templates` was set because the temporary build was not installed with templates.
- The suite includes inherited-enable override, late-added configured-hook, Git 2.54 fail-closed (including manual-prune preservation), stale-record protection, rollback after record replacement during ref deletion, and explicit ref-deletion failure cases.
- `npx tsc --noEmit`: passed.
- `git diff --check`: passed.

## Review and limits

- Independent reviewer `/root/plan05_readonly_review` accepted the exact tracked diff SHA-256 `24505962c5d887efe49b9499ef686f5fa2a0f7e29fd3aa0cd1c69de23f592073` against the base revision. The review confirmed the Git 2.54 guard runs before mutation, manual pruning preserves/report failures, and retention ref deletion/restoration handles concurrent replacement without overwriting.
- The full repository suite, current-main CI, and release qualification were not run for this slice. This evidence does not qualify an RC or change acceptance status.
