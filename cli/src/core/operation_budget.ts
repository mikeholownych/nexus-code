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
import { MAX_OPERATION_ACTIVE_MS, MAX_OPERATION_INFERENCE_SUBMISSIONS, MAX_TOTAL_TOKENS } from "./operation_schema.js";
import type { OperationStore } from "./operation_runner_persistence.js";

export const MAX_OPERATION_ACTIVE_MINUTES = MAX_OPERATION_ACTIVE_MS / 60_000;

/** Parses `N` or `none`; anything else is a usage error. */
export function parseTokenCap(text: string): number | undefined {
  if (text.trim().toLowerCase() === "none") return undefined;
  if (!/^[0-9]+$/.test(text.trim())) throw new Error(`--max-total-tokens must be a whole number from 1 to ${MAX_TOTAL_TOKENS}, or 'none' (got '${text}')`);
  const value = Number(text.trim());
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TOTAL_TOKENS) throw new Error(`--max-total-tokens must be a whole number from 1 to ${MAX_TOTAL_TOKENS}, or 'none' (got '${text}')`);
  return value;
}

/** Parses a finite operation active-time cap in whole minutes. Removing the cap is never allowed. */
export function parseActiveMinutesCap(text: string): number {
  const trimmed = text.trim();
  if (!/^[0-9]+$/.test(trimmed)) throw new Error(`--max-total-active-minutes must be a whole number from 1 to ${MAX_OPERATION_ACTIVE_MINUTES} (got '${text}')`);
  const minutes = Number(trimmed);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_OPERATION_ACTIVE_MINUTES) {
    throw new Error(`--max-total-active-minutes must be a whole number from 1 to ${MAX_OPERATION_ACTIVE_MINUTES} (got '${text}')`);
  }
  return minutes * 60_000;
}

/** Parses a required finite operation-wide provider request cap. */
export function parseInferenceSubmissionCap(text: string): number {
  const trimmed = text.trim();
  if (!/^[0-9]+$/.test(trimmed)) throw new Error(`--max-total-inference-submissions must be a whole number from 1 to ${MAX_OPERATION_INFERENCE_SUBMISSIONS} (got '${text}')`);
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_OPERATION_INFERENCE_SUBMISSIONS) {
    throw new Error(`--max-total-inference-submissions must be a whole number from 1 to ${MAX_OPERATION_INFERENCE_SUBMISSIONS} (got '${text}')`);
  }
  return value;
}

export interface OperationBudgetChanges {
  maxTotalTokens?: number | undefined;
  maxTotalActiveMs?: number;
  maxInferenceCalls?: number;
  resetInferenceSubmissionHistory?: boolean;
}

export function setOperationBudget(store: OperationStore, id: string, changes: OperationBudgetChanges, now: () => number = Date.now): DurableOperationState {
  const changesTokens = Object.hasOwn(changes, "maxTotalTokens");
  const changesInference = changes.maxInferenceCalls !== undefined;
  if (!changesTokens && changes.maxTotalActiveMs === undefined && !changesInference) {
    throw new Error("At least one operation budget cap must be supplied.");
  }
  if (changes.resetInferenceSubmissionHistory && !changesInference) {
    throw new Error("--reset-inference-submission-history requires --max-total-inference-submissions.");
  }
  if (changes.maxTotalActiveMs !== undefined && (!Number.isSafeInteger(changes.maxTotalActiveMs) || changes.maxTotalActiveMs < 1 || changes.maxTotalActiveMs > MAX_OPERATION_ACTIVE_MS)) {
    throw new Error(`Operation active-time cap must be a whole number of minutes from 1 to ${MAX_OPERATION_ACTIVE_MINUTES}.`);
  }
  const release = store.acquire(id);
  try {
    const state = store.load(id);
    if (state.status === "COMPLETE" || state.status === "CANCELLED") throw new Error(`operation ${id} is ${state.status}; its budget can no longer change`);
    const previousTokens = state.policy.maxTotalTokens;
    const previousActive = state.policy.maxTotalActiveMs;
    const previousInferenceCap = state.policy.maxInferenceCalls;
    const previousInferenceCount = state.inferenceCalls;
    const previousInferenceHistoryComplete = state.historyKnown;
    if (changesInference && !state.historyKnown && !changes.resetInferenceSubmissionHistory) {
      throw new Error(`operation ${id} has unknown historical inference usage; supply --reset-inference-submission-history with the new cap to explicitly start a bounded accounting epoch`);
    }
    if (changesInference && (!Number.isSafeInteger(changes.maxInferenceCalls) || changes.maxInferenceCalls! < 1 || changes.maxInferenceCalls! > MAX_OPERATION_INFERENCE_SUBMISSIONS)) {
      throw new Error(`Operation inference submission cap must be a whole number from 1 to ${MAX_OPERATION_INFERENCE_SUBMISSIONS}.`);
    }
    if (changesTokens) {
      if (changes.maxTotalTokens === undefined) delete state.policy.maxTotalTokens;
      else state.policy.maxTotalTokens = changes.maxTotalTokens;
    }
    if (changes.maxTotalActiveMs !== undefined) state.policy.maxTotalActiveMs = changes.maxTotalActiveMs;
    if (changesInference) state.policy.maxInferenceCalls = changes.maxInferenceCalls!;
    if (changes.resetInferenceSubmissionHistory) {
      state.inferenceCalls = 0;
      state.historyKnown = true;
    }
    const at = new Date(now()).toISOString();
    const who = (() => { try { return os.userInfo().username; } catch { return "unknown"; } })();
    const inferenceChangeSummary = changes.resetInferenceSubmissionHistory
      ? `starting a new accounting epoch (previous count ${previousInferenceCount}; previous history complete: ${previousInferenceHistoryComplete})`
      : `consumed ${state.inferenceCalls}`;
    state.updatedAt = at;
    state.events.push({
      type: "OPERATION_BUDGET_CHANGED",
      at,
      message: `Operator changed operation budget caps (tokens ${previousTokens ?? "none"} to ${state.policy.maxTotalTokens ?? "none"}; active time ${Math.floor(previousActive / 60_000)} to ${Math.floor(state.policy.maxTotalActiveMs / 60_000)} minutes; inference submissions ${previousInferenceCap} to ${state.policy.maxInferenceCalls}, ${inferenceChangeSummary}).`,
      detail: {
        by: who,
        pid: process.pid,
        // Preserve the original token-cap journal fields for existing consumers.
        from: previousTokens ?? null,
        to: state.policy.maxTotalTokens ?? null,
        previousMaxTotalTokens: previousTokens ?? null,
        maxTotalTokens: state.policy.maxTotalTokens ?? null,
        previousMaxTotalActiveMs: previousActive,
        maxTotalActiveMs: state.policy.maxTotalActiveMs,
        priorMaxCalls: previousInferenceCap,
        maxInferenceCalls: state.policy.maxInferenceCalls,
        priorCalls: previousInferenceCount,
        inferenceCalls: state.inferenceCalls,
        historyWasKnown: previousInferenceHistoryComplete,
        historyKnown: state.historyKnown,
        inferenceReset: Boolean(changes.resetInferenceSubmissionHistory),
      },
    });
    if (state.events.length > 300) state.events.splice(0, state.events.length - 300);
    store.save(state);
    return state;
  } finally {
    release();
  }
}

export function setOperationTokenCap(store: OperationStore, id: string, cap: number | undefined, now: () => number = Date.now): DurableOperationState {
  return setOperationBudget(store, id, { maxTotalTokens: cap }, now);
}
