/**
 * Google Application Default Credentials for Vertex AI, read-only, from environment variables and files:
 *   1. GOOGLE_APPLICATION_CREDENTIALS: a service-account JSON key file. An RS256 JWT assertion signed with
 *      `node:crypto` is exchanged at the Google token endpoint for a short-lived bearer token.
 *   2. Otherwise `gcloud auth print-access-token` (spawned without a shell, bounded time and output).
 * Not supported: authorized-user files, workload identity federation and the metadata server.
 *
 * Tokens are cached until shortly before they expire; concurrent callers share one refresh. The private key, the signed
 * assertion and the tokens are never logged or put in an error message: errors name only the variable, the file or the
 * provider's error code.
 */
import { createSign } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
/** A token is refreshed once it has this long (ms) left. */
export const REFRESH_SKEW_MS = 60_000;
/** gcloud does not report an expiry; its tokens last an hour, so a cached one is trusted for half of that. */
const GCLOUD_TOKEN_TTL_MS = 30 * 60_000;
const GCLOUD_TIMEOUT_MS = 15_000;

export class GcpAuthError extends Error {}

export interface TokenOptions {
  env: Record<string, string | undefined>;
  /** Milliseconds since the epoch; tests inject a clock. */
  now?: () => number;
  fetchFn?: typeof fetch;
  readFile?: (file: string) => string;
  /** Runs `gcloud auth print-access-token` and returns its stdout; rejects on failure. */
  runGcloud?: () => Promise<string>;
  tokenUrl?: string;
  /** Bound on the gcloud child (default 15 s). */
  gcloudTimeoutMs?: number;
}

interface ServiceAccountKey { client_email: string; private_key: string; project_id?: string }

const b64url = (v: Buffer | string): string => Buffer.from(v).toString("base64url");
// A bearer token is opaque; this only rejects empty output, whitespace and control characters. Bounded length, linear.
const TOKEN = /^[\x21-\x7e]{20,4096}$/;
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION = /^[a-z0-9-]+$/;

function parseKey(text: string, file: string): ServiceAccountKey {
  let raw: any;
  try { raw = JSON.parse(text); } catch { throw new GcpAuthError(`GOOGLE_APPLICATION_CREDENTIALS (${file}) is not valid JSON`); }
  if (raw?.type !== "service_account") throw new GcpAuthError(`GOOGLE_APPLICATION_CREDENTIALS (${file}) is not a service-account key (only service-account key files are supported)`);
  if (typeof raw.client_email !== "string" || !raw.client_email || typeof raw.private_key !== "string" || !raw.private_key) {
    throw new GcpAuthError(`GOOGLE_APPLICATION_CREDENTIALS (${file}) lacks client_email or private_key`);
  }
  return { client_email: raw.client_email, private_key: raw.private_key, ...(typeof raw.project_id === "string" ? { project_id: raw.project_id } : {}) };
}

function readKeyFile(o: TokenOptions): ServiceAccountKey | undefined {
  const file = o.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!file) return undefined;
  let text: string;
  try { text = (o.readFile ?? ((f) => fs.readFileSync(f, "utf8")))(file); } catch { throw new GcpAuthError(`cannot read GOOGLE_APPLICATION_CREDENTIALS (${file})`); }
  return parseKey(text, file);
}

/** The signed JWT assertion for the jwt-bearer grant. Throws without detail if the key cannot sign. */
export function signAssertion(key: ServiceAccountKey, nowSeconds: number, tokenUrl: string): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope: GOOGLE_SCOPE, aud: tokenUrl, iat: nowSeconds, exp: nowSeconds + 3600 }));
  const input = `${header}.${claims}`;
  try {
    return `${input}.${b64url(createSign("RSA-SHA256").update(input).sign(key.private_key))}`;
  } catch {
    throw new GcpAuthError("the service-account private_key cannot sign (is it an RSA key in PEM form?)");
  }
}

