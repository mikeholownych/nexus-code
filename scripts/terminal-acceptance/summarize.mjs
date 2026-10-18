#!/usr/bin/env node
// Gate for the manual real-terminal matrix (ACCEPTANCE §5.3) over the cell records written by run-cell.sh.
//   node scripts/terminal-acceptance/summarize.mjs <evidence dir> [--dispositions dispositions.json]
// Every terminal × size cell must exist (a missing cell is NOT RUN, which fails the gate: ACCEPTANCE §1 rule 5), all
// cells must name the same RC and nexus binary, and checks 2, 5 and 6 must have zero FAIL. A measured survivor overrides
// a PASS on check 5; an unrestored terminal overrides a PASS on check 6. Any other FAIL needs a written disposition,
// keyed "<cell>:<check>" in the dispositions file.
import fs from "node:fs";
import path from "node:path";

const TERMINALS = ["xterm", "kitty", "tmux-gnome", "vscode", "gnome"];
const SIZES = ["80x24", "40x14", "200x60"];
const SAFETY = new Set(["2", "5", "6"]);
const dir = process.argv[2];
if (!dir) { console.error("usage: summarize.mjs <evidence dir> [--dispositions file]"); process.exit(2); }
const dispositionsFile = process.argv.includes("--dispositions") ? process.argv[process.argv.indexOf("--dispositions") + 1] : null;
const dispositions = dispositionsFile ? JSON.parse(fs.readFileSync(dispositionsFile, "utf8")) : {};

const problems = [];
const rows = [];
const identities = new Set();
for (const terminal of TERMINALS) {
  for (const size of SIZES) {
    const cell = `${terminal}-${size}`;
    const file = path.join(dir, `cell-${cell}.json`);
    if (!fs.existsSync(file)) { rows.push({ cell, status: "NOT RUN" }); problems.push(`${cell}: NOT RUN`); continue; }
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    identities.add(`${record.rc} ${record.nexusSha256}`);
    const results = {};
    for (const check of ["1", "2", "3", "4", "5", "6", "7"]) {
      let result = record.checks?.[check]?.result;
      if (result !== "PASS" && result !== "FAIL") { problems.push(`${cell}: check ${check} has no PASS/FAIL`); result = "MISSING"; }
      if (check === "5" && record.measured?.some((exit) => exit.survivors > 0)) result = "FAIL (measured survivors)";
      if (check === "6" && record.measured?.some((exit) => !exit.sttyRestored)) result = "FAIL (terminal not restored)";
      results[check] = result;
      if (result.startsWith("FAIL")) {
        if (SAFETY.has(check)) problems.push(`${cell}: safety check ${check} ${result}`);
        else if (!dispositions[`${cell}:${check}`]) problems.push(`${cell}: check ${check} FAIL without a written disposition`);
      }
    }
    rows.push({ cell, status: "RECORDED", results });
  }
}
if (identities.size > 1) problems.push(`cells name different RC/binary identities: ${[...identities].join(" | ")}`);

console.log(`| cell | ${["1", "2", "3", "4", "5", "6", "7"].join(" | ")} |\n|---|${"---|".repeat(7)}`);
for (const row of rows) console.log(`| ${row.cell} | ${row.status === "NOT RUN" ? Array(7).fill("NOT RUN").join(" | ") : Object.values(row.results).join(" | ")} |`);
const verdict = problems.length ? "FAIL" : "PASS";
console.log(`\nREQ-QUAL-108 manual matrix gate: ${verdict}${identities.size === 1 ? ` (${[...identities][0]})` : ""}`);
for (const problem of problems) console.log(`- ${problem}`);
fs.writeFileSync(path.join(dir, "matrix-summary.json"), `${JSON.stringify({ verdict, identities: [...identities], rows, problems, dispositions }, null, 2)}\n`);
process.exit(problems.length ? 1 : 0);
