import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { processGone } from "./helpers/fixtures.js";
import { checkLeaks } from "../scripts/check_test_leaks.mjs";

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

test("the leak ratchet holds: no unlisted file builds a bridge, agent or gateway without the guard, and no listed file is stale", () => {
  const { missing, stale } = checkLeaks(path.join(cli, "test"), path.join(cli, "test/leak_guard_baseline.json"));
  assert.deepEqual(missing, []);
  assert.deepEqual(stale, []);
});

test("the ratchet names a new unguarded file, a stale baseline entry, and tolerates spacing, factories, .mjs and subdirectories", () => {
  const dir = scratch({
    "bad.test.ts": "new AutonomousAgent (config);\n",
    "bad_gateway.test.ts": "const gw = await startGateway(() => reply);\n",
    "listed.test.ts": "new RustCoreBridge(w);\n",
    "adopted.test.ts": 'import "./helpers/leak_guard.js";\nnew RustCoreBridge(w);\n',
    "gone.test.ts": "const x = 1;\n",
    "definition.ts": "export async function startGateway(script) {}\n",
    "plain.test.ts": "const x = 1;\n",
  });
  fs.writeFileSync(path.join(dir, "bad.mjs"), "new   RustCoreBridge(w);\n");
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "deep.test.ts"), "new AutonomousAgent(c);\n");
  fs.writeFileSync(path.join(dir, "baseline.json"), JSON.stringify(["listed.test.ts", "adopted.test.ts", "gone.test.ts"]));
  const { missing, stale } = checkLeaks(dir, path.join(dir, "baseline.json"));
  assert.deepEqual(missing, ["bad.mjs", "bad.test.ts", "bad_gateway.test.ts", path.join("sub", "deep.test.ts")]);
  assert.deepEqual(stale, ["adopted.test.ts", "gone.test.ts"]);
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
  fs.writeFileSync(path.join(dir, "zz_after.test.ts"), 'import { test } from "node:test";\ntest("ran after the hung file", () => {});\n');
  const file = path.join(dir, "hang.test.ts");
  const started = Date.now();
  const r = spawnSync(process.execPath, ["scripts/run_tests.mjs", file, path.join(dir, "zz_after.test.ts")], { cwd: cli, encoding: "utf8", timeout: 60_000, env: childEnv({ NEXUS_TEST_FILE_TIMEOUT_SECS: "20" }) });
  const out = r.stdout + r.stderr;
  assert.notEqual(r.status, 0, out);
  assert.match(out, new RegExp(`TEST FILE TIMEOUT after 20s: ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(out, /still working/);
  assert.match(out, /timed out: .*hang\.test\.ts/);
  assert.match(out, /ran after the hung file/, "the run restarts with the remaining files");
  assert.ok(Date.now() - started < 60_000);
  const pid = Number(/CHILD_PID=(\d+)/.exec(out)?.[1]);
  assert.ok(pid > 0, out);
  assert.ok(processGone(pid), `grandchild ${pid} survived the timeout kill`);
});

test("run_tests.mjs removes its throwaway home and kills the group when interrupted", async () => {
  const dir = scratch({ "wait.test.ts": 'import { test } from "node:test";\ntest("waits", async () => { console.log("READY"); await new Promise(() => setInterval(() => {}, 1000)); });\n' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-leakguard-tmp-"));
  const child = spawn(process.execPath, ["scripts/run_tests.mjs", path.join(dir, "wait.test.ts")], { cwd: cli, env: childEnv({ TMPDIR: tmp }), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const deadline = Date.now() + 60_000;
  while (!out.includes("READY") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.ok(out.includes("READY"), out);
  assert.ok(fs.readdirSync(tmp).some((n) => n.startsWith("nexus-test-home-")), "the throwaway home exists while running");
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  child.kill("SIGTERM");
  assert.equal(await exited, 1);
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith("nexus-test-home-")), []);
  fs.rmSync(tmp, { recursive: true, force: true });
});
