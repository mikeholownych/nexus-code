/** Review-only graph records. These records are deliberately incompatible with runnable batch specifications. */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDistinctPlanReviewer, type BatchPlanReview, validatePlanReview } from "./batch_plan_review.js";
import { validateBatchSpec } from "./batch_spec.js";
import { redactForPersistence } from "./core/persistence_protection.js";
import { isReadOnlyRole, ROLE_PROFILES, type AgentRole } from "./core/roles.js";
import type { WorkRequirements } from "./core/resources.js";
import { integer, oneOf, readPrivateJson, strictObject, text, timestamp, writePrivateJson } from "./core/runner_store.js";
import { realpathAllowingMissing } from "./core/socket_files.js";
import { defaultTaskStateDir } from "./core/state.js";
import { parseStrictJson } from "./core/strict_json.js";
import { isPathWithin } from "./path_within.js";

export const MAX_BATCH_PLAN_BYTES = 256 * 1024;
const MAX_UNITS = 32;
const MAX_CHECKS = 8;
const UNIT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const DRAFT_ID = /^plan-(?:[a-f0-9]{24}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface PlanCheck {
  id: string;
  command: string;
  cwd: string;
  expectation: string;
  timeoutSeconds: number;
  required: boolean;
}

export interface BatchPlanUnit {
  id: string;
  title: string;
  objective: string;
  role: AgentRole;
  required: boolean;
  dependsOn: string[];
  mode: "read" | "write";
  scope: string[];
  acceptanceCriteria: string[];
  checks: PlanCheck[];
  outputs: string[];
  handoffs: string[];
  independentReview?: boolean;
  requires?: WorkRequirements;
}

export interface BatchPlan {
  version: 1;
  objective: string;
  acceptanceCriteria: string[];
  checks: PlanCheck[];
  risks: string[];
  assumptions: string[];
  blockers: string[];
  units: BatchPlanUnit[];
}

export interface BatchPlanProvenance {
  resourceId: string;
  model: string;
  disclosure: "local" | "cloud";
  effectiveModel?: string;
  fallbackFrom?: string;
}

export interface BatchPlanDraft {
  version: 1;
  id: string;
  workspace: string;
  digest: string;
  createdAt: string;
  plan: BatchPlan;
  provenance?: BatchPlanProvenance;
}

function items(label: string, value: unknown, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${label} must contain ${min} to ${max} items`);
  }
  return value;
}

function prose(label: string, value: unknown, max = 1000): string {
  const result = text(label, value, max).trim();
  if (!result || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(result)) {
    throw new Error(`${label} contains empty text or unsupported control characters`);
  }
  return result;
}

function proseList(label: string, value: unknown, min = 0): string[] {
  return items(label, value, 32, min).map((item) => prose(label, item));
}

function boolean(label: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be true or false`);
  return value;
}

