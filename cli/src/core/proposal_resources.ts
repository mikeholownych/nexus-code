import { InferenceError, LocalLlmClient } from "../client.js";
import { disclosureClass, originOf, providerDefinition } from "../providers.js";
import { calculateContextBudget, isContextAdmissible } from "../tokens.js";
import type { HarnessConfig } from "../types.js";
import { AgentWorkUnitExecutor, resourcesFromConfig } from "./operation_runner.js";
import { requestJsonProposal } from "./proposal_inference.js";
import { ResourceRegistry } from "./resources.js";

interface ProposalSelectionOptions {
  role: string;
  qualification: string;
  requireAuthorizedOrigin?: boolean;
  noEligibleMessage: string;
  /** Used by deterministic workflow fixtures. Production uses the normal read-only request envelope. */
  request?: (contract: string, input: string, signal?: AbortSignal) => Promise<unknown>;
}

export function proposalClients(
  contract: string,
  input: string,
  config: HarnessConfig,
  role: string,
  requireAuthorizedOrigin = false,
) {
  const executor = new AgentWorkUnitExecutor({ baseConfig: config, discoverCatalog: false });
  const authorized = config.authorizedDisclosureOrigins ?? [];
  const clients = new Map(resourcesFromConfig(config).flatMap((resource) => {
    const selected = executor.configFor(resource);
    const origin = originOf(selected.endpoint);
    const authorizedOrigin = origin && authorized.includes(origin) ? origin : undefined;
    if (requireAuthorizedOrigin) {
      if (selected.provider && !providerDefinition(selected.provider)) return [];
      if (disclosureClass(selected.endpoint, selected.provider, selected.cloudRoutedOrigins) === "cloud" && !authorizedOrigin) return [];
    }
    const contextLimit = selected.contextLimit ?? 65_536;
    const completionReserveTokens = Math.min(selected.completionReserveTokens ?? 4096, 4096);
    const promptTokens = calculateContextBudget([
      { role: "system", content: contract },
      { role: "user", content: input },
    ], [], contextLimit).totalActiveTokens;
    if (!isContextAdmissible(promptTokens, contextLimit, completionReserveTokens, 0)) return [];
    const client = new LocalLlmClient({
      ...selected,
      ...(requireAuthorizedOrigin ? { authorizedDisclosureOrigins: authorized } : {}),
      completionReserveTokens,
      readOnly: true,
    }, { role, diagnosticHandler: () => {} });
    return [[resource.id, { resource, client, authorizedOrigin }] as const];
  }));
  return { clients, resources: [...clients.values()].map((entry) => entry.resource) };
}

export function inferenceProvenance(id: string, client: LocalLlmClient, fallbackFrom?: string) {
  const effectiveModel = client.getLastEffectiveModel();
  return {
    resourceId: id, model: client.getModel(), disclosure: client.disclosureOf(),
    ...(effectiveModel ? { effectiveModel } : {}),
    ...(fallbackFrom ? { fallbackFrom } : {}),
  };
}

export async function requestLocalFirstProposal(
  contract: string,
  input: string,
  config: HarnessConfig,
  options: ProposalSelectionOptions,
  signal?: AbortSignal,
) {
  const timeout = AbortSignal.timeout(60_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  deadline.throwIfAborted();
  const { clients, resources } = proposalClients(contract, input, config, options.role, options.requireAuthorizedOrigin);

  let lastFailure: { resourceId: string; error: InferenceError } | undefined;
  let localFailed = false;
  const attempted = new Set<string>();
  for (const disclosure of ["local", "cloud"] as const) {
    const available = resources.filter((resource) => clients.get(resource.id)!.client.disclosureOf() === disclosure);
    while (attempted.size < 3) {
      const candidates = available.filter((resource) => !attempted.has(resource.id));
      const resource = new ResourceRegistry(candidates).select({ qualification: options.qualification }).chosen;
      if (!resource) break;
      const { client, authorizedOrigin } = clients.get(resource.id)!;
      attempted.add(resource.id);
      deadline.throwIfAborted();
      try {
        const proposal = options.request
          ? await options.request(contract, input, deadline)
          : await requestJsonProposal(client, contract, input, deadline);
        deadline.throwIfAborted();
        return { proposal, provenance: inferenceProvenance(resource.id, client, lastFailure?.resourceId), authorizedOrigin, localFailed };
      } catch (error) {
        deadline.throwIfAborted();
        if (!(error instanceof InferenceError) || !error.failoverEligible) throw error;
        lastFailure = { resourceId: resource.id, error };
        if (disclosure === "local") localFailed = true;
      }
    }
  }
  if (lastFailure) throw lastFailure.error;
  throw new Error(options.noEligibleMessage);
}
