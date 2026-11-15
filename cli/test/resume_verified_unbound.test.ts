/**
 * VC-5: what a resumed task may still claim.
 *  (a) a requirement `verified` on one workspace state is demoted on resume when the workspace has since changed
 *      (candidate identity differs from the one the verifier run was recorded on);
 *  (b) after a restart following an unbound-verifier pass the resumed task is not refused for "no matching pre-change
 *      baseline": it completes REGRESSION_FREE (the unbound marker survives; it can only weaken a claim, never VERIFIED).
 */
import "./helpers/leak_guard.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { computeCandidateIdentitySync } from "../src/core/candidate.js";
import { DurableStateManager } from "../src/core/state.js";
import { WorkspacePath } from "../src/core/workspace_path.js";
import { createLedger } from "../src/core/objective.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, Reply } from "./helpers/fixtures.js";

const quiet = (agent: AutonomousAgent): AutonomousAgent => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (endpoint: string, workspace: string): HarnessConfig => ({
  endpoint,
  model: "m",
  maxSteps: 30,
  temperature: 0,
  workspace,
  shell: "bash",
  approvalMode: "auto",
  fullAccess: true,
  continuation: { ...DEFAULT_CONTINUATION, maxCompletionNudges: 0 },
});
const write = (name: string, content: string): Reply => ({
  kind: "tools",
  calls: [{ name: "write_file", args: { path: name, content, overwrite: true } }],
});
const done: Reply = { kind: "tools", calls: [{ name: "task_completed", args: { summary: "done" } }] };

const PKG = JSON.stringify({ name: "x", version: "1.0.0", private: true, main: "./math.js", scripts: { test: "env -u NODE_TEST_CONTEXT node --test test/*.test.js" } });
const ADD_TEST = 'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { add } = require("../math.js");\ntest("adds", () => assert.equal(add(2, 3), 5));\n';

function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-resume-vc5-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: root, stdio: "ignore" });
  return root;
}

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-resume-vc5-home-"));
  try {
    return await fn();
  } finally {
    fs.rmSync(process.env.HOME!, { recursive: true, force: true });
    process.env.HOME = saved;
  }
}

