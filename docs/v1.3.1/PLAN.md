# Nexus Code v1.3.1 plan: close v1.3.0 gaps, harden security, ship npm package

Status: **DRAFT PLAN** (2026-11-25), authored on `v1/v131-plan` from `origin/main` (`e578571b`). This plan is execution guidance, not a release claim. No merge/tag/publish performed.

## 1. Purpose

v1.3.0-rc.1 landed the platform track but carried explicit deferrals, partial qualifications, open issues, and open security/code-quality alerts. **v1.3.1 has no deferrals** for the v1.3.0 gap set: every item deferred/excluded from v1.3.0-rc.1, every open GitHub issue, and every open GitHub security/code-quality alert is in scope and must be closed with measured evidence or an explicit owner-approved disposition (fix, dismiss with rationale, or superseded by equivalent control).

**Owner directions (2026-11-25):**
- Base branch for v1.3.1 work: `release/v1.3.1` from `origin/main`.
- npm publish is **in scope** for v1.3.1.
- macOS/Windows desktop clients and terminal clients are **targeted in v1.4.0** (explicitly out of v1.3.1).
- #807 is **required** for v1.3.1.

## 2. Evidence snapshot (measured 2026-11-25)

| Source | Observation |
|---|---|
| `gh release view v1.3.0-rc.1` | Pre-release published 2026-11-25T18:01:36Z, tag `v1.3.0-rc.1`, RC tip recorded as `da83ebb12`. Release body lists deferred/excluded items and known limits. |
| `docs/releases/v1.3.0-READINESS.md` @ `origin/main` | SB-1 D22 closed; HK-3 partial (subprocess workspace JS hooks/plugins deferred to v1.4 in RC notes); HK-2 partial (no git-URL commit-pinned install, no trigger-loaded skills); PA-4 partial/staged; WP-P10-02 partial; PA-3 live-gateway/interrupted-effect reconciliation pending; PF-3/BG-3 experimental. |
| Open issues | `#807` unattended job/loop resume overrides stale-driver pause (PA-3, OPEN); `#800` containment checks use `relative.startsWith("..")` (`..x` segment) (OPEN); `#1` PLAN-10 task 8 finish/seal held-out T2/T3 corpus (OPEN, v1.2.1 label). |
| Open code scanning alerts (CodeQL, 7) | `#69` high `js/regex-injection` `cli/src/tester.ts:1126`; `#70` medium `js/bad-code-sanitization` `cli/test/verify_sandbox.test.ts:385`; `#78` medium `js/bad-code-sanitization` `cli/test/runner_deadline.test.ts:47`; `#79` medium `js/shell-command-injection-from-environment` `cli/src/core/hook_runner.ts:107`; `#81` medium `js/shell-command-injection-from-environment` `cli/test/hooks_self_approval.test.ts:410`; `#82` high `js/incomplete-url-substring-sanitization` `cli/test/triggers_cli.test.ts:195`; `#83` high `js/incomplete-url-substring-sanitization` `cli/test/triggers_cli.test.ts:195`. |
| Dependabot / secret scanning | No open Dependabot alerts; no open secret-scanning alerts. Open Dependabot PRs: `#827` walkdir 2.5.0→2.5.1 `/core`, `#828` @babel/parser 7.29.15→8.1.3 `/cli` (major). |
| Local unreconciled SB-1 fix-forward | `/home/mike/nexus-wt/SB1_D22_ACCEPTANCE` has local commits `eb8a9856`, `4c4d1c9b` (profile-aware sandbox denial/verify receipts/docs/tests; 62 targeted tests pass locally). Not pushed/no PR. Must be reconciled into v1.3.1 line. |

## 3. Non-goals / explicit v1.4 targets

- macOS/Windows desktop clients and terminal clients — **v1.4.0** (owner-directed).
- Marketplace, auto-update, hosted/multi-tenant operation (per v1.3.0 plan D8).
- New runtime dependencies without a decision.

## 4. Work packages (all required)

### WP-131-01 — PA-3 stale-driver override fix (#807, required)

**Problem:** `driveOperation` pauses stale-driver operations, but `job_worker.ts` and `loop.ts` pass `prepare` hooks that turn `PAUSED` back into `RUNNING`/`WAITING`, overriding the stale pause for unattended job resume and loop iteration re-drive. Goals are unaffected because `GoalOrchestrator.resume` is explicit operator action.

