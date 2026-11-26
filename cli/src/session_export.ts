/**
 * Session export (`/export` in the TUI and the REPL). The export carries the authoritative task state — objective,
 * requirement states, steering, verifier attempts, plan, milestones, receipts, last turn — beside the conversation,
 * and says plainly whether the conversation is the full history or a compacted context whose earlier messages were
 * replaced by summaries (the replaced originals are included from the session's archive when it exists).
 */
import type { SessionData, SessionManager } from "./session.js";
import { buildSessionContextInventory, isContextInventorySnapshot, isInferenceContextManifest, markPersistedContextFreshnessUnknown, mergeContextInventorySnapshots, type ContextInventorySnapshot } from "./core/context_inventory.js";
import { safeOperatorText } from "./protocol.js";
import type { ChatMessage } from "./types.js";
import { gatingRequirements, requirementDone } from "./core/objective.js";
import { describeChain, verifyChain } from "./core/hash_chain.js";

export const EXPORT_FORMAT = "nexus-session-export/2";
const SUMMARY_PREFIX = "[Structured Context Memory";

export interface HistoryCompleteness {
  complete: boolean | "unknown";
  compactions: number;
  archivedMessages: number;
  archivedIncluded: number;
  unreadableArchiveLines: number;
  summaryMessagesInContext: number;
  note: string;
}

function contentText(message: ChatMessage): string {
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
}

export function historyCompleteness(session: SessionData, archived: { messages: ChatMessage[]; unreadableLines: number }): HistoryCompleteness {
  const summaries = session.messages.filter((m, i) => i > 0 && m.role === "system" && contentText(m).startsWith(SUMMARY_PREFIX)).length;
  const recorded = session.history;
  const compactions = recorded?.compactions ?? (summaries > 0 ? summaries : 0);
  const compacted = compactions > 0 || summaries > 0;
  const complete: HistoryCompleteness["complete"] = recorded ? !compacted : compacted ? false : "unknown";
  const archivedMessages = recorded?.archivedMessages ?? 0;
  let note: string;
  if (!compacted) {
    note = recorded ? "The conversation below is the full history of this session." : "This session predates history tracking; no compaction summary is present in its context.";
  } else if (archived.messages.length > 0 && archived.messages.length >= archivedMessages && archived.unreadableLines === 0) {
    note = `Context compaction replaced earlier messages with summaries ${compactions} time(s); the ${archived.messages.length} replaced originals are included under archivedHistory, so together they are the full history.`;
  } else {
    note =
      `Context compaction replaced earlier messages with summaries ${compactions} time(s). ` +
      `${archived.messages.length} of ${archivedMessages || "an unknown number of"} replaced originals are available in the archive` +
      `${archived.unreadableLines ? ` (${archived.unreadableLines} unreadable line(s))` : ""}; the rest exist only as the summaries in the context below. This export is NOT the full history.`;
  }
  return {
    complete,
    compactions,
    archivedMessages,
    archivedIncluded: archived.messages.length,
    unreadableArchiveLines: archived.unreadableLines,
    summaryMessagesInContext: summaries,
    note,
  };
}

export interface SessionExport {
  json: Record<string, unknown>;
  markdown: string;
}

/** Each requirement evidence item with who produced it; an item nothing records as tool output is the model's claim. */
export function evidenceProvenance(objective: SessionData["objective"] | null | undefined): { requirement: string; evidence: string; source: "tool" | "model" }[] {
  return (objective?.requirements ?? []).flatMap((r) => r.evidence.map((evidence) => ({ requirement: r.id, evidence, source: r.evidenceSources?.[evidence] ?? ("model" as const) })));
}

