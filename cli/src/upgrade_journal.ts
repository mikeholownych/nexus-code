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
import { execFileSync, spawnSync } from "node:child_process";

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
      !states.includes(value.state) || !sourceDir || !targetDir || sourceDir === targetDir ||
      !expectedPath(value.prefix, root) || !expectedPath(value.sourceInstallDir, sourceDir) ||
      !expectedPath(value.targetInstallDir, targetDir) || !expectedPath(value.sourceSymlinkTarget, path.join(sourceDir, "bin", "nexus")) ||
      !expectedPath(value.binPath, expectedBin) || !isoDate(value.startedAt) || !isoDate(value.updatedAt)) return false;

  if (value.stagingDir !== undefined) {
    if (typeof value.stagingDir !== "string" || path.dirname(path.resolve(value.stagingDir)) !== libRoot ||
        !/^\.tmp-upgrade-[A-Za-z0-9._-]{1,128}$/.test(path.basename(value.stagingDir))) return false;
  }
  if (value.configBackupPath !== undefined) {
    const backups = path.join(path.dirname(root), ".config", "nexus", "backups");
    if (typeof value.configBackupPath !== "string" || path.dirname(path.resolve(value.configBackupPath)) !== backups ||
        !/^config\.env\.bak\.[A-Za-z0-9T_.-]+$/.test(path.basename(value.configBackupPath))) return false;
  }
  if (value.stateBackupDir !== undefined) {
    const backups = path.join(path.dirname(root), ".nexus", "backups");
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
  fs.renameSync(tmp, journalPath);
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
    const backupDir = path.join(homeDir, ".config", "nexus", "backups");
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
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
    const backupDest = path.join(stateBackupsDir, `state-backup-${timestamp}`);
    fs.mkdirSync(backupDest, { recursive: true, mode: 0o700 });

    // Copy session index if present
    const sessionIndex = path.join(stateDir, "sessions", "index.json");
    if (fs.existsSync(sessionIndex)) {
      const destIndex = path.join(backupDest, "session-index.json");
      fs.copyFileSync(sessionIndex, destIndex);
      fs.chmodSync(destIndex, 0o600);
    }

    result.stateBackupDir = backupDest;
  }

  return result;
}

/**
 * Restores configuration from a previous backup file.
 */
export function restoreConfigBackup(backupPath: string, homeDir: string = process.env.HOME || ""): boolean {
  if (!fs.existsSync(backupPath)) return false;
  const configDir = path.join(homeDir, ".config", "nexus");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const target = path.join(configDir, "config.env");
  fs.copyFileSync(backupPath, target);
  fs.chmodSync(target, 0o600);
  return true;
}

export interface RecoveryOutcome {
  recovered: boolean;
  action: "rolled_back" | "finalized" | "none" | "cleaned_up";
  details: string;
}

/**
 * Idempotent crash recovery: inspects journal and restores working installation or finalizes transition.
 */
