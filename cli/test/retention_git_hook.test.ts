import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { executeRetention, planRetention } from "../src/core/retention.js";

test("checkpoint gc does not execute repository hooks", () => {
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
    execFileSync("git", ["update-ref", "refs/nexus/checkpoints/checkpoint", "HEAD"], { cwd: workspace });
    const marker = path.join(root, "hook-ran");
    const hook = path.join(workspace, ".git", "hooks", "reference-transaction");
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    fs.chmodSync(hook, 0o755);

    const record = path.join(partition, "checkpoint.json");
    fs.writeFileSync(record, JSON.stringify({ workspace, gitRef: "refs/nexus/checkpoints/checkpoint" }));
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    fs.utimesSync(record, old, old);

    const plan = planRetention({ home, maxAgeDays: 1 });
    assert.ok(plan.reclaimableItems.some((item) => item.kind === "checkpoint"));
    executeRetention(plan);
    assert.equal(fs.existsSync(marker), false, "gc executed a workspace git hook");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
