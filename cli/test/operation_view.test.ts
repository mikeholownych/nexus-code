import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { OperationStore } from "../src/core/operation_runner.js";
import { newOperation, type DurableOperationState } from "../src/core/operation.js";
import { scopeKey, type ResourceDescriptor } from "../src/core/resources.js";
import { OPERATION_VIEW_SCHEMA_VERSION, buildOperationView, renderOperationView, watchOperation } from "../src/operation_view.js";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");

function resource(id: string, overrides: Partial<ResourceDescriptor> = {}): ResourceDescriptor {
  return {
    id,
    provider: "https://api.test",
    endpoint: "https://api.test/v1",
    model: `model-${id}`,
    capabilities: ["tools"],
    rank: 0,
    ...overrides,
  };
}

function state(): DurableOperationState {
  const op = newOperation(
    "op-view",
    "Ship the operator view",
    [
      { id: "u1", title: "Implement the projector", prompt: "Implement it", role: "implementer" },
      { id: "u2", title: "Test the projector", prompt: "Test it", role: "tester", dependsOn: ["u1"] },
      { id: "u3", title: "Review the projector", prompt: "Review it", role: "reviewer", dependsOn: ["u2"], required: false },
    ],
    [resource("primary"), resource("secondary", { rank: 1, contextLength: 200_000 })],
    NOW,
  );
  op.units[0].status = "COMPLETE";
  op.units[0].result = {
    summary: "projector implemented",
    completedAt: "2026-10-28T11:00:00.000Z",
    resourceId: "primary",
    outcome: "VERIFIED",
  };
  op.units[1].status = "BLOCKED";
  op.units[1].blocked = {
    since: "2026-10-28T11:10:00.000Z",
    reason: "verifier failed twice",
    decision: {
      id: "d1",
      unitId: "u2",
      cause: "NOT_CONVERGING",
      question: "u2 keeps failing its verifier. What now?",
      options: [
        { id: "1", label: "retry", action: { kind: "retry" } },
        { id: "2", label: "revise the unit (note required)", action: { kind: "revise" } },
      ],
    },
  };
  op.units[2].status = "WAITING_ON_DEPENDENCY";
  op.status = "BLOCKED";
  op.blocked = { since: "2026-10-28T11:10:00.000Z", decisions: [op.units[1].blocked!.decision] };
  op.events = [
    { type: "WORK_STARTED", at: "2026-10-28T10:59:00.000Z", message: "u1 started on primary", unitId: "u1", resourceId: "primary" },
    { type: "WORK_COMPLETED", at: "2026-10-28T11:00:00.000Z", message: "u1 complete (VERIFIED)", unitId: "u1" },
    { type: "WORK_BLOCKED", at: "2026-10-28T11:10:00.000Z", message: "u2 blocked: verifier failed twice", unitId: "u2" },
  ];
  return op;
}

test("projects units, depth, durable state and the open decision", () => {
  const op = state();
  op.units[0].agentTaskId = "task-u1";
  const view = buildOperationView(op, { now: NOW });

  assert.equal(view.schemaVersion, OPERATION_VIEW_SCHEMA_VERSION);
  assert.equal(view.id, "op-view");
  assert.equal(view.status, "BLOCKED");
  assert.equal(view.terminal, false);
  assert.deepEqual(view.counts, { total: 3, complete: 1, running: 0, ready: 0, blocked: 1, parked: 0, waiting: 1 });

  const [u1, u2, u3] = view.units;
  assert.equal(u1.depth, 0);
  assert.equal(u1.durable, true);
  assert.equal(u1.result?.outcome, "VERIFIED");
  assert.equal(u2.depth, 1);
  assert.equal(u2.detail, "verifier failed twice");
  assert.deepEqual(u2.blocked, { reason: "verifier failed twice", decisionId: "d1" });
  assert.equal(u3.depth, 2);
  assert.equal(u3.required, false);

  assert.deepEqual(view.dag.edges, [
    { from: "u1", to: "u2" },
    { from: "u2", to: "u3" },
  ]);
  assert.deepEqual(view.dag.criticalPath, ["u2", "u3"]);
  assert.deepEqual(view.dag.missingDependencies, []);
  assert.deepEqual(view.dag.cycles, []);

  assert.equal(view.decisions.length, 1);
  assert.equal(view.decisions[0].id, "d1");
  assert.equal(view.decisions[0].unitId, "u2");
  assert.deepEqual(view.decisions[0].options.map((option) => option.id), ["1", "2"]);
  assert.equal(view.decisions[0].command, "nexus operation decide op-view d1 <option> [--note <text>]");
});

