/**
 * The objective ledger: what the operator asked for, and how far the work has got against it.
 *
 * The plan (`update_plan`) is the agent's own roadmap and may be coarser than the request. The ledger keeps the
 * request itself — verbatim — and the acceptance criteria seeded from it, so a reduced plan can never stand in for
 * them. Requirements change state only with evidence, scope changes are recorded explicitly, operator steering is
 * kept until applied, and verifier attempts are remembered against the exact workspace inputs they ran on.
 *
 * Pure data and pure functions; the agent owns persistence and presentation.
 */
import { createHash } from "node:crypto";
import type { VerificationStatus } from "./turn.js";
import { DEFAULT_CONVERGENCE_ATTEMPTS } from "../types.js";
import type { CanonicalCapability } from "./capabilities.js";
import { isFilteredVerifierCommand } from "../tester.js";
import { redactSecrets } from "../ui.js";
import { visibleControls } from "../file_diff.js";
import { createTracking, ExecutionTracker, normalizeTracking, type ExecutionTracking } from "./execution_tracking.js";

export const LEDGER_VERSION = 1;
export const PINNED_LEDGER_PREFIX = "[Objective Ledger - pinned by Nexus; never summarised]";
export const STEERING_PREFIX = "[Operator steering";
/** Objectives longer than this are pinned in full only while the original message has left the context. */
export const MAX_PINNED_OBJECTIVE_CHARS = 24_000;
/** Operator follow-ups and steering pinned verbatim, newest first, up to this many characters (or the block's budget). */
const MAX_PINNED_OPERATOR_CHARS = 12_000;
const MAX_REQUIREMENT_TEXT = 240;
const MAX_EVIDENCE_ITEMS = 6;
const MAX_EVIDENCE_CHARS = 300;
const MAX_VERIFIER_CHARS = 400;
const MAX_TEST_LINKS = 6;
const MAX_TEST_LINK_CHARS = 120;

export type RequirementKind = "feature" | "constraint" | "invariant";
const REQUIREMENT_KINDS: readonly string[] = ["feature", "constraint", "invariant"];

/** Verifier and test-link text comes from the operator or the model: one line, no control characters, capped. */
const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
const cleanLine = (text: string, max: number) => clip(oneLine(text), max);
/** Text shown in the pinned ledger as a code span: nothing inside it can read as ledger structure. */
const span = (text: string, max: number) => `\`${cleanLine(text, max).replace(/`/g, "'")}\``;

/** A command that exits 0 whatever the workspace holds checks nothing. */
export function isConstantVerifier(command: string): boolean {
  return /^(?:true|:|exit\s+0|\/(?:usr\/)?bin\/true)$/.test(command.trim().replace(/\s*;+\s*$/, ""));
}

/** Constraints and invariants hold for the whole task; unlike a feature they are not done on the model's word. */
export function isHardRequirement(r: Pick<Requirement, "kind">): boolean {
  return r.kind === "constraint" || r.kind === "invariant";
}

/** Claimed implemented, but neither verified by its own verifier nor accepted by the operator. */
function unverifiedHard(r: Requirement): boolean {
  return isHardRequirement(r) && r.status === "implemented" && r.operatorAccepted !== true;
}

export type RequirementStatus = "open" | "in_progress" | "implemented" | "verified" | "blocked" | "descoped";
/** Statuses that need no further work in this task. `blocked` is terminal for the turn but never "done". */
export const DONE_STATUSES: ReadonlySet<RequirementStatus> = new Set(["implemented", "verified", "descoped"]);

/**
 * Done for the purpose of completion. Descoping reduces what the operator asked for, so only the operator can make
 * it count: a descoped operator or steering requirement stays unresolved until `operatorAccepted` is set (by the
 * operator's `/requirements accept`), while a sub-requirement the agent added itself may be descoped freely.
 */
export function requirementDone(r: Requirement): boolean {
  if (r.status === "verified") return true;
  if (r.status === "implemented") return !unverifiedHard(r);
  return r.status === "descoped" && (r.source === "model" || r.operatorAccepted === true);
}

export interface Requirement {
  id: string;
  /** Heading line (capped), for lists. */
  text: string;
  /** The requirement's complete wording from the operator's message (nested items included), never truncated. */
  detail?: string;
  status: RequirementStatus;
  /** Absent means a feature (ledgers written before typed requirements). */
  kind?: RequirementKind;
  /** Command that checks a constraint or invariant; `verified` needs a passing run of it after the last change. */
  verifier?: string;
  /** Who set the verifier. One the model declared is advisory: its run is evidence, never `verified`. */
  verifierSource?: "operator" | "model";
  /** Tests (names or paths) that exercise this requirement. */
  tests?: string[];
  /** Where it came from: the operator's objective, operator steering, or the model (added sub-requirement). */
  source: "objective" | "steering" | "model";
  /** Implementation and validation evidence (file paths, commands, test names). */
  evidence: string[];
  /** Reason for blocked/descoped; required for both. */
  note?: string;
  /** The operator accepted this requirement's descoping (only the operator's own command sets this). */
  operatorAccepted?: boolean;
  /**
   * The passing verifier run that a `verified` status rests on, recorded on the then-current workspace. Nexus can
   * show that this run passed on these inputs; it cannot prove the verifier exercises this particular requirement.
   */
  verifiedBy?: { attempt: number; command: string; inputs: string; at: string };
  updatedAt: string;
}

export interface ScopeChange {
  at: string;
  requirement: string;
  from: RequirementStatus;
  to: RequirementStatus;
  reason: string;
}

export interface SteeringRecord {
  id: string;
  text: string;
  receivedAt: string;
  status: "queued" | "applied" | "cancelled";
  appliedAt?: string;
  appliedAtStep?: number;
}

/** Steering that negates a requirement: held out of the conversation and the ledger until the operator decides. */
export interface SteeringConflict {
  id: string;
  text: string;
  requirements: string[];
  receivedAt: string;
  /** `unresolved`: no operator was available, so the ledger is unchanged and the negation was not applied. */
  status: "pending" | "approved" | "declined" | "unresolved";
  decidedAt?: string;
}

/** Requirements of an earlier objective still unmet when a new request replaced it; the operator decides what happens to them. */
export interface SupersededObjective {
  at: string;
  objective: string;
  objectiveSha256: string;
  requirements: Array<{ id: string; text: string; status: RequirementStatus }>;
  status: "pending_decision";
}

export interface VerificationAttempt {
  n: number;
  command: string;
  /** Candidate identity of the workspace the verifier ran on (tracked and untracked, non-ignored files). */
  inputs: string;
  /**
   * What else must be unchanged before a prior failure is reused: the agent process that ran it, the count of
   * mutating tool calls (any edit, write or shell command) at that time, and a fingerprint of inputs git ignores
   * (PATH, dependency install markers, .env files).
   */
  epoch?: string;
  mutationSeq?: number;
  external?: string;
  status: VerificationStatus | "SKIPPED_UNCHANGED_INPUTS";
  isDeliverableBound?: boolean;
  /** False when the run passed but nothing independent of the agent shows the change (see core/independent_check). */
  independent?: boolean;
  filtered?: boolean;
  /** Set when the run was a constraint's own verifier: it is evidence for that requirement only, never a general test run. */
  requirementId?: string;
  at: string;
  /** First failing line of the verifier's output, when it failed. */
  failedCheck?: string;
  /** ENVIRONMENT: the verifier could not run (tool missing, exit 126/127, sandbox error); it says nothing about the candidate. */
  classification?: "ENVIRONMENT" | "CANDIDATE_FAILED";
  /** The verifier process's exit code; absent when it never ran or was killed. */
  exitCode?: number;
  /** Names of the failing tests (redacted, capped). */
  failingTests?: string[];
  /** How many distinct failing tests the run named, uncapped (up to MAX_COUNTED_FAILING_TESTS); absent on older attempts. */
  failingTotal?: number;
  /** True when `failingTests` holds fewer names than the run reported. */
  failingTruncated?: boolean;
  /** Redacted tail of the verifier's output, capped at MAX_ATTEMPT_EXCERPT_BYTES. */
  excerpt?: string;
}

export interface ObjectiveOutcome {
  status: "completed" | "incomplete" | "blocked";
  reason: string;
  failedCheck?: string;
  remaining: string[];
  nextAction?: string;
  at: string;
}

export interface ContinuationState {
  /** Segments of `segmentSteps` steps the current turn has run (1 for an ordinary turn). */
  segments: number;
  /** Steps run against this objective across turns. */
  totalSteps: number;
  /** Step (within the current turn) of the last observed progress. */
  lastProgressStep: number;
  stopReason?: string;
}

