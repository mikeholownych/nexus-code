import { spawn, spawnSync, ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import * as dns from "node:dns";
import { URL, fileURLToPath } from "node:url";
import { ToolDefinition, ExecutionResult } from "./types.js";
import { SecurityManager } from "./security.js";
import { InformationFlowBoundary, matchesLocalOrigins, parseLocalOrigins } from "./core/egress.js";
import { htmlToReadableText } from "./core/html_text.js";
import { CapabilityRegistry, HARNESS_TOOLS, defaultRegistry } from "./core/capabilities.js";
import { isSafeReadOnlyCommand } from "./core/authority.js";
import { getBuildIdentity } from "./build_identity.js";
export { HARNESS_TOOLS, defaultRegistry };

/** JSON-RPC protocol version spoken between the CLI and harness-core (REQ-REL-103). */
export const CORE_PROTOCOL_VERSION = 1;

/** Rust engine binaries the bridge looks for, in order (release before debug). */
export function coreBinaryCandidates(): string[] {
  const packagedCoreDir = process.env.NEXUS_HOME ? path.join(process.env.NEXUS_HOME, "lib", "core") : undefined;
  return [
    ...(packagedCoreDir ? [path.join(packagedCoreDir, "harness-core")] : []),
    path.resolve(__dirname, "../../core/target/release/harness-core"),
    path.resolve(__dirname, "../../core/target/debug/harness-core"),
    path.resolve(__dirname, "../../core/target/release/harness-core.exe"),
    path.resolve(__dirname, "../../core/target/debug/harness-core.exe"),
  ];
}

/** The engine binary the bridge would run, or undefined when it falls back to `cargo run`. */
export function resolveCoreBinary(): string | undefined {
  return coreBinaryCandidates().find((candidate) => fs.existsSync(candidate));
}

/** Cargo manifest the bridge's `cargo run` fallback builds. */
export function coreCargoManifest(): string {
  if (process.env.NEXUS_HOME) return path.resolve(process.env.NEXUS_HOME, "lib", "core", "Cargo.toml");
  return path.resolve(__dirname, "../../core/Cargo.toml");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


/**
 * Why deleting `target` is refused, or null: the workspace root itself, and `.git` or anything inside it. The Rust
 * engine enforces the same rule; checking here denies the call before it is dispatched (or offered for approval).
 */
export function forbiddenDeletion(workspace: string, target: string): string | null {
  const p = target.trim();
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, p);
  if (!p || resolved === root) return "Security Violation: Cannot delete workspace root directory";
  if (path.relative(root, resolved).split(/[\\/]/).includes(".git")) return "Security Violation: Cannot delete .git or anything inside it";
  return null;
}

/**
 * Parses and expands a standard IPv6 string into a 128-bit BigInt value.
 */
function parseIPv6ToBigInt(ip: string): bigint | null {
  const zoneIndex = ip.indexOf("%");
  const cleanIp = (zoneIndex >= 0 ? ip.slice(0, zoneIndex) : ip).toLowerCase();

  let v4Suffix: string | null = null;
  let baseIp = cleanIp;
  const lastColon = cleanIp.lastIndexOf(":");
  if (lastColon >= 0) {
    const after = cleanIp.slice(lastColon + 1);
    if (after.includes(".")) {
      v4Suffix = after;
      baseIp = cleanIp.slice(0, lastColon);
    }
  }

  let groups: string[];
  if (baseIp.includes("::")) {
    const halves = baseIp.split("::");
    if (halves.length !== 2) return null;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const needed = (v4Suffix ? 6 : 8) - (left.length + right.length);
    if (needed < 0) return null;
    groups = [...left, ...Array(needed).fill("0"), ...right];
  } else {
    groups = baseIp.split(":");
  }

  if (v4Suffix) {
    if (groups.length !== 6) return null;
    const v4Parts = v4Suffix.split(".").map((x) => parseInt(x, 10));
    if (v4Parts.length !== 4 || v4Parts.some((n) => isNaN(n) || n < 0 || n > 255)) return null;
    const g6 = ((v4Parts[0] << 8) | v4Parts[1]).toString(16);
    const g7 = ((v4Parts[2] << 8) | v4Parts[3]).toString(16);
    groups.push(g6, g7);
  }

  if (groups.length !== 8) return null;

  let value = 0n;
  for (const g of groups) {
    const num = parseInt(g, 16);
    if (isNaN(num) || num < 0 || num > 0xffff) return null;
    value = (value << 16n) | BigInt(num);
  }
  return value;
}

/**
 * Validates whether an IP address (IPv4 or IPv6) is a globally reachable public IP.
 * Rejects loopback, private networks, CGNAT, link-local, ULA, multicast, and reserved ranges.
 */
export function isPublicIp(ip: string): boolean {
  let clean = ip.trim();
  if (clean.startsWith("[") && clean.endsWith("]")) {
    clean = clean.slice(1, -1);
  }
  const v4 = net.isIP(clean) === 4;
  const v6 = net.isIP(clean) === 6;
  if (!v4 && !v6) return false;

  if (v4) {
    const parts = clean.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => isNaN(n) || n < 0 || n > 255)) return false;
    const [a, b, c] = parts;
    // 0.0.0.0/8 (Broadcast/This host - RFC 1122)
    if (a === 0) return false;
    // 10.0.0.0/8 (RFC 1918)
    if (a === 10) return false;
    // 100.64.0.0/10 (CGNAT / Shared Address Space RFC 6598)
    if (a === 100 && b >= 64 && b <= 127) return false;
    // 127.0.0.0/8 (Loopback RFC 1122)
    if (a === 127) return false;
    // 169.254.0.0/16 (Link-local RFC 3927)
    if (a === 169 && b === 254) return false;
    // 172.16.0.0/12 (RFC 1918)
    if (a === 172 && b >= 16 && b <= 31) return false;
    // 192.0.0.0/24 (IETF Protocol Assignments RFC 6890)
    if (a === 192 && b === 0 && c === 0) return false;
    // 192.0.2.0/24 (TEST-NET-1 RFC 5737)
    if (a === 192 && b === 0 && c === 2) return false;
    // 192.88.99.0/24 (6to4 Relay Anycast RFC 7526)
    if (a === 192 && b === 88 && c === 99) return false;
    // 192.168.0.0/16 (RFC 1918)
    if (a === 192 && b === 168) return false;
    // 198.18.0.0/15 (Benchmarking RFC 2544)
    if (a === 198 && (b === 18 || b === 19)) return false;
    // 198.51.100.0/24 (TEST-NET-2 RFC 5737)
    if (a === 198 && b === 51 && c === 100) return false;
    // 203.0.113.0/24 (TEST-NET-3 RFC 5737)
    if (a === 203 && b === 0 && c === 113) return false;
    // 224.0.0.0/4 (Multicast RFC 5771) and 240.0.0.0/4 (Reserved RFC 1112)
    if (a >= 224) return false;
    return true;
  }

  // IPv6
  const v6Big = parseIPv6ToBigInt(clean);
  if (v6Big === null) return false;

  // Unspecified :: (0)
  if (v6Big === 0n) return false;
  // Loopback ::1 (1)
  if (v6Big === 1n) return false;

  // IPv4-mapped address: ::ffff:0:0/96 (top 80 bits zero, next 16 bits 0xffff)
  if ((v6Big >> 32n) === 0xffffn) {
    const lower = Number(v6Big & 0xffffffffn);
    const a = (lower >>> 24) & 0xff;
    const b = (lower >>> 16) & 0xff;
    const c = (lower >>> 8) & 0xff;
    const d = lower & 0xff;
    return isPublicIp(`${a}.${b}.${c}.${d}`);
  }

  // IPv4-compatible (::/96, deprecated) and IPv4-translated (::ffff:0:0/96) forms embed an
  // IPv4 address in the low 32 bits. They are reserved/deprecated rather than globally
  // reachable, and some stacks map them to the embedded address; classify by the embedded
  // IPv4 address instead of treating the whole prefix as public.
  if ((v6Big >> 32n) === 0n || (v6Big >> 32n) === 0xffff0000n) {
    const lower = Number(v6Big & 0xffffffffn);
    const a = (lower >>> 24) & 0xff;
    const b = (lower >>> 16) & 0xff;
    const c = (lower >>> 8) & 0xff;
    const d = lower & 0xff;
    return isPublicIp(`${a}.${b}.${c}.${d}`);
  }

  // NAT64 well-known prefix: 64:ff9b::/96 (RFC 6052) embeds the IPv4 destination in the
  // low 32 bits. On an IPv6-only/NAT64 network the prefix reaches that IPv4 host, so a
  // loopback/private embedded address is an SSRF target, not public IPv6 space.
  if ((v6Big >> 32n) === 0x0064ff9b0000000000000000n) {
    const lower = Number(v6Big & 0xffffffffn);
    const a = (lower >>> 24) & 0xff;
    const b = (lower >>> 16) & 0xff;
    const c = (lower >>> 8) & 0xff;
    const d = lower & 0xff;
    return isPublicIp(`${a}.${b}.${c}.${d}`);
  }

  // NAT64 local-use prefix: 64:ff9b:1::/48 (RFC 8215) is never globally reachable.
  if ((v6Big >> 80n) === 0x0064ff9b0001n) return false;

  // IPv6 ULA: fc00::/7 (first 7 bits 0x7e -> fc00:: to fdff:ffff:...)
  if ((v6Big >> 121n) === 0x7en) return false;

  // IPv6 link-local: fe80::/10 (first 10 bits 0x3fa -> fe80:: to febf:ffff:...)
  if ((v6Big >> 118n) === 0x3fan) return false;

  // IPv6 multicast: ff00::/8 (first 8 bits 0xff)
  if ((v6Big >> 120n) === 0xffn) return false;

  // Discard prefix: 100::/64
  if ((v6Big >> 64n) === 0x0100000000000000n) return false;

  // Documentation: 2001:db8::/32 (first 32 bits 0x20010db8)
  if ((v6Big >> 96n) === 0x20010db8n) return false;

  // 6to4: 2002::/16 -> check encapsulated IPv4
  if ((v6Big >> 112n) === 0x2002n) {
    const v4Val = Number((v6Big >> 80n) & 0xffffffffn);
    const a = (v4Val >>> 24) & 0xff;
    const b = (v4Val >>> 16) & 0xff;
    const c = (v4Val >>> 8) & 0xff;
    const d = v4Val & 0xff;
    return isPublicIp(`${a}.${b}.${c}.${d}`);
  }

  return true;
}

