import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutonomousAgent } from "../src/agent.js";
import { DurableStateManager } from "../src/core/state.js";
import { SecurityManager } from "../src/security.js";
import { RustCoreBridge } from "../src/tools.js";
import { buildSessionExport } from "../src/session_export.js";

let repo: string;
let stateDir: string;
let home: string;
let previousHome: string | undefined;
let agents: AutonomousAgent[] = [];

function write(rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
}

function makeAgent(opts: { mode?: "review" | "auto"; role?: string; fullAccess?: boolean } = {}): AutonomousAgent {
  const agent = new AutonomousAgent({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 4, temperature: 0, workspace: repo, shell: "bash", fullAccess: opts.fullAccess } as any);
  const a = agent as any;
  a.stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [a.primaryWorkspacePathIdentity] });
  if (opts.role) a.role = opts.role;
  if (opts.mode) agent.setApprovalMode(opts.mode);
  agents.push(agent);
  return agent;
}

let seq = 0;
async function call(agent: AutonomousAgent, name: string, args: Record<string, unknown>, onConfirm?: (tool: string, a: any) => Promise<boolean>) {
  const toolCall = { id: `c${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
  return (await (agent as any).dispatchToolCall(toolCall, 1, "agent", onConfirm)).receipt;
}
/** The guard let the call through (the write itself needs the built Rust core, which not every host has). */
const passedGuard = (receipt: { status?: string; denialReason?: string }) => receipt.denialReason !== "VERIFICATION_CONFIG_PROTECTED" && receipt.status !== "DENIED";
const yes = async () => true;
const no = async () => false;
const attempts = (agent: AutonomousAgent) => (agent as any).bridge.getSecurityManager().getVerificationAttempts();

beforeEach(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vg-home-"));
  process.env.HOME = home;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vg-repo-"));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vg-state-"));
  write("Makefile", "test:\n\tnpm test\n");
  write(".github/workflows/ci.yml", "name: ci\n");
  write("src/app.ts", "export const a = 1;\n");
  write("README.md", "hi\n");
  write("docs/guide.md", "guide\n");
  write("tests/old.test.ts", "test('a', () => { assert.equal(1, 1); });\n");
  write("package.json", JSON.stringify({ name: "x", scripts: { test: "node --test" }, dependencies: { left: "1.0.0" } }, null, 2));
});

afterEach(() => {
  for (const a of agents) a.shutdown();
  agents = [];
  for (const d of [repo, stateDir, home]) fs.rmSync(d, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

describe("verification config guard", () => {
  test("headless write_file to Makefile is denied with VERIFICATION_CONFIG_PROTECTED and recorded", async () => {
    const agent = makeAgent({ mode: "auto" });
    const receipt = await call(agent, "write_file", { path: "Makefile", content: "test:\n\ttrue\n" });
    assert.equal(receipt.status, "DENIED");
    assert.equal(receipt.denialReason, "VERIFICATION_CONFIG_PROTECTED");
    assert.equal(fs.readFileSync(path.join(repo, "Makefile"), "utf8"), "test:\n\tnpm test\n");
    const [attempt] = attempts(agent);
    assert.equal(attempt.path, "Makefile");
    assert.equal(attempt.class, "build");
    assert.equal(attempt.tool, "write_file");
    assert.equal(attempt.decision, "blocked");
  });

  test("edit_file on a CI workflow asks the operator even in auto mode; approval passes and is recorded", async () => {
    const agent = makeAgent({ mode: "auto" });
    const asked: string[] = [];
    const receipt = await call(agent, "edit_file", { path: ".github/workflows/ci.yml", old_content: "name: ci", new_content: "name: ci2" }, async (tool) => { asked.push(tool); return true; });
    assert.deepEqual(asked, ["edit_file"]);
    assert.ok(passedGuard(receipt));
    assert.equal(attempts(agent)[0].decision, "operator-approved");
    assert.equal(attempts(agent)[0].class, "ci");
  });

  test("a declined decision leaves the file and records a blocked attempt", async () => {
    const agent = makeAgent({ mode: "auto" });
    const receipt = await call(agent, "write_file", { path: "Makefile", content: "x" }, no);
    assert.equal(receipt.success, false);
    assert.equal(fs.readFileSync(path.join(repo, "Makefile"), "utf8"), "test:\n\tnpm test\n");
    assert.equal(attempts(agent)[0].decision, "blocked");
  });

  test("fullAccess passes without asking and still records", async () => {
    const agent = makeAgent({ mode: "auto", fullAccess: true });
    let asked = false;
    const receipt = await call(agent, "write_file", { path: "Makefile", content: "y\n" }, async () => { asked = true; return true; });
    assert.equal(asked, false);
    assert.ok(passedGuard(receipt));
    assert.equal(attempts(agent)[0].decision, "auto-recorded");
  });

  test("ordinary source, README and docs are never classified", async () => {
    const agent = makeAgent({ mode: "auto" });
    for (const p of ["src/app.ts", "README.md", "docs/guide.md"]) {
      const receipt = await call(agent, "write_file", { path: p, content: "changed\n" });
      assert.ok(passedGuard(receipt), p);
    }
    assert.deepEqual(attempts(agent), []);
    const sm = new SecurityManager(repo);
    for (const p of ["src/app.ts", "README.md", "docs/guide.md", "src/scripts/build.ts", "lib/Makefile", "src/Makefile.ts"]) assert.equal(sm.classifyVerificationPath(p), null, p);
  });

  test("package.json: a dependency bump passes, a scripts edit is gated", async () => {
    const agent = makeAgent({ mode: "auto" });
    const bump = await call(agent, "edit_file", { path: "package.json", old_content: '"left": "1.0.0"', new_content: '"left": "1.1.0"' });
    assert.ok(passedGuard(bump));
    const scripts = await call(agent, "edit_file", { path: "package.json", old_content: '"test": "node --test"', new_content: '"test": "true"' });
    assert.equal(scripts.status, "DENIED");
    assert.equal(scripts.denialReason, "VERIFICATION_CONFIG_PROTECTED");
    assert.match(fs.readFileSync(path.join(repo, "package.json"), "utf8"), /node --test/);
  });

  test("tester may create a new test file and append cases", async () => {
    const agent = makeAgent({ mode: "auto", role: "tester" });
    const created = await call(agent, "write_file", { path: "tests/new.test.ts", content: "test('n', () => {});\n" });
    assert.ok(passedGuard(created));
    assert.deepEqual(attempts(agent), []);
    const old = fs.readFileSync(path.join(repo, "tests/old.test.ts"), "utf8");
    const appended = await call(agent, "write_file", { path: "tests/old.test.ts", content: `${old}test('b', () => {});\n` });
    assert.ok(passedGuard(appended));
    assert.equal(attempts(agent)[0].decision, "role-allowed");
    assert.equal(attempts(agent)[0].role, "tester");
  });

  test("tester weakening or deleting an existing test is denied; CI config stays gated", async () => {
    const agent = makeAgent({ mode: "auto", role: "tester" });
    const weaken = await call(agent, "write_file", { path: "tests/old.test.ts", content: "test('a', () => {});\n" });
    assert.equal(weaken.denialReason, "VERIFICATION_CONFIG_PROTECTED");
    const edit = await call(agent, "edit_file", { path: "tests/old.test.ts", old_content: "assert.equal(1, 1);", new_content: "" });
    assert.equal(edit.denialReason, "VERIFICATION_CONFIG_PROTECTED");
    const del = await call(agent, "delete_file", { path: "tests/old.test.ts" });
    assert.equal(del.denialReason, "VERIFICATION_CONFIG_PROTECTED");
    const ci = await call(agent, "write_file", { path: ".github/workflows/ci.yml", content: "name: x\n" });
    assert.equal(ci.denialReason, "VERIFICATION_CONFIG_PROTECTED");
    assert.ok(fs.existsSync(path.join(repo, "tests/old.test.ts")));
    assert.match(fs.readFileSync(path.join(repo, "tests/old.test.ts"), "utf8"), /assert\.equal/);
  });

  test("an implementer editing an existing test is not exempt", async () => {
    const agent = makeAgent({ mode: "auto", role: "implementer" });
    const old = fs.readFileSync(path.join(repo, "tests/old.test.ts"), "utf8");
    const receipt = await call(agent, "write_file", { path: "tests/old.test.ts", content: `${old}more\n` });
    assert.equal(receipt.denialReason, "VERIFICATION_CONFIG_PROTECTED");
  });

  test("the agent cannot edit .nexus-security.json, even under fullAccess without an operator", async () => {
    write(".nexus-security.json", JSON.stringify({ verificationPaths: { mode: "approve" } }));
    const agent = makeAgent({ mode: "auto", fullAccess: true });
    const receipt = await call(agent, "write_file", { path: ".nexus-security.json", content: '{"verificationPaths":{"mode":"off"}}' });
    assert.equal(receipt.denialReason, "VERIFICATION_CONFIG_PROTECTED");
    assert.match(fs.readFileSync(path.join(repo, ".nexus-security.json"), "utf8"), /approve/);
  });

  test("mode off restores the unguarded behaviour", async () => {
    write(".nexus-security.json", JSON.stringify({ verificationPaths: { mode: "off" } }));
    const agent = makeAgent({ mode: "auto" });
    const receipt = await call(agent, "write_file", { path: "Makefile", content: "z\n" });
    assert.ok(passedGuard(receipt));
    assert.deepEqual(attempts(agent), []);
  });

  test("mode record allows and records; mode block denies even with an operator", async () => {
    write(".nexus-security.json", JSON.stringify({ verificationPaths: { mode: "record" } }));
    const recording = makeAgent({ mode: "auto" });
    assert.ok(passedGuard(await call(recording, "write_file", { path: "Makefile", content: "r\n" })));
    assert.equal(attempts(recording)[0].decision, "auto-recorded");
    write(".nexus-security.json", JSON.stringify({ verificationPaths: { mode: "block" } }));
    const blocking = makeAgent({ mode: "auto" });
    const receipt = await call(blocking, "write_file", { path: "Makefile", content: "b\n" }, yes);
    assert.equal(receipt.denialReason, "VERIFICATION_CONFIG_PROTECTED");
  });

  test("policy extra and allow lists change the class list", () => {
    write(".nexus-security.json", JSON.stringify({ verificationPaths: { mode: "approve", extra: ["eval/**"], allow: ["Makefile"] } }));
    const sm = new SecurityManager(repo);
    assert.equal(sm.classifyVerificationPath("eval/cases/a.json")?.source, "policy");
    assert.equal(sm.classifyVerificationPath("Makefile"), null);
    assert.equal(sm.classifyVerificationPath("justfile")?.class, "build");
  });

  test("run_command that rewrites a verification file is recorded and not blocked", async () => {
    const agent = makeAgent({ mode: "auto", fullAccess: true });
    const receipt = await call(agent, "run_command", { command: "sed -i 's/npm test/true/' Makefile" });
    assert.ok(passedGuard(receipt));
    const [attempt] = attempts(agent);
    assert.equal(attempt.tool, "run_command");
    assert.equal(attempt.path, "Makefile");
    assert.equal(attempt.decision, "auto-recorded");
    await call(agent, "run_command", { command: "echo ok > src/app.ts" });
    assert.equal(attempts(agent).length, 1);
  });

  test("attempts appear in the session export", async () => {
    const agent = makeAgent({ mode: "auto" });
    await call(agent, "write_file", { path: "Makefile", content: "q\n" });
    const state = agent.checkpointDurableState();
    const exported = buildSessionExport({} as any, { ...state, id: "s", workspace: repo, model: "m" } as any);
    const taskState = (exported.json.export as any).taskState;
    assert.equal(taskState.verificationConfigAttempts.length, 1);
    assert.equal(taskState.verificationConfigAttempts[0].decision, "blocked");
    assert.match(exported.markdown, /Verification configuration edits/);
    assert.match(exported.markdown, /blocked `write_file` Makefile/);
  });

  test("creating a file that does not exist is never gated", async () => {
    const agent = makeAgent({ mode: "auto" });
    for (const p of ["justfile", "jest.config.js", "tests/fresh.test.ts", ".github/workflows/new.yml"]) {
      const receipt = await call(agent, "write_file", { path: p, content: "x\n" });
      assert.ok(passedGuard(receipt), p);
    }
    assert.deepEqual(attempts(agent), []);
  });

  test("a symlink to a classified file is classified", async () => {
    fs.symlinkSync(path.join(repo, "Makefile"), path.join(repo, "notes.txt"));
    const agent = makeAgent({ mode: "auto" });
    const receipt = await call(agent, "write_file", { path: "notes.txt", content: "w\n" });
    assert.equal(receipt.denialReason, "VERIFICATION_CONFIG_PROTECTED");
    assert.equal(fs.readFileSync(path.join(repo, "Makefile"), "utf8"), "test:\n\tnpm test\n");
  });

  test("the tool layer refuses on its own when no decision was granted", async () => {
    const bridge = new RustCoreBridge(repo);
    const result = await bridge.executeTool("write_file", { path: "Makefile", content: "t\n" });
    assert.equal(result.success, false);
    assert.equal(result.denialReason, "VERIFICATION_CONFIG_PROTECTED");
  });
});
