// Example messages of the ACP adapter, built with the real mapping functions from sample sidecar events. The mapping
// tests assert on them, and acp_schema.test.ts validates every one against the published schema.
import type { TurnResult } from "../../src/core/turn.js";
import type { ReceiptSection } from "../../src/evidence.js";
import type { SidecarEvent } from "../../src/protocol.js";
import { errorResponse, notification, request, resultResponse, rpcError } from "../../src/acp/jsonrpc.js";
import {
  approvalToPermissionRequest,
  assistantDeltaToUpdate,
  cancelledRequestError,
  fileDiffToUpdate,
  historyToReplay,
  initializeResult,
  loadSessionResult,
  newSessionResult,
  nexusReceipt,
  promptResult,
  sessionUpdate,
  sidecarErrorToRpc,
  toolEndToUpdate,
  toolStartToUpdate,
  turnToStop,
  verdictChunk,
  verificationFromTurn,
  verificationUpdate,
} from "../../src/acp/mapping.js";
import { ACP_ALLOW_ONCE_OPTION_ID, ACP_CANCEL_REQUEST_METHOD, ACP_ERROR, ACP_RECEIPT_GET_METHOD } from "../../src/acp/types.js";
import type { AcpAgentMessage, AcpClientMessage } from "../../src/acp/types.js";

type Event<T extends SidecarEvent["type"]> = Extract<SidecarEvent, { type: T }>;

export const SESSION = "session_20261122_101500_ab12cd34";
export const WORKSPACE = "/work/repo";

export function turn(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    execution: "COMPLETED",
    outcome: "UNVERIFIED",
    acceptance: "NOT_REQUESTED",
    reason: "VERIFICATION_NOT_RUN",
    modelStop: "FINAL_TEXT",
    finalOutputComplete: true,
    verification: null,
    interruption: null,
    inferenceFailure: null,
    steps: { used: 2, max: 30, limitReached: false },
    unverifiedChangesPending: true,
    finishedAt: "2026-11-22T10:15:30.000Z",
    ...overrides,
  };
}

export const VERIFIED_TURN = turn({
  outcome: "VERIFIED",
  reason: undefined,
  unverifiedChangesPending: false,
  verification: { status: "PASSED", command: "npm test", source: "discovered", exitSuccess: true, outputSha256: "a".repeat(64), candidateId: "b".repeat(64), at: "2026-11-22T10:15:29.000Z" } as TurnResult["verification"],
  turnEvidence: { workspaceChanged: "yes", carriedChanges: false, denied: 0, verifierRuns: [{ command: "npm test", phase: "before_change", passed: false }, { command: "npm test", phase: "completion", passed: true }] },
});

export const STATE: Event<"session.state"> = {
  type: "session.state", workspace: WORKSPACE, workspace_name: "repo", model: "m", mode: "review", git: null, busy: false, session: SESSION, read_only: false,
  posture: { mode: "review", sandbox: "bwrap", trusted: false },
};

export const TOOL_START: Event<"tool.start"> = { type: "tool.start", turn_id: "t1", call_id: "c1", tool: "write_file", subject: "src/a.ts", evidence: "e1" };
export const TOOL_END: Event<"tool.end"> = { type: "tool.end", turn_id: "t1", call_id: "c1", tool: "write_file", success: true, summary: "Wrote src/a.ts", lines: 1, evidence: "e1" };
export const COMMAND_END: Event<"tool.end"> = {
  type: "tool.end", turn_id: "t1", call_id: "c2", tool: "run_command", success: false, summary: "exit 1 · 2 lines", lines: 2, evidence: "e2", preview: "FAIL a.test.ts\n1 failed", exit_code: 1, duration_ms: 420, timed_out: false,
};

export const MODIFY_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " export { a, b };",
  "@@ -10,2 +10,3 @@",
  " // tail",
  "+// added",
  " // end",
  "",
].join("\n");

export const FILE_DIFF: Event<"file.diff"> = {
  type: "file.diff", turn_id: "t1", call_id: "c1", evidence: "e1", path: "src/a.ts", kind: "modified", added: 2, removed: 1, preview: MODIFY_DIFF, truncated: false, total_lines: 12, diff_lines: 7, hunks: 2,
};
export const TOOL_DETAIL: Event<"tool.detail"> = {
  type: "tool.detail", id: "d1", evidence: "e1", tool: "write_file", subject: "src/a.ts", status: "succeeded", args: "{}", output: "", duration_ms: 3, diff: MODIFY_DIFF, diff_chars: MODIFY_DIFF.length,
};

