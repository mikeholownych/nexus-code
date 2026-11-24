/**
 * The translation between the sidecar protocol (cli/src/protocol.ts) and ACP, as pure functions: a sidecar event in, an
 * ACP message out, and a client's permission reply in, a sidecar command out. No state, no I/O: the adapter (a later
 * slice) owns sessions, ids and the link to the sidecar, and calls these.
 *
 * Sidecar events arrive already redacted and bounded by `formatSafeSidecarEvent`; nothing here widens them.
 * Nexus-specific data goes under `_meta`, never at the root of a type of the specification ("Implementations MUST NOT
 * add any custom fields at the root of a type that's part of the specification", published specification, extensibility).
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { diffSidePath, headerPath } from "../core/unified_diff.js";
import type { TurnResult } from "../core/turn.js";
import type { ReceiptSection } from "../evidence.js";
import type { ErrorCode, SidecarEvent } from "../protocol.js";
import { errorResponse, notification, request, rpcError } from "./jsonrpc.js";
import {
  ACP_ALLOW_ONCE_OPTION_ID,
  ACP_ERROR,
  ACP_MAX_DIFF_BLOCKS,
  ACP_MAX_ERROR_MESSAGE_CHARS,
  ACP_MAX_TOOL_TEXT_CHARS,
  ACP_META_APPROVAL_DIGEST,
  ACP_META_DIFF,
  ACP_META_EXPERIMENTAL,
  ACP_META_EXTENSIONS,
  ACP_META_HISTORY,
  ACP_META_MCP_SERVERS_IGNORED,
  ACP_META_POSTURE,
  ACP_META_SIDECAR_PROTOCOL,
  ACP_META_VERIFICATION,
  ACP_PERMISSION_OPTIONS,
  ACP_PROTOCOL_VERSION,
  ACP_RECEIPT_GET_METHOD,
  ACP_VERIFY_METHOD,
  ACP_VERIFICATION_CARRIER,
} from "./types.js";
import type {
  AcpAgentMessageChunk,
  AcpError,
  AcpErrorCode,
  AcpErrorResponse,
  AcpHistoryExtent,
  AcpId,
  AcpInitializeResult,
  AcpLoadSessionResult,
  AcpMcpServersIgnored,
  AcpNewSessionResult,
  AcpPermissionRequest,
  AcpPosture,
  AcpPromptResult,
  AcpSessionInfoUpdate,
  AcpSessionMeta,
  AcpSessionUpdate,
  AcpSessionUpdateNotification,
  AcpStopReason,
  AcpToolCall,
  AcpToolCallContent,
  AcpToolCallUpdate,
  AcpToolDiffContent,
  AcpToolKind,
  AcpToolRawOutput,
  AcpValidationReceipt,
  AcpVerification,
  NexusReceipt,
} from "./types.js";
import { singleLine, validatePermissionResult } from "./validate.js";

type Event<T extends SidecarEvent["type"]> = Extract<SidecarEvent, { type: T }>;

/**
 * What becomes of each sidecar event type. `mapped`: a function here turns it into an ACP message. `consumed`: the
 * adapter uses it for its own state and sends nothing for it. `dropped`: deliberately not shown to an ACP client.
 * The key type makes a missing entry a compile error, and a test compares the keys with the union in protocol.ts.
 */
