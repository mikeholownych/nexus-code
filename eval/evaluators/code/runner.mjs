import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateSyntaxAst, isSupportedSyntaxPath } from "./syntax_ast.mjs";
import { evaluateBuild } from "./build.mjs";
import { evaluateTypecheckClean } from "./typecheck_clean.mjs";
import { evaluateDiffBoundary } from "./diff_boundary.mjs";
import { evaluateJsonRepairRate } from "./json_repair_rate.mjs";
import { evaluatorResult } from "./result.mjs";

const DEFAULT_SNAPSHOT_LIMITS = Object.freeze({ maxDepth: 64, maxEntries: 50_000, maxBytes: 256 * 1024 * 1024, timeoutMs: 5_000 });
function sameEntry(left, right) {
  return left.kind === right.kind && left.mode === right.mode && left.size === right.size &&
    left.digest === right.digest && left.linkTarget === right.linkTarget;
}

function snapshotError(message) {
  throw new Error(`workspace snapshot refused: ${message}`);
}

/** Capture a bounded, no-follow view of a workspace for later changed-path discovery. */
export function captureWorkspaceSnapshot(root, options = {}) {
  const limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...options };
  const now = options.now ?? (() => performance.now());
  // Each rule is a directory name, or { name, sibling, child, quiet }: skipped only where that sibling file exists beside it
  // and that child file exists inside it (Cargo writes CACHEDIR.TAG into every target/ it creates). The skipped directories
  // are listed on the returned map (`skippedDirectories`) so a caller can tell a skipped path from a deleted one.
  const skippedDirectories = [];
  const skipRules = new Map((options.skipDirectories ?? []).map((rule) => (typeof rule === "string" ? { name: rule } : rule)).map((rule) => [rule.name, rule]));
  for (const key of ["maxDepth", "maxEntries", "maxBytes", "timeoutMs"]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw new RangeError(`${key} must be a positive integer`);
  }
  let rootStat;
  try { rootStat = fs.lstatSync(root); }
  catch (error) { snapshotError(`workspace root is unavailable: ${error?.message ?? error}`); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) snapshotError("workspace root must be a real directory");
  const workspace = fs.realpathSync(root);
  const started = now();
  const entries = new Map();
  let entryCount = 0;
  let totalBytes = 0;
  const checkDeadline = () => {
    if (now() - started > limits.timeoutMs) snapshotError("traversal deadline exceeded");
  };
  const checkEntry = (relative, depth) => {
    checkDeadline();
    if (depth > limits.maxDepth) snapshotError(`maximum depth exceeded at ${relative}`);
    entryCount += 1;
    if (entryCount > limits.maxEntries) snapshotError("maximum entry count exceeded");
  };

  const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  const openDirectory = options.openDirectory ?? ((directory) => fs.opendirSync(directory, { bufferSize: 1 }));
  const visit = (directory, relativeDirectory, depth, expectedStat = null) => {
    checkDeadline();
    let descriptor;
    try { descriptor = fs.openSync(directory, directoryFlags); }
    catch (error) { snapshotError(`cannot safely open directory ${relativeDirectory || "."}: ${error?.message ?? error}`); }
    try {
      const openedDirectory = fs.fstatSync(descriptor);
      if (!openedDirectory.isDirectory() || (expectedStat && (openedDirectory.dev !== expectedStat.dev || openedDirectory.ino !== expectedStat.ino))) {
        snapshotError(`directory changed during scan: ${relativeDirectory || "."}`);
      }
      let listing;
      try { listing = openDirectory(`/proc/self/fd/${descriptor}`); }
      catch (error) { snapshotError(`cannot list ${relativeDirectory || "."}: ${error?.message ?? error}`); }
      try {
        while (true) {
          checkDeadline();
          let entry;
          try { entry = listing.readSync(); }
          catch (error) { snapshotError(`cannot list ${relativeDirectory || "."}: ${error?.message ?? error}`); }
          if (entry === null) break;
          const name = typeof entry === "string" ? entry : entry?.name;
          if (typeof name !== "string" || !name) snapshotError(`invalid directory entry in ${relativeDirectory || "."}`);
          if (!relativeDirectory && name === ".git") continue;
          const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
          const absolute = path.join(`/proc/self/fd/${descriptor}`, name);
          checkEntry(relative, depth + 1);
          const skipRule = skipRules.get(name);
          if (skipRule && (!skipRule.sibling || fs.existsSync(path.join(`/proc/self/fd/${descriptor}`, skipRule.sibling))) &&
              (!skipRule.child || fs.existsSync(path.join(absolute, skipRule.child)))) {
            // Counted as one entry; the directory's contents are never listed.
            let skipped;
            try { skipped = fs.lstatSync(absolute); }
            catch (error) { snapshotError(`cannot inspect ${relative}: ${error?.message ?? error}`); }
            if (skipped.isDirectory()) { skippedDirectories.push({ path: relative, quiet: skipRule.quiet === true }); continue; }
          }
          let stat;
          try { stat = fs.lstatSync(absolute); }
          catch (error) { snapshotError(`cannot inspect ${relative}: ${error?.message ?? error}`); }
          if (stat.isDirectory()) {
            visit(absolute, relative, depth + 1, stat);
            continue;
          }
          if (stat.isSymbolicLink()) {
            let linkTarget;
            try { linkTarget = fs.readlinkSync(absolute); }
            catch (error) { snapshotError(`cannot read symlink ${relative}: ${error?.message ?? error}`); }
            const after = fs.lstatSync(absolute);
            if (!after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino) snapshotError(`symlink changed during scan: ${relative}`);
            entries.set(relative, { kind: "symlink", mode: stat.mode & 0o777, size: Buffer.byteLength(linkTarget), linkTarget });
            continue;
          }
          if (!stat.isFile()) snapshotError(`special file is not allowed: ${relative}`);
          totalBytes += stat.size;
          if (totalBytes > limits.maxBytes) snapshotError("maximum file byte count exceeded");
          let fileDescriptor;
          try { fileDescriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
          catch (error) { snapshotError(`cannot safely open ${relative}: ${error?.message ?? error}`); }
          try {
            const opened = fs.fstatSync(fileDescriptor);
            if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
              snapshotError(`file changed during scan: ${relative}`);
            }
            const bytes = fs.readFileSync(fileDescriptor);
            const after = fs.fstatSync(fileDescriptor);
            if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
              snapshotError(`file changed during scan: ${relative}`);
            }
            entries.set(relative, {
              kind: "file",
              mode: stat.mode & 0o777,
              size: stat.size,
              digest: createHash("sha256").update(bytes).digest("hex"),
            });
          } finally {
            fs.closeSync(fileDescriptor);
          }
          checkDeadline();
        }
      } finally {
        listing.closeSync();
      }
    } finally {
      fs.closeSync(descriptor);
    }
  };

  visit(workspace, "", 0, rootStat);
  checkDeadline();
  if (!entries.size) snapshotError("workspace contains no regular files or symlinks");
  entries.skippedDirectories = skippedDirectories;
  return entries;
}

