import type { HarnessCandidate, HarnessImprovementRun, HarnessLibraryEntry, HarnessManifest, HirEvidenceRecord, HirTaskSuite, ProbeResult, PromotionReport } from "./types.js";

export interface ValidationResult { ok: boolean; errors: string[] }

const SAFE_ID = /^[A-Za-z0-9._-]{1,160}$/;
const SAFE_REL_PATH = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\-\/]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function isObject(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
function isString(v: unknown): v is string { return typeof v === "string"; }
function isBool(v: unknown): v is boolean { return typeof v === "boolean"; }
function isNonNegInt(v: unknown): v is number { return Number.isSafeInteger(v) && (v as number) >= 0; }

export function validateHarnessManifest(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(value)) return { ok: false, errors: ["manifest must be object"] };
  const m = value as Partial<HarnessManifest>;
  if (m.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!isString(m.id) || !SAFE_ID.test(m.id)) errors.push("invalid id");
  if (!isString(m.createdAt) || !ISO_DATE.test(m.createdAt)) errors.push("invalid createdAt");
  if (!isObject(m.source) || !["fixture", "path", "profile"].includes(String((m.source as any).kind)) || !isString((m.source as any).ref) || !(m.source as any).ref.trim()) errors.push("invalid source");
  if (!Array.isArray(m.components) || m.components.length < 1) errors.push("components must be non-empty array");
  else for (const [i, c] of m.components.entries()) {
    if (!isObject(c)) { errors.push(`component ${i} must be object`); continue; }
    if (!["system_prompt", "skill", "config_overlay", "tool_policy", "approval_policy", "sandbox_policy", "other"].includes(String(c.kind))) errors.push(`component ${i} invalid kind`);
    if (!isString(c.path) || !SAFE_REL_PATH.test(c.path)) errors.push(`component ${i} invalid path`);
    if (!isString(c.contentHash) || !c.contentHash) errors.push(`component ${i} invalid contentHash`);
    if (!isNonNegInt(c.bytes)) errors.push(`component ${i} invalid bytes`);
    if (!isBool(c.mutable)) errors.push(`component ${i} invalid mutable`);
  }
  return { ok: errors.length === 0, errors };
}

