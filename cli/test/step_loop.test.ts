import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ApplicationCore } from "../src/core/app.js";
import { AutonomousAgent } from "../src/agent.js";
import { InteractiveRepl } from "../src/repl.js";
import { SidecarServer } from "../src/sidecar.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, makeHome, trustWorkspace, waitUntil, Reply } from "./helpers/fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcIndex = path.resolve(here, "../src/index.ts");
const cliRoot = path.resolve(here, "..");

const quiet = (agent: AutonomousAgent) => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};

const cfg = (endpoint: string, workspace: string, o: Partial<HarnessConfig> = {}): HarnessConfig => ({
  endpoint,
  model: "m",
  maxSteps: 30,
  temperature: 0,
  workspace,
  shell: "bash",
  approvalMode: "auto",
  fullAccess: true,
  continuation: { ...DEFAULT_CONTINUATION },
  ...o,
});

const write = (name: string, content = `${name}\n`): Reply => ({
  kind: "tools",
  calls: [{ name: "write_file", args: { path: name, content } }],
});

const text = (content: string): Reply => ({ kind: "text", content });

describe("WP-1106: Single-step agent loop mode", () => {
  test("AC1: run --step pauses after one model-tool cycle", { timeout: 60_000 }, async () => {
    const home = makeHome();
    const repo = makeRepo();
    trustWorkspace(home, repo);
    const prevHome = process.env.HOME;
    process.env.HOME = home;

    const gw = await startGateway((n) => {
      if (n === 1) return write("step1.txt", "step 1 completed\n");
      return write("step2.txt", "step 2 completed\n");
    });

    const app = new ApplicationCore(cfg(gw.url, repo));
    try {
      const result = await app.runTask("Execute steps sequentially", { step: true });

      assert.equal(gw.requests.length, 1, "only 1 provider request cycle must be issued");
      assert.ok(fs.existsSync(path.join(repo, "step1.txt")), "first step tool call must be executed");
      assert.ok(!fs.existsSync(path.join(repo, "step2.txt")), "second step tool call must not be executed");

      assert.equal(result.turn.execution, "LIMIT_REACHED");
      assert.equal(result.turn.reason, "STEP_PAUSED");
      assert.equal(result.turn.stepPaused, true);
      assert.equal(result.turn.steps.used, 1);
      assert.equal(result.turn.steps.limitReached, true);

      // Objective status must be recorded and unresolved
      const durableState = app.getStateManager().loadTaskState(result.taskId);
      assert.ok(durableState, "task state must be persisted");
      assert.equal(durableState.lastTurn?.reason, "STEP_PAUSED");
      assert.equal(durableState.lastTurn?.stepPaused, true);
    } finally {
      app.shutdown();
      await gw.close();
      process.env.HOME = prevHome;
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("AC1b: --step pauses after a cycle whose tool calls are parallel reads", { timeout: 60_000 }, async () => {
    const home = makeHome();
    const repo = makeRepo({ "a.txt": "alpha\n", "b.txt": "beta\n" });
    trustWorkspace(home, repo);
    const prevHome = process.env.HOME;
    process.env.HOME = home;

    const gw = await startGateway((n) => {
      if (n === 1) {
        return {
          kind: "tools",
          calls: [
            { name: "read_file", args: { path: "a.txt" } },
            { name: "read_file", args: { path: "b.txt" } },
          ],
        };
      }
      return write("after-reads.txt", "must not exist\n");
    });

    const app = new ApplicationCore(cfg(gw.url, repo));
    try {
      const result = await app.runTask("Read both files, then write a file", { step: true });

      assert.equal(gw.requests.length, 1, "a parallel-read cycle must still end the step: only 1 provider request");
      assert.ok(!fs.existsSync(path.join(repo, "after-reads.txt")), "the edit after the reads must not run in the same --step");
      assert.equal(result.turn.reason, "STEP_PAUSED");
      assert.equal(result.turn.stepPaused, true);
      assert.equal(result.turn.steps.used, 1);
    } finally {
      app.shutdown();
      await gw.close();
      process.env.HOME = prevHome;
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("AC2: /step advances the current objective by exactly one cycle", { timeout: 60_000 }, async () => {
    const home = makeHome();
    const repo = makeRepo();
    trustWorkspace(home, repo);
    const prevHome = process.env.HOME;
    process.env.HOME = home;

    const gw = await startGateway((n) => {
      if (n === 1) return write("repl_step1.txt", "content 1\n");
      if (n === 2) return write("repl_step2.txt", "content 2\n");
      return text("done");
    });

    const app = new ApplicationCore(cfg(gw.url, repo));
    const agent = quiet(app.getAgent());
    try {
      // Step 1: Initial prompt in step mode
      const turn1 = await agent.runTurn("Create two files in separate steps", undefined, { step: true });
      assert.equal(turn1.reason, "STEP_PAUSED");
      assert.equal(gw.requests.length, 1);
      assert.ok(fs.existsSync(path.join(repo, "repl_step1.txt")));
      assert.ok(!fs.existsSync(path.join(repo, "repl_step2.txt")));

      const messagesBefore = agent.getMessages().length;

      // Step 2: Simulate operator /step command on unresolved objective
      const ledger = agent.getObjective();
      assert.ok(ledger && ledger.outcome?.status !== "completed", "objective must be unresolved");

      const turn2 = await agent.runTurn("", undefined, { step: true, resume: true });
      assert.equal(turn2.reason, "STEP_PAUSED");
      assert.equal(gw.requests.length, 2, "exactly one more cycle executed");
      assert.ok(fs.existsSync(path.join(repo, "repl_step2.txt")), "second tool call executed");

      // Verify no user message was pushed for /step
      const messagesAfter = agent.getMessages();
      const userMessages = messagesAfter.filter((m) => m.role === "user");
      assert.equal(userMessages.length, 1, "no extra user message appended for /step");
      assert.equal(userMessages[0].content.toString().includes("Create two files"), true);

      // Verify amendments on objective was not amended with blank text
      assert.equal(ledger.amendments.length, 0, "objective was not amended");
    } finally {
      app.shutdown();
      await gw.close();
      process.env.HOME = prevHome;
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("AC3a: run --resume --step resumes durable state without replaying completed tools", { timeout: 60_000 }, async () => {
    const home = makeHome();
    const repo = makeRepo();
    trustWorkspace(home, repo);
    const prevHome = process.env.HOME;
    process.env.HOME = home;

    let writeCount = 0;
    const gw = await startGateway((n) => {
      if (n === 1) {
        writeCount++;
        return write("resume1.txt", "part 1\n");
      }
      if (n === 2) {
        writeCount++;
        return write("resume2.txt", "part 2\n");
      }
      return text("all done");
    });

    let taskId = "";
    // Process 1: run initial step
    {
      const app1 = new ApplicationCore(cfg(gw.url, repo));
      try {
        const res = await app1.runTask("Two part task", { step: true });
        assert.equal(res.turn.reason, "STEP_PAUSED");
        taskId = res.taskId;
      } finally {
        app1.shutdown();
      }
    }

    assert.equal(writeCount, 1);
    assert.ok(fs.existsSync(path.join(repo, "resume1.txt")));
    assert.ok(!fs.existsSync(path.join(repo, "resume2.txt")));

    // Process 2: resume with --step
    {
      const app2 = new ApplicationCore(cfg(gw.url, repo));
      try {
        const res2 = await app2.runTask("", { resumeTaskId: taskId, step: true });
        assert.equal(res2.turn.reason, "STEP_PAUSED");
        assert.equal(gw.requests.length, 2, "second provider request made");
        assert.equal(writeCount, 2, "first tool was not replayed");
        assert.ok(fs.existsSync(path.join(repo, "resume2.txt")), "second tool executed");

        // Verify conversation history has original user message, assistant 1, tool 1, assistant 2, tool 2
        const messages = app2.getAgent().getMessages();
        const assistantMsgs = messages.filter((m) => m.role === "assistant");
        assert.equal(assistantMsgs.length, 2);
        const toolMsgs = messages.filter((m) => m.role === "tool");
        assert.equal(toolMsgs.length, 2);
      } finally {
        app2.shutdown();
      }
    }

    await gw.close();
    process.env.HOME = prevHome;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("AC3b: /step resumes saved objective after REPL restart", { timeout: 60_000 }, async () => {
    const home = makeHome();
    const repo = makeRepo();
    trustWorkspace(home, repo);
    const prevHome = process.env.HOME;
    process.env.HOME = home;

    const gw = await startGateway((n) => {
      if (n === 1) return write("repl_persist1.txt", "first\n");
      if (n === 2) return write("repl_persist2.txt", "second\n");
      return text("done");
    });

    let sessionId = "";
    // Session 1: initial step and save
    {
      const app1 = new ApplicationCore(cfg(gw.url, repo));
      const repl1 = new InteractiveRepl(app1, "auto");
      sessionId = (repl1 as any).currentSessionId;
      try {
        await (repl1 as any).runInteractiveTurn("Sequential REPL task", undefined, { step: true });
        assert.ok(fs.existsSync(path.join(repo, "repl_persist1.txt")));
      } finally {
        app1.shutdown();
      }
    }

    // Session 2: restore by sessionId and issue /step
    {
      const app2 = new ApplicationCore(cfg(gw.url, repo));
      const repl2 = new InteractiveRepl(app2, "auto", sessionId);
      try {
        const ledger = app2.getAgent().getObjective();
        assert.ok(ledger, "objective must be restored");
        assert.notEqual(ledger.outcome?.status, "completed");

        await (repl2 as any).runInteractiveTurn("", undefined, { step: true, resume: true });
        assert.equal(gw.requests.length, 2);
        assert.ok(fs.existsSync(path.join(repo, "repl_persist2.txt")));
      } finally {
        app2.shutdown();
      }
    }

    await gw.close();
    process.env.HOME = prevHome;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("AC4: step mode preserves terminal and interrupted outcomes", { timeout: 60_000 }, async () => {
    const home = makeHome();
    const repo = makeRepo();
    trustWorkspace(home, repo);
    const prevHome = process.env.HOME;
    process.env.HOME = home;

    // 4a: Terminal outcome
    {
      const gw = await startGateway(() => text("Here is the completed explanation with no tools needed."));
      const app = new ApplicationCore(cfg(gw.url, repo));
      try {
        const res = await app.runTask("Explain something", { step: true });
        assert.equal(res.turn.execution, "COMPLETED");
        assert.equal(res.turn.outcome, "NOT_REQUIRED");
        assert.notEqual(res.turn.reason, "STEP_PAUSED");
        assert.equal(res.turn.stepPaused, undefined);
      } finally {
        app.shutdown();
        await gw.close();
      }
    }

    // 4b: Interrupted outcome (AbortSignal)
    {
      const gw = await startGateway(() => ({ kind: "text", content: "slow", delayMs: 2000 }));
      const app = new ApplicationCore(cfg(gw.url, repo));
      const abort = new AbortController();
      try {
        setTimeout(() => abort.abort(), 100);
        const res = await app.runTask("Cancelled task", { step: true, signal: abort.signal });
        assert.equal(res.turn.execution, "INTERRUPTED");
        assert.equal(res.turn.reason, "OPERATOR_INTERRUPT");
        assert.notEqual(res.turn.reason, "STEP_PAUSED");
      } finally {
        app.shutdown();
        await gw.close();
      }
    }

    // 4c: Provider failure
    {
      const gw = await startGateway(() => ({ kind: "http", status: 500, body: "Internal Server Error" }));
      const app = new ApplicationCore(cfg(gw.url, repo));
      try {
        const res = await app.runTask("Failing task", { step: true });
        assert.equal(res.turn.execution, "FAILED");
        assert.equal(res.turn.reason, "INFERENCE_FAILED");
        assert.notEqual(res.turn.reason, "STEP_PAUSED");
      } finally {
        app.shutdown();
        await gw.close();
      }
    }

    process.env.HOME = prevHome;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("AC5: step mode is opt-in and leaves default continuation unchanged", { timeout: 60_000 }, async () => {
    const home = makeHome();
    const repo = makeRepo();
    trustWorkspace(home, repo);
    const prevHome = process.env.HOME;
    process.env.HOME = home;

    const gw = await startGateway((n) => {
      if (n === 1) return write("opt1.txt", "1\n");
      if (n === 2) return write("opt2.txt", "2\n");
      return text("All work is finished.");
    });

    const app = new ApplicationCore(cfg(gw.url, repo));
    try {
      // Normal run without step mode continues across cycles until completion
      const res = await app.runTask("Run all steps automatically");
      assert.equal(gw.requests.length, 3, "default mode must continue automatically");
      assert.equal(res.turn.execution, "COMPLETED");
      assert.notEqual(res.turn.reason, "STEP_PAUSED");
      assert.ok(fs.existsSync(path.join(repo, "opt1.txt")));
      assert.ok(fs.existsSync(path.join(repo, "opt2.txt")));
    } finally {
      app.shutdown();
      await gw.close();
      process.env.HOME = prevHome;
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("REPL /step (real handler): refuses without an unresolved objective, then checkpoints and runs one cycle", { timeout: 60_000 }, async () => {
    const home = makeHome();
    const repo = makeRepo();
    trustWorkspace(home, repo);
    // The first prompt's inference fails, which leaves its objective unresolved; /step then runs one cycle.
    let phase: "fail" | "work" = "fail";
    let workRequests = 0;
    const gw = await startGateway(() => {
      if (phase === "fail") return { kind: "http", status: 400, body: '{"error":"bad request"}' };
      workRequests++;
      return workRequests === 1 ? write("repl_step_a.txt", "a\n") : write("repl_step_b.txt", "must not exist\n");
    });
    const child = spawn(
      process.execPath,
      ["--import", "tsx", srcIndex, "repl", "-y", "-w", repo, "-e", gw.url, "-m", "m"],
      { cwd: cliRoot, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") }, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stdout += d.toString()));
    const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
    // The REPL reads one line per prompt: send the next line only when the n-th prompt is showing.
    const prompts = () => stdout.split("❯ ").length - 1;
    const send = async (n: number, line: string): Promise<number> => {
      await waitUntil(() => prompts() >= n, 30_000);
      child.stdin.write(`${line}\n`);
      return stdout.length;
    };
    try {
      await send(1, "/step");
      const afterRefusal = await send(2, "Create the files");
      // The failed turn left the objective unresolved; switch the provider to working replies before /step.
      await waitUntil(() => prompts() >= 3, 30_000);
      phase = "work";
      const beforeFirstListing = await send(3, "/checkpoints");
      const beforeStep = await send(4, "/step");
      const beforeSecondListing = await send(5, "/checkpoints");
      await waitUntil(() => prompts() >= 6, 30_000);
      child.stdin.end();
      await closed;

      assert.match(stdout.slice(0, afterRefusal), /No unresolved objective to step/, "the real /step handler refuses without an objective");
      assert.equal(workRequests, 1, "/step ran exactly one model request");
      assert.ok(fs.existsSync(path.join(repo, "repl_step_a.txt")), "/step ran the cycle's tool call");
      assert.ok(!fs.existsSync(path.join(repo, "repl_step_b.txt")), "/step paused after one cycle");
      // /step made its own rollback checkpoint, named after the objective: only the listing after /step shows it.
      assert.doesNotMatch(stdout.slice(beforeFirstListing, beforeStep), /Step: Create the files/);
      assert.match(stdout.slice(beforeSecondListing), /Step: Create the files/, `no /step checkpoint listed after /step:\n${stdout}`);
    } finally {
      if (child.exitCode === null) child.kill();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("CLI index --step option parses and passes through to runTask", async () => {
    const home = makeHome();
    const repo = makeRepo();
    trustWorkspace(home, repo);
    const prevHome = process.env.HOME;
    process.env.HOME = home;

    const gw = await startGateway((n) => {
      if (n === 1) return write("cli_step.txt", "cli\n");
      return text("done");
    });

    try {
      const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", srcIndex, "run", "--step", "-y", "-j", "-w", repo, "-e", gw.url, "-m", "m", "Do one step"],
          { cwd: cliRoot, env: { ...process.env, HOME: home } }
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });

      assert.equal(gw.requests.length, 1);
      assert.ok(fs.existsSync(path.join(repo, "cli_step.txt")));
      const parsed = JSON.parse(stdout.trim());
      assert.equal(parsed.turn.execution, "LIMIT_REACHED");
      assert.equal(parsed.turn.reason, "STEP_PAUSED");
      assert.equal(parsed.turn.stepPaused, true);
    } finally {
      await gw.close();
      process.env.HOME = prevHome;
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

const readA = (): Reply => ({ kind: "tools", calls: [{ name: "read_file", args: { path: "a.txt" } }] });

/** Runs an objective with one step, then /step until the turn stops for a reason other than STEP_PAUSED. */
async function stepUntilStopped(continuation: Partial<HarnessConfig["continuation"]>, maxSteps = 10) {
  const home = makeHome();
  const repo = makeRepo({ "a.txt": "alpha\n" });
  trustWorkspace(home, repo);
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  const gw = await startGateway(readA);
  const app = new ApplicationCore(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION, ...continuation } }));
  const agent = quiet(app.getAgent());
  try {
    const reasons: string[] = [];
    let turn = await agent.runTurn("Read a.txt", undefined, { step: true });
    reasons.push(turn.reason);
    while (turn.reason === "STEP_PAUSED" && reasons.length < maxSteps) {
      turn = await agent.runTurn("", undefined, { step: true, resume: true });
      reasons.push(turn.reason);
    }
    const messages = agent.getMessages().map((m) => (typeof m.content === "string" ? m.content : ""));
    return { reasons, turn, messages, requests: gw.requests.length };
  } finally {
    app.shutdown();
    await gw.close();
    process.env.HOME = prevHome;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

interface StepRig {
  server: SidecarServer;
  events: any[];
  repo: string;
  app: ApplicationCore;
  /** Replaces the provider's script; `k` counts requests from the change (1-based). */
  script(next: (k: number) => Reply): void;
  send(msg: Record<string, unknown>): Promise<void>;
}

/** A TUI sidecar whose first prompt fails at inference, so it leaves an unresolved objective for /step. */
async function withStepSidecar(fn: (rig: StepRig) => Promise<void>): Promise<void> {
  let current: (k: number) => Reply = () => ({ kind: "http", status: 400, body: '{"error":"bad request"}' });
  let base = 0;
  const gw = await startGateway((n) => current(n - base));
  const repo = makeRepo();
  const home = makeHome();
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = new ApplicationCore(cfg(gw.url, repo, { maxSteps: 6 }));
  const events: any[] = [];
  const server = new SidecarServer({ app, mode: "auto", write: (line) => events.push(JSON.parse(line)) });
  server.start();
  const send = (msg: Record<string, unknown>) => server.handleLine(JSON.stringify({ v: 1, ...msg }));
  try {
    await fn({
      server, events, repo, app, send,
      script: (next) => {
        base = gw.requests.length;
        current = next;
      },
    });
  } finally {
    await send({ type: "cancel" });
    await server.idle();
    app.shutdown();
    await gw.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("WP-1301: /step in the TUI and the step pause", () => {
  test("TUI /step runs as a sidecar turn: checkpoint, live tool events, saved session, turn.result", { timeout: 60_000 }, async () => {
    await withStepSidecar(async ({ server, events, repo, app, script, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "Create the files" });
      await server.idle();
      assert.equal(events.find((e) => e.type === "turn.result" && e.turn_id === "t1")?.turn.execution, "FAILED");
      const checkpointsBefore = app.getCheckpointManager().listCheckpoints().length;

      script((k) => (k === 1 ? write("tui_step_a.txt", "a\n") : write("tui_step_b.txt", "must not exist\n")));
      await send({ type: "slash", id: "s1", command: "step" });
      await server.idle();

      assert.ok(fs.existsSync(path.join(repo, "tui_step_a.txt")), "the stepped cycle ran its tool call");
      assert.ok(!fs.existsSync(path.join(repo, "tui_step_b.txt")), "/step paused after one cycle");
      const checkpoints = app.getCheckpointManager().listCheckpoints();
      assert.equal(checkpoints.length, checkpointsBefore + 1, "/step made a rollback checkpoint before it ran");
      assert.match(checkpoints[0].name, /^Step: Create the files/, "the newest checkpoint is the step's");
      const start = events.find((e) => e.type === "tool.start" && e.turn_id === "s1");
      assert.equal(start?.tool, "write_file", "the stepped tool call streamed as a live tool event");
      const result = events.find((e) => e.type === "turn.result" && e.turn_id === "s1");
      assert.ok(result, "/step reports through turn.result");
      assert.equal(result.turn.execution, "LIMIT_REACHED");
      assert.equal(result.turn.reason, "STEP_PAUSED");
      const sessions = app.getSessionManager().listSessions();
      assert.equal(sessions.length, 1, "the step saved into the same session as the turn before it");
      const saved = app.getSessionManager().loadSession(sessions[0].id);
      assert.equal(saved?.lastTurn?.reason, "STEP_PAUSED", "the session saved after the step records the step's result");
      assert.ok(
        saved?.messages.some((m: any) => m.role === "tool" && m.name === "write_file"),
        "the saved session holds the step's write_file tool message",
      );
      assert.equal(events.some((e) => e.type === "slash.result" && /Step completed/.test(e.output ?? "")), false);
    });
  });

  test("TUI /step: /undo rolls back only the step, not the turn before it", { timeout: 60_000 }, async () => {
    await withStepSidecar(async ({ server, events, repo, script, send }) => {
      // The first turn changes the workspace, then fails at inference: its objective stays unresolved.
      script((k) => (k === 1 ? write("turn_one.txt", "kept\n") : { kind: "http", status: 400, body: '{"error":"bad request"}' }));
      await send({ type: "prompt.submit", id: "t1", text: "Create the files" });
      await server.idle();
      assert.ok(fs.existsSync(path.join(repo, "turn_one.txt")));

      script((k) => (k === 1 ? write("step_one.txt", "undone\n") : write("step_two.txt", "must not exist\n")));
      await send({ type: "slash", id: "s1", command: "step" });
      await server.idle();
      assert.ok(fs.existsSync(path.join(repo, "step_one.txt")));

      await send({ type: "slash", id: "u1", command: "undo" });
      await server.idle();
      assert.equal(events.find((e) => e.type === "slash.result" && e.id === "u1")?.success, true);
      assert.ok(!fs.existsSync(path.join(repo, "step_one.txt")), "/undo removed the step's change");
      assert.ok(fs.existsSync(path.join(repo, "turn_one.txt")), "/undo kept the previous turn's change");
    });
  });

  test("TUI /step whose inference fails is reported as FAILED through turn.result, never as Step completed", { timeout: 60_000 }, async () => {
    await withStepSidecar(async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "Create the files" });
      await server.idle();
      await send({ type: "slash", id: "s1", command: "step" });
      await server.idle();
      const result = events.find((e) => e.type === "turn.result" && e.turn_id === "s1");
      assert.equal(result?.turn.execution, "FAILED");
      assert.equal(events.some((e) => e.type === "slash.result" && e.id === "s1" && /Step completed/.test(e.output ?? "")), false);
    });
  });

  test("TUI /step can be cancelled, during inference and immediately after it is sent", { timeout: 60_000 }, async () => {
    for (const delayBeforeCancel of [200, 0]) {
      await withStepSidecar(async ({ server, events, repo, script, send }) => {
        await send({ type: "prompt.submit", id: "t1", text: "Create the files" });
        await server.idle();
        script(() => ({ ...write("slow_step.txt", "must not exist\n"), delayMs: 3000 }));
        const started = Date.now();
        await send({ type: "slash", id: "s1", command: "step" });
        if (delayBeforeCancel) await new Promise((r) => setTimeout(r, delayBeforeCancel));
        await send({ type: "cancel" });
        await server.idle();
        assert.ok(Date.now() - started < 2500, `cancel (after ${delayBeforeCancel} ms) ended /step before the provider replied`);
        assert.equal(events.some((e) => e.type === "notice" && /cannot be cancelled/.test(e.text)), false);
        assert.equal(events.find((e) => e.type === "turn.result" && e.turn_id === "s1")?.turn.execution, "INTERRUPTED");
        assert.ok(!fs.existsSync(path.join(repo, "slow_step.txt")));
      });
    }
  });

  // The provider replies that make up one model request (an empty stream is re-requested once without streaming), and
  // the note that continuation path leaves for the model's next cycle.
  const continuations: Array<[string, Reply[], RegExp]> = [
    ["an empty reply", [text(""), text("")], /your reply was empty/],
    ["a reply whose only tool call is dropped with a notice", [{ kind: "tools", calls: [{ name: " ", args: {} }] }], /Malformed native tool call dropped/],
    ["a reply cut off at the output limit", [{ ...write("cut.txt", "x".repeat(200)), truncated: true }], /output limit/],
  ];
  for (const [name, cycle, note] of continuations) {
    test(`--step pauses after ${name}: one provider request, no second cycle`, { timeout: 60_000 }, async () => {
      const home = makeHome();
      const repo = makeRepo();
      trustWorkspace(home, repo);
      const prevHome = process.env.HOME;
      process.env.HOME = home;
      const gw = await startGateway((n) => cycle[n - 1] ?? write("second_cycle.txt", "must not exist\n"));
      const app = new ApplicationCore(cfg(gw.url, repo));
      try {
        const agent = quiet(app.getAgent());
        const turn = await agent.runTurn("Write the file", undefined, { step: true });
        assert.equal(gw.requests.length, cycle.length, "one model request per --step");
        const last = agent.getMessages().at(-1);
        assert.match(typeof last?.content === "string" ? last.content : "", note, "the cycle took the continuation path under test");
        assert.equal(turn.reason, "STEP_PAUSED");
        assert.ok(!fs.existsSync(path.join(repo, "second_cycle.txt")));
      } finally {
        app.shutdown();
        await gw.close();
        process.env.HOME = prevHome;
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }

  test("the step pause keeps a STAGNATION_DETECTED set during the cycle (recovery exhausted)", { timeout: 60_000 }, async () => {
    // Only recovery exhaustion can stop this run: the no-progress limit is out of reach.
    const { reasons, turn, messages } = await stepUntilStopped({ maxRecoveries: 1, stagnationSteps: 100 });
    assert.equal(turn.reason, "STAGNATION_DETECTED", `reasons: ${reasons.join(", ")}`);
    assert.match((turn as any).detail ?? "", /recovery exhausted|repeated read_file/);
    // endStep ran at each pause: the recovery note reached the conversation.
    assert.ok(messages.some((m) => m.startsWith("[Nexus recovery")), "the recovery note was delivered");
  });

  test("steps without progress accumulate across /step calls until STAGNATION_DETECTED", { timeout: 60_000 }, async () => {
    // Recovery cannot exhaust here: only the no-progress count can stop the run.
    const { reasons, turn } = await stepUntilStopped({ maxRecoveries: 50, stagnationSteps: 3 });
    assert.equal(turn.reason, "STAGNATION_DETECTED", `reasons: ${reasons.join(", ")}`);
    assert.match((turn as any).detail ?? "", /consecutive steps without progress/);
    assert.ok(reasons.length <= 6, `stopped within a few /step calls: ${reasons.join(", ")}`);
  });
});
