/**
 * Inference usage ledger: one receipt per provider-connection request (main agent, planner/coder, subagents and
 * auxiliary calls all share the process-wide ledger), and the spending limits checked before each cloud request.
 *
 * Receipts never hold credentials, headers or request bodies. Usage is what the provider reported; cost is recorded
 * only when the provider reported it (OpenRouter) and is otherwise "unknown" — never estimated from a price table.
 * Limits are enforced on reported/reserved figures and are not a guarantee of the provider's final invoice.
 */
import { snapshotModel } from "./core/models_snapshot.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensurePrivateDir, appendPrivateFile } from "./core/durable_file.js";
import { ensureSelfIgnore } from "./core/git_exclude.js";

export interface UsageReport {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Provider-reported cost in USD. */
  costUsd?: number;
}

export interface InferenceReceipt {
  at: string;
  requestId: string;
  role: string;
  providerId: string;
  /** The model the operator selected and the model the provider reports having used (may differ, e.g. OpenRouter routing). */
  selectedModel: string;
  effectiveModel?: string;
  endpointOrigin: string;
  protocol: string;
  disclosure: "local" | "cloud";
  origin_class?: "local" | "cloud" | string;
  executions?: number;
  outcome: "completed" | "failed" | "aborted";
  failureKind?: string;
  providerRequestId?: string;
  usage?: UsageReport;
  /** "provider": usage came from the provider; "uncertain": the request may have been billed but no usage arrived. */
  usageConfidence: "provider" | "uncertain" | "none";
  costConfidence: "provider-reported" | "unknown";
}

export interface SpendingLimits {
  maxRequests?: number;
  maxTokens?: number;
  maxCostUsd?: number;
}

export function spendingLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): SpendingLimits {
  const num = (k: string) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  return { maxRequests: num("NEXUS_CLOUD_MAX_REQUESTS"), maxTokens: num("NEXUS_CLOUD_MAX_TOKENS"), maxCostUsd: num("NEXUS_CLOUD_MAX_COST_USD") };
}

/**
 * Limits per provider id, from NEXUS_CLOUD_LIMITS, a JSON object such as
 * `{"openrouter":{"maxCostUsd":5,"maxTokens":2000000},"groq":{"maxRequests":200}}`. They apply on top of the global
 * NEXUS_CLOUD_MAX_* limits. A value that does not parse is returned as `error`, and every cloud request is then refused:
 * a limit that silently fails to apply is worse than none.
 */
