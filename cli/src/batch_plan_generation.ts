import type { BatchPlanDraft, BatchPlanProvenance } from "./batch_plan.js";
import { BATCH_PLAN_REVIEW_CONTRACT, selectBatchPlanReviewer } from "./batch_plan_review.js";
import { InferenceError, LocalLlmClient } from "./client.js";
import { AgentWorkUnitExecutor, resourcesFromConfig } from "./core/operation_runner.js";
import { requestJsonProposal } from "./core/proposal_inference.js";
import { ResourceRegistry } from "./core/resources.js";
import { calculateContextBudget, isContextAdmissible } from "./tokens.js";
import type { HarnessConfig } from "./types.js";

const PROPOSAL_CONTRACT = [
  "Propose a bounded Nexus batch work graph for the operator's objective. Return only one JSON object.",
  "Use version:1, objective, acceptanceCriteria, checks, risks, assumptions, blockers, and units.",
  "Checks are objects with id, command, cwd, expectation, timeoutSeconds (1–300), and required.",
  "Units have id, title, objective, role, required, dependsOn, mode (read or write), scope, acceptanceCriteria, checks, outputs, and handoffs.",
  "Use read mode for researcher or reviewer, and write mode for architect, implementer, or tester. Handoffs are dependency IDs.",
  "Read scope may be '.', while write scope must name narrower paths.",
  "For an independent unit reviewer, set independentReview and list prior dependencies under requires.independentOf.",
  "Use workspace-relative paths and declare every unit scope. Order overlapping writes and keep independent work parallel.",
  "Provide a required final check and at least one required check for each required write unit.",
  "Use string arrays for criteria, risks, assumptions, blockers, paths, dependency IDs, and outputs.",
  "Record unresolved acceptance questions as blockers. Do not claim work has run or been verified.",
].join("\n");

function proposalClients(contract: string, input: string, config: HarnessConfig, role: string) {
  const executor = new AgentWorkUnitExecutor({ baseConfig: config, discoverCatalog: false });
  const clients = new Map(resourcesFromConfig(config).flatMap((resource) => {
    const selected = executor.configFor(resource);
    const contextLimit = selected.contextLimit ?? 65_536;
    const completionReserveTokens = Math.min(selected.completionReserveTokens ?? 4096, 4096);
    const promptTokens = calculateContextBudget([
      { role: "system", content: contract },
      { role: "user", content: input },
    ], [], contextLimit).totalActiveTokens;
    if (!isContextAdmissible(promptTokens, contextLimit, completionReserveTokens, 0)) return [];
    const client = new LocalLlmClient({ ...selected, completionReserveTokens, readOnly: true }, {
      role,
      diagnosticHandler: () => {},
    });
    return [[resource.id, { resource, client }] as const];
  }));
  return { clients, resources: [...clients.values()].map((entry) => entry.resource) };
}

function inferenceProvenance(id: string, client: LocalLlmClient, fallbackFrom?: string): BatchPlanProvenance {
  const effectiveModel = client.getLastEffectiveModel();
  return {
    resourceId: id, model: client.getModel(), disclosure: client.disclosureOf(),
    ...(effectiveModel ? { effectiveModel } : {}),
    ...(fallbackFrom ? { fallbackFrom } : {}),
  };
}

export async function generateBatchPlanProposal(input: string, config: HarnessConfig, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(60_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  deadline.throwIfAborted();
  const { clients, resources } = proposalClients(PROPOSAL_CONTRACT, input, config, "batch-planner");

  let lastFailure: { resourceId: string; error: InferenceError } | undefined;
  const attempted = new Set<string>();
  for (const disclosure of ["local", "cloud"] as const) {
    const available = resources.filter((resource) => clients.get(resource.id)!.client.disclosureOf() === disclosure);
    while (attempted.size < 3) {
      const candidates = available.filter((resource) => !attempted.has(resource.id));
      const resource = new ResourceRegistry(candidates).select({ qualification: "architecture" }).chosen;
      if (!resource) break;
      const { client } = clients.get(resource.id)!;
      attempted.add(resource.id);
      try {
        const plan = await requestJsonProposal(client, PROPOSAL_CONTRACT, input, deadline);
        return { plan, provenance: inferenceProvenance(resource.id, client, lastFailure?.resourceId) };
      } catch (error) {
        if (!(error instanceof InferenceError) || !error.failoverEligible) throw error;
        lastFailure = { resourceId: resource.id, error };
      }
    }
  }
  if (lastFailure) throw lastFailure.error;
  throw new Error("No eligible resource is configured for batch planning.");
}

export async function generateBatchPlanReview(draft: BatchPlanDraft, config: HarnessConfig, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!draft.provenance) throw new Error("An independent review requires known planner provenance.");
  const input = JSON.stringify(draft.plan);
  const { clients, resources } = proposalClients(BATCH_PLAN_REVIEW_CONTRACT, input, config, "batch-plan-reviewer");
  const resource = selectBatchPlanReviewer(
    resources, draft.provenance, (candidate) => clients.get(candidate.id)!.client.disclosureOf(), { allowCloud: true },
  );
  if (!resource) throw new Error("No distinct qualified resource is configured for plan review.");
  const { client } = clients.get(resource.id)!;
  const review = await requestJsonProposal(client, BATCH_PLAN_REVIEW_CONTRACT, input, signal);
  return { review, provenance: inferenceProvenance(resource.id, client) };
}
