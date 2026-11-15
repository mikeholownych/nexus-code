// Doc version drift check (v1.2.1 DH-1). docs/releases/LATEST holds the latest stable tag (one line, vX.Y.Z); the release
// step is the only thing that changes it. Checks, with exit 1 on any problem:
//   1. LATEST is a stable tag, has docs/releases/<tag>.md, and is not newer than the package.json version.
//   2. README.md: every "latest stable release is [vX]" names LATEST, every stable NEXUS_VERSION=vX pin is LATEST, and no
//      version at or below LATEST is described as "in development".
//   3. CHANGELOG.md: a "## [vX] - Unreleased" heading is allowed only for a version newer than LATEST.
// `--root <dir>` checks another tree (used by its test).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const rootIdx = args.indexOf("--root");
const root = rootIdx >= 0 ? path.resolve(args[rootIdx + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const parse = (v) => v.replace(/^v/, "").split("-")[0].split(".").map(Number);
const cmp = (a, b) => { const x = parse(a), y = parse(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

const problems = [];
const latest = read("docs/releases/LATEST").trim();
if (!/^v\d+\.\d+\.\d+$/.test(latest)) {
  console.error(`docs/releases/LATEST must hold one stable tag vX.Y.Z, found '${latest}'`);
  process.exit(1);
}
if (!fs.existsSync(path.join(root, "docs/releases", `${latest}.md`))) problems.push(`docs/releases/${latest}.md does not exist`);
const pkg = JSON.parse(read("package.json")).version;
if (cmp(latest, pkg) > 0) problems.push(`LATEST ${latest} is newer than package.json version ${pkg}`);

const readme = read("README.md");
for (const m of readme.matchAll(/latest stable release is \[?(v\d+\.\d+\.\d+)/g)) {
  if (m[1] !== latest) problems.push(`README.md names ${m[1]} as the latest stable release; LATEST is ${latest}`);
}
for (const m of readme.matchAll(/NEXUS_VERSION=(v\d+\.\d+\.\d+)(?![-\w.])/g)) {
  if (m[1] !== latest) problems.push(`README.md install pin NEXUS_VERSION=${m[1]} is not the latest stable ${latest}`);
}
for (const m of readme.matchAll(/(v\d+\.\d+\.\d+)[^.\n]{0,20}\bin development/g)) {
  if (cmp(m[1], latest) <= 0) problems.push(`README.md says ${m[1]} is in development but ${latest} is released`);
}

for (const m of read("CHANGELOG.md").matchAll(/^## \[(v\d+\.\d+\.\d+)\]\s*-\s*Unreleased/gm)) {
  if (cmp(m[1], latest) <= 0) problems.push(`CHANGELOG.md heading [${m[1]}] says Unreleased but ${latest} is released`);
}

if (problems.length) {
  for (const p of problems) console.error(`doc version drift: ${p}`);
  process.exit(1);
}
console.log(`doc versions consistent with latest stable ${latest}`);