export const SIDECAR_EVENT_DISPOSITION: Record<SidecarEvent["type"], { disposition: "mapped" | "consumed" | "dropped"; why: string }> = {
  hello: { disposition: "consumed", why: "session start: the protocol version and the capabilities `receipt` and `tool.detail` are required" },
  initialized: { disposition: "consumed", why: "session start: the answer to the adapter's own initialize" },
  "session.state": { disposition: "mapped", why: "sessionId and _meta posture of session/new and session/load (postureFromState)" },
  "assistant.delta": { disposition: "mapped", why: "agent_message_chunk (assistantDeltaToUpdate)" },
  "stream.stall": { disposition: "dropped", why: "a provider stall has no ACP update; the turn's result reports a failure" },
  activity: { disposition: "dropped", why: "phase changes have no ACP update; tool calls carry the progress" },
  "file.diff": { disposition: "mapped", why: "tool_call_update with diff content (fileDiffToUpdate)" },
  "steer.ack": { disposition: "dropped", why: "steering is not exposed over ACP, so nothing is acknowledged" },
  "tool.start": { disposition: "mapped", why: "tool_call (toolStartToUpdate)" },
  "tool.end": { disposition: "mapped", why: "tool_call_update with status and text (toolEndToUpdate)" },
  "approval.request": { disposition: "mapped", why: "session/request_permission (approvalToPermissionRequest)" },
  "checkpoint.choice.request": { disposition: "consumed", why: "the adapter answers `cancel` and fails the prompt; it never chooses for the operator" },
  "turn.result": { disposition: "mapped", why: "stop reason, verification carrier and verdict line (turnToStop, verificationFromTurn)" },
  "slash.result": { disposition: "dropped", why: "slash commands are not exposed over ACP" },
  notice: { disposition: "dropped", why: "operator notices go to the adapter's stderr log, not into the conversation" },
  history: { disposition: "mapped", why: "session/load replay (historyToReplay)" },
  "tool.detail": { disposition: "mapped", why: "the full diff of a file change (fileDiffToUpdate)" },
  receipt: { disposition: "mapped", why: "receipt sections of _nexus/receipt/get and the validation receipt id (validationReceiptFromSections)" },
  error: { disposition: "mapped", why: "a JSON-RPC error (sidecarErrorToRpc)" },
  "models.catalog": { disposition: "dropped", why: "model selection is not exposed over ACP" },
  "provider.auth": { disposition: "dropped", why: "provider sign-in is not exposed over ACP" },
  "provider.result": { disposition: "dropped", why: "provider sign-in is not exposed over ACP" },
  "model.result": { disposition: "dropped", why: "model selection is not exposed over ACP" },
};

/**
 * The ACP kind of every model tool of the capability catalogue (`HARNESS_TOOLS`; a test fails when a tool is added
 * there without a row here) and of `verifier`, which the gate asks about under that name. Any other name (an MCP or
 * plugin tool, `steering_conflict`) is `other`.
 */
export const TOOL_KINDS: Readonly<Record<string, AcpToolKind>> = {
  read_file: "read",
  batch_read: "read",
  file_info: "read",
  list_dir: "read",
  file_tree: "read",
  outline_file: "read",
  lsp_hover: "read",
  lsp_diagnostics: "read",
  git_status: "read",
  git_diff: "read",
  git_log: "read",
  write_file: "edit",
  edit_file: "edit",
  patch_file: "edit",
  delete_file: "delete",
  search_code: "search",
  find_files: "search",
  search_symbols: "search",
  cst_symbols: "search",
  trigram_search: "search",
  hybrid_search: "search",
  lsp_definition: "search",
  run_command: "execute",
  run_tests: "execute",
  verifier: "execute",
  fetch_web: "fetch",
  search_web: "fetch",
  browser_navigate: "fetch",
  browser_screenshot: "fetch",
  browser_console_logs: "fetch",
  browser_click: "other",
  browser_type: "other",
  spawn_subagent: "think",
  update_plan: "think",
  task_completed: "other",
  activate_skill: "other",
  manage_knowledge: "other",
};

export function toolKind(tool: string): AcpToolKind {
  return Object.hasOwn(TOOL_KINDS, tool) ? TOOL_KINDS[tool] : "other";
}

function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

function textContent(text: string): AcpToolCallContent {
  return { type: "content", content: { type: "text", text: bounded(text, ACP_MAX_TOOL_TEXT_CHARS) } };
}

function toolTitle(tool: string, subject: string): string {
  const name = singleLine(tool, 200) || "tool";
  const what = singleLine(subject, 300);
  return what ? `${name}: ${what}` : name;
}

/** Wraps a session update in its `session/update` notification. */
export function sessionUpdate(sessionId: string, update: AcpSessionUpdate): AcpSessionUpdateNotification {
  return notification("session/update", { sessionId, update });
}

/** The `initialize` result. `version`: the CLI's version; `sidecarProtocol`: `PROTOCOL_VERSION` of protocol.ts. */
export function initializeResult(nexus: { version: string; sidecarProtocol: number }): AcpInitializeResult {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentInfo: { name: "nexus", title: "Nexus Code", version: nexus.version },
    authMethods: [],
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false },
      _meta: { [ACP_META_EXPERIMENTAL]: true, [ACP_META_EXTENSIONS]: [ACP_RECEIPT_GET_METHOD, ACP_VERIFY_METHOD], [ACP_META_SIDECAR_PROTOCOL]: nexus.sidecarProtocol },
    },
  };
}

