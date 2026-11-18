# Governed Skills — Remediation Architecture

**Baseline current:** `3c54e601` skills as instructional context  
**Goal:** Optional governance layer that reuses Nexus spine/authority/evidence — not a parallel engine.

---

## 1. Current vs proposed

| Dimension | Current | Proposed |
|---|---|---|
| Activation | Tool result text only | Structured activation record + tool result |
| Content identity | Path + in-memory body | SHA-256 digest of normalized body (+ path, source class) |
| Capability | Session only | Session ∩ optional skill constraints (never ∪ expand) |
| Attribution | Infer from messages | `skillActivationId` on subsequent receipts while active |
| Lifecycle | File watcher refresh | Local manifest state: digest, qualified?, revoked? |
| Evidence | ExecutionReceipt without skill fields | Extend receipt / evidenceEmission hook |
| Compatibility | Agent Skills name/description | Additive optional frontmatter; ignore unknown; never grant from skill alone |

---

## 2. Component reuse

| Need | Reuse |
|---|---|
| Admission / confinement | `AuthorityAdmissionEngine` — add optional constraint intersection in `admit` |
| Dispatch | `dispatch_tool_call.ts` — attach active activation to context |
| Spine / receipts | `ExecutionSpine` / `ExecutionReceipt` — additive fields |
| Needs-input | Existing args hashing for approvals |
| Sanitization | `oneLine` / injection scanner — keep for prompt boundary |
| Qualification patterns | CERI evidence store patterns; `regression_obligations` style invalidation |
| Trust | `workspace_trust` — unchanged semantics |
| Peer inspiration (OpenCode) | Skill tool policy refuse-before-load (approach only; MIT; do not copy) |

**Ruled out:** new auth microservice, new log bus, mandatory remote registry.

---

## 3. Proposed interfaces

```ts
/** Informational vs enforced: only listed fields are enforced when present. */
interface SkillManifestV1 {
  name: string;
  description: string;
  // ENFORCED when present — intersected with session authority; never expands it
  allowedCapabilities?: string[];      // capability ids or tool names
  deniedCapabilities?: string[];
  resourceScope?: "workspace" | "subtree";
  resourceRoots?: string[];            // only if subtree
  // INFORMATIONAL
  version?: string;
  license?: string;
  compatibility?: string[];
}

interface SkillActivation {
  activationId: string;                // uuid
  skillName: string;
  sourcePath: string;
  sourceClass: "global" | "workspace";
  contentDigest: string;               // sha256 of body bytes used
  activatedAt: string;
  taskId: string;
  constraints: ResolvedSkillConstraints; // normalized from manifest or "unconstrained"
  status: "active" | "revoked" | "superseded";
}

// Additive on ExecutionReceipt:
// skillActivationId?: string;
// skillName?: string;
// skillContentDigest?: string;
```

Compatibility: skills without constraint fields ⇒ `constraints = unconstrained` (current behavior). Document explicitly; **do not** invent default allowlists that widen or silently tighten mid-release without a flag.

---

## 4. Authority composition

```
effective = sessionAuthority
if (activeActivation?.constraints)
  effective = intersect(effective, constraints)
// skill constraints MUST NOT admit what session denied
```

Enforcement points:

1. `dispatch_tool_call` — refuse tools outside skill allowlist when constrained activation active (before approval).
2. `AuthorityAdmissionEngine.admit` — second check with activation context.
3. `confine` — intersect resource roots when skill declares subtree.

Revocation: mark activation `revoked`; further tools with that id denied; conversation text may remain (label as superseded).

---

## 5. Execution identity

- Create `SkillActivation` inside `activate_skill` handler after successful load.
- Store on agent: `activeSkillActivations: Map<id, SkillActivation>` and optional “current” pointer.
- Pass `skillActivationId` through `InvocationRequest` / dispatch context.
- Clear or supersede on explicit deactivate, task end, or digest mismatch policy.

---

## 6. Integrity model

On activate:

1. `realpath` skill file; record path + digest(body).
2. Refuse activate if file missing / unreadable (fail closed).
3. Optional: refuse if digest ≠ last qualified digest (when qualification enabled).

On refresh/watcher: update catalog; do not mutate past activation digests. Policy choice (flag):

- `skill-integrity=sticky` (default): keep using activation digest for attribution; re-activate to pick up changes.
- `skill-integrity=live`: warn/block tools if file digest ≠ activation digest.

---

## 7. Lifecycle model (local-first)

```
install/discover → (optional) qualify → advertise → activate → execute → revoke/rollback
```

Local state under `NEXUS_STATE_DIR/skills/`:

- `index.json` — name → last digest, sourceClass, qualifiedAt, revoked
- No network required

Qualification = run skill fixture tests (expected tool sequence negatives) offline; store pass digest.

---

## 8. Evidence model

- Emit activation via `evidenceEmission` / flight recorder: activation record (no secrets).
- Link tool receipts with `skillActivationId`.
- Redact skill bodies in durable stores by default; store digest + path; optional operator opt-in to keep body snapshot.

---

## 9. Failure handling

| Failure | Behavior |
|---|---|
| Missing skill file at activate | Deny activate |
| Constraint parse error | Deny activate (fail closed) if enforcement flag on; else ignore constraints with warning |
| Unknown capability in allowlist | Deny activate or drop unknown with warning (choose in WP; prefer deny when enforcing) |
| Auth hook exception | Existing spine FAIL-001 (fail closed) |
| Revoked activation | Deny tools attributed to it |
| Unconstrained legacy skill | Current behavior |

---

## 10. What not to build

- Central skill app store / mandatory signatures for OSS local use
- Parallel authorization engine
- Treating prompt sanitization as capability enforcement
- Silently granting tools because a skill listed them
