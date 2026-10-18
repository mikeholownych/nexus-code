# RubyForest session handoff (2026-10-18)

## Identity
- Agent Mail: RubyForest (cursor-agent / composer)
- Role: implementation/integration (not held-out custodian, not release publisher)

## Baseline verified
- Repo: github.com/mikeholownych/nexus-code
- Authoritative tip at join: origin/v1/integration@cab12f0 (PR #54 merged)
- Shared checkout main@db1ca55 dirty — preserved untouched
- d2c4bfc / 2c70d39 are ancestors; 2496186 / 53dd2f1 are not (superseded by five-stage §1.1; draft-then-publish sentence already fixed in PR #51)

## Completed this session
1. Independent review PR #51 @8ea75d8 → CHANGES_REQUIRED (openGuardFile lstat+open r+ TOCTOU; need O_NOFOLLOW|O_NONBLOCK)
2. PR #55 opened: REQ-AGT-111 v1 subset test + docs @f7243a1 — https://github.com/mikeholownych/nexus-code/pull/55
3. Independent review PR #48 → SUPERSEDED by #51; closed PR #48

## Active claims held
- PLAN-04_AGT111_V1_CLOSURE
- FILE_docs_EXECUTION_CONVERGENCE.md
- FILE_docs_v1.0.0_plans_PLAN-04-continuity-and-durable-work.md
- FILE_docs_v1.0.0_specs_SPEC-04-continuity-and-durable-work.md
- FILE_cli_test_agt111_subagent_parity.test.ts
- FILE_docs_reviews_evidence_v1_PLAN-04_AGT111_V1_CLOSURE

## Blocked / waiting
- PR #55: CI + independent review (cannot self-accept)
- REQUIREMENTS.md FILE claim held by codex-lead (dead pid) — ledger row for REQ-AGT-111 deferred
- PR #51: owner p12-fix must fix O_NOFOLLOW; then re-review
- PLAN-10_VERSION_PROBE_STORAGE: local ahead-4 includes 46504c7 grantRunAsAccess(probeWorkspace) not on origin after PR54 merge — owner claim held; BOUNDARY logged

## Next useful work when free
1. After REQUIREMENTS claim frees: update REQ-AGT-111 row to partial (v1 subset) with test ref
2. After PR51 O_NOFOLLOW lands: re-review and help integrate
3. Version-probe ACL follow-up PR if VERSION_PROBE claims transferred
4. Exact-RC / repro.yml dispatch only after RC tag (publisher)
