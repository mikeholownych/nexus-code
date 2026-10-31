/** Durable operation storage and per-operation process locks. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { credentialStorageHome } from "../client.js";
import { AccountIdentityError, createOperationAccountIdentity, isLegacyCredentialFingerprint, type OperationAccountIdentity } from "./account_identity.js";
import type { DurableOperationState } from "./operation.js";
import { CURRENT_OPERATION_SCHEMA_VERSION, InvalidOperationStateError, LEGACY_OPERATION_SCHEMA_VERSION, migrateOperationState, needsMigrationBackup, UnsupportedOperationSchemaError } from "./operation_schema.js";
import { writePrivateFile } from "./durable_file.js";
import { DurableStateManager, type DurableTaskState } from "./state.js";
import { WorkspacePath } from "./workspace_path.js";
import { reportOperationDiagnostic, type OperationDiagnosticHandler } from "./operation_runner_diagnostics.js";

// ---------------------------------------------------------------- persistence

const LIFECYCLE: Record<DurableOperationState["status"], DurableTaskState["status"]> = {
  RUNNING: "in_progress",
  WAITING: "in_progress",
  BLOCKED: "in_progress",
  COMPLETE: "completed",
  CANCELLED: "interrupted",
};

/** Operations are durable tasks: the same atomic, workspace-bound task store that turn recovery uses. */
export class OperationStore {
  private readonly onDiagnostic?: OperationDiagnosticHandler;
  readonly manager: DurableStateManager;
  private readonly workspace: WorkspacePath;
  private readonly accountIdentityHome: string;

  /** `baseDir` defaults to the task store turn recovery uses (~/.nexus/tasks). */
  constructor(workspace: string, baseDir?: string, accountIdentityHome = credentialStorageHome(), onDiagnostic?: OperationDiagnosticHandler) {
    this.onDiagnostic = onDiagnostic;
    this.workspace = WorkspacePath.fromSelectedWorkspace(path.resolve(workspace));
    this.manager = new DurableStateManager({ ...(baseDir ? { baseDir } : {}), workspacePaths: [this.workspace] });
    this.accountIdentityHome = accountIdentityHome;
  }