export function isSafeOutboundUrl(urlStr: string): { safe: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { safe: false, reason: "Invalid URL format" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { safe: false, reason: `Blocked protocol '${parsed.protocol}'. Only http and https are permitted.` };
  }

  let hostname = parsed.hostname.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }

  const allowedOrigins = parseLocalOrigins(process.env.NEXUS_LOCAL_ORIGINS);
  if (matchesLocalOrigins(hostname, parsed.origin, allowedOrigins)) {
    return { safe: true };
  }

  // Cloud metadata & special internal domains
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "metadata.google.internal"
  ) {
    return { safe: false, reason: "SSRF Guard: Access to local/internal domains is blocked." };
  }

  // IPv4 check
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map(Number);
    if (octets.some((o) => o > 255)) {
      return { safe: false, reason: "Invalid IP address" };
    }
    const [a, b] = octets;
    if (a === 127) {
      return { safe: false, reason: "SSRF Guard: Loopback access (127.0.0.0/8) is blocked." };
    }
    if (a === 169 && b === 254) {
      return { safe: false, reason: "SSRF Guard: Cloud metadata / Link-local address (169.254.0.0/16) is blocked." };
    }
    if (a === 10) {
      return { safe: false, reason: "SSRF Guard: Private network address (10.0.0.0/8) is blocked." };
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return { safe: false, reason: "SSRF Guard: Private network address (172.16.0.0/12) is blocked." };
    }
    if (a === 192 && b === 168) {
      return { safe: false, reason: "SSRF Guard: Private network address (192.168.0.0/16) is blocked." };
    }
    if (a === 0) {
      return { safe: false, reason: "SSRF Guard: Zero network address (0.0.0.0/8) is blocked." };
    }
    if (a === 100 && b >= 64 && b <= 127) {
      return { safe: false, reason: "SSRF Guard: CGNAT shared address (100.64.0.0/10) is blocked." };
    }
    if (!isPublicIp(hostname)) {
      return { safe: false, reason: `SSRF Guard: Non-public address ${hostname} is blocked.` };
    }
  }

  // IPv6 check
  if (net.isIP(hostname) === 6) {
    if (hostname === "::1") {
      return { safe: false, reason: "SSRF Guard: IPv6 loopback (::1) is blocked." };
    }
    if (!isPublicIp(hostname)) {
      return { safe: false, reason: `SSRF Guard: Non-public address ${hostname} is blocked.` };
    }
  }

  return { safe: true };
}

export interface SafeFetchOptions {
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  localOrigins?: readonly string[];
  dnsLookup?: (hostname: string, options: any) => Promise<Array<{ address: string; family: number }>>;
}

export interface SafeFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: http.IncomingHttpHeaders;
  text: string;
  finalUrl: string;
  truncated: boolean;
}

/**
 * SSRF-safe HTTP/HTTPS fetch (REQ-SEC-112).
 * Resolves host via DNS, refuses non-public addresses, pins the resolved address for connection,
 * executes manual redirects up to maxRedirects checking IP safety on every hop,
 * and streams the body up to maxBytes (default 5 MB) aborting early to prevent unbounded memory growth.
 */
