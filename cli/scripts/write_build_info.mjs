// Records the identity of this build in cli/dist/build-info.json (read by `nexus --version` and the doctor):
// the commit, its time, and whether the source differed from it. Deterministic for a given tree (no wall-clock time),
// so two builds of the same source are byte-identical. Not tracked: it describes a build, not the source.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(cli, "..");
const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
const commit = git("rev-parse", "--short=12", "HEAD");
const info = {
  commit: commit ?? "unknown",
  commitTime: commit ? git("log", "-1", "--format=%cI") : null,
  // A detached checkout has no branch ("HEAD" is not one).
  branch: commit ? (git("rev-parse", "--abbrev-ref", "HEAD") || "").replace(/^HEAD$/, "") || null : null,
  // Build output is tracked in this repository; a rebuilt cli/dist alone does not make the source dirty.
  dirty: commit ? Boolean(git("status", "--porcelain", "--untracked-files=no", "--", ".", ":(exclude)cli/dist")) : false,
};
fs.writeFileSync(path.join(cli, "dist", "build-info.json"), JSON.stringify(info, null, 2) + "\n");