  private preflightFutureVersion(id: string): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.manager.getStateFilePath(id), "utf8"));
      const version = raw?.operation?.schemaVersion;
      if (typeof version === "number" && version > CURRENT_OPERATION_SCHEMA_VERSION) throw new UnsupportedOperationSchemaError(version);
    } catch (error) {
      if (error instanceof UnsupportedOperationSchemaError) throw error;
      // Missing, unreadable and malformed records retain the state manager's established error and quarantine paths.
    }
  }

  save(op: DurableOperationState): void {
    this.preflightFutureVersion(op.id);
    op = migrateLegacyAccountIdentities(op, createOperationAccountIdentity(this.accountIdentityHome));
    const existing = this.manager.hasTaskState(op.id) ? this.manager.loadTaskState(op.id) : undefined;
    // A newer operation document is never overwritten by an older build. Writing over it would destroy the only copy
    // a later build can read, which is exactly what the load gate refuses to do.
    const onDisk = existing?.operation?.schemaVersion;
    if (typeof onDisk === "number" && onDisk > CURRENT_OPERATION_SCHEMA_VERSION) throw new UnsupportedOperationSchemaError(onDisk);
    // A v1.0.0 operation document is upgraded by this write. Keep the record this build cannot re-create, once,
    // before the first v2 write, so an operator can diff or restore it. The envelope's own migration backup is a
    // different file and a different concern.
    if (existing?.operation && needsMigrationBackup(onDisk)) {
      this.backupBeforeMigration(op.id, typeof onDisk === "number" ? onDisk : LEGACY_OPERATION_SCHEMA_VERSION);
    }
    const state: DurableTaskState = {
      schemaVersion: 1,
      taskId: op.id,
      sessionId: op.id,
      id: op.id,
      title: `Operation: ${op.objective.slice(0, 80)}`,
      workspacePath: this.workspace.value,
      workspace: this.workspace.value,
      createdAt: existing?.createdAt ?? op.createdAt,
      updatedAt: op.updatedAt,
      status: LIFECYCLE[op.status],
      activePlan: op.units.map((u) => ({ name: u.title, status: u.status === "COMPLETE" ? "completed" : u.status === "RUNNING" ? "in_progress" : "pending", detail: u.status })),
      milestones: existing?.milestones ?? [],
      validationReceipts: [],
      messages: [],
      currentOperation: null,
      operation: op,
    };
    this.manager.saveTaskState(state, [this.workspace]);
  }

  load(id: string): DurableOperationState {
    this.preflightFutureVersion(id);
    const state = this.manager.loadTaskState(id, this.workspace.value, [this.workspace]);
    if (!state.operation) throw new Error(`Task ${id} is not an operation`);
    let migrated: DurableOperationState;
    try {
      migrated = migrateOperationState(state.operation);
    } catch (error) {
      if (!(error instanceof InvalidOperationStateError)) throw error;
      // Structurally invalid is the operation-document analogue of an unparseable envelope: quarantine it and report
      // where it went, rather than leaving a record that will keep failing every later load.
      const quarantined = this.manager.quarantineFile(this.manager.getStateFilePath(id));
      throw new Error(`Operation ${id} is invalid: ${error.message} (quarantined to ${quarantined})`);
    }
    return migrateLegacyAccountIdentities(migrated, createOperationAccountIdentity(this.accountIdentityHome));
  }

  /** Status/export callers migrate legacy IDs on disk only when they can hold the operation lock. */
  loadForInspection(id: string): DurableOperationState {
    let release: (() => void) | undefined;
    try {
      release = this.acquire(id);
    } catch (error) {
      if (!(error instanceof OperationLockedError)) throw error;
    }
    try {
      const operation = this.load(id);
      if (release) this.save(operation);
      return operation;
    } finally {
      release?.();
    }
  }

  list(): DurableOperationState[] {
    const out: DurableOperationState[] = [];
    for (const t of this.manager.listTasks()) {
      if (!t.title.startsWith("Operation: ")) continue;
      try {
        out.push(this.load(t.taskId));
      } catch (error) {
        // A record from a newer build is a real condition the operator must see, not a record to skip silently.
        if (error instanceof AccountIdentityError || error instanceof UnsupportedOperationSchemaError) throw error;
      }
    }
    return out;
  }

  /** Status/export listing persists each legacy migration only when its operation lock is available. */
  listForInspection(): DurableOperationState[] {
    const out: DurableOperationState[] = [];
    for (const task of this.manager.listTasks()) {
      if (!task.title.startsWith("Operation: ")) continue;
      try {
        out.push(this.loadForInspection(task.taskId));
      } catch (error) {
        if (error instanceof AccountIdentityError || error instanceof UnsupportedOperationSchemaError) throw error;
      }
    }
    return out;
  }

  /**
   * One driver per operation: a second process resuming it would execute its units twice. The lock names the
   * holder's pid; a lock whose holder on this host is gone is stale and taken over. Returns the release function.
   */
  acquire(id: string): () => void {
    const lockPath = path.join(this.manager.getBaseDir(), `${id}.lock`);
    const create = () => fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }), { flag: "wx" });
    try {
      create();
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      let holder: { pid?: number; host?: string; at?: string } = {};
      try {
        holder = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      } catch {
        reportOperationDiagnostic(this.onDiagnostic, "persistence", "lock_read_failed");
      }
      // A lock written before this host last booted is stale even if its pid has since been reused.
      const beforeBoot = holder.at !== undefined && Date.parse(holder.at) < Date.now() - os.uptime() * 1000;
      if (holder.host !== os.hostname() || (!beforeBoot && holder.pid !== undefined && processAlive(holder.pid))) {
        throw new OperationLockedError(`Operation ${id} is already being driven by pid ${holder.pid ?? "?"} on ${holder.host ?? "?"} (lock ${lockPath}).`);
      }
      fs.rmSync(lockPath, { force: true });
      create();
    }
    return () => {
      try {
        if (JSON.parse(fs.readFileSync(lockPath, "utf-8")).pid === process.pid) fs.rmSync(lockPath, { force: true });
      } catch {
        reportOperationDiagnostic(this.onDiagnostic, "persistence", "lock_release_failed");
      }
    };
  }

  /** Most recently updated operation in this workspace that is waiting or running (to resume after restart). */
  latestResumable(): DurableOperationState | undefined {
    return this.list().find((op) => op.status === "WAITING" || op.status === "RUNNING");
  }

  /**
   * Keeps the record this build is about to upgrade, once. Refuses to overwrite an existing copy whose bytes differ:
   * an earlier migration already produced it, and silently replacing it would destroy the only v1 evidence.
   */
  private backupBeforeMigration(id: string, fromVersion: unknown): void {
    const record = path.join(this.manager.getBaseDir(), `${id}.json`);
    const backup = `${record}.pre-migration-v${String(fromVersion)}`;
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(record);
    } catch (error: any) {
      // The record was just read to decide this backup was needed; its absence is a real problem, not a reason to skip.
      throw new Error(`Operation ${id}: cannot read ${record} to keep a pre-migration copy (${String(error?.message ?? error)})`);
    }
    if (fs.existsSync(backup)) {
      const existing = fs.readFileSync(backup);
      if (!existing.equals(bytes)) {
        throw new Error(
          `Operation ${id}: cannot migrate the operation record because ${backup} already exists with different content. ` +
            `Move it aside to continue, or restore it to read the record with the build that wrote it.`,
        );
      }
      return;
    }
    writePrivateFile(backup, bytes, { durable: true, mode: 0o600 });
  }
}

