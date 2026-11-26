import type { DurableOperationState } from "./operation.js";

export interface PersistedTokenStats {
  total: number;
  requests?: number;
  reportedRequests?: number;
}

/** Persisted token totals attributed to every work-unit task in one durable operation. */
export interface OperationUsage {
  agentRuns: number;
  reportedTokens: number;
  estimatedTokens: number;
  inferenceRequests: number;
  totalTokens: number;
  tokenAccountingComplete: boolean;
  maxTotalTokens?: number;
}

/**
 * Aggregate the existing per-task token records. Missing, malformed, unreadable, or currently changing task usage is
 * incomplete; callers must not present a partial total as exact or use it to admit more work under a token cap.
 */
export function collectOperationUsage(
  operation: DurableOperationState,
  loadTokenStats: (taskId: string) => PersistedTokenStats | undefined,
): OperationUsage {
  const usage: OperationUsage = {
    agentRuns: 0,
    reportedTokens: 0,
    estimatedTokens: 0,
    inferenceRequests: 0,
    totalTokens: 0,
    tokenAccountingComplete: true,
  };

  for (const unit of operation.units) {
    usage.agentRuns += unit.runs;
    if (unit.status === "RUNNING") usage.tokenAccountingComplete = false;
    if (!unit.agentTaskId) {
      if (unit.runs > 0) usage.tokenAccountingComplete = false;
      continue;
    }

    let stats: PersistedTokenStats | undefined;
    try {
      stats = loadTokenStats(unit.agentTaskId);
    } catch {
      usage.tokenAccountingComplete = false;
      continue;
    }
    if (!stats || !Number.isSafeInteger(stats.total) || stats.total < 0) {
      usage.tokenAccountingComplete = false;
      continue;
    }

    const requests = stats.requests ?? 0;
    if (!Number.isSafeInteger(requests) || requests < 0 ||
        (stats.reportedRequests !== undefined && (!Number.isSafeInteger(stats.reportedRequests) || stats.reportedRequests < 0 || stats.reportedRequests > requests))) {
      usage.tokenAccountingComplete = false;
      continue;
    }
    const totalTokens = usage.totalTokens + stats.total;
    const inferenceRequests = usage.inferenceRequests + requests;
    if (!Number.isSafeInteger(totalTokens) || !Number.isSafeInteger(inferenceRequests)) {
      usage.tokenAccountingComplete = false;
      continue;
    }

    usage.totalTokens = totalTokens;
    usage.inferenceRequests = inferenceRequests;
    if (requests > 0 && stats.reportedRequests === requests) usage.reportedTokens += stats.total;
    else usage.estimatedTokens += stats.total;
  }

  if (!Number.isSafeInteger(usage.reportedTokens) || !Number.isSafeInteger(usage.estimatedTokens)) {
    usage.tokenAccountingComplete = false;
  }
  if (operation.policy.maxTotalTokens !== undefined) usage.maxTotalTokens = operation.policy.maxTotalTokens;
  return usage;
}
