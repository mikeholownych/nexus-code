# Continuous Evaluation and Regression Intelligence (CERI) Technical Implementation Plan

**Document ID:** `NEXUS-PLAN-V112-CERI`  
**Target Release:** Nexus Code `v1.1.2`  
**Author:** Principal Software Architect, Reliability Engineer, & Implementation Lead  
**Date:** 2026-11-01  
**Status:** Approved for Implementation  

---

## 1. System Architecture & Component Boundaries

The CERI implementation establishes an evidence-driven control plane for qualification without mutating core operation persistence or introducing external heavyweight services.

```
cli/src/ceri/
├── contracts.ts          # Versioned evaluation schemas, manifests, and classifications
├── evidence_store.ts     # Append-only persistence, secret redaction, and hash chaining
├── baseline.ts           # Baseline registration, comparability validation, and 12-state comparator
├── investigation.ts      # Epistemologically structured regression investigation findings
├── remediation.ts        # Controlled remediation proposal generator with approval boundaries
├── scheduler.ts          # Intel Arc Pro dual-worker capacity and concurrency control
├── reporting.ts          # Machine-readable JSON and human-readable Markdown reporting
└── runner.ts             # Deterministic evaluation runner and manifest synthesizer
```

---

## 2. Core Interfaces & Contracts (`cli/src/ceri/contracts.ts`)

### 2.1 Versioned Evaluation Definition
```ts
export type CapabilityDomain =
  | "code_comprehension"
  | "scoped_implementation"
  | "multi_file_refactoring"
  | "dependency_analysis"
  | "tool_selection"
  | "context_compaction"
  | "session_persistence"
  | "retry_backoff"
  | "rate_limit_recovery"
  | "model_escalation"
  | "specialist_delegation"
  | "independent_review"
  | "authorization_enforcement"
  | "workspace_isolation";

export interface EvaluationDefinition {
  id: string;
  version: string;
  domain: CapabilityDomain;
  objective: string;
  fixturePath: string;
  initialCommit?: string;
  expectedOutputs: string[];
  authorizedTools: string[];
  executionBudget: {
    maxSteps: number;
    timeoutSeconds: number;
    maxTokens?: number;
  };
  deterministicAssertions: Array<{
    id: string;
    description: string;
    command?: string;
    expectedExitCode?: number;
    expectedStdoutPattern?: string;
  }>;
  independentValidationCriteria: string[];
  knownNondeterminism?: string[];
}
```

### 2.2 Run Manifest & Provenance
```ts
export interface RunManifest {
  runId: string;
  evaluationId: string;
  evaluationVersion: string;
  sourceCommit: string;
  dirtyWorktree: boolean;
  uncommittedDiffHash?: string;
  model: {
    name: string;
    digest?: string;
    quantization?: string;
    parameters: {
      temperature: number;
      topP?: number;
      maxTokens?: number;
      seed?: number;
    };
  };
  routingConfig: {
    gatewayUrl: string;
    taskClass?: string;
    specialistRouting: boolean;
  };
  agentProfileVersion: string;
  harnessVersion: string;
  toolchainVersions: Record<string, string>;
  environment: {
    os: string;
    kernel: string;
    nodeVersion: string;
    bubblewrapVersion?: string;
  };
  hardware: {
    cpuModel: string;
    gpuModel?: string;
    totalMemoryBytes: number;
  };
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status: "RUNNING" | "COMPLETED" | "INTERRUPTED" | "FAILED" | "CANCELLED";
  terminationReason?: string;
  mandatoryComparabilityKeys: string[];
}
```

### 2.3 12-State Comparative Classification
```ts
export type ComparativeOutcome =
  | "PASS"
  | "FAIL"
  | "REGRESSION_CANDIDATE"
  | "CONFIRMED_REGRESSION"
  | "IMPROVEMENT_CANDIDATE"
  | "FLAKY"
  | "INFRASTRUCTURE_FAILURE"
  | "EVALUATOR_DEFECT"
  | "INCONCLUSIVE"
  | "NOT_EXECUTED"
  | "CANCELLED"
  | "INCOMPARABLE";

export interface BaselineComparisonResult {
  baselineId: string;
  currentRunId: string;
  isEligibleForComparison: boolean;
  incomparabilityReasons?: string[];
  outcome: ComparativeOutcome;
  divergences: Array<{
    assertionId: string;
    baselineStatus: "PASS" | "FAIL";
    currentStatus: "PASS" | "FAIL";
    details: string;
  }>;
  confidence: number;
  explanation: string;
}
```

