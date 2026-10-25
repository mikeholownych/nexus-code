/**
 * Candidate Identity, Validation Authority & Receipt Management
 * Nexus Issue #12 — WP-04 (INC-05, DEC-02, CAND-001..004, EVID-002, VER-001..005)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { CandidateMutationEvent, CandidateMutationHook } from "./spine.js";

export type CandidateFileStatus = "modified" | "added" | "deleted" | "untracked" | "typechange";

export interface FileCandidateEntry {
  path: string; // Relative POSIX path
  mode: string; // "100644" | "100755" | "120000" | "000000"
  contentHash: string; // SHA-256 hex
  size: number;
  status: CandidateFileStatus;
}

export interface MaterialValidationDependency {
  name: string;
  path?: string; // Relative or absolute path to config/lockfile/toolchain
  versionOrHash: string; // SHA-256 content hash or explicit version string
}

export interface EvaluatorBinding {
  evaluatorId: string;
  evaluatorType: string;
  evaluatorVersion?: string;
  testSuite?: string;
  instanceId?: string;
  metadata?: Record<string, any>;
}

export interface CandidateIdentity {
  candidateId: string; // SHA-256 composite digest of rootBaseSha + canonical manifest
  workspacePath: string;
  rootBaseSha: string;
  trackedChanges: FileCandidateEntry[];
  untrackedFiles: FileCandidateEntry[];
  manifestHash: string;
  isGit: boolean;
  timestamp: string;
}

export interface ValidationReceipt {
  receiptId: string;
  candidateId: string; // Bound to exact candidateId
  verifierCommand: string;
  exitCode: number;
  stdoutHash: string;
  timestamp: string;
  status: "PASSED" | "FAILED" | "INVALIDATED";
  evaluatorBinding?: EvaluatorBinding;
  materialDependencies: MaterialValidationDependency[];
  invalidationReason?: string;
  invalidatedAt?: string;
  evidence?: Record<string, any>;
}

export interface CandidateComputeOptions {
  baseRef?: string;
  includeUntracked?: boolean;
  ignoredPatterns?: string[];
  materialDependencies?: MaterialValidationDependency[];
  /** Optional stricter manifest bound; values above the hard limit are clamped. */
  maxEntries?: number;
  /** Optional stricter byte bound; values above the hard limit are clamped. */
  maxTotalBytes?: number;
}

const MAX_CANDIDATE_ENTRIES = 100_000;
const MAX_CANDIDATE_FILE_BYTES = 256 * 1024 * 1024;
const MAX_CANDIDATE_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_CANDIDATE_DIRECTORY_DEPTH = 128;

function configuredEntryLimit(options: CandidateComputeOptions): number {
  const configured = options.maxEntries;
  if (configured === undefined) return MAX_CANDIDATE_ENTRIES;
  if (!Number.isSafeInteger(configured) || configured < 1) {
    throw new Error("Candidate maxEntries must be a positive safe integer");
  }
  return Math.min(configured, MAX_CANDIDATE_ENTRIES);
}

function configuredByteLimit(options: CandidateComputeOptions): number {
  const configured = options.maxTotalBytes;
  if (configured === undefined) return MAX_CANDIDATE_TOTAL_BYTES;
  if (!Number.isSafeInteger(configured) || configured < 1) {
    throw new Error("Candidate maxTotalBytes must be a positive safe integer");
  }
  return Math.min(configured, MAX_CANDIDATE_TOTAL_BYTES);
}

function procFdPath(fd: number, childName?: string, filesystem: typeof fs = fs): string {
  if (process.platform !== "linux" || !filesystem.existsSync("/proc/self/fd")) {
    throw new Error("Platform cannot enforce descriptor-relative candidate traversal");
  }
  return childName === undefined ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${childName}`;
}

export function openCandidateDirectory(
  fullPath: string,
  parentFd?: number,
  childName?: string,
  filesystem: typeof fs = fs,
): { fd: number; dir: fs.Dir } {
  const directoryFlag = filesystem.constants.O_DIRECTORY;
  const noFollow = filesystem.constants.O_NOFOLLOW;
  const nonBlocking = filesystem.constants.O_NONBLOCK;
  if (typeof directoryFlag !== "number" || typeof noFollow !== "number" || typeof nonBlocking !== "number") {
    throw new Error("Platform cannot enforce no-follow candidate directory traversal");
  }
  if (parentFd !== undefined && childName === undefined) {
    throw new Error("Descriptor-relative candidate directory requires a child name");
  }
  const target = parentFd === undefined ? filesystem.realpathSync(fullPath) : procFdPath(parentFd, childName, filesystem);
  const before = filesystem.lstatSync(target, { bigint: true });
  if (!before.isDirectory()) throw new Error(`Candidate directory changed or is not a directory: ${fullPath}`);
  const fd = filesystem.openSync(target, filesystem.constants.O_RDONLY | directoryFlag | noFollow | nonBlocking);
  try {
    const opened = filesystem.fstatSync(fd, { bigint: true });
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Candidate directory changed while opening: ${fullPath}`);
    }
    const dir = filesystem.opendirSync(procFdPath(fd, undefined, filesystem), { bufferSize: 32 });
    return { fd, dir };
  } catch (error) {
    filesystem.closeSync(fd);
    throw error;
  }
}

