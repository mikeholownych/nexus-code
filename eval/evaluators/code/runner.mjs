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
  const skipDirectories = new Set(options.skipDirectories ?? []);
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
          if (skipDirectories.has(name)) {
            // Counted as one entry; the directory's contents are never listed.
            let skipped;
            try { skipped = fs.lstatSync(absolute); }
            catch (error) { snapshotError(`cannot inspect ${relative}: ${error?.message ?? error}`); }
            if (skipped.isDirectory()) continue;
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

const excludedBuildConfiguration = /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|tsconfig(?:\.[^/]+)?\.json|(?:webpack|vite|rollup|postcss|babel|jest|vitest|eslint|next|nuxt|tsup|turbo|metro)\.config\.[^/]+|scripts\/(?:build|compile|typecheck)\.[cm]?[jt]s)$/i;

/**
 * Files the build itself executes or resolves through, rather than inputs it reads: a candidate that edits one could
 * make its own build pass. They keep their pre-agent content, and an edit is reported, not applied.
 */
const pinnedBuildHelpers = /(?:^|\/)(?:build\.rs|setup\.py|setup\.cfg|pyproject\.toml|conftest\.py|noxfile\.py|tox\.ini|pytest\.ini|Makefile|GNUmakefile|CMakeLists\.txt|go\.mod|go\.sum|go\.work|Cargo\.toml|Cargo\.lock|rust-toolchain(?:\.toml)?|\.cargo\/config(?:\.toml)?|\.npmrc|\.yarnrc(?:\.yml)?|\.babelrc|\.mocharc\.[^/]+|tools\/[^/]+\.[cm]?js)$/i;

/** Directories whose contents are dependencies, never candidate work: skipped by the snapshot and never overlaid. */
const DEPENDENCY_DIRECTORIES = ["node_modules"];

function pinnedBuildInput(relative) {
  return excludedBuildConfiguration.test(relative) || pinnedBuildHelpers.test(relative);
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

/** Where an explicit candidate working directory lands in the pinned workspace, or null when it is outside the candidate. */
function pinnedWorkingDirectory(candidateWorkspace, pinnedWorkspace, cwd) {
  if (cwd === undefined || cwd === null) return pinnedWorkspace;
  if (typeof cwd !== "string") return null;
  const real = (value) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
  const relative = path.relative(real(candidateWorkspace), real(path.resolve(candidateWorkspace, cwd)));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return path.join(pinnedWorkspace, relative);
}

/** `options.scratchRoot` places the copy where the run keeps its workspaces (a size-capped tmpfs under the resource contract). */
export function createPinnedCandidateWorkspace(baselineWorkspace, candidateWorkspace, { scratchRoot = os.tmpdir() } = {}) {
  if (!baselineWorkspace) throw new Error("no pre-agent build configuration workspace is available");
  const snapshotOptions = { skipDirectories: DEPENDENCY_DIRECTORIES };
  const baseline = captureWorkspaceSnapshot(baselineWorkspace, snapshotOptions);
  const candidate = captureWorkspaceSnapshot(candidateWorkspace, snapshotOptions);
  const ignored = [];
  const uncarriable = [];
  const tempRoot = fs.mkdtempSync(path.join(scratchRoot, "nexus-evaluator-pinned-config-"));
  const pinnedWorkspace = path.join(tempRoot, "workspace");
  try {
    fs.cpSync(baselineWorkspace, pinnedWorkspace, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    const paths = new Set([...baseline.keys(), ...candidate.keys()]);
    for (const relative of paths) {
      const before = baseline.get(relative);
      const after = candidate.get(relative);
      if (before && after && sameEntry(before, after)) continue;
      if (pinnedBuildInput(relative)) { ignored.push(relative); continue; }
      const target = path.join(pinnedWorkspace, ...relative.split("/"));
      if (!after) {
        removeEntry(target);
        continue;
      }
      if (after.kind !== "file") { uncarriable.push(relative); continue; }
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
    // A candidate symlink cannot be reproduced safely. Dropping it would score a tree the candidate did not produce.
    if (uncarriable.length) throw new Error(`candidate changes that cannot be carried into the build workspace: ${uncarriable.join(", ")}`);
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
export async function runCodeEvaluators({ task, candidateWorkspace, hiddenWorkspace, typecheckBaselineWorkspace, agent, baselineSnapshot, resources = null, scratchRoot }) {
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
      const pinned = createPinnedCandidateWorkspace(typecheckBaselineWorkspace, candidateWorkspace, { scratchRoot });
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
              results.push(await evaluateSyntaxAst({ root: candidateWorkspace, files, parsers: spec.parsers, maxSourceBytes: spec.maxSourceBytes, parserTimeoutMs: spec.parserTimeoutMs }));
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
          else results.push(withIgnored(await evaluateBuild({ command, args, cwd: pinnedWorkspace, timeoutMs, resources, maxFileBytes: spec.maxFileBytes ?? task.build?.maxFileBytes })));
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
          // An explicit candidate working directory (a package inside a monorepo) maps to the same place in the pinned copy.
          const candidateCwd = pinnedWorkspace ? pinnedWorkingDirectory(candidateWorkspace, pinnedWorkspace, spec.candidate?.cwd ?? task.typecheck?.candidate?.cwd) : candidateWorkspace;
          const candSpec = { ...candidateSpec, cwd: candidateCwd };
          if (candidateCwd === null) results.push(evaluatorResult("typecheck_clean", false, 0, { error: "candidate typecheck cwd is outside the candidate workspace" }));
          else if (!baseSpec?.command || !candSpec?.command) results.push(evaluatorResult("typecheck_clean", false, 0, { error: explicitBaseline ? "no typecheck command specified" : "no pre-agent typecheck baseline workspace" }));
          else if (!pinnedWorkspace) results.push(evaluatorResult("typecheck_clean", false, 0, { error: pinnedWorkspaceError ?? "no pre-agent build configuration workspace is available" }));
          else results.push(withIgnored(await evaluateTypecheckClean({ baseline: baseSpec, candidate: candSpec, resources, diagnosticPattern: spec.diagnosticPattern ?? task.typecheck?.diagnosticPattern })));
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