function distinct<T>(label: string, values: T[]): T[] {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate values`);
  return values;
}

function ids(label: string, value: unknown): string[] {
  return distinct(label, items(label, value, MAX_UNITS).map((item) => text(label, item, 64, UNIT_ID)));
}

/** Scope prefixes may name future files. Existing symbolic links are excluded so two textual prefixes cannot alias. */
function workspacePath(label: string, value: unknown, workspace: string, allowRoot: boolean): string {
  const raw = prose(label, value, 512);
  const relative = path.posix.normalize(raw).replace(/\/$/, "");
  const segments = raw.split("/");
  if ((!allowRoot && relative === ".") || path.posix.isAbsolute(raw) ||
      /[:\\*?\[\]\n\t]/u.test(raw) || segments.includes("..") || segments.includes(".git") || segments.includes(".nexus")) {
    throw new Error(`${label} must be a workspace-relative path without traversal, metadata or glob segments`);
  }
  let current = workspace;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new Error(`${label} must not traverse a symbolic link`);
  }
  return relative;
}

function checks(label: string, value: unknown, workspace: string): PlanCheck[] {
  const parsed = items(label, value, MAX_CHECKS).map((item) => {
    const check = strictObject(label, item, ["id", "command", "cwd", "expectation", "timeoutSeconds", "required"]);
    return {
      id: text(`${label}.id`, check.id, 64, UNIT_ID),
      command: prose(`${label}.command`, check.command, 1000),
      cwd: workspacePath(`${label}.cwd`, check.cwd, workspace, true),
      expectation: prose(`${label}.expectation`, check.expectation),
      timeoutSeconds: integer(`${label}.timeoutSeconds`, check.timeoutSeconds, 1, 300),
      required: boolean(`${label}.required`, check.required),
    };
  });
  distinct(`${label} ids`, parsed.map((check) => check.id));
  return parsed;
}

function requirements(label: string, value: unknown): WorkRequirements {
  const req = strictObject(label, value, [], ["capabilities", "qualification", "minContext", "independentOf"]);
  return {
    ...(req.capabilities === undefined ? {} : { capabilities: distinct(label, proseList(`${label}.capabilities`, req.capabilities)) }),
    ...(req.qualification === undefined ? {} : { qualification: prose(`${label}.qualification`, req.qualification, 128) }),
    ...(req.minContext === undefined ? {} : { minContext: integer(`${label}.minContext`, req.minContext, 1, 2_000_000) }),
    ...(req.independentOf === undefined ? {} : { independentOf: ids(`${label}.independentOf`, req.independentOf) }),
  };
}

function parseUnit(value: unknown, workspace: string): BatchPlanUnit {
  const unit = strictObject("plan unit", value, [
    "id", "title", "objective", "role", "required", "dependsOn", "mode", "scope",
    "acceptanceCriteria", "checks", "outputs", "handoffs",
  ], ["independentReview", "requires"]);
  const id = text("unit id", unit.id, 64, UNIT_ID);
  const role = text(`unit '${id}' role`, unit.role, 64) as AgentRole;
  if (!Object.hasOwn(ROLE_PROFILES, role)) throw new Error(`unit '${id}' has an unknown role`);
  const mode = oneOf(`unit '${id}' mode`, unit.mode, ["read", "write"] as const);
  if (isReadOnlyRole(role) !== (mode === "read")) {
    throw new Error(`unit '${id}' mode conflicts with the role's authority`);
  }
  const label = `unit '${id}'`;
  const dependsOn = ids(`${label}.dependsOn`, unit.dependsOn);
  const handoffs = ids(`${label}.handoffs`, unit.handoffs);
  if (handoffs.some((source) => !dependsOn.includes(source))) throw new Error(`${label} handoff source must be a declared dependency`);
  const requires = unit.requires === undefined ? undefined : requirements(`${label}.requires`, unit.requires);
  const independentReview = unit.independentReview === undefined ? undefined : boolean(`${label}.independentReview`, unit.independentReview);
  if ((independentReview || requires?.independentOf?.length) &&
      (mode !== "read" || !requires?.independentOf?.length || requires.independentOf.some((source) => !dependsOn.includes(source)))) {
    throw new Error(`${label} independent review must name prior dependencies and use a read-only role`);
  }
  return {
    id,
    title: prose(`${label}.title`, unit.title, 160),
    objective: prose(`${label}.objective`, unit.objective, 4000),
    role,
    required: boolean(`${label}.required`, unit.required),
    dependsOn,
    mode,
    scope: distinct(`${label}.scope`, items(`${label}.scope`, unit.scope, 32, 1)
      .map((item) => workspacePath(`${label}.scope`, item, workspace, mode === "read"))),
    acceptanceCriteria: proseList(`${label}.acceptanceCriteria`, unit.acceptanceCriteria, 1),
    checks: checks(`${label}.checks`, unit.checks, workspace),
    outputs: proseList(`${label}.outputs`, unit.outputs, 1),
    handoffs,
    ...(independentReview === undefined ? {} : { independentReview }),
    ...(requires === undefined ? {} : { requires }),
  };
}

function validateParallelScopes(units: BatchPlanUnit[]): void {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const ancestors = new Map<string, Set<string>>();
  function dependencies(unit: BatchPlanUnit): Set<string> {
    const saved = ancestors.get(unit.id);
    if (saved) return saved;
    const result = new Set<string>();
    for (const id of unit.dependsOn) {
      result.add(id);
      for (const upstream of dependencies(byId.get(id)!)) result.add(upstream);
    }
    ancestors.set(unit.id, result);
    return result;
  }

  for (const [index, left] of units.entries()) {
    for (const right of units.slice(index + 1)) {
      if ((left.mode === "read" && right.mode === "read") ||
          dependencies(left).has(right.id) || dependencies(right).has(left.id)) continue;
      const overlap = left.scope.some((a) => right.scope.some((b) =>
        a === "." || b === "." || a === b || a.startsWith(b + "/") || b.startsWith(a + "/")));
      if (overlap) throw new Error(`units '${left.id}' and '${right.id}' overlap without an ordering dependency`);
    }
  }
}

