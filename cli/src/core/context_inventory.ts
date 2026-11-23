import { createHash } from "node:crypto";
import { countTokens } from "../tokens.js";

export type ContextScope = "turn" | "session" | "task" | "repository" | "profile" | "user";
export type ContextFreshness = "current" | "stale" | "unknown";
export type ContextTrust = "operator_input_untrusted" | "model_generated_unverified" | "tool_output_unverified" | "persisted_unverified" | "system_instruction" | "verified_evidence";
export type ContextSourceStatus = "ok" | "partial" | "failed";

export interface ContextInventoryItem {
  id: string;
  sourceType: string;
  sourceLocation: string;
  scope: ContextScope;
  observedAt: string;
  freshness: ContextFreshness;
  freshnessRule?: string;
  trust: ContextTrust;
  retention: string;
  inclusionReason: string;
  retrievalMethod: string;
  estimatedTokens: number;
  sourceRefs?: string[];
}

export interface ContextSourceMeasurement {
  source: string;
  status: ContextSourceStatus;
  durationMs: number;
  itemCount: number;
  includedItemCount: number;
  omittedItemCount: number;
  estimatedTokens: number;
  detail?: string;
}

export interface ContextInventorySnapshot {
  schemaVersion: 1;
  capturedAt: string;
  sessionId?: string;
  taskId?: string;
  workspace?: string;
  coverage: "complete" | "partial";
  coverageGaps: string[];
  items: ContextInventoryItem[];
  sourceMeasurements: ContextSourceMeasurement[];
  metrics: {
    assemblyDurationMs: number;
    includedItems: number;
    omittedItems: number;
    estimatedTokens: number;
    tokenSource: "client_estimate";
    contextLimit?: number;
    contextLimitSource?: string;
    lastRequestTokens?: number;
    lastRequestTokenSource?: string;
    budgetStatus: "within_budget" | "over_budget" | "unknown";
  };
}

export interface ContextSourceItemInput {
  sourceType: string;
  sourceLocation: string;
  scope: ContextScope;
  content: string;
  trust: ContextTrust;
  retention: string;
  inclusionReason: string;
  retrievalMethod: string;
  freshness?: ContextFreshness;
  freshnessRule?: string;
  sourceRefs?: string[];
}

export interface ContextInventoryInput {
  capturedAt?: string;
  sessionId?: string;
  taskId?: string;
  workspace?: string;
  sources: Array<{ name: string; status: ContextSourceStatus; durationMs: number; items: ContextSourceItemInput[]; detail?: string }>;
  coverageGaps?: string[];
  maxItems?: number;
  contextLimit?: number;
  contextLimitSource?: string;
  lastRequestTokens?: number;
  lastRequestTokenSource?: string;
}

const DEFAULT_MAX_ITEMS = 500;
const MAX_SOURCE_DETAIL = 240;

function stableId(sourceType: string, sourceLocation: string, scope: ContextScope): string {
  const digest = createHash("sha256").update(`${sourceType}\0${sourceLocation}\0${scope}`).digest("hex").slice(0, 24);
  return `ctx_${digest}`;
}

function metadataText(value: string, max = 1000): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, max);
}

function boundedDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value * 100) / 100) : 0;
}