export async function safeFetch(
  targetUrl: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResponse> {
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 15000;
  const allowedOrigins =
    options.localOrigins ?? parseLocalOrigins(process.env.NEXUS_LOCAL_ORIGINS);

  let currentUrl = targetUrl;
  let redirectCount = 0;
  const reqHeaders: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (compatible; NexusCode/1.0)",
    ...(options.headers || {}),
  };

  while (true) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      throw new Error(`Invalid URL format: '${currentUrl}'`);
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `Blocked protocol '${parsed.protocol}'. Only http and https are permitted.`
      );
    }

    let host = parsed.hostname.toLowerCase();
    if (host.startsWith("[") && host.endsWith("]")) {
      host = host.slice(1, -1);
    }

    const isExplicitlyAllowed = matchesLocalOrigins(host, parsed.origin, allowedOrigins);

    if (!isExplicitlyAllowed) {
      if (
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local") ||
        host.endsWith(".internal") ||
        host === "metadata.google.internal"
      ) {
        throw new Error("SSRF Guard: Access to local/internal domains is blocked.");
      }
    }

    let resolved: Array<{ address: string; family: number }> = [];
    if (net.isIP(host)) {
      resolved = [{ address: host, family: net.isIP(host) }];
    } else {
      const lookupFn = options.dnsLookup ?? dns.promises.lookup;
      try {
        const res = await lookupFn(host, { all: true });
        resolved = Array.isArray(res) ? res : [res];
      } catch (err: any) {
        throw new Error(`DNS lookup failed for '${host}': ${err.message}`);
      }
    }

    if (!resolved.length) {
      throw new Error(`DNS resolution returned no addresses for '${host}'`);
    }

    for (const addr of resolved) {
      if (!isPublicIp(addr.address)) {
        const addrAllowed =
          isExplicitlyAllowed ||
          matchesLocalOrigins(addr.address, parsed.origin, allowedOrigins);
        if (!addrAllowed) {
          throw new Error(`SSRF Guard: Non-public address ${addr.address} is blocked.`);
        }
      }
    }

    const pinnedAddr = resolved[0].address;
    const pinnedFamily = resolved[0].family;

    // Connect over a socket we create ourselves, pinned to the validated address. Passing a
    // `lookup` callback to http(s).request instead lets Node emit some connect failures
    // (ENETUNREACH, EINVAL) on the socket before the request has attached its error listener,
    // which surfaces as an unhandled 'error' event and terminates the whole process.
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    const createConnection = () => {
      if (parsed.protocol === "https:") {
        return tls.connect({
          host: pinnedAddr,
          port,
          ...(net.isIP(host) ? {} : { servername: host }),
        });
      }
      return net.connect({ host: pinnedAddr, port, family: pinnedFamily });
    };

    const reqOptions: http.RequestOptions = {
      method: "GET",
      hostname: parsed.hostname,
      port,
      path: parsed.pathname + parsed.search,
      headers: {
        ...reqHeaders,
        Host: parsed.host,
      },
      createConnection,
    };

    const res: http.IncomingMessage = await new Promise((resolve, reject) => {
      const transport = parsed.protocol === "https:" ? https : http;
      const req = transport.request(reqOptions, resolve);
      req.on("error", reject);
      const timer = setTimeout(() => {
        req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      req.on("close", () => clearTimeout(timer));
      req.end();
    });

    const status = res.statusCode || 0;
    if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
      res.destroy();
      redirectCount++;
      if (redirectCount > maxRedirects) {
        throw new Error(`Too many redirects (maximum ${maxRedirects})`);
      }
      const nextUrl = new URL(res.headers.location, currentUrl).toString();
      if (new URL(nextUrl).origin !== parsed.origin) {
        if (reqHeaders.authorization) delete reqHeaders.authorization;
        if (reqHeaders.cookie) delete reqHeaders.cookie;
      }
      currentUrl = nextUrl;
      continue;
    }

    let bytesRead = 0;
    let truncated = false;
    const chunks: Buffer[] = [];
    for await (const chunk of res) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytesRead + buf.length > maxBytes) {
        const remaining = maxBytes - bytesRead;
        if (remaining > 0) {
          chunks.push(buf.subarray(0, remaining));
          bytesRead += remaining;
        }
        truncated = true;
        res.destroy();
        break;
      }
      chunks.push(buf);
      bytesRead += buf.length;
    }

    const bodyText = Buffer.concat(chunks, bytesRead).toString("utf-8");
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: res.statusMessage || "",
      headers: res.headers,
      text: bodyText,
      finalUrl: currentUrl,
      truncated,
    };
  }
}

/** Default `run_command` deadline in the Rust runner (seconds); mirrored here so the bridge can outlast it. */
export const RUN_COMMAND_DEFAULT_TIMEOUT_SECS = 60;
/** Extra time the bridge waits beyond the runner's own deadline (kill grace + reply), so the runner's structured result wins. */
export const RPC_GRACE_SECS = 5;
const RPC_DEFAULT_TIMEOUT_MS = 35_000;

