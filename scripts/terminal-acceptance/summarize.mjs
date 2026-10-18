#!/usr/bin/env node
// Gate for the manual real-terminal matrix (ACCEPTANCE §5.3) over the attempt records written by run-cell.sh.
//   node scripts/terminal-acceptance/summarize.mjs <evidence dir> --rc vX.Y.Z-rc.N --manifest-sha256 <hex> \
//     [--dispositions dispositions.json]
// --manifest-sha256 is the SHA-256 of MANIFEST.sha256 inside the RC release archive, so every cell must have run the
// published RC package. The gate fails closed:
//   - every terminal × size cell needs a complete, verified attempt (otherwise NOT RUN: ACCEPTANCE §1 rule 5);
//   - an attempt is complete only when its self-hash, file hashes, both launch measurements and the mock log's
//     scenario proof (approve x2 tool rounds, stream, sleep tool call) all verify;
//   - checks 2, 5 and 6 have zero FAIL in ANY attempt; a measured survivor or unrestored terminal turns PASS into FAIL;
//   - every other FAIL, in any attempt, needs a written disposition keyed "<cell>:<check>".
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TERMINALS = ["xterm", "kitty", "tmux-gnome", "vscode", "gnome"];
const SIZES = ["80x24", "40x14", "200x60"];
const CHECKS = ["1", "2", "3", "4", "5", "6", "7"];
const SAFETY = new Set(["2", "5", "6"]);
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const dir = process.argv[2];
const rc = arg("--rc");
const manifestSha = arg("--manifest-sha256");
if (!dir || !/^v\d+\.\d+\.\d+-rc\.\d+$/.test(rc ?? "") || !/^[0-9a-f]{64}$/.test(manifestSha ?? "")) {
  console.error("usage: summarize.mjs <evidence dir> --rc vX.Y.Z-rc.N --manifest-sha256 <hex> [--dispositions file]");
  process.exit(2);
}
const dispositions = arg("--dispositions") ? JSON.parse(fs.readFileSync(arg("--dispositions"), "utf8")) : {};
const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Why an attempt record cannot be used, or null. */
function attemptProblem(file, record, cell) {
  const sidecar = `${file}.sha256`;
  if (!fs.existsSync(sidecar) || fs.readFileSync(sidecar, "utf8").split(/\s+/)[0] !== sha(file)) return "record self-hash missing or wrong";
  if (record.cell !== cell) return `record names cell ${record.cell}`;
  if (record.rc !== rc) return `record is for ${record.rc}, not ${rc}`;
  if (record.packageManifestSha256 !== manifestSha) return "installed package manifest differs from the RC archive";
  for (const [name, entry] of Object.entries(record.files ?? {})) {
    const target = path.join(dir, entry.path);
    if (!fs.existsSync(target) || sha(target) !== entry.sha256) return `${name} file missing or changed`;
  }
  if (Object.keys(record.files ?? {}).length !== 5) return "record does not list its five evidence files";
  if (record.files.approvalScreenshot.sha256 === record.files.postExitScreenshot.sha256) return "the two screenshots are the same file";
  const launches = (record.measured ?? []).map((m) => m.launch).sort().join(",");
  if (launches !== "main,no_color") return `measured launches are [${launches}], not main and no_color`;
  if (record.measured.some((m) => !Number.isInteger(m.survivors) || typeof m.sttyRestored !== "boolean")) return "measurements are malformed";
  const s = record.scenarios ?? {};
  if (!(s.approveToolRounds?.includes(0) && s.approveToolRounds?.includes(1)) || !(s.stream >= 1) || !(s.sleepTool >= 1)) return "the mock log does not show the approve, stream and sleep scenarios";
  if (CHECKS.some((check) => !["PASS", "FAIL"].includes(record.checks?.[check]?.result))) return "a check has no PASS/FAIL";
  return null;
}

const problems = [];
const rows = [];
for (const terminal of TERMINALS) {
  for (const size of SIZES) {
    const cell = `${terminal}-${size}`;
    const files = fs.readdirSync(dir).filter((f) => new RegExp(`^cell-${cell.replace(/\./g, "\\.")}\\.attempt-\\d+\\.json$`).test(f)).sort();
    const aborted = fs.readdirSync(dir).filter((f) => f.startsWith(`cell-${cell}.attempt-`) && f.endsWith(".partial")).length;
    const attempts = [];
    for (const name of files) {
      const file = path.join(dir, name);
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      const problem = attemptProblem(file, record, cell);
      if (problem) { problems.push(`${cell} ${name}: unusable (${problem})`); continue; }
      const results = {};
      for (const check of CHECKS) {
        let result = record.checks[check].result;
        if (check === "5" && record.measured.some((m) => m.survivors > 0)) result = "FAIL (measured survivors)";
        if (check === "6" && record.measured.some((m) => !m.sttyRestored)) result = "FAIL (terminal not restored)";
        results[check] = result;
        if (!result.startsWith("FAIL")) continue;
        if (SAFETY.has(check)) problems.push(`${cell} attempt ${record.attempt}: safety check ${check} ${result}`);
        else if (!dispositions[`${cell}:${check}`]) problems.push(`${cell} attempt ${record.attempt}: check ${check} FAIL without a written disposition`);
      }
      attempts.push({ attempt: record.attempt, results });
    }
    if (!attempts.length) { problems.push(`${cell}: NOT RUN`); rows.push({ cell, status: "NOT RUN", attempts: 0, aborted }); continue; }
    rows.push({ cell, status: "RECORDED", attempts: attempts.length, aborted, latest: attempts[attempts.length - 1] });
  }
}

console.log(`| cell | attempts | ${CHECKS.join(" | ")} |\n|---|---|${"---|".repeat(CHECKS.length)}`);
for (const row of rows) {
  const cells = row.status === "NOT RUN" ? CHECKS.map(() => "NOT RUN") : CHECKS.map((c) => row.latest.results[c]);
  console.log(`| ${row.cell} | ${row.attempts}${row.aborted ? ` (+${row.aborted} aborted)` : ""} | ${cells.join(" | ")} |`);
}
const verdict = problems.length ? "FAIL" : "PASS";
console.log(`\nREQ-QUAL-108 manual matrix gate for ${rc} (package manifest ${manifestSha.slice(0, 12)}): ${verdict}`);
for (const problem of problems) console.log(`- ${problem}`);
fs.writeFileSync(path.join(dir, "matrix-summary.json"), `${JSON.stringify({ verdict, rc, packageManifestSha256: manifestSha, rows, problems, dispositions }, null, 2)}\n`);
process.exit(problems.length ? 1 : 0);
