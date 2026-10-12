/**
 * Assessment reproduction (not part of the product suite): a process that dies mid-turn after findings were recorded.
 * Mid-turn progress (recordProgress) persists messages but not the findings store; the durable record inside the
 * persisted messages names findings by id. On recovery, are those findings readable, and do new ids collide?
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { DurableStateManager } from "../src/core/state.js";
import { readFindings } from "../src/core/findings.js";

const MARKERS: Record<string, string> = { "a.txt": "copper-falcon", "b.txt": "silent-orchard", "c.txt": "amber-lattice", "d.txt": "north-quarry" };
const FILES = Object.keys(MARKERS);
function bigFile(file: string): string {
  let out = `MARKER ${file}: ${MARKERS[file]}\n`;
  for (let i = 0; out.length < 24_800; i++) out += `record ${file}.${i} value=${(i * 7919) % 100000} status=ok filler text to occupy context\n`;
  return out;
}
const allText = (body: any): string => (body.messages ?? []).map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))).join("\n");
const isCheckpoint = (body: any) => String(body.messages?.[0]?.content ?? "").startsWith("You keep the working notes");

test("mid-turn crash after findings were recorded", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "repro-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "repro-ws-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "repro-state-"));
  const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), "repro-snap-"));
  for (const f of FILES) fs.writeFileSync(path.join(repo, f), bigFile(f));
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: repo, stdio: "ignore" });
  process.env.HOME = home;
  for (const k of ["LOCAL_LLM_ENDPOINT", "LOCAL_LLM_API_KEY", "LOCAL_LLM_CREDENTIAL_ORIGINS", "LOCAL_LLM_FALLBACK_ENDPOINTS"]) delete process.env[k];
  let steps = 0;
  let snapped = false;
  let ids = 0;
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/models")) return void res.end('{"data":[{"id":"m"}]}');
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      let content: string | null = null;
      let calls: any[] | undefined;
      if (isCheckpoint(body)) {
        content = FILES.filter((f) => allText(body).includes(`MARKER ${f}: ${MARKERS[f]}`)).map((f) => `${f} starts with marker ${MARKERS[f]}.`).join(" ");
      } else {
        steps++;
        // At step 4 the findings for earlier files are recorded and mid-turn progress has been persisted:
        // snapshot the state directory as a crash would leave it.
        if (steps === Number(process.env.SNAP_STEP || 4) && !snapped) {
          fs.cpSync(stateDir, snapDir, { recursive: true });
          snapped = true;
        }
        const f = FILES[(steps - 1) % FILES.length];
        calls = [{ index: 0, id: `call_${++ids}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: f }) } }];
      }
      const delta = { ...(content ? { content } : {}), ...(calls ? { tool_calls: calls } : {}) };
      if (!body.stream) {
        res.setHeader("content-type", "application/json");
        return void res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content, tool_calls: calls }, finish_reason: calls ? "tool_calls" : "stop" }] }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const cfg: any = { endpoint: url, model: "m", maxSteps: Number(process.env.MAX_STEPS || 4), temperature: 0, workspace: repo, shell: "bash", contextLimit: 40_000 };
  const make = (dir: string) => {
    const a = new AutonomousAgent(cfg);
    (a as any).ui = new Proxy({}, { get: () => () => {} });
    (a as any).stateManager = new DurableStateManager({ baseDir: dir, workspacePaths: [(a as any).primaryWorkspacePathIdentity] });
    return a;
  };
  const log = console.log;
  console.log = () => {};
  try {
    const first = make(stateDir);
    const taskId = first.getTaskId();
    await first.runTurn("Read a.txt, b.txt, c.txt and d.txt one at a time, then report the marker word of each via task_completed.");
    const liveFindings = first.getFindings();
    first.shutdown();
    assert.ok(snapped, "snapshot taken");
    const snapState = JSON.parse(fs.readFileSync(path.join(snapDir, fs.readdirSync(snapDir).find((n) => n.endsWith(".json"))!), "utf8"));
    const persistedText = JSON.stringify(snapState.messages ?? []);
    const referenced = [...new Set([...persistedText.matchAll(/\[(F\d+); step \d+;/g)].map((m) => m[1]))];
    const second = make(snapDir);
    await second.recoverFromTaskState(taskId);
    const restored = second.getFindings();
    const missing = referenced.filter((id) => !restored.some((n) => n.includes(`[${id}; step`)));
    const readBack = referenced.map((id) => `${id}: ${readFindings(restored, { id }).text.slice(0, 120)}`);
    console.log = log;
    console.log(JSON.stringify({
      liveFindingIds: liveFindings.map((n) => /\[(F\d+);/.exec(n)?.[1]),
      snapshotFindingsField: (snapState.findings ?? []).length,
      idsReferencedInPersistedMessages: referenced,
      restoredFindingIds: restored.map((n) => /\[(F\d+);/.exec(n)?.[1]),
      unreadableAfterRecovery: missing,
      nextSeqAfterRecovery: (second as any).findingSeq,
      readFindingsAfterRecovery: readBack,
    }, null, 1));
    console.log = () => {};
    await second.runTurn("continue");
    const msgs = JSON.stringify(second.getMessages());
    const store = second.getFindings();
    console.log = log;
    const headers = (t: string) => [...t.matchAll(/Findings recorded from inspected output \[(F\d+); step (\d+); from ([^;]{0,40})/g)].map((m) => `${m[1]} step ${m[2]} ${m[3]}`);
    console.log(JSON.stringify({ afterResume_storeHeaders: store.map((n) => headers(n)[0]), afterResume_recordHeaders: [...new Set(headers(msgs))] }, null, 1));
    second.shutdown();
    assert.deepEqual(missing, [], `findings referenced by the persisted record but unreadable after recovery: ${missing.join(", ")}`);
  } finally {
    console.log = log;
    server.closeAllConnections();
    server.close();
    for (const d of [home, repo, stateDir, snapDir]) fs.rmSync(d, { recursive: true, force: true });
  }
});