export const APPROVAL_CHANGE: Event<"approval.request"> = {
  type: "approval.request", id: "approval-1", turn_id: "t1", tool: "write_file", subject: "src/a.ts", preview: '{\n  "path": "src/a.ts"\n}',
  review: { kind: "change", path: "src/a.ts", before: "const b = 2;\n", after: "const b = 3;\n", created: false, truncated: false },
};
export const APPROVAL_CREATE: Event<"approval.request"> = {
  type: "approval.request", id: "approval-2", turn_id: "t1", tool: "write_file", subject: "src/new.ts", preview: "{}",
  review: { kind: "change", path: "src/new.ts", before: null, after: "export {};\n", created: true, truncated: false },
};
export const APPROVAL_COMMAND: Event<"approval.request"> = {
  type: "approval.request", id: "approval-3", turn_id: "t1", tool: "run_command", subject: "npm test", preview: '{\n  "command": "npm test"\n}', review: { kind: "command", command: "npm test" },
};
export const APPROVAL_PATCH: Event<"approval.request"> = {
  type: "approval.request", id: "approval-4", turn_id: "t1", tool: "patch_file", subject: "src/a.ts", preview: "{}", review: { kind: "patch", path: "src/a.ts", patch: "@@\n-a\n+b\n", truncated: true },
};
export const APPROVAL_VERIFIER: Event<"approval.request"> = {
  type: "approval.request", id: "approval-5", turn_id: "t1", tool: "verifier", subject: "npm test", preview: "{}", review: { kind: "verifier", command: "npm test", script: "jest", detail: "discovered from package.json" },
};
export const APPROVAL_ARGS: Event<"approval.request"> = {
  type: "approval.request", id: "approval-6", turn_id: "t1", tool: "fetch_web", subject: "https://example.test/", preview: "{}", review: { kind: "args", text: '{\n  "url": "https://example.test/"\n}', truncated: false },
};
export const APPROVALS = [APPROVAL_CHANGE, APPROVAL_CREATE, APPROVAL_COMMAND, APPROVAL_PATCH, APPROVAL_VERIFIER, APPROVAL_ARGS];

export const RECEIPT_SECTIONS: ReceiptSection[] = [
  { title: "Last turn", rows: [["result", "DONE"], ["execution", "COMPLETED"]] },
  { title: "Verifier", rows: [["status", "PASSED"]] },
  { title: "Validation receipt", rows: [["status", "PASSED"], ["receipt", "rcpt-0b8f6f0e-7c1d-4b43-9d55-0f6f4a0c2e11"], ["candidate", "b".repeat(64)]] },
];

export const HISTORY: Event<"history"> = {
  type: "history", session: SESSION, total: 9,
  messages: [
    { role: "user", text: "fix the test" },
    { role: "steering", text: "keep the API" },
    { role: "assistant", text: "I will edit src/a.ts." },
    { role: "tool", tool: "edit_file", text: "src/a.ts" },
    { role: "tool", tool: "delete_file", text: "src/old.ts" },
    { role: "outcome", heading: "DONE - UNVERIFIED", text: "execution=COMPLETED outcome=UNVERIFIED", turn: turn() },
  ],
};

const VERIFICATION = verificationFromTurn({ sessionId: SESSION, turnId: "t1", turn: VERIFIED_TURN, sections: RECEIPT_SECTIONS });
const UNVERIFIED = verificationFromTurn({ sessionId: SESSION, turnId: "t2", turn: turn() });
const failed = turnToStop(turn({ execution: "FAILED", outcome: "NOT_ESTABLISHED", reason: "INFERENCE_FAILED", detail: "the provider closed the stream" }));
const IGNORED = { count: 2, names: ["files", "github"] };

