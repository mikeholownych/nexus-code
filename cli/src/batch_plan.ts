/** Batch proposals and their operator acceptance records. Drafts are incompatible with runnable batch specifications. */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDistinctPlanReviewer, type BatchPlanReview, validatePlanReview } from "./batch_plan_review.js";
import { validateBatchSpec } from "./batch_spec.js";
import { redactForPersistence } from "./core/persistence_protection.js";
import { isReadOnlyRole, ROLE_PROFILES, type AgentRole } from "./core/roles.js";
import type { ExecutionResourceRequest } from "./core/operation.js";
import { validateExecutionResources } from "./core/operation_schema.js";
import type { WorkRequirements } from "./core/resources.js";
import { assertPrivateDir, integer, oneOf, readPrivateJson, strictObject, text, timestamp, writePrivateJson } from "./core/runner_store.js";
import { realpathAllowingMissing } from "./core/socket_files.js";
import { GIT_SAFE, driverRefusal, safeGitEnv, snapshotSupport } from "./core/specialist_inputs.js";
import { defaultTaskStateDir } from "./core/state.js";
import { withStateStoreGuard } from "./core/state_store_guard.js";
import { parseStrictJson } from "./core/strict_json.js";
import { trustedGitArgs } from "./git.js";
import { isPathWithin } from "./path_within.js";

