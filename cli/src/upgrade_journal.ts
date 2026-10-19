/**
 * Upgrade Journal, Backups & Crash Recovery Engine (REQ-REL-116, ACC-UPG-09, ACC-UPG-11)
 *
 * Maintains a persistent transaction journal outside the version directory being replaced:
 * - Records stages: idle -> preparing -> downloading -> staged -> switching -> switched -> verified -> complete
 * - Automatic and explicit idempotent crash recovery (restoring previous symlink or completing verified transition)
 * - Safe pre-migration configuration and state backups with 0600 file / 0700 dir permissions
 * - Clean credential preservation without exposing secrets in journal files
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { acquireFileGuard, releaseFileGuard, type FileGuard } from "./core/file_guard.js";
import { withStateStoreGuard, STATE_STORE_GUARD_FILE } from "./core/state_store_guard.js";
import { verifyInstalledRuntime } from "./upgrade_health.js";

export type JournalState =
  | "idle"
  | "preparing"
  | "downloading"
  | "staged"
  | "switching"
  | "switched"
  | "verified"
  | "complete"
  | "recovery_required"
  | "rolled_back";

export interface UpgradeJournalEntry {
  formatVersion: 1;
  id: string;
  state: JournalState;
  sourceVersion: string;
  sourceInstallDir: string;
  sourceSymlinkTarget: string;
  targetVersion: string;
  targetInstallDir: string;
  stagingDir?: string;
  replacementBackupDir?: string;
  displacedTargetDir?: string;
  prefix: string;
  binPath: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
  configBackupPath?: string;
  stateBackupDir?: string;
}

export interface BackupResult {
  configBackupPath?: string;
  stateBackupDir?: string;
}

export function getJournalPath(prefix: string): string {
  return path.join(prefix, "lib", "nexus", ".upgrade-journal.json");
}

export function readJournal(prefix: string): UpgradeJournalEntry | null {
  const journalPath = getJournalPath(prefix);
  if (!fs.existsSync(journalPath)) return null;
  try {
    if (!fs.lstatSync(journalPath).isFile() || fs.realpathSync(journalPath) !== path.resolve(journalPath)) return null;
    const raw = fs.readFileSync(journalPath, "utf8");
    const data = JSON.parse(raw);
    if (isValidJournal(data, prefix)) {
      return data as UpgradeJournalEntry;
    }
  } catch {}
  return null;
}

function isValidJournal(value: any, prefix: string): value is UpgradeJournalEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const states: JournalState[] = ["idle", "preparing", "downloading", "staged", "switching", "switched", "verified", "complete", "recovery_required", "rolled_back"];
  const root = path.resolve(prefix);
  const libRoot = path.join(root, "lib", "nexus");
  const expectedBin = path.join(root, "bin", "nexus");
  const versionDir = (version: unknown) => typeof version === "string" && /^[v]?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)
    ? path.join(libRoot, version)
    : "";
  const sourceDir = versionDir(value.sourceVersion);
  const targetDir = versionDir(value.targetVersion);
  const expectedPath = (actual: unknown, expected: string) => typeof actual === "string" && expected !== "" && path.resolve(actual) === expected;
  const isoDate = (date: unknown) => typeof date === "string" && Number.isFinite(Date.parse(date));

  if (value.formatVersion !== 1 || typeof value.id !== "string" || value.id.length < 1 || value.id.length > 128 ||
      !states.includes(value.state) || !sourceDir || !targetDir ||
      !expectedPath(value.prefix, root) || !expectedPath(value.sourceInstallDir, sourceDir) ||
      !expectedPath(value.targetInstallDir, targetDir) || !expectedPath(value.sourceSymlinkTarget, path.join(sourceDir, "bin", "nexus")) ||
      !expectedPath(value.binPath, expectedBin) || !isoDate(value.startedAt) || !isoDate(value.updatedAt)) return false;

  if (!/^[A-Za-z0-9._-]+$/.test(value.id)) return false;
  for (const [field, name] of [["replacementBackupDir", `.rollback-${value.id}`], ["displacedTargetDir", `.failed-${value.id}`]]) {
    if (value[field] !== undefined && !expectedPath(value[field], path.join(libRoot, name))) return false;
  }
  if (sourceDir === targetDir && !value.replacementBackupDir) return false;
  if (value.stagingDir !== undefined) {
    if (typeof value.stagingDir !== "string" || path.dirname(path.resolve(value.stagingDir)) !== libRoot ||
        !/^\.tmp-upgrade-[A-Za-z0-9._-]{1,128}$/.test(path.basename(value.stagingDir))) return false;
  }
  if (value.configBackupPath !== undefined) {
    const backups = path.join(process.env.HOME || "", ".config", "nexus", "backups");
    if (typeof value.configBackupPath !== "string" || path.dirname(path.resolve(value.configBackupPath)) !== backups ||
        !/^config\.env\.bak\.[A-Za-z0-9T_.-]+$/.test(path.basename(value.configBackupPath))) return false;
  }
  if (value.stateBackupDir !== undefined) {
    const backups = path.join(process.env.HOME || "", ".nexus", "backups");
    if (typeof value.stateBackupDir !== "string" || path.dirname(path.resolve(value.stateBackupDir)) !== backups ||
        !/^state-backup-[A-Za-z0-9T_.-]+$/.test(path.basename(value.stateBackupDir))) return false;
  }
  return true;
}

export function writeJournal(prefix: string, entry: UpgradeJournalEntry): void {
  const journalPath = getJournalPath(prefix);
  const dir = path.dirname(journalPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${journalPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
  const fd = fs.openSync(tmp, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, journalPath);
  syncDirectory(dir);
}

export function clearJournal(prefix: string): void {
  const journalPath = getJournalPath(prefix);
  if (fs.existsSync(journalPath)) {
    try {
      fs.unlinkSync(journalPath);
    } catch {}
  }
}

/**
 * Creates pre-migration backups of configuration and durable state.
 * Files are created with strict 0600 permissions in 0700 directories.
 */
