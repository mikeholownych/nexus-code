/**
 * WP-1302: diff_boundary must not count evaluator-staged hidden tests as agent changes.
 *
 * In a non-hardened run the hidden check stages its tests into the candidate workspace (and the regression check writes
 * caches there). The code evaluators compare that workspace with the pre-agent snapshot, so they have to run first. The
 * real run needs the CI sandbox fixtures; eval/check_phase.mjs holds the ordering as a function that eval/run.mjs calls, so
 * it is exercised here with the real evaluators and a hidden step that really writes into the workspace.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runner: any = await import(pathToFileURL(path.join(ROOT, "eval/evaluators/code/runner.mjs")).href);
const phase: any = await import(pathToFileURL(path.join(ROOT, "eval/check_phase.mjs")).href);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp1302-run-order-"));
  const baseline = path.join(root, "baseline");
  const candidate = path.join(root, "candidate");
  fs.mkdirSync(path.join(baseline, "src"), { recursive: true });
  fs.writeFileSync(path.join(baseline, "src/math.js"), "exports.add = (a, b) => a - b;\n");
  fs.cpSync(baseline, candidate, { recursive: true });
  fs.writeFileSync(path.join(candidate, "src/math.js"), "exports.add = (a, b) => a + b;\n");
  return { root, candidate, snapshot: runner.captureWorkspaceSnapshot(baseline) };
}

const task = { evaluators: [{ type: "diff_boundary", allowedPaths: ["src/"] }] };

test("a hidden step that stages tests into the candidate workspace does not affect diff_boundary", async () => {
  const { root, candidate, snapshot } = fixture();
  const calls: string[] = [];
  try {
    const result = await phase.runPostAgentPhase({
      evaluators: async () => { calls.push("evaluators"); return runner.runCodeEvaluators({ task, candidateWorkspace: candidate, baselineSnapshot: snapshot }); },
      hidden: async () => { calls.push("hidden"); fs.mkdirSync(path.join(candidate, "hidden")); fs.writeFileSync(path.join(candidate, "hidden/add.test.js"), "// staged by the hidden check\n"); return { pass: true }; },
      regression: async () => { calls.push("regression"); fs.writeFileSync(path.join(candidate, ".cache"), "x\n"); return { pass: true }; },
    });
    assert.deepEqual(calls, ["evaluators", "hidden", "regression"]);
    assert.equal(result.evaluators[0].passed, true, JSON.stringify(result.evaluators[0].details));
    // The same evaluator run after the staging is what the old order produced.
    const [late] = await runner.runCodeEvaluators({ task, candidateWorkspace: candidate, baselineSnapshot: snapshot });
    assert.equal(late.passed, false);
    assert.deepEqual(late.details.violations.map((v: any) => v.file), [".cache", "hidden/add.test.js"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("run.mjs drives the post-agent steps through runPostAgentPhase", () => {
  const source = fs.readFileSync(path.join(ROOT, "eval/run.mjs"), "utf8");
  assert.match(source, /import \{ runPostAgentPhase \} from "\.\/check_phase\.mjs"/);
  const call = source.slice(source.indexOf("await runPostAgentPhase("));
  assert.ok(call.indexOf("evaluators:") < call.indexOf("hidden:") && call.indexOf("hidden:") < call.indexOf("regression:"));
  assert.doesNotMatch(source, /const (hidden|regression) = .*await runCheck/, "no step runs outside the phase function");
});
