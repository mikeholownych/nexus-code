import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { MATERIAL_DEPENDENCY_CONFIG_FILES } from "../material_deps.js";
import { isPathWithin } from "../path_within.js";
import { openCandidateDirectory, openCandidatePathParent, resolveFileCandidateDetails } from "./candidate.js";
import type { OperationVerificationCheck } from "./operation_verification.js";

const DEPENDENCY_DIRECTORIES = ["node_modules", ".venv", "venv", "vendor"];
const MAX_ROOTS = 2_048;
const MAX_ENTRIES = 40_000;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_DEPTH = 64;
const PRIVATE_COMPONENTS = new Set([".git", ".nexus"]);

export function verificationWorkingDirectory(worktree: string, cwd: string): string | undefined {
  if (cwd === ".") return worktree;
  const intended = path.resolve(worktree, cwd);
  try {
    const physicalRoot = fs.realpathSync(worktree);
    return fs.realpathSync(intended) === path.resolve(physicalRoot, cwd) && fs.statSync(intended).isDirectory()
      ? intended : undefined;
  } catch {
    return undefined;
  }
}

function materialRoots(worktree: string, checks: readonly OperationVerificationCheck[]): string[] {
  const roots = new Set<string>();
  for (const check of checks) {
    for (const input of check.materialInputs ?? []) roots.add(input);
    for (let cwd = verificationWorkingDirectory(worktree, check.cwd) ? check.cwd : "."; ; cwd = path.posix.dirname(cwd)) {
      for (const name of [...DEPENDENCY_DIRECTORIES, ...MATERIAL_DEPENDENCY_CONFIG_FILES]) {
        roots.add(cwd === "." ? name : path.posix.join(cwd, name));
      }
      if (cwd === ".") break;
    }
  }
  if (roots.size > MAX_ROOTS) throw new Error("verification material inputs exceed the root limit");
  return [...roots].sort().filter((root) =>
    !root.split("/").slice(0, -1).some((_component, index, components) => roots.has(components.slice(0, index + 1).join("/"))));
}

function sameEntry(before: fs.BigIntStats, after: fs.BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Bind explicit and conventional check inputs even when Git ignores them. Raw contents stay in the worktree. */
export function verificationMaterialDigest(worktree: string, checks: readonly OperationVerificationCheck[]): string {
  const roots = materialRoots(worktree, checks);
  const physicalRoot = fs.realpathSync(worktree);
  const targets = roots.map((root) => path.resolve(physicalRoot, root));
  const rows: Array<[string, ...Array<string | number>]> = [];
  let entries = 0;
  let bytes = 0;

  function walk(relative: string, anchoredPath: string, before: fs.BigIntStats, parentFd: number, name: string, depth: number): void {
    if (++entries > MAX_ENTRIES || depth > MAX_DEPTH) throw new Error("verification material inputs exceed traversal limits");
    if (before.isDirectory()) {
      const opened = openCandidateDirectory(anchoredPath, parentFd, name);
      try {
        const openedStat = fs.fstatSync(opened.fd, { bigint: true });
        if (!sameEntry(before, openedStat)) throw new Error("a verification material directory changed while opening");
        rows.push([relative, "directory", Number(openedStat.mode & 0o777n)]);
        for (let item = opened.dir.readSync(); item !== null; item = opened.dir.readSync()) {
          if (PRIVATE_COMPONENTS.has(item.name)) throw new Error("verification material cannot include private repository state");
          const childPath = `/proc/self/fd/${opened.fd}/${item.name}`;
          walk(`${relative}/${item.name}`, childPath, fs.lstatSync(childPath, { bigint: true }), opened.fd, item.name, depth + 1);
        }
        if (!sameEntry(openedStat, fs.fstatSync(opened.fd, { bigint: true }))
          || !sameEntry(openedStat, fs.lstatSync(anchoredPath, { bigint: true }))) {
          throw new Error("a verification material directory changed during capture");
        }
      } finally {
        opened.dir.closeSync();
        fs.closeSync(opened.fd);
      }
      return;
    }

    const file = resolveFileCandidateDetails(anchoredPath, fs, MAX_BYTES - bytes);
    if (file.isDeleted) throw new Error("a verification material input disappeared during capture");
    let resolved: string | undefined;
    if (file.isSymlink) {
      const destination = fs.realpathSync(anchoredPath);
      if (!targets.some((target) => isPathWithin(destination, target))) {
        throw new Error("a verification material link points outside the bound input scope");
      }
      resolved = path.relative(physicalRoot, destination);
    }
    const after = fs.lstatSync(anchoredPath, { bigint: true });
    if (!sameEntry(before, after) || before.size !== after.size) {
      throw new Error("a verification material entry changed during capture");
    }
    bytes += file.size;
    rows.push([relative, file.mode, file.contentHash, file.size, ...(resolved ? [resolved] : [])]);
  }

  for (const relative of roots) {
    let located: ReturnType<typeof openCandidatePathParent>;
    try {
      located = openCandidatePathParent(worktree, relative);
    } catch (error) {
      if (!isMissing(error)) throw error;
      rows.push([relative, "absent"]);
      continue;
    }
    try {
      let before: fs.BigIntStats;
      try {
        before = fs.lstatSync(located.fullPath, { bigint: true });
      } catch (error) {
        if (!isMissing(error)) throw error;
        rows.push([relative, "absent"]);
        continue;
      }
      walk(relative, located.fullPath, before, located.parent.fd, located.name, 0);
    } finally {
      located.parent.dir.closeSync();
      fs.closeSync(located.parent.fd);
    }
  }
  rows.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(["operation-material-inputs-v1", process.version, rows])).digest("hex");
}
