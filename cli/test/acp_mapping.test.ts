/**
 * AC-1: the translation between the sidecar protocol and ACP (cli/src/acp/mapping.ts): every row of the mapping
 * tables in the plan that is decided by a pure function, and the permission properties decidable at this level.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_TOOLS } from "../src/core/capabilities.js";
import type { ValidationReceipt } from "../src/core/candidate.js";
import { receiptSections } from "../src/evidence.js";
import type { SidecarEvent } from "../src/protocol.js";
import { RequestCorrelator } from "../src/acp/jsonrpc.js";
import {
  SIDECAR_EVENT_DISPOSITION,
  TOOL_KINDS,
  VALIDATION_RECEIPT_SECTION,
  approvalDigest,
  approvalToPermissionRequest,
  assistantDeltaToUpdate,
  bindApprovalToToolCall,
  cancelledRequestError,
  fileDiffToUpdate,
  historyToReplay,
  initializeResult,
  loadSessionResult,
  newSessionResult,
  nexusReceipt,
  permissionReplyToCommand,
  postureFromState,
  promptResult,
  sessionUpdate,
  sidecarErrorToRpc,
  toolCallId,
  toolEndToUpdate,
  toolKind,
  toolStartToUpdate,
  turnToStop,
  unifiedDiffToBlocks,
  validationReceiptFromSections,
  verdictChunk,
  verificationFromTurn,
  verificationUpdate,
  type ApprovalCommand,
} from "../src/acp/mapping.js";
import * as acpTypes from "../src/acp/types.js";
import {
  ACP_ALLOW_ONCE_OPTION_ID,
  ACP_ERROR,
  ACP_MAX_DIFF_BLOCKS,
  ACP_MAX_ERROR_MESSAGE_CHARS,
  ACP_MAX_TOOL_TEXT_CHARS,
  ACP_META_PREFIX,
  ACP_EXTENSION_METHOD_PREFIX,
  ACP_PERMISSION_OPTIONS,
  ACP_REJECT_ONCE_OPTION_ID,
} from "../src/acp/types.js";
import {
  AGENT_EXAMPLES,
  APPROVALS,
  APPROVAL_ARGS,
  APPROVAL_CHANGE,
  APPROVAL_COMMAND,
  APPROVAL_CREATE,
  APPROVAL_PATCH,
  APPROVAL_VERIFIER,
  COMMAND_END,
  FILE_DIFF,
  HISTORY,
  MODIFY_DIFF,
  RECEIPT_SECTIONS,
  SESSION,
  STATE,
  TOOL_DETAIL,
  TOOL_END,
  TOOL_START,
  VERIFIED_TURN,
  WORKSPACE,
  turn,
} from "./helpers/acp_examples.js";

const protocolSource = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "protocol.ts"), "utf8");

/**
 * Every sidecar event type has a decision here: mapped, consumed by the adapter, or deliberately dropped. A new event
 * type in protocol.ts fails this test (and the type check of mapping.ts) until it is classified.
 */
test("every SidecarEvent type is classified as mapped, consumed or dropped, and only those", () => {
  const union = protocolSource.slice(protocolSource.indexOf("export type SidecarEvent ="), protocolSource.indexOf("export type SidecarCommand"));
  const types = [...new Set([...union.matchAll(/type: "([a-z.]+)"/g)].map((m) => m[1]))].sort();
  assert.ok(types.length >= 20, `parsed ${types.length} event types`);
  assert.deepEqual(Object.keys(SIDECAR_EVENT_DISPOSITION).sort(), types);
  for (const [type, entry] of Object.entries(SIDECAR_EVENT_DISPOSITION)) {
    assert.ok(["mapped", "consumed", "dropped"].includes(entry.disposition), type);
    assert.ok(entry.why.trim().length > 10, `${type} says why`);
  }
  const mapped = Object.entries(SIDECAR_EVENT_DISPOSITION).filter(([, entry]) => entry.disposition === "mapped").map(([type]) => type).sort();
  assert.deepEqual(mapped, ["approval.request", "assistant.delta", "error", "file.diff", "history", "receipt", "session.state", "tool.detail", "tool.end", "tool.start", "turn.result"]);
});

test("the tool-kind table classifies every model tool of the capability catalogue, with kinds of the specification", () => {
  const names = HARNESS_TOOLS.map((tool) => tool.function.name);
  assert.ok(names.length >= 30, `the catalogue has ${names.length} tools`);
  for (const name of names) assert.ok(Object.hasOwn(TOOL_KINDS, name), `${name} has no ACP kind: add a row to TOOL_KINDS in cli/src/acp/mapping.ts`);
  assert.deepEqual(Object.keys(TOOL_KINDS).filter((name) => !names.includes(name)), ["verifier"], "no row for a tool that does not exist (verifier is the gate's own name)");
  const used = ["read", "edit", "delete", "search", "execute", "think", "fetch", "other"];
  for (const [name, kind] of Object.entries(TOOL_KINDS)) assert.ok(used.includes(kind), `${name}: ${kind}`);
  assert.equal(Object.values(TOOL_KINDS).some((kind) => (kind as string) === "switch_mode" || (kind as string) === "move"), false);
  assert.deepEqual(
    ["read_file", "write_file", "edit_file", "patch_file", "delete_file", "run_command", "run_tests", "search_code", "fetch_web", "spawn_subagent", "task_completed"].map(toolKind),
    ["read", "edit", "edit", "edit", "delete", "execute", "execute", "search", "fetch", "think", "other"],
  );
  // The side effects a client is told about are not understated: every mutating file tool is edit or delete, every command execute.
  for (const tool of ["mcp__files__write", "steering_conflict", "", "constructor", "__proto__", "toString", "hasOwnProperty", "READ_FILE"]) assert.equal(toolKind(tool), "other", tool);
});

test("assistant.delta becomes agent_message_chunk, with no messageId", () => {
  assert.deepEqual(assistantDeltaToUpdate({ type: "assistant.delta", turn_id: "t1", text: "Hel" }), { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
  assert.deepEqual(sessionUpdate(SESSION, assistantDeltaToUpdate({ type: "assistant.delta", turn_id: "t1", text: "" })), {
    jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } } },
  });
});

test("tool.start becomes a pending tool_call whose id is the evidence id", () => {
  assert.deepEqual(toolStartToUpdate(TOOL_START), { sessionUpdate: "tool_call", toolCallId: "e1", title: "write_file: src/a.ts", kind: "edit", status: "pending", rawInput: { tool: "write_file", subject: "src/a.ts" } });
  const unknown = toolStartToUpdate({ type: "tool.start", turn_id: "t1", call_id: "c9", tool: "mcp__x__y", subject: "", evidence: "e9" });
  assert.deepEqual([unknown.kind, unknown.title], ["other", "mcp__x__y"]);
  // Two calls with the same model call id stay two tool calls.
  assert.notEqual(toolCallId({ evidence: "e1", call_id: "same" }), toolCallId({ evidence: "e2", call_id: "same" }));
  assert.equal(toolCallId({ evidence: "", call_id: "c7" }), "call:c7");
  const hostile = toolStartToUpdate({ type: "tool.start", turn_id: "t1", call_id: "c1", tool: "run_command", subject: `echo a\necho b\u0000 ${"x".repeat(1000)}`, evidence: "e3" });
  assert.equal(/[\u0000-\u001f]/.test(hostile.title), false, "a title is one line");
  assert.ok(hostile.title.length <= 520);
});

