import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateBatchSpec } from "../src/batch_spec.js";
import { makeBatchWorkflowSpec } from "../../eval/workflow_modes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("generated comparative batch graph is accepted by Nexus's existing operation-spec validator", () => {
  const spec = makeBatchWorkflowSpec({ objective: "same objective" }, "evaluation-1");
  assert.equal(validateBatchSpec(spec).units.length, 5);
});

test("PA-4 comparative workflow harness tests run in the normal CLI regression suite", { timeout: 120_000 }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-workflow-harness-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ["--test", "eval/workflow_modes.test.mjs", "eval/score_workflows.test.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_STATE_HOME: path.join(home, ".local", "state"),
    },
  });
  assert.equal(result.status, 0, `workflow evaluation tests failed (status ${result.status}, signal ${result.signal}):\n${result.stdout}\n${result.stderr}`);
});