test("reports resource eligibility with the scheduler's own rules", () => {
  const op = state();
  const key = scopeKey(op.resources[0], "model");
  assert.ok(key);
  op.conditions = [
    {
      scope: "model",
      key: key!,
      condition: "RATE_LIMITED",
      temporary: true,
      recheckAt: "2026-10-28T12:05:00.000Z",
      source: "backoff",
      confidence: "derived",
      reason: "rate limited (HTTP 429)",
      observedAt: "2026-10-28T11:59:00.000Z",
      failures: 1,
      resourceId: "primary",
    },
  ];

  const blocked = buildOperationView(op, { now: NOW });
  assert.equal(blocked.resources[0].eligible, false);
  assert.equal(blocked.resources[0].eligibleAt, "2026-10-28T12:05:00.000Z");
  assert.deepEqual(
    blocked.resources[0].blocking?.map((condition) => [condition.condition, condition.scope]),
    [["RATE_LIMITED", "model"]],
  );
  assert.equal(blocked.resources[1].eligible, true);
  assert.equal(blocked.resources[1].eligibleAt, undefined);

  const after = buildOperationView(op, { now: Date.parse("2026-10-28T12:06:00.000Z") });
  assert.equal(after.resources[0].eligible, true);
  assert.equal(after.resources[0].blocking, undefined);
  assert.equal(after.resources[0].eligibleAt, undefined);
});

test("shows a missing dependency and every unit on a cycle", () => {
  const op = state();
  op.units[2].dependsOn = ["u2", "u404"];
  const missing = buildOperationView(op, { now: NOW });
  assert.deepEqual(missing.dag.missingDependencies, ["u404"]);

  const cyclic = state();
  cyclic.units[0].dependsOn = ["u3"];
  const view = buildOperationView(cyclic, { now: NOW });
  assert.deepEqual(view.dag.cycles, ["u1", "u2", "u3"]);
});

test("critical path does not memoize a cycle-truncated dependency chain", () => {
  const op = state();
  for (const unit of op.units) unit.status = "RUNNABLE";
  op.units[0].dependsOn = ["u2", "u3"];
  op.units[1].dependsOn = ["u1"];
  op.units[2].dependsOn = ["u4"];
  const prerequisite = structuredClone(op.units[2]);
  prerequisite.id = "u4";
  prerequisite.title = "Finish prerequisite";
  prerequisite.status = "RUNNABLE";
  prerequisite.dependsOn = [];
  prerequisite.blocked = undefined;
  prerequisite.result = undefined;
  op.units.push(prerequisite);

  const view = buildOperationView(op, { now: NOW });
  assert.deepEqual(view.dag.criticalPath, ["u4", "u3", "u1", "u2"]);
});

test("shows a blocked unit's decision even while other work is running", () => {
  const op = state();
  op.status = "RUNNING";
  op.blocked = undefined;
  op.units[0].status = "RUNNING";
  op.units[2].status = "RUNNING";
  const view = buildOperationView(op, { now: NOW });
  assert.equal(view.decisions.length, 1);
  assert.equal(view.decisions[0].id, "d1");
  assert.equal(view.decisions[0].command, "nexus operation decide op-view d1 <option> [--note <text>]");
});

test("keeps only the newest events and honours an explicit limit", () => {
  const op = state();
  const view = buildOperationView(op, { now: NOW, events: 2 });
  assert.deepEqual(view.events.map((event) => event.type), ["WORK_COMPLETED", "WORK_BLOCKED"]);
  assert.deepEqual(buildOperationView(op, { now: NOW, events: 0 }).events, []);
  assert.equal(buildOperationView(op, { now: NOW }).events.length, 3);
});

test("is read-only: building a view does not modify the operation", () => {
  const op = state();
  const before = structuredClone(op);
  const view = buildOperationView(op, { now: NOW });
  renderOperationView(view, { width: 80 });
  assert.deepEqual(op, before);
});