export interface ObjectiveLedger {
  version: number;
  /** Work unit id when this ledger is scoped to a work unit in an operation or team (REQ-AGT-102/103). */
  unitId?: string;
  objective: string;
  objectiveSha256: string;
  startedAt: string;
  requirements: Requirement[];
  scopeChanges: ScopeChange[];
  steering: SteeringRecord[];
  steeringConflicts?: SteeringConflict[];
  superseded?: SupersededObjective[];
  verification: VerificationAttempt[];
  continuation: ContinuationState;
  /** The model's own statement of what comes next (update_requirements next_action). */
  nextAction?: string;
  /** Attempts numbered up to this were already judged non-converging and stopped the work; the next judgement starts after it. */
  convergenceResetAfter?: number;
  outcome?: ObjectiveOutcome;
  /** Short follow-up messages the operator sent as new turns while this objective was unresolved. */
  amendments: Array<{ at: string; text: string }>;
  /**
   * Objective-scoped execution tracking (core/execution_tracking.ts): cumulative steps, progress, repetition,
   * failed approaches, interventions and compactions. Absent in ledgers written before it existed; `trackingOf` fills it.
   */
  execution?: ExecutionTracking;
}

/** The ledger's execution tracking, created (or completed, for a ledger restored from an earlier version) on first use. */
export function trackingOf(ledger: ObjectiveLedger): ExecutionTracker {
  ledger.execution = normalizeTracking(ledger.execution);
  return new ExecutionTracker(ledger.execution);
}

const now = () => new Date().toISOString();
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * Acceptance criteria as written: top-level numbered items (`1.`, `2)`, `R3:`) of the objective. Each keeps its
 * heading line; the full wording stays in the verbatim objective. Fewer than two items means the objective is a
 * single request and is tracked as one requirement.
 */
export function seedRequirements(objective: string): Array<{ id: string; text: string; detail: string; kind?: RequirementKind; verifier?: string; verifierSource?: "operator"; note?: string }> {
  const lines = objective.replace(/\r\n?/g, "\n").split("\n");
  const items: Array<{ indent: number; text: string; line: number }> = [];
  lines.forEach((line, index) => {
    const match = /^(\s*)(?:R?(\d{1,3})[.):]|R(\d{1,3})\s*[-–—])\s+(\S.*)$/.exec(line);
    if (match) items.push({ indent: match[1].replace(/\t/g, "    ").length, text: match[4].trim(), line: index });
  });
  const whole = [{ id: "R1", text: clip(firstLine(objective), MAX_REQUIREMENT_TEXT), detail: objective }];
  if (items.length < 2) return whole;
  // Only the outermost numbering level: nested numbered sub-steps belong to their parent item.
  const outer = Math.min(...items.map((item) => item.indent));
  const top = items.filter((item) => item.indent <= outer + 1);
  if (top.length < 2) return whole;
  // Each requirement's full wording: from its own line up to the next top-level item (the last runs to the end).
  return top.map((item, index) => ({
    id: `R${index + 1}`,
    text: clip(item.text, MAX_REQUIREMENT_TEXT),
    detail: lines.slice(item.line, index + 1 < top.length ? top[index + 1].line : lines.length).join("\n").trimEnd(),
    ...typedItem(item.text),
  }));
}

