import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AutonomousAgent } from "../src/agent.js";
import { makeRepo, startGateway } from "./helpers/fixtures.js";
import { trackResource } from "./helpers/leak_guard.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(description: string, check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(20);
  }
  assert.fail(`timed out waiting for ${description}`);
}

async function recoverAfterProcessCrash(includeCompletedSibling: boolean): Promise<{ effects: string; toolResults: string[] }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-p10-crash-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const previous = { home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  const repo = makeRepo({ "README.md": "base\n" });
  const counter = path.join(root, "effects.txt");
  const commandPidFile = path.join(root, "command.pid");
  const taskIdFile = path.join(root, "task-id.txt");
  const completedCall = { name: "run_command", args: { command: `printf 'completed\\n' >> '${counter}'; printf 'completed\\n'` } };
  const pendingLabel = includeCompletedSibling ? "pending" : "ran";
  const pendingCommand = `printf '%s\\n' "$$" > '${commandPidFile}'; printf '${pendingLabel}\\n' >> '${counter}'; if [ "$(wc -l < '${counter}')" -gt ${includeCompletedSibling ? 2 : 1} ]; then exit 0; fi; exec sleep 60`;
  const pendingCall = { name: "run_command", args: { command: pendingCommand, timeout_secs: 120 } };
  const initialCalls = includeCompletedSibling ? [completedCall, pendingCall] : [pendingCall];
  const gateway = await startGateway((n) => n === 1
    ? { kind: "tools", calls: initialCalls }
    : { kind: "text", content: "done" });
  const previousCwd = process.cwd();
  const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let child: ReturnType<typeof spawn> | undefined;
  let resumed: AutonomousAgent | undefined;
  let commandPid: number | undefined;

  try {
    const childScript = `
      import fs from "node:fs";
      import { AutonomousAgent } from "./src/agent.ts";
      const agent = new AutonomousAgent({ endpoint: process.env.TEST_GATEWAY, model: "m", maxSteps: 6, temperature: 0, workspace: process.env.TEST_WORKSPACE, shell: "bash", approvalMode: "auto", fullAccess: true }, 1, undefined, { durable: true });
      agent.ui = new Proxy({}, { get: () => () => {} });
      fs.writeFileSync(process.env.TEST_TASK_ID_FILE, agent.getTaskId());
      await agent.runTurn("Run the command and report its result.");
      process.exit(0);
    `;
    child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
      cwd: cliRoot,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        TEST_GATEWAY: gateway.url,
        TEST_WORKSPACE: repo,
        TEST_TASK_ID_FILE: taskIdFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackResource("child process", `crash fixture agent pid ${child.pid}`, () => child?.exitCode === null && child?.signalCode === null, () => child?.kill("SIGKILL"));
    let childOutput = "";
    child.stdout?.on("data", (chunk) => { childOutput += String(chunk); });
    child.stderr?.on("data", (chunk) => { childOutput += String(chunk); });
    const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child!.once("exit", (code, signal) => resolve({ code, signal }));
    });

    await waitFor("the child task id", () => fs.existsSync(taskIdFile));
    await waitFor("the first provider request", () => gateway.requests.length >= 1);
    await waitFor("the side effect and running command pid", () => fs.existsSync(counter) && fs.existsSync(commandPidFile));
    commandPid = Number(fs.readFileSync(commandPidFile, "utf8").trim());
    assert.ok(Number.isSafeInteger(commandPid) && commandPid > 1, "fixture recorded its own command pid");
    assert.equal(fs.readFileSync(counter, "utf8"), includeCompletedSibling ? "completed\npending\n" : "ran\n");

    child.kill("SIGKILL");
    const killed = await childExit;
    assert.equal(killed.signal, "SIGKILL", `child ended unexpectedly: ${JSON.stringify(killed)} ${childOutput}`);
    try { process.kill(commandPid, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }

    const taskId = fs.readFileSync(taskIdFile, "utf8").trim();
    resumed = new AutonomousAgent({ endpoint: gateway.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash", approvalMode: "auto", fullAccess: true } as any, 1, undefined, { durable: true });
    resumed.ui = new Proxy({}, { get: () => () => {} });
    const recovery = await resumed.recoverFromTaskState(taskId);
    assert.equal(recovery.interrupted, true, "restart identifies the durable operation left in flight");
    await resumed.runTurn("Continue.", undefined, { resume: true });

    const effects = fs.readFileSync(counter, "utf8");
    const toolResults = gateway.requests.flatMap((request: any) => request.messages ?? [])
      .filter((message: any) => message.role === "tool")
      .map((message: any) => String(message.content));
    return { effects, toolResults };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const recordedPid = commandPid ?? (fs.existsSync(commandPidFile) ? Number(fs.readFileSync(commandPidFile, "utf8").trim()) : undefined);
    if (Number.isSafeInteger(recordedPid) && recordedPid! > 1) {
      try { process.kill(recordedPid!, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    resumed?.shutdown();
    await gateway.close();
    process.chdir(previousCwd);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    if (previous.home === undefined) delete process.env.HOME; else process.env.HOME = previous.home;
    if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous.xdg;
  }
}

test("a real process crash after a tool side effect does not silently replay the call", async () => {
  const { effects, toolResults } = await recoverAfterProcessCrash(false);
  assert.equal(effects, "ran\n", "the side effect was not repeated after recovery");
  assert.ok(toolResults.some((content) => /effects, if any, are unknown/.test(content)), JSON.stringify(toolResults));
});

test("a crash during a multi-tool response preserves a completed sibling and does not replay the unknown sibling", async () => {
  const { effects, toolResults } = await recoverAfterProcessCrash(true);
  assert.equal(effects, "completed\npending\n", "the completed sibling remains once and the unknown sibling is not repeated");
  assert.ok(toolResults.some((content) => content.includes("completed")), JSON.stringify(toolResults));
  assert.ok(toolResults.some((content) => /effects, if any, are unknown/.test(content)), JSON.stringify(toolResults));
});
