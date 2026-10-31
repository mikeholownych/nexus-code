import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = process.env.REPRO_WORKFLOW_FILE ?? path.join(root, ".github/workflows/repro.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");
const condition = workflow.match(/if \[\[ ! "\$TARGET_TAG" =~ (.+) \]\]; then/)?.[1];

function accepts(tag: string): boolean {
  assert.ok(condition, "workflow exposes its target-tag condition");
  const result = spawnSync("bash", ["-c", `if [[ ! "$TARGET_TAG" =~ ${condition} ]]; then exit 1; fi`], {
    env: { ...process.env, TARGET_TAG: tag },
  });
  return result.status === 0;
}

test("cross-runner reproducibility accepts immutable RC tags across release lines", () => {
  assert.equal(accepts("v1.0.0-rc.4"), true);
  assert.equal(accepts("v1.1.0-rc.1"), true);
  assert.equal(accepts("v12.34.56-rc.10"), true);
});

test("cross-runner reproducibility rejects stable, malformed, and partial tags", () => {
  for (const tag of ["v1.1.0", "v1.1.0-rc.0", "v1.1.0-rc.1-extra", "1.1.0-rc.1", "v1.1-rc.1"]) {
    assert.equal(accepts(tag), false, tag);
  }
});
