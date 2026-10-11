/**
 * Nexus sidecar protocol v1: newline-delimited JSON between the Ratatui client (parent) and the
 * Node agent sidecar (child). The sidecar projects agent state; it never asks the client to decide outcomes.
 */
import type { ProviderRecoveryRecord, TurnResult } from "./core/turn.js";
import { redactSecrets } from "./ui.js";
import type { ApprovalReview } from "./approval_review.js";
import type { SlashSpec } from "./slash/catalog.js";
import type { EvidenceStatus, ReceiptSection } from "./evidence.js";
import type { Catalog } from "./model_catalog.js";

export const PROTOCOL_VERSION = 1;
export const MAX_TEXT_FIELD = 8000;
export const MAX_SUMMARY = 160;
export const MAX_SLASH_OUTPUT = 32_000;

export type ErrorCode = "BAD_REQUEST" | "BUSY" | "NO_PENDING_APPROVAL" | "NOT_FOUND" | "INTERNAL";

/** Lines of a file diff shown in the transcript; the full diff is in the tool call's detail record. */
export const DIFF_PREVIEW_LINES = 40;
export const DIFF_PREVIEW_CHARS = 6000;

/**
 * What became of operator steering sent while work was running. `queued`: held for the next step boundary.
 * `applied`: given to the agent (at a step boundary, or as a follow-up turn). `deferred`: the turn was finishing; it
 * starts a follow-up turn. `cancelled`: the turn ended first; `text` is returned to the operator. `rejected`: nothing
 * it could steer (a command is running); `text` is returned. `duplicate`: this id was already received.
 */
export type SteerStatus = "queued" | "applied" | "deferred" | "cancelled" | "rejected" | "duplicate";

export interface ModelSummary {
  summary: string;
  notes?: string;
}

export type SidecarEvent =
  | { type: "hello"; protocol: number; pid: number; commands: Array<Pick<SlashSpec, "name" | "usage" | "summary">> }
  | {
      type: "session.state";
      workspace: string;
      workspace_name: string;
      model: string;
      mode: "auto" | "review";
      git: { branch: string; dirty: number } | null;
      busy: boolean;
    }
  | { type: "assistant.delta"; turn_id: string; text: string }
  /** What the running turn is doing; sent on every phase change, independent of model output. */
  | { type: "activity"; turn_id: string; phase: string; step: number; segment: number; tool?: string; subject?: string }
  /** A file-edit tool changed a file: that operation's own diff (bounded preview; `evidence` opens the full one). */
  | {
      type: "file.diff";
      turn_id: string;
      call_id: string;
      evidence: string;
      path: string;
      kind: "added" | "modified" | "deleted";
      added: number;
      removed: number;
      preview: string;
      truncated: boolean;
      total_lines: number;
      note?: string;
    }
  | { type: "steer.ack"; id: string; status: SteerStatus; message: string; text?: string }
  | { type: "tool.start"; turn_id: string; call_id: string; tool: string; subject: string; evidence: string }
  | { type: "tool.end"; turn_id: string; call_id: string; tool: string; success: boolean; summary: string; lines: number; evidence: string }
  | { type: "approval.request"; id: string; turn_id: string; tool: string; subject: string; preview: string; review: ApprovalReview }
  | { type: "turn.result"; turn_id: string; heading: string; line: string; turn: TurnResult; model_summary: ModelSummary | null }
  | {
      type: "slash.result";
      id: string;
      command: string;
      success: boolean;
      output: string;
      /** "diff": colour unified-diff lines. */
      format?: "diff";
      /** Text for the client to put into the composer. */
      composer?: string;
      /** The command started a turn with this prompt; the turn's events follow under the same id. */
      prompt?: string;
    }
  | { type: "notice"; text: string }
  | {
      type: "tool.detail";
      id: string;
      evidence: string;
      tool: string;
      subject: string;
      status: EvidenceStatus;
      args: string;
      output: string;
      duration_ms: number | null;
      /** Full unified diff of the change this call made, when it changed a file. */
      diff?: string;
    }
  | { type: "receipt"; id: string; sections: ReceiptSection[] }
  | { type: "error"; id?: string; code: ErrorCode; message: string }
  /** Answer to models.list: providers (with connection source, never a credential), models, current and recent. */
  | ({ type: "models.catalog"; id: string } & Catalog)
  /** A sign-in needs the operator: open `url` (and type `user_code` for a device flow). */
  | { type: "provider.auth"; id: string; provider: string; url: string; user_code?: string; instructions: string }
  /** Outcome of provider.connect / provider.disconnect. */
  | { type: "provider.result"; id: string; provider: string; success: boolean; message: string }
  /** Outcome of model.select. */
  | { type: "model.result"; id: string; success: boolean; message: string };

