import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { ApplicationCore, TaskExecutionResult } from "../src/core/app.js";
import { InteractiveRepl } from "../src/repl.js";
import { TerminalDashboard } from "../src/tui.js";
import { HarnessConfig } from "../src/types.js";
import { CandidateTracker, hashContent } from "../src/core/candidate.js";

describe("WP-10: Application Core & CLI/TUI Projection Convergence (INC-11, UI-001..UI-007)", () => {
  let tmpDir: string;
  let gitRepoDir: string;

  let activeApps: ApplicationCore[] = [];

  beforeEach(() => {
    activeApps = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-app-test-"));
    gitRepoDir = path.join(tmpDir, "repo");

    fs.mkdirSync(gitRepoDir, { recursive: true });
    execFileSync("git", ["init"], { cwd: gitRepoDir });
    execFileSync("git", ["config", "user.name", "Tester"], { cwd: gitRepoDir });
    execFileSync("git", ["config", "user.email", "tester@nexus.local"], { cwd: gitRepoDir });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: gitRepoDir });

    fs.writeFileSync(path.join(gitRepoDir, "README.md"), "# Test Project\n");
    fs.mkdirSync(path.join(gitRepoDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(gitRepoDir, "src", "index.ts"), "export const answer = 42;\n");
    execFileSync("git", ["add", "."], { cwd: gitRepoDir });
    execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: gitRepoDir });
  });

  afterEach(() => {
    for (const a of activeApps) {
      try {
        a.shutdown();
      } catch {}
    }
    activeApps = [];
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function createTestConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
    return {
      endpoint: "http://localhost:1234/v1",
      model: "test-model",
      workspace: gitRepoDir,
      maxSteps: 5,
      temperature: 0.1,
      shell: "bash",
      ...overrides,
    };
  }

  function createApp(overrides: Partial<HarnessConfig> = {}): ApplicationCore {
    const config = createTestConfig(overrides);
    const app = new ApplicationCore(config);
    activeApps.push(app);
    return app;
  }

  test("UI-001: ApplicationCore serves as single unified application model for CLI and REPL", () => {
    const app = createApp();

    assert.ok(app.getAgent(), "Must provide AutonomousAgent");
    assert.ok(app.getSpine(), "Must provide ExecutionSpine");
    assert.ok(app.getAuthorityEngine(), "Must provide AuthorityAdmissionEngine");
    assert.ok(app.getCandidateTracker(), "Must provide CandidateTracker");
    assert.ok(app.getStateManager(), "Must provide DurableStateManager");
    assert.ok(app.getSessionManager(), "Must provide SessionManager");

    // REPL initializes over the exact same ApplicationCore instance
    const repl = new InteractiveRepl(app, true);
    assert.strictEqual(repl.getApp(), app, "REPL must bind directly to shared ApplicationCore");
    assert.strictEqual(repl.getApp().getTaskId(), app.getTaskId(), "Task identity must be identical");
  });

  test("UI-002 & UI-003: Structured TaskExecutionResult and JSON output format", async () => {
    const app = createApp();

    // Populate plan milestones in agent
    const agent = app.getAgent();
    agent.setActivePlan([
      { name: "Inspect architecture", status: "completed", detail: "Done" },
      { name: "Implement changes", status: "in_progress" },
    ]);
    app.checkpointState("Initial plan defined");

    // Execute task with JSON mode enabled
    let taskEndedEvent: TaskExecutionResult | undefined;
    app.on("task:end", (res) => {
      taskEndedEvent = res;
    });

    const result = await app.runTask("Inspect project structure", { json: true });

    assert.ok(result);
    assert.strictEqual(typeof result.taskId, "string");
    assert.strictEqual(result.taskId, app.getTaskId());
    assert.strictEqual(typeof result.success, "boolean");
    assert.strictEqual(typeof result.durationMs, "number");
    assert.ok(Array.isArray(result.plan));
    assert.strictEqual(result.plan.length, 2);
    assert.strictEqual(result.plan[0].status, "completed");
    assert.ok(Array.isArray(result.validationReceipts));
    assert.ok(result.tokenStats);
    assert.strictEqual(typeof result.tokenStats.total, "number");

    // Event matches return value
    assert.strictEqual(taskEndedEvent?.taskId, result.taskId);

    // Verify machine-readable JSON serialization
    const serialized = JSON.stringify(result);
    const deserialized = JSON.parse(serialized);
    assert.strictEqual(deserialized.taskId, result.taskId);
    assert.strictEqual(deserialized.plan[0].name, "Inspect architecture");
  });

  test("UI-004 & UI-005: TerminalDashboard projects live ApplicationCore state without separate loop", () => {
    const app = createApp();

    // Define plan milestones and record candidate receipt
    app.getAgent().setActivePlan([
      { name: "Phase 1: Discovery", status: "completed" },
      { name: "Phase 2: Validation", status: "in_progress" },
    ]);

    const tracker = app.getCandidateTracker();
    const candidate = tracker.computeCandidateIdentitySync(gitRepoDir);
    const receipt = tracker.recordValidationReceipt({
      candidateId: candidate.candidateId,
      verifierCommand: "npm test",
      exitCode: 0,
      stdoutHash: hashContent("ok"),
      status: "PASSED",
      materialDependencies: [],
    });

    app.getStateManager().recordCandidateAndReceipt(app.getTaskId(), {
      candidateId: candidate.candidateId,
      candidateIdentity: candidate,
      receipt,
    });
    app.checkpointState();

    // Render snapshot directly from ApplicationCore
    const dashboard = new TerminalDashboard(app);
    const snapshot = dashboard.renderSnapshot(100, 30);

    assert.ok(snapshot.includes("NEXUS CODE FULL-SCREEN TUI DASHBOARD"));
    assert.ok(snapshot.includes("Discovery"), "Must project Phase 1 from ApplicationCore");
    assert.ok(snapshot.includes("Validation"), "Must project Phase 2 from ApplicationCore");
    assert.ok(snapshot.includes(app.getTaskId()), "Must project Task ID from ApplicationCore");
    assert.ok(snapshot.includes(candidate.candidateId.slice(0, 12)), "Must project Candidate ID");
  });

  test("UI-006: Unified slash commands via ApplicationCore", async () => {
    const app = createApp();

    // 1. /plan add
    const addRes = await app.executeSlashCommand("plan", "add Setup environment");
    assert.strictEqual(addRes.success, true);
    assert.strictEqual(app.getActivePlan().length, 1);
    assert.strictEqual(app.getActivePlan()[0].name, "Setup environment");
    assert.strictEqual(app.getActivePlan()[0].status, "pending");

    // 2. /plan start
    const startRes = await app.executeSlashCommand("plan", "start 1");
    assert.strictEqual(startRes.success, true);
    assert.strictEqual(app.getActivePlan()[0].status, "in_progress");

    // 3. /plan done
    const doneRes = await app.executeSlashCommand("plan", "done 1");
    assert.strictEqual(doneRes.success, true);
    assert.strictEqual(app.getActivePlan()[0].status, "completed");

    // Checkpoint verified on disk
    const state = app.getTaskState();
    assert.strictEqual(state.activePlan[0].status, "completed");
    assert.strictEqual(state.milestones.length, 1);

    // 4. /status
    const statusRes = await app.executeSlashCommand("status");
    assert.strictEqual(statusRes.success, true);
    assert.strictEqual(statusRes.data.taskId, app.getTaskId());
    assert.strictEqual(statusRes.data.model, "test-model");

    // 5. /tokens
    const tokensRes = await app.executeSlashCommand("tokens");
    assert.strictEqual(tokensRes.success, true);
    assert.strictEqual(typeof tokensRes.data.total, "number");

    // 6. Unknown command fails gracefully
    const unknownRes = await app.executeSlashCommand("unknown_cmd");
    assert.strictEqual(unknownRes.success, false);
  });

  test("ACT-004 & AUTH-001: Operator direct shell command runs through ExecutionSpine with operator actor", async () => {
    const app = createApp();

    let capturedOperatorEvent: any;
    app.on("operator:command", (ev) => {
      capturedOperatorEvent = ev;
    });

    const receipt = await app.executeOperatorCommand("echo 'operator shell test'");

    assert.ok(receipt);
    assert.strictEqual(receipt.toolName, "run_command");
    assert.strictEqual(receipt.actor, "operator", "Actor identity must be 'operator'");
    assert.strictEqual(receipt.executionDomain, "operator_direct_shell");
    assert.strictEqual(receipt.success, true);
    assert.ok(receipt.output && receipt.output.includes("operator shell test"));

    assert.ok(capturedOperatorEvent);
    assert.strictEqual(capturedOperatorEvent.command, "echo 'operator shell test'");
    assert.strictEqual(capturedOperatorEvent.receipt.actor, "operator");
  });

  test("Negative Path: Read-only configuration denies operator mutating commands", async () => {
    const app = createApp({ readOnly: true });

    // Attempting a mutating command in read-only mode fails closed
    const receipt = await app.executeOperatorCommand("rm -rf src/index.ts");
    assert.strictEqual(receipt.success, false);
    assert.strictEqual(receipt.status, "DENIED");
    assert.match(receipt.error!, /Read-only mode/);

    // Verify file remains on disk
    assert.strictEqual(fs.existsSync(path.join(gitRepoDir, "src", "index.ts")), true);
  });

  test("UI-001 & State Recovery: Recover task into ApplicationCore and continue execution", async () => {
    const app1 = createApp();
    const taskId = app1.getTaskId();

    // Define initial plan and checkpoint
    app1.getAgent().setActivePlan([
      { name: "Step 1: Init", status: "completed" },
      { name: "Step 2: Work", status: "in_progress" },
    ]);
    app1.checkpointState("Step 1 done");

    // Reconstruct new ApplicationCore pointing to same workspace
    const app2 = createApp();
    assert.notStrictEqual(app2.getTaskId(), taskId);

    // Recover previous task state into app2
    const rec = await app2.recoverTask(taskId);
    assert.strictEqual(rec.success, true);
    assert.strictEqual(app2.getTaskId(), taskId, "Recovered task ID must become active task ID");
    assert.strictEqual(app2.getActivePlan().length, 2);
    assert.strictEqual(app2.getActivePlan()[0].status, "completed");
  });
});
