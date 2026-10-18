/**
 * Child process for the compaction crash tests: runs a short real turn (tool outputs carrying unique markers) with the
 * session record and its archive wired like the sidecar, then runs an operator compaction and dies with SIGKILL at
 * the requested point of the commit:
 *   after_archive     the originals were appended (fsync) to the session archive; no record was written
 *   mid_archive_line  a torn archive line was written; nothing else
 *   after_task_state  archive and task state written; the session record was not
 * Usage: tsx compaction_crash_child.ts <workdir> <point>   (HOME must be <workdir>)
 */
import fs from "node:fs";
import path from "node:path";
import { AutonomousAgent } from "../../src/agent.js";
import { DEFAULT_CONTINUATION } from "../../src/types.js";
import { SessionManager } from "../../src/session.js";
import { startGateway, makeRepo, Reply } from "./fixtures.js";
import { AgentWorkUnitExecutor, driveOperation, OperationStore } from "../../src/core/operation_runner.js";
import { newOperation } from "../../src/core/operation.js";
import { DurableStateManager } from "../../src/core/state.js";
import type { HarnessConfig } from "../../src/types.js";
import type { ResourceDescriptor } from "../../src/core/resources.js";

const [work, point] = process.argv.slice(2);

if (point === "work_unit_pressure") {
  const pressureMarkers = ["MARKER-PRESSURE-ALPHA", "MARKER-PRESSURE-BRAVO", "MARKER-PRESSURE-CHARLIE", "MARKER-PRESSURE-DELTA", "MARKER-PRESSURE-ECHO", "MARKER-PRESSURE-FOXTROT"];
  const pressureFiller = "lorem ipsum dolor sit amet ".repeat(900);
  const pressureRepo = makeRepo(Object.fromEntries(pressureMarkers.map((marker, i) => [`m${i}.txt`, `${marker}\n${pressureFiller}\n`])));
  const stateDir = path.join(work, "op-state");
  fs.mkdirSync(stateDir, { recursive: true });
  let toolStep = 0;
  const pressureGateway = await startGateway((_n, body) => {
    if (!body?.tools) return { kind: "text", content: "Recorded marker findings." };
    toolStep++;
    if (toolStep <= 6) return { kind: "tools", calls: [{ name: "read_file", args: { path: `m${toolStep - 1}.txt` } }] };
    if (toolStep === 7) return { kind: "tools", calls: [{ name: "write_file", args: { path: "out.txt", content: "pressure compaction completed" } }] };
    return { kind: "tools", calls: [{ name: "task_completed", args: { summary: "Read all marker files and wrote out.txt." } }] };
  });
  const config: HarnessConfig = {
    endpoint: pressureGateway.url,
    model: "m",
    maxSteps: 20,
    temperature: 0,
    workspace: pressureRepo,
    shell: "bash",
    approvalMode: "auto" as const,
    fullAccess: true,
    contextLimit: 18_000,
    completionReserveTokens: 500,
    toolResponseReserveTokens: 500,
  };
  const resource: ResourceDescriptor = { id: "primary", provider: new URL(pressureGateway.url).origin, endpoint: pressureGateway.url, model: "m", capabilities: ["tools"], rank: 0 };
  const store = new OperationStore(pressureRepo, stateDir);
  const executor = new AgentWorkUnitExecutor({
    baseConfig: config,
    createAgent: (agentConfig, depth, opts) => {
      const agent = new AutonomousAgent(agentConfig, depth, undefined, opts);
      const a = agent as any;
      a.stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [a.primaryWorkspacePathIdentity] });
      a.ui = new Proxy({}, { get: () => () => {} });
      agent.setProgressListener(() => {
        const taskId = agent.getTaskId();
        const historyPath = path.join(stateDir, `${taskId}.history.jsonl`);
        if (!fs.existsSync(historyPath)) return;
        const historyText = fs.readFileSync(historyPath, "utf8");
        const archivedMarkers = pressureMarkers.filter((marker) => historyText.includes(marker));
        if (!archivedMarkers.includes("MARKER-PRESSURE-ALPHA")) return;
        const lines = historyText.trim().split("\n").filter(Boolean);
        if (!lines.length) return;
        const compactionId = JSON.parse(lines[lines.length - 1]).compactionId;
        if (!compactionId) return;
        fs.writeFileSync(path.join(work, "info.json"), JSON.stringify({ taskId, compactionId, stateDir, repo: pressureRepo, markers: archivedMarkers }));
        process.kill(process.pid, "SIGKILL");
      });
      return agent;
    },
  });
  const op = newOperation("pressure-compaction", "pressure compaction recovery", [{ id: "pressure-unit", role: "implementer", prompt: "Read m0.txt through m5.txt, then write out.txt." }], [resource], Date.now());
  await driveOperation(op, { store, executor });
  process.exit(3);
}

const markers = ["MARKER-ALPHA-417", "MARKER-BRAVO-822", "MARKER-CHARLIE-139"];
// Large enough outputs that an operator compaction condenses the earlier ones.
const filler = "lorem ipsum dolor sit amet ".repeat(400);
const repo = makeRepo(Object.fromEntries(markers.map((m, i) => [`m${i}.txt`, `${m}\n${filler}\n`])));
const script = (n: number): Reply =>
  n <= 3 ? { kind: "tools", calls: [{ name: "read_file", args: { path: `m${n - 1}.txt` } }] } : n <= 9 ? { kind: "tools", calls: [{ name: "write_file", args: { path: `out${n}.txt`, content: `${filler}\n` } }] } : { kind: "text", content: "done" };

const gw = await startGateway(script);
const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 30, temperature: 0, workspace: repo, shell: "bash", continuation: { ...DEFAULT_CONTINUATION } }, 0, undefined, { durable: true });
(agent as any).ui = new Proxy({}, { get: () => () => {} });
const sessions = new SessionManager(path.join(work, "sessions"), () => agent.getWorkspacePathIdentity());
const sessionId = sessions.generateSessionId();
let crashAt: string | undefined;
const save = () => {
  if (crashAt === "after_task_state") process.kill(process.pid, "SIGKILL");
  sessions.saveSession(
    { id: sessionId, workspace: repo, model: "m", messages: agent.getMessages(), objective: agent.getObjective() ?? null, findings: agent.getFindings(), history: agent.getHistoryCompleteness() },
    agent.getWorkspacePathIdentity(),
  );
};
agent.setArchiveSink((id, messages) => {
  if (crashAt === "mid_archive_line") {
    fs.appendFileSync(sessions.archivedHistoryPath(sessionId), `{"archivedAt":"2026-10-13T00:00:00Z","compactionId":"${id}","message":{"role":"tool","con`);
    process.kill(process.pid, "SIGKILL");
  }
  sessions.appendArchivedHistory(sessionId, messages, id);
  if (crashAt === "after_archive") process.kill(process.pid, "SIGKILL");
});
agent.setProgressListener(save);
await agent.runTurn("Read m0..m2, then write out4..out7.");
save();
fs.writeFileSync(path.join(work, "info.json"), JSON.stringify({ sessionId, taskId: agent.getTaskId(), repo, markers }));
crashAt = point;
const result = await agent.compactNow(false);
// Reaching this line means the crash point was never hit.
console.log("no crash", JSON.stringify(result));
process.exit(3);
