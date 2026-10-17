import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import http from "node:http"; import os from "node:os"; import path from "node:path";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../snap/cli/src/agent.js";
import { ApplicationCore } from "../snap/cli/src/core/app.js";

type Reply = { tools: Array<{ name: string; args: unknown }> } | { text: string };
async function gateway(script: (b: any) => Reply) {
  const gw: any = { requests: [] as any[] }; let n = 0;
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/models")) { res.setHeader("content-type", "application/json"); return void res.end('{"data":[{"id":"m"}]}'); }
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      let body: any = {}; try { body = JSON.parse(raw); } catch {}
      gw.requests.push(body); const reply = script(body);
      const calls = "tools" in reply ? reply.tools.map((c, index) => ({ index, id: `call_${++n}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) : undefined;
      if (!body.stream) { res.setHeader("content-type", "application/json");
        const message = calls ? { role: "assistant", content: null, tool_calls: calls } : { role: "assistant", content: (reply as any).text };
        return void res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: calls ? "tool_calls" : "stop" }] })); }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const delta = calls ? { tool_calls: calls } : { content: (reply as any).text };
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  gw.url = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  gw.close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  return gw;
}
const tools = (b: any) => (b.messages ?? []).filter((m: any) => m.role === "tool").length;
const lastUser = (b: any) => { const u = (b.messages ?? []).filter((m: any) => m.role === "user"); return String(u[u.length - 1]?.content ?? ""); };
function repo() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "agt-")); fs.writeFileSync(path.join(d, "notes.txt"), "orig\n");
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: d, stdio: "ignore" }); return d; }
function quiet(a: any) { a.ui = new Proxy({}, { get: () => () => {} }); return a; }
const cfg = (gw: any, ws: string, o: any = {}) => ({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: ws, shell: "bash", ...o });
const home = fs.mkdtempSync(path.join(os.tmpdir(), "agt-home-")); process.env.HOME = home;
for (const k of ["LOCAL_LLM_ENDPOINT","LOCAL_LLM_API_KEY","LOCAL_LLM_MODEL"]) delete process.env[k];

test("R1 failed mutating command leaves no verification obligation", async () => {
  const gw = await gateway((b) => tools(b) === 0 ? { tools: [{ name: "run_command", args: { command: "echo changed > notes.txt; exit 3" } }] } : { text: "Done." });
  const ws = repo();
  const agent = quiet(new AutonomousAgent(cfg(gw, ws)));
  const r = await agent.runTurn("Update notes.txt");
  const tool = agent.getMessages().find((m: any) => m.role === "tool");
  console.log("R1 tool content:", String(tool?.content).slice(0, 200));
  console.log("R1 file:", JSON.stringify(fs.readFileSync(path.join(ws, "notes.txt"), "utf8")), "git:", execSync("git status --porcelain", { cwd: ws }).toString().trim());
  console.log("R1 result:", r.execution, r.outcome, r.reason, "pending=", r.unverifiedChangesPending);
  agent.shutdown(); await gw.close();
});

test("R2 run --resume <id> discards recovered conversation", async () => {
  const gw = await gateway((b) => ({ text: lastUser(b).includes("PINEAPPLE") ? "noted" : "reply" }));
  const ws = repo();
  const first = new ApplicationCore(cfg(gw, ws)); quiet(first.getAgent());
  const r1 = await first.runTask("Remember the codeword PINEAPPLE.", { quiet: true }); first.shutdown();
  const second = new ApplicationCore(cfg(gw, ws)); quiet(second.getAgent());
  const r2 = await second.runTask("What was the codeword?", { quiet: true, resumeTaskId: r1.taskId }); second.shutdown();
  const last = gw.requests[gw.requests.length - 1];
  const carries = JSON.stringify(last.messages).includes("PINEAPPLE");
  console.log("R2 r1.taskId=", r1.taskId, "r2.taskId=", r2.taskId, "msgs in resumed request=", last.messages.length, "carries prior conversation=", carries);
  let latestErr = "";
  const third = new ApplicationCore(cfg(gw, ws)); quiet(third.getAgent());
  try { await third.runTask("x", { quiet: true, resumeTaskId: "latest" }); latestErr = "no error"; } catch (e: any) { latestErr = e.message; }
  third.shutdown();
  console.log("R2 resume 'latest':", latestErr.slice(0, 200));
  await gw.close();
});

test("R4 spawn_subagent: orphan task records and token accounting", async () => {
  const gw = await gateway((b) => {
    const sub = JSON.stringify(b.messages).includes("[Subagent Objective]");
    if (sub) return tools(b) === 0 ? { tools: [{ name: "read_file", args: { path: "notes.txt" } }] } : { text: "Subagent report: notes says orig" };
    return tools(b) === 0 ? { tools: [{ name: "spawn_subagent", args: { prompt: "read notes.txt" } }] } : { text: "Parent done." };
  });
  const ws = repo();
  const tasksDir = path.join(home, ".nexus", "tasks");
  const before = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).length : 0;
  const agent = quiet(new AutonomousAgent(cfg(gw, ws)));
  const r = await agent.runTurn("Use a subagent to read notes.txt");
  const after = fs.readdirSync(tasksDir).length;
  const subReqs = gw.requests.filter((b: any) => JSON.stringify(b.messages).includes("[Subagent Objective]")).length;
  console.log("R4 outcome", r.execution, r.outcome, "task files before/after", before, after, "gateway requests total", gw.requests.length, "subagent requests", subReqs, "parent tokenStats.requests", agent.getTokenStats().requests);
  agent.shutdown(); await gw.close();
});
