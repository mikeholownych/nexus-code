/**
 * Qualification-host preflight: evaluator build/typecheck commands run under /usr/bin/prlimit, so a host without a
 * working one must fail validation instead of failing every code-evaluator task (eval/host/validate.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = () => import(path.join(ROOT, "eval/host/prlimit.mjs"));

test("host preflight accepts a prlimit that applies a file-size limit", async () => {
  const { prlimitProblem } = await load();
  assert.equal(prlimitProblem({ exists: () => true, run: () => ({ status: 0 }) }), null);
});

test("host preflight rejects a missing or non-working prlimit", async () => {
  const { prlimitProblem } = await load();
  assert.match(prlimitProblem({ exists: () => false, run: () => ({ status: 0 }) }), /prlimit is missing.*util-linux/);
  assert.match(prlimitProblem({ exists: () => true, run: () => ({ status: 1, stderr: "boom" }) }), /prlimit could not apply a file-size limit/);
  assert.match(prlimitProblem({ exists: () => true, run: () => ({ status: null, error: new Error("EACCES") }) }), /prlimit could not apply a file-size limit/);
});

test("the real host's prlimit passes the preflight, and validate and provision both check it", async () => {
  const { prlimitProblem } = await load();
  assert.equal(prlimitProblem(), null);
  assert.match(fs.readFileSync(path.join(ROOT, "eval/host/validate.mjs"), "utf8"), /prlimitProblem/);
  const provision = fs.readFileSync(path.join(ROOT, "eval/host/provision.sh"), "utf8");
  assert.match(provision, /\/usr\/bin\/prlimit/, "provisioning checks the same absolute path as validate.mjs and the evaluator");
  assert.doesNotMatch(provision, /command -v prlimit/);
  assert.match(fs.readFileSync(path.join(ROOT, "eval/README.md"), "utf8"), /prlimit/);
});
