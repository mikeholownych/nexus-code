// Checks docs/v1.0.0/REQUIREMENTS.md against the rest of the repository (REQ-OPS-102).
//   report mode (default): every B/RR row links a spec, a plan and an acceptance ID; every ACC id it names is defined
//     (in a spec table, a spec's "ACC-X-01 to ACC-X-NN" range, or ACCEPTANCE.md); every `test:<file>::"<name>"` reference
//     in a row names an existing test file that contains <name>.
//   --enforce (release gate): additionally every B/RR row is at least `tested` and carries a test: or ACC reference.
// Exit 1 on any problem; prints a summary table either way. `--ledger <file>` checks another ledger (used by its test).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const enforce = args.includes("--enforce");
const ledgerArg = args.indexOf("--ledger");
const qualificationArg = args.indexOf("--qualification-record");
const artifactArg = args.indexOf("--rc-artifact");
const evidenceRootArg = args.indexOf("--evidence-root");
const qualificationMode = [qualificationArg, artifactArg, evidenceRootArg].some((i) => i >= 0);
const pkg = path.join(root, "docs", "v1.0.0");
const ledgerPath = ledgerArg >= 0 ? path.resolve(args[ledgerArg + 1]) : path.join(pkg, "REQUIREMENTS.md");

const read = (p) => fs.readFileSync(p, "utf8");
const specs = fs.readdirSync(path.join(pkg, "specs")).map((f) => read(path.join(pkg, "specs", f)));
const acceptance = read(path.join(pkg, "ACCEPTANCE.md"));
const decisions = read(path.join(pkg, "DECISIONS.md"));

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
const requiredRows = new Map();
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
  if (required) requiredRows.set(id, { id, blocking, status, line });
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
}

const sha256 = (file) => {
  // Keep hashing synchronous with the checker's other filesystem validation.
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
};
function hasSymlinkComponent(absolutePath) {
  const resolved = path.resolve(absolutePath);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}
function evidenceFile(rootDir, relative, label) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) {
    problems.push(`${label}: unsafe evidence path`);
    return null;
  }
  const rootStat = fs.lstatSync(rootDir);
  if (!rootStat.isDirectory() || hasSymlinkComponent(rootDir)) {
    problems.push(`${label}: evidence root must be a real directory`);
    return null;
  }
  let current = rootDir;
  for (const part of relative.split(/[\\/]/)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch {
      problems.push(`${label}: evidence file is missing`);
      return null;
    }
    if (stat.isSymbolicLink() || (current !== path.join(rootDir, relative) && !stat.isDirectory()) || (current === path.join(rootDir, relative) && !stat.isFile())) {
      problems.push(`${label}: evidence path must contain only directories and a regular file`);
      return null;
    }
  }
  return current;
}

