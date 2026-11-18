# Governed Skills — Implementation Plan

**Baseline:** `3c54e601`  
**Architecture:** `GOVERNED_SKILLS_ARCHITECTURE.md`  
**Findings:** `SKILLS_AUDIT_FINDINGS.json`  

Increments are independently testable. Prefer additive schemas and feature flags. Preserve Agent Skills `name`/`description` compatibility.

---

## Priority order

1. **WP-GS-01** Evidence + activation identity (F-02, F-03 partial)  
2. **WP-GS-02** Content digest + sticky integrity (F-03, ADV-05/06)  
3. **WP-GS-03** Optional capability intersection (F-01)  
4. **WP-GS-04** Wire `isUntrustedSource` / activate approval posture (S-01)  
5. **WP-GS-05** Local lifecycle index + revocation (F-05, ADV-09)  
6. **WP-GS-06** Continuous skill qualification hooks (F-05)  
7. **WP-GS-07** Supply-chain hardening options (F-04) — optional  

Do **not** start with a new auth engine. Do **not** block release of instructional skills on WP-GS-06/07.

---

## WP-GS-01 — Activation identity and receipt linkage

1. **Objective:** Durable, structured skill→tool attribution without changing auth.  
2. **Findings:** F-02, ADV-07, ADV-08  
3. **Reuse:** `ExecutionReceipt`, `evidenceEmission`, flight recorder, agent task id  
4. **Files:** `spine.ts` (receipt fields), `spine_handlers.ts` (activate), `dispatch_tool_call.ts`, `agent.ts`, tests  
5. **Schema:** `skillActivationId?`, `skillName?` on receipt; in-memory `SkillActivation`  
6. **Authority:** none  
7. **Migration:** additive optional fields; old sessions OK  
8. **Sequence:** types → activate creates id → dispatch attaches → tests  
9. **Deps:** none  
10. **Failure:** missing id ⇒ omit fields (no fail-open auth change)  
11. **Unit:** activate creates id; subsequent tool receipt carries id  
12. **Integration:** skill_injection path with mocked tools  
13. **Adversarial:** ADV-07 re-run expects fields present  
14. **Acceptance:** receipts for tools after activate include activation id; deactivate clears  
15. **Evidence:** test log + sample receipt JSON  
16. **Rollback:** flag `NEXUS_SKILL_ACTIVATION_IDS=0`  
17. **Complexity:** S–M; uncertainty: compaction dropping tool messages (document)

---

## WP-GS-02 — Content digest and integrity policy

1. **Objective:** Pin activated body digest; detect file/symlink change.  
2. **Findings:** F-03, ADV-05, ADV-06  
3. **Reuse:** `createHash` patterns from `needs_input` / upgrade  
4. **Files:** `skills.ts` load path, activate handler, optional live check in dispatch  
5. **Schema:** `contentDigest` on SkillActivation; optional `realpath`  
6. **Authority:** none (integrity only) unless live policy blocks  
7. **Migration:** digests new activations only  
8. **Sequence:** hash at activate → store → sticky default → optional live mismatch warn/deny  
9. **Deps:** WP-GS-01  
10. **Failure:** unreadable file ⇒ deny activate  
11–13. **Tests:** edit after activate; symlink retarget; sticky vs live  
14. **Acceptance:** activation record digest matches injected body; live mode detects drift  
15–16. Evidence + flag rollback  
17. **Complexity:** M; uncertainty: large skill bodies / redaction of stored snapshots

---

## WP-GS-03 — Optional capability / resource intersection

