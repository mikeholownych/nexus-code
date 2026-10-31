import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OperationStore } from "../src/core/operation_runner.js";
import { ConvergenceScheduler } from "../src/core/scheduler.js";
import { ResourceRegistry } from "../src/core/resources.js";
import { newOperation, type DurableOperationState } from "../src/core/operation.js";
import {
  CURRENT_OPERATION_SCHEMA_VERSION,
  InvalidOperationStateError,
  UnsupportedOperationSchemaError,
  effectiveConcurrency,
  migrateOperationState,
  validateOperationState,
} from "../src/core/operation_schema.js";
import { validateOperationSpec, OperationSpecError } from "../src/operation_cli.js";
import { buildOperationView, renderOperationView } from "../src/operation_view.js";
import type { ResourceDescriptor } from "../src/core/resources.js";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resource(id: string, overrides: Partial<ResourceDescriptor> = {}): ResourceDescriptor {
  return { id, provider: "https://api.test", endpoint: "https://api.test/v1", model: `model-${id}`, capabilities: ["tools"], rank: 0, ...overrides };
}

function state(): DurableOperationState {
  return newOperation(
    "op-schema",
    "Exercise the operation schema",
    [
      { id: "impl", prompt: "Implement it", role: "implementer" },
      { id: "test", prompt: "Test it", role: "tester", dependsOn: ["impl"] },
    ],
    [resource("primary"), resource("secondary", { rank: 1 })],
    NOW,
  );
}

/** The v1.0.0 document shape: current fields removed, schemaVersion 1. */
function asV1Document(op: DurableOperationState): any {
  const raw: any = JSON.parse(JSON.stringify(op));
  raw.schemaVersion = 1;
  delete raw.messages;
  delete raw.policy.maxConcurrentUnits;
  for (const unit of raw.units) delete unit.contextBudget;
  for (const r of raw.resources) delete r.maxConcurrentUnits;
  return raw;
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-v11-schema-"));
}

test("a v1 operation document migrates by adding the schema version and nothing else", () => {
  const v1 = asV1Document(state());
  const before = JSON.parse(JSON.stringify(v1));
  const migrated = migrateOperationState(v1);

  assert.equal(migrated.schemaVersion, CURRENT_OPERATION_SCHEMA_VERSION);
  assert.deepEqual({ ...migrated, schemaVersion: 1 }, before, "the migration changed more than the schema version");
  assert.deepEqual(v1, before, "the migration mutated its input");
  assert.equal(migrated.messages, undefined, "the migration must not materialise optional collections");
  assert.equal(migrated.policy.maxConcurrentUnits, undefined, "an unset limit must stay unset so v1 schedules as before");
});

test("the migrated state schedules exactly as the v1 state did", () => {
  const v1 = asV1Document(state());
  const migrated = migrateOperationState(v1);
  assert.deepEqual(
    migrated.units.map((u) => ({ id: u.id, dependsOn: u.dependsOn, status: u.status })),
    (v1.units as Array<{ id: string; dependsOn: string[]; status: string }>).map((u) => ({ id: u.id, dependsOn: u.dependsOn, status: u.status })),
  );
  assert.equal(effectiveConcurrency(migrated), 1);

  // The criterion is about scheduling, not shape: run the real scheduler over both and compare the due-sets.
  const decide = (op: DurableOperationState) => {
    const clock = { now: () => NOW };
    const scheduler = new ConvergenceScheduler(op, new ResourceRegistry(op.resources, op.conditions, clock), clock.now);
    const decision = scheduler.decide();
    assert.equal(decision.kind, "run");
    return decision.kind === "run" ? decision.assignments.map((a) => [a.unit.id, a.resource.id]) : [];
  };
  assert.deepEqual(decide(migrated), decide(asV1Document(state()) as DurableOperationState));
});

test("a record from a newer build is refused, not quarantined", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new OperationStore(dir, path.join(dir, "tasks"), dir);
  const op = state();
  store.save(op);
  const file = store.manager.getStateFilePath(op.id);

  // Simulate a record written by a later build.
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  raw.operation.schemaVersion = CURRENT_OPERATION_SCHEMA_VERSION + 1;
  fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });

  assert.throws(() => store.load(op.id), UnsupportedOperationSchemaError);
  // Every load path must agree; a status listing must not silently drop the operation either.
  assert.throws(() => store.loadForInspection(op.id), UnsupportedOperationSchemaError);
  assert.throws(() => store.list(), UnsupportedOperationSchemaError);
  assert.ok(fs.existsSync(file), "a newer record must stay readable, not be renamed away");
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".corrupt-")), []);
});

