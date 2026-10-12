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
import { connectionFor, disclosureClass, operatorSettingKeyForAuth, type ResolvedConnection } from "./providers.js";
import { ProviderStreamError, readSse, type NativeRequestInput, type NativeResult } from "./protocols/common.js";
import { anthropicStreamParser, buildAnthropicRequest, parseAnthropicResponse } from "./protocols/anthropic.js";
import { buildResponsesRequest, parseResponsesResponse, responsesStreamParser } from "./protocols/openai_responses.js";
import { UsageLedger, type UsageReport } from "./usage.js";
import { resolveCredential, saveCredential, type StoredCredential } from "./credentials.js";
import { COPILOT_HEADERS, copilotToken, refreshOAuth } from "./oauth.js";
import { providerDefinition } from "./providers.js";

type OAuthCredential = Extract<StoredCredential, { type: "oauth" }>;

function originOf(url: string | undefined): string | undefined {
  if (!url?.trim()) return undefined;
  try {
    return new URL(url.trim()).origin;
  } catch {
    return undefined;
  }
}

/** The origin a credential configured for `endpoint` belongs to. */
export function credentialOriginOf(endpoint: string | undefined): string | undefined {
  return originOf(endpoint);
}

function readConfigEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(path.join(credentialStorageHome(), ".config/nexus/config.env"), "utf-8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {}
  return out;
}