test("renders units, decisions and the critical path deterministically", () => {
  const view = buildOperationView(state(), { now: NOW });
  const text = renderOperationView(view, { width: 80 });
  assert.match(text, /^Operation op-view: BLOCKED \(1\/3 complete, 1 blocked\)/m);
  assert.match(text, /u1 \[implementer\] Implement the projector\s+COMPLETE/);
  assert.match(text, /u2 \[tester\] Test the projector\s+BLOCKED/);
  assert.match(text, /verifier failed twice/);
  assert.match(text, /Critical path: u2 → u3/);
  assert.match(text, /Decision needed: u2 keeps failing its verifier/);
  assert.match(text, /nexus operation decide op-view d1 <option>/);
  assert.match(text, /WORK_BLOCKED u2: u2 blocked/);
  assert.equal(renderOperationView(view, { width: 80 }), text);
});

test("truncates long titles when a width is given and leaves them alone otherwise", () => {
  const op = state();
  op.units[0].title = "x".repeat(120);
  const view = buildOperationView(op, { now: NOW });
  assert.match(renderOperationView(view, { width: 40 }), /x{38}…/);
  assert.match(renderOperationView(view), new RegExp(`x{120}`));
});

test("a complete operation is terminal and has an empty critical path", () => {
  const op = state();
  op.status = "COMPLETE";
  op.blocked = undefined;
  for (const unit of op.units) {
    unit.status = "COMPLETE";
    unit.blocked = undefined;
    unit.result = unit.result ?? { summary: "done", completedAt: "2026-10-28T11:30:00.000Z", resourceId: "primary", outcome: "VERIFIED" };
  }
  const view = buildOperationView(op, { now: NOW });
  assert.equal(view.terminal, true);
  assert.equal(view.status, "COMPLETE");
  assert.deepEqual(view.dag.criticalPath, []);
  assert.deepEqual(view.decisions, []);
});

test("watch renders until the operation is terminal and never mutates it", async () => {
  const op = state();
  const snapshots = [structuredClone(op), structuredClone(op)];
  const final = state();
  final.status = "COMPLETE";
  final.blocked = undefined;
  for (const unit of final.units) {
    unit.status = "COMPLETE";
    unit.blocked = undefined;
    unit.result = unit.result ?? { summary: "done", completedAt: "2026-10-28T11:30:00.000Z", resourceId: "primary", outcome: "VERIFIED" };
  }
  snapshots.push(final);
  const before = snapshots.map((snapshot) => structuredClone(snapshot));
  let reads = 0;
  const writes: string[] = [];
  const result = await watchOperation({
    load: () => snapshots[Math.min(reads++, snapshots.length - 1)],
    intervalMs: 0,
    sleep: async () => {},
    write: (text) => writes.push(text),
    now: () => NOW,
  });

  assert.deepEqual(result, { renders: 3, stopped: "terminal" });
  assert.deepEqual(snapshots, before);
  assert.match(writes[0], /Operation op-view: BLOCKED/);
  assert.match(writes[2], /Operation op-view: COMPLETE \(3\/3 complete\)/);
});

test("watch stops on abort, on a render limit and after repeated read failures", async () => {
  const op = state();
  const controller = new AbortController();
  const limited = await watchOperation({
    load: () => op,
    intervalMs: 0,
    signal: controller.signal,
    sleep: async () => controller.abort(),
    write: () => {},
    maxRenders: 10,
    now: () => NOW,
  });
  assert.deepEqual(limited, { renders: 1, stopped: "aborted" });

  const capped = await watchOperation({
    load: () => op,
    intervalMs: 0,
    sleep: async () => {},
    write: () => {},
    maxRenders: 2,
    now: () => NOW,
  });
  assert.deepEqual(capped, { renders: 2, stopped: "limit" });

  const writes: string[] = [];
  const unreadable = await watchOperation({
    load: () => {
      throw new Error("operation file is being replaced");
    },
    intervalMs: 0,
    sleep: async () => {},
    write: (text) => writes.push(text),
    maxReadFailures: 3,
  });
  assert.deepEqual(unreadable, { renders: 0, stopped: "unreadable" });
  assert.equal(writes.length, 2);
  assert.match(writes[0], /could not read the operation: operation file is being replaced/);

  const hostile: string[] = [];
  await watchOperation({
    load: () => {
      throw new Error("boom\u001b]52;c;cGF5bG9hZA==\u0007\u001b[2Jforged\nline\tend");
    },
    intervalMs: 0,
    sleep: async () => {},
    write: (text) => hostile.push(text),
    maxReadFailures: 2,
  });
  assert.equal(hostile.length, 1);
  assert.doesNotMatch(hostile[0], /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
  assert.equal(hostile[0].split("\n").length, 2, "a read-failure message must stay on one line");
  assert.match(hostile[0], /forged line end/);
});

test("the default sleep wakes promptly when the watch is aborted", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const running = watchOperation({
    load: () => state(),
    intervalMs: 5_000,
    signal: controller.signal,
    write: () => {},
    now: () => NOW,
  });
  setTimeout(() => controller.abort(), 25);
  const result = await running;
  const elapsed = Date.now() - started;
  assert.deepEqual(result, { renders: 1, stopped: "aborted" });
  assert.ok(elapsed < 1_000, `abort took ${elapsed} ms`);
});