test("tool.end: completed only for a call that ran and succeeded; refused by the gate, declined and failed are all failed", () => {
  assert.deepEqual(toolEndToUpdate(TOOL_END), { sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed", content: [{ type: "content", content: { type: "text", text: "Wrote src/a.ts" } }] });
  assert.deepEqual(toolEndToUpdate(COMMAND_END), {
    sessionUpdate: "tool_call_update", toolCallId: "e2", status: "failed",
    content: [{ type: "content", content: { type: "text", text: "exit 1 · 2 lines\nFAIL a.test.ts\n1 failed" } }],
    rawOutput: { exit_code: 1, duration_ms: 420, timed_out: false },
  });
  // A gate refusal: success false, no `denied` (that flag is only the operator's own decline).
  const gate = toolEndToUpdate({ type: "tool.end", turn_id: "t1", call_id: "c3", tool: "delete_file", success: false, summary: "Refused: read-only mode", lines: 1, evidence: "e3" });
  assert.equal(gate.status, "failed");
  assert.equal(gate.rawOutput, undefined);
  const declined = toolEndToUpdate({ type: "tool.end", turn_id: "t1", call_id: "c4", tool: "write_file", success: false, summary: "Denied by you", lines: 1, evidence: "e4", denied: true });
  assert.deepEqual([declined.status, declined.rawOutput], ["failed", { denied: true }]);
  // Never completed when declined, whatever else the event says.
  assert.equal(toolEndToUpdate({ ...TOOL_END, denied: true }).status, "failed");
  assert.equal(toolEndToUpdate({ ...TOOL_END, success: "yes" as unknown as boolean }).status, "failed", "only a true success completes");
  const timedOut = toolEndToUpdate({ ...COMMAND_END, exit_code: null, timed_out: true });
  assert.deepEqual(timedOut.rawOutput, { exit_code: null, duration_ms: 420, timed_out: true });
  // Text is bounded.
  const long = toolEndToUpdate({ ...COMMAND_END, preview: "o".repeat(ACP_MAX_TOOL_TEXT_CHARS * 2) });
  const text = long.content?.[0].type === "content" ? long.content[0].content.text : "";
  assert.ok(text.length <= ACP_MAX_TOOL_TEXT_CHARS + 40, `${text.length} chars`);
  assert.match(text, /…\[truncated \d+ chars\]$/);
  const exact = toolEndToUpdate({ ...TOOL_END, summary: "s".repeat(ACP_MAX_TOOL_TEXT_CHARS) });
  assert.equal(exact.content?.[0].type === "content" && exact.content[0].content.text.length, ACP_MAX_TOOL_TEXT_CHARS);
  assert.equal(toolEndToUpdate({ ...TOOL_END, summary: "" }).content, undefined);
});

test("a unified diff becomes one diff block per hunk: context and removed lines as oldText, context and added as newText", () => {
  const { blocks, truncated } = unifiedDiffToBlocks(MODIFY_DIFF, WORKSPACE);
  assert.equal(truncated, false);
  assert.deepEqual(blocks, [
    { type: "diff", path: "/work/repo/src/a.ts", oldText: "const a = 1;\nconst b = 2;\nexport { a, b };\n", newText: "const a = 1;\nconst b = 3;\nexport { a, b };\n" },
    { type: "diff", path: "/work/repo/src/a.ts", oldText: "// tail\n// end\n", newText: "// tail\n// added\n// end\n" },
  ]);
  // A new file: oldText is null. A deleted file: newText is empty.
  const created = unifiedDiffToBlocks("diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+export {};\n+// end\n", WORKSPACE);
  assert.deepEqual(created.blocks, [{ type: "diff", path: "/work/repo/new.ts", oldText: null, newText: "export {};\n// end\n" }]);
  const deleted = unifiedDiffToBlocks("--- a/old.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-gone\n-too\n", WORKSPACE);
  assert.deepEqual(deleted.blocks, [{ type: "diff", path: "/work/repo/old.ts", oldText: "gone\ntoo\n", newText: "" }]);
  // "\ No newline at end of file" applies to the side just read.
  const eol = unifiedDiffToBlocks("--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n", WORKSPACE);
  assert.deepEqual(eol.blocks, [{ type: "diff", path: "/work/repo/f", oldText: "old", newText: "new\n" }]);
  const eolBoth = unifiedDiffToBlocks("--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-a\n+b\n same\n\\ No newline at end of file\n", WORKSPACE);
  assert.deepEqual(eolBoth.blocks, [{ type: "diff", path: "/work/repo/f", oldText: "a\nsame", newText: "b\nsame" }]);
  // Removed "-- x" and added "++ x" lines look like headers and are content, because the hunk header counts them.
  const lookalike = unifiedDiffToBlocks("--- a/f.sql\n+++ b/f.sql\n@@ -1,2 +1,2 @@\n--- drop\n+++ keep\n x\n", WORKSPACE);
  assert.deepEqual(lookalike.blocks, [{ type: "diff", path: "/work/repo/f.sql", oldText: "-- drop\nx\n", newText: "++ keep\nx\n" }]);
  // Two files, a quoted path, and an absolute path that stays as it is.
  const two = unifiedDiffToBlocks('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+2\ndiff --git "a/sp ace" "b/sp ace"\n--- "a/sp ace"\n+++ "b/sp ace"\n@@ -1 +1 @@\n-3\n+4\n', WORKSPACE);
  assert.deepEqual(two.blocks.map((block) => block.path), ["/work/repo/x", "/work/repo/sp ace"]);
  assert.equal(unifiedDiffToBlocks("--- /abs/f\n+++ /abs/f\n@@ -1 +1 @@\n-1\n+2\n", WORKSPACE).blocks[0].path, "/abs/f");
  // A preview cut before its headers uses the event's path; with no path at all there is no block.
  assert.deepEqual(unifiedDiffToBlocks("@@ -1 +1 @@\n-1\n+2\n", WORKSPACE, "src/b.ts").blocks, [{ type: "diff", path: "/work/repo/src/b.ts", oldText: "1\n", newText: "2\n" }]);
  assert.deepEqual(unifiedDiffToBlocks("@@ -1 +1 @@\n-1\n+2\n", WORKSPACE).blocks, []);
  assert.deepEqual(unifiedDiffToBlocks("", WORKSPACE, "f").blocks, []);
  assert.deepEqual(unifiedDiffToBlocks("not a diff\nat all", WORKSPACE, "f").blocks, []);
  // A hunk cut short by the producer's cap: what is there is shown, and the cut is reported.
  const cut = unifiedDiffToBlocks("--- a/f\n+++ b/f\n@@ -1,50 +1,50 @@\n a\n-b\n+c…[truncated 900 chars]", WORKSPACE);
  assert.equal(cut.truncated, true);
  assert.equal(cut.blocks.length, 1);
  // At most ACP_MAX_DIFF_BLOCKS blocks: exactly at the limit is whole, one more is cut and says so.
  const hunks = (n: number) => `--- a/f\n+++ b/f\n${Array.from({ length: n }, (_, i) => `@@ -${i + 1} +${i + 1} @@\n-a${i}\n+b${i}\n`).join("")}`;
  const atLimit = unifiedDiffToBlocks(hunks(ACP_MAX_DIFF_BLOCKS), WORKSPACE);
  assert.deepEqual([atLimit.blocks.length, atLimit.truncated], [ACP_MAX_DIFF_BLOCKS, false]);
  const over = unifiedDiffToBlocks(hunks(ACP_MAX_DIFF_BLOCKS + 1), WORKSPACE);
  assert.deepEqual([over.blocks.length, over.truncated], [ACP_MAX_DIFF_BLOCKS, true]);
});

test("file.diff becomes a tool_call_update with diff blocks: the full diff from tool.detail, else the bounded preview", () => {
  const full = fileDiffToUpdate(FILE_DIFF, WORKSPACE, TOOL_DETAIL);
  assert.equal(full.toolCallId, "e1");
  assert.equal(full.status, "in_progress");
  assert.equal(full.content?.length, 2);
  assert.deepEqual(full._meta, { "nexus/diff": { kind: "modified", added: 2, removed: 1, truncated: false } });
  const preview = fileDiffToUpdate({ ...FILE_DIFF, truncated: true }, WORKSPACE);
  assert.equal(preview.content?.length, 2);
  assert.equal(preview._meta?.["nexus/diff"]?.truncated, true, "a cut preview says so");
  const cutDetail = fileDiffToUpdate(FILE_DIFF, WORKSPACE, { ...TOOL_DETAIL, diff_chars: MODIFY_DIFF.length + 10 });
  assert.equal(cutDetail._meta?.["nexus/diff"]?.truncated, true, "a detail diff shorter than the complete one says so");
  const none = fileDiffToUpdate({ ...FILE_DIFF, preview: "" }, WORKSPACE, { ...TOOL_DETAIL, diff: undefined });
  assert.equal(none.content, undefined);
  const added = fileDiffToUpdate({ ...FILE_DIFF, kind: "added", path: "new.ts", preview: "--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+x\n" }, WORKSPACE);
  assert.deepEqual(added.content, [{ type: "diff", path: "/work/repo/new.ts", oldText: null, newText: "x\n" }]);
});

test("approval.request becomes session/request_permission: title, kind, review content, digest, and exactly two options", () => {
  const build = (event: (typeof APPROVALS)[number]) => approvalToPermissionRequest(event, { rpcId: 4242, sessionId: SESSION, toolCallId: "e1", workspace: WORKSPACE });
  const change = build(APPROVAL_CHANGE);
  assert.deepEqual(change, {
    jsonrpc: "2.0", id: 4242, method: "session/request_permission",
    params: {
      sessionId: SESSION,
      toolCall: {
        toolCallId: "e1", title: "write_file: src/a.ts", kind: "edit", status: "pending",
        content: [{ type: "diff", path: "/work/repo/src/a.ts", oldText: "const b = 2;\n", newText: "const b = 3;\n" }],
        rawInput: { tool: "write_file", subject: "src/a.ts" },
        _meta: { "nexus/approval_digest": approvalDigest(APPROVAL_CHANGE) },
      },
      options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }, { optionId: "reject_once", name: "Reject", kind: "reject_once" }],
    },
  });
  // The options are the same two for every kind of review; allow_always and reject_always are never offered.
  for (const approval of APPROVALS) {
    const options = build(approval).params.options;
    assert.deepEqual(options.map((option) => [option.optionId, option.kind]), [[ACP_ALLOW_ONCE_OPTION_ID, "allow_once"], [ACP_REJECT_ONCE_OPTION_ID, "reject_once"]], approval.id);
    assert.match(build(approval).params.toolCall._meta["nexus/approval_digest"], /^[0-9a-f]{64}$/);
  }
  assert.deepEqual(ACP_PERMISSION_OPTIONS.map((option) => option.kind), ["allow_once", "reject_once"]);
  // A request cannot change the shared option list.
  build(APPROVAL_CHANGE).params.options[0].optionId = "tampered" as never;
  assert.equal(ACP_PERMISSION_OPTIONS[0].optionId, "allow_once");

  const text = (content: ReturnType<typeof build>["params"]["toolCall"]["content"]) => content.map((item) => (item.type === "content" ? item.content.text : `<diff ${item.path}>`));
  assert.deepEqual(build(APPROVAL_CREATE).params.toolCall.content, [{ type: "diff", path: "/work/repo/src/new.ts", oldText: null, newText: "export {};\n" }], "a new file has a null oldText");
  assert.deepEqual(text(build(APPROVAL_COMMAND).params.toolCall.content), ["npm test"]);
  assert.equal(build(APPROVAL_COMMAND).params.toolCall.kind, "execute");
  assert.deepEqual(text(build(APPROVAL_PATCH).params.toolCall.content), ["Patch for src/a.ts:\n@@\n-a\n+b\n", "This review text was cut to its size limit; the call's full arguments are larger."]);
  assert.deepEqual(text(build(APPROVAL_VERIFIER).params.toolCall.content), ["Verifier: npm test\n\njest\n\ndiscovered from package.json"]);
  assert.deepEqual(text(build(APPROVAL_ARGS).params.toolCall.content), ['{\n  "url": "https://example.test/"\n}']);
  assert.equal(build(APPROVAL_ARGS).params.toolCall.kind, "fetch");
  // An existing file whose content could not be shown is not presented as a new file without saying so.
  const hidden = build({ ...APPROVAL_CHANGE, review: { kind: "change", path: "big.bin", before: null, after: "x", created: false, truncated: true } });
  assert.deepEqual(text(hidden.params.toolCall.content), ["<diff /work/repo/big.bin>", "The file exists, and its current content is not shown (outside the workspace, not a regular file, or too large).", "This review text was cut to its size limit; the call's full arguments are larger."]);
  // A review kind this adapter does not know still shows the arguments.
  const unknown = build({ ...APPROVAL_CHANGE, preview: '{"x":1}', review: { kind: "future" } as never });
  assert.deepEqual(text(unknown.params.toolCall.content), ['{"x":1}']);
});

