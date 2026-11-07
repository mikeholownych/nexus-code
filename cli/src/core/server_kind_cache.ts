import type { ServerKind } from "./provider_capabilities.js";

/** How long a discovered server identity is trusted before it must be re-verified. */
export const SERVER_KIND_TTL_MS = 10 * 60_000;

/**
 * Process-wide record of the server identity learned for a connection. Entries expire, and the caller keys them by
 * provider, endpoint and credential so that a switch of any of the three never inherits another server's identity
 * (REQ-PRV-109: the gateway-only task-class header must not follow a replaced server).
 */
export class ServerKindCache {
  private readonly entries = new Map<string, { kind: ServerKind; expires: number }>();

  constructor(private readonly ttlMs: number = SERVER_KIND_TTL_MS, private readonly now: () => number = Date.now) {}

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
    this.entries.set(key, { kind, expires: this.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
