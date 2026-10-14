/**
 * Optional provider capabilities: context capacity, output allowance and request token counting, discovered from the
 * selected connection where it advertises them, and clearly labelled estimates where it does not.
 *
 * None of this is a prerequisite. A connection that advertises nothing (LM Studio, plain llama.cpp, a cloud provider)
 * runs on the operator's configuration or the client defaults, and every number says which it is. A connection that
 * advertises capacity (the homelab-ai gateway's `/v1/models`: context_length, max_completion_tokens, limits_version,
 * serving workers; vLLM's max_model_len) has it used, refreshed when the model, the advertised limits version, the
 * serving workers or the observed capacity change. A stale client default never overrides valid advertised capacity;
 * an operator's explicit setting below it is kept (it is a choice), above it is capped (it is not physical capacity).
 *
 * Count sources, from strongest to weakest:
 * - `exact_admitted`: the gateway's own count of the request it admitted (inference response headers), after the fact;
 * - `exact_sampled_worker`: `/v1/tokenize` applied the chat template and tokenized the actual outbound request on one
 *   worker of the alias. The current gateway contract samples that worker without the routing and reasoning policy
 *   inference applies, so it is exact for that worker and template, not proven for the worker inference admits;
 * - `gateway_conservative`: the gateway could not tokenize and returned its conservative estimate;
 * - `client_estimate`: Nexus's own estimate (no counting capability, or it is unavailable).
 *
 * The tool-output headroom kept free for the next tool results is a scheduling policy, not a measurement; it is
 * reported separately from the measured prompt and the advertised output allowance.
 */

export type SizingSource = "advertised" | "operator" | "operator_capped_by_advertised" | "client_default";
export type CountSource = "exact_admitted" | "exact_sampled_worker" | "gateway_conservative" | "client_estimate";
export type CapabilityState = "supported" | "unsupported" | "unavailable" | "unknown";

/** Built-in client defaults: used only when neither the provider nor the operator gives a value. */
export const CLIENT_DEFAULT_CONTEXT = 65_536;
export const CLIENT_DEFAULT_OUTPUT = 8_192;
/** Tool-output headroom policy: min(4096, context/8). A scheduling margin for the next tool results, not capacity. */
export function toolHeadroomPolicy(context: number, configured?: number): number {
  return configured ?? Math.min(4096, Math.floor(context / 8));
}

export interface Advertisement {
  /** Who advertised: the homelab-ai gateway contract, a vLLM-style catalog, or an OpenAI-style catalog with no limits. */
  via: "aihost_gateway" | "vllm" | "catalog";
  /** null: the provider says the capacity is currently unknown (e.g. no serving worker observed). */
  contextLength?: number | null;
  maxCompletionTokens?: number;
  limitsVersion?: string;
  reasoning?: { mode?: string; budget?: number };
  workers?: string[];
  /** The connection's contract includes a request-counting endpoint (/v1/tokenize). */
  tokenize: boolean;
}

export interface ProviderCapabilities {
  model: string;
  observedAt: string;
  discovery: CapabilityState;
  discoveryDetail?: string;
  advertised?: Advertisement;
  tokenCounting: CapabilityState;
  tokenCountingDetail?: string;
  contextLimit: number;
  contextSource: SizingSource;
  outputAllowance: number;
  outputSource: SizingSource;
}

const positiveInt = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);

