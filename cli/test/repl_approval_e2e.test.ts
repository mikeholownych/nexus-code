/**
 * ACC-SAFE-03 & ACC-SAFE-08: REPL approval hardening e2e in a real pseudo-terminal (PTY).
 *
 * Verifies:
 * 1. Lone Enter at approval prompt -> DENIED (returns false, file not written)
 * 2. Keystrokes typed ahead before approval prompt -> cleared with Ctrl-U and line buffer reset, DENIED
 * 3. Paste within the 400ms grace window -> discarded, not approved
 * 4. Deliberate 'y' after 500ms -> APPROVED (action executed)
 * 5. 'a' (always allow session) requires explicit confirmation typing 'all';
 *    unconfirmed cancels and reprompts, confirmed switches session to auto-approve.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startGateway, makeRepo, makeHome, trustWorkspace, Reply, ptyTest } from "./helpers/fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const INDEX = path.join(ROOT, "dist/index.js");
const DRIVER = path.join(here, "helpers/repl_approval_driver.py");

function script(_n: number, body: any): Reply {
  const messages: any[] = body?.messages ?? [];
  let lastUserIdx = -1;
  let filename = "target.txt";

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      const text = typeof messages[i].content === "string" ? messages[i].content : "";
      const m = text.match(/create\s+([a-zA-Z0-9_\-\.]+)/i);
      if (m) filename = m[1];
      break;
    }
  }

  const toolsSinceUser = lastUserIdx >= 0
    ? messages.slice(lastUserIdx).filter((m) => m.role === "tool").length
    : 0;

  if (toolsSinceUser === 0) {
    return {
      kind: "tools",
      calls: [{ name: "write_file", args: { path: filename, content: `content for ${filename}\n` } }],
      delayMs: 500, // delay allows typed-ahead input to land mid-turn
    };
  }
  return { kind: "text", content: `Finished handling ${filename}.` };
}

async function runScenario(scenario: string): Promise<any> {
  const repo = makeRepo();
  const home = makeHome();
  trustWorkspace(home, repo);
  const gw = await startGateway(script);
  const plan = {
    node: process.execPath,
    index: INDEX,
    args: ["repl", "--approve", "-w", repo, "-e", gw.url, "-m", "m"],
    ws: repo,
    home,
    scenario,
    env: {
      HOME: home,
      NEXUS_DEBUG: "0",
    },
  };
  const planFile = path.join(home, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan));

  let driverShutdownConfirmed = false;
  try {
    const { code, out, err } = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn("python3", [DRIVER, planFile], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (c) => resolve({ code: c, out, err }));
    });
    // The driver exits successfully only after its finally block confirms that
    // the PTY process group has stopped. Preserve the fixture on every other
    // exit so a surviving child cannot write into a HOME being removed here.
    driverShutdownConfirmed = code === 0;
    assert.equal(code, 0, `driver failed for scenario '${scenario}':\n${err}\n${out}`);
    const lastLine = out.trim().split("\n").pop() || "{}";
    return JSON.parse(lastLine);
  } finally {
    await gw.close();
    if (driverShutdownConfirmed) {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
}

ptyTest("REPL approval hardening (ACC-SAFE-03): lone Enter, typed-ahead, paste, deliberate approval, and session confirmation", { timeout: 180_000 }, async () => {
  assert.ok(fs.existsSync(INDEX), `missing ${INDEX} (run npm run build)`);
  assert.ok(fs.existsSync(DRIVER), `missing ${DRIVER}`);

  // 1. Lone Enter -> DENIED
  const r1 = await runScenario("lone_enter");
  assert.equal(r1.file_created, false, "lone Enter must NOT approve the action");
  assert.equal(r1.passed, true);

  // 2. Typed ahead mid-turn -> DISCARDED & DENIED
  const r2 = await runScenario("typed_ahead");
  assert.equal(r2.file_created, false, "typed-ahead input must be discarded and NOT approve");
  assert.equal(r2.passed, true);

  // 3. Paste during grace window -> DISCARDED & NOT APPROVED
  const r3 = await runScenario("paste");
  assert.equal(r3.created_during_grace, false, "burst/paste during grace window must NOT approve");
  assert.equal(r3.created_after_deny, false);
  assert.equal(r3.passed, true);

  // 4. Deliberate 'y' after grace window -> APPROVED
  const r4 = await runScenario("deliberate");
  assert.equal(r4.file_created, true, "deliberate 'y' after grace window MUST approve");
  assert.equal(r4.passed, true);

  // 5. 'a' confirmation: unconfirmed cancels, 'all' enables auto-mode
  const r5 = await runScenario("confirm_a");
  assert.equal(r5.auto1_cancelled, true, "unconfirmed 'a' must cancel auto-approval");
  assert.equal(r5.auto1_created, true, "confirmed 'a' with 'all' must approve initial action");
  assert.equal(r5.auto2_created, true, "subsequent actions must run in auto mode without prompt");
  assert.equal(r5.passed, true);
});

const STARTUP_DRIVER = path.join(here, "helpers/startup_permission_driver.py");
const TRUST_MARKER = "TRUSTED_FOLDER_INSTRUCTIONS_CANARY";

async function runStartupPermissionCase(surface: "tui" | "repl", trusted: boolean, mode: "review" | "auto" | undefined) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-safe01-"));
  const repo = path.join(parent, "workspace");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  fs.writeFileSync(path.join(repo, "AGENTS.md"), `${TRUST_MARKER}\n`);
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Nexus test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "nexus-test@example.invalid"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
  const home = makeHome();
  if (trusted) trustWorkspace(home, repo);
  const gw = await startGateway((_n, body) => {
    const messages: any[] = body?.messages ?? [];
    const hasToolResult = messages.some((message) => message.role === "tool");
    return hasToolResult
      ? { kind: "text", content: "COMMAND_FINISHED" }
      : { kind: "tools", calls: [{ name: "run_command", args: { command: "echo x > ../outside" } }] };
  });
  const args = surface === "repl" ? ["repl"] : [];
  if (mode) args.push("--mode", mode);
  args.push("-w", repo, "-e", gw.url, "-m", "m");
  const plan = {
    node: process.execPath,
    index: INDEX,
    args,
    cwd: repo,
    home,
    surface,
    trusted,
    mode: mode ?? "default",
  };
  const planFile = path.join(home, "startup-plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan));
  let driverShutdownConfirmed = false;
  try {
    const { code, out, err } = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn("python3", [STARTUP_DRIVER, planFile], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("close", (exitCode) => resolve({ code: exitCode, out, err }));
    });
    driverShutdownConfirmed = code === 0;
    assert.equal(code, 0, `${surface}/${trusted ? "trusted" : "untrusted"}/${mode ?? "default"} failed:\n${err}\n${out}`);
    const result = JSON.parse(out.trim().split("\n").at(-1)!);
    const outside = path.join(parent, "outside");
    assert.equal(fs.existsSync(outside), mode === "auto", "auto executes; review denies the action by default");
    const requestText = JSON.stringify(gw.requests[0] ?? {});
    assert.equal(requestText.includes(TRUST_MARKER), trusted, "project instructions load only for a trusted workspace");
    assert.equal(result.approvalPrompt, mode !== "auto", "approval mode is independent of folder trust");
    return result;
  } finally {
    await gw.close();
    if (driverShutdownConfirmed) {
      fs.rmSync(parent, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
}

ptyTest("ACC-SAFE-01: launcher permission mode is independent of folder trust", { timeout: 900_000 }, async () => {
  assert.ok(fs.existsSync(INDEX), `missing ${INDEX} (run npm run build)`);
  assert.ok(fs.existsSync(STARTUP_DRIVER), `missing ${STARTUP_DRIVER}`);
  const cases = [];
  for (const surface of ["tui", "repl"] as const) {
    for (const trusted of [false, true]) {
      for (const mode of ["review", "auto", undefined] as const) {
        cases.push(await runStartupPermissionCase(surface, trusted, mode));
      }
    }
  }
  assert.equal(cases.length, 12);
});

async function runVerifierSlashCase(trusted: boolean, mode: "review" | "auto", cancel = false) {
  const canary = `NEXUS_SAFE10_CHILD_${process.pid}_${Date.now()}`;
  const slowScript = [
    "const fs = require('fs');",
    `const canary = ${JSON.stringify(canary)};`,
    `const child = require('child_process').spawn('bash', ['-c', 'exec -a "$1" sleep 30', 'nexus-safe10', canary], { stdio: 'ignore' });`,
    "fs.writeFileSync('started', canary);",
    "child.once('spawn', () => fs.writeFileSync('started', canary));",
    "child.once('error', (error) => fs.writeFileSync('spawn-error', String(error)));",
    "child.on('exit', (code, signal) => { if (code === 0 && !signal) fs.writeFileSync('finished', 'yes'); });",
  ].join("\n") + "\n";
  const quickScript = [
    "const fs = require('fs');",
    "fs.writeFileSync('started', 'yes');",
    "fs.writeFileSync('mounts.txt', fs.readFileSync('/proc/self/mountinfo', 'utf8'));",
    "fs.writeFileSync('sentinel.txt', 'ran');",
  ].join("\n") + "\n";
  const repo = makeRepo({
    "package.json": JSON.stringify({ name: "nexus-verifier-fixture", scripts: { test: "node test.js" } }, null, 2) + "\n",
    "test.js": cancel ? slowScript : quickScript,
  });
  const home = makeHome();
  if (trusted) trustWorkspace(home, repo);
  const gw = await startGateway(() => ({ kind: "text", content: "unused" }));
  const args = ["--mode", mode, "--sandbox", "bwrap", "-w", repo, "-e", gw.url, "-m", "m"];
  const plan = { node: process.execPath, index: INDEX, args, cwd: repo, home, surface: "tui", trusted, mode, kind: "verifier", cancel, canary };
  const planFile = path.join(home, "verifier-plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan));
  let driverShutdownConfirmed = false;
  try {
    const { code, out, err } = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn("python3", [STARTUP_DRIVER, planFile], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("close", (exitCode) => resolve({ code: exitCode, out, err }));
    });
    driverShutdownConfirmed = code === 0;
    assert.equal(code, 0, `verifier /test ${trusted ? "trusted" : "untrusted"}/${mode}${cancel ? "/cancel" : ""} failed:\n${err}\n${out}`);
    const result = JSON.parse(out.trim().split("\n").at(-1)!);
    assert.equal(result.approvalPrompt, mode === "review");
    if (cancel) {
      assert.ok(result.cancelSeconds < 5, `Escape cancellation exceeded five seconds: ${result.cancelSeconds}`);
      assert.ok(fs.existsSync(path.join(repo, "started")), "the verifier started before cancellation");
      assert.ok(!fs.existsSync(path.join(repo, "finished")), "the cancelled verifier did not complete normally");
      const startedCanary = fs.readFileSync(path.join(repo, "started"), "utf8");
      assert.equal(startedCanary, canary, "the fixture recorded its unique descendant-process canary");
      assert.equal(result.canaryVisibleBeforeCancel, true, "the verifier descendant was visible from host /proc before cancellation");
      const remaining = await waitForCanaryProcesses(canary, false, 3_000);
      assert.deepEqual(remaining, [], `cancelled verifier left descendant process(es) alive: ${remaining.join(", ")}`);
    } else {
      assert.equal(fs.readFileSync(path.join(repo, "sentinel.txt"), "utf8"), "ran");
      const mounts = fs.readFileSync(path.join(repo, "mounts.txt"), "utf8");
      const hasWorkspaceMount = mounts.split("\n").some((line) => line.split(" ")[4] === repo);
      assert.ok(hasWorkspaceMount, "the verifier observed its workspace bind mount in /proc/self/mountinfo");
    }
    return result;
  } finally {
    await gw.close();
    await terminateCanaryProcesses(canary);
    if (driverShutdownConfirmed) {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
}

function canaryProcesses(canary: string): number[] {
  return fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).flatMap((pid) => {
    try {
      const argv = fs.readFileSync(path.join("/proc", pid, "cmdline"), "utf8").split("\0").filter(Boolean);
      const processName = fs.readFileSync(path.join("/proc", pid, "comm"), "utf8").trim();
      return argv[0] === canary && argv[1] === "30" && processName === "sleep" ? [Number(pid)] : [];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") return [];
      throw error;
    }
  });
}

async function waitForCanaryProcesses(canary: string, expected: boolean, timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let pids: number[] = [];
  do {
    pids = canaryProcesses(canary);
    if ((pids.length > 0) === expected) return pids;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return pids;
}

async function terminateCanaryProcesses(canary: string): Promise<void> {
  let pids = canaryProcesses(canary);
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  pids = await waitForCanaryProcesses(canary, false, 1_000);
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  await waitForCanaryProcesses(canary, false, 1_000);
}

ptyTest("ACC-SAFE-09/10: /test approval, trust independence, sandbox and cancellation", { timeout: 360_000 }, async () => {
  for (const trusted of [false, true]) {
    for (const mode of ["review", "auto"] as const) {
      await runVerifierSlashCase(trusted, mode);
    }
  }
  await runVerifierSlashCase(true, "review", true);
});