export function openCandidatePathParent(
  workspacePath: string,
  relativePath: string,
  filesystem: typeof fs = fs,
): { parent: { fd: number; dir: fs.Dir }; name: string; fullPath: string } {
  const components = relativePath.split("/").filter(Boolean);
  if (components.length === 0 || components.some((part) => part === "." || part === "..")) {
    throw new Error("Invalid candidate path from workspace root");
  }

  let parent = openCandidateDirectory(workspacePath, undefined, undefined, filesystem);
  try {
    for (let index = 0; index < components.length - 1; index += 1) {
      const component = components[index];
      const next = openCandidateDirectory(
        path.join(workspacePath, ...components.slice(0, index + 1)),
        parent.fd,
        component,
        filesystem,
      );
      parent.dir.closeSync();
      filesystem.closeSync(parent.fd);
      parent = next;
    }
    const name = components[components.length - 1];
    return { parent, name, fullPath: procFdPath(parent.fd, name, filesystem) };
  } catch (error) {
    parent.dir.closeSync();
    filesystem.closeSync(parent.fd);
    throw error;
  }
}

export interface CandidateValidationDecision {
  valid: boolean;
  currentCandidateId?: string;
  receiptCandidateId?: string;
  reason?: string;
}

export interface EntryStructuralDetails {
  mode: string;
  contentHash: string;
  size: number;
  isDeleted: boolean;
  isSymlink: boolean;
}

/**
 * Computes SHA-256 digest of input content.
 */
export function hashContent(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Normalizes a path into a relative POSIX path.
 */
export function toPosixRelativePath(basePath: string, targetPath: string): string {
  const rel = path.isAbsolute(targetPath)
    ? path.relative(basePath, targetPath)
    : targetPath;
  return rel.split(path.sep).join("/");
}

/**
 * Resolves structural attributes for a candidate file or symlink entry on disk.
 * Uses lstatSync to preserve symbolic link identity and readlinkSync to hash link target text.
 */
export function resolveFileCandidateDetails(
  fullPath: string,
  filesystem: typeof fs = fs,
  maxBytes = MAX_CANDIDATE_FILE_BYTES,
): EntryStructuralDetails {
  let entryObserved = false;
  try {
    const lstat = filesystem.lstatSync(fullPath, { bigint: true });
    entryObserved = true;
    if (lstat.isSymbolicLink()) {
      const targetText = filesystem.readlinkSync(fullPath);
      const targetSize = Buffer.byteLength(targetText);
      if (targetSize > Math.min(MAX_CANDIDATE_FILE_BYTES, maxBytes)) {
        throw new Error(`Candidate file exceeds ${Math.min(MAX_CANDIDATE_FILE_BYTES, maxBytes)} byte limit: ${fullPath}`);
      }
      const afterReadlink = filesystem.lstatSync(fullPath, { bigint: true });
      if (lstat.dev !== afterReadlink.dev || lstat.ino !== afterReadlink.ino) {
        throw new Error(`Candidate symlink changed while resolving identity: ${fullPath}`);
      }
      return {
        mode: "120000",
        contentHash: hashContent(targetText),
        size: targetSize,
        isDeleted: false,
        isSymlink: true,
      };
    }
    if (lstat.isFile()) {
      const fileByteLimit = Math.min(MAX_CANDIDATE_FILE_BYTES, maxBytes);
      if (lstat.size > BigInt(fileByteLimit)) {
        throw new Error(`Candidate file exceeds ${fileByteLimit} byte limit: ${fullPath}`);
      }
      const noFollow = filesystem.constants.O_NOFOLLOW;
      const nonBlocking = filesystem.constants.O_NONBLOCK;
      if (typeof noFollow !== "number" || typeof nonBlocking !== "number") {
        throw new Error(`Platform cannot enforce no-follow candidate file reads: ${fullPath}`);
      }
      const descriptor = filesystem.openSync(fullPath, filesystem.constants.O_RDONLY | noFollow | nonBlocking);
      try {
        const opened = filesystem.fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || opened.dev !== lstat.dev || opened.ino !== lstat.ino) {
          throw new Error(`Candidate file changed or is not regular while resolving identity: ${fullPath}`);
        }
        if (opened.size > BigInt(fileByteLimit)) {
          throw new Error(`Candidate file exceeds ${fileByteLimit} byte limit: ${fullPath}`);
        }

        const hash = crypto.createHash("sha256");
        const chunk = Buffer.allocUnsafe(64 * 1024);
        let size = 0;
        while (true) {
          const bytesRead = filesystem.readSync(descriptor, chunk, 0, chunk.length, null);
          if (bytesRead === 0) break;
          size += bytesRead;
          if (size > fileByteLimit) {
            throw new Error(`Candidate file exceeds ${fileByteLimit} byte limit: ${fullPath}`);
          }
          hash.update(chunk.subarray(0, bytesRead));
        }

        const afterRead = filesystem.fstatSync(descriptor, { bigint: true });
        if (
          afterRead.dev !== opened.dev ||
          afterRead.ino !== opened.ino ||
          afterRead.size !== opened.size ||
          afterRead.mtimeNs !== opened.mtimeNs ||
          afterRead.ctimeNs !== opened.ctimeNs ||
          BigInt(size) !== opened.size
        ) {
          throw new Error(`Candidate file changed while resolving identity: ${fullPath}`);
        }
        const currentPath = filesystem.lstatSync(fullPath, { bigint: true });
        if (!currentPath.isFile() || currentPath.dev !== opened.dev || currentPath.ino !== opened.ino) {
          throw new Error(`Candidate file path changed while resolving identity: ${fullPath}`);
        }
        return {
          mode: (opened.mode & 0o111n) !== 0n ? "100755" : "100644",
          contentHash: hash.digest("hex"),
          size,
          isDeleted: false,
          isSymlink: false,
        };
      } finally {
        filesystem.closeSync(descriptor);
      }
    }
    throw new Error(`Unsupported filesystem object type for candidate entry at: ${fullPath}`);
  } catch (err: any) {
    if (err.code === "ENOENT" && !entryObserved) {
      return {
        mode: "000000",
        contentHash: "0000000000000000000000000000000000000000000000000000000000000000",
        size: 0,
        isDeleted: true,
        isSymlink: false,
      };
    }
    throw err;
  }
}

