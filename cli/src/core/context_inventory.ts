import { createHash } from "node:crypto";
import { countTokens } from "../tokens.js";

export type ContextScope = "turn" | "session" | "task" | "repository" | "profile" | "user";
export type ContextFreshness = "current" | "stale" | "unknown";
export type ContextTrust = "operator_input_untrusted" | "model_generated_unverified" | "tool_output_unverified" | "persisted_unverified" | "system_instruction" | "verified_evidence";
export type ContextSourceStatus = "ok" | "partial" | "failed";
export type ContextSourceOutcome = "timed_out" | "cancelled";
export type ContextObservationState = "dispatching" | "response_received" | "unknown_effect" | "not_dispatched";
export type WorkspaceStateComparison = "changed" | "unchanged" | "no_previous_capture" | "previous_capture_unversioned" | "unavailable";

export interface WorkspaceStateEvidence {
  /** Composite candidate identity; no source file contents or per-file hashes are retained. */
  fingerprint?: string;
  comparison: WorkspaceStateComparison;
  invalidatedRepositoryItemIds: string[];
}

export interface ContextInventoryItem {
  id: string;
  sourceType: string;
  sourceLocation: string;
  scope: ContextScope;
  observedAt: string;
  freshness: ContextFreshness;
  freshnessRule?: string;
  /** Content-free source version marker for comparing current records with saved inventories. */
  sourceVersion?: string;
  /** Lifecycle outcome for an observed request manifest; absent on other context items. */
  observationState?: ContextObservationState;
  observationSequence?: number;
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
  /** False when an export reconstructed provenance without timing the source read. */
  durationMeasured?: boolean;
  /** Additive detail keeps schema-1 readers compatible while distinguishing timeout and cancellation. */
  outcome?: ContextSourceOutcome;
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
  workspaceState?: WorkspaceStateEvidence;
  coverage: "complete" | "partial";
  coverageGaps: string[];
  items: ContextInventoryItem[];
  sourceMeasurements: ContextSourceMeasurement[];
  metrics: {
    assemblyDurationMs: number;
    /** False when this snapshot was reconstructed for export and no assembly timer was run. */
    assemblyDurationMeasured?: boolean;
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

/** Content-free record of the exact message and tool-schema arrays handed to a provider adapter. */
export interface InferenceContextManifest {
  schemaVersion: 1;
  id: string;
  capturedAt: string;
  sessionId?: string;
  taskId?: string;
  workspace?: string;
  sequence: number;
  status: "dispatching" | "response_received" | "unknown_effect" | "not_dispatched";
  coverage: "complete" | "partial";
  coverageGaps: string[];
  messages: Array<{ position: number; role: string; sourceRef: string; estimatedTokens: number }>;
  tools: { count: number; estimatedTokens: number; schemaRefs: string[]; omitted: number };
  budget: {
    requestEstimateTokens: number;
    tokenSource: "client_estimate";
    contextLimit: number;
    contextLimitSource: string;
    outputAllowance: number;
    outputAllowanceSource: string;
    toolResponseReserve: number;
  };
}

const MAX_INFERENCE_MANIFESTS = 24;
const MAX_MANIFEST_MESSAGES = 4096;
const MAX_MANIFEST_TOOL_REFS = 256;

/** Create a bounded manifest from the arrays about to be sent; prompt and schema text are counted, never retained. */
export function buildInferenceContextManifest(input: {
  id: string;
  capturedAt?: string;
  taskId?: string;
  workspace?: string;
  sequence: number;
  messages: readonly { role?: unknown; content?: unknown; tool_calls?: unknown }[];
  tools: readonly unknown[];
  status?: InferenceContextManifest["status"];
  contextLimit: number;
  contextLimitSource: string;
  outputAllowance: number;
  outputAllowanceSource: string;
  toolResponseReserve: number;
  requestEstimateTokens?: number;
}): InferenceContextManifest {
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const coverageGaps: string[] = [];
  const messages: InferenceContextManifest["messages"] = [];
  let estimatedMessageTokens = 0;
  for (const [position, message] of input.messages.entries()) {
    const content = typeof message.content === "string" ? message.content : safeJson(message.content);
    const contentTokens = countTokens(content);
    const role = typeof message.role === "string" ? message.role : "unknown";
    if (role === "system" || role === "user" || role === "assistant" || role === "tool") {
      const toolCallText = message.tool_calls ? safeJson(message.tool_calls) : "";
      estimatedMessageTokens += contentTokens + countTokens(toolCallText) + 4;
    }
    if (position < MAX_MANIFEST_MESSAGES) {
      messages.push({
        position,
        role: metadataText(role, 40),
        sourceRef: `request:message:${position}`,
        estimatedTokens: contentTokens,
      });
    }
  }
  const schemaRefs = input.tools.slice(0, MAX_MANIFEST_TOOL_REFS).map((_, position) => `request:tool-schema:${position}`);
  if (input.messages.length > MAX_MANIFEST_MESSAGES) coverageGaps.push(`message references capped at ${MAX_MANIFEST_MESSAGES}`);
  if (input.tools.length > schemaRefs.length) coverageGaps.push(`tool schema references capped at ${MAX_MANIFEST_TOOL_REFS}`);
  const toolEstimatedTokens = countTokens(JSON.stringify(input.tools));
  const requestEstimateTokens = input.requestEstimateTokens ?? (estimatedMessageTokens + toolEstimatedTokens);
  return {
    schemaVersion: 1,
    id: metadataText(input.id, 100),
    capturedAt: metadataText(capturedAt, 80),
    ...(input.taskId ? { taskId: metadataText(input.taskId, 200) } : {}),
    ...(input.workspace ? { workspace: metadataText(input.workspace, 1000) } : {}),
    sequence: Math.max(0, Math.floor(input.sequence)),
    status: input.status ?? "dispatching",
    coverage: coverageGaps.length ? "partial" : "complete",
    coverageGaps,
    messages,
    tools: { count: input.tools.length, estimatedTokens: toolEstimatedTokens, schemaRefs, omitted: Math.max(0, input.tools.length - schemaRefs.length) },
    budget: {
      requestEstimateTokens,
      tokenSource: "client_estimate",
      contextLimit: input.contextLimit,
      contextLimitSource: metadataText(input.contextLimitSource, 100),
      outputAllowance: input.outputAllowance,
      outputAllowanceSource: metadataText(input.outputAllowanceSource, 100),
      toolResponseReserve: input.toolResponseReserve,
    },
  };
}

export function retainInferenceContextManifest(manifests: readonly InferenceContextManifest[], manifest: InferenceContextManifest): InferenceContextManifest[] {
  return [...manifests.filter((item) => item.id !== manifest.id), manifest].slice(-MAX_INFERENCE_MANIFESTS);
}

/** A process restart during dispatch cannot prove whether the provider acted on the request. */
export function markInterruptedInferenceManifestsUnknown(manifests: readonly InferenceContextManifest[]): InferenceContextManifest[] {
  return manifests.map((manifest) => manifest.status === "dispatching" ? { ...manifest, status: "unknown_effect" } : manifest);
}

export function isInferenceContextManifest(value: unknown): value is InferenceContextManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as InferenceContextManifest;
  const safe = (text: unknown, max: number) => typeof text === "string" && text.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(text);
  const exactKeys = (object: object, required: string[], optional: string[] = []) => {
    const keys = Object.keys(object);
    return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
  };
  return exactKeys(manifest, ["schemaVersion", "id", "capturedAt", "sequence", "status", "coverage", "coverageGaps", "messages", "tools", "budget"], ["sessionId", "taskId", "workspace"]) &&
    Boolean(manifest.tools && typeof manifest.tools === "object" && exactKeys(manifest.tools, ["count", "estimatedTokens", "schemaRefs", "omitted"])) &&
    Boolean(manifest.budget && typeof manifest.budget === "object" && exactKeys(manifest.budget, ["requestEstimateTokens", "tokenSource", "contextLimit", "contextLimitSource", "outputAllowance", "outputAllowanceSource", "toolResponseReserve"])) &&
    manifest.schemaVersion === 1 && /^ctxreq_[0-9a-f-]{36}$/.test(manifest.id) && safe(manifest.capturedAt, 80) &&
    (manifest.sessionId === undefined || safe(manifest.sessionId, 200)) && (manifest.taskId === undefined || safe(manifest.taskId, 200)) && (manifest.workspace === undefined || safe(manifest.workspace, 1000)) &&
    Number.isSafeInteger(manifest.sequence) && manifest.sequence >= 0 && ["dispatching", "response_received", "unknown_effect", "not_dispatched"].includes(manifest.status) &&
    ["complete", "partial"].includes(manifest.coverage) && Array.isArray(manifest.coverageGaps) && manifest.coverageGaps.length <= 20 && manifest.coverageGaps.every((gap) => ["message references capped at 4096", "tool schema references capped at 256"].includes(gap)) && manifest.coverage === (manifest.coverageGaps.length ? "partial" : "complete") &&
    Array.isArray(manifest.messages) && manifest.messages.length <= MAX_MANIFEST_MESSAGES && manifest.messages.every((item, index) => item && exactKeys(item, ["position", "role", "sourceRef", "estimatedTokens"]) && item.position === index && ["system", "user", "assistant", "tool"].includes(item.role) && item.sourceRef === `request:message:${index}` && Number.isFinite(item.estimatedTokens) && item.estimatedTokens >= 0) &&
    Boolean(Number.isSafeInteger(manifest.tools.count) && manifest.tools.count >= 0 && Number.isFinite(manifest.tools.estimatedTokens) && manifest.tools.estimatedTokens >= 0 && Number.isSafeInteger(manifest.tools.omitted) && manifest.tools.omitted >= 0 && Array.isArray(manifest.tools.schemaRefs) && manifest.tools.schemaRefs.length <= MAX_MANIFEST_TOOL_REFS && manifest.tools.schemaRefs.length + manifest.tools.omitted === manifest.tools.count && manifest.tools.schemaRefs.every((ref, index) => ref === `request:tool-schema:${index}`)) &&
    Boolean(manifest.budget && Number.isFinite(manifest.budget.requestEstimateTokens) && manifest.budget.requestEstimateTokens >= 0 && manifest.budget.tokenSource === "client_estimate" && Number.isFinite(manifest.budget.contextLimit) && manifest.budget.contextLimit > 0 && ["advertised", "operator", "operator_capped_by_advertised", "snapshot", "client_default", "client_default_or_unknown"].includes(manifest.budget.contextLimitSource) && Number.isFinite(manifest.budget.outputAllowance) && manifest.budget.outputAllowance >= 0 && ["advertised", "operator", "operator_capped_by_advertised", "snapshot", "client_default", "client_default_or_unknown"].includes(manifest.budget.outputAllowanceSource) && Number.isFinite(manifest.budget.toolResponseReserve) && manifest.budget.toolResponseReserve >= 0);
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
  sourceVersion?: string;
  observationState?: ContextObservationState;
  observationSequence?: number;
  sourceRefs?: string[];
}

export interface ContextInventoryInput {
  capturedAt?: string;
  /** End-to-end time spent collecting and assembling inventory sources. */
  assemblyDurationMs?: number;
  /** Defaults to true; false is used when reconstructing a stable export rather than measuring retrieval. */
  durationsMeasured?: boolean;
  sessionId?: string;
  taskId?: string;
  workspace?: string;
  workspaceState?: WorkspaceStateEvidence;
  sources: Array<{ name: string; status: ContextSourceStatus; outcome?: ContextSourceOutcome; durationMs: number; items: ContextSourceItemInput[]; omittedItemCount?: number; detail?: string }>;
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

function safeSourceVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && /^[A-Za-z0-9_:.,+\-\[\]"]+$/.test(value);
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
    const preOmitted = Number.isSafeInteger(source.omittedItemCount) && (source.omittedItemCount ?? 0) > 0 ? source.omittedItemCount! : 0;
    totalCandidateItems += source.items.length + preOmitted;
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
        ...(item.sourceVersion && safeSourceVersion(item.sourceVersion) ? { sourceVersion: item.sourceVersion } : {}),
        ...(item.observationState ? { observationState: item.observationState } : {}),
        ...(Number.isSafeInteger(item.observationSequence) && (item.observationSequence ?? -1) >= 0 ? { observationSequence: item.observationSequence } : {}),
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
      ...(source.outcome ? { outcome: source.outcome } : {}),
      durationMs: input.durationsMeasured === false ? 0 : boundedDuration(source.durationMs),
      ...(input.durationsMeasured === false ? { durationMeasured: false } : {}),
      itemCount: source.items.length + preOmitted,
      includedItemCount: included.length,
      omittedItemCount: source.items.length - included.length + preOmitted,
      estimatedTokens,
      ...(source.detail ? { detail: source.detail.replace(/[\r\n\t]/g, " ").slice(0, MAX_SOURCE_DETAIL) } : {}),
    });
  }

  // Keep a deterministic prefix so the same source order produces the same bounded snapshot and token work.
  const items = candidates;
  const omittedItems = totalCandidateItems - items.length;
  const gaps = [...(input.coverageGaps ?? [])];
  if (input.workspaceState?.comparison === "changed") {
    gaps.push(`workspace state changed since the previous capture; ${input.workspaceState.invalidatedRepositoryItemIds.length} prior repository-scoped item(s) require revalidation`);
  } else if (input.workspaceState?.comparison === "previous_capture_unversioned") {
    gaps.push("the previous context capture has no workspace fingerprint; repository freshness remains unknown");
  } else if (input.workspaceState?.comparison === "unavailable") {
    gaps.push("current workspace state could not be fingerprinted; repository freshness remains unknown");
  }
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
    ...(input.workspaceState ? { workspaceState: {
      ...(input.workspaceState.fingerprint ? { fingerprint: input.workspaceState.fingerprint } : {}),
      comparison: input.workspaceState.comparison,
      invalidatedRepositoryItemIds: input.workspaceState.invalidatedRepositoryItemIds.slice(0, DEFAULT_MAX_ITEMS),
    } } : {}),
    coverage,
    coverageGaps: [...new Set(gaps)],
    items,
    sourceMeasurements,
    metrics: {
      assemblyDurationMs: input.durationsMeasured === false ? 0 : boundedDuration(input.assemblyDurationMs ?? (performance.now() - started)),
      ...(input.durationsMeasured === false ? { assemblyDurationMeasured: false } : {}),
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

/** Compare one saved inventory with a bounded, current candidate identity. Missing evidence remains explicit. */
export function compareWorkspaceState(previous: ContextInventorySnapshot | undefined, fingerprint: string | undefined): WorkspaceStateEvidence {
  const invalidatedRepositoryItemIds = previous?.items.filter((item) => item.scope === "repository").map((item) => item.id).slice(0, DEFAULT_MAX_ITEMS) ?? [];
  if (!fingerprint) return { comparison: "unavailable", invalidatedRepositoryItemIds: [] };
  if (!previous) return { fingerprint, comparison: "no_previous_capture", invalidatedRepositoryItemIds: [] };
  if (!previous.workspaceState?.fingerprint) {
    return { fingerprint, comparison: "previous_capture_unversioned", invalidatedRepositoryItemIds };
  }
  return {
    fingerprint,
    comparison: previous.workspaceState.fingerprint === fingerprint ? "unchanged" : "changed",
    invalidatedRepositoryItemIds: previous.workspaceState.fingerprint === fingerprint ? [] : invalidatedRepositoryItemIds,
  };
}

/** Rebuild only what legacy/session records can establish; repository freshness remains unknown. */
export interface BoundedContextSourceItems {
  items: ContextSourceItemInput[];
  omittedItemCount: number;
}

export function inventorySourcesFromMessages(messages: readonly any[], options: { archived?: boolean; sourcePrefix?: string } = {}): ContextSourceItemInput[] {
  return inventorySourcesFromMessagesBounded(messages, { ...options, maxItems: Number.MAX_SAFE_INTEGER }).items;
}

export function inventorySourcesFromMessagesBounded(messages: readonly any[], options: { archived?: boolean; sourcePrefix?: string; maxItems: number }): BoundedContextSourceItems {
  const archived = Boolean(options.archived);
  const sourcePrefix = options.sourcePrefix ?? (archived ? "archive" : "session");
  const maxItems = Number.isSafeInteger(options.maxItems) && options.maxItems >= 0 ? options.maxItems : DEFAULT_MAX_ITEMS;
  const items: ContextSourceItemInput[] = [];
  let omittedItemCount = 0;
  messages.forEach((message, index) => {
    if (items.length >= maxItems) {
      const content = message?.content;
      if ((typeof content === "string" && content.length > 0) || (typeof content !== "string" && content !== undefined)) omittedItemCount++;
      return;
    }
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
  return { items, omittedItemCount };
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
}, archived: { messages?: readonly any[]; unreadableLines?: number } = {}, capturedAt = new Date().toISOString(), durationsMeasured = true): ContextInventorySnapshot {
  const started = durationsMeasured ? performance.now() : 0;
  const activeItems = inventorySourcesFromMessages(session.messages ?? []);
  if (session.objective) activeItems.push({ sourceType: "objective_ledger", sourceLocation: "task:objective-ledger", scope: "task", content: safeJson(session.objective), trust: "persisted_unverified", retention: "task", inclusionReason: "durable task objective and requirements", retrievalMethod: "durable_task_state", sourceRefs: Array.isArray(session.objective.requirements) ? session.objective.requirements.map((requirement: any, index: number) => `requirement:${typeof requirement?.id === "string" ? requirement.id : index + 1}`) : undefined });
  if (session.durableNotes?.length) session.durableNotes.forEach((note, index) => activeItems.push({ sourceType: "durable_note", sourceLocation: `task:durable-note:${index}`, scope: "task", content: note, trust: "persisted_unverified", retention: "task", inclusionReason: "durable task note retained across compaction", retrievalMethod: "durable_task_state" }));
  if (session.activePlan?.length) activeItems.push({ sourceType: "active_plan", sourceLocation: "task:active-plan", scope: "task", content: safeJson(session.activePlan), trust: "persisted_unverified", retention: "task", inclusionReason: "current durable plan state", retrievalMethod: "durable_task_state" });
  if (session.compactionProvenance) activeItems.push({ sourceType: "compaction_provenance", sourceLocation: `task:compaction:${session.compactionProvenance.recordId}`, scope: "session", content: session.compactionProvenance.summaryContent ?? "compaction summary; content reference only", trust: "persisted_unverified", retention: "session_archive", inclusionReason: "summary links to predecessor records whose originals are retained in the history archive", retrievalMethod: "compaction_record", sourceRefs: [session.compactionProvenance.recordId, ...session.compactionProvenance.predecessorIds] });
  const activeDurationMs = durationsMeasured ? Math.max(0, performance.now() - started) : 0;
  const archivedStarted = durationsMeasured ? performance.now() : 0;
  const archivedItems = inventorySourcesFromMessages(archived.messages ?? [], { archived: true, sourcePrefix: "archive" });
  const archivedDurationMs = durationsMeasured ? Math.max(0, performance.now() - archivedStarted) : 0;
  const tokenAccounting = session.lastTurn?.tokenAccounting;
  return buildContextInventory({
    capturedAt,
    durationsMeasured,
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
  const workspaceComparisons = ["changed", "unchanged", "no_previous_capture", "previous_capture_unversioned", "unavailable"];
  return snapshot.schemaVersion === 1 &&
    safeText(snapshot.capturedAt, 80) &&
    (snapshot.sessionId === undefined || safeText(snapshot.sessionId, 200)) &&
    (snapshot.taskId === undefined || safeText(snapshot.taskId, 200)) &&
    (snapshot.workspace === undefined || safeText(snapshot.workspace, 1000)) &&
    (snapshot.workspaceState === undefined || (snapshot.workspaceState && Object.keys(snapshot.workspaceState).every((key) => ["fingerprint", "comparison", "invalidatedRepositoryItemIds"].includes(key)) && (snapshot.workspaceState.fingerprint === undefined || /^[a-f0-9]{64}$/.test(snapshot.workspaceState.fingerprint)) && workspaceComparisons.includes(snapshot.workspaceState.comparison) && Array.isArray(snapshot.workspaceState.invalidatedRepositoryItemIds) && snapshot.workspaceState.invalidatedRepositoryItemIds.length <= DEFAULT_MAX_ITEMS && snapshot.workspaceState.invalidatedRepositoryItemIds.every((id) => safeText(id, 80)) && (snapshot.workspaceState.comparison === "unavailable" ? snapshot.workspaceState.fingerprint === undefined && snapshot.workspaceState.invalidatedRepositoryItemIds.length === 0 : Boolean(snapshot.workspaceState.fingerprint)) && (["unchanged", "no_previous_capture"].includes(snapshot.workspaceState.comparison) ? snapshot.workspaceState.invalidatedRepositoryItemIds.length === 0 : true))) &&
    (snapshot.coverage === "complete" || snapshot.coverage === "partial") &&
    Array.isArray(snapshot.coverageGaps) && snapshot.coverageGaps.length <= 100 && snapshot.coverageGaps.every((gap) => safeText(gap)) &&
    Array.isArray(snapshot.items) && snapshot.items.length <= DEFAULT_MAX_ITEMS && snapshot.items.every((item) => item && safeText(item.id, 80) && safeText(item.sourceType, 80) && safeText(item.sourceLocation) && scopes.includes(item.scope) && safeText(item.observedAt, 80) && freshness.includes(item.freshness) && (item.freshnessRule === undefined || safeText(item.freshnessRule)) && (item.freshness === "unknown" || safeText(item.freshnessRule)) && (item.sourceVersion === undefined || safeSourceVersion(item.sourceVersion)) && (item.observationState === undefined || ["dispatching", "response_received", "unknown_effect", "not_dispatched"].includes(item.observationState)) && (item.observationSequence === undefined || Number.isSafeInteger(item.observationSequence) && item.observationSequence >= 0) && trust.includes(item.trust) && safeText(item.retention) && safeText(item.inclusionReason) && safeText(item.retrievalMethod, 100) && Number.isFinite(item.estimatedTokens) && item.estimatedTokens >= 0 && (item.sourceRefs === undefined || (Array.isArray(item.sourceRefs) && item.sourceRefs.length <= 100 && item.sourceRefs.every((ref) => safeText(ref, 200))))) &&
    Array.isArray(snapshot.sourceMeasurements) && snapshot.sourceMeasurements.length <= 100 && snapshot.sourceMeasurements.every((source) => source && safeText(source.source, 100) && ["ok", "partial", "failed"].includes(source.status) && (source.durationMeasured === undefined || typeof source.durationMeasured === "boolean") && (source.outcome === undefined || (source.status === "failed" && ["timed_out", "cancelled"].includes(source.outcome))) && Number.isFinite(source.durationMs) && source.durationMs >= 0 && Number.isFinite(source.itemCount) && source.itemCount >= 0 && Number.isFinite(source.includedItemCount) && source.includedItemCount >= 0 && Number.isFinite(source.omittedItemCount) && source.omittedItemCount >= 0 && Number.isFinite(source.estimatedTokens) && source.estimatedTokens >= 0 && (source.detail === undefined || safeText(source.detail, MAX_SOURCE_DETAIL))) &&
    Boolean(snapshot.metrics && (snapshot.metrics.assemblyDurationMeasured === undefined || typeof snapshot.metrics.assemblyDurationMeasured === "boolean") && Number.isFinite(snapshot.metrics.assemblyDurationMs) && snapshot.metrics.assemblyDurationMs >= 0 && Number.isFinite(snapshot.metrics.estimatedTokens) && snapshot.metrics.estimatedTokens >= 0 && Number.isFinite(snapshot.metrics.includedItems) && snapshot.metrics.includedItems >= 0 && Number.isFinite(snapshot.metrics.omittedItems) && snapshot.metrics.omittedItems >= 0 && snapshot.metrics.tokenSource === "client_estimate" && ["within_budget", "over_budget", "unknown"].includes(snapshot.metrics.budgetStatus) && (snapshot.metrics.contextLimit === undefined || (Number.isFinite(snapshot.metrics.contextLimit) && snapshot.metrics.contextLimit > 0)) && (snapshot.metrics.lastRequestTokens === undefined || (Number.isFinite(snapshot.metrics.lastRequestTokens) && snapshot.metrics.lastRequestTokens >= 0)));
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
  const observedRequestManifests = snapshot.items.filter((item) => item.sourceType === "inference_request_manifest");
  const sequencedRequestManifests = observedRequestManifests.filter((item) => item.observationSequence !== undefined);
  const latestSequence = sequencedRequestManifests.reduce((latest, item) => Math.max(latest, item.observationSequence!), -1);
  const latestSequenceItems = sequencedRequestManifests.filter((item) => item.observationSequence === latestSequence);
  const latestRequestManifest = latestSequenceItems.length === 1 ? latestSequenceItems[0] : undefined;
  // Older request refs reuse positional names; only the latest sequenced completed
  // request can establish that the currently inspected context reached the adapter.
  // An unsequenced record could be newer, so it makes ordering unknowable.
  const requestOrderKnown = observedRequestManifests.length > 0 && observedRequestManifests.length === sequencedRequestManifests.length;
  const requestManifests = requestOrderKnown && latestRequestManifest?.observationState === "response_received" ? [latestRequestManifest] : [];
  const requestManifestCount = requestManifests.length;
  // Session message indexes are not provider request indexes: prompt injection and
  // compaction can change the arrays. Only explicit source links prove inclusion.
  const dispatchedContextItems = snapshot.items.filter((item) => item.sourceType !== "inference_request_manifest" && requestManifests.some((manifest) => {
    return item.sourceRefs?.some((reference) => manifest.sourceRefs?.includes(reference)) === true;
  }));
  const dispatchedSourceTypes = new Set(dispatchedContextItems.map((item) => item.sourceType));
  const allFreshnessKnown = inventoryExists && snapshot.items.every((item) => item.freshness !== "unknown");
  const measuredSourceCount = snapshot.sourceMeasurements.filter((source) => source.durationMeasured !== false && source.status === "ok" && source.durationMs > 0).length;
  const hasFreshnessComparison = snapshot.workspaceState?.comparison === "changed" || snapshot.workspaceState?.comparison === "unchanged";
  const memoryItems = snapshot.items.filter((item) => ["durable_note", "compaction_summary", "compaction_provenance", "durable_knowledge"].includes(item.sourceType));
  const carriedMemoryObserved = memoryItems.some((item) => item.sourceRefs?.length && dispatchedContextItems.some((dispatched) => dispatched.id === item.id));
  const dimension = (value: Omit<ContextMaturityDimension, "stage">): ContextMaturityDimension => ({ ...value, stage: value.level === null ? null : STAGES[value.level] });
  return {
    schemaVersion: 1,
    assessedAt: snapshot.capturedAt,
    basis: "deterministic_client_evidence",
    dimensions: [
      dimension({
        dimension: "navigability", level: requestManifestCount === 0 ? null : dispatchedSourceTypes.size >= 2 ? 2 : 1,
        evidence: [
          { reference: "cli/src/core/context_inventory.ts:inventorySourcesFromMessages", finding: `${dispatchedContextItems.length} source item(s) have explicit source references linked to a captured request; ${dispatchedSourceTypes.size} distinct source type(s) were observed in dispatched context.`, status: requestManifestCount ? "observed" : "unknown" },
          { reference: "cli/src/agent.ts:submitGuardingLength", finding: observedRequestManifests.length ? `${observedRequestManifests.length} content-free request manifest(s) were observed; ordering is ${requestOrderKnown ? "sequenced" : "unknown because at least one record has no sequence"}, and the latest outcome is ${latestRequestManifest?.observationState ?? "unknown"}${requestManifestCount ? " and is eligible for request-link evidence" : " and is not eligible for request-link evidence"}.` : "Conversation replay and pinned task context exist; no persisted request manifest was observed in this capture.", status: requestManifestCount ? "observed" : "unknown" },
          ...(evidence.hasActiveSkills ? [{ reference: "cli/src/skills.ts:SkillManager.getPromptSection", finding: "Path and trust metadata exist for skills; active prompt inclusion is not represented in the persisted message inventory.", status: "observed" as const }] : []),
        ],
        unmetCriteria: ["Relationships from each request message to the repository, task, session, profile, or memory source that produced it.", "A unified retrieval graph connecting repository, task, session, profile, and memory items."],
        knownLimitations: snapshot.coverageGaps,
        nextImprovement: "Link request-position references to stable source records while preserving bounded, content-free session evidence.",
      }),
      dimension({
        dimension: "retrieval_speed", level: measuredSourceCount >= 2 ? 2 : null,
        evidence: [
          { reference: "cli/src/core/context_inventory.ts:buildContextInventory", finding: measuredSourceCount >= 2 ? `${measuredSourceCount} source retrieval duration(s) and a total inventory-assembly duration are measured in this capture; these are not inference latency measurements or a latency distribution.` : `${measuredSourceCount} eligible source retrieval duration(s) were measured; at least two are required for an exploratory rating.`, status: measuredSourceCount ? "measured" : "unknown" },
          { reference: "cli/src/agent.ts:admitContext", finding: "Context admission enforces token estimates and output/tool reserves; this is budget evidence, not a retrieval latency SLO.", status: "observed" },
        ],
        unmetCriteria: ["Repeated per-inference source latency and timeout measurements.", "A defined retrieval latency budget/SLO and measured failure rate."],
        knownLimitations: ["Inventory timings measure local collection only; token counts are client estimates."],
        nextImprovement: "Instrument each request's source assembly and evaluate latency distributions before setting an SLO.",
      }),
      dimension({
        dimension: "freshness", level: !inventoryExists ? null : snapshot.coverage === "complete" && hasFreshnessComparison && allFreshnessKnown ? 2 : snapshot.items.some((item) => item.freshness === "unknown") ? 1 : null,
        evidence: [
          { reference: "cli/src/core/context_inventory.ts:ContextFreshness", finding: `${snapshot.items.filter((item) => item.freshness === "unknown").length} item(s) have unknown freshness; no current-state claim is inferred from persistence.`, status: "observed" },
          { reference: "cli/src/core/context_inventory.ts:compareWorkspaceState", finding: snapshot.workspaceState ? `Workspace comparison is ${snapshot.workspaceState.comparison}; ${snapshot.workspaceState.invalidatedRepositoryItemIds.length} prior repository-scoped item(s) require revalidation.` : "No workspace fingerprint comparison was available in this inventory.", status: snapshot.workspaceState?.comparison === "unavailable" ? "unknown" : "observed" },
        ],
        unmetCriteria: ["Per-source freshness identities for external inputs, tool policy, and individual memory provenance.", "A freshness objective backed by observed change-to-invalidation latency."],
        knownLimitations: ["The bounded candidate fingerprint covers repository candidate state only; ignored files and provider-side context are not fingerprinted. Session and archive facts remain unknown unless independently revalidated."],
        nextImprovement: "Measure change-to-invalidation latency and add source-specific freshness identities for context outside the repository candidate.",
      }),
      dimension({
        dimension: "compounding_value", level: carriedMemoryObserved ? 2 : memoryItems.length > 0 ? 1 : null,
        evidence: [
          { reference: "cli/src/session.ts:SessionManager.saveSession", finding: carriedMemoryObserved ? "A durable memory item with source references was linked to a captured inference request; this demonstrates reuse, not correctness or improved outcomes." : memoryItems.length ? "Durable memory records exist, but none was linked to a captured inference request in this inventory." : "No durable note or compaction link was observed in carried session context.", status: memoryItems.length ? "observed" : "unknown" },
          { reference: "cli/src/knowledge.ts:KnowledgeGraph", finding: evidence.hasDurableKnowledge ? "Workspace knowledge entries exist, but this diagnostic cannot prove exact inference-time inclusion or task value; persisted entries remain unverified memory, not evidence." : "No durable project knowledge entry was observed for this session.", status: evidence.hasDurableKnowledge ? "observed" : "unknown" },
        ],
        unmetCriteria: ["Observed reuse of promoted knowledge across turns with source links.", "Held-out evidence that accumulated context improves task quality or time without harming correctness."],
        knownLimitations: ["A persisted summary or knowledge entry is not proof of correctness; no improvement claim is made."],
        nextImprovement: "Run a held-out comparison of carried memory against no-memory execution, using deterministic verification and source-linked provenance.",
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
    ...(snapshot.workspaceState ? [`Workspace freshness: ${snapshot.workspaceState.comparison}; ${snapshot.workspaceState.invalidatedRepositoryItemIds.length} prior repository item(s) invalidated`] : []),
    ...(snapshot.metrics.lastRequestTokens !== undefined ? [`Last request: ${snapshot.metrics.lastRequestTokens} tokens (${snapshot.metrics.lastRequestTokenSource ?? "source unknown"})`] : []),
    "",
    ...snapshot.sourceMeasurements.map((source) => `Source ${source.source}: ${source.status}${source.outcome ? ` (${source.outcome})` : ""}, ${source.includedItemCount}/${source.itemCount} item(s) included (${source.omittedItemCount} omitted), ${source.estimatedTokens} estimated tokens, ${source.durationMs} ms${source.detail ? ` — ${source.detail}` : ""}`),
    "",
    ...snapshot.items.map((item) => `${item.id} ${item.sourceType} @ ${item.sourceLocation} [${item.scope}; ${item.freshness}${item.freshnessRule ? ` (${item.freshnessRule})` : ""}${item.sourceVersion ? `; source-version=${encodeURIComponent(item.sourceVersion)}` : ""}${item.observationState ? `; outcome=${item.observationState}` : ""}${item.observationSequence !== undefined ? `; sequence=${item.observationSequence}` : ""}; ${item.trust}] ${item.estimatedTokens} est. tokens; via ${item.retrievalMethod}`),
    ...(snapshot.coverageGaps.length ? ["", "Coverage gaps:", ...snapshot.coverageGaps.map((gap) => `- ${gap}`)] : []),
  ];
  return lines.join("\n");
}
