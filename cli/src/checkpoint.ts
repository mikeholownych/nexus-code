import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { envWithoutConfiguredHooks } from "./core/git_hook_guard.js";
import crypto from "node:crypto";
import {
  assertNoSensitivePersistenceContent,
  redactForPersistence,
  SensitivePersistenceError,
} from "./core/persistence_protection.js";
import { ensurePrivateDir, writePrivateFile } from "./core/durable_file.js";

export interface CheckpointInfo {
  id: string;
  name: string;
  timestamp: string;
  workspace?: string;
  gitRef?: string;
  snapshotDir?: string;
  allowSensitive?: boolean;
  untrackedFiles?: string[];
  files?: Array<{ path: string; content: string }>;
}

class GitIndexLockError extends Error {
  constructor() {
    super("Git index lock exists; check for an active Git operation before deciding whether the lock is stale.");
    this.name = "GitIndexLockError";
  }
}

class GitIndexLockCheckError extends Error {
  constructor() {
    super("Could not inspect the Git index lock; checkpoint creation stopped without changing Git state.");
    this.name = "GitIndexLockCheckError";
  }
}

export class CheckpointManager {
  private workspace: string;
  private checkpointDir: string;
  private isGit: boolean = false;
  private repositoryRootCache: string | undefined;
  private workspacePrefixCache: string | undefined;

  constructor(workspace: string) {
    this.workspace = path.resolve(workspace);
    const hash = crypto.createHash("sha256").update(this.workspace).digest("hex").slice(0, 12);
    this.checkpointDir = path.join(os.homedir(), ".nexus", "checkpoints", hash);
    ensurePrivateDir(this.checkpointDir);
    this.checkGit();
  }

