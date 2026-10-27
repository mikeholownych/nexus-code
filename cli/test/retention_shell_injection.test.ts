import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeRetention, planRetention } from "../src/core/retention.js";

test("checkpoint garbage collection never interpolates a checkpoint id into a shell", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-retention-shell-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const partition = path.join(home, ".nexus", "checkpoints", "partition");
  fs.mkdirSync(partition, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const marker = path.join(workspace, "injected");
  const id = "checkpoint;touch injected;";
  const record = path.join(partition, `${id}.json`);
  fs.writeFileSync(record, JSON.stringify({ workspace, gitRef: "refs/nexus/checkpoints/checkpoint" }));
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  fs.utimesSync(record, old, old);

  try {
    const plan = planRetention({ home, maxAgeDays: 1 });
    assert.ok(plan.reclaimableItems.some((item) => item.kind === "checkpoint" && item.id === id));
    executeRetention(plan);
    assert.equal(fs.existsSync(marker), false, "retention executed a command from the checkpoint id");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
