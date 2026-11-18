/**
 * Cloud inference providers: one declaration per provider feeds configuration, credential scoping, disclosure policy
 * and request construction. The local appliance is not a provider here: a configuration without a provider id keeps
 * the original endpoint path (LOCAL_LLM_*, stored gateway token, X-Task-Class, endpoint failover) unchanged.
 *
 * Separate concepts:
 * - Provider definition (PROVIDERS): identity, wire protocol, default base URL, credential variable, auth style.
 * - Connection (ResolvedConnection): the base URL actually used, its credential scope and disclosure class.
 * - Model: the provider's model id, passed verbatim (ids may contain "/" and ":").
 * - Role binding: main, planner and coder each name their own provider; subagents and auxiliary calls inherit main.
 */
import fs from "node:fs";
import { classifyDestination } from "./core/egress.js";
import { parseProvidersDocument } from "./provider_file.js";

export type WireProtocol = "openai-chat" | "openai-responses" | "anthropic-messages" | "gemini-generate-content" | "bedrock-converse";
/** "sigv4": requests are signed from the AWS credential chain (environment and shared files), not a key. */
/** "gcp-adc": a bearer token from Google Application Default Credentials (service-account key file or gcloud), for Vertex AI. */
export type AuthStyle = "bearer" | "x-api-key" | "header" | "none" | "oauth" | "sigv4" | "gcp-adc";

/** How an operator can connect a provider from the TUI or `nexus connect`. */
export interface ConnectMethod {
  id: string;
  label: string;
  kind: "key" | "browser" | "device";
  /** Uses another vendor's client identity; the providers' terms may not permit it. */
  unofficial?: boolean;
}

/** A model-id pattern (case-insensitive regular expression source) served over another wire protocol. */
export interface ProtocolRule {
  modelPattern: string;
  protocol: WireProtocol;
}

export interface ProviderDefinition {
  id: string;
  label: string;
  protocol: WireProtocol;
  /** Includes the provider's API path and version; nothing is appended except the operation path. */
  baseUrl?: string;
  /** Environment variable holding this provider's key (none for sign-in-only providers). Sent only to the connection's own origin. */
  credentialEnv?: string;
  methods: ConnectMethod[];
  /** The backend accepts streamed requests only; non-streaming calls are streamed internally. */
  streamOnly?: boolean;
  /** Request parameters this backend rejects for every model; never sent. */
  omitParams?: string[];
  auth: AuthStyle;
  /** Header carrying the key when `auth` is "header" (for example Azure OpenAI's `api-key`). */
  authHeader?: string;
  /** Models this provider serves over a different wire protocol than `protocol`; first matching pattern wins. */
  protocolRules?: ProtocolRule[];
  /** Headers this provider requires on every request. */
  staticHeaders?: Record<string, string>;
  /** Query parameters added to every request URL (for example Azure OpenAI's `api-version`). */
  query?: Record<string, string>;
  /** Ask the provider to report usage (and, where offered, cost) on streamed responses. */
  usage: "openrouter" | "stream-options" | "native";
  /** The request cache hints this backend understands (anthropic: cache_control breakpoints). Sent only when the operator sets NEXUS_PROMPT_CACHE=1. */
  promptCache?: "anthropic";
}

