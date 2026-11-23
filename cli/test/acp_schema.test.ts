/**
 * AC-1: the published schema of the ACP adapter's messages (docs/protocol/acp-adapter-v1.schema.json), its version
 * ledger, and the agreement of the schema with the messages the mapping builds. The schema describes Nexus's subset of
 * the Agent Client Protocol, not ACP itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../scripts/gen_protocol_schema.mjs";
import { ACP_ADAPTER_LEDGER_FILE, acpAdapterLedgerProblem, acpAdapterSchemaFile, generateAcpAdapterSchema } from "../scripts/gen_acp_schema.mjs";
import { encodeMessage, parseMessage } from "../src/acp/jsonrpc.js";
import { ACP_ADAPTER_SCHEMA_VERSION, ACP_ERROR, ACP_PERMISSION_OPTIONS, ACP_RECEIPT_GET_METHOD } from "../src/acp/types.js";
import { AGENT_EXAMPLES, CLIENT_EXAMPLES } from "./helpers/acp_examples.js";
import { validate } from "./helpers/json_schema.js";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_TEXT = fs.readFileSync(acpAdapterSchemaFile(ACP_ADAPTER_SCHEMA_VERSION), "utf8");
const schema = JSON.parse(SCHEMA_TEXT);
const refs = (list: Array<{ $ref: string }>) => list.map((item) => item.$ref.split("/").pop()).sort();

test("the checked-in ACP adapter schema equals a fresh generation from src/acp/types.ts", () => {
  const generated = generateAcpAdapterSchema();
  assert.equal(generated.version, ACP_ADAPTER_SCHEMA_VERSION);
  assert.equal(generated.text, SCHEMA_TEXT, "docs/protocol/acp-adapter schema is out of date: run `node cli/scripts/gen_acp_schema.mjs`, then record the version decision in ACP_ADAPTER_VERSIONS.json");
});

test("gen_acp_schema.mjs --check passes on the checked-in schema and ledger", () => {
  const result = spawnSync(process.execPath, [path.join(cli, "scripts", "gen_acp_schema.mjs"), "--check"], { cwd: cli, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /docs\/protocol\/acp-adapter-v1\.schema\.json is current/);
});

test("the newest ACP adapter ledger entry records the current schema and schema_version", () => {
  const ledger = JSON.parse(fs.readFileSync(ACP_ADAPTER_LEDGER_FILE, "utf8"));
  assert.equal(acpAdapterLedgerProblem(SCHEMA_TEXT, ledger, ACP_ADAPTER_SCHEMA_VERSION), undefined);
  for (const entry of ledger) {
    assert.ok(Number.isInteger(entry.schema_version) && /^[0-9a-f]{64}$/.test(entry.schemaSha256) && typeof entry.note === "string" && entry.note.trim(), "each entry has schema_version, schemaSha256 and a note");
  }
  // The rule itself: a changed schema (a type change), or a version bump, without a new entry is a failure.
  assert.match(acpAdapterLedgerProblem(`${SCHEMA_TEXT} `, ledger, ACP_ADAPTER_SCHEMA_VERSION) ?? "", /add an entry/);
  assert.match(acpAdapterLedgerProblem(SCHEMA_TEXT, ledger, ACP_ADAPTER_SCHEMA_VERSION + 1) ?? "", /ACP_ADAPTER_SCHEMA_VERSION is/);
  assert.match(acpAdapterLedgerProblem(SCHEMA_TEXT, [], ACP_ADAPTER_SCHEMA_VERSION) ?? "", /no entries/);
  assert.equal(ledger[ledger.length - 1].schemaSha256, sha256(SCHEMA_TEXT));
});

test("the schema says it is Nexus's subset of ACP, and its root is the two directions of the connection", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.match(schema.title, /subset of the Agent Client Protocol/);
  assert.match(schema.description, /NOT the schema of the Agent Client Protocol/);
  assert.match(schema.description, /only the subset of ACP version 1 that Nexus implements/);
  assert.match(schema.description, /Experimental/);
  assert.deepEqual(schema.$ref, "#/$defs/AcpAdapterDocument");
  assert.deepEqual(refs(schema.$defs.AcpAdapterDocument.anyOf), [
    "AcpCancelNotification", "AcpCancelRequestNotification", "AcpErrorResponse", "AcpInitializeRequest", "AcpLoadSessionRequest", "AcpNewSessionRequest", "AcpPermissionErrorResponse",
    "AcpPermissionRequest", "AcpPermissionResponse", "AcpPromptRequest", "AcpReceiptGetRequest", "AcpResultResponse", "AcpSessionUpdateNotification",
  ]);
  const method = (name: string) => schema.$defs[name].properties.method.const;
  assert.deepEqual(
    ["AcpInitializeRequest", "AcpNewSessionRequest", "AcpLoadSessionRequest", "AcpPromptRequest", "AcpReceiptGetRequest", "AcpCancelNotification", "AcpCancelRequestNotification", "AcpSessionUpdateNotification", "AcpPermissionRequest"].map(method),
    ["initialize", "session/new", "session/load", "session/prompt", ACP_RECEIPT_GET_METHOD, "session/cancel", "$/cancel_request", "session/update", "session/request_permission"],
  );
});

test("the schema carries the contract's closed lists: stop reasons, tool kinds and statuses, options, error codes, capabilities", () => {
  const defs = schema.$defs;
  assert.deepEqual(defs.AcpStopReason.enum, ["cancelled", "end_turn", "max_tokens", "max_turn_requests"]);
  assert.deepEqual(defs.AcpToolKind.enum, ["delete", "edit", "execute", "fetch", "other", "read", "search", "think"]);
  assert.deepEqual(defs.AcpToolStatus.enum, ["completed", "failed", "in_progress", "pending"]);
  assert.deepEqual(defs.AcpErrorCode.enum.slice().sort((a: number, b: number) => a - b), Object.values(ACP_ERROR).sort((a, b) => a - b));
  assert.deepEqual(defs.AcpPermissionOption.properties.optionId.enum, ACP_PERMISSION_OPTIONS.map((option) => option.optionId).sort());
  assert.deepEqual(defs.AcpPermissionOption.properties.kind.enum, ["allow_once", "reject_once"], "allow_always and reject_always cannot be offered");
  assert.deepEqual(refs(defs.AcpSessionUpdate.anyOf), ["AcpAgentMessageChunk", "AcpSessionInfoUpdate", "AcpToolCall", "AcpToolCallUpdate", "AcpUserMessageChunk"]);
  assert.deepEqual(refs(defs.AcpPromptBlock.anyOf), ["AcpResourceLinkBlock", "AcpTextBlock"], "image, audio and embedded resources are not in the subset");
  const capabilities = defs.AcpAgentCapabilities.properties;
  assert.deepEqual(capabilities.promptCapabilities.properties, { audio: { const: false }, embeddedContext: { const: false }, image: { const: false } });
  assert.deepEqual(capabilities.promptCapabilities.required, ["audio", "embeddedContext", "image"]);
  assert.deepEqual(capabilities.mcpCapabilities.properties, { http: { const: false }, sse: { const: false } });
  assert.deepEqual(defs.AcpInitializeResult.properties.protocolVersion, { const: 1 });
  assert.deepEqual(defs.AcpNewSessionParams.required, ["cwd", "mcpServers"]);
  assert.deepEqual(defs.AcpLoadSessionParams.required, ["cwd", "mcpServers", "sessionId"]);
  assert.deepEqual(defs.AcpToolDiffContent.required, ["newText", "oldText", "path", "type"]);
  assert.deepEqual(defs.AcpVerification.required, ["execution", "outcome", "receipt_id", "turn_id", "unverified_changes_pending", "validation_receipt", "verifier", "verifier_runs"]);
  // The JSON-RPC error has no _meta: details go in `data`.
  assert.deepEqual(Object.keys(defs.AcpError.properties), ["code", "data", "message"]);
});

test("every example message of the mapping tests validates against the schema, and survives the wire", () => {
  assert.ok(AGENT_EXAMPLES.length >= 30 && CLIENT_EXAMPLES.length >= 10);
  for (const { name, message } of [...AGENT_EXAMPLES, ...CLIENT_EXAMPLES]) {
    assert.deepEqual(validate(message, schema, schema), [], name);
    // As it is written to the connection and read back: still valid, and classified.
    const line = encodeMessage(message);
    const decoded = JSON.parse(line);
    assert.deepEqual(validate(decoded, schema, schema), [], `${name} (decoded)`);
  }
  // What a client sends is classified by the reader as what it is.
  for (const { name, message } of CLIENT_EXAMPLES) {
    const expected = "method" in message ? ("id" in message ? "request" : "notification") : "response";
    assert.equal(parseMessage(encodeMessage(message).trimEnd()).kind, expected, name);
  }
  // Each example matches the branch it is meant to, not merely some branch.
  const matches = (message: unknown) => (schema.$defs.AcpAdapterDocument.anyOf as Array<{ $ref: string }>).filter((branch) => validate(message, branch, schema).length === 0).map((branch) => branch.$ref.split("/").pop());
  for (const { name, message } of AGENT_EXAMPLES) {
    const m = message as any;
    const expected = "error" in m ? "AcpErrorResponse" : "result" in m ? "AcpResultResponse" : m.method === "session/update" ? "AcpSessionUpdateNotification" : "AcpPermissionRequest";
    assert.ok(matches(message).includes(expected), `${name}: ${matches(message).join(", ")}`);
  }
  for (const update of AGENT_EXAMPLES.map(({ message }) => (message as any).params?.update).filter(Boolean)) {
    const branches = (schema.$defs.AcpSessionUpdate.anyOf as Array<{ $ref: string }>).filter((branch) => validate(update, branch, schema).length === 0);
    assert.equal(branches.length, 1, `${update.sessionUpdate} matches exactly one session update`);
  }
});

test("the schema refuses messages outside the subset", () => {
  const bad = (message: unknown, why: string) => assert.ok(validate(message, schema, schema).length > 0, why);
  const update = (value: object) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: value } });
  bad({ jsonrpc: "1.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }, "wrong jsonrpc");
  bad({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/w" } }, "session/new without mcpServers");
  bad({ jsonrpc: "2.0", id: 1, method: "session/set_mode", params: { sessionId: "s", modeId: "auto" } }, "a method outside the subset");
  bad({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "image", data: "", mimeType: "image/png" }] } }, "an image block");
  bad(update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "x" } }), "an update Nexus never sends");
  bad(update({ sessionUpdate: "tool_call", toolCallId: "e1", title: "t", kind: "switch_mode", status: "pending" }), "a tool kind Nexus never uses");
  bad(update({ sessionUpdate: "tool_call_update", toolCallId: "e1", status: "done" }), "an unknown status");
  bad(update({ sessionUpdate: "session_info_update" }), "the carrier without its verification object");
  // A result is told apart by its request, not by its shape, and the `session/load` result is the empty object: any
  // object is a valid `result` at the root. The result types themselves are closed where the contract is.
  const def = (name: string, value: unknown) => validate(value, schema.$defs[name], schema);
  assert.ok(def("AcpPromptResult", { stopReason: "refusal" }).length > 0, "a stop reason Nexus never sends");
  assert.ok(def("AcpPromptResult", {}).length > 0);
  assert.ok(def("AcpNewSessionResult", {}).length > 0);
  assert.ok(def("AcpInitializeResult", { protocolVersion: 2, agentInfo: { name: "nexus", title: "Nexus Code", version: "1" }, authMethods: [], agentCapabilities: {} }).length > 0);
  assert.ok(def("AcpError", { code: -32002, message: "x" }).length > 0, "an error code Nexus does not send");
  assert.deepEqual(def("AcpLoadSessionResult", {}), []);
  const permission = AGENT_EXAMPLES.find(({ message }) => (message as any).method === "session/request_permission")!.message as any;
  bad({ ...permission, params: { ...permission.params, options: [...permission.params.options, { optionId: "allow_always", name: "Always", kind: "allow_always" }] } }, "an allow_always option");
  bad({ ...permission, id: "string-id" }, "a string id on an agent request");
});
