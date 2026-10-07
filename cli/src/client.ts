import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { ChatMessage, ToolDefinition, HarnessConfig, ToolCall } from "./types.js";
import { InformationFlowBoundary, DestinationTrustBoundary } from "./core/egress.js";
import pc from "picocolors";
import type {
  ExecutionStatus,
  InferenceFailure,
  InferenceFailureKind,
  InferenceFailureOrigin,
  ProviderCondition,
  ProviderHints,
  TransportCause,
} from "./core/turn.js";
import {
  classifyHttpFailure,
  classifyTransportFailure,
  providerHints,
  TEMPORARY_CONDITIONS,
  type ProbeResult,
  type ProviderClassification,
} from "./core/provider_recovery.js";
import { redactSecrets } from "./ui.js";

export function readLatestAuthToken(): string | null {
  // 1. Check opencode client token file
  const opencodeTokenPath = path.join(os.homedir(), ".config/opencode/t5820-client-token");
  if (fs.existsSync(opencodeTokenPath)) {
    try {
      const val = fs.readFileSync(opencodeTokenPath, "utf-8").trim();
      if (val) return val;
    } catch {}
  }

  // 2. Check ~/.config/nexus/config.env
  const configEnvPath = path.join(os.homedir(), ".config/nexus/config.env");
  if (fs.existsSync(configEnvPath)) {
    try {
      const lines = fs.readFileSync(configEnvPath, "utf-8").split("\n");
      for (const line of lines) {
        if (line.startsWith("LOCAL_LLM_API_KEY=")) {
          const val = line.substring("LOCAL_LLM_API_KEY=".length).trim();
          if (val) return val;
        }
      }
    } catch {}
  }

  // 3. Check environment
  if (process.env.LOCAL_LLM_API_KEY) {
    return process.env.LOCAL_LLM_API_KEY.trim();
  }

  return null;
}

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export type StreamTokenCallback = (token: string) => void;

const DEFAULT_CLASSIFICATION: Record<InferenceFailureKind, ProviderClassification> = {
  http_error: { condition: "PERMANENT_FAILURE", execution: "UNKNOWN" },
  network_error: { condition: "TEMPORARILY_UNAVAILABLE", execution: "UNKNOWN" },
  timeout: { condition: "TEMPORARILY_UNAVAILABLE", execution: "UNKNOWN" },
  stream_interrupted: { condition: "TEMPORARILY_UNAVAILABLE", execution: "UNKNOWN" },
  stream_incomplete: { condition: "TEMPORARILY_UNAVAILABLE", execution: "UNKNOWN" },
  provider_error_frame: { condition: "TEMPORARILY_UNAVAILABLE", execution: "UNKNOWN" },
  malformed_event: { condition: "PERMANENT_FAILURE", execution: "UNKNOWN" },
  output_truncated: { condition: "AVAILABLE", execution: "COMPLETED" },
  protocol_error: { condition: "PERMANENT_FAILURE", execution: "COMPLETED" },
  aborted: { condition: "AVAILABLE", execution: "UNKNOWN" },
};

/**
 * Typed inference failure. `condition` is what the failure says about the provider; `execution` is what is known
 * about whether the provider ran the request. Another endpoint is tried immediately only when the request is
 * proven not executed and the condition is temporary; anything else is the agent loop's recovery decision.
 */
export class InferenceError extends Error {
  readonly kind: InferenceFailureKind;
  readonly origin: InferenceFailureOrigin;
  readonly httpStatus?: number;
  readonly requestId?: string;
  readonly partialText: string;
  readonly failoverEligible: boolean;
  readonly transportCause: TransportCause[];
  readonly condition: ProviderCondition;
  readonly execution: ExecutionStatus;
  readonly hints: ProviderHints;