1. **Objective:** Enforce optional skill constraints as **intersection** with session authority.  
2. **Findings:** F-01, ADV-01  
3. **Reuse:** `AuthorityAdmissionEngine`, capability registry, role allow-list pattern  
4. **Files:** frontmatter parse (enforced keys only), `authority.ts`, `dispatch_tool_call.ts`, docs  
5. **Schema:** `allowedCapabilities` / `deniedCapabilities` / optional resource roots — **enforced only when present**  
6. **Authority:** intersect only; document that absence = unconstrained (current)  
7. **Migration:** existing skills unchanged; flag `NEXUS_SKILL_CONSTRAINTS=1` to enforce  
8. **Sequence:** parse → resolve to tool names → enforce in dispatch → authority double-check  
9. **Deps:** WP-GS-01 (to know active constraints)  
10. **Failure:** invalid manifest with flag on ⇒ deny activate  
11–13. Tests: allowlist blocks `run_command`; session RO still wins; unconstrained legacy  
14. **Acceptance:** constrained skill cannot admit tools outside list even in auto mode; cannot expand RO  
15–16. Evidence + disable flag  
17. **Complexity:** M–L; uncertainty: mapping Agent Skills `allowed-tools` dialects — support explicitly or ignore until mapped

---

## WP-GS-04 — Activate approval / untrusted source wiring

1. **Objective:** Make `context_inject` untrusted-source gating real or remove dead API.  
2. **Findings:** S-01  
3. **Reuse:** `ApprovalPolicy`, needs_input  
4. **Files:** `dispatch_tool_call.ts` policyContext; possibly mark global vs workspace  
5. **Choose one:** (A) set `isUntrustedSource` for workspace skills even when trusted-for-load if operator wants confirm; or (B) delete/rename dead API and document hard-deny-only. Prefer (A) behind flag for first activate per skill digest.  
6–17. Standard test/rollback; Complexity S

---

## WP-GS-05 — Local lifecycle index and revocation

1. **Objective:** Local digest index, revoke, sticky in-memory clear on revoke; align FS watcher roots with discovery (S-03).  
2. **Findings:** F-05, ADV-09, S-03  
3. **Reuse:** state dir under `NEXUS_STATE_DIR`; watcher refresh  
4. **Files:** new `cli/src/skills_lifecycle.ts`, `skills.ts` (`startWatcher` dirs), slash commands  
5. **Schema:** local index JSON  
6. **Authority:** revoke blocks new activate + attributed tools  
7. **Migration:** empty index = allow all discovered  
8–17. Complexity M; air-gapped OK; include regression that watchDirs cover every discovery root (or document intentional exceptions)

---

## WP-GS-06 — Continuous skill qualification

1. **Objective:** Skill fixtures + negative tests + invalidate on digest change.  
2. **Findings:** F-05  
3. **Reuse:** CERI evidence patterns, `tester.ts` digests, regression obligations concepts  
4. **Files:** `cli/test/skills_qualification/` fixtures; optional `nexus skills qualify`  
5–17. Complexity L; do after WP-GS-02/05; local-only

---

## WP-GS-07 — Supply-chain options (optional)

1. **Objective:** Optional realpath-outside-HOME warning/deny; optional symlink policy.  
2. **Findings:** F-04, ADV-06  
3. **Reuse:** workspace trust UX patterns  
4. **Not required:** remote notarization  
5–17. Complexity S–M; default warn not deny for OSS compat

---

## Cross-cutting acceptance gates

| Gate | Requirement |
|---|---|
| G0 | Skill suite 57/57 still green |
| G1 | Auth/spine related suites green |
| G2 | ADV harness updated expectations pass |
| G3 | Docs: informational vs enforced frontmatter table |
| G4 | No expansion of authority in any WP |
| G5 | Feature flags default preserve current behavior until operator opts in (except pure additive receipt fields if deemed safe) |

---

## Release considerations

- Ship WP-GS-01/02 as auditability improvements with additive fields (low risk).  
- Ship WP-GS-03 constraints **opt-in** initially.  
- Keep Agent Skills CLI interoperability directories unchanged.  
- Record XERJ reference coding in PRs (OpenCode skill policy refuse-before-load as approach-only).

---

## Explicit non-goals

- Parallel authorization engine  
- Mandatory online skill registry  
- Replacing session approval modes with skill metadata  
- Claiming prompt sanitization equals execution security  