test("the approval digest covers tool, subject, preview and review, in a canonical order, and nothing else", () => {
  const digest = approvalDigest(APPROVAL_CHANGE);
  const canonical = '{"preview":"{\\n  \\"path\\": \\"src/a.ts\\"\\n}","review":{"after":"const b = 3;\\n","before":"const b = 2;\\n","created":false,"kind":"change","path":"src/a.ts","truncated":false},"subject":"src/a.ts","tool":"write_file"}';
  assert.equal(digest, crypto.createHash("sha256").update(canonical).digest("hex"));
  const reordered = { review: { truncated: false, created: false, after: "const b = 3;\n", before: "const b = 2;\n", path: "src/a.ts", kind: "change" as const }, preview: APPROVAL_CHANGE.preview, subject: "src/a.ts", tool: "write_file", turn_id: "t9", id: "approval-77", type: "approval.request" as const };
  assert.equal(approvalDigest(reordered), digest, "key order, the approval id and the turn id do not change it");
  for (const changed of [
    { ...APPROVAL_CHANGE, tool: "edit_file" },
    { ...APPROVAL_CHANGE, subject: "src/b.ts" },
    { ...APPROVAL_CHANGE, preview: "{}" },
    { ...APPROVAL_CHANGE, review: { ...APPROVAL_CHANGE.review, after: "const b = 4;\n" } },
    { ...APPROVAL_CHANGE, review: { ...APPROVAL_CHANGE.review, before: null } },
  ]) assert.notEqual(approvalDigest(changed as typeof APPROVAL_CHANGE), digest);
  assert.equal(new Set(APPROVALS.map(approvalDigest)).size, APPROVALS.length);
});

