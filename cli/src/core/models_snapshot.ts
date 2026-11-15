import fs from "node:fs";

export interface SnapshotModel {
  id: string;
  context: number;
  output: number;
  input?: number;
  toolCall: boolean;
  toolChoice?: string[];
  reasoning: boolean;
  effort?: string[];
  price?: { input: number; output: number };
}

export interface SnapshotProvider {
  id: string;
  name: string;
  env: string[];
  protocol: string;
  /** Absent means unresolvable from the snapshot: a native protocol, or `needsBaseUrl` (the operator must supply it). */
  baseUrl?: string;
  /** The base URL takes its host (or all of itself) from an env variable: validate it after substitution. */
  hostFromEnv?: true;
  needsBaseUrl?: true;
  models: SnapshotModel[];
}

export interface ModelsSnapshot {
  date: string;
  commit?: string;
  license: string;
  source: string;
  providers: SnapshotProvider[];
}

export interface ProviderPin {
  suffixes: string[];
  defaultBaseUrl?: string;
  source: string;
}

export type ToolChoiceMode = "auto" | "none" | "required" | "tool";

const ENV_NAME = /^[A-Z0-9][A-Z0-9_]{1,63}$/;
const ENV_DENY = /^AWS_|^GOOGLE_APPLICATION_CREDENTIALS$|_SSH|^GITHUB_TOKEN$/;
const ENV_DENY_ALLOWED = new Set(["amazon-bedrock", "google-vertex", "google-vertex-anthropic", "github-copilot"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const unsafeId = (id: unknown, max: number): boolean =>
  typeof id !== "string" || !id || id.length > max || id.includes("..") || id.startsWith("/") || id.includes("\0");

/** Reasons a provider entry is refused (empty when it is acceptable). Mirrors scripts/gen_models_snapshot.mjs. */
export function providerViolations(p: SnapshotProvider, pins: Record<string, ProviderPin>): string[] {
  const out: string[] = [];
  if (typeof p?.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(p.id) || p.id.includes("..")) out.push("id");
  if (typeof p?.name !== "string" || !p.name || p.name.length > 200) out.push("name");
  if (typeof p?.protocol !== "string" || !(/^(openai-chat|openai-responses|anthropic-messages)$/.test(p.protocol) || /^native:.{1,200}$/.test(p.protocol))) out.push("protocol");
  const env = Array.isArray(p?.env) ? p.env : [];
  if (!Array.isArray(p?.env)) out.push("env");
  for (const e of env) {
    if (typeof e !== "string" || !ENV_NAME.test(e)) out.push("env name");
    else if (ENV_DENY.test(e) && !ENV_DENY_ALLOWED.has(p.id)) out.push(`env name ${e} not allowed`);
  }
  const pin = Object.hasOwn(pins, p?.id) ? pins[p.id] : undefined;
  if (p?.baseUrl !== undefined) {
    const url = p.baseUrl;
    if (typeof url !== "string" || /[\s\u0000-\u001f]/.test(url)) out.push("baseUrl");
    else {
      for (const m of url.matchAll(/\$\{([^}]*)\}/g)) if (!env.includes(m[1]!)) out.push("baseUrl variable not in env");
      const fromEnv = url.startsWith("${") || (url.split("://")[1] ?? "").split(/[/?#]/)[0]!.includes("${");
      if (fromEnv !== (p.hostFromEnv === true)) out.push("hostFromEnv mismatch");
      if (url.startsWith("${")) {
        if (!/^\$\{[A-Z0-9_]+\}(\/[^$]*)?$/.test(url)) out.push("baseUrl template");
      } else {
        try {
          const u = new URL(url.replace(/\$\{[^}]*\}/g, "placeholder"));
          if (!(u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname)))) out.push("baseUrl scheme");
          if (u.username || u.password) out.push("baseUrl credentials");
          if (pin && !fromEnv && !pin.suffixes.some((s) => u.hostname === s || u.hostname.endsWith(`.${s}`))) out.push("baseUrl leaves pinned host");
        } catch {
          out.push("baseUrl does not parse");
        }
      }
    }
  } else if (p?.hostFromEnv !== undefined) out.push("hostFromEnv without baseUrl");
  if (pin && p.hostFromEnv) out.push("pinned provider takes its host from env");
  return out;
}

/** Keeps only provider entries that pass `providerViolations`; the rest are listed in `rejected`. Never throws. */
export function parseSnapshot(raw: unknown, pins: Record<string, ProviderPin>): { snapshot: ModelsSnapshot; rejected: string[] } {
  const r = (raw ?? {}) as Partial<ModelsSnapshot>;
  const rejected: string[] = [];
  const providers: SnapshotProvider[] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(r.providers) ? r.providers : []) {
    const bad = providerViolations(p, pins);
    if (!bad.length && seen.has(p.id)) bad.push("duplicate");
    if (bad.length) {
      rejected.push(`${String(p?.id).slice(0, 64)}: ${bad.join("; ")}`);
      continue;
    }
    seen.add(p.id);
    providers.push({ ...p, models: (Array.isArray(p.models) ? p.models : []).filter((m) => !unsafeId(m?.id, 200)) });
  }
  const snapshot: ModelsSnapshot = {
    date: typeof r.date === "string" ? r.date : "unknown",
    ...(typeof r.commit === "string" ? { commit: r.commit } : {}),
    license: "MIT",
    source: typeof r.source === "string" ? r.source : "",
    providers,
  };
  return { snapshot, rejected };
}

interface Loaded {
  snapshot: ModelsSnapshot;
  byId: Map<string, SnapshotProvider>;
}

let loaded: Loaded | undefined;
const modelIndex = new WeakMap<SnapshotProvider, Map<string, SnapshotModel>>();

function readJson(name: string): unknown {
  return JSON.parse(fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));
}

/** Reads the snapshot on first use only; importing this module costs nothing. */
function data(): Loaded {
  if (!loaded) {
    const { snapshot } = parseSnapshot(readJson("providers.generated.json"), readJson("providers.pins.json") as Record<string, ProviderPin>);
    loaded = { snapshot, byId: new Map(snapshot.providers.map((p) => [p.id, p])) };
  }
  return loaded;
}

export function snapshotDate(): string {
  return data().snapshot.date;
}

export function snapshotProviders(): readonly SnapshotProvider[] {
  return data().snapshot.providers;
}

export function snapshotProvider(providerId: string): SnapshotProvider | undefined {
  return data().byId.get(providerId);
}

export function snapshotModel(providerId: string, modelId: string): SnapshotModel | undefined {
  const provider = data().byId.get(providerId);
  if (!provider) return undefined;
  let index = modelIndex.get(provider);
  if (!index) {
    index = new Map(provider.models.map((m) => [m.id, m]));
    modelIndex.set(provider, index);
  }
  return index.get(modelId);
}

/** Context window in tokens, or `fallback` (default undefined) when the snapshot has no positive figure. */
export function resolveContext(providerId: string, modelId: string, fallback?: number): number | undefined {
  const context = snapshotModel(providerId, modelId)?.context;
  return context && context > 0 ? context : fallback;
}

/**
 * true: the model lists the mode; false: it lists modes and this is not one of them; "unknown": the snapshot has no
 * tool-choice data for it (unknown provider or model, or no `capabilities.tools.choice`), so the caller must not assume.
 */
export function acceptsToolChoice(providerId: string, modelId: string, mode: ToolChoiceMode): boolean | "unknown" {
  const modes = snapshotModel(providerId, modelId)?.toolChoice;
  return modes ? modes.includes(mode) : "unknown";
}