test("watch clears the screen only when asked", async () => {
  const op = state();
  const writes: string[] = [];
  await watchOperation({ load: () => op, intervalMs: 0, sleep: async () => {}, write: (text) => writes.push(text), clear: true, maxRenders: 1, now: () => NOW });
  assert.equal(writes[0], "\x1b[2J\x1b[H");
  const plain: string[] = [];
  await watchOperation({ load: () => op, intervalMs: 0, sleep: async () => {}, write: (text) => plain.push(text), maxRenders: 1, now: () => NOW });
  assert.doesNotMatch(plain[0], /\x1b/);
});

const cliDir = fileURLToPath(new URL("..", import.meta.url));

interface CliFixture {
  root: string;
  home: string;
  workspace: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

function createCliFixture(): CliFixture {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "nexus-view-test-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    root,
    home,
    workspace,
    stateDir,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      NEXUS_STATE_DIR: stateDir,
      // Keep expected CLI styling out of these raw-control safety assertions.
      NO_COLOR: "1",
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function runCli(args: string[], fixture: CliFixture): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", path.join(cliDir, "src/index.ts"), ...args, "-w", fixture.workspace], {
      cwd: cliDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      env: fixture.env,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error: any) {
    return { status: Number(error?.status ?? -1), stdout: String(error?.stdout ?? ""), stderr: String(error?.stderr ?? "") };
  }
}

function assertNoUnsafeTerminalControls(output: string): void {
  // CLI styling is expected; only discard the known SGR styling form before checking controls from input data.
  const withoutSgr = output.replace(/\x1b\[[0-9;]*m/g, "");
  assert.doesNotMatch(withoutSgr, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
}

function saveFixture(fixture: CliFixture, id: string): string {
  const op = state();
  op.id = id;
  op.units[1].blocked!.decision.id = `d-${id}`;
  op.units[1].blocked!.decision.unitId = "u2";
  op.blocked!.decisions = [op.units[1].blocked!.decision];
  const store = new OperationStore(fixture.workspace, path.join(fixture.stateDir, "tasks"), fixture.home);
  store.save(op);
  return store.manager.getStateFilePath(id);
}

test("status --dag prints the view and --dag --json prints the same facts without writing the operation", (t) => {
  const fixture = createCliFixture();
  t.after(fixture.cleanup);
  const file = saveFixture(fixture, "op-cli-view");
  const before = { hash: createHash("sha256").update(fs.readFileSync(file)).digest("hex"), mtime: fs.statSync(file).mtimeMs };

  const text = runCli(["operation", "status", "--dag", "op-cli-view"], fixture);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Operation op-cli-view: BLOCKED/);
  assert.match(text.stdout, /Critical path: u2 → u3/);
  assert.match(text.stdout, /Decision needed:/);

  const json = runCli(["operation", "status", "--dag", "--json", "op-cli-view"], fixture);
  assert.equal(json.status, 0, json.stderr);
  const views = JSON.parse(json.stdout);
  assert.equal(views.length, 1);
  assert.equal(views[0].id, "op-cli-view");
  assert.deepEqual(views[0].dag.edges, [{ from: "u1", to: "u2" }, { from: "u2", to: "u3" }]);
  assert.equal(views[0].resources[0].eligible, true);

  const after = { hash: createHash("sha256").update(fs.readFileSync(file)).digest("hex"), mtime: fs.statSync(file).mtimeMs };
  assert.deepEqual(after, before, "the view path wrote the operation");
});

test("watch on a pipe renders one snapshot and exits non-zero while the operation is blocked", (t) => {
  const fixture = createCliFixture();
  t.after(fixture.cleanup);
  const file = saveFixture(fixture, "op-cli-watch");
  const before = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const result = runCli(["operation", "watch", "op-cli-watch"], fixture);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Operation op-cli-watch: BLOCKED/);
  assert.equal(createHash("sha256").update(fs.readFileSync(file)).digest("hex"), before);
});