/** Reads one `/models` entry. Unknown shapes yield a catalog advertisement with no limits (never an error). */
export function parseAdvertisement(entry: Record<string, any> | undefined): Advertisement | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const gateway = typeof entry.limits_version === "string" && entry.limits_version.length > 0;
  const workers = Array.isArray(entry.serving)
    ? entry.serving.map((s: any) => (typeof s?.worker_id === "string" ? s.worker_id : undefined)).filter((w: string | undefined): w is string => Boolean(w)).sort()
    : undefined;
  const contextLength = entry.context_length === null ? null : positiveInt(entry.context_length) ?? positiveInt(entry.max_model_len);
  const reasoning = entry.reasoning && typeof entry.reasoning === "object"
    ? { ...(typeof entry.reasoning.mode === "string" ? { mode: entry.reasoning.mode } : {}), ...(positiveInt(entry.reasoning.budget) ? { budget: positiveInt(entry.reasoning.budget) } : {}) }
    : undefined;
  return {
    via: gateway ? "aihost_gateway" : contextLength !== undefined ? "vllm" : "catalog",
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(positiveInt(entry.max_completion_tokens) ? { maxCompletionTokens: positiveInt(entry.max_completion_tokens) } : {}),
    ...(gateway ? { limitsVersion: entry.limits_version } : {}),
    ...(reasoning && Object.keys(reasoning).length ? { reasoning } : {}),
    ...(workers?.length ? { workers } : {}),
    tokenize: gateway,
  };
}

/**
 * The context and output limits in effect, and where each came from. `operatorContext` / `operatorOutput` are values
 * the operator set explicitly (undefined otherwise).
 */
export function resolveLimits(advertised: Advertisement | undefined, operatorContext?: number, operatorOutput?: number): Pick<ProviderCapabilities, "contextLimit" | "contextSource" | "outputAllowance" | "outputSource"> {
  const adCtx = typeof advertised?.contextLength === "number" ? advertised.contextLength : undefined;
  let contextLimit: number;
  let contextSource: SizingSource;
  if (adCtx !== undefined && operatorContext !== undefined) {
    contextLimit = Math.min(adCtx, operatorContext);
    contextSource = operatorContext <= adCtx ? "operator" : "operator_capped_by_advertised";
  } else if (adCtx !== undefined) {
    contextLimit = adCtx;
    contextSource = "advertised";
  } else if (operatorContext !== undefined) {
    contextLimit = operatorContext;
    contextSource = "operator";
  } else {
    contextLimit = CLIENT_DEFAULT_CONTEXT;
    contextSource = "client_default";
  }
  const adOut = advertised?.maxCompletionTokens;
  let outputAllowance: number;
  let outputSource: SizingSource;
  if (adOut !== undefined && operatorOutput !== undefined) {
    outputAllowance = Math.min(adOut, operatorOutput);
    outputSource = operatorOutput <= adOut ? "operator" : "operator_capped_by_advertised";
  } else if (adOut !== undefined) {
    outputAllowance = adOut;
    outputSource = "advertised";
  } else if (operatorOutput !== undefined) {
    outputAllowance = operatorOutput;
    outputSource = "operator";
  } else {
    outputAllowance = Math.min(CLIENT_DEFAULT_OUTPUT, Math.floor(contextLimit / 4));
    outputSource = "client_default";
  }
  // An output allowance can never take the whole window.
  outputAllowance = Math.max(1, Math.min(outputAllowance, Math.floor(contextLimit / 2)));
  return { contextLimit, contextSource, outputAllowance, outputSource };
}

/** Whether a new advertisement changes what was in effect (model, limits version, workers or capacity). */
export function advertisementChanged(before: Advertisement | undefined, after: Advertisement | undefined): boolean {
  if (!before || !after) return before !== after;
  return (
    before.limitsVersion !== after.limitsVersion ||
    before.contextLength !== after.contextLength ||
    before.maxCompletionTokens !== after.maxCompletionTokens ||
    (before.workers ?? []).join(",") !== (after.workers ?? []).join(",")
  );
}

export interface RequestCount {
  promptTokens: number;
  source: CountSource;
  /** Worker the count was taken on, when the provider said. */
  workerId?: string;
  limitsVersion?: string;
  /** Context the provider reported with the count (the counted worker's). */
  contextLength?: number;
  /** Why a stronger source was not available. */
  detail?: string;
}

/**
 * Reads a `/v1/tokenize` answer. The gateway's "exact" is exact for the worker it sampled (see the module comment), so
 * it is labelled `exact_sampled_worker`; "estimated_conservative" is the gateway's estimate. Anything else is malformed.
 */
