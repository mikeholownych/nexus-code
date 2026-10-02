import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { CheckpointManager } from "../src/checkpoint.js";
import { KnowledgeGraph } from "../src/knowledge.js";
import { InteractiveRepl } from "../src/repl.js";
import { SessionManager } from "../src/session.js";
import { DurableStateManager, TaskStateWriteError } from "../src/core/state.js";
import { InformationFlowBoundary } from "../src/core/egress.js";
import { writeProtectedTextFile } from "../src/core/persistence_protection.js";
import { WorkspacePath } from "../src/core/workspace_path.js";

const syntheticGithubToken = `ghp_${"A".repeat(36)}`;
const syntheticOpenAiToken = `sk-${"B".repeat(28)}`;
const syntheticBearer = `Bearer ${"C".repeat(32)}`;
// Synthetic DATA-004 fixture, deliberately not a live credential.
const syntheticHighEntropyPathPart = "aZ7mK2pQ9x-V4nR8cT1yB6hW3";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("session persistence scrubs nested credential plaintext and keeps recoverable safe state", () => {
  const tempDir = makeTempDir("nexus-pers002-session-");
  try {
    const sessionsDir = path.join(tempDir, "sessions");
    const selectedWorkspace = WorkspacePath.fromSelectedWorkspace(tempDir);
    const manager = new SessionManager(sessionsDir, () => selectedWorkspace);
    const state = {
      id: "pers002-session",
      taskId: "pers002-task",
      sessionId: "pers002-session",
      title: "Keep this useful title",
      workspace: tempDir,
      activePlan: [{ name: "inspect", status: "completed", detail: "safe detail" }],
      messages: [
        { role: "user" as const, content: `Use ${syntheticGithubToken} when needed` },
        { role: "assistant" as const, content: [{ type: "text", text: `Nested ${syntheticOpenAiToken}` }] },
        {
          role: "assistant" as const,
          tool_calls: [{
            id: "call-safe-1",
            type: "function" as const,
            function: { name: "run", arguments: JSON.stringify({ nested: [{ authorization: syntheticBearer }], keep: "ordinary" }) },
          }],
        },
      ],
    };

    manager.saveSession(state);
    const filePath = path.join(sessionsDir, "pers002-task.json");
    const persisted = fs.readFileSync(filePath, "utf8");

    assert.equal(persisted.includes(syntheticGithubToken), false);
    assert.equal(persisted.includes(syntheticOpenAiToken), false);
    assert.equal(persisted.includes(syntheticBearer), false);
    assert.match(persisted, /REDACTED/);

    const recovered = manager.loadSession("pers002-task");
    assert.ok(recovered);
    assert.equal(recovered.title, "Keep this useful title");
    assert.equal(recovered.activePlan[0].detail, "safe detail");
    assert.equal(recovered.messages.length, 3);
    assert.match(recovered.messages[0].content as string, /REDACTED/);
    assert.equal(recovered.messages[2].tool_calls?.[0].id, "call-safe-1");
    assert.match(recovered.messages[2].tool_calls?.[0].function.arguments || "", /REDACTED/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("loading an older plaintext session rewrites protected bytes before successful recovery", () => {
  const tempDir = makeTempDir("nexus-pers002-migration-");
  try {
    const sessionsDir = path.join(tempDir, "sessions");
    fs.mkdirSync(sessionsDir);
    const secret = syntheticGithubToken;
    fs.writeFileSync(path.join(sessionsDir, "legacy-task.json"), JSON.stringify({
      schemaVersion: 1,
      taskId: "legacy-task",
      sessionId: "legacy-session",
      id: "legacy-session",
      title: "Legacy session",
      workspacePath: tempDir,
      workspace: tempDir,
      status: "in_progress",
      activePlan: [],
      milestones: [],
      validationReceipts: [],
      messages: [{ role: "user", content: `legacy ${secret}` }],
    }), "utf8");

    const selectedWorkspace = WorkspacePath.fromSelectedWorkspace(tempDir);
    const manager = new SessionManager(sessionsDir, () => selectedWorkspace);
    const recovered = manager.loadSession("legacy-task");
    assert.ok(recovered);
    assert.match(recovered.messages[0].content as string, /REDACTED/);
    const persisted = fs.readFileSync(path.join(sessionsDir, "legacy-task.json"), "utf8");
    assert.equal(persisted.includes(secret), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("persisted session workspace cannot mint WorkspacePath provenance or expand selected workspace", () => {
  const tempDir = makeTempDir("nexus-pers002-session-type-confusion-");
  const otherWorkspace = makeTempDir("nexus-pers002-session-other-");
  try {
    const sessionsDir = path.join(tempDir, "sessions");
    fs.mkdirSync(sessionsDir);
    fs.writeFileSync(path.join(sessionsDir, "forged.json"), JSON.stringify({
      schemaVersion: 1,
      taskId: "forged",
      sessionId: "forged",
      id: "forged",
      workspacePath: otherWorkspace,
      workspace: otherWorkspace,
      title: "Forged path identity",
      status: "in_progress",
      activePlan: [],
      milestones: [],
      validationReceipts: [],
      messages: [],
    }), "utf8");
    const selectedWorkspace = WorkspacePath.fromSelectedWorkspace(tempDir);
    const manager = new SessionManager(sessionsDir, () => selectedWorkspace);
    assert.equal(manager.loadSession("forged"), null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(otherWorkspace, { recursive: true, force: true });
  }
});

test("caller-supplied WorkspacePath cannot override selected SessionManager or state-manager identity", () => {
  const root = makeTempDir("nexus-pers002-capability-override-");
  const selected = path.join(root, "selected");
  const other = path.join(root, syntheticHighEntropyPathPart);
  const sessionsDir = path.join(root, "sessions");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(selected);
  fs.mkdirSync(other);
  try {
    const selectedIdentity = WorkspacePath.fromSelectedWorkspace(selected);
    const otherIdentity = WorkspacePath.fromSelectedWorkspace(other);
    const sessionManager = new SessionManager(sessionsDir, () => selectedIdentity);
    assert.throws(() => sessionManager.saveSession({
      id: "override-session",
      workspace: other,
      messages: [],
    }, otherIdentity));
    assert.equal(fs.existsSync(path.join(sessionsDir, "override-session.json")), false);

    const stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [selectedIdentity] });
    assert.throws(() => stateManager.saveTaskState({
      taskId: "override-state",
      sessionId: "override-state",
      id: "override-state",
      title: "must not accept caller-minted capability",
      workspacePath: other,
      workspace: other,
      status: "in_progress",
      activePlan: [],
      milestones: [],
      validationReceipts: [],
      messages: [],
    } as any, [otherIdentity]), TaskStateWriteError);
    assert.equal(fs.existsSync(path.join(stateDir, "override-state.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy state with a classified identity fails recovery without writing a sanitized shadow record", () => {
  const tempDir = makeTempDir("nexus-pers002-identity-migration-");
  try {
    const secretTaskId = syntheticGithubToken;
    const originalPath = path.join(tempDir, `${secretTaskId}.json`);
    fs.writeFileSync(originalPath, JSON.stringify({
      schemaVersion: 1,
      taskId: secretTaskId,
      sessionId: secretTaskId,
      id: secretTaskId,
      title: "Legacy identity fixture",
      workspacePath: tempDir,
      workspace: tempDir,
      status: "in_progress",
      activePlan: [],
      milestones: [],
      validationReceipts: [],
      messages: [{ role: "user", content: "ordinary content" }],
    }), "utf8");

    const manager = new DurableStateManager({ baseDir: tempDir });
    assert.throws(() => manager.loadTaskState(secretTaskId));
    assert.equal(fs.existsSync(originalPath), true);
    assert.equal(fs.readdirSync(tempDir).filter((name) => name.endsWith(".json")).length, 1);
    assert.equal(fs.readFileSync(originalPath, "utf8").includes(secretTaskId), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("knowledge persistence does not write credential plaintext and reloads a redacted entry", () => {
  const tempDir = makeTempDir("nexus-pers002-knowledge-");
  try {
    const workspace = path.join(tempDir, "workspace");
    fs.mkdirSync(workspace);
    const graph = new KnowledgeGraph(workspace);
    graph.set("provider credential", `Use ${syntheticGithubToken}`, "rule");

    const filePath = path.join(workspace, ".nexus", "knowledge.json");
    const persisted = fs.readFileSync(filePath, "utf8");
    assert.equal(persisted.includes(syntheticGithubToken), false);
    assert.match(persisted, /REDACTED/);

    const recovered = new KnowledgeGraph(workspace).get("provider credential");
    assert.ok(recovered);
    assert.match(recovered.value, /REDACTED/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("git checkpoint refuses to persist modified files containing classified credentials", () => {
  const tempDir = makeTempDir("nexus-pers002-checkpoint-git-");
  const previousHome = process.env.HOME;
  process.env.HOME = path.join(tempDir, "home");
  try {
    const workspace = path.join(tempDir, "workspace");
    fs.mkdirSync(workspace);
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Synthetic Fixture"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, "app.txt"), "safe baseline\n");
    execFileSync("git", ["add", "app.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, "app.txt"), `changed ${syntheticGithubToken}\n`);

    assert.throws(() => new CheckpointManager(workspace).createCheckpoint("sensitive checkpoint"), /sensitive/i);
    const checkpointRoot = path.join(process.env.HOME, ".nexus", "checkpoints");
    const workspacePartition = fs.readdirSync(checkpointRoot).map((name) => path.join(checkpointRoot, name));
    assert.equal(workspacePartition.every((directory) => fs.readdirSync(directory).length === 0), true);
    assert.equal(execFileSync("git", ["for-each-ref", "refs/nexus/checkpoints"], { cwd: workspace, encoding: "utf8" }).trim(), "");
    assert.equal(fs.readFileSync(path.join(workspace, "app.txt"), "utf8").includes(syntheticGithubToken), true);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("git checkpoint retains ordinary tracked state without changing the worktree", () => {
  const tempDir = makeTempDir("nexus-pers002-checkpoint-git-safe-");
  const previousHome = process.env.HOME;
  process.env.HOME = path.join(tempDir, "home");
  try {
    const workspace = path.join(tempDir, "workspace");
    fs.mkdirSync(workspace);
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Synthetic Fixture"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, "app.txt"), "safe baseline\n");
    execFileSync("git", ["add", "app.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, "app.txt"), "safe changed state\n");

    const checkpoint = new CheckpointManager(workspace).createCheckpoint("ordinary update");
    assert.ok(checkpoint.gitRef);
    assert.equal(execFileSync("git", ["show", `${checkpoint.gitRef}:app.txt`], { cwd: workspace, encoding: "utf8" }), "safe changed state\n");
    assert.equal(fs.readFileSync(path.join(workspace, "app.txt"), "utf8"), "safe changed state\n");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("git checkpoint permits a staged deletion with no index blob to inspect", () => {
  const tempDir = makeTempDir("nexus-pers002-checkpoint-delete-");
  const previousHome = process.env.HOME;
  process.env.HOME = path.join(tempDir, "home");
  try {
    const workspace = path.join(tempDir, "workspace");
    fs.mkdirSync(workspace);
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Synthetic Fixture"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, "remove.txt"), "ordinary content\n");
    execFileSync("git", ["add", "remove.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workspace });
    fs.rmSync(path.join(workspace, "remove.txt"));
    execFileSync("git", ["add", "-u"], { cwd: workspace });

    const checkpoint = new CheckpointManager(workspace).createCheckpoint("staged deletion");
    assert.ok(checkpoint.gitRef);
    assert.equal(execFileSync("git", ["diff", "--name-status", "HEAD", checkpoint.gitRef], { cwd: workspace, encoding: "utf8" }).trim(), "D\tremove.txt");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("non-git checkpoint refuses to copy sensitive workspace files", () => {
  const tempDir = makeTempDir("nexus-pers002-checkpoint-copy-");
  const previousHome = process.env.HOME;
  process.env.HOME = path.join(tempDir, "home");
  try {
    const workspace = path.join(tempDir, "workspace");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "secrets.txt"), `${syntheticOpenAiToken}\n`);

    assert.throws(() => new CheckpointManager(workspace).createCheckpoint("sensitive snapshot"), /sensitive/i);
    const checkpointRoot = path.join(process.env.HOME, ".nexus", "checkpoints");
    const workspacePartition = fs.readdirSync(checkpointRoot).map((name) => path.join(checkpointRoot, name));
    assert.equal(workspacePartition.every((directory) => fs.readdirSync(directory).length === 0), true);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("non-git checkpoint preserves an ordinary workspace snapshot", () => {
  const tempDir = makeTempDir("nexus-pers002-checkpoint-safe-");
  const previousHome = process.env.HOME;
  process.env.HOME = path.join(tempDir, "home");
  try {
    const workspace = path.join(tempDir, "workspace");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "README.md"), "ordinary engineering state\n");

    const checkpoint = new CheckpointManager(workspace).createCheckpoint("safe checkpoint");
    assert.ok(checkpoint.snapshotDir);
    assert.equal(fs.readFileSync(path.join(checkpoint.snapshotDir, "README.md"), "utf8"), "ordinary engineering state\n");
    const metadata = path.join(process.env.HOME, ".nexus", "checkpoints", fs.readdirSync(path.join(process.env.HOME, ".nexus", "checkpoints"))[0], `${checkpoint.id}.json`);
    assert.equal(JSON.parse(fs.readFileSync(metadata, "utf8")).name, "safe checkpoint");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("structured session export text is redacted before a durable file write", () => {
  const tempDir = makeTempDir("nexus-pers002-export-");
  try {
    const outPath = path.join(tempDir, "session.json");
    const session = { messages: [{ role: "user", content: `keep ordinary text; ${syntheticOpenAiToken}` }] };
    writeProtectedTextFile(outPath, JSON.stringify(session, null, 2));
    const persisted = fs.readFileSync(outPath, "utf8");
    assert.equal(persisted.includes(syntheticOpenAiToken), false);
    assert.match(persisted, /REDACTED/);
    assert.match(persisted, /keep ordinary text/);
    assert.deepEqual(JSON.parse(persisted).messages[0].role, "user");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("REPL history appends a redacted durable copy while retaining the live input in memory", () => {
  const tempDir = makeTempDir("nexus-pers002-history-");
  try {
    const historyFile = path.join(tempDir, "history");
    const repl = Object.create(InteractiveRepl.prototype) as any;
    repl.historyFile = historyFile;
    repl.history = [];

    repl.appendHistory(`connect with ${syntheticBearer}`);

    const persisted = fs.readFileSync(historyFile, "utf8");
    assert.equal(persisted.includes(syntheticBearer), false);
    assert.match(persisted, /REDACTED/);
    assert.equal(repl.history[0], `connect with ${syntheticBearer}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("REPL history loading scrubs legacy plaintext on disk before returning recovered history", () => {
  const tempDir = makeTempDir("nexus-pers002-history-migrate-");
  try {
    const historyFile = path.join(tempDir, "history");
    fs.writeFileSync(historyFile, `old prompt ${syntheticGithubToken}\nordinary line\n`);
    const repl = Object.create(InteractiveRepl.prototype) as any;
    repl.historyFile = historyFile;
    repl.history = [];

    repl.loadHistory();

    assert.equal(fs.readFileSync(historyFile, "utf8").includes(syntheticGithubToken), false);
    assert.match(repl.history[0], /REDACTED/);
    assert.equal(repl.history[1], "ordinary line");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("durable task state refuses a write if the persistence classifier fails", () => {
  const tempDir = makeTempDir("nexus-pers002-failure-");
  const boundary = InformationFlowBoundary.getGlobalInstance();
  const failingBoundary = new InformationFlowBoundary();
  failingBoundary.redactForDurablePersistence = () => {
    throw new Error("synthetic classifier failure");
  };
  try {
    InformationFlowBoundary.setGlobalInstance(failingBoundary);
    const manager = new DurableStateManager({ baseDir: tempDir });
    const state: any = {
      taskId: "failure-task",
      sessionId: "failure-session",
      workspacePath: tempDir,
      messages: [{ role: "user", content: syntheticGithubToken }],
    };

    assert.throws(() => manager.saveTaskState(state), TaskStateWriteError);
    assert.equal(fs.existsSync(path.join(tempDir, "failure-task.json")), false);
    assert.equal(fs.readdirSync(tempDir).some((name) => name.endsWith(".tmp")), false);
  } finally {
    InformationFlowBoundary.setGlobalInstance(boundary);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("durable task state refuses a credential embedded in workspace identity", () => {
  const tempDir = makeTempDir("nexus-pers002-path-secret-");
  try {
    const manager = new DurableStateManager({ baseDir: tempDir });
    const state: any = {
      taskId: "safe-task-identity",
      sessionId: "safe-session-identity",
      workspacePath: path.join(tempDir, syntheticGithubToken),
      messages: [{ role: "user", content: "ordinary content" }],
    };

    assert.throws(() => manager.saveTaskState(state), TaskStateWriteError);
    assert.equal(fs.existsSync(path.join(tempDir, "safe-task-identity.json")), false);
    assert.equal(fs.readdirSync(tempDir).some((name) => name.endsWith(".tmp")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("durable task state refuses a high-entropy path component rather than preserving it unclassified", () => {
  const tempDir = makeTempDir("nexus-pers002-path-entropy-");
  try {
    const manager = new DurableStateManager({ baseDir: tempDir });
    const state: any = {
      taskId: "safe-task-identity",
      sessionId: "safe-session-identity",
      workspacePath: path.join(tempDir, syntheticHighEntropyPathPart),
      messages: [{ role: "user", content: "ordinary content" }],
    };

    assert.throws(() => manager.saveTaskState(state), TaskStateWriteError);
    assert.equal(fs.existsSync(path.join(tempDir, "safe-task-identity.json")), false);
    assert.equal(fs.readdirSync(tempDir).some((name) => name.endsWith(".tmp")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("selected typed WorkspacePath survives durable serialization and restart recovery", () => {
  const root = makeTempDir("nexus-pers002-typed-workspace-");
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(workspace);
  try {
    const selectedWorkspace = WorkspacePath.fromSelectedWorkspace(workspace);
    const writer = new DurableStateManager({ baseDir: stateDir, workspacePaths: [selectedWorkspace] });
    writer.saveTaskState({
      taskId: "typed-workspace-task",
      sessionId: "typed-workspace-session",
      id: "typed-workspace-session",
      title: "recoverable workspace state",
      workspacePath: selectedWorkspace.value,
      workspace: selectedWorkspace.value,
      status: "in_progress",
      activePlan: [],
      milestones: [],
      validationReceipts: [],
      messages: [{ role: "user", content: "ordinary retained content" }],
    } as any);

    const persisted = fs.readFileSync(path.join(stateDir, "typed-workspace-task.json"), "utf8");
    assert.match(persisted, new RegExp(selectedWorkspace.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(persisted, /ordinary retained content/);

    const restarted = new DurableStateManager({
      baseDir: stateDir,
      workspacePaths: [WorkspacePath.fromSelectedWorkspace(workspace)],
    });
    const recovered = restarted.loadTaskState("typed-workspace-task");
    assert.equal(recovered.workspacePath, workspace);
    assert.equal(recovered.workspace, workspace);
    assert.equal(recovered.messages[0].content, "ordinary retained content");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("typed WorkspacePath does not override a positively identified credential", () => {
  const root = makeTempDir("nexus-pers002-typed-secret-");
  const workspace = path.join(root, syntheticGithubToken);
  fs.mkdirSync(workspace);
  try {
    const identity = WorkspacePath.fromSelectedWorkspace(workspace);
    const manager = new DurableStateManager({ baseDir: path.join(root, "state"), workspacePaths: [identity] });
    assert.throws(() => manager.saveTaskState({
      taskId: "typed-secret-task",
      sessionId: "typed-secret-session",
      id: "typed-secret-session",
      title: "must refuse secret-bearing identity",
      workspacePath: identity.value,
      workspace: identity.value,
      status: "in_progress",
      activePlan: [],
      milestones: [],
      validationReceipts: [],
      messages: [],
    } as any), TaskStateWriteError);
    assert.equal(fs.existsSync(path.join(root, "state", "typed-secret-task.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical positive credential findings block typed WorkspacePath persistence", () => {
  const root = makeTempDir("nexus-pers002-typed-credential-matrix-");
  const fixtures = [
    `Bearer ${"C".repeat(32)}`,
    syntheticGithubToken,
    syntheticOpenAiToken,
    `api_key='${"D".repeat(24)}'`,
    `AKIA${"A".repeat(16)}`,
    `AIzaSyD-${"1".repeat(30)}`,
    `hf_${"1".repeat(34)}`,
    `xoxb-${"1".repeat(24)}`,
  ];
  const boundary = InformationFlowBoundary.getGlobalInstance();
  try {
    for (const [index, syntheticCredential] of fixtures.entries()) {
      assert.ok(
        boundary.classifyText(syntheticCredential).some((finding) => finding.classificationType !== "UNCERTAIN"),
        `fixture ${index} must be positively identified by the accepted classifier`,
      );
      const workspace = path.join(root, `credential-${index}-${syntheticCredential}`);
      fs.mkdirSync(workspace);
      const identity = WorkspacePath.fromSelectedWorkspace(workspace);
      const stateDir = path.join(root, `state-${index}`);
      const manager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [identity] });
      assert.throws(() => manager.saveTaskState({
        taskId: `typed-credential-${index}`,
        sessionId: `typed-credential-session-${index}`,
        id: `typed-credential-session-${index}`,
        title: "synthetic typed-path credential fixture",
        workspacePath: identity.value,
        workspace: identity.value,
        status: "in_progress",
        activePlan: [],
        milestones: [],
        validationReceipts: [],
        messages: [],
      } as any), TaskStateWriteError);
      assert.equal(fs.existsSync(path.join(stateDir, `typed-credential-${index}.json`)), false);
    }

    const pem = "-----BEGIN RSA PRIVATE KEY-----\nsynthetic-private-key-material\n-----END RSA PRIVATE KEY-----";
    assert.ok(boundary.classifyText(pem).some((finding) => finding.classificationType !== "UNCERTAIN"));
    // PEM delimiters contain path separators/newlines, so this representation
    // cannot be a single POSIX directory component; direct classification is
    // covered here and path persistence is inapplicable.
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("typed WorkspacePath may resolve only an UNCERTAIN path entropy finding", () => {
  const root = makeTempDir("nexus-pers002-typed-uncertain-");
  const workspace = path.join(root, syntheticHighEntropyPathPart);
  fs.mkdirSync(workspace);
  try {
    assert.ok(InformationFlowBoundary.getGlobalInstance().classifyText(workspace)
      .some((finding) => finding.classificationType === "UNCERTAIN"));
    const identity = WorkspacePath.fromSelectedWorkspace(workspace);
    const stateDir = path.join(root, "state");
    const manager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [identity] });
    manager.saveTaskState({
      taskId: "typed-uncertain-task",
      sessionId: "typed-uncertain-session",
      id: "typed-uncertain-session",
      title: "typed uncertain identity",
      workspacePath: identity.value,
      workspace: identity.value,
      status: "in_progress",
      activePlan: [],
      milestones: [],
      validationReceipts: [],
      messages: [],
    } as any);
    const durable = fs.readFileSync(path.join(stateDir, "typed-uncertain-task.json"), "utf8");
    assert.ok(durable.includes(syntheticHighEntropyPathPart));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("typed WorkspacePath does not exempt arbitrary high-entropy message content", () => {
  const root = makeTempDir("nexus-pers002-typed-payload-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  try {
    const syntheticPayload = syntheticHighEntropyPathPart;
    const identity = WorkspacePath.fromSelectedWorkspace(workspace);
    const stateDir = path.join(root, "state");
    const manager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [identity] });
    manager.saveTaskState({
      taskId: "typed-payload-task",
      sessionId: "typed-payload-session",
      id: "typed-payload-session",
      title: "ordinary title",
      workspacePath: identity.value,
      workspace: identity.value,
      status: "in_progress",
      activePlan: [],
      milestones: [],
      validationReceipts: [],
      messages: [{ role: "user", content: `opaque payload ${syntheticPayload}` }],
    } as any);
    const durable = fs.readFileSync(path.join(stateDir, "typed-payload-task.json"), "utf8");
    assert.equal(durable.includes(syntheticPayload), false);
    assert.match(durable, /REDACTED/);
    assert.match(durable, /ordinary title/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspacePath property name alone does not grant typed-path preservation", () => {
  const root = makeTempDir("nexus-pers002-type-confusion-");
  const shapedDirectory = path.join(root, "nexus-a3k9m2v7q4p8-z5c1x6n0b4r2-abcdef");
  fs.mkdirSync(shapedDirectory);
  try {
    const manager = new DurableStateManager({ baseDir: path.join(root, "state") });
    assert.throws(() => manager.saveTaskState({
      taskId: "untyped-path-task",
      sessionId: "untyped-path-session",
      id: "untyped-path-session",
      title: "untyped path must fail closed",
      workspacePath: shapedDirectory,
      workspace: shapedDirectory,
      status: "in_progress",
      activePlan: [],
      milestones: [],
      validationReceipts: [],
      messages: [],
    } as any), TaskStateWriteError);
    assert.equal(fs.existsSync(path.join(root, "state", "untyped-path-task.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("WorkspacePath rejects normalization changes and detects a changed symlink target", () => {
  const root = makeTempDir("nexus-pers002-workspace-alias-");
  const targetA = path.join(root, "workspace-a");
  const targetB = path.join(root, "workspace-b");
  const alias = path.join(root, "selected-workspace");
  fs.mkdirSync(targetA);
  fs.mkdirSync(targetB);
  fs.symlinkSync(targetA, alias, "dir");
  try {
    assert.throws(() => WorkspacePath.fromSelectedWorkspace(`${alias}${path.sep}..${path.sep}selected-workspace`));
    const identity = WorkspacePath.fromSelectedWorkspace(alias);
    const stateDir = path.join(root, "state");
    const manager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [identity] });
    fs.unlinkSync(alias);
    fs.symlinkSync(targetB, alias, "dir");

    assert.throws(() => manager.saveTaskState({
      taskId: "changed-alias-task",
      sessionId: "changed-alias-session",
      id: "changed-alias-session",
      title: "changed resource alias",
      workspacePath: identity.value,
      workspace: identity.value,
      status: "in_progress",
      activePlan: [],
      milestones: [],
      validationReceipts: [],
      messages: [],
    } as any), TaskStateWriteError);
    assert.equal(fs.existsSync(path.join(stateDir, "changed-alias-task.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a reminted WorkspacePath cannot authorize a retargeted selected symlink", () => {
  const root = makeTempDir("nexus-pers002-reminted-alias-");
  const firstTarget = path.join(root, "first");
  const secondTarget = path.join(root, syntheticHighEntropyPathPart);
  const alias = path.join(root, "workspace-alias");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(firstTarget);
  fs.mkdirSync(secondTarget);
  try {
    fs.symlinkSync(firstTarget, alias, "dir");
    const selected = WorkspacePath.fromSelectedWorkspace(alias);
    const manager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [selected] });
    fs.unlinkSync(alias);
    fs.symlinkSync(secondTarget, alias, "dir");
    const reminted = WorkspacePath.fromSelectedWorkspace(alias);
    assert.throws(() => manager.saveTaskState({
      taskId: "retargeted-alias-task",
      sessionId: "retargeted-alias-task",
      id: "retargeted-alias-task",
      title: "must preserve original resource identity",
      workspacePath: alias,
      workspace: alias,
      status: "in_progress",
      activePlan: [],
      milestones: [],
      validationReceipts: [],
      messages: [],
    } as any, [reminted]), TaskStateWriteError);
    assert.equal(fs.existsSync(path.join(stateDir, "retargeted-alias-task.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("selected WorkspacePath capability is immutable and rejects forged instances", () => {
  const root = makeTempDir("nexus-pers002-immutable-capability-");
  const selectedPath = path.join(root, "selected");
  const otherPath = path.join(root, syntheticHighEntropyPathPart);
  const stateDir = path.join(root, "state");
  fs.mkdirSync(selectedPath);
  fs.mkdirSync(otherPath);
  try {
    const selected = WorkspacePath.fromSelectedWorkspace(selectedPath);
    const manager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [selected] });
    assert.equal(Reflect.set(selected as any, "value", otherPath), false);
    assert.equal(Reflect.set(selected as any, "canonicalPath", otherPath), false);

    const forged = Object.create(WorkspacePath.prototype);
    Object.defineProperties(forged, {
      value: { value: otherPath },
      canonicalPath: { value: otherPath },
    });
    assert.throws(() => manager.saveTaskState({
      taskId: "forged-workspace-capability",
      sessionId: "forged-workspace-capability",
      id: "forged-workspace-capability",
      title: "must reject forged capability",
      workspacePath: otherPath,
      workspace: otherPath,
      status: "in_progress",
      activePlan: [],
      milestones: [],
      validationReceipts: [],
      messages: [],
    } as any, [forged]));
    assert.equal(fs.existsSync(path.join(stateDir, "forged-workspace-capability.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
