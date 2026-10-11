/**
 * What the model picker shows: the appliance and every cloud provider, whether and how each is connected, the models
 * each lists, and the operator's recent selections. Listing never blocks on a slow or offline provider: each list
 * is fetched with a timeout and falls back to the last good list cached in ~/.cache/nexus/models.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { credentialStorageHome, LocalLlmClient } from "./client.js";
import { buildConfig, providerBaseUrl, providerKey } from "./config.js";
import { resolveCredential } from "./credentials.js";
import { originOf, PROVIDERS, providerDefinition } from "./providers.js";
/** The appliance's id in the picker (it is not a cloud provider). */
export const APPLIANCE = "appliance";
const MAX_RECENT = 8;
const stateFile = () => path.join(credentialStorageHome(), ".local/state/nexus/recent-models.json");
const cacheFile = (id) => path.join(credentialStorageHome(), ".cache/nexus/models", `${id.replace(/[^a-z0-9_-]/gi, "_")}.json`);
export function readRecent() {
    try {
        const raw = JSON.parse(fs.readFileSync(stateFile(), "utf-8"));
        return Array.isArray(raw) ? raw.filter((r) => typeof r?.provider === "string" && typeof r?.model === "string").slice(0, MAX_RECENT) : [];
    }
    catch {
        return [];
    }
}
export function recordRecent(ref) {
    const list = [ref, ...readRecent().filter((r) => r.provider !== ref.provider || r.model !== ref.model)].slice(0, MAX_RECENT);
    try {
        fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
        fs.writeFileSync(stateFile(), JSON.stringify(list, null, 2) + "\n");
    }
    catch { }
}
/** Chat-capable entries of a provider's list (OpenAI and Copilot lists also carry embedding/audio/image models). */
function chatModel(providerId, id) {
    if (/(embedding|tts|whisper|dall-e|gpt-image|audio|realtime|transcribe|moderation|davinci|babbage)/i.test(id))
        return false;
    if (providerId === "openai")
        return /^(gpt-|o\d|chatgpt-|codex)/i.test(id);
    return true;
}
function cached(id) {
    try {
        const raw = JSON.parse(fs.readFileSync(cacheFile(id), "utf-8"));
        return Array.isArray(raw?.models) ? raw.models : undefined;
    }
    catch {
        return undefined;
    }
}
function cache(id, models) {
    try {
        fs.mkdirSync(path.dirname(cacheFile(id)), { recursive: true });
        fs.writeFileSync(cacheFile(id), JSON.stringify({ fetchedAt: new Date().toISOString(), models }) + "\n");
    }
    catch { }
}
async function withTimeout(p, ms) {
    let t;
    try {
        return await Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`no answer within ${ms / 1000}s`)), ms); })]);
    }
    finally {
        clearTimeout(t);
    }
}
/** The appliance connection, whatever provider is currently selected. */
export function applianceConfig(base) {
    try {
        return { ...buildConfig({ appliance: true }), workspace: base.workspace };
    }
    catch {
        return { ...base, provider: undefined };
    }
}
/** A connection config for `providerId` with its own key (sign-in providers resolve theirs per request). */
export function providerConfig(base, providerId, model = "") {
    const endpoint = providerBaseUrl(providerId);
    const origin = originOf(endpoint);
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
export function connectionOf(providerId) {
    const def = providerDefinition(providerId);
    if (!def)
        return { connected: false };
    if (providerId === "compatible") {
        try {
            providerBaseUrl("compatible");
        }
        catch {
            return { connected: false };
        }
    }
    const found = resolveCredential(providerId, def.credentialEnv);
    return found ? { connected: true, source: found.source, external: found.kind === "external" } : { connected: false };
}
export async function buildCatalog(config, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 8_000;
    const appliance = applianceConfig(config);
    const providers = [];
    const models = [];
    const load = async (entry, list) => {
        try {
            const ids = (await withTimeout(list(), timeoutMs)).filter((id) => chatModel(entry.id, id));
            cache(entry.id, ids);
            models.push(...ids.map((id) => ({ provider: entry.id, id })));
        }
        catch (err) {
            const old = cached(entry.id);
            entry.status = old ? "cached" : "error";
            entry.error = String(err?.message ?? err).slice(0, 200);
            if (old)
                models.push(...old.map((id) => ({ provider: entry.id, id })));
        }
    };
    const applianceEntry = {
        id: APPLIANCE,
        label: `Appliance (${originOf(appliance.endpoint)?.replace(/^https?:\/\//, "") ?? appliance.endpoint})`,
        disclosure: "local",
        connected: true,
        methods: [],
        status: "ok",
    };
    providers.push(applianceEntry);
    const jobs = [load(applianceEntry, () => new LocalLlmClient(appliance).listModels())];
    for (const def of Object.values(PROVIDERS)) {
        const c = connectionOf(def.id);
        if (def.id === "compatible" && !c.connected)
            continue; // needs a base URL before it is meaningful
        const entry = {
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
        if (c.connected)
            jobs.push(load(entry, () => new LocalLlmClient(providerConfig(config, def.id)).listModels()));
    }
    await Promise.all(jobs);
    const order = new Map(providers.map((p, i) => [p.id, i]));
    models.sort((a, b) => (order.get(a.provider) - order.get(b.provider)) || a.id.localeCompare(b.id));
    return {
        providers,
        models,
        current: { provider: config.provider ?? APPLIANCE, model: config.model },
        recent: readRecent(),
    };
}
