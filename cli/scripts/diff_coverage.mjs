// Diff coverage for the CLI TypeScript source. Reads Node's built-in lcov report and the added lines
// from git, then reports the share of coverable added lines that the suite actually executed.
// Lines with no DA record (comments, blanks, type-only code) are not coverable and are ignored.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { optionValue } from "./script_args.mjs";

const arg = (name, fallback) => optionValue(process.argv, name, fallback);
const has = (name) => process.argv.includes(`--${name}`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const lcovPath = path.resolve(root, arg("lcov", "cli/coverage/lcov.info"));
const base = arg("base", "HEAD~1");
const min = Number(arg("min", "0"));
const includeWorktree = has("include-worktree");

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  return result.stdout;
}

/** Repo-relative paths of changed production TypeScript files. */
function changedFiles() {
  const sets = [git(["diff", "--name-only", "--diff-filter=ACMRTUXB", `${base}...HEAD`])];
  if (includeWorktree) {
    sets.push(git(["diff", "--name-only", "--diff-filter=ACMRTUXB"]));
    sets.push(git(["diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB"]));
  }
  return [...new Set(sets.flatMap((text) => text.split(/\r?\n/).filter(Boolean)))]
    .filter((file) => /^cli\/src\/.*\.ts$/.test(file) && !file.endsWith(".d.ts"))
    .sort();
}

/** Added line numbers in the new file, from zero-context hunks. Pure so it can be tested without a git repo. */
export function parseAddedLines(diffText) {
  const lines = [];
  let current = 0;
  let inHunk = false;
  for (const line of diffText.split(/\r?\n/)) {
    // File headers are only headers before a hunk; an added source line can itself start with `++`.
    if (!inHunk && (line.startsWith("+++") || line.startsWith("---"))) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      current = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (line.startsWith("+")) { lines.push(current); current += 1; }
    else if (line.startsWith(" ")) current += 1;
    // Deleted lines do not advance the new-file line number.
  }
  return lines;
}

function addedLines(file, worktree = false) {
  const args = worktree
    ? ["diff", "-U0", "--", file]
    : ["diff", "-U0", `${base}...HEAD`, "--", file];
  return parseAddedLines(git(args));
}

/** lcov DA hits keyed by repo-relative source path and line. Pure so it can be tested without a fixture file. */
export function parseLcov(text) {
  const hitCounts = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      const sf = line.slice(3).trim();
      current = sf.startsWith("cli/") ? sf : `cli/${sf}`;
      if (!hitCounts.has(current)) hitCounts.set(current, new Map());
    } else if (line.startsWith("DA:") && current) {
      const [number, hits] = line.slice(3).split(",").map(Number);
      if (Number.isInteger(number) && Number.isFinite(hits)) hitCounts.get(current).set(number, hits);
    } else if (line === "end_of_record") current = null;
  }
  return hitCounts;
}

function readLcov(file) {
  return parseLcov(fs.readFileSync(file, "utf8"));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const files = changedFiles();
  const lcov = fs.existsSync(lcovPath) ? readLcov(lcovPath) : new Map();
  const rows = [];
  let eligible = 0;
  let covered = 0;
  for (const file of files) {
    const hits = lcov.get(file) ?? new Map();
    const added = [...new Set([...addedLines(file), ...(includeWorktree ? addedLines(file, true) : [])])];
    const lines = added.filter((line) => hits.has(line));
    const hit = lines.filter((line) => hits.get(line) > 0);
    eligible += lines.length;
    covered += hit.length;
    rows.push({ file, added: added.length, coverable: lines.length, covered: hit.length });
  }
  const percent = eligible ? (covered / eligible) * 100 : null;
  const report = {
    base,
    lcov: path.relative(root, lcovPath),
    threshold: min,
    eligible,
    covered,
    percent: percent === null ? null : Math.round(percent * 100) / 100,
    files: rows,
  };
  for (const row of rows) {
    console.log(`${row.file}: ${row.covered}/${row.coverable} coverable added lines (${row.added} added)`);
  }
  if (percent === null) console.log("No coverable added TypeScript lines; diff coverage is not applicable.");
  else console.log(`Diff coverage: ${percent.toFixed(2)}% (${covered}/${eligible}), threshold ${min}%`);
  if (arg("json", "")) fs.writeFileSync(path.resolve(root, arg("json")), `${JSON.stringify(report, null, 2)}\n`);
  const passed = percent === null || percent >= min;
  if (!passed) console.error(`Diff coverage ${percent.toFixed(2)}% is below the ${min}% gate.`);
  process.exit(passed ? 0 : 1);
}
