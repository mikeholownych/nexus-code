import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { evaluateSyntaxAst } from "./syntax_ast.mjs";
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
  for (const item of task.evaluators) {
    const spec = typeof item === "string" ? { type: item } : item;
    if (!spec || typeof spec.type !== "string") continue;
    switch (spec.type) {
      case "syntax_ast": {
        if (changedFilesError) {
          results.push(evaluatorResult("syntax_ast", false, 0, { error: changedFilesError, files: [] }));
        } else {
          const files = spec.files ?? changedFiles;
          results.push(await evaluateSyntaxAst({ root: candidateWorkspace, files, parsers: spec.parsers }));
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
        else results.push(await evaluateBuild({ command, args, cwd: candidateWorkspace, timeoutMs }));
        break;
      }
      case "typecheck_clean": {
        const explicitBaseline = spec.baseline ?? task.typecheck?.baseline;
        const baseSpec = explicitBaseline ?? (typecheckBaselineWorkspace ? {
          command: spec.command ?? task.typecheck?.command,
          args: spec.args ?? task.typecheck?.args ?? [],
          cwd: typecheckBaselineWorkspace,
        } : null);
        const candSpec = spec.candidate ?? task.typecheck?.candidate ?? { command: spec.command ?? task.typecheck?.command, args: spec.args ?? task.typecheck?.args ?? [], cwd: candidateWorkspace };
        if (!baseSpec?.command || !candSpec?.command) results.push(evaluatorResult("typecheck_clean", false, 0, { error: explicitBaseline ? "no typecheck command specified" : "no pre-agent typecheck baseline workspace" }));
        else results.push(await evaluateTypecheckClean({ baseline: baseSpec, candidate: candSpec }));
        break;
      }
      default:
        results.push(evaluatorResult(spec.type, false, 0, { error: `unknown evaluator type: ${spec.type}` }));
        break;
    }
  }
  return results;
}
