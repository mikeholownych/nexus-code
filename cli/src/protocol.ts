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
import { visibleControls } from "./file_diff.js";

export const PROTOCOL_VERSION = 1;
export const MAX_TEXT_FIELD = 8000;
/**
 * Longest clipboard text `/paste` puts into the composer, and the limit of the `slash.result` composer field. It keeps
 * the escaped `slash.result` line under the TUI's 1 MiB protocol line cap.
 */
export const MAX_PASTE = 100_000;
export const MAX_SUMMARY = 160;
export const MAX_SLASH_OUTPUT = 32_000;

export type ErrorCode = "BAD_REQUEST" | "BUSY" | "NO_PENDING_APPROVAL" | "NOT_FOUND" | "INTERNAL" | "NO_PROVIDER";

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

/** One entry of a resumed conversation: a message, a tool the agent called, or the last turn's outcome. */
export interface HistoryEntry {
  role: "user" | "assistant" | "steering" | "tool" | "outcome";
  text: string;
  tool?: string;
  heading?: string;
  turn?: TurnResult;
}

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
      mode: "auto" | "review" | "read-only";
      git: { branch: string; dirty: number } | null;
      busy: boolean;
      /** The id the session is saved under (shown so it can be resumed or referred to). */
      session?: string;
      /** The same facts the REPL /status reports (gate I-3). */
      read_only?: boolean;
      context_tokens?: number;
      context_limit?: number;
      endpoint_kind?: "local" | "cloud";
      posture?: {
        mode: "auto" | "review" | "read-only";
        sandbox: string;
        trusted: boolean;
      };
    }
  | { type: "assistant.delta"; turn_id: string; text: string }
  /** What the running turn is doing; sent on every phase change, independent of model output. */
  | {
      type: "activity";
      turn_id: string;
      phase: string;
      step: number;
      segment: number;
      tool?: string;
      subject?: string;
      /** The turn's budget: total steps across segments, and the wall-clock limit in minutes (when continuation is on). */
      max_steps?: number;
      max_minutes?: number;
    }
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
      /** Changed and context lines in the whole diff (what "N more lines" counts), and its hunks. */
      diff_lines: number;
      hunks: number;
      /** The complete diff on disk (redacted), kept for the session whatever the in-memory limits. */
      full_path?: string;
      note?: string;
    }
  | { type: "steer.ack"; id: string; status: SteerStatus; message: string; text?: string }
  | { type: "tool.start"; turn_id: string; call_id: string; tool: string; subject: string; evidence: string }
  | {
      type: "tool.end";
      turn_id: string;
      call_id: string;
      tool: string;
      success: boolean;
      summary: string;
      lines: number;
      evidence: string;
      /** Commands: the first lines of their output (stdout, then stderr), redacted, controls made visible. */
      preview?: string;
      exit_code?: number | null;
      duration_ms?: number;
      timed_out?: boolean;
    }
  | { type: "approval.request"; id: string; turn_id: string; tool: string; subject: string; preview: string; review: ApprovalReview }
  | { type: "checkpoint.choice.request"; id: string; turn_id: string; message: string }
  | { type: "turn.result"; turn_id: string; heading: string; line: string; turn: TurnResult; model_summary: ModelSummary | null; saved: boolean }
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
  /**
   * `key`: a later notice with the same key replaces this one on screen (a live status, not a log line).
   * `detail`: the raw cause, redacted, for the operator to inspect on request. Both are optional, so an older
   * client shows `text` as it always did.
   */
  | { type: "notice"; text: string; key?: string; detail?: string }
  /** A resumed session's recent conversation (user and assistant text only), oldest first; `total` counts all of it. */
  | { type: "history"; session: string; total: number; messages: HistoryEntry[] }
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
      /** Full unified diff of the change this call made, when it changed a file (at most MAX_DIFF_DETAIL chars). */
      diff?: string;
      /** Characters in the complete diff; more than `diff` holds when it was cut to the in-memory limit. */
      diff_chars?: number;
      /** The complete diff on disk. */
      diff_path?: string;
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
  | { type: "checkpoint.choice"; id: string; choice: "read_only" | "without_checkpoint" | "retry" | "allow_sensitive" | "cancel" | "other" }
  | { type: "slash"; id: string; command: string; args: string }
  | { type: "tool.detail"; id: string; evidence: string }
  | { type: "receipt"; id: string }
  | { type: "models.list"; id: string }
  | { type: "model.select"; id: string; provider: string; model: string }
  /** `key` only for method "api-key"; it is never echoed back or logged. */
  | { type: "provider.connect"; id: string; provider: string; method: string; key?: string; endpoint?: string }
  | { type: "provider.cancel"; id: string }
  /** Clear a completed local endpoint setup associated with this exact provider.connect request. */
  | { type: "provider.local-cancel"; id: string }
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
    case "checkpoint.choice": {
      const requestId = requireId("checkpoint.choice");
      const choices = ["read_only", "without_checkpoint", "retry", "allow_sensitive", "cancel", "other"] as const;
      if (!choices.includes(msg.choice as typeof choices[number])) throw new ProtocolError("checkpoint.choice requires a supported choice", requestId);
      return { type: "checkpoint.choice", id: requestId, choice: msg.choice as typeof choices[number] };
    }
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
      if (msg.endpoint !== undefined && (typeof msg.endpoint !== "string" || !msg.endpoint || msg.endpoint.length > 2048 || /[\r\n\0]/.test(msg.endpoint))) {
        throw new ProtocolError("provider.connect endpoint must be a valid single-line URL", requestId);
      }
      return {
        type: "provider.connect", id: requestId, provider: msg.provider, method: msg.method,
        ...(typeof msg.key === "string" ? { key: msg.key } : {}),
        ...(typeof msg.endpoint === "string" ? { endpoint: msg.endpoint } : {}),
      };
    }
    case "provider.cancel":
      return { type: "provider.cancel", id: requireId("provider.cancel") };
    case "provider.local-cancel":
      return { type: "provider.local-cancel", id: requireId("provider.local-cancel") };
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
    ...(turn.turnEvidence
      ? { turnEvidence: { ...turn.turnEvidence, verifierRuns: turn.turnEvidence.verifierRuns.map((r) => ({ ...r, command: redactSecrets(r.command) })) } }
      : {}),
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

