import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BatchPlanStore, parseBatchPlan, validateBatchPlan } from "../src/batch_plan.js";
import { validateBatchSpec } from "../src/batch_spec.js";

function fixture(t: { after(callback: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "batch-plan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = fs.mkdirSync(path.join(root, "work"), { recursive: true })!;
  const state = path.join(root, "state");
  return { root, workspace, state };
}

const check = { id: "test", command: "npm test", cwd: ".", expectation: "Exit successfully", timeoutSeconds: 60, required: true };
function plan() {
  return {
    version: 1,
    objective: "  Add tests and implementation  ",
    acceptanceCriteria: ["Tests pass"],
    checks: [check],
    risks: [],
    assumptions: [],
    blockers: [],
    units: [
      { id: "test", title: "Write tests", objective: "Cover regression", role: "implementer", required: true,
        dependsOn: [], mode: "write", scope: ["./test/"], acceptanceCriteria: ["Tests cover contract"], checks: [check],
        outputs: ["Tests"], handoffs: [] },
      { id: "implement", title: "Implement fix", objective: "Make tests pass", role: "implementer", required: true,
        dependsOn: ["test"], mode: "write", scope: ["src"], acceptanceCriteria: ["Build passes"], checks: [check],
        outputs: ["Implementation"], handoffs: ["test"] },
    ],
  };
}

test("normalizes a bounded plan without making it a runnable batch", (t) => {
  const { workspace } = fixture(t);
  const normalized = validateBatchPlan(plan(), workspace);
  assert.equal(normalized.objective, "Add tests and implementation");
  assert.deepEqual(normalized.units[0].scope, ["test"]);
  assert.throws(() => validateBatchSpec(normalized), /unknown spec key 'version'/);
});

test("rejects unsafe plans before persisting anything", (t) => {
  const { root, workspace, state } = fixture(t);
  fs.symlinkSync(root, path.join(workspace, "outside"));
  const store = new BatchPlanStore(workspace, state);
  const cases: Array<[(input: ReturnType<typeof plan>) => void, RegExp]> = [
    [(input) => { input.units[0].dependsOn = ["implement"]; }, /cycle/i],
    [(input) => { input.units[0].required = false; }, /advisory/],
    [(input) => { input.units[0].scope = ["../out"]; }, /relative/],
    [(input) => { input.units[0].scope = ["outside/child"]; }, /symbolic link/],
    [(input) => { input.units[1].dependsOn = []; input.units[1].handoffs = []; input.units[1].scope = ["test/data"]; }, /overlap/],
    [(input) => { input.units[1].handoffs = ["other"]; }, /handoff/],
    [(input) => { input.units[0].role = "unknown"; }, /unknown role/],
    [(input) => { input.acceptanceCriteria = []; }, /acceptanceCriteria/],
    [(input) => { Object.assign(input, { policy: { allowFallback: true } }); }, /unknown key 'policy'/],
  ];
  for (const [mutate, expected] of cases) {
    const input = plan();
    mutate(input);
    assert.throws(() => store.create(input), expected);
  }
  assert.equal(fs.existsSync(state), false);
});

test("persists a private draft, binds it to its workspace, and detects edits to the stored record", (t) => {
  const { root, workspace, state } = fixture(t);
  const store = new BatchPlanStore(workspace, state);
  const draft = store.create(plan());
  assert.match(draft.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(new BatchPlanStore(workspace, state).read(draft.id), draft);
  assert.throws(() => store.read("../outside"), /draft id/);
  const other = fs.mkdirSync(path.join(root, "other"), { recursive: true })!;
  assert.throws(() => new BatchPlanStore(other, state).read(draft.id));
  const [dir] = fs.readdirSync(state);
  const file = path.join(state, dir, `${draft.id}.json`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, JSON.stringify({ ...draft, plan: { ...draft.plan, objective: "Changed" } }));
  assert.throws(() => store.read(draft.id), /digest/);
});

test("parses model output strictly and retains routing provenance in the immutable draft", (t) => {
  const { workspace, state } = fixture(t);
  const serialized = JSON.stringify(plan());
  assert.throws(() => parseBatchPlan(serialized.replace('"version":1', '"version":2,"version":1'), workspace), /duplicate/i);
  assert.throws(() => parseBatchPlan(" ".repeat(256 * 1024 + 1), workspace), /size limit/);
  const store = new BatchPlanStore(workspace, state);
  const provenance = { resourceId: "cloud-runner", model: "test-model", disclosure: "cloud", fallbackFrom: "local-default" } as const;
  const draft = store.create(parseBatchPlan(serialized, workspace), provenance);
  assert.deepEqual(store.read(draft.id).provenance, provenance);
  const [dir] = fs.readdirSync(state);
  const file = path.join(state, dir, `${draft.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...draft, provenance: { ...provenance, disclosure: "local" } }));
  assert.throws(() => store.read(draft.id), /digest/);
});
