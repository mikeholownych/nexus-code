import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { executeRetention, planRetention } from "../src/core/retention.js";

test("checkpoint gc disables repository hooks and deletes the checkpoint ref", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-retention-hook-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const partition = path.join(home, ".nexus", "checkpoints", "partition");
  fs.mkdirSync(partition, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  try {
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "t@t.invalid"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, "file.txt"), "x\n");
    execFileSync("git", ["add", "file.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: workspace });
    const ref = "refs/nexus/checkpoints/checkpoint";
    execFileSync("git", ["update-ref", ref, "HEAD"], { cwd: workspace });
    const marker = path.join(root, "hook-ran");
    const hook = path.join(workspace, ".git", "hooks", "reference-transaction");
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    fs.chmodSync(hook, 0o755);
    const includedHookConfig = path.join(root, "configured-hooks.inc");
    fs.writeFileSync(
      includedHookConfig,
      '[hook "retention=extra"]\n\tevent = reference-transaction\n\tcommand = touch configured-hook-ran\n',
    );
    execFileSync("git", ["config", "--local", "include.path", includedHookConfig], { cwd: workspace });
    const gitVersion = execFileSync("git", ["--version"], { cwd: workspace, encoding: "utf8" });
    const version = gitVersion.match(/git version (\d+)\.(\d+)/);
    assert.ok(version, `could not parse Git version: ${gitVersion}`);
    const hasConfiguredHooks = Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 54);
    if (hasConfiguredHooks) {
      const probeRef = "refs/nexus/checkpoints/config-hook-probe";
      execFileSync("git", ["update-ref", probeRef, "HEAD"], { cwd: workspace });
      assert.equal(fs.existsSync(path.join(workspace, "configured-hook-ran")), true, "configured hook precondition did not run");
      assert.equal(fs.existsSync(marker), true, "traditional hook precondition did not run");
      fs.rmSync(path.join(workspace, "configured-hook-ran"));
      fs.rmSync(marker);
      execFileSync("git", ["update-ref", "-d", probeRef], { cwd: workspace });
      fs.rmSync(path.join(workspace, "configured-hook-ran"));
      fs.rmSync(marker);
    }

    const record = path.join(partition, "checkpoint.json");
    fs.writeFileSync(record, JSON.stringify({ workspace, gitRef: "refs/nexus/checkpoints/checkpoint" }));
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    fs.utimesSync(record, old, old);

    const plan = planRetention({ home, maxAgeDays: 1 });
    assert.ok(plan.reclaimableItems.some((item) => item.kind === "checkpoint"));
    executeRetention(plan);
    assert.equal(fs.existsSync(marker), false, "gc executed a workspace git hook");
    assert.equal(fs.existsSync(path.join(workspace, "configured-hook-ran")), false, "gc executed a configured Git hook");
    const refLookup = spawnSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd: workspace });
    assert.equal(
      refLookup.status,
      1,
      `git show-ref did not confirm ref deletion: ${refLookup.error?.message ?? refLookup.stderr?.toString()}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