function changedWorkspacePaths(baseline, candidate) {
  if (!(baseline instanceof Map) || baseline.size === 0) throw new Error("baseline snapshot is missing or empty");
  const current = captureWorkspaceSnapshot(candidate);
  const paths = new Set([...baseline.keys(), ...current.keys()]);
  const changed = [...paths].filter((relative) => {
    const before = baseline.get(relative);
    const after = current.get(relative);
    return !before || !after || !sameEntry(before, after);
  }).sort();
  if (!changed.length) throw new Error("no changed paths were discovered");
  return changed;
}

/**
 * Pinning policy, one rule: a file the build or a checker obeys keeps its pre-agent content and an edit to it is reported in
 * `ignoredCandidateChanges`. Two kinds of path are pinned, and nothing else is:
 *  - files whose name is unambiguous at any depth (package manifests, lockfiles, `tsconfig*.json`, `Cargo.toml`, `go.mod`,
 *    `build.rs`, `setup.py`, `conftest.py`, `Makefile`, ...);
 *  - tool configuration and build scripts at the project root, or at a package root one level under `packages/`, `apps/`,
 *    `libs/`, `crates/`, `modules/` or `services/` (`.babelrc*`, `.eslintrc*`, `.mocharc.*`, `<tool>.config.*` for a named list
 *    of tools, `build.*s`, `gulpfile.*`, `scripts/build.*s`, `tools/*.js`, ...).
 * Everything else is carried if it is a source or data type and reported if it is not, so ordinary source such as
 * `src/config/database.config.ts` or `src/build.ts` reaches the build.
 */
