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
  "Use researcher, architect, implementer, tester, or reviewer roles. Handoffs are dependency IDs.",
  "Use workspace-relative paths and declare every unit scope. Order overlapping writes and keep independent work parallel.",
  "Provide a required final check and at least one required check for each required write unit.",
  "Use string arrays for criteria, risks, assumptions, blockers, paths, dependency IDs, and outputs.",
  "Record unresolved acceptance questions as blockers. Do not claim work has run or been verified.",
].join("\n");

export async function generateBatchPlanProposal(input: string, config: HarnessConfig, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(60_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  deadline.throwIfAborted();
  const executor = new AgentWorkUnitExecutor({ baseConfig: config, discoverCatalog: false });
  const resources = resourcesFromConfig(config);
  const clients = new Map(resources.flatMap((resource) => {
    const selected = executor.configFor(resource);
    const contextLimit = selected.contextLimit ?? 65_536;
    const completionReserveTokens = Math.min(selected.completionReserveTokens ?? 4096, 4096);
    const promptTokens = calculateContextBudget([
      { role: "system", content: PROPOSAL_CONTRACT },
      { role: "user", content: input },
    ], [], contextLimit).totalActiveTokens;
    if (!isContextAdmissible(promptTokens, contextLimit, completionReserveTokens, 0)) return [];
    const client = new LocalLlmClient({ ...selected, completionReserveTokens }, {
      role: "batch-planner",
      diagnosticHandler: () => {},
    });
    return [[resource.id, client] as const];
  }));

  let fallbackFrom: string | undefined;
  for (const disclosure of ["local", "cloud"] as const) {
    const candidates = resources.filter((resource) => clients.get(resource.id)?.disclosureOf() === disclosure);
    const resource = new ResourceRegistry(candidates).select({ qualification: "architecture" }).chosen;
    if (!resource) continue;
    const client = clients.get(resource.id)!;
    try {
      const plan = await requestJsonProposal(client, PROPOSAL_CONTRACT, input, deadline);
      return { plan, provenance: { resourceId: resource.id, model: client.getModel(), disclosure, ...(fallbackFrom ? { fallbackFrom } : {}) } };
    } catch (error) {
      if (disclosure === "cloud" || !(error instanceof InferenceError) || !error.failoverEligible) throw error;
      fallbackFrom = resource.id;
      if (!resources.some((candidate) => clients.get(candidate.id)?.disclosureOf() === "cloud")) throw error;
    }
  }
  throw new Error("No eligible resource is configured for batch planning.");
}
