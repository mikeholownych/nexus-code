// Read-only measurement: apply Nexus's CURRENT compaction to a persisted session's messages and report sizes.
// Run from cli/:  npx tsx ../docs/research/context-engineering/tools/measure_compaction.ts <session.json>
// Uses private methods via `as any`; does not modify runtime code or the session file.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AutonomousAgent } from "../../../../cli/src/agent.js";
import { calculateContextBudget } from "../../../../cli/src/tokens.js";

const file = process.argv[2];
const sess = JSON.parse(fs.readFileSync(file, "utf-8"));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-measure-"));
const agent: any = new AutonomousAgent({ endpoint: "http://127.0.0.1:1/v1", model: "m", maxSteps: 30, temperature: 0, workspace: ws, shell: "bash" } as any);
const tools = agent.getEffectiveTools();
const base = calculateContextBudget(sess.messages, tools, 65536);
console.log(JSON.stringify({ phase: "original", messages: sess.messages.length, ...base }));
for (const recent of [2, 1, 0]) {
  for (const budget of [6000, 0]) {
    const out = agent.compactedMessages(sess.messages, recent, budget);
    const b = calculateContextBudget(out, tools, 65536);
    const summary = out.find((m: any, i: number) => i > 0 && m.role === "system");
    console.log(JSON.stringify({ phase: "compacted", recentToolTurns: recent, detailBudgetChars: budget, messages: out.length, totalActiveTokens: b.totalActiveTokens, summaryTokens: summary ? Math.round(String(summary.content).length / 4) : 0, ratioVsOriginal: +(b.totalActiveTokens / base.totalActiveTokens).toFixed(3) }));
  }
}
agent.shutdown();
fs.rmSync(ws, { recursive: true, force: true });
