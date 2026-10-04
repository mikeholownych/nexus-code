/**
 * Nexus sidecar protocol v1: newline-delimited JSON between the Ratatui client (parent) and the
 * Node agent sidecar (child). The sidecar projects agent state; it never asks the client to decide outcomes.
 */
import type { TurnResult } from "./core/turn.js";
import { redactSecrets } from "./ui.js";
import type { ApprovalReview } from "./approval_review.js";
import type { SlashSpec } from "./slash/catalog.js";
import type { EvidenceStatus, ReceiptSection } from "./evidence.js";

export const PROTOCOL_VERSION = 1;
export const MAX_TEXT_FIELD = 8000;
export const MAX_SUMMARY = 160;
export const MAX_SLASH_OUTPUT = 32_000;

export type ErrorCode = "BAD_REQUEST" | "BUSY" | "NO_PENDING_APPROVAL" | "NOT_FOUND" | "INTERNAL";

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
    }
  | { type: "receipt"; id: string; sections: ReceiptSection[] }
  | { type: "error"; id?: string; code: ErrorCode; message: string };

export type SidecarCommand =
  | { type: "prompt.submit"; id: string; text: string }
  | { type: "cancel" }
  | { type: "approve"; id: string; always: boolean }
  | { type: "deny"; id: string }
  | { type: "slash"; id: string; command: string; args: string }
  | { type: "tool.detail"; id: string; evidence: string }
  | { type: "receipt"; id: string }
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
  };
}

export function toolSummary(success: boolean, output: string, error?: string): { summary: string; lines: number } {
  const text = redactSecrets(stripEscapes(success ? output || "" : error || output || "")).trim();
  const first = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? (success ? "Completed" : "Tool failed");
  return { summary: first.replace(/\s+/g, " ").slice(0, MAX_SUMMARY), lines: text ? text.split(/\r?\n/).length : 0 };
}