/** Build a content-free inventory. Source text is counted and discarded; it is never included in the returned record. */
export function buildContextInventory(input: ContextInventoryInput): ContextInventorySnapshot {
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const started = performance.now();
  const maxItems = Number.isSafeInteger(input.maxItems) && (input.maxItems ?? 0) > 0 ? input.maxItems! : DEFAULT_MAX_ITEMS;
  const candidates: ContextInventoryItem[] = [];
  const sourceMeasurements: ContextSourceMeasurement[] = [];
  let totalCandidateItems = 0;
  for (const source of input.sources) {
    let estimatedTokens = 0;
    const remaining = Math.max(0, maxItems - candidates.length);
    const included = source.items.slice(0, remaining);
    totalCandidateItems += source.items.length;
    for (const item of included) {
      const tokens = countTokens(item.content);
      estimatedTokens += tokens;
      const sourceType = metadataText(item.sourceType, 80);
      const sourceLocation = metadataText(item.sourceLocation);
      const freshness = item.freshnessRule ? item.freshness ?? "unknown" : "unknown";
      candidates.push({
        id: stableId(sourceType, sourceLocation, item.scope),
        sourceType,
        sourceLocation,
        scope: item.scope,
        observedAt: capturedAt,
        freshness,
        ...(item.freshnessRule ? { freshnessRule: metadataText(item.freshnessRule) } : {}),
        trust: item.trust,
        retention: metadataText(item.retention, 120),
        inclusionReason: metadataText(item.inclusionReason),
        retrievalMethod: metadataText(item.retrievalMethod, 100),
        estimatedTokens: tokens,
        ...(item.sourceRefs?.length ? { sourceRefs: item.sourceRefs.slice(0, 100).map((ref) => metadataText(ref, 200)) } : {}),
      });
    }
    sourceMeasurements.push({
      source: source.name,
      status: source.status,
      durationMs: boundedDuration(source.durationMs),
      itemCount: source.items.length,
      includedItemCount: included.length,
      omittedItemCount: source.items.length - included.length,
      estimatedTokens,
      ...(source.detail ? { detail: source.detail.replace(/[\r\n\t]/g, " ").slice(0, MAX_SOURCE_DETAIL) } : {}),
    });
  }

  // Keep a deterministic prefix so the same source order produces the same bounded snapshot and token work.
  const items = candidates;
  const omittedItems = totalCandidateItems - items.length;
  const gaps = [...(input.coverageGaps ?? [])];
  if (omittedItems) gaps.push(`inventory item limit omitted ${omittedItems} item(s)`);
  if (sourceMeasurements.some((source) => source.status !== "ok")) gaps.push("one or more context sources were partial or unavailable");
  const estimatedTokens = items.reduce((sum, item) => sum + item.estimatedTokens, 0);
  const coverage: ContextInventorySnapshot["coverage"] = gaps.length ? "partial" : "complete";
  const limit = input.contextLimit;
  const budgetStatus = limit === undefined || gaps.length > 0 || omittedItems > 0 || sourceMeasurements.some((source) => source.status !== "ok")
    ? "unknown"
    : estimatedTokens <= limit ? "within_budget" : "over_budget";

  return {
    schemaVersion: 1,
    capturedAt,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.workspace ? { workspace: input.workspace } : {}),
    coverage,
    coverageGaps: [...new Set(gaps)],
    items,
    sourceMeasurements,
    metrics: {
      assemblyDurationMs: boundedDuration(performance.now() - started),
      includedItems: items.length,
      omittedItems,
      estimatedTokens,
      tokenSource: "client_estimate",
      ...(limit !== undefined ? { contextLimit: limit } : {}),
      ...(input.contextLimitSource ? { contextLimitSource: input.contextLimitSource } : {}),
      ...(input.lastRequestTokens !== undefined ? { lastRequestTokens: input.lastRequestTokens } : {}),
      ...(input.lastRequestTokenSource ? { lastRequestTokenSource: input.lastRequestTokenSource } : {}),
      budgetStatus,
    },
  };
}

