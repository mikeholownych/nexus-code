/** Shared fixtures for the D4 context-capacity tests. */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../../src/agent.js";

export interface Gw { url: string; requests: number; close(): Promise<void> }

export async function gateway(script: (n: number) => { tool?: { name: string; args: unknown }; text?: string; fail?: boolean }): Promise<Gw> {
  const gw: Gw = { url: "", requests: 0, close: async () => {} };
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/models")) { res.setHeader("content-type", "application/json"); res.end('{"data":[{"id":"m"}]}'); return; }   // not a model request
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      gw.requests++;
      const r = script(gw.requests);
      if (r.fail) { res.writeHead(500); res.end('{"error":"scripted"}'); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const delta = r.tool
        ? { tool_calls: [{ index: 0, id: `call_${gw.requests}`, type: "function", function: { name: r.tool.name, arguments: JSON.stringify(r.tool.args) } }] }
        : { content: r.text ?? "ok" };
      res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: r.tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  gw.url = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  gw.close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return gw;
}

export function repo(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-capacity-"));
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c);
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: dir, stdio: "ignore" });
  return dir;
}

/** The agent's terminal UI (spinners write unterminated lines) interferes with the node:test TAP stream; tests do not assert on it. */
export function mute(agent: AutonomousAgent): AutonomousAgent {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
}

export const roles = (a: AutonomousAgent) => a.getMessages().map((m) => m.role[0]).join("");

