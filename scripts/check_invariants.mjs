// Checks docs/INVARIANTS.md against the repository.
//   - every rule row names enforcing files and test files that exist;
//   - every rule id appears in at least one test (or fixture) under cli/test, so a rule has proof;
//   - every `I-<AREA>-<n>` id written in cli/src or cli/test is a row in the table, so code cannot cite an undefined rule.
// Exit 1 on any problem. Run from anywhere: paths resolve from this file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const doc = fs.readFileSync(path.join(root, "docs", "INVARIANTS.md"), "utf8");
const problems = [];

const rows = doc.split("\n").filter((line) => /^\| I-[A-Z]+-\d+ \|/.test(line)).map((line) => {
  const cells = line.split("|").slice(1, -1).map((c) => c.trim());
  const files = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  return { id: cells[0], enforced: files(cells[2] ?? ""), proofs: files(cells[3] ?? "") };
});
if (rows.length === 0) problems.push("no rule rows found in docs/INVARIANTS.md");
const ids = new Set(rows.map((r) => r.id));
if (ids.size !== rows.length) problems.push("a rule id appears twice");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "dist" ? [] : walk(full);
    return /\.(ts|mjs|json)$/.test(e.name) ? [full] : [];
  });
}
const testFiles = walk(path.join(root, "cli", "test"));
const srcFiles = walk(path.join(root, "cli", "src"));
const textOf = new Map([...testFiles, ...srcFiles].map((f) => [f, fs.readFileSync(f, "utf8")]));

for (const row of rows) {
  if (row.enforced.length === 0) problems.push(`${row.id}: no enforcing file named`);
  if (row.proofs.length === 0) problems.push(`${row.id}: no proving test named`);
  for (const file of [...row.enforced, ...row.proofs]) {
    if (!fs.existsSync(path.join(root, file))) problems.push(`${row.id}: ${file} does not exist`);
  }
}
for (const [file, text] of textOf) {
  for (const match of text.matchAll(/\bI-[A-Z]+-\d+\b/g)) {
    if (!ids.has(match[0])) problems.push(`${path.relative(root, file)}: cites ${match[0]}, which is not a row in docs/INVARIANTS.md`);
  }
}

if (problems.length) {
  for (const p of [...new Set(problems)]) console.error(`invariants: ${p}`);
  process.exit(1);
}
console.log(`invariants: ${rows.length} rows; all referenced source and test files exist`);
