/**
 * Qualification-host preflight rejects Bubblewrap releases affected by CVE-2026-87766 (eval/host/validate.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("host preflight accepts Bubblewrap 0.12.0 and later", async () => {
  const { bubblewrapVersionProblem } = await import(path.join(ROOT, "eval/host/bubblewrap.mjs"));
  for (const output of ["bubblewrap 0.12.0\n", "bubblewrap 0.13.1", "bubblewrap 0.100.0", "bubblewrap 1.0.0"]) {
    assert.equal(bubblewrapVersionProblem(output), null, output);
  }
});

test("host preflight rejects vulnerable or unrecognized Bubblewrap versions", async () => {
  const { bubblewrapVersionProblem } = await import(path.join(ROOT, "eval/host/bubblewrap.mjs"));
  for (const output of ["bubblewrap 0.9.0\n", "bubblewrap 0.11.99", "bubblewrap 0.6.1"]) {
    assert.match(bubblewrapVersionProblem(output), /below 0\.12\.0 \(CVE-2026-87766\)/, output);
  }
  for (const output of ["", undefined, "bubblewrap 0.12", "bwrap 0.13.1", "bubblewrap 0.13.1-rc1", "bubblewrap 0.13.1\nbubblewrap 0.9.0"]) {
    assert.match(bubblewrapVersionProblem(output), /unrecognized Bubblewrap version output/, String(output));
  }
});
