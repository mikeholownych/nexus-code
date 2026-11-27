import type { BatchPlanDraft } from "./batch_plan.js";
import { BATCH_PLAN_REVIEW_CONTRACT, selectBatchPlanReviewer } from "./batch_plan_review.js";
import { InferenceError } from "./client.js";
import { requestJsonProposal } from "./core/proposal_inference.js";
import { inferenceProvenance, proposalClients, requestLocalFirstProposal } from "./core/proposal_resources.js";
import type { HarnessConfig } from "./types.js";

const PROPOSAL_CONTRACT = [
  "Propose a bounded Nexus batch work graph for the operator's objective. Return only one JSON object.",
  "Use version:1, objective, acceptanceCriteria, checks, risks, assumptions, blockers, and units.",
  "Checks are objects with id, command, cwd, expectation, timeoutSeconds (1–300), and required. A required check may additionally use when: {changedPaths: [paths]} to run only after matching changes.",
  "Declare any extra dependency or generated input a check reads with materialInputs using workspace-relative paths.",
  "Units have id, title, objective, role, required, dependsOn, mode (read or write), scope, acceptanceCriteria, checks, outputs, and handoffs.",
  "Use read mode for researcher or reviewer, and write mode for architect, implementer, or tester. Handoffs are dependency IDs.",
  "Read scope may be '.', while write scope must name narrower paths.",
  "For an independent unit reviewer, set independentReview and list prior dependencies under requires.independentOf.",
  "Use workspace-relative paths and declare every unit scope. Order overlapping writes and keep independent work parallel.",
  "For parallel execution, optionally provide execution: {maxConcurrentUnits, executionBudget:{cpuMilli,memoryBytes}} and executionResources:{cpuMilli,memoryBytes} for each unit.",
  "Provide a required final check and at least one required check for each required write unit.",
  "Use string arrays for criteria, risks, assumptions, blockers, paths, dependency IDs, and outputs.",
  "Record unresolved acceptance questions as blockers. Do not claim work has run or been verified.",
].join("\n");

export async function generateBatchPlanProposal(input: string, config: HarnessConfig, signal?: AbortSignal) {
  const { proposal: plan, provenance } = await requestLocalFirstProposal(PROPOSAL_CONTRACT, input, config, {
    role: "batch-planner", qualification: "architecture", noEligibleMessage: "No eligible resource is configured for batch planning.",
  }, signal);
  return { plan, provenance };
}

export async function generateBatchPlanReview(draft: BatchPlanDraft, config: HarnessConfig, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(60_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  deadline.throwIfAborted();
  if (!draft.provenance) throw new Error("An independent review requires known planner provenance.");
  const input = JSON.stringify(draft.plan);
  const { clients, resources } = proposalClients(BATCH_PLAN_REVIEW_CONTRACT, input, config, "batch-plan-reviewer");
  const planner = draft.provenance;
  const attempted = new Set<string>();
  let lastFailure: { resourceId: string; error: InferenceError } | undefined;
  while (attempted.size < 3) {
    const resource = selectBatchPlanReviewer(
      resources.filter((candidate) => !attempted.has(candidate.id)),
      planner, (candidate) => clients.get(candidate.id)!.client.disclosureOf(), { allowCloud: true },
    );
    if (!resource) break;
    attempted.add(resource.id);
    const { client } = clients.get(resource.id)!;
    try {
      const review = await requestJsonProposal(client, BATCH_PLAN_REVIEW_CONTRACT, input, deadline);
      return { review, provenance: inferenceProvenance(resource.id, client, lastFailure?.resourceId) };
    } catch (error) {
      if (!(error instanceof InferenceError) || !error.failoverEligible) throw error;
      lastFailure = { resourceId: resource.id, error };
    }
  }
  if (lastFailure) throw lastFailure.error;
  throw new Error("No distinct qualified resource is configured for plan review.");
}