**Scope:**
- Change unattended resume/loop prepare behavior so stale-driver pause is **not silently overridden**. Default policy: if stale pause reason is present, do not auto-clear it; persist visible event/receipt, leave operation paused/blocked-for-operator as appropriate, and require explicit operator resume/ack path. (Exact state machine to be confirmed in implementation design, but no silent override.)
- Cover both `cli/src/core/job_worker.ts` and `cli/src/loop.ts` prepare hooks; audit other `prepare` callers for same pattern.
- Add deterministic tests: resumed detached job with stale driver identity remains paused/blocked with visible reason; loop iteration operation stale pause is not auto-cleared; explicit operator resume path still works; goals unaffected.

**Acceptance:**
- #807 closed with code + tests + evidence.
- `docs/v1.3.0/PA3_GOAL_LIFECYCLE.md`/PA-3 acceptance updated or v1.3.1 evidence doc records the fix.
- G-4/G-3 relevant hostile/regression cases added.

### WP-131-02 — PA-3 completion / qualification gaps

**Scope:**
- Interrupted-effect reconciliation beyond stale-driver pause: define and test reconciliation matrix for unknown/interrupted effects on resume/restart.
- Live-gateway qualification: execute and record measured provider-neutral/live-gateway qualification evidence (or record explicit environment block with owner-visible evidence; no silent skip).
- Reconcile SB-1 local fix-forward commits `eb8a9856`, `4c4d1c9b` into v1.3.1 line after review (profile-aware sandbox denial/verify receipts).

**Acceptance:**
- PA-3 acceptance doc updated with v1.3.1 evidence; no unresolved stale-pause override; interrupted-effect reconciliation covered by deterministic tests.
- SB-1 fix-forward merged or superseded with equivalent tests/evidence.

### WP-131-03 — HK-3 completion: subprocess workspace JS hooks/plugins

**Problem:** v1.3.0-rc.1 kept in-process workspace JS hooks/plugins supported with deprecation note; subprocess execution deferred to v1.4. Owner requires no deferrals.

**Scope:**
- Run workspace JavaScript hooks and plugins as subprocesses (or equivalent isolated process boundary) with explicit capability/trust model.
- Preserve per-plugin trust keyed by exact bytes/SHA-256, terminal approval, no agent self-approval.
- Preserve manifest plugins subprocess model and project-hook verified-copy rules.
- Define migration/compatibility behavior; remove or narrow deprecation note only when subprocess path is complete and tested.
- Ensure no gate weakening: hooks/plugins cannot approve denied actions, raise verdicts, or bypass managed policy/sandbox/verification guards.

**Acceptance:**
- HK-3 plan acceptance met on v1.3.1: per-plugin trust + subprocess execution for workspace JS hooks/plugins.
- G-3 hostile suite covers plugin/hook subprocess boundary.
- Docs: `docs/PLUGINS.md`, `docs/HOOKS.md`, migration notes, doctor messages updated.

### WP-131-04 — HK-1/HK-2 completion

**Scope:**
- HK-1 remaining hook events: `pre-verify`, `post-verify`, `permission-request`, `session-start`, `session-end`, `stop`, `pre-compact`; JSON stdin/stdout contract; exit 2 blocks; timeout; scrubbed env; tighten-only semantics.
- HK-2 git-URL installs pinned to commit hash; install receipt records resolved commit; `nexus plugins install|list-installed|remove|verify` covers git+local; policy permission-kind refusal; trigger-loaded skills (declared trigger, not always-on).

**Acceptance:**
- HK-1/HK-2 plan criteria met; tests for each event and install/verify/remove path.
- No marketplace, no auto-update.
- Skill trigger request-shape snapshots prove non-triggered skills add nothing.

### WP-131-05 — PA-4 completion (no staged deferral)

**Scope:**
- Complete `/goal` and `/loop` lifecycle qualification and TUI/sidecar exposure where supported.
- Shared validated delegation contract/outcome; authority intersection; recursive/resource limits; typed non-success and unknown-effect outcomes.
- Prompt-only subagent compatibility preserved; writable profiles require established worktree.
- Durable state, lifecycle controls, recovery, status, pause/resume/cancel for each command.
- `/goal` satisfies PA-3 semantics; `/batch` remains qualified.
- Provider-neutral deterministic fixtures; existing local/cloud fixtures pass without provider changes.

