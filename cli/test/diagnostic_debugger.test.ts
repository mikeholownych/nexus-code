// A failure_debugger on a diagnostic snapshot is completed by its diagnosis, not by the verifier that fails there.
// Real AutonomousAgent over the mock gateway: the agent's own completion oracle is what is under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AgentWorkUnitExecutor } from "../src/core/operation_runner_execution.js";
import { startGateway, type Reply } from "./helpers/fixtures.js";

const VERIFIER = "env -u NODE_TEST_CONTEXT node --test test/value.test.js";

function failingRepo(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-diag-ws-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: r, stdio: "ignore" });
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  fs.mkdirSync(path.join(r, "test")); fs.mkdirSync(path.join(r, "src"));
  fs.writeFileSync(path.join(r, "src/value.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(r, "test/value.test.js"), "const t=require('node:test');const a=require('node:assert');t('v',()=>a.equal(require('../src/value.js'),2));\n");
  fs.writeFileSync(path.join(r, "package.json"), JSON.stringify({ name: "x", scripts: { test: VERIFIER } }));
  g("add", "."); g("commit", "-qm", "snapshot (failing)");
  return r;
}

const report = JSON.stringify({ specialistRole: "failure_debugger", status: "SUCCESS", summary: "root cause: value.js exports 1", findings: {}, evidence: [{ path: "src/value.js", note: "n" }], escalationRecommended: false });

for (const configured of [true, false]) {
  for (const diagnostic of [true, false]) {
    test(`a debugger that writes a repro file via run_command (authoritative verifier: ${configured}, diagnostic: ${diagnostic}) ${diagnostic ? "completes" : "stays gated"}`, async () => {
      const ws = failingRepo();
      const gw = await startGateway((n): Reply => n === 1
        ? { kind: "tools", calls: [{ name: "run_command", args: { command: "echo repro > repro_notes.txt" } }] }
        : { kind: "tools", calls: [{ name: "task_completed", args: { summary: report } }] });
      const executor = new AgentWorkUnitExecutor({
        baseConfig: {
          endpoint: gw.url, model: "m", workspace: ws, shell: "bash", maxSteps: 8, temperature: 0, approvalMode: "auto", fullAccess: true,
          ...(configured ? { authoritativeVerifierCommand: VERIFIER } : {}),
        } as any,
      });
      const unit: any = { id: "u1", title: "dbg", role: "failure_debugger", prompt: "diagnose", dependsOn: [], requires: {}, status: "RUNNABLE", reroutes: [], runs: 0, unknownResumes: 0, modelsUsed: [], inputs: {} };
      const deps = [{ id: "t", title: "Tests", summary: "1 failed", verification: { command: VERIFIER, status: "FAILED", hasExecutedTests: true }, failed: true as const }];
      try {
        const out: any = await executor.run(unit, { id: "primary", endpoint: gw.url, provider: new URL(gw.url).origin, model: "m", capabilities: ["tools"], rank: 0 } as any,
          { objective: "x", dependencies: deps, bindAgentTask: () => {}, observeFailure: () => null, observeSuccess: () => {}, shouldYield: () => false, workspace: ws, ...(diagnostic ? { diagnostic: true as const } : {}) } as any);
        if (diagnostic) assert.equal(out.kind, "completed", JSON.stringify(out).slice(0, 400));
        else assert.equal(out.kind, "failed", "a debugger on the live tree is still gated by the verifier");
      } finally {
        await gw.close();
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });
  }
}