function resolveWorkspaceFileDetails(
  workspacePath: string,
  relativePath: string,
  maxBytes: number,
  filesystem: typeof fs = fs,
): EntryStructuralDetails {
  const located = openCandidatePathParent(workspacePath, relativePath, filesystem);
  try {
    return resolveFileCandidateDetails(located.fullPath, filesystem, maxBytes);
  } finally {
    located.parent.dir.closeSync();
    filesystem.closeSync(located.parent.fd);
  }
}

/**
 * Computes deterministic digest over an array of material dependencies.
 */
export function computeMaterialDependenciesHash(
  deps: MaterialValidationDependency[]
): string {
  if (!deps || deps.length === 0) return hashContent("NO_DEPENDENCIES");
  const sorted = [...deps].sort((a, b) => {
    const nameCmp = a.name.localeCompare(b.name);
    if (nameCmp !== 0) return nameCmp;
    return (a.path || "").localeCompare(b.path || "");
  });
  const canonical = sorted
    .map((d) => `${d.name}\t${d.path || ""}\t${d.versionOrHash}`)
    .join("\n");
  return hashContent(canonical);
}

/**
 * Computes candidate identity for a workspace directory (git or non-git fallback).
 */
export function computeCandidateIdentitySync(
  workspacePath: string,
  options: CandidateComputeOptions = {}
): CandidateIdentity {
  return computeCandidateIdentitySyncForTesting(workspacePath, options, fs);
}