export function buildSessionExport(manager: SessionManager, session: SessionData, exportedAt = new Date()): SessionExport {
  const capturedAt = exportedAt.toISOString();
  let archived: { messages: ChatMessage[]; unreadableLines: number } = { messages: [], unreadableLines: 0 };
  try {
    archived = manager.readArchivedHistory(session.id);
  } catch {}
  const history = historyCompleteness(session, archived);
  const reconstructedInventory = buildSessionContextInventory(session, archived, capturedAt, false);
  const savedInventory = isContextInventorySnapshot(session.contextInventory) ? markPersistedContextFreshnessUnknown(session.contextInventory) : undefined;
  const contextInventory = savedInventory
    ? mergeContextInventorySnapshots(savedInventory, buildSessionContextInventory({ ...session, messages: [], objective: undefined, durableNotes: undefined, activePlan: [], compactionProvenance: null }, archived, capturedAt, false))
    : reconstructedInventory;
  const inferenceContextManifests = Array.isArray(session.inferenceContextManifests) && session.inferenceContextManifests.length <= 24 && session.inferenceContextManifests.every(isInferenceContextManifest)
    ? session.inferenceContextManifests
    : [];
  const exportSession = { ...session, inferenceContextManifests };
  const objective = session.objective ?? null;
  const lastTurn = session.lastTurn ?? null;
  const json: Record<string, unknown> = {
    ...session,
    contextInventory,
    inferenceContextManifests,
    export: {
      format: EXPORT_FORMAT,
      exportedAt: capturedAt,
      history,
      taskState: {
        status: session.status,
        outcome: lastTurn ? { execution: lastTurn.execution, outcome: lastTurn.outcome, reason: lastTurn.reason ?? null, detail: lastTurn.detail ?? null } : null,
        objectiveOutcome: objective?.outcome ?? null,
        unresolvedRequirements: objective ? gatingRequirements(objective).filter((r) => !requirementDone(r)) : [],
        steering: objective?.steering ?? [],
        steeringConflicts: objective?.steeringConflicts ?? [],
        supersededObjectives: objective?.superseded ?? [],
        evidenceProvenance: evidenceProvenance(objective),
        verificationAttempts: objective?.verification ?? [],
        verificationEvidence: lastTurn?.verification ?? null,
        verificationConfigAttempts: session.verificationConfigAttempts ?? [],
        commandRuleDecisions: session.commandRuleDecisions ?? [],
        unverifiedChangesPending: session.unverifiedChangesPending ?? null,
      },
      tokenAccounting:
        "tokenStats.prompt sums the input tokens of every inference request; each request re-sends the whole context, so it grows " +
        "with steps x context size. reportedRequests came from provider usage reports, estimatedRequests were estimated locally.",
    },
    archivedHistory: archived.messages,
  };
  return { json, markdown: markdownExport(exportSession, history, archived.messages, contextInventory) };
}

/**
 * Escape a value for a Markdown table cell. Newlines are normalized to spaces first so they
 * cannot terminate the table row; backslashes are escaped next, then pipes, so an existing
 * backslash (e.g. from `\|` in the source) cannot neutralise the pipe escape and break the
 * surrounding table row (CodeQL js/incomplete-sanitization).
 */
