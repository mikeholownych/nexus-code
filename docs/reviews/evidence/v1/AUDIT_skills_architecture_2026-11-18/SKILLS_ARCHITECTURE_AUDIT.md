# Skills Architecture — Independent Audit Report

**Auditor role:** Principal Software Architect / Security / Runtime Reliability (independent verification)  
**Repository:** `github.com/mikeholownych/nexus-code`  
**Audit worktree:** `/home/mike/nexus-wt/AUDIT_skills_architecture_2026-11-18`  
**Exact baseline:** `3c54e6014c2ea5281f642fdd53ac20605f2b24ae` (`origin/main`, merge of PR #611, 2026-11-18)  
**Prior audit baseline:** `3c54e6014c2ea5281f642fdd53ac20605f2b24ae`  
**Delta since prior audit:** **0 commits** — this engagement re-verifies the same tip independently.  
**Date:** 2026-11-18  
**Production code changes:** none (evidence and documentation only)

---

## 1. Scope

Independent verification of Nexus Agent Skills architecture: discovery, ranking, activation, authorization interaction, integrity, trust/supply chain, lifecycle, evidence, and controlled adversarial characterization. No production feature implementation.

Out of scope: publishing, merging, gateway inference evaluation, credential inspection, full `make test` under concurrent load beyond claimed SUITE windows used here.

---

## 2. Methodology

1. Claimed slice `AUDIT_skills_architecture_2026-11-18` + SUITE; dedicated worktree from `origin/main`.
2. Isolated `HOME` / `XDG_CONFIG_HOME` / `NEXUS_STATE_DIR` for all test and adversarial runs.
3. Source tracing of skills → dispatch → spine → authority → receipts.
4. Executed existing skill and related security tests; recorded exit codes and counts.
5. Ran ADV-01..ADV-12 characterization harness (`adversarial/run_adv.mjs`).
6. Treated prior hypotheses as claims to prove or disprove; distinguished SOURCE / TEST / ADVERSARIAL evidence.
7. Confirmed via repository search ([prior-findings search](06517866-bc6b-46ce-98ce-7ea307003340)): **no committed F-01–F-05 skills-architecture audit artifact exists** — those IDs were mission-brief hypotheses only. Do not confuse with `docs/PHASE2S_SECURITY_AND_DATA_REVIEW.md` F-01–F-05 (unrelated Issue #12 topics).
8. Cross-checked a full path inventory ([skills architecture inventory](370450c7-7cf4-400e-acd3-e39aed9854be)) against the traced execution path.

Evidence: `SKILLS_AUDIT_EVIDENCE.md`, `raw/`, `adversarial/`.

---

## 3. Architecture inventory (verified)

| Concern | Primary implementation | Notes |
|---|---|---|
| Discovery / load | `cli/src/skills.ts` `SkillManager.refresh` / `scanDir` / `loadSkillFile` (~214–340) | Global dirs always trusted; workspace dirs gated by `isWorkspaceTrusted` |
| Frontmatter | `parseFrontmatter` (~347–386) | Only `name` + `description` used; other keys ignored |
| Ranking | `findSkills` BM25 (~406–436) | Trusted skills only |
| Catalog / note | `getPromptSection`, `formatSkillNote`, `run_turn.ts` ~186 | Descriptions sanitized (`oneLine`); bodies not |
| Activation | `spine_handlers.ts` `activate_skill` (~677–704); capability `capability_definitions/skill.ts` | Effect `context_inject`, non-mutating; returns body as tool output |
| Dispatch / deny untrusted | `dispatch_tool_call.ts` ~259–283 | Hard deny `UNTRUSTED_WORKSPACE_SKILL` before spine |
| Authorization | `authority.ts` `AuthorityAdmissionEngine`; wired in `agent.ts` ~434–444 | Session RO / fullAccess / grants; **not** skill-scoped |
| Approval | `approval_policy.ts`; `needs_input.ts` | Headless approvals args-bound; `isUntrustedSource` **not set** on live dispatch path |
| Confinement | `authority.ts` `confine`; `extractTargetResources` in `spine.ts` | Path tools jail; `run_command` records command string, not parsed FS targets |
| Roles / subagents | `roles.ts`, `dispatch_tool_call.ts` role allow-list; `runSubagent` | Role tools enforced; no skill identity on subagent |
| MCP / plugins | `mcp.ts` (~951 filter), `plugins.ts` | Skills ≠ plugins; plugins can register tools |
| Evidence | `ExecutionReceipt` in `spine.ts` ~95–128 | No `skillName` / digest fields |
| Persistence | Session messages + `harness: "skill-note"`; `withSkillNoteProvenance` | Activation body = tool message text only |
| Qualification reuse | `ceri/`, `regression_obligations.ts`, role qualifications | Exists for ops/eval; **not** integrated with skills |
| Role / MCP surfaces | `roles.ts` allow-lists; `mcp.ts` ~950–951 | Specialists + read-only team roles omit `activate_skill`; Nexus-as-MCP strips it |
| FS watcher | `skills.ts` `startWatcher` ~521–527 | Watches a **subset** of discovery roots (omits e.g. `.claude/skills`, `~/.config/nexus/skills`) |

Docs: `docs/SKILLS_AND_PLUGINS.md` (explicitly states `allowed-tools` grants nothing).

---

## 4. Validated findings

### F-01 Skill capability contracts — CONFIRMED (by design)

Skill frontmatter cannot declare enforceable capabilities. `allowed-tools` / `permissions` / `trusted` in YAML are not carried on the `Skill` object (`skills_agents_dir.test.ts`; ADV-01). Tool admission uses session authority (approval mode, RO, fullAccess, grants, role allow-lists), not skill metadata. A skill body can *suggest* any tool; the model may call it; runtime still enforces session policy.

**Severity:** Medium (architectural gap / maturity) — **not** a bypass of existing session controls.  
**Does not expand authority:** CONFIRMED (TEST + ADVERSARIAL).

### F-02 Skill-to-execution attribution — CONFIRMED

Activation injects instructions via tool result text. `ExecutionReceipt` has task/actor/domain/capability/tool but **no** skill name, source digest, or activation id (ADV-07). Downstream tools are not bound to an activation. Relationships after resume exist only if tool messages remain in the conversation (ADV-08).

**Severity:** Medium (auditability / forensics), not an auth bypass by itself.

### F-03 Integrity and version binding — CONFIRMED

No content digest on `Skill`. In-memory catalog sticky until `refresh` / watcher; file edit or symlink retarget changes content on refresh without invalidating prior activation text (ADV-05, ADV-06). Classic conversational TOCTOU: governing text for the *model* is whatever was injected into messages; governing file for the *next* `activate_skill` is current disk after refresh.

**Severity:** Medium (integrity / replay), Low for default single-operator trust model.

### F-04 Trust and supply chain — PARTIALLY CONFIRMED

- Global install locations are always trusted (`skills.ts` ~228–241).
- Workspace skills require workspace trust; untrusted activation denied (SOURCE + TEST).
- Symlinks followed; target outside install root still trusted if discovered via a global skill dir (ADV-06).
- No publisher identity, signature, or install attestation.
- Description sanitization strips control markers / template tokens; **activation body is raw** (ADV-04).
- Workspace trust ≠ publisher identity ≠ execution authority (documented separation largely holds).

**Severity:** Medium under shared-HOME / multi-tenant threat; Low for single-user machine with intentional global installs.

### F-05 Lifecycle qualification — CONFIRMED (missing integration)

No skill version manifest, qualification status, revocation registry, or skill-level regression harness. Watcher reload is best-effort. Existing CERI / regression obligations / role qualifications are **reusable but unused** for skills.

**Severity:** Low–Medium (maturity), not an active exploit.

### S-01 (new) `isUntrustedSource` unwired — CONFIRMED

`ApprovalPolicy` gates `context_inject` when `isUntrustedSource` is true, but `dispatch_tool_call.ts` never sets that field on `policyContext` (only unit-tested). Compensating control: untrusted *workspace* skills hard-denied before approval. Global skills never hit that gate.

**Severity:** Low (dead control path / incomplete design), given compensating deny.

### S-02 (new) Shell path vs filesystem confinement — CONFIRMED (session-level)

`extractTargetResources` treats `args.command` as a single opaque string; confinement does not parse shell operands. Under default/fullAccess, shell side effects are limited by approval mode, sandbox (if enabled), and RO allowlist — not by path jail. Skills that instruct `run_command` inherit this model (ADV-03).

**Severity:** Medium as general execution risk; skills amplify *instruction* surface only.

### S-03 (new) Skill FS watcher covers fewer roots than discovery — CONFIRMED

`refresh()` loads five home and four workspace roots; `startWatcher()` watches only five directories and omits workspace/home `.claude/skills`, `~/.config/nexus/skills`, `~/.config/opencode/skills`, and workspace `.claude/skills` (`skills.ts:229–257` vs `521–527`). Changes under unwatched roots apply only after restart, explicit refresh, or a watched sibling change that triggers `refresh`.

**Severity:** Low (reliability / stale catalog), not an auth bypass.  
**Compensating:** Next full `refresh` (workspace change, restart) reloads all roots.

---

## 5. Disproved / overstated hypotheses

| Claim | Adjudication |
|---|---|
| “Per-skill auth missing ⇒ skills bypass session policy” | **Disproven.** Session RO, review/auto, grants, role allow-lists, untrusted-workspace deny still apply (TEST + ADV). |
| “Need a parallel authorization engine for skills” | **Not supported.** Extend `AuthorityAdmissionEngine` + receipts + optional skill constraint intersection. |
| “Receipts cannot establish any attribution” | **Overstated.** Receipts establish tool/task/actor; skill linkage is missing, not all evidence. |
| “Prior audit tip is stale vs main” | **Disproven for this run.** `origin/main` == prior baseline. |
| “A prior written F-01–F-05 skills audit exists in-repo” | **Disproven.** Hypotheses lived only in the mission brief; no `docs/`/`tasks/` write-up found. |

Additional compensating controls (inventory-confirmed): specialist and read-only role allow-lists refuse `activate_skill`; serve-MCP hides `activate_skill`; checkpoint read-only fallback can block `context_inject`.

---

## 6. Residual uncertainties

1. Full `make test` / CI matrix not re-run end-to-end in this engagement (SUITE used for targeted suites only).
2. Interactive `onConfirm` post-approve argument mutation across async boundaries not fuzzed beyond single-dispatch analysis (ADV-12 headless binding OK).
3. Live model compliance with skill instructions not measured (prompt injection is not an execution boundary).
4. Docker/bubblewrap sandbox effectiveness against skill-driven shell not re-qualified here.
5. GitHub Issues/PRs for skills not enumerated (`gh` unauthenticated in this environment).
6. Background phrase searches for older transcript copies of F-01–F-05 were SIGTERM’d; the completed repo search is treated as authoritative for committed artifacts.

---

## 7. Security implications

Skills are **untrusted instructional text** with discovery trust based on install location. They do not register capabilities. The dangerous surface is: (a) trusted global install of malicious instructions, (b) model following those instructions under a permissive session (auto/`--yes`), (c) weak forensic binding of what skill text was active. Session authorization remains the execution boundary; prompt sanitization is not.

---

## 8. Operational implications

- Treat `~/.agents/skills` and friends as code you run with your agent’s authority.
- Prefer review mode or RO for untrusted skill experiments.
- Do not expect skill frontmatter to constrain tools.
- Forensics of “which skill caused this” currently requires message archaeology.

---

## 9. Final assessment

The skills subsystem is **functionally coherent** for Agent Skills compatibility (discovery, ranking, bounded catalog, activate-as-context, workspace trust gating) and has **solid session-level execution controls**. It is **not** a governed skill execution platform: no per-skill capability contracts, no durable activation identity/digest, no skill lifecycle/qualification, incomplete provenance on receipts.

**Verdict:** Safe to continue shipping skills as instructional extensions under existing session policy. Proceed with **incremental governed-skills work packages** (see implementation plan) prioritized for auditability and optional constraint intersection — **not** a parallel security stack. No immediate critical defect requiring emergency hotfix was demonstrated.

**Do not claim:** “skills are production-hardened with enforceable contracts” or “skill execution is fully attributable.”