export function validateBatchPlan(value: unknown, workspace: string): BatchPlan {
  const root = fs.realpathSync(workspace);
  const input = strictObject("plan", value, ["version", "objective", "acceptanceCriteria", "checks", "risks", "assumptions", "blockers", "units"]);
  if (input.version !== 1) throw new Error("unsupported batch plan version");
  const plan: BatchPlan = {
    version: 1,
    objective: prose("objective", input.objective, 4000),
    acceptanceCriteria: proseList("acceptanceCriteria", input.acceptanceCriteria, 1),
    checks: checks("plan checks", input.checks, root),
    risks: proseList("risks", input.risks),
    assumptions: proseList("assumptions", input.assumptions),
    blockers: proseList("blockers", input.blockers),
    units: items("units", input.units, MAX_UNITS, 1).map((unit) => parseUnit(unit, root)),
  };
  if (!plan.checks.some((check) => check.required)) throw new Error("plan needs a required final check");
  if (plan.units.some((unit) => unit.required && unit.mode === "write" && !unit.checks.some((check) => check.required))) {
    throw new Error("required write units need at least one required check");
  }
  // Exercise the same structural contract without exposing a runnable spec or asking the scheduler to act.
  validateBatchSpec({
    objective: plan.objective,
    units: plan.units.map((unit) => ({
      id: unit.id,
      title: unit.title,
      prompt: unit.objective,
      role: unit.role,
      required: unit.required,
      dependsOn: unit.dependsOn,
      requires: unit.requires,
      ...(unit.mode === "write" ? { authorizedScope: unit.scope } : {}),
    })),
  });
  validateParallelScopes(plan.units);
  const canonical = JSON.stringify(plan);
  if (Buffer.byteLength(canonical) > MAX_BATCH_PLAN_BYTES) throw new Error("batch plan exceeds the size limit");
  if (JSON.stringify(redactForPersistence(plan)) !== canonical) {
    throw new Error("batch plan contains protected content");
  }
  return plan;
}