/** The session's posture as the sidecar reports it; undefined from a sidecar that sends none. */
export function postureFromState(state: Event<"session.state">): AcpPosture | undefined {
  const posture = state.posture;
  if (!posture) return undefined;
  return { mode: posture.mode, sandbox: posture.sandbox, trusted: posture.trusted, read_only: state.read_only === true || posture.mode === "read-only" };
}

function sessionMeta(state: Event<"session.state">, ignored: AcpMcpServersIgnored, history?: AcpHistoryExtent): AcpSessionMeta | undefined {
  const posture = postureFromState(state);
  const meta: AcpSessionMeta = {
    ...(posture ? { [ACP_META_POSTURE]: posture } : {}),
    ...(ignored.count > 0 ? { [ACP_META_MCP_SERVERS_IGNORED]: ignored } : {}),
    ...(history ? { [ACP_META_HISTORY]: history } : {}),
  };
  return Object.keys(meta).length ? meta : undefined;
}

/** The `session/new` result; undefined when the sidecar's state names no session (the adapter then fails the request). */
export function newSessionResult(state: Event<"session.state">, ignored: AcpMcpServersIgnored): AcpNewSessionResult | undefined {
  if (!state.session) return undefined;
  const meta = sessionMeta(state, ignored);
  return { sessionId: state.session, ...(meta ? { _meta: meta } : {}) };
}

/** The `session/load` result: the specification's empty object, with Nexus's data under `_meta`. */
export function loadSessionResult(state: Event<"session.state">, ignored: AcpMcpServersIgnored, history: AcpHistoryExtent): AcpLoadSessionResult {
  const meta = sessionMeta(state, ignored, history);
  return meta ? { _meta: meta } : {};
}

function messageChunk(text: string): AcpAgentMessageChunk {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

export function assistantDeltaToUpdate(event: Event<"assistant.delta">): AcpAgentMessageChunk {
  return messageChunk(event.text);
}

/**
 * The id of a tool call over ACP: the sidecar's evidence id, because a model's own call ids can repeat. A `tool.end`
 * whose start the sidecar did not record has no evidence id and falls back to the call id.
 */
export function toolCallId(event: { evidence: string; call_id: string }): string {
  return event.evidence || `call:${event.call_id}`;
}

export function toolStartToUpdate(event: Event<"tool.start">): AcpToolCall {
  return {
    sessionUpdate: "tool_call",
    toolCallId: toolCallId(event),
    title: toolTitle(event.tool, event.subject),
    kind: toolKind(event.tool),
    status: "pending",
    rawInput: { tool: event.tool, subject: event.subject },
  };
}

/**
 * A finished tool call. `completed` only for a call that ran and succeeded: a call the gate refused, one the operator
 * declined (`denied`) and one that failed are all `failed`.
 */
export function toolEndToUpdate(event: Event<"tool.end">): AcpToolCallUpdate {
  const status = event.success === true && event.denied !== true ? "completed" : "failed";
  const rawOutput: AcpToolRawOutput = {
    ...(event.exit_code !== undefined ? { exit_code: event.exit_code } : {}),
    ...(event.duration_ms !== undefined ? { duration_ms: event.duration_ms } : {}),
    ...(event.timed_out !== undefined ? { timed_out: event.timed_out } : {}),
    ...(event.denied === true ? { denied: true } : {}),
  };
  const text = [event.summary, event.preview].filter((part): part is string => typeof part === "string" && part.trim() !== "").join("\n");
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: toolCallId(event),
    status,
    ...(text ? { content: [textContent(text)] } : {}),
    ...(Object.keys(rawOutput).length ? { rawOutput } : {}),
  };
}

const CAP_MARKER = /…\[truncated \d+ chars\]\s*$/;

/**
 * A unified diff as ACP diff blocks, one per hunk: `oldText` is the hunk's context and removed lines, `newText` its
 * context and added lines; `oldText` is null for a file that did not exist. Paths are made absolute against
 * `workspace`; `fallbackPath` names the file when the diff has no header (a cut preview). `truncated`: the diff was cut
 * by its producer, or has more hunks than one update carries.
 */
