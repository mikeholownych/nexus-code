// Stable promotion check (ACCEPTANCE §1.1 stage 5): the stable-version commit must equal the accepted RC commit plus
// nothing but the synchronized version change. Usage: node scripts/check-version-only-diff.mjs <rc-ref> <stable-ref>
// The expected stable tree is rebuilt from the RC tree by taking the stable root package.json (which may differ from
// the RC's only in "version") and running that RC's scripts/sync-version.mjs; it must match the stable commit exactly.
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [rcRef, stableRef] = process.argv.slice(2);
const fail = (message) => { throw new Error(message); };
process.on("uncaughtException", (error) => { console.error(`check-version-only-diff: ${error.message}`); process.exit(1); });
if (!rcRef || !stableRef) fail("usage: check-version-only-diff.mjs <rc-ref> <stable-ref>");
const git = (...argv) => execFileSync("git", argv, { encoding: "utf8" }).trim();
const rc = git("rev-parse", `${rcRef}^{commit}`);
const stable = git("rev-parse", `${stableRef}^{commit}`);
if (git("rev-list", "--parents", "-n", "1", stable).split(" ").slice(1).join(" ") !== rc) fail(`stable ${stable} is not a single commit directly on RC ${rc}`);

const rcPackage = JSON.parse(git("show", `${rc}:package.json`));
const stablePackageText = execFileSync("git", ["show", `${stable}:package.json`], { encoding: "utf8" });
const stablePackage = JSON.parse(stablePackageText);
if (!/^\d+\.\d+\.\d+$/.test(stablePackage.version)) fail(`stable version '${stablePackage.version}' is not a stable SemVer`);
if (!isDeepStrictEqual({ ...rcPackage, version: null }, { ...stablePackage, version: null })) fail("root package.json changes more than its version");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-version-diff-"));
try {
  git("worktree", "add", "-q", "--detach", work, rc);
  fs.writeFileSync(path.join(work, "package.json"), stablePackageText);
  execFileSync(process.execPath, [path.join(work, "scripts/sync-version.mjs")], { cwd: work, stdio: "ignore" });
  const differing = execFileSync("git", ["diff", "--name-only", stable], { cwd: work, encoding: "utf8" }).trim();
  if (differing) fail(`stable commit differs from RC + sync-version ${stablePackage.version} in: ${differing.split("\n").join(", ")}`);
  const changed = git("diff", "--name-only", rc, stable).split("\n").filter(Boolean);
  console.log(`version-only: ${stable} = ${rc} + v${stablePackage.version} (${changed.join(", ")})`);
} finally {
  try { git("worktree", "remove", "--force", work); } catch { fs.rmSync(work, { recursive: true, force: true }); }
}