export function recoverUpgrade(prefix: string): RecoveryOutcome {
  const journalPath = getJournalPath(prefix);
  const journal = readJournal(prefix);
  if (!journal && fs.existsSync(journalPath)) {
    return { recovered: false, action: "none", details: "Upgrade journal failed schema or path validation; no recovery action was taken." };
  }
  if (!journal || journal.state === "idle" || journal.state === "complete" || journal.state === "rolled_back") {
    return {
      recovered: false,
      action: "none",
      details: "No interrupted upgrade found in journal.",
    };
  }

  const { state, sourceInstallDir, targetInstallDir, stagingDir, binPath, sourceVersion, targetVersion } = journal;

  const libRoot = path.join(path.resolve(prefix), "lib", "nexus");
  if (!isRealDirectory(libRoot) || !isRealDirectory(path.dirname(binPath))) {
    return { recovered: false, action: "none", details: "Upgrade recovery roots are not real contained directories; no recovery action was taken." };
  }
  for (const installDir of [sourceInstallDir, targetInstallDir]) {
    if (fs.existsSync(installDir) && !isRealDirectory(installDir)) {
      return { recovered: false, action: "none", details: "An installation path is not a real directory; no recovery action was taken." };
    }
  }

  // Cleanup abandoned staging directory if exists
  if (stagingDir && fs.existsSync(stagingDir)) {
    if (!isRealDirectory(stagingDir) || path.dirname(path.resolve(stagingDir)) !== libRoot || fs.realpathSync(path.dirname(stagingDir)) !== libRoot) {
      return { recovered: false, action: "none", details: "Staging path is not a contained real directory; no recovery action was taken." };
    }
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch (err: any) {
      return { recovered: false, action: "none", details: `Could not safely remove staging directory: ${err.message}` };
    }
  }

  // If upgrade crashed during downloading, preparing, or staged (before symlink was touched):
  if (state === "preparing" || state === "downloading" || state === "staged" || state === "recovery_required") {
    // Symlink should point to source
    if (fs.existsSync(sourceInstallDir)) {
      atomicSymlinkSwap(path.join(sourceInstallDir, "bin", "nexus"), binPath);
    }
    journal.state = "rolled_back";
    journal.updatedAt = new Date().toISOString();
    writeJournal(prefix, journal);
    return {
      recovered: true,
      action: "cleaned_up",
      details: `Cleaned up incomplete upgrade to ${targetVersion}; active installation remains ${sourceVersion}.`,
    };
  }

  // If upgrade crashed during switching or switched:
  if (state === "switching" || state === "switched" || state === "verified") {
    // Check if target installation is intact and executable
    const targetExecutable = path.join(targetInstallDir, "bin", "nexus");
    let targetHealthy = false;
    if (fs.existsSync(targetExecutable)) {
      try {
        const testRes = spawnSync(targetExecutable, ["--version"]);
        if (testRes.status === 0) {
          targetHealthy = true;
        }
      } catch {}
    }

    if (targetHealthy) {
      // Finalize transition
      atomicSymlinkSwap(targetExecutable, binPath);
      journal.state = "complete";
      journal.updatedAt = new Date().toISOString();
      writeJournal(prefix, journal);
      return {
        recovered: true,
        action: "finalized",
        details: `Validated intact target installation at ${targetInstallDir}; finalized upgrade to ${targetVersion}.`,
      };
    } else {
      // Revert symlink to source installation
      const sourceExecutable = path.join(sourceInstallDir, "bin", "nexus");
      if (fs.existsSync(sourceExecutable)) {
        atomicSymlinkSwap(sourceExecutable, binPath);
        journal.state = "rolled_back";
        journal.updatedAt = new Date().toISOString();
        writeJournal(prefix, journal);
        return {
          recovered: true,
          action: "rolled_back",
          details: `Target installation at ${targetInstallDir} was incomplete; safely reverted link to ${sourceVersion}.`,
        };
      } else {
        journal.state = "recovery_required";
        journal.error = "Both source and target installations are unverified";
        journal.updatedAt = new Date().toISOString();
        writeJournal(prefix, journal);
        return {
          recovered: false,
          action: "none",
          details: `Manual intervention required: source ${sourceInstallDir} and target ${targetInstallDir} unreadable.`,
        };
      }
    }
  }

  return {
    recovered: false,
    action: "none",
    details: `Journal state is ${state}; no recovery action required.`,
  };
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

function atomicSymlinkSwap(targetFile: string, linkPath: string): void {
  const binDir = path.dirname(linkPath);
  fs.mkdirSync(binDir, { recursive: true });
  const tmpLink = path.join(binDir, `.nexus-link-recovery.${process.pid}.${Date.now()}`);
  try {
    fs.symlinkSync(targetFile, tmpLink);
    fs.renameSync(tmpLink, linkPath);
  } catch (err: any) {
    try {
      fs.unlinkSync(tmpLink);
    } catch {}
    throw err;
  }
}