export function unifiedDiffToBlocks(diff: string, workspace: string, fallbackPath?: string): { blocks: AcpToolDiffContent[]; truncated: boolean } {
  const blocks: AcpToolDiffContent[] = [];
  let truncated = CAP_MARKER.test(diff);
  const lines = diff.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let created = false;
  let hunk: { before: string[]; after: string[]; beforeEol: boolean; afterEol: boolean; last: "before" | "after" | "both" } | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  const side = (rows: string[], eol: boolean) => (rows.length ? rows.join("\n") + (eol ? "\n" : "") : "");
  const flush = () => {
    const done = hunk;
    hunk = undefined;
    oldLeft = 0;
    newLeft = 0;
    if (!done) return;
    const file = newPath ?? oldPath ?? fallbackPath;
    if (!file) return;
    if (blocks.length >= ACP_MAX_DIFF_BLOCKS) {
      truncated = true;
      return;
    }
    blocks.push({ type: "diff", path: path.resolve(workspace, file), oldText: created ? null : side(done.before, done.beforeEol), newText: side(done.after, done.afterEol) });
  };
  for (const line of lines) {
    if (hunk && line.startsWith("\\")) {
      // "\ No newline at end of file" describes the line just read.
      if (hunk.last !== "after") hunk.beforeEol = false;
      if (hunk.last !== "before") hunk.afterEol = false;
      continue;
    }
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      // A hunk header says how many lines follow on each side, so a removed line "-- x" (written "--- x") is content.
      if (line.startsWith(" ") || line === "") {
        hunk.before.push(line.slice(1));
        hunk.after.push(line.slice(1));
        hunk.last = "both";
        oldLeft = Math.max(0, oldLeft - 1);
        newLeft = Math.max(0, newLeft - 1);
        continue;
      }
      if (line.startsWith("-") && oldLeft > 0) {
        hunk.before.push(line.slice(1));
        hunk.last = "before";
        oldLeft--;
        continue;
      }
      if (line.startsWith("+") && newLeft > 0) {
        hunk.after.push(line.slice(1));
        hunk.last = "after";
        newLeft--;
        continue;
      }
      // The hunk ended earlier than its header promised: read this line as structure.
    }
    if (line.startsWith("@@")) {
      flush();
      const counts = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (!counts) continue;
      oldLeft = counts[1] === undefined ? 1 : Number(counts[1]);
      newLeft = counts[2] === undefined ? 1 : Number(counts[2]);
      hunk = { before: [], after: [], beforeEol: true, afterEol: true, last: "both" };
    } else if (line.startsWith("diff --git ")) {
      flush();
      oldPath = undefined;
      newPath = undefined;
      created = false;
    } else if (line.startsWith("--- ")) {
      flush();
      const raw = headerPath(line.slice(4));
      oldPath = raw === undefined ? undefined : diffSidePath(raw, "a/");
      created = raw !== undefined && oldPath === undefined;
      newPath = undefined;
    } else if (line.startsWith("+++ ")) {
      const raw = headerPath(line.slice(4));
      newPath = raw === undefined ? undefined : diffSidePath(raw, "b/");
    } else if (hunk) {
      flush();
    }
  }
  flush();
  return { blocks, truncated };
}

/**
 * The diff of a file change as a `tool_call_update`. With the tool call's detail record (`tool.detail`) the full diff
 * is used; without it, the bounded preview the `file.diff` event carries. `_meta["nexus/diff"]` says which it was.
 */
