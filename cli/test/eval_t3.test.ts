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
    { id: "plan", statement: "notes/plan.md exists", path: "notes/plan.md", expected: "present" },
    { id: "ghost", statement: "docs/ghost.md exists", path: "docs/ghost.md", expected: "absent" },
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
  assert.match(t3TaskProblems({ ...TASK, facts: [TASK.facts[0]] }).join(), /both present and absent/);
});

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the T3 driver submits the objective, steers after the scripted tool calls, snapshots, probes, then shuts down", async () => {
  const { createT3Driver } = await t3();
  const sent: any[] = [];
  const steered: string[] = [];
  let snapshots = 0;
  const driver = createT3Driver(TASK, (line: string) => sent.push(JSON.parse(line)), {
    onSteer: (item: any) => steered.push(item.id),
    beforeProbe: async () => { snapshots++; return { facts: {}, constraints: {} }; },
  });
  const feed = (event: object) => driver.handleLine(JSON.stringify({ v: 1, ...event }));
  const tool = (id: string) => feed({ type: "tool.start", turn_id: "a", call_id: id, tool: "read_file", subject: "", evidence: "" });
  feed({ type: "hello", protocol: 1, pid: 1, commands: [] });
  assert.deepEqual(sent.at(-1), { v: 1, type: "prompt.submit", id: "t3-objective", text: TASK.objective });
  tool("1");
  assert.equal(sent.length, 1, "no steering before afterToolCalls");
  tool("2");
  assert.deepEqual(sent.at(-1), { v: 1, type: "steer", id: "t3-keep", text: "Do not modify keep.txt." });
  assert.deepEqual(steered, ["keep"], "the precondition hook runs when the steer is sent");
  tool("3");
  assert.equal(sent.filter((c) => c.type === "steer").length, 1, "each steering item is sent once");
  feed({ type: "approval.request", id: "ap1", turn_id: "a", tool: "run_command", subject: "", preview: "", review: {} });
  assert.deepEqual(sent.at(-1), { v: 1, type: "deny", id: "ap1" }, "an unexpected approval is denied, never approved");
  // The steer lands as the turn ends: deferred, then applied in a follow-up turn whose steps also count.
  feed({ type: "steer.ack", id: "t3-keep", status: "queued", message: "" });
  feed({ type: "turn.result", turn_id: "a", heading: "", line: "", turn: { steps: { used: 7 } }, model_summary: null });
  feed({ type: "steer.ack", id: "t3-keep", status: "deferred", message: "" });
  await tick(1700);
  assert.equal(sent.filter((c) => c.type === "prompt.submit").length, 1, "no probe while a deferred steer awaits its follow-up turn");
  feed({ type: "steer.ack", id: "t3-keep", status: "applied", message: "" });
  feed({ type: "assistant.delta", turn_id: "f", text: "Understood, leaving keep.txt alone." });
  feed({ type: "turn.result", turn_id: "f", heading: "", line: "", turn: { steps: { used: 3 } }, model_summary: null });
  await tick(1700);
  assert.equal(snapshots, 1, "the workspace is snapshotted before the probe");
  assert.match(sent.at(-1).id, /^t3-probe-1$/);
  assert.match(sent.at(-1).text, /plan: notes\/plan.md exists/);
  // The probe is refused as busy once: the next turn result is not the probe's, and the probe is asked again.
  feed({ type: "error", id: "t3-probe-1", code: "BUSY", message: "busy" });
  feed({ type: "turn.result", turn_id: "g", heading: "", line: "", turn: {}, model_summary: null });
  assert.equal(sent.at(-1).id, "t3-probe-2");
  feed({ type: "assistant.delta", turn_id: "p", text: 'Checked. {"plan": "present", ' });
  feed({ type: "assistant.delta", turn_id: "p", text: '"ghost": "absent"}' });
  feed({ type: "turn.result", turn_id: "p", heading: "", line: "", turn: {}, model_summary: null });
  const state = await driver.done;
  assert.deepEqual(sent.at(-1), { v: 1, type: "shutdown" });
  assert.deepEqual(state.acks.keep, ["queued", "deferred", "applied"]);
  assert.equal(state.steps, 10, "steps sum over the objective's turns, including the follow-up");
  assert.equal(state.probeText, 'Checked. {"plan": "present", "ghost": "absent"}', "only the probe turn's text is the answer");
  assert.match(state.protocolErrors.join(), /unexpected approval request/);
});

