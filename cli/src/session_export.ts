/**
 * Session export (`/export` in the TUI and the REPL). The export carries the authoritative task state — objective,
 * requirement states, steering, verifier attempts, plan, milestones, receipts, last turn — beside the conversation,
 * and says plainly whether the conversation is the full history or a compacted context whose earlier messages were
 * replaced by summaries (the replaced originals are included from the session's archive when it exists).
 */
import type { SessionData, SessionManager } from "./session.js";
import type { ChatMessage } from "./types.js";
import { gatingRequirements, requirementDone } from "./core/objective.js";

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

export function buildSessionExport(manager: SessionManager, session: SessionData): SessionExport {
  let archived: { messages: ChatMessage[]; unreadableLines: number } = { messages: [], unreadableLines: 0 };
  try {
    archived = manager.readArchivedHistory(session.id);
  } catch {}
  const history = historyCompleteness(session, archived);
  const objective = session.objective ?? null;
  const lastTurn = session.lastTurn ?? null;
  const json: Record<string, unknown> = {
    ...session,
    export: {
      format: EXPORT_FORMAT,
      exportedAt: new Date().toISOString(),
      history,
      taskState: {
        status: session.status,
        outcome: lastTurn ? { execution: lastTurn.execution, outcome: lastTurn.outcome, reason: lastTurn.reason ?? null, detail: lastTurn.detail ?? null } : null,
        objectiveOutcome: objective?.outcome ?? null,
        unresolvedRequirements: objective ? gatingRequirements(objective).filter((r) => !requirementDone(r)) : [],
        steering: objective?.steering ?? [],
        verificationAttempts: objective?.verification ?? [],
        verificationEvidence: lastTurn?.verification ?? null,
        unverifiedChangesPending: session.unverifiedChangesPending ?? null,
      },
      tokenAccounting:
        "tokenStats.prompt sums the input tokens of every inference request; each request re-sends the whole context, so it grows " +
        "with steps x context size. reportedRequests came from provider usage reports, estimatedRequests were estimated locally.",
    },
    archivedHistory: archived.messages,
  };
  return { json, markdown: markdownExport(session, history, archived.messages) };
}

/**
 * Escape a value for a Markdown table cell. Backslashes are escaped first, then pipes, so an
 * existing backslash (e.g. from `\|` in the source) cannot neutralise the pipe escape and break
 * the surrounding table row (CodeQL js/incomplete-sanitization).
 */
export function escapeTableCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function markdownExport(session: SessionData, history: HistoryCompleteness, archived: ChatMessage[]): string {
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
      for (const r of gating) out.push(`| ${r.id} ${escapeTableCell(r.text)} | ${r.status} | ${escapeTableCell([...r.evidence, r.note ?? ""].filter(Boolean).join("; "))} |`);
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
    if (objective.verification.length) {
      out.push("**Verifier attempts:**", "");
      for (const a of objective.verification) out.push(`- #${a.n} \`${a.command}\` → ${a.status} on ${a.inputs.slice(0, 12)}${a.failedCheck ? ` (${a.failedCheck})` : ""}`);
      out.push("");
    }
  }
  if (session.activePlan?.length) {
    out.push("**Plan (the agent's roadmap; requirement states above are authoritative):**", "");
    for (const p of session.activePlan) out.push(`- [${p.status}] ${p.name}${p.detail ? ` — ${p.detail}` : ""}`);
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