export const PROVIDERS: Readonly<Record<string, ProviderDefinition>> = Object.freeze({
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    protocol: "openai-chat",
    baseUrl: "https://openrouter.ai/api/v1",
    credentialEnv: "OPENROUTER_API_KEY",
    auth: "bearer",
    staticHeaders: { "X-Title": "Nexus" },
    usage: "openrouter",
    methods: [
      { id: "api-key", label: "API key", kind: "key" },
      { id: "openrouter-oauth", label: "Sign in with OpenRouter", kind: "browser" },
    ],
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    protocol: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    credentialEnv: "OPENAI_API_KEY",
    auth: "bearer",
    usage: "native",
    methods: [{ id: "api-key", label: "API key", kind: "key" }],
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    credentialEnv: "ANTHROPIC_API_KEY",
    auth: "x-api-key",
    staticHeaders: { "anthropic-version": "2023-06-01" },
    usage: "native",
    promptCache: "anthropic",
    methods: [{ id: "api-key", label: "API key", kind: "key" }],
  },
  /** ChatGPT Plus/Pro plan through the Codex backend (unofficial: Codex CLI sign-in). */
  chatgpt: {
    id: "chatgpt",
    label: "ChatGPT plan",
    protocol: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    auth: "oauth",
    staticHeaders: { originator: "nexus" },
    usage: "native",
    streamOnly: true,
    // The Codex backend serves reasoning models only and sets its own output limit.
    omitParams: ["temperature", "max_output_tokens"],
    methods: [{ id: "chatgpt-oauth", label: "Sign in with ChatGPT (unofficial)", kind: "browser", unofficial: true }],
  },
  /** GitHub Copilot subscription (unofficial: VS Code Copilot sign-in). */
  copilot: {
    id: "copilot",
    label: "GitHub Copilot",
    protocol: "openai-chat",
    baseUrl: "https://api.githubcopilot.com",
    auth: "oauth",
    usage: "native",
    // Copilot serves some models through the Responses API only.
    protocolRules: [{ modelPattern: "^gpt-5", protocol: "openai-responses" }],
    methods: [{ id: "copilot-device", label: "Sign in with GitHub (unofficial)", kind: "device", unofficial: true }],
  },
  /** Any other OpenAI-compatible Chat Completions service; its base URL must be configured by the operator. */
  compatible: {
    id: "compatible",
    label: "OpenAI-compatible",
    protocol: "openai-chat",
    credentialEnv: "NEXUS_COMPATIBLE_API_KEY",
    auth: "bearer",
    usage: "stream-options",
    methods: [{ id: "api-key", label: "API key", kind: "key" }],
  },
});

/** Providers the operator declared in ~/.config/nexus/providers.json; built-in ids can never be replaced. */
let operatorProviders: Readonly<Record<string, ProviderDefinition>> = Object.freeze({});

/**
 * Providers shipped as data (src/providers.catalog.json, the same schema as the operator's file): the OpenAI-compatible
 * long tail. Operator definitions of the same id take precedence; built-ins are never replaced. Read on first use.
 */
let catalogProviders: readonly ProviderDefinition[] | undefined;
function catalog(): readonly ProviderDefinition[] {
  if (!catalogProviders) {
    const raw = JSON.parse(fs.readFileSync(new URL("./providers.catalog.json", import.meta.url), "utf8"));
    catalogProviders = parseProvidersDocument(raw).filter((d) => !Object.prototype.hasOwnProperty.call(PROVIDERS, d.id));
  }
  return catalogProviders;
}

export function setOperatorProviders(defs: readonly ProviderDefinition[]): void {
  const next: Record<string, ProviderDefinition> = {};
  for (const def of defs) {
    if (Object.prototype.hasOwnProperty.call(PROVIDERS, def.id)) throw new Error(`providers.${def.id}: a built-in provider id cannot be redefined`);
    next[def.id] = def;
  }
  operatorProviders = Object.freeze(next);
}

/** Where a provider definition comes from. */
export function providerSource(id: string): "built-in" | "catalog" | "providers.json" | undefined {
  if (Object.prototype.hasOwnProperty.call(PROVIDERS, id)) return "built-in";
  if (Object.prototype.hasOwnProperty.call(operatorProviders, id)) return "providers.json";
  return catalog().some((d) => d.id === id) ? "catalog" : undefined;
}

/** Every known provider: the built-ins, then the operator's own, in declaration order. The one place callers enumerate providers. */
export function allProviders(): ProviderDefinition[] {
  return [...Object.values(PROVIDERS), ...catalog().filter((d) => !Object.prototype.hasOwnProperty.call(operatorProviders, d.id)), ...Object.values(operatorProviders)];
}

export function providerIds(): string[] {
  return allProviders().map((d) => d.id);
}

export function providerDefinition(id: string | undefined): ProviderDefinition | undefined {
  if (!id) return undefined;
  if (Object.prototype.hasOwnProperty.call(PROVIDERS, id)) return PROVIDERS[id];
  if (Object.prototype.hasOwnProperty.call(operatorProviders, id)) return operatorProviders[id];
  return catalog().find((d) => d.id === id);
}