/** Rebuild only what legacy/session records can establish; repository freshness remains unknown. */
export function inventorySourcesFromMessages(messages: readonly any[], options: { archived?: boolean; sourcePrefix?: string } = {}): ContextSourceItemInput[] {
  const archived = Boolean(options.archived);
  const sourcePrefix = options.sourcePrefix ?? (archived ? "archive" : "session");
  const items: ContextSourceItemInput[] = [];
  messages.forEach((message, index) => {
    const content = typeof message?.content === "string" ? message.content : safeJson(message?.content);
    if (!content) return;
    let sourceType: string;
    let scope: ContextScope = "session";
    let trust: ContextTrust;
    if (message?.role === "tool") {
      sourceType = "tool_output";
      trust = "tool_output_unverified";
    } else if (message?.role === "assistant") {
      sourceType = "model_output";
      trust = "model_generated_unverified";
    } else if (message?.role === "user" && message?.harness === "skill-note") {
      sourceType = "skill_note";
      scope = "profile";
      trust = "persisted_unverified";
    } else if (message?.role === "user") {
      sourceType = "operator_message";
      trust = "operator_input_untrusted";
    } else if (message?.role === "system" && content.startsWith("[Structured Context Memory - durable task state]")) {
      sourceType = "compaction_summary";
      trust = "persisted_unverified";
    } else {
      sourceType = "system_context";
      trust = "persisted_unverified";
    }
    const location = `${sourcePrefix}:message:${index}:${String(message?.role ?? "unknown")}`;
    const sourceRefs = [message?.tool_call_id, message?.id]
      .filter((reference): reference is string => typeof reference === "string" && reference.length > 0)
      .map((reference, referenceIndex) => `${referenceIndex === 0 && typeof message?.tool_call_id === "string" ? "tool-call" : "message"}:${createHash("sha256").update(reference).digest("hex").slice(0, 16)}`);
    items.push({
      sourceType,
      sourceLocation: location,
      scope,
      content,
      trust,
      retention: archived ? "session_archive" : "session",
      inclusionReason: archived ? "retained original history referenced by compaction archive" : "conversation history carried by session",
      retrievalMethod: archived ? "durable_archive" : "transcript_replay",
      freshness: "unknown",
      freshnessRule: archived ? "archived transcript is historical; no workspace fingerprint is retained" : "conversation history is historical and may describe an earlier workspace state",
      ...(sourceRefs.length ? { sourceRefs } : {}),
    });
  });
  return items;
}

/** Build content-free provenance from durable session fields and an optional archive read. */
export function buildSessionContextInventory(session: {
  id: string;
  sessionId?: string;
  taskId?: string;
  workspace?: string;
  workspacePath?: string;
  messages?: readonly any[];
  objective?: any;
  durableNotes?: string[];
  activePlan?: unknown[];
  compactionProvenance?: { recordId: string; predecessorIds: string[]; summaryContent?: string } | null;
  lastTurn?: { tokenAccounting?: { contextLimit: number; contextSource: string; lastRequest?: { promptTokens: number; source: string } } } | null;
}, archived: { messages?: readonly any[]; unreadableLines?: number } = {}): ContextInventorySnapshot {
  const capturedAt = new Date().toISOString();
  const started = performance.now();
  const activeItems = inventorySourcesFromMessages(session.messages ?? []);
  if (session.objective) activeItems.push({ sourceType: "objective_ledger", sourceLocation: "task:objective-ledger", scope: "task", content: safeJson(session.objective), trust: "persisted_unverified", retention: "task", inclusionReason: "durable task objective and requirements", retrievalMethod: "durable_task_state", sourceRefs: Array.isArray(session.objective.requirements) ? session.objective.requirements.map((requirement: any, index: number) => `requirement:${typeof requirement?.id === "string" ? requirement.id : index + 1}`) : undefined });
  if (session.durableNotes?.length) session.durableNotes.forEach((note, index) => activeItems.push({ sourceType: "durable_note", sourceLocation: `task:durable-note:${index}`, scope: "task", content: note, trust: "persisted_unverified", retention: "task", inclusionReason: "durable task note retained across compaction", retrievalMethod: "durable_task_state" }));
  if (session.activePlan?.length) activeItems.push({ sourceType: "active_plan", sourceLocation: "task:active-plan", scope: "task", content: safeJson(session.activePlan), trust: "persisted_unverified", retention: "task", inclusionReason: "current durable plan state", retrievalMethod: "durable_task_state" });
  if (session.compactionProvenance) activeItems.push({ sourceType: "compaction_provenance", sourceLocation: `task:compaction:${session.compactionProvenance.recordId}`, scope: "session", content: session.compactionProvenance.summaryContent ?? "compaction summary; content reference only", trust: "persisted_unverified", retention: "session_archive", inclusionReason: "summary links to predecessor records whose originals are retained in the history archive", retrievalMethod: "compaction_record", sourceRefs: [session.compactionProvenance.recordId, ...session.compactionProvenance.predecessorIds] });
  const activeDurationMs = Math.max(0, performance.now() - started);
  const archivedStarted = performance.now();
  const archivedItems = inventorySourcesFromMessages(archived.messages ?? [], { archived: true, sourcePrefix: "archive" });
  const archivedDurationMs = Math.max(0, performance.now() - archivedStarted);
  const tokenAccounting = session.lastTurn?.tokenAccounting;
  return buildContextInventory({
    capturedAt,
    sessionId: session.sessionId ?? session.id,
    taskId: session.taskId ?? session.id,
    workspace: session.workspace ?? session.workspacePath,
    sources: [
      { name: "durable_session_state", status: "partial", durationMs: activeDurationMs, items: activeItems, detail: "session record sources only; inference-time prompt components and provider tool schemas are not available in this save path" },
      { name: "session_archive", status: archived.unreadableLines ? "partial" : "ok", durationMs: archivedDurationMs, items: archivedItems, detail: archived.unreadableLines ? `${archived.unreadableLines} unreadable archive line(s)` : undefined },
    ],
    coverageGaps: [
      "session save does not capture the exact inference request or split the composite system prompt into source items",
      ...(archived.unreadableLines ? ["one or more archived history records could not be read"] : []),
    ],
    ...(tokenAccounting ? { contextLimit: tokenAccounting.contextLimit, contextLimitSource: tokenAccounting.contextSource, lastRequestTokens: tokenAccounting.lastRequest?.promptTokens, lastRequestTokenSource: tokenAccounting.lastRequest?.source } : {}),
  });
}

