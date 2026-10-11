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
import { classifyDestination } from "./core/egress.js";

export type WireProtocol = "openai-chat" | "openai-responses" | "anthropic-messages";
export type AuthStyle = "bearer" | "x-api-key" | "none" | "oauth";

/** How an operator can connect a provider from the TUI or `nexus connect`. */
export interface ConnectMethod {
  id: string;
  label: string;
  kind: "key" | "browser" | "device";
  /** Uses another vendor's client identity; the providers' terms may not permit it. */
  unofficial?: boolean;
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
  auth: AuthStyle;
  /** Headers this provider requires on every request. */
  staticHeaders?: Record<string, string>;
  /** Ask the provider to report usage (and, where offered, cost) on streamed responses. */
  usage: "openrouter" | "stream-options" | "native";
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

export function providerDefinition(id: string | undefined): ProviderDefinition | undefined {
  return id ? PROVIDERS[id] : undefined;
}

/** `NEXUS_<ID>_BASE_URL`: the operator's override of a provider's base URL. */
export function baseUrlSetting(id: string): string {
  return `NEXUS_${id.toUpperCase()}_BASE_URL`;
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
  staticHeaders: Record<string, string>;
  usage: ProviderDefinition["usage"] | "none";
  /** Whether requests carry the appliance's X-Task-Class routing hint. */
  sendTaskClass: boolean;
  streamOnly: boolean;
}

/** Copilot serves some models through the Responses API only. */
export function protocolFor(providerId: string | undefined, model: string): WireProtocol | undefined {
  if (providerId === "copilot" && /^gpt-5/i.test(model)) return "openai-responses";
  return undefined;
}

export function connectionFor(providerId: string | undefined, model = ""): ResolvedConnection {
  const def = providerDefinition(providerId);
  if (!def) {
    return { label: "endpoint", protocol: "openai-chat", auth: "bearer", staticHeaders: {}, usage: "none", sendTaskClass: true, streamOnly: false };
  }
  return {
    providerId: def.id,
    label: def.label,
    protocol: protocolFor(def.id, model) ?? def.protocol,
    auth: def.auth,
    staticHeaders: { ...(def.staticHeaders ?? {}) },
    usage: def.usage,
    sendTaskClass: false,
    streamOnly: Boolean(def.streamOnly),
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
