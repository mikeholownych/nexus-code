/**
 * What the model picker shows: the appliance and every cloud provider, whether and how each is connected, the models
 * each lists, and the operator's recent selections. Listing never blocks on a slow or offline provider: each list
 * is fetched with a timeout and falls back to the last good list cached in ~/.cache/nexus/models.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { credentialStorageHome, LocalLlmClient, operatorSetting } from "./client.js";
import { applianceEndpointSelection, buildConfig, providerBaseUrl, providerKey } from "./config.js";
import { resolveCredential } from "./credentials.js";
import { originOf, PROVIDERS, providerDefinition, type ConnectMethod } from "./providers.js";
import type { HarnessConfig } from "./types.js";

/** The appliance's id in the picker (it is not a cloud provider). */
export const APPLIANCE = "appliance";

export interface CatalogProvider {
  id: string;
  label: string;
  /** "local" for the appliance, "cloud" otherwise. */
  disclosure: "local" | "cloud";
  connected: boolean;
  /** Where the connection's credential comes from ("$OPENROUTER_API_KEY", "Nexus", "Codex CLI", ...). */
  source?: string;
  /** True when the credential is read from another client (Codex CLI, opencode, crush, Copilot plugin). */
  external?: boolean;
  methods: ConnectMethod[];
  status: "ok" | "cached" | "error" | "disconnected";
  error?: string;
}

export interface CatalogModel {
  provider: string;
  id: string;
}

export interface ModelRef {
  provider: string;
  model: string;
}

export interface Catalog {
  providers: CatalogProvider[];
  models: CatalogModel[];
  current: ModelRef;
  recent: ModelRef[];
}

const MAX_RECENT = 8;
const stateFile = () => path.join(credentialStorageHome(), ".local/state/nexus/recent-models.json");
const cacheFile = (id: string) => path.join(credentialStorageHome(), ".cache/nexus/models", `${id.replace(/[^a-z0-9_-]/gi, "_")}.json`);

