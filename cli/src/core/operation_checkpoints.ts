/**
 * Durable context checkpoints for operation units. A checkpoint is a byte-for-byte copy of the unit's task-state file
 * (its whole conversation and objective state); restoring it puts that conversation back and makes the unit runnable.
 * Restoring is fail-closed by construction: the agent's recovery path treats a resumed task as unverified, so the
 * operator gets the context back but not the old verification standing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { writePrivateFile } from "./durable_file.js";
import type { ContextCheckpoint, DurableOperationState } from "./operation.js";

export class ContextCheckpointError extends Error {}

const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const TASK_ID = /^[A-Za-z0-9._-]{1,160}$/;

function slug(value: string): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";
  return `${clean}-${createHash("sha256").update(value).digest("hex").slice(0, 8)}`;
}

export function checkpointDir(baseDir: string, operationId: string): string {
  return path.join(baseDir, "context-checkpoints", slug(operationId));
}

export function checkpointFile(baseDir: string, operationId: string, unitId: string, name: string): string {
  return path.join(checkpointDir(baseDir, operationId), `${slug(unitId)}--${name}.json`);
}

export function listContextCheckpoints(state: DurableOperationState): ContextCheckpoint[] {
  return [...(state.contextCheckpoints ?? [])];
}

interface TaskStore {
  getBaseDir(): string;
}

function taskFile(store: TaskStore, taskId: string): string {
  if (!TASK_ID.test(taskId)) throw new ContextCheckpointError(`task id '${taskId}' is not usable as a file name`);
  return path.join(store.getBaseDir(), `${taskId}.json`);
}

/** Snapshot a settled unit's conversation. Running units are refused: their state file is being written. */
export function createContextCheckpoint(
  store: TaskStore,
  state: DurableOperationState,
  unitId: string,
  name: string,
  now: number = Date.now(),
): ContextCheckpoint {
  if (!NAME.test(name)) {
    throw new ContextCheckpointError(`invalid checkpoint name '${name}': use letters, digits, '.', '_' or '-' (max 64)`);
  }
  const unit = state.units.find((entry) => entry.id === unitId);
  if (!unit) throw new ContextCheckpointError(`unit '${unitId}' is not part of operation ${state.id}`);
  if (unit.status === "RUNNING") {
    throw new ContextCheckpointError(`unit '${unitId}' is running; checkpoint it when the turn has settled`);
  }
  if (!unit.agentTaskId) throw new ContextCheckpointError(`unit '${unitId}' has no durable conversation yet`);
  const source = taskFile(store, unit.agentTaskId);
  if (!fs.existsSync(source)) throw new ContextCheckpointError(`unit '${unitId}' has no task state at ${source}`);

  const data = fs.readFileSync(source);
  let messages = 0;
  try {
    const parsed = JSON.parse(data.toString("utf8"));
    messages = Array.isArray(parsed?.messages) ? parsed.messages.length : 0;
  } catch {
    throw new ContextCheckpointError(`unit '${unitId}' has unreadable task state; refusing to checkpoint it`);
  }

  const destination = checkpointFile(store.getBaseDir(), state.id, unitId, name);
  writePrivateFile(destination, data, { durable: true });
  const record: ContextCheckpoint = {
    unitId,
    name,
    at: new Date(now).toISOString(),
    taskId: unit.agentTaskId,
    messages,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
  state.contextCheckpoints = [
    ...(state.contextCheckpoints ?? []).filter((entry) => !(entry.unitId === unitId && entry.name === name)),
    record,
  ];
  return record;
}

/**
 * Restore a checkpoint over the unit's task state, keeping the pre-restore file as a backup. The unit becomes runnable
 * and the operation runnable; the next resume recovers the restored conversation as unverified (fail-closed).
 */
export function restoreContextCheckpoint(
  store: TaskStore,
  state: DurableOperationState,
  unitId: string,
  name: string,
  now: number = Date.now(),
): { record: ContextCheckpoint; backup?: string } {
  const record = (state.contextCheckpoints ?? []).find((entry) => entry.unitId === unitId && entry.name === name);
  if (!record) throw new ContextCheckpointError(`no checkpoint '${name}' for unit '${unitId}'`);
  const unit = state.units.find((entry) => entry.id === unitId);
  if (!unit) throw new ContextCheckpointError(`unit '${unitId}' is not part of operation ${state.id}`);
  if (state.status === "COMPLETE" || state.status === "CANCELLED") {
    throw new ContextCheckpointError(`operation ${state.id} is ${state.status}; a checkpoint cannot revive it`);
  }
  if (unit.status === "RUNNING") {
    throw new ContextCheckpointError(`unit '${unitId}' is running; restore it when the turn has settled`);
  }
  if (unit.status === "COMPLETE") {
    throw new ContextCheckpointError(`unit '${unitId}' is complete; restore a checkpoint before it completes`);
  }
  if (unit.dropped) throw new ContextCheckpointError(`unit '${unitId}' was dropped by the operator`);
  const source = checkpointFile(store.getBaseDir(), state.id, unitId, name);
  if (!fs.existsSync(source)) throw new ContextCheckpointError(`checkpoint file is missing: ${source}`);
  const data = fs.readFileSync(source);
  if (createHash("sha256").update(data).digest("hex") !== record.sha256) {
    throw new ContextCheckpointError(`checkpoint '${name}' does not match its recorded hash; refusing to restore it`);
  }
  const target = taskFile(store, record.taskId);

  let backup: string | undefined;
  if (fs.existsSync(target)) {
    // Backups live with the checkpoints, not beside the live task files: a stray `*.json` there would appear as a
    // duplicate task and be eligible for retention pruning.
    backup = path.join(checkpointDir(store.getBaseDir(), state.id), "backups", `${slug(unitId)}--${name}--${now}.json`);
    writePrivateFile(backup, fs.readFileSync(target), { durable: true });
  }
  writePrivateFile(target, data, { durable: true });

  unit.agentTaskId = record.taskId;
  unit.status = "RUNNABLE";
  delete unit.blocked;
  delete unit.parked;
  delete unit.result;
  delete unit.pendingDecision;
  // Only this unit's escalation is resolved; an operation-level decision (for example the git or not-converging guard)
  // is not the operator's consent to clear it.
  const remaining = (state.blocked?.decisions ?? []).filter((decision) => decision.unitId !== unitId);
  if (remaining.length) state.blocked = { since: state.blocked!.since, decisions: remaining };
  else delete state.blocked;
  delete state.wait;
  state.status = "RUNNING";
  return { record, ...(backup ? { backup } : {}) };
}