export function validateHirTaskSuite(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(value)) return { ok: false, errors: ["suite must be object"] };
  const s = value as Partial<HirTaskSuite>;
  if (s.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!isString(s.id) || !SAFE_ID.test(s.id)) errors.push("invalid id");
  if (!Array.isArray(s.cases) || s.cases.length < 1) errors.push("cases must be non-empty array");
  else {
    const ids = new Set<string>();
    for (const [i, c] of s.cases.entries()) {
      if (!isObject(c)) { errors.push(`case ${i} must be object`); continue; }
      if (!isString(c.id) || !SAFE_ID.test(c.id)) errors.push(`case ${i} invalid id`);
      else if (ids.has(c.id)) errors.push(`duplicate case id ${c.id}`); else ids.add(c.id);
      if (!isString(c.description) || !c.description.trim()) errors.push(`case ${i} invalid description`);
      if (!isString(c.prompt) || !c.prompt.trim()) errors.push(`case ${i} invalid prompt`);
      if (c.expected !== undefined) {
        if (!isObject(c.expected)) errors.push(`case ${i} invalid expected`);
        else {
          const e = c.expected as any;
          if (e.verifierCommand !== undefined && (!isString(e.verifierCommand) || !e.verifierCommand.trim() || e.verifierCommand.length > 4096)) errors.push(`case ${i} invalid verifierCommand`);
          if (e.artifactPath !== undefined && (!isString(e.artifactPath) || !SAFE_REL_PATH.test(e.artifactPath))) errors.push(`case ${i} invalid artifactPath`);
          if (e.rubricRef !== undefined && !isString(e.rubricRef)) errors.push(`case ${i} invalid rubricRef`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateHirRun(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(value)) return { ok: false, errors: ["run must be object"] };
  const r = value as Partial<HarnessImprovementRun>;
  if (r.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!isString(r.id) || !SAFE_ID.test(r.id)) errors.push("invalid id");
  const statuses = ["CREATED","BASELINING","PROPOSING","GATING","PROBING","COMPARING","COMPOSING","REFLECTING","WAITING_OPERATOR","PAUSED","BLOCKED","COMPLETED","CANCELLED","FAILED"];
  if (!statuses.includes(String(r.status))) errors.push("invalid status");
  if (!isString(r.createdAt) || !ISO_DATE.test(r.createdAt)) errors.push("invalid createdAt");
  if (!isString(r.updatedAt) || !ISO_DATE.test(r.updatedAt)) errors.push("invalid updatedAt");
  if (!isString(r.baseHarnessId) || !SAFE_ID.test(r.baseHarnessId)) errors.push("invalid baseHarnessId");
  if (!isString(r.taskSuiteRef) || !r.taskSuiteRef.trim()) errors.push("invalid taskSuiteRef");
  if (!isObject(r.budgets)) errors.push("invalid budgets");
  else {
    const b = r.budgets as any;
    for (const [k, min, max] of [["maxRounds",1,10],["maxCandidatesPerRound",1,8],["maxProbes",1,64],["maxWallClockMs",1000,86_400_000],["maxProbeWallClockMs",1000,3_600_000],["maxConcurrentProbes",1,1]] as const) {
      if (!Number.isSafeInteger(b[k]) || b[k] < min || b[k] > max) errors.push(`invalid budgets.${k}`);
    }
    if (b.maxTokens !== undefined && (!Number.isSafeInteger(b.maxTokens) || b.maxTokens < 1)) errors.push("invalid budgets.maxTokens");
  }
  if (!isObject(r.policy)) errors.push("invalid policy");
  else {
    const p = r.policy as any;
    if (p.allowLiveProfileMutation !== false) errors.push("policy.allowLiveProfileMutation must be false");
    if (p.allowRepoMutation !== false) errors.push("policy.allowRepoMutation must be false");
    if (p.allowNetwork !== false) errors.push("policy.allowNetwork must be false");
    if (p.redactSecrets !== true) errors.push("policy.redactSecrets must be true");
    if (p.approvalModePinned !== "pinned") errors.push("policy.approvalModePinned must be pinned");
  }
  for (const k of ["rounds", "candidateIds", "probeIds", "evidenceIds"] as const) if (!Array.isArray((r as any)[k])) errors.push(`invalid ${k}`);
  if (!isObject(r.actualUsage)) errors.push("invalid actualUsage");
  else {
    const u = r.actualUsage as any;
    for (const k of ["probes", "wallClockMs", "tokens"]) if (!isNonNegInt(u[k])) errors.push(`invalid actualUsage.${k}`);
  }
  return { ok: errors.length === 0, errors };
}

export function validateHarnessCandidate(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(value)) return { ok: false, errors: ["candidate must be object"] };
  const c = value as Partial<HarnessCandidate>;
  if (c.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!isString(c.id) || !SAFE_ID.test(c.id)) errors.push("invalid id");
  if (!isString(c.runId) || !SAFE_ID.test(c.runId)) errors.push("invalid runId");
  if (!Number.isSafeInteger(c.round) || (c.round as number) < 0) errors.push("invalid round");
  if (!isString(c.baseHarnessId) || !SAFE_ID.test(c.baseHarnessId)) errors.push("invalid baseHarnessId");
  if (!isString(c.treeRef) || !c.treeRef.trim()) errors.push("invalid treeRef");
  if (!isString(c.diffRef)) errors.push("invalid diffRef");
  if (!isObject(c.proposal)) errors.push("invalid proposal");
  if (!isObject(c.gate) || !["PENDING","PASS","FAIL"].includes(String((c.gate as any).status)) || !Array.isArray((c.gate as any).findings)) errors.push("invalid gate");
  return { ok: errors.length === 0, errors };
}

export function validateProbeResult(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(value)) return { ok: false, errors: ["probe result must be object"] };
  const p = value as Partial<ProbeResult>;
  if (p.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!isString(p.id) || !SAFE_ID.test(p.id)) errors.push("invalid id");
  if (!isString(p.runId) || !SAFE_ID.test(p.runId)) errors.push("invalid runId");
  if (!isString(p.candidateId) || !p.candidateId) errors.push("invalid candidateId");
  if (!isString(p.caseId) || !p.caseId) errors.push("invalid caseId");
  if (!["SUCCEEDED","FAILED","TIMED_OUT","CANCELLED","BLOCKED"].includes(String(p.status))) errors.push("invalid status");
  if (!isString(p.startedAt) || !ISO_DATE.test(p.startedAt)) errors.push("invalid startedAt");
  if (!isString(p.endedAt) || !ISO_DATE.test(p.endedAt)) errors.push("invalid endedAt");
  if (!isObject(p.metrics)) errors.push("invalid metrics");
  else {
    const m = p.metrics as any;
    if (!isNonNegInt(m.wallClockMs)) errors.push("invalid metrics.wallClockMs");
    if (!isNonNegInt(m.tokens)) errors.push("invalid metrics.tokens");
    if (!isNonNegInt(m.toolErrors)) errors.push("invalid metrics.toolErrors");
    if (!(m.verifierPass === null || isBool(m.verifierPass))) errors.push("invalid metrics.verifierPass");
  }
  if (!isObject(p.artifacts)) errors.push("invalid artifacts");
  if (!Array.isArray(p.observations)) errors.push("invalid observations");
  return { ok: errors.length === 0, errors };
}

export function validatePromotionReport(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(value)) return { ok: false, errors: ["report must be object"] };
  const r = value as Partial<PromotionReport>;
  if (r.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!isString(r.id) || !SAFE_ID.test(r.id)) errors.push("invalid id");
  if (!isString(r.runId) || !SAFE_ID.test(r.runId)) errors.push("invalid runId");
  if (!isString(r.baseHarnessId) || !SAFE_ID.test(r.baseHarnessId)) errors.push("invalid baseHarnessId");
  if (!isString(r.status)) errors.push("invalid status");
  if (!isString(r.createdAt) || !ISO_DATE.test(r.createdAt)) errors.push("invalid createdAt");
  if (!Array.isArray(r.changes)) errors.push("invalid changes");
  if (!Array.isArray(r.scorecard)) errors.push("invalid scorecard");
  if (!Array.isArray(r.applyInstructions)) errors.push("invalid applyInstructions");
  if (!Array.isArray(r.nonPromotable)) errors.push("invalid nonPromotable");
  if (!isString(r.noApplyWarning) || !r.noApplyWarning.trim()) errors.push("invalid noApplyWarning");
  return { ok: errors.length === 0, errors };
}

export function validateLibraryEntry(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(value)) return { ok: false, errors: ["library entry must be object"] };
  const e = value as Partial<HarnessLibraryEntry>;
  if (e.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!isString(e.id) || !SAFE_ID.test(e.id)) errors.push("invalid id");
  if (!isString(e.runId) || !SAFE_ID.test(e.runId)) errors.push("invalid runId");
  if (!isString(e.createdAt) || !ISO_DATE.test(e.createdAt)) errors.push("invalid createdAt");
  if (!isString(e.updatedAt) || !ISO_DATE.test(e.updatedAt)) errors.push("invalid updatedAt");
  if (!["draft","accepted","rejected"].includes(String(e.status))) errors.push("invalid status");
  if (!isObject(e.scope)) errors.push("invalid scope");
  if (!isString(e.statement) || !e.statement.trim()) errors.push("invalid statement");
  if (!Array.isArray(e.evidenceIds)) errors.push("invalid evidenceIds");
  if (!["high","medium","low"].includes(String(e.confidence))) errors.push("invalid confidence");
  return { ok: errors.length === 0, errors };
}

export function assertValid<T>(name: string, value: T, validator: (v: unknown) => ValidationResult): T {
  const res = validator(value);
  if (!res.ok) throw new Error(`Invalid ${name}: ${res.errors.join("; ")}`);
  return value;
}
