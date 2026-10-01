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
    // Allowed safe commands
    assert.strictEqual(isSafeReadOnlyCommand("ls"), true);
    assert.strictEqual(isSafeReadOnlyCommand("ls -la"), true);
    assert.strictEqual(isSafeReadOnlyCommand("pwd"), true);
    assert.strictEqual(isSafeReadOnlyCommand("git status"), true);
    assert.strictEqual(isSafeReadOnlyCommand("git log -n 5"), true);
    assert.strictEqual(isSafeReadOnlyCommand("git diff"), true);
    assert.strictEqual(isSafeReadOnlyCommand("cat package.json"), true);
    assert.strictEqual(isSafeReadOnlyCommand("cargo check"), true);
    assert.strictEqual(isSafeReadOnlyCommand("cargo clippy"), true);
    assert.strictEqual(isSafeReadOnlyCommand("npm test"), true);

    // Denied mutating commands
    assert.strictEqual(isSafeReadOnlyCommand("rm -rf /"), false);
    assert.strictEqual(isSafeReadOnlyCommand("touch newfile.txt"), false);
    assert.strictEqual(isSafeReadOnlyCommand("git commit -m 'feat'"), false);
    assert.strictEqual(isSafeReadOnlyCommand("git push"), false);
    assert.strictEqual(isSafeReadOnlyCommand("ls > out.txt"), false);
    assert.strictEqual(isSafeReadOnlyCommand("cat file >> other.txt"), false);
    assert.strictEqual(isSafeReadOnlyCommand("npm install"), false);
    assert.strictEqual(isSafeReadOnlyCommand("cargo build"), false);
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
});
