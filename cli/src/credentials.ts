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

export type StoredCredential =
  | { type: "api"; key: string; label?: string; savedAt: string }
  | {
      type: "oauth";
      access: string;
      /** Refresh token (ChatGPT) or GitHub OAuth token (Copilot). */
      refresh?: string;
      /** Epoch ms; undefined when unknown. */
      expiresAt?: number;
      accountId?: string;
      label?: string;
      savedAt: string;
    };

export interface ResolvedCredential {
  /** Where it came from, for the operator: "$OPENAI_API_KEY", "Nexus", "Codex CLI", "opencode", ... */
  source: string;
  kind: "env" | "nexus" | "external";
  credential: StoredCredential;
  /** False for tokens owned by another client: Nexus must not refresh them. */
  refreshable: boolean;
  /** File it was read from (external and nexus). */
  file?: string;
}

interface StoreFile {
  version: 1;
  providers: Record<string, StoredCredential>;
}

const LOCAL_ENDPOINT_CREDENTIAL_PREFIX = "nexus-local-endpoint:";

/** Stable credential-store key for one exact HTTP(S) origin; the credential never follows another endpoint. */
function localEndpointCredentialId(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.origin === "null") return undefined;
    return `${LOCAL_ENDPOINT_CREDENTIAL_PREFIX}${url.origin}`;
  } catch {
    return undefined;
  }
}

export function saveLocalEndpointCredential(endpoint: string, key: string): boolean {
  const id = localEndpointCredentialId(endpoint);
  const value = key.trim();
  if (!id || !value || /[\r\n]/.test(value)) return false;
  saveCredential(id, { type: "api", key: value, savedAt: now() });
  return true;
}

/** Save a verified endpoint key and its selected model as one failure-atomic setup operation. */
export function commitLocalEndpointSetup(endpoint: string, key: string, commitSettings: () => void): boolean {
  const id = localEndpointCredentialId(endpoint);
  const value = key.trim();
  if (!id || !value || /[\r\n]/.test(value)) return false;

  const file = credentialsPath();
  let previous: StoredCredential | undefined;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("The Nexus credential store is not a regular file.");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || !parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)) {
      throw new Error("The Nexus credential store has an unsupported format.");
    }
    if (Object.hasOwn(parsed.providers, id)) {
      const entry = parsed.providers[id];
      if (!entry || typeof entry !== "object" || entry.type !== "api" || typeof entry.key !== "string" || !entry.key || typeof entry.savedAt !== "string") {
        throw new Error("The local endpoint credential has an unsupported format.");
      }
      previous = entry;
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw new Error("Nexus could not safely update its credential store.");
  }
  const hadStore = fs.existsSync(file);
  try {
    saveCredential(id, { type: "api", key: value, savedAt: now() });
    commitSettings();
    return true;
  } catch (error) {
    try {
      if (previous) {
        saveCredential(id, previous);
      } else {
        removeCredential(id);
        if (!hadStore && Object.keys(readStore().providers).length === 0) {
          try { fs.unlinkSync(file); } catch (unlinkError: any) { if (unlinkError?.code !== "ENOENT") throw unlinkError; }
        }
      }
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Local endpoint setup failed and its saved credential could not be restored.");
    }
    throw error;
  }
}

export function localEndpointCredential(endpoint: string): { origin: string; key: string } | undefined {
  const id = localEndpointCredentialId(endpoint);
  if (!id) return undefined;
  const credential = readStore().providers[id];
  if (credential?.type !== "api") return undefined;
  return { origin: id.slice(LOCAL_ENDPOINT_CREDENTIAL_PREFIX.length), key: credential.key };
}

/** Used only to prevent a project or caller-supplied key from escaping its saved endpoint origin. */
export function localEndpointCredentials(): Array<{ origin: string; key: string }> {
  const store = readStore();
  const result: Array<{ origin: string; key: string }> = [];
  for (const [id, credential] of Object.entries(store.providers)) {
    if (!id.startsWith(LOCAL_ENDPOINT_CREDENTIAL_PREFIX) || credential.type !== "api") continue;
    const origin = id.slice(LOCAL_ENDPOINT_CREDENTIAL_PREFIX.length);
    if (localEndpointCredentialId(origin) === id) result.push({ origin, key: credential.key });
  }
  return result;
}

export function credentialsPath(): string {
  return path.join(credentialStorageHome(), ".config/nexus/credentials.json");
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
}

