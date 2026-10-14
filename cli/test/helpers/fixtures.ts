import { test } from "node:test";
import http from "node:http";
import type { Socket } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

export type Reply =
  /** `truncated`: the reply hits the output limit (finish_reason=length) partway through its tool calls' arguments. */
  | { kind: "tools"; calls: Array<{ name: string; args: unknown; id?: string }>; content?: string; delayMs?: number; truncated?: boolean }
  /** `chunks`: stream the text in these pieces, `gapMs` apart (the default sends it in one delta). `truncated`: finish_reason=length. */
  | { kind: "text"; content: string; delayMs?: number; chunks?: string[]; gapMs?: number; truncated?: boolean }
  | { kind: "http"; status: number; body?: string; delayMs?: number };

export interface Gateway {
  url: string;
  requests: unknown[];
  /** Bodies of /tokenize requests (only with `options.tokenize`). */
  tokenizeRequests: any[];
  /** Number of GET /models requests served. */
  modelRequests: number;
  /** Authorization headers seen, per path kind. */
  authSeen: Array<{ path: string; authorization?: string }>;
  close(): Promise<void>;
}

/** Optional gateway capabilities (homelab-ai contract shape): catalog entries, request counting, admission headers. */
export interface GatewayOptions {
  /** `data` entries for GET /models (default: [{ id: "m" }]). Called per request, so tests can change capacity. */
  models?: () => any[];
  /** Answer to POST /tokenize; absent: 404. */
  tokenize?: (body: any, n: number) => { status: number; body: unknown; delayMs?: number };
  /** Response headers for the n-th chat request (e.g. X-AIHost-* admission headers). */
  headers?: (n: number, body: any) => Record<string, string>;
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** A tool call's arguments as sent: whole, or cut off partway like a reply that hit the output limit. */
function wireArguments(args: unknown, truncated?: boolean): string {
  const json = JSON.stringify(args);
  return truncated ? json.slice(0, Math.max(1, Math.floor(json.length / 2))) : json;
}

function finishReason(r: Extract<Reply, { kind: "tools" | "text" }>): string {
  return r.truncated ? "length" : r.kind === "tools" ? "tool_calls" : "stop";
}

function streamBody(r: Extract<Reply, { kind: "tools" | "text" }>): string {
  let out = "";
  if (r.kind === "text") out += sse({ choices: [{ index: 0, delta: { content: r.content } }] });
  else {
    if (r.content) out += sse({ choices: [{ index: 0, delta: { content: r.content } }] });
    r.calls.forEach((c, i) => {
      out += sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: c.id ?? `call_${i}_${Math.random().toString(36).slice(2, 7)}`, type: "function", function: { name: c.name, arguments: wireArguments(c.args, r.truncated) } }] } }] });
    });
  }
  out += sse({ choices: [{ index: 0, delta: {}, finish_reason: finishReason(r) }] });
  return out + "data: [DONE]\n\n";
}

