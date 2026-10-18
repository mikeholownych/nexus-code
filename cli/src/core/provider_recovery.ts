import type {
  ExecutionStatus,
  InferenceFailure,
  ProviderCondition,
  ProviderHints,
  ProviderRecoveryRecord,
  TransportCause,
} from "./turn.js";

/** Conditions the agent loop waits out instead of failing the turn. */
export const TEMPORARY_CONDITIONS: ReadonlySet<ProviderCondition> = new Set([
  "TEMPORARILY_UNAVAILABLE",
  "RATE_LIMITED",
  "OVERLOADED",
  "DRAINING",
]);

export interface ProviderClassification {
  condition: ProviderCondition;
  execution: ExecutionStatus;
}

// ---------------------------------------------------------------- provider hints

/** `Retry-After`: delta-seconds or an HTTP-date. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(parseFloat(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Durations such as `1s`, `250ms`, `6m0s`, `1h2m3.5s` (OpenAI `x-ratelimit-reset-*`), or bare seconds. */
export function parseDuration(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(parseFloat(v) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = "";
  for (let m = re.exec(v); m; m = re.exec(v)) {
    const n = parseFloat(m[1]);
    total += m[2] === "h" ? n * 3_600_000 : m[2] === "m" ? n * 60_000 : m[2] === "s" ? n * 1000 : n;
    matched += m[0];
  }
  return matched === v ? Math.round(total) : undefined;
}

type HeaderSource = { get(name: string): string | null } | undefined;

/** Read standard and common provider retry metadata from response headers and an error body. */
export function providerHints(headers: HeaderSource, body?: string, now: number = Date.now()): ProviderHints {
  const h: ProviderHints = {};
  const get = (n: string) => headers?.get(n) ?? null;
  const rawMs = get("retry-after-ms");
  const explicitMs = rawMs && /^\d+(\.\d+)?$/.test(rawMs.trim()) ? Math.round(parseFloat(rawMs)) : undefined;
  const retryAfterMs = explicitMs ?? parseRetryAfter(get("retry-after"), now);
  if (retryAfterMs !== undefined) h.retryAfterMs = retryAfterMs;
  const resets = [get("x-ratelimit-reset-requests"), get("x-ratelimit-reset-tokens"), get("ratelimit-reset")]
    .map(parseDuration)
    .filter((n): n is number => n !== undefined);
  if (resets.length) h.rateLimitResetMs = Math.max(...resets);
  const remReq = Number(get("x-ratelimit-remaining-requests") ?? NaN);
  const remTok = Number(get("x-ratelimit-remaining-tokens") ?? NaN);
  if (Number.isFinite(remReq)) h.remainingRequests = remReq;
  if (Number.isFinite(remTok)) h.remainingTokens = remTok;
  if (body) {
    try {
      const err = JSON.parse(body)?.error;
      if (err && typeof err === "object") {
        if (typeof err.code === "string") h.errorCode = err.code;
        if (typeof err.type === "string") h.errorType = err.type;
      }
    } catch {}
  }
  return h;
}

// ---------------------------------------------------------------- classification

const CAPACITY_CODES = new Set(["context_length_exceeded", "string_above_max_length"]);
/** Error types servers use for a request larger than the loaded context (llama.cpp server: exceed_context_size_error). */
const CAPACITY_TYPES = new Set(["exceed_context_size_error"]);
/** Context-overflow wording of vLLM, llama.cpp, LM Studio and Ollama error messages. */
const CAPACITY_MESSAGE = /context length|context window|maximum context|context size|exceeds the available context|too many tokens|prompt too long/i;
/** Cloud billing/quota exhaustion (OpenAI insufficient_quota, Anthropic billing_error). Waiting does not fix these. */
const QUOTA_CODES = new Set(["insufficient_quota", "billing_error", "payment_required"]);
const NOT_EXECUTED_CODES = new Set(["pre_generation", "gateway_restarting", "pool_unavailable", "adapter_unavailable", "quota_exceeded"]);

/**
 * An HTTP failure status. 429/503/408 and auth/validation 4xx are answers given instead of executing the
 * request (RFC 9110), so execution is NOT_EXECUTED. 500/502/504 may follow admission and generation: UNKNOWN.
 */
export function classifyHttpFailure(status: number, hints: ProviderHints = {}, body = ""): ProviderClassification {
  const code = hints.errorCode;
  if ((code && CAPACITY_CODES.has(code)) || (hints.errorType && CAPACITY_TYPES.has(hints.errorType))) {
    return { condition: "CAPACITY_REJECTED", execution: "NOT_EXECUTED" };
  }
  if (status === 402 || (code && QUOTA_CODES.has(code)) || (hints.errorType && QUOTA_CODES.has(hints.errorType))) {
    return { condition: "QUOTA_EXHAUSTED", execution: "NOT_EXECUTED" };
  }
  if (status === 401 || status === 403) return { condition: "AUTH_FAILURE", execution: "NOT_EXECUTED" };
  if (status === 429) return { condition: "RATE_LIMITED", execution: "NOT_EXECUTED" };
  if (status === 503) {
    const draining = code === "gateway_restarting" || hints.errorType === "draining" || /draining|restarting|shutting down/i.test(body);
    return { condition: draining ? "DRAINING" : "OVERLOADED", execution: "NOT_EXECUTED" };
  }
  if (status === 408) return { condition: "TEMPORARILY_UNAVAILABLE", execution: "NOT_EXECUTED" };
  // 529: Anthropic's "overloaded" answer, given instead of executing the request.
  if (status === 529) return { condition: "OVERLOADED", execution: "NOT_EXECUTED" };
  if (status === 413 || ((status === 400 || status === 422 || status === 500) && CAPACITY_MESSAGE.test(body))) {
    return { condition: "CAPACITY_REJECTED", execution: "NOT_EXECUTED" };
  }
  if (status >= 400 && status < 500) return { condition: "REQUEST_REJECTED", execution: "NOT_EXECUTED" };
  if (status === 500 || status === 502 || status === 504) {
    return { condition: "TEMPORARILY_UNAVAILABLE", execution: code && NOT_EXECUTED_CODES.has(code) ? "NOT_EXECUTED" : "UNKNOWN" };
  }
  return { condition: "PERMANENT_FAILURE", execution: "UNKNOWN" };
}

const CONNECT_NEVER_COMPLETED = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
const TLS_VERIFICATION = /^(CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|ERR_TLS_CERT_ALTNAME_INVALID|ERR_SSL_)/;

export function isTlsVerificationError(chain: TransportCause[]): boolean {
  return chain.some((c) => Boolean(c.code && TLS_VERIFICATION.test(c.code)));
}

/**
 * A fetch/read rejection. Only failures that prove the request never left (connect refused/unreachable, a
 * socket that wrote 0 bytes) are NOT_EXECUTED. Resets and timeouts after connecting are UNKNOWN: the gateway
 * may have admitted the request. TLS verification and unknown-host failures are configuration, not outages.
 */
export function classifyTransportFailure(chain: TransportCause[], phase: "connect" | "stream", timedOut: boolean): ProviderClassification {
  if (phase === "stream" || timedOut) return { condition: "TEMPORARILY_UNAVAILABLE", execution: "UNKNOWN" };
  if (isTlsVerificationError(chain)) return { condition: "PERMANENT_FAILURE", execution: "NOT_EXECUTED" };
  if (chain.some((c) => c.code === "ENOTFOUND")) return { condition: "PERMANENT_FAILURE", execution: "NOT_EXECUTED" };
  if (chain.some((c) => c.code && CONNECT_NEVER_COMPLETED.has(c.code))) return { condition: "TEMPORARILY_UNAVAILABLE", execution: "NOT_EXECUTED" };
  if (chain.some((c) => c.bytesWritten === 0)) return { condition: "TEMPORARILY_UNAVAILABLE", execution: "NOT_EXECUTED" };
  return { condition: "TEMPORARILY_UNAVAILABLE", execution: "UNKNOWN" };
}

// ---------------------------------------------------------------- policy and backoff

export interface RecoveryPolicy {
  /** Overall bound on waiting for one inference step, from its first failure. 0 disables recovery. */
  deadlineMs: number;
  /** Bound when the endpoint has never succeeded in this session (default 120 s; REQ-TUI-105). */
  firstContactDeadlineMs?: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Fraction of each backoff delay that is randomised (0 = fixed, 1 = full jitter). */
  jitterRatio: number;
  minDelayMs: number;
  probeTimeoutMs: number;
  /** Resubmissions allowed per step after a failure whose execution status is UNKNOWN. */
  maxUnknownReplays: number;
  /** Hard stop on loop iterations, independent of time. */
  maxIterations: number;
}

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = {
  deadlineMs: 20 * 60_000,
  firstContactDeadlineMs: 2 * 60_000,
  baseDelayMs: 1_000,
  // Probing is a cheap model-list request, so the wait between probes stays short: with a 60 s cap a run resumed up to
  // a minute after the provider came back (eval pilot 2026-10-13). An advertised Retry-After still wins.
  maxDelayMs: 15_000,
  jitterRatio: 0.5,
  minDelayMs: 500,
  probeTimeoutMs: 5_000,
  maxUnknownReplays: 1,
  maxIterations: 1_000,
};

export function recoveryPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RecoveryPolicy {
  const num = (name: string, fallback: number, min = 0) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  const p = { ...DEFAULT_RECOVERY_POLICY };
  p.deadlineMs = num("LOCAL_LLM_RECOVERY_DEADLINE_MS", p.deadlineMs);
  p.firstContactDeadlineMs = num("NEXUS_FIRST_CONTACT_DEADLINE_MS", p.firstContactDeadlineMs ?? 120_000);
  p.baseDelayMs = num("LOCAL_LLM_RECOVERY_BASE_DELAY_MS", p.baseDelayMs, 1);
  p.maxDelayMs = Math.max(num("LOCAL_LLM_RECOVERY_MAX_DELAY_MS", p.maxDelayMs, 1), p.baseDelayMs);
  p.minDelayMs = Math.min(num("LOCAL_LLM_RECOVERY_MIN_DELAY_MS", p.minDelayMs, 1), p.maxDelayMs);
  p.probeTimeoutMs = num("LOCAL_LLM_RECOVERY_PROBE_TIMEOUT_MS", p.probeTimeoutMs, 1);
  p.maxUnknownReplays = Math.floor(num("LOCAL_LLM_RECOVERY_MAX_UNKNOWN_REPLAYS", p.maxUnknownReplays));
  return p;
}

/** Exponential backoff with partial jitter, floored at `minDelayMs` so no schedule can spin. */
export function backoffDelayMs(consecutiveFailures: number, policy: RecoveryPolicy, random: () => number): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, consecutiveFailures - 1));
  const jittered = exp * (1 - policy.jitterRatio) + random() * exp * policy.jitterRatio;
  return Math.max(policy.minDelayMs, Math.round(jittered));
}