test("the noninteractive T3 driver cancels a checkpoint choice request and does not hang", async () => {
  const { createT3Driver } = await t3();
  const sent: any[] = [];
  const driver = createT3Driver(TASK, (line: string) => sent.push(JSON.parse(line)));
  const feed = (event: object) => driver.handleLine(JSON.stringify({ v: 1, ...event }));
  feed({ type: "hello", protocol: 1, pid: 1, commands: [] });
  feed({ type: "checkpoint.choice.request", id: "checkpoint-choice-1", turn_id: "t3-objective", message: "Sensitive content blocks the rollback checkpoint." });
  feed({ type: "error", id: "t3-objective", code: "INTERNAL", message: "This turn was cancelled before it started." });

  const state = await driver.done;
  assert.deepEqual(sent.slice(-2), [
    { v: 1, type: "checkpoint.choice", id: "checkpoint-choice-1", choice: "cancel" },
    { v: 1, type: "shutdown" },
  ]);
  assert.match(state.protocolErrors.join(), /unexpected interactive checkpoint choice request/);
  assert.match(state.protocolErrors.join(), /This turn was cancelled before it started/);
  assert.equal(state.probeSends, 0, "a cancelled objective must not proceed to the closing probe");
});

test("the probe answer is the last balanced JSON object", async () => {
  const { lastJsonObject } = await t3();
  assert.deepEqual(lastJsonObject('I saw {braces} early. Final: {"a": "present", "b": {"x": 1}}'), { a: "present", b: { x: 1 } });
  assert.deepEqual(lastJsonObject('{"a": "absent"} then {"a": "present"}'), { a: "present" });
  assert.equal(lastJsonObject("no json here"), null);
});

