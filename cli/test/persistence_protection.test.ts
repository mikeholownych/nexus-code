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

const syntheticGithubToken = `ghp_${"A".repeat(36)}`;
const syntheticOpenAiToken = `sk-${"B".repeat(28)}`;
const syntheticBearer = `Bearer ${"C".repeat(32)}`;

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("session persistence scrubs nested credential plaintext and keeps recoverable safe state", () => {
  const tempDir = makeTempDir("nexus-pers002-session-");
  try {
    const sessionsDir = path.join(tempDir, "sessions");
    const manager = new SessionManager(sessionsDir);
    const state = {
      id: "pers002-session",
      taskId: "pers002-task",
      sessionId: "pers002-session",
      title: "Keep this useful title",
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

    const manager = new SessionManager(sessionsDir);
    const recovered = manager.loadSession("legacy-task");
    assert.ok(recovered);
    assert.match(recovered.messages[0].content as string, /REDACTED/);
    const persisted = fs.readFileSync(path.join(sessionsDir, "legacy-task.json"), "utf8");
    assert.equal(persisted.includes(secret), false);
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
