# Skills Architecture Audit — Executive Decision Record

**Baseline:** `3c54e6014c2ea5281f642fdd53ac20605f2b24ae` (`origin/main`)  
**Date:** 2026-11-18  
**Decision authority:** Owner (this document is a recommendation)

---

## What is already working

- Agent Skills discovery across global + trust-gated workspace directories
- Lexical ranking, bounded catalog, per-prompt notes with provenance markers
- `activate_skill` as non-mutating `context_inject` through the execution spine
- Hard deny of untrusted workspace skill activation
- Session authorization stack (approval modes, RO allowlist, grants, role allow-lists, spine receipts)
- Description sanitization against control/template markers
- Strong automated coverage for skill loading/injection (57/57) and related auth suites (72/72)

---

## What is genuinely missing

- Per-skill enforceable capability/resource contracts (optional intersection)
- Durable skill activation identity linked to tool receipts
- Content digest / integrity policy for activated bodies
- Skill lifecycle: qualification, revoke, rollback index
- Live wiring for `isUntrustedSource` on activate (API exists, unused)
- Watcher coverage aligned with all discovery roots (S-03; low)

**Provenance note:** Prior F-01–F-05 labels were mission hypotheses only — no earlier in-repo skills audit write-up was found ([prior-findings search](06517866-bc6b-46ce-98ce-7ea307003340)).

---

## What is unsafe or unreliable

- **Not demonstrated:** silent privilege escalation via skill frontmatter
- **Unreliable for forensics:** reconstructing “which skill governed these tools” after compaction
- **Unsafe if mis-modeled:** treating skills as capability grants; treating prompt sanitization as an execution boundary
- **Elevated under shared HOME / auto+`--yes`:** malicious global skills as high-influence instructions
- **Session-level:** shell side effects vs path confinement (amplified by skill instructions, not introduced by them)

---

## What should be implemented

1. WP-GS-01 activation IDs on receipts  
2. WP-GS-02 content digests + sticky/live integrity  
3. WP-GS-03 opt-in capability intersection (never expand)  
4. WP-GS-04 resolve dead `isUntrustedSource` path  
5. WP-GS-05/06 local lifecycle + qualification  

---

## What should explicitly **not** be implemented

- Parallel authorization / logging / orchestration frameworks  
- Mandatory remote skill registry or notarization for local/air-gapped use  
- Silent enforcement that breaks unconstrained legacy skills without a flag  
- Using skill metadata to grant tools the session would deny  

---

## Recommended execution sequence

Ship instructional skills as-is under current session policy → implement WP-GS-01/02 (auditability) → opt-in WP-GS-03 → lifecycle WP-GS-05/06 → optional supply-chain WP-GS-07.

---

## Remaining blockers and uncertainties

- Full CI/`make test` not re-run in this engagement  
- `gh` unauthenticated — open issues not inventoried  
- Sandbox effectiveness vs skill-driven shell not re-qualified  
- Product choice: default sticky vs live integrity; confirm-on-activate UX  

**No release blocker hotfix identified.** Proceed with planned governed-skills increments when prioritized.