  constructor(
    kind: InferenceFailureKind,
    origin: InferenceFailureOrigin,
    message: string,
    opts: {
      httpStatus?: number;
      requestId?: string;
      partialText?: string;
      failoverEligible?: boolean;
      transportCause?: TransportCause[];
      condition?: ProviderCondition;
      execution?: ExecutionStatus;
      hints?: ProviderHints;
    } = {},
  ) {
    super(message);
    this.name = "InferenceError";
    this.kind = kind;
    this.origin = origin;
    this.httpStatus = opts.httpStatus;
    this.requestId = opts.requestId;
    this.partialText = opts.partialText ?? "";
    this.transportCause = opts.transportCause ?? [];
    this.condition = opts.condition ?? DEFAULT_CLASSIFICATION[kind].condition;
    this.execution = opts.execution ?? DEFAULT_CLASSIFICATION[kind].execution;
    this.hints = opts.hints ?? {};
    this.failoverEligible = opts.failoverEligible ?? (this.execution === "NOT_EXECUTED" && TEMPORARY_CONDITIONS.has(this.condition));
  }

  toFailure(): InferenceFailure {
    return {
      kind: this.kind,
      origin: this.origin,
      message: this.message,
      httpStatus: this.httpStatus,
      requestId: this.requestId,
      partialTextChars: this.partialText.length || undefined,
      ...(this.transportCause.length ? { transportCause: this.transportCause } : {}),
      condition: this.condition,
      execution: this.execution,
      ...(Object.keys(this.hints).length ? { hints: this.hints } : {}),
    };
  }
}


function abortedError(requestId?: string, partialText?: string): InferenceError {
  return new InferenceError("aborted", "operator", "Inference request aborted by operator", { requestId, partialText, failoverEligible: false });
}

/** Walk `err.cause` (and AggregateError members): fetch reports only "fetch failed"/"terminated" at the top. */
export function transportCauseChain(err: any): TransportCause[] {
  const out: TransportCause[] = [];
  const seen = new Set<unknown>();
  const visit = (e: any): void => {
    if (!e || typeof e !== "object" || seen.has(e) || out.length >= 8) return;
    seen.add(e);
    const c: TransportCause = {};
    if (typeof e.name === "string") c.name = e.name;
    if (typeof e.code === "string") c.code = e.code;
    if (typeof e.errno === "number") c.errno = e.errno;
    if (typeof e.syscall === "string") c.syscall = e.syscall;
    if (typeof e.address === "string") c.address = e.address;
    if (typeof e.port === "number") c.port = e.port;
    if (typeof e.socket?.bytesWritten === "number") c.bytesWritten = e.socket.bytesWritten;
    if (typeof e.socket?.bytesRead === "number") c.bytesRead = e.socket.bytesRead;
    if (typeof e.message === "string" && e.message) c.message = redactSecrets(e.message);
    out.push(c);
    if (Array.isArray(e.errors)) for (const sub of e.errors) visit(sub);
    visit(e.cause);
  };
  visit(err?.cause);
  return out;
}

function formatCause(chain: TransportCause[]): string {
  if (!chain.length) return "";
  return ` (cause: ${chain.map((c) => [c.code, c.message].filter(Boolean).join(": ") || c.name).join(" <- ")})`;
}

/** Classify a fetch/read rejection. `operatorSignal` distinguishes operator abort from the request timeout. */
function classifyTransportError(err: any, operatorSignal: AbortSignal | undefined, requestId: string, phase: "connect" | "stream", partialText = ""): InferenceError {
  if (err instanceof InferenceError) return err;
  if (operatorSignal?.aborted) return abortedError(requestId, partialText);
  const transportCause = transportCauseChain(err);
  const timedOut = err?.name === "TimeoutError";
  const classification = classifyTransportFailure(transportCause, phase, timedOut);
  if (timedOut) {
    return new InferenceError("timeout", "transport", `Inference request timed out: ${err.message}${formatCause(transportCause)}`, { requestId, partialText, transportCause, ...classification });
  }
  const msg = `${err?.message || String(err)}${formatCause(transportCause)}`;
  return phase === "stream"
    ? new InferenceError("stream_interrupted", "transport", `Inference stream interrupted before completion: ${msg}`, { requestId, partialText, transportCause, ...classification })
    : new InferenceError("network_error", "transport", `Inference request failed: ${msg}`, { requestId, transportCause, ...classification });
}

export class LocalLlmClient {
  private endpoints: string[] = [];
  private activeEndpointIndex: number = 0;
  private apiKey: string;
  private model: string;
  private temperature: number;
  private boundary: InformationFlowBoundary;
  private taskId?: string;
  private sessionId?: string;
  private taskClass?: string;