test("watch on a pipe reports the operation's exit code for complete and cancelled", (t) => {
  for (const [id, status, expected] of [
    ["op-cli-watch-complete", "COMPLETE", 0],
    ["op-cli-watch-cancelled", "CANCELLED", 130],
  ] as const) {
    const fixture = createCliFixture();
    t.after(fixture.cleanup);
    const file = saveFixture(fixture, id);
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    record.status = "COMPLETE";
    record.operation.status = status;
    record.operation.blocked = undefined;
    for (const unit of record.operation.units) {
      unit.status = "COMPLETE";
      unit.blocked = undefined;
      unit.result = unit.result ?? { summary: "done", completedAt: "2026-10-28T11:30:00.000Z", resourceId: "primary", outcome: "VERIFIED" };
    }
    fs.writeFileSync(file, JSON.stringify(record));
    const result = runCli(["operation", "watch", id], fixture);
    assert.equal(result.status, expected, result.stderr);
  }
});

test("status and watch reject malformed or blank --events instead of guessing", (t) => {
  const fixture = createCliFixture();
  t.after(fixture.cleanup);
  saveFixture(fixture, "op-cli-events");
  for (const value of ["-1", "", "   "]) {
    for (const command of ["status", "watch"]) {
      const args = command === "status"
        ? ["operation", "status", "--dag", "--events", value, "op-cli-events"]
        : ["operation", "watch", "--events", value, "op-cli-events"];
      const result = runCli(args, fixture);
      assert.equal(result.status, 2, `${command} accepted ${JSON.stringify(value)}`);
      assert.match(result.stderr, /--events.*non-negative number/);
      assert.equal(result.stdout, "");
    }
  }
});

test("watch's multiple-operation list sanitizes persisted objectives", (t) => {
  const fixture = createCliFixture();
  t.after(fixture.cleanup);
  const first = saveFixture(fixture, "op-cli-list-a");
  const second = saveFixture(fixture, "op-cli-list-b");
  const record = JSON.parse(fs.readFileSync(second, "utf8"));
  record.operation.id = "op-cli-list-b\u001b]52;c;payload\u0007";
  record.operation.objective = "hostile\u001b]52;c;payload\u0007\u001b[2J forged\nline\tend\u009c";
  fs.writeFileSync(second, JSON.stringify(record));
  assert.ok(fs.existsSync(first));

  const result = runCli(["operation", "watch"], fixture);
  assert.equal(result.status, 2);
  const operationRows = result.stderr.split("\n").filter((line) => line.includes("  BLOCKED  "));
  assert.equal(operationRows.length, 2);
  assert.doesNotMatch(operationRows.join("\n"), /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
  assert.equal(result.stderr.split("\n").some((line) => line.startsWith("line")), false);
  assert.match(operationRows.join("\n"), /op-cli-list-b␛\]52;c;payload␇  BLOCKED/);
  assert.match(operationRows.join("\n"), /hostile.*forged line end<U\+009C>/);
});