export function mergeContextInventorySnapshots(primary: ContextInventorySnapshot, supplemental: ContextInventorySnapshot): ContextInventorySnapshot {
  const byId = new Map<string, ContextInventoryItem>();
  for (const item of [...primary.items, ...supplemental.items]) if (!byId.has(item.id)) byId.set(item.id, item);
  const combinedItems = [...byId.values()];
  const items = combinedItems.slice(0, DEFAULT_MAX_ITEMS);
  const measurements = new Map<string, ContextSourceMeasurement>();
  for (const source of primary.sourceMeasurements) measurements.set(source.source, source);
  // The archive is read at export time, so its current measurement supersedes an older empty archive record.
  for (const source of supplemental.sourceMeasurements) if (source.source === "session_archive") measurements.set(source.source, source);
  const omittedByMerge = combinedItems.length - items.length;
  const coverageGaps = [...new Set([
    ...supplemental.coverageGaps,
    ...primary.coverageGaps,
    ...(omittedByMerge ? [`merged inventory item limit omitted ${omittedByMerge} item(s)`] : []),
  ])];
  const estimatedTokens = items.reduce((sum, item) => sum + item.estimatedTokens, 0);
  return {
    ...supplemental,
    ...primary,
    coverage: coverageGaps.length ? "partial" : "complete",
    coverageGaps,
    items,
    sourceMeasurements: [...measurements.values()],
    metrics: {
      ...supplemental.metrics,
      ...primary.metrics,
      includedItems: items.length,
      omittedItems: supplemental.metrics.omittedItems + primary.metrics.omittedItems + omittedByMerge,
      estimatedTokens,
      budgetStatus: (primary.metrics.contextLimit ?? supplemental.metrics.contextLimit) === undefined
        ? "unknown"
        : coverageGaps.length > 0 || items.some((item) => item.freshness === "unknown") || primary.metrics.omittedItems > 0 || supplemental.metrics.omittedItems > 0
          ? "unknown"
        : estimatedTokens <= (primary.metrics.contextLimit ?? supplemental.metrics.contextLimit)!
          ? "within_budget"
          : "over_budget",
    },
  };
}

/** Persistence cannot establish that a previously current observation still matches workspace/session state. */
export function markPersistedContextFreshnessUnknown(snapshot: ContextInventorySnapshot): ContextInventorySnapshot {
  const invalidated = snapshot.items.some((item) => item.freshness === "current");
  if (!invalidated) return snapshot;
  const coverageGaps = [...new Set([...snapshot.coverageGaps, "persisted context freshness was not revalidated against current session and workspace state"])];
  return {
    ...snapshot,
    coverage: "partial",
    coverageGaps,
    items: snapshot.items.map((item) => item.freshness === "current"
      ? { ...item, freshness: "unknown", freshnessRule: "persisted observation requires revalidation before it can be considered current" }
      : item),
    metrics: { ...snapshot.metrics, budgetStatus: "unknown" },
  };
}

function safeJson(value: unknown): string {
  if (value === undefined || value === null) return "";
  try { return JSON.stringify(value); } catch { return "[unserializable content]"; }
}