test("an approval is bound to the one open tool call with the same turn, tool and subject, else to its own id", () => {
  const other: Extract<SidecarEvent, { type: "tool.start" }> = { ...TOOL_START, call_id: "c2", evidence: "e2", subject: "src/b.ts" };
  assert.equal(bindApprovalToToolCall(APPROVAL_CHANGE, [other, TOOL_START]), "e1");
  assert.equal(bindApprovalToToolCall(APPROVAL_CHANGE, []), "approval-1", "none open: synthetic");
  assert.equal(bindApprovalToToolCall(APPROVAL_CHANGE, [other]), "approval-1");
  assert.equal(bindApprovalToToolCall(APPROVAL_CHANGE, [TOOL_START, { ...TOOL_START, evidence: "e5" }]), "approval-1", "two candidates: not guessed");
  assert.equal(bindApprovalToToolCall(APPROVAL_CHANGE, [{ ...TOOL_START, turn_id: "t0" }]), "approval-1", "another turn's call");
});

/** Every reply shape a client could send, with whether it approves. Exactly one row does. */
const REPLIES: Array<[string, { result: unknown } | { error: unknown }, boolean]> = [
  ["selected allow_once", { result: { outcome: { outcome: "selected", optionId: "allow_once" } } }, true],
  ["selected allow_once with _meta", { result: { outcome: { outcome: "selected", optionId: "allow_once", _meta: { always: true } }, _meta: { always: true } } }, true],
  ["selected reject_once", { result: { outcome: { outcome: "selected", optionId: "reject_once" } } }, false],
  ["cancelled", { result: { outcome: { outcome: "cancelled" } } }, false],
  ["cancelled carrying the allow id", { result: { outcome: { outcome: "cancelled", optionId: "allow_once" } } }, false],
  ["allow_always", { result: { outcome: { outcome: "selected", optionId: "allow_always" } } }, false],
  ["reject_always", { result: { outcome: { outcome: "selected", optionId: "reject_always" } } }, false],
  ["the kind as an option id of another agent", { result: { outcome: { outcome: "selected", optionId: "once" } } }, false],
  ["always", { result: { outcome: { outcome: "selected", optionId: "always" } } }, false],
  ["allow", { result: { outcome: { outcome: "selected", optionId: "allow" } } }, false],
  ["upper case", { result: { outcome: { outcome: "selected", optionId: "ALLOW_ONCE" } } }, false],
  ["trailing space", { result: { outcome: { outcome: "selected", optionId: "allow_once " } } }, false],
  ["leading NUL", { result: { outcome: { outcome: "selected", optionId: "\u0000allow_once" } } }, false],
  ["empty option id", { result: { outcome: { outcome: "selected", optionId: "" } } }, false],
  ["missing option id", { result: { outcome: { outcome: "selected" } } }, false],
  ["null option id", { result: { outcome: { outcome: "selected", optionId: null } } }, false],
  ["numeric option id", { result: { outcome: { outcome: "selected", optionId: 0 } } }, false],
  ["array option id", { result: { outcome: { outcome: "selected", optionId: ["allow_once"] } } }, false],
  ["object option id", { result: { outcome: { outcome: "selected", optionId: { toString: "allow_once" } } } }, false],
  ["boolean option id", { result: { outcome: { outcome: "selected", optionId: true } } }, false],
  ["outcome approved", { result: { outcome: { outcome: "approved", optionId: "allow_once" } } }, false],
  ["outcome allow_once", { result: { outcome: { outcome: "allow_once" } } }, false],
  ["outcome as a string", { result: { outcome: "selected" } }, false],
  ["outcome as the option id", { result: { outcome: "allow_once" } }, false],
  ["flat result", { result: { outcome: "selected", optionId: "allow_once" } }, false],
  ["option id beside the outcome", { result: { optionId: "allow_once", outcome: { outcome: "cancelled" } } }, false],
  ["always flag", { result: { always: true, approve: true, approved: true } }, false],
  ["approve command as the result", { result: { type: "approve", id: "approval-1", always: true } }, false],
  ["true", { result: true }, false],
  ["the option id as the result", { result: "allow_once" }, false],
  ["a number", { result: 1 }, false],
  ["null", { result: null }, false],
  ["undefined", { result: undefined }, false],
  ["an empty object", { result: {} }, false],
  ["an array", { result: [{ outcome: { outcome: "selected", optionId: "allow_once" } }] }, false],
  ["outcome array", { result: { outcome: [{ outcome: "selected", optionId: "allow_once" }] } }, false],
  ["a JSON-RPC error", { error: { code: -32603, message: "dialog failed" } }, false],
  ["an error that names the allow option", { error: { code: 0, message: "allow_once", data: { outcome: { outcome: "selected", optionId: "allow_once" } } } }, false],
  ["both result and error", { result: { outcome: { outcome: "selected", optionId: "allow_once" } }, error: { code: 1, message: "x" } } as { result: unknown }, false],
  ["neither", {} as { result: unknown }, false],
  ["inherited result", Object.create({ result: { outcome: { outcome: "selected", optionId: "allow_once" } } }), false],
  ["inherited outcome", { result: Object.create({ outcome: { outcome: "selected", optionId: "allow_once" } }) }, false],
  ["inherited option id", { result: { outcome: Object.assign(Object.create({ optionId: "allow_once" }), { outcome: "selected" }) } }, false],
];