test("ordinary status sanitizes blocked decision identifiers", (t) => {
  const fixture = createCliFixture();
  t.after(fixture.cleanup);
  const file = saveFixture(fixture, "op-cli-decision");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.operation.blocked.decisions[0].id = "decision\u001b]52;c;cGF5bG9hZA==\u0007\u001b[2J\u001b[31m";
  record.operation.blocked.decisions[0].options[0].id = "option\u001b]52;c;cGF5bG9hZA==\u0007\u001b[2J";
  record.operation.units[1].status = "BLOCKED\u001b[2J";
  fs.writeFileSync(file, JSON.stringify(record));

  const result = runCli(["operation", "status", "op-cli-decision"], fixture);
  assert.equal(result.status, 0);
  assertNoUnsafeTerminalControls(result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /decision␛\]52;c;cGF5bG9hZA==␇␛\[2J␛\[31m/);
});

test("rejected decisions sanitize the failing decision id", (t) => {
  const fixture = createCliFixture();
  t.after(fixture.cleanup);
  saveFixture(fixture, "op-cli-reject");

  const result = runCli(["operation", "decide", "op-cli-reject", "decision\u001b[2J", "1"], fixture);
  assert.equal(result.status, 2);
  assertNoUnsafeTerminalControls(result.stdout + result.stderr);
});

test("run sanitizes an operation id in its resume banner", (t) => {
  const fixture = createCliFixture();
  t.after(fixture.cleanup);
  const spec = path.join(fixture.root, "operation.json");
  fs.writeFileSync(spec, JSON.stringify({ id: "op-run\u001b]52;c;cGF5bG9hZA==\u0007", objective: "safe", units: [{ id: "u", prompt: "p" }] }));

  const result = runCli(["operation", "run", spec], fixture);
  assert.notEqual(result.status, 0);
  assertNoUnsafeTerminalControls(result.stdout + result.stderr);
});

test("status and watch sanitize invalid operation identifiers and event arguments", (t) => {
  const fixture = createCliFixture();
  t.after(fixture.cleanup);
  saveFixture(fixture, "op-cli-errors");
  for (const args of [
    ["operation", "status", "--dag", "missing\u001b[2J"],
    ["operation", "status", "--dag", "--events", "bad\u001b[2J", "op-cli-errors"],
    ["operation", "watch", "missing\u001b[2J"],
  ]) {
    const result = runCli(args, fixture);
    assert.notEqual(result.status, 0);
    assertNoUnsafeTerminalControls(result.stdout + result.stderr);
  }
});

test("run sanitizes resource and spec validation errors", (t) => {
  const fixture = createCliFixture();
  t.after(fixture.cleanup);
  const cases = [
    { id: "op-resource", objective: "safe", units: [{ id: "u", prompt: "p" }], resources: [{ id: "resource\u001b[2J", model: "m" }] },
    { id: "op-dependency", objective: "safe", units: [{ id: "u", prompt: "p", dependsOn: ["missing\u001b[2J"] }] },
  ];
  for (const [index, value] of cases.entries()) {
    const spec = path.join(fixture.root, `invalid-${index}.json`);
    fs.writeFileSync(spec, JSON.stringify(value));
    const result = runCli(["operation", "run", spec], fixture);
    assert.notEqual(result.status, 0);
    assertNoUnsafeTerminalControls(result.stdout + result.stderr);
  }
});

test("terminal-safe rendering: operation text cannot emit control or escape sequences", () => {
  const op = state();
  const evil = "safe\u001b]52;c;cGF5bG9hZA==\u0007\u001b[2Jafter\nforged\tline\u001b[31m";
  op.objective = evil;
  op.units[1].title = evil;
  op.units[1].blocked!.reason = evil;
  op.units[1].blocked!.decision.question = evil;
  op.units[1].blocked!.decision.options[0].label = evil;
  op.events[2].message = evil;
  const view = buildOperationView(op, { now: NOW });
  const rendered = renderOperationView(view, { width: 120 });
  assert.doesNotMatch(rendered, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
  assert.match(rendered, /safe/);
  // A newline in operation text is folded, so it cannot start a line that imitates an operation status line.
  const lines = rendered.split("\n");
  assert.equal(lines.some((line) => line.startsWith("forged")), false, "a folded newline must not start a line");
  for (const line of lines) assert.doesNotMatch(line, /[\r\t]/);
  assert.match(rendered, /after forged line/);
});

test("events are copied without their free-form detail", () => {
  const op = state();
  op.events[0].detail = { parked: { reason: "secret payload" } };
  const view = buildOperationView(op, { now: NOW });
  assert.deepEqual(Object.keys(view.events[0]).sort(), ["at", "message", "resourceId", "type", "unitId"]);
  assert.equal(JSON.stringify(view).includes("secret payload"), false);
  view.events[0].message = "changed";
  assert.equal(op.events[0].message.includes("u1 started"), true, "the view must not alias the operation");
});

type JsonSchema = {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  type?: string;
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

/** Minimal draft-2020-12 checker for the keywords the checked-in schema uses (with local $ref resolution). */
function validate(value: unknown, schema: JsonSchema, at: string, root: JsonSchema = schema): string[] {
  if (schema.$ref?.startsWith("#/$defs/")) {
    const target = root.$defs?.[schema.$ref.slice("#/$defs/".length)];
    if (!target) return [`${at}: unresolved $ref ${schema.$ref}`];
    return validate(value, target, at, root);
  }
  const errors: string[] = [];
  const typeOf = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.const !== undefined && value !== schema.const) errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((option) => option === value)) errors.push(`${at}: ${JSON.stringify(value)} is not in the enum`);
  if (schema.type) {
    const ok =
      schema.type === "integer" ? Number.isInteger(value) :
      schema.type === "number" ? typeof value === "number" :
      typeOf === schema.type;
    if (!ok) errors.push(`${at}: expected ${schema.type}, got ${typeOf}`);
  }
  if (schema.type === "object" && value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in record)) errors.push(`${at}: missing required '${key}'`);
    for (const [key, child] of Object.entries(record)) {
      const property = schema.properties?.[key];
      if (!property) {
        if (schema.additionalProperties === false) errors.push(`${at}: unexpected property '${key}'`);
        continue;
      }
      errors.push(...validate(child, property, `${at}.${key}`, root));
    }
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => errors.push(...validate(item, schema.items!, `${at}[${index}]`, root)));
  }
  return errors;
}