/** An item the operator wrote as `Invariant: ...` or `Constraint: ...`, optionally ending `[verify: <command>]`. */
function typedItem(text: string): { kind?: RequirementKind; verifier?: string; verifierSource?: "operator"; note?: string } {
  const kind = /^(constraint|invariant)s?\b\s*[:\-–—]/i.exec(text)?.[1].toLowerCase() as RequirementKind | undefined;
  if (!kind) return {};
  if (!/\[verify:/i.test(text)) return { kind };
  const command = /\[verify:\s*(.+)\]\s*$/i.exec(text)?.[1];
  const clean = command ? oneLine(command) : "";
  const refusal = !clean
    ? "its [verify: ...] verifier could not be read, so it has none"
    : clean.length > MAX_VERIFIER_CHARS
      ? `its verifier is over ${MAX_VERIFIER_CHARS} characters, so it has none`
      : isConstantVerifier(clean)
        ? "its verifier checks nothing (it always passes), so it has none"
        : undefined;
  return refusal ? { kind, note: refusal } : { kind, verifier: clean, verifierSource: "operator" };
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? text.trim();
}

export function createLedger(objective: string, at = now(), unitId?: string): ObjectiveLedger {
  return {
    version: LEDGER_VERSION,
    ...(unitId ? { unitId } : {}),
    objective,
    objectiveSha256: sha256(objective),
    startedAt: at,
    requirements: seedRequirements(objective).map((seed) => ({
      ...seed,
      status: "open" as const,
      source: "objective" as const,
      evidence: [],
      updatedAt: at,
    })),
    scopeChanges: [],
    steering: [],
    verification: [],
    continuation: { segments: 1, totalSteps: 0, lastProgressStep: 0 },
    amendments: [],
    execution: createTracking(),
  };
}

/**
 * Requirements an operator follow-up adds to the objective it continues: its numbered items, appended after the
 * existing ones (an amendment never removes or rewrites what was asked before).
 */
export function amendObjective(ledger: ObjectiveLedger, prompt: string, at = now()): Requirement[] {
  ledger.amendments.push({ at, text: prompt });
  const seeds = seedRequirements(prompt);
  if (seeds.length < 2) return [];
  const base = ledger.requirements.filter((r) => r.source === "objective").length;
  const added = seeds.map((seed, i) => ({
    id: `R${base + i + 1}`,
    text: seed.text,
    detail: seed.detail,
    ...(seed.kind ? { kind: seed.kind } : {}),
    ...(seed.verifier ? { verifier: seed.verifier, verifierSource: seed.verifierSource } : {}),
    status: "open" as const,
    source: "objective" as const,
    evidence: [],
    note: `added by the operator's follow-up of ${at}${seed.note ? `; ${seed.note}` : ""}`,
    updatedAt: at,
  }));
  ledger.requirements.push(...added);
  return added;
}

/**
 * Whether the operator's next message starts a new objective or continues the unresolved one. A message that
 * carries its own numbered requirements, or is long, is a new objective; a short message ("continue", "also check
 * the README") while requirements remain open amends the current one. A resolved objective is always replaced.
 */
export function isNewObjective(ledger: ObjectiveLedger | undefined, prompt: string): boolean {
  if (!ledger || ledger.outcome?.status === "completed") return true;
  // A single request without listed requirements does not chain, except where the operator explicitly continues it
  // ("continue", "keep going", "try again"): that is the same objective, and keeps its execution history.
  if (gatingRequirements(ledger).length === 0) return !isContinuationPrompt(prompt);
  // A structured objective not yet completed is never replaced implicitly, whatever the follow-up looks like (a
  // detailed correction is still a correction). The operator replaces it explicitly: `/requirements clear` or `/clear`.
  return false;
}

/**
 * A follow-up that only asks the work to go on ("continue", "keep going", "resume", "try again", optionally with a
 * short qualifier such as "continue please" or "go on from where you stopped"). Anything that states new work is not.
 */
export function isContinuationPrompt(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  let end = normalized.length;
  while (end > 0) {
    const code = normalized.charCodeAt(end - 1);
    if (code === 33 || code === 46 || code === 0x2026) end--;
    else break;
  }
  const text = end === normalized.length ? normalized : normalized.slice(0, end);
  if (!text || text.length > 80 || text.includes("\n")) return false;
  return /^(?:please\s+)?(?:continue|keep going|keep at it|go on|go ahead|carry on|resume|proceed|try again|retry|next|finish(?: it| the task| the job)?|ok(?:ay)?,?\s+continue)\b(?:[\s,]+(?:please|then|now|on|with (?:it|the task|the work)|where you (?:left off|stopped)|from where you (?:left off|stopped)))*$/.test(text);
}

/** Requirements that gate completion: seeded from a structured objective (two or more), or added explicitly. */
export function gatingRequirements(ledger: ObjectiveLedger): Requirement[] {
  const seeded = ledger.requirements.filter((r) => r.source === "objective");
  const structured = seeded.length >= 2;
  return ledger.requirements.filter((r) => r.source !== "objective" || structured);
}

export function openRequirements(ledger: ObjectiveLedger): Requirement[] {
  return gatingRequirements(ledger).filter((r) => (!DONE_STATUSES.has(r.status) && r.status !== "blocked") || unverifiedHard(r));
}

/** Blocked requirements, and operator requirements the agent descoped without the operator's acceptance. */
export function blockedRequirements(ledger: ObjectiveLedger): Requirement[] {
  return gatingRequirements(ledger).filter((r) => r.status === "blocked" || (r.status === "descoped" && !requirementDone(r)));
}

/**
 * The operator's acceptance of descoped requirements (`/requirements accept R2 R3`). Returns the ids accepted and
 * the ids refused (unknown, or not descoped).
 */
export function acceptDescoping(ledger: ObjectiveLedger, ids: string[], at = now()): { accepted: string[]; refused: string[] } {
  const accepted: string[] = [];
  const refused: string[] = [];
  for (const id of ids) {
    const r = ledger.requirements.find((req) => req.id.toLowerCase() === id.toLowerCase());
    if (!r || (r.status !== "descoped" && !unverifiedHard(r))) {
      refused.push(id);
      continue;
    }
    r.operatorAccepted = true;
    r.updatedAt = at;
    ledger.scopeChanges.push({ at, requirement: r.id, from: r.status, to: r.status, reason: "accepted by the operator" });
    accepted.push(r.id);
  }
  return { accepted, refused };
}

export function hasOpenRequirements(ledger: ObjectiveLedger): boolean {
  return openRequirements(ledger).length > 0 || blockedRequirements(ledger).length > 0;
}

export interface RequirementUpdate {
  id?: string;
  /** New requirement text (adds a model-sourced requirement when `id` is absent or unknown). */
  text?: string;
  status?: RequirementStatus;
  evidence?: string[] | string;
  note?: string;
  kind?: RequirementKind;
  verifier?: string;
  tests?: string[] | string;
}

export interface UpdateResult {
  ok: boolean;
  changed: boolean;
  errors: string[];
}

/**
 * Applies the model's requirement updates. Seeded and steering requirements cannot be removed or reworded; moving
 * one to `descoped` or `blocked` needs a reason and is recorded as a scope change; `implemented` and `verified` need
 * evidence. Invalid entries are rejected individually, so one mistake does not discard the rest.
 */
export function applyRequirementUpdates(
  ledger: ObjectiveLedger,
  updates: RequirementUpdate[],
  nextAction?: string,
  at = now(),
  /** The passing verifier attempt on the current workspace, if one is recorded (required for `verified` of a feature). */
  generalPass?: VerificationAttempt,
  /** The recorded attempt of exactly this command on the current workspace, if any (a constraint's own verifier). */
  freshAttempt?: (command: string, requirementId: string) => VerificationAttempt | undefined,
): UpdateResult {
  const errors: string[] = [];
  let changed = false;
  for (const update of updates) {
    const status = update.status;
    if (status && !["open", "in_progress", "implemented", "verified", "blocked", "descoped"].includes(status)) {
      errors.push(`${update.id ?? "?"}: unknown status ${String(status)}`);
      continue;
    }
    const evidence = (Array.isArray(update.evidence) ? update.evidence : update.evidence ? [update.evidence] : [])
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => clip(item.trim(), MAX_EVIDENCE_CHARS));
    const note = typeof update.note === "string" && update.note.trim() ? clip(update.note.trim(), MAX_EVIDENCE_CHARS) : undefined;
    let requirement = update.id ? ledger.requirements.find((r) => r.id === update.id) : undefined;
    if (!requirement) {
      const text = typeof update.text === "string" ? update.text.trim() : "";
      if (!text) {
        errors.push(`${update.id ?? "(no id)"}: unknown requirement; to add one, give its text`);
        continue;
      }
      requirement = {
        id: `M${ledger.requirements.filter((r) => r.source === "model").length + 1}`,
        text: clip(text, MAX_REQUIREMENT_TEXT),
        status: "open",
        source: "model",
        evidence: [],
        updatedAt: at,
      };
      ledger.requirements.push(requirement);
      changed = true;
    } else if (update.text && update.text.trim() !== requirement.text && requirement.source !== "model") {
      errors.push(`${requirement.id}: the operator's requirement text cannot be changed`);
    }
    if (update.kind !== undefined && update.kind !== (requirement.kind ?? "feature")) {
      if (!REQUIREMENT_KINDS.includes(update.kind)) errors.push(`${requirement.id}: unknown kind ${String(update.kind)}`);
      else if (requirement.source !== "model") errors.push(`${requirement.id}: the operator's requirement type cannot be changed`);
      else {
        requirement.kind = update.kind;
        changed = true;
      }
    }
    const verifier = typeof update.verifier === "string" ? oneLine(update.verifier) : "";
    if (verifier && verifier !== requirement.verifier) {
      if (verifier.length > MAX_VERIFIER_CHARS) errors.push(`${requirement.id}: the verifier is over ${MAX_VERIFIER_CHARS} characters; give a shorter command`);
      else if (isConstantVerifier(verifier)) errors.push(`${requirement.id}: '${clip(verifier, 40)}' checks nothing (it always passes); give a command that can fail`);
      else if (!isHardRequirement(requirement)) errors.push(`${requirement.id}: a verifier applies to a constraint or invariant`);
      else if (requirement.source !== "model" || requirement.verifier) errors.push(`${requirement.id}: its verifier is fixed and cannot be changed`);
      else {
        requirement.verifier = verifier;
        requirement.verifierSource = "model";
        changed = true;
      }
    }
    for (const link of Array.isArray(update.tests) ? update.tests : update.tests ? [update.tests] : []) {
      const test = typeof link === "string" ? cleanLine(link, MAX_TEST_LINK_CHARS) : "";
      if (test && !(requirement.tests ?? []).includes(test)) {
        requirement.tests = [...(requirement.tests ?? []), test].slice(-MAX_TEST_LINKS);
        changed = true;
      }
    }
    if (status && status !== requirement.status) {
      if ((status === "descoped" || status === "blocked") && !note) {
        errors.push(`${requirement.id}: ${status} needs a note giving the reason`);
        continue;
      }
      if ((status === "implemented" || status === "verified") && evidence.length === 0 && requirement.evidence.length === 0) {
        errors.push(`${requirement.id}: ${status} needs evidence (files changed, commands run, tests passed)`);
        continue;
      }
      // `verified` is not the model's word: it binds a passing verifier run recorded on the current workspace.
      if (status === "verified") {
        const hard = isHardRequirement(requirement);
        if (hard && !requirement.verifier) {
          errors.push(`${requirement.id}: a ${requirement.kind} with no verifier cannot be verified on your word. Mark it implemented; the operator accepts it (/requirements accept).`);
          continue;
        }
        if (hard && requirement.verifierSource !== "operator") {
          const run = freshAttempt?.(requirement.verifier!, requirement.id);
          if (run) {
            const line = `advisory verifier #${run.n}: ${clip(run.command, 80)} ${run.status} (model-declared, unreviewed)`;
            if (!requirement.evidence.includes(line)) requirement.evidence = [...requirement.evidence, line].slice(-MAX_EVIDENCE_ITEMS);
            changed = true;
          }
          errors.push(
            `${requirement.id}: its verifier was declared by you, not the operator, so its run is evidence only and cannot verify it. ` +
              `Mark it implemented; it stays open until the operator accepts it (/requirements accept ${requirement.id}).`,
          );
          continue;
        }
        const currentPass = hard ? freshAttempt?.(requirement.verifier!, requirement.id) : generalPass;
        if (!currentPass || currentPass.status !== "PASSED") {
          errors.push(
            hard
              ? `${requirement.id}: verified needs a passing run of its verifier '${requirement.verifier}' after the last change, and none is recorded. Mark it implemented; it is verified only when the verifier passes.`
              : `${requirement.id}: verified needs a passing verifier run on the current workspace, and none is recorded since the last change. ` +
                `Mark it implemented with your evidence; run the verifier (run_tests, or task_completed) and mark it verified afterwards.`,
          );
          continue;
        }
        if (!hard && (currentPass.filtered || isFilteredVerifierCommand(currentPass.command))) {
          errors.push(
            `${requirement.id}: verified requires an authoritative full test suite run without filters. The recorded run '${currentPass.command}' was filtered. Run tests without a filter or mark as implemented.`,
          );
          continue;
        }
        if (!hard && currentPass.isDeliverableBound === false) {
          errors.push(
            `${requirement.id}: verified requires a test run that covers the deliverable. The recorded run '${currentPass.command}' passed generic tests but did not test the changed files. Mark as implemented.`,
          );
          continue;
        }
        if (!hard && currentPass.independent === false) {
          errors.push(
            `${requirement.id}: verified requires a check you did not write: tests that existed before this change and failed before it, or the operator's configured verifier. The recorded run '${currentPass.command}' passed, but only your own tests (or tests that also passed before the change) check this. Mark it implemented.`,
          );
          continue;
        }
        requirement.verifiedBy = { attempt: currentPass.n, command: currentPass.command, inputs: currentPass.inputs, at: currentPass.at };
        evidence.push(`verifier #${currentPass.n}: ${currentPass.command} PASSED on ${currentPass.inputs.slice(0, 12)}`);
      } else if (requirement.verifiedBy) {
        requirement.verifiedBy = undefined;
      }
      if (status === "descoped" || status === "blocked" || requirement.status === "descoped") {
        ledger.scopeChanges.push({ at, requirement: requirement.id, from: requirement.status, to: status, reason: note ?? "" });
      }
      // A new status from the agent withdraws any earlier operator acceptance; the operator accepts again if asked.
      if (requirement.operatorAccepted) requirement.operatorAccepted = undefined;
      requirement.status = status;
      changed = true;
    }
    if (note && note !== requirement.note) {
      requirement.note = note;
      changed = true;
    }
    for (const item of evidence) {
      if (!requirement.evidence.includes(item)) {
        requirement.evidence.push(item);
        changed = true;
      }
    }
    if (requirement.evidence.length > MAX_EVIDENCE_ITEMS) requirement.evidence = requirement.evidence.slice(-MAX_EVIDENCE_ITEMS);
    requirement.updatedAt = at;
  }
  if (typeof nextAction === "string" && nextAction.trim() && nextAction.trim() !== ledger.nextAction) {
    ledger.nextAction = clip(nextAction.trim(), MAX_EVIDENCE_CHARS);
    changed = true;
  }
  return { ok: errors.length === 0, changed, errors };
}

