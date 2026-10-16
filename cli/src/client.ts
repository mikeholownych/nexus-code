import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { parseAdmissionHeaders, parseAdvertisement, parseServerContext, parseTokenizeResponse, serverKindOf, type AdmissionReport, type Advertisement, type RequestCount, type ServerKind } from "./core/provider_capabilities.js";
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
import { classifyLocality, setLocalityAuthorityResolver } from "./core/egress.js";
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

/**
 * The stored gateway token: the file named by the operator's NEXUS_GATEWAY_TOKEN_FILE (environment or config.env, never
 * a project .env), else the legacy location ~/.config/opencode/t5820-client-token kept for existing installations. It
 * is sent only to the origin config.env names (see credentialOriginOf).
 */
function readGatewayTokenFile(): string | undefined {
  const configured = operatorSetting("NEXUS_GATEWAY_TOKEN_FILE");
  const file = configured
    ? path.resolve(credentialStorageHome(), configured.replace(/^~(?=\/)/, credentialStorageHome()))
    : path.join(credentialStorageHome(), ".config/opencode/t5820-client-token");
  try {
    return fs.readFileSync(file, "utf-8").trim() || undefined;
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

setLocalityAuthorityResolver(operatorSetting);

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
interface PendingRequest { usage?: UsageReport; providerRequestId?: string; effectiveModel?: string; endpoint?: string; executions?: number }

/** Model ids from a `/models` answer: OpenAI-style `data[].id`, or the ChatGPT backend's listed `models[].slug`. */
function modelIds(body: any): string[] {
  if (Array.isArray(body?.data)) return body.data.map((m: any) => m?.id).filter((id: unknown): id is string => typeof id === "string");
  if (Array.isArray(body?.models)) return body.models.filter((m: any) => !m?.visibility || m.visibility === "list").map((m: any) => m?.slug ?? m?.id).filter((id: unknown): id is string => typeof id === "string");
  return [];
}

/** Optional request parameters a provider may reject; dropping one never changes what the request asks for. */
const DROPPABLE_PARAMS = new Set(["temperature", "top_p", "max_output_tokens", "max_tokens", "stream_options"]);
/** Local endpoints may drop only the optional parameters Nexus adds for them, never sampling settings. */
const LOCAL_DROPPABLE_PARAMS = new Set(["max_tokens", "stream_options"]);

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
/** An information-flow denial: nothing was sent, and no other endpoint may be tried with the same content (PRV-12). */
function egressDenied(message: string): InferenceError {
  return new InferenceError("policy_denied", "client", message, { failoverEligible: false });
}

const MAX_PROVIDER_ERROR_CHARS = 2_000;
/** Limit for requests that carry no task content (model lists, catalogs, embeddings): a silent server never hangs them. */
const METADATA_TIMEOUT_MS = 15_000;

/** Provider or endpoint error text as shown and stored: secrets redacted, at most MAX_PROVIDER_ERROR_CHARS (REQ-PRV-103). */
export function boundedProviderText(text: string): string {
  const clean = redactSecrets(text);
  return clean.length > MAX_PROVIDER_ERROR_CHARS ? `${clean.slice(0, MAX_PROVIDER_ERROR_CHARS)}… [${clean.length - MAX_PROVIDER_ERROR_CHARS} more characters]` : clean;
}

const metadataSignal = (signal?: AbortSignal): AbortSignal =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(METADATA_TIMEOUT_MS)]) : AbortSignal.timeout(METADATA_TIMEOUT_MS);

/**
 * Watchdog for inference requests (first-byte, idle between chunks, and optional total timeout).
 * Reset on each streamed chunk (REQ-PRV-104).
 */
export class StreamWatchdog {
  private readonly ac = new AbortController();
  private timer?: NodeJS.Timeout;
  private totalTimer?: NodeJS.Timeout;
  private readonly callerAbortListener?: () => void;

