import type { RemediationProposal } from "./contracts.js";

export class SelfApprovalForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfApprovalForbiddenError";
  }
}

export class RemediationProposalManager {
  /**
   * Creates a new reviewable remediation proposal initialized to PENDING_REVIEW status.
   */
  static createProposal(params: {
    id: string;
    targetIssue: string;
    authorAgent: string;
    reproductionSteps: string[];
    proposedDiff: string;
    testRecommendations: string[];
  }): RemediationProposal {
    return {
      id: params.id,
      targetIssue: params.targetIssue,
      authorAgent: params.authorAgent,
      reproductionSteps: [...params.reproductionSteps],
      proposedDiff: params.proposedDiff,
      testRecommendations: [...params.testRecommendations],
      approvalStatus: "PENDING_REVIEW",
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Reviews and records a verdict on a remediation proposal.
   * Strictly enforces that the author agent may NOT approve its own proposal.
   */
  static reviewProposal(
    proposal: RemediationProposal,
    reviewerAgent: string,
    decision: "APPROVED" | "REJECTED",
    rationale: string
  ): RemediationProposal {
    if (!reviewerAgent || typeof reviewerAgent !== "string" || !reviewerAgent.trim()) {
      throw new Error("Reviewer agent identifier is required");
    }

    if (proposal.approvalStatus !== "PENDING_REVIEW") {
      throw new Error(
        `Cannot review proposal '${proposal.id}': current status is '${proposal.approvalStatus}', expected 'PENDING_REVIEW'`
      );
    }

    const normReviewer = reviewerAgent.trim().toLowerCase();
    const normAuthor = proposal.authorAgent.trim().toLowerCase();

    if (decision === "APPROVED" && normReviewer === normAuthor) {
      throw new SelfApprovalForbiddenError(
        `Author agent '${proposal.authorAgent}' cannot approve its own remediation proposal '${proposal.id}'. Independent review required.`
      );
    }

    return {
      ...proposal,
      approvalStatus: decision,
      reviewerAgent: reviewerAgent.trim(),
      reviewDecisionRationale: rationale,
    };
  }
}