export function queueSteering(ledger: ObjectiveLedger, id: string, text: string, at = now()): SteeringRecord | undefined {
  if (ledger.steering.some((s) => s.id === id)) return undefined;
  const record: SteeringRecord = { id, text, receivedAt: at, status: "queued" };
  ledger.steering.push(record);
  return record;
}

const NEGATOR = String.raw`(?:dont|do not|never|not|without|cant|wont)`;
const NOUN = String.raw`(?:requirements?|reqs?)`;
const TARGET = String.raw`(?:(?:the\s+)?${NOUN}\s*(?:no\s+|number\s+)?r?\d{1,3}(?:\s+(?:and\s+)?r?\d{1,3})*|r\d{1,3}(?:\s+and\s+r\d{1,3})*)`;
const DROP = new RegExp(String.raw`\b(?:drop|remove|ignore|skip|disregard|abandon|cancel|scrap|descope)\s+(?:all\s+of\s+)?${TARGET}\b`, "g");
const NO_NEED = new RegExp(String.raw`\b(?:dont|do not|never|no need to|no need for)\s+(?:(?:do|doing|implement|implementing|work on|working on|address|addressing|handle|handling|bother with|need)\s+)?${TARGET}\b`, "g");
const NO_LONGER = new RegExp(String.raw`\b${TARGET}\s+(?:no longer\s+(?:applies|apply|matters|needed|required|relevant)|(?:is|are)\s+(?:no longer\s+(?:needed|required|relevant|applicable)|obsolete|cancelled|canceled|void|not needed|unnecessary|dropped)|can be\s+(?:dropped|skipped|ignored|removed)|should be\s+(?:dropped|removed|skipped|ignored))`, "g");

