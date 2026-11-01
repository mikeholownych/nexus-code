import test from "node:test";
import assert from "node:assert/strict";
import {
  RemediationProposalManager,
  SelfApprovalForbiddenError,
} from "../src/ceri/remediation.js";

test("RemediationProposalManager initializes proposal to PENDING_REVIEW", () => {
  const proposal = RemediationProposalManager.createProposal({
    id: "prop-01",
    targetIssue: "AST visitor missed async methods",
    authorAgent: "Failure-Debugger-Agent",
    reproductionSteps: ["Run eval-code-comp-01"],
    proposedDiff: "+ if (node.isAsync) { ... }",
    testRecommendations: ["Add async method test case in parser.test.ts"],
  });

  assert.equal(proposal.id, "prop-01");
  assert.equal(proposal.approvalStatus, "PENDING_REVIEW");
  assert.equal(proposal.authorAgent, "Failure-Debugger-Agent");
});

test("RemediationProposalManager rejects author self-approval", () => {
  const proposal = RemediationProposalManager.createProposal({
    id: "prop-02",
    targetIssue: "Memory leak in queue",
    authorAgent: "Agent-X",
    reproductionSteps: ["Run queue test"],
    proposedDiff: "+ queue.clear()",
    testRecommendations: ["Verify queue empty"],
  });

  // Author agent tries to approve its own proposal
  assert.throws(
    () =>
      RemediationProposalManager.reviewProposal(
        proposal,
        "Agent-X", // Self-approval!
        "APPROVED",
        "Looks good to me"
      ),
    SelfApprovalForbiddenError
  );

  // Self-approval with whitespace and case variations must also be rejected
  assert.throws(
    () =>
      RemediationProposalManager.reviewProposal(
        proposal,
        "  agent-x  ", // Normalized match!
        "APPROVED",
        "Looks good"
      ),
    SelfApprovalForbiddenError
  );
});

test("RemediationProposalManager permits independent reviewer approval and prevents double review", () => {
  const proposal = RemediationProposalManager.createProposal({
    id: "prop-03",
    targetIssue: "Off-by-one index error",
    authorAgent: "Author-Agent-01",
    reproductionSteps: ["Run index test"],
    proposedDiff: "+ for (let i = 0; i < len; i++)",
    testRecommendations: ["Verify bounds"],
  });

  const reviewed = RemediationProposalManager.reviewProposal(
    proposal,
    "Independent-Reviewer-Agent",
    "APPROVED",
    "Verified against boundary test and clean diff."
  );

  assert.equal(reviewed.approvalStatus, "APPROVED");
  assert.equal(reviewed.reviewerAgent, "Independent-Reviewer-Agent");

  // Attempting to review an already-approved proposal fails
  assert.throws(
    () =>
      RemediationProposalManager.reviewProposal(
        reviewed,
        "Another-Reviewer",
        "REJECTED",
        "Too late"
      ),
    /expected 'PENDING_REVIEW'/
  );
});