  private checkGit(): void {
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: this.workspace, stdio: "ignore" });
      this.isGit = true;
    } catch {
      this.isGit = false;
    }
  }

  private gitRoot(): string {
    if (!this.repositoryRootCache) {
      this.repositoryRootCache = fs.realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: this.workspace,
        encoding: "utf8",
      }).trim());
    }
    return this.repositoryRootCache;
  }

  private gitWorkspacePrefix(): string {
    if (this.workspacePrefixCache === undefined) {
      const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], {
        cwd: this.workspace,
        encoding: "utf8",
      }).trim();
      this.workspacePrefixCache = prefix.replace(/\\/g, "/");
    }
    return this.workspacePrefixCache;
  }

  private workspaceRelativeGitPath(gitPath: string): string | undefined {
    const prefix = this.gitWorkspacePrefix();
    if (!prefix) return gitPath;
    return gitPath.startsWith(prefix) ? gitPath.slice(prefix.length) : undefined;
  }

  private restoreGitIndex(gitRef: string, hookGuardEnv: NodeJS.ProcessEnv): void {
    const prefix = this.gitWorkspacePrefix();
    const repositoryRoot = this.gitRoot();
    if (!prefix) {
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "read-tree", gitRef], {
        cwd: repositoryRoot,
        stdio: "ignore",
        env: hookGuardEnv,
      });
      return;
    }

    // Build the checkpoint index separately, then replace only entries owned
    // by this workspace in the real index. A whole-tree read-tree would also
    // reset staged changes belonging to sibling workspaces in the repository.
    const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-checkpoint-index-"));
    try {
      const targetIndex = path.join(temporaryDir, "index");
      const targetEnv = { ...hookGuardEnv, GIT_INDEX_FILE: targetIndex };
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "read-tree", gitRef], {
        cwd: repositoryRoot,
        stdio: "ignore",
        env: targetEnv,
      });

      const workspacePathspec = prefix ? [`:(top,literal)${prefix.slice(0, -1)}`] : [];
      const indexPaths = ["-c", "core.fsmonitor=false", "ls-files", "--stage", "-z", "--full-name", ...(workspacePathspec.length ? ["--", ...workspacePathspec] : [])];
      const targetEntries = execFileSync("git", indexPaths, {
        cwd: repositoryRoot,
        env: targetEnv,
        maxBuffer: 64 * 1024 * 1024,
      });
      const currentEntries = execFileSync("git", indexPaths, {
        cwd: repositoryRoot,
        env: hookGuardEnv,
        maxBuffer: 64 * 1024 * 1024,
      });
      const prefixBytes = Buffer.from(prefix);
      const parseEntries = (entries: Buffer): Array<{ metadata: Buffer; filePath: Buffer }> =>
        entries.toString("binary").split("\0").filter(Boolean).map((entry) => {
          const separator = entry.indexOf("\t");
          if (separator < 0) throw new Error("Git returned a malformed index entry");
          return {
            metadata: Buffer.from(entry.slice(0, separator), "binary"),
            filePath: Buffer.from(entry.slice(separator + 1), "binary"),
          };
        });
      const inWorkspace = (filePath: Buffer): boolean => filePath.subarray(0, prefixBytes.length).equals(prefixBytes);
      const target = parseEntries(targetEntries).filter(({ filePath }) => inWorkspace(filePath));
      const current = parseEntries(currentEntries).filter(({ filePath }) => inWorkspace(filePath));
      const indexInfo: Buffer[] = [];

      for (const { metadata, filePath } of current) {
        const [, objectId, stage] = metadata.toString("ascii").split(" ");
        if (!objectId || !stage) throw new Error("Git returned an incomplete index entry");
        indexInfo.push(Buffer.from(`0 ${"0".repeat(objectId.length)} ${stage}\t`, "ascii"), filePath, Buffer.from("\0"));
      }
      for (const { metadata, filePath } of target) {
        indexInfo.push(metadata, Buffer.from("\t"), filePath, Buffer.from("\0"));
      }

      if (indexInfo.length > 0) {
        execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "update-index", "-z", "--index-info"], {
          cwd: repositoryRoot,
          input: Buffer.concat(indexInfo),
          stdio: ["pipe", "ignore", "pipe"],
          env: hookGuardEnv,
        });
      }
    } finally {
      fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
  }

  private gitIndexLockExists(): boolean {
    let lockPath: string;
    try {
      lockPath = execFileSync("git", ["rev-parse", "--git-path", "index.lock"], {
        cwd: this.workspace,
        encoding: "utf-8",
      }).trim();
    } catch {
      throw new GitIndexLockCheckError();
    }
    if (!lockPath) throw new GitIndexLockCheckError();

    const absoluteLockPath = path.isAbsolute(lockPath) ? lockPath : path.resolve(this.workspace, lockPath);
    try {
      // lstat observes dangling symlinks too. Any directory entry at Git's lock
      // path can prevent Git from creating its lock, so it must stop checkpointing.
      fs.lstatSync(absoluteLockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new GitIndexLockCheckError();
    }
  }

  private assertGitIndexUnlocked(): void {
    if (this.gitIndexLockExists()) throw new GitIndexLockError();
  }

  private copyDirFiltered(src: string, dest: string, allowSensitive = false): void {
    ensurePrivateDir(dest);
    const ignored = new Set(["node_modules", ".git", "target", "dist", ".nexus", ".next", ".cache"]);
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      if (!allowSensitive) assertNoSensitivePersistenceContent(entry.name, "checkpoint");
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this.copyDirFiltered(srcPath, destPath, allowSensitive);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(srcPath);
        if (!allowSensitive) assertNoSensitivePersistenceContent(content.toString("utf8"), "checkpoint");
        writePrivateFile(destPath, content);
      }
    }
  }

  private assertGitChangesSafe(allowSensitive: boolean): void {
    const changedPaths = execFileSync("git", ["-c", "core.fsmonitor=false", "diff", "--name-only", "-z", "HEAD"], {
      cwd: this.workspace,
      encoding: "buffer",
    }).toString("utf8").split("\0").filter(Boolean);

    const gitRoot = this.gitRoot();
    for (const relativePath of changedPaths) {
      if (!allowSensitive) this.assertSnapshotTextSafe(relativePath);
      try {
        const indexEntry = execFileSync("git", ["-c", "core.fsmonitor=false", "ls-files", "--stage", "--full-name", "-z", "--", `:(top,literal)${relativePath}`], {
          cwd: this.workspace,
          encoding: "buffer",
          maxBuffer: 64 * 1024 * 1024,
        }).toString("utf8");
        const entry = indexEntry.split("\0").find(Boolean);
        if (!entry) throw new Error("Checkpoint could not verify protected Git index state");
        const tab = entry.indexOf("\t");
        const [mode, objectId, stage] = entry.slice(0, tab).split(" ");
        if (stage !== "0") throw new Error("Checkpoint could not verify protected Git index state");
        const indexed = execFileSync("git", ["-c", "core.fsmonitor=false", "cat-file", "blob", objectId], {
          cwd: this.workspace,
          encoding: "buffer",
          maxBuffer: 64 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        });
        if (!allowSensitive) {
          if (mode === "120000") this.assertSnapshotTextSafe(indexed.toString("utf8"));
          else assertNoSensitivePersistenceContent(indexed.toString("utf8"), "checkpoint");
        }
      } catch (error) {
        if (error instanceof SensitivePersistenceError) throw error;
        try {
          // A staged deletion has no index blob and no worktree bytes to copy.
          // Any other inability to inspect an indexed object is fail-closed.
          execFileSync("git", ["-c", "core.fsmonitor=false", "ls-files", "--error-unmatch", "--full-name", "--", `:(top,literal)${relativePath}`], {
            cwd: this.workspace,
            stdio: "ignore",
          });
          throw new Error("Checkpoint could not verify protected Git index state");
        } catch (indexError) {
          if (
            indexError instanceof Error &&
            indexError.message === "Checkpoint could not verify protected Git index state"
          ) throw indexError;
          if ((indexError as NodeJS.ErrnoException & { status?: number })?.status !== 1) {
            throw new Error("Checkpoint could not verify protected Git index state");
          }
          // Not present in the index: the path may be a staged deletion. Git's
          // checkpoint operation will not persist any untracked replacement.
        }
      }

      const worktreePath = path.join(gitRoot, relativePath);
      const stat = fs.lstatSync(worktreePath, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) {
        if (!allowSensitive) this.assertSnapshotTextSafe(fs.readlinkSync(worktreePath));
      } else if (stat?.isFile()) {
        if (!allowSensitive) assertNoSensitivePersistenceContent(fs.readFileSync(worktreePath, "utf8"), "checkpoint");
      }
    }
  }

  private gitUntrackedPaths(includeIgnored = false): string[] {
    const paths = execFileSync("git", ["-c", "core.fsmonitor=false", "ls-files", "--others", "--full-name", ...(includeIgnored ? [] : ["--exclude-standard"]), "-z"], {
      cwd: this.workspace,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    }).toString("utf8").split("\0").filter(Boolean);
    return paths.flatMap((gitPath) => {
      const relativePath = this.workspaceRelativeGitPath(gitPath);
      return relativePath ? [relativePath] : [];
    });
  }

  private assertSnapshotTextSafe(value: string): void {
    assertNoSensitivePersistenceContent(value, "checkpoint");
    for (const component of value.split(/[\\/]/)) assertNoSensitivePersistenceContent(component, "checkpoint");
  }

  private assertUntrackedEntriesSafe(relativePaths: string[], sourceRoot: string, allowSensitive: boolean): void {
    for (const relativePath of relativePaths) {
      const sourcePath = path.join(sourceRoot, relativePath);
      const stat = fs.lstatSync(sourcePath);
      if (!allowSensitive) this.assertSnapshotTextSafe(relativePath);
      if (stat.isSymbolicLink()) {
        if (!allowSensitive) this.assertSnapshotTextSafe(fs.readlinkSync(sourcePath));
      } else if (stat.isFile()) {
        if (!allowSensitive) assertNoSensitivePersistenceContent(fs.readFileSync(sourcePath, "utf8"), "checkpoint");
      } else {
        throw new Error("Checkpoint untracked entries must be regular files or symbolic links");
      }
    }
  }

  private assertNoNestedGitRepositoryAncestors(
    relativePaths: string[],
    targetRoot: string,
    allowExternalSymlinkAncestors = false,
  ): void {
    const root = fs.realpathSync(targetRoot);
    const gitProbeEnv = { ...process.env };
    for (const key of Object.keys(gitProbeEnv)) {
      if (key.startsWith("GIT_")) delete gitProbeEnv[key];
    }
    for (const relativePath of relativePaths) {
      const destination = path.resolve(root, relativePath);
      const relativeDestination = path.relative(root, destination);
      if (!relativeDestination || relativeDestination === ".." || relativeDestination.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDestination)) {
        throw new Error("Checkpoint destination path escapes the workspace");
      }
      const relativeParent = path.dirname(relativeDestination);
      const parentComponents = relativeParent === "." ? [] : relativeParent.split(path.sep);
      const destinationStat = fs.lstatSync(destination, { throwIfNoEntry: false });
      // A directory at the exact destination can itself be a repository, for
      // example when an untracked checkpoint file was replaced by a bare repo.
      // Include that leaf only when it is currently a directory; ordinary file
      // destinations still need only their parents checked.
      const components = destinationStat?.isDirectory()
        ? [...parentComponents, path.basename(relativeDestination)]
        : parentComponents;
      let parent = root;
      for (const component of components) {
        parent = path.join(parent, component);
        const stat = fs.lstatSync(parent, { throwIfNoEntry: false });
        if (!stat) break;
        if (stat.isSymbolicLink()) {
          if (allowExternalSymlinkAncestors) {
            try {
              const resolvedParent = fs.realpathSync(parent);
              if (resolvedParent !== root && !resolvedParent.startsWith(root + path.sep)) break;
            } catch {
              // Deletion cleanup already skips dangling or inaccessible parents.
              break;
            }
          }
          throw new Error("Checkpoint destination parent is a symbolic link");
        }
        if (!stat.isDirectory()) break;
        const dotGit = fs.lstatSync(path.join(parent, ".git"), { throwIfNoEntry: false });
        const bareHead = fs.lstatSync(path.join(parent, "HEAD"), { throwIfNoEntry: false });
        const bareConfigPath = path.join(parent, "config");
        const bareConfig = fs.lstatSync(bareConfigPath, { throwIfNoEntry: false });
        if (dotGit) {
          throw new Error("Checkpoint destination parent is a nested Git repository");
        }

        // A bare repository root requires HEAD. The Git probe distinguishes a
        // real repository from ordinary project folders named `objects`/`refs`.
        const hasGitDirectoryMarkers = !!bareHead;
        if (hasGitDirectoryMarkers) {
          try {
            const discoveredGitDir = execFileSync("git", ["-C", parent, "rev-parse", "--absolute-git-dir"], {
              cwd: root,
              encoding: "utf8",
              env: gitProbeEnv,
              maxBuffer: 1024 * 1024,
              stdio: ["ignore", "pipe", "ignore"],
            }).trim();
            if (fs.realpathSync(discoveredGitDir) === fs.realpathSync(parent)) {
              throw new Error("Checkpoint destination parent is a nested Git repository");
            }
          } catch (error) {
            if (error instanceof Error && error.message === "Checkpoint destination parent is a nested Git repository") throw error;
            if ((error as NodeJS.ErrnoException & { status?: number })?.status !== 128) {
              throw new Error("Checkpoint could not verify nested Git repository state");
            }
          }
        }

        const bareConfigStat = bareConfig ? fs.statSync(bareConfigPath, { throwIfNoEntry: false }) : undefined;
        if (hasGitDirectoryMarkers && bareConfigStat?.isFile()) {
          if (bareConfigStat.size > 1024 * 1024) {
            throw new Error("Checkpoint destination has an oversized Git configuration");
          }
          try {
            const configuredBare = execFileSync("git", ["config", "--file", bareConfigPath, "--includes", "--type=bool", "--get", "core.bare"], {
              cwd: root,
              encoding: "utf8",
              env: gitProbeEnv,
              maxBuffer: 1024 * 1024,
              stdio: ["ignore", "pipe", "ignore"],
            }).trim();
            if (configuredBare === "true") {
              throw new Error("Checkpoint destination parent is a nested Git repository");
            }
          } catch (error) {
            const status = (error as NodeJS.ErrnoException & { status?: number })?.status;
            if (error instanceof Error && error.message === "Checkpoint destination parent is a nested Git repository") throw error;
            if (status !== 1) throw new Error("Checkpoint destination has an invalid Git configuration");
          }
        }
      }
    }
  }

  private assertUntrackedDestinationSafe(relativePaths: string[], targetRoot: string): void {
    this.assertNoNestedGitRepositoryAncestors(relativePaths, targetRoot);
    const root = fs.realpathSync(targetRoot);
    for (const relativePath of relativePaths) {
      const destination = path.resolve(root, relativePath);
      const relativeDestination = path.relative(root, destination);
      const relativeParent = path.dirname(relativeDestination);
      let parent = root;
      for (const component of relativeParent === "." ? [] : relativeParent.split(path.sep)) {
        parent = path.join(parent, component);
        const stat = fs.lstatSync(parent, { throwIfNoEntry: false });
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
          throw new Error("Checkpoint destination parent is not a real directory");
        }
      }
    }
  }

  private copyUntrackedEntries(relativePaths: string[], sourceRoot: string, targetRoot: string, allowSensitive: boolean): void {
    ensurePrivateDir(targetRoot);
    for (const relativePath of relativePaths) {
      const sourcePath = path.join(sourceRoot, relativePath);
      const targetPath = path.join(targetRoot, relativePath);
      this.assertUntrackedDestinationSafe([relativePath], targetRoot);
      ensurePrivateDir(path.dirname(targetPath));
      this.assertUntrackedDestinationSafe([relativePath], targetRoot);
      const stat = fs.lstatSync(sourcePath);
      if (stat.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(sourcePath);
        if (!allowSensitive) this.assertSnapshotTextSafe(linkTarget);
        if (fs.lstatSync(targetPath, { throwIfNoEntry: false })) fs.rmSync(targetPath, { force: true });
        fs.symlinkSync(linkTarget, targetPath);
      } else if (stat.isFile()) {
        const content = fs.readFileSync(sourcePath);
        if (!allowSensitive) assertNoSensitivePersistenceContent(content.toString("utf8"), "checkpoint");
        writePrivateFile(targetPath, content);
      } else {
        throw new Error("Checkpoint untracked entries must be regular files or symbolic links");
      }
    }
  }

  private assertUntrackedSnapshotSafe(relativePaths: string[], snapshotDir: string, allowSensitive: boolean): void {
    const root = fs.realpathSync(snapshotDir);
    for (const relativePath of relativePaths) {
      const parent = fs.realpathSync(path.dirname(path.join(root, relativePath)));
      if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error("Checkpoint snapshot path escapes its root");
    }
    this.assertUntrackedEntriesSafe(relativePaths, root, allowSensitive);
  }

  private assertLegacyUntrackedRestoreSafe(gitRef: string): void {
    const checkoutPaths = execFileSync("git", ["-c", "core.fsmonitor=false", "ls-tree", "-r", "--name-only", "--full-tree", "-z", gitRef], {
      cwd: this.workspace,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    }).toString("utf8").split("\0").filter(Boolean).flatMap((gitPath) => {
      const relativePath = this.workspaceRelativeGitPath(gitPath);
      return relativePath ? [relativePath] : [];
    });
    const deletedPaths = execFileSync("git", ["-c", "core.fsmonitor=false", "diff", "--name-only", "--diff-filter=D", "-z", "HEAD", gitRef], {
      cwd: this.workspace,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    }).toString("utf8").split("\0").filter(Boolean).flatMap((gitPath) => {
      const relativePath = this.workspaceRelativeGitPath(gitPath);
      return relativePath ? [relativePath] : [];
    });
    const mutationPaths = new Set([...checkoutPaths, ...deletedPaths]);
    if (this.gitUntrackedPaths(true).some((relativePath) => {
      for (let candidate = relativePath; candidate && candidate !== "."; candidate = path.posix.dirname(candidate)) {
        if (mutationPaths.has(candidate)) return true;
      }
      return false;
    })) {
      throw new Error("Checkpoint legacy restore would overwrite or delete an uncaptured untracked file");
    }
  }

  private removeTrackedDeletions(gitRef: string, addedPaths: string[] = []): void {
    const deletedPaths = this.gitRefDeletedPaths(gitRef);
    const workspaceRoot = fs.realpathSync(this.workspace);
    for (const relativePath of new Set([...deletedPaths, ...addedPaths])) {
      const targetPath = path.join(workspaceRoot, relativePath);
      const relativeTarget = path.relative(workspaceRoot, targetPath);
      if (!relativeTarget || relativeTarget === ".." || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) continue;
      let parent = workspaceRoot;
      let blocked = false;
      for (const component of path.dirname(relativeTarget).split(path.sep).filter((part) => part && part !== ".")) {
        parent = path.join(parent, component);
        const parentStat = fs.lstatSync(parent, { throwIfNoEntry: false });
        if (!parentStat || !parentStat.isDirectory() || parentStat.isSymbolicLink()) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      try {
        if (fs.lstatSync(targetPath, { throwIfNoEntry: false })?.isDirectory()) continue;
        fs.rmSync(targetPath, { force: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }
    }
  }

  private gitRefDeletedPaths(gitRef: string): string[] {
    const paths = execFileSync("git", ["-c", "core.fsmonitor=false", "diff", "--name-only", "--diff-filter=D", "-z", "HEAD", gitRef], {
      cwd: this.workspace,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    }).toString("utf8").split("\0").filter(Boolean);
    return paths.flatMap((gitPath) => {
      const relativePath = this.workspaceRelativeGitPath(gitPath);
      return relativePath ? [relativePath] : [];
    });
  }

  private trackedPathsAddedSince(gitRef: string): string[] {
    const committed = execFileSync("git", ["-c", "core.fsmonitor=false", "diff", "--name-only", "--diff-filter=A", "-z", gitRef, "HEAD"], {
      cwd: this.workspace,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    }).toString("utf8").split("\0").filter(Boolean).flatMap((gitPath) => {
      const relativePath = this.workspaceRelativeGitPath(gitPath);
      return relativePath ? [relativePath] : [];
    });
    const staged = execFileSync("git", ["-c", "core.fsmonitor=false", "diff-index", "--cached", "--name-only", "--diff-filter=A", "-z", gitRef], {
      cwd: this.workspace,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    }).toString("utf8").split("\0").filter(Boolean).flatMap((gitPath) => {
      const relativePath = this.workspaceRelativeGitPath(gitPath);
      return relativePath ? [relativePath] : [];
    });
    return [...new Set([...committed, ...staged])];
  }

  private workspaceSnapshotPaths(root: string): string[] {
    const ignored = new Set(["node_modules", ".git", "target", "dist", ".nexus", ".next", ".cache"]);
    const paths: string[] = [];
    const visit = (directory: string, relative: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) visit(path.join(directory, entry.name), entryPath);
        else if (entry.isFile() || entry.isSymbolicLink()) paths.push(entryPath);
      }
    };
    visit(root, "");
    return paths;
  }

  private workspaceSnapshotDirectories(root: string): string[] {
    const ignored = new Set(["node_modules", ".git", "target", "dist", ".nexus", ".next", ".cache"]);
    const paths: string[] = [];
    const visit = (directory: string, relative: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name) || !entry.isDirectory()) continue;
        const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
        paths.push(entryPath);
        visit(path.join(directory, entry.name), entryPath);
      }
    };
    visit(root, "");
    return paths;
  }

  private directoryHasCleanupPreservedEntries(directory: string): boolean {
    const ignored = new Set(["node_modules", ".git", "target", "dist", ".nexus", ".next", ".cache"]);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) return true;
      if (entry.isDirectory()) {
        if (this.directoryHasCleanupPreservedEntries(path.join(directory, entry.name))) return true;
      } else if (!entry.isFile() && !entry.isSymbolicLink()) {
        return true;
      }
    }
    return false;
  }

  private assertSnapshotTargetsReplaceable(relativePaths: string[]): void {
    for (const relativePath of relativePaths) {
      const targetPath = path.join(this.workspace, relativePath);
      const stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
      if (stat?.isDirectory() && this.directoryHasCleanupPreservedEntries(targetPath)) {
        throw new Error("Checkpoint snapshot target directory contains entries preserved by cleanup");
      }
    }
  }

  private assertGitSnapshotTargetsReplaceable(relativePaths: string[], gitRef: string): void {
    const directoryTargets = relativePaths.filter((relativePath) =>
      fs.lstatSync(path.join(this.workspace, relativePath), { throwIfNoEntry: false })?.isDirectory(),
    );
    if (directoryTargets.length === 0) return;

    const changedPaths = execFileSync("git", ["-c", "core.fsmonitor=false", "diff", "--name-only", "-z", gitRef, "--"], {
      cwd: this.workspace,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    }).toString("utf8").split("\0").filter(Boolean);
    if (changedPaths.some((relativePath) => path.basename(relativePath) === ".gitignore")) {
      throw new Error("Checkpoint Git ignore rules differ from the current worktree");
    }

    for (const relativePath of directoryTargets) {
      // A clean preview can be empty when the directory path is also tracked in the index,
      // even though ordinary untracked children beneath it are removable.
      if (this.directoryContainsOnlyGitCleanRemovableEntries(relativePath)
        && this.gitTrackedDescendantPaths(relativePath).length === 0) {
        continue;
      }
      if (!this.directoryContainsOnlyTrackedRemovableEntries(relativePath)) {
        throw new Error("Checkpoint snapshot target directory contains entries preserved by Git clean");
      }
    }
  }

  /** Tracked file entries that checkout-index may recreate from this checkpoint tree. Gitlinks are not blobs. */
  private gitRefBlobPaths(gitRef: string): string[] {
    const entries = execFileSync("git", ["-c", "core.fsmonitor=false", "ls-tree", "-r", "-z", "--full-tree", gitRef], {
      cwd: this.workspace,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    }).toString("utf8").split("\0").filter(Boolean);

    const paths: string[] = [];
    for (const entry of entries) {
      const separator = entry.indexOf("\t");
      if (separator < 0) throw new Error("Could not parse checkpoint Git tree entry");
      const objectType = entry.slice(0, separator).split(" ")[1];
      if (objectType === "blob") {
        const relativePath = this.workspaceRelativeGitPath(entry.slice(separator + 1));
        if (relativePath) paths.push(relativePath);
      }
    }
    return paths;
  }

  private directoryContainsOnlyGitCleanRemovableEntries(relativePath: string): boolean {
    const root = path.join(this.workspace, relativePath);
    const visit = (directory: string, relative: string): boolean => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.name === ".git") return false;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          try {
            execFileSync("git", ["-c", "core.fsmonitor=false", "check-ignore", "--no-index", "-q", "--", `${relativePath}/${child}`], {
              cwd: this.workspace,
              stdio: "ignore",
            });
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException & { status?: number })?.status !== 1) return false;
          }
          if (!visit(fullPath, child)) return false;
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          try {
            execFileSync("git", ["-c", "core.fsmonitor=false", "check-ignore", "--no-index", "-q", "--", `${relativePath}/${child}`], {
              cwd: this.workspace,
              stdio: "ignore",
            });
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException & { status?: number })?.status !== 1) return false;
          }
        } else {
          return false;
        }
      }
      return true;
    };
    return visit(root, "");
  }

  private gitTrackedDescendantPaths(relativePath: string): string[] {
    return execFileSync("git", ["-c", "core.fsmonitor=false", "ls-files", "--cached", "-z", "--", relativePath], {
      cwd: this.workspace,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    }).toString("utf8").split("\0").filter((entry) => entry.startsWith(`${relativePath}/`));
  }

  private directoryContainsOnlyTrackedRemovableEntries(relativePath: string): boolean {
    const root = path.join(this.workspace, relativePath);
    const diskEntries: string[] = [];
    const visit = (directory: string, relative: string): boolean => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        const fullPath = path.join(directory, entry.name);
        if (entry.name === ".git") return false;
        if (entry.isDirectory()) {
          try {
            execFileSync("git", ["-c", "core.fsmonitor=false", "check-ignore", "--no-index", "-q", "--", `${relativePath}/${child}`], {
              cwd: this.workspace,
              stdio: "ignore",
            });
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException & { status?: number })?.status !== 1) return false;
          }
          if (!visit(fullPath, child)) return false;
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          diskEntries.push(`${relativePath}/${child}`);
        } else {
          return false;
        }
      }
      return true;
    };

    if (!visit(root, "")) return false;
    if (diskEntries.length === 0) return false;
    const trackedEntries = this.gitTrackedDescendantPaths(relativePath);
    const tracked = new Set(trackedEntries);
    if (diskEntries.length !== tracked.size || diskEntries.some((entry) => !tracked.has(entry))) return false;

    for (const entry of diskEntries) {
      try {
        execFileSync("git", ["-c", "core.fsmonitor=false", "check-ignore", "--no-index", "-q", "--", entry], {
          cwd: this.workspace,
          stdio: "ignore",
        });
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException & { status?: number })?.status !== 1) return false;
      }
    }
    return true;
  }

  private removeNonSnapshotEntries(snapshotFiles: string[]): void {
    const retained = new Set(snapshotFiles);
    const ignored = new Set(["node_modules", ".git", "target", "dist", ".nexus", ".next", ".cache"]);
    const visit = (directory: string, relative: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(fullPath, entryPath);
          if (fs.readdirSync(fullPath).length === 0 && ![...retained].some((file) => file.startsWith(entryPath + "/"))) {
            fs.rmdirSync(fullPath);
          }
        } else if ((entry.isFile() || entry.isSymbolicLink()) && !retained.has(entryPath)) {
          fs.rmSync(fullPath, { force: true });
        }
      }
    };
    visit(this.workspace, "");
  }

  public createCheckpoint(name?: string, options: { allowSensitive?: boolean } = {}): CheckpointInfo {
    const allowSensitive = options.allowSensitive === true;
    const rand = Math.random().toString(36).slice(2, 6);
    const id = `cp_${Date.now()}_${rand}`;
    const desc = redactForPersistence(name || `Checkpoint at ${new Date().toLocaleTimeString()}`);
    const timestamp = new Date().toISOString();

    let gitRef: string | undefined;
    let snapshotDir: string | undefined;
    let untrackedPaths: string[] = [];

    if (this.isGit) {
      try {
        this.assertGitIndexUnlocked();
        this.assertGitChangesSafe(allowSensitive);
        untrackedPaths = this.gitUntrackedPaths();
        this.assertUntrackedEntriesSafe(untrackedPaths, this.workspace, allowSensitive);
        // Create an untracked + tracked git stash commit without modifying working tree
        // Clean/smudge filter drivers (filter.* selected through .gitattributes) can still run external
        // programs here and during restore; Git offers no single override for them, and refusing to
        // checkpoint whenever a filter is configured would break Git LFS. Recorded as a known limitation
        // in docs/reviews/evidence/v1/DEFECT-CHECKPOINT-GIT-HOOKS-20261026/README.md.
        // Config-declared hooks (Git 2.54+) ignore core.hooksPath; disable the events these
        // commands can raise while keeping traditional hooks off with the argv override.
        const hookGuardEnv = envWithoutConfiguredHooks(this.workspace, ["reference-transaction", "post-index-change"]);
        const stashCommit = execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "stash", "create"], { cwd: this.workspace, encoding: "utf-8", env: hookGuardEnv }).trim();
        if (stashCommit) {
          // Catch a Git operation that began during validation or stash creation.
          // This is a point-in-time guard; Git exposes no atomic lock spanning
          // stash creation and publication of this separate checkpoint ref.
          this.assertGitIndexUnlocked();
          execFileSync("git", ["-c", "core.hooksPath=/dev/null", "update-ref", `refs/nexus/checkpoints/${id}`, stashCommit], {
            cwd: this.workspace,
            stdio: "ignore",
            env: hookGuardEnv,
          });
          gitRef = stashCommit;
        } else {
          // Working tree was clean; record HEAD
          const headCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: this.workspace, encoding: "utf-8" }).trim();
          this.assertGitIndexUnlocked();
          execFileSync("git", ["-c", "core.hooksPath=/dev/null", "update-ref", `refs/nexus/checkpoints/${id}`, headCommit], {
            cwd: this.workspace,
            stdio: "ignore",
            env: hookGuardEnv,
          });
          gitRef = headCommit;
        }
      } catch (error) {
        if (
          error instanceof SensitivePersistenceError ||
          error instanceof GitIndexLockError ||
          error instanceof GitIndexLockCheckError
        ) throw error;
        if (this.gitIndexLockExists()) throw new GitIndexLockError();
        throw new Error("Checkpoint could not verify protected Git state; no checkpoint was written");
      }
    }

    if (untrackedPaths.length > 0 || !gitRef) {
      const snapTarget = path.join(this.checkpointDir, "snapshots", id);
      try {
        if (gitRef) {
          this.copyUntrackedEntries(untrackedPaths, this.workspace, snapTarget, allowSensitive);
        } else {
          untrackedPaths = this.workspaceSnapshotPaths(this.workspace);
          this.assertUntrackedEntriesSafe(untrackedPaths, this.workspace, allowSensitive);
          this.copyUntrackedEntries(untrackedPaths, this.workspace, snapTarget, allowSensitive);
        }
        snapshotDir = snapTarget;
      } catch (error) {
        try {
          fs.rmSync(snapTarget, { recursive: true, force: true });
          if (gitRef) execFileSync("git", ["-c", "core.hooksPath=/dev/null", "update-ref", "-d", `refs/nexus/checkpoints/${id}`], { cwd: this.workspace, stdio: "ignore", env: envWithoutConfiguredHooks(this.workspace, ["reference-transaction"]) });
        } catch {}
        throw error;
      }
    }

    const checkpoint: CheckpointInfo = {
      id,
      name: desc,
      timestamp,
      workspace: this.workspace,
      gitRef,
      snapshotDir,
      ...(allowSensitive ? { allowSensitive: true } : {}),
      ...(this.isGit || snapshotDir ? { untrackedFiles: untrackedPaths } : {}),
    };

    const targetFile = path.join(this.checkpointDir, `${id}.json`);
    writePrivateFile(targetFile, JSON.stringify(checkpoint, null, 2), { durable: true });
    return checkpoint;
  }

  public getCheckpointDir(): string {
    return this.checkpointDir;
  }

  public getWorkspace(): string {
    return this.workspace;
  }

  public listCheckpoints(): CheckpointInfo[] {
    if (!fs.existsSync(this.checkpointDir)) return [];
    const files = fs.readdirSync(this.checkpointDir).filter((f) => f.endsWith(".json"));
    const list: CheckpointInfo[] = [];
    for (const f of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.checkpointDir, f), "utf-8"));
        const checkpoint = this.validatedCheckpoint(parsed);
        // The record must be the one its filename names; otherwise a planted file could cause
        // prune to delete another checkpoint's JSON/snapshot.
        if (checkpoint && checkpoint.id === f.replace(/\.json$/, "")) list.push(checkpoint);
      } catch {
        // Ignore corrupt checkpoint files
      }
    }
    return list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /**
   * Checkpoint JSON is local state, but it is still data: a malformed or edited file must not crash
   * lookups, make Git run shell text, or point prune/restore at an arbitrary directory.
   */
  private validatedCheckpoint(raw: any): CheckpointInfo | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.id)) return null;
    if (typeof raw.name !== "string" || typeof raw.timestamp !== "string") return null;
    // The name and timestamp are printed by the checkpoint commands; state-file text must not
    // inject terminal escapes.
    const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
    const name = raw.name.replace(control, "");
    const timestamp = raw.timestamp.replace(control, "");
    const checkpoint: CheckpointInfo = { id: raw.id, name, timestamp };
    if (typeof raw.workspace === "string") checkpoint.workspace = raw.workspace;
    if (typeof raw.gitRef === "string" && /^[0-9a-f]{7,64}$/i.test(raw.gitRef)) checkpoint.gitRef = raw.gitRef;
    const snapshotDir = this.confinedSnapshotDir(raw.id, raw.snapshotDir);
    if (snapshotDir) checkpoint.snapshotDir = snapshotDir;
    if (raw.allowSensitive === true) checkpoint.allowSensitive = true;
    if (raw.untrackedFiles !== undefined) {
      if (!Array.isArray(raw.untrackedFiles) || !raw.untrackedFiles.every((entry: any) =>
        typeof entry === "string" && entry.length > 0 && !entry.includes("\0") && !entry.startsWith("/") &&
        !/^[A-Za-z]:/.test(entry) && path.posix.normalize(entry) === entry && entry !== ".." &&
        !entry.startsWith("../") && !entry.split("/").includes(".git"),
      )) return null;
      checkpoint.untrackedFiles = [...new Set<string>(raw.untrackedFiles)];
    }
    if (Array.isArray(raw.files)) checkpoint.files = raw.files;
    return checkpoint;
  }

  /** A snapshot is usable only when it resolves under this checkpoint's own snapshots/<id>. */
  private confinedSnapshotDir(id: string, value: unknown): string | undefined {
    if (typeof value !== "string" || !path.isAbsolute(value)) return undefined;
    try {
      const snapshots = path.join(this.checkpointDir, "snapshots");
      const stat = fs.lstatSync(snapshots);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
      const root = fs.realpathSync(snapshots);
      const expected = path.join(root, id);
      const real = fs.realpathSync(value);
      return real === expected || real.startsWith(expected + path.sep) ? real : undefined;
    } catch {
      return undefined;
    }
  }

  public getCheckpoint(id: string): CheckpointInfo | null {
    const list = this.listCheckpoints();
    if (list.length === 0) return null;
    const cleanId = id.trim().toLowerCase();
    const found = list.find(
      (cp) => cp.id.toLowerCase() === cleanId || cp.id.toLowerCase().includes(cleanId) || cp.name.toLowerCase().includes(cleanId)
    );
    return found || null;
  }

  public getDiff(checkpointId: string, baseCheckpointId?: string): { success: boolean; diff: string; error?: string } {
    const cpTarget = this.getCheckpoint(checkpointId);
    if (!cpTarget) {
      return { success: false, diff: "", error: `Checkpoint '${checkpointId}' not found.` };
    }

    if (this.isGit && cpTarget.gitRef) {
      try {
        if (baseCheckpointId) {
          const cpBase = this.getCheckpoint(baseCheckpointId);
          if (!cpBase || !cpBase.gitRef) {
            return { success: false, diff: "", error: `Base checkpoint '${baseCheckpointId}' not found.` };
          }
          const out = execFileSync("git", ["-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv", cpBase.gitRef, cpTarget.gitRef], {
            cwd: this.workspace,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
          });
          return { success: true, diff: out };
        } else {
          // Diff checkpoint ref against current working tree
          const out = execFileSync("git", ["-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv", cpTarget.gitRef], {
            cwd: this.workspace,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
          });
          return { success: true, diff: out };
        }
      } catch (err: any) {
        return { success: false, diff: "", error: `Failed to compute diff: ${err.message}` };
      }
    }

    return {
      success: true,
      diff: `[Non-git checkpoint '${cpTarget.id}' - ${cpTarget.name} created at ${cpTarget.timestamp}]`,
    };
  }

  public pruneCheckpoints(keepCount: number = 20): { prunedCount: number; message: string } {
    const checkpoints = this.listCheckpoints();
    if (checkpoints.length <= keepCount) {
      return { prunedCount: 0, message: `No pruning needed (${checkpoints.length} checkpoints <= limit of ${keepCount}).` };
    }

    const toPrune = checkpoints.slice(keepCount);
    let count = 0;
    const failures: string[] = [];

    for (const cp of toPrune) {
      let deletedRefTarget: string | undefined;
      let hookEnv: NodeJS.ProcessEnv | undefined;
      const ref = cp.gitRef ? `refs/nexus/checkpoints/${cp.id}` : undefined;
      try {
        const jsonPath = path.join(this.checkpointDir, `${cp.id}.json`);
        if (this.isGit && ref) {
          // Resolve hook suppression before mutating checkpoint state. Git 2.54 cannot
          // suppress every configured hook without a discovery race, so retain the record.
          hookEnv = envWithoutConfiguredHooks(this.workspace, ["reference-transaction"]);
          try {
            deletedRefTarget = execFileSync("git", ["show-ref", "--hash", "--verify", ref], {
              cwd: this.workspace,
              env: hookEnv,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            }).trim();
          } catch (error: any) {
            if (error?.status !== 1) throw error;
          }
          if (deletedRefTarget) {
            execFileSync("git", ["-c", "core.hooksPath=/dev/null", "update-ref", "-d", ref, deletedRefTarget], {
              cwd: this.workspace,
              stdio: "ignore",
              env: hookEnv,
            });
          }
        }

        try {
          if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
        } catch (error) {
          if (deletedRefTarget && ref && hookEnv) {
            try {
              execFileSync("git", ["-c", "core.hooksPath=/dev/null", "update-ref", ref, deletedRefTarget, "0".repeat(deletedRefTarget.length)], {
                cwd: this.workspace,
                stdio: "ignore",
                env: hookEnv,
              });
            } catch (restoreError: any) {
              throw new Error(`${error instanceof Error ? error.message : String(error)}; checkpoint ref restoration failed: ${restoreError?.message || String(restoreError)}`);
            }
          }
          throw error;
        }
        if (cp.snapshotDir && fs.existsSync(cp.snapshotDir)) {
          fs.rmSync(cp.snapshotDir, { recursive: true, force: true });
        }
        count++;
      } catch (error: any) {
        failures.push(`${cp.id}: ${error?.message || String(error)}`);
      }
    }

    const message = `Pruned ${count} old checkpoints (retained ${keepCount} most recent).`;
    return {
      prunedCount: count,
      message: failures.length === 0 ? message : `${message} ${failures.length} checkpoint(s) could not be pruned: ${failures.join("; ")}`,
    };
  }

  public rollbackLast(): { success: boolean; message: string } {
    const checkpoints = this.listCheckpoints();
    if (checkpoints.length === 0) {
      return { success: false, message: "No checkpoints available to roll back to." };
    }
    const target = checkpoints[0];
    return this.restore(target.id);
  }

  public restore(id: string): { success: boolean; message: string } {
    const cp = this.getCheckpoint(id);
    if (!cp) {
      return { success: false, message: `Checkpoint '${id}' not found.` };
    }
    if (cp.gitRef && !this.isGit) {
      return { success: false, message: `Rollback failed: checkpoint '${cp.id}' requires its Git repository metadata; workspace was not changed` };
    }

    try {
      if (this.isGit && cp.gitRef) {
        const hookGuardEnv = envWithoutConfiguredHooks(this.workspace, ["reference-transaction", "post-index-change"]);
        const postCheckpointAdditions = cp.untrackedFiles === undefined ? this.trackedPathsAddedSince(cp.gitRef) : [];
        const deletedPaths = this.gitRefDeletedPaths(cp.gitRef);
        const checkoutPaths = this.gitRefBlobPaths(cp.gitRef);
        const writePaths = [...new Set([...checkoutPaths, ...(cp.untrackedFiles ?? [])])];
        const removalPaths = [...new Set([...deletedPaths, ...postCheckpointAdditions])];
        if (cp.untrackedFiles !== undefined && cp.untrackedFiles.length > 0) {
          if (!cp.snapshotDir) return { success: false, message: `Rollback failed: checkpoint '${cp.id}' is missing its untracked snapshot; workspace was not changed` };
          try {
            this.assertUntrackedSnapshotSafe(cp.untrackedFiles, cp.snapshotDir, cp.allowSensitive === true);
            this.assertUntrackedDestinationSafe(cp.untrackedFiles, this.workspace);
          } catch {
            return { success: false, message: `Rollback failed: checkpoint '${cp.id}' has an unsafe untracked snapshot or destination; workspace was not changed` };
          }
        }
        // Validate every path that restore may write or remove before read-tree
        // mutates the outer index. Tracked deletions are destructive too: they
        // must not cross into nested repositories in the current worktree.
        this.assertNoNestedGitRepositoryAncestors(writePaths, this.workspace);
        // Tracked deletion cleanup intentionally leaves targets behind when a
        // parent symlink resolves outside the workspace. Preserve that behavior
        // while still rejecting a nested repository reachable within the tree.
        this.assertNoNestedGitRepositoryAncestors(removalPaths, this.workspace, true);
        if (cp.untrackedFiles !== undefined) {
          const replacementTargets = [...new Set([...cp.untrackedFiles, ...checkoutPaths])];
          this.assertGitSnapshotTargetsReplaceable(replacementTargets, cp.gitRef);
        }
        if (cp.untrackedFiles === undefined) this.assertLegacyUntrackedRestoreSafe(cp.gitRef);
        this.restoreGitIndex(cp.gitRef, hookGuardEnv);
        // Remove checkpoint-deleted paths while their current ancestors are still
        // present. Installing checkpoint symlinks first could redirect deletion
        // through an in-workspace link into unrelated ignored data.
        this.removeTrackedDeletions(cp.gitRef, postCheckpointAdditions);
        // Use literal index paths from the checkpoint tree. checkout-index does
        // not accept directory pathspecs, and an all-index checkout would overwrite
        // sibling worktree content in repositories with nested workspaces.
        if (checkoutPaths.length > 0) {
          const checkoutInput = Buffer.from(checkoutPaths.map((filePath) => `${filePath}\0`).join(""), "utf8");
          execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "checkout-index", "-f", "-q", "-z", "--stdin"], {
            cwd: this.workspace,
            input: checkoutInput,
            stdio: ["pipe", "ignore", "ignore"],
            env: hookGuardEnv,
          });
        }
        if (cp.untrackedFiles !== undefined) {
          execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "clean", "-fd"], { cwd: this.workspace, stdio: "ignore", env: hookGuardEnv });
          if (cp.untrackedFiles.length > 0) {
            this.copyUntrackedEntries(cp.untrackedFiles, cp.snapshotDir!, this.workspace, cp.allowSensitive === true);
          }
          return { success: true, message: `Restored workspace to checkpoint '${cp.name}' (${cp.id})` };
        }
        return { success: true, message: `Restored tracked workspace to checkpoint '${cp.name}' (${cp.id}); legacy untracked files were not captured and were left unchanged` };
      }

      if (cp.snapshotDir && cp.untrackedFiles !== undefined) {
        try {
          this.assertUntrackedSnapshotSafe(cp.untrackedFiles, cp.snapshotDir, cp.allowSensitive === true);
          this.assertUntrackedDestinationSafe([...cp.untrackedFiles, ...this.workspaceSnapshotPaths(this.workspace)], this.workspace);
          this.assertSnapshotTargetsReplaceable(cp.untrackedFiles);
        } catch {
          return { success: false, message: `Rollback failed: checkpoint '${cp.id}' has an incomplete or unsafe snapshot or destination; workspace was not changed` };
        }
        this.removeNonSnapshotEntries(cp.untrackedFiles);
        this.copyUntrackedEntries(cp.untrackedFiles, cp.snapshotDir, this.workspace, cp.allowSensitive === true);
        return { success: true, message: `Restored workspace files from snapshot '${cp.name}' (${cp.id})` };
      }

      if (cp.snapshotDir && fs.existsSync(cp.snapshotDir)) {
        const snapshotFiles = this.workspaceSnapshotPaths(cp.snapshotDir);
        const snapshotDirectories = this.workspaceSnapshotDirectories(cp.snapshotDir);
        this.assertUntrackedSnapshotSafe(snapshotFiles, cp.snapshotDir, cp.allowSensitive === true);
        if (!cp.allowSensitive) {
          for (const relativePath of snapshotDirectories) this.assertSnapshotTextSafe(relativePath);
        }
        this.assertUntrackedDestinationSafe([...snapshotFiles, ...snapshotDirectories], this.workspace);
        this.copyDirFiltered(cp.snapshotDir, this.workspace, cp.allowSensitive === true);
        return { success: true, message: `Restored workspace files from legacy snapshot '${cp.name}' (${cp.id}); other entries were left unchanged` };
      }

      return { success: false, message: `Cannot restore checkpoint: no valid snapshot recorded.` };
    } catch (err: any) {
      return { success: false, message: `Rollback failed: ${err.message}` };
    }
  }
}