**Acceptance:**
- PA-4 plan acceptance criteria met; evidence docs updated (`PA4_*`, readiness).
- No second scheduler/workflow store.

### WP-131-06 — WP-P10-02 completion

**Scope:**
- Side/delegated inference accounting.
- Per-tool deadlines.
- General unknown-outcome reconciliation.
- Whole-operation token accounting.

**Acceptance:**
- Operation schema migration tests; accounting tests across child/side inference; unknown-outcome reconciliation matrix; `nexus operation status/budget` and docs updated.
- Additive/compatible schema evolution documented.

### WP-131-07 — BG-3/PF-3 hardening

**Scope:**
- BG-3: address #812 non-blocking re-review suggestions; abuse/trust hardening; clarify webhook integrity vs confidentiality limits in docs.
- PF-3: close #816 shared posture helper follow-up; socket transport hardening/observability; protocol compatibility disciplined.

**Acceptance:**
- Issues/follow-ups closed or converted to explicit tested behavior with docs.
- Deterministic tests for trigger/webhook/socket edge cases.

### WP-131-08 — Containment/path safety (#800)

**Scope:**
- Replace unsafe `relative.startsWith("..")` containment checks with correct `rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)` via shared helper (reuse/export `isPathWithin` where appropriate).
- Audit and fix all sites listed in #800 and any additional `git grep` matches.
- Add per-site regression tests including `..x` sibling-segment case.

**Acceptance:**
- #800 closed with code/tests.
- No unsafe containment pattern remains without documented justification.
- Security review notes whether each site was fail-open or fail-closed before fix.

### WP-131-09 — Security/code-quality alert closure

**Scope:** Resolve all 7 open CodeQL alerts; triage Dependabot PRs.

| Alert | Action |
|---:|---|
| #69 high `js/regex-injection` `cli/src/tester.ts` | Replace tainted regex construction with safe literal/glob handling or strict validation+escaping; add hostile input tests. |
| #70 medium `js/bad-code-sanitization` `cli/test/verify_sandbox.test.ts` | Fix unsafe test construction or dismiss with documented rationale. |
| #78 medium `js/bad-code-sanitization` `cli/test/runner_deadline.test.ts` | Fix/dismiss with rationale. |
| #79 medium `js/shell-command-injection-from-environment` `cli/src/core/hook_runner.ts` | Constrain command construction to approved argv forms; no shell interpolation from uncontrolled env/path; add regression tests. Dismiss only with strong rationale. |
| #81 medium `js/shell-command-injection-from-environment` `cli/test/hooks_self_approval.test.ts` | Fix test to use safe spawn/argv/fixed paths. |
| #82,#83 high `js/incomplete-url-substring-sanitization` `cli/test/triggers_cli.test.ts` | Use parsed URL origin/host equality. |

Dependabot PRs: #827 walkdir patch - merge after CI; #828 @babel/parser major - evaluate compatibility, upgrade or pin with rationale.

**Acceptance:**
- Code scanning open alerts = 0, or dismissals have owner-approved security rationale documented in issue/PR.
- Dependabot PRs triaged/merged/superseded.
- CI green on release branch.

### WP-131-10 — npm publish (D13, in scope)

**Scope:**
- Define publishable package name/scope, license confirmation, README/install docs, semver/release workflow.
- Remove `private: true` / prepublishOnly block only when publish is authorized and package contents are correct.
- Add `files`/`.npmignore`/export map validation, provenance/SBOM/signing as appropriate.
- Update release workflow for stable npm publish (owner-gated) while preserving RC/stable GitHub release flow.
- Ensure CLI binary/core packaging model is clear (npm package may ship JS/TS dist + launcher; Rust core handling documented).

**Acceptance:**
- Dry-run publish passes; package contents audited.
- Release process docs updated.
- Owner authorization required before first real publish/tag.

### WP-131-11 — Backlog closure and qualification

**Scope:**
- #1 PLAN-10 task 8: finish and seal held-out T2/T3 corpus, or close/supersede with measured evidence.
- Context maturity is integrated on `codex/context-maturity-v131`; focused results and remaining limits are recorded in `docs/research/context-engineering/CONTEXT-MATURITY-SYSTEM.md`. Full-suite and hosted CI qualification remain pending under G-1.
- G-1–G-7 re-evaluated for v1.3.1; release notes/readiness updated with measured status.