export function fileDiffToUpdate(event: Event<"file.diff">, workspace: string, detail?: Event<"tool.detail">): AcpToolCallUpdate {
  const full = detail?.diff;
  const { blocks, truncated } = unifiedDiffToBlocks(full ?? event.preview, workspace, event.path);
  const cut = truncated || (full === undefined ? event.truncated : (detail?.diff_chars ?? full.length) > full.length);
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: toolCallId(event),
    status: "in_progress",
    ...(blocks.length ? { content: blocks } : {}),
    _meta: { [ACP_META_DIFF]: { kind: event.kind, added: event.added, removed: event.removed, truncated: cut } },
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).filter((key) => object[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** SHA-256 (hex) of the canonical `{tool, subject, preview, review}` of an approval: what the operator was shown. */
export function approvalDigest(event: Event<"approval.request">): string {
  const { tool, subject, preview, review } = event;
  return createHash("sha256").update(canonicalJson({ tool, subject, preview, review })).digest("hex");
}

/**
 * The tool call an approval asks about. `approval.request` carries no call id, so it is bound to the one open
 * `tool.start` of the same turn with the same tool and subject; with none, or more than one, the approval's own id is
 * used as a synthetic tool call id.
 */
export function bindApprovalToToolCall(event: Event<"approval.request">, open: ReadonlyArray<Event<"tool.start">>): string {
  const matches = open.filter((start) => start.turn_id === event.turn_id && start.tool === event.tool && start.subject === event.subject);
  return matches.length === 1 ? toolCallId(matches[0]) : event.id;
}

function reviewContent(event: Event<"approval.request">, workspace: string): AcpToolCallContent[] {
  const review = event.review;
  const cut = (truncated: boolean): AcpToolCallContent[] => (truncated ? [textContent("This review text was cut to its size limit; the call's full arguments are larger.")] : []);
  switch (review?.kind) {
    case "change": {
      const hidden = review.before === null && !review.created;
      return [
        { type: "diff", path: path.resolve(workspace, review.path), oldText: review.before, newText: review.after },
        ...(hidden ? [textContent("The file exists, and its current content is not shown (outside the workspace, not a regular file, or too large).")] : []),
        ...cut(review.truncated),
      ];
    }
    case "patch":
      return [textContent(`Patch for ${singleLine(review.path, 400)}:\n${review.patch}`), ...cut(review.truncated)];
    case "command":
      return [textContent(review.command)];
    case "verifier":
      return [textContent([`Verifier: ${review.command}`, review.script, review.detail].filter((part): part is string => typeof part === "string" && part !== "").join("\n\n"))];
    case "args":
      return [textContent(review.text), ...cut(review.truncated)];
    default:
      // A review kind this adapter does not know: show the raw arguments rather than nothing.
      return [textContent(event.preview)];
  }
}

/**
 * `approval.request` as a `session/request_permission` request with exactly the two options allow-once and reject.
 * `rpcId` comes from the adapter's `RequestCorrelator`, `toolCallId` from `bindApprovalToToolCall`.
 */
export function approvalToPermissionRequest(event: Event<"approval.request">, binding: { rpcId: number; sessionId: string; toolCallId: string; workspace: string }): AcpPermissionRequest {
  return request(binding.rpcId, "session/request_permission", {
    sessionId: binding.sessionId,
    toolCall: {
      toolCallId: binding.toolCallId,
      title: toolTitle(event.tool, event.subject),
      kind: toolKind(event.tool),
      status: "pending",
      content: reviewContent(event, binding.workspace),
      rawInput: { tool: event.tool, subject: event.subject },
      _meta: { [ACP_META_APPROVAL_DIGEST]: approvalDigest(event) },
    },
    options: ACP_PERMISSION_OPTIONS.map((option) => ({ ...option })),
  });
}

/** The only two commands a permission reply can become. `always` has the literal type `false`: no caller can widen it. */
export type ApprovalCommand = { type: "approve"; id: string; always: false } | { type: "deny"; id: string };

/**
 * A client's reply to a permission request, as the sidecar command for the approval it answers. THE ONE DECISION POINT:
 * `approve` (once, never "always") only for a well-formed `selected` outcome whose option id is the allow-once id Nexus
 * offered. Everything else is `deny`: reject, cancelled, an option id that was not offered (`allow_always` included), a
 * JSON-RPC error, a malformed or missing result.
 *
 * The caller must have matched the reply to an open request first (`RequestCorrelator.settle` returned `matched`); a
 * stale or unknown reply is never passed here, so it produces no command at all.
 */
export function permissionReplyToCommand(approvalId: string, reply: { result: unknown } | { error: unknown }): ApprovalCommand {
  const deny: ApprovalCommand = { type: "deny", id: approvalId };
  if (!Object.hasOwn(reply, "result") || Object.hasOwn(reply, "error")) return deny;
  const parsed = validatePermissionResult((reply as { result: unknown }).result);
  if (!parsed.ok || parsed.value.outcome !== "selected") return deny;
  if (parsed.value.optionId !== ACP_ALLOW_ONCE_OPTION_ID) return deny;
  return { type: "approve", id: approvalId, always: false };
}

/**
 * How a prompt request ends for a finished turn: a stop reason, or a JSON-RPC error for a turn that failed.
 * `end_turn` says nothing about verification; the verification object does.
 */
export function turnToStop(turn: TurnResult): { stopReason: AcpStopReason } | { error: AcpError } {
  switch (turn.execution) {
    case "INTERRUPTED":
      return { stopReason: "cancelled" };
    case "LIMIT_REACHED":
      return { stopReason: "max_turn_requests" };
    case "COMPLETED":
    case "BLOCKED":
      return { stopReason: "end_turn" };
    case "FAILED": {
      const failure = turn.inferenceFailure;
      if (failure?.kind === "output_truncated") return { stopReason: "max_tokens" };
      const credentials = failure?.condition === "AUTH_FAILURE" || failure?.httpStatus === 401 || failure?.httpStatus === 403;
      const message = bounded(turn.detail || failure?.message || "the turn failed", ACP_MAX_ERROR_MESSAGE_CHARS);
      return { error: rpcError(credentials ? ACP_ERROR.AUTH_REQUIRED : ACP_ERROR.INTERNAL_ERROR, message, { reason: turn.reason ?? "FAILED" }) };
    }
    default:
      // An execution state this adapter does not know is never reported as a clean end.
      return { error: rpcError(ACP_ERROR.INTERNAL_ERROR, "the turn ended in a state this adapter does not know", { reason: String(turn.execution) }) };
  }
}

/** The title of the receipt section that shows the validation receipt (`validationSection` in cli/src/evidence.ts). */
export const VALIDATION_RECEIPT_SECTION = "Validation receipt";

/**
 * Reads the validation receipt out of the receipt's display rows: the one place that depends on those rows' labels
 * (a test pins it against `receiptSections`). Null when no receipt is active.
 */
export function validationReceiptFromSections(sections: ReadonlyArray<ReceiptSection>): AcpValidationReceipt | null {
  const section = sections.find((candidate) => candidate.title === VALIDATION_RECEIPT_SECTION);
  const value = (label: string) => section?.rows.find((row) => row[0] === label)?.[1];
  const id = value("receipt");
  if (!id) return null;
  return { id, status: value("status") ?? "", candidate: value("candidate") ?? null };
}

/**
 * The verification object of a turn, from its result and the receipt sections the sidecar returned for it (omitted
 * when the receipt could not be fetched: there is then no validation receipt to report). `turnId` is null for the last
 * outcome of a loaded session.
 */
export function verificationFromTurn(input: { sessionId: string; turnId: string | null; turn: TurnResult; sections?: ReadonlyArray<ReceiptSection> }): AcpVerification {
  const { turn } = input;
  const validation = input.sections ? validationReceiptFromSections(input.sections) : null;
  const v = turn.verification;
  return {
    receipt_id: validation?.id ?? `turn:${input.sessionId}:${input.turnId ?? "last"}`,
    turn_id: input.turnId,
    execution: turn.execution,
    outcome: turn.outcome,
    ...(turn.reason ? { reason: turn.reason } : {}),
    unverified_changes_pending: turn.unverifiedChangesPending === true,
    verifier: v
      ? {
          status: v.status,
          ...(v.command !== undefined ? { command: v.command } : {}),
          ...(v.source !== undefined ? { source: v.source } : {}),
          ...(v.exitSuccess !== undefined ? { exit_success: v.exitSuccess } : {}),
          ...(v.outputSha256 !== undefined ? { output_sha256: v.outputSha256 } : {}),
          ...(v.candidateId !== undefined ? { candidate: v.candidateId } : {}),
        }
      : null,
    verifier_runs: (turn.turnEvidence?.verifierRuns ?? []).map((run) => ({ command: run.command, phase: run.phase, passed: run.passed })),
    validation_receipt: validation,
  };
}

/** The carrier update: sent just before the prompt response, so a client that reads `_meta` has the verdict first. */
export function verificationUpdate(verification: AcpVerification): AcpSessionInfoUpdate {
  return { sessionUpdate: ACP_VERIFICATION_CARRIER, _meta: { [ACP_META_VERIFICATION]: verification } };
}

/** The verdict as plain text, so a client that ignores `_meta` cannot show an unverified completion as plain success. */
export function verdictChunk(heading: string, line: string): AcpAgentMessageChunk {
  return messageChunk(`\n\n${heading}\n${line}\n`);
}

export function promptResult(stopReason: AcpStopReason, verification: AcpVerification): AcpPromptResult {
  return { stopReason, _meta: { [ACP_META_VERIFICATION]: verification } };
}

export function nexusReceipt(sessionId: string, verification: AcpVerification, sections: ReadonlyArray<ReceiptSection>): NexusReceipt {
  return { receipt_id: verification.receipt_id, session_id: sessionId, turn_id: verification.turn_id, verification, sections: [...sections] };
}

/**
 * A loaded session's `history` as replay updates, oldest first: operator text (prompts and steering) as
 * `user_message_chunk`, the agent's text as `agent_message_chunk`, each tool as a completed `tool_call` (`hist-N`),
 * and the last outcome as the verification carrier followed by its verdict line. For paged history, callers combine
 * the page updates and extents in page order before returning the session/load response.
 */
export function historyToReplay(event: Event<"history">): { updates: AcpSessionUpdate[]; extent: AcpHistoryExtent } {
  const updates: AcpSessionUpdate[] = [];
  let sent = 0;
  let tools = 0;
  for (const entry of event.messages) {
    switch (entry.role) {
      case "user":
      case "steering":
        sent++;
        updates.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: entry.text } });
        break;
      case "assistant":
        sent++;
        updates.push(messageChunk(entry.text));
        break;
      case "tool": {
        const tool = entry.tool ?? "tool";
        const toolCallId = entry.toolCallId ?? `hist-${++tools}`;
        updates.push({ sessionUpdate: "tool_call", toolCallId, title: toolTitle(tool, entry.text), kind: toolKind(tool), status: entry.status ?? "completed", rawInput: { tool, subject: entry.text } });
        break;
      }
      case "tool_result": {
        updates.push({
          sessionUpdate: "tool_call_update",
          toolCallId: entry.toolCallId ?? `hist-${++tools}`,
          status: entry.status ?? "completed",
          ...(entry.text ? { content: [{ type: "content", content: { type: "text", text: entry.text } }] } : {}),
        });
        break;
      }
      case "outcome":
        if (entry.turn) updates.push(verificationUpdate(verificationFromTurn({ sessionId: event.session, turnId: null, turn: entry.turn })));
        if (entry.heading || entry.text) updates.push(verdictChunk(entry.heading ?? "", entry.text));
        break;
    }
  }
  return { updates, extent: { sent, total: Math.max(event.total, sent) } };
}

