"use strict";
// Prints one line per case (about a thousand lines) and the failures last, like a verbose CI reporter.
const { addCents, percentOf, splitEvenly } = require("./src/calc");
const cases = require("./test/cases.json");
let failed = 0;
const failures = [];
for (const [kind, id, x, y, want] of cases) {
  let ok = false, got;
  if (kind === "add") { got = addCents(x, y); ok = got === want; }
  else if (kind === "pct") { got = percentOf(x, y); ok = got === want; }
  else { got = splitEvenly(x, y); ok = got.length === y && got.reduce((s, n) => s + n, 0) === want && Math.max(...got) - Math.min(...got) <= 1; }
  console.log(`${ok ? "PASS" : "FAIL"} #${id} ${kind}(${x}, ${y})${ok ? "" : ` -> ${JSON.stringify(got)}`}`);
  if (!ok) { failed++; failures.push(`#${id} ${kind}(${x}, ${y}) expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`); }
}
console.log(`\n${cases.length - failed} passed, ${failed} failed`);
if (failed) { console.log("FAILURES (first 12):\n" + failures.slice(0, 12).join("\n")); process.exit(1); }