const DEFERRED = /\b(?:yet|for now|until|later|temporarily|first)\b/;
const unquoted = (text: string) => text.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`/g, " ").replace(/"[^"\n]*"|\u201c[^\u201d\n]*\u201d/g, " ");

const normalizeClause = (text: string) => text.toLowerCase().replace(/['\u2019]/g, "").replace(/\s*[,&]\s*/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Requirements that `text` explicitly negates: "drop requirement 3", "don't do R2", "requirement 2 no longer
 * applies", or "don't <the requirement's own wording>". Mentioning a number, adding a requirement or "don't forget
 * requirement 3" is not a negation. Anything ambiguous returns nothing, so only a deterministic negation blocks.
 */
export function steeringNegations(ledger: ObjectiveLedger, text: string): string[] {
  const live = gatingRequirements(ledger).filter((r) => !requirementDone(r));
  const found = new Set<string>();
  for (const sentence of unquoted(text).split(/[.!?;\n]+/)) {
    const clause = normalizeClause(sentence);
    if (!clause || DEFERRED.test(clause)) continue;
    const refs: string[] = [];
    for (const m of clause.matchAll(DROP)) {
      if (!new RegExp(String.raw`\b${NEGATOR}\b`).test(clause.slice(0, m.index))) refs.push(m[0]);
    }
    for (const m of clause.matchAll(NO_NEED)) refs.push(m[0]);
    for (const m of clause.matchAll(NO_LONGER)) refs.push(m[0]);
    for (const ref of refs) for (const n of ref.match(/\d+/g) ?? []) found.add(`R${Number(n)}`);
    for (const r of live) {
      const own = normalizeClause(r.text);
      if (own.split(" ").length < 3) continue;
      if (new RegExp(String.raw`(?:^|\s)(?:dont|do not|never|no need to)\s+(?:to\s+)?${own}(?:\s|$)`).test(clause)) found.add(r.id);
    }
  }
  return live.filter((r) => found.has(r.id.toUpperCase())).map((r) => r.id);
}

/** Records steering that negates requirements, once per steering id. The ledger's requirements are not touched. */
export function recordSteeringConflict(ledger: ObjectiveLedger, id: string, text: string, requirements: string[], at = now()): SteeringConflict | undefined {
  if (ledger.steering.some((s) => s.id === id) || ledger.steeringConflicts?.some((c) => c.id === id)) return undefined;
  const conflict: SteeringConflict = { id, text, requirements, receivedAt: at, status: "pending" };
  (ledger.steeringConflicts ??= []).push(conflict);
  return conflict;
}

/**
 * The operator's decision, recorded only while the conflict is still pending: approval descopes the negated
 * requirements (accepted) and queues the steering; a refusal changes nothing. `note` is the sanitised steering text.
 */
export function resolveSteeringConflict(ledger: ObjectiveLedger, conflict: SteeringConflict, approved: boolean, note: string, at = now()): boolean {
  if (conflict.status !== "pending") return false;
  conflict.status = approved ? "approved" : "declined";
  conflict.decidedAt = at;
  if (!approved) return true;
  for (const id of conflict.requirements) {
    const r = ledger.requirements.find((req) => req.id === id);
    if (!r) continue;
    ledger.scopeChanges.push({ at, requirement: r.id, from: r.status, to: "descoped", reason: `operator approved steering ${conflict.id}` });
    r.status = "descoped";
    r.operatorAccepted = true;
    r.note = clip(`operator approved steering ${conflict.id}: ${note}`, MAX_EVIDENCE_CHARS);
    r.updatedAt = at;
  }
  queueSteering(ledger, conflict.id, conflict.text, at);
  return true;
}

/** Conflicts still waiting when the turn closes can no longer be applied coherently: they stay unresolved, nothing changes. */
export function settleSteeringConflicts(ledger: ObjectiveLedger, at = now()): SteeringConflict[] {
  const settled: SteeringConflict[] = [];
  for (const c of ledger.steeringConflicts ?? []) {
    if (c.status !== "pending") continue;
    c.status = "unresolved";
    c.decidedAt = at;
    settled.push(c);
  }
  return settled;
}

/** What a new objective would orphan: the earlier objective and its requirements that are not done. */
export function supersededBy(previous: ObjectiveLedger, at = now()): SupersededObjective | undefined {
  if (previous.outcome?.status === "completed") return undefined;
  const unmet = previous.requirements.filter((r) => !requirementDone(r));
  if (!unmet.length) return undefined;
  return {
    at,
    objective: previous.objective,
    objectiveSha256: previous.objectiveSha256,
    requirements: unmet.map((r) => ({ id: r.id, text: r.text, status: r.status })),
    status: "pending_decision",
  };
}

/**
 * After any change to the workspace, verified requirements rest on a verifier run of an older state: they become
 * implemented (model-reported) again, with a note. Returns the ids demoted.
 */
export function invalidateVerified(ledger: ObjectiveLedger, reason: string, at = now()): string[] {
  const demoted: string[] = [];
  for (const r of ledger.requirements) {
    if (r.status !== "verified") continue;
    r.status = "implemented";
    r.note = clip(`verification invalidated: ${reason}${r.verifiedBy ? ` (was verifier #${r.verifiedBy.attempt})` : ""}`, MAX_EVIDENCE_CHARS);
    r.verifiedBy = undefined;
    r.updatedAt = at;
    demoted.push(r.id);
  }
  return demoted;
}

/** The first line of a failing verifier's output that names the failure; else its last non-empty line. */
export function failedCheckFrom(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // Lines that report a failure first (an echoed command that merely mentions "FAIL" is not one), then any mention.
  const reported = lines.find((line) => /^(✖|×|not ok\b|FAIL(ED)?\b|error(\[|:|\b)|thread .* panicked|test result: FAILED|AssertionError)/i.test(line));
  const failing = reported ?? lines.find((line) => /(\bFAIL(ED)?\b|\bfailed\b|\berror\[|panicked)/i.test(line) && !/\b0 failed\b/.test(line));
  const chosen = failing ?? lines[lines.length - 1];
  return chosen ? clip(chosen, MAX_EVIDENCE_CHARS) : undefined;
}

export const MAX_ATTEMPT_EXCERPT_BYTES = 2048;
/** Only the newest attempts keep their excerpt, so the persisted ledger stays small. */
const EXCERPT_RETAINED_ATTEMPTS = 5;
const MAX_FAILING_TESTS = 10;
const MAX_STORED_NAME_CHARS = 120;
const MAX_COUNTED_FAILING_TESTS = 10_000;
const MAX_SHOWN_TESTS = 3;
const MAX_SHOWN_NAME_CHARS = 80;

const ENVIRONMENT_OUTPUT = [
  /\bcommand not found\b/i,
  /\bspawn \S+ ENOENT\b|\bENOENT\b.*\bspawn\b/i,
  /\bexecutable file not found\b/i,
  /\b(?:sh|bash|zsh|dash|make): (?:line \d+: )?\S+: (?:Permission denied|No such file or directory)$/im,
  /\bmake: \*\*\* .*\bError 12[67]\b/,
  /\bsandbox (?:error|denied|violation|unavailable|failed)\b|\bbwrap:|\blandlock\b/i,
];
/** A runner that started prints a count or summary; its absence is what makes output-only evidence of a start failure. */
const RUNNER_SUMMARY =
  /^\s*(?:Tests?:\s+\d|Test Suites?:\s+\d|Test Files\s+\d|Ran \d+ tests?|ℹ tests \d+|# tests \d+|test result:|\d+ (?:passing|failing|passed|failed)\b|=+ .*\b(?:passed|failed)\b)/im;
const NAME_PATTERNS = [
  /^(?:✖|×|✕|not ok \d+(?: -)?)\s+(.+?)(?:\s+\(\d[\d.]*m?s\))?$/,
  /^● (?!Console\b|Test suite failed to run)(.+)$/,
  /^(?:FAILED|FAIL|ERROR|--- FAIL)[:\s]+(\S.*?)(?:\s+-\s.*|\s+\(\d.*\))?$/,
  /^\d+\) (.+)$/,
  /^test (\S+) \.\.\. FAILED$/,
];

const ANSI = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g;
const stripAnsi = (text: string): string => text.replace(ANSI, "");
/** Verifier-controlled text made safe to carry: secrets redacted, then controls and bidi overrides made visible, then clipped. */
const safeVerifierText = (text: string, max: number): string => clip(visibleControls(redactSecrets(text)), max);

/** Names of failing tests in TAP, node:test, jest, vitest, mocha, unittest, pytest, go and cargo output. */
export function failingTestNames(output: string): string[] {
  return failingTestScan(output).names;
}

function failingTestScan(output: string): { names: string[]; total: number } {
  const names = new Set<string>();
  for (const raw of stripAnsi(output).split(/\r?\n/)) {
    const line = raw.trim();
    for (const re of NAME_PATTERNS) {
      const name = re.exec(line)?.[1];
      if (name && !/^\d+ (?:tests?|failed)\b/i.test(name)) {
        names.add(safeVerifierText(name, MAX_STORED_NAME_CHARS));
        break;
      }
    }
    if (names.size >= MAX_COUNTED_FAILING_TESTS) break;
  }
  return { names: [...names].slice(0, MAX_FAILING_TESTS), total: names.size };
}

/**
 * Structured evidence of a failed verifier run. A timed-out run is never classified. With failing tests named, the
 * run reached the candidate, so exit 126/127 and environment-shaped text prove nothing. Otherwise ENVIRONMENT needs
 * exit 126/127, an executor failure with no exit code, or environment-shaped output from a run that printed no
 * runner summary.
 */
export function attemptEvidence(
  output: string,
  exitCode?: number | null,
  opts: { timedOut?: boolean; executorFailed?: boolean } = {},
): Pick<VerificationAttempt, "classification" | "exitCode" | "failingTests" | "failingTotal" | "failingTruncated" | "excerpt"> {
  const text = stripAnsi(output);
  const { names: failingTests, total } = failingTestScan(text);
  const none = failingTests.length === 0;
  const environment =
    !opts.timedOut &&
    none &&
    (exitCode === 126 ||
      exitCode === 127 ||
      (opts.executorFailed === true && typeof exitCode !== "number") ||
      (!RUNNER_SUMMARY.test(text) && ENVIRONMENT_OUTPUT.some((re) => re.test(text))));
  let excerpt = redactSecrets(text.trim());
  if (Buffer.byteLength(excerpt) > MAX_ATTEMPT_EXCERPT_BYTES) {
    excerpt = Buffer.from(excerpt).subarray(-MAX_ATTEMPT_EXCERPT_BYTES).toString("utf8").replace(/^\uFFFD+/, "");
  }
  return {
    ...(opts.timedOut ? {} : { classification: environment ? "ENVIRONMENT" : "CANDIDATE_FAILED" }),
    ...(typeof exitCode === "number" ? { exitCode } : {}),
    ...(failingTests.length ? { failingTests, failingTotal: total, ...(total > failingTests.length ? { failingTruncated: true } : {}) } : {}),
    ...(excerpt ? { excerpt } : {}),
  } as Pick<VerificationAttempt, "classification" | "exitCode" | "failingTests" | "failingTotal" | "failingTruncated" | "excerpt">;
}

/** One line for the model: classification, exit code and a few quoted failing test names (never the excerpt). */
export function describeAttemptEvidence(a: Pick<VerificationAttempt, "classification" | "exitCode" | "failingTests">): string {
  const parts: string[] = [];
  if (a.classification === "ENVIRONMENT") parts.push("ENVIRONMENT (the verifier could not run; this is not a candidate failure)");
  else if (a.classification) parts.push(a.classification);
  if (a.exitCode !== undefined) parts.push(`exit ${a.exitCode}`);
  if (a.failingTests?.length) {
    const shown = a.failingTests.slice(0, MAX_SHOWN_TESTS).map((n) => JSON.stringify(safeVerifierText(String(n), MAX_SHOWN_NAME_CHARS)));
    const more = a.failingTests.length - shown.length;
    parts.push(`failing tests (untrusted verifier output): ${shown.join(", ")}${more > 0 ? ` +${more} more` : ""}`);
  }
  return parts.join(", ");
}

/**
 * The last real attempt of `command` whose result still applies: same workspace identity, same agent process, no
 * mutating tool call since, same ignored-input fingerprint. Anything less certain returns undefined, so the verifier
 * runs again — reusing a failure is only an optimisation and must never block a legitimate rerun.
 */
export function priorAttempt(
  ledger: ObjectiveLedger,
  command: string,
  current: { inputs: string; epoch: string; mutationSeq: number; external: string },
  /** Look at that requirement's own verifier runs; without it, only general runs count. */
  requirementId?: string,
): VerificationAttempt | undefined {
  for (let i = ledger.verification.length - 1; i >= 0; i--) {
    const attempt = ledger.verification[i];
    if (attempt.command !== command || attempt.status === "SKIPPED_UNCHANGED_INPUTS" || attempt.requirementId !== requirementId) continue;
    if (attempt.classification === "ENVIRONMENT" && attempt.status !== "TIMED_OUT") return undefined;
    const same =
      attempt.inputs === current.inputs &&
      attempt.epoch === current.epoch &&
      attempt.mutationSeq === current.mutationSeq &&
      attempt.external === current.external;
    return same ? attempt : undefined;
  }
  return undefined;
}

export function recordAttempt(ledger: ObjectiveLedger, attempt: Omit<VerificationAttempt, "n" | "at">, at = now()): VerificationAttempt {
  const lastN = ledger.verification.length > 0 ? (ledger.verification[ledger.verification.length - 1]?.n ?? 0) : 0;
  const record: VerificationAttempt = { n: lastN + 1, at, ...attempt };
  ledger.verification.push(record);
  for (const old of ledger.verification.slice(0, -EXCERPT_RETAINED_ATTEMPTS)) delete old.excerpt;
  if (ledger.verification.length > 50) ledger.verification = ledger.verification.slice(-50);
  return record;
}

export type ConvergenceState = "converging" | "stalled" | "oscillating" | "diverging";

export interface ConvergenceSignal {
  state: ConvergenceState;
  /** Plain statement of what repeated; empty when converging. */
  evidence: string;
  /** The attempts the judgement rests on, oldest first (empty when converging). */
  attempts: VerificationAttempt[];
}

/**
 * What makes two failures "the same". Names compare, not assertion messages: the same tests failing for a different
 * reason are the same failure here. A list cut at the cap compares with its total, and an unknown total abstains.
 * Without names the first failing line and exit code compare, which says much less (see `checkOnly`).
 */
const failureKey = (a: VerificationAttempt): string | undefined => {
  if (a.failingTests?.length) {
    if (a.failingTruncated && a.failingTotal === undefined) return undefined;
    return `tests:${[...a.failingTests].sort().join("\n")}|total:${a.failingTotal ?? ""}`;
  }
  return a.failedCheck ? `check:${a.failedCheck}|exit:${a.exitCode ?? ""}` : undefined;
};
const checkOnly = (key: string | undefined): boolean => key?.startsWith("check:") === true;
const failureCount = (a: VerificationAttempt): number | undefined =>
  a.failingTests?.length && !(a.failingTruncated && a.failingTotal === undefined) ? (a.failingTotal ?? a.failingTests.length) : undefined;
const safeText = (text: string, max = 160): string => clip(visibleControls(redactSecrets(text)), max);

/**
 * Whether repeated verifier failures show the work is not getting anywhere: the same failure across `attempts`
 * candidates that each changed the inputs (stalled), A/B/A/B alternation of two failure sets (oscillating), or a
 * strictly rising failing-test count (diverging). A check-only failure (no test names) needs one more attempt.
 *
 * "Consecutive" is over comparable attempts of one command: ENVIRONMENT, timed-out, skipped-on-unchanged-inputs and
 * unclassified (pre-DV-1) attempts are dropped, not counted as a break, and a pass ends the history. Another
 * command's attempts do not mix in, and filtered runs take no part in alternation. An attempt on unchanged inputs (for
 * example after a rewrite with identical contents) is not a new candidate, so it ends a stalled run.
 * `command` defaults to the latest comparable attempt's. This is a stop signal only; it never establishes success.
 */
export function convergenceSignal(
  ledger: Pick<ObjectiveLedger, "verification" | "convergenceResetAfter">,
  attempts = DEFAULT_CONVERGENCE_ATTEMPTS,
  command?: string,
): ConvergenceSignal {
  const converging: ConvergenceSignal = { state: "converging", evidence: "", attempts: [] };
  const n = Math.max(2, Math.floor(attempts));
  const comparable = ledger.verification.filter((a) => a.n > (ledger.convergenceResetAfter ?? 0));
  const target = command ?? comparable.filter((a) => a.status === "FAILED" && a.classification === "CANDIDATE_FAILED").at(-1)?.command;
  const history: VerificationAttempt[] = [];
  for (const a of comparable) {
    if (a.command !== target) continue;
    if (a.status === "PASSED") history.length = 0;
    else if (a.status === "FAILED" && a.classification === "CANDIDATE_FAILED") history.push(a);
  }
  const tail = (list: VerificationAttempt[], k: number) => (list.length >= k ? list.slice(-k) : undefined);

  const lastKey = history.length ? failureKey(history[history.length - 1]) : undefined;
  const stalledTail = lastKey === undefined ? undefined : tail(history, checkOnly(lastKey) ? n + 1 : n);
  if (stalledTail && stalledTail.every((a, i) => failureKey(a) === lastKey && (i === 0 || a.inputs !== stalledTail[i - 1].inputs))) {
    const first = stalledTail[0];
    const what = first.failingTests?.length
      ? `the same failing tests (untrusted verifier output: ${first.failingTests.slice(0, 3).map((t) => JSON.stringify(safeText(t, 80))).join(", ")}${first.failingTests.length > 3 ? ", ..." : ""})`
      : `the same failed check (untrusted verifier output: ${JSON.stringify(safeText(first.failedCheck ?? ""))})`;
    return { state: "stalled", evidence: `${what} in ${stalledTail.length} consecutive attempts, each on changed workspace inputs`, attempts: stalledTail };
  }

  const alternating = tail(history.filter((a) => a.filtered !== true), Math.max(4, n + 1));
  if (alternating) {
    const [a, b] = [failureKey(alternating[0]), failureKey(alternating[1])];
    if (a !== undefined && b !== undefined && a !== b && alternating.every((x, i) => failureKey(x) === (i % 2 === 0 ? a : b))) {
      return { state: "oscillating", evidence: `the failure alternated between two sets across the last ${alternating.length} attempts`, attempts: alternating };
    }
  }

  const risingTail = tail(history, n);
  const counts = risingTail?.map(failureCount);
  if (risingTail && counts!.every((c) => c !== undefined) && counts!.every((c, i) => i === 0 || c! > counts![i - 1]!)) {
    return { state: "diverging", evidence: `the failing-test count rose in each of the last ${n} attempts (${counts!.join(" -> ")})`, attempts: risingTail };
  }
  return converging;
}

/** The attempt history a non-converging stop carries: command, status, classification, failing tests and candidate ids; capped and made safe. */
export function convergenceHistory(attempts: VerificationAttempt[], max = 10): Array<Pick<VerificationAttempt, "n" | "command" | "status" | "classification" | "failingTests" | "failedCheck"> & { candidate: string }> {
  return attempts.slice(-max).map((a) => ({
    n: a.n,
    command: safeText(a.command, 200),
    status: a.status,
    ...(a.classification ? { classification: a.classification } : {}),
    ...(a.failingTests ? { failingTests: a.failingTests.slice(0, 10).map((t) => safeText(String(t), MAX_STORED_NAME_CHARS)) } : {}),
    ...(a.failedCheck ? { failedCheck: safeText(a.failedCheck, 200) } : {}),
    candidate: a.inputs.slice(0, 12),
  }));
}

/**
 * The context block the model sees every request: requirement states, steering, verification and continuation.
 * The objective is included verbatim only when the operator's original message is no longer in the conversation.
 */
export function renderPinnedLedger(
  ledger: ObjectiveLedger,
  includeObjective: boolean,
  budgetChars = MAX_PINNED_OBJECTIVE_CHARS,
  recovery: RecoveryContextOptions = {},
): string {
  const out: string[] = [PINNED_LEDGER_PREFIX];
  if (includeObjective) {
    const unresolved = gatingRequirements(ledger).filter((r) => !requirementDone(r));
    if (ledger.objective.length <= budgetChars) {
      out.push("Operator objective (verbatim; the original message left the context):", ledger.objective);
    } else {
      // Too large to repeat on every request. Every unresolved requirement's complete wording is carried instead;
      // what does not fit is named, and read_objective returns any part verbatim.
      out.push(
        `Operator objective (${ledger.objective.length} chars; the original message left the context and the whole text exceeds this block's budget). ` +
          "The complete wording of each unresolved requirement follows; call read_objective (requirement id, or offset/length) for any other part, verbatim.",
      );
      let room = budgetChars;
      const intro = ledger.objective.slice(0, Math.min(1500, ledger.objective.length));
      out.push("Opening of the objective:", intro);
      room -= intro.length;
      const deferred: string[] = [];
      for (const r of unresolved) {
        const detail = r.detail ?? r.text;
        if (detail.length <= room) {
          out.push(`Full text of ${r.id} [${r.status}]:`, detail);
          room -= detail.length;
        } else {
          deferred.push(r.id);
        }
      }
      if (deferred.length) out.push(`Not shown here for space (unresolved; fetch with read_objective before working on them): ${deferred.join(", ")}.`);
    }
  } else {
    out.push(`Operator objective: the operator's original message in this conversation (sha256 ${ledger.objectiveSha256.slice(0, 12)}).`);
  }
  // Operator follow-ups and steering are carried verbatim, newest first within their budget; what does not fit is named
  // with its size and read_objective returns it in full.
  const steering = ledger.steering.filter((s) => s.status !== "cancelled");
  const operatorMessages = [
    ...ledger.amendments.map((a, i) => ({ key: `amendment:${i}`, at: a.at, size: a.text.length })),
    ...steering.map((s) => ({ key: `steering:${s.id}`, at: s.receivedAt, size: s.text.length })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  let operatorRoom = Math.min(MAX_PINNED_OPERATOR_CHARS, budgetChars);
  const verbatim = new Set<string>();
  for (const m of operatorMessages) {
    if (m.size > operatorRoom) continue;
    verbatim.add(m.key);
    operatorRoom -= m.size;
  }
  const operatorEntry = (key: string, label: string, text: string, fetch: string) =>
    verbatim.has(key)
      ? `- ${label} ${text}`
      : `- ${label} (${text.length} chars, not shown for space; read_objective ${fetch} returns it verbatim): ${clip(text.replace(/\s+/g, " "), 120)}`;
  if (ledger.amendments.length) {
    out.push("Operator follow-ups on this objective:");
    ledger.amendments.forEach((a, i) => out.push(operatorEntry(`amendment:${i}`, `A${i + 1}`, a.text, `amendment "A${i + 1}"`)));
  }
  const gating = gatingRequirements(ledger);
  if (gating.length) {
    out.push("Acceptance requirements (the plan never replaces these; update them with update_requirements and evidence):");
    for (const r of gating) {
      const evidence = r.evidence.length ? ` evidence: ${r.evidence.join("; ")}` : "";
      const note = r.note ? ` note: ${r.note}` : "";
      const pending = r.status === "descoped" && !requirementDone(r) ? " (descoped by you; still unresolved until the operator accepts it)" : "";
      const links = r.tests?.length ? ` tests: ${r.tests.slice(0, MAX_TEST_LINKS).map((t) => span(t, MAX_TEST_LINK_CHARS)).join(", ")}` : "";
      const hard = isHardRequirement(r)
        ? ` {${r.kind}; ${r.verifier ? `${r.verifierSource === "operator" ? "verifier" : "model-declared verifier (unreviewed)"}: ${span(r.verifier, MAX_VERIFIER_CHARS)}` : "no verifier"}${unverifiedHard(r) ? (r.verifier && r.verifierSource === "operator" ? "; not verified: needs its verifier to pass" : "; not verified: needs operator acceptance") : ""}}`
        : "";
      out.push(`- ${r.id} [${r.status}${pending}]${hard} ${r.text}${links}${evidence}${note}`);
    }
  }
  if (ledger.scopeChanges.length) {
    out.push("Explicit scope changes:");
    for (const change of ledger.scopeChanges.slice(-8)) out.push(`- ${change.requirement}: ${change.from} -> ${change.to} (${change.reason})`);
  }
  if (steering.length) {
    out.push("Operator steering received during the work (applies on top of the objective):");
    for (const s of steering) {
      out.push(operatorEntry(`steering:${s.id}`, `${s.id} [${s.status}${s.appliedAtStep ? ` at step ${s.appliedAtStep}` : ""}]`, s.text, `steering "${s.id}"`));
    }
  }
  const attempts = ledger.verification.slice(-3);
  if (attempts.length) {
    out.push("Verifier attempts (inputs = workspace candidate identity):");
    for (const a of attempts) out.push(`- #${a.n} ${a.command}${a.requirementId ? ` (verifier of ${a.requirementId})` : ""} -> ${a.status} on ${a.inputs.slice(0, 12)}${a.failedCheck ? ` (${a.failedCheck})` : ""}${describeAttemptEvidence(a) ? ` [${describeAttemptEvidence(a)}]` : ""}`);
  }
  const c = ledger.continuation;
  if (c.segments > 1 || c.totalSteps > 0) {
    out.push(`Continuation: segment ${c.segments} of this turn; ${c.totalSteps} steps so far on this objective. Keep working toward the open requirements; no operator "continue" is needed.`);
  }
  if (ledger.execution) {
    // A ledger restored from an earlier version may lack fields (recovery, coverage): read a normalized copy.
    const execution = normalizeTracking(ledger.execution);
    const tracker = new ExecutionTracker(execution);
    if (tracker.recoveryStage === "constrained") out.push(renderRecoveryContext(recoveryInput(ledger), recovery));
    const loops = tracker.loops().slice(0, 3);
    if (loops.length) {
      out.push("Repeated without progress on an unchanged workspace (do not repeat these; change approach):");
      for (const r of loops) out.push(`- ${r.action} ×${r.count} (steps ${r.firstStep}-${r.lastStep}) -> ${r.outcome.slice(0, 160)}`);
    }
    const failed = execution.failedApproaches.slice(-4);
    if (failed.length) {
      out.push("Failed approaches on this objective (most recent):");
      for (const f of failed) out.push(`- step ${f.step}: ${f.detail.slice(0, 200)}`);
    }
  }
  if (ledger.nextAction) out.push(`Next action (your last statement): ${ledger.nextAction}`);
  return out.join("\n");
}

/** How the recovery context is rendered: evidence presence, the stagnation limit, and which tools the agent may call. */
export interface RecoveryContextOptions {
  present?: (callId: string) => boolean;
  stagnationSteps?: number;
  /** Whether the agent may call a tool; actions it may not take are left out of "Permitted next actions". */
  permits?: (tool: string) => boolean;
}

const clipText = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const fmtRanges = (ranges: Array<[number, number]>) => ranges.map(([a, b]) => (b < a ? "empty" : a === b ? `${a}` : `${a}-${b}`)).join(", ");

/**
 * The RECOVERY_REQUIRED context: built only from recorded evidence (executed observations, the ledger, recovery
 * state), never from the model's own claims. When the specific open question is not recorded, it says so and requires
 * the agent to state it. `present` (when the caller has the conversation) marks evidence still in context.
 */
export function renderRecoveryContext(
  input: { objective: string; open: Array<{ id: string; text: string }>; execution: ExecutionTracking },
  opts: RecoveryContextOptions = {},
): string {
  const t = normalizeTracking(input.execution);
  const tracker = new ExecutionTracker(t);
  const r = t.recovery;
  const state = r.state ?? "unknown";
  const out: string[] = ["RECOVERY_REQUIRED"];
  out.push("Current objective:", `- ${clipText(input.objective.replace(/\s+/g, " "), 300)}`);
  const observed = state === "unknown" ? [] : tracker.observedOn(state).sort((a, b) => Math.max(...b.steps) - Math.max(...a.steps)).slice(0, 8);
  out.push("Previously acquired evidence (on the current workspace state):");
  if (observed.length) {
    for (const o of observed) {
      const live = opts.present ? (o.keys.some((k) => opts.present!(k)) ? "output still in this conversation" : "output no longer in this conversation") : `step(s) ${o.steps.slice(-4).join(", ")}`;
      out.push(`- ${o.path} lines ${fmtRanges(o.ranges)}${o.total !== undefined ? ` of ${o.total}` : ""} (${live}; fingerprint ${o.fingerprints.slice(-1)[0]})`);
    }
  } else out.push("- none recorded as file line ranges");
  const repeated = [
    ...(state === "unknown" ? [] : tracker.equivalentsOn(state).slice(0, 4).map((e) => `- ${e.path}${e.start !== undefined ? ` lines ${e.start}-${e.end}` : ""}: obtained again ${e.count} time(s) while already in this conversation (steps ${e.firstStep}-${e.lastStep}; last: ${e.action})`)),
    ...tracker.loops().filter((l) => l.state === state).slice(0, 3).map((l) => `- ${l.action} ×${l.count} with the same result (steps ${l.firstStep}-${l.lastStep})`),
  ];
  out.push("Repeated observations:", ...(repeated.length ? repeated : [`- ${r.trigger ?? "unrecorded"}`]));
  const unchangedSince = t.progress.filter((p) => /workspace reached a new state/.test(p.detail)).at(-1)?.step;
  out.push("Current workspace state:", `- ${state === "unknown" ? "unknown" : state.slice(0, 12)}${unchangedSince ? `; unchanged since step ${unchangedSince}` : ""}`);
  const last = t.progress.at(-1);
  out.push("Last meaningful progress:", `- ${last ? `step ${last.step}: ${last.detail}` : "none recorded on this objective"}`);
  const open = input.open.slice(0, 4);
  out.push("Unresolved question:");
  for (const q of open) out.push(`- open requirement ${q.id}: ${clipText(q.text, 160)}`);
  out.push("- The specific question your next action must answer is not recorded. State it in one sentence, and why the evidence above does not answer it, before any further observation.");
  out.push(
    "Disallowed operations (refused before they run while the workspace is unchanged):",
    "- Reading any of the line ranges above again, through any interface (read_file, batch_read, cat/head/sed), while that output is still in this conversation.",
    "- (Other calls are not refused, but repeating one that returns the same result on this unchanged workspace stops the turn.)",
  );
  // Only actions the agent may take: a restricted role or read-only mode refuses the others at dispatch.
  const can = opts.permits ?? (() => true);
  const canAny = (...tools: string[]) => tools.some(can);
  const actions = [
    "use the output already in this conversation",
    ...(canAny("read_file", "batch_read") ? ["read lines or files not listed above"] : []),
    ...(canAny("search_code", "search_symbols") ? ["search for a specific symbol or string"] : []),
    ...(canAny("write_file", "edit_file", "patch_file") ? ["edit files"] : []),
    ...(canAny("run_command", "run_tests") ? ["run a build, test or command"] : []),
  ].join("; ");
  out.push(
    "Permitted next actions:",
    `- ${actions.charAt(0).toUpperCase()}${actions.slice(1)};`,
    `- ${can("update_requirements") ? "record a finding or a blocker with update_requirements (status \"blocked\" with the reason); or " : ""}finish with a final message reporting what you found.`,
  );
  const remaining = Math.max(0, r.allowedDenials - r.denials);
  const stagnation = opts.stagnationSteps !== undefined ? `; ${Math.max(0, opts.stagnationSteps - t.stepsWithoutProgress)} step(s) without progress left before the turn stops` : "";
  out.push("Recovery budget:", `- ${remaining} refusal(s) left of ${r.allowedDenials} in episode ${r.episode}; another refused attempt beyond that stops the turn${stagnation}.`);
  return out.join("\n");
}

/** The ledger facts the recovery context is built from: the objective, its open requirements, its tracking. */
export function recoveryInput(ledger: ObjectiveLedger): { objective: string; open: Array<{ id: string; text: string }>; execution: ExecutionTracking } {
  return { objective: ledger.objective, open: gatingRequirements(ledger).filter((q) => !requirementDone(q)), execution: normalizeTracking(ledger.execution) };
}

/** Whether the ledger has anything worth a context block beyond the operator's message itself. */
export function ledgerNeedsPinning(ledger: ObjectiveLedger, objectiveInContext: boolean): boolean {
  const execution = ledger.execution;
  return (
    !objectiveInContext ||
    (execution !== undefined && (execution.recovery?.stage ?? "normal") !== "normal") ||
    gatingRequirements(ledger).length > 0 ||
    ledger.steering.length > 0 ||
    ledger.verification.length > 0 ||
    ledger.continuation.segments > 1 ||
    ledger.amendments.length > 0
  );
}

/** Requirement rows for receipts and exports. */
export function requirementRows(ledger: ObjectiveLedger): Array<[string, string]> {
  return gatingRequirements(ledger).map((r) => {
    const status =
      r.status === "descoped"
        ? requirementDone(r) ? "DESCOPED (accepted)" : "DESCOPED (needs operator acceptance)"
        : unverifiedHard(r)
          ? `UNVERIFIED (${r.kind}: ${r.verifier ? (r.verifierSource === "operator" ? "its verifier has not passed" : "model-declared verifier (unreviewed); needs operator acceptance") : "no verifier; needs operator acceptance"})`
          : r.status === "implemented"
          ? "IMPLEMENTED (model-reported)"
          : r.status === "verified" && r.verifiedBy
            ? `VERIFIED (verifier #${r.verifiedBy.attempt} ${r.verifiedBy.command} passed on ${r.verifiedBy.inputs.slice(0, 12)})`
            : r.status.toUpperCase();
    return [r.id, `${status} ${r.text}${r.note ? ` (${r.note})` : ""}`];
  });
}

/**
 * `update_requirements`: an agent-level orchestration tool (registered on the top-level agent's registry, not in the
 * baseline HARNESS_TOOLS set, so subagents and serve-mcp do not expose it).
 */
export const REQUIREMENTS_CAPABILITY: CanonicalCapability = {
    "id": "orchestrate_requirements",
    "modelToolName": "update_requirements",
    "category": "orchestration",
    "mutating": false,
    "effect": "internal",
    "sideEffectContract": "Record progress against the operator's acceptance requirements (no workspace change)",
    "backend": "ts_native",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "update_requirements",
        "description": "Record the state of the operator's acceptance requirements (listed in the pinned Objective Ledger). The plan never replaces them. Mark a requirement implemented or verified only with evidence (files changed, commands run, tests passed); mark it blocked or descoped only with a note giving the reason (an explicit scope change). Add a sub-requirement by giving text without an id. Also states your next action.",
        "parameters": {
          "type": "object",
          "properties": {
            "requirements": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": { "type": "string", "description": "Requirement id from the ledger, e.g. R3. Omit to add a new sub-requirement." },
                  "text": { "type": "string", "description": "Text of a new sub-requirement (ignored for the operator's own requirements)." },
                  "status": { "type": "string", "enum": ["open", "in_progress", "implemented", "verified", "blocked", "descoped"] },
                  "evidence": { "type": "array", "items": { "type": "string" }, "description": "Implementation and validation evidence." },
                  "note": { "type": "string", "description": "Reason, required for blocked and descoped." },
                  "kind": { "type": "string", "enum": ["feature", "constraint", "invariant"], "description": "Type of a new sub-requirement (default feature). A constraint or invariant is complete only when its verifier passes after your last change; the operator's own cannot be retyped." },
                  "verifier": { "type": "string", "description": "Command that checks a new constraint or invariant (set once, run through the approval gate)." },
                  "tests": { "type": "array", "items": { "type": "string" }, "description": "Test names or paths that exercise this requirement." }
                }
              }
            },
            "next_action": { "type": "string", "description": "The next concrete action you will take." }
          },
          "required": ["requirements"]
        }
      }
    }
  };