  constructor(
    config: HarnessConfig,
    options?: {
      boundary?: InformationFlowBoundary;
      taskId?: string;
      sessionId?: string;
      taskClass?: string;
    }
  ) {
    const normalizeEp = (urlStr: string) => {
      let ep = urlStr.trim().replace(/\/+$/, "");
      if (!ep.endsWith("/v1")) {
        ep = `${ep}/v1`;
      }
      return ep;
    };

    const endpointList: string[] = [normalizeEp(config.endpoint)];
    if (config.fallbackEndpoints && Array.isArray(config.fallbackEndpoints)) {
      for (const fb of config.fallbackEndpoints) {
        if (fb && typeof fb === "string") {
          endpointList.push(normalizeEp(fb));
        }
      }
    }
    if (process.env.LOCAL_LLM_FALLBACK_ENDPOINTS) {
      for (const fb of process.env.LOCAL_LLM_FALLBACK_ENDPOINTS.split(",")) {
        if (fb.trim()) {
          endpointList.push(normalizeEp(fb));
        }
      }
    }
    this.endpoints = Array.from(new Set(endpointList));
    this.activeEndpointIndex = 0;

    this.apiKey =
      config.apiKey && config.apiKey !== "local" && config.apiKey !== "not-needed"
        ? config.apiKey
        : readLatestAuthToken() || "not-needed";
    this.model = config.model;
    this.temperature = config.temperature ?? 0.2;
    this.boundary = options?.boundary || InformationFlowBoundary.getGlobalInstance();
    this.taskId = options?.taskId;
    this.sessionId = options?.sessionId;
    this.taskClass = options?.taskClass ?? config.taskClass;
  }

  /** Hint the gateway's route table (sent as X-Task-Class); undefined sends none. */
  public setTaskClass(taskClass?: string): void {
    this.taskClass = taskClass;
  }

  /**
   * Tool-call arguments must be a JSON string on the wire: servers such as llama.cpp parse the history
   * and reject the whole request (HTTP 500) when any earlier assistant tool call has malformed arguments.
   * Malformed arguments are wrapped so the history stays valid and the original text is preserved.
   */
  private sanitizeHistory(messages: ChatMessage[]): ChatMessage[] {
    let changed = false;
    const out = messages.map((m) => {
      if (m.role !== "assistant" || !m.tool_calls?.length) return m;
      const calls = m.tool_calls.map((tc) => {
        const a = tc.function?.arguments;
        if (typeof a !== "string") return tc;
        try {
          JSON.parse(a || "{}");
          return tc;
        } catch {
          changed = true;
          return { ...tc, function: { ...tc.function, arguments: JSON.stringify({ raw: a }) } };
        }
      });
      return { ...m, tool_calls: calls };
    });
    return changed ? out : messages;
  }

  private routingHeaders(): Record<string, string> {
    return this.taskClass && /^[A-Za-z0-9_.-]{1,64}$/.test(this.taskClass) ? { "X-Task-Class": this.taskClass } : {};
  }

  /** Switch the model in place so session, task, boundary and routing state survive the change. */
  public setModel(model: string): void {
    this.model = model;
  }