/** The notice key of every provider-wait line: one live row that each transition replaces. */
export const PROVIDER_STATUS_KEY = "provider.recovery";
export const STARTUP_PROVIDER_KEY = "provider.startup";

export interface StatusNotice {
  text: string;
  key: string;
  /** The raw cause (redacted); never part of `text`. */
  detail?: string;
}

/** What went wrong, in words an operator can act on. */
function providerProblemWords(record: ProviderRecoveryRecord): string {
  const last = record.submissions[record.submissions.length - 1];
  const status = last?.httpStatus;
  if (record.condition === "AUTH_FAILURE" || status === 401 || status === 403) return "the provider rejected the credentials";
  if (record.condition === "QUOTA_EXHAUSTED" || status === 402) return "the provider account is out of quota";
  if (record.condition === "RATE_LIMITED" || status === 429) return "the provider is rate limiting requests";
  if (record.condition === "OVERLOADED" || status === 503 || status === 529) return "the provider is overloaded";
  if (record.condition === "DRAINING") return "the provider is restarting";
  if (last?.kind === "timeout") return "the provider did not answer in time";
  if (last?.kind === "network_error" || record.condition === "TEMPORARILY_UNAVAILABLE") return "the provider cannot be reached";
  return "the provider returned an error";
}

function minutesWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return ms < 60_000 || minutes < 1 ? "under a minute" : `about ${minutes} min`;
}

function rawProviderCause(record: ProviderRecoveryRecord): string {
  const last = record.submissions[record.submissions.length - 1];
  const parts = [
    `condition ${record.condition}${last?.httpStatus ? `, HTTP ${last.httpStatus}` : ""}${last ? `, ${last.kind}, execution ${last.execution}` : ""}`,
    last?.message,
    record.reason ? `recovery: ${record.reason}` : undefined,
    last?.requestId ? `request ${last.requestId}` : undefined,
  ];
  return redactSecrets(parts.filter(Boolean).join("\n"));
}

/**
 * The provider-wait status line for one recovery transition (PROBING produces none). Every transition carries the
 * same `key`, so the client shows one row that changes instead of a line per attempt (D-06).
 */
export function providerRecoveryStatus(record: ProviderRecoveryRecord, discardedPartialOutput: boolean): StatusNotice | undefined {
  if (record.state === "PROBING") return undefined;
  const detail = rawProviderCause(record);
  const where = record.endpoint ? ` at ${redactSecrets(record.endpoint)}` : "";
  const problem = providerProblemWords(record);
  switch (record.state) {
    case "WAITING": {
      const secs = record.nextAttemptAt ? Math.max(0, Math.round((Date.parse(record.nextAttemptAt) - Date.parse(record.updatedAt)) / 1000)) : 0;
      const left = minutesWords(Math.max(0, record.policy.deadlineMs - record.waitedMs));
      const discarded = discardedPartialOutput ? " The partial response was discarded." : "";
      const text = `Waiting for the model provider${where}: ${problem}. Retry ${record.submissions.length}, next attempt in ${secs}s; gives up in ${left}. Your work is kept. /details shows the raw error; esc cancels.${discarded}`;
      return { text: redactSecrets(text), key: PROVIDER_STATUS_KEY, detail };
    }
    case "RESUMED":
      return { text: `The model provider recovered after ${Math.round(record.waitedMs / 1000)}s; step ${record.step} resumed.`, key: PROVIDER_STATUS_KEY, detail };
    case "CANCELLED":
      return { text: "Stopped waiting for the model provider.", key: PROVIDER_STATUS_KEY, detail };
    default:
      return {
        text: redactSecrets(`Nexus stopped retrying the model provider${where}: ${problem}. Check the connection or use /connect, then send your message again. /details shows the raw error.`),
        key: PROVIDER_STATUS_KEY,
        detail,
      };
  }
}