/** Test seam for deterministic filesystem race fixtures; production callers use computeCandidateIdentitySync. */
export function computeCandidateIdentitySyncForTesting(
  workspacePath: string,
  options: CandidateComputeOptions,
  filesystem: typeof fs,
): CandidateIdentity {
  const resolvedWorkspace = path.resolve(workspacePath);
  if (!filesystem.existsSync(resolvedWorkspace)) {
    throw new Error(`Workspace path does not exist: ${resolvedWorkspace}`);
  }

  const stat = filesystem.statSync(resolvedWorkspace);
  if (!stat.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${resolvedWorkspace}`);
  }

  let isGit = false;
  try {
    const gitCheck = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: resolvedWorkspace,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    isGit = gitCheck === "true";
  } catch {
    isGit = false;
  }

  const includeUntracked = options.includeUntracked !== false;

  if (isGit) {
    return computeGitCandidateIdentity(resolvedWorkspace, options, includeUntracked, filesystem);
  } else {
    return computeNonGitCandidateIdentity(resolvedWorkspace, options, filesystem);
  }
}

/**
 * Computes candidate identity for a Git-backed workspace or worktree.
 */
function computeGitCandidateIdentity(
  workspacePath: string,
  options: CandidateComputeOptions,
  includeUntracked: boolean,
  filesystem: typeof fs,
): CandidateIdentity {
  const entryLimit = configuredEntryLimit(options);
  const byteLimit = configuredByteLimit(options);
  let rootBaseSha = "UNKNOWN_BASE";
  try {
    rootBaseSha = execFileSync(
      "git",
      ["rev-parse", options.baseRef || "HEAD"],
      {
        cwd: workspacePath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    ).trim();
  } catch {
    rootBaseSha = "EMPTY_GIT_BASE";
  }

  const trackedEntriesMap = new Map<string, FileCandidateEntry>();
  const untrackedEntriesMap = new Map<string, FileCandidateEntry>();
  const untrackedBudget = { entries: 0, bytes: 0 };
  let trackedBytes = 0;

  function assertTrackedEntryAvailable(posixPath: string): void {
    if (!trackedEntriesMap.has(posixPath) && trackedEntriesMap.size + untrackedBudget.entries >= entryLimit) {
      throw new Error(`Candidate manifest exceeds ${entryLimit} entry limit`);
    }
  }

  function setTrackedEntry(entry: FileCandidateEntry): void {
    const previous = trackedEntriesMap.get(entry.path);
    assertTrackedEntryAvailable(entry.path);
    const nextBytes = trackedBytes - (previous?.size || 0) + entry.size;
    if (nextBytes + untrackedBudget.bytes > byteLimit) {
      throw new Error(`Candidate manifest exceeds ${byteLimit} byte limit`);
    }
    trackedEntriesMap.set(entry.path, entry);
    trackedBytes = nextBytes;
  }

  function remainingBytesForTrackedPath(posixPath: string): number {
    const oldSize = trackedEntriesMap.get(posixPath)?.size || 0;
    return byteLimit - (trackedBytes - oldSize) - untrackedBudget.bytes;
  }

  function recordUntrackedEntry(): void {
    untrackedBudget.entries += 1;
    if (untrackedBudget.entries + trackedEntriesMap.size > entryLimit) {
      throw new Error(`Candidate manifest exceeds ${entryLimit} entry limit`);
    }
  }

  function addUntrackedFile(fullPath: string, posixPath: string): void {
    recordUntrackedEntry();
    const details = resolveFileCandidateDetails(fullPath, filesystem, byteLimit - trackedBytes - untrackedBudget.bytes);
    if (details.isDeleted) return;
    untrackedBudget.bytes += details.size;
    if (trackedBytes + untrackedBudget.bytes > byteLimit) {
      throw new Error(`Candidate manifest exceeds ${byteLimit} byte limit`);
    }
    untrackedEntriesMap.set(posixPath, {
      path: posixPath,
      mode: details.mode,
      contentHash: details.contentHash,
      size: details.size,
      status: "untracked",
    });
  }

  function walkUntrackedDirectory(
    directoryPath: string,
    relativePath: string,
    depth: number,
    parentFd?: number,
    childName?: string,
  ): void {
    if (depth > MAX_CANDIDATE_DIRECTORY_DEPTH) {
      throw new Error(`Candidate directory depth exceeds ${MAX_CANDIDATE_DIRECTORY_DEPTH}: ${relativePath}`);
    }
    recordUntrackedEntry();
    const openedDirectory = openCandidateDirectory(directoryPath, parentFd, childName, filesystem);
    const directory = openedDirectory.dir;
    try {
      while (true) {
        const child = directory.readSync();
        if (child === null) break;
        // Nested repository history and metadata are deliberately outside candidate identity.
        if (child.name === ".git") continue;
        const fullPath = procFdPath(openedDirectory.fd, child.name, filesystem);
        const childRelativePath = `${relativePath}/${child.name}`;
        const details = filesystem.lstatSync(fullPath, { bigint: true });
        if (details.isDirectory()) {
          walkUntrackedDirectory(fullPath, childRelativePath, depth + 1, openedDirectory.fd, child.name);
        } else if (details.isFile() || details.isSymbolicLink()) {
          addUntrackedFile(fullPath, childRelativePath);
        } else {
          throw new Error(`Unsupported filesystem object type in candidate directory at: ${childRelativePath}`);
        }
      }
    } finally {
      directory.closeSync();
      filesystem.closeSync(openedDirectory.fd);
    }
  }

  // 1. If baseRef is provided and differs from worktree HEAD, inspect committed differences on branch
  if (options.baseRef && options.baseRef !== "HEAD") {
    let diffOut = "";
    try {
      diffOut = execFileSync(
        "git",
        ["diff", "--name-status", options.baseRef, "HEAD"],
        {
          cwd: workspacePath,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }
      ).trim();

    } catch {
      // Diff command fallback
    }
    if (diffOut.trim().length > 0) {
      const lines = diffOut.trim().split("\n");
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const statusChar = parts[0][0];
        const filePath = parts[parts.length - 1];
        const posixPath = filePath.split(path.sep).join("/");
        // Nexus session, checkpoint, and flight data are runtime state, not candidate input.
        if (posixPath === ".nexus" || posixPath.startsWith(".nexus/")) continue;
        assertTrackedEntryAvailable(posixPath);

        if (statusChar === "D") {
          setTrackedEntry({
            path: posixPath,
            mode: "000000",
            contentHash: "0000000000000000000000000000000000000000000000000000000000000000",
            size: 0,
            status: "deleted",
          });
        } else {
          const details = resolveWorkspaceFileDetails(workspacePath, filePath, remainingBytesForTrackedPath(posixPath), filesystem);
          if (details.isDeleted) {
            setTrackedEntry({
              path: posixPath,
              mode: "000000",
              contentHash: details.contentHash,
              size: 0,
              status: "deleted",
            });
          } else {
            let status: CandidateFileStatus = "modified";
            if (statusChar === "T" || details.isSymlink) status = "typechange";
            else if (statusChar === "A") status = "added";
            setTrackedEntry({
              path: posixPath,
              mode: details.mode,
              contentHash: details.contentHash,
              size: details.size,
              status,
            });
          }
        }
      }
    }
  }

  // 2. Query git status for working tree modifications, type changes, and untracked files
  try {
    const statusOut = execFileSync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      {
        cwd: workspacePath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );

    if (statusOut.length > 0) {
      const lines = statusOut.split(/\r?\n/);
      for (const line of lines) {
        if (!line || line.length < 3) continue;
        const match = line.match(/^([ MADRCUT?!]{2})\s+(.*)$/);
        if (!match) continue;
        const code = match[1];
        let rawFile = match[2].trim();

        // Handle rename syntax: "R  orig -> new"
        if (rawFile.includes(" -> ")) {
          const parts = rawFile.split(" -> ");
          rawFile = parts[1];
        }

        // Strip quotes if present
        if (rawFile.startsWith('"') && rawFile.endsWith('"')) {
          rawFile = rawFile.slice(1, -1);
        }

        const posixPath = rawFile.split(path.sep).join("/").replace(/\/+$/, "");
        // Match the non-Git identity path: managed Nexus state must not count as workspace progress.
        if (posixPath === ".nexus" || posixPath.startsWith(".nexus/")) continue;

        if (code === "??") {
          if (includeUntracked) {
            const located = openCandidatePathParent(workspacePath, rawFile, filesystem);
            try {
              const details = filesystem.lstatSync(located.fullPath, { bigint: true });
              if (details.isDirectory()) {
                walkUntrackedDirectory(located.fullPath, posixPath, 1, located.parent.fd, located.name);
              } else if (details.isFile() || details.isSymbolicLink()) {
                addUntrackedFile(located.fullPath, posixPath);
              } else {
                throw new Error(`Unsupported filesystem object type in untracked candidate path: ${posixPath}`);
              }
            } finally {
              located.parent.dir.closeSync();
              filesystem.closeSync(located.parent.fd);
            }
          }
        } else {
          assertTrackedEntryAvailable(posixPath);
          // Tracked modification (staged or unstaged or typechange or deletion)
          if (code.includes("D")) {
            setTrackedEntry({
              path: posixPath,
              mode: "000000",
              contentHash: "0000000000000000000000000000000000000000000000000000000000000000",
              size: 0,
              status: "deleted",
            });
          } else {
            const details = resolveWorkspaceFileDetails(workspacePath, rawFile, remainingBytesForTrackedPath(posixPath), filesystem);
            if (details.isDeleted) {
              setTrackedEntry({
                path: posixPath,
                mode: "000000",
                contentHash: details.contentHash,
                size: 0,
                status: "deleted",
              });
            } else {
              let status: CandidateFileStatus = "modified";
              if (code.includes("T")) {
                status = "typechange";
              } else if (code.includes("A")) {
                status = "added";
              }
              setTrackedEntry({
                path: posixPath,
                mode: details.mode,
                contentHash: details.contentHash,
                size: details.size,
                status,
              });
            }
          }
        }
      }
    }
  } catch (err: any) {
    throw new Error(`Failed to query git status for candidate identity: ${err.message}`);
  }

  // Canonicalize entries in sorted order
  const trackedChanges = Array.from(trackedEntriesMap.values()).sort((a, b) =>
    a.path.localeCompare(b.path)
  );
  const untrackedFiles = Array.from(untrackedEntriesMap.values()).sort((a, b) =>
    a.path.localeCompare(b.path)
  );
  const manifestEntries = [...trackedChanges, ...untrackedFiles];
  if (manifestEntries.length > entryLimit) {
    throw new Error(`Candidate manifest exceeds ${entryLimit} entry limit`);
  }
  const totalManifestBytes = manifestEntries.reduce((total, entry) => total + entry.size, 0);
  if (totalManifestBytes > byteLimit) {
    throw new Error(`Candidate manifest exceeds ${byteLimit} byte limit`);
  }

  const manifestLines: string[] = [];
  for (const entry of trackedChanges) {
    manifestLines.push(`T\t${entry.path}\t${entry.status}\t${entry.mode}\t${entry.contentHash}\t${entry.size}`);
  }
  for (const entry of untrackedFiles) {
    manifestLines.push(`U\t${entry.path}\t${entry.status}\t${entry.mode}\t${entry.contentHash}\t${entry.size}`);
  }

  const manifestContent =
    manifestLines.length > 0 ? manifestLines.join("\n") : "CLEAN_TREE_NO_CANDIDATE_CHANGES";
  const manifestHash = hashContent(manifestContent);
  const candidateId = hashContent(`candidate-v1:git:${rootBaseSha}:${manifestHash}`);

  return {
    candidateId,
    workspacePath,
    rootBaseSha,
    trackedChanges,
    untrackedFiles,
    manifestHash,
    isGit: true,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Computes candidate identity for a non-Git workspace via deterministic filesystem manifest.
 */
function computeNonGitCandidateIdentity(
  workspacePath: string,
  options: CandidateComputeOptions,
  filesystem: typeof fs,
): CandidateIdentity {
  const entryLimit = configuredEntryLimit(options);
  const byteLimit = configuredByteLimit(options);
  const rootBaseSha = "NON_GIT_WORKSPACE";
  const allEntries: FileCandidateEntry[] = [];

  const defaultExcludes = new Set([
    ".git",
    "node_modules",
    ".nexus",
    "target",
    "dist",
    "build",
    ".cache",
  ]);

  if (options.ignoredPatterns && options.ignoredPatterns.length > 0) {
    for (const pat of options.ignoredPatterns) {
      defaultExcludes.add(pat);
    }
  }

  let visitedEntries = 0;
  let totalBytes = 0;
  function walk(
    currentDir: string,
    depth: number,
    relativeDir = "",
    parentFd?: number,
    childName?: string,
  ): void {
    if (depth > MAX_CANDIDATE_DIRECTORY_DEPTH) {
      throw new Error(`Candidate directory depth exceeds ${MAX_CANDIDATE_DIRECTORY_DEPTH}`);
    }
    const openedDirectory = openCandidateDirectory(currentDir, parentFd, childName, filesystem);
    const directory = openedDirectory.dir;
    try {
      while (true) {
        const item = directory.readSync();
        if (item === null) break;
        if (defaultExcludes.has(item.name)) continue;
        visitedEntries += 1;
        if (visitedEntries > entryLimit) {
          throw new Error(`Candidate manifest exceeds ${entryLimit} entry limit`);
        }
        const fullPath = procFdPath(openedDirectory.fd, item.name, filesystem);
        const relativePath = relativeDir ? `${relativeDir}/${item.name}` : item.name;
        if (item.isDirectory()) {
          walk(fullPath, depth + 1, relativePath, openedDirectory.fd, item.name);
        } else if (item.isFile() || item.isSymbolicLink()) {
          const details = resolveFileCandidateDetails(fullPath, filesystem, byteLimit - totalBytes);
          if (!details.isDeleted) {
            totalBytes += details.size;
            if (totalBytes > byteLimit) {
              throw new Error(`Candidate manifest exceeds ${byteLimit} byte limit`);
            }
            allEntries.push({
              path: relativePath,
              mode: details.mode,
              contentHash: details.contentHash,
              size: details.size,
              status: details.isSymlink ? "typechange" : "modified",
            });
          }
        } else {
          throw new Error(`Unsupported filesystem object type in non-git workspace at: ${relativePath}`);
        }
      }
    } finally {
      directory.closeSync();
      filesystem.closeSync(openedDirectory.fd);
    }
  }

  walk(workspacePath, 0);
  allEntries.sort((a, b) => a.path.localeCompare(b.path));

  const manifestLines = allEntries.map(
    (e) => `F\t${e.path}\t${e.status}\t${e.mode}\t${e.contentHash}\t${e.size}`
  );
  const manifestContent =
    manifestLines.length > 0 ? manifestLines.join("\n") : "EMPTY_NON_GIT_WORKSPACE";
  const manifestHash = hashContent(manifestContent);
  const candidateId = hashContent(`candidate-v1:nongit:${manifestHash}`);

  return {
    candidateId,
    workspacePath,
    rootBaseSha,
    trackedChanges: allEntries,
    untrackedFiles: [],
    manifestHash,
    isGit: false,
    timestamp: new Date().toISOString(),
  };
}

/**
 * CandidateTracker manages candidate identities, validation receipts,
 * post-validation mutation invalidation, and merge gating.
 */
export class CandidateTracker {
  private activeReceipts: Map<string, ValidationReceipt> = new Map();
  private latestReceipt?: ValidationReceipt;
  private knownCandidateIdentities: Map<string, CandidateIdentity> = new Map();

  /**
   * Computes the candidate identity synchronously.
   */
  public computeCandidateIdentitySync(
    workspacePath: string,
    options: CandidateComputeOptions = {}
  ): CandidateIdentity {
    const identity = computeCandidateIdentitySync(workspacePath, options);
    this.knownCandidateIdentities.set(identity.candidateId, identity);
    return identity;
  }

  /**
   * Computes the candidate identity asynchronously.
   */
  public async computeCandidateIdentity(
    workspacePath: string,
    options: CandidateComputeOptions = {}
  ): Promise<CandidateIdentity> {
    return this.computeCandidateIdentitySync(workspacePath, options);
  }

  /**
   * Records an authoritative validation receipt.
   */
  public recordValidationReceipt(
    params: Omit<ValidationReceipt, "receiptId" | "timestamp">
  ): ValidationReceipt {
    if (!params.candidateId || typeof params.candidateId !== "string") {
      throw new Error("CAND-001: Validation receipt must carry a non-empty candidateId string.");
    }

    const receipt: ValidationReceipt = {
      receiptId: `rcpt-${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      ...params,
      materialDependencies: params.materialDependencies ? [...params.materialDependencies] : [],
    };

    this.activeReceipts.set(receipt.receiptId, receipt);
    this.latestReceipt = receipt;
    return receipt;
  }

  /**
   * Retrieves the current active receipt for a candidate.
   */
  public getActiveReceipt(candidateId?: string): ValidationReceipt | null {
    if (!this.latestReceipt) return null;
    if (this.latestReceipt.status !== "PASSED") return null;
    if (candidateId && this.latestReceipt.candidateId !== candidateId) return null;
    return this.latestReceipt;
  }

  /**
   * Retrieves a receipt by its unique ID.
   */
  public getReceipt(receiptId: string): ValidationReceipt | null {
    return this.activeReceipts.get(receiptId) || null;
  }

  /**
   * Returns all recorded receipts.
   */
  public getAllReceipts(): ValidationReceipt[] {
    return Array.from(this.activeReceipts.values());
  }

  /**
   * Invalidates active validation receipts.
   * If mutatedPaths is specified, checks whether the mutated paths fall within candidate workspace
   * or touch material validation dependencies per CAND-002.
   */
  public invalidateReceipts(
    reason: string,
    mutatedPaths?: string[],
    workspaceRoot?: string
  ): number {
    let invalidatedCount = 0;
    const now = new Date().toISOString();

    for (const receipt of this.activeReceipts.values()) {
      if (receipt.status === "PASSED") {
        if (mutatedPaths && mutatedPaths.length > 0) {
          const candidateIdentity = this.knownCandidateIdentities.get(receipt.candidateId);
          const effectiveWsRoot = candidateIdentity?.workspacePath || workspaceRoot;

          const candidateDeps = new Set(
            receipt.materialDependencies.map((d) => d.path || d.name)
          );

          let touchesCandidate = false;

          for (const rawPath of mutatedPaths) {
            const norm = rawPath.split(path.sep).join("/");

            // 1. Check material validation dependencies
            if (
              candidateDeps.has(norm) ||
              Array.from(candidateDeps).some((dp) => norm.endsWith(dp) || dp.endsWith(norm))
            ) {
              touchesCandidate = true;
              break;
            }

            // 2. Check candidate workspace containment
            if (effectiveWsRoot) {
              const resolvedWs = path.resolve(effectiveWsRoot);
              const resolvedTarget = path.isAbsolute(rawPath)
                ? path.resolve(rawPath)
                : path.resolve(resolvedWs, rawPath);

              const rel = path.relative(resolvedWs, resolvedTarget);
              const isInside = !rel.startsWith("..") && !path.isAbsolute(rel);
              if (isInside) {
                touchesCandidate = true;
                break;
              }
            } else if (candidateIdentity) {
              // Fallback to known candidate file paths if workspace root is unknown
              const candidatePaths = new Set([
                ...candidateIdentity.trackedChanges.map((t) => t.path),
                ...candidateIdentity.untrackedFiles.map((u) => u.path),
              ]);
              if (
                candidatePaths.has(norm) ||
                Array.from(candidatePaths).some((cp) => norm.endsWith(cp) || cp.endsWith(norm))
              ) {
                touchesCandidate = true;
                break;
              }
            }
          }

          if (!touchesCandidate) {
            // Mutation is demonstrably confined outside candidate workspace and dependencies (CAND-002)
            continue;
          }
        }

        receipt.status = "INVALIDATED";
        receipt.invalidationReason = reason;
        receipt.invalidatedAt = now;
        invalidatedCount++;
      }
    }

    return invalidatedCount;
  }

  /**
   * Creates an ExecutionSpine CandidateMutationHook that invalidates receipts upon file mutation.
   */
  public createMutationHook(): CandidateMutationHook {
    return async (event: CandidateMutationEvent, context?: any) => {
      const paths =
        event.mutatedPaths && event.mutatedPaths.length > 0
          ? event.mutatedPaths.join(", ")
          : "unspecified resources";
      this.invalidateReceipts(
        `Candidate mutated post-validation by tool '${event.toolName}' (mutated: ${paths})`,
        event.mutatedPaths,
        context?.workspaceRoot
      );
    };
  }

  /**
   * Verifies candidate eligibility for worktree merge (CAND-001..CAND-004).
   * Re-evaluates actual state on disk to defeat out-of-band mutations and race conditions.
   */
  public isCandidateValidForMergeSync(
    workspacePath: string,
    receipt: ValidationReceipt,
    options: CandidateComputeOptions = {}
  ): CandidateValidationDecision {
    if (!receipt) {
      return {
        valid: false,
        reason: "CAND-003: No validation receipt provided for candidate merge.",
      };
    }

    if (receipt.status !== "PASSED") {
      return {
        valid: false,
        receiptCandidateId: receipt.candidateId,
        reason: `CAND-003: Validation receipt status is ${receipt.status}: ${receipt.invalidationReason || "receipt is not in PASSED state"}`,
      };
    }

    // Recompute actual current candidate identity from disk (detects out-of-band modifications)
    let currentIdentity: CandidateIdentity;
    try {
      currentIdentity = this.computeCandidateIdentitySync(workspacePath, options);
    } catch (err: any) {
      return {
        valid: false,
        receiptCandidateId: receipt.candidateId,
        reason: `CAND-003: Failed to compute current candidate identity: ${err.message}`,
      };
    }

    // CAND-003: Verify candidate identity equality
    if (currentIdentity.candidateId !== receipt.candidateId) {
      return {
        valid: false,
        currentCandidateId: currentIdentity.candidateId,
        receiptCandidateId: receipt.candidateId,
        reason: `CAND-003: Candidate identity at merge (${currentIdentity.candidateId}) does not match validated candidate (${receipt.candidateId}). Candidate was modified after validation.`,
      };
    }

    // CAND-002: Verify material validation dependencies remain unchanged
    if (receipt.materialDependencies && receipt.materialDependencies.length > 0) {
      for (const dep of receipt.materialDependencies) {
        if (dep.path) {
          const depFullPath = path.isAbsolute(dep.path)
            ? dep.path
            : path.join(workspacePath, dep.path);

          if (!fs.existsSync(depFullPath)) {
            return {
              valid: false,
              currentCandidateId: currentIdentity.candidateId,
              receiptCandidateId: receipt.candidateId,
              reason: `CAND-002: Material validation dependency '${dep.name}' at '${dep.path}' is missing on disk.`,
            };
          }

          const currentHash = hashContent(fs.readFileSync(depFullPath));
          if (currentHash !== dep.versionOrHash) {
            return {
              valid: false,
              currentCandidateId: currentIdentity.candidateId,
              receiptCandidateId: receipt.candidateId,
              reason: `CAND-002: Material validation dependency '${dep.name}' has changed: expected ${dep.versionOrHash}, found ${currentHash}.`,
            };
          }
        }
      }
    }

    return {
      valid: true,
      currentCandidateId: currentIdentity.candidateId,
      receiptCandidateId: receipt.candidateId,
    };
  }

  /**
   * Asynchronous candidate merge eligibility check.
   */
  public async isCandidateValidForMerge(
    workspacePath: string,
    receipt: ValidationReceipt,
    options: CandidateComputeOptions = {}
  ): Promise<CandidateValidationDecision> {
    return this.isCandidateValidForMergeSync(workspacePath, receipt, options);
  }
}
