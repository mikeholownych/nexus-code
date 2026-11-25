import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("nexus operation validate accepts a valid spec without creating operation state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-op-validate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  const stateDir = path.join(root, "state");
  const specPath = path.join(root, "op.json");
  fs.writeFileSync(specPath, JSON.stringify({
    objective: "Validate only",
    units: [
      { id: "a", prompt: "do a" },
      { id: "b", prompt: "do b", dependsOn: ["a"] },
    ],
  }));

  const out = execFileSync(process.execPath, ["--import", "tsx", path.join(cliDir, "src/index.ts"), "operation", "validate", specPath, "-w", workspace], {
    cwd: cliDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, ".config"), NEXUS_STATE_DIR: stateDir, NO_COLOR: "1" },
  });
  assert.match(out, /Operation spec is valid: Validate only/);
  assert.match(out, /b ← a/);
  assert.deepEqual(fs.existsSync(path.join(stateDir, "tasks")) ? fs.readdirSync(path.join(stateDir, "tasks")) : [], []);
});

test("nexus operation validate refuses invalid spec with usage error and no state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-op-validate-bad-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  const stateDir = path.join(root, "state");
  const specPath = path.join(root, "bad.json");
  fs.writeFileSync(specPath, JSON.stringify({ objective: "Bad", units: [{ id: "a", prompt: "x", depends: ["b"] }] }));

  let status = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, ["--import", "tsx", path.join(cliDir, "src/index.ts"), "operation", "validate", specPath, "-w", workspace], {
      cwd: cliDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      env: { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, ".config"), NEXUS_STATE_DIR: stateDir, NO_COLOR: "1" },
    });
  } catch (error: any) {
    status = Number(error?.status ?? -1);
    stderr = String(error?.stderr ?? "");
  }
  assert.equal(status, 2, stderr);
  assert.match(stderr, /unknown unit 'a' key 'depends'/);
  assert.deepEqual(fs.existsSync(path.join(stateDir, "tasks")) ? fs.readdirSync(path.join(stateDir, "tasks")) : [], []);
});