export function createPreMigrationBackup(homeDir: string = process.env.HOME || ""): BackupResult {
  const result: BackupResult = {};
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  // 1. Config backup
  const configEnv = path.join(homeDir, ".config", "nexus", "config.env");
  if (fs.existsSync(configEnv)) {
    if (!fs.lstatSync(configEnv).isFile() || fs.realpathSync(configEnv) !== path.resolve(configEnv)) throw new Error("Configuration backup source is redirected");
    const backupDir = path.join(homeDir, ".config", "nexus", "backups");
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(backupDir) !== path.resolve(backupDir)) throw new Error("Configuration backup directory is redirected");
    const backupFile = path.join(backupDir, `config.env.bak.${timestamp}`);
    fs.copyFileSync(configEnv, backupFile);
    fs.chmodSync(backupFile, 0o600);
    result.configBackupPath = backupFile;
  }

  // 2. State backup
  const stateDir = path.join(homeDir, ".nexus");
  if (fs.existsSync(stateDir)) {
    const stateBackupsDir = path.join(stateDir, "backups");
    fs.mkdirSync(stateBackupsDir, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(stateBackupsDir) !== path.resolve(stateBackupsDir)) throw new Error("State backup directory is redirected");
    const backupDest = path.join(stateBackupsDir, `state-backup-${timestamp}`);
    fs.mkdirSync(backupDest, { recursive: true, mode: 0o700 });

    // Snapshot all durable state, not just its index. Backup directories are
    // excluded to avoid recursion; symbolic links are refused rather than read.
    withDurableStoreGuards(homeDir, () => copyPrivateTree(stateDir, path.join(backupDest, "state"), new Set(["backups"])));
    const configDir = path.join(homeDir, ".config", "nexus");
    if (fs.existsSync(configDir)) copyPrivateTree(configDir, path.join(backupDest, "config"), new Set(["backups"]));
    fs.writeFileSync(path.join(backupDest, "backup.json"), JSON.stringify({ formatVersion:1, kind:"nexus-state-config", createdAt:new Date().toISOString() }), { mode:0o600 });

    result.stateBackupDir = backupDest;
  }

  return result;
}

