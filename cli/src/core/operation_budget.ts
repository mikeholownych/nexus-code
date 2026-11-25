/**
 * Operator command behind `nexus operation budget`: tighten, loosen or remove an operation's token cap.
 *
 * The cap is `policy.maxTotalTokens`. It is checked before every dispatch against the rolled-up child token totals, so
 * a change applies from the next dispatch. A change is an audited operator decision: who, when, old and new value go
 * into the operation's event journal. It takes the driver lock, so a record a live driver holds in memory is never
 * rewritten under it (the command is refused until that driver stops). It does not resume a goal paused on the old cap;
 * resuming stays the operator's separate step.
 */
import * as os from "node:os";
import type { DurableOperationState } from "./operation.js";
import { MAX_TOTAL_TOKENS } from "./operation_schema.js";
import type { OperationStore } from "./operation_runner_persistence.js";

/** Parses `N` or `none`; anything else is a usage error. */
export function parseTokenCap(text: string): number | undefined {
  if (text.trim().toLowerCase() === "none") return undefined;
  if (!/^[0-9]+$/.test(text.trim())) throw new Error(`--max-total-tokens must be a whole number from 1 to ${MAX_TOTAL_TOKENS}, or 'none' (got '${text}')`);
  const value = Number(text.trim());
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TOTAL_TOKENS) throw new Error(`--max-total-tokens must be a whole number from 1 to ${MAX_TOTAL_TOKENS}, or 'none' (got '${text}')`);
  return value;
}

export function setOperationTokenCap(store: OperationStore, id: string, cap: number | undefined, now: () => number = Date.now): DurableOperationState {
  const release = store.acquire(id);
  try {
    const state = store.load(id);
    if (state.status === "COMPLETE" || state.status === "CANCELLED") throw new Error(`operation ${id} is ${state.status}; its budget can no longer change`);
    const previous = state.policy.maxTotalTokens;
    if (cap === undefined) delete state.policy.maxTotalTokens; else state.policy.maxTotalTokens = cap;
    const at = new Date(now()).toISOString();
    const who = (() => { try { return os.userInfo().username; } catch { return "unknown"; } })();
    state.updatedAt = at;
    state.events.push({
      type: "OPERATION_BUDGET_CHANGED",
      at,
      message: `Operator changed the token cap from ${previous ?? "none"} to ${cap ?? "none"}.`,
      detail: { by: who, pid: process.pid, from: previous ?? null, to: cap ?? null },
    });
    if (state.events.length > 300) state.events.splice(0, state.events.length - 300);
    store.save(state);
    return state;
  } finally {
    release();
  }
}