  private requestTimeoutMs(): number {
    const raw = Number(process.env.LOCAL_LLM_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 900_000;
  }

  public setTaskId(taskId?: string): void {
    this.taskId = taskId;
  }

  public getTaskId(): string | undefined {
    return this.taskId;
  }

  public setSessionId(sessionId?: string): void {
    this.sessionId = sessionId;
  }

  public getSessionId(): string | undefined {
    return this.sessionId;
  }

  public getBoundary(): InformationFlowBoundary {
    return this.boundary;
  }

  public setBoundary(boundary: InformationFlowBoundary): void {
    this.boundary = boundary;
  }

  public get endpoint(): string {
    return this.endpoints[this.activeEndpointIndex] || this.endpoints[0];
  }

  public getActiveEndpoint(): string {
    return this.endpoint;
  }

  public getEndpoints(): string[] {
    return [...this.endpoints];
  }

  public addFallbackEndpoint(endpoint: string): void {
    let ep = endpoint.trim().replace(/\/+$/, "");
    if (!ep.endsWith("/v1")) {
      ep = `${ep}/v1`;
    }
    if (!this.endpoints.includes(ep)) {
      this.endpoints.push(ep);
    }
  }

  public setApiKey(key: string): void {
    this.apiKey = key;
  }

  public reloadAuthToken(): boolean {
    const fresh = readLatestAuthToken();
    if (fresh && fresh !== this.apiKey) {
      this.apiKey = fresh;
      return true;
    }
    return false;
  }

  private async executeWithFailover<T>(
    operationName: string,
    operation: (endpoint: string) => Promise<T>
  ): Promise<T> {
    const total = this.endpoints.length;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < total; attempt++) {
      const idx = (this.activeEndpointIndex + attempt) % total;
      const currentEp = this.endpoints[idx];

      try {
        const result = await operation(currentEp);
        if (idx !== this.activeEndpointIndex) {
          console.warn(
            pc.yellow(`\n⚡ Failover: Active inference endpoint switched to ${currentEp}`)
          );
          this.activeEndpointIndex = idx;
        }
        return result;
      } catch (err: any) {
        lastError = err;
        if (err instanceof InferenceError && !err.failoverEligible) throw err;
        if (total > 1 && attempt < total - 1) {
          const nextIdx = (idx + 1) % total;
          console.warn(
            pc.dim(
              `⚠️ [Failover] ${operationName} failed on ${currentEp} (${err.message}). Trying backup endpoint ${this.endpoints[nextIdx]}...`
            )
          );
        }
      }
    }

    throw (
      lastError ||
      new Error(
        `All inference endpoints failed for ${operationName} (attempted: ${this.endpoints.join(", ")})`
      )
    );
  }

