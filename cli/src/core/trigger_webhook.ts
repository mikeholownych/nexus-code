/**
 * BG-3: the webhook listener. Off unless the runner is started with a webhook port AND an approved webhook trigger
 * exists; it binds loopback unless the operator asks for more and authentication is configured.
 *
 * A delivery is `POST /hook/<workspace key>/<trigger id>` with three headers:
 *   X-Nexus-Timestamp  seconds since the epoch; more than 5 minutes from now (or before the listener started) is refused
 *   X-Nexus-Delivery   a unique id of 8..64 characters of [A-Za-z0-9_.-]; one id is accepted once
 *   X-Nexus-Signature  sha256=<hex>, the HMAC-SHA256 of `<timestamp>.<delivery>.<raw body>` under the trigger's secret
 * The order of the checks is the design (docs/TRIGGERS.md):
 *   1. before any body is read: the Host header is a loopback name (DNS rebinding), a route and an approved trigger
 *      exist, an Origin header is only accepted if the spec lists it, the declared size is within the cap;
 *   2. the body is read raw up to the cap, under header and request timeouts, then the signature is checked in
 *      constant time (against a dummy key when there is no such trigger, so the work does not tell);
 *   3. only then the delivery id is recorded (a replay is refused here) and `onDelivery` runs: the rate limiter and
 *      everything after it. A caller that cannot sign never reaches the limiter, so it cannot spend a trigger's budget.
 * Everything refused before step 3 gets the same status and body, so a caller cannot tell which check failed.
 * Nothing in the body is parsed here: the firer passes a capped, escaped preview to the job as data.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_HEADER_BYTES = 8 * 1024;
export const MAX_CONNECTIONS = 32;
export const SKEW_SECONDS = 300;
export const REPLAY_MAX = 4096;
export const REPLAY_TTL_MS = 2 * SKEW_SECONDS * 1000;
const REFUSED = JSON.stringify({ error: "refused" });
const ROUTE = /^\/hook\/([0-9a-f]{12})\/([a-z0-9][a-z0-9-]{0,62})$/;
const DELIVERY = /^[A-Za-z0-9][A-Za-z0-9_.-]{7,63}$/;
const SIGNATURE = /^sha256=([0-9a-f]{64})$/;

export const isLoopbackAddress = (host: string): boolean => /^127(?:\.\d{1,3}){3}$/.test(host) || host === "::1" || host === "localhost";

/** What the firer knows about one approved webhook trigger. */
export interface WebhookTarget {
  secret: Buffer;
  /** Origins the spec lists; an `Origin` header outside them is refused. */
  allowedOrigins: readonly string[];
}

export interface WebhookDelivery {
  workspaceKey: string;
  id: string;
  deliveryId: string;
  /** The raw body, at most `MAX_BODY_BYTES`. */
  body: Buffer;
}

/** What an authenticated caller is told. `reason` is a short code from a fixed set. */
export type WebhookOutcome = { accepted: true } | { accepted: false; reason: "rate-limited" | "quarantined" | "busy" | "refused" };

export interface WebhookOptions {
  host: string;
  port: number;
  allowNonLoopback?: boolean;
  /** Whether any approved webhook trigger has a secret: a non-loopback bind is refused without one. */
  hasAuthentication: () => boolean;
  lookup: (workspaceKey: string, id: string) => WebhookTarget | undefined;
  onDelivery: (delivery: WebhookDelivery, nowMs: number) => WebhookOutcome;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  maxConnections?: number;
  now?: () => number;
}

/** Delivery ids seen in the last `ttlMs`, bounded. Full means refuse: a new id is never admitted by forgetting an old one. */
export class ReplayCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly max: number = REPLAY_MAX, private readonly ttlMs: number = REPLAY_TTL_MS) {}

  admit(key: string, nowMs: number): boolean {
    for (const [oldKey, expires] of this.seen) {
      if (expires > nowMs) break;
      this.seen.delete(oldKey);
    }
    if (this.seen.has(key) || this.seen.size >= this.max) return false;
    this.seen.set(key, nowMs + this.ttlMs);
    return true;
  }

  size(): number {
    return this.seen.size;
  }
}

export class WebhookListener {
  private server: http.Server | undefined;
  private readonly replay = new ReplayCache();
  private readonly dummy = randomBytes(32);
  private startedAtSeconds = 0;
  private hostNames = new Set<string>();

