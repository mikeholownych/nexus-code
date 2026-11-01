import type { InvestigationFinding, EpistemologicalType } from "./contracts.js";

export class InvestigationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvestigationValidationError";
  }
}

export interface InvestigationReport {
  investigationId: string;
  targetRunId: string;
  baselineId: string;
  findings: InvestigationFinding[];
  summary: string;
  hasUnresolvedUncertainty: boolean;
  createdAt: string;
}

export class CeriInvestigationCoordinator {
  /**
   * Validates that an investigation finding adheres to epistemological discipline:
   * Any INFERENCE or CONFIRMED_FINDING must cite at least one explicit evidence reference.
   */
  static validateFinding(finding: InvestigationFinding): void {
    if (!finding.id || typeof finding.id !== "string") {
      throw new InvestigationValidationError("Finding missing valid 'id'");
    }
    if (!finding.type || typeof finding.type !== "string") {
      throw new InvestigationValidationError("Finding missing valid 'type'");
    }
    if (!finding.description || typeof finding.description !== "string") {
      throw new InvestigationValidationError("Finding missing valid 'description'");
    }

    if (
      (finding.type === "INFERENCE" || finding.type === "CONFIRMED_FINDING") &&
      (!Array.isArray(finding.evidenceReferences) || finding.evidenceReferences.length === 0)
    ) {
      throw new InvestigationValidationError(
        `Finding '${finding.id}' of type '${finding.type}' must cite at least one valid evidence reference`
      );
    }
  }

  /**
   * Constructs a structured investigation report, verifying that findings
   * maintain a clear boundary between observation, hypothesis, and confirmed reality.
   */
  static createReport(params: {
    investigationId: string;
    targetRunId: string;
    baselineId: string;
    findings: InvestigationFinding[];
    summary: string;
  }): InvestigationReport {
    // Validate each finding
    for (const f of params.findings) {
      this.validateFinding(f);
    }

    const hasUnresolvedUncertainty = params.findings.some(
      (f) => f.type === "UNRESOLVED_UNCERTAINTY"
    );

    return {
      investigationId: params.investigationId,
      targetRunId: params.targetRunId,
      baselineId: params.baselineId,
      findings: [...params.findings],
      summary: params.summary,
      hasUnresolvedUncertainty,
      createdAt: new Date().toISOString(),
    };
  }
}