if (qualificationMode && (!enforce || qualificationArg < 0 || artifactArg < 0 || evidenceRootArg < 0)) {
  problems.push("--qualification-record, --rc-artifact, and --evidence-root must be supplied together with --enforce");
} else if (enforce) {
  let qualifiedRequirements = null;
  if (qualificationMode) {
    try {
      const recordPath = path.resolve(args[qualificationArg + 1]);
      const artifactPath = path.resolve(args[artifactArg + 1]);
      const evidenceRoot = path.resolve(args[evidenceRootArg + 1]);
      if (ledgerArg >= 0) throw new Error("--ledger cannot be used with exact-RC qualification enforcement");
      const recordStat = fs.lstatSync(recordPath);
      const artifactStat = fs.lstatSync(artifactPath);
      if (!recordStat.isFile() || hasSymlinkComponent(recordPath) || !artifactStat.isFile() || hasSymlinkComponent(artifactPath)) throw new Error("record and RC artifact must be regular files without symlink components");
      const record = JSON.parse(read(recordPath));
      const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      if (git("status", "--porcelain", "--untracked-files=all")) throw new Error("exact-RC qualification requires a clean source worktree");
      const sourceCommit = git("rev-parse", "HEAD");
      if (record.schemaVersion !== 1) throw new Error("unsupported qualification record schema");
      if (record.sourceCommit !== sourceCommit) throw new Error("qualification source commit does not match current source commit");
      if (typeof record.rcTag !== "string" || !/^v\d+\.\d+\.\d+-rc\.\d+$/.test(record.rcTag)) throw new Error("RC tag does not point to the current source commit");
      let taggedCommit;
      try { taggedCommit = git("rev-parse", `${record.rcTag}^{commit}`); } catch { throw new Error("RC tag does not point to the current source commit"); }
      if (taggedCommit !== sourceCommit) throw new Error("RC tag does not point to the current source commit");
      if (record.artifactSha256 !== sha256(artifactPath)) throw new Error("RC artifact SHA-256 does not match qualification record");
      const provenance = record.artifactProvenance;
      const provenancePath = evidenceFile(evidenceRoot, provenance?.path, "RC artifact provenance");
      if (provenance?.sourceCommit !== sourceCommit || provenance?.artifactSha256 !== record.artifactSha256 || !provenancePath || provenance.sha256 !== sha256(provenancePath)) throw new Error("RC artifact provenance does not bind the source commit and artifact digest");
      const acceptance = record.independentAcceptance;
      const reviewer = typeof acceptance?.reviewer === "string" ? acceptance.reviewer.trim().toLocaleLowerCase("en-US") : "";
      const implementers = Array.isArray(acceptance?.implementers) ? acceptance.implementers : [];
      if (!acceptance || !["ACCEPT", "ACCEPT WITH DEFECTS"].includes(acceptance.disposition) || !reviewer || !Array.isArray(acceptance.implementers) || implementers.some((person) => typeof person !== "string" || !person.trim()) || implementers.some((person) => person.trim().toLocaleLowerCase("en-US") === reviewer)) throw new Error("independent acceptance reviewer must be independent of implementers");
      if (!Number.isInteger(acceptance.blockingDefects) || acceptance.blockingDefects !== 0) throw new Error("independent acceptance has unresolved blocker defects");
      const defects = acceptance.defects ?? [];
      if (!Array.isArray(defects) || (acceptance.disposition === "ACCEPT" && defects.length > 0) || (acceptance.disposition === "ACCEPT WITH DEFECTS" && defects.length === 0) || defects.some((defect) => typeof defect.id !== "string" || !defect.id.trim() || defect.blocking !== false || typeof defect.ownerDisposition !== "string" || !defect.ownerDisposition.trim())) throw new Error("independent acceptance defects need IDs and non-blocking owner dispositions");
      const report = acceptance.report;
      const reportPath = evidenceFile(evidenceRoot, report?.path, "independent acceptance report");
      if (!reportPath || report.sha256 !== sha256(reportPath)) throw new Error("independent acceptance report digest does not match");
      if (!record.requirements || typeof record.requirements !== "object" || Array.isArray(record.requirements)) throw new Error("qualification record requirements must be an object");
      qualifiedRequirements = record.requirements;
      for (const id of Object.keys(qualifiedRequirements)) if (!requiredRows.has(id)) throw new Error(`qualification record includes unknown or non-required requirement ${id}`);
      for (const [id, row] of requiredRows) {
        const evidence = qualifiedRequirements[id];
        if (!evidence) throw new Error(`missing qualification evidence for ${id}`);
        if (!Object.hasOwn(RANK, evidence.status) || RANK[evidence.status] < RANK.tested) throw new Error(`${id}: qualification status is below tested`);
        if (row.blocking && evidence.status !== "product-qualified") {
          const decision = evidence.qualificationNotApplicable?.decision;
          const decisionExists = typeof decision === "string" && /^DEC-\d{2}$/.test(decision) && new RegExp(`^## ${decision}:`, "m").test(decisions);
          if (evidence.status !== "tested" || typeof evidence.qualificationNotApplicable?.reason !== "string" || !evidence.qualificationNotApplicable.reason.trim() || !decisionExists) throw new Error(`${id}: blocker must be product-qualified or tested with an approved decision and qualification-not-applicable reason`);
        }
        if (!Array.isArray(evidence.evidence) || evidence.evidence.length === 0) throw new Error(`${id}: qualification evidence references are required`);
        for (const ref of evidence.evidence) {
          if (typeof ref?.id !== "string" || !/^ACC-[A-Z0-9]+-[A-Z0-9]+$/.test(ref.id) || !row.line.includes(ref.id)) throw new Error(`${id}: evidence must cite an acceptance criterion on its ledger row`);
          const file = evidenceFile(evidenceRoot, ref.path, `${id} evidence`);
          if (!file || typeof ref.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(ref.sha256) || sha256(file) !== ref.sha256) throw new Error(`${id}: evidence digest is missing or does not match`);
        }
      }
      console.log(`qualification evidence verified for ${record.rcTag} at ${sourceCommit} (${record.artifactSha256})`);
    } catch (error) {
      problems.push(`qualification evidence invalid: ${error.message}`);
    }
  }
  for (const [id, row] of requiredRows) {
    if (!(row.status in RANK) || RANK[row.status] < RANK.tested) problems.push(`${id}: source ledger status '${row.status}' is below 'tested'`);
    if (!/test:|ACC-|ACCEPTANCE/.test(row.line)) problems.push(`${id}: no test or acceptance evidence`);
  }
}

console.log(`requirements: ${rows} rows; ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}${enforce ? " (enforce)" : " (report)"}`);
for (const p of problems) console.log(`  ✖ ${p}`);
if (rows === 0) problems.push("no requirement rows parsed");
process.exit(problems.length ? 1 : 0);