const PACKAGE_ROOT = String.raw`(?:(?:packages|apps|libs|crates|modules|services)\/[^/]+\/)?`;
const pinnedAnyDepth = new RegExp(String.raw`(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|tsconfig(?:\.[^/]+)?\.json|(?:pyright|js)config\.json|build\.rs|setup\.py|setup\.cfg|pyproject\.toml|conftest\.py|noxfile\.py|tox\.ini|pytest\.ini|Makefile|GNUmakefile|CMakeLists\.txt|go\.mod|go\.sum|go\.work|Cargo\.toml|Cargo\.lock|rust-toolchain(?:\.toml)?|\.cargo\/config(?:\.toml)?|\.npmrc|\.yarnrc(?:\.yml)?)$`, "i");
const pinnedAtPackageRoot = new RegExp(String.raw`^${PACKAGE_ROOT}(?:\.babelrc(?:\.[^/]+)?|\.eslintrc(?:\.[^/]+)?|\.mocharc\.[^/]+|eslint\.config\.[^/]+|(?:webpack|vite|vitest|rollup|postcss|babel|jest|next|nuxt|tsup|turbo|metro|tailwind|prettier|astro|playwright|cypress|karma|esbuild|gulp|stylelint|commitlint|svelte)\.config\.[^/]+|\.?ruff\.toml|(?:clippy|rustfmt|deny)\.toml|biome\.jsonc?|deno\.jsonc?|\.swcrc|tslint\.json|\.golangci\.ya?ml|\.rubocop\.yml|angular\.json|project\.json|nx\.json|lerna\.json|(?:build|compile|typecheck|gulpfile|Gruntfile|Jakefile)\.[cm]?[jt]s|scripts\/(?:build|compile|typecheck)\.[cm]?[jt]s|tools\/[^/]+\.[cm]?js)$`, "i");

/**
 * Candidate file types carried into the pinned workspace: source code and data a build reads. Anything else the agent
 * changed (shell scripts, Gradle/Maven/Ruby/Just build files, INI configuration, lockfiles, binaries, symlinks) keeps its
 * baseline content and is reported in `details.ignoredCandidateChanges`, because a build can run or obey it.
 */
const INPUT_EXTENSIONS = new Set([".json", ".css", ".scss", ".less", ".sql", ".proto", ".graphql", ".html", ".svg", ".txt", ".csv", ".yaml", ".yml", ".toml",
  ".go", ".c", ".h", ".cc", ".cpp", ".hpp", ".java", ".kt", ".cs", ".swift"]);

function carriedInputPath(relative) {
  return isSupportedSyntaxPath(relative) || INPUT_EXTENSIONS.has(path.extname(relative).toLowerCase());
}

/**
 * Dependency, cache and build-output directories (at any depth): skipped by the snapshot, so never overlaid. A virtualenv
 * or cache directory is recognised by its marker file and, like `target/`, is reported in `ignoredCandidateChanges` when
 * the baseline and the candidate disagree about skipping it. `node_modules/` and `__pycache__/` are never reported. `target` is skipped only where it is Cargo output: beside a `Cargo.toml` and holding Cargo's `CACHEDIR.TAG`;
 * elsewhere it is an ordinary directory and is carried or reported like any other.
 */
const DEPENDENCY_DIRECTORIES = [
  { name: "node_modules", quiet: true }, { name: "__pycache__", quiet: true },
  { name: ".venv", child: "pyvenv.cfg" }, { name: "venv", child: "pyvenv.cfg" },
  { name: ".mypy_cache", child: "CACHEDIR.TAG" }, { name: ".pytest_cache", child: "CACHEDIR.TAG" },
  { name: "target", sibling: "Cargo.toml", child: "CACHEDIR.TAG" },
];

function pinnedBuildInput(relative) {
  return pinnedAnyDepth.test(relative) || pinnedAtPackageRoot.test(relative);
}

/** Remove one entry without following it. `fs.rmSync` leaves a dangling symlink in place on current Node. */
function removeEntry(target) {
  let stat;
  try { stat = fs.lstatSync(target); }
  catch (error) { if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return; throw error; }
  if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
  else fs.unlinkSync(target);
}