/** `NEXUS_<ID>_BASE_URL`: the operator's override of a provider's base URL. */
export function baseUrlSetting(id: string): string {
  return `NEXUS_${id.toUpperCase().replace(/-/g, "_")}_BASE_URL`;
}

export function originOf(url: string | undefined): string | undefined {
  if (!url?.trim()) return undefined;
  try {
    return new URL(url.trim()).origin;
  } catch {
    return undefined;
  }
}

export interface ResolvedConnection {
  /** Undefined for the legacy appliance/endpoint path. */
  providerId?: string;
  label: string;
  protocol: WireProtocol;
  auth: AuthStyle;
  authHeader?: string;
  staticHeaders: Record<string, string>;
  query: Record<string, string>;
  usage: ProviderDefinition["usage"] | "none";
  /** Whether requests carry the appliance's X-Task-Class routing hint. */
  sendTaskClass: boolean;
  streamOnly: boolean;
  omitParams: string[];
  promptCache?: "anthropic";
}

/** Whether requests to this connection carry cache hints: the provider declares the capability and the operator opted in. */
export function promptCacheEnabled(conn: Pick<ResolvedConnection, "promptCache" | "protocol">, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NEXUS_PROMPT_CACHE === "1" && conn.promptCache === "anthropic" && conn.protocol === "anthropic-messages";
}

/** The wire protocol a provider's rules assign to this model, when one applies. */
export function protocolFor(providerId: string | undefined, model: string): WireProtocol | undefined {
  return providerDefinition(providerId)?.protocolRules?.find((r) => new RegExp(r.modelPattern, "i").test(model))?.protocol;
}

export function connectionFor(providerId: string | undefined, model = ""): ResolvedConnection {
  const def = providerDefinition(providerId);
  if (!def) {
    // Usage is requested (OpenAI-compatible servers such as llama.cpp, vLLM and the appliance gateway report it, with
    // cached-token counts); a server that rejects stream_options has it dropped and the request retried.
    return { label: "endpoint", protocol: "openai-chat", auth: "bearer", staticHeaders: {}, query: {}, usage: "stream-options", sendTaskClass: true, streamOnly: false, omitParams: [] };
  }
  return {
    providerId: def.id,
    label: def.label,
    protocol: protocolFor(def.id, model) ?? def.protocol,
    auth: def.auth,
    ...(def.authHeader ? { authHeader: def.authHeader } : {}),
    staticHeaders: { ...(def.staticHeaders ?? {}) },
    query: { ...(def.query ?? {}) },
    usage: def.usage,
    sendTaskClass: false,
    streamOnly: Boolean(def.streamOnly),
    omitParams: [...(def.omitParams ?? [])],
    ...(def.promptCache ? { promptCache: def.promptCache } : {}),
  };
}

/**
 * Disclosure class of a destination: "cloud" when content sent there leaves the operator's machines and network.
 * URL locality is not sufficient: an origin the operator lists in NEXUS_CLOUD_ROUTED_ORIGINS (a local gateway that
 * forwards to a cloud service) is cloud, and every named provider except `compatible` is cloud by definition.
 */
export function disclosureClass(url: string, providerId: string | undefined, cloudRoutedOrigins: readonly string[] = []): "local" | "cloud" {
  if (providerId && providerId !== "compatible") return "cloud";
  const origin = originOf(url);
  if (origin && cloudRoutedOrigins.includes(origin)) return "cloud";
  const boundary = classifyDestination(url);
  return boundary === "EXTERNAL_PUBLIC" || boundary === "EXTERNAL_BOUNDED" ? "cloud" : "local";
}

export function parseOriginList(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((o) => originOf(o)).filter((o): o is string => Boolean(o));
}

/** The environment variable a provider connection reads its key from (for operator-facing messages). */
export function operatorSettingKeyForAuth(id: string): string {
  const def = providerDefinition(id);
  return def?.credentialEnv ?? (def ? `sign in with /model → ctrl+p → ${def.label}` : "the provider's API key variable");
}