---

## 3. Evidence Storage & Integrity (`cli/src/ceri/evidence_store.ts`)

1. **Storage Layout:**
   Evidence is written to `<evidenceDir>/<evaluationId>/<runId>/`:
   - `manifest.json`: Atomic run manifest.
   - `events.jsonl`: Append-only event stream (turn starts, tool calls, model calls).
   - `assertions.json`: Deterministic assertion outputs and raw exit codes.
   - `receipts.json`: Independently verifiable candidate receipts (`ValidationReceipt`).
   - `integrity.json`: Hash-chain linking all artifacts in the run.
2. **Atomic Writes:**
   All summary JSON files are written first to `.tmp.<filename>.<pid>` and atomically renamed (`fs.renameSync`) to guarantee that partial writes are never presented as complete.
3. **Secret Redaction:**
   All outputs and logs pass through `redactSecrets` from `cli/src/evidence.ts` prior to filesystem persistence.
4. **Interrupted Run Detection:**
   If a run directory has `manifest.json` with `status: "RUNNING"` and no `completedAt`, the store flags it as `INTERRUPTED` on startup.

---

## 4. Baseline Comparability Rules (`cli/src/ceri/baseline.ts`)

Two runs are eligible for direct baseline comparison if and only if:
1. `evaluationId` matches exactly.
2. `evaluationVersion` matches exactly.
3. `model.name` matches exactly.
4. `model.quantization` matches exactly (or neither specifies one).
5. Neither run was performed on an unrecorded dirty worktree (`dirtyWorktree: false` or matching `uncommittedDiffHash`).
6. Core runtime environment (Node.js major version and OS) are compatible.

If any check fails, the result is classified as `INCOMPARABLE` with explicit `incomparabilityReasons`.

---

## 5. Regression Intelligence & Epistemological Boundaries (`cli/src/ceri/investigation.ts`)

To prevent model hallucination from contaminating defect analysis:
1. Every entry in an investigation must carry an explicit type:
   - `OBSERVATION`: Direct fact verified by log line, exit code, or diff.
   - `INFERENCE`: Logical conclusion derived directly from observations.
   - `HYPOTHESIS`: Unproven potential root cause.
   - `CONFIRMED_FINDING`: Hypothesis proven via isolated rerun or test reproduction.
   - `UNRESOLVED_UNCERTAINTY`: Explicitly stated unknowns.
2. Every `INFERENCE` or `CONFIRMED_FINDING` must cite at least one `evidenceReference` (hash, file path, line number, or receiptId).
3. The investigator is barred from mutating evaluation definitions or designated baselines.

---

## 6. Remediation Proposal Boundaries (`cli/src/ceri/remediation.ts`)

1. Remediation proposals generated by agents must carry:
   - `approvalStatus: "PENDING_REVIEW"`.
   - `authorAgent`: Identifier of the generating agent.
2. Under no circumstances may an agent approve its own proposal (`authorAgent !== reviewerAgent`).
3. Modifying an evaluation fixture or assertion requires a distinct `EVALUATION_DEFINITION_MUTATION` proposal that cannot be bundled with candidate code fixes.

---

## 7. Verification Milestones

1. **Milestone 1:** Unit tests for versioned evaluation contracts, manifests, and definition validation (`cli/test/ceri_contracts.test.ts`).
2. **Milestone 2:** Append-only evidence store with atomic writes, secret redaction, tamper-proof hash chains, and interrupted run recovery (`cli/test/ceri_evidence_store.test.ts`).
3. **Milestone 3:** Baseline comparator enforcing eligibility rules and 12-state classification (`cli/test/ceri_baseline.test.ts`).
4. **Milestone 4:** Regression intelligence epistemological typing and remediation non-self-approval boundary (`cli/test/ceri_investigation.test.ts`).
5. **Milestone 5:** End-to-end evaluation runner producing complete machine-readable reports (`cli/test/ceri_e2e.test.ts`).