test("the --json document satisfies the checked-in JSON schema", () => {
  const schemaPath = fileURLToPath(new URL("../../docs/v1.1.0/operation-view.schema.json", import.meta.url));
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as JsonSchema;
  assert.equal(schema.type, "array");
  assert.equal(schema.items?.$ref, "#/$defs/view");

  const op = state();
  op.units[0].agentTaskId = "task-u1";
  op.units[0].assignment = { resourceId: "primary", model: "model-primary", since: "2026-10-28T10:59:00.000Z" };
  op.units[0].status = "COMPLETE";
  op.units[0].blocked = undefined;
  op.units[1].parked = { since: "2026-10-28T11:00:00.000Z", reason: "rate limited", resourceIds: ["primary"], wakeAt: "2026-10-28T11:05:00.000Z" };
  op.wait = { since: "2026-10-28T11:00:00.000Z", wakeAt: "2026-10-28T11:05:00.000Z", reason: "rate limited", parkedUnits: ["u2"] };
  op.resources[1].contextLength = 200_000;
  op.resources[1].taskClass = "review";

  op.units[2].status = "RUNNABLE";
  op.units[0].contextBudget = 120_000;
  op.units[0].context = { estimatedPromptTokens: 42_000, budgetTokens: 120_000, contextLimit: 200_000, at: "2026-10-28T11:30:00.000Z" };
  op.contextCheckpoints = [
    { unitId: "u1", name: "before-refactor", at: "2026-10-28T11:30:00.000Z", taskId: "task-u1", messages: 12, bytes: 4096, sha256: "a".repeat(64), files: [{ name: "task", bytes: 4096, sha256: "a".repeat(64) }] },
  ];
  op.git = {
    isolate: true,
    repoRoot: "/repo",
    baseRef: "HEAD",
    baseCommit: "a".repeat(40),
    integrationBranch: "nexus/op-op-view/integration",
    integrationWorktree: "/repo/.nexus/worktrees/op-op-view/integration",
    baseDir: "/repo/.nexus/worktrees/op-op-view",
    units: {},
  };
  op.integrations = [
    {
      unitId: "u1",
      branch: "nexus/op-op-view/u1",
      commit: "b".repeat(40),
      integratedCommit: "c".repeat(40),
      mergedAt: "2026-10-28T11:20:00.000Z",
      files: ["src/value.ts"],
      outcome: "VERIFIED",
      summary: "done",
      verification: "PASSED",
    },
  ];
  const key = scopeKey(op.resources[0], "model");
  op.conditions = [
    {
      scope: "model",
      key: key!,
      condition: "RATE_LIMITED",
      temporary: true,
      recheckAt: "2026-10-28T12:05:00.000Z",
      source: "backoff",
      confidence: "derived",
      reason: "rate limited (HTTP 429)",
      observedAt: "2026-10-28T11:59:00.000Z",
      failures: 1,
      resourceId: "primary",
    },
  ];

  const view = buildOperationView(op, { now: NOW });
  assert.equal(view.counts.ready, 1);
  assert.equal(view.resources[0].blocking?.length, 1);
  const document = JSON.parse(JSON.stringify([view]));
  assert.deepEqual(validate(document, schema, "views"), []);

  // The schema must reject the shapes the projection deliberately removed.
  const withDetail = [{ ...view, events: [{ ...view.events[0], detail: { secret: true } }] }];
  assert.notDeepEqual(validate(JSON.parse(JSON.stringify(withDetail)), schema, "views"), []);
});

