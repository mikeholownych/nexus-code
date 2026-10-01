/**
 * Authority Admission & Resource Confinement Test Suite
 * Nexus Issue #12 — WP-02 (INC-03, AUTH-001..012, ACT-001..004, RES-001..004, DEC-01)
 */

import { test, describe } from "node:test";
import * as assert from "node:assert";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import {
  AuthorityAdmissionEngine,
  AuthorityGrant,
  isSafeReadOnlyCommand,
} from "../src/core/authority.js";
import { ExecutionSpine, InvocationRequest, InvocationContext } from "../src/core/spine.js";
import { createDefaultRegistry } from "../src/core/capabilities.js";
import { BrowserDriver } from "../src/browser.js";

describe("WP-02: Authority Admission & Resource Confinement (INC-03)", () => {
  const tmpRoot = path.join(os.tmpdir(), `nexus-auth-test-${Date.now()}-${process.pid}`);
  const wsRoot = path.join(tmpRoot, "workspace");
  const extRoot = path.join(tmpRoot, "external");

  // Create isolated test workspaces
  fs.mkdirSync(wsRoot, { recursive: true });
  fs.mkdirSync(extRoot, { recursive: true });
  fs.writeFileSync(path.join(wsRoot, "package.json"), JSON.stringify({ name: "test-pkg" }, null, 2));
  fs.writeFileSync(path.join(wsRoot, "README.md"), "# Test Workspace");
  fs.mkdirSync(path.join(wsRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, "src", "index.ts"), "console.log('hello');");
  fs.writeFileSync(path.join(wsRoot, "src", "util.ts"), "export const x = 1;");
  fs.writeFileSync(path.join(extRoot, "secret.txt"), "SUPER_SECRET_EXTERNAL_DATA");

  test("AUTH-009 & AUTH-010: Safe read-only command classification", () => {
    // 1. Allowed safe commands
    assert.strictEqual(isSafeReadOnlyCommand("ls"), true);
    assert.strictEqual(isSafeReadOnlyCommand("ls -la"), true);
    assert.strictEqual(isSafeReadOnlyCommand("pwd"), true);
    assert.strictEqual(isSafeReadOnlyCommand("git status"), true);
    assert.strictEqual(isSafeReadOnlyCommand("git log -n 5"), true);
    assert.strictEqual(isSafeReadOnlyCommand("git diff"), true);
    assert.strictEqual(isSafeReadOnlyCommand("git branch"), true);
    assert.strictEqual(isSafeReadOnlyCommand("git branch -a"), true);
    assert.strictEqual(isSafeReadOnlyCommand("git branch -r"), true);
    assert.strictEqual(isSafeReadOnlyCommand("git branch --list"), true);
    assert.strictEqual(isSafeReadOnlyCommand('git branch --list "main"'), true);
    assert.strictEqual(isSafeReadOnlyCommand("git branch --show-current"), true);
    assert.strictEqual(isSafeReadOnlyCommand("cat package.json"), true);
    assert.strictEqual(isSafeReadOnlyCommand("head -n 20 README.md"), true);
    assert.strictEqual(isSafeReadOnlyCommand("tail -n 5 log.txt"), true);
    assert.strictEqual(isSafeReadOnlyCommand('grep "foo" file.txt'), true);
    assert.strictEqual(isSafeReadOnlyCommand('rg "pattern" src/'), true);
    assert.strictEqual(isSafeReadOnlyCommand("diff file1 file2"), true);
    assert.strictEqual(isSafeReadOnlyCommand("wc -l package.json"), true);
    assert.strictEqual(isSafeReadOnlyCommand('find . -name "*.ts"'), true);
    assert.strictEqual(isSafeReadOnlyCommand("find src -type f"), true);
    assert.strictEqual(isSafeReadOnlyCommand("npm list"), true);
    assert.strictEqual(isSafeReadOnlyCommand("node -v"), true);
    assert.strictEqual(isSafeReadOnlyCommand("rustc -v"), true);

    // 2. Denied shell composition, chaining, redirection, and substitution
    assert.strictEqual(isSafeReadOnlyCommand("cat file.txt | rm -rf /"), false);
    assert.strictEqual(isSafeReadOnlyCommand("cat file.txt | cat"), false);
    assert.strictEqual(isSafeReadOnlyCommand("cat $(rm -rf /)"), false);
    assert.strictEqual(isSafeReadOnlyCommand("cat `rm -rf /`"), false);
    assert.strictEqual(isSafeReadOnlyCommand("git status || rm -rf /"), false);
    assert.strictEqual(isSafeReadOnlyCommand("git status && rm -rf /"), false);
    assert.strictEqual(isSafeReadOnlyCommand("ls; rm -rf /"), false);
    assert.strictEqual(isSafeReadOnlyCommand("ls & rm -rf /"), false);
    assert.strictEqual(isSafeReadOnlyCommand("ls > out.txt"), false);
    assert.strictEqual(isSafeReadOnlyCommand("cat file >> other.txt"), false);
    assert.strictEqual(isSafeReadOnlyCommand("cat < /etc/passwd"), false);
    assert.strictEqual(isSafeReadOnlyCommand("cat << EOF"), false);
    assert.strictEqual(isSafeReadOnlyCommand("cat file\nrm -rf /"), false);
    assert.strictEqual(isSafeReadOnlyCommand("cat file\rrm -rf /"), false);
    assert.strictEqual(isSafeReadOnlyCommand("(rm -rf /)"), false);
    assert.strictEqual(isSafeReadOnlyCommand("{ rm -rf /; }"), false);
    assert.strictEqual(isSafeReadOnlyCommand("cat file\\; rm"), false);

    // 3. Denied non-allowlisted and project-controlled delegated execution commands
    assert.strictEqual(isSafeReadOnlyCommand("rm -rf /"), false);
    assert.strictEqual(isSafeReadOnlyCommand("touch newfile.txt"), false);
    assert.strictEqual(isSafeReadOnlyCommand("git commit -m 'feat'"), false);
    assert.strictEqual(isSafeReadOnlyCommand("git push"), false);
    assert.strictEqual(isSafeReadOnlyCommand("npm install"), false);
    assert.strictEqual(isSafeReadOnlyCommand("cargo build"), false);
    assert.strictEqual(isSafeReadOnlyCommand('python3 -c "import os"'), false);
    assert.strictEqual(isSafeReadOnlyCommand('node -e "process.exit()"'), false);
    assert.strictEqual(isSafeReadOnlyCommand("npm test"), false);
    assert.strictEqual(isSafeReadOnlyCommand("npm run test"), false);
    assert.strictEqual(isSafeReadOnlyCommand("cargo check"), false);
    assert.strictEqual(isSafeReadOnlyCommand("cargo clippy"), false);

    // 4. Denied executable argument escapes (find -exec/delete, git --output, git branch creation/deletion)
    assert.strictEqual(isSafeReadOnlyCommand("find . -exec rm -rf {} +"), false);
    assert.strictEqual(isSafeReadOnlyCommand("find . -delete"), false);
    assert.strictEqual(isSafeReadOnlyCommand("find . -ok rm {} +"), false);
    assert.strictEqual(isSafeReadOnlyCommand("find . -fprint out.txt"), false);
    assert.strictEqual(isSafeReadOnlyCommand("git diff --output=out.txt"), false);
    assert.strictEqual(isSafeReadOnlyCommand("git log --output out.txt"), false);
    assert.strictEqual(isSafeReadOnlyCommand("git branch -D main"), false);
    assert.strictEqual(isSafeReadOnlyCommand("git branch -d feat"), false);
    assert.strictEqual(isSafeReadOnlyCommand("git branch -m old new"), false);
    assert.strictEqual(isSafeReadOnlyCommand("git branch new_branch"), false);
    assert.strictEqual(isSafeReadOnlyCommand("git branch --delete foo"), false);
  });

  test("AUTH-009: Read-only mode denies mutating capabilities and non-safe commands", async () => {
    const engine = new AuthorityAdmissionEngine({ readOnly: true });
    const dummyContext: InvocationContext = { workspaceRoot: wsRoot, readOnly: true };

    // file_write (mutating) must be denied
    const writeDecision = await engine.admit(
      { toolName: "write_file", args: { path: "src/new.ts", content: "x" } },
      dummyContext
    );
    assert.strictEqual(writeDecision.admitted, false);
    assert.match(writeDecision.reason!, /mutates candidate state and is denied in read-only mode/);

    // file_read (non-mutating) must be admitted
    const readDecision = await engine.admit(
      { toolName: "read_file", args: { path: "package.json" } },
      dummyContext
    );
    assert.strictEqual(readDecision.admitted, true);

    // run_command with safe command must be admitted
    const cmdSafeDecision = await engine.admit(
      { toolName: "run_command", args: { command: "git status" } },
      dummyContext
    );
    assert.strictEqual(cmdSafeDecision.admitted, true);

    // run_command with mutating command must be denied
    const cmdMutatingDecision = await engine.admit(
      { toolName: "run_command", args: { command: "rm -rf src/" } },
      dummyContext
    );
    assert.strictEqual(cmdMutatingDecision.admitted, false);
    assert.match(cmdMutatingDecision.reason!, /AUTH-010:.*Command 'rm -rf src\/' is not permitted in read-only mode/);
  });

  test("AUTH-006: Fail-closed evaluation when explicit grants do not match", async () => {
    const engine = new AuthorityAdmissionEngine({
      grants: [
        {
          actor: "agent",
          executionDomain: "agent_orchestration",
          capabilities: ["file_read"],
          scope: "workspace",
        },
      ],
    });
    const dummyContext: InvocationContext = { workspaceRoot: wsRoot };

    // Permitted capability
    const readDecision = await engine.admit(
      { toolName: "read_file", args: { path: "package.json" }, actor: "agent", executionDomain: "agent_orchestration" },
      dummyContext
    );
    assert.strictEqual(readDecision.admitted, true);

    // Unlisted capability fails closed
    const writeDecision = await engine.admit(
      { toolName: "write_file", args: { path: "src/new.ts", content: "x" }, actor: "agent", executionDomain: "agent_orchestration" },
      dummyContext
    );
    assert.strictEqual(writeDecision.admitted, false);
    assert.match(writeDecision.reason!, /AUTH-006: Fail-closed/);

    // Unlisted actor fails closed
    const operatorDecision = await engine.admit(
      { toolName: "read_file", args: { path: "package.json" }, actor: "operator", executionDomain: "operator_direct_shell" },
      dummyContext
    );
    assert.strictEqual(operatorDecision.admitted, false);
    assert.match(operatorDecision.reason!, /AUTH-006: Fail-closed/);
  });

  test("AUTH-004 & AUTH-005: Resource scoping — exact vs subtree vs workspace (no sibling inheritance)", async () => {
    const dummyContext: InvocationContext = { workspaceRoot: wsRoot };

    // 1. Exact scope grant
    const exactEngine = new AuthorityAdmissionEngine({
      grants: [
        {
          capabilities: ["*"],
          scope: "exact",
          resources: ["package.json"],
        },
      ],
    });

    // Exact resource match -> Confined
    const exactMatch = await exactEngine.confine(
      { toolName: "read_file", args: { path: "package.json" } },
      dummyContext
    );
    assert.strictEqual(exactMatch.confined, true);

    // Sibling resource -> Blocked (NO sibling inheritance)
    const exactSibling = await exactEngine.confine(
      { toolName: "read_file", args: { path: "README.md" } },
      dummyContext
    );
    assert.strictEqual(exactSibling.confined, false);
    assert.match(exactSibling.reason!, /AUTH-005: Security Violation: Path 'README.md' does not match any exact authorized resource/);

    // 2. Subtree scope grant
    const subtreeEngine = new AuthorityAdmissionEngine({
      grants: [
        {
          capabilities: ["*"],
          scope: "subtree",
          resources: ["src"],
        },
      ],
    });

    // Contained descendant -> Confined
    const subMatch = await subtreeEngine.confine(
      { toolName: "read_file", args: { path: "src/index.ts" } },
      dummyContext
    );
    assert.strictEqual(subMatch.confined, true);

    const subNested = await subtreeEngine.confine(
      { toolName: "read_file", args: { path: "src/nested/sub.ts" } },
      dummyContext
    );
    assert.strictEqual(subNested.confined, true);

    // Outside subtree (sibling directory) -> Blocked (NO sibling inheritance)
    const subSibling = await subtreeEngine.confine(
      { toolName: "read_file", args: { path: "package.json" } },
      dummyContext
    );
    assert.strictEqual(subSibling.confined, false);
    assert.match(subSibling.reason!, /AUTH-005: Security Violation: Path 'package.json' is outside authorized subtree scope/);
  });

  test("RES-002 & AUTH-011: Command cwd confinement rejects directory escapes", async () => {
    const engine = new AuthorityAdmissionEngine();
    const dummyContext: InvocationContext = { workspaceRoot: wsRoot };

    // Valid in-workspace cwd
    const validCwd = await engine.confine(
      { toolName: "run_command", args: { command: "pwd", cwd: "src" } },
      dummyContext
    );
    assert.strictEqual(validCwd.confined, true);

    // Absolute out-of-workspace cwd
    const extCwd = await engine.confine(
      { toolName: "run_command", args: { command: "pwd", cwd: "/etc" } },
      dummyContext
    );
    assert.strictEqual(extCwd.confined, false);
    assert.match(extCwd.reason!, /RES-002: Security Violation: Working directory '\/etc' escapes workspace jail/);

    // Relative parent traversal cwd
    const traversalCwd = await engine.confine(
      { toolName: "run_command", args: { command: "pwd", cwd: "../../" } },
      dummyContext
    );
    assert.strictEqual(traversalCwd.confined, false);
    assert.match(traversalCwd.reason!, /RES-002: Security Violation: Working directory '..\/\.\.\/' escapes workspace jail/);
  });

  test("RES-004: Path traversal attempts are rejected by resource confinement", async () => {
    const engine = new AuthorityAdmissionEngine();
    const dummyContext: InvocationContext = { workspaceRoot: wsRoot };

    // Target escaping workspace
    const escapeRes = await engine.confine(
      { toolName: "read_file", args: { path: "../../external/secret.txt" } },
      dummyContext
    );
    assert.strictEqual(escapeRes.confined, false);
    assert.match(escapeRes.reason!, /RES-004: Security Violation: Path '..\/..\/external\/secret.txt' escapes workspace jail/);

    // Absolute external path
    const absEscape = await engine.confine(
      { toolName: "read_file", args: { path: "/etc/passwd" } },
      dummyContext
    );
    assert.strictEqual(absEscape.confined, false);
    assert.match(absEscape.reason!, /RES-004: Security Violation: Path '\/etc\/passwd' escapes workspace jail/);
  });

  test("AUTH-007 & AUTH-008: Full-access mode executes cleanly without prompts", async () => {
    const engine = new AuthorityAdmissionEngine({ fullAccess: true });
    const dummyContext: InvocationContext = { workspaceRoot: wsRoot };

    // Any capability admitted
    const admitRes = await engine.admit(
      { toolName: "write_file", args: { path: "anywhere.txt", content: "x" } },
      dummyContext
    );
    assert.strictEqual(admitRes.admitted, true);
    assert.strictEqual(admitRes.effectiveScope, "full_access");

    // Broad resource confinement
    const confineRes = await engine.confine(
      { toolName: "write_file", args: { path: "/tmp/broad_access.txt", content: "x" } },
      dummyContext
    );
    assert.strictEqual(confineRes.confined, true);
  });

  test("RES-001: BrowserDriver local file URL and screenshot confinement", async () => {
    const browser = new BrowserDriver(wsRoot);

    // 1. In-workspace local file URL navigation succeeds
    const inWsUrl = `file://${path.join(wsRoot, "package.json")}`;
    const navIn = await browser.navigate(inWsUrl);
    assert.strictEqual(navIn.status, 200);
    assert.match(navIn.contentSnippet, /test-pkg/);

    // 2. Out-of-workspace local file URL navigation fails with 403 Security Violation
    const extUrl = `file://${path.join(extRoot, "secret.txt")}`;
    const navExt = await browser.navigate(extUrl);
    assert.strictEqual(navExt.status, 403);
    assert.match(navExt.title, /Security Violation/);
    assert.match(navExt.contentSnippet, /escapes workspace jail/);

    // 3. Traversal file://../../etc/passwd rejected
    const traversalUrl = "file://../../etc/passwd";
    const navTrav = await browser.navigate(traversalUrl);
    assert.strictEqual(navTrav.status, 403);
    assert.match(navTrav.title, /Security Violation/);

    // 4. In-workspace screenshot succeeds
    const ssOk = await browser.screenshot("test-ss.png");
    assert.ok(fs.existsSync(ssOk.path));

    // 5. Escaping screenshot path throws Security Violation
    await assert.rejects(
      async () => {
        await browser.screenshot("../../external/escaped.png");
      },
      /Security Violation: Screenshot output path escapes workspace jail/
    );
  });

  test("ACT-004 & AUTH-001: Operator direct shell domain through ExecutionSpine", async () => {
    const registry = createDefaultRegistry();
    const authorityEngine = new AuthorityAdmissionEngine({ readOnly: true });

    const spine = new ExecutionSpine({
      registry,
      hooks: {
        authorityAdmission: authorityEngine.createAdmissionHook(),
        resourceConfinement: authorityEngine.createConfinementHook(),
      },
    });

    registry.setHandler("run_command", async (args) => {
      return { success: true, output: `Executed: ${args.command}` };
    });

    const context: InvocationContext = {
      workspaceRoot: wsRoot,
      readOnly: true,
    };

    // 1. Operator direct shell safe command admitted and executed
    const safeReceipt = await spine.execute(
      {
        toolName: "run_command",
        args: { command: "git status" },
        actor: "operator",
        executionDomain: "operator_direct_shell",
      },
      context
    );
    assert.strictEqual(safeReceipt.success, true);
    assert.strictEqual(safeReceipt.actor, "operator");
    assert.strictEqual(safeReceipt.executionDomain, "operator_direct_shell");
    assert.strictEqual(safeReceipt.status, "COMPLETED");

    // 2. Operator direct shell mutating command denied under --read-only
    const deniedReceipt = await spine.execute(
      {
        toolName: "run_command",
        args: { command: "rm -rf /" },
        actor: "operator",
        executionDomain: "operator_direct_shell",
      },
      context
    );
    assert.strictEqual(deniedReceipt.success, false);
    assert.strictEqual(deniedReceipt.actor, "operator");
    assert.strictEqual(deniedReceipt.executionDomain, "operator_direct_shell");
    assert.strictEqual(deniedReceipt.status, "DENIED");
    assert.match(deniedReceipt.error!, /AUTH-010:.*Command 'rm -rf \/' is not permitted in read-only mode/);
  });

  test("ExecutionSpine Stage 3 end-to-end: ResourceConfinementHook blocks traversal before execution", async () => {
    const registry = createDefaultRegistry();
    const authorityEngine = new AuthorityAdmissionEngine();

    let executed = false;
    registry.setHandler("read_file", async () => {
      executed = true;
      return { success: true, output: "file content" };
    });

    const spine = new ExecutionSpine({
      registry,
      hooks: {
        authorityAdmission: authorityEngine.createAdmissionHook(),
        resourceConfinement: authorityEngine.createConfinementHook(),
      },
    });

    const receipt = await spine.execute(
      {
        toolName: "read_file",
        args: { path: "../../external/secret.txt" },
        actor: "agent",
        executionDomain: "agent_orchestration",
      },
      { workspaceRoot: wsRoot }
    );

    assert.strictEqual(receipt.success, false);
    assert.strictEqual(receipt.status, "BLOCKED");
    assert.strictEqual(executed, false, "Handler must NOT have executed!");
    assert.match(receipt.error!, /RES-004: Security Violation: Path/);
  });

  test("F-WP02-MAT-01: Read-only mode denies shell composition and prevents disk side effects through ExecutionSpine", async () => {
    const registry = createDefaultRegistry();
    const authorityEngine = new AuthorityAdmissionEngine({ readOnly: true });

    let handlerExecuted = false;
    registry.setHandler("run_command", async (args) => {
      handlerExecuted = true;
      return { success: true, output: "simulated execution" };
    });

    const spine = new ExecutionSpine({
      registry,
      hooks: {
        authorityAdmission: authorityEngine.createAdmissionHook(),
        resourceConfinement: authorityEngine.createConfinementHook(),
      },
    });

    const sideEffectFile1 = path.join(wsRoot, "side_effect_pipe.txt");
    const sideEffectFile2 = path.join(wsRoot, "side_effect_subshell.txt");
    const sideEffectFile3 = path.join(wsRoot, "side_effect_chain.txt");

    const commandsToTest = [
      `cat package.json | touch ${sideEffectFile1}`,
      `git status && touch ${sideEffectFile2}`,
      `cat $(touch ${sideEffectFile3})`,
      `echo malicious > ${path.join(wsRoot, "side_effect_redirect.txt")}`,
      "find . -delete",
      "git branch -D main",
    ];

    for (const cmd of commandsToTest) {
      handlerExecuted = false;
      const receipt = await spine.execute(
        {
          toolName: "run_command",
          args: { command: cmd },
          actor: "agent",
          executionDomain: "agent_orchestration",
        },
        { workspaceRoot: wsRoot, readOnly: true }
      );

      assert.strictEqual(receipt.success, false, `Command '${cmd}' must fail admission`);
      assert.strictEqual(receipt.status, "DENIED", `Command '${cmd}' receipt status must be DENIED`);
      assert.strictEqual(handlerExecuted, false, `Handler must NOT execute for '${cmd}'`);
      assert.match(receipt.error!, /AUTH-010:.*is not permitted in read-only mode/);
    }

    // Verify disk state has ZERO side-effect files
    assert.strictEqual(fs.existsSync(sideEffectFile1), false, "Pipe side effect must not exist on disk");
    assert.strictEqual(fs.existsSync(sideEffectFile2), false, "Subshell side effect must not exist on disk");
    assert.strictEqual(fs.existsSync(sideEffectFile3), false, "Chaining side effect must not exist on disk");
    assert.strictEqual(fs.existsSync(path.join(wsRoot, "side_effect_redirect.txt")), false, "Redirect side effect must not exist on disk");
  });

  test("F-WP02-MAT-01: Read-only command denial applies consistently across agent, operator_direct_shell, and subagent domains", async () => {
    const authorityEngine = new AuthorityAdmissionEngine({ readOnly: true });
    const dummyContext: InvocationContext = { workspaceRoot: wsRoot, readOnly: true };

    const domains = [
      { actor: "agent", domain: "agent_orchestration" },
      { actor: "operator", domain: "operator_direct_shell" },
      { actor: "subagent-1", domain: "subagent" },
    ];

    for (const d of domains) {
      const decision = await authorityEngine.admit(
        {
          toolName: "run_command",
          args: { command: "cat file.txt | rm -rf /" },
          actor: d.actor,
          executionDomain: d.domain,
        },
        dummyContext
      );

      assert.strictEqual(
        decision.admitted,
        false,
        `Domain '${d.domain}' with actor '${d.actor}' must deny unsafe read-only command`
      );
      assert.match(decision.reason!, /AUTH-010:.*Command 'cat file.txt \| rm -rf \/' is not permitted in read-only mode/);
    }
  });

  test("F-WP02-MAT-02: Isolated fixtures confirm project-controlled execution (npm test, cargo check) is denied under read-only mode", async () => {
    const registry = createDefaultRegistry();
    const authorityEngine = new AuthorityAdmissionEngine({ readOnly: true });

    let handlerExecuted = false;
    registry.setHandler("run_command", async (args) => {
      handlerExecuted = true;
      return { success: true, output: "simulated execution" };
    });

    const spine = new ExecutionSpine({
      registry,
      hooks: {
        authorityAdmission: authorityEngine.createAdmissionHook(),
        resourceConfinement: authorityEngine.createConfinementHook(),
      },
    });

    // 1. Isolated npm fixture
    const npmFixtureDir = path.join(tmpRoot, "npm-fixture");
    fs.mkdirSync(npmFixtureDir, { recursive: true });
    const npmSentinel = path.join(npmFixtureDir, "sentinel_npm.txt");
    fs.writeFileSync(
      path.join(npmFixtureDir, "package.json"),
      JSON.stringify({
        name: "test-escape",
        scripts: { test: `touch "${npmSentinel}"` },
      })
    );

    // Attempt npm test under read-only mode
    handlerExecuted = false;
    const npmReceipt = await spine.execute(
      {
        toolName: "run_command",
        args: { command: "npm test", cwd: npmFixtureDir },
        actor: "agent",
        executionDomain: "agent_orchestration",
      },
      { workspaceRoot: wsRoot, readOnly: true }
    );

    assert.strictEqual(npmReceipt.success, false, "npm test must be denied under read-only mode");
    assert.strictEqual(npmReceipt.status, "DENIED", "npm test receipt status must be DENIED");
    assert.strictEqual(handlerExecuted, false, "Handler must NOT have executed for npm test");
    assert.strictEqual(fs.existsSync(npmSentinel), false, "npm test sentinel must NOT be created on disk");
    assert.match(npmReceipt.error!, /AUTH-010:.*Command 'npm test' is not permitted in read-only mode/);

    // Attempt npm run test under read-only mode
    handlerExecuted = false;
    const npmRunReceipt = await spine.execute(
      {
        toolName: "run_command",
        args: { command: "npm run test", cwd: npmFixtureDir },
        actor: "agent",
        executionDomain: "agent_orchestration",
      },
      { workspaceRoot: wsRoot, readOnly: true }
    );
    assert.strictEqual(npmRunReceipt.success, false, "npm run test must be denied under read-only mode");
    assert.strictEqual(npmRunReceipt.status, "DENIED");
    assert.strictEqual(handlerExecuted, false);

    // 2. Isolated Cargo fixture with build.rs
    const cargoFixtureDir = path.join(tmpRoot, "cargo-fixture");
    fs.mkdirSync(cargoFixtureDir, { recursive: true });
    const cargoSentinel = path.join(cargoFixtureDir, "sentinel_cargo.txt");
    fs.writeFileSync(
      path.join(cargoFixtureDir, "Cargo.toml"),
      `[package]\nname = "cargo-escape"\nversion = "0.1.0"\nedition = "2021"\n`
    );
    fs.writeFileSync(
      path.join(cargoFixtureDir, "build.rs"),
      `fn main() { std::fs::write("${cargoSentinel}", "escaped").unwrap(); }`
    );

    // Attempt cargo check under read-only mode
    handlerExecuted = false;
    const cargoReceipt = await spine.execute(
      {
        toolName: "run_command",
        args: { command: "cargo check", cwd: cargoFixtureDir },
        actor: "agent",
        executionDomain: "agent_orchestration",
      },
      { workspaceRoot: wsRoot, readOnly: true }
    );

    assert.strictEqual(cargoReceipt.success, false, "cargo check must be denied under read-only mode");
    assert.strictEqual(cargoReceipt.status, "DENIED", "cargo check receipt status must be DENIED");
    assert.strictEqual(handlerExecuted, false, "Handler must NOT have executed for cargo check");
    assert.strictEqual(fs.existsSync(cargoSentinel), false, "cargo check sentinel must NOT be created on disk");
    assert.match(cargoReceipt.error!, /AUTH-010:.*Command 'cargo check' is not permitted in read-only mode/);

    // Attempt cargo clippy under read-only mode
    handlerExecuted = false;
    const clippyReceipt = await spine.execute(
      {
        toolName: "run_command",
        args: { command: "cargo clippy", cwd: cargoFixtureDir },
        actor: "agent",
        executionDomain: "agent_orchestration",
      },
      { workspaceRoot: wsRoot, readOnly: true }
    );
    assert.strictEqual(clippyReceipt.success, false, "cargo clippy must be denied under read-only mode");
    assert.strictEqual(clippyReceipt.status, "DENIED");
    assert.strictEqual(handlerExecuted, false);

    // 3. Positive verification: npm list remains admitted
    handlerExecuted = false;
    const listReceipt = await spine.execute(
      {
        toolName: "run_command",
        args: { command: "npm list", cwd: wsRoot },
        actor: "agent",
        executionDomain: "agent_orchestration",
      },
      { workspaceRoot: wsRoot, readOnly: true }
    );
    assert.strictEqual(listReceipt.success, true, "npm list must be admitted under read-only mode");
    assert.strictEqual(listReceipt.status, "COMPLETED");
    assert.strictEqual(handlerExecuted, true);

    // Cleanup fixtures
    fs.rmSync(npmFixtureDir, { recursive: true, force: true });
    fs.rmSync(cargoFixtureDir, { recursive: true, force: true });
  });
});