/** A provider-advertised eligible time wins over backoff; a little jitter spreads synchronised clients. */
export function nextDelayMs(consecutiveFailures: number, hints: ProviderHints | undefined, policy: RecoveryPolicy, random: () => number): number {
  const advertised = hints?.retryAfterMs ?? hints?.rateLimitResetMs;
  if (advertised !== undefined) return Math.max(policy.minDelayMs, Math.round(advertised + random() * Math.min(1_000, advertised * 0.1)));
  return backoffDelayMs(consecutiveFailures, policy, random);
}

// ---------------------------------------------------------------- recovery controller

export interface RecoveryClock {
  now(): number;
  random(): number;
  /** Resolves after `ms`, rejects with an AbortError when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realRecoveryClock: RecoveryClock = {
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new RecoveryCancelled());
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new RecoveryCancelled());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

/** The operator cancelled while the loop was waiting for the provider. */
export class RecoveryCancelled extends Error {
  constructor() {
    super("Cancelled while waiting for the inference provider");
    this.name = "RecoveryCancelled";
  }
}

export interface ProbeResult {
  available: boolean;
  condition: ProviderCondition;
  httpStatus?: number;
  hints?: ProviderHints;
  detail?: string;
}

/**
 * One submission of the operation. The link to the submission it replaces is kept in Nexus's recovery record, not
 * sent to the provider: provider retry headers (e.g. aihost X-AIHost-Attempt) mean "retry the task after an
 * outcome" and can change routing, which a transport resubmission must not do.
 */
export interface Submission {
  requestId: string;
  attempt: number;
  previousRequestId?: string;
}

export interface RecoveryHooks<T> {
  submit(s: Submission): Promise<T>;
  /**
   * Side-effect-free reachability check (e.g. GET /models). Never resubmits the operation. `preferAlternate` asks
   * for another endpoint first, because the previous submission may still be executing where it was sent.
   */
  probe(signal: AbortSignal | undefined, opts: { preferAlternate: boolean }): Promise<ProbeResult>;
  /** InferenceFailure for errors this controller may reason about; null rethrows untouched. */
  classify(err: unknown): InferenceFailure | null;
  newRequestId(): string;
  onState?(record: ProviderRecoveryRecord): void;
  /** Every classified failure, so a resource registry can record the condition at its evidenced scope. */
  onFailure?(failure: InferenceFailure): void;
  /**
   * Asked before waiting in place on a NOT_EXECUTED failure (never on UNKNOWN). True ends recovery as YIELDED
   * and rethrows, so a scheduler can reroute or park the work instead of this step waiting on one resource.
   */
  shouldYield?(failure: InferenceFailure, plannedDelayMs: number): boolean;
}

export interface RecoveryControllerOptions {
  /** False when the endpoint has never succeeded in this session; bounds waiting to `firstContactDeadlineMs` (REQ-TUI-105). */
  everSucceeded?: boolean;
  endpoint?: string;
}

/** Startup probe diagnosis (REQ-TUI-105): names the endpoint URL, cause, and fix when unreachable or rejected. */
export function startupEndpointWarning(endpoint: string, probe: ProbeResult): string | undefined {
  if (!probe.available) {
    const cause = probe.detail ? ` (${probe.detail})` : "";
    return `Endpoint ${endpoint} is unreachable${cause}. Run \`nexus doctor\`, check LOCAL_LLM_ENDPOINT in ~/.config/nexus/config.env, or use /connect.`;
  }
  if (probe.httpStatus === 401 || probe.httpStatus === 403) {
    return `Endpoint ${endpoint} rejected credentials (HTTP ${probe.httpStatus}). Run \`nexus doctor\`, check ~/.config/nexus/config.env, or use /connect.`;
  }
  return undefined;
}

/**
 * Keeps one inference step alive across temporary provider failures.
 *
 * Connectivity recovery and operation replay are separate: waiting and probing never execute the operation, and
 * a resubmission happens only when the previous submission's execution status permits it. NOT_EXECUTED may be
 * resubmitted for as long as the deadline allows. UNKNOWN is resubmitted at most `maxUnknownReplays` times and
 * only after a probe shows the provider reachable; this is safe for inference because Nexus acts on a response
 * only after receiving it completely, so an unreceived response has no engineering effect to duplicate.
 */
export class ProviderRecoveryController {
  record: ProviderRecoveryRecord | null = null;
  private readonly effectiveDeadlineMs: number;

