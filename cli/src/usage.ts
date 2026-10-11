/**
 * Inference usage ledger: one receipt per provider-connection request (main agent, planner/coder, subagents and
 * auxiliary calls all share the process-wide ledger), and the spending limits checked before each cloud request.
 *
 * Receipts never hold credentials, headers or request bodies. Usage is what the provider reported; cost is recorded
 * only when the provider reported it (OpenRouter) and is otherwise "unknown" — never estimated from a price table.
 * Limits are enforced on reported/reserved figures and are not a guarantee of the provider's final invoice.
 */
import * as fs from "node:fs";
import * as path from "node:path";

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

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Requests whose cost the provider did not report. */
  unpricedRequests: number;
  /** Requests that may have been billed without reported usage (failed mid-stream, timed out). */
  uncertainRequests: number;
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
  limits: SpendingLimits = spendingLimitsFromEnv();

  /**
   * Admit one cloud request under the limits, reserving `estimatedTokens` until it is recorded. Concurrent callers
   * (scheduled work units, subagents) see each other's reservations. Returns a refusal reason, or undefined.
   */
  admit(requestId: string, estimatedTokens: number, costReported: boolean): string | undefined {
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
    return undefined;
  }

  /** Drops a reservation whose request will not be recorded under that id. */
  release(requestId: string): void {
    this.reserved.delete(requestId);
  }

  record(receipt: InferenceReceipt, workspace?: string): void {
    this.reserved.delete(receipt.requestId);
    this.receipts.push(receipt);
    if (!workspace) return;
    try {
      const dir = path.join(workspace, ".nexus");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "inference_receipts.jsonl"), JSON.stringify(receipt) + "\n", { mode: 0o600 });
    } catch {
      // Receipts are diagnostics; an unwritable workspace must not fail the inference that already happened.
    }
  }

  all(): readonly InferenceReceipt[] {
    return this.receipts;
  }

  cloudTotals(): UsageTotals {
    const t: UsageTotals = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedRequests: 0, uncertainRequests: 0 };
    for (const r of this.receipts) {
      // Requests refused before sending (disclosure, limits, missing credential) cost nothing.
      if (r.disclosure !== "cloud" || r.failureKind === "policy_denied" || r.failureKind === "configuration_error") continue;
      t.requests++;
      t.inputTokens += r.usage?.inputTokens ?? 0;
      t.outputTokens += r.usage?.outputTokens ?? 0;
      if (r.costConfidence === "provider-reported") t.costUsd += r.usage?.costUsd ?? 0;
      else t.unpricedRequests++;
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
    return `Cloud usage: ${t.requests} request(s), ${t.inputTokens.toLocaleString()} input + ${t.outputTokens.toLocaleString()} output tokens, ${cost}${uncertain}`;
  }
}
