export type HirStatus =
  | "CREATED"
  | "BASELINING"
  | "PROPOSING"
  | "GATING"
  | "PROBING"
  | "COMPARING"
  | "COMPOSING"
  | "REFLECTING"
  | "WAITING_OPERATOR"
  | "PAUSED"
  | "BLOCKED"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";

export type HarnessComponentKind =
  | "system_prompt"
  | "skill"
  | "config_overlay"
  | "tool_policy"
  | "approval_policy"
  | "sandbox_policy"
  | "other";

export interface HarnessComponent {
  kind: HarnessComponentKind;
  path: string;
  contentHash: string;
  bytes: number;
  mutable: boolean;
}

export interface HarnessManifest {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  source: { kind: "fixture" | "path" | "profile"; ref: string };
  components: HarnessComponent[];
  metadata?: { profile?: string; model?: string; tags?: string[] };
}

export interface HirBudgets {
  maxRounds: number;
  maxCandidatesPerRound: number;
  maxProbes: number;
  maxWallClockMs: number;
  maxProbeWallClockMs: number;
  maxTokens?: number;
  maxConcurrentProbes: number;
}

export interface HirPolicy {
  allowLiveProfileMutation: false;
  allowRepoMutation: false;
  allowNetwork: false;
  redactSecrets: true;
  approvalModePinned: "pinned";
}

export interface HirRound {
  round: number;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "BLOCKED";
  baselineProbeIds: string[];
  candidateIds: string[];
  successorCandidateId?: string;
  selectedCandidateId?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface HarnessImprovementRun {
  schemaVersion: 1;
  id: string;
  status: HirStatus;
  createdAt: string;
  updatedAt: string;
  baseHarnessId: string;
  taskSuiteRef: string;
  budgets: HirBudgets;
  policy: HirPolicy;
  rounds: HirRound[];
  candidateIds: string[];
  probeIds: string[];
  evidenceIds: string[];
  promotionReportId?: string;
  reason?: string;
  nextAction?: string;
  actualUsage: { probes: number; wallClockMs: number; tokens: number };
}

export interface HirTaskCase {
  id: string;
  description: string;
  prompt: string;
  tags?: string[];
  expected?: {
    verifierCommand?: string;
    artifactPath?: string;
    rubricRef?: string;
  };
}

export interface HirTaskSuite {
  schemaVersion: 1;
  id: string;
  cases: HirTaskCase[];
}

export interface HarnessCandidate {
  schemaVersion: 1;
  id: string;
  runId: string;
  round: number;
  parentId?: string;
  baseHarnessId: string;
  treeRef: string;
  diffRef: string;
  proposal: {
    source: "human" | "agent" | "imported";
    rationale: string;
    targetWeaknesses: string[];
  };
  gate: {
    status: "PENDING" | "PASS" | "FAIL";
    findings: Array<{ severity: "info" | "warn" | "error"; code: string; message: string; path?: string }>;
  };
}

export interface ProbeResult {
  schemaVersion: 1;
  id: string;
  runId: string;
  candidateId: string;
  caseId: string;
  status: "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED" | "BLOCKED";
  startedAt: string;
  endedAt: string;
  metrics: {
    wallClockMs: number;
    tokens: number;
    toolErrors: number;
    verifierPass: boolean | null;
    score: number | null;
  };
  artifacts: {
    trajectoryRef?: string;
    stdoutRef?: string;
    stderrRef?: string;
    diffRef?: string;
  };
  observations: string[];
}

export interface HirEvidenceRecord {
  schemaVersion: 1;
  id: string;
  runId: string;
  kind: "baseline" | "probe" | "comparison" | "gate" | "composition" | "reflection" | "operator_decision";
  subjectId: string;
  summary: string;
  refs: string[];
  confidence: "high" | "medium" | "low";
  deterministic: boolean;
  createdAt: string;
}

export interface PromotionChange {
  componentPath: string;
  changeType: "add" | "modify" | "remove";
  recommendation: "apply" | "review" | "reject";
  evidenceIds: string[];
  risks: string[];
}

export interface PromotionReport {
  schemaVersion: 1;
  id: string;
  runId: string;
  baseHarnessId: string;
  recommendedCandidateId?: string;
  status: "DRAFT" | "READY_FOR_REVIEW" | "ACCEPTED" | "REJECTED" | "DEFERRED";
  createdAt: string;
  changes: PromotionChange[];
  scorecard: ScorecardEntry[];
  applyInstructions: string[];
  nonPromotable: string[];
  noApplyWarning: string;
}

export interface ScorecardEntry {
  candidateId: string;
  caseId: string;
  dimension: "correctness" | "safety" | "reliability" | "efficiency" | "behavioral_quality";
  label: "deterministic" | "advisory";
  baseValue: unknown;
  candidateValue: unknown;
  delta?: string;
  verdict: "better" | "worse" | "same" | "unknown";
  evidenceIds: string[];
}

export interface HirEvent {
  schemaVersion: 1;
  id: string;
  runId: string;
  type: string;
  at: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface HarnessLibraryEntry {
  schemaVersion: 1;
  id: string; // hlesson_*
  runId: string;
  createdAt: string;
  updatedAt: string;
  status: "draft" | "accepted" | "rejected";
  scope: { baseHarnessId?: string; profile?: string; tags?: string[] };
  statement: string;
  evidenceIds: string[];
  confidence: "high" | "medium" | "low";
  recommendation?: "apply" | "review" | "reject";
  candidateId?: string;
  reportId?: string;
}