test("a permission reply approves only for selected + the offered allow-once id; approve never carries always: true", () => {
  const commands: ApprovalCommand[] = [];
  for (const [name, reply, approves] of REPLIES) {
    const command = permissionReplyToCommand("approval-7", reply);
    commands.push(command);
    assert.deepEqual(command, approves ? { type: "approve", id: "approval-7", always: false } : { type: "deny", id: "approval-7" }, name);
  }
  assert.equal(REPLIES.filter(([, , approves]) => approves).length, 2);
  // Over the whole table, and over every string a client is likely to try as an option id: no `always: true`, no third verb.
  const guesses = ["allow_always", "always", "allow-always", "allowAlways", "allow_once_always", "allow", "yes", "true", "1", "approve", "once", "reject_once", "reject_always", "*", "allow_once\n", " allow_once", "allow_once\u0000", "ａllow_once"];
  for (const optionId of guesses) {
    const command = permissionReplyToCommand("approval-7", { result: { outcome: { outcome: "selected", optionId } } });
    commands.push(command);
    assert.deepEqual(command, { type: "deny", id: "approval-7" }, `option id ${JSON.stringify(optionId)} was not offered as an approval`);
  }
  for (const command of commands) {
    assert.ok(command.type === "approve" || command.type === "deny");
    assert.notEqual((command as { always?: unknown }).always, true);
    assert.deepEqual(Object.keys(command).sort(), command.type === "approve" ? ["always", "id", "type"] : ["id", "type"]);
    assert.equal(command.id, "approval-7", "the command answers the approval it was built for, not an id from the reply");
  }
  // An approval is offered under exactly one id, and only that id's kind is allow_once.
  assert.deepEqual(ACP_PERMISSION_OPTIONS.filter((option) => option.kind === "allow_once").map((option) => option.optionId), [ACP_ALLOW_ONCE_OPTION_ID]);
});

test("a reply to a stale or unknown request id produces no sidecar command; a matched one produces exactly one", () => {
  const sent: ApprovalCommand[] = [];
  const correlator = new RequestCorrelator<{ approvalId: string }>({ start: 5000 });
  const allow = { result: { outcome: { outcome: "selected", optionId: "allow_once" } } };
  /** What the adapter does with a reply: only a matched one reaches the mapping. */
  const receive = (id: unknown, reply: { result: unknown } | { error: unknown }) => {
    const settled = correlator.settle(id);
    if (settled.state === "matched") sent.push(permissionReplyToCommand(settled.context.approvalId, reply));
    return settled.state;
  };
  // Unsolicited approvals before any request exists: guessed ids, and the id the next request will get.
  for (const guess of [5000, 5001, 1, 0, -1, "5000", null, 4999]) assert.equal(receive(guess, allow), "unknown", String(guess));
  assert.deepEqual(sent, []);
  const rpcId = correlator.open({ approvalId: "approval-1" });
  assert.equal(rpcId, 5000);
  assert.equal(receive(rpcId + 1, allow), "unknown", "the wrong id");
  assert.equal(receive(String(rpcId), allow), "unknown", "the right digits as a string");
  assert.deepEqual(sent, []);
  assert.equal(receive(rpcId, allow), "matched");
  assert.deepEqual(sent, [{ type: "approve", id: "approval-1", always: false }]);
  // A replayed reply, and a reply after the request was abandoned (cancel, timeout, turn end), change nothing.
  assert.equal(receive(rpcId, allow), "stale");
  const second = correlator.open({ approvalId: "approval-2" });
  correlator.abandon(second);
  assert.equal(receive(second, allow), "stale");
  assert.equal(receive(rpcId, { result: { outcome: { outcome: "selected", optionId: "reject_once" } } }), "stale");
  assert.equal(sent.length, 1, "exactly one command, for the one matched reply");
});

test("stop reasons: the table of the plan, with max_turn_requests for a limit and an error for a failed turn", () => {
  assert.deepEqual(turnToStop(turn({ execution: "INTERRUPTED", outcome: "NOT_ESTABLISHED", reason: "OPERATOR_INTERRUPT" })), { stopReason: "cancelled" });
  assert.deepEqual(turnToStop(turn({ execution: "LIMIT_REACHED", outcome: "NOT_ESTABLISHED", reason: "STEP_LIMIT_REACHED" })), { stopReason: "max_turn_requests" });
  assert.deepEqual(turnToStop(turn({ execution: "COMPLETED" })), { stopReason: "end_turn" });
  assert.deepEqual(turnToStop(VERIFIED_TURN), { stopReason: "end_turn" });
  assert.deepEqual(turnToStop(turn({ execution: "BLOCKED", outcome: "NOT_ESTABLISHED", reason: "NEEDS_INPUT" })), { stopReason: "end_turn" });
  const failure = (overrides: object) => ({ kind: "http_error", origin: "provider", message: "upstream said no", ...overrides }) as NonNullable<ReturnType<typeof turn>["inferenceFailure"]>;
  assert.deepEqual(turnToStop(turn({ execution: "FAILED", outcome: "NOT_ESTABLISHED", reason: "INFERENCE_FAILED", inferenceFailure: failure({ kind: "output_truncated" }) })), { stopReason: "max_tokens" });
  assert.deepEqual(turnToStop(turn({ execution: "FAILED", outcome: "NOT_ESTABLISHED", reason: "INFERENCE_FAILED", detail: "the stream closed", inferenceFailure: failure({}) })), {
    error: { code: -32603, message: "the stream closed", data: { reason: "INFERENCE_FAILED" } },
  });
  assert.deepEqual(turnToStop(turn({ execution: "FAILED", outcome: "NOT_ESTABLISHED", reason: undefined, inferenceFailure: null })), { error: { code: -32603, message: "the turn failed", data: { reason: "FAILED" } } });
  // -32000 only for a credential failure.
  for (const credentials of [failure({ condition: "AUTH_FAILURE" }), failure({ httpStatus: 401 }), failure({ httpStatus: 403 })]) {
    const stop = turnToStop(turn({ execution: "FAILED", outcome: "NOT_ESTABLISHED", reason: "INFERENCE_FAILED", inferenceFailure: credentials }));
    assert.deepEqual("error" in stop && [stop.error.code, stop.error.message], [-32000, "upstream said no"]);
  }
  for (const other of [failure({ httpStatus: 500 }), failure({ httpStatus: 429, condition: "RATE_LIMITED" }), failure({ kind: "timeout" })]) {
    const stop = turnToStop(turn({ execution: "FAILED", outcome: "NOT_ESTABLISHED", reason: "INFERENCE_FAILED", inferenceFailure: other }));
    assert.equal("error" in stop && stop.error.code, -32603);
  }
  const long = turnToStop(turn({ execution: "FAILED", outcome: "NOT_ESTABLISHED", detail: "d".repeat(ACP_MAX_ERROR_MESSAGE_CHARS * 3) }));
  assert.ok("error" in long && long.error.message.length <= ACP_MAX_ERROR_MESSAGE_CHARS + 40);
  // `refusal` is never produced, and a state this adapter does not know is an error, not a clean end.
  const unknown = turnToStop(turn({ execution: "PAUSED" as never }));
  assert.equal("error" in unknown && unknown.error.code, -32603);
  const states = protocolTurnStates();
  for (const execution of states) {
    const stop = turnToStop(turn({ execution: execution as never }));
    if ("stopReason" in stop) assert.ok(["end_turn", "cancelled", "max_tokens", "max_turn_requests"].includes(stop.stopReason), execution);
  }
  assert.deepEqual(states, ["BLOCKED", "COMPLETED", "FAILED", "INTERRUPTED", "LIMIT_REACHED"], "a new execution state needs a row in turnToStop");
});

