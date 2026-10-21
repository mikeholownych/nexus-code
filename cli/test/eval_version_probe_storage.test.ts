/** Candidate version discovery must use the same capped writable filesystem as evaluated work. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("the production version-probe workspace uses the configured capped filesystem", { timeout: 60_000 }, async () => {
  const workspaceRoot = process.env.NEXUS_EVAL_TEST_WORKSPACE_ROOT;
  assert.ok(workspaceRoot, "requires the dedicated capped workspace fixture configured by CI");
  const runtimeRoot = process.env.NEXUS_EVAL_TEST_RUNTIME_ROOT;
  assert.ok(runtimeRoot, "requires the dedicated public runtime fixture configured by CI");
  const runAs = process.env.NEXUS_EVAL_TEST_RUN_AS ?? "nobody";
  const evaluatorUid = Number(execFileSync("/usr/bin/id", ["-u", runAs], { encoding: "utf8" }).trim());
  assert.notEqual(evaluatorUid, process.getuid(), "version probe must actually switch to a separate evaluator uid");
  const cap = fs.statfsSync(workspaceRoot);
  const expectedDevice = fs.statSync(workspaceRoot).dev;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-version-storage-test-"));
  const home = path.join(temp, "home");
  const tools = fs.mkdtempSync(path.join(runtimeRoot, "version-agent-"));
  const tasks = path.join(temp, "tasks");
  for (const dir of [home, tasks]) fs.mkdirSync(dir, { mode: 0o700 });
  fs.chmodSync(tools, 0o755);
  const before = new Set(fs.readdirSync(workspaceRoot));
  const agent = path.join(tools, "goose");
  // Use /bin/sh: isolatedProcessArgv mounts SYSTEM_BINARIES only, not process.execPath.
  // GHA Node from actions/setup-node is not at /usr/bin/node, so a node shebang exits 1
  // before the fake agent body runs (local /usr/bin/node masks this).
  fs.writeFileSync(agent, `#!/bin/sh
set -eu
if [ "$(id -u)" -ne ${evaluatorUid} ]; then
  echo 'version probe did not switch evaluator uid' >&2
  exit 94
fi
if [ "\${1:-}" != '--version' ]; then
  exit 91
fi
if [ "$(stat -c %d .)" -ne ${expectedDevice} ]; then
  echo 'version probe escaped capped filesystem' >&2
  exit 92
fi
printf 'bounded' > version-probe-write
echo 'goose-storage-probe 1.0.0'
`, { mode: 0o755 });
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ object: "list", data: [{ id: "storage-probe-model", object: "model", owned_by: "synthetic-test" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = path.join(temp, "config.json");
  const out = path.join(temp, "out");
  fs.writeFileSync(config, JSON.stringify({
    name: "bounded-version-probe", agent: "goose", expectedAgentVersion: "1.0.0", runAs,
    endpoint: `http://127.0.0.1:${address.port}/v1`, model: "storage-probe-model", proxy: false,
    env: { PATH: `${tools}${path.delimiter}${process.env.PATH ?? ""}` },
    sandboxRuntimePaths: [agent], sandboxRuntimeRoots: [tools],
    resources: { cpuPercent: 100, memoryBytes: 256 * 1024 * 1024, tasks: 64, storageBytes: cap.blocks * cap.bsize, workspaceRoot },
  }));
  try {
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(ROOT, "eval/run.mjs"), "--config", config, "--out", out, "--tasks", tasks], {
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"), XDG_STATE_HOME: path.join(home, ".local/state") },
        stdio: ["ignore", "pipe", "pipe"], detached: true,
      });
      let stdout = "", stderr = "";
      const stop = () => { if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch {} };
      const timer = setTimeout(() => {
        stop(); child.stdout.destroy(); child.stderr.destroy();
        reject(new Error(`version-probe runner exceeded 45 seconds: ${stderr}`));
      }, 45_000);
      child.stdout.on("data", data => { stdout += data; });
      child.stderr.on("data", data => { stderr += data; });
      child.once("error", error => { clearTimeout(timer); stop(); reject(error); });
      child.once("close", status => { clearTimeout(timer); stop(); resolve({ status, stdout, stderr }); });
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    assert.match(JSON.stringify(manifest.agentVersion), /goose-storage-probe 1.0.0/);
    assert.deepEqual(fs.readdirSync(workspaceRoot).filter(name => !before.has(name) && name.startsWith("nexus-eval-version-workspace-")), [], "version-probe workspace must be cleaned up");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(temp, { recursive: true, force: true });
    fs.rmSync(tools, { recursive: true, force: true });
  }
});