export function providerLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): { limits: Record<string, SpendingLimits>; error?: string } {
  const raw = env.NEXUS_CLOUD_LIMITS;
  if (raw === undefined || raw.trim() === "") return { limits: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    const limits: Record<string, SpendingLimits> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${id}: not an object`);
      const out: SpendingLimits = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k !== "maxRequests" && k !== "maxTokens" && k !== "maxCostUsd") throw new Error(`${id}: unknown limit ${k}`);
        if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`${id}.${k}: must be a positive number`);
        out[k] = v;
      }
      limits[id] = out;
    }
    return { limits };
  } catch (err) {
    return { limits: {}, error: `NEXUS_CLOUD_LIMITS is not valid (${err instanceof Error ? err.message : "unparseable"})` };
  }
}

/** USD for one request at the snapshot's price (per million tokens) for the model it used; undefined when no price is known. */
function snapshotCost(providerId: string, model: string, usage: UsageReport | undefined): number | undefined {
  const price = snapshotModel(providerId, model)?.price;
  if (!price || !usage) return undefined;
  return ((usage.inputTokens ?? 0) * price.input + (usage.outputTokens ?? 0) * price.output) / 1_000_000;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Requests whose cost the provider did not report. */
  unpricedRequests: number;
  /** Requests that may have been billed without reported usage (failed mid-stream, timed out). */
  uncertainRequests: number;
  /** Requests priced from the models snapshot instead of by the provider (per-provider totals only). */
  estimatedRequests: number;
  /** Prompt tokens served from the provider cache, and the prompt tokens of requests that reported cache usage (the share's denominator). */
  cachedTokens: number;
  cacheReportedPromptTokens: number;
}

export class UsageLedger {
  private static instance?: UsageLedger;
  static global(): UsageLedger {
    return (UsageLedger.instance ??= new UsageLedger());
  }
  /** Tests isolate ledgers. */
  static resetGlobal(): void {
    UsageLedger.instance = undefined;
  }

  private receipts: InferenceReceipt[] = [];
  private reserved = new Map<string, number>();
  private reservedBy = new Map<string, string>();
  /** Workspaces whose `.nexus/.gitignore` has been verified by this process. */
  private readonly selfIgnored = new Set<string>();
  limits: SpendingLimits = spendingLimitsFromEnv();
  private providerLimitsConfig = providerLimitsFromEnv();
  get providerLimits(): Record<string, SpendingLimits> {
    return this.providerLimitsConfig.limits;
  }
  set providerLimits(limits: Record<string, SpendingLimits>) {
    this.providerLimitsConfig = { limits };
  }

  /**
   * Admit one cloud request under the limits, reserving `estimatedTokens` until it is recorded. Concurrent callers
   * (scheduled work units, subagents) see each other's reservations. Returns a refusal reason, or undefined.
   */
  admit(requestId: string, estimatedTokens: number, costReported: boolean, providerId?: string, model?: string): string | undefined {
    if (this.providerLimitsConfig.error) return this.providerLimitsConfig.error;
    const own = providerId ? this.providerLimitsConfig.limits[providerId] : undefined;
    if (own && providerId) {
      const refusal = this.admitProvider(providerId, own, estimatedTokens, costReported, model);
      if (refusal) return refusal;
    }
    const t = this.cloudTotals();
    const pendingTokens = [...this.reserved.values()].reduce((a, b) => a + b, 0);
    const { maxRequests, maxTokens, maxCostUsd } = this.limits;
    if (maxRequests !== undefined && t.requests + this.reserved.size + 1 > maxRequests) {
      return `cloud request limit reached (NEXUS_CLOUD_MAX_REQUESTS=${maxRequests}; ${t.requests} recorded, ${this.reserved.size} in flight)`;
    }
    if (maxTokens !== undefined && t.inputTokens + t.outputTokens + pendingTokens + estimatedTokens > maxTokens) {
      return `cloud token limit would be exceeded (NEXUS_CLOUD_MAX_TOKENS=${maxTokens}; ${t.inputTokens + t.outputTokens} used, ${pendingTokens} reserved, ~${estimatedTokens} requested)`;
    }
    if (maxCostUsd !== undefined) {
      if (!costReported) return `NEXUS_CLOUD_MAX_COST_USD is set but this provider does not report cost, so the limit cannot be enforced; use NEXUS_CLOUD_MAX_TOKENS instead`;
      if (t.costUsd >= maxCostUsd) return `cloud cost limit reached (NEXUS_CLOUD_MAX_COST_USD=${maxCostUsd}; $${t.costUsd.toFixed(4)} reported)`;
    }
    this.reserved.set(requestId, estimatedTokens);
    if (providerId) this.reservedBy.set(requestId, providerId);
    return undefined;
  }

  private admitProvider(providerId: string, limits: SpendingLimits, estimatedTokens: number, costReported: boolean, model?: string): string | undefined {
    const t = this.cloudTotals(providerId);
    const inFlight = [...this.reservedBy.entries()].filter(([, id]) => id === providerId).map(([req]) => this.reserved.get(req) ?? 0);
    const pendingTokens = inFlight.reduce((a, b) => a + b, 0);
    const name = `NEXUS_CLOUD_LIMITS[${providerId}]`;
    if (limits.maxRequests !== undefined && t.requests + inFlight.length + 1 > limits.maxRequests) {
      return `${providerId} request limit reached (${name}.maxRequests=${limits.maxRequests}; ${t.requests} recorded, ${inFlight.length} in flight)`;
    }
    if (limits.maxTokens !== undefined && t.inputTokens + t.outputTokens + pendingTokens + estimatedTokens > limits.maxTokens) {
      return `${providerId} token limit would be exceeded (${name}.maxTokens=${limits.maxTokens}; ${t.inputTokens + t.outputTokens} used, ${pendingTokens} reserved, ~${estimatedTokens} requested)`;
    }
    if (limits.maxCostUsd !== undefined) {
      const priced = costReported || (model !== undefined && snapshotModel(providerId, model)?.price !== undefined);
      if (!priced) return `${name}.maxCostUsd is set but ${providerId} does not report cost and the model snapshot has no price for ${model ?? "this model"}, so the limit cannot be enforced; use maxTokens instead`;
      if (t.unpricedRequests > 0) return `${name}.maxCostUsd cannot be enforced: ${t.unpricedRequests} earlier ${providerId} request(s) have no known cost`;
      if (t.costUsd >= limits.maxCostUsd) return `${providerId} cost limit reached (${name}.maxCostUsd=${limits.maxCostUsd}; $${t.costUsd.toFixed(4)} spent${t.estimatedRequests ? `, ${t.estimatedRequests} request(s) estimated from snapshot prices` : ""})`;
    }
    return undefined;
  }

  /** Drops a reservation whose request will not be recorded under that id. */
  release(requestId: string): void {
    this.reserved.delete(requestId);
    this.reservedBy.delete(requestId);
  }

  record(receipt: InferenceReceipt, workspace?: string): void {
    this.reserved.delete(receipt.requestId);
    this.reservedBy.delete(receipt.requestId);
    if (process.env.NEXUS_RECEIPTS === "0") return;
    this.receipts.push(receipt);
    if (!workspace) return;
    // Receipts land in the user's workspace: keep them out of the user's `git status` without touching Git metadata.
    // Verified once per workspace; done again only if the ignore file has since been removed.
    if (!this.selfIgnored.has(workspace) || !fs.existsSync(path.join(workspace, ".nexus", ".gitignore"))) {
      try {
        ensureSelfIgnore(workspace);
        this.selfIgnored.add(workspace);
      } catch {
        // Dirty counts exclude .nexus regardless (git.ts workspaceStatus); a refused ignore file must not lose the receipt.
      }
    }
    try {
      const dir = path.join(workspace, ".nexus");
      ensurePrivateDir(dir);
      appendPrivateFile(path.join(dir, "inference_receipts.jsonl"), JSON.stringify(receipt) + "\n");
    } catch {
      // Receipts are diagnostics; an unwritable workspace must not fail the inference that already happened.
    }
  }

  all(): readonly InferenceReceipt[] {
    return this.receipts;
  }

  cloudTotals(providerId?: string): UsageTotals {
    const t: UsageTotals = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedRequests: 0, uncertainRequests: 0, estimatedRequests: 0, cachedTokens: 0, cacheReportedPromptTokens: 0 };
    for (const r of this.receipts) {
      if (providerId !== undefined && r.providerId !== providerId) continue;
      // Requests refused before sending (disclosure, limits, missing credential) cost nothing.
      if (r.disclosure !== "cloud" || r.failureKind === "policy_denied" || r.failureKind === "configuration_error") continue;
      t.requests++;
      t.inputTokens += r.usage?.inputTokens ?? 0;
      t.outputTokens += r.usage?.outputTokens ?? 0;
      if (r.usage?.cachedInputTokens !== undefined) {
        t.cachedTokens += r.usage.cachedInputTokens;
        // Anthropic and Bedrock report input apart from cache reads and writes; the others count cached tokens inside input.
        const apart = r.protocol === "anthropic-messages" || r.protocol === "bedrock-converse";
        t.cacheReportedPromptTokens += (r.usage.inputTokens ?? 0) + (apart ? r.usage.cachedInputTokens + (r.usage.cacheWriteTokens ?? 0) : 0);
      }
      if (r.costConfidence === "provider-reported") t.costUsd += r.usage?.costUsd ?? 0;
      else if (providerId !== undefined) {
        // Per-provider limits count a request the provider did not price at the snapshot's price for the model that ran.
        const estimate = snapshotCost(r.providerId, r.effectiveModel ?? r.selectedModel, r.usage);
        if (estimate === undefined) t.unpricedRequests++;
        else {
          t.costUsd += estimate;
          t.estimatedRequests++;
        }
      } else t.unpricedRequests++;
      if (r.usageConfidence === "uncertain") t.uncertainRequests++;
    }
    return t;
  }

  /** One line for /tokens and run summaries; undefined when no cloud request was made. */
  summary(): string | undefined {
    const t = this.cloudTotals();
    if (!t.requests) return undefined;
    const cost = t.unpricedRequests === t.requests
      ? "cost unknown (not reported by provider)"
      : `$${t.costUsd.toFixed(4)} provider-reported${t.unpricedRequests ? ` + ${t.unpricedRequests} request(s) with unknown cost` : ""}`;
    const uncertain = t.uncertainRequests ? `; ${t.uncertainRequests} request(s) may have been billed without reported usage` : "";
    const cache = t.cacheReportedPromptTokens > 0
      ? `, cached ${t.cachedTokens.toLocaleString()} of ${t.cacheReportedPromptTokens.toLocaleString()} input tokens (${Math.round((100 * t.cachedTokens) / t.cacheReportedPromptTokens)}%)`
      : "";
    return `Cloud usage: ${t.requests} request(s), ${t.inputTokens.toLocaleString()} input + ${t.outputTokens.toLocaleString()} output tokens${cache}, ${cost}${uncertain}`;
  }
}