/** Maximum allowed tool timeout in seconds per REQ-SEC-107 (default 1800). */
export function maxToolTimeoutSecs(): number {
  const env = process.env.NEXUS_MAX_TOOL_TIMEOUT_SECS;
  if (!env) return 1800;
  const parsed = parseInt(env, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1800;
}

/**
 * Deadline ownership for one RPC. For `run_command` the runner owns the command deadline (`runnerSecs`) and the bridge's
 * outer timer is strictly longer; for other tools only the bridge timer applies.
 */
export function rpcDeadlines(toolName: string, args: Record<string, any>): { runnerSecs?: number; bridgeMs: number } {
  if (toolName === "run_command") {
    const rawSecs = typeof args.timeout_secs === "number" && args.timeout_secs > 0 ? args.timeout_secs : RUN_COMMAND_DEFAULT_TIMEOUT_SECS;
    const maxSecs = maxToolTimeoutSecs();
    const runnerSecs = Math.min(rawSecs, maxSecs);
    return { runnerSecs, bridgeMs: (runnerSecs + RPC_GRACE_SECS) * 1000 };
  }
  return { bridgeMs: args.timeout_secs ? (args.timeout_secs + RPC_GRACE_SECS) * 1000 : RPC_DEFAULT_TIMEOUT_MS };
}

const READ_ONLY_COMMAND_MAX_OUTPUT_BYTES = 32_000;
const READ_ONLY_COMMAND_KILL_GRACE_MS = 500;

class BoundedCommandOutput {
  private static readonly HALF = READ_ONLY_COMMAND_MAX_OUTPUT_BYTES / 2;
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private totalBytes = 0;

  public push(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    let rest = chunk;
    if (this.headBytes < BoundedCommandOutput.HALF) {
      const take = Math.min(rest.length, BoundedCommandOutput.HALF - this.headBytes);
      if (take) this.head.push(Buffer.from(rest.subarray(0, take)));
      this.headBytes += take;
      rest = rest.subarray(take);
    }
    if (rest.length >= BoundedCommandOutput.HALF) {
      this.tail = [Buffer.from(rest.subarray(rest.length - BoundedCommandOutput.HALF))];
      this.tailBytes = BoundedCommandOutput.HALF;
      return;
    }
    if (rest.length) {
      this.tail.push(Buffer.from(rest));
      this.tailBytes += rest.length;
      while (this.tailBytes > BoundedCommandOutput.HALF) {
        const overflow = this.tailBytes - BoundedCommandOutput.HALF;
        const first = this.tail[0];
        if (first.length <= overflow) {
          this.tail.shift();
          this.tailBytes -= first.length;
        } else {
          this.tail[0] = Buffer.from(first.subarray(overflow));
          this.tailBytes -= overflow;
        }
      }
    }
  }

  public render(): string {
    const head = Buffer.concat(this.head);
    const tail = Buffer.concat(this.tail);
    if (this.totalBytes <= READ_ONLY_COMMAND_MAX_OUTPUT_BYTES) {
      return Buffer.concat([head, tail]).toString("utf8");
    }
    const omittedBytes = Math.max(0, this.totalBytes - head.length - tail.length);
    return `${head.toString("utf8")}\n\n... [TRUNCATED ${omittedBytes} BYTES] ...\n\n${tail.toString("utf8")}`;
  }
}

/** Run the already-confined Bubblewrap command without blocking the agent event loop. */
function runReadOnlySandbox(
  command: string,
  args: string[],
  workspaceFd: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ExecutionResult> {
  if (signal?.aborted) {
    return Promise.resolve({ success: false, output: "", error: "Read-only command cancelled before it started.", cancelled: true });
  }

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: "/",
        detached: process.platform !== "win32",
        // Do not let a read-only command recover the agent's credentials or runtime
        // configuration through /proc/self/environ after a workspace-entry race.
        env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
        stdio: ["ignore", "pipe", "pipe", workspaceFd],
      });
    } catch (err: any) {
      resolve({ success: false, output: "", error: `Failed to execute read-only command: ${err?.message ?? String(err)}` });
      return;
    }

    const stdout = new BoundedCommandOutput();
    const stderr = new BoundedCommandOutput();
    let termination: "timeout" | "cancelled" | undefined;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const forceStop = (reason: "timeout" | "cancelled") => {
      if (termination) return;
      termination = reason;
      const signalSandbox = (signalName: NodeJS.Signals) => {
        if (process.platform !== "win32" && child.pid !== undefined) {
          try {
            process.kill(-child.pid, signalName);
          } catch (err: any) {
            if (err?.code !== "ESRCH") child.kill(signalName);
          }
        } else {
          child.kill(signalName);
        }
      };
      signalSandbox("SIGTERM");
      killTimer = setTimeout(() => signalSandbox("SIGKILL"), READ_ONLY_COMMAND_KILL_GRACE_MS);
    };
    const timer = setTimeout(() => forceStop("timeout"), timeoutMs);
    const onAbort = () => forceStop("cancelled");
    const finish = (result: { code: number | null; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      const output = stdout.render();
      const errorOutput = stderr.render();
      if (termination === "cancelled") {
        resolve({ success: false, output, error: "Read-only command was cancelled.", cancelled: true });
      } else if (termination === "timeout") {
        resolve({ success: false, output, error: `Read-only command timed out after ${timeoutMs / 1000}s.`, timedOut: true });
      } else if (result.error) {
        resolve({ success: false, output, error: `Failed to execute read-only command: ${result.error}` });
      } else if (result.code !== 0) {
        resolve({ success: false, output, error: errorOutput || `Read-only command exited with code ${result.code}` });
      } else {
        resolve({ success: true, output: output.trim() });
      }
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once("error", (err) => finish({ code: null, error: err.message }));
    child.once("close", (code) => finish({ code }));
    signal?.addEventListener("abort", onAbort, { once: true });
    // Close the race between the initial check and listener registration.
    if (signal?.aborted) onAbort();
  });
}

/** How long a cancelled RPC waits for the runner to confirm the command ended (its grace period is 2 s). */
const RPC_CANCEL_CONFIRM_MS = 5_000;

export class RustCoreBridge {
  private static activeBridges: Set<RustCoreBridge> = new Set();
  private workspace: string;
  private workspaceIdentity?: { dev: number; ino: number };
  private defaultShell: string;
  private coreBinaryPath: string | null = null;
  private cargoManifestPath: string;
  private rpcProcess: ChildProcess | null = null;
  private nextRequestId: number = 1;
  private pendingRequests: Map<number, {
    resolve: (res: ExecutionResult) => void;
    timeoutTimer: NodeJS.Timeout;
  }> = new Map();
  private rpcBuffer: string = "";
  private dryRun: boolean = false;
  private readOnly: boolean = false;
  private sandbox: boolean | string = false;
  private requireSandbox: boolean = false;
  private verifierTimeoutSecs?: number;
  private securityManager: SecurityManager;
  private handshakePromise: Promise<{ version: string; protocol: number }> | null = null;
  private handshakeError: Error | null = null;

  constructor(
    workspace: string,
    defaultShell: string = "bash",
    customBinaryPath?: string,
    dryRun: boolean = false,
    readOnly: boolean = false,
    sandbox: boolean | string = false,
    requireSandbox: boolean = false
  ) {
    this.workspace = path.resolve(workspace);
    try {
      const workspaceStat = fs.statSync(this.workspace);
      if (workspaceStat.isDirectory()) {
        this.workspaceIdentity = { dev: workspaceStat.dev, ino: workspaceStat.ino };
      }
    } catch {
      // Read-only command execution fails closed if the workspace identity is unavailable.
    }
    this.defaultShell = defaultShell;
    this.cargoManifestPath = path.resolve(__dirname, "../../core/Cargo.toml");
    this.dryRun = dryRun;
    this.readOnly = readOnly;
    this.sandbox = sandbox;
    this.requireSandbox = requireSandbox;
    this.securityManager = new SecurityManager(this.workspace);
    RustCoreBridge.activeBridges.add(this);

    if (customBinaryPath && fs.existsSync(customBinaryPath)) {
      this.coreBinaryPath = customBinaryPath;
    } else {
      this.resolveBinary();
    }
  }

  public getSecurityManager(): SecurityManager {
    return this.securityManager;
  }

  public setDryRun(enabled: boolean): void {
    this.dryRun = enabled;
  }

