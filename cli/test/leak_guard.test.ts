import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { processGone } from "./helpers/fixtures.js";
import { findUnguarded } from "../scripts/check_test_leaks.mjs";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guard = pathToFileURL(path.join(cli, "test/helpers/leak_guard.ts")).href;
const fixtures = pathToFileURL(path.join(cli, "test/helpers/fixtures.ts")).href;
const tools = pathToFileURL(path.join(cli, "src/tools.ts")).href;
const tsx = path.join(cli, "node_modules/.bin/tsx");

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  return { ...env, ...extra };
}

function scratch(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-leakguard-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test("every test file that builds a bridge or agent releases it or imports the leak guard", () => {
  assert.deepEqual(findUnguarded(path.join(cli, "test")), []);
});

test("the repo check names a file that builds an agent without any release", () => {
  const dir = scratch({
    "bad.test.ts": "new AutonomousAgent(config);\n",
    "ok_guard.test.ts": 'import "./helpers/leak_guard.js";\nnew RustCoreBridge(w);\n',
    "ok_shutdown.test.ts": "const a = new AutonomousAgent(c);\na.shutdown();\n",
    "none.test.ts": "const x = 1;\n",
  });
  assert.deepEqual(findUnguarded(dir), ["bad.test.ts"]);
});

test("the guard fails a file that leaks a bridge, gateway, child process and timer, names each, and releases them", () => {
  const dir = scratch({
    "leaky.test.ts": `import { test } from "node:test";
import { spawn } from "node:child_process";
import "${guard}";
import { startGateway } from "${fixtures}";
import { RustCoreBridge } from "${tools}";
test("leaks", async () => {
  await startGateway(() => ({ kind: "text", content: "x" }));
  new RustCoreBridge(process.cwd());
  const child = spawn("sleep", ["300"], { stdio: "ignore" });
  console.log("CHILD_PID=" + child.pid);
  setInterval(() => {}, 1000);
});
`,
  });
  const started = Date.now();
  const r = spawnSync(tsx, ["--test", path.join(dir, "leaky.test.ts")], { cwd: cli, encoding: "utf8", timeout: 60_000, env: childEnv({ HOME: dir }) });
  const out = r.stdout + r.stderr;
  assert.notEqual(r.status, 0, out);
  assert.match(out, /leaky\.test\.ts leaked 4 resource\(s\)/);
  assert.match(out, /gateway: scripted gateway on port \d+ not closed/);
  assert.match(out, /child process: pid \d+ sleep 300/);
  assert.match(out, /RustCoreBridge not shut down/);
  assert.match(out, /1 timer\(s\) still pending/);
  assert.ok(Date.now() - started < 30_000);
  const pid = Number(/CHILD_PID=(\d+)/.exec(out)?.[1]);
  assert.ok(pid > 0, out);
  assert.ok(processGone(pid), `child ${pid} survived the guard`);
});

test("the guard passes a file that releases everything", () => {
  const dir = scratch({
    "clean.test.ts": `import { test } from "node:test";
import { spawn } from "node:child_process";
import "${guard}";
import { startGateway } from "${fixtures}";
import { RustCoreBridge } from "${tools}";
test("clean", async () => {
  const gw = await startGateway(() => ({ kind: "text", content: "x" }));
  const bridge = new RustCoreBridge(process.cwd());
  const child = spawn("sleep", ["300"], { stdio: "ignore" });
  const timer = setInterval(() => {}, 1000);
  child.kill("SIGKILL");
  clearInterval(timer);
  bridge.shutdown();
  await gw.close();
});
`,
  });
  const r = spawnSync(tsx, ["--test", path.join(dir, "clean.test.ts")], { cwd: cli, encoding: "utf8", timeout: 60_000, env: childEnv({ HOME: dir }) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("run_tests.mjs kills a hung file's whole process group at the per-file timeout and names the file", () => {
  const dir = scratch({
    "hang.test.ts": `import { test } from "node:test";
import { spawn } from "node:child_process";
test("hangs", async () => {
  const child = spawn("sleep", ["300"], { stdio: "ignore" });
  console.log("CHILD_PID=" + child.pid);
  console.log("still working");
  await new Promise(() => setInterval(() => {}, 1000));
});
`,
  });
  const file = path.join(dir, "hang.test.ts");
  const started = Date.now();
  const r = spawnSync(process.execPath, ["scripts/run_tests.mjs", file], { cwd: cli, encoding: "utf8", timeout: 60_000, env: childEnv({ NEXUS_TEST_FILE_TIMEOUT_SECS: "20" }) });
  const out = r.stdout + r.stderr;
  assert.notEqual(r.status, 0, out);
  assert.match(out, new RegExp(`TEST FILE TIMEOUT after 20s: ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(out, /still working/);
  assert.match(out, /failed: 1 .*\[timeout\]/);
  assert.ok(Date.now() - started < 30_000);
  const pid = Number(/CHILD_PID=(\d+)/.exec(out)?.[1]);
  assert.ok(pid > 0, out);
  assert.ok(processGone(pid), `grandchild ${pid} survived the timeout kill`);
});