describe("VC-5 resume", () => {
  test("a verified requirement is demoted on resume when the workspace changed since verification", async () => {
    await withHome(async () => {
      const root = repo({ "package.json": PKG, "math.js": "exports.add = (a, b) => a + b;\n" });
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-resume-vc5-state-"));
      const gw = await startGateway(() => ({ kind: "text", content: "done" }));
      const agents: AutonomousAgent[] = [];
      const durable = (): any => {
        const a = quiet(new AutonomousAgent(cfg(gw.url, root), 1, undefined, { durable: true, role: "implementer", unitId: "vc5-unit" }));
        agents.push(a);
        const x = a as any;
        x.stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [WorkspacePath.fromSelectedWorkspace(root)] });
        return x;
      };
      try {
        const first = durable();
        const ledger = createLedger("add");
        ledger.requirements = [];
        ledger.requirements.push({ id: "R1", kind: "feature", text: "adds", status: "verified", evidence: ["ok"], verifiedBy: { attempt: 1, command: "npm test", inputs: computeCandidateIdentitySync(root).candidateId, at: new Date().toISOString() }, updatedAt: new Date().toISOString() } as any);
        ledger.requirements.push({ id: "R2", kind: "feature", text: "adds2", status: "verified", evidence: ["ok"], verifiedBy: { attempt: 1, command: "npm test", inputs: "stale-identity", at: new Date().toISOString() }, updatedAt: new Date().toISOString() } as any);
        first.objective = ledger;
        first.checkpointDurableState("verified ledger");
        const taskId = first.getTaskId();

        // Unchanged workspace: a requirement whose run matches the current identity stays verified.
        const same = durable();
        await same.recoverFromTaskState(taskId);
        const byId = (a: any, id: string) => a.objective.requirements.find((r: any) => r.id === id);
        assert.equal(byId(same, "R1").status, "verified");
        assert.equal(byId(same, "R2").status, "implemented", "a run on a different identity is not carried over");
        assert.match(byId(same, "R2").note, /verification invalidated/);

        // Edited workspace: every verified requirement is demoted.
        fs.writeFileSync(path.join(root, "math.js"), "exports.add = (a, b) => b + a;\n");
        const edited = durable();
        await edited.recoverFromTaskState(taskId);
        assert.equal(byId(edited, "R1").status, "implemented");
        assert.equal(byId(edited, "R1").verifiedBy, undefined);
        assert.match(byId(edited, "R1").note, /verification invalidated: .*changed/);
      } finally {
        for (const a of agents) a.shutdown();
        await gw.close();
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    });
  });

  test("resume after an unbound pass completes REGRESSION_FREE, not refused for a missing baseline", { timeout: 90_000 }, async () => {
    await withHome(async () => {
      const root = repo({ "package.json": PKG, "test/math.test.js": ADD_TEST, "node_modules/.bin/.keep": "", "math.js": "exports.add = (a, b) => a - b;\n" });
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-resume-vc5-state-"));
      const steps: Reply[] = [write("math.js", "exports.add = (a, b) => a + b;\n"), done, write("math.js", "exports.add = (a, b) => b + a;\n"), done];
      const gw = await startGateway((n) => steps[n - 1] ?? { kind: "text", content: "done" });
      const agents: AutonomousAgent[] = [];
      const durable = (): any => {
        const a = quiet(new AutonomousAgent(cfg(gw.url, root), 1, undefined, { durable: true, role: "implementer", unitId: "vc5-unit" }));
        agents.push(a);
        const x = a as any;
        x.stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [WorkspacePath.fromSelectedWorkspace(root)] });
        return x;
      };
      try {
        const first = durable();
        const turn1 = await first.runTurn("Fix math.js.");
        assert.equal(turn1.outcome, "REGRESSION_FREE", JSON.stringify({ r: turn1.reason, d: turn1.detail }));
        first.checkpointDurableState("after unbound pass");
        const taskId = first.getTaskId();

        const second = durable();
        await second.recoverFromTaskState(taskId);
        assert.equal(second.changeBaseline, null, "the recovered baseline itself is still never trusted");
        const turn2 = await second.runTurn("Finish.");
        assert.doesNotMatch(turn2.verification?.independenceDetail ?? "", /no matching pre-change baseline/);
        assert.equal(turn2.outcome, "REGRESSION_FREE", JSON.stringify({ r: turn2.reason, d: turn2.detail, m: second.turnMutations }));
        assert.equal(turn2.verification?.definitionBound, false);
      } finally {
        for (const a of agents) a.shutdown();
        await gw.close();
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    });
  });

  test("a forged marker cannot excuse a verifier whose definition is bindable now", { timeout: 90_000 }, async () => {
    await withHome(async () => {
      const root = repo({ "package.json": PKG, "test/math.test.js": ADD_TEST, "math.js": "exports.add = (a, b) => a + b;\n" });
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-resume-vc5-state-"));
      const gw = await startGateway(() => done);
      const agents: AutonomousAgent[] = [];
      try {
        const first = quiet(new AutonomousAgent(cfg(gw.url, root), 1, undefined, { durable: true, role: "implementer", unitId: "vc5-unit" }));
        agents.push(first);
        const f = first as any;
        const manager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [WorkspacePath.fromSelectedWorkspace(root)] });
        f.stateManager = manager;
        f.changeBaseline = { command: "npm test", failed: false, tests: new Map(), verifier: null, verifierUnbindableReason: "forged", trustedDeliverables: [], at: new Date().toISOString() };
        f.hasPendingModifications = true;
        f.checkpointDurableState("forged marker");
        const second = quiet(new AutonomousAgent(cfg(gw.url, root), 1, undefined, { durable: true, role: "implementer", unitId: "vc5-unit" }));
        agents.push(second);
        (second as any).stateManager = manager;
        await second.recoverFromTaskState(f.getTaskId());
        const turn = await second.runTurn("Finish.");
        assert.equal(turn.outcome, "NOT_ESTABLISHED");
        assert.match(turn.verification?.independenceDetail ?? "", /no matching pre-change baseline/);
      } finally {
        for (const a of agents) a.shutdown();
        await gw.close();
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    });
  });
});