test("a non-integer or impossible version is an invalid record, not a newer one", () => {
  for (const version of ["2", 1.5, -1, null]) {
    assert.throws(() => migrateOperationState({ ...asV1Document(state()), schemaVersion: version }), InvalidOperationStateError, String(version));
  }
});

test("structural invariants name the field and the unit", () => {
  const base = state();
  const cases: Array<[string, (op: DurableOperationState) => void, RegExp]> = [
    ["duplicate id", (op) => { op.units[1].id = op.units[0].id; }, /duplicate work unit id 'impl'/],
    ["unknown dependency", (op) => { op.units[1].dependsOn = ["nope"]; }, /depends on unknown unit 'nope'/],
    ["zero budget", (op) => { op.units[0].contextBudget = 0; }, /unit 'impl' has an invalid contextBudget/],
    ["bad policy limit", (op) => { op.policy.maxConcurrentUnits = 0; }, /policy.maxConcurrentUnits must be an integer from 1 to 64/],
    ["bad resource slot", (op) => { op.resources[0].maxConcurrentUnits = 99; }, /resource 'primary'.maxConcurrentUnits/],
    ["bad receipt", (op) => { op.integrations = [{ unitId: "impl" } as any]; }, /missing its unitId or integratedCommit/],
  ];
  for (const [label, mutate, expected] of cases) {
    const op = JSON.parse(JSON.stringify(base)) as DurableOperationState;
    mutate(op);
    assert.throws(() => validateOperationState(op), expected, label);
  }
});

test("a resource slot count out of range is refused at creation, so the record can always be reloaded", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const value of [0, 65, 1.5]) {
    assert.throws(
      () => newOperation("op", "o", [{ id: "u1", prompt: "x" }], [resource("r1", { maxConcurrentUnits: value })], NOW),
      /resource 'r1'.maxConcurrentUnits must be an integer from 1 to 64/,
    );
  }
  // A value the spec validator refuses must never reach the store; if it did, every later load would fail.
  assert.throws(() => validateOperationSpec({ objective: "o", units: [{ id: "u1", prompt: "x" }], resources: [{ id: "r1", endpoint: "https://a.test", model: "m", maxConcurrentUnits: 0 }] }), OperationSpecError);
});

test("newOperation rejects an out-of-range concurrency and accepts a valid one", () => {
  const spec = [{ id: "u1", prompt: "do it" }];
  for (const value of [0, -1, 1.5, 65, 1000]) {
    assert.throws(() => newOperation("op", "o", spec, [resource("r")], NOW, { maxConcurrentUnits: value }), /maxConcurrentUnits/);
  }
  assert.equal(newOperation("op", "o", spec, [resource("r")], NOW, { maxConcurrentUnits: 2 }).policy.maxConcurrentUnits, 2);
});

test("the store keeps a byte-identical pre-migration copy before the first v2 write", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const baseDir = path.join(dir, "tasks");
  const store = new OperationStore(dir, baseDir, dir);
  const op = state();
  store.save(op);
  const file = store.manager.getStateFilePath(op.id);

  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  raw.operation = asV1Document({ ...op, id: op.id });
  const v1Bytes = Buffer.from(JSON.stringify(raw));
  fs.writeFileSync(file, v1Bytes, { mode: 0o600 });

  const loaded = store.load(op.id);
  assert.equal(loaded.schemaVersion, CURRENT_OPERATION_SCHEMA_VERSION);
  store.save(loaded);

  const backup = `${file}.pre-migration-v1`;
  assert.ok(fs.existsSync(backup), "a pre-migration copy must exist");
  assert.deepEqual(fs.readFileSync(backup), v1Bytes, "the copy must be the exact record that was migrated");

  // A second save must not replace the backup with the migrated bytes.
  store.save(store.load(op.id));
  assert.deepEqual(fs.readFileSync(backup), v1Bytes);
});

test("an existing pre-migration copy with different content fails the save closed", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new OperationStore(dir, path.join(dir, "tasks"), dir);
  const op = state();
  store.save(op);
  const file = store.manager.getStateFilePath(op.id);
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  raw.operation = asV1Document({ ...op, id: op.id });
  fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });
  fs.writeFileSync(`${file}.pre-migration-v1`, "not the record", { mode: 0o600 });

  assert.throws(() => store.save(store.load(op.id)), /already exists with different content/);
  assert.equal(fs.readFileSync(`${file}.pre-migration-v1`, "utf-8"), "not the record");
});