export function escapeTableCell(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

function markdownExport(session: SessionData, history: HistoryCompleteness, archived: ChatMessage[], contextInventory?: ContextInventorySnapshot): string {
  const out: string[] = [
    "# Nexus Code Session Export",
    "",
    `- **Session ID:** \`${session.id}\``,
    `- **Workspace:** \`${session.workspace}\``,
    `- **Date:** ${session.createdAt}`,
    `- **Model:** \`${session.model}\``,
    `- **Status:** ${session.status}`,
  ];
  const t = session.lastTurn;
  if (t) out.push(`- **Last turn:** execution=${t.execution} outcome=${t.outcome}${t.reason ? ` reason=${t.reason}` : ""}${t.detail ? ` (${t.detail})` : ""}`);
  out.push("", `> **History:** ${history.note}`, "");
  const objective = session.objective;
  if (objective) {
    out.push("## Objective", "", "```text", objective.objective, "```", "");
    const gating = gatingRequirements(objective);
    if (gating.length) {
      out.push("| Requirement | Status | Evidence / note |", "|---|---|---|");
      for (const r of gating) out.push(`| ${escapeTableCell(r.id)} ${escapeTableCell(r.text)} | ${escapeTableCell(r.status)} | ${escapeTableCell([...r.evidence.map((e) => `[${r.evidenceSources?.[e] ?? "model"}] ${e}`), r.note ?? ""].filter(Boolean).join("; "))} |`);
      out.push("");
    }
    if (objective.outcome) {
      const o = objective.outcome;
      out.push(`**Objective outcome:** ${o.status} (${o.reason})${o.failedCheck ? ` — failed check: ${o.failedCheck}` : ""}${o.nextAction ? ` — next: ${o.nextAction}` : ""}`, "");
    }
    if (objective.steering.length) {
      out.push("**Operator steering:**", "");
      for (const s of objective.steering) out.push(`- ${s.id} [${s.status}${s.appliedAtStep ? ` at step ${s.appliedAtStep}` : ""}] ${s.text}`);
      out.push("");
    }
    if (objective.steeringConflicts?.length) {
      out.push("**Steering conflicts (negated requirements):**", "");
      for (const c of objective.steeringConflicts) out.push(`- ${c.id} [${c.status}] negates ${c.requirements.join(", ")}: ${safeOperatorText(c.text)}`);
      out.push("");
    }
    if (objective.superseded?.length) {
      out.push("**Requirements left unmet by a replaced objective:**", "");
      for (const o of objective.superseded) out.push(`- [${o.status}] ${o.requirements.map((r) => `${r.id} (${r.status}) ${r.text}`).join("; ")}`);
      out.push("");
    }
    if (objective.verification.length) {
      out.push("**Verifier attempts:**", "");
      for (const a of objective.verification) out.push(`- #${a.n} \`${a.command}\` → ${a.status} on ${a.inputs.slice(0, 12)}${a.failedCheck ? ` (${a.failedCheck})` : ""}`);
      out.push("");
    }
  }
  if (session.verificationConfigAttempts?.length) {
    out.push("**Verification configuration edits (tests, CI, build):**", "");
    for (const a of session.verificationConfigAttempts) out.push(`- ${a.timestamp} ${a.decision} \`${a.tool}\` ${a.path} (${a.class}${a.role ? `, ${a.role}` : ""})`);
    out.push("", `Record integrity: ${describeChain(verifyChain(session.verificationConfigAttempts))}.`);
    out.push("");
  }
  if (session.commandRuleDecisions?.length) {
    out.push("**Operator command rules (which rule decided a shell command):**", "");
    for (const d of session.commandRuleDecisions) out.push(`- ${d.timestamp} ${d.effect}: \`${d.command}\` by rule ${d.rule} (${d.decision} \`${d.prefix}\`${d.justification ? `: ${d.justification}` : ""})`);
    out.push("");
  }
  if (session.activePlan?.length) {
    out.push("**Plan (the agent's roadmap; requirement states above are authoritative):**", "");
    for (const p of session.activePlan) out.push(`- [${p.status}] ${p.name}${p.detail ? ` — ${p.detail}` : ""}`);
    out.push("");
  }
  if (contextInventory) {
    out.push("## Context inventory (source references; content omitted)", "", `Coverage: **${contextInventory.coverage}** · ${contextInventory.metrics.includedItems} item(s) · ${contextInventory.metrics.omittedItems} omitted · ${contextInventory.metrics.estimatedTokens} estimated tokens (${contextInventory.metrics.tokenSource})`, "");
    for (const item of contextInventory.items) out.push(`- \`${item.id}\` ${item.sourceType} — ${item.sourceLocation}; scope=${item.scope}; observed=${item.observedAt}; freshness=${item.freshness}${item.freshnessRule ? ` (${item.freshnessRule})` : ""}${item.sourceVersion ? `; source-version=\`${encodeURIComponent(item.sourceVersion)}\`` : ""}${item.observationState ? `; outcome=${item.observationState}` : ""}${item.observationSequence !== undefined ? `; sequence=${item.observationSequence}` : ""}; trust=${item.trust}; via=${item.retrievalMethod}${item.sourceRefs?.length ? `; refs=${item.sourceRefs.join(",")}` : ""}`);
    if (contextInventory.coverageGaps.length) out.push("", "Coverage gaps:", ...contextInventory.coverageGaps.map((gap) => `- ${gap}`));
    out.push("");
  }
  if (session.inferenceContextManifests?.length) {
    out.push("## Inference context manifests (content omitted)", "");
    for (const manifest of session.inferenceContextManifests) {
      out.push(`- \`${manifest.id}\` sequence=${manifest.sequence}; captured=${manifest.capturedAt}; status=${manifest.status}; coverage=${manifest.coverage}; messages=${manifest.messages.length}; tools=${manifest.tools.count}; request estimate=${manifest.budget.requestEstimateTokens} tokens; context limit=${manifest.budget.contextLimit} (${manifest.budget.contextLimitSource}); output allowance=${manifest.budget.outputAllowance} (${manifest.budget.outputAllowanceSource}); tool reserve=${manifest.budget.toolResponseReserve}`);
      for (const item of manifest.messages) out.push(`  - ${item.sourceRef}; role=${item.role}; estimated=${item.estimatedTokens} tokens`);
      for (const ref of manifest.tools.schemaRefs) out.push(`  - ${ref}; effective tool schema included`);
      if (manifest.coverageGaps.length) out.push(`  - Coverage gaps: ${manifest.coverageGaps.join("; ")}`);
    }
    out.push("");
  }
  out.push("---", "");
  const render = (m: ChatMessage, archivedMessage: boolean) => {
    if (m.role === "system") {
      const text = contentText(m);
      if (!text.startsWith(SUMMARY_PREFIX)) return;
      out.push("### Context summary (earlier messages replaced by compaction)", "", "```json", text.slice(text.indexOf("\n") + 1), "```", "", "---", "");
      return;
    }
    const who = m.role === "user" ? "User" : m.role === "assistant" ? "Nexus" : `Tool (${m.name})`;
    const calls = m.tool_calls?.length ? `\n\n_tool calls: ${m.tool_calls.map((c) => `${c.function.name} [${c.id}]`).join(", ")}_` : "";
    const ref = m.role === "tool" && m.tool_call_id ? ` [${m.tool_call_id}]` : "";
    out.push(`### ${archivedMessage ? "(archived) " : ""}${who}${ref}`, "", `${contentText(m)}${calls}`, "", "---", "");
  };
  if (archived.length) {
    out.push("## Archived history (replaced in context by summaries)", "");
    for (const m of archived) render(m, true);
  }
  out.push("## Conversation context", "");
  for (const m of session.messages) render(m, false);
  return out.join("\n");
}
