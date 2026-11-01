import { createHash } from "node:crypto";

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

export interface DeterministicAssertion {
  id: string;
  description: string;
  command?: string;
  expectedExitCode?: number;
  expectedStdoutPattern?: string;
}

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
  deterministicAssertions: DeterministicAssertion[];
  independentValidationCriteria: string[];
  knownNondeterminism?: string[];
}

export interface ModelMetadata {
  name: string;
  digest?: string;
  quantization?: string;
  parameters: {
    temperature: number;
    topP?: number;
    maxTokens?: number;
    seed?: number;
  };
}

export interface EnvironmentMetadata {
  os: string;
  kernel: string;
  nodeVersion: string;
  bubblewrapVersion?: string;
}

export interface HardwareMetadata {
  cpuModel: string;
  gpuModel?: string;
  totalMemoryBytes: number;
}

export type RunStatus = "RUNNING" | "COMPLETED" | "INTERRUPTED" | "FAILED" | "CANCELLED";

export interface RunManifest {
  runId: string;
  evaluationId: string;
  evaluationVersion: string;
  sourceCommit: string;
  dirtyWorktree: boolean;
  uncommittedDiffHash?: string;
  model: ModelMetadata;
  routingConfig: {
    gatewayUrl: string;
    taskClass?: string;
    specialistRouting: boolean;
  };
  agentProfileVersion: string;
  harnessVersion: string;
  toolchainVersions: Record<string, string>;
  environment: EnvironmentMetadata;
  hardware: HardwareMetadata;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status: RunStatus;
  terminationReason?: string;
  mandatoryComparabilityKeys: string[];
}

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

export interface BaselineSpecification {
  baselineId: string;
  evaluationId: string;
  evaluationVersion: string;
  sourceCommit: string;
  modelName: string;
  modelQuantization?: string;
  selectionRationale: string;
  manifestSha256: string;
  establishedAt: string;
}

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

export type EpistemologicalType =
  | "OBSERVATION"
  | "INFERENCE"
  | "HYPOTHESIS"
  | "CONFIRMED_FINDING"
  | "UNRESOLVED_UNCERTAINTY";

export interface InvestigationFinding {
  id: string;
  type: EpistemologicalType;
  description: string;
  evidenceReferences: string[];
  timestamp: string;
}

export interface RemediationProposal {
  id: string;
  targetIssue: string;
  authorAgent: string;
  reproductionSteps: string[];
  proposedDiff: string;
  testRecommendations: string[];
  approvalStatus: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  reviewerAgent?: string;
  reviewDecisionRationale?: string;
  createdAt: string;
}

export interface CeriOperationalReport {
  reportId: string;
  generatedAt: string;
  evaluationCoverage: {
    totalEvaluations: number;
    executedRuns: number;
    passedRuns: number;
    failedRuns: number;
  };
  baselineId?: string;
  regressions: {
    confirmed: string[];
    candidates: string[];
  };
  inconclusiveCount: number;
  flakyCount: number;
  infrastructureFailures: number;
  blockers: string[];
  evidenceCompletenessScore: number;
  limitations: string[];
}

/**
 * Validates that an EvaluationDefinition satisfies all structural requirements.
 */
export function validateEvaluationDefinition(def: unknown): EvaluationDefinition {
  if (!def || typeof def !== "object") {
    throw new Error("Evaluation definition must be a non-null object");
  }
  const d = def as Partial<EvaluationDefinition>;
  if (!d.id || typeof d.id !== "string") throw new Error("Evaluation definition missing valid 'id'");
  if (!d.version || typeof d.version !== "string") throw new Error("Evaluation definition missing valid 'version'");
  if (!d.domain || typeof d.domain !== "string") throw new Error("Evaluation definition missing valid 'domain'");
  if (!d.objective || typeof d.objective !== "string") throw new Error("Evaluation definition missing valid 'objective'");
  if (!Array.isArray(d.authorizedTools)) throw new Error("Evaluation definition 'authorizedTools' must be an array");
  if (!d.executionBudget || typeof d.executionBudget.maxSteps !== "number" || typeof d.executionBudget.timeoutSeconds !== "number") {
    throw new Error("Evaluation definition missing valid 'executionBudget'");
  }
  if (!Array.isArray(d.deterministicAssertions)) {
    throw new Error("Evaluation definition 'deterministicAssertions' must be an array");
  }
  return d as EvaluationDefinition;
}

/**
 * Computes a deterministic SHA-256 hash for any serializable payload.
 */
export function computePayloadHash(payload: unknown): string {
  const json = JSON.stringify(payload, Object.keys(payload as any).sort());
  return createHash("sha256").update(json).digest("hex");
}