  public setReadOnly(enabled: boolean): void {
    this.readOnly = enabled;
  }

  public setSandbox(sandbox: boolean | string): void {
    this.sandbox = sandbox;
  }

  public setVerifierTimeoutSecs(secs?: number): void {
    this.verifierTimeoutSecs = secs;
  }

  private resolveBinary(): void {
    const found = resolveCoreBinary();
    if (found) this.coreBinaryPath = found;
  }

  private ensureRpcDaemon(): ChildProcess | null {
    if (this.rpcProcess && !this.rpcProcess.killed && this.rpcProcess.stdin && !this.rpcProcess.stdin.destroyed) {
      return this.rpcProcess;
    }

    let command: string;
    let spawnArgs: string[];

    if (this.coreBinaryPath && fs.existsSync(this.coreBinaryPath)) {
      command = this.coreBinaryPath;
      spawnArgs = ["--workspace", this.workspace, "rpc"];
    } else {
      command = "cargo";
      spawnArgs = [
        "run",
        "--manifest-path",
        this.cargoManifestPath,
        "--quiet",
        "--",
        "--workspace",
        this.workspace,
        "rpc",
      ];
    }

    try {
      this.rpcProcess = spawn(command, spawnArgs, {
        cwd: this.workspace,
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.rpcProcess.stdout?.on("data", (chunk: Buffer) => {
        this.handleRpcStdout(chunk.toString("utf-8"));
      });

      this.rpcProcess.on("error", () => {
        this.cleanupRpc();
      });

      this.rpcProcess.on("exit", () => {
        this.cleanupRpc();
      });

      return this.rpcProcess;
    } catch {
      this.cleanupRpc();
      return null;
    }
  }

  private cleanupRpc(): void {
    if (this.rpcProcess) {
      try {
        this.rpcProcess.stdin?.end();
        this.rpcProcess.stdout?.destroy();
        this.rpcProcess.stderr?.destroy();
        this.rpcProcess.kill("SIGTERM");
      } catch {}
      this.rpcProcess = null;
    }
    for (const [_, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeoutTimer);
      pending.resolve({
        success: false,
        output: "",
        error: "Rust core RPC daemon disconnected",
      });
    }
    this.pendingRequests.clear();
    this.rpcBuffer = "";
    this.handshakePromise = null;
  }

  private handleRpcStdout(data: string): void {
    this.rpcBuffer += data;
    const lines = this.rpcBuffer.split("\n");
    this.rpcBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed);
        const reqId = msg.id;
        if (reqId !== undefined && this.pendingRequests.has(reqId)) {
          const { resolve, timeoutTimer } = this.pendingRequests.get(reqId)!;
          clearTimeout(timeoutTimer);
          this.pendingRequests.delete(reqId);

          if (msg.error) {
            resolve({
              success: false,
              output: "",
              error: typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error),
            });
          } else {
            const outStr = typeof msg.result === "string"
              ? msg.result
              : JSON.stringify(msg.result, null, 2);
            resolve({
              success: true,
              output: outStr,
            });
          }
        }
      } catch {
        // Non-JSON output (e.g. cargo build notes)
      }
    }
  }

  public shutdown(): void {
    this.cleanupRpc();
    this.handshakePromise = null;
    this.handshakeError = null;
    RustCoreBridge.activeBridges.delete(this);
  }

  /**
   * Reset handshake cache (used after restart or in tests).
   */
  public resetHandshake(): void {
    this.handshakePromise = null;
    this.handshakeError = null;
  }

  /**
   * REQ-REL-103: Verifies that the running harness-core engine matches the CLI's expected protocol
   * version and release version via the `hello` JSON-RPC method.
   */
  public async ensureHandshake(): Promise<{ version: string; protocol: number }> {
    if (this.handshakeError) {
      throw this.handshakeError;
    }
    if (this.handshakePromise) {
      return this.handshakePromise;
    }

    this.handshakePromise = (async () => {
      try {
        const result = await this.executeViaRpc("hello", {}, { ignoreTurnSignal: true });
        if (!result) {
          throw new Error("Failed to communicate with core engine during startup handshake.");
        }
        if (!result.success) {
          throw new Error(`Core engine handshake failed: ${result.error || "Unknown error"}`);
        }
        let data: any;
        try {
          data = JSON.parse(result.output);
        } catch {
          throw new Error(`Invalid JSON in core engine hello handshake response: ${result.output}`);
        }
        const coreProtocol = data.protocol;
        const coreVersion = data.version;
        const expectedVersion = getBuildIdentity().version;

        if (coreProtocol !== CORE_PROTOCOL_VERSION) {
          throw new Error(
            `Engine protocol mismatch: core engine reports protocol ${coreProtocol}, but CLI expects ${CORE_PROTOCOL_VERSION}. Run 'make build' to update.`
          );
        }
        if (expectedVersion !== "unknown" && coreVersion !== expectedVersion) {
          throw new Error(
            `Engine version mismatch: core engine reports version ${coreVersion}, but CLI is ${expectedVersion}. Run 'make build' to update.`
          );
        }
        return { version: coreVersion, protocol: coreProtocol };
      } catch (err: any) {
        this.handshakeError = err;
        this.cleanupRpc();
        throw err;
      }
    })();

    return this.handshakePromise;
  }

  public static shutdownAllGlobal(): void {
    for (const b of RustCoreBridge.activeBridges) {
      b.shutdown();
    }
    RustCoreBridge.activeBridges.clear();
  }

  /**
   * The abort signal of the turn now running. Every RPC sent while it is set is tied to it: when the turn is cancelled,
   * the runner is told to end that request's command (its whole process group) instead of leaving it running.
   */
  private turnSignal?: AbortSignal;

  public setTurnSignal(signal: AbortSignal | undefined): void {
    this.turnSignal = signal;
  }

  /** Asks the runner to end the request's command; best effort (the daemon may already be gone). */
  private sendCancel(requestId: number): void {
    const daemon = this.rpcProcess;
    if (!daemon?.stdin || daemon.stdin.destroyed) return;
    try {
      daemon.stdin.write(JSON.stringify({ id: this.nextRequestId++, method: "cancel", params: { request_id: requestId } }) + "\n");
    } catch {}
  }

  /**
   * Ends background processes that finished commands left running (`server &`), for a cancelled turn. Returns how many
   * process groups were ended, or 0 when the runner is not running.
   */
  public async endBackground(): Promise<number> {
    if (!this.rpcProcess) return 0;
    const result = await this.executeViaRpc("end_background", {}, { ignoreTurnSignal: true });
    try {
      return Number(JSON.parse(result?.output ?? "{}").ended ?? 0);
    } catch {
      return 0;
    }
  }

  private async executeViaRpc(toolName: string, args: Record<string, any>, options: { ignoreTurnSignal?: boolean } = {}): Promise<ExecutionResult | null> {
    const signal = options.ignoreTurnSignal ? undefined : this.turnSignal;
    if (signal?.aborted) {
      return { success: false, output: "", error: `'${toolName}' was not started: the turn was cancelled`, cancelled: true };
    }
    const daemon = this.ensureRpcDaemon();
    if (!daemon || !daemon.stdin || daemon.stdin.destroyed) {
      return null;
    }

    if (toolName !== "hello") {
      try {
        await this.ensureHandshake();
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    const id = this.nextRequestId++;
    const deadlines = rpcDeadlines(toolName, args);
    // The runner's deadline is stated explicitly (never left to the Rust default) so the two timers cannot disagree.
    const params = deadlines.runnerSecs === undefined ? args : { ...args, timeout_secs: deadlines.runnerSecs };
    const payload = JSON.stringify({
      id,
      method: toolName,
      params,
    });

    return new Promise<ExecutionResult>((outerResolve) => {
      let cancelTimer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        if (!this.pendingRequests.has(id)) return;
        // The runner ends the command's process group and answers with cancelled: true within its grace period; if it
        // does not answer, the call is reported cancelled anyway rather than left waiting.
        this.sendCancel(id);
        cancelTimer = setTimeout(() => {
          if (this.pendingRequests.has(id)) {
            const pending = this.pendingRequests.get(id)!;
            clearTimeout(pending.timeoutTimer);
            this.pendingRequests.delete(id);
            resolve({ success: false, output: "", error: `'${toolName}' was cancelled; the command runner did not confirm within ${RPC_CANCEL_CONFIRM_MS / 1000}s`, cancelled: true });
          }
        }, RPC_CANCEL_CONFIRM_MS);
      };
      const resolve = (result: ExecutionResult) => {
        signal?.removeEventListener("abort", onAbort);
        if (cancelTimer) clearTimeout(cancelTimer);
        outerResolve(signal?.aborted && toolName === "run_command" ? { ...result, cancelled: true } : result);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const timeoutMs = deadlines.bridgeMs;
      const timeoutTimer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          // The bridge stops waiting; the runner is told to end the command too, so nothing keeps running unowned.
          this.sendCancel(id);
          resolve({
            success: false,
            output: "",
            error: `RPC request for '${toolName}' timed out after ${timeoutMs / 1000}s without an answer from the command runner (result unknown); the command was told to stop`,
            timedOut: true,
          });
        }
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, timeoutTimer });

      try {
        daemon.stdin!.write(payload + "\n");
      } catch (err: any) {
        clearTimeout(timeoutTimer);
        this.pendingRequests.delete(id);
        resolve({
          success: false,
          output: "",
          error: `Failed to write to RPC daemon: ${err.message}`,
        });
      }
    });
  }

  private executeViaSpawnSync(toolName: string, args: Record<string, any>): ExecutionResult {
    const argsJson = JSON.stringify(args);

    let command: string;
    let spawnArgs: string[];

    if (this.coreBinaryPath && fs.existsSync(this.coreBinaryPath)) {
      command = this.coreBinaryPath;
      spawnArgs = ["--workspace", this.workspace, "call", "--tool", toolName, "--args", argsJson];
    } else {
      command = "cargo";
      spawnArgs = [
        "run",
        "--manifest-path",
        this.cargoManifestPath,
        "--quiet",
        "--",
        "--workspace",
        this.workspace,
        "call",
        "--tool",
        toolName,
        "--args",
        argsJson,
      ];
    }

    try {
      const res = spawnSync(command, spawnArgs, {
        cwd: this.workspace,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });

      if (res.error) {
        return {
          success: false,
          output: "",
          error: `Failed to execute core engine: ${res.error.message}`,
        };
      }

      if (res.status !== 0) {
        return {
          success: false,
          output: res.stdout || "",
          error: res.stderr || `Tool exited with code ${res.status}`,
        };
      }

      return {
        success: true,
        output: res.stdout.trim(),
      };
    } catch (err: any) {
      return {
        success: false,
        output: "",
        error: `Unexpected error executing tool: ${err.message}`,
      };
    }
  }

  /**
   * Execute tool using high-performance persistent JSON-RPC daemon, with automatic spawnSync fallback
   */
  async executeTool(toolName: string, args: Record<string, any>): Promise<ExecutionResult> {
    // 1. Security policy verification
    if (toolName === "run_command") {
      const cmd = (args.command || "").trim();
      const check = this.securityManager.isCommandBlocked(cmd);
      if (check.blocked) {
        return {
          success: false,
          output: "",
          error: check.reason,
        };
      }
    }

    const PATH_CHECKED_TOOLS = [
      "write_file",
      "edit_file",
      "patch_file",
      "delete_file",
      "read_file",
      "file_info",
      "count_lines",
      "list_dir",
      "file_tree",
      "outline_file",
      "cst_symbols",
      "lsp_hover",
      "lsp_definition",
      "lsp_diagnostics",
    ];
    if (PATH_CHECKED_TOOLS.includes(toolName)) {
      const targetPath = args.path || args.target_file || args.file_path || "";
      const check = this.securityManager.isPathProtected(targetPath);
      if (check.protected) {
        return {
          success: false,
          output: "",
          error: check.reason,
        };
      }
    }

    if (toolName === "batch_read" && Array.isArray(args.paths)) {
      for (const p of args.paths) {
        const check = this.securityManager.isPathProtected(p || "");
        if (check.protected) {
          return {
            success: false,
            output: "",
            error: check.reason,
          };
        }
      }
    }

    if (toolName === "delete_file") {
      const refused = forbiddenDeletion(this.workspace, String(args.path || ""));
      if (refused) return { success: false, output: "", error: refused };
    }

    // 2. Read-only mode enforcement
    if (this.readOnly) {
      if (["write_file", "edit_file", "patch_file", "delete_file"].includes(toolName)) {
        return {
          success: false,
          output: "",
          error: `Read-only mode violation: Mutating tool '${toolName}' is blocked.`,
        };
      }
      if (toolName === "run_command") {
        const cmd = (args.command || "").trim();
        // The same check as the authority engine: one allowlist, with argument-level escapes (find -exec, rg --pre…).
        if (!isSafeReadOnlyCommand(cmd, undefined, this.workspace)) {
          return {
            success: false,
            output: "",
            error: `Read-only mode violation: Non-read command '${cmd}' is blocked.`,
          };
        }
      }
    }

    // 3. Dry-run mode simulation
    if (this.dryRun) {
      if (toolName === "run_tests") {
        return {
          success: false,
          output: JSON.stringify({
            dry_run: true,
            passed: false,
            summary: "Test command was not executed because dry-run mode is active.",
          }),
          error: "Dry-run mode does not execute repository-controlled test commands.",
        };
      }
      if (toolName === "write_file") {
        return {
          success: true,
          output: JSON.stringify({
            dry_run: true,
            path: args.path,
            action: "write_file",
            bytes_simulated: (args.content || "").length,
            message: `[DRY-RUN SIMULATION] Would write ${(args.content || "").length} characters to ${args.path}. No changes written to disk.`,
          }),
        };
      }
      if (toolName === "edit_file") {
        return {
          success: true,
          output: JSON.stringify({
            dry_run: true,
            path: args.path,
            action: "edit_file",
            message: `[DRY-RUN SIMULATION] Would replace target content in ${args.path}. No changes written to disk.`,
          }),
        };
      }
      if (toolName === "patch_file") {
        return {
          success: true,
          output: JSON.stringify({
            dry_run: true,
            path: args.path,
            action: "patch_file",
            message: `[DRY-RUN SIMULATION] Would patch ${args.path}. No changes written to disk.`,
          }),
        };
      }
      if (toolName === "delete_file") {
        return {
          success: true,
          output: JSON.stringify({
            dry_run: true,
            path: args.path,
            action: "delete_file",
            message: `[DRY-RUN SIMULATION] Would delete ${args.path}. No changes deleted.`,
          }),
        };
      }
      if (toolName === "run_command") {
        const cmd = (args.command || "").trim();
        if (!isSafeReadOnlyCommand(cmd, undefined, this.workspace)) {
          return {
            success: true,
            output: `[DRY-RUN SIMULATION] Command '${cmd}' simulated without execution to protect disk state.`,
          };
        }
      }
    }

    if (toolName === "task_completed") {
      return {
        success: true,
        output: JSON.stringify({
          status: "completed",
          summary: args.summary || "Task marked as completed.",
          notes: args.notes || "",
        }),
      };
    }

    if (toolName === "update_plan") {
      return {
        success: true,
        output: JSON.stringify({
          status: "plan_updated",
          phases: args.phases || [],
        }),
      };
    }

    if (toolName === "run_tests") {
      const { discoverVerifier, runTestSuiteWithExecutor, verifierTimeoutSecs } = await import("./tester.js");
      const discovered = discoverVerifier(this.workspace, args.filter);
      if (!discovered) {
        return {
          success: false,
          output: JSON.stringify({
            command: "none",
            passed: false,
            noVerifier: true,
            failures: [],
            diagnostics: [],
            report: "no verifier: no verification command is configured or discovered in this workspace.",
            summary: "no verifier: no verification command is configured or discovered in this workspace.",
          }),
          error: "no verifier: no verification command is configured or discovered in this workspace.",
        };
      }
      const timeoutSecs = verifierTimeoutSecs(this.verifierTimeoutSecs);
      const res = await runTestSuiteWithExecutor(
        this.workspace,
        (testCommand) => this.executeTool("run_command", { command: testCommand, timeout_secs: timeoutSecs }),
        discovered.command,
      );
      return {
        success: res.success,
        output: JSON.stringify({
          command: res.command,
          passed: res.success,
          failures: res.failures,
          diagnostics: res.diagnostics,
          // The end of the run's output (where runners report counts): bounded, and what coverage is judged from.
          report: (res.rawOutput || "").split("\n").slice(-40).join("\n").slice(-4000),
          summary: res.success
            ? "Test suite passed successfully."
            : `Test suite failed with ${res.failures.length} failing tests and ${res.diagnostics.length} diagnostics.`,
        }),
        error: res.success ? undefined : `Test suite failed: ${res.failures.join("; ") || "Errors encountered"}`,
      };
    }

    if (toolName === "fetch_web") {
      try {
        const url = args.url;
        if (!url || typeof url !== "string") {
          return { success: false, output: "", error: "Missing required parameter 'url'" };
        }

        const safetyCheck = isSafeOutboundUrl(url);
        if (!safetyCheck.safe) {
          return { success: false, output: "", error: safetyCheck.reason || "Blocked by security policy" };
        }

        const boundary = InformationFlowBoundary.getGlobalInstance();
        const egressCheck = boundary.evaluateEgress(url, url, {
          sourceBoundary: "HOST_LOCAL",
        });
        if (!egressCheck.allowed) {
          return { success: false, output: "", error: egressCheck.reason || "Egress blocked by InformationFlowBoundary [FAIL-003]" };
        }

        const policy = this.securityManager.getPolicy();
        if (policy.allowedDomains && policy.allowedDomains.length > 0) {
          try {
            const parsedUrl = new URL(url);
            const domain = parsedUrl.hostname.toLowerCase();
            const isAllowed = policy.allowedDomains.some(
              (d) => domain === d.toLowerCase() || domain.endsWith("." + d.toLowerCase())
            );
            if (!isAllowed) {
              return {
                success: false,
                output: "",
                error: `Security Policy Violation: Domain '${domain}' is not in allowedDomains list.`,
              };
            }
          } catch (e: any) {
            return { success: false, output: "", error: `Invalid URL: ${e.message}` };
          }
        }

        const res = await safeFetch(url, {
          maxBytes: 5 * 1024 * 1024,
          maxRedirects: 5,
          timeoutMs: 15000,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; NexusCode/1.0)",
          },
        });
        if (!res.ok) {
          return { success: false, output: "", error: `HTTP ${res.status}: ${res.statusText}` };
        }
        const text = res.text;
        const clean = htmlToReadableText(text);
        const maxLen = args.max_length || 15000;
        const truncated = clean.length > maxLen ? clean.substring(0, maxLen) + "\n... [TRUNCATED]" : clean;
        return { success: true, output: truncated };
      } catch (err: any) {
        return { success: false, output: "", error: `Fetch failed: ${err.message}` };
      }
    }

    if (toolName === "search_web") {
      try {
        const query = args.query;
        if (!query || typeof query !== "string") {
          return { success: false, output: "", error: "Missing required parameter 'query'" };
        }
        const maxResults = typeof args.max_results === "number" ? args.max_results : 5;
        const { executeWebSearch } = await import("./search_web.js");
        const searchRes = await executeWebSearch(query, maxResults);
        if (!searchRes.success) {
          return { success: false, output: "", error: searchRes.error || "Web search failed" };
        }
        return {
          success: true,
          output: JSON.stringify(
            {
              query,
              total_results: searchRes.results.length,
              results: searchRes.results,
            },
            null,
            2
          ),
        };
      } catch (err: any) {
        return { success: false, output: "", error: `Search failed: ${err.message}` };
      }
    }

    if (toolName === "lsp_hover") {
      try {
        const { LspBridgeManager } = await import("./lsp.js");
        const lsp = new LspBridgeManager(this.workspace);
        const res = await lsp.hover(args.path, Number(args.line), Number(args.character));
        return {
          success: res.found,
          output: res.hoverText || "No hover info",
          error: res.error,
        };
      } catch (err: any) {
        return { success: false, output: "", error: `LSP error: ${err.message}` };
      }
    }

    if (toolName === "lsp_definition") {
      try {
        const { LspBridgeManager } = await import("./lsp.js");
        const lsp = new LspBridgeManager(this.workspace);
        const res = await lsp.definition(args.path, Number(args.line), Number(args.character));
        return {
          success: res.found,
          output: JSON.stringify(res.locations || [], null, 2),
          error: res.error,
        };
      } catch (err: any) {
        return { success: false, output: "", error: `LSP error: ${err.message}` };
      }
    }

    if (toolName === "lsp_diagnostics") {
      try {
        const { LspBridgeManager } = await import("./lsp.js");
        const lsp = new LspBridgeManager(this.workspace);
        const diags = lsp.getDiagnostics(args.path);
        return {
          success: true,
          output: JSON.stringify(diags, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: `LSP error: ${err.message}` };
      }
    }

    // Default the shell and wrap with sandbox if enabled.
    // Note: Path protection checks are enforced on all file read/write/edit tools (REQ-SEC-118).
    // For run_command, path protection is advisory because shell commands (e.g. cat, grep)
    // execute through the host shell environment.
    let clampedNotice = "";
    if (toolName === "run_command") {
      const maxSecs = maxToolTimeoutSecs();
      if (typeof args.timeout_secs === "number" && args.timeout_secs > maxSecs) {
        clampedNotice = `[Notice: timeout_secs clamped from ${args.timeout_secs} to ${maxSecs} (NEXUS_MAX_TOOL_TIMEOUT_SECS)]\n`;
        args.timeout_secs = maxSecs;
      }
      if (!args.shell) {
        args.shell = this.defaultShell;
      }
      if (this.sandbox || this.readOnly || this.requireSandbox) {
        const { wrapSandboxedCommand } = await import("./sandbox.js");
        const configuredMode = typeof this.sandbox === "string" ? (this.sandbox as any) : "auto";
        const mode = this.readOnly && configuredMode === "none" ? "auto" : configuredMode;

        if (this.readOnly) {
          let workspaceFd: number | undefined;
          try {
            const flags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0);
            workspaceFd = fs.openSync(this.workspace, flags);
            const pinnedStat = fs.fstatSync(workspaceFd);
            if (
              !pinnedStat.isDirectory() ||
              !this.workspaceIdentity ||
              pinnedStat.dev !== this.workspaceIdentity.dev ||
              pinnedStat.ino !== this.workspaceIdentity.ino
            ) {
              return {
                success: false,
                output: "",
                error: "Read-only mode violation: workspace identity changed before command execution.",
              };
            }

            const pinnedWorkspace = `/proc/${process.pid}/fd/${workspaceFd}`;
            if (!isSafeReadOnlyCommand(args.command || "", undefined, pinnedWorkspace)) {
              return {
                success: false,
                output: "",
                error: "Read-only mode violation: command operands escaped the pinned workspace.",
              };
            }

            const sandboxed = wrapSandboxedCommand(args.command || "", this.workspace, {
              mode,
              shell: args.shell,
              readOnlyHost: true,
              workspaceFd,
              network: false,
            });
            if (!sandboxed.sandboxed || sandboxed.engine !== "bwrap" || !sandboxed.argv) {
              return {
                success: false,
                output: "",
                error: `Read-only mode violation: filesystem-isolated shell execution is unavailable. ${sandboxed.warning || "No supported sandbox engine is available."}`,
              };
            }

            const timeoutSecs = rpcDeadlines("run_command", args).runnerSecs ?? RUN_COMMAND_DEFAULT_TIMEOUT_SECS;
            return await runReadOnlySandbox(
              sandboxed.argv[0],
              sandboxed.argv.slice(1),
              workspaceFd,
              timeoutSecs * 1000,
              this.turnSignal,
            );
          } catch (err: any) {
            return { success: false, output: "", error: `Read-only command confinement failed: ${err.message}` };
          } finally {
            if (workspaceFd !== undefined) fs.closeSync(workspaceFd);
          }
        }

        const sandboxed = wrapSandboxedCommand(args.command || "", this.workspace, {
          mode,
          shell: args.shell,
          readOnlyHost: this.readOnly,
          network: this.readOnly ? false : undefined,
        });
        const explicitlyRequestedSandbox = Boolean(this.sandbox) && configuredMode !== "none";
        if ((this.readOnly || this.requireSandbox || explicitlyRequestedSandbox) && !sandboxed.sandboxed) {
          const authority = this.readOnly
            ? "Read-only mode"
            : this.requireSandbox
              ? "Worktree isolation"
              : "Configured sandbox";
          return {
            success: false,
            output: "",
            error: `${authority} violation: filesystem-isolated shell execution is unavailable. ${sandboxed.warning || "No supported sandbox engine is available."}`,
          };
        }
        args.command = sandboxed.command;
        if (sandboxed.argv) {
          args.argv = sandboxed.argv;
        }
      }
    }

    const applyNotice = (res: ExecutionResult): ExecutionResult => {
      if (clampedNotice && !res.output?.includes("[Notice: timeout_secs clamped")) {
        return {
          ...res,
          output: clampedNotice + (res.output || ""),
        };
      }
      return res;
    };

    // Attempt persistent JSON-RPC execution
    try {
      const rpcResult = await this.executeViaRpc(toolName, args);
      if (rpcResult !== null) {
        return applyNotice(rpcResult);
      }
    } catch {
      // Fall through to fallback
    }

    // Fallback: spawnSync invocation
    return applyNotice(this.executeViaSpawnSync(toolName, args));
  }

  public async listServices(): Promise<Array<{ name: string; pgid: number; command: string }>> {
    try {
      const res = await this.executeViaRpc("list_services", {}, { ignoreTurnSignal: true });
      if (res && res.output) {
        const parsed = JSON.parse(res.output);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      }
    } catch {
      // Return empty if RPC is not running or failed
    }
    return [];
  }

  public registerWithCapabilities(registry: CapabilityRegistry): void {
    registerBridgeCapabilities(registry, this);
  }
}

export function registerBridgeCapabilities(
  registry: CapabilityRegistry,
  bridge: RustCoreBridge
): void {
  for (const cap of registry.listCapabilities()) {
    if (
      cap.backend === "rust_rpc" ||
      [
        "fetch_web",
        "search_web",
        "lsp_hover",
        "lsp_definition",
        "lsp_diagnostics",
        "run_tests",
      ].includes(cap.modelToolName)
    ) {
      registry.setHandler(cap.modelToolName, async (args) =>
        bridge.executeTool(cap.modelToolName, args)
      );
    }
  }
}
