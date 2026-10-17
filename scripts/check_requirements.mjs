// Checks docs/v1.0.0/REQUIREMENTS.md against the rest of the repository (REQ-OPS-102).
//   report mode (default): every B/RR row links a spec, a plan and an acceptance ID; every ACC id it names is defined
//     (in a spec table, a spec's "ACC-X-01 to ACC-X-NN" range, or ACCEPTANCE.md); every `test:<file>::"<name>"` reference
//     in a row names an existing test file that contains <name>.
//   --enforce (release gate): additionally every B/RR row is at least `tested` and carries a test: or ACC reference.
// Exit 1 on any problem; prints a summary table either way. `--ledger <file>` checks another ledger (used by its test).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const enforce = args.includes("--enforce");
const ledgerArg = args.indexOf("--ledger");
const pkg = path.join(root, "docs", "v1.0.0");
const ledgerPath = ledgerArg >= 0 ? path.resolve(args[ledgerArg + 1]) : path.join(pkg, "REQUIREMENTS.md");

const read = (p) => fs.readFileSync(p, "utf8");
const specs = fs.readdirSync(path.join(pkg, "specs")).map((f) => read(path.join(pkg, "specs", f)));
const acceptance = read(path.join(pkg, "ACCEPTANCE.md"));

function accDefined(id) {
  const cell = new RegExp(`\\|\\s*${id}\\s*\\|`);
  if (specs.some((s) => cell.test(s)) || cell.test(acceptance)) return true;
  const m = /^ACC-([A-Z0-9]+)-(\d+)$/.exec(id);
  if (!m) return false;
  const range = new RegExp(`ACC-${m[1]}-(\\d+) to ACC-${m[1]}-(\\d+)`, "g");
  return specs.some((s) => [...s.matchAll(range)].some((r) => Number(r[1]) <= Number(m[2]) && Number(m[2]) <= Number(r[2])));
}

function testExists(file, name) {
  const p = path.join(root, file);
  return fs.existsSync(p) && read(p).includes(name);
}

const RANK = { open: 0, partial: 1, implemented: 2, tested: 3, "visually-accepted": 4, "product-qualified": 5 };
const problems = [];
const counts = {};
let rows = 0;
let header = null;
for (const line of read(ledgerPath).split("\n")) {
  if (!line.startsWith("|")) { header = null; continue; }
  const cells = line.slice(1, -1).split("|").map((c) => c.trim());
  if (cells[0] === "ID") { header = cells; continue; }
  if (!header || !/^REQ-[A-Z]+-\d+[a-z]?$/.test(cells[0])) continue;
  const col = (name) => cells[header.findIndex((h) => h.startsWith(name))] ?? "";
  const id = cells[0];
  const cls = col("Class");
  const status = col("Status").split(/[\s(]/)[0];
  const acc = col("Acceptance");
  const links = col("Spec") || col("Links");
  const blocking = /\*\*B\*\*/.test(cls) || /^B\b/.test(cls);
  const required = blocking || /^RR\b/.test(cls);
  rows++;
  counts[status] = (counts[status] ?? 0) + 1;
  for (const accId of line.match(/ACC-[A-Z0-9]+-[A-Z0-9]+/g) ?? []) {
    if (!accDefined(accId)) problems.push(`${id}: ${accId} is not defined in any spec or ACCEPTANCE.md`);
  }
  for (const m of line.matchAll(/test:([\w./-]+)::"([^"]+)"/g)) {
    if (!testExists(m[1], m[2])) problems.push(`${id}: test reference ${m[1]}::"${m[2]}" not found`);
  }
  if (required && /^REQ-[A-Z]+-1\d\d/.test(id)) {
    if (!/SPEC-\w+/.test(links) || !/PLAN-\w+/.test(links)) problems.push(`${id}: ${blocking ? "blocker" : "release-required"} row lacks a SPEC and PLAN link`);
    if (!/ACC-|ACCEPTANCE/.test(acc)) problems.push(`${id}: no acceptance reference`);
  }
  if (enforce && required) {
    if (!(status in RANK) || RANK[status] < RANK.tested) problems.push(`${id}: status '${status}' is below 'tested'`);
    if (!/test:|ACC-|ACCEPTANCE/.test(line)) problems.push(`${id}: no test or acceptance evidence`);
  }
}

console.log(`requirements: ${rows} rows; ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}${enforce ? " (enforce)" : " (report)"}`);
for (const p of problems) console.log(`  ✖ ${p}`);
if (rows === 0) problems.push("no requirement rows parsed");
process.exit(problems.length ? 1 : 0);
