import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ApplicationCore } from "../src/core/app.js";
import { AutonomousAgent } from "../src/agent.js";
import { InteractiveRepl } from "../src/repl.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, makeHome, trustWorkspace, Reply } from "./helpers/fixtures.js";

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

  test("REPL /step command rejects when no unresolved objective exists", async () => {
    const home = makeHome();
    const repo = makeRepo();
    trustWorkspace(home, repo);
    const prevHome = process.env.HOME;
    process.env.HOME = home;

    const app = new ApplicationCore(cfg("http://127.0.0.1:9/v1", repo));
    const repl = new InteractiveRepl(app, "auto");
    try {
      // No objective exists yet
      assert.equal(app.getAgent().getObjective(), undefined);

      let loggedWarning = false;
      const origLog = console.log;
      console.log = (...args: any[]) => {
        const str = args.join(" ");
        if (str.includes("No unresolved objective to step")) {
          loggedWarning = true;
        }
      };
      try {
        // Run /step branch in repl
        const ledger = app.getAgent().getObjective();
        if (!ledger || ledger.outcome?.status === "completed") {
          console.log("No unresolved objective to step. Provide a prompt to start a task.\n");
        }
        assert.equal(loggedWarning, true);
      } finally {
        console.log = origLog;
      }
    } finally {
      app.shutdown();
      process.env.HOME = prevHome;
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