/**
 * Sidecar error codes as JSON-RPC codes. All are -32603: none is the client's doing (the adapter validates before it
 * sends), and -32000 is kept for a credential failure, which arrives as a failed turn (`turnToStop`), not as one of these.
 */
const SIDECAR_ERROR_CODES: Record<ErrorCode, AcpErrorCode> = {
  BAD_REQUEST: ACP_ERROR.INTERNAL_ERROR,
  BUSY: ACP_ERROR.INTERNAL_ERROR,
  NO_PENDING_APPROVAL: ACP_ERROR.INTERNAL_ERROR,
  NOT_FOUND: ACP_ERROR.INTERNAL_ERROR,
  INTERNAL: ACP_ERROR.INTERNAL_ERROR,
  NO_PROVIDER: ACP_ERROR.INTERNAL_ERROR,
  UNSUPPORTED_PROTOCOL: ACP_ERROR.INTERNAL_ERROR,
  EXPERIMENTAL_DISABLED: ACP_ERROR.INTERNAL_ERROR,
  // Socket transport only: the ACP adapter talks to its sidecar over stdio and never receives these.
  UNAUTHORIZED: ACP_ERROR.INTERNAL_ERROR,
  NOT_CONTROLLER: ACP_ERROR.INTERNAL_ERROR,
  NOT_PERMITTED: ACP_ERROR.INTERNAL_ERROR,
};

/** The JSON-RPC error for a sidecar `error` event; `data.reason` is the sidecar's code. */
export function sidecarErrorToRpc(event: Event<"error">): AcpError {
  const code = Object.hasOwn(SIDECAR_ERROR_CODES, event.code) ? SIDECAR_ERROR_CODES[event.code] : ACP_ERROR.INTERNAL_ERROR;
  return rpcError(code, bounded(event.message, ACP_MAX_ERROR_MESSAGE_CHARS), { reason: String(event.code) });
}

/** The answer to a request ended by `$/cancel_request` (published specification, schema: -32800). */
export function cancelledRequestError(id: AcpId): AcpErrorResponse {
  return errorResponse(id, rpcError(ACP_ERROR.REQUEST_CANCELLED, "the request was cancelled"));
}
