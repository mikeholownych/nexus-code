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

const [work, point] = process.argv.slice(2);
const markers = ["MARKER-ALPHA-417", "MARKER-BRAVO-822", "MARKER-CHARLIE-139"];
// Large enough outputs that an operator compaction condenses the earlier ones.
const filler = "lorem ipsum dolor sit amet ".repeat(400);
const repo = makeRepo(Object.fromEntries(markers.map((m, i) => [`m${i}.txt`, `${m}\n${filler}\n`])));
const script = (n: number): Reply =>
  n <= 3 ? { kind: "tools", calls: [{ name: "read_file", args: { path: `m${n - 1}.txt` } }] } : n <= 9 ? { kind: "tools", calls: [{ name: "write_file", args: { path: `out${n}.txt`, content: `${filler}\n` } }] } : { kind: "text", content: "done" };

const gw = await startGateway(script);
const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 30, temperature: 0, workspace: repo, shell: "bash", continuation: { ...DEFAULT_CONTINUATION } });
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