export function isContextInventorySnapshot(value: unknown): value is ContextInventorySnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as ContextInventorySnapshot;
  const safeText = (text: unknown, max = 1000) => typeof text === "string" && text.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(text);
  const scopes = ["turn", "session", "task", "repository", "profile", "user"];
  const freshness = ["current", "stale", "unknown"];
  const trust = ["operator_input_untrusted", "model_generated_unverified", "tool_output_unverified", "persisted_unverified", "system_instruction", "verified_evidence"];
  return snapshot.schemaVersion === 1 &&
    safeText(snapshot.capturedAt, 80) &&
    (snapshot.sessionId === undefined || safeText(snapshot.sessionId, 200)) &&
    (snapshot.taskId === undefined || safeText(snapshot.taskId, 200)) &&
    (snapshot.workspace === undefined || safeText(snapshot.workspace, 1000)) &&
    (snapshot.coverage === "complete" || snapshot.coverage === "partial") &&
    Array.isArray(snapshot.coverageGaps) && snapshot.coverageGaps.length <= 100 && snapshot.coverageGaps.every((gap) => safeText(gap)) &&
    Array.isArray(snapshot.items) && snapshot.items.length <= DEFAULT_MAX_ITEMS && snapshot.items.every((item) => item && safeText(item.id, 80) && safeText(item.sourceType, 80) && safeText(item.sourceLocation) && scopes.includes(item.scope) && safeText(item.observedAt, 80) && freshness.includes(item.freshness) && (item.freshnessRule === undefined || safeText(item.freshnessRule)) && (item.freshness === "unknown" || safeText(item.freshnessRule)) && trust.includes(item.trust) && safeText(item.retention) && safeText(item.inclusionReason) && safeText(item.retrievalMethod, 100) && Number.isFinite(item.estimatedTokens) && item.estimatedTokens >= 0 && (item.sourceRefs === undefined || (Array.isArray(item.sourceRefs) && item.sourceRefs.length <= 100 && item.sourceRefs.every((ref) => safeText(ref, 200))))) &&
    Array.isArray(snapshot.sourceMeasurements) && snapshot.sourceMeasurements.length <= 100 && snapshot.sourceMeasurements.every((source) => source && safeText(source.source, 100) && ["ok", "partial", "failed"].includes(source.status) && Number.isFinite(source.durationMs) && source.durationMs >= 0 && Number.isFinite(source.itemCount) && source.itemCount >= 0 && Number.isFinite(source.includedItemCount) && source.includedItemCount >= 0 && Number.isFinite(source.omittedItemCount) && source.omittedItemCount >= 0 && Number.isFinite(source.estimatedTokens) && source.estimatedTokens >= 0 && (source.detail === undefined || safeText(source.detail, MAX_SOURCE_DETAIL))) &&
    Boolean(snapshot.metrics && Number.isFinite(snapshot.metrics.assemblyDurationMs) && snapshot.metrics.assemblyDurationMs >= 0 && Number.isFinite(snapshot.metrics.estimatedTokens) && snapshot.metrics.estimatedTokens >= 0 && Number.isFinite(snapshot.metrics.includedItems) && snapshot.metrics.includedItems >= 0 && Number.isFinite(snapshot.metrics.omittedItems) && snapshot.metrics.omittedItems >= 0 && snapshot.metrics.tokenSource === "client_estimate" && ["within_budget", "over_budget", "unknown"].includes(snapshot.metrics.budgetStatus) && (snapshot.metrics.contextLimit === undefined || (Number.isFinite(snapshot.metrics.contextLimit) && snapshot.metrics.contextLimit > 0)) && (snapshot.metrics.lastRequestTokens === undefined || (Number.isFinite(snapshot.metrics.lastRequestTokens) && snapshot.metrics.lastRequestTokens >= 0)));
}

export type ContextMaturityLevel = 1 | 2 | 3 | 4 | 5;

export interface ContextMaturityDimension {
  dimension: "navigability" | "retrieval_speed" | "freshness" | "compounding_value";
  level: ContextMaturityLevel | null;
  stage: string | null;
  evidence: Array<{ reference: string; finding: string; status: "observed" | "measured" | "unknown" }>;
  unmetCriteria: string[];
  knownLimitations: string[];
  nextImprovement: string;
}