  constructor(
    private readonly firstByteMs: number,
    private readonly idleMs: number,
    private readonly totalMs: number,
    private readonly callerSignal?: AbortSignal,
  ) {
    if (this.callerSignal) {
      if (this.callerSignal.aborted) {
        this.ac.abort(this.callerSignal.reason);
      } else {
        this.callerAbortListener = () => this.ac.abort(this.callerSignal!.reason);
        this.callerSignal.addEventListener("abort", this.callerAbortListener, { once: true });
      }
    }
    if (this.totalMs > 0) {
      this.totalTimer = setTimeout(() => {
        this.ac.abort(new DOMException(`Total inference timeout of ${this.totalMs / 1000}s exceeded`, "TimeoutError"));
      }, this.totalMs);
      this.totalTimer.unref?.();
    }
    this.arm(this.firstByteMs, "First-byte");
  }

  get signal(): AbortSignal {
    return this.ac.signal;
  }

  private arm(ms: number, phase: string): void {
    clearTimeout(this.timer);
    if (ms > 0) {
      this.timer = setTimeout(() => {
        this.ac.abort(new DOMException(`${phase} inference timeout of ${ms / 1000}s exceeded`, "TimeoutError"));
      }, ms);
      this.timer.unref?.();
    }
  }

  onChunk(): void {
    this.arm(this.idleMs, "Idle");
  }

  done(): void {
    clearTimeout(this.timer);
    clearTimeout(this.totalTimer);
    if (this.callerSignal && this.callerAbortListener) {
      this.callerSignal.removeEventListener("abort", this.callerAbortListener);
    }
  }
}

/**
 * Typed inference failure. `condition` is what the failure says about the provider; `execution` is what is known
 * about whether the provider ran the request. Another endpoint is tried immediately only when the request is
 * proven not executed and the condition is temporary; anything else is the agent loop's recovery decision.
 */
/** Request counting did not produce a count; `kind` says whether to expect it later (see countRequestTokens). */
export class TokenCountError extends Error {
  constructor(public readonly kind: "unsupported" | "unavailable" | "malformed" | "denied" | "aborted", message: string) {
    super(message);
    this.name = "TokenCountError";
  }
}

/** A tool call whose arguments were cut off by the output limit: its name, the target path when it parses, how much was written. */
export interface TruncatedCall {
  name: string;
  path?: string;
  argumentChars: number;
}