function protocolTurnStates(): string[] {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "core", "turn.ts"), "utf8");
  const declared = /export type ExecutionState = ([^;]+);/.exec(source)?.[1] ?? "";
  return [...declared.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]).sort();
}

test("the validation receipt id is read from the rows the real receipt builder writes", () => {
  const receipt: ValidationReceipt = {
    receiptId: `rcpt-${crypto.randomUUID()}`, candidateId: crypto.createHash("sha256").update("candidate").digest("hex"), verifierCommand: "npm test", exitCode: 0,
    stdoutHash: crypto.createHash("sha256").update("out").digest("hex"), timestamp: "2026-11-22T10:15:29.000Z", status: "PASSED", materialDependencies: [],
  };
  const sections = receiptSections({ heading: "DONE - VERIFIED", turn: VERIFIED_TURN }, receipt);
  assert.ok(sections.some((section) => section.title === VALIDATION_RECEIPT_SECTION), "the section title the reader looks for is the one the builder writes");
  assert.deepEqual(validationReceiptFromSections(sections), { id: receipt.receiptId, status: "PASSED", candidate: receipt.candidateId });
  assert.deepEqual(validationReceiptFromSections(receiptSections({ heading: "DONE", turn: VERIFIED_TURN }, { ...receipt, status: "INVALIDATED", invalidationReason: "workspace changed" })), { id: receipt.receiptId, status: "INVALIDATED", candidate: receipt.candidateId });
  // No active receipt (no --authoritative-verifier), no turn yet, or no such section: null.
  assert.equal(validationReceiptFromSections(receiptSections({ heading: "DONE", turn: VERIFIED_TURN }, null)), null);
  assert.equal(validationReceiptFromSections(receiptSections(null, null)), null);
  assert.equal(validationReceiptFromSections([]), null);
  // A row of another section with the same label is not the receipt.
  assert.equal(validationReceiptFromSections([{ title: "Last turn", rows: [["receipt", "rcpt-x"]] }]), null);
  // A receipt read back from a damaged state file may lack fields.
  assert.deepEqual(validationReceiptFromSections(receiptSections(null, { receiptId: "rcpt-1" } as ValidationReceipt)), { id: "rcpt-1", status: "", candidate: null });
});