export interface ContextMaturityAssessment {
  schemaVersion: 1;
  assessedAt: string;
  basis: "deterministic_client_evidence";
  dimensions: ContextMaturityDimension[];
}

const STAGES: Record<ContextMaturityLevel, string> = {
  1: "Ad hoc",
  2: "Exploratory",
  3: "Standardizing",
  4: "Managed",
  5: "Competitive asset",
};

/** Rule-based, per-dimension assessment; it does not use model judgment and has no aggregate score. */
export function assessContextMaturity(snapshot: ContextInventorySnapshot, evidence: { hasDurableKnowledge: boolean; hasActiveSkills: boolean }): ContextMaturityAssessment {
  const inventoryExists = snapshot.items.length > 0;
  const allFreshnessKnown = inventoryExists && snapshot.items.every((item) => item.freshness !== "unknown");
  const hasMeasuredSourceLatency = snapshot.sourceMeasurements.some((source) => source.durationMs > 0);
  const carriedMemoryObserved = snapshot.items.some((item) => item.sourceType === "durable_note" || item.sourceType === "compaction_summary" || item.sourceType === "compaction_provenance");
  const dimension = (value: Omit<ContextMaturityDimension, "stage">): ContextMaturityDimension => ({ ...value, stage: value.level === null ? null : STAGES[value.level] });
  return {
    schemaVersion: 1,
    assessedAt: snapshot.capturedAt,
    basis: "deterministic_client_evidence",
    dimensions: [
      dimension({
        dimension: "navigability", level: inventoryExists ? 2 : null,
        evidence: [
          { reference: "cli/src/core/context_inventory.ts:inventorySourcesFromMessages", finding: `${snapshot.items.length} source-linked context item(s) are represented without storing their content.`, status: inventoryExists ? "observed" : "unknown" },
          { reference: "cli/src/agent.ts:requestMessages", finding: "Conversation replay and pinned task context exist, but runtime prompt components are not yet captured as one complete inventory.", status: "observed" },
          ...(evidence.hasActiveSkills ? [{ reference: "cli/src/skills.ts:SkillManager.getPromptSection", finding: "Path and trust metadata exist for skills; active prompt inclusion is not represented in the persisted message inventory.", status: "observed" as const }] : []),
        ],
        unmetCriteria: ["Complete source-by-source provenance for all content included in each inference request.", "A unified retrieval graph connecting repository, task, session, profile, and memory items."],
        knownLimitations: snapshot.coverageGaps,
        nextImprovement: "Capture this inventory at request construction and attach source relationships to each admitted item.",
      }),
      dimension({
        dimension: "retrieval_speed", level: hasMeasuredSourceLatency ? 2 : null,
        evidence: [
          { reference: "cli/src/core/context_inventory.ts:buildContextInventory", finding: hasMeasuredSourceLatency ? "Source and total inventory-assembly durations are recorded for this capture; they are not inference latency measurements." : "No source retrieval duration was measured in this snapshot.", status: hasMeasuredSourceLatency ? "measured" : "unknown" },
          { reference: "cli/src/agent.ts:admitContext", finding: "Context admission enforces token estimates and output/tool reserves; this is budget evidence, not a retrieval latency SLO.", status: "observed" },
        ],
        unmetCriteria: ["Repeated per-inference source latency and timeout measurements.", "A defined retrieval latency budget/SLO and measured failure rate."],
        knownLimitations: ["Inventory timings measure local collection only; token counts are client estimates."],
        nextImprovement: "Instrument each request's source assembly and evaluate latency distributions before setting an SLO.",
      }),
      dimension({
        dimension: "freshness", level: inventoryExists ? allFreshnessKnown ? 2 : 1 : null,
        evidence: [
          { reference: "cli/src/core/context_inventory.ts:ContextFreshness", finding: `${snapshot.items.filter((item) => item.freshness === "unknown").length} item(s) have unknown freshness; no current-state claim is inferred from persistence.`, status: "observed" },
          { reference: "cli/src/core/candidate.ts:CandidateTracker", finding: "Verification receipts have applicability invalidation, but ordinary context observations do not consistently carry the same workspace fingerprint.", status: "observed" },
        ],
        unmetCriteria: ["Per-source version/fingerprint and invalidation rules for repository-derived observations.", "A freshness objective backed by observed change-to-invalidation latency."],
        knownLimitations: ["Session and archived history can describe prior workspace states; this inventory marks those facts unknown rather than current."],
        nextImprovement: "Bind repository-derived context to a workspace fingerprint and invalidate or mark it historical when that identity changes.",
      }),
      dimension({
        dimension: "compounding_value", level: carriedMemoryObserved ? 2 : inventoryExists ? 1 : null,
        evidence: [
          { reference: "cli/src/session.ts:SessionManager.saveSession", finding: carriedMemoryObserved ? "A durable note or compaction link is carried in the observed session context; it remains unverified memory, not evidence." : "No durable note or compaction link was observed in carried session context.", status: carriedMemoryObserved ? "observed" : "unknown" },
          { reference: "cli/src/knowledge.ts:KnowledgeGraph", finding: evidence.hasDurableKnowledge ? "Workspace knowledge entries exist, but this diagnostic cannot prove exact inference-time inclusion or task value; persisted entries remain unverified memory, not evidence." : "No durable project knowledge entry was observed for this session.", status: evidence.hasDurableKnowledge ? "observed" : "unknown" },
        ],
        unmetCriteria: ["Observed reuse of promoted knowledge across turns with source links.", "Held-out evidence that accumulated context improves task quality or time without harming correctness."],
        knownLimitations: ["A persisted summary or knowledge entry is not proof of correctness; no improvement claim is made."],
        nextImprovement: "Add a reviewed, provenance-preserving promotion path only after memory safety tests cover poisoning, scope, and deletion.",
      }),
    ],
  };
}

