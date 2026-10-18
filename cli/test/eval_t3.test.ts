/**
 * T3 long-task harness (REQ-QUAL-109, ACCEPTANCE §6.3): task schema, the sidecar-protocol driver, compaction counting,
 * per-run scoring, and an end-to-end run of the checkout sidecar through run.mjs's sandbox and model proxy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startGateway } from "./helpers/fixtures.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const t3 = () => import(path.join(ROOT, "eval/t3.mjs"));

const TASK = {
  id: "t3-smoke",
  tier: "T3",
  objective: "Survey the repository and summarise it.",
  fixture: "repo",
  steps: 60,
  minutes: 5,
  steering: [{ id: "keep", afterToolCalls: 2, text: "Do not modify keep.txt.", constraint: { kind: "file-unchanged", path: "keep.txt" } }],
  facts: [
    { id: "plan", statement: "notes/plan.md exists", path: "notes/plan.md" },
    { id: "ghost", statement: "docs/ghost.md exists", path: "docs/ghost.md" },
  ],
  hidden: { command: "test -f keep.txt" },
};

test("T3 task schema requires steering with checkable constraints, a fact sheet, a long budget and Nexus only", async () => {
  const { t3TaskProblems } = await t3();
  assert.deepEqual(t3TaskProblems(TASK), []);
  assert.deepEqual(t3TaskProblems({ ...TASK, tier: "T2", steering: undefined }), [], "other tiers are not T3-checked");
  const problems = t3TaskProblems({ ...TASK, steps: 30, agents: ["goose"], steering: [{ id: "x", afterToolCalls: 0, text: "", constraint: { kind: "vibe" } }], facts: [] }).join("\n");
  assert.match(problems, /Nexus only/);
  assert.match(problems, /at least 60/);
  assert.match(problems, /afterToolCalls/);
  assert.match(problems, /text is required/);
  assert.match(problems, /constraint.kind/);
  assert.match(problems, /fact sheet/);
});

test("the T3 driver submits the objective, steers after the scripted tool calls, probes, then shuts down", async () => {
  const { createT3Driver } = await t3();
  const sent: any[] = [];
  const driver = createT3Driver(TASK, (line: string) => sent.push(JSON.parse(line)));
  const feed = (event: object) => driver.handleLine(JSON.stringify({ v: 1, ...event }));
  feed({ type: "hello", protocol: 1, pid: 1, commands: [] });
  assert.deepEqual(sent.at(-1), { v: 1, type: "prompt.submit", id: "t3-objective", text: TASK.objective });
  feed({ type: "tool.start", turn_id: "a", call_id: "1", tool: "read_file", subject: "", evidence: "" });
  assert.equal(sent.length, 1, "no steering before afterToolCalls");
  feed({ type: "tool.start", turn_id: "a", call_id: "2", tool: "read_file", subject: "", evidence: "" });
  assert.deepEqual(sent.at(-1), { v: 1, type: "steer", id: "t3-keep", text: "Do not modify keep.txt." });
  feed({ type: "tool.start", turn_id: "a", call_id: "3", tool: "read_file", subject: "", evidence: "" });
  assert.equal(sent.filter((c) => c.type === "steer").length, 1, "each steering item is sent once");
  feed({ type: "steer.ack", id: "t3-keep", status: "queued", message: "" });
  feed({ type: "steer.ack", id: "t3-keep", status: "applied", message: "" });
  feed({ type: "approval.request", id: "ap1", turn_id: "a", tool: "run_command", subject: "", preview: "", review: {} });
  assert.deepEqual(sent.at(-1), { v: 1, type: "deny", id: "ap1" }, "an unexpected approval is denied, never approved");
  feed({ type: "turn.result", turn_id: "a", heading: "", line: "", turn: { steps: { used: 7 } }, model_summary: null });
  assert.equal(sent.at(-1).id, "t3-probe");
  assert.match(sent.at(-1).text, /plan: notes\/plan.md exists/);
  feed({ type: "assistant.delta", turn_id: "b", text: '{"plan": "present", ' });
  feed({ type: "assistant.delta", turn_id: "b", text: '"ghost": "absent"}' });
  feed({ type: "turn.result", turn_id: "b", heading: "", line: "", turn: {}, model_summary: null });
  const state = await driver.done;
  assert.deepEqual(sent.at(-1), { v: 1, type: "shutdown" });
  assert.deepEqual(state.acks.keep, ["queued", "applied"]);
  assert.equal(state.probeText, '{"plan": "present", "ghost": "absent"}');
  assert.equal(state.objectiveTurn.steps.used, 7);
  assert.match(state.protocolErrors.join(), /unexpected approval request/);
});

test("compactions count only committed ids whose originals are in the archive", async () => {
  const { countCompactions } = await t3();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-home-"));
  try {
    fs.mkdirSync(path.join(home, ".nexus/sessions"), { recursive: true });
    fs.writeFileSync(path.join(home, ".nexus/sessions/s1.json"), JSON.stringify({ history: { compactions: 3, committedCompactions: ["c1", "c2", "c3"] } }));
    fs.writeFileSync(path.join(home, ".nexus/sessions/s1.history.jsonl"), [{ compactionId: "c1" }, { compactionId: "c2" }, { compactionId: "c9" }].map((l) => JSON.stringify(l)).join("\n"));
    assert.equal(countCompactions(home), 2, "c3 has no archived originals and c9 was never committed");
    assert.equal(countCompactions(path.join(home, "missing")), 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("T3 scoring: steering is honoured only when applied and its constraint holds; false absence is counted", async () => {
  const { scoreT3Run, steeringBaseline } = await t3();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "t3-ws-"));
  try {
    fs.mkdirSync(path.join(ws, "notes"));
    fs.writeFileSync(path.join(ws, "notes/plan.md"), "plan\n");
    fs.writeFileSync(path.join(ws, "keep.txt"), "keep\n");
    const baseline = steeringBaseline(TASK, ws);
    const driver = (probeText: string, statuses = ["queued", "applied"]) => ({ acks: { keep: statuses }, steeringSent: ["keep"], probeText, objectiveTurn: { steps: { used: 61 } }, protocolErrors: [] });
    const run = (d: any, compactions = 2) => scoreT3Run({ task: TASK, ws, baseline, driver: d, compactions, runCommand: async () => ({ pass: true }) });

    const good = await run(driver('{"plan":"present","ghost":"absent"}'));
    assert.equal(good.eligible, true);
    assert.equal(good.steeringHonoured, 1);
    assert.equal(good.falseAbsences, 0);
    assert.equal(good.probeAnswered, true);

    const lost = await run(driver('Sure: {"plan":"absent","ghost":"absent"}'));
    assert.equal(lost.falseAbsences, 1, "claiming an existing file is absent is a false absence");

    assert.equal((await run(driver("I am not sure."))).probeAnswered, false);
    assert.equal((await run(driver("{}", ["queued", "cancelled"]))).steeringHonoured, 0, "steering never applied is not honoured");
    assert.equal((await run(driver("{}"), 1)).eligible, false, "fewer than two compactions is not a T3 run");

    fs.writeFileSync(path.join(ws, "keep.txt"), "changed\n");
    const violated = await run(driver('{"plan":"present","ghost":"absent"}'));
    assert.equal(violated.steering[0].constraintHolds, false);
    assert.equal(violated.steeringHonoured, 0, "an applied steer whose constraint was broken is not honoured");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("a T3 run drives the real sidecar through the sandbox: steering applied, probe answered and scored", { timeout: 300_000 }, async () => {
  const lastUser = (body: any) => [...(body?.messages ?? [])].reverse().find((m: any) => m.role === "user")?.content ?? "";
  const gw = await startGateway((_n: number, body: any) => {
    if (String(lastUser(body)).startsWith("Final check")) return { kind: "text", content: '{"plan": "absent", "ghost": "absent"}' };
    const tools = (body?.messages ?? []).filter((m: any) => m.role === "tool").length;
    if (tools < 5) return { kind: "tools", calls: [{ name: "read_file", args: { path: tools % 2 ? "notes/plan.md" : "README.md" } }] };
    if (tools === 5) return { kind: "tools", calls: [{ name: "task_completed", args: { summary: "surveyed" } }] };
    return { kind: "text", content: "Surveyed." };
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-t3-"));
  try {
    const tasks = path.join(root, "tasks");
    const repo = path.join(tasks, TASK.id, "repo");
    fs.mkdirSync(path.join(repo, "notes"), { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "# t3 smoke\n");
    fs.writeFileSync(path.join(repo, "notes/plan.md"), "plan\n");
    fs.writeFileSync(path.join(repo, "keep.txt"), "keep\n");
    fs.writeFileSync(path.join(tasks, TASK.id, "task.json"), JSON.stringify(TASK));
    const config = path.join(root, "config.json");
    fs.writeFileSync(config, JSON.stringify({ name: "nexus@mock", agent: "nexus", endpoint: gw.url, model: "m", runs: 1, steps: 60, minutes: 5 }));
    const out = path.join(root, "out");
    const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, "eval/run.mjs"), "--config", config, "--tasks", tasks, "--out", out], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const [record] = fs.readFileSync(path.join(out, "results.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(record.t3, `no T3 result: ${JSON.stringify(record)}`);
    assert.equal(record.t3.steering[0].sent, true);
    assert.equal(record.t3.steering[0].applied, true, `steering statuses ${JSON.stringify(record.t3.steering[0].statuses)}`);
    assert.equal(record.t3.steering[0].constraintHolds, true);
    assert.equal(record.t3.probeAnswered, true);
    assert.equal(record.t3.falseAbsences, 1, "the scripted model falsely says notes/plan.md is absent");
    assert.equal(record.t3.eligible, false, "a short smoke run is reported as not a qualifying T3 run");
    assert.deepEqual(record.t3.protocolErrors, []);
    assert.equal(record.hiddenPass, true);
    const scored = spawnSync(process.execPath, [path.join(ROOT, "eval/score.mjs"), path.join(out, "results.jsonl"), "--json"], { encoding: "utf8" });
    assert.equal(scored.status, 0, scored.stderr);
    const summary = JSON.parse(scored.stdout).t3;
    assert.equal(summary.runs, 1);
    assert.equal(summary.ineligible, 1);
    assert.equal(summary.falseAbsences, 1);
    assert.equal(summary.gate, "FAIL");
  } finally {
    await gw.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
