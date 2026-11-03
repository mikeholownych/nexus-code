import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BenchmarkEvaluator } from "../src/evaluator.js";

test("malformed JSONL warnings redact credential-like parser details", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-evaluator-diagnostic-"));
  const datasetPath = path.join(directory, "malformed.jsonl");
  const syntheticCredential = `sk-live-${"A".repeat(40)}`;
  const warnings: string[] = [];
  const originalWarn = console.warn;

  try {
    fs.writeFileSync(datasetPath, `${syntheticCredential}\n`);
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));

    assert.deepEqual(BenchmarkEvaluator.loadDataset(datasetPath), []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Warning: Skipped malformed JSONL line 1/);
    assert.ok(!warnings[0].includes(syntheticCredential), "parser diagnostics must not expose synthetic credentials");
  } finally {
    console.warn = originalWarn;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
