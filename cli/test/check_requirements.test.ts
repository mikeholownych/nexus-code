import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = path.resolve(import.meta.dirname, "..", "..", "scripts", "check_requirements.mjs");
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

function ledger(row: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ledger-"));
  const file = path.join(dir, "REQUIREMENTS.md");
  fs.writeFileSync(file, [
    "| ID | Source | Requirement | Rationale | Location | Evidence | Status | Acceptance | Class | Finding | Spec / Plan |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    row,
    "",
  ].join("\n"));
  return file;
}

// REQ-OPS-102 / ACC-GOV-01
test("the ledger checker passes the repository ledger in report mode", () => {
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("the ledger checker rejects a test reference whose test does not exist", () => {
  const file = ledger('| REQ-SEC-101 | x | x | x | x | test:cli/test/config.test.ts::"no such test name" | tested | ACC-SAFE-01 | **B** | x | SPEC-01 / PLAN-01 |');
  const result = run("--ledger", file);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /not found/);
});

test("the ledger checker rejects a blocker without spec, plan or acceptance, and an undefined acceptance id", () => {
  assert.equal(run("--ledger", ledger("| REQ-SEC-101 | x | x | x | x | x | open | — | **B** | x | — |")).status, 1);
  const undefinedAcc = run("--ledger", ledger("| REQ-SEC-101 | x | x | x | x | x | open | ACC-NOPE-01 | **B** | x | SPEC-01 / PLAN-01 |"));
  assert.match(undefinedAcc.stdout, /ACC-NOPE-01 is not defined/);
});

test("enforce mode requires blocker rows to be tested", () => {
  const file = ledger('| REQ-SEC-101 | x | x | x | x | test:cli/test/config.test.ts::"buildConfig applies flags" | open | ACC-SAFE-01 | **B** | x | SPEC-01 / PLAN-01 |');
  assert.equal(run("--ledger", file).status, 0);
  const enforced = run("--ledger", file, "--enforce");
  assert.equal(enforced.status, 1);
  assert.match(enforced.stdout, /below 'tested'/);
});
