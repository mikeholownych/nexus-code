import http from "node:http";
import type { Socket } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

export type Reply =
  | { kind: "tools"; calls: Array<{ name: string; args: unknown; id?: string }>; content?: string; delayMs?: number }
  | { kind: "text"; content: string; delayMs?: number }
  | { kind: "http"; status: number; body?: string; delayMs?: number };

export interface Gateway {
  url: string;
  requests: unknown[];
  close(): Promise<void>;
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function streamBody(r: Extract<Reply, { kind: "tools" | "text" }>): string {
  let out = "";
  if (r.kind === "text") out += sse({ choices: [{ index: 0, delta: { content: r.content } }] });
  else {
    if (r.content) out += sse({ choices: [{ index: 0, delta: { content: r.content } }] });
    r.calls.forEach((c, i) => {
      out += sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: c.id ?? `call_${i}_${Math.random().toString(36).slice(2, 7)}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] });
    });
  }
  out += sse({ choices: [{ index: 0, delta: {}, finish_reason: r.kind === "tools" ? "tool_calls" : "stop" }] });
  return out + "data: [DONE]\n\n";
}

/** Deterministic OpenAI-compatible gateway. `script(n)` decides the reply to the n-th chat request (1-based). */
export async function startGateway(script: (n: number) => Reply): Promise<Gateway> {
  const requests: unknown[] = [];
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "m" }] }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = {};
      try { body = JSON.parse(raw); } catch {}
      requests.push(body);
      const r = script(requests.length);
      const respond = () => {
        if (res.writableEnded || res.destroyed) return;
        if (r.kind === "http") {
          res.statusCode = r.status;
          res.end(r.body ?? "{}");
        } else if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(streamBody(r));
        } else {
          res.setHeader("content-type", "application/json");
          const message = r.kind === "text"
            ? { role: "assistant", content: r.content }
            : { role: "assistant", content: r.content ?? null, tool_calls: r.calls.map((c, i) => ({ id: c.id ?? `call_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
          res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: "stop" }] }));
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