export function parseBatchPlan(input: string, workspace: string): BatchPlan {
  if (Buffer.byteLength(input) > MAX_BATCH_PLAN_BYTES) throw new Error("batch plan exceeds the size limit");
  return validateBatchPlan(parseStrictJson(input, 8), workspace);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseProvenance(value: unknown): BatchPlanProvenance | undefined {
  if (value === undefined) return undefined;
  const record = strictObject("plan provenance", value, ["resourceId", "model", "disclosure"], ["effectiveModel", "fallbackFrom"]);
  const provenance = {
    resourceId: prose("plan resource id", record.resourceId, 512),
    model: prose("plan model", record.model, 512),
    disclosure: oneOf("plan disclosure", record.disclosure, ["local", "cloud"] as const),
    ...(record.effectiveModel === undefined ? {} : { effectiveModel: prose("provider-reported model", record.effectiveModel, 512) }),
    ...(record.fallbackFrom === undefined ? {} : { fallbackFrom: prose("previous plan resource id", record.fallbackFrom, 512) }),
  };
  if (JSON.stringify(redactForPersistence(provenance)) !== JSON.stringify(provenance)) {
    throw new Error("batch plan provenance contains protected content");
  }
  return provenance;
}

function draftDigest(draft: Omit<BatchPlanDraft, "digest">): string {
  return sha256(JSON.stringify(draft));
}

export class BatchPlanStore {
  private readonly workspace: string;
  private readonly directory: string;

  constructor(workspace: string, stateRoot = path.join(path.dirname(defaultTaskStateDir()), "batch-plans")) {
    this.workspace = fs.realpathSync(workspace);
    this.directory = path.join(path.resolve(stateRoot), sha256(this.workspace));
  }

  private file(id: string, kind: "draft" | "review" = "draft"): string {
    text("draft id", id, 41, DRAFT_ID);
    const resolved = realpathAllowingMissing(this.directory);
    if (isPathWithin(resolved, this.workspace)) throw new Error("batch plan state must be outside the workspace");
    return path.join(resolved, kind === "review" ? `${id}.review.json` : `${id}.json`);
  }

  create(value: unknown, provenance?: BatchPlanProvenance): BatchPlanDraft {
    const parsedProvenance = parseProvenance(provenance);
    const plan = validateBatchPlan(value, this.workspace);
    const id = `plan-${randomUUID()}`;
    const snapshot: Omit<BatchPlanDraft, "digest"> = {
      version: 1,
      id,
      workspace: this.workspace,
      createdAt: new Date().toISOString(),
      plan,
      ...(parsedProvenance === undefined ? {} : { provenance: parsedProvenance }),
    };
    const draft: BatchPlanDraft = { ...snapshot, digest: draftDigest(snapshot) };
    writePrivateJson(this.file(id), draft);
    return draft;
  }

  read(id: string): BatchPlanDraft {
    const raw = readPrivateJson(this.file(id), { label: "Batch plan draft", limit: MAX_BATCH_PLAN_BYTES * 2 });
    if (raw === undefined) throw new Error("batch plan draft was not found");
    const record = strictObject("plan draft", raw, ["version", "id", "workspace", "digest", "createdAt", "plan"], ["provenance"]);
    if (record.version !== 1 || record.id !== id || record.workspace !== this.workspace) {
      throw new Error("batch plan draft is incompatible with this workspace or id");
    }
    const digest = text("draft digest", record.digest, 64, SHA256);
    const plan = validateBatchPlan(record.plan, this.workspace);
    const provenance = parseProvenance(record.provenance);
    const snapshot: Omit<BatchPlanDraft, "digest"> = {
      version: 1,
      id,
      workspace: this.workspace,
      createdAt: timestamp("draft time", record.createdAt),
      plan,
      ...(provenance === undefined ? {} : { provenance }),
    };
    if (draftDigest(snapshot) !== digest) throw new Error("batch plan draft digest mismatch");
    return { ...snapshot, digest };
  }

  recordReview(id: string, planDigest: string, provenance: BatchPlanProvenance, modelOutput: unknown): BatchPlanReview {
    const draft = this.read(id);
    if (draft.digest !== planDigest) throw new Error("batch plan review digest does not match the draft");
    const reviewer = parseProvenance(provenance);
    if (!reviewer || !draft.provenance || !isDistinctPlanReviewer(draft.provenance, { ...reviewer, id: reviewer.resourceId })) {
      throw new Error("batch plan review requires a known planner and a distinct reviewer resource and model");
    }
    const snapshot: Omit<BatchPlanReview, "digest"> = {
      version: 1,
      planDigest,
      provenance: reviewer,
      reviewedAt: new Date().toISOString(),
      ...validatePlanReview(modelOutput, draft.plan),
    };
    const review = { ...snapshot, digest: sha256(JSON.stringify(snapshot)) };
    writePrivateJson(this.file(id, "review"), review);
    return review;
  }

  readReview(id: string): BatchPlanReview | undefined {
    const draft = this.read(id);
    const raw = readPrivateJson(this.file(id, "review"), { label: "Batch plan review" });
    if (raw === undefined) return undefined;
    const record = strictObject("recorded plan review", raw, [
      "version", "planDigest", "provenance", "reviewedAt", "findings", "uncertainty", "digest",
    ]);
    if (record.version !== 1 || record.planDigest !== draft.digest) throw new Error("batch plan review digest does not match the draft");
    const provenance = parseProvenance(record.provenance);
    if (!provenance || !draft.provenance || !isDistinctPlanReviewer(draft.provenance, { ...provenance, id: provenance.resourceId })) {
      throw new Error("batch plan review requires a known planner and a distinct reviewer resource and model");
    }
    const snapshot: Omit<BatchPlanReview, "digest"> = {
      version: 1,
      planDigest: draft.digest,
      provenance,
      reviewedAt: timestamp("plan review time", record.reviewedAt),
      ...validatePlanReview({ findings: record.findings, uncertainty: record.uncertainty }, draft.plan),
    };
    const digest = text("plan review digest", record.digest, 64, SHA256);
    if (sha256(JSON.stringify(snapshot)) !== digest) throw new Error("batch plan review digest mismatch");
    return { ...snapshot, digest };
  }

}