/**
 * Restores configuration from a previous backup file.
 */
export function restoreConfigBackup(backupPath: string, homeDir: string = process.env.HOME || ""): boolean {
  try {
    const resolved = path.resolve(backupPath);
    if (fs.realpathSync(resolved) !== resolved) return false;
    const configRoot = path.join(homeDir, ".config", "nexus");
    if (fs.lstatSync(resolved).isDirectory()) {
      if (path.dirname(resolved) !== path.join(homeDir, ".nexus", "backups") || !/^state-backup-[A-Za-z0-9T_.-]+$/.test(path.basename(resolved))) return false;
      const metadata = JSON.parse(fs.readFileSync(path.join(resolved, "backup.json"), "utf8"));
      if (metadata.formatVersion !== 1 || metadata.kind !== "nexus-state-config") return false;
      // Validate the entire source tree before touching live configuration/state.
      validatePrivateTree(resolved);
      const state = path.join(resolved, "state");
      const config = path.join(resolved, "config");
      if (fs.existsSync(state)) withDurableStoreGuards(homeDir, () => restorePrivateTree(state, path.join(homeDir, ".nexus"), new Set(["backups"])));
      if (fs.existsSync(config)) restorePrivateTree(config, configRoot, new Set(["backups"]));
      return true;
    }
    // Legacy plain config backups are recognized by their canonical location
    // and name. Archives and arbitrary files must never become config.env.
    if (path.dirname(resolved) !== path.join(configRoot, "backups") || !/^config\.env\.bak\.[A-Za-z0-9T_.-]+$/.test(path.basename(resolved)) || !fs.lstatSync(resolved).isFile()) return false;
    fs.mkdirSync(configRoot, { recursive:true, mode:0o700 });
    if (fs.realpathSync(configRoot) !== path.resolve(configRoot)) return false;
    const target = path.join(configRoot, "config.env");
    if (fs.existsSync(target) && (!fs.lstatSync(target).isFile() || fs.realpathSync(target) !== target)) return false;
    fs.copyFileSync(resolved, target);
    fs.chmodSync(target, 0o600);
    return true;
  } catch { return false; }
}
/** Keep permanent guard inodes even when rolling back to a backup without that store. */
function removeRestoredObsoleteTree(target: string): void {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory()) { fs.unlinkSync(target); return; }
  for (const name of fs.readdirSync(target)) {
    if (name !== STATE_STORE_GUARD_FILE) removeRestoredObsoleteTree(path.join(target, name));
  }
  if (fs.readdirSync(target).length === 0) fs.rmdirSync(target);
}

/** New clients serialize task/session multi-file snapshots in a fixed lock order. */
function withDurableStoreGuards<T>(homeDir: string, callback: () => T): T {
  const tasks = path.join(homeDir, ".nexus", "tasks");
  const sessions = path.join(homeDir, ".nexus", "sessions");
  for (const directory of [tasks, sessions]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(directory) !== path.resolve(directory)) throw new Error("State store is redirected");
  }
  return withStateStoreGuard(tasks, () => withStateStoreGuard(sessions, callback));
}