export function renderContextMaturityText(assessment: ContextMaturityAssessment): string {
  return assessment.dimensions.map((item) => {
    const heading = `${item.dimension}: ${item.level === null ? "insufficient evidence" : `Stage ${item.level} — ${item.stage}`}`;
    return [heading, ...item.evidence.map((e) => `  evidence [${e.status}] ${e.reference}: ${e.finding}`), ...item.unmetCriteria.map((gap) => `  gap: ${gap}`), ...item.knownLimitations.map((limit) => `  limitation: ${limit}`), `  next: ${item.nextImprovement}`].join("\n");
  }).join("\n\n");
}

export function renderContextInventoryText(snapshot: ContextInventorySnapshot): string {
  const lines = [
    `Context inventory: ${snapshot.coverage} (${snapshot.metrics.includedItems} item(s), ${snapshot.metrics.omittedItems} omitted)`,
    `Captured: ${snapshot.capturedAt} · assembly ${snapshot.metrics.assemblyDurationMs} ms · ${snapshot.metrics.estimatedTokens} estimated tokens (${snapshot.metrics.tokenSource})`,
    `Prompt budget: ${snapshot.metrics.budgetStatus}${snapshot.metrics.contextLimit !== undefined ? ` (${snapshot.metrics.contextLimit} tokens, ${snapshot.metrics.contextLimitSource ?? "source unknown"})` : " (limit unknown)"}`,
    ...(snapshot.metrics.lastRequestTokens !== undefined ? [`Last request: ${snapshot.metrics.lastRequestTokens} tokens (${snapshot.metrics.lastRequestTokenSource ?? "source unknown"})`] : []),
    "",
    ...snapshot.sourceMeasurements.map((source) => `Source ${source.source}: ${source.status}, ${source.includedItemCount}/${source.itemCount} item(s) included (${source.omittedItemCount} omitted), ${source.estimatedTokens} estimated tokens, ${source.durationMs} ms${source.detail ? ` — ${source.detail}` : ""}`),
    "",
    ...snapshot.items.map((item) => `${item.id} ${item.sourceType} @ ${item.sourceLocation} [${item.scope}; ${item.freshness}${item.freshnessRule ? ` (${item.freshnessRule})` : ""}; ${item.trust}] ${item.estimatedTokens} est. tokens; via ${item.retrievalMethod}`),
    ...(snapshot.coverageGaps.length ? ["", "Coverage gaps:", ...snapshot.coverageGaps.map((gap) => `- ${gap}`)] : []),
  ];
  return lines.join("\n");
}