test("the verification object: outcome, verifier, runs and receipt of a turn; the receipt id falls back to the turn", () => {
  const verified = verificationFromTurn({ sessionId: SESSION, turnId: "t1", turn: VERIFIED_TURN, sections: RECEIPT_SECTIONS });
  assert.deepEqual(verified, {
    receipt_id: "rcpt-0b8f6f0e-7c1d-4b43-9d55-0f6f4a0c2e11",
    turn_id: "t1",
    execution: "COMPLETED",
    outcome: "VERIFIED",
    unverified_changes_pending: false,
    verifier: { status: "PASSED", command: "npm test", source: "discovered", exit_success: true, output_sha256: "a".repeat(64), candidate: "b".repeat(64) },
    verifier_runs: [{ command: "npm test", phase: "before_change", passed: false }, { command: "npm test", phase: "completion", passed: true }],
    validation_receipt: { id: "rcpt-0b8f6f0e-7c1d-4b43-9d55-0f6f4a0c2e11", status: "PASSED", candidate: "b".repeat(64) },
  });
  const unverified = verificationFromTurn({ sessionId: SESSION, turnId: "t2", turn: turn() });
  assert.deepEqual(unverified, {
    receipt_id: `turn:${SESSION}:t2`, turn_id: "t2", execution: "COMPLETED", outcome: "UNVERIFIED", reason: "VERIFICATION_NOT_RUN", unverified_changes_pending: true, verifier: null, verifier_runs: [], validation_receipt: null,
  });
  // An end_turn stop reason never hides the outcome: the same object rides the update, the result and the receipt.
  assert.deepEqual(verificationUpdate(unverified), { sessionUpdate: "session_info_update", _meta: { "nexus/verification": unverified } });
  assert.deepEqual(promptResult("end_turn", unverified), { stopReason: "end_turn", _meta: { "nexus/verification": unverified } });
  assert.deepEqual(nexusReceipt(SESSION, verified, RECEIPT_SECTIONS), { receipt_id: verified.receipt_id, session_id: SESSION, turn_id: "t1", verification: verified, sections: RECEIPT_SECTIONS });
  assert.deepEqual(verdictChunk("DONE - UNVERIFIED", "execution=COMPLETED outcome=UNVERIFIED"), { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\nDONE - UNVERIFIED\nexecution=COMPLETED outcome=UNVERIFIED\n" } });
  // A failed verifier and a turn with no evidence record.
  const failed = verificationFromTurn({ sessionId: SESSION, turnId: "t3", turn: turn({ outcome: "NOT_ESTABLISHED", reason: "VERIFIER_FAILED", verification: { status: "FAILED", command: "npm test", exitSuccess: false, at: "x" } as never }), sections: [] });
  assert.deepEqual(failed.verifier, { status: "FAILED", command: "npm test", exit_success: false });
  assert.equal(failed.receipt_id, `turn:${SESSION}:t3`);
});

test("history becomes replay updates in order, and reports how much of the conversation was sent", () => {
  const { updates, extent } = historyToReplay(HISTORY);
  assert.deepEqual(updates.map((update) => update.sessionUpdate), ["user_message_chunk", "user_message_chunk", "agent_message_chunk", "tool_call", "tool_call", "session_info_update", "agent_message_chunk"]);
  assert.deepEqual(updates[0], { sessionUpdate: "user_message_chunk", content: { type: "text", text: "fix the test" } });
  assert.deepEqual(updates[3], { sessionUpdate: "tool_call", toolCallId: "hist-1", title: "edit_file: src/a.ts", kind: "edit", status: "completed", rawInput: { tool: "edit_file", subject: "src/a.ts" } });
  assert.deepEqual([(updates[4] as { toolCallId: string }).toolCallId, (updates[4] as { kind: string }).kind], ["hist-2", "delete"]);
  const carrier = updates[5] as ReturnType<typeof verificationUpdate>;
  assert.deepEqual([carrier._meta["nexus/verification"].outcome, carrier._meta["nexus/verification"].turn_id, carrier._meta["nexus/verification"].receipt_id], ["UNVERIFIED", null, `turn:${SESSION}:last`]);
  assert.match((updates[6] as ReturnType<typeof verdictChunk>).content.text, /DONE - UNVERIFIED\nexecution=COMPLETED outcome=UNVERIFIED/);
  // `total` counts conversation entries (prompts, steering, replies); so does `sent` within this page.
  assert.deepEqual(extent, { sent: 3, total: 9 });
  assert.deepEqual(historyToReplay({ type: "history", session: SESSION, total: 0, messages: [] }), { updates: [], extent: { sent: 0, total: 0 } });
  assert.deepEqual(historyToReplay({ type: "history", session: SESSION, total: 1, messages: [{ role: "user", text: "a" }, { role: "assistant", text: "b" }] }).extent, { sent: 2, total: 2 }, "never fewer in total than sent");
  assert.deepEqual(historyToReplay({ type: "history", session: SESSION, total: 0, messages: [{ role: "tool", text: "x" }] }).updates[0], { sessionUpdate: "tool_call", toolCallId: "hist-1", title: "tool: x", kind: "other", status: "completed", rawInput: { tool: "tool", subject: "x" } });
});

test("history tool results update the matching replayed tool call", () => {
  const { updates, extent } = historyToReplay({
    type: "history", session: SESSION, total: 2,
    messages: [
      { role: "user", text: "inspect" },
      { role: "tool", tool: "read_file", toolCallId: "hist-7", status: "pending", text: "src/a.ts" },
      { role: "tool_result", toolCallId: "hist-7", status: "completed", text: "export const answer = 42;" },
      { role: "assistant", text: "The answer is 42." },
    ],
  });
  assert.deepEqual(updates.filter((update) => update.sessionUpdate === "tool_call").map((update: any) => [update.toolCallId, update.status]), [["hist-7", "pending"]]);
  assert.deepEqual(updates.find((update) => update.sessionUpdate === "tool_call_update"), {
    sessionUpdate: "tool_call_update", toolCallId: "hist-7", status: "completed",
    content: [{ type: "content", content: { type: "text", text: "export const answer = 42;" } }],
  });
  assert.deepEqual(extent, { sent: 2, total: 2 });
});

test("sidecar error codes become JSON-RPC -32603 with the code as data.reason; every code has a row", () => {
  const codes = [.../export type ErrorCode = ([^;]+);/.exec(protocolSource)![1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
  assert.ok(codes.length >= 8);
  const mapping = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "acp", "mapping.ts"), "utf8");
  const table = mapping.slice(mapping.indexOf("const SIDECAR_ERROR_CODES"), mapping.indexOf("export function sidecarErrorToRpc"));
  for (const code of codes) {
    assert.match(table, new RegExp(`\\b${code}: ACP_ERROR\\.`), `${code} has a row`);
    assert.deepEqual(sidecarErrorToRpc({ type: "error", code: code as never, message: "m" }), { code: -32603, message: "m", data: { reason: code } }, code);
  }
  assert.deepEqual(sidecarErrorToRpc({ type: "error", code: "FUTURE" as never, message: "m" }), { code: -32603, message: "m", data: { reason: "FUTURE" } });
  assert.deepEqual(sidecarErrorToRpc({ type: "error", code: "constructor" as never, message: "m" }).code, -32603);
  assert.ok(sidecarErrorToRpc({ type: "error", code: "INTERNAL", message: "m".repeat(ACP_MAX_ERROR_MESSAGE_CHARS * 2) }).message.length <= ACP_MAX_ERROR_MESSAGE_CHARS + 40);
  assert.deepEqual(cancelledRequestError(4), { jsonrpc: "2.0", id: 4, error: { code: -32800, message: "the request was cancelled" } });
  assert.deepEqual(ACP_ERROR, { PARSE_ERROR: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL_ERROR: -32603, AUTH_REQUIRED: -32000, REQUEST_CANCELLED: -32800 });
});

test("initialize: protocol version 1, all three prompt capabilities false, no MCP transport, no auth method, no session capabilities", () => {
  assert.deepEqual(initializeResult({ version: "1.3.0", sidecarProtocol: 1 }), {
    protocolVersion: 1,
    agentInfo: { name: "nexus", title: "Nexus Code", version: "1.3.0" },
    authMethods: [],
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false },
      _meta: { "nexus/experimental": true, "nexus/extensions": ["_nexus/receipt/get"], "nexus/sidecar_protocol": 1 },
    },
  });
});

test("session results: the posture the operator's machine set, ignored MCP servers and the replay extent, all under _meta", () => {
  assert.deepEqual(postureFromState(STATE), { mode: "review", sandbox: "bwrap", trusted: false, read_only: false });
  assert.deepEqual(postureFromState({ ...STATE, read_only: true }), { mode: "review", sandbox: "bwrap", trusted: false, read_only: true });
  assert.equal(postureFromState({ ...STATE, mode: "read-only", posture: { mode: "read-only", sandbox: "none", trusted: true } })?.read_only, true);
  assert.equal(postureFromState({ ...STATE, posture: undefined }), undefined);
  assert.deepEqual(newSessionResult(STATE, { count: 0, names: [] }), { sessionId: SESSION, _meta: { "nexus/posture": { mode: "review", sandbox: "bwrap", trusted: false, read_only: false } } });
  assert.deepEqual(newSessionResult(STATE, { count: 2, names: ["files", "github"] })?._meta?.["nexus/mcp_servers_ignored"], { count: 2, names: ["files", "github"] });
  assert.deepEqual(newSessionResult({ ...STATE, posture: undefined }, { count: 0, names: [] }), { sessionId: SESSION });
  assert.equal(newSessionResult({ ...STATE, session: undefined }, { count: 0, names: [] }), undefined, "no session id, no result");
  assert.deepEqual(loadSessionResult(STATE, { count: 0, names: [] }, { sent: 3, total: 9 }), { _meta: { "nexus/posture": { mode: "review", sandbox: "bwrap", trusted: false, read_only: false }, "nexus/history": { sent: 3, total: 9 } } });
});