function readVerifiedCandidateFile(root, relative, snapshotEntry) {
  const segments = relative.split("/");
  if (!segments.length || segments.some((part) => !part || part === "." || part === "..")) throw new Error(`unsafe candidate source path: ${relative}`);
  let directory = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(directory).isDirectory()) throw new Error("candidate workspace is not a real directory");
    for (const segment of segments.slice(0, -1)) {
      const child = fs.openSync(`/proc/self/fd/${directory}/${segment}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      fs.closeSync(directory);
      directory = child;
    }
    const filePath = `/proc/self/fd/${directory}/${segments.at(-1)}`;
    const before = fs.lstatSync(filePath);
    if (!before.isFile() || before.isSymbolicLink() || snapshotEntry.kind !== "file" || before.size !== snapshotEntry.size) {
      throw new Error(`candidate source is not a stable regular file: ${relative}`);
    }
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error(`candidate source changed while opening: ${relative}`);
      const bytes = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor);
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
          createHash("sha256").update(bytes).digest("hex") !== snapshotEntry.digest) {
        throw new Error(`candidate source changed while copying: ${relative}`);
      }
      return { bytes, mode: after.mode & 0o777 };
    } finally {
      fs.closeSync(descriptor);
    }
  } finally {
    fs.closeSync(directory);
  }
}

function createPinnedCandidateWorkspace(baselineWorkspace, candidateWorkspace) {
  if (!baselineWorkspace) throw new Error("no pre-agent build configuration workspace is available");
  const snapshotOptions = { skipDirectories: DEPENDENCY_DIRECTORIES };
  const baseline = captureWorkspaceSnapshot(baselineWorkspace, snapshotOptions);
  const candidate = captureWorkspaceSnapshot(candidateWorkspace, snapshotOptions);
  const ignored = [];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-evaluator-pinned-config-"));
  const pinnedWorkspace = path.join(tempRoot, "workspace");
  try {
    fs.cpSync(baselineWorkspace, pinnedWorkspace, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    // One skip decision for both trees: a path under a directory either snapshot skipped is neither overlaid nor deleted.
    const skipped = new Map();
    for (const side of [baseline, candidate]) for (const item of side.skippedDirectories) skipped.set(item.path, (skipped.get(item.path) ?? 0) + 1);
    const quiet = new Set([...baseline.skippedDirectories, ...candidate.skippedDirectories].filter((item) => item.quiet).map((item) => item.path));
    for (const [directory, sides] of skipped) if (sides === 1 && !quiet.has(directory)) ignored.push(`${directory}/`);
    const underSkipped = (relative) => { for (const directory of skipped.keys()) if (relative.startsWith(`${directory}/`)) return true; return false; };
    const paths = new Set([...baseline.keys(), ...candidate.keys()]);
    for (const relative of paths) {
      if (underSkipped(relative)) continue;
      const before = baseline.get(relative);
      const after = candidate.get(relative);
      if (before && after && sameEntry(before, after)) continue;
      if (pinnedBuildInput(relative) || !carriedInputPath(relative)) { ignored.push(relative); continue; }
      const target = path.join(pinnedWorkspace, ...relative.split("/"));
      if (!after) {
        removeEntry(target);
        continue;
      }
      if (after.kind !== "file") { ignored.push(relative); continue; }
      const { bytes, mode } = readVerifiedCandidateFile(candidateWorkspace, relative, after);
      const targetParent = path.dirname(target);
      const parents = [];
      let current = targetParent;
      while (current !== pinnedWorkspace && current.startsWith(`${pinnedWorkspace}${path.sep}`)) {
        parents.push(current);
        current = path.dirname(current);
      }
      for (const directory of parents.reverse()) {
        try {
          const stat = fs.lstatSync(directory);
          if (stat.isSymbolicLink() || !stat.isDirectory()) {
            removeEntry(directory);
            fs.mkdirSync(directory, { recursive: false });
          }
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          fs.mkdirSync(directory, { recursive: true });
        }
      }
      // The copied baseline can contain a symlink at this path. Remove the
      // entry itself, then create exclusively so a final-component symlink
      // can never redirect candidate bytes outside the pinned workspace.
      removeEntry(target);
      const descriptor = fs.openSync(
        target,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
        mode,
      );
      try {
        fs.writeFileSync(descriptor, bytes);
        fs.fchmodSync(descriptor, mode);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    return { tempRoot, workspace: pinnedWorkspace, ignored: ignored.sort() };
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

export function needsEvaluatorConfigurationBaseline(task) {
  return Array.isArray(task?.evaluators) && task.evaluators.some((entry) => {
    const type = typeof entry === "string" ? entry : entry?.type;
    return type === "build" || type === "typecheck_clean";
  });
}

/** Run the deterministic evaluator set against the actual candidate workspace and pre-agent snapshot. */
export async function runCodeEvaluators({ task, candidateWorkspace, hiddenWorkspace, typecheckBaselineWorkspace, agent, baselineSnapshot }) {
  if (!task.evaluators || !Array.isArray(task.evaluators) || task.evaluators.length === 0) return [];
  const results = [];
  let changedFiles = null;
  let changedFilesError = null;
  if (task.evaluators.some((entry) => ["syntax_ast", "diff_boundary"].includes(typeof entry === "string" ? entry : entry?.type))) {
    try { changedFiles = changedWorkspacePaths(baselineSnapshot, candidateWorkspace); }
    catch (error) { changedFilesError = String(error?.message ?? error); }
  }
  let pinnedWorkspace = null;
  let pinnedWorkspaceRoot = null;
  let pinnedWorkspaceError = null;
  let pinnedIgnored = [];
  // Candidate edits to pinned build configuration are not applied; say so in the result rather than dropping them.
  const withIgnored = (result) => ({ ...result, details: { ...result.details, ignoredCandidateChanges: pinnedIgnored } });
  if (needsEvaluatorConfigurationBaseline(task)) {
    try {
      const pinned = createPinnedCandidateWorkspace(typecheckBaselineWorkspace, candidateWorkspace);
      pinnedWorkspace = pinned.workspace;
      pinnedWorkspaceRoot = pinned.tempRoot;
      pinnedIgnored = pinned.ignored;
    } catch (error) {
      pinnedWorkspaceError = String(error?.message ?? error);
    }
  }
  try {
    for (const item of task.evaluators) {
      const spec = typeof item === "string" ? { type: item } : item;
      if (!spec || typeof spec.type !== "string") continue;
      switch (spec.type) {
        case "syntax_ast": {
          if (changedFilesError) {
            results.push(evaluatorResult("syntax_ast", false, 0, { error: changedFilesError, files: [] }));
          } else {
            const files = spec.files ?? changedFiles.filter((relative) => {
              if (!isSupportedSyntaxPath(relative)) return false;
              try { fs.lstatSync(path.join(candidateWorkspace, ...relative.split("/"))); return true; }
              catch (error) { return error?.code !== "ENOENT"; }
            });
            if (spec.files === undefined && files.length === 0) {
              results.push(evaluatorResult("syntax_ast", true, 1, { files: [], failures: [] }));
            } else {
              results.push(await evaluateSyntaxAst({ root: candidateWorkspace, files, parsers: spec.parsers }));
            }
          }
          break;
        }
        case "diff_boundary": {
          if (changedFilesError) {
            results.push(evaluatorResult("diff_boundary", false, 0, { error: changedFilesError, accepted: [], violations: [] }));
          } else {
            const allowedPaths = spec.allowedPaths ?? task.allowedPaths ?? [];
            results.push(evaluateDiffBoundary({ changedFiles, allowedPaths }));
          }
          break;
        }
        case "json_repair_rate": {
          results.push(evaluateJsonRepairRate(agent?.json?.turn?.toolCallSyntax));
          break;
        }
        case "build": {
          const command = spec.command ?? task.build?.command;
          const args = spec.args ?? task.build?.args ?? [];
          const timeoutMs = spec.timeoutMs ?? task.build?.timeoutMs;
          if (!command) results.push(evaluatorResult("build", false, 0, { error: "no build command specified" }));
          else if (!pinnedWorkspace) results.push(evaluatorResult("build", false, 0, { error: pinnedWorkspaceError ?? "no pre-agent build configuration workspace is available" }));
          else results.push(withIgnored(await evaluateBuild({ command, args, cwd: pinnedWorkspace, timeoutMs })));
          break;
        }
        case "typecheck_clean": {
          const explicitBaseline = spec.baseline ?? task.typecheck?.baseline;
          const baseSpec = explicitBaseline ?? (typecheckBaselineWorkspace ? {
            command: spec.command ?? task.typecheck?.command,
            args: spec.args ?? task.typecheck?.args ?? [],
            cwd: typecheckBaselineWorkspace,
          } : null);
          const candidateSpec = spec.candidate ?? task.typecheck?.candidate ?? { command: spec.command ?? task.typecheck?.command, args: spec.args ?? task.typecheck?.args ?? [], cwd: candidateWorkspace };
          const candSpec = { ...candidateSpec, cwd: pinnedWorkspace ?? candidateWorkspace };
          if (!baseSpec?.command || !candSpec?.command) results.push(evaluatorResult("typecheck_clean", false, 0, { error: explicitBaseline ? "no typecheck command specified" : "no pre-agent typecheck baseline workspace" }));
          else if (!pinnedWorkspace) results.push(evaluatorResult("typecheck_clean", false, 0, { error: pinnedWorkspaceError ?? "no pre-agent build configuration workspace is available" }));
          else results.push(withIgnored(await evaluateTypecheckClean({ baseline: baseSpec, candidate: candSpec })));
          break;
        }
        default:
          results.push(evaluatorResult(spec.type, false, 0, { error: `unknown evaluator type: ${spec.type}` }));
          break;
      }
    }
  } finally {
    if (pinnedWorkspaceRoot) fs.rmSync(pinnedWorkspaceRoot, { recursive: true, force: true });
  }
  return results;
}