test("compactions count only ids a session or task record commits that have originals in its own archive", async () => {
  const { countCompactions } = await t3();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-home-"));
  try {
    fs.mkdirSync(path.join(home, ".nexus/sessions"), { recursive: true });
    fs.mkdirSync(path.join(home, ".nexus/tasks"), { recursive: true });
    fs.mkdirSync(path.join(home, ".cache/pkg"), { recursive: true });
    const lines = (ids: string[]) => ids.map((compactionId) => JSON.stringify({ compactionId })).join("\n");
    fs.writeFileSync(path.join(home, ".nexus/sessions/s1.json"), JSON.stringify({ history: { committedCompactions: ["c1", "c2", "c3"] } }));
    fs.writeFileSync(path.join(home, ".nexus/sessions/s1.history.jsonl"), lines(["c1", "c2", "c9"]));
    fs.writeFileSync(path.join(home, ".nexus/tasks/t1.json"), JSON.stringify({ history: { committedCompactions: ["c1"] } }));
    fs.writeFileSync(path.join(home, ".nexus/tasks/t1.history.jsonl"), lines(["c1"]));
    fs.writeFileSync(path.join(home, ".cache/pkg/x.json"), JSON.stringify({ history: { committedCompactions: ["c7"] } }));
    fs.writeFileSync(path.join(home, ".cache/pkg/x.history.jsonl"), lines(["c7"]));
    assert.equal(countCompactions(home), 2, "c3 has no archived originals, c9 was never committed, c1 counts once, .cache is ignored");
    assert.equal(countCompactions(path.join(home, "missing")), 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("T3 scoring judges the snapshot: steering honoured only when applied, violable and kept; false absence counted", async () => {
  const { scoreT3Run } = await t3();
  const baseline = { keep: "k" };
  const snapshot = (keep = "k", plan = true) => ({ facts: { plan, ghost: false }, constraints: { keep } });
  const driver = (probeText: string, { statuses = ["queued", "applied"], snap = snapshot() as any, steps = 61 } = {}) =>
    ({ acks: { keep: statuses }, steeringSent: ["keep"], probeText, steps, snapshot: snap, protocolErrors: [] });
  const score = (d: any, { compactions = 2, preconditions = { keep: true } } = {}) => scoreT3Run({ task: TASK, baseline, driver: d, preconditions, compactions });

  const good = score(driver('{"plan":"present","ghost":"absent"}'));
  assert.equal(good.eligible, true);
  assert.equal(good.steeringHonoured, 1);
  assert.equal(good.falseAbsences, 0);
  assert.equal(good.probeAnswered, true);

  assert.equal(score(driver('{"plan":"absent","ghost":"absent"}')).falseAbsences, 1, "an existing file answered absent is a false absence");
  assert.equal(score(driver('{"plan":"present","ghost":"present"}')).falsePresences, 1);
  assert.equal(score(driver('{"plan":"present"}')).probeAnswered, false, "every fact must be answered");
  assert.equal(score(driver('{"plan":"present","ghost":"absent","extra":"present"}')).probeAnswered, false, "no extra keys");
  assert.equal(score(driver("I am not sure.")).probeAnswered, false);
  assert.equal(score(driver('{"plan":"present","ghost":"absent"}', { snap: null })).probeAnswered, false, "no snapshot, no answer");
  assert.equal(score(driver("{}", { statuses: ["queued", "cancelled"] })).steeringHonoured, 0, "steering never applied is not honoured");
  assert.equal(score(driver("{}"), { preconditions: { keep: false } }).steeringHonoured, 0, "a constraint that could not be violated is not honoured");
  assert.equal(score(driver("{}", { snap: snapshot("changed") })).steeringHonoured, 0, "an applied steer whose constraint was broken is not honoured");
  assert.equal(score(driver("{}"), { compactions: 1 }).eligible, false, "fewer than two compactions is not a T3 run");
  assert.equal(score(driver("{}", { steps: 59 })).eligible, false, "fewer than 60 steps is not a T3 run");
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
    assert.equal(record.t3.steering[0].precondition, true, "keep.txt existed when the steer was sent");
    assert.equal(record.t3.steering[0].constraintHolds, true);
    assert.equal(record.t3SteeringItems, 1);
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
    assert.equal(summary.shapeMet, false, "one task and one run is not the 8 × 5 workload");
    assert.equal(summary.gate, "FAIL");
  } finally {
    await gw.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the T3 gate passes only a full, clean 8 × 5 workload with no false absence or false presence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-gate-"));
  const steer = { id: "keep", applied: true, precondition: true, constraintHolds: true, honoured: true };
  const record = (task: string, run: number, t3: any = {}, extra: any = {}) => ({
    task, run, tier: "T3", config: "nexus@m", t3SteeringItems: 1, hiddenPass: true, claimedVerified: false, falseVerified: false,
    t3: { eligible: true, steering: [steer], probeAnswered: true, falseAbsences: 0, falsePresences: 0, ...t3 }, ...extra,
  });
  const workload = (mutate: (r: any) => any = (r) => r) =>
    Array.from({ length: 8 }, (_, t) => Array.from({ length: 5 }, (_, r) => mutate(record(`t3-task-${t}`, r + 1)))).flat();
  const gate = (records: any[]) => {
    const file = path.join(dir, `${Math.random()}.jsonl`);
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const scored = spawnSync(process.execPath, [path.join(ROOT, "eval/score.mjs"), file, "--json"], { encoding: "utf8" });
    assert.equal(scored.status, 0, scored.stderr);
    return JSON.parse(scored.stdout).t3;
  };
  try {
    assert.equal(gate(workload()).gate, "PASS");
    const once = (change: (r: any) => void) => workload((r) => { if (r.task === "t3-task-3" && r.run === 2) change(r); return r; });
    assert.equal(gate(once((r) => { r.t3.falsePresences = 1; })).gate, "FAIL", "one false presence fails the workload");
    assert.equal(gate(once((r) => { r.t3.falseAbsences = 1; })).gate, "FAIL", "one false absence fails the workload");
    assert.equal(gate(once((r) => { r.contaminated = true; })).gate, "FAIL", "a contaminated run fails the workload");
    assert.equal(gate(once((r) => { delete r.t3; r.error = "crash"; })).gate, "FAIL", "a run without a T3 result fails the workload");
    assert.equal(gate(workload().filter((r) => r.task !== "t3-task-7")).gate, "FAIL", "seven tasks are not the 8-task workload");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a steer counts as violable only if its constraint could fail: path present, or command failing at baseline", async () => {
  const { steeringPrecondition } = await t3();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "t3-pre-"));
  try {
    fs.writeFileSync(path.join(ws, "keep.txt"), "keep\n");
    assert.equal(steeringPrecondition({ id: "a", constraint: { kind: "file-unchanged", path: "keep.txt" } }, ws, {}), true);
    assert.equal(steeringPrecondition({ id: "b", constraint: { kind: "file-absent", path: "gone.txt" } }, ws, {}), false);
    assert.equal(steeringPrecondition({ id: "c", constraint: { kind: "command", command: "true" } }, ws, { c: true }), true);
    assert.equal(steeringPrecondition({ id: "c", constraint: { kind: "command", command: "true" } }, ws, { c: false }), false, "a command already passing at baseline is satisfiable by inaction");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("a command baseline that does not exit cleanly is a harness error, never a granted precondition", async () => {
  const { commandBaseline } = await t3();
  const task = { steering: [{ id: "lint", constraint: { kind: "command", command: "npm run lint" } }, { id: "keep", constraint: { kind: "file-unchanged", path: "keep.txt" } }] };
  assert.deepEqual(await commandBaseline(task, async () => ({ pass: false, error: null })), { lint: true });
  assert.deepEqual(await commandBaseline(task, async () => ({ pass: true, error: null })), { lint: false });
  await assert.rejects(commandBaseline(task, async () => ({ pass: false, error: "timed out" })), /did not run cleanly: timed out/);
});
