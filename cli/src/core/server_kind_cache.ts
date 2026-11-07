import type { ServerKind } from "./provider_capabilities.js";

/** How long a discovered server identity is trusted before it must be re-verified. */
export const SERVER_KIND_TTL_MS = 10 * 60_000;
/** Upper bound on remembered identities; the oldest entry is evicted first. */
export const SERVER_KIND_MAX_ENTRIES = 256;

/**
 * Process-wide record of the server identity learned for a connection. Entries expire, and the caller keys them by
 * provider, endpoint and credential so that a switch of any of the three never inherits another server's identity
 * (REQ-PRV-109: the gateway-only task-class header must not follow a replaced server).
 *
 * Expired entries are swept on every write and the map is bounded, so a long session that rotates credentials does not
 * accumulate stale keys. A refreshed OAuth token changes the credential digest and therefore the key: the identity is
 * simply re-discovered at the next capability read.
 *
 * Policy: an identity (including a gateway's) is kept through an unreadable catalog (5xx, dropped connection) until
 * its TTL ends, because an outage is not evidence the server was replaced; a 404 or unlisted model drops a gateway.
 */
export class ServerKindCache {
  private readonly entries = new Map<string, { kind: ServerKind; expires: number }>();

  constructor(private readonly ttlMs: number = SERVER_KIND_TTL_MS, private readonly now: () => number = () => Date.now(), private readonly max: number = SERVER_KIND_MAX_ENTRIES) {}

  get(key: string): ServerKind | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.kind;
  }

  set(key: string, kind: ServerKind): void {
    const now = this.now();
    for (const [k, entry] of this.entries) if (entry.expires <= now) this.entries.delete(k);
    this.entries.delete(key);
    while (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value as string);
    this.entries.set(key, { kind, expires: now + this.ttlMs });
  }

  get size(): number {
    return this.entries.size;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