function readGatewayTokenFile(): string | undefined {
  try {
    return fs.readFileSync(path.join(credentialStorageHome(), ".config/opencode/t5820-client-token"), "utf-8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Settings with authority over where credentials may be sent: the operator's process environment as it was before
 * any env file was loaded, overlaid by ~/.config/nexus/config.env. Project and installation .env files are excluded:
 * they may choose endpoints and carry their own keys, but they never decide where a stored credential goes.
 * Undefined until loadEnvironment() records it; until then nothing but the operator has written process.env.
 */
let credentialAuthority: Readonly<Record<string, string | undefined>> | undefined;
/**
 * The operator's home directory as resolved when the authority was recorded: the stored credentials (config.env, the
 * gateway token file) are read from there, never from a HOME that an env file set later.
 */
let credentialHome: string | undefined;

export function setCredentialAuthority(settings: Record<string, string | undefined>, operatorHome: string = os.homedir()): void {
  credentialAuthority = Object.freeze({ ...settings });
  credentialHome = operatorHome;
}

/** Where the operator's stored credentials live (the live home only before any authority is recorded). */
export function credentialStorageHome(): string {
  return credentialHome ?? os.homedir();
}

function authoritySetting(key: string): string | undefined {
  return (credentialAuthority ? credentialAuthority[key] : process.env[key])?.trim() || undefined;
}

/** A setting as the operator configured it (operator environment + config.env; never a project or install .env). */
export function operatorSetting(key: string): string | undefined {
  return authoritySetting(key);
}

/** Origins that stored credentials belong to, and the operator-environment key with its own origin. */
function storedCredentialHomes(): { gateway?: string; listed: Set<string>; envKey?: string; envKeyOrigin?: string } {
  const file = readConfigEnv();
  const envKeyOrigin = originOf(authoritySetting("LOCAL_LLM_ENDPOINT"));
  const gateway = originOf(file.LOCAL_LLM_ENDPOINT) ?? envKeyOrigin;
  const listed = new Set(
    (authoritySetting("LOCAL_LLM_CREDENTIAL_ORIGINS") ?? "").split(",").map((o) => originOf(o)).filter((o): o is string => Boolean(o)),
  );
  return { gateway, listed, envKey: authoritySetting("LOCAL_LLM_API_KEY"), envKeyOrigin };
}

/**
 * The locally stored credential for `endpoint`, only if it belongs to that endpoint's gateway; null otherwise.
 *
 * Stored credentials are scoped to where they were configured: the gateway token file and the config.env key belong
 * to config.env's LOCAL_LLM_ENDPOINT (or, without one, the operator's $LOCAL_LLM_ENDPOINT) and to origins the operator
 * lists in LOCAL_LLM_CREDENTIAL_ORIGINS; the operator's $LOCAL_LLM_API_KEY belongs to the operator's
 * $LOCAL_LLM_ENDPOINT. Only the credential authority (see setCredentialAuthority) decides these bindings. A
 * credential is never attached to another provider merely because that provider has no key of its own.
 */
export function storedCredentialFor(endpoint: string): string | null {
  const target = originOf(endpoint);
  if (!target) return null;
  const homes = storedCredentialHomes();
  if (target === homes.gateway || homes.listed.has(target)) {
    const token = readGatewayTokenFile() || readConfigEnv().LOCAL_LLM_API_KEY;
    if (token) return token;
  }
  if (target === homes.envKeyOrigin && homes.envKey) return homes.envKey;
  return null;
}

/** True when `value` is one of the locally stored credentials (token file, config.env key, operator env key). */
function isStoredCredential(value: string): boolean {
  const homes = storedCredentialHomes();
  return [readGatewayTokenFile(), readConfigEnv().LOCAL_LLM_API_KEY, homes.envKey].some((stored) => stored && stored === value);
}

/**
 * Whether `key`, supplied for `endpoint` by configuration other than the credential authority (an operation spec's
 * apiKeyEnv, for example), may be sent there. Keys of their own are; a stored credential only to where it belongs.
 */
export function mayBindCredential(key: string | undefined, endpoint: string): boolean {
  const value = key?.trim();
  if (!value || !isStoredCredential(value)) return true;
  const target = originOf(endpoint);
  if (!target) return false;
  const homes = storedCredentialHomes();
  return target === homes.gateway || homes.listed.has(target) || (target === homes.envKeyOrigin && value === homes.envKey);
}

/**
 * $LOCAL_LLM_API_KEY and the origin it is bound to. The operator's key belongs to the operator's endpoint (or, when
 * the operator configured none, `operatorEndpoint`: the command-line endpoint or the built-in default). A key that a
 * project .env supplied belongs to the endpoint that configuration selects; it is that project's credential.
 */
export function environmentCredential(operatorEndpoint: string): { apiKey: string; origin: string | undefined } | undefined {
  const apiKey = process.env.LOCAL_LLM_API_KEY?.trim();
  if (!apiKey) return undefined;
  const operatorKey = authoritySetting("LOCAL_LLM_API_KEY");
  if (operatorKey === apiKey) return { apiKey, origin: originOf(authoritySetting("LOCAL_LLM_ENDPOINT") ?? operatorEndpoint) };
  if (isStoredCredential(apiKey)) return undefined;
  return { apiKey, origin: originOf(process.env.LOCAL_LLM_ENDPOINT ?? operatorEndpoint) };
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
  policy_denied: { condition: "REQUEST_REJECTED", execution: "NOT_EXECUTED" },
  configuration_error: { condition: "REQUEST_REJECTED", execution: "NOT_EXECUTED" },
};

/** Chat Completions usage (OpenRouter adds `cost`). */
function chatUsage(u: any): UsageReport | undefined {
  if (!u || typeof u !== "object") return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const r: UsageReport = {};
  if (n(u.prompt_tokens) !== undefined) r.inputTokens = u.prompt_tokens;
  if (n(u.completion_tokens) !== undefined) r.outputTokens = u.completion_tokens;
  if (n(u.prompt_tokens_details?.cached_tokens) !== undefined) r.cachedInputTokens = u.prompt_tokens_details.cached_tokens;
  if (n(u.completion_tokens_details?.reasoning_tokens) !== undefined) r.reasoningTokens = u.completion_tokens_details.reasoning_tokens;
  if (n(u.cost) !== undefined) r.costUsd = u.cost;
  return r;
}

/** What the provider reported about the request in progress (for its receipt). */
interface PendingRequest { usage?: UsageReport; providerRequestId?: string; effectiveModel?: string; endpoint?: string }

/** Model ids from a `/models` answer: OpenAI-style `data[].id`, or the ChatGPT backend's listed `models[].slug`. */
function modelIds(body: any): string[] {
  if (Array.isArray(body?.data)) return body.data.map((m: any) => m?.id).filter((id: unknown): id is string => typeof id === "string");
  if (Array.isArray(body?.models)) return body.models.filter((m: any) => !m?.visibility || m.visibility === "list").map((m: any) => m?.slug ?? m?.id).filter((id: unknown): id is string => typeof id === "string");
  return [];
}

/** Optional request parameters a provider may reject; dropping one never changes what the request asks for. */
const DROPPABLE_PARAMS = new Set(["temperature", "top_p", "max_output_tokens", "stream_options"]);

/** The parameter a 400 answer names as unsupported ("Unsupported parameter: temperature", OpenAI `param`). */
export function unsupportedParameter(message: string): string | undefined {
  const named = /unsupported (?:parameter|value)[:\s'"`]+([a-z_]+)/i.exec(message)?.[1];
  if (named) return named.toLowerCase();
  if (/unsupported_parameter|not supported/i.test(message)) return /"param"\s*:\s*"([a-z_]+)"/i.exec(message)?.[1]?.toLowerCase();
  return undefined;
}

/** Cloud destinations announced in this process (the disclosure notice is shown once per origin). */
const announcedDestinations = new Set<string>();
/** Provider error bodies are bounded and redacted before they reach messages, logs or the UI. */
const MAX_PROVIDER_ERROR_CHARS = 2_000;

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
  /** Explicitly configured key and the origin it belongs to (config.credentialOrigin, else the primary endpoint). */
  private explicitKey?: string;
  private explicitOrigin?: string;
  /** Stored credentials resolved per origin; an origin whose stored credential rotated in supersedes its explicit key. */
  private storedKeys = new Map<string, string | null>();
  private rotated = new Set<string>();
  private model: string;
  private temperature: number;
  private boundary: InformationFlowBoundary;
  private taskId?: string;
  private sessionId?: string;
  private taskClass?: string;
  /** The connection's provider, protocol, auth style and disclosure behaviour (legacy endpoint path when no provider). */
  private conn: ResolvedConnection;
  /** ChatGPT account the signed-in token belongs to (sent as chatgpt-account-id). */
  private oauthAccountId?: string;
  /**
   * Parameters this connection does not send: those its provider never accepts, plus any the provider rejected as
   * unsupported during this session (learned once, then omitted from every later request).
   */
  private unsupportedParams = new Set<string>();
  /** Copilot API token exchanged from another client's GitHub token; held in memory only. */
  private exchangedToken?: OAuthCredential;
  private readonly authorizedOrigins: Set<string>;
  private readonly cloudRoutedOrigins: string[];
  private readonly workspace?: string;
  private readonly role: string;
  private readonly maxOutputTokens: number;
  private readonly reasoningEffort?: string;
  private readonly thinkingBudget?: number;
  /** Usage the provider reported for the most recent completed request on this client (provider connections only). */
  private lastUsageReport?: UsageReport;
  private pending?: PendingRequest;
  /** Ledger reservations taken by the request in progress (released when its receipt is recorded). */
  private reservations: string[] = [];

  constructor(
    config: HarnessConfig,
    options?: {
      boundary?: InformationFlowBoundary;
      taskId?: string;
      sessionId?: string;
      taskClass?: string;
      /** Receipt label: main, planner, coder, subagent, work-unit. */
      role?: string;
    }
  ) {
    this.conn = connectionFor(config.provider, config.model);
    this.unsupportedParams = new Set(this.conn.omitParams);
    // A provider's base URL already carries its API path and version; only the legacy endpoint path appends /v1.
    const normalizeEp = (urlStr: string) => {
      let ep = urlStr.trim().replace(/\/+$/, "");
      if (!this.conn.providerId && !ep.endsWith("/v1")) {
        ep = `${ep}/v1`;
      }
      return ep;
    };

    const endpointList: string[] = [normalizeEp(config.endpoint)];
    if (!config.pinEndpoint && !this.conn.providerId && config.fallbackEndpoints && Array.isArray(config.fallbackEndpoints)) {
      for (const fb of config.fallbackEndpoints) {
        if (fb && typeof fb === "string") {
          endpointList.push(normalizeEp(fb));
        }
      }
    }
    if (!config.pinEndpoint && !this.conn.providerId && process.env.LOCAL_LLM_FALLBACK_ENDPOINTS) {
      for (const fb of process.env.LOCAL_LLM_FALLBACK_ENDPOINTS.split(",")) {
        if (fb.trim()) {
          endpointList.push(normalizeEp(fb));
        }
      }
    }
    this.endpoints = Array.from(new Set(endpointList));
    this.activeEndpointIndex = 0;

    if (config.apiKey && config.apiKey !== "local" && config.apiKey !== "not-needed") {
      this.explicitKey = config.apiKey;
      this.explicitOrigin = originOf(config.credentialOrigin ?? normalizeEp(config.endpoint));
    }
    this.model = config.model;
    this.temperature = config.temperature ?? 0.2;
    this.boundary = options?.boundary || InformationFlowBoundary.getGlobalInstance();
    this.taskId = options?.taskId;
    this.sessionId = options?.sessionId;
    this.taskClass = options?.taskClass ?? config.taskClass;
    // Configurations built by buildConfig carry the operator's authorization; programmatic configurations authorize
    // the destinations they name directly (never their fallbacks).
    this.authorizedOrigins = new Set(
      (config.authorizedDisclosureOrigins ?? [config.endpoint, config.plannerEndpoint, config.coderEndpoint].map((e) => (e ? originOf(normalizeEp(e)) : undefined)))
        .filter((o): o is string => Boolean(o)),
    );
    this.cloudRoutedOrigins = config.cloudRoutedOrigins ?? [];
    this.workspace = config.workspace;
    this.role = options?.role ?? (config.taskClass === "subagent" ? "subagent" : "main");
    this.maxOutputTokens = config.completionReserveTokens ?? 8192;
    this.reasoningEffort = config.reasoningEffort;
    this.thinkingBudget = config.anthropicThinkingBudget;
  }

  /** Provider id of this connection; undefined on the legacy appliance/endpoint path. */
  public getProviderId(): string | undefined {
    return this.conn.providerId;
  }

  /** Usage the provider reported for the last completed request (undefined on the appliance path or when unreported). */
  public getLastUsage(): UsageReport | undefined {
    return this.lastUsageReport;
  }

  /** "cloud" when `url` (default: the active endpoint) receives content outside the operator's machines/network. */
  public disclosureOf(url: string = this.endpoint): "local" | "cloud" {
    return disclosureClass(url, this.conn.providerId, this.cloudRoutedOrigins);
  }

  /** Why task content may not be sent to `url`, or undefined when it may. */
  private disclosureDenial(url: string, requestId?: string): InferenceError | undefined {
    if (this.disclosureOf(url) !== "cloud") return undefined;
    const origin = originOf(url);
    if (origin && this.authorizedOrigins.has(origin)) return undefined;
    return new InferenceError(
      "policy_denied",
      "client",
      `Refusing to send task content to ${origin ?? url}: it is a cloud destination the operator has not authorized. ` +
        `Select it explicitly (--provider / --endpoint, or ~/.config/nexus/config.env) or list it in NEXUS_CLOUD_DISCLOSURE_ORIGINS.`,
      { requestId, failoverEligible: false },
    );
  }

  /**
   * Checks made before a content-bearing request leaves: model and credential present (provider connections), and the
   * shared cloud spending limits. Shows the disclosure notice the first time a cloud origin is used in this process.
   */
  private preflight(url: string, requestId: string, payloadChars: number): void {
    if (this.conn.providerId) {
      if (!this.model) {
        throw new InferenceError("configuration_error", "client", `Provider '${this.conn.providerId}' needs an explicit model: pass --model or set NEXUS_MODEL.`, { requestId, failoverEligible: false });
      }
      if (this.conn.auth !== "none" && !this.credentialFor(url) && !this.declaredAuthless()) {
        const variable = operatorSettingKeyForAuth(this.conn.providerId);
        throw new InferenceError("configuration_error", "client", `No credential for provider '${this.conn.providerId}': set ${variable}. Nexus never substitutes another provider's or the appliance's credential.`, {
          requestId,
          failoverEligible: false,
          condition: "AUTH_FAILURE",
        });
      }
    }
    if (this.disclosureOf(url) !== "cloud") return;
    // Spending limits cover provider connections, whose requests are recorded; the legacy endpoint path has no receipts.
    if (this.conn.providerId) {
      this.reservations.push(requestId);
      const reason = UsageLedger.global().admit(requestId, Math.ceil(payloadChars / 4) + this.maxOutputTokens, this.conn.usage === "openrouter");
      if (reason) throw new InferenceError("policy_denied", "client", `Cloud spending limit: ${reason}.`, { requestId, failoverEligible: false });
    }
    const origin = originOf(url) ?? url;
    if (!announcedDestinations.has(origin)) {
      announcedDestinations.add(origin);
      console.error(pc.dim(`[nexus] Cloud inference: ${this.conn.label} (${origin}), model ${this.model || "(unset)"}. Task content — prompts, tool results and file excerpts — is sent to this provider.`));
    }
  }

  /** `compatible` connections may run without a key only when the operator declares it (NEXUS_COMPATIBLE_AUTH=none). */
  private declaredAuthless(): boolean {
    return this.conn.providerId === "compatible" && authoritySetting("NEXUS_COMPATIBLE_AUTH") === "none";
  }

  /** Records a receipt for a provider-connection request (appliance requests keep their existing records only). */
  private async withReceipt<T>(requestId: string, purpose: string | undefined, run: () => Promise<T>): Promise<T> {
    if (!this.conn.providerId) return run();
    this.pending = undefined;
    this.reservations = [];
    const pending = (): PendingRequest | undefined => this.pending;
    const base = () => {
      const p = pending();
      return {
      at: new Date().toISOString(),
      requestId,
      role: purpose ?? this.role,
      providerId: this.conn.providerId!,
      selectedModel: this.model,
      ...(p?.effectiveModel ? { effectiveModel: p.effectiveModel } : {}),
      endpointOrigin: originOf(p?.endpoint ?? this.endpoint) ?? "",
      protocol: this.conn.protocol,
      disclosure: this.disclosureOf(p?.endpoint ?? this.endpoint),
      ...(p?.providerRequestId ? { providerRequestId: p.providerRequestId } : {}),
      ...(p?.usage ? { usage: p.usage } : {}),
      costConfidence: p?.usage?.costUsd !== undefined ? ("provider-reported" as const) : ("unknown" as const),
      };
    };
    const releaseAll = () => {
      for (const id of this.reservations) UsageLedger.global().release(id);
      this.reservations = [];
    };
    try {
      const result = await run();
      releaseAll();
      this.lastUsageReport = pending()?.usage;
      UsageLedger.global().record({ ...base(), outcome: "completed", usageConfidence: pending()?.usage ? "provider" : "uncertain" }, this.workspace);
      return result;
    } catch (err: any) {
      releaseAll();
      const notSent = err instanceof InferenceError && (err.kind === "policy_denied" || err.kind === "configuration_error");
      const maybeBilled = !(err instanceof InferenceError) || err.execution !== "NOT_EXECUTED";
      UsageLedger.global().record({
        ...base(),
        outcome: err instanceof InferenceError && err.kind === "aborted" ? "aborted" : "failed",
        failureKind: err instanceof InferenceError ? err.kind : "error",
        usageConfidence: pending()?.usage ? "provider" : notSent || !maybeBilled ? "none" : "uncertain",
      }, notSent ? undefined : this.workspace);
      throw err;
    }
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
    if (!this.conn.sendTaskClass) return {};
    return this.taskClass && /^[A-Za-z0-9_.-]{1,64}$/.test(this.taskClass) ? { "X-Task-Class": this.taskClass } : {};
  }

  /** Switch the model in place so session, task, boundary and routing state survive the change. */
  public setModel(model: string): void {
    this.model = model;
    // Some providers serve a model over a different protocol (Copilot gpt-5 via Responses).
    this.conn = connectionFor(this.conn.providerId, model);
    // Learned rejections belong to the previous model.
    this.unsupportedParams = new Set(this.conn.omitParams);
  }

  /** Removes parameters this provider connection does not accept (provider connections only). */
  private omitUnsupported(body: Record<string, unknown>): void {
    if (!this.conn.providerId) return;
    for (const p of this.unsupportedParams) delete body[p];
  }

  /**
   * When a provider answers 400 naming an optional parameter as unsupported, the request was not executed: drop that
   * parameter for this connection and resend once. Bounded by the small set of droppable parameters.
   */
  private async withParameterRetry<T>(run: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await run();
      } catch (err) {
        if (!this.conn.providerId || !(err instanceof InferenceError) || err.httpStatus !== 400) throw err;
        const param = unsupportedParameter(err.message);
        if (!param || !DROPPABLE_PARAMS.has(param) || this.unsupportedParams.has(param)) throw err;
        this.unsupportedParams.add(param);
        console.error(pc.dim(`[nexus] ${this.conn.label} rejected '${param}' for ${this.model}; resending without it.`));
      }
    }
  }

  /**
   * Resolves a sign-in provider's token for this request: Nexus's own sign-in is refreshed when it is about to expire
   * (one attempt) and saved; a token owned by another client is re-read from that client and never refreshed
   * (refresh tokens rotate; refreshing would sign that client out). A Copilot GitHub token from another client is
   * exchanged for a Copilot API token in memory, which rotates nothing.
   */
  private async prepareCredential(url: string, requestId?: string, force = false): Promise<void> {
    if (this.conn.auth !== "oauth" || !this.conn.providerId) return;
    const id = this.conn.providerId;
    const label = providerDefinition(id)?.label ?? id;
    const found = resolveCredential(id);
    const fail = (message: string) =>
      new InferenceError("configuration_error", "client", message, { requestId, failoverEligible: false, condition: "AUTH_FAILURE" });
    if (!found || found.credential.type !== "oauth") {
      this.explicitKey = undefined;
      return; // preflight reports the missing sign-in
    }
    let cred: OAuthCredential = found.credential;
    const fresh = (c?: OAuthCredential) => Boolean(c?.access) && (c!.expiresAt === undefined || c!.expiresAt - Date.now() > 60_000);
    if (!fresh(cred) || force) {
      try {
        if (found.refreshable) {
          cred = (await refreshOAuth(id, cred)) as OAuthCredential;
          saveCredential(id, cred);
        } else if (id === "copilot" && cred.refresh) {
          if (force || !fresh(this.exchangedToken) || this.exchangedToken?.refresh !== cred.refresh) {
            this.exchangedToken = (await copilotToken(cred.refresh)) as OAuthCredential;
          }
          cred = this.exchangedToken!;
        } else if (!fresh(cred)) {
          throw new Error(`the ${label} sign-in read from ${found.source} has expired. Use ${found.source} once to refresh it, or sign in from Nexus (/model, then ctrl+p).`);
        }
      } catch (err: any) {
        throw fail(`Cannot use ${label}: ${redactSecrets(err?.message ?? String(err))}`);
      }
    }
    this.explicitKey = cred.access;
    this.explicitOrigin = originOf(url);
    this.rotated.delete(this.explicitOrigin ?? "");
    this.oauthAccountId = cred.accountId;
  }

  /** One forced refresh-and-retry when a signed-in provider answers 401 (its token was revoked or rotated). */
  private async withOAuthRetry<T>(url: string, requestId: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (this.conn.auth !== "oauth" || !(err instanceof InferenceError) || err.httpStatus !== 401) throw err;
      await this.prepareCredential(url, requestId, true);
      return run();
    }
  }

  /** Headers a provider requires that depend on the request (sign-in account, Copilot editor identity). */
  private providerHeaders(messages: ChatMessage[]): Record<string, string> {
    if (this.conn.providerId === "chatgpt") return this.oauthAccountId ? { "chatgpt-account-id": this.oauthAccountId } : {};
    if (this.conn.providerId === "copilot") {
      return { ...COPILOT_HEADERS, "X-Initiator": messages.some((m) => m.role === "assistant") ? "agent" : "user" };
    }
    return {};
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

  /** Sets the key for the active endpoint's origin. */
  public setApiKey(key: string): void {
    this.explicitKey = key;
    this.explicitOrigin = originOf(this.endpoints[this.activeEndpointIndex]);
    if (this.explicitOrigin) this.rotated.delete(this.explicitOrigin);
  }

  /** The credential sent to `url`: its own explicit key, else its gateway's stored credential, else none. */
  private credentialFor(url: string): string | undefined {
    const origin = originOf(url);
    if (!origin) return undefined;
    if (this.explicitKey && this.explicitOrigin === origin && !this.rotated.has(origin)) return this.explicitKey;
    // A provider connection uses only its own key: never the appliance's stored token or any other credential.
    if (this.conn.providerId) return undefined;
    if (!this.storedKeys.has(origin)) this.storedKeys.set(origin, storedCredentialFor(url));
    return this.storedKeys.get(origin) ?? undefined;
  }

  private authorization(url: string): Record<string, string> {
    if (!this.conn.providerId) return { Authorization: `Bearer ${this.credentialFor(url) ?? "not-needed"}` };
    const key = this.credentialFor(url);
    const auth: Record<string, string> = !key ? {} : this.conn.auth === "x-api-key" ? { "x-api-key": key } : { Authorization: `Bearer ${key}` };
    if (this.conn.providerId === "copilot") Object.assign(auth, COPILOT_HEADERS);
    return { ...this.conn.staticHeaders, ...auth };
  }

  /** Provider connections refuse redirects: a credential-bearing request never follows a server to another origin. */
  private fetchPolicy(): { redirect?: "error" } {
    return this.conn.providerId ? { redirect: "error" } : {};
  }

  /** After a 401 from `url`: re-read that gateway's stored credential (rotation). Never borrows another provider's. */
  public reloadAuthToken(url: string = this.endpoints[this.activeEndpointIndex]): boolean {
    const origin = originOf(url);
    if (!origin || this.conn.providerId) return false;
    const fresh = storedCredentialFor(url);
    if (!fresh || fresh === this.credentialFor(url)) return false;
    this.storedKeys.set(origin, fresh);
    this.rotated.add(origin);
    return true;
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
      // An endpoint not authorized for cloud disclosure is never tried; a fallback never widens disclosure.
      const denial = this.disclosureDenial(currentEp);
      if (denial) {
        lastError = lastError ?? denial;
        continue;
      }

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
      await this.prepareCredential(currentEp);
      const query = this.conn.protocol === "anthropic-messages" ? "?limit=1000" : this.conn.providerId === "chatgpt" ? "?client_version=1.0.0" : "";
      const url = `${currentEp}/models${query}`;
      const res = await fetch(url, {
        headers: this.authorization(url),
        ...this.fetchPolicy(),
      });

      if (res.status === 401 && this.reloadAuthToken(url)) {
        const retryRes = await fetch(url, {
          headers: this.authorization(url),
        });
        if (retryRes.ok) return modelIds(await retryRes.json());
      }

      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}: ${res.statusText}`);
      }

      return modelIds(await res.json());
    });
  }

  /** Raw `/models` entries. Providers that publish capability metadata let the scheduler qualify resources. */
  async listModelCatalog(signal?: AbortSignal): Promise<Array<Record<string, any>>> {
    return this.executeWithFailover("listModelCatalog", async (currentEp) => {
      const res = await fetch(`${currentEp}/models`, { headers: this.authorization(currentEp), signal, ...this.fetchPolicy() });
      if (!res.ok) throw new Error(`Server returned HTTP ${res.status}: ${res.statusText}`);
      const data = (await res.json()) as { data?: Array<Record<string, any>> };
      return Array.isArray(data.data) ? data.data : [];
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
          headers: this.authorization(this.endpoints[idx]),
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
          ...this.fetchPolicy(),
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
    /** Receipt role override for auxiliary calls (e.g. "compaction"). */
    purpose?: string,
  ): Promise<ChatMessage> {
    return this.withReceipt(requestId, purpose, () =>
      this.withOAuthRetry(this.endpoint, requestId, () => this.withParameterRetry(() => this.chatCompletionOnce(messages, tools, requestId, signal))),
    );
  }

  private async chatCompletionOnce(messages: ChatMessage[], tools: ToolDefinition[], requestId: string, signal?: AbortSignal): Promise<ChatMessage> {
    if (this.conn.protocol !== "openai-chat") return this.nativeCompletion(messages, tools, undefined, requestId, signal, this.conn.streamOnly);
    if (this.conn.streamOnly) return this.chatCompletionStreamOnce(messages, tools, undefined, requestId, signal);
    return this.executeWithFailover("chatCompletion", async (currentEp) => {
      if (signal?.aborted) throw abortedError(requestId);
      const url = `${currentEp}/chat/completions`;
      await this.prepareCredential(currentEp, requestId);
      this.preflight(currentEp, requestId, JSON.stringify(messages).length + JSON.stringify(tools).length);

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
      if (this.conn.usage === "openrouter") payload.usage = { include: true };
      this.omitUnsupported(payload);

      let res: Response;
      let data: ChatCompletionResponse;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.authorization(url),
            ...this.providerHeaders(messages),
            "X-Request-ID": requestId,
            ...this.routingHeaders(),
          },
          body: JSON.stringify(payload),
          signal: this.combinedSignal(signal),
          ...this.fetchPolicy(),
        });

        if (res.status === 401 && this.reloadAuthToken(url)) {
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
      if (this.conn.providerId) {
        this.pending = { usage: chatUsage(data.usage), providerRequestId: data.id, effectiveModel: (data as any).model, endpoint: currentEp };
      }
      if (!data.choices || data.choices.length === 0) {
        throw new InferenceError("protocol_error", "provider", "Model returned empty choices array", { requestId, failoverEligible: false });
      }

      const choice = data.choices[0] as { message: ChatMessage; finish_reason?: string };
      if (this.conn.providerId && choice.finish_reason === "error") {
        throw new InferenceError("provider_error_frame", "provider", "Provider ended the response with finish_reason=error.", { requestId, partialText: typeof choice.message?.content === "string" ? choice.message.content : "" });
      }
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
    return this.withReceipt(requestId, undefined, () =>
      this.withOAuthRetry(this.endpoint, requestId, () =>
        this.withParameterRetry(() => this.chatCompletionStreamOnce(messages, tools, onToken, requestId, signal)),
      ),
    );
  }

  private async chatCompletionStreamOnce(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onToken: StreamTokenCallback | undefined,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<ChatMessage> {
    if (this.conn.protocol !== "openai-chat") return this.nativeCompletion(messages, tools, onToken, requestId, signal, true);
    return this.executeWithFailover("chatCompletionStream", async (currentEp) => {
      if (signal?.aborted) throw abortedError(requestId);
      const url = `${currentEp}/chat/completions`;
      await this.prepareCredential(currentEp, requestId);
      this.preflight(currentEp, requestId, JSON.stringify(messages).length + JSON.stringify(tools).length);

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
      if (this.conn.usage === "openrouter") payload.usage = { include: true };
      if (this.conn.usage === "openrouter" || this.conn.usage === "stream-options") payload.stream_options = { include_usage: true };
      this.omitUnsupported(payload);

      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.authorization(url),
            ...this.providerHeaders(messages),
            "X-Request-ID": requestId,
            ...this.routingHeaders(),
          },
          body: JSON.stringify(payload),
          signal: this.combinedSignal(signal),
          ...this.fetchPolicy(),
        });
      } catch (err: any) {
        // No resend here: a rejected fetch does not prove the gateway never admitted the request, and a
        // second attempt would replace this error with its own. Recovery belongs to the agent loop.
        throw classifyTransportError(err, signal, requestId, "connect");
      }

      if (res.status === 401 && this.reloadAuthToken(url)) {
        return this.chatCompletionStream(messages, tools, onToken, requestId, signal);
      }

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => res.statusText);
        throw this.httpError(res.status, errText, requestId, res.headers);
      }

      let fullContent = "";
      let finishReason: string | undefined;
      let sawDone = false;
      if (this.conn.providerId) this.pending = { endpoint: currentEp };
      const toolCallsMap: Map<number, { id: string; name: string; args: string }> = new Map();

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      // Positive completion evidence for this protocol: a chunk carrying a non-null finish_reason, or the
      // terminal `data: [DONE]` event. Absence of both means the stream ended early.
      const handleLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) return;
        if (trimmed === "data: [DONE]" || trimmed === "data:[DONE]") {
          sawDone = true;
          return;
        }
        if (!trimmed.startsWith("data:") && !trimmed.startsWith("data: ")) return;
        const payload = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed.slice(5);
        let chunk: any;
        try {
          chunk = JSON.parse(payload);
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
        if (this.pending && chunk && typeof chunk === "object") {
          if (chunk.usage) this.pending.usage = chatUsage(chunk.usage);
          if (typeof chunk.id === "string") this.pending.providerRequestId ??= chunk.id;
          if (typeof chunk.model === "string") this.pending.effectiveModel ??= chunk.model;
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

      if (this.conn.providerId && finishReason === "error") {
        throw new InferenceError("provider_error_frame", "provider", "Provider ended the stream with finish_reason=error.", { requestId, partialText: fullContent });
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
        // Provider connections stay under this request's single receipt.
        if (this.conn.providerId) return this.chatCompletionOnce(messages, tools, randomUUID(), signal);
        return this.chatCompletion(messages, tools, randomUUID(), signal);
      }

      return {
        role: "assistant",
        content: fullContent || null,
        ...(assembledToolCalls.length > 0 ? { tool_calls: assembledToolCalls } : {}),
      };
    });
  }

  /** Egress interception (DISC-001..003, CTX-006, FAIL-003) of messages and tools bound for `currentEp`. */
  private egress(messages: ChatMessage[], tools: ToolDefinition[], currentEp: string): { messages: ChatMessage[]; tools: ToolDefinition[] } {
    const ctx = { taskId: this.taskId, sessionId: this.sessionId, sourceBoundary: "HOST_LOCAL" as const };
    const m = this.boundary.evaluateEgress(messages, currentEp, ctx);
    if (!m.allowed) throw new Error(m.reason || `Egress to endpoint '${currentEp}' denied by InformationFlowBoundary [FAIL-003].`);
    let outTools = tools;
    if (tools.length > 0) {
      const t = this.boundary.evaluateEgress(tools, currentEp, ctx);
      if (!t.allowed) throw new Error(t.reason || `Egress of tools to endpoint '${currentEp}' denied by InformationFlowBoundary [FAIL-003].`);
      outTools = t.sanitizedPayload || tools;
    }
    return { messages: this.sanitizeHistory(m.sanitizedPayload || messages), tools: outTools };
  }

  /** A provider-reported stream error, typed by what it says about the provider. Partial output is never used. */
  private fromStreamError(e: ProviderStreamError, requestId: string): InferenceError {
    if (e.malformed) return new InferenceError("malformed_event", "provider", e.message, { requestId, partialText: e.partialText, failoverEligible: false });
    const t = e.errorType ?? "";
    const classification: ProviderClassification =
      t === "context_length_exceeded" ? { condition: "CAPACITY_REJECTED", execution: "NOT_EXECUTED" }
      : t === "overloaded_error" ? { condition: "OVERLOADED", execution: "UNKNOWN" }
      : t === "rate_limit_error" || t === "rate_limit_exceeded" ? { condition: "RATE_LIMITED", execution: "UNKNOWN" }
      : t === "invalid_request_error" ? { condition: "REQUEST_REJECTED", execution: "UNKNOWN" }
      : t === "authentication_error" || t === "permission_error" ? { condition: "AUTH_FAILURE", execution: "UNKNOWN" }
      : t === "billing_error" || t === "insufficient_quota" ? { condition: "QUOTA_EXHAUSTED", execution: "UNKNOWN" }
      : { condition: "TEMPORARILY_UNAVAILABLE", execution: "UNKNOWN" };
    return new InferenceError("provider_error_frame", "provider", redactSecrets(e.message).slice(0, MAX_PROVIDER_ERROR_CHARS), {
      requestId,
      partialText: e.partialText,
      hints: t ? { errorType: t } : {},
      ...classification,
    });
  }

  /**
   * Anthropic Messages / OpenAI Responses request. The result is used only when the provider's terminal event arrived:
   * an incomplete stream, a truncated output or a provider error yields a typed failure and no tool call runs.
   */
  private async nativeCompletion(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onToken: StreamTokenCallback | undefined,
    requestId: string,
    signal: AbortSignal | undefined,
    stream: boolean,
  ): Promise<ChatMessage> {
    return this.executeWithFailover(stream ? "chatCompletionStream" : "chatCompletion", async (currentEp) => {
      if (signal?.aborted) throw abortedError(requestId);
      await this.prepareCredential(currentEp, requestId);
      this.preflight(currentEp, requestId, JSON.stringify(messages).length + JSON.stringify(tools).length);
      const outbound = this.egress(messages, tools, currentEp);
      const anthropic = this.conn.protocol === "anthropic-messages";
      const owner = `${this.conn.providerId}:${this.model}`;
      const input: NativeRequestInput = {
        model: this.model,
        messages: outbound.messages,
        tools: outbound.tools,
        temperature: this.temperature,
        maxOutputTokens: this.maxOutputTokens,
        stream,
        owner,
        reasoningEffort: this.reasoningEffort,
        thinkingBudget: this.thinkingBudget,
      };
      const req = anthropic ? buildAnthropicRequest(input) : buildResponsesRequest(input);
      this.omitUnsupported(req.body);
      if (req.droppedState) {
        console.error(pc.dim(`[nexus] ${req.droppedState} earlier assistant turn(s) carry reasoning state owned by another provider/model or altered since capture; it is not replayed to ${owner} (visible text and tool calls are kept).`));
      }
      const url = `${currentEp}${req.path}`;
      this.pending = { endpoint: currentEp };
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...this.authorization(url), ...this.providerHeaders(outbound.messages), "X-Request-ID": requestId },
          body: JSON.stringify(req.body),
          signal: this.combinedSignal(signal),
          ...this.fetchPolicy(),
        });
      } catch (err: any) {
        throw classifyTransportError(err, signal, requestId, "connect");
      }
      if (!res.ok || (stream && !res.body)) {
        const errText = await res.text().catch(() => res.statusText);
        throw this.httpError(res.status, errText, requestId, res.headers);
      }
      const keepReasoning = Boolean(this.reasoningEffort);
      let result: NativeResult;
      if (!stream) {
        let data: any;
        try {
          data = await res.json();
        } catch (err: any) {
          if (err?.name === "SyntaxError") throw new InferenceError("malformed_event", "provider", "Provider returned a non-JSON response body.", { requestId, failoverEligible: false });
          throw classifyTransportError(err, signal, requestId, "stream");
        }
        try {
          result = anthropic ? parseAnthropicResponse(data, owner) : parseResponsesResponse(data, owner, keepReasoning);
        } catch (e) {
          throw e instanceof ProviderStreamError ? this.fromStreamError(e, requestId) : e;
        }
      } else {
        const parser = anthropic ? anthropicStreamParser(owner, onToken) : responsesStreamParser(owner, keepReasoning, onToken);
        try {
          await readSse(res.body!, (name, raw) => {
            let data: any;
            try {
              data = JSON.parse(raw);
            } catch {
              throw new ProviderStreamError(`Malformed stream event: ${raw.slice(0, 120)}`, undefined, parser.text(), true);
            }
            parser.event(name, data);
          });
        } catch (err: any) {
          if (err instanceof ProviderStreamError) throw this.fromStreamError(err, requestId);
          throw classifyTransportError(err, signal, requestId, "stream", parser.text());
        }
        result = parser.result();
      }
      this.pending = { endpoint: currentEp, usage: result.usage, providerRequestId: result.providerRequestId, effectiveModel: result.effectiveModel };
      if (result.finish === "incomplete") {
        throw new InferenceError("stream_incomplete", "transport", "Inference stream ended before the provider's terminal event; response is incomplete and no tool call from it runs.", {
          requestId,
          partialText: result.text,
        });
      }
      if (result.finish === "length") {
        throw new InferenceError(
          "output_truncated",
          "client",
          result.message.tool_calls?.length
            ? "Model output was truncated (max output tokens) inside a tool call; refusing to run partial arguments."
            : "Model output was truncated (max output tokens); refusing to treat it as a complete answer.",
          { requestId, partialText: result.text, failoverEligible: false },
        );
      }
      return result.message;
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
    const shown = this.conn.providerId ? redactSecrets(body).slice(0, MAX_PROVIDER_ERROR_CHARS) : body;
    return new InferenceError("http_error", providerSide ? "provider" : "client", `Inference error (HTTP ${status}): ${shown}`, {
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
    // Bulk repository indexing is not a disclosure any provider selection authorizes; search stays lexical instead.
    if (this.conn.providerId && this.disclosureOf() === "cloud") {
      throw new Error(`Embeddings are not sent to cloud provider '${this.conn.providerId}'.`);
    }
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
          ...this.authorization(url),
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
