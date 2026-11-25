/**
 * Validation of everything an ACP client sends. Each function takes the raw `params` (or `result`) and returns a typed
 * value or a -32602 error naming the field in `data.field`. Error messages are fixed text: no client string is echoed.
 *
 * Pure. The two checks that need the file system (the canonical form of `cwd`, whether a `file://` link lies inside
 * the workspace) take it as an argument (`AcpFs`), and never read a file's content.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACP_ERROR,
  ACP_MAX_CLIENT_FIELD_CHARS,
  ACP_MAX_CWD_CHARS,
  ACP_MAX_MCP_SERVERS_INSPECTED,
  ACP_MAX_PROMPT_BLOCKS,
  ACP_MAX_PROMPT_CHARS,
  ACP_MAX_RECEIPT_ID_CHARS,
  ACP_MAX_SESSION_ID_CHARS,
  ACP_MAX_TEXT_BLOCK_CHARS,
  ACP_MAX_URI_CHARS,
  ACP_NV_MAX_PROTOCOL_VERSION,
  ACP_PROTOCOL_VERSION,
} from "./types.js";
import type { AcpError, AcpId, AcpMcpServersIgnored, AcpPermissionOutcome } from "./types.js";
import { isRequestId } from "./jsonrpc.js";

export type Validated<T> = { ok: true; value: T } | { ok: false; error: AcpError };

/** The two file-system questions validation asks. Both throw when the path cannot be resolved or examined. */
export interface AcpFs {
  realpath(file: string): string;
  isDirectory(file: string): boolean;
}

