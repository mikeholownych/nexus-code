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
    if (data && data.formatVersion === 1 && typeof data.state === "string") {
      return data as UpgradeJournalEntry;
    }
  } catch {}
  return null;
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
  const journal = readJournal(prefix);
  if (!journal || journal.state === "idle" || journal.state === "complete" || journal.state === "rolled_back") {
    return {
      recovered: false,
      action: "none",
      details: "No interrupted upgrade found in journal.",
    };
  }

  const { state, sourceInstallDir, targetInstallDir, stagingDir, binPath, sourceVersion, targetVersion } = journal;

  // Cleanup abandoned staging directory if exists
  if (stagingDir && fs.existsSync(stagingDir)) {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
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
