/**
 * WP-1302: diff_boundary must not count evaluator-staged hidden tests as agent changes.
 *
 * In a non-hardened run the hidden check stages its tests into the candidate workspace (and the regression check writes
 * caches there). The code evaluators discover changed paths by comparing that workspace with the pre-agent snapshot, so
 * they have to run first. The full runner needs the CI fixtures (bubblewrap toolchain exposure checks), so this pins the
 * order in the source and demonstrates the failure it prevents with the real evaluator.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runner: any = await import(pathToFileURL(path.join(ROOT, "eval/evaluators/code/runner.mjs")).href);

test("run.mjs runs the code evaluators before the hidden and regression checks", () => {
  const source = fs.readFileSync(path.join(ROOT, "eval/run.mjs"), "utf8");
  const evaluators = source.indexOf("await runCodeEvaluators(");
  const hidden = source.indexOf("await runCheck(task, hiddenWs, task.hidden");
  const regression = source.indexOf("await runCheck(task, regressionWs, task.regression");
  assert.ok(evaluators > 0 && hidden > 0 && regression > 0);
  assert.ok(evaluators < hidden, "evaluators must run before the hidden check stages its tests");
  assert.ok(evaluators < regression, "evaluators must run before the regression check writes into the workspace");
});

test("staging hidden tests into the candidate before diff_boundary makes a valid patch fail (why the order matters)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp1302-run-order-"));
  const baseline = path.join(root, "baseline");
  const candidate = path.join(root, "candidate");
  try {
    fs.mkdirSync(path.join(baseline, "src"), { recursive: true });
    fs.writeFileSync(path.join(baseline, "src/math.js"), "exports.add = (a, b) => a - b;\n");
    fs.cpSync(baseline, candidate, { recursive: true });
    fs.writeFileSync(path.join(candidate, "src/math.js"), "exports.add = (a, b) => a + b;\n");
    const snapshot = runner.captureWorkspaceSnapshot(baseline);
    const task = { evaluators: [{ type: "diff_boundary", allowedPaths: ["src/"] }] };
    const [before] = await runner.runCodeEvaluators({ task, candidateWorkspace: candidate, baselineSnapshot: snapshot });
    assert.equal(before.passed, true, JSON.stringify(before.details));
    fs.mkdirSync(path.join(candidate, "hidden"));
    fs.writeFileSync(path.join(candidate, "hidden/add.test.js"), "// staged by the hidden check\n");
    const [after] = await runner.runCodeEvaluators({ task, candidateWorkspace: candidate, baselineSnapshot: snapshot });
    assert.equal(after.passed, false);
    assert.deepEqual(after.details.violations.map((v: any) => v.file), ["hidden/add.test.js"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
