/** Serialize rotating Nexus-owned OAuth refreshes across callers and processes. */
import { acquireFileGuard, releaseFileGuard, type FileGuard } from "./core/file_guard.js";
import { credentialsPath, resolveCredential, saveCredential, type StoredCredential } from "./credentials.js";
import { refreshOAuth } from "./oauth.js";

type OAuthCredential = Extract<StoredCredential, { type: "oauth" }>;

const DEFAULT_WAIT_MS = 10_000;
const inProcess = new Map<string, Promise<OAuthCredential>>();

export interface SharedRefreshDeps {
  refresh?: (providerId: string, credential: OAuthCredential) => Promise<StoredCredential>;
  readStored?: (providerId: string) => StoredCredential | undefined;
  save?: (providerId: string, credential: OAuthCredential) => void;
  guardPath?: string;
  waitMs?: number;
  now?: () => number;
}

/**
 * Refresh a sign-in after re-reading the Nexus-owned credential under a process-shared lock. A new, unexpired
 * credential published by another process wins. If the lock cannot be acquired, fail closed: sending the same
 * rotating refresh token concurrently can invalidate both callers' credentials.
 */
export function refreshStoredSignIn(
  providerId: string,
  credential: OAuthCredential,
  staleAccess: string | undefined,
  deps: SharedRefreshDeps = {},
): Promise<OAuthCredential> {
  const key = `${credentialsPath()}\u0000${providerId}\u0000${credential.refresh ?? ""}`;
  const existing = inProcess.get(key);
  if (existing) return existing;

  const pending = refreshUnderGuard(providerId, credential, staleAccess, deps)
    .finally(() => { if (inProcess.get(key) === pending) inProcess.delete(key); });
  inProcess.set(key, pending);
  return pending;
}

async function refreshUnderGuard(
  providerId: string,
  credential: OAuthCredential,
  staleAccess: string | undefined,
  deps: SharedRefreshDeps,
): Promise<OAuthCredential> {
  const guardPath = deps.guardPath ?? `${credentialsPath()}.refresh.lock`;
  const guard: FileGuard | null = acquireFileGuard(guardPath, {
    label: "OAuth refresh guard",
    waitMs: deps.waitMs ?? DEFAULT_WAIT_MS,
  });
  if (!guard) throw new Error("The sign-in is being refreshed by another Nexus process; retry after it finishes.");

  try {
    const now = deps.now ?? Date.now;
    const readStored = deps.readStored ?? ((id: string) => {
      const resolved = resolveCredential(id);
      return resolved?.kind === "nexus" ? resolved.credential : undefined;
    });
    const latest = readStored(providerId);
    if (latest?.type === "oauth" && latest.access && latest.access !== staleAccess
      && (latest.expiresAt === undefined || latest.expiresAt - now() > 60_000)) {
      return latest;
    }

    const source = latest?.type === "oauth" && latest.refresh ? latest : credential;
    const refreshed = await (deps.refresh ?? refreshOAuth)(providerId, source);
    if (refreshed.type !== "oauth" || !refreshed.access) throw new Error("The provider returned an invalid refreshed sign-in.");
    (deps.save ?? saveCredential)(providerId, refreshed);
    return refreshed;
  } finally {
    releaseFileGuard(guard);
  }
}
