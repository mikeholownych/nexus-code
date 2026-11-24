import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkCriticalComplexity, compareMetrics, measureFunction } from "../scripts/check_critical_complexity.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("critical complexity counts branch decisions and control nesting, excluding nested function bodies", () => {
  const source = `function sample(a: boolean, b: boolean) {
    if (a && b) return a ? 1 : 2;
    switch (Number(a)) {
      case 1: return 3;
      case 2: return 4;
      default: return 5;
    }
    function callback() { if (b || a) return 6; }
  }`;
  assert.deepEqual(measureFunction(source, { file: "fixture.ts", name: "sample" }), {
    cyclomatic: 6,
    maxNesting: 2,
    lines: 9,
  });
});

test("complexity gate rejects growth in either decision count or control nesting", () => {
  const baseline = { cyclomatic: 3, maxNesting: 2, lines: 20 };
  assert.deepEqual(compareMetrics(baseline, { cyclomatic: 4, maxNesting: 2, lines: 22 }).violations, [
    "cyclomatic complexity increased 3 -> 4",
  ]);
  assert.deepEqual(compareMetrics(baseline, { cyclomatic: 3, maxNesting: 3, lines: 18 }).violations, [
    "maximum control nesting increased 2 -> 3",
  ]);
  assert.deepEqual(compareMetrics(baseline, { cyclomatic: 2, maxNesting: 2, lines: 28 }).violations, []);
});

test("release baseline is an ancestor and tracked hot-path functions do not exceed it", () => {
  const result = checkCriticalComplexity(root);
  assert.equal(result.baselineRevision, "4d9996d485c2db866918c110d35e1c1a1d3b2911");
  assert.equal(result.rows.length, 5);
  for (const row of result.rows) assert.deepEqual(row.comparison.violations, [], `${row.target.file}::${row.target.name}`);
});
