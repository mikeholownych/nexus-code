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
    for (const p of ["src/app.ts", "README.md", "docs/guide.md", "src/scripts/build.ts", "src/Makefile.ts"]) assert.equal(sm.classifyVerificationPath(p), null, p);
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

  test("creating a new test file is free; creating new config, CI, verifier or policy files is gated", async () => {
    const agent = makeAgent({ mode: "auto" });
    assert.ok(passedGuard(await call(agent, "write_file", { path: "tests/fresh.test.ts", content: "x\n" })));
    assert.deepEqual(attempts(agent), []);
    for (const p of [".nexus-security.json", "conftest.py", "jest.config.js", "justfile", "pytest.ini", ".github/workflows/new.yml", "scripts/test_all.sh", "cli/Makefile"]) {
      const receipt = await call(agent, "write_file", { path: p, content: "{}\n" });
      assert.equal(receipt.denialReason, "VERIFICATION_CONFIG_PROTECTED", p);
      assert.equal(fs.existsSync(path.join(repo, p)), false, p);
    }
    const asked: string[] = [];
    const approved = await call(agent, "write_file", { path: "justfile", content: "x\n" }, async (t) => { asked.push(t); return true; });
    assert.deepEqual(asked, ["write_file"]);
    assert.ok(passedGuard(approved));
    const full = makeAgent({ mode: "auto", fullAccess: true });
    assert.ok(passedGuard(await call(full, "write_file", { path: "conftest.py", content: "x\n" })));
    assert.equal(attempts(full)[0].decision, "auto-recorded");
  });

  test("a new package.json is gated only when it declares verification keys", async () => {
    const agent = makeAgent({ mode: "auto" });
    assert.ok(passedGuard(await call(agent, "write_file", { path: "pkg/package.json", content: '{"name":"p"}' })));
    const gated = await call(agent, "write_file", { path: "pkg2/package.json", content: '{"scripts":{"test":"true"}}' });
    assert.equal(gated.denialReason, "VERIFICATION_CONFIG_PROTECTED");
  });

  test("nested monorepo paths are classified at any depth; scripts rule is case-sensitive", async () => {
    write("cli/package.json", JSON.stringify({ scripts: { test: "node --test" } }));
    write("sub/vitest.config.ts", "export default {};\n");
    write("scripts/ci/run.sh", "true\n");
    write("packages/a/Makefile", "x:\n");
    const sm = new SecurityManager(repo);
    for (const p of ["cli/package.json", "sub/vitest.config.ts", "scripts/ci/run.sh", "packages/a/Makefile", "a/b/conftest.py", "scripts/build/verify-all.sh", "scripts/lint.sh"]) assert.ok(sm.classifyVerificationPath(p), p);
    assert.equal(sm.classifyVerificationPath("SCRIPTS/Test.sh"), null);
    assert.equal(sm.classifyVerificationPath("scripts/build.sh"), null);
    assert.equal(sm.classifyVerificationPath("node_modules/x/package.json"), null);
    const agent = makeAgent({ mode: "auto" });
    const receipt = await call(agent, "edit_file", { path: "cli/package.json", old_content: '"node --test"', new_content: '"true"' });
    assert.equal(receipt.denialReason, "VERIFICATION_CONFIG_PROTECTED");
    assert.equal((await call(agent, "write_file", { path: "scripts/ci/run.sh", content: "x\n" })).denialReason, "VERIFICATION_CONFIG_PROTECTED");
  });

  test("dot-dot and absolute spellings resolve to the same file; paths outside the workspace are not classified", async () => {
    const agent = makeAgent({ mode: "auto" });
    for (const p of ["src/../Makefile", path.join(repo, "Makefile"), "./Makefile"]) {
      assert.equal((await call(agent, "write_file", { path: p, content: "x" })).denialReason, "VERIFICATION_CONFIG_PROTECTED", p);
    }
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vg-out-"));
    fs.writeFileSync(path.join(outside, "Makefile"), "x");
    try {
      assert.equal(new SecurityManager(repo).verificationEditDecision("write_file", { path: path.join(outside, "Makefile"), content: "y" }), null);
      assert.equal(new SecurityManager(repo).verificationEditDecision("write_file", { path: "../" + path.basename(outside) + "/Makefile", content: "y" }), null);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("deleting a directory that holds verification files is gated", () => {
    write("scripts/test_all.sh", "true\n");
    write(".circleci/config.yml", "x\n");
    write("empty/readme.md", "x\n");
    const sm = new SecurityManager(repo);
    for (const dir of ["tests", ".github", ".circleci", "scripts", ".github/workflows"]) {
      const d = sm.verificationEditDecision("delete_file", { path: dir }, { operator: false });
      assert.equal(d?.action, "deny", dir);
    }
    assert.equal(sm.verificationEditDecision("delete_file", { path: "empty" }, { operator: false }), null);
    assert.equal(sm.verificationEditDecision("delete_file", { path: "tests" }, { role: "tester", operator: true })?.action, "ask");
  });

  test("fixtures, snapshots and data files under test directories are not existing-test files", () => {
    write("tests/fixtures/a.json", "{}");
    write("tests/__snapshots__/a.snap", "x");
    write("tests/data.txt", "x");
    write("tests/__fixtures__/h.ts", "x");
    write("tests/helpers.ts", "x");
    const sm = new SecurityManager(repo);
    for (const p of ["tests/fixtures/a.json", "tests/__snapshots__/a.snap", "tests/data.txt", "tests/__fixtures__/h.ts"]) {
      assert.equal(sm.verificationEditDecision("write_file", { path: p, content: "y" }, { operator: false }), null, p);
    }
    assert.equal(sm.verificationEditDecision("write_file", { path: "tests/helpers.ts", content: "y" }, { operator: false })?.action, "deny");
  });

  test("a role-less agent (TDD RED phase) can still create a new test file headless", async () => {
    const agent = makeAgent({ mode: "auto" });
    assert.ok(passedGuard(await call(agent, "write_file", { path: "test/repro.test.ts", content: "x\n" })));
    assert.deepEqual(attempts(agent), []);
  });

  test("tester exemption cannot be used to neuter existing tests", () => {
    write("tests/t.test.ts", "test('a', () => {\n  assert.equal(1, 1);\n});\n");
    const sm = new SecurityManager(repo);
    const ctx = { role: "tester", operator: false };
    const old = fs.readFileSync(path.join(repo, "tests/t.test.ts"), "utf8");
    const d = (tool: string, args: Record<string, unknown>) => sm.verificationEditDecision(tool, { path: "tests/t.test.ts", ...args }, ctx)?.action;
    assert.equal(d("write_file", { content: `${old}test('b', () => {});\n` }), "allow");
    assert.equal(d("write_file", { content: `${old}process.exit(0);\n` }), "deny");
    assert.equal(d("write_file", { content: `${old}describe.skip('x', () => {});\n` }), "deny");
    assert.equal(d("write_file", { content: `${old}test.only('x', () => {});\n` }), "deny");
    assert.equal(d("write_file", { content: `${old.trimEnd()}//\ntest('b', () => {});\n` }), "deny");
    assert.equal(d("edit_file", { old_content: "});\n", new_content: "});\ntest('b', () => {});\n" }), "allow");
    assert.equal(d("edit_file", { old_content: "assert.equal(", new_content: "assert.equal(1,1);//" }), "deny");
    assert.equal(d("edit_file", { old_content: "});", new_content: "});//" }), "deny");
    assert.equal(d("edit_file", { old_content: "", new_content: "x" }), "deny");
    assert.equal(d("edit_file", { old_content: "});\n", new_content: "});\ntest('b', () => { return; });\n" }), "allow");
    assert.equal(d("patch_file", { patch: "--- a/tests/t.test.ts\n+++ b/tests/t.test.ts\n@@ -3,0 +4,1 @@\n+test('b', () => {});\n" }), "allow");
    assert.equal(d("patch_file", { patch: "--- a/tests/t.test.ts\n+++ b/tests/t.test.ts\n@@ -2,1 +2,0 @@\n---x\n" }), "deny");
    assert.equal(d("patch_file", { patch: "--- a/tests/t.test.ts\n+++ b/tests/t.test.ts\n@@ -2,1 +2,1 @@\n-  assert.equal(1, 1);\n+  // gone\n" }), "deny");
  });

  test("mode block gives the tester no exemption", async () => {
    write(".nexus-security.json", JSON.stringify({ verificationPaths: { mode: "block" } }));
    const agent = makeAgent({ mode: "auto", role: "tester" });
    const old = fs.readFileSync(path.join(repo, "tests/old.test.ts"), "utf8");
    const receipt = await call(agent, "write_file", { path: "tests/old.test.ts", content: `${old}test('b', () => {});\n` });
    assert.equal(receipt.denialReason, "VERIFICATION_CONFIG_PROTECTED");
    assert.ok(passedGuard(await call(agent, "write_file", { path: "tests/new2.test.ts", content: "x\n" })));
  });

  test("an operator approval covers one call only and does not leak to the next", async () => {
    const agent = makeAgent({ mode: "auto" });
    await call(agent, "write_file", { path: "Makefile", content: "a\n" }, yes);
    const second = await call(agent, "write_file", { path: "Makefile", content: "b\n" });
    assert.equal(second.denialReason, "VERIFICATION_CONFIG_PROTECTED");
    assert.deepEqual(attempts(agent).map((a: any) => a.decision), ["operator-approved", "blocked"]);
  });

  test("the tool layer takes its authority from the call, not from shared state", async () => {
    const bridge = new RustCoreBridge(repo);
    const denied = await bridge.executeTool("write_file", { path: "Makefile", content: "t\n" }, { fullAccess: true, operator: false, role: "implementer" });
    assert.notEqual(denied.denialReason, "VERIFICATION_CONFIG_PROTECTED");
    const again = await bridge.executeTool("write_file", { path: "Makefile", content: "t\n" });
    assert.equal(again.denialReason, "VERIFICATION_CONFIG_PROTECTED");
    const approved = await bridge.executeTool("write_file", { path: "Makefile", content: "t\n" }, { operator: true, approved: true });
    assert.notEqual(approved.denialReason, "VERIFICATION_CONFIG_PROTECTED");
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
