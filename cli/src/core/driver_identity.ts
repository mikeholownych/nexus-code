/**
 * Who is driving a durable operation, and whether that driver is still alive.
 *
 * A driver is recorded as {pid, host, start ticks, boot id}. An operation is "actively driven" only when every field is
 * present and names a live process of this host whose kernel start time equals the recorded one. Anything else
 * (a process that is gone, a recycled pid, another host or boot, a record without the full identity, a hand-edited
 * record) is stale: the operation resumes PAUSED with a specific reason, never silently running. Fails closed.
 *
 * Records written before `activeStartTicks` existed carry no start time; they are "identity unknown" and pause.
 * Identity comes from `/proc`, so off Linux nothing can be proven and an active record always pauses.
 */
import * as os from "node:os";
import { systemProcessIdentity, type ProcessIdentityReader } from "./process_identity.js";
import type { DurableOperationState } from "./operation.js";

export const STALE_PAUSE_PREFIX = "Paused on resume:";

export type StaleDriverCause = "process_gone" | "pid_recycled" | "other_host" | "other_boot" | "identity_unknown";

export interface StaleDriver {
  cause: StaleDriverCause;
  /** The operator-visible pause reason. */
  reason: string;
}

type DriverFields = Pick<DurableOperationState, "activePid" | "activeHost" | "activeBootId" | "activeStartTicks">;

/** Records this process as the driver (all four identity fields). */
export function stampDriver(state: DriverFields, reader: ProcessIdentityReader = systemProcessIdentity, host = os.hostname()): void {
  const boot = reader.bootId();
  const ticks = reader.startTicks(process.pid);
  if (boot) state.activeBootId = boot; else delete state.activeBootId;
  if (ticks) state.activeStartTicks = ticks; else delete state.activeStartTicks;
  state.activePid = process.pid;
  state.activeHost = host;
}

export function clearDriver(state: DriverFields): void {
  delete state.activePid;
  delete state.activeHost;
  delete state.activeBootId;
  delete state.activeStartTicks;
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function isUndriven(state: DurableOperationState): boolean {
  const anyIdentity = state.activePid !== undefined || state.activeHost !== undefined || state.activeBootId !== undefined || state.activeStartTicks !== undefined;
  // A plan nobody has started has no execution to reconcile, so its first driver may start it.
  return !anyIdentity && state.status === "RUNNING" && state.units.every((unit) => unit.status === "WAITING_ON_DEPENDENCY" && unit.runs === 0 && unit.agentTaskId === undefined);
}

/** The verdict for an operation that claims to be driven (RUNNING or WAITING); undefined when its driver is provably alive. */
export function staleDriver(state: DurableOperationState, reader: ProcessIdentityReader = systemProcessIdentity, host = os.hostname()): StaleDriver | undefined {
  if (state.status !== "RUNNING" && state.status !== "WAITING") return undefined;
  if (isUndriven(state)) return undefined;
  const stale = (cause: StaleDriverCause, detail: string): StaleDriver => ({
    cause,
    reason: `${STALE_PAUSE_PREFIX} ${detail}. The operation was not cleanly paused, so it is not resumed automatically; inspect it, then resume it explicitly.`,
  });
  const { activePid: pid, activeHost: recordedHost, activeBootId: recordedBoot, activeStartTicks: ticks } = state as { [K in keyof DriverFields]?: unknown };
  const boot = reader.bootId();
  if (isText(recordedBoot) && boot && recordedBoot !== boot) return stale("other_boot", `its driver ran before the last host reboot (boot ${recordedBoot.slice(0, 12)})`);
  if (isText(recordedHost) && recordedHost !== host) return stale("other_host", `its driver ran on another host (${recordedHost}), whose processes cannot be checked from here`);
  const validPid = typeof pid === "number" && Number.isInteger(pid) && pid > 0;
  // Whatever else is missing, a recorded pid that is not running at all is the most useful thing to say.
  if (validPid && boot && reader.startTicks(pid) === undefined) return stale("process_gone", `its driver process (pid ${pid}) is no longer running`);
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || !isText(recordedHost) || !isText(recordedBoot) || !isText(ticks) || !boot) {
    return stale("identity_unknown", "its driver identity is missing or incomplete (written by an earlier version, edited, or not provable on this platform), so it cannot be shown to be alive");
  }
  const now = reader.startTicks(pid);
  if (now === undefined) return stale("process_gone", `its driver process (pid ${pid}) is no longer running`);
  if (now !== ticks) return stale("pid_recycled", `pid ${pid} now belongs to a different process than its driver (the pid was recycled)`);
  return undefined;
}

/**
 * What a read-only view should show: the same state `driveOperation` would persist. A stale operation is reported
 * PAUSED with its reason (derived, nothing is written); anything else is returned as is.
 */
export function withDerivedPause<T extends DurableOperationState>(state: T, reader?: ProcessIdentityReader): T {
  const verdict = staleDriver(state, reader);
  if (!verdict) return state;
  return { ...state, status: "PAUSED", pauseReason: state.pauseReason ? `${state.pauseReason} ${verdict.reason}` : verdict.reason };
}

/** The pid of a recorded driver that is provably alive and is not this process, else undefined. The lock may be gone; the record still names it. */
export function liveForeignDriver(state: DurableOperationState, reader: ProcessIdentityReader = systemProcessIdentity, host = os.hostname()): number | undefined {
  if (state.status !== "RUNNING" && state.status !== "WAITING") return undefined;
  if (state.activePid === undefined || state.activePid === process.pid || isUndriven(state)) return undefined;
  return staleDriver(state, reader, host) ? undefined : state.activePid;
}