export class OperationLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationLockedError";
  }
}

/** Re-key legacy short hashes without changing which resources share an account-scoped condition. */
export function migrateLegacyAccountIdentities(
  operation: DurableOperationState,
  identity: OperationAccountIdentity,
): DurableOperationState {
  // Schema-1 records do not retain whether an old 12-hex account value came
  // from the CLI label or the former credential hash. Preserve explicitly
  // marked labels; migrate unmarked 12-hex values as legacy credential IDs.
  const explicitAccounts = new Set(
    operation.resources.filter((resource) => resource.accountIdentitySource === "explicit" && resource.account).map((resource) => resource.account!),
  );
  const explicitAccountConditionKeys = new Set(
    operation.resources
      .filter((resource) => resource.accountIdentitySource === "explicit" && resource.account)
      .map((resource) => `${resource.provider}|account|${resource.account}`),
  );
  const migrated = new Map<string, string>();
  const replacement = (value: string): string => {
    if (explicitAccounts.has(value) || !isLegacyCredentialFingerprint(value)) return value;
    let mapped = migrated.get(value);
    if (!mapped) {
      mapped = identity.migrateLegacy(value, operation.id);
      migrated.set(value, mapped);
    }
    return mapped;
  };

  for (const resource of operation.resources) {
    if (resource.account) resource.account = replacement(resource.account);
  }
  for (const condition of operation.conditions) {
    if (condition.scope !== "account") continue;
    // Account labels are arbitrary strings and may themselves contain `|account|`; preserve the full key for
    // explicitly labeled resources instead of parsing the final delimiter as a structural boundary.
    if (explicitAccountConditionKeys.has(condition.key)) continue;
    const marker = "|account|";
    const markerAt = condition.key.lastIndexOf(marker);
    if (markerAt < 0) continue;
    const oldAccount = condition.key.slice(markerAt + marker.length);
    const newAccount = replacement(oldAccount);
    if (newAccount !== oldAccount) condition.key = `${condition.key.slice(0, markerAt + marker.length)}${newAccount}`;
  }
  return operation;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}
