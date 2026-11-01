# Nexus Code v1.1.2 Implementation Plan: Specialist Orchestration & Independent Review

**Document ID:** `NEXUS-PLAN-V112`  
**Author:** Principal Software Architect & Senior Implementation Engineer  
**Status:** Approved for Implementation  
**Base Revision:** `origin/main` (`9a3d8787`)  

---

## 1. Architectural Strategy & Phasing

To maintain production stability and backward compatibility, the implementation proceeds in five ordered vertical slices:

```
┌─────────────────────────────────────────────────────────────┐
│ Slice 1: Specialist Agent Contracts & Profiles (Foundation) │
│ - Typed SpecialistContract schema                           │
│ - Tool permission whitelists per specialist                 │
│ - Structured output envelope                                │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ Slice 2: Objective Independent Review Boundary (Integrity)  │
│ - buildReviewEvidencePackage (strips narrative)             │
│ - Strict IndependentReviewVerdict schema                    │
│ - Verification gating rules                                 │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ Slice 3: Deterministic Micro-Routing Engine (Efficiency)    │
│ - Rule-based fast-path matching for non-semantic queries    │
│ - Constrained model-assisted routing fallback               │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ Slice 4: Multi-Stage Escalation State Machine (Resilience)  │
│ - Repeat failure detection & diagnostic routing             │
│ - Deep reasoning escalation path (Qwen3.5-27B)              │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ Slice 5: Telemetry-Informed Concurrency Throttle & Harness  │
│ - Dynamic slot throttle under worker latency pressure       │
│ - Comparative benchmark harness                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Slice 1: Specialist Agent Contracts & Profiles

### 2.1 Modules & Files Changed
- **New Module:** `cli/src/core/specialist_profiles.ts`
- **Updated Module:** `cli/src/core/roles.ts` (exporting expanded roles and contracts)
- **New Tests:** `cli/test/specialist_profiles.test.ts`

### 2.2 Data Contracts & Interfaces
```ts
export type SpecialistRole =
  | "semantic_explorer"
  | "call_site_analyzer"
  | "failure_debugger"
  | "security_reviewer"
  | "acceptance_reviewer";

export interface SpecialistContract {
  role: SpecialistRole;
  title: string;
  description: string;
  permittedTools: readonly string[];
  readOnly: boolean;
  maxContextTokens: number;
  inputRequirements: readonly string[];
  outputSchemaName: string;
}

export interface SpecialistStructuredOutput<T = unknown> {
  specialistRole: SpecialistRole;
  status: "SUCCESS" | "FAILED" | "INCONCLUSIVE";
  findings: T;
  evidence: Array<{ path: string; lineRange?: [number, number]; note: string }>;
  tokenConsumption?: { prompt: number; completion: number };
}
```

### 2.3 Invariants & Security
- A specialist assigned to a unit cannot execute tools outside `permittedTools`. If a prohibited tool is called, the execution harness fails-closed with code `E_TOOL_DISALLOWED`.
- Read-only specialists (`readOnly: true`) strictly enforce `--read-only` flag on the runner.

---

## 3. Slice 2: Objective Independent Review Boundary

### 3.1 Modules & Files Changed
- **New Module:** `cli/src/core/independent_review.ts`
- **Updated Module:** `cli/src/core/operation_runner_execution.ts` (using objective evidence package when building reviewer prompts)
- **New Tests:** `cli/test/independent_review.test.ts`

### 3.2 Data Contracts & Interfaces
```ts
export interface ReviewEvidencePackage {
  operationId: string;
  unitId: string;
  objective: string;
  authorizedScope: readonly string[];
  baselineCommit: string;
  candidateCommit?: string;
  unifiedDiff: string;
  verifierOutput?: string;
  testPassRate?: { passed: number; failed: number; total: number };
}

export interface IndependentReviewVerdict {
  verdict: "ACCEPT" | "REJECT";
  verifiedObservations: string[];
  suspectedDefects: Array<{ path: string; line?: number; description: string }>;
  unprovenCriteria: string[];
  scopeViolations: string[];
}
```

### 3.3 Confirmation Bias Mitigation
- `buildReviewEvidencePackage`:
  - Strips all free-form text narratives authored by the implementer.
  - Injects only: (1) Objective requirements, (2) authorized file paths, (3) Git unified diff, (4) raw compiler/test runner stdout/stderr.
  - Reviewer prompt states: `"You are evaluating the raw code changes and test evidence independently. The implementer's self-assessed completion notes have been intentionally redacted."`

---

## 4. Slice 3: Deterministic Micro-Routing Engine

### 4.1 Modules & Files Changed
- **New Module:** `cli/src/core/micro_router.ts`
- **New Tests:** `cli/test/micro_router.test.ts`

### 4.2 Interfaces
```ts
export type RoutingDecisionKind = "DETERMINISTIC_FASTPATH" | "SPECIALIST_DELEGATION" | "GENERAL_MODEL";

export interface RoutingDecision {
  kind: RoutingDecisionKind;
  matchedRule?: string;
  targetTool?: string;
  targetRole?: string;
  reason: string;
  confidence: number;
}
```

---

## 5. Persistence, State, & Migration Implications

- **Schema Stability:** The operation persistence schema (`cli/src/core/operation.ts`) remains on **`schemaVersion: 2`**.
- Specialist contracts and review packages operate cleanly within existing `OperationMessage` (kinds `"artifact"` and `"verdict"`) and `WorkUnit` models.
- No schema migration required from v1.1.1 or v1.1.2-rc.1.

---

## 6. Verification Milestones

1. **Milestone 1 (Specialist Profiles):** `specialist_profiles.test.ts` passes with 100% test coverage; tool whitelist rejections validated.
2. **Milestone 2 (Review Boundary):** `independent_review.test.ts` passes; implementer narrative redaction verified; structured verdict parsing verified.
3. **Milestone 3 (Micro-Router):** `micro_router.test.ts` passes; rule-based queries execute without LLM round-trips.
4. **Milestone 4 (Full Regression):** Complete existing test suite (`npm --prefix cli test`) runs without regressions.
