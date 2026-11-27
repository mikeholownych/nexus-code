import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeRepo } from "./helpers/fixtures.js";
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

test("a provider request with a lost response is recorded as unknown after process-crash resume", { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-p10-provider-crash-"));
  const home = path.join(root, "home");
  const repo = makeRepo({ "README.md": "base\n" });
  const taskIdFile = path.join(root, "task-id.txt");
  const resultFile = path.join(root, "resume-result.json");
  fs.mkdirSync(home, { recursive: true });

  const requests: unknown[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "m" }] }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => { raw += String(chunk); });
    req.on("end", () => {
      if (req.url?.endsWith("/chat/completions")) {
        try { requests.push(JSON.parse(raw)); } catch { requests.push(raw); }
        // The first response is lost when Nexus is killed; a later request gets a deterministic answer.
        if (requests.length > 1) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ id: "response-2", choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        }
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/v1`;
  const closeServer = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  trackResource("gateway", "provider crash fixture server not closed", () => server.listening, () => closeServer());

  const previousCwd = process.cwd();
  const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const childEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    TEST_GATEWAY: endpoint,
    TEST_WORKSPACE: repo,
    TEST_TASK_ID_FILE: taskIdFile,
    TEST_RESULT_FILE: resultFile,
  };
  let first: ReturnType<typeof spawn> | undefined;
  let resumed: ReturnType<typeof spawn> | undefined;
  const stop = async (child: ReturnType<typeof spawn> | undefined): Promise<void> => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  };

  try {
    const firstScript = `
      import fs from "node:fs";
      import { AutonomousAgent } from "./src/agent.ts";
      import { DEFAULT_CONTINUATION } from "./src/types.ts";
      const agent = new AutonomousAgent({ endpoint: process.env.TEST_GATEWAY, model: "m", maxSteps: 2, maxInferenceSubmissions: 5, continuation: { ...DEFAULT_CONTINUATION, maxInferenceSubmissions: 5 }, temperature: 0, workspace: process.env.TEST_WORKSPACE, shell: "bash", approvalMode: "auto", fullAccess: true }, 1, undefined, { durable: true });
      agent.ui = new Proxy({}, { get: () => () => {} });
      fs.writeFileSync(process.env.TEST_TASK_ID_FILE, agent.getTaskId());
      await agent.runTurn("Continue the task.");
      process.exit(0);
    `;
    first = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", firstScript], {
      cwd: cliRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackResource("child process", `provider crash fixture agent pid ${first.pid}`, () => first?.exitCode === null && first?.signalCode === null, () => first?.kill("SIGKILL"));
    let firstOutput = "";
    first.stdout?.on("data", (chunk) => { firstOutput += String(chunk); });
    first.stderr?.on("data", (chunk) => { firstOutput += String(chunk); });
    const firstExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => first!.once("exit", (code, signal) => resolve({ code, signal })));

    try {
      await waitFor("the durable task id", () => fs.existsSync(taskIdFile), 30_000);
    } catch (error) {
      assert.fail(`${error instanceof Error ? error.message : String(error)}\nfirst process output:\n${firstOutput}`);
    }
    try {
      await waitFor("the pending provider request or first-process exit", () => requests.length === 1 || first!.exitCode !== null || first!.signalCode !== null, 30_000);
      assert.equal(requests.length, 1, `first process ended before reaching the provider: exit=${first?.exitCode} signal=${first?.signalCode}\n${firstOutput}`);
    } catch (error) {
      assert.fail(`${error instanceof Error ? error.message : String(error)}\nfirst process output:\n${firstOutput}`);
    }
    assert.equal(fs.readFileSync(taskIdFile, "utf8").length > 0, true);
    first.kill("SIGKILL");
    const killed = await firstExit;
    assert.equal(killed.signal, "SIGKILL", `first process ended unexpectedly: ${JSON.stringify(killed)} ${firstOutput}`);

    const resumeScript = `
      import fs from "node:fs";
      import { AutonomousAgent } from "./src/agent.ts";
      import { DEFAULT_CONTINUATION } from "./src/types.ts";
      const agent = new AutonomousAgent({ endpoint: process.env.TEST_GATEWAY, model: "m", maxSteps: 2, maxInferenceSubmissions: 5, continuation: { ...DEFAULT_CONTINUATION, maxInferenceSubmissions: 5 }, temperature: 0, workspace: process.env.TEST_WORKSPACE, shell: "bash", approvalMode: "auto", fullAccess: true }, 1, undefined, { durable: true });
      agent.ui = new Proxy({}, { get: () => () => {} });
      const taskId = fs.readFileSync(process.env.TEST_TASK_ID_FILE, "utf8").trim();
      const recovery = await agent.recoverFromTaskState(taskId);
      const result = await agent.runTurn("", undefined, { resume: true });
      fs.writeFileSync(process.env.TEST_RESULT_FILE, JSON.stringify({ recovery, result, execution: agent.getObjective()?.execution }));
      agent.shutdown();
    `;
    resumed = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", resumeScript], {
      cwd: cliRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackResource("child process", `provider resume fixture agent pid ${resumed.pid}`, () => resumed?.exitCode === null && resumed?.signalCode === null, () => resumed?.kill("SIGKILL"));
    let resumeOutput = "";
    resumed.stdout?.on("data", (chunk) => { resumeOutput += String(chunk); });
    resumed.stderr?.on("data", (chunk) => { resumeOutput += String(chunk); });
    const resumedExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => resumed!.once("exit", (code, signal) => resolve({ code, signal })));
    assert.deepEqual(resumedExit, { code: 0, signal: null }, resumeOutput);
    assert.ok(fs.existsSync(resultFile), `resume result was not written: ${resumeOutput}`);
    const resumedState = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    assert.equal(resumedState.execution.inferenceSubmissions, requests.length, "every provider submission remains charged after restart");
    assert.equal(resumedState.execution.maxInferenceSubmissions, 5, "resume preserves the saved request ceiling");
    assert.equal(resumedState.execution.inferenceOutcomeUnknowns, 1, "the lost provider response is durably reported as unknown");
    assert.ok(requests.length > 1, "resume can submit again when the persisted allowance still has capacity");
  } finally {
    await stop(first);
    await stop(resumed);
    await closeServer();
    process.chdir(previousCwd);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