function readStore(): StoreFile {
  const raw = readJson(credentialsPath());
  return raw && typeof raw === "object" && raw.providers && typeof raw.providers === "object"
    ? { version: 1, providers: raw.providers }
    : { version: 1, providers: {} };
}

/** Atomic, owner-only write: a credential file is never briefly world-readable or half-written. */
function writeStore(store: StoreFile): void {
  const file = credentialsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function saveCredential(providerId: string, credential: StoredCredential): void {
  const store = readStore();
  store.providers[providerId] = credential;
  writeStore(store);
}

/** Removes Nexus's own credential; connections owned by other clients or the environment are untouched. */
export function removeCredential(providerId: string): boolean {
  const store = readStore();
  if (!(providerId in store.providers)) return false;
  delete store.providers[providerId];
  writeStore(store);
  return true;
}

/** Expiry (epoch ms) from a JWT's `exp` claim, without verifying it (advisory only). */
export function jwtExpiry(token: string | undefined): number | undefined {
  const claims = jwtClaims(token);
  return typeof claims?.exp === "number" ? claims.exp * 1000 : undefined;
}

export function jwtClaims(token: string | undefined): Record<string, any> | undefined {
  const part = token?.split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"));
  } catch {
    return undefined;
  }
}

/** ChatGPT account id from ID/access token claims. */
export function chatgptAccountId(...tokens: Array<string | undefined>): string | undefined {
  for (const t of tokens) {
    const c = jwtClaims(t);
    const id = c?.chatgpt_account_id ?? c?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

const now = () => new Date().toISOString();
/** A crush api_key may be a "$VAR" reference rather than a value. */
const literalKey = (v: unknown): string | undefined => (typeof v === "string" && v.trim() && !v.trim().startsWith("$") ? v.trim() : undefined);

/** Names other clients use for Nexus's provider ids. */
const OPENCODE_IDS: Record<string, string[]> = {
  openrouter: ["openrouter"],
  openai: ["openai"],
  anthropic: ["anthropic"],
  chatgpt: ["openai"],
  copilot: ["github-copilot"],
};
const CRUSH_IDS: Record<string, string[]> = { openrouter: ["openrouter"], openai: ["openai"], anthropic: ["anthropic"], chatgpt: ["openai"], copilot: ["copilot"] };

/** Connections registered in other clients for `providerId`, best first. Read-only. */
export function externalCredentials(providerId: string): ResolvedCredential[] {
  const home = credentialStorageHome();
  const out: ResolvedCredential[] = [];
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
    if (!e || typeof e !== "object") continue;
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
    } else if (!oauthWanted && e.type === "api" && literalKey(e.key)) {
      out.push({ source: "opencode", kind: "external", file: ocFile, refreshable: false, credential: { type: "api", key: literalKey(e.key)!, savedAt: now() } });
    }
  }

  const crushFile = path.join(home, ".local/share/crush/crush.json");
  const crush = readJson(crushFile);
  for (const id of CRUSH_IDS[providerId] ?? []) {
    const p = crush?.providers?.[id];
    if (!p || typeof p !== "object") continue;
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
    } else if (!oauthWanted && literalKey(p.api_key)) {
      out.push({ source: "crush", kind: "external", file: crushFile, refreshable: false, credential: { type: "api", key: literalKey(p.api_key)!, savedAt: now() } });
    }
  }

  if (providerId === "copilot") {
    for (const name of ["apps.json", "hosts.json"]) {
      const file = path.join(home, ".config/github-copilot", name);
      const data = readJson(file);
      if (!data || typeof data !== "object") continue;
      const entry = Object.entries(data).find(([k, v]: [string, any]) => (k === "github.com" || k.startsWith("github.com:")) && typeof v?.oauth_token === "string");
      if (entry) {
        const githubToken = (entry[1] as any).oauth_token as string;
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
export function providerApiKey(providerId: string, envVar?: string): string | undefined {
  const r = resolveCredential(providerId, envVar);
  return r?.credential.type === "api" ? r.credential.key : undefined;
}

export function resolveCredential(providerId: string, envVar?: string): ResolvedCredential | undefined {
  const env = envVar ? process.env[envVar]?.trim() : undefined;
  if (env) return { source: `$${envVar}`, kind: "env", refreshable: false, credential: { type: "api", key: env, savedAt: now() } };
  const own = readStore().providers[providerId];
  if (own) return { source: own.label ?? "Nexus", kind: "nexus", refreshable: true, credential: own, file: credentialsPath() };
  return externalCredentials(providerId)[0];
}
