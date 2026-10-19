import { spawn } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireFileGuard, releaseFileGuard } from "../src/core/file_guard.js";
import { withStateStoreGuard, tryStateStoreGuard } from "../src/core/state_store_guard.js";

function fixture(run: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-file-guard-"));
  try { run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("independent descriptors contend and release permits reacquisition", () => fixture(root => {
  const file = path.join(root, "guard");
  const first = acquireFileGuard(file);
  assert.ok(first);
  try { assert.equal(acquireFileGuard(file), null); }
  finally { releaseFileGuard(first); }
  const second = acquireFileGuard(file);
  assert.ok(second);
  releaseFileGuard(second);
}));

test("duplicate release cannot close an unrelated reused descriptor", () => fixture(root => {
  const guard = acquireFileGuard(path.join(root, "guard"));
  assert.ok(guard);
  releaseFileGuard(guard);
  const unrelated = fs.openSync(path.join(root, "other"), "w");
  try { releaseFileGuard(guard); fs.writeSync(unrelated, "still open"); }
  finally { fs.closeSync(unrelated); }
}));

test("unsafe guards and missing lock utility fail closed", () => fixture(root => {
  const target = path.join(root, "target");
  fs.writeFileSync(target, "unchanged", { mode: 0o600 });
  const link = path.join(root, "link"); fs.symlinkSync(target, link);
  assert.throws(() => acquireFileGuard(link), /redirected/);
  fs.chmodSync(target, 0o644);
  assert.throws(() => acquireFileGuard(target), /permissions/);
  fs.chmodSync(target, 0o600);
  fs.linkSync(target, path.join(root, "hardlink"));
  assert.throws(() => acquireFileGuard(target), /hard links/);
  assert.throws(() => acquireFileGuard(path.join(root, "missing"), { utility: path.join(root, "absent") }), /unavailable/);
  assert.equal(fs.readFileSync(target, "utf8"), "unchanged");
}));

test("state store supports synchronous nesting and releases after exceptions", () => fixture(root => {
  const result = withStateStoreGuard(root, () => withStateStoreGuard(root, () => 42));
  assert.equal(result, 42);
  assert.throws(() => withStateStoreGuard(root, () => { throw new Error("fixture"); }), /fixture/);
  assert.deepEqual(tryStateStoreGuard(root, () => "released"), { acquired: true, value: "released" });
  assert.throws(() => withStateStoreGuard(root, () => Promise.resolve()), /synchronous/);
}));

test("background collection skips an externally held store", () => fixture(root => {
  const guard = acquireFileGuard(path.join(root, ".nexus-state.guard"));
  assert.ok(guard);
  try { assert.deepEqual(tryStateStoreGuard(root, () => assert.fail("must not execute")), { acquired: false }); }
  finally { releaseFileGuard(guard); }
}));

test("kernel ownership is released when the owning process is killed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-guard-kill-"));
  const file = path.join(root, "guard");
  const code = `const fs=require('node:fs'); const {spawnSync}=require('node:child_process'); const fd=fs.openSync(${JSON.stringify(file)},'w',0o600); const r=spawnSync('/usr/bin/flock',['-n','3'],{stdio:['ignore','ignore','ignore',fd]}); if(r.status!==0)process.exit(2); console.log('READY'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("guard holder startup timed out")), 5000);
      child.stdout.once("data", data => { clearTimeout(timer); String(data).includes("READY") ? resolve() : reject(new Error(String(data))); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("guard holder exited before readiness")); });
    });
    assert.equal(acquireFileGuard(file), null);
    child.kill("SIGKILL"); await exited;
    const guard = acquireFileGuard(file); assert.ok(guard); releaseFileGuard(guard);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } fs.rmSync(root, { recursive: true, force: true }); }
});