  constructor(private readonly options: WebhookOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Opens the listener. Rejects (and opens nothing) when the bind is not allowed. */
  async start(): Promise<{ host: string; port: number }> {
    const { port } = this.options;
    const host = this.options.host === "localhost" ? "127.0.0.1" : this.options.host;
    if (!isLoopbackAddress(host)) {
      if (this.options.allowNonLoopback !== true) throw new Error(`the webhook listener binds loopback only; ${host} needs the explicit non-loopback flag`);
      if (!this.options.hasAuthentication()) throw new Error(`the webhook listener refuses to bind ${host}: no approved webhook trigger has a secret configured`);
    }
    const requestTimeout = this.options.requestTimeoutMs ?? 10_000;
    const server = http.createServer({
      maxHeaderSize: MAX_HEADER_BYTES,
      requestTimeout,
      headersTimeout: Math.min(requestTimeout, 5_000),
      keepAliveTimeout: 1_000,
      connectionsCheckingInterval: Math.max(50, Math.min(1_000, Math.floor(requestTimeout / 2))),
    }, (req, res) => this.handle(req, res));
    server.maxConnections = this.options.maxConnections ?? MAX_CONNECTIONS;
    server.maxRequestsPerSocket = 1;
    server.on("clientError", (_error, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      else socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port, exclusive: true }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.startedAtSeconds = Math.floor(this.now() / 1000);
    const address = server.address() as AddressInfo;
    this.hostNames = new Set(["127.0.0.1", "localhost", "[::1]", ...(isLoopbackAddress(host) ? [] : [host.toLowerCase()])]);
    this.boundPort = address.port;
    return { host, port: address.port };
  }

  private boundPort = 0;

  get listening(): boolean {
    return this.server?.listening === true;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private hostAllowed(header: unknown): boolean {
    if (typeof header !== "string" || header.length > 255) return false;
    const match = /^(\[[0-9a-f:]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(header);
    if (!match) return false;
    if (match[2] !== undefined && Number(match[2]) !== this.boundPort) return false;
    return this.hostNames.has(match[1]!.toLowerCase());
  }

  private send(res: http.ServerResponse, status: number, body: string): void {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close", "cache-control": "no-store" });
    res.end(body);
    res.once("finish", () => res.socket?.destroy());
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const refuse = () => this.send(res, 401, REFUSED);
    const route = ROUTE.exec(req.url ?? "");
    if (req.method !== "POST" || !route || !this.hostAllowed(req.headers.host)) return refuse();
    const target = this.options.lookup(route[1]!, route[2]!);
    const origin = req.headers.origin;
    if (origin !== undefined && !(typeof origin === "string" && target?.allowedOrigins.some((allowed) => allowed.toLowerCase() === origin.toLowerCase()))) return refuse();
    const max = this.options.maxBodyBytes ?? MAX_BODY_BYTES;
    const declared = req.headers["content-length"];
    if (declared !== undefined) {
      if (typeof declared !== "string" || !/^\d{1,9}$/.test(declared)) return refuse();
      if (Number(declared) > max) return this.send(res, 413, JSON.stringify({ error: "too large" }));
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > max) {
        over = true;
        chunks.length = 0;
        this.send(res, 413, JSON.stringify({ error: "too large" }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => res.socket?.destroy());
    req.on("end", () => {
      if (over) return;
      try {
        this.authenticated(req, res, route[1]!, route[2]!, target, Buffer.concat(chunks), refuse);
      } catch {
        this.send(res, 500, JSON.stringify({ error: "failed" }));
      }
    });
  }

  private authenticated(req: http.IncomingMessage, res: http.ServerResponse, workspaceKey: string, id: string, target: WebhookTarget | undefined, body: Buffer, refuse: () => void): void {
    const header = (name: string): string | undefined => (typeof req.headers[name] === "string" ? (req.headers[name] as string) : undefined);
    const timestamp = header("x-nexus-timestamp") ?? "";
    const delivery = header("x-nexus-delivery") ?? "";
    const signature = SIGNATURE.exec(header("x-nexus-signature") ?? "")?.[1];
    const nowMs = this.now();
    const seconds = /^\d{9,11}$/.test(timestamp) ? Number(timestamp) : undefined;
    const fresh = seconds !== undefined && Math.abs(nowMs / 1000 - seconds) <= SKEW_SECONDS && seconds >= this.startedAtSeconds;
    // The work is the same whatever failed: an HMAC is always computed, against a dummy key when there is no trigger.
    const mac = createHmac("sha256", target?.secret ?? this.dummy).update(`${timestamp}.${delivery}.`).update(body).digest();
    const given = Buffer.from(signature ?? "0".repeat(64), "hex");
    const signed = timingSafeEqual(mac, given) && signature !== undefined;
    if (!(target !== undefined && signed && fresh && DELIVERY.test(delivery))) return refuse();
    // Authenticated. A replay is refused before it can touch the limiter.
    if (!this.replay.admit(`${workspaceKey}/${id}/${delivery}`, nowMs)) return refuse();
    const outcome = this.options.onDelivery({ workspaceKey, id, deliveryId: delivery, body }, nowMs);
    if (outcome.accepted) this.send(res, 202, JSON.stringify({ status: "accepted" }));
    else this.send(res, 429, JSON.stringify({ status: "not-started", reason: outcome.reason }));
  }
}