export type SidecarCommand =
  | { type: "prompt.submit"; id: string; text: string }
  /** Operator guidance for the work in progress (see SteerStatus). */
  | { type: "steer"; id: string; text: string }
  | { type: "cancel" }
  | { type: "approve"; id: string; always: boolean }
  | { type: "deny"; id: string }
  | { type: "slash"; id: string; command: string; args: string }
  | { type: "tool.detail"; id: string; evidence: string }
  | { type: "receipt"; id: string }
  | { type: "models.list"; id: string }
  | { type: "model.select"; id: string; provider: string; model: string }
  /** `key` only for method "api-key"; it is never echoed back or logged. */
  | { type: "provider.connect"; id: string; provider: string; method: string; key?: string }
  | { type: "provider.cancel"; id: string }
  | { type: "provider.disconnect"; id: string; provider: string }
  | { type: "shutdown" };

export class ProtocolError extends Error {
  constructor(message: string, public readonly id?: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Truncation can split a surrogate pair; a lone surrogate would serialize as JSON the client cannot decode. */
export function encodeEvent(event: SidecarEvent): string {
  const wellFormed = (_key: string, value: unknown) => (typeof value === "string" ? value.replace(LONE_SURROGATE, "\uFFFD") : value);
  return JSON.stringify({ v: PROTOCOL_VERSION, ...event }, wellFormed) + "\n";
}

export function parseCommand(line: string): SidecarCommand {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new ProtocolError("line is not valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProtocolError("message must be a JSON object");
  const msg = raw as Record<string, unknown>;
  const id = typeof msg.id === "string" && msg.id ? msg.id : undefined;
  if (msg.v !== PROTOCOL_VERSION) throw new ProtocolError(`unsupported protocol version: ${String(msg.v)}`, id);
  const requireId = (type: string): string => {
    if (!id) throw new ProtocolError(`${type} requires id`);
    return id;
  };
  switch (msg.type) {
    case "prompt.submit": {
      const requestId = requireId("prompt.submit");
      const text = msg.text;
      if (typeof text !== "string" || !text.trim()) throw new ProtocolError("prompt.submit requires non-empty text", requestId);
      return { type: "prompt.submit", id: requestId, text };
    }
    case "steer": {
      const requestId = requireId("steer");
      const text = msg.text;
      if (typeof text !== "string" || !text.trim()) throw new ProtocolError("steer requires non-empty text", requestId);
      return { type: "steer", id: requestId, text };
    }
    case "cancel":
      return { type: "cancel" };
    case "approve":
      return { type: "approve", id: requireId("approve"), always: msg.always === true };
    case "deny":
      return { type: "deny", id: requireId("deny") };
    case "slash": {
      const requestId = requireId("slash");
      const command = msg.command;
      if (typeof command !== "string" || !command.trim()) throw new ProtocolError("slash requires command", requestId);
      return { type: "slash", id: requestId, command, args: typeof msg.args === "string" ? msg.args : "" };
    }
    case "tool.detail": {
      const requestId = requireId("tool.detail");
      const evidence = msg.evidence;
      if (typeof evidence !== "string" || !evidence) throw new ProtocolError("tool.detail requires evidence", requestId);
      return { type: "tool.detail", id: requestId, evidence };
    }
    case "receipt":
      return { type: "receipt", id: requireId("receipt") };
    case "models.list":
      return { type: "models.list", id: requireId("models.list") };
    case "model.select": {
      const requestId = requireId("model.select");
      if (typeof msg.provider !== "string" || !msg.provider || typeof msg.model !== "string" || !msg.model.trim()) {
        throw new ProtocolError("model.select requires provider and model", requestId);
      }
      return { type: "model.select", id: requestId, provider: msg.provider, model: msg.model };
    }
    case "provider.connect": {
      const requestId = requireId("provider.connect");
      if (typeof msg.provider !== "string" || !msg.provider || typeof msg.method !== "string" || !msg.method) {
        throw new ProtocolError("provider.connect requires provider and method", requestId);
      }
      if (msg.key !== undefined && typeof msg.key !== "string") throw new ProtocolError("provider.connect key must be a string", requestId);
      return { type: "provider.connect", id: requestId, provider: msg.provider, method: msg.method, ...(typeof msg.key === "string" ? { key: msg.key } : {}) };
    }
    case "provider.cancel":
      return { type: "provider.cancel", id: requireId("provider.cancel") };
    case "provider.disconnect": {
      const requestId = requireId("provider.disconnect");
      if (typeof msg.provider !== "string" || !msg.provider) throw new ProtocolError("provider.disconnect requires provider", requestId);
      return { type: "provider.disconnect", id: requestId, provider: msg.provider };
    }
    case "shutdown":
      return { type: "shutdown" };
    default:
      throw new ProtocolError(`unknown message type: ${String(msg.type)}`, id);
  }
}

export function capText(text: string, max: number = MAX_TEXT_FIELD): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

/** CSI sequences, OSC sequences (BEL or ST terminated), then the remaining two-character escapes. */
const TERMINAL_ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[0-~]/g;

export function stripEscapes(text: string): string {
  return text.replace(TERMINAL_ESCAPE, "");
}

export function toolSubject(args: Record<string, any>): string {
  const subject = args.path ?? args.file_path ?? args.command ?? args.url ?? args.query ?? args.name ?? "";
  return redactSecrets(stripEscapes(String(subject))).replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Copy of a turn with secrets redacted from its free-text fields; enums, counts, ids and hashes are left as-is. */
export function projectTurn(turn: TurnResult): TurnResult {
  const redactOptional = (text: string | undefined) => (text === undefined ? undefined : redactSecrets(text));
  return {
    ...turn,
    detail: redactOptional(turn.detail),
    verification: turn.verification ? { ...turn.verification, command: redactOptional(turn.verification.command) } : null,
    interruption: turn.interruption ? { ...turn.interruption, outstandingTool: redactOptional(turn.interruption.outstandingTool) } : null,
    inferenceFailure: turn.inferenceFailure ? { ...turn.inferenceFailure, message: redactSecrets(turn.inferenceFailure.message) } : null,
    ...(turn.providerRecovery
      ? {
          providerRecovery: turn.providerRecovery.map((r) => ({
            ...r,
            reason: redactOptional(r.reason),
            submissions: r.submissions.map((s) => ({ ...s, message: redactSecrets(s.message) })),
          })),
        }
      : {}),
  };
}

/** One-line operator notice for a provider recovery transition; PROBING produces none. */
export function providerRecoveryNotice(record: ProviderRecoveryRecord, discardedPartialOutput: boolean): string | undefined {
  const last = record.submissions[record.submissions.length - 1];
  const condition = record.condition.toLowerCase().replace(/_/g, " ");
  const discarded = discardedPartialOutput ? " The partial response was discarded." : "";
  switch (record.state) {
    case "WAITING": {
      const secs = record.nextAttemptAt ? Math.max(0, Math.round((Date.parse(record.nextAttemptAt) - Date.parse(record.updatedAt)) / 1000)) : 0;
      return `Inference provider ${condition} (${last?.httpStatus ? `HTTP ${last.httpStatus}` : last?.kind ?? "failure"}); waiting ${secs}s before checking again. Work is preserved.${discarded}`;
    }
    case "RESUMED":
      return `Inference provider recovered after ${Math.round(record.waitedMs / 1000)}s; step ${record.step} resumed.`;
    case "PROBING":
      return undefined;
    default:
      return redactSecrets(`Provider recovery ${record.state.toLowerCase()}: ${record.reason ?? condition}`);
  }
}

export function toolSummary(success: boolean, output: string, error?: string): { summary: string; lines: number } {
  const text = redactSecrets(stripEscapes(success ? output || "" : error || output || "")).trim();
  const first = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? (success ? "Completed" : "Tool failed");
  return { summary: first.replace(/\s+/g, " ").slice(0, MAX_SUMMARY), lines: text ? text.split(/\r?\n/).length : 0 };
}