/** Deterministic OpenAI-compatible gateway. `script(n, body)` decides the reply to the n-th chat request (1-based). */
export async function startGateway(script: (n: number, body?: any) => Reply, options: GatewayOptions = {}): Promise<Gateway> {
  const requests: unknown[] = [];
  const tokenizeRequests: any[] = [];
  const authSeen: Array<{ path: string; authorization?: string }> = [];
  let modelRequests = 0;
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    authSeen.push({ path: req.url ?? "", authorization: req.headers.authorization });
    if (req.url?.endsWith("/models")) {
      modelRequests++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: options.models ? options.models() : [{ id: "m" }] }));
      return;
    }
    if (req.url?.endsWith("/tokenize")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body: any = {};
        try { body = JSON.parse(raw); } catch {}
        tokenizeRequests.push(body);
        if (!options.tokenize) {
          res.statusCode = 404;
          res.end(JSON.stringify({ status: "not_found", message: "no tokenize" }));
          return;
        }
        const answer = options.tokenize(body, tokenizeRequests.length);
        const send = () => {
          if (res.writableEnded || res.destroyed) return;
          res.statusCode = answer.status;
          res.setHeader("content-type", "application/json");
          res.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
        };
        if (answer.delayMs) setTimeout(send, answer.delayMs); else send();
      });
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = {};
      try { body = JSON.parse(raw); } catch {}
      requests.push(body);
      const extraHeaders = options.headers ? options.headers(requests.length, body) : {};
      for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
      const r = script(requests.length, body);
      const respond = () => {
        if (res.writableEnded || res.destroyed) return;
        if (r.kind === "http") {
          res.statusCode = r.status;
          res.end(r.body ?? "{}");
        } else if (body.stream && r.kind === "text" && r.chunks?.length) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const pieces = [...r.chunks];
          const next = () => {
            if (res.writableEnded || res.destroyed) return;
            const piece = pieces.shift();
            if (piece === undefined) {
              res.end(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
              return;
            }
            res.write(sse({ choices: [{ index: 0, delta: { content: piece } }] }));
            setTimeout(next, r.gapMs ?? 50);
          };
          next();
        } else if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(streamBody(r));
        } else {
          res.setHeader("content-type", "application/json");
          const message = r.kind === "text"
            ? { role: "assistant", content: r.content }
            : { role: "assistant", content: r.content ?? null, tool_calls: r.calls.map((c, i) => ({ id: c.id ?? `call_${i}`, type: "function", function: { name: c.name, arguments: wireArguments(c.args, r.truncated) } })) };
          res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: r.truncated ? "length" : "stop" }] }));
        }
      };
      if (r.delayMs) setTimeout(respond, r.delayMs); else respond();
    });
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    tokenizeRequests,
    get modelRequests() {
      return modelRequests;
    },
    authSeen,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Temporary git repository with one committed file. */
export function makeRepo(files: Record<string, string> = {}): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sidecar-"));
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), content);
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: repo, stdio: "ignore" });
  return repo;
}

export function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-home-"));
}

export async function waitUntil(cond: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function waitForEvent(events: any[], pred: (e: any) => boolean, timeoutMs = 10000): Promise<any> {
  try {
    await waitUntil(() => events.some(pred), timeoutMs);
  } catch {
    throw new Error(`timed out waiting for event; saw: ${events.map((e) => e.type).join(", ")}`);
  }
  return events.find(pred);
}

/**
 * Pseudo-terminal scenarios measure timing (spinner frames, idle redraws, approval grace) and drive real processes;
 * run concurrently by the test runner they starve each other and keys arrive late. `ptyTest` holds a cross-process
 * lock (a directory under the system temp dir, taken over when its owner is gone) so they run one at a time.
 */
export async function acquirePtyLock(timeoutMs = 15 * 60_000): Promise<() => void> {
  const dir = path.join(os.tmpdir(), "nexus-pty-test.lock");
  const owner = path.join(dir, "pid");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(owner, String(process.pid));
      return () => fs.rmSync(dir, { recursive: true, force: true });
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      let pid = 0;
      try {
        pid = Number(fs.readFileSync(owner, "utf8"));
      } catch {}
      let alive = false;
      try {
        if (pid > 0) {
          process.kill(pid, 0);
          alive = true;
        }
      } catch {}
      // A lock without a live owner (crashed run, or an owner not yet written for a while) is taken over.
      if (!alive && (pid > 0 || Date.now() - fs.statSync(dir).mtimeMs > 5_000)) {
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for the PTY test lock held by pid ${pid}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

export function ptyTest(name: string, options: { timeout?: number }, fn: () => Promise<void>): void {
  test(name, { ...options, timeout: (options.timeout ?? 120_000) + 15 * 60_000 }, async () => {
    const release = await acquirePtyLock();
    try {
      await fn();
    } finally {
      release();
    }
  });
}