function validatePrivateTree(source: string): void {
  if (fs.realpathSync(source) !== path.resolve(source)) throw new Error("Backup path is redirected");
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("Backup contains unsupported files");
  if (stat.isDirectory()) for (const name of fs.readdirSync(source)) validatePrivateTree(path.join(source, name));
}
function copyPrivateTree(source: string, destination: string, excluded = new Set<string>()): void {
  validatePrivateTreeExcept(source, excluded);
  fs.mkdirSync(destination, { recursive:true, mode:0o700 });
  if (fs.realpathSync(destination) !== path.resolve(destination)) throw new Error("Backup destination is redirected");
  fs.chmodSync(destination, 0o700);
  for (const entry of fs.readdirSync(source, { withFileTypes:true })) {
    if (excluded.has(entry.name) || entry.name === STATE_STORE_GUARD_FILE) continue;
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyPrivateTree(from, to);
    else {
      try { if (fs.lstatSync(to).isSymbolicLink()) throw new Error("Restore destination is redirected"); } catch (error:any) { if (error.code !== "ENOENT") throw error; }
      fs.copyFileSync(from, to); fs.chmodSync(to, 0o600);
    }
  }
}
function restorePrivateTree(source: string, destination: string, preserved = new Set<string>()): void {
  if (fs.existsSync(destination)) validatePrivateTreeExcept(destination, preserved);
  copyPrivateTree(source, destination);
  for (const name of fs.readdirSync(destination)) {
    if (preserved.has(name) || name === STATE_STORE_GUARD_FILE) continue;
    const from = path.join(source, name), to = path.join(destination, name);
    if (!fs.existsSync(from)) removeRestoredObsoleteTree(to);
    else if (fs.lstatSync(from).isDirectory()) restorePrivateTree(from, to);
  }
}
function validatePrivateTreeExcept(source: string, excluded: Set<string>): void {
  if (fs.realpathSync(source) !== path.resolve(source) || !fs.lstatSync(source).isDirectory()) throw new Error("State root is redirected");
  for (const entry of fs.readdirSync(source)) if (!excluded.has(entry)) validatePrivateTree(path.join(source, entry));
}

export interface RecoveryOutcome {
  recovered: boolean;
  action: "rolled_back" | "finalized" | "none" | "cleaned_up" | "manual_intervention" | "upgrade_in_progress";
  details: string;
}

/**
 * Permanent kernel-owned guard that serializes stale-lock reclamation between
 * concurrent processes. The guard is a regular file that is never unlinked or
 * replaced; mutual exclusion comes from an advisory flock held on the open file
 * description for the whole reclaim section. The kernel releases the lock when
 * the last referring descriptor closes, so a reclaimer killed by SIGKILL or a
 * power loss cannot wedge later upgrades, and no recursive takeover of a stale
 * gate directory is ever performed.
 */
export type ReclaimGuard = FileGuard;

const FLOCK_UTILITY = "/usr/bin/flock";

/**
 * Acquires the reclaim guard. Returns null on contention (another live
 * reclaimer holds the kernel lock) and throws on any unsupported or failed
 * prerequisite so callers fail closed instead of proceeding unserialized.
 * The utility path is injectable so tests can demonstrate fail-closed
 * behavior without modifying the real system utility.
 */
export function acquireReclaimGuard(guardPath: string, flockUtility: string = FLOCK_UTILITY): ReclaimGuard | null {
  return acquireFileGuard(guardPath, { utility: flockUtility, label: "Reclaim guard" });
}

export function releaseReclaimGuard(guard: ReclaimGuard | null): void {
  releaseFileGuard(guard);
}

/**
 * Idempotent crash recovery: inspects journal and restores working installation or finalizes transition.
 */