export const MAX_BATCH_PLAN_BYTES = 256 * 1024;
const MAX_UNITS = 32;
const MAX_CHECKS = 8;
const UNIT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const DRAFT_ID = /^plan-(?:[a-f0-9]{24}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export interface PlanCheck {
  id: string;
  command: string;
  cwd: string;
  expectation: string;
  timeoutSeconds: number;
  required: boolean;
  when?: { changedPaths: string[] };
  materialInputs?: string[];
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
  executionResources?: ExecutionResourceRequest;
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
  execution?: { maxConcurrentUnits: number; executionBudget: ExecutionResourceRequest };
}

export interface BatchPlanProvenance {
  resourceId: string;
  model: string;
  disclosure: "local" | "cloud";
  effectiveModel?: string;
  fallbackFrom?: string;
}

export interface BatchPlanBase {
  repository: string;
  worktree: string;
  commit: string;
  identity: string;
}

export interface BatchPlanDraft {
  version: 1;
  id: string;
  workspace: string;
  digest: string;
  createdAt: string;
  plan: BatchPlan;
  provenance?: BatchPlanProvenance;
  base?: BatchPlanBase;
}

export interface BatchPlanAcceptance {
  version: 1;
  operationId: string;
  draft: BatchPlanDraft;
  base: BatchPlanBase;
  acceptedAt: string;
  review?: BatchPlanReview;
  digest: string;
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
function workspacePath(label: string, value: unknown, workspace: string | undefined, allowRoot: boolean): string {
  const raw = prose(label, value, 512);
  const relative = path.posix.normalize(raw).replace(/\/$/, "");
  const segments = raw.split("/");
  if ((!allowRoot && relative === ".") || path.posix.isAbsolute(raw) ||
      /[:\\*?\[\]\n\t]/u.test(raw) || segments.includes("..") || segments.includes(".git") || segments.includes(".nexus")) {
    throw new Error(`${label} must be a workspace-relative path without traversal, metadata or glob segments`);
  }
  if (workspace === undefined) return relative;
  let current = workspace;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new Error(`${label} must not traverse a symbolic link`);
  }
  return relative;
}

function checks(label: string, value: unknown, workspace: string | undefined): PlanCheck[] {
  const parsed = items(label, value, MAX_CHECKS).map((item) => {
    const check = strictObject(label, item, ["id", "command", "cwd", "expectation", "timeoutSeconds", "required"], ["when", "materialInputs"]);
    const required = boolean(`${label}.required`, check.required);
    const condition = check.when === undefined ? undefined : strictObject(`${label}.when`, check.when, ["changedPaths"]);
    if (condition && !required) throw new Error(`${label} conditional checks must be required when applicable`);
    const changedPaths = condition && distinct(`${label}.when.changedPaths`, items(`${label}.when.changedPaths`, condition.changedPaths, 32, 1)
      .map((value) => workspacePath(`${label}.when.changedPaths`, value, workspace, true))).sort();
    const materialInputs = check.materialInputs === undefined ? undefined
      : distinct(`${label}.materialInputs`, items(`${label}.materialInputs`, check.materialInputs, 32, 1)
        .map((value) => workspacePath(`${label}.materialInputs`, value, workspace, false))).sort();
    return {
      id: text(`${label}.id`, check.id, 64, UNIT_ID),
      command: prose(`${label}.command`, check.command, 1000),
      cwd: workspacePath(`${label}.cwd`, check.cwd, workspace, true),
      expectation: prose(`${label}.expectation`, check.expectation),
      timeoutSeconds: integer(`${label}.timeoutSeconds`, check.timeoutSeconds, 1, 300),
      required,
      ...(changedPaths ? { when: { changedPaths } } : {}),
      ...(materialInputs ? { materialInputs } : {}),
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

function executionResources(label: string, value: unknown): ExecutionResourceRequest {
  const request = strictObject(label, value, ["cpuMilli", "memoryBytes"]);
  validateExecutionResources("batch plan", label, request);
  return { cpuMilli: request.cpuMilli, memoryBytes: request.memoryBytes };
}

function parseUnit(value: unknown, workspace: string | undefined): BatchPlanUnit {
  const unit = strictObject("plan unit", value, [
    "id", "title", "objective", "role", "required", "dependsOn", "mode", "scope",
    "acceptanceCriteria", "checks", "outputs", "handoffs",
  ], ["independentReview", "requires", "executionResources"]);
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
    ...(unit.executionResources === undefined ? {} : { executionResources: executionResources(`${label}.executionResources`, unit.executionResources) }),
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
  return normalizeBatchPlan(value, fs.realpathSync(workspace));
}

function normalizeBatchPlan(value: unknown, root?: string): BatchPlan {
  const input = strictObject("plan", value, ["version", "objective", "acceptanceCriteria", "checks", "risks", "assumptions", "blockers", "units"], ["execution"]);
  if (input.version !== 1) throw new Error("unsupported batch plan version");
  const parallel = input.execution === undefined ? undefined : strictObject("plan execution", input.execution, ["maxConcurrentUnits", "executionBudget"]);
  const plan: BatchPlan = {
    version: 1,
    objective: prose("objective", input.objective, 4000),
    acceptanceCriteria: proseList("acceptanceCriteria", input.acceptanceCriteria, 1),
    checks: checks("plan checks", input.checks, root),
    risks: proseList("risks", input.risks),
    assumptions: proseList("assumptions", input.assumptions),
    blockers: proseList("blockers", input.blockers),
    units: items("units", input.units, MAX_UNITS, 1).map((unit) => parseUnit(unit, root)),
    ...(parallel ? { execution: {
      maxConcurrentUnits: integer("plan execution.maxConcurrentUnits", parallel.maxConcurrentUnits, 2, MAX_UNITS),
      executionBudget: executionResources("plan execution.executionBudget", parallel.executionBudget),
    } } : {}),
  };
  if (!plan.checks.some((check) => check.required && !check.when)) throw new Error("plan needs a required final check");
  if (plan.units.some((unit) => unit.required && unit.mode === "write" && !unit.checks.some((check) => check.required && !check.when))) {
    throw new Error("required write units need at least one required check");
  }
  // Exercise the same structural contract without exposing a runnable spec or asking the scheduler to act.
  validateBatchSpec({
    objective: plan.objective,
    ...(plan.execution ? { policy: plan.execution, git: { isolate: true } } : {}),
    units: plan.units.map((unit) => ({
      id: unit.id,
      title: unit.title,
      prompt: unit.objective,
      role: unit.role,
      required: unit.required,
      dependsOn: unit.dependsOn,
      requires: unit.requires,
      executionResources: unit.executionResources,
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

function recordDigest(record: object): string {
  return sha256(JSON.stringify(record));
}

function gitReader(workspace: string): (args: string[], input?: string) => string {
  const pin = trustedGitArgs(workspace);
  return (args, input) => execFileSync("git", [...GIT_SAFE, ...pin, ...args], {
    cwd: workspace,
    env: safeGitEnv(undefined),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input,
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function captureBase(workspace: string, git: ReturnType<typeof gitReader>): BatchPlanBase {
  const worktree = fs.realpathSync(git(["rev-parse", "--show-toplevel"]).replace(/\n$/, ""));
  const repository = fs.realpathSync(path.resolve(workspace, git(["rev-parse", "--git-common-dir"]).replace(/\n$/, "")));
  const commit = text("plan base commit", git(["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]).trim(), 64, COMMIT_ID);
  const identity = recordDigest([repository, worktree].map((location) => {
    const stat = fs.statSync(location, { bigint: true });
    return [stat.dev.toString(), stat.ino.toString()];
  }));
  return { repository, worktree, commit, identity };
}

function parsePlanBase(value: unknown): BatchPlanBase {
  const base = strictObject("plan base", value, ["repository", "worktree", "commit", "identity"]);
  const repository = text("plan repository", base.repository, 4096);
  const worktree = text("plan worktree", base.worktree, 4096);
  if (!path.isAbsolute(repository) || !path.isAbsolute(worktree)) throw new Error("plan base paths must be absolute");
  return {
    repository,
    worktree,
    commit: text("plan base commit", base.commit, 64, COMMIT_ID),
    identity: text("plan base identity", base.identity, 64, SHA256),
  };
}

function verifyCurrentBase(workspace: string, expected: BatchPlanBase): void {
  if (expected.worktree !== workspace) throw new Error("accept the plan from its repository root worktree");
  const git = gitReader(workspace);
  const assertBase = () => {
    if (recordDigest(captureBase(workspace, git)) !== recordDigest(expected)) {
      throw new Error("the plan base or worktree changed; create and inspect a new draft");
    }
  };
  assertBase();
  // Only invoke status where Git can accurately account for the worktree and no configured driver can run.
  const supported = snapshotSupport(git, workspace, expected.commit);
  if ("unsupported" in supported) throw new Error(`cannot establish a clean plan base: ${supported.unsupported}`);
  const files = git(["ls-files", "-z", "--cached"]).split("\0").filter(Boolean);
  const refusal = driverRefusal(git, files);
  if (refusal) throw new Error(`cannot establish a clean plan base: ${refusal}`);
  // Keep the activity-produced, untracked Nexus state directory out of the cleanliness decision.
  const status = git(["status", "--porcelain=v1", "--untracked-files=all", "--", ":/", ":(top,exclude).nexus", ":(top,exclude).nexus/**"]);
  if (status) throw new Error("plan acceptance requires a clean worktree");
  if (git(["ls-files", "-z", "--cached", "--", ".nexus"])) throw new Error("plan acceptance cannot ignore tracked Nexus state");
  assertBase();
}

function operationIdForDraft(id: string): string {
  return `batch-${id}`;
}

export class BatchPlanStore {
  private readonly workspace: string;
  private readonly directory: string;

  constructor(workspace: string, stateRoot = path.join(path.dirname(defaultTaskStateDir()), "batch-plans")) {
    this.workspace = fs.realpathSync(workspace);
    this.directory = path.join(path.resolve(stateRoot), sha256(this.workspace));
  }

  private file(id: string, kind: "draft" | "review" | "acceptance" | "admission" = "draft"): string {
    text("draft id", id, 41, DRAFT_ID);
    const resolved = realpathAllowingMissing(this.directory);
    if (isPathWithin(resolved, this.workspace)) throw new Error("batch plan state must be outside the workspace");
    return path.join(resolved, kind === "draft" ? `${id}.json` : `${id}.${kind}.json`);
  }

  private withPlanGuard<T>(id: string, work: () => T): T {
    const directory = path.dirname(this.file(id));
    assertPrivateDir(directory);
    return withStateStoreGuard(directory, work);
  }

  create(value: unknown, provenance?: BatchPlanProvenance): BatchPlanDraft {
    const parsedProvenance = parseProvenance(provenance);
    const plan = validateBatchPlan(value, this.workspace);
    const id = `plan-${randomUUID()}`;
    // Non-Git and empty Git workspaces may still hold inspectable proposals.
    let base: BatchPlanBase | undefined;
    try { base = captureBase(this.workspace, gitReader(this.workspace)); } catch { /* no trustworthy Git base available */ }
    const snapshot: Omit<BatchPlanDraft, "digest"> = {
      version: 1,
      id,
      workspace: this.workspace,
      createdAt: new Date().toISOString(),
      plan,
      ...(parsedProvenance === undefined ? {} : { provenance: parsedProvenance }),
      ...(base === undefined ? {} : { base }),
    };
    const draft: BatchPlanDraft = { ...snapshot, digest: recordDigest(snapshot) };
    writePrivateJson(this.file(id), draft);
    return draft;
  }

  read(id: string): BatchPlanDraft {
    const raw = readPrivateJson(this.file(id), { label: "Batch plan draft", limit: MAX_BATCH_PLAN_BYTES * 2 });
    if (raw === undefined) throw new Error("batch plan draft was not found");
    return this.parseDraft(id, raw, true);
  }

  private parseDraft(id: string, raw: unknown, checkPaths: boolean): BatchPlanDraft {
    const record = strictObject("plan draft", raw, ["version", "id", "workspace", "digest", "createdAt", "plan"], ["provenance", "base"]);
    if (record.version !== 1 || record.id !== id || record.workspace !== this.workspace) {
      throw new Error("batch plan draft is incompatible with this workspace or id");
    }
    const digest = text("draft digest", record.digest, 64, SHA256);
    const plan = normalizeBatchPlan(record.plan, checkPaths ? this.workspace : undefined);
    const base = record.base === undefined ? undefined : parsePlanBase(record.base);
    const provenance = parseProvenance(record.provenance);
    const snapshot: Omit<BatchPlanDraft, "digest"> = {
      version: 1,
      id,
      workspace: this.workspace,
      createdAt: timestamp("draft time", record.createdAt),
      plan,
      ...(provenance === undefined ? {} : { provenance }),
      ...(base === undefined ? {} : { base }),
    };
    if (recordDigest(snapshot) !== digest) throw new Error("batch plan draft digest mismatch");
    return { ...snapshot, digest };
  }

  recordReview(id: string, planDigest: string, provenance: BatchPlanProvenance, modelOutput: unknown): BatchPlanReview {
    this.read(id);
    return this.withPlanGuard(id, () => {
      const draft = this.read(id);
      if (this.readAcceptance(id)) throw new Error("batch plan is already accepted");
      if (this.readReview(id)?.findings.some((finding) => finding.blocking)) {
        throw new Error("a blocking review requires a revised draft");
      }
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
    });
  }

  readReview(id: string): BatchPlanReview | undefined {
    const draft = this.read(id);
    const raw = readPrivateJson(this.file(id, "review"), { label: "Batch plan review", limit: MAX_BATCH_PLAN_BYTES });
    if (raw === undefined) return undefined;
    return this.parseReview(draft, raw);
  }

  private parseReview(draft: BatchPlanDraft, raw: unknown): BatchPlanReview {
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

  /** Persist one immutable operator decision before admitting its deterministic operation id. */
  accept(id: string, digest: string, reviewDigest?: string): BatchPlanAcceptance {
    // Validate the id and locate the existing private directory before taking its guard.
    const file = this.file(id, "acceptance");
    if (!fs.existsSync(this.file(id))) throw new Error("batch plan draft was not found");
    return this.withPlanGuard(id, () => {
      const prior = this.readAcceptance(id);
      const draft = prior?.draft ?? this.read(id);
      if (digest !== draft.digest) throw new Error("plan acceptance digest does not match the displayed draft");
      if (prior) {
        if (reviewDigest !== prior.review?.digest) throw new Error("plan acceptance must name the exact displayed review digest");
        return prior;
      }
      if (draft.plan.blockers.length) throw new Error("plan has unresolved blockers; create and inspect a revised draft");
      const review = this.readReview(id);
      if (review?.findings.some((finding) => finding.blocking)) {
        throw new Error("plan has a blocking review finding; create and inspect a revised draft");
      }
      if (reviewDigest !== review?.digest) throw new Error("plan acceptance must name the exact displayed review digest");
      if (!draft.base) throw new Error("plan acceptance needs a pinned Git base; create a draft in a repository with a commit");
      verifyCurrentBase(this.workspace, draft.base);
      const snapshot: Omit<BatchPlanAcceptance, "digest"> = {
        version: 1,
        operationId: operationIdForDraft(id),
        draft,
        base: draft.base,
        acceptedAt: new Date().toISOString(),
        ...(review === undefined ? {} : { review }),
      };
      const acceptance = { ...snapshot, digest: recordDigest(snapshot) };
      writePrivateJson(file, acceptance);
      return acceptance;
    });
  }

  readAcceptance(id: string): BatchPlanAcceptance | undefined {
    const raw = readPrivateJson(this.file(id, "acceptance"), { label: "Batch plan acceptance", limit: MAX_BATCH_PLAN_BYTES * 3 });
    if (raw === undefined) return undefined;
    const record = strictObject("plan acceptance", raw, ["version", "operationId", "draft", "base", "acceptedAt", "digest"], ["review"]);
    if (record.version !== 1 || record.operationId !== operationIdForDraft(id)) throw new Error("plan acceptance version or operation id is invalid");
    const draft = this.parseDraft(id, record.draft, false);
    const base = parsePlanBase(record.base);
    if (!draft.base || recordDigest(draft.base) !== recordDigest(base)) throw new Error("plan acceptance base does not match the draft");
    const review = record.review === undefined ? undefined : this.parseReview(draft, record.review);
    const snapshot: Omit<BatchPlanAcceptance, "digest"> = {
      version: 1,
      operationId: record.operationId,
      draft,
      base,
      acceptedAt: timestamp("plan acceptance time", record.acceptedAt),
      ...(review === undefined ? {} : { review }),
    };
    const digest = text("plan acceptance digest", record.digest, 64, SHA256);
    if (recordDigest(snapshot) !== digest) throw new Error("plan acceptance digest mismatch");
    return { ...snapshot, digest };
  }

  /** Reserve the operation before its runner can create worktrees or dispatch units. */
  reserveAdmission(acceptance: BatchPlanAcceptance): void {
    this.withPlanGuard(acceptance.draft.id, () => {
      this.assertCurrentBase(acceptance);
      const file = this.file(acceptance.draft.id, "admission");
      if (readPrivateJson(file, { label: "Batch plan admission" }) !== undefined) {
        throw new Error("The approved plan was already admitted. Restore its durable operation before resuming.");
      }
      writePrivateJson(file, {
        version: 1,
        operationId: acceptance.operationId,
        acceptanceDigest: acceptance.digest,
      });
    });
  }

  /** Recheck a persisted decision before creating its worktree. Historical receipts remain readable after HEAD moves. */
  assertCurrentBase(acceptance: BatchPlanAcceptance): void {
    const saved = this.readAcceptance(acceptance.draft.id);
    if (!saved || saved.digest !== acceptance.digest) throw new Error("the accepted plan snapshot could not be revalidated");
    // Recheck live scope paths as well as the clean pinned base before any new admission.
    validateBatchPlan(saved.draft.plan, this.workspace);
    verifyCurrentBase(this.workspace, saved.base);
  }

}