/** The answer to a prompt sent while the provider is still down: short, because the start-up notice already gave the steps. */
export function noProviderRefusal(problem: { kind: "unreachable" | "rejected"; endpoint: string }): string {
  const why = problem.kind === "rejected" ? `${problem.endpoint} rejected the credentials` : `nothing answers at ${problem.endpoint}`;
  return redactSecrets(`Not sent: no model is connected (${why}). Use /connect or start a local model server, then send it again; your message is back in the composer.`);
}

/** First run with nothing to talk to: what is missing, what to do next, where to read more. The raw cause goes in `detail`. */
export function noProviderNotice(problem: { kind: "unreachable" | "rejected"; endpoint: string; detail: string }): StatusNotice {
  const missing =
    problem.kind === "rejected"
      ? `No model is connected: ${problem.endpoint} rejected the credentials.`
      : `No model is connected: nothing answers at ${problem.endpoint}.`;
  const text =
    `${missing} Next: type /connect to sign in or add an API key, or start a local model server (LM Studio, Ollama, llama.cpp) ` +
    `and send your message again. \`nexus doctor\` checks the setup; docs/CLOUD_PROVIDERS.md lists providers.`;
  return { text: redactSecrets(text), key: STARTUP_PROVIDER_KEY, detail: redactSecrets(problem.detail) };
}

/** Lines of a command's output carried in `tool.end` for the transcript preview. */
export const TOOL_PREVIEW_LINES = 8;

export interface ToolSummary {
  summary: string;
  lines: number;
  preview?: string;
  exit_code?: number | null;
  duration_ms?: number;
  timed_out?: boolean;
}

/**
 * What the transcript shows for a finished tool. A command's JSON result (`stdout`, `stderr`, `exit_code`) becomes a
 * real summary (`exit 0 · 122 lines`, or `no output`), the count of its output lines and a bounded preview of them;
 * other tools keep the first line of their output (or error) as the summary.
 */
export function toolSummary(success: boolean, output: string, error?: string): ToolSummary {
  const command = commandResult(output);
  if (command) {
    const body = [command.stdout.trimEnd(), command.stderr.trimEnd()].filter(Boolean).join("\n");
    const rows = body ? body.split(/\r?\n/) : [];
    const exit = command.timed_out ? "timed out" : command.exit_code === null ? "no exit code" : `exit ${command.exit_code}`;
    const failure = success ? "" : (error ?? "").split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
    const summary = failure && !failure.startsWith("{") ? failure : `${exit} · ${rows.length ? `${rows.length} line${rows.length === 1 ? "" : "s"}` : "no output"}`;
    return {
      summary: redactSecrets(stripEscapes(summary)).replace(/\s+/g, " ").slice(0, MAX_SUMMARY),
      lines: rows.length,
      preview: (rows.length > TOOL_PREVIEW_LINES ? rows.slice(-TOOL_PREVIEW_LINES) : rows).map((row) => visibleControls(redactSecrets(row)).slice(0, 400)).join("\n"),
      exit_code: command.exit_code,
      ...(command.duration_ms !== undefined ? { duration_ms: command.duration_ms } : {}),
      ...(command.timed_out ? { timed_out: true } : {}),
    };
  }
  const text = redactSecrets(stripEscapes(success ? output || "" : error || output || "")).trim();
  const first = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? (success ? "Completed" : "Tool failed");
  return { summary: first.replace(/\s+/g, " ").slice(0, MAX_SUMMARY), lines: text ? text.split(/\r?\n/).length : 0 };
}

/** The structured result of a shell command tool, when `output` is one. */
function commandResult(output: string): { stdout: string; stderr: string; exit_code: number | null; duration_ms?: number; timed_out?: boolean } | undefined {
  if (!output || output.trimStart()[0] !== "{") return undefined;
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === "object" && typeof parsed.stdout === "string" && "exit_code" in parsed) {
      return {
        stdout: parsed.stdout,
        stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
        exit_code: typeof parsed.exit_code === "number" ? parsed.exit_code : null,
        ...(typeof parsed.duration_ms === "number" ? { duration_ms: parsed.duration_ms } : {}),
        ...(parsed.timed_out === true ? { timed_out: true } : {}),
      };
    }
  } catch {}
  return undefined;
}