test("a corrupt record is reported cleanly and quarantined by the shared loader", (t) => {
  const fixture = createCliFixture();
  t.after(fixture.cleanup);
  const file = saveFixture(fixture, "op-cli-corrupt");
  fs.writeFileSync(file, "{ not json");
  const result = runCli(["operation", "status", "--dag", "op-cli-corrupt"], fixture);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Cannot read operation op-cli-corrupt: Corrupt state/);
  assert.doesNotMatch(result.stderr, /\n\s+at .*node:internal/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.startsWith("op-cli-corrupt.json.corrupt-")), true);
});

test("projects the operation's git isolation and unit integration receipts", () => {
  const op = state();
  op.git = {
    isolate: true,
    repoRoot: "/repo",
    baseRef: "HEAD",
    baseCommit: "a".repeat(40),
    integrationBranch: "nexus/op-op-view-123456/integration",
    integrationWorktree: "/repo/.nexus/worktrees/op-op-view-123456/integration",
    baseDir: "/repo/.nexus/worktrees/op-op-view-123456",
    units: {},
  };
  op.integrations = [
    {
      unitId: "u1",
      branch: "nexus/op-op-view-123456/u1-abcdef",
      commit: "b".repeat(40),
      integratedCommit: "c".repeat(40),
      mergedAt: "2026-10-28T11:20:00.000Z",
      files: ["src/value.ts"],
      outcome: "VERIFIED",
      summary: "done",
      verification: "PASSED",
    },
  ];
  const view = buildOperationView(op, { now: NOW });
  assert.deepEqual(view.git, {
    integrationBranch: "nexus/op-op-view-123456/integration",
    integrationWorktree: "/repo/.nexus/worktrees/op-op-view-123456/integration",
  });
  assert.deepEqual(view.units[0].integration, {
    commit: "b".repeat(40),
    integratedCommit: "c".repeat(40),
    mergedAt: "2026-10-28T11:20:00.000Z",
    files: ["src/value.ts"],
    verification: "PASSED",
  });
  assert.equal(view.units[1].integration, undefined);

  op.units[0].contextBudget = 120_000;
  op.units[0].context = { estimatedPromptTokens: 42_000, budgetTokens: 120_000, contextLimit: 200_000, at: "2026-10-28T11:30:00.000Z" };
  const withContext = buildOperationView(op, { now: NOW });
  assert.equal(withContext.units[0].contextBudget, 120_000);
  assert.deepEqual(withContext.units[0].context, {
    estimatedPromptTokens: 42_000,
    budgetTokens: 120_000,
    contextLimit: 200_000,
    at: "2026-10-28T11:30:00.000Z",
  });
  assert.match(renderOperationView(withContext, { width: 120 }), /context 42000 tokens \(effective cap 120000\)/);

  // The effective cap is the smaller of the operator's budget and the resource's advertised limit.
  op.units[0].context = { estimatedPromptTokens: 42_000, budgetTokens: 500_000, contextLimit: 200_000, at: "2026-10-28T11:30:00.000Z" };
  assert.match(renderOperationView(buildOperationView(op, { now: NOW }), { width: 120 }), /context 42000 tokens \(effective cap 200000\)/);

  op.contextCheckpoints = [
    { unitId: "u1", name: "before-refactor", at: "2026-10-28T11:30:00.000Z", taskId: "task-u1", messages: 12, bytes: 4096, sha256: "a".repeat(64), files: [{ name: "task", bytes: 4096, sha256: "a".repeat(64) }] },
  ];
  const withCheckpoints = buildOperationView(op, { now: NOW });
  assert.deepEqual(withCheckpoints.checkpoints, [
    { unitId: "u1", name: "before-refactor", at: "2026-10-28T11:30:00.000Z", messages: 12 },
  ]);
  assert.match(renderOperationView(withCheckpoints, { width: 120 }), /Checkpoints\n  u1\/before-refactor · 12 messages/);
  const rendered = renderOperationView(view, { width: 120 });
  assert.match(rendered, /isolated: nexus\/op-op-view-123456\/integration/);
  assert.match(rendered, /u1 \[implementer\] Implement the projector\s+COMPLETE.*integrated cccccccccccc/);
});
