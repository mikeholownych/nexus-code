/**
 * Provider credentials: where each provider's key or sign-in comes from, in precedence order.
 *
 * 1. The provider's environment variable (operator environment / config.env / process env).
 * 2. Nexus's own store, ~/.config/nexus/credentials.json (mode 0600), written by `nexus connect` and the TUI.
 * 3. Connections already registered in other clients on this machine, read in place and never modified:
 *    Codex CLI (~/.codex/auth.json), opencode (~/.local/share/opencode/auth.json), crush
 *    (~/.local/share/crush/crush.json) and the GitHub Copilot editor plugins (~/.config/github-copilot/apps.json).
 *
 * An OAuth token read from another client is used while valid and re-read when it expires; Nexus never refreshes it,
 * because refresh tokens rotate and refreshing would sign the owning client out. All files are read from the
 * operator's credential home (credentialStorageHome), never from a HOME a project .env set.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { credentialStorageHome } from "./client.js";
export function credentialsPath() {
    return path.join(credentialStorageHome(), ".config/nexus/credentials.json");
}
function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf-8"));
    }
    catch {
        return undefined;
    }
}
function readStore() {
    const raw = readJson(credentialsPath());
    return raw && typeof raw === "object" && raw.providers && typeof raw.providers === "object"
        ? { version: 1, providers: raw.providers }
        : { version: 1, providers: {} };
}
/** Atomic, owner-only write: a credential file is never briefly world-readable or half-written. */
function writeStore(store) {
    const file = credentialsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
}
export function saveCredential(providerId, credential) {
    const store = readStore();
    store.providers[providerId] = credential;
    writeStore(store);
}
/** Removes Nexus's own credential; connections owned by other clients or the environment are untouched. */
export function removeCredential(providerId) {
    const store = readStore();
    if (!(providerId in store.providers))
        return false;
    delete store.providers[providerId];
    writeStore(store);
    return true;
}
/** Expiry (epoch ms) from a JWT's `exp` claim, without verifying it (advisory only). */
export function jwtExpiry(token) {
    const claims = jwtClaims(token);
    return typeof claims?.exp === "number" ? claims.exp * 1000 : undefined;
}
export function jwtClaims(token) {
    const part = token?.split(".")[1];
    if (!part)
        return undefined;
    try {
        return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"));
    }
    catch {
        return undefined;
    }
}
/** ChatGPT account id from ID/access token claims. */
export function chatgptAccountId(...tokens) {
    for (const t of tokens) {
        const c = jwtClaims(t);
        const id = c?.chatgpt_account_id ?? c?.["https://api.openai.com/auth"]?.chatgpt_account_id;
        if (typeof id === "string" && id)
            return id;
    }
    return undefined;
}
const now = () => new Date().toISOString();
/** A crush api_key may be a "$VAR" reference rather than a value. */
const literalKey = (v) => (typeof v === "string" && v.trim() && !v.trim().startsWith("$") ? v.trim() : undefined);
/** Names other clients use for Nexus's provider ids. */
const OPENCODE_IDS = {
    openrouter: ["openrouter"],
    openai: ["openai"],
    anthropic: ["anthropic"],
    chatgpt: ["openai"],
    copilot: ["github-copilot"],
};
const CRUSH_IDS = { openrouter: ["openrouter"], openai: ["openai"], anthropic: ["anthropic"], chatgpt: ["openai"], copilot: ["copilot"] };
/** Connections registered in other clients for `providerId`, best first. Read-only. */
export function externalCredentials(providerId) {
    const home = credentialStorageHome();
    const out = [];
    const oauthWanted = providerId === "chatgpt" || providerId === "copilot";
    if (providerId === "chatgpt") {
        const file = path.join(home, ".codex/auth.json");
        const codex = readJson(file);
        const t = codex?.tokens;
        if (typeof t?.access_token === "string" && t.access_token) {
            out.push({
                source: "Codex CLI",
                kind: "external",
                file,
                refreshable: false,
                credential: {
                    type: "oauth",
                    access: t.access_token,
                    expiresAt: jwtExpiry(t.access_token),
                    accountId: t.account_id || chatgptAccountId(t.id_token, t.access_token),
                    savedAt: codex.last_refresh ?? now(),
                },
            });
        }
    }
    const ocFile = path.join(home, ".local/share/opencode/auth.json");
    const oc = readJson(ocFile);
    for (const id of OPENCODE_IDS[providerId] ?? []) {
        const e = oc?.[id];
        if (!e || typeof e !== "object")
            continue;
        if (oauthWanted && e.type === "oauth" && typeof e.access === "string") {
            out.push({
                source: "opencode",
                kind: "external",
                file: ocFile,
                refreshable: false,
                credential: {
                    type: "oauth",
                    access: e.access,
                    refresh: providerId === "copilot" ? e.refresh : undefined, // Copilot: the GitHub token, exchangeable without rotation
                    expiresAt: typeof e.expires === "number" && e.expires > 0 ? e.expires : jwtExpiry(e.access),
                    accountId: e.accountId,
                    savedAt: now(),
                },
            });
        }
        else if (!oauthWanted && e.type === "api" && literalKey(e.key)) {
            out.push({ source: "opencode", kind: "external", file: ocFile, refreshable: false, credential: { type: "api", key: literalKey(e.key), savedAt: now() } });
        }
    }
    const crushFile = path.join(home, ".local/share/crush/crush.json");
    const crush = readJson(crushFile);
    for (const id of CRUSH_IDS[providerId] ?? []) {
        const p = crush?.providers?.[id];
        if (!p || typeof p !== "object")
            continue;
        const o = p.oauth;
        if (oauthWanted && o && typeof o.access_token === "string") {
            out.push({
                source: "crush",
                kind: "external",
                file: crushFile,
                refreshable: false,
                credential: {
                    type: "oauth",
                    access: o.access_token,
                    refresh: providerId === "copilot" ? o.refresh_token : undefined,
                    expiresAt: typeof o.expires_at === "number" && o.expires_at > 0 ? o.expires_at * 1000 : jwtExpiry(o.access_token),
                    accountId: o.account_id,
                    savedAt: now(),
                },
            });
        }
        else if (!oauthWanted && literalKey(p.api_key)) {
            out.push({ source: "crush", kind: "external", file: crushFile, refreshable: false, credential: { type: "api", key: literalKey(p.api_key), savedAt: now() } });
        }
    }
    if (providerId === "copilot") {
        for (const name of ["apps.json", "hosts.json"]) {
            const file = path.join(home, ".config/github-copilot", name);
            const data = readJson(file);
            if (!data || typeof data !== "object")
                continue;
            const entry = Object.entries(data).find(([k, v]) => k.startsWith("github.com") && typeof v?.oauth_token === "string");
            if (entry) {
                const githubToken = entry[1].oauth_token;
                out.push({
                    source: "GitHub Copilot plugin",
                    kind: "external",
                    file,
                    refreshable: false,
                    // No Copilot token yet: the GitHub token is exchanged for one on first use (no rotation involved).
                    credential: { type: "oauth", access: "", refresh: githubToken, expiresAt: 0, savedAt: now() },
                });
            }
        }
    }
    return out;
}
/**
 * The credential a provider connection uses: its environment variable, else Nexus's store, else a connection
 * registered in another client. `envVar` is the provider's variable (undefined for OAuth-only providers).
 */
/** The API key a provider connection uses (env, Nexus store, or another client); undefined for sign-in providers. */
export function providerApiKey(providerId, envVar) {
    const r = resolveCredential(providerId, envVar);
    return r?.credential.type === "api" ? r.credential.key : undefined;
}
export function resolveCredential(providerId, envVar) {
    const env = envVar ? process.env[envVar]?.trim() : undefined;
    if (env)
        return { source: `$${envVar}`, kind: "env", refreshable: false, credential: { type: "api", key: env, savedAt: now() } };
    const own = readStore().providers[providerId];
    if (own)
        return { source: own.label ?? "Nexus", kind: "nexus", refreshable: true, credential: own, file: credentialsPath() };
    return externalCredentials(providerId)[0];
}