**Acceptance:**
- #1 closed with evidence.
- v1.3.1 readiness doc has no silent TBD for in-scope items.

## 5. Sequencing

1. **Foundation/safety first:** WP-131-08, WP-131-09, WP-131-01 (security + required PA-3 bug).
2. **Platform correctness:** WP-131-02, WP-131-06, WP-131-03.
3. **Feature completion:** WP-131-04, WP-131-05, WP-131-07.
4. **Release packaging:** WP-131-10, WP-131-11.

Parallelism is allowed across independent WPs with worktree/claim discipline and per-subsystem merge serialization.

## 6. Release gates (v1.3.1)

| Gate | Requirement |
|---|---|
| G-1 | `make test` green at exact head; required CI green; release-branch CI green after each merge. |
| G-2 | Protocol/schema/ACP conformance green; no undocumented protocol drift. |
| G-3 | Hostile gate-bypass suite green across client/hook/plugin/schedule/trigger/socket/policy surfaces; no allow-always/bypass/regression. |
| G-4 | Unattended runs: no allow-always, fresh worktree, unattended flag in receipts, kill-and-resume pass; stale-driver pause cannot be silently overridden (#807). |
| G-5 | Audit export/verify/tamper-fails round trip green. |
| G-6 | Docs/examples for every new/changed surface, runnable or tested where applicable. |
| G-7 | Release notes measured; no frontier-grade claim; external qualification reported as measured/pending. |
| G-8 | Open issues #1/#800/#807 closed; CodeQL open alerts 0 or owner-approved dismissals; Dependabot/secret scanning triaged. |
| G-9 | npm publish dry-run/audit pass; real publish only on owner authorization. |

## 7. Risks

| Risk | Mitigation |
|---|---|
| Subprocess workspace JS plugins/hooks change behavior | Compatibility tests, migration docs, explicit trust/approval UX, fail-closed on unsupported plugin shape. |
| #807 fix changes unattended recovery semantics | Visible reason/event, explicit operator resume path, deterministic job/loop tests. |
| Path-containment sweep touches many sites | Shared helper, per-site tests, review fail-open/fail-closed before/after. |
| CodeQL fixes alter security-sensitive behavior | Targeted regression tests, minimal fixes, avoid behavior drift in hook/sandbox/policy. |
| npm publish exposes packaging mistakes | `files` allowlist, dry-run, install-from-tarball smoke, owner-gated publish. |

## 8. Owner decisions / inputs recorded

- **#807 (recorded 2026-11-25):** default behavior approved — **block/keep paused with visible reason; no auto-clear**. Unattended job/loop stale-driver resume must not silently override pause; explicit operator resume/ack required.
- **npm publish (recorded 2026-11-25):** in scope for v1.3.1, but npm package and publishing account are **not yet set up**. WP-131-10 must include package naming/scope decision, account/access setup checklist, dry-run/tarball audit, CI/release workflow wiring, and owner-gated first publish. No real publish without owner authorization.
- **Testing infrastructure (updated 2026-11-26):** do not assume or require paid infrastructure or subscriptions for this FOSS project. Use deterministic local fixtures and locally available inference; live provider checks are deferred unless suitable infrastructure is donated or otherwise available at no cost. Deterministic tests remain release-gate authority.
- **CodeQL (recorded 2026-11-25):** alerts must be **fixed**, or closed only with **specific reasoning/proof of false positive documented** (owner-approved rationale). Default: fix.
- **#1 T2/T3 corpus:** still needs confirmation whether external data/access is required; close/seal with evidence or explicit owner-approved supersession.
- **Remote branch (recorded 2026-11-25):** `release/v1.3.1` created on origin from `origin/main` (`e578571b`). Agents push PRs against `release/v1.3.1`.

## 9. Reference coding / XERJ

This planning pass used local docs, git history, and GitHub issue/alert/release metadata. No peer-project code copied. For implementation WPs, follow `docs/XERJ_REFERENCE_CODING.md`: query XERJ before non-trivial peer-analogous code, record take/borrow/reject in PRs, or record "XERJ unavailable: <reason>" with `git grep` fallback.
