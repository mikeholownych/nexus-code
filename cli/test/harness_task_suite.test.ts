import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadTaskSuiteFile } from "../src/core/harness/task_suite.js";

describe("harness task suite", () => {
  it("loads and validates a suite file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-suite-"));
    const p = path.join(tmp, "suite.json");
    fs.writeFileSync(p, JSON.stringify({ schemaVersion: 1, id: "suite1", cases: [{ id: "c1", description: "d", prompt: "p", expected: { verifierCommand: "echo ok" } }] }));
    const suite = loadTaskSuiteFile(p);
    assert.equal(suite.id, "suite1");
    assert.equal(suite.cases[0].expected?.verifierCommand, "echo ok");
  });

  it("rejects artifact path escape", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-suite-"));
    const p = path.join(tmp, "suite.json");
    fs.writeFileSync(p, JSON.stringify({ schemaVersion: 1, id: "suite1", cases: [{ id: "c1", description: "d", prompt: "p", expected: { artifactPath: "../evil.txt" } }] }));
    assert.throws(() => loadTaskSuiteFile(p), /artifactPath/);
  });
});