/** Every kind of message the mapping can build: what Nexus sends. */
export const AGENT_EXAMPLES: Array<{ name: string; message: AcpAgentMessage }> = [
  { name: "initialize result", message: resultResponse(1, initializeResult({ version: "1.3.0", sidecarProtocol: 1 })) },
  { name: "session/new result", message: resultResponse("new-1", newSessionResult(STATE, IGNORED)!) },
  { name: "session/new result without _meta", message: resultResponse(2, newSessionResult({ ...STATE, posture: undefined }, { count: 0, names: [] })!) },
  { name: "session/load result", message: resultResponse(3, loadSessionResult(STATE, { count: 0, names: [] }, historyToReplay(HISTORY).extent)) },
  { name: "session/load result, empty", message: resultResponse(3, {}) },
  { name: "session/prompt result", message: resultResponse(4, promptResult("end_turn", VERIFICATION)) },
  { name: "session/prompt result, limit", message: resultResponse(4, promptResult("max_turn_requests", UNVERIFIED)) },
  { name: "receipt", message: resultResponse(5, nexusReceipt(SESSION, VERIFICATION, RECEIPT_SECTIONS)) },
  { name: "agent_message_chunk", message: sessionUpdate(SESSION, assistantDeltaToUpdate({ type: "assistant.delta", turn_id: "t1", text: "Hello" })) },
  { name: "tool_call", message: sessionUpdate(SESSION, toolStartToUpdate(TOOL_START)) },
  { name: "tool_call_update with diff (detail)", message: sessionUpdate(SESSION, fileDiffToUpdate(FILE_DIFF, WORKSPACE, TOOL_DETAIL)) },
  { name: "tool_call_update with diff (preview)", message: sessionUpdate(SESSION, fileDiffToUpdate(FILE_DIFF, WORKSPACE)) },
  { name: "tool_call_update completed", message: sessionUpdate(SESSION, toolEndToUpdate(TOOL_END)) },
  { name: "tool_call_update failed command", message: sessionUpdate(SESSION, toolEndToUpdate(COMMAND_END)) },
  { name: "tool_call_update denied", message: sessionUpdate(SESSION, toolEndToUpdate({ ...TOOL_END, success: false, summary: "Denied by you", denied: true })) },
  { name: "verification carrier", message: sessionUpdate(SESSION, verificationUpdate(VERIFICATION)) },
  { name: "verdict chunk", message: sessionUpdate(SESSION, verdictChunk("DONE - VERIFIED", "execution=COMPLETED outcome=VERIFIED")) },
  ...historyToReplay(HISTORY).updates.map((update, i) => ({ name: `replay update ${i} (${update.sessionUpdate})`, message: sessionUpdate(SESSION, update) })),
  ...APPROVALS.map((approval, i) => ({
    name: `session/request_permission (${approval.review.kind}${approval === APPROVAL_CREATE ? ", new file" : ""})`,
    message: approvalToPermissionRequest(approval, { rpcId: 1_000_000 + i, sessionId: SESSION, toolCallId: i === 0 ? "e1" : approval.id, workspace: WORKSPACE }),
  })),
  { name: "error: failed turn", message: errorResponse(4, "error" in failed ? failed.error : rpcError(ACP_ERROR.INTERNAL_ERROR, "unreachable")) },
  { name: "error: sidecar", message: errorResponse(4, sidecarErrorToRpc({ type: "error", id: "t1", code: "BUSY", message: "A turn or command is running; cancel it or wait for its result." })) },
  { name: "error: invalid params", message: errorResponse("r-9", rpcError(ACP_ERROR.INVALID_PARAMS, "cwd must be an absolute path", { field: "cwd" })) },
  { name: "error: parse, null id", message: errorResponse(null, rpcError(ACP_ERROR.PARSE_ERROR, "the line is not valid JSON")) },
  { name: "error: sidecar start failed", message: errorResponse(2, rpcError(ACP_ERROR.INTERNAL_ERROR, "the session could not start", { reason: "sidecar_start_failed", exit_code: 2, message: "policy.toml: unknown table" })) },
  { name: "error: request cancelled", message: cancelledRequestError(4) },
];

/** One of each message a client may send that Nexus acts on. */
export const CLIENT_EXAMPLES: Array<{ name: string; message: AcpClientMessage }> = [
  { name: "initialize", message: request(0, "initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }, clientInfo: { name: "editor", title: "Editor", version: "0.1.0" } }) },
  { name: "session/new", message: request(1, "session/new", { cwd: WORKSPACE, mcpServers: [] }) },
  { name: "session/new with ignored servers", message: { jsonrpc: "2.0", id: "new-1", method: "session/new", params: { cwd: WORKSPACE, mcpServers: [{ name: "files", command: "mcp-files", args: [], env: [] }], additionalDirectories: [] } } },
  { name: "session/load", message: request(3, "session/load", { sessionId: SESSION, cwd: WORKSPACE, mcpServers: [] }) },
  { name: "session/prompt", message: request(4, "session/prompt", { sessionId: SESSION, prompt: [{ type: "text" as const, text: "fix the test in " }, { type: "resource_link" as const, uri: "file:///work/repo/src/a.ts", name: "a.ts" }] }) },
  { name: "receipt get", message: request(5, ACP_RECEIPT_GET_METHOD, { sessionId: SESSION, receiptId: `turn:${SESSION}:t2` }) },
  { name: "session/cancel", message: notification("session/cancel", { sessionId: SESSION }) },
  { name: "$/cancel_request", message: notification(ACP_CANCEL_REQUEST_METHOD, { requestId: 4 }) },
  { name: "permission: allow once", message: resultResponse(1_000_000, { outcome: { outcome: "selected" as const, optionId: ACP_ALLOW_ONCE_OPTION_ID } }) as AcpClientMessage },
  { name: "permission: cancelled", message: resultResponse(1_000_001, { outcome: { outcome: "cancelled" as const } }) as AcpClientMessage },
  { name: "permission: error", message: { jsonrpc: "2.0", id: 1_000_002, error: { code: -32603, message: "the dialog failed" } } },
];
