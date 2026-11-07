/**
 * WP-1302: where the pinned workspace lives and which working directory the candidate typecheck uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runner: any = await import(pathToFileURL(path.join(ROOT, "eval/evaluators/code/runner.mjs")).href);

function scratch(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("the pinned workspace is created under the supplied scratch root, not os.tmpdir()", () => {
  const root = scratch("wp1302-scratch-root-");
  const baseline = path.join(root, "baseline");
  const candidate = path.join(root, "candidate");
  const scratchRoot = path.join(root, "tmpfs");
  fs.mkdirSync(scratchRoot);
  for (const dir of [baseline, candidate]) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "a.txt"), "x\n"); }
  try {
    const pinned = runner.createPinnedCandidateWorkspace(baseline, candidate, { scratchRoot });
    assert.ok(pinned.workspace.startsWith(`${scratchRoot}${path.sep}`), pinned.workspace);
    fs.rmSync(pinned.tempRoot, { recursive: true, force: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("typecheck_clean honours an explicit candidate working directory inside the workspace", async () => {
  const root = scratch("wp1302-candidate-cwd-");
  const baseline = path.join(root, "baseline");
  const candidate = path.join(root, "candidate");
  try {
    for (const dir of [baseline, candidate]) {
      fs.mkdirSync(path.join(dir, "packages/app"), { recursive: true });
      fs.writeFileSync(path.join(dir, "packages/app/marker.txt"), "x\n");
      fs.writeFileSync(path.join(dir, "packages/app/main.json"), "{}\n");
    }
    fs.writeFileSync(path.join(candidate, "packages/app/main.json"), '{"changed":true}\n');
    const command = "/usr/bin/node";
    const args = ["-e", `if(!require("fs").existsSync("marker.txt")){console.error("error TS9999: wrong working directory");process.exit(1)}`];
    const [result] = await runner.runCodeEvaluators({
      task: { evaluators: [{ type: "typecheck_clean", baseline: { command, args, cwd: path.join(baseline, "packages/app") }, candidate: { command, args, cwd: path.join(candidate, "packages/app") } }] },
      candidateWorkspace: candidate,
      typecheckBaselineWorkspace: baseline,
    });
    assert.equal(result.passed, true, JSON.stringify(result.details));
    const [escaping] = await runner.runCodeEvaluators({
      task: { evaluators: [{ type: "typecheck_clean", baseline: { command, args, cwd: path.join(baseline, "packages/app") }, candidate: { command, args, cwd: root } }] },
      candidateWorkspace: candidate,
      typecheckBaselineWorkspace: baseline,
    });
    assert.equal(escaping.passed, false);
    assert.match(String(escaping.details.error), /outside the candidate workspace/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
