/**
 * HK-1: a hook as a process. What it is given (one JSON object on standard input, a scrubbed environment), and what
 * happens when it misbehaves: it is stopped with everything it started, its output is bounded, and every such end is
 * a failure the caller turns into a denial.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expandHookArgv, hookEnvironment, reduceHookOutput, runHookProcess, HOOK_STDERR_LIMIT, HOOK_STDOUT_LIMIT } from "../src/core/hook_runner.js";
import { startedAt } from "../src/core/process_identity.js";

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nx-hook-runner-"));
}

function script(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

const env = (workspace: string) => hookEnvironment({ event: "pre-tool", name: "guard", source: "operator", workspace });

/** Polls until `check` holds; the host may be busy, so the wait is long and the step short. */
async function eventually(check: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
    if (check()) return;
    await sleep(50);
  }
  assert.fail(`timed out waiting for: ${what}`);
}

/** Kills what a test left behind, by pid, and only if it is still the process the test started. */
function reap(pids: Array<{ pid: number; started: string | undefined }>): void {
  for (const { pid, started } of pids) {
    if (started !== undefined && startedAt(pid) === started) {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  }
}

test("the hook reads exactly the payload on standard input, then end of input", async () => {
  const dir = scratch();
  try {
    const received = path.join(dir, "stdin.json");
    const payload = JSON.stringify({ session_id: "task-1", cwd: dir, hook_event_name: "PreToolUse", nexus_event: "pre-tool", permission_mode: "auto", tool_name: "run_command", tool_input: { command: "git push --force" } });
    const result = await runHookProcess({ command: ["/bin/sh", "-c", 'cat > "$1"', "sh", received], cwd: dir, env: env(dir), stdin: payload, timeoutMs: 30_000 });
    assert.deepEqual({ exit: result.exit, signal: result.signal, failure: result.failure, stdout: result.stdout }, { exit: 0, signal: null, failure: undefined, stdout: "" });
    assert.equal(fs.readFileSync(received, "utf8"), payload);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the environment carries no credential of the parent, only the safe variables and the hook's own", async () => {
  const dir = scratch();
  // NODE_PATH is not a secret, and not passed either: it says where node finds code.
  const secrets = ["NODE_PATH", "FAKE_API_KEY", "NEXUS_API_KEY", "NEXUS_GATEWAY_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "NEXUS_TRUST_WORKSPACE"];
  const saved = Object.fromEntries(secrets.map((name) => [name, process.env[name]]));
  try {
    for (const name of secrets) process.env[name] = `secret-value-of-${name}`;
    const result = await runHookProcess({ command: "env", cwd: dir, env: env(dir), stdin: "{}", timeoutMs: 30_000 });
    assert.equal(result.exit, 0);
    assert.ok(!result.stdout.includes("secret-value-of-"), "no secret value reaches the hook");
    const names = result.stdout.split("\n").filter(Boolean).map((line) => line.split("=")[0]);
    for (const name of secrets) assert.ok(!names.includes(name), `${name} is not passed`);
    const allowed = new Set([
      "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME", "SHELL", "TMPDIR", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
      "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
      "NEXUS_HOOK_EVENT", "NEXUS_HOOK_NAME", "NEXUS_HOOK_SOURCE", "NEXUS_PROJECT_DIR", "CLAUDE_PROJECT_DIR",
      // Set by the shell itself.
      "PWD", "OLDPWD", "SHLVL", "_",
    ]);
    assert.deepEqual(names.filter((name) => !allowed.has(name)), [], "nothing outside the allowlist");
    const value = (name: string) => result.stdout.split("\n").find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1);
    assert.equal(value("NEXUS_HOOK_EVENT"), "pre-tool");
    assert.equal(value("NEXUS_HOOK_NAME"), "guard");
    assert.equal(value("NEXUS_HOOK_SOURCE"), "operator");
    assert.equal(value("NEXUS_PROJECT_DIR"), dir);
    assert.equal(value("CLAUDE_PROJECT_DIR"), dir);
  } finally {
    for (const name of secrets) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a string runs under the shell in the workspace; an array is executed without one", async () => {
  const dir = scratch();
  try {
    const viaShell = await runHookProcess({ command: "pwd | tr a-z A-Z; echo done", cwd: dir, env: env(dir), stdin: "", timeoutMs: 30_000 });
    assert.equal(viaShell.stdout, `${fs.realpathSync(dir).toUpperCase()}\ndone\n`);
    // Shell syntax in an argument stays an argument.
    const marker = path.join(dir, "made-by-shell");
    const direct = await runHookProcess({ command: ["/bin/echo", `$(touch ${marker}); echo x > ${marker}`], cwd: dir, env: env(dir), stdin: "", timeoutMs: 30_000 });
    assert.equal(direct.stdout, `$(touch ${marker}); echo x > ${marker}\n`);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a leading ~/ in an array command is the home directory", async () => {
  const home = os.homedir();
  assert.ok(home.startsWith(os.tmpdir()) || home.includes("tmp"), `this test writes under HOME, which must be a throwaway (${home})`);
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  script(path.join(home, "bin"), "nexus-guard.sh", "echo from-home");
  const argv = expandHookArgv(["~/bin/nexus-guard.sh"], home);
  assert.ok(!("problem" in argv), JSON.stringify(argv));
  const result = await runHookProcess({ command: argv, cwd: home, env: env(home), stdin: "", timeoutMs: 30_000 });
  assert.equal(result.stdout, "from-home\n");
});

test("exit codes and signals come back as they happened", async () => {
  const dir = scratch();
  try {
    const run = (command: string) => runHookProcess({ command, cwd: dir, env: env(dir), stdin: "{}", timeoutMs: 30_000 });
    const one = await run("echo out; echo err >&2; exit 1");
    assert.deepEqual({ exit: one.exit, stdout: one.stdout, stderr: one.stderr, failure: one.failure }, { exit: 1, stdout: "out\n", stderr: "err\n", failure: undefined });
    assert.deepEqual(reduceHookOutput(one), { decision: "error", denialReason: "HOOK_FAILED", reason: "the hook exited with status 1" });

    const two = await run("echo 'no force pushes' >&2; exit 2");
    assert.deepEqual(reduceHookOutput(two), { decision: "deny", denialReason: "HOOK_DENIED", reason: "no force pushes" });

    // SIGKILL: a signal that ends the hook without the host writing a core dump.
    const crashed = await run("kill -KILL $$");
    assert.equal(crashed.signal, "SIGKILL");
    assert.equal(reduceHookOutput(crashed).denialReason, "HOOK_FAILED");

    const missing = await runHookProcess({ command: [path.join(dir, "no-such-hook")], cwd: dir, env: env(dir), stdin: "{}", timeoutMs: 30_000 });
    assert.equal(missing.failure, "spawn");
    assert.match(missing.detail ?? "", /ENOENT/);
    assert.equal(reduceHookOutput(missing).denialReason, "HOOK_FAILED");

    // A hook that never reads a large payload is not an error by itself.
    const deaf = await runHookProcess({ command: "exit 0", cwd: dir, env: env(dir), stdin: "x".repeat(1024 * 1024), timeoutMs: 30_000 });
    assert.deepEqual({ exit: deaf.exit, failure: deaf.failure }, { exit: 0, failure: undefined });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a hook past its deadline is stopped with its child and a grandchild that left the group and ignores SIGTERM", async () => {
  const dir = scratch();
  const started: Array<{ pid: number; started: string | undefined }> = [];
  try {
    // The grandchild is in its own session (the group signal does not reach it) and ignores SIGTERM (only SIGKILL by
    // pid ends it). `ready` appears once all three pids are written.
    const hook = script(dir, "slow.sh", [
      `setsid sh -c 'trap "" TERM; echo $$ > "${dir}/grandchild.pid"; exec sleep 999' &`,
      `sleep 999 &`,
      `echo $! > "${dir}/child.pid"`,
      `echo $$ > "${dir}/hook.pid"`,
      `while [ ! -s "${dir}/grandchild.pid" ]; do sleep 0.05; done`,
      `touch "${dir}/ready"`,
      `wait`,
    ].join("\n"));
    const pidOf = (name: string) => Number(fs.readFileSync(path.join(dir, `${name}.pid`), "utf8").trim());
    const running = runHookProcess({ command: [hook], cwd: dir, env: env(dir), stdin: "{}", timeoutMs: 6_000, killGraceMs: 500 });
    await eventually(() => fs.existsSync(path.join(dir, "ready")), "the hook to start its processes", 5_000);
    for (const name of ["hook", "child", "grandchild"]) {
      const pid = pidOf(name);
      started.push({ pid, started: startedAt(pid) });
      assert.notEqual(startedAt(pid), undefined, `${name} is running before the deadline`);
    }
    const result = await running;
    assert.equal(result.failure, "timeout");
    assert.equal(reduceHookOutput(result).denialReason, "HOOK_FAILED");
    assert.ok(result.durationMs >= 6_000 && result.durationMs < 25_000, `stopped at the deadline, not at the sleep's end (${result.durationMs} ms)`);
    // Gone, or the pid now belongs to a different process: the start time tells which.
    await eventually(() => started.every(({ pid, started: at }) => startedAt(pid) !== at), "the hook, its child and its grandchild to be gone");
  } finally {
    reap(started);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a flood on standard output is cut at the limit and the hook is stopped, without buffering it", async () => {
  const dir = scratch();
  try {
    // `yes` never ends by itself: the run returning at all shows the hook was stopped.
    const flood = await runHookProcess({ command: "yes 0123456789abcdef", cwd: dir, env: env(dir), stdin: "{}", timeoutMs: 60_000, killGraceMs: 500 });
    assert.equal(flood.failure, "stdout_oversize");
    assert.ok(Buffer.byteLength(flood.stdout) <= HOOK_STDOUT_LIMIT, `kept ${Buffer.byteLength(flood.stdout)} bytes`);
    assert.ok(flood.durationMs < 30_000, `stopped by the limit, not the deadline (${flood.durationMs} ms)`);
    assert.equal(reduceHookOutput(flood).denialReason, "HOOK_FAILED");

    // A bounded 10 MiB answer that ends in an "allow" is refused the same way.
    const big = await runHookProcess({ command: `head -c 10485760 /dev/zero | tr '\\0' ' '; echo '{"decision":"approve"}'`, cwd: dir, env: env(dir), stdin: "{}", timeoutMs: 60_000, killGraceMs: 500 });
    assert.equal(big.failure, "stdout_oversize");
    assert.ok(Buffer.byteLength(big.stdout) <= HOOK_STDOUT_LIMIT);
    assert.equal(reduceHookOutput(big).decision, "error");

    const noisy = await runHookProcess({ command: "yes error >&2", cwd: dir, env: env(dir), stdin: "{}", timeoutMs: 60_000, killGraceMs: 500 });
    assert.equal(noisy.failure, "stderr_oversize");
    assert.ok(Buffer.byteLength(noisy.stderr) <= HOOK_STDERR_LIMIT);

    // Exactly at the limit is accepted.
    const exact = await runHookProcess({ command: `head -c ${HOOK_STDOUT_LIMIT} /dev/zero | tr '\\0' x`, cwd: dir, env: env(dir), stdin: "{}", timeoutMs: 60_000 });
    assert.deepEqual({ failure: exact.failure, exit: exact.exit, bytes: exact.stdout.length }, { failure: undefined, exit: 0, bytes: HOOK_STDOUT_LIMIT });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a hook that exits while something it started holds its output open is a failure, not an empty answer", async () => {
  const dir = scratch();
  const started: Array<{ pid: number; started: string | undefined }> = [];
  try {
    const pidFile = path.join(dir, "bg.pid");
    const holding = await runHookProcess({ command: `sleep 300 & echo $! > "${pidFile}"; exit 0`, cwd: dir, env: env(dir), stdin: "{}", timeoutMs: 60_000, drainMs: 500 });
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    started.push({ pid, started: startedAt(pid) });
    assert.deepEqual({ exit: holding.exit, failure: holding.failure }, { exit: 0, failure: "output_left_open" });
    assert.equal(reduceHookOutput(holding).denialReason, "HOOK_FAILED");
    // The answer was refused, so what the hook left running in its process group is ended, not orphaned.
    // (It may be gone already, so it is recognised by what it runs, not by a start time read now.)
    const stillSleeping = () => {
      try {
        return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("sleep");
      } catch {
        return false;
      }
    };
    try {
      await eventually(() => !stillSleeping(), "the process the hook left behind to be gone");
    } finally {
      if (stillSleeping()) process.kill(pid, "SIGKILL");
    }

    // Detached from the output, the background process is the hook's own business.
    const detached = await runHookProcess({ command: `sleep 300 >/dev/null 2>&1 & echo $! > "${pidFile}"; echo ok`, cwd: dir, env: env(dir), stdin: "{}", timeoutMs: 60_000, drainMs: 500 });
    const second = Number(fs.readFileSync(pidFile, "utf8").trim());
    started.push({ pid: second, started: startedAt(second) });
    assert.deepEqual({ exit: detached.exit, failure: detached.failure, stdout: detached.stdout }, { exit: 0, failure: undefined, stdout: "ok\n" });
  } finally {
    reap(started);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