/**
 * `read_objective`: the operator's objective verbatim — one requirement's complete wording, or a character range —
 * for objectives too large to repeat in full on every request. Agent-level, read-only.
 */
export const READ_OBJECTIVE_CAPABILITY: CanonicalCapability = {
  id: "orchestrate_read_objective",
  modelToolName: "read_objective",
  category: "orchestration",
  mutating: false,
  effect: "internal",
  sideEffectContract: "Read the operator's objective verbatim (no workspace change)",
  backend: "ts_native",
  toolDefinition: {
    type: "function",
    function: {
      name: "read_objective",
      description:
        "Return the operator's words verbatim: the complete wording of one requirement (requirement: \"R3\"), one steering message (steering: its id), one follow-up (amendment: \"A2\"), or a character range of the objective (offset, length up to 20000). Use it when the pinned Objective Ledger says something is not shown.",
      parameters: {
        type: "object",
        properties: {
          requirement: { type: "string", description: "Requirement id, e.g. R3." },
          steering: { type: "string", description: "Steering id, as named in the ledger." },
          amendment: { type: "string", description: "Follow-up id, e.g. A2." },
          offset: { type: "number", description: "Start character (0-based)." },
          length: { type: "number", description: "Characters to return (max 20000)." },
        },
      },
    },
  },
} as CanonicalCapability;