test("extension names: one prefix for methods, one for _meta keys, and the trace-context keys are never used", () => {
  const constants = Object.entries(acpTypes).filter(([name, value]) => typeof value === "string" && (name.startsWith("ACP_META_") || name.endsWith("_METHOD"))) as Array<[string, string]>;
  const metaKeys = constants.filter(([name]) => name.startsWith("ACP_META_") && name !== "ACP_META_PREFIX").map(([, value]) => value);
  assert.equal(metaKeys.length, 9);
  for (const key of metaKeys) assert.ok(key.startsWith(ACP_META_PREFIX) && key.length > ACP_META_PREFIX.length, key);
  assert.equal(acpTypes.ACP_RECEIPT_GET_METHOD.startsWith(ACP_EXTENSION_METHOD_PREFIX), true);
  assert.equal(ACP_EXTENSION_METHOD_PREFIX.startsWith("_"), true, "the specification reserves method names that start with an underscore for extensions");
  assert.equal(acpTypes.ACP_CANCEL_REQUEST_METHOD, "$/cancel_request");
  // The names are written once: no other module of the adapter spells a `nexus/` key or an extension method.
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "acp");
  for (const file of ["jsonrpc.ts", "mapping.ts", "validate.ts"]) {
    const code = fs.readFileSync(path.join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/["'`]_?nexus\//.test(code), false, `${file} spells an extension name instead of using the constant in types.ts`);
  }
});

/** The members the specification defines at the root of each of its types that Nexus sends. `_meta` is where Nexus's own data goes. */
const SPEC_ROOTS: Record<string, readonly string[]> = {
  request: ["jsonrpc", "id", "method", "params"],
  notification: ["jsonrpc", "method", "params"],
  response: ["jsonrpc", "id", "result"],
  errorResponse: ["jsonrpc", "id", "error"],
  error: ["code", "message", "data"],
  initializeResult: ["protocolVersion", "agentCapabilities", "agentInfo", "authMethods", "_meta"],
  agentCapabilities: ["loadSession", "promptCapabilities", "mcpCapabilities", "sessionCapabilities", "_meta"],
  promptCapabilities: ["image", "audio", "embeddedContext", "_meta"],
  mcpCapabilities: ["http", "sse", "_meta"],
  implementation: ["name", "title", "version", "_meta"],
  newSessionResult: ["sessionId", "configOptions", "modes", "_meta"],
  loadSessionResult: ["configOptions", "modes", "_meta"],
  promptResult: ["stopReason", "usage", "_meta"],
  sessionNotification: ["sessionId", "update", "_meta"],
  agent_message_chunk: ["sessionUpdate", "content", "messageId", "_meta"],
  user_message_chunk: ["sessionUpdate", "content", "messageId", "_meta"],
  tool_call: ["sessionUpdate", "toolCallId", "title", "kind", "status", "content", "locations", "rawInput", "rawOutput", "_meta"],
  tool_call_update: ["sessionUpdate", "toolCallId", "title", "kind", "status", "content", "locations", "rawInput", "rawOutput", "_meta"],
  session_info_update: ["sessionUpdate", "title", "updatedAt", "_meta"],
  textContent: ["type", "text", "annotations", "_meta"],
  toolContent: ["type", "content", "_meta"],
  toolDiff: ["type", "path", "oldText", "newText", "_meta"],
  permissionParams: ["sessionId", "toolCall", "options", "_meta"],
  permissionToolCall: ["toolCallId", "title", "kind", "status", "content", "locations", "rawInput", "rawOutput", "_meta"],
  permissionOption: ["optionId", "name", "kind", "_meta"],
};

test("no custom field at the root of a type of the specification: every outbound message keeps Nexus's data under _meta", () => {
  const visited = new Set<string>();
  const check = (value: any, type: string, where: string) => {
    visited.add(type);
    assert.ok(value && typeof value === "object" && !Array.isArray(value), `${where}: ${type} is an object`);
    for (const key of Object.keys(value)) assert.ok(SPEC_ROOTS[type].includes(key), `${where}: ${key} is not a member of ${type} in the specification; put it under _meta`);
    if (type !== "error" && "_meta" in value) {
      for (const key of Object.keys(value._meta)) {
        assert.ok(key.startsWith(ACP_META_PREFIX), `${where}: _meta key ${key} lacks the prefix`);
        assert.equal(["traceparent", "tracestate", "baggage"].includes(key), false);
      }
    }
    assert.equal(type === "error" && "_meta" in value, false, `${where}: _meta is not allowed on a JSON-RPC error`);
  };
  const toolContent = (items: any[], where: string) => {
    for (const [i, item] of items.entries()) {
      if (item.type === "diff") {
        check(item, "toolDiff", `${where}[${i}]`);
        assert.ok(path.isAbsolute(item.path), `${where}[${i}]: a diff path is absolute`);
        assert.ok(item.oldText === null || typeof item.oldText === "string");
      } else {
        assert.equal(item.type, "content");
        check(item, "toolContent", `${where}[${i}]`);
        check(item.content, "textContent", `${where}[${i}].content`);
      }
    }
  };
  for (const { name, message } of AGENT_EXAMPLES) {
    const m = message as any;
    if ("error" in m) {
      check(m, "errorResponse", name);
      check(m.error, "error", `${name}.error`);
    } else if ("result" in m) {
      check(m, "response", name);
      const result = m.result;
      // The receipt is the result of Nexus's own extension method: its type is Nexus's, not the specification's.
      if ("receipt_id" in result) continue;
      if ("protocolVersion" in result) {
        check(result, "initializeResult", name);
        check(result.agentCapabilities, "agentCapabilities", name);
        check(result.agentCapabilities.promptCapabilities, "promptCapabilities", name);
        check(result.agentCapabilities.mcpCapabilities, "mcpCapabilities", name);
        check(result.agentInfo, "implementation", name);
      } else if ("sessionId" in result) check(result, "newSessionResult", name);
      else if ("stopReason" in result) check(result, "promptResult", name);
      else check(result, "loadSessionResult", name);
    } else if (m.method === "session/update") {
      check(m, "notification", name);
      check(m.params, "sessionNotification", name);
      const update = m.params.update;
      assert.ok(Object.hasOwn(SPEC_ROOTS, update.sessionUpdate), `${name}: ${update.sessionUpdate} is a session update Nexus sends`);
      check(update, update.sessionUpdate, `${name}.update`);
      if (update.content && !Array.isArray(update.content)) check(update.content, "textContent", `${name}.update.content`);
      if (Array.isArray(update.content)) toolContent(update.content, `${name}.update.content`);
    } else {
      assert.equal(m.method, "session/request_permission", name);
      check(m, "request", name);
      check(m.params, "permissionParams", name);
      check(m.params.toolCall, "permissionToolCall", name);
      toolContent(m.params.toolCall.content, `${name}.toolCall.content`);
      for (const option of m.params.options) check(option, "permissionOption", name);
    }
  }
  // Every type above was reached by at least one example, so the walk is not vacuous.
  assert.deepEqual([...visited].sort(), Object.keys(SPEC_ROOTS).sort());
  // And every kind of session update and tool status Nexus declares appears in the examples.
  const updates = AGENT_EXAMPLES.map(({ message }) => (message as any).params?.update).filter(Boolean);
  assert.deepEqual([...new Set(updates.map((update) => update.sessionUpdate))].sort(), ["agent_message_chunk", "session_info_update", "tool_call", "tool_call_update", "user_message_chunk"]);
  assert.deepEqual([...new Set(updates.map((update) => update.status).filter(Boolean))].sort(), ["completed", "failed", "in_progress", "pending"]);
});
