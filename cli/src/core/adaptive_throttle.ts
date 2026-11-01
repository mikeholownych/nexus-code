export interface AdaptiveThrottleOptions {
  baselineConcurrency: number;
  baselineLatencyMs: number;
  minConcurrency?: number;
  maxConcurrency?: number;
  windowSize?: number;
}

export interface TelemetryObservation {
  latencyMs: number;
  ttftMs?: number;
  success: boolean;
  timeout?: boolean;
}

export interface ThrottleMetrics {
  averageLatencyMs: number;
  averageTtftMs: number;
  timeoutRate: number;
  sampleCount: number;
}

/**
 * Dynamically adjusts available concurrency slots based on rolling latency, TTFT,
 * and timeout rates to avoid cascading failures under model or network load.
 */
export class AdaptiveConcurrencyThrottle {
  private readonly baselineConcurrency: number;
  private readonly baselineLatencyMs: number;
  private readonly minConcurrency: number;
  private readonly maxConcurrency: number;
  private readonly windowSize: number;
  private readonly history: TelemetryObservation[] = [];

  constructor(options: AdaptiveThrottleOptions) {
    this.baselineConcurrency = Math.max(1, options.baselineConcurrency);
    this.baselineLatencyMs = Math.max(1, options.baselineLatencyMs);
    this.minConcurrency = Math.max(1, options.minConcurrency ?? 1);
    this.maxConcurrency = options.maxConcurrency ?? this.baselineConcurrency;
    this.windowSize = Math.max(2, options.windowSize ?? 10);
  }

  recordObservation(observation: TelemetryObservation): void {
    this.history.push({ ...observation });
    if (this.history.length > this.windowSize) {
      this.history.shift();
    }
  }

  getCurrentLimit(): number {
    if (this.history.length === 0) {
      return Math.min(this.maxConcurrency, this.baselineConcurrency);
    }

    const metrics = this.getMetrics();

    // If timeout rate exceeds 20%, force to minimum concurrency
    if (metrics.timeoutRate >= 0.2) {
      return this.minConcurrency;
    }

    // Ratio of observed latency to baseline latency
    const latencyRatio = metrics.averageLatencyMs / this.baselineLatencyMs;

    // Normal latency: below 2x baseline latency
    if (latencyRatio < 2.0) {
      return Math.min(this.maxConcurrency, this.baselineConcurrency);
    }

    // High latency (>= 2x baseline): scale concurrency down proportionally
    const adjusted = Math.floor(this.baselineConcurrency / latencyRatio);
    return Math.max(this.minConcurrency, Math.min(this.maxConcurrency, adjusted));
  }

  isThrottled(): boolean {
    return this.getCurrentLimit() < this.baselineConcurrency;
  }

  getMetrics(): ThrottleMetrics {
    if (this.history.length === 0) {
      return {
        averageLatencyMs: this.baselineLatencyMs,
        averageTtftMs: 0,
        timeoutRate: 0,
        sampleCount: 0,
      };
    }

    let totalLatency = 0;
    let totalTtft = 0;
    let ttftCount = 0;
    let timeouts = 0;

    for (const item of this.history) {
      totalLatency += item.latencyMs;
      if (typeof item.ttftMs === "number") {
        totalTtft += item.ttftMs;
        ttftCount++;
      }
      if (item.timeout) {
        timeouts++;
      }
    }

    return {
      averageLatencyMs: totalLatency / this.history.length,
      averageTtftMs: ttftCount > 0 ? totalTtft / ttftCount : 0,
      timeoutRate: timeouts / this.history.length,
      sampleCount: this.history.length,
    };
  }
}

export type BudgetStatus = "OK" | "WARNING" | "CRITICAL" | "EXHAUSTED";

export interface TokenBudgetOptions {
  maxTokens: number;
  warningThreshold?: number;
  criticalThreshold?: number;
}

/**
 * Tracks token consumption against an operation budget, alerting at thresholds
 * and rejecting further consumption once exhausted.
 */
export class TokenBudgetTracker {
  private readonly maxTokens: number;
  private readonly warningRatio: number;
  private readonly criticalRatio: number;
  private consumedTokens = 0;

  constructor(options: TokenBudgetOptions) {
    this.maxTokens = Math.max(1, options.maxTokens);
    this.warningRatio = options.warningThreshold ?? 0.8;
    this.criticalRatio = options.criticalThreshold ?? 0.95;
  }

  consume(tokens: number): boolean {
    if (!Number.isFinite(tokens)) {
      throw new RangeError(`Token count must be a finite number, got ${tokens}`);
    }
    if (tokens <= 0) return true;
    this.consumedTokens += tokens;
    if (this.consumedTokens > this.maxTokens) {
      return false;
    }
    return true;
  }

  getRemainingTokens(): number {
    return Math.max(0, this.maxTokens - this.consumedTokens);
  }

  getTotalConsumed(): number {
    return this.consumedTokens;
  }

  isExhausted(): boolean {
    return this.consumedTokens >= this.maxTokens;
  }

  getWarningStatus(): BudgetStatus {
    const ratio = this.consumedTokens / this.maxTokens;
    if (ratio >= 1.0) return "EXHAUSTED";
    if (ratio >= this.criticalRatio) return "CRITICAL";
    if (ratio >= this.warningRatio) return "WARNING";
    return "OK";
  }
}