  constructor(
    private readonly policy: RecoveryPolicy,
    private readonly clock: RecoveryClock,
    private readonly step: number,
    private readonly options: RecoveryControllerOptions = {},
  ) {
    this.effectiveDeadlineMs =
      options.everSucceeded === false
        ? Math.min(policy.deadlineMs, policy.firstContactDeadlineMs ?? 120_000)
        : policy.deadlineMs;
  }

  async run<T>(initialRequestId: string, hooks: RecoveryHooks<T>, signal?: AbortSignal): Promise<T> {
    let submission: Submission = { requestId: initialRequestId, attempt: 1 };
    let firstFailureAt = 0;
    let consecutive = 0;
    let unknownReplays = 0;
    for (let iteration = 0; ; iteration++) {
      let failure: InferenceFailure | null;
      try {
        const result = await hooks.submit(submission);
        if (this.record) this.transition("RESUMED", { resumedAt: this.iso(), resumedRequestId: submission.requestId }, hooks);
        return result;
      } catch (err) {
        failure = hooks.classify(err);
        if (!failure) throw err;
        if (failure.kind === "aborted") {
          if (this.record) this.transition("CANCELLED", { reason: "operator cancelled a resubmission" }, hooks);
          throw err;
        }
        const condition = failure.condition ?? "PERMANENT_FAILURE";
        const execution = failure.execution ?? "UNKNOWN";
        try {
          hooks.onFailure?.(failure);
        } catch {}
        this.ensureRecord(condition);
        this.record!.submissions.push({
          requestId: submission.requestId,
          attempt: submission.attempt,
          ...(submission.previousRequestId ? { previousRequestId: submission.previousRequestId } : {}),
          failedAt: this.iso(),
          kind: failure.kind,
          condition,
          execution,
          ...(failure.httpStatus ? { httpStatus: failure.httpStatus } : {}),
          ...(failure.hints?.retryAfterMs !== undefined ? { retryAfterMs: failure.hints.retryAfterMs } : {}),
          message: failure.message.slice(0, 300),
        });
        this.record!.condition = condition;

        const stop = (state: ProviderRecoveryRecord["state"], reason: string): never => {
          this.transition(state, { reason }, hooks);
          throw err;
        };
        if (!TEMPORARY_CONDITIONS.has(condition)) stop("NOT_RECOVERABLE", `${condition} is not a temporary provider condition`);
        if (this.effectiveDeadlineMs <= 0) stop("NOT_RECOVERABLE", "provider recovery is disabled (deadline 0)");
        if (iteration >= this.policy.maxIterations) stop("EXHAUSTED", `iteration bound ${this.policy.maxIterations} reached`);
        if (execution === "UNKNOWN") {
          if (unknownReplays >= this.policy.maxUnknownReplays) {
            stop("EXHAUSTED", `execution status unknown and the replay budget (${this.policy.maxUnknownReplays}) is spent`);
          }
          unknownReplays++;
          this.record!.unknownReplays = unknownReplays;
        }
        if (!firstFailureAt) firstFailureAt = this.clock.now();
        consecutive++;

        // Probe before resubmitting when the provider stopped answering, and always before replaying an UNKNOWN.
        const mustProbe = execution === "UNKNOWN" || condition === "TEMPORARILY_UNAVAILABLE" || condition === "DRAINING";
        let hints = failure.hints;
        for (;;) {
          const delay = nextDelayMs(consecutive, hints, this.policy, this.clock.random);
          const elapsed = this.clock.now() - firstFailureAt;
          if (execution === "NOT_EXECUTED" && hooks.shouldYield?.(failure, delay)) {
            stop("YIELDED", `${condition} (not executed); handed to the scheduler instead of waiting ${Math.round(delay / 1000)}s in place`);
          }
          if (elapsed + delay > this.effectiveDeadlineMs) {
            const where = this.options.endpoint ? ` (${this.options.endpoint})` : "";
            const guidance =
              this.options.everSucceeded === false
                ? ` — run \`nexus doctor\`, check LOCAL_LLM_ENDPOINT in ~/.config/nexus/config.env, or use /connect`
                : "";
            stop(
              "EXHAUSTED",
              `provider${where} did not recover within ${Math.round(this.effectiveDeadlineMs / 1000)}s (next wait ${Math.round(delay / 1000)}s would exceed it)${guidance}`,
            );
          }
          this.transition("WAITING", { nextAttemptAt: new Date(this.clock.now() + delay).toISOString() }, hooks);
          try {
            await this.clock.sleep(delay, signal);
          } catch (sleepErr) {
            this.transition("CANCELLED", { reason: "operator cancelled while waiting for the provider" }, hooks);
            throw sleepErr instanceof RecoveryCancelled ? sleepErr : new RecoveryCancelled();
          }
          this.record!.waitedMs += delay;
          if (!mustProbe) break;
          this.transition("PROBING", {}, hooks);
          let probe: ProbeResult;
          try {
            probe = await hooks.probe(signal, { preferAlternate: execution === "UNKNOWN" });
          } catch (probeErr) {
            if (signal?.aborted) {
              this.transition("CANCELLED", { reason: "operator cancelled while probing the provider" }, hooks);
              throw new RecoveryCancelled();
            }
            probe = { available: false, condition: "TEMPORARILY_UNAVAILABLE", detail: String((probeErr as Error)?.message ?? probeErr) };
          }
          this.record!.probes++;
          if (probe.available) break;
          this.record!.condition = probe.condition;
          if (!TEMPORARY_CONDITIONS.has(probe.condition)) stop("NOT_RECOVERABLE", `probe found ${probe.condition}${probe.detail ? `: ${probe.detail}` : ""}`);
          consecutive++;
          hints = probe.hints;
        }

        submission = { requestId: hooks.newRequestId(), attempt: submission.attempt + 1, previousRequestId: submission.requestId };
      }
    }
  }

  private ensureRecord(condition: ProviderCondition): void {
    if (this.record) return;
    const now = this.iso();
    this.record = {
      state: "WAITING",
      step: this.step,
      startedAt: now,
      updatedAt: now,
      condition,
      submissions: [],
      probes: 0,
      waitedMs: 0,
      unknownReplays: 0,
      ...(this.options.endpoint ? { endpoint: this.options.endpoint } : {}),
      ...(this.options.everSucceeded !== undefined ? { everSucceeded: this.options.everSucceeded } : {}),
      policy: { deadlineMs: this.effectiveDeadlineMs, maxDelayMs: this.policy.maxDelayMs, maxUnknownReplays: this.policy.maxUnknownReplays },
    };
  }

  private transition(state: ProviderRecoveryRecord["state"], extra: Partial<ProviderRecoveryRecord>, hooks: RecoveryHooks<unknown>): void {
    const r = this.record!;
    r.state = state;
    r.updatedAt = this.iso();
    if (state !== "WAITING") delete r.nextAttemptAt;
    Object.assign(r, extra);
    try {
      hooks.onState?.({ ...r, submissions: [...r.submissions] });
    } catch {}
  }

  private iso(): string {
    return new Date(this.clock.now()).toISOString();
  }
}