export function recoverUpgrade(prefix: string, options: { forceRollback?: boolean; timeoutMs?: number; lockHeld?: boolean; onStaleLockObserved?: () => void } = {}): RecoveryOutcome {
  const journalPath = getJournalPath(prefix);
  const journal = readJournal(prefix);
  if (!journal && !fs.existsSync(journalPath)) return { recovered:false, action:"none", details:"No interrupted upgrade found in journal." };
  if (journal && ["idle", "complete", "rolled_back"].includes(journal.state) && !options.forceRollback) return { recovered:false, action:"none", details:"No interrupted upgrade found in journal." };
  const lock = path.join(prefix, "lib", "nexus", ".upgrade.lock");
  let owned = false, ownedIno: number | undefined;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const inProgress: RecoveryOutcome = { recovered:false, action:"upgrade_in_progress", details:"An upgrade transaction is currently in progress." };
  const acquire = () => {
    const fd = fs.openSync(lock, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ pid:process.pid, token })); fs.fsyncSync(fd); ownedIno = fs.fstatSync(fd).ino; }
    finally { fs.closeSync(fd); }
    owned = true;
  };
  try {
    if (fs.existsSync(lock)) {
      if (!isRealFile(lock)) throw new Error("Upgrade lock is redirected");
      const staleStat = fs.lstatSync(lock), staleIno = staleStat.ino;
      const holder = JSON.parse(fs.readFileSync(lock, "utf8"));
      if (!Number.isSafeInteger(holder.pid) || holder.pid < 1) throw new Error("Upgrade lock is invalid");
      if (holder.pid === process.pid && !options.lockHeld) return inProgress;
      if (holder.pid !== process.pid) {
        try { process.kill(holder.pid, 0); return inProgress; }
        catch (error:any) { if (error.code === "EPERM") return inProgress; if (error.code !== "ESRCH") throw error; }
        options.onStaleLockObserved?.();
        const guardPath = `${lock}.guard`;
        let guard = acquireReclaimGuard(guardPath);
        if (!guard) {
          // A live reclaimer holds the kernel guard: give it a moment, then
          // re-check whether it took over the lock before reporting progress.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
          const current = fs.lstatSync(lock, { throwIfNoEntry:false });
          if (!current || current.ino !== staleIno) return inProgress;
          guard = acquireReclaimGuard(guardPath);
          if (!guard) return { recovered:false, action:"upgrade_in_progress", details:`An upgrade transaction is currently in progress (reclaim guard: ${guardPath}).` };
        }
        try {
          const currentStat = fs.lstatSync(lock, { throwIfNoEntry:false });
          if (currentStat && currentStat.ino !== staleIno) return inProgress;
          if (currentStat) {
            if (JSON.parse(fs.readFileSync(lock, "utf8")).pid !== holder.pid) return inProgress;
            fs.unlinkSync(lock);
          }
          acquire();
        } finally { releaseReclaimGuard(guard); }
      }
    }
    if (!owned && !fs.existsSync(lock) && fs.existsSync(path.dirname(lock))) {
      try { acquire(); } catch (error:any) { if (error.code === "EEXIST") return inProgress; throw error; }
    }
    return recoverUpgradeLocked(prefix, options);
  } catch (error:any) { return { recovered:false, action:"manual_intervention", details:error.message }; }
  finally {
    if (owned) try {
      const current = fs.lstatSync(lock, { throwIfNoEntry:false });
      if (current?.ino === ownedIno && JSON.parse(fs.readFileSync(lock, "utf8")).token === token) fs.unlinkSync(lock);
    } catch {}
  }
}
function recoverUpgradeLocked(prefix: string, options: { forceRollback?: boolean; timeoutMs?: number; lockHeld?: boolean } = {}): RecoveryOutcome {
  const journalPath = getJournalPath(prefix);
  const journal = readJournal(prefix);
  const failed = (details: string): RecoveryOutcome => ({ recovered:false, action:"manual_intervention", details });
  if (!journal && fs.existsSync(journalPath)) return failed("Upgrade journal failed schema or path validation; no recovery action was taken.");
  if (!journal || (["idle", "complete", "rolled_back"].includes(journal.state) && !options.forceRollback)) return { recovered:false, action:"none", details:"No interrupted upgrade found in journal." };
  const libRoot = path.join(path.resolve(prefix), "lib", "nexus");
  if (!isRealDirectory(libRoot) || !isRealDirectory(path.dirname(journal.binPath))) return failed("Upgrade recovery roots are not real contained directories; no recovery action was taken.");
  for (const directory of [journal.sourceInstallDir, journal.targetInstallDir, journal.replacementBackupDir, journal.displacedTargetDir, journal.stagingDir]) {
    if (directory && fs.existsSync(directory) && !isRealDirectory(directory)) return failed("A recovery path is not a contained real directory; no recovery action was taken.");
    // lstat also detects dangling symlinks, which existsSync deliberately ignores.
    if (directory) { try { if (fs.lstatSync(directory).isSymbolicLink()) return failed("A recovery path is a symlink; no recovery action was taken."); } catch (error: any) { if (error.code !== "ENOENT") return failed(error.message); } }
  }
  try {
    if (!options.forceRollback && journal.state === "verified" && verifyInstalledRuntime(journal.targetInstallDir, journal.targetVersion, options.timeoutMs).healthy) {
      atomicSymlinkSwap(path.join(journal.targetInstallDir, "bin", "nexus"), journal.binPath);
      journal.state = "complete";
      journal.updatedAt = new Date().toISOString();
      writeJournal(prefix, journal);
      return { recovered:true, action:"finalized", details:`Finalized verified release ${journal.targetVersion}.` };
    }
    // The old package is kept outside disposable staging. The journal records its
    // identity BEFORE the first rename, covering crashes on either side of it.
    const early = ["preparing", "downloading", "staged"].includes(journal.state);
    const sameVersion = journal.sourceInstallDir === journal.targetInstallDir;
    const saved = journal.replacementBackupDir;
    if (saved && fs.existsSync(saved)) {
      if (!verifyInstalledRuntime(saved, sameVersion ? journal.sourceVersion : journal.targetVersion, options.timeoutMs).healthy && sameVersion) throw new Error("Preserved source package failed runtime validation; retained for manual intervention");
      if (fs.existsSync(journal.targetInstallDir)) {
        if (!journal.displacedTargetDir || fs.existsSync(journal.displacedTargetDir)) throw new Error("Cannot displace failed target safely; all packages retained");
        fs.renameSync(journal.targetInstallDir, journal.displacedTargetDir);
        syncDirectory(libRoot);
      }
      fs.renameSync(saved, journal.targetInstallDir);
      syncDirectory(libRoot);
    }
    const health = verifyInstalledRuntime(journal.sourceInstallDir, journal.sourceVersion, options.timeoutMs);
    if (!health.healthy) throw new Error(`source launcher/runtime is unverified: ${health.error}`);
    atomicSymlinkSwap(journal.sourceSymlinkTarget, journal.binPath);
    journal.state = "rolled_back";
    journal.updatedAt = new Date().toISOString();
    delete journal.error;
    writeJournal(prefix, journal);
    // Never delete staging before successful source restoration. Failed packages
    // and the original backup remain available if any step above fails.
    if (journal.stagingDir && fs.existsSync(journal.stagingDir)) fs.rmSync(journal.stagingDir, { recursive:true, force:true });
    return { recovered:true, action:early ? "cleaned_up" : "rolled_back", details:`Restored verified source release ${journal.sourceVersion}.` };
  } catch (error: any) {
    journal.state = "recovery_required";
    journal.error = `Manual intervention required: ${error.message}`;
    journal.updatedAt = new Date().toISOString();
    try { writeJournal(prefix, journal); } catch {}
    return failed(journal.error);
  }
}

/** Flush rename boundaries as well as the journal before reporting success. */
export function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function isRealDirectory(directory: string): boolean {
  try {
    const absolute = path.resolve(directory);
    const stat = fs.lstatSync(absolute);
    return stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(absolute) === absolute;
  } catch {
    return false;
  }
}

function isRealFile(filePath: string): boolean {
  try {
    const absolute = path.resolve(filePath);
    const stat = fs.lstatSync(absolute);
    return stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync(absolute) === absolute;
  } catch {
    return false;
  }
}

function atomicSymlinkSwap(targetFile: string, linkPath: string): void {
  const binDir = path.dirname(linkPath);
  fs.mkdirSync(binDir, { recursive: true });
  const tmpLink = path.join(binDir, `.nexus-link-recovery.${process.pid}.${Date.now()}`);
  try {
    fs.symlinkSync(targetFile, tmpLink);
    fs.renameSync(tmpLink, linkPath);
    syncDirectory(binDir);
  } catch (err: any) {
    try {
      fs.unlinkSync(tmpLink);
    } catch {}
    throw err;
  }
}