export function parseTokenizeResponse(body: unknown): RequestCount | { malformed: string } {
  if (!body || typeof body !== "object") return { malformed: "not a JSON object" };
  const b = body as Record<string, any>;
  const tokens = positiveInt(b.prompt_tokens) ?? (b.prompt_tokens === 0 ? 0 : undefined);
  if (tokens === undefined) return { malformed: "no numeric prompt_tokens" };
  const source = b.source === "exact" ? "exact_sampled_worker" : b.source === "estimated_conservative" ? "gateway_conservative" : undefined;
  if (!source) return { malformed: `unknown count source ${JSON.stringify(b.source)?.slice(0, 40)}` };
  return {
    promptTokens: tokens,
    source,
    ...(typeof b.worker_id === "string" ? { workerId: b.worker_id } : {}),
    ...(typeof b.limits_version === "string" ? { limitsVersion: b.limits_version } : {}),
    ...(positiveInt(b.context_length) ? { contextLength: positiveInt(b.context_length) } : {}),
  };
}

/** What the gateway reported about the request it admitted (inference response headers); undefined when absent. */
export interface AdmissionReport {
  promptTokens?: number;
  source?: CountSource;
  contextLimit?: number;
  maxCompletion?: number;
  limitsVersion?: string;
  workerId?: string;
  pool?: string;
  clamped?: boolean;
}

export function parseAdmissionHeaders(get: (name: string) => string | null): AdmissionReport | undefined {
  const raw = get("x-aihost-prompt-tokens");
  const route = get("x-aihost-route") ?? "";
  const num = (name: string) => {
    const v = get(name);
    return v === null || v.trim() === "" ? NaN : Number(v);
  };
  const ctx = num("x-aihost-context-limit");
  const maxCompletion = num("x-aihost-max-completion");
  const limitsVersion = get("x-aihost-limits-version") ?? undefined;
  // A connection that sends none of these headers reports nothing about admission (not "an admission of 0").
  if (!raw && !route && !limitsVersion && !Number.isFinite(ctx)) return undefined;
  const estimated = raw?.trim().startsWith("~");
  const tokens = raw ? Number(raw.replace(/^~/, "").trim()) : NaN;
  const declared = (get("x-aihost-prompt-tokens-source") ?? "").toLowerCase();
  const source: CountSource | undefined = !raw ? undefined : !estimated && declared === "exact" ? "exact_admitted" : "gateway_conservative";
  const routeField = (name: string) => new RegExp(`(?:^|;)\\s*${name}=([^;]*)`).exec(route)?.[1]?.trim() || undefined;
  const clampedHeader = get("x-aihost-clamped");
  return {
    ...(Number.isFinite(tokens) ? { promptTokens: tokens } : {}),
    ...(source ? { source } : {}),
    ...(Number.isFinite(ctx) && ctx > 0 ? { contextLimit: ctx } : {}),
    ...(Number.isFinite(maxCompletion) && maxCompletion > 0 ? { maxCompletion } : {}),
    ...(limitsVersion ? { limitsVersion } : {}),
    ...(routeField("worker") ? { workerId: routeField("worker") } : {}),
    ...(routeField("pool") ? { pool: routeField("pool") } : {}),
    ...(clampedHeader ? { clamped: /^(1|true|yes)$/i.test(clampedHeader.trim()) } : {}),
  };
}

/** One line for logs and receipts. */
export function describeCapabilities(c: ProviderCapabilities): string {
  const ad = c.advertised;
  return [
    `context ${c.contextLimit} (${c.contextSource})`,
    `output allowance ${c.outputAllowance} (${c.outputSource})`,
    `discovery ${c.discovery}${c.discoveryDetail ? ` (${c.discoveryDetail})` : ""}`,
    `token counting ${c.tokenCounting}${c.tokenCountingDetail ? ` (${c.tokenCountingDetail})` : ""}`,
    ...(ad?.limitsVersion ? [`limits_version ${ad.limitsVersion}`] : []),
    ...(ad?.workers?.length ? [`workers ${ad.workers.join(",")}`] : []),
  ].join("; ");
}