function defaultGcloud(timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gcloud", ["auth", "print-access-token"], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

export class GcpTokenSource {
  private cached: { token: string; expiresAt: number } | undefined;
  private inflight: Promise<string> | undefined;
  private readonly now: () => number;

  constructor(private readonly o: TokenOptions) {
    this.now = o.now ?? Date.now;
  }

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - this.now() > REFRESH_SKEW_MS) return this.cached.token;
    this.inflight ??= this.refresh().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    const key = readKeyFile(this.o);
    const got = key ? await this.exchange(key) : await this.fromGcloud();
    this.cached = got;
    return got.token;
  }

  private async exchange(key: ServiceAccountKey): Promise<{ token: string; expiresAt: number }> {
    const url = this.o.tokenUrl ?? GOOGLE_TOKEN_URL;
    const started = this.now();
    const assertion = signAssertion(key, Math.floor(started / 1000), url);
    let res: Response;
    try {
      res = await (this.o.fetchFn ?? fetch)(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new GcpAuthError("the Google token endpoint could not be reached");
    }
    let body: any;
    try { body = await res.json(); } catch { body = undefined; }
    if (!res.ok) {
      const code = typeof body?.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? ` (${body.error})` : "";
      throw new GcpAuthError(`the Google token endpoint refused the service-account assertion: HTTP ${res.status}${code}`);
    }
    const token = body?.access_token;
    const ttl = Number(body?.expires_in);
    if (typeof token !== "string" || !TOKEN.test(token) || !Number.isFinite(ttl) || ttl <= 0) throw new GcpAuthError("the Google token endpoint returned no usable access token");
    return { token, expiresAt: started + ttl * 1000 };
  }

  private async fromGcloud(): Promise<{ token: string; expiresAt: number }> {
    let out: string;
    try {
      out = await (this.o.runGcloud ? this.o.runGcloud() : defaultGcloud(this.o.gcloudTimeoutMs ?? GCLOUD_TIMEOUT_MS));
    } catch {
      throw new GcpAuthError("no Google credentials: set GOOGLE_APPLICATION_CREDENTIALS to a service-account key file, or sign in with `gcloud auth login` (gcloud auth print-access-token failed)");
    }
    const token = out.trim();
    if (!TOKEN.test(token)) throw new GcpAuthError("gcloud auth print-access-token returned no usable access token");
    return { token, expiresAt: this.now() + GCLOUD_TOKEN_TTL_MS };
  }
}

let shared: GcpTokenSource | undefined;
let override: Partial<TokenOptions> = {};

/** The process-wide source (one cache per credential configuration); tests replace its collaborators. */
export function gcpTokenSource(env: Record<string, string | undefined> = process.env): GcpTokenSource {
  shared ??= new GcpTokenSource({ env, ...override });
  return shared;
}

/** Test seam: replaces the shared source's collaborators and drops its cache. Pass `{}` to restore. */
export function setGcpAdcOverrides(next: Partial<TokenOptions>): void {
  override = next;
  shared = undefined;
}

export interface VertexTarget { project: string; location: string }

/** Project and location for the URL: GOOGLE_CLOUD_PROJECT (else the key file's project_id) and GOOGLE_CLOUD_LOCATION. */
export function resolveVertexTarget(env: Record<string, string | undefined>, readFile?: (file: string) => string): VertexTarget {
  const location = env.GOOGLE_CLOUD_LOCATION?.trim();
  if (!location) throw new GcpAuthError("no Vertex location: set GOOGLE_CLOUD_LOCATION (for example us-central1 or global)");
  if (!LOCATION.test(location)) throw new GcpAuthError("GOOGLE_CLOUD_LOCATION must contain only a-z, 0-9 and '-'");
  const project = env.GOOGLE_CLOUD_PROJECT?.trim() || readKeyFile({ env, ...(readFile ? { readFile } : {}) })?.project_id;
  if (!project) throw new GcpAuthError("no Vertex project: set GOOGLE_CLOUD_PROJECT or use a key file with project_id");
  if (!PROJECT.test(project)) throw new GcpAuthError("the Vertex project id is not valid (6-30 characters of a-z, 0-9 and '-', starting with a letter)");
  return { project, location };
}

/** `https://{location}-aiplatform.googleapis.com`, or `https://aiplatform.googleapis.com` for `global`. Validates the location. */
export function vertexOrigin(location: string): string {
  if (!LOCATION.test(location)) throw new GcpAuthError("GOOGLE_CLOUD_LOCATION must contain only a-z, 0-9 and '-'");
  return location === "global" ? "https://aiplatform.googleapis.com" : `https://${location}-aiplatform.googleapis.com`;
}

/** Turns the Gemini protocol's `/models/<id>:method` into the Vertex publisher-model path. */
export function vertexPath(path: string, target: VertexTarget): string {
  return `/v1/projects/${target.project}/locations/${target.location}/publishers/google${path}`;
}