function cacheId(providerId: string, endpoint: string): string {
  let identity = endpoint.trim();
  try {
    const normalized = new URL(identity);
    normalized.hash = "";
    identity = normalized.toString().replace(/\/+$/, "");
  } catch {}
  return `${providerId}-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

export function readRecent(): ModelRef[] {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), "utf-8"));
    return Array.isArray(raw) ? raw.filter((r) => typeof r?.provider === "string" && typeof r?.model === "string").slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function recordRecent(ref: ModelRef): void {
  const list = [ref, ...readRecent().filter((r) => r.provider !== ref.provider || r.model !== ref.model)].slice(0, MAX_RECENT);
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(list, null, 2) + "\n");
  } catch {}
}

/** Chat-capable entries of a provider's list (OpenAI and Copilot lists also carry embedding/audio/image models). */
export function chatModel(providerId: string, id: string): boolean {
  if (/(embedding|tts|whisper|dall-e|gpt-image|audio|realtime|transcribe|moderation|davinci|babbage)/i.test(id)) return false;
  if (providerId === "openai") return /^(gpt-|o\d|chatgpt-|codex)/i.test(id);
  return true;
}

function cached(id: string): string[] | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(id), "utf-8"));
    return Array.isArray(raw?.models) ? raw.models : undefined;
  } catch {
    return undefined;
  }
}

function cache(id: string, models: string[]): void {
  try {
    fs.mkdirSync(path.dirname(cacheFile(id)), { recursive: true });
    fs.writeFileSync(cacheFile(id), JSON.stringify({ fetchedAt: new Date().toISOString(), models }) + "\n");
  } catch {}
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`no answer within ${ms / 1000}s`)), ms); })]);
  } finally {
    clearTimeout(t);
  }
}

/** The appliance connection, whatever provider is currently selected. */
export function applianceConfig(base: HarnessConfig): HarnessConfig {
  try {
    const config = buildConfig({ appliance: true });
    const selection = applianceEndpointSelection();
    const origin = selection ? originOf(selection.endpoint) : undefined;
    return {
      ...config,
      workspace: base.workspace,
      ...(origin ? { authorizedDisclosureOrigins: [...new Set([...(config.authorizedDisclosureOrigins ?? []), origin])] } : {}),
    };
  } catch {
    return { ...base, provider: undefined };
  }
}

/** A connection config for `providerId` with its own key (sign-in providers resolve theirs per request). */
export function providerConfig(base: HarnessConfig, providerId: string, model = ""): HarnessConfig {
  const endpoint = providerBaseUrl(providerId);
  const origin = originOf(endpoint)!;
  return {
    ...base,
    provider: providerId,
    endpoint,
    model,
    apiKey: providerKey(providerId),
    credentialOrigin: origin,
    fallbackEndpoints: undefined,
    pinEndpoint: true,
    authorizedDisclosureOrigins: [...new Set([...(base.authorizedDisclosureOrigins ?? []), origin])],
  };
}

export function connectionOf(providerId: string): { connected: boolean; source?: string; external?: boolean } {
  const def = providerDefinition(providerId);
  if (!def) return { connected: false };
  if (providerId === "compatible") {
    try { providerBaseUrl("compatible"); } catch { return { connected: false }; }
  }
  const found = resolveCredential(providerId, def.credentialEnv);
  if (found) return { connected: true, source: found.source, external: found.kind === "external" };
  // A key-less compatible server (plain vLLM, llama.cpp) the operator declared with NEXUS_COMPATIBLE_AUTH=none (PRV-14).
  if (providerId === "compatible" && operatorSetting("NEXUS_COMPATIBLE_AUTH") === "none") return { connected: true, source: "declared key-less (NEXUS_COMPATIBLE_AUTH=none)" };
  return { connected: false };
}

export async function buildCatalog(config: HarnessConfig, opts: { timeoutMs?: number } = {}): Promise<Catalog> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const appliance = applianceConfig(config);
  const applianceClient = new LocalLlmClient(appliance);
  const providers: CatalogProvider[] = [];
  const models: CatalogModel[] = [];

  const load = async (entry: CatalogProvider, create: () => { endpoint: string; list: () => Promise<string[]> }) => {
    let endpoint: string | undefined;
    try {
      const source = create();
      endpoint = source.endpoint;
      const ids = (await withTimeout(source.list(), timeoutMs)).filter((id) => chatModel(entry.id, id));
      cache(cacheId(entry.id, endpoint), ids);
      models.push(...ids.map((id) => ({ provider: entry.id, id })));
    } catch (err: any) {
      const old = endpoint ? cached(cacheId(entry.id, endpoint)) : undefined;
      entry.status = old ? "cached" : "error";
      entry.error = String(err?.message ?? err).slice(0, 200);
      if (old) models.push(...old.map((id) => ({ provider: entry.id, id })));
    }
  };

  const applianceEntry: CatalogProvider = {
    id: APPLIANCE,
    label: `Appliance (${originOf(appliance.endpoint)?.replace(/^https?:\/\//, "") ?? appliance.endpoint})`,
    disclosure: applianceClient.disclosureOf(),
    connected: true,
    methods: [],
    status: "ok",
  };
  providers.push(applianceEntry);
  const jobs: Promise<void>[] = [load(applianceEntry, () => ({ endpoint: appliance.endpoint, list: () => applianceClient.listModels() }))];

  for (const def of Object.values(PROVIDERS)) {
    const c = connectionOf(def.id);
    if (def.id === "compatible" && !c.connected) continue; // needs a base URL before it is meaningful
    const entry: CatalogProvider = {
      id: def.id,
      label: def.label,
      disclosure: "cloud",
      connected: c.connected,
      ...(c.source ? { source: c.source } : {}),
      ...(c.external ? { external: true } : {}),
      methods: def.methods,
      status: c.connected ? "ok" : "disconnected",
    };
    providers.push(entry);
    if (c.connected) jobs.push(load(entry, () => {
      const provider = providerConfig(config, def.id);
      return { endpoint: provider.endpoint, list: () => new LocalLlmClient(provider).listModels() };
    }));
  }
  await Promise.all(jobs);

  const order = new Map(providers.map((p, i) => [p.id, i]));
  models.sort((a, b) => (order.get(a.provider)! - order.get(b.provider)!) || a.id.localeCompare(b.id));
  return {
    providers,
    models,
    current: { provider: config.provider ?? APPLIANCE, model: config.model },
    recent: readRecent(),
  };
}