/** What each cut-off tool call was: the name, and the target path when the partial arguments already hold it whole. */
export function truncatedCalls(calls: Array<{ function: { name: string; arguments: unknown } }>): TruncatedCall[] {
  return calls.map((call) => {
    const args = typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments ?? "");
    const match = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(args);
    let path: string | undefined;
    if (match) {
      try {
        path = JSON.parse(`"${match[1]}"`);
      } catch {}
    }
    return { name: call.function.name, ...(path ? { path } : {}), argumentChars: args.length };
  });
}

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
  /** output_truncated only: the tool calls the reply was writing when it was cut off (never run). */
  readonly truncatedCalls: TruncatedCall[];

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
      truncatedCalls?: TruncatedCall[];
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
    this.truncatedCalls = opts.truncatedCalls ?? [];
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
  /** Output allowance sent as max_tokens on local endpoints; resized from provider capabilities (setOutputAllowance). */
  private maxOutputTokens: number;
  /** What the gateway reported about the most recent admitted inference request (response headers), if anything. */
  private lastAdmission?: AdmissionReport;
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

  /** Usage the provider or local server reported for the last completed request (undefined when unreported). */
  public getLastUsage(): UsageReport | undefined {
    return this.lastUsageReport;
  }

  /** Whether the connection supports native tool calling (Responses, Anthropic, or OpenAI-compatible accepting tools). */
  public supportsNativeTools(): boolean {
    if (this.conn.protocol === "openai-responses" || this.conn.protocol === "anthropic-messages") {
      return true;
    }
    return !this.unsupportedParams.has("tools");
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
      const locality = classifyLocality(url);
      console.error(pc.dim(`[nexus] Cloud inference: ${this.conn.label} (${origin}, locality: ${locality.reason}), model ${this.model || "(unset)"}. Task content — prompts, tool results and file excerpts — is sent to this provider.`));
    }
  }

  /** `compatible` connections may run without a key only when the operator declares it (NEXUS_COMPATIBLE_AUTH=none). */
  private declaredAuthless(): boolean {
    return this.conn.providerId === "compatible" && authoritySetting("NEXUS_COMPATIBLE_AUTH") === "none";
  }

  /** Records a receipt for an inference request (local endpoint or provider connection). */
  private async withReceipt<T>(requestId: string, purpose: string | undefined, run: () => Promise<T>): Promise<T> {
    this.pending = undefined;
    this.reservations = [];
    const pending = (): PendingRequest | undefined => this.pending;
    const base = () => {
      const p = pending();
      const ep = p?.endpoint ?? this.endpoint;
      const disclosure = this.disclosureOf(ep);
      return {
        at: new Date().toISOString(),
        requestId,
        role: purpose ?? this.role,
        providerId: this.conn.providerId ?? "local",
        selectedModel: this.model,
        ...(p?.effectiveModel ? { effectiveModel: p.effectiveModel } : {}),
        endpointOrigin: originOf(ep) ?? "",
        protocol: this.conn.protocol,
        disclosure,
        origin_class: (disclosure === "cloud" ? "cloud" : "local") as "local" | "cloud",
        ...(p?.executions ? { executions: p.executions } : {}),
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

  /** Removes parameters this connection was found not to accept. */
  private omitUnsupported(body: Record<string, unknown>): void {
    for (const p of this.unsupportedParams) delete body[p];
  }

  /**
   * When a provider or local server answers 400 naming an optional parameter as unsupported, the request was not
   * executed: drop that parameter for this connection and resend once. Bounded by the small set of droppable parameters.
   */
  private async withParameterRetry<T>(run: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await run();
      } catch (err) {
        if (!(err instanceof InferenceError) || err.httpStatus !== 400) throw err;
        const param = unsupportedParameter(err.message);
        const droppable = this.conn.providerId ? DROPPABLE_PARAMS : LOCAL_DROPPABLE_PARAMS;
        if (!param || !droppable.has(param) || this.unsupportedParams.has(param)) throw err;
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

  private createWatchdog(operatorSignal?: AbortSignal, currentEp?: string): StreamWatchdog {
    const disclosure = this.disclosureOf(currentEp ?? this.endpoint);
    const parseNum = (k: string) => {
      const raw = process.env[k];
      if (raw === undefined || raw === "") return undefined;
      const v = Number(raw);
      return Number.isFinite(v) && v >= 0 ? v : undefined;
    };
    const firstByteMs = parseNum("LOCAL_LLM_FIRST_BYTE_TIMEOUT_MS") ?? 120_000;
    const idleMs = parseNum("LOCAL_LLM_IDLE_TIMEOUT_MS") ?? 120_000;
    const defaultTotal = disclosure === "cloud" ? 900_000 : 0;
    const totalMs = parseNum("LOCAL_LLM_TIMEOUT_MS") ?? defaultTotal;
    return new StreamWatchdog(firstByteMs, idleMs, totalMs, operatorSignal);
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
    // A provider connection is pinned to its own endpoint: task content never fails over elsewhere (PRV-13).
    if (this.conn.providerId) return;
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
        signal: metadataSignal(),
        ...this.fetchPolicy(),
      });

      if (res.status === 401 && this.reloadAuthToken(url)) {
        const retryRes = await fetch(url, {
          headers: this.authorization(url),
          signal: metadataSignal(),
          ...this.fetchPolicy(),
        });
        if (retryRes.ok) return modelIds(await retryRes.json());
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Server returned HTTP ${res.status}: ${boundedProviderText(text || res.statusText)}`);
      }

      return modelIds(await res.json());
    });
  }

  /** Raw `/models` entries. Providers that publish capability metadata let the scheduler qualify resources. */
  async listModelCatalog(signal?: AbortSignal): Promise<Array<Record<string, any>>> {
    return this.executeWithFailover("listModelCatalog", async (currentEp) => {
      const res = await fetch(`${currentEp}/models`, { headers: this.authorization(currentEp), signal: metadataSignal(signal), ...this.fetchPolicy() });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Server returned HTTP ${res.status}: ${boundedProviderText(text || res.statusText)}`);
      }
      const data = (await res.json()) as { data?: Array<Record<string, any>> };
      return Array.isArray(data.data) ? data.data : [];
    });
  }

  /** Sets the output allowance (max_tokens on local endpoints) from the connection's capabilities. */
  public setOutputAllowance(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) this.maxOutputTokens = Math.floor(tokens);
  }

  public getOutputAllowance(): number {
    return this.maxOutputTokens;
  }

  /** The gateway's report on the most recent admitted inference request (headers), when it sent one. */
  public getLastAdmission(): AdmissionReport | undefined {
    return this.lastAdmission;
  }

  /**
   * This connection's `/models` entry for the selected model, read from the active endpoint only (never a fallback or
   * another provider: capability discovery is scoped to the connection in use). Not content-bearing.
   * `unsupported`: the provider has no catalog or does not list the model; `unavailable`: it could not be read now.
   */
  async discoverAdvertisement(signal?: AbortSignal): Promise<{ state: "supported" | "unsupported" | "unavailable"; advertised?: Advertisement; detail?: string }> {
    const ep = this.endpoint;
    if (this.conn.protocol !== "openai-chat") return { state: "unsupported", detail: `${this.conn.protocol} connection` };
    const url = `${ep}/models`;
    try {
      await this.prepareCredential(ep);
      const res = await fetch(url, {
        // Marked so providers (and their logs) can tell a capability read from an availability probe.
        headers: { ...this.authorization(url), "X-Nexus-Purpose": "capabilities" },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
        ...this.fetchPolicy(),
      });
      if (res.status === 404) return { state: "unsupported", detail: "no /models catalog" };
      if (!res.ok) return { state: "unavailable", detail: `HTTP ${res.status}` };
      const data = (await res.json()) as { data?: Array<Record<string, any>> };
      const entry = Array.isArray(data?.data) ? data.data.find((e) => e?.id === this.model) : undefined;
      if (!entry) return { state: "unsupported", detail: `model ${this.model} not listed` };
      const advertised = parseAdvertisement(entry);
      if (!advertised || (advertised.contextLength === undefined && advertised.maxCompletionTokens === undefined)) {
        // An OpenAI-style catalog without limits (llama.cpp, LM Studio, Ollama): ask the server itself what it loaded.
        // Only for a plain endpoint: cloud provider connections have no such endpoints.
        const local = this.conn.providerId ? undefined : await this.discoverServerContext(entry, signal);
        if (local) return { state: "supported", advertised: local };
        return { state: "unsupported", advertised, detail: "catalog lists no limits" };
      }
      return { state: "supported", advertised };
    } catch (err: any) {
      if (signal?.aborted) throw abortedError(randomUUID());
      return { state: "unavailable", detail: redactSecrets(String(err?.message ?? err)).slice(0, 160) };
    }
  }

  private static serverContextCache = new Map<string, Advertisement>();

  /**
   * The loaded context of a local server that lists no limits in its catalog, from that server's own endpoint (llama.cpp
   * `/props`, LM Studio `/api/v0/models`, Ollama `/api/show`) on the endpoint's origin with the same credential and a 2 s
   * limit. The server is recognised from its catalog entry first, so an unrecognised server is never probed. Not
   * content-bearing. Undefined when the server is not recognised or does not answer with a context size.
   */
  private async discoverServerContext(entry: Record<string, any>, signal?: AbortSignal): Promise<Advertisement | undefined> {
    const kind = serverKindOf(entry);
    if (kind !== "llamacpp" && kind !== "lmstudio" && kind !== "ollama") return undefined;
    const cacheKey = `${this.endpoint}::${this.model}`;
    const cached = LocalLlmClient.serverContextCache.get(cacheKey);
    if (cached) return cached;
    const root = this.endpoint.replace(/\/v1\/?$/, "");
    const probes: Array<{ kind: "llamacpp" | "lmstudio" | "ollama"; url: string; init?: RequestInit }> = [
      { kind: "llamacpp" as const, url: `${root}/props` },
      { kind: "lmstudio" as const, url: `${root}/api/v0/models` },
      { kind: "ollama" as const, url: `${root}/api/show`, init: { method: "POST", body: JSON.stringify({ model: this.model }), headers: { "content-type": "application/json" } } },
    ].filter((p) => p.kind === kind);
    for (const probe of probes) {
      try {
        const res = await fetch(probe.url, {
          ...probe.init,
          headers: { ...(probe.init?.headers as Record<string, string> | undefined), ...this.authorization(probe.url), "X-Nexus-Purpose": "capabilities" },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2_000)]) : AbortSignal.timeout(2_000),
          ...this.fetchPolicy(),
        });
        if (!res.ok) continue;
        const found = parseServerContext(probe.kind, await res.json(), this.model);
        if (found) {
          LocalLlmClient.serverContextCache.set(cacheKey, found);
          return found;
        }
      } catch {
        if (signal?.aborted) throw abortedError(randomUUID());
      }
    }
    return undefined;
  }

  /**
   * Counts the prompt tokens of the request inference would send now, through the connection's `/v1/tokenize`
   * (advertised by the homelab-ai gateway contract). The body is `outboundChatBody` — the actual outbound messages,
   * tools, tool_choice and settings, after the same egress quarantine and sanitization — sent to the active endpoint
   * only, with the same credential scoping, disclosure checks and cancellation as inference. No failover: a counting
   * failure belongs to this connection and capability, and never moves task content elsewhere.
   * Throws TokenCountError: `unsupported` (no such endpoint or model), `unavailable` (temporary), `malformed`,
   * `denied` (credential or disclosure), `aborted`.
   */
  async countRequestTokens(messages: ChatMessage[], tools: ToolDefinition[], requestId: string, signal?: AbortSignal): Promise<RequestCount> {
    if (this.conn.providerId || this.conn.protocol !== "openai-chat") throw new TokenCountError("unsupported", "provider connections have no request-counting endpoint");
    const ep = this.endpoint;
    const denial = this.disclosureDenial(ep, requestId);
    if (denial) throw new TokenCountError("denied", denial.message);
    if (signal?.aborted) throw new TokenCountError("aborted", "cancelled");
    const url = `${ep}/tokenize`;
    let body: any;
    try {
      await this.prepareCredential(ep, requestId);
      this.preflight(ep, requestId, JSON.stringify(messages).length + JSON.stringify(tools).length);
      body = this.outboundChatBody(ep, messages, tools);
    } catch (err: any) {
      throw new TokenCountError("denied", boundedProviderText(String(err?.message ?? err)).slice(0, 200));
    }
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.authorization(url), "X-Request-ID": requestId, ...this.routingHeaders() },
        body: JSON.stringify(body),
        signal: metadataSignal(signal),
        ...this.fetchPolicy(),
      });
    } catch (err: any) {
      if (signal?.aborted) throw new TokenCountError("aborted", "cancelled");
      throw new TokenCountError("unavailable", boundedProviderText(String(err?.message ?? err)).slice(0, 160));
    }
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) throw new TokenCountError("denied", `HTTP ${res.status}`);
    // The gateway answers 404 both for an unknown model and when every worker of the alias is blocked.
    if (res.status === 404) throw new TokenCountError(/blocked|capacity/i.test(text) ? "unavailable" : "unsupported", `HTTP 404 ${boundedProviderText(text).slice(0, 120)}`);
    if (res.status === 405 || res.status === 501) throw new TokenCountError("unsupported", `HTTP ${res.status}`);
    if (!res.ok) throw new TokenCountError("unavailable", `HTTP ${res.status} ${boundedProviderText(text).slice(0, 120)}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TokenCountError("malformed", "response is not JSON");
    }
    const count = parseTokenizeResponse(parsed);
    if ("malformed" in count) throw new TokenCountError("malformed", count.malformed);
    return count;
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
        throw egressDenied(
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
          throw egressDenied(
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
      // The same output allowance as a streamed request (PRV-09: the empty-stream re-request used to be uncapped).
      if (!this.conn.providerId) payload.max_tokens = this.maxOutputTokens;

      if (outboundTools.length > 0) {
        payload.tools = outboundTools;
        payload.tool_choice = "auto";
      }
      if (this.conn.usage === "openrouter") payload.usage = { include: true };
      this.omitUnsupported(payload);

      const watchdog = this.createWatchdog(signal, currentEp);
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
          signal: watchdog.signal,
          ...this.fetchPolicy(),
        });

        if (res.status === 401 && this.reloadAuthToken(url)) {
          watchdog.done();
          return this.chatCompletion(messages, tools, requestId, signal);
        }

        if (!res.ok) {
          watchdog.done();
          const errText = await res.text();
          throw this.httpError(res.status, errText, requestId, res.headers);
        }
        data = (await res.json()) as ChatCompletionResponse;
      } catch (err: any) {
        watchdog.done();
        throw classifyTransportError(err, signal, requestId, "connect");
      } finally {
        watchdog.done();
      }
      const executions = this.pending?.executions;
      this.pending = {
        usage: chatUsage(data.usage),
        providerRequestId: data.id,
        effectiveModel: (data as any).model,
        endpoint: currentEp,
        ...(executions !== undefined ? { executions } : {}),
      };
      if (!data.choices || data.choices.length === 0) {
        throw new InferenceError("protocol_error", "provider", "Model returned empty choices array", { requestId, failoverEligible: false });
      }

      const choice = data.choices[0] as { message: ChatMessage; finish_reason?: string };
      if (choice.message?.tool_calls && Array.isArray(choice.message.tool_calls)) {
        for (const tc of choice.message.tool_calls) {
          if (tc.function && typeof tc.function.arguments === "object" && tc.function.arguments !== null) {
            tc.function.arguments = JSON.stringify(tc.function.arguments);
          }
        }
      }
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
          { requestId, partialText: typeof choice.message.content === "string" ? choice.message.content : "", failoverEligible: false, truncatedCalls: truncatedCalls(choice.message.tool_calls ?? []) },
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

  /**
   * The chat request body exactly as it leaves for `currentEp` (openai-chat protocol): egress quarantine and history
   * sanitization applied to messages and tools, model, temperature, tools and tool_choice, the output allowance
   * (max_tokens on local endpoints) and streaming options. Inference and request counting both send this body, so a
   * count is of the request that is actually sent. Throws when the information-flow boundary denies the egress.
   */
  private outboundChatBody(currentEp: string, messages: ChatMessage[], tools: ToolDefinition[]): any {
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
      throw egressDenied(
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
        throw egressDenied(
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
    // Local endpoints: cap a reply at the completion reserve the context budget already assumes, so a runaway
    // generation cannot run for minutes. (Cloud providers differ on the parameter name and are left to their limits.)
    if (!this.conn.providerId) payload.max_tokens = this.maxOutputTokens;
    if (this.conn.usage === "openrouter") payload.usage = { include: true };
    if (this.conn.usage === "openrouter" || this.conn.usage === "stream-options") payload.stream_options = { include_usage: true };
    this.omitUnsupported(payload);
    return payload;
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

      const payload = this.outboundChatBody(currentEp, messages, tools);

      const watchdog = this.createWatchdog(signal, currentEp);
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
          signal: watchdog.signal,
          ...this.fetchPolicy(),
        });
      } catch (err: any) {
        watchdog.done();
        // No resend here: a rejected fetch does not prove the gateway never admitted the request, and a
        // second attempt would replace this error with its own. Recovery belongs to the agent loop.
        throw classifyTransportError(err, signal, requestId, "connect");
      }

      if (res.status === 401 && this.reloadAuthToken(url)) {
        watchdog.done();
        return this.chatCompletionStream(messages, tools, onToken, requestId, signal);
      }

      if (!res.ok || !res.body) {
        watchdog.done();
        const errText = await res.text().catch(() => res.statusText);
        throw this.httpError(res.status, errText, requestId, res.headers);
      }

      this.lastAdmission = parseAdmissionHeaders((name) => res.headers.get(name));
      let fullContent = "";
      let reasoningContent = "";
      let finishReason: string | undefined;
      let sawDone = false;
      this.pending = { endpoint: currentEp, executions: this.pending?.executions };
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
        const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoningDelta === "string") {
          reasoningContent += reasoningDelta;
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
            // The name arrives once in spec streams. Some servers repeat it in later deltas, or send it cumulatively;
            // only a genuinely new fragment is appended (PRV-04: a repeated name became "read_fileread_file").
            const fragment = tc.function?.name;
            if (fragment) {
              if (!current.name) current.name = fragment;
              else if (fragment !== current.name) current.name = fragment.startsWith(current.name) ? fragment : current.name + fragment;
            }
            const rawArgs = tc.function?.arguments;
            if (rawArgs !== undefined && rawArgs !== null) {
              if (typeof rawArgs === "object") {
                current.args = JSON.stringify(rawArgs);
              } else {
                current.args += String(rawArgs);
              }
            }

            toolCallsMap.set(idx, current);
          }
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          watchdog.onChunk();

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
      } finally {
        watchdog.done();
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
          { requestId, partialText: fullContent, failoverEligible: false, truncatedCalls: truncatedCalls(assembledToolCalls) },
        );
      }

      // The stream completed with nothing in it; the non-streaming re-request is a new operation with its own
      // X-Request-ID so the provider's records never show two executions under one request ID.
      if (!fullContent && !reasoningContent && assembledToolCalls.length === 0) {
        if (this.pending) this.pending.executions = 2;
        else this.pending = { endpoint: currentEp, executions: 2 };
        console.error(pc.dim(`[nexus] Empty stream from ${this.conn.label}; re-requesting non-streaming completion (executions: 2).`));
        const res = await this.chatCompletionOnce(messages, tools, randomUUID(), signal);
        if (this.pending) this.pending.executions = 2;
        else this.pending = { endpoint: currentEp, executions: 2 };
        return res;
      }

      return {
        role: "assistant",
        content: fullContent || null,
        ...(assembledToolCalls.length > 0 ? { tool_calls: assembledToolCalls } : {}),
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      };
    });
  }

  /** Egress interception (DISC-001..003, CTX-006, FAIL-003) of messages and tools bound for `currentEp`. */
  private egress(messages: ChatMessage[], tools: ToolDefinition[], currentEp: string): { messages: ChatMessage[]; tools: ToolDefinition[] } {
    const ctx = { taskId: this.taskId, sessionId: this.sessionId, sourceBoundary: "HOST_LOCAL" as const };
    const m = this.boundary.evaluateEgress(messages, currentEp, ctx);
    if (!m.allowed) throw egressDenied(m.reason || `Egress to endpoint '${currentEp}' denied by InformationFlowBoundary [FAIL-003].`);
    let outTools = tools;
    if (tools.length > 0) {
      const t = this.boundary.evaluateEgress(tools, currentEp, ctx);
      if (!t.allowed) throw egressDenied(t.reason || `Egress of tools to endpoint '${currentEp}' denied by InformationFlowBoundary [FAIL-003].`);
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
      const watchdog = this.createWatchdog(signal, currentEp);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...this.authorization(url), ...this.providerHeaders(outbound.messages), "X-Request-ID": requestId },
          body: JSON.stringify(req.body),
          signal: watchdog.signal,
          ...this.fetchPolicy(),
        });
      } catch (err: any) {
        watchdog.done();
        throw classifyTransportError(err, signal, requestId, "connect");
      }
      if (!res.ok || (stream && !res.body)) {
        watchdog.done();
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
        } finally {
          watchdog.done();
        }
        try {
          result = anthropic ? parseAnthropicResponse(data, owner) : parseResponsesResponse(data, owner, keepReasoning);
        } catch (e) {
          throw e instanceof ProviderStreamError ? this.fromStreamError(e, requestId) : e;
        }
      } else {
        const parser = anthropic ? anthropicStreamParser(owner, onToken) : responsesStreamParser(owner, keepReasoning, onToken);
        try {
          await readSse(
            res.body!,
            (name, raw) => {
              let data: any;
              try {
                data = JSON.parse(raw);
              } catch {
                throw new ProviderStreamError(`Malformed stream event: ${raw.slice(0, 120)}`, undefined, parser.text(), true);
              }
              parser.event(name, data);
            },
            () => watchdog.onChunk(),
          );
        } catch (err: any) {
          if (err instanceof ProviderStreamError) throw this.fromStreamError(err, requestId);
          throw classifyTransportError(err, signal, requestId, "stream", parser.text());
        } finally {
          watchdog.done();
        }
        result = parser.result();
      }
      this.pending = { endpoint: currentEp, usage: result.usage, providerRequestId: result.providerRequestId, effectiveModel: result.effectiveModel, executions: this.pending?.executions };
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
          { requestId, partialText: result.text, failoverEligible: false, truncatedCalls: truncatedCalls(result.message.tool_calls ?? []) },
        );
      }
      return result.message;
    });
  }

  private combinedSignal(operatorSignal?: AbortSignal): AbortSignal {
    return this.createWatchdog(operatorSignal).signal;
  }

  /** HTTP 5xx/429/408 are provider-side; other 4xx are request faults (client origin). */
  private httpError(status: number, body: string, requestId: string, headers?: Headers): InferenceError {
    const providerSide = status >= 500 || status === 429 || status === 408;
    const hints = providerHints(headers, body);
    const shown = boundedProviderText(body);
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

  /** Set when the endpoint answered that it has no embeddings: later calls fail at once instead of per chunk. */
  private embeddingsUnsupported?: string;

  async generateEmbedding(text: string, model?: string): Promise<number[]> {
    // Bulk repository indexing is not a disclosure any provider selection authorizes; search stays lexical instead.
    if (this.conn.providerId && this.disclosureOf() === "cloud") {
      throw new Error(`Embeddings are not sent to cloud provider '${this.conn.providerId}'.`);
    }
    if (this.embeddingsUnsupported) throw new Error(this.embeddingsUnsupported);
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
        throw egressDenied(
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
        signal: metadataSignal(),
        ...this.fetchPolicy(),
      });

      if (!res.ok) {
        const message = `Embedding request failed (${res.status}): ${boundedProviderText(await res.text())}`;
        if (res.status === 404 || res.status === 501) this.embeddingsUnsupported = `${message} (embeddings are off for this session)`;
        throw new Error(message);
      }

      const data: any = await res.json();
      if (data.data && Array.isArray(data.data) && data.data[0]?.embedding) {
        return data.data[0].embedding;
      }
      throw new Error("Invalid embedding response format");
    });
  }
}