function fail(field: string, message: string): { ok: false; error: AcpError } {
  return { ok: false, error: { code: ACP_ERROR.INVALID_PARAMS, message, data: { field } } };
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** An own member that is neither absent nor null. */
function present(object: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(object, key) && object[key] !== undefined && object[key] !== null;
}

function member(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CONTROL_RUNS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** Text bound for one line of a prompt or a log: control characters (newlines included) become a space, then it is cut. */
export function singleLine(text: string, max: number): string {
  return text.replace(CONTROL_RUNS, " ").trim().slice(0, max);
}

export interface InitializeInput {
  /** The version the client asked for. The answer is `negotiatedProtocolVersion`. */
  protocolVersion: number;
  client: { name: string; version: string; title?: string } | null;
}

/**
 * `clientCapabilities` and `_meta` are checked for shape and then dropped: the validated value carries neither, so
 * nothing downstream can consult what a client claims about itself.
 */
export function validateInitialize(params: unknown): Validated<InitializeInput> {
  const p = record(params);
  if (!p) return fail("params", "initialize requires a params object");
  const version = member(p, "protocolVersion");
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0 || version > ACP_NV_MAX_PROTOCOL_VERSION) {
    return fail("protocolVersion", `protocolVersion must be an integer from 0 to ${ACP_NV_MAX_PROTOCOL_VERSION}`);
  }
  if (present(p, "clientCapabilities") && !record(p.clientCapabilities)) return fail("clientCapabilities", "clientCapabilities must be an object");
  let client: InitializeInput["client"] = null;
  if (present(p, "clientInfo")) {
    const info = record(p.clientInfo);
    if (!info) return fail("clientInfo", "clientInfo must be an object");
    const text = (key: string, required: boolean): Validated<string | undefined> => {
      if (!present(info, key)) return required ? fail(`clientInfo.${key}`, `clientInfo.${key} must be a non-empty string`) : ok(undefined);
      const value = info[key];
      if (typeof value !== "string" || !value.trim()) return fail(`clientInfo.${key}`, `clientInfo.${key} must be a non-empty string`);
      if (value.length > ACP_MAX_CLIENT_FIELD_CHARS) return fail(`clientInfo.${key}`, `clientInfo.${key} is longer than ${ACP_MAX_CLIENT_FIELD_CHARS} characters`);
      if (CONTROL.test(value)) return fail(`clientInfo.${key}`, `clientInfo.${key} must not contain control characters`);
      return ok(value);
    };
    const name = text("name", true);
    if (!name.ok) return name;
    const clientVersion = text("version", true);
    if (!clientVersion.ok) return clientVersion;
    const title = text("title", false);
    if (!title.ok) return title;
    client = { name: name.value as string, version: clientVersion.value as string, ...(title.value !== undefined ? { title: title.value } : {}) };
  }
  return ok({ protocolVersion: version, client });
}

/**
 * The version to answer `initialize` with: the requested one when Nexus supports it, else the latest Nexus supports
 * (published specification, initialization). Nexus supports one version, so this is that version either way.
 */
export function negotiatedProtocolVersion(_requested: number): typeof ACP_PROTOCOL_VERSION {
  return ACP_PROTOCOL_VERSION;
}

/**
 * The part of the `cwd` rule that needs no file system: a string, absolute ("MUST be an absolute path", published
 * specification, session-setup), bounded, with no NUL and no line break.
 */
export function validateCwdShape(value: unknown, field = "cwd"): Validated<string> {
  if (typeof value !== "string" || !value) return fail(field, "cwd must be a non-empty string");
  if (value.length > ACP_MAX_CWD_CHARS) return fail(field, `cwd is longer than ${ACP_MAX_CWD_CHARS} characters`);
  if (/[\0\r\n]/.test(value)) return fail(field, "cwd must not contain a NUL or a line break");
  if (!path.isAbsolute(value)) return fail(field, "cwd must be an absolute path");
  return ok(value);
}

/**
 * The part that does: the real path of `cwd` (symlinks resolved), which must be a directory. The canonical path is what
 * the session runs in, and it passes the shape rule again, because a link can lead to a name the rule refuses.
 */
export function canonicalCwd(cwd: string, fs: AcpFs, field = "cwd"): Validated<string> {
  const shaped = validateCwdShape(cwd, field);
  if (!shaped.ok) return shaped;
  let real: string;
  try {
    real = fs.realpath(shaped.value);
    if (!fs.isDirectory(real)) return fail(field, "cwd is not a directory");
  } catch {
    return fail(field, "cwd does not exist or cannot be read");
  }
  return validateCwdShape(real, field);
}

/** The exact shape `SessionManager.generateSessionId` writes. `latest`, a prefix and a file name are not session ids here. */
const SESSION_ID = /^session_\d{8}_\d{6}_[a-z0-9]{8}$/;

export function validateSessionId(value: unknown, field = "sessionId"): Validated<string> {
  if (typeof value !== "string" || value.length > ACP_MAX_SESSION_ID_CHARS || !SESSION_ID.test(value)) {
    return fail(field, "sessionId must be a complete Nexus session id");
  }
  return ok(value);
}

function mcpServers(p: Record<string, unknown>): Validated<AcpMcpServersIgnored> {
  const servers = member(p, "mcpServers");
  if (!Array.isArray(servers)) return fail("mcpServers", "mcpServers is required and must be an array");
  const names: string[] = [];
  for (const entry of servers.slice(0, ACP_MAX_MCP_SERVERS_INSPECTED)) {
    const name = record(entry) ? member(entry as Record<string, unknown>, "name") : undefined;
    names.push(typeof name === "string" ? singleLine(name, ACP_MAX_CLIENT_FIELD_CHARS) : "");
  }
  return ok({ count: servers.length, names });
}

/** Session options the specification defines and Nexus does not support: refused, never silently ignored. */
function unsupportedSessionOptions(p: Record<string, unknown>): { ok: false; error: AcpError } | undefined {
  if (present(p, "additionalDirectories")) {
    const directories = p.additionalDirectories;
    if (!Array.isArray(directories)) return fail("additionalDirectories", "additionalDirectories must be an array");
    if (directories.length > 0) return fail("additionalDirectories", "additional directories are not supported: a session has one workspace, cwd");
  }
  if (present(p, "systemPrompt")) return fail("systemPrompt", "a client-supplied system prompt is not supported");
  return undefined;
}

export interface NewSessionInput {
  /** As sent, shape-checked. Run it through `canonicalCwd` before use. */
  cwd: string;
  /** What the client asked to connect, for the report only: none of it is connected. */
  mcpServers: AcpMcpServersIgnored;
}

export function validateNewSession(params: unknown): Validated<NewSessionInput> {
  const p = record(params);
  if (!p) return fail("params", "session/new requires a params object");
  const cwd = validateCwdShape(member(p, "cwd"));
  if (!cwd.ok) return cwd;
  const servers = mcpServers(p);
  if (!servers.ok) return servers;
  const unsupported = unsupportedSessionOptions(p);
  if (unsupported) return unsupported;
  return ok({ cwd: cwd.value, mcpServers: servers.value });
}

export interface LoadSessionInput extends NewSessionInput {
  sessionId: string;
}

export function validateLoadSession(params: unknown): Validated<LoadSessionInput> {
  const p = record(params);
  if (!p) return fail("params", "session/load requires a params object");
  const sessionId = validateSessionId(member(p, "sessionId"));
  if (!sessionId.ok) return sessionId;
  const rest = validateNewSession(p);
  if (!rest.ok) return rest;
  return ok({ sessionId: sessionId.value, ...rest.value });
}

/**
 * A `resource_link` as one line of prompt text. A `file://` URI whose real path lies inside the workspace becomes
 * `Referenced file: <path relative to the workspace>`; anything else becomes `Reference: <the URI, on one line>`.
 * Nothing is read or fetched: the agent reaches the file, if it wants it, through its own gated tools.
 * `workspace` must already be canonical.
 */
export function resourceLinkLine(uri: string, workspace: string, fs: AcpFs): string {
  if (/^file:\/\//i.test(uri)) {
    try {
      const real = fs.realpath(fileURLToPath(new URL(uri)));
      const relative = path.relative(workspace, real);
      const inside = relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
      if (inside && !CONTROL.test(relative)) return `Referenced file: ${relative}`;
    } catch {
      // Not a path that exists here: it stays an opaque reference.
    }
  }
  return `Reference: ${singleLine(uri, ACP_MAX_URI_CHARS)}`;
}

export interface PromptInput {
  sessionId: string;
  /** The prompt as the sidecar receives it: text blocks and reference lines, one per line group, in order. */
  text: string;
}

const REFUSED_BLOCKS: Record<string, string> = {
  image: "image content is not supported",
  audio: "audio content is not supported",
  resource: "embedded resources are not supported; send a resource_link",
};

/**
 * `session/prompt`: content blocks to prompt text. `text` is taken as it is; `resource_link` becomes a reference line
 * (see `resourceLinkLine`); `image`, `audio` and `resource` are refused, naming the block.
 */
export function validatePrompt(params: unknown, context: { workspace: string; fs: AcpFs }): Validated<PromptInput> {
  const p = record(params);
  if (!p) return fail("params", "session/prompt requires a params object");
  const sessionId = validateSessionId(member(p, "sessionId"));
  if (!sessionId.ok) return sessionId;
  const blocks = member(p, "prompt");
  if (!Array.isArray(blocks) || blocks.length === 0) return fail("prompt", "prompt must be a non-empty array of content blocks");
  if (blocks.length > ACP_MAX_PROMPT_BLOCKS) return fail("prompt", `prompt has more than ${ACP_MAX_PROMPT_BLOCKS} content blocks`);
  const parts: string[] = [];
  let total = 0;
  for (let i = 0; i < blocks.length; i++) {
    const field = `prompt[${i}]`;
    const block = record(blocks[i]);
    if (!block) return fail(field, `prompt block ${i} must be an object`);
    const type = member(block, "type");
    let part: string;
    if (type === "text") {
      const text = member(block, "text");
      if (typeof text !== "string") return fail(`${field}.text`, `prompt block ${i}: text must be a string`);
      if (text.length > ACP_MAX_TEXT_BLOCK_CHARS) return fail(`${field}.text`, `prompt block ${i}: text is longer than ${ACP_MAX_TEXT_BLOCK_CHARS} characters`);
      if (text.includes("\0")) return fail(`${field}.text`, `prompt block ${i}: text must not contain a NUL`);
      part = text;
    } else if (type === "resource_link") {
      const uri = member(block, "uri");
      if (typeof uri !== "string" || !uri) return fail(`${field}.uri`, `prompt block ${i}: uri must be a non-empty string`);
      if (uri.length > ACP_MAX_URI_CHARS) return fail(`${field}.uri`, `prompt block ${i}: uri is longer than ${ACP_MAX_URI_CHARS} characters`);
      part = resourceLinkLine(uri, context.workspace, context.fs);
    } else if (typeof type === "string" && Object.hasOwn(REFUSED_BLOCKS, type)) {
      return fail(field, `prompt block ${i}: ${REFUSED_BLOCKS[type]}`);
    } else {
      return fail(`${field}.type`, `prompt block ${i}: unknown content type`);
    }
    total += part.length + (parts.length ? 1 : 0);
    if (total > ACP_MAX_PROMPT_CHARS) return fail("prompt", `the prompt is longer than ${ACP_MAX_PROMPT_CHARS} characters`);
    parts.push(part);
  }
  const text = parts.join("\n");
  if (!text.trim()) return fail("prompt", "the prompt has no text");
  return ok({ sessionId: sessionId.value, text });
}

export function validateCancel(params: unknown): Validated<{ sessionId: string }> {
  const p = record(params);
  if (!p) return fail("params", "session/cancel requires a params object");
  const sessionId = validateSessionId(member(p, "sessionId"));
  return sessionId.ok ? ok({ sessionId: sessionId.value }) : sessionId;
}

/** `$/cancel_request`: the id of the request to cancel. */
export function validateCancelRequest(params: unknown): Validated<{ requestId: AcpId }> {
  const p = record(params);
  if (!p) return fail("params", "$/cancel_request requires a params object");
  const requestId = member(p, "requestId");
  if (!isRequestId(requestId)) return fail("requestId", "requestId must be a string or an integer");
  return ok({ requestId });
}

export function validateReceiptGet(params: unknown): Validated<{ sessionId: string; receiptId?: string }> {
  const p = record(params);
  if (!p) return fail("params", "the receipt request requires a params object");
  const sessionId = validateSessionId(member(p, "sessionId"));
  if (!sessionId.ok) return sessionId;
  if (!present(p, "receiptId")) return ok({ sessionId: sessionId.value });
  const receiptId = p.receiptId;
  if (typeof receiptId !== "string" || !receiptId || receiptId.length > ACP_MAX_RECEIPT_ID_CHARS || CONTROL.test(receiptId)) {
    return fail("receiptId", `receiptId must be a non-empty string of at most ${ACP_MAX_RECEIPT_ID_CHARS} characters`);
  }
  return ok({ sessionId: sessionId.value, receiptId });
}

/**
 * `_nexus/verify`: the client chooses only the active session; verifier, base and deliverables are never accepted.
 * `_meta` is allowed and never read, whatever it holds, as on every other method.
 */
export function validateVerify(params: unknown): Validated<{ sessionId: string }> {
  const p = record(params);
  if (!p) return fail("params", "the verification request requires a params object");
  if (Object.keys(p).some((key) => key !== "sessionId" && key !== "_meta")) {
    return fail("params", "verification accepts only sessionId and optional _meta; verification settings belong to the server operator");
  }
  const sessionId = validateSessionId(member(p, "sessionId"));
  return sessionId.ok ? ok({ sessionId: sessionId.value }) : sessionId;
}

/**
 * The shape of the `result` of a reply to `session/request_permission`: `{outcome: {outcome: "selected", optionId}}`
 * or `{outcome: {outcome: "cancelled"}}`. Shape only: which option id approves is decided in one place,
 * `permissionReplyToCommand` in mapping.ts. There is nobody to send this error to: the caller denies.
 */
export function validatePermissionResult(result: unknown): Validated<AcpPermissionOutcome> {
  const r = record(result);
  if (!r) return fail("result", "a permission result must be an object");
  const outcome = record(member(r, "outcome"));
  if (!outcome) return fail("outcome", "a permission result needs an outcome object");
  const kind = member(outcome, "outcome");
  if (kind === "cancelled") return ok({ outcome: "cancelled" });
  if (kind !== "selected") return fail("outcome.outcome", "the outcome must be selected or cancelled");
  const optionId = member(outcome, "optionId");
  if (typeof optionId !== "string") return fail("outcome.optionId", "a selected outcome needs a string optionId");
  return ok({ outcome: "selected", optionId });
}