  async listModels(): Promise<string[]> {
    return this.executeWithFailover("listModels", async (currentEp) => {
      const url = `${currentEp}/models`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (res.status === 401 && this.reloadAuthToken()) {
        const retryRes = await fetch(url, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        });
        if (retryRes.ok) {
          const data = (await retryRes.json()) as { data?: Array<{ id: string }> };
          return data.data?.map((m) => m.id) || [];
        }
      }

      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}: ${res.statusText}`);
      }

      const data = (await res.json()) as { data?: Array<{ id: string }> };
      return data.data?.map((m) => m.id) || [];
    });
  }

  /**
   * Side-effect-free reachability check (GET /models) used while waiting out a provider failure. Any answer other
   * than 408/429/5xx shows the server is serving again; the first endpoint that answers becomes active.
   * `preferAlternate` starts with the next endpoint, so a request of unknown status is resubmitted elsewhere
   * when another endpoint is available.
   */
  async probeAvailability(signal?: AbortSignal, opts: { timeoutMs?: number; preferAlternate?: boolean } = {}): Promise<ProbeResult> {
    const total = this.endpoints.length;
    const start = opts.preferAlternate && total > 1 ? (this.activeEndpointIndex + 1) % total : this.activeEndpointIndex;
    let last: ProbeResult = { available: false, condition: "TEMPORARILY_UNAVAILABLE" };
    for (let i = 0; i < total; i++) {
      const idx = (start + i) % total;
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? 5_000);
      try {
        const res = await fetch(`${this.endpoints[idx]}/models`, {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        });
        const body = await res.text().catch(() => "");
        if (res.status < 500 && res.status !== 429 && res.status !== 408) {
          this.activeEndpointIndex = idx;
          return { available: true, condition: "AVAILABLE", httpStatus: res.status };
        }
        const hints = providerHints(res.headers, body);
        last = { ...classifyHttpFailure(res.status, hints, body), available: false, httpStatus: res.status, hints, detail: `HTTP ${res.status}` };
      } catch (err: any) {
        if (signal?.aborted) throw err;
        const chain = transportCauseChain(err);
        const { condition } = classifyTransportFailure(chain, "connect", err?.name === "TimeoutError");
        last = { available: false, condition, detail: `${err?.message ?? err}${formatCause(chain)}` };
        if (!TEMPORARY_CONDITIONS.has(condition)) return last;
      }
    }
    return last;
  }

  async chatCompletion(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    requestId: string = randomUUID(),
    signal?: AbortSignal,
  ): Promise<ChatMessage> {
    return this.executeWithFailover("chatCompletion", async (currentEp) => {
      if (signal?.aborted) throw abortedError(requestId);
      const url = `${currentEp}/chat/completions`;

      // 1. Egress Interception & Quarantine (DISC-001..003, CTX-006, FAIL-003)
      const egressEvaluation = this.boundary.evaluateEgress(
        messages,
        currentEp,
        {
          taskId: this.taskId,
          sessionId: this.sessionId,
          sourceBoundary: "HOST_LOCAL",
        }
      );

      if (!egressEvaluation.allowed) {
        throw new Error(
          egressEvaluation.reason || `Egress to endpoint '${currentEp}' denied by InformationFlowBoundary [FAIL-003].`
        );
      }

      const outboundMessages: ChatMessage[] = this.sanitizeHistory(egressEvaluation.sanitizedPayload || messages);

      let outboundTools = tools;
      if (tools.length > 0) {
        const toolsEgress = this.boundary.evaluateEgress(
          tools,
          currentEp,
          {
            taskId: this.taskId,
            sessionId: this.sessionId,
            sourceBoundary: "HOST_LOCAL",
          }
        );
        if (!toolsEgress.allowed) {
          throw new Error(
            toolsEgress.reason || `Egress of tools to endpoint '${currentEp}' denied by InformationFlowBoundary [FAIL-003].`
          );
        }
        outboundTools = toolsEgress.sanitizedPayload || tools;
      }

      const payload: any = {
        model: this.model,
        messages: outboundMessages.map((m) => ({
          role: m.role,
          content: m.content ?? null,
          ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          ...(m.name ? { name: m.name } : {}),
        })),
        temperature: this.temperature,
      };

      if (outboundTools.length > 0) {
        payload.tools = outboundTools;
        payload.tool_choice = "auto";
      }

      let res: Response;
      let data: ChatCompletionResponse;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            "X-Request-ID": requestId,
            ...this.routingHeaders(),
          },
          body: JSON.stringify(payload),
          signal: this.combinedSignal(signal),
        });

        if (res.status === 401 && this.reloadAuthToken()) {
          return this.chatCompletion(messages, tools, requestId, signal);
        }

        if (!res.ok) {
          const errText = await res.text();
          throw this.httpError(res.status, errText, requestId, res.headers);
        }
        data = (await res.json()) as ChatCompletionResponse;
      } catch (err: any) {
        throw classifyTransportError(err, signal, requestId, "connect");
      }
      if (!data.choices || data.choices.length === 0) {
        throw new InferenceError("protocol_error", "provider", "Model returned empty choices array", { requestId, failoverEligible: false });
      }

      const choice = data.choices[0] as { message: ChatMessage; finish_reason?: string };
      if (choice.finish_reason === "length") {
        throw new InferenceError(
          "output_truncated",
          "client",
          choice.message.tool_calls?.length
            ? "Model output was truncated (finish_reason=length) inside a tool call; refusing to run partial arguments."
            : "Model output was truncated (finish_reason=length); refusing to treat it as a complete answer.",
          { requestId, partialText: typeof choice.message.content === "string" ? choice.message.content : "", failoverEligible: false },
        );
      }
      return choice.message;
    });
  }

  /**
   * Real-time SSE token streaming for typewriter terminal output (matching Codex / Claude Code)
   */
  async chatCompletionStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onToken?: StreamTokenCallback,
    requestId: string = randomUUID(),
    signal?: AbortSignal,
  ): Promise<ChatMessage> {
    return this.executeWithFailover("chatCompletionStream", async (currentEp) => {
      if (signal?.aborted) throw abortedError(requestId);
      const url = `${currentEp}/chat/completions`;

      // 1. Egress Interception & Quarantine (DISC-001..003, CTX-006, FAIL-003)
      const egressEvaluation = this.boundary.evaluateEgress(
        messages,
        currentEp,
        {
          taskId: this.taskId,
          sessionId: this.sessionId,
          sourceBoundary: "HOST_LOCAL",
        }
      );

      if (!egressEvaluation.allowed) {
        throw new Error(
          egressEvaluation.reason || `Egress to endpoint '${currentEp}' denied by InformationFlowBoundary [FAIL-003].`
        );
      }

      const outboundMessages: ChatMessage[] = this.sanitizeHistory(egressEvaluation.sanitizedPayload || messages);

      let outboundTools = tools;
      if (tools.length > 0) {
        const toolsEgress = this.boundary.evaluateEgress(
          tools,
          currentEp,
          {
            taskId: this.taskId,
            sessionId: this.sessionId,
            sourceBoundary: "HOST_LOCAL",
          }
        );
        if (!toolsEgress.allowed) {
          throw new Error(
            toolsEgress.reason || `Egress of tools to endpoint '${currentEp}' denied by InformationFlowBoundary [FAIL-003].`
          );
        }
        outboundTools = toolsEgress.sanitizedPayload || tools;
      }

      const payload: any = {
        model: this.model,
        messages: outboundMessages.map((m) => ({
          role: m.role,
          content: m.content ?? null,
          ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          ...(m.name ? { name: m.name } : {}),
        })),
        temperature: this.temperature,
        stream: true,
      };

      if (outboundTools.length > 0) {
        payload.tools = outboundTools;
        payload.tool_choice = "auto";
      }

      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            "X-Request-ID": requestId,
            ...this.routingHeaders(),
          },
          body: JSON.stringify(payload),
          signal: this.combinedSignal(signal),
        });
      } catch (err: any) {
        // No resend here: a rejected fetch does not prove the gateway never admitted the request, and a
        // second attempt would replace this error with its own. Recovery belongs to the agent loop.
        throw classifyTransportError(err, signal, requestId, "connect");
      }

      if (res.status === 401 && this.reloadAuthToken()) {
        return this.chatCompletionStream(messages, tools, onToken, requestId, signal);
      }

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => res.statusText);
        throw this.httpError(res.status, errText, requestId, res.headers);
      }

      let fullContent = "";
      let finishReason: string | undefined;
      let sawDone = false;
      const toolCallsMap: Map<number, { id: string; name: string; args: string }> = new Map();

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      // Positive completion evidence for this protocol: a chunk carrying a non-null finish_reason, or the
      // terminal `data: [DONE]` event. Absence of both means the stream ended early.
      const handleLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) return;
        if (trimmed === "data: [DONE]") {
          sawDone = true;
          return;
        }
        if (!trimmed.startsWith("data: ")) return;
        let chunk: any;
        try {
          chunk = JSON.parse(trimmed.slice(6));
        } catch {
          throw new InferenceError("malformed_event", "provider", `Malformed stream event: ${trimmed.slice(0, 120)}`, {
            requestId,
            partialText: fullContent,
            failoverEligible: false,
          });
        }
        if (chunk && typeof chunk === "object" && chunk.error) {
          const em = typeof chunk.error === "string" ? chunk.error : chunk.error.message || JSON.stringify(chunk.error);
          const hints = providerHints(undefined, JSON.stringify({ error: chunk.error }));
          // The request was admitted. Only an explicit pre-generation code proves the model never ran it.
          const classification: ProviderClassification =
            hints.errorCode === "context_length_exceeded"
              ? { condition: "CAPACITY_REJECTED", execution: "NOT_EXECUTED" }
              : { condition: "TEMPORARILY_UNAVAILABLE", execution: hints.errorCode === "pre_generation" && !fullContent ? "NOT_EXECUTED" : "UNKNOWN" };
          throw new InferenceError("provider_error_frame", "provider", `Provider error frame mid-stream: ${em}`, {
            requestId,
            partialText: fullContent,
            hints,
            ...classification,
          });
        }
        if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) return;

        // 1. Text token chunk
        if (delta.content) {
          fullContent += delta.content;
          if (onToken) {
            onToken(delta.content);
          }
        }

        // 2. Tool call chunks
        if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            // Spec streams give every fragment an index. Some servers (and re-streamed non-streaming
            // responses) omit it; then a fragment that carries an id or a name starts a NEW call, and
            // one with neither continues the latest call. Never fold distinct calls into index 0.
            let idx: number;
            if (typeof tc.index === "number") {
              idx = tc.index;
            } else if (tc.id || tc.function?.name) {
              idx = toolCallsMap.size === 0 ? 0 : Math.max(...toolCallsMap.keys()) + 1;
            } else {
              idx = toolCallsMap.size === 0 ? 0 : Math.max(...toolCallsMap.keys());
            }
            const current = toolCallsMap.get(idx) || { id: "", name: "", args: "" };

            if (tc.id) current.id = tc.id;
            if (tc.function?.name) current.name += tc.function.name;
            if (tc.function?.arguments) current.args += tc.function.arguments;

            toolCallsMap.set(idx, current);
          }
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) handleLine(line);
        }
        if (buffer.trim()) handleLine(buffer);
      } catch (streamErr: any) {
        try { await reader.cancel(); } catch {}
        const classified = classifyTransportError(streamErr, signal, requestId, "stream", fullContent);
        // A transport error after the terminal event cannot change the (already complete) response.
        const postCompletionTransportError = (finishReason || sawDone) && !(streamErr instanceof InferenceError) && classified.kind !== "aborted";
        if (!postCompletionTransportError) throw classified;
      }

      if (!finishReason && !sawDone) {
        throw new InferenceError(
          "stream_incomplete",
          "transport",
          "Inference stream ended without a finish_reason or [DONE]; response is incomplete.",
          { requestId, partialText: fullContent },
        );
      }

      const assembledToolCalls: ToolCall[] = [];
      for (const [_, tc] of toolCallsMap.entries()) {
        if (tc.name) {
          assembledToolCalls.push({
            id: tc.id || `call_${Math.random().toString(36).substring(2, 9)}`,
            type: "function",
            function: {
              name: tc.name,
              arguments: tc.args,
            },
          });
        }
      }

      if (finishReason === "length") {
        throw new InferenceError(
          "output_truncated",
          "client",
          assembledToolCalls.length > 0
            ? "Model output was truncated (finish_reason=length) inside a tool call; refusing to run partial arguments."
            : "Model output was truncated (finish_reason=length); refusing to treat it as a complete answer.",
          { requestId, partialText: fullContent, failoverEligible: false },
        );
      }

      // The stream completed with nothing in it; the non-streaming re-request is a new operation with its own
      // X-Request-ID so the provider's records never show two executions under one request ID.
      if (!fullContent && assembledToolCalls.length === 0) {
        return this.chatCompletion(messages, tools, randomUUID(), signal);
      }

      return {
        role: "assistant",
        content: fullContent || null,
        ...(assembledToolCalls.length > 0 ? { tool_calls: assembledToolCalls } : {}),
      };
    });
  }

  private combinedSignal(operatorSignal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs());
    return operatorSignal ? AbortSignal.any([timeout, operatorSignal]) : timeout;
  }

  /** HTTP 5xx/429/408 are provider-side; other 4xx are request faults (client origin). */
  private httpError(status: number, body: string, requestId: string, headers?: Headers): InferenceError {
    const providerSide = status >= 500 || status === 429 || status === 408;
    const hints = providerHints(headers, body);
    return new InferenceError("http_error", providerSide ? "provider" : "client", `Inference error (HTTP ${status}): ${body}`, {
      httpStatus: status,
      requestId,
      hints,
      ...classifyHttpFailure(status, hints, body),
    });
  }

  public getModel(): string {
    return this.model;
  }

  async generateEmbedding(text: string, model?: string): Promise<number[]> {
    return this.executeWithFailover("generateEmbedding", async (currentEp) => {
      const url = `${currentEp}/embeddings`;

      // 1. Egress Interception & Quarantine (DISC-001..003, CTX-006, FAIL-003)
      const egressEvaluation = this.boundary.evaluateEgress(
        text,
        currentEp,
        {
          taskId: this.taskId,
          sessionId: this.sessionId,
          sourceBoundary: "HOST_LOCAL",
        }
      );

      if (!egressEvaluation.allowed) {
        throw new Error(
          egressEvaluation.reason || `Egress to endpoint '${currentEp}' denied by InformationFlowBoundary [FAIL-003].`
        );
      }

      const outboundText = egressEvaluation.sanitizedText || text;

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: model || this.model,
          input: outboundText,
        }),
      });

      if (!res.ok) {
        throw new Error(`Embedding request failed (${res.status}): ${await res.text()}`);
      }

      const data: any = await res.json();
      if (data.data && Array.isArray(data.data) && data.data[0]?.embedding) {
        return data.data[0].embedding;
      }
      throw new Error("Invalid embedding response format");
    });
  }
}