/** What read_objective returns for `args`. */
export function readObjective(
  ledger: ObjectiveLedger,
  args: { requirement?: unknown; steering?: unknown; amendment?: unknown; offset?: unknown; length?: unknown },
): { ok: boolean; text: string } {
  if (typeof args.steering === "string" && args.steering.trim()) {
    const id = args.steering.trim();
    const s = ledger.steering.find((record) => record.id === id);
    if (!s) return { ok: false, text: `No steering ${id}; known: ${ledger.steering.map((record) => record.id).join(", ") || "none"}.` };
    return { ok: true, text: `Operator steering ${s.id} [${s.status}] received ${s.receivedAt}\n${s.text}` };
  }
  if (typeof args.amendment === "string" && args.amendment.trim()) {
    const id = args.amendment.trim();
    const n = Number(/^A(\d+)$/i.exec(id)?.[1] ?? 0);
    const a = n > 0 ? ledger.amendments[n - 1] : undefined;
    if (!a) return { ok: false, text: `No follow-up ${id}; known: ${ledger.amendments.length ? `A1-A${ledger.amendments.length}` : "none"}.` };
    return { ok: true, text: `Operator follow-up A${n} received ${a.at}\n${a.text}` };
  }
  if (typeof args.requirement === "string" && args.requirement.trim()) {
    const r = ledger.requirements.find((req) => req.id.toLowerCase() === String(args.requirement).trim().toLowerCase());
    if (!r) return { ok: false, text: `No requirement ${String(args.requirement)}; known: ${ledger.requirements.map((req) => req.id).join(", ")}.` };
    return { ok: true, text: `${r.id} [${r.status}]\n${r.detail ?? r.text}` };
  }
  const total = ledger.objective.length;
  const offset = Math.max(0, Math.min(total, Math.floor(Number(args.offset ?? 0)) || 0));
  const length = Math.max(1, Math.min(20_000, Math.floor(Number(args.length ?? 20_000)) || 20_000));
  const end = Math.min(total, offset + length);
  return { ok: true, text: `[objective characters ${offset}-${end} of ${total}]\n${ledger.objective.slice(offset, end)}` };
}