test("the spec validator rejects publish, unknown keys and a bad limit with an actionable message", () => {
  const valid = {
    objective: "Ship it",
    git: { isolate: true },
    policy: { maxConcurrentUnits: 2 },
    units: [{ id: "u1", prompt: "do it", role: "implementer", requires: { independentOf: [] } }],
    resources: [{ id: "r1", endpoint: "https://api.test", model: "m" }],
  };
  assert.doesNotThrow(() => validateOperationSpec(valid));
  assert.doesNotThrow(() => validateOperationSpec(JSON.parse(JSON.stringify(valid))));

  const cases: Array<[unknown, RegExp]> = [
    [{ ...valid, git: { isolate: true, publish: "pr" } }, /git\.publish is not supported in this version/],
    [{ ...valid, units: [{ id: "u1", prompt: "x", depends: ["u2"] }] }, /unknown unit 'u1' key 'depends' \(did you mean 'dependsOn'\?\)/],
    [{ ...valid, unitz: [] }, /unknown spec key 'unitz'/],
    [{ ...valid, policy: { maxConcurrent: 2 } }, /unknown policy key 'maxConcurrent'/],
    [{ ...valid, policy: { maxConcurrentUnits: 0 } }, /must be an integer from 1 to 64/],
    [{ ...valid, units: [{ id: "u1", prompt: "x", role: "wizard" }] }, /unknown role 'wizard'/],
    [{ ...valid, units: [{ id: "u1", prompt: "x", requires: { minContexts: 1 } }] }, /unknown unit 'u1' requires key 'minContexts'/],
    [{ ...valid, units: [] }, /non-empty 'units' array/],
    [{ ...valid, resources: [{ id: "r1", endpoint: "https://api.test", model: "m", maxConcurrentUnits: 99 }] }, /resource 'r1'.maxConcurrentUnits must be an integer from 1 to 64/],
    [{ ...valid, objective: "  " }, /non-empty 'objective'/],
  ];
  for (const [spec, expected] of cases) {
    assert.throws(() => validateOperationSpec(spec), expected);
  }
});

test("the CLI refuses a spec with git.publish before creating an operation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-v11-spec-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  const stateDir = path.join(root, "state");
  const specPath = path.join(root, "op.json");
  fs.writeFileSync(
    specPath,
    JSON.stringify({ objective: "Ship it", git: { isolate: true, publish: "pr" }, units: [{ id: "u1", prompt: "do it" }] }),
  );

  let status = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, ["--import", "tsx", path.join(cliDir, "src/index.ts"), "operation", "run", specPath, "-w", workspace], {
      cwd: cliDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      env: { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, ".config"), NEXUS_STATE_DIR: stateDir, NO_COLOR: "1" },
    });
  } catch (error: any) {
    status = Number(error?.status ?? -1);
    stderr = String(error?.stderr ?? "");
  }
  assert.equal(status, 2, stderr);
  assert.match(stderr, /git\.publish is not supported in this version/);
  assert.deepEqual(fs.existsSync(path.join(stateDir, "tasks")) ? fs.readdirSync(path.join(stateDir, "tasks")) : [], []);
});

test("a tampered status renders as visible control pictures, never as an escape sequence", () => {
  const op = state();
  const hostile = `\u001b]52;c;${Buffer.from("evil").toString("base64")}\u0007`;
  op.status = hostile as any;
  op.units[0].status = hostile as any;
  const rendered = renderOperationView(buildOperationView(op), { width: 200 });
  assert.doesNotMatch(rendered, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
  assert.match(rendered, /␛/);
});

test("ACC-V11-SCHEMA-04: an invalid operation document is quarantined on load, never silently skipped", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new OperationStore(dir, path.join(dir, "tasks"), dir);
  const op = state();
  store.save(op);
  const file = store.manager.getStateFilePath(op.id);
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  raw.operation.units[0].contextBudget = 0;
  fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });

  assert.throws(() => store.load(op.id), /is invalid: .*contextBudget.*quarantined to/);
  assert.equal(fs.existsSync(file), false, "the invalid record must be moved aside");
  assert.equal(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".corrupt-")).length, 1);
});
