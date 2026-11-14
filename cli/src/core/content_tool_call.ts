import { extractSoleFencedCall } from "../parser.js";
import type { ChatMessage, ToolDefinition } from "../types.js";

/** Sent with the model's own text reply when it wrote a call as text, before asking again. */
export const CONTENT_CALL_NOTE = "Your last reply wrote a tool call as plain text, and plain text is never executed. If you meant to call the tool, call it now with the native tool-call mechanism. If you were only showing or quoting that JSON, answer in prose instead.";

/**
 * Some servers answer a tool request with the call as JSON text in `content` and no `tool_calls`. That text is never
 * executed (REQ-AGT-112: prose JSON is not a call). This only recognises such a reply so the client can ask the server
 * again and use whatever native call comes back. A reply qualifies only when it is nothing
 * but strictly parseable JSON (plain or in one fence, closing tags and think blocks tolerated) that is either
 * {"name": <offered tool>, "arguments": {...}}, or an arguments object accepted by the one tool the request offered; and
 * the JSON is not text the request already contained (a model quoting what it read is not asking for a call).
 */
export function isContentCallReply(message: ChatMessage, tools: readonly ToolDefinition[], requestMessages: readonly ChatMessage[] = []): boolean {
  if (tools.length === 0 || (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) || typeof message.content !== "string") return false;
  const body = soleJsonBody(message.content);
  if (body === undefined) return false;
  let value: unknown;
  try { value = JSON.parse(body); } catch { return false; }
  if (!isRecord(value) || echoedFromRequest(body, value, requestMessages)) return false;
  return (namedCall(value, tools) ?? (tools.length === 1 ? acceptedBy(tools[0]!, value) : undefined)) !== undefined;
}

/** Text as a model would quote it back: JSON escapes undone, `N | ` line-number prefixes and all whitespace dropped. */
function quotable(text: string): string {
  return text.replace(/\\(["\\/])/g, "$1").replace(/\\[nrt]/g, "").replace(/^[ \t]*\d+[ \t]*\|[ \t]?/gm, "").replace(/\s+/g, "");
}

function leafStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) leafStrings(item, into);
  else if (isRecord(value)) for (const item of Object.values(value)) leafStrings(item, into);
  return into;
}

/**
 * Whether the request already held this JSON, so the model is quoting what it read rather than asking for a call: the
 * same JSON in any non-assistant turn, or, for a tool result, every string value of it (key order and layout vary).
 */
function echoedFromRequest(body: string, value: unknown, requestMessages: readonly ChatMessage[]): boolean {
  const needle = quotable(body);
  const strings = leafStrings(value).map(quotable).filter(Boolean);
  return requestMessages.some((message) => {
    if (message.role === "assistant" || typeof message.content !== "string") return false;
    const held = quotable(message.content);
    return held.includes(needle) || (message.role === "tool" && strings.length > 0 && strings.every((text) => held.includes(text)));
  });
}

function soleJsonBody(content: string): string | undefined {
  let text = content.replace(/<(think|thought|reasoning)>[\s\S]*?<\/\1>/gi, "").trim();
  text = text.replace(/(?:\s*<\/(?:invoke|function|tool_call|parameter)>)+$/i, "").trim();
  const fenced = extractSoleFencedCall(text);
  if (fenced) text = fenced.content;
  return text.startsWith("{") && text.endsWith("}") ? text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parameters(tool: ToolDefinition): { properties: Record<string, unknown>; required: string[] } {
  const schema = (tool.function.parameters ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
  return { properties: isRecord(schema.properties) ? schema.properties : {}, required: Array.isArray(schema.required) ? schema.required : [] };
}

function namedCall(value: Record<string, unknown>, tools: readonly ToolDefinition[]): { name: string; args: Record<string, unknown> } | undefined {
  const name = typeof value.name === "string" ? value.name : typeof value.tool === "string" ? value.tool : undefined;
  const raw = value.arguments ?? value.parameters ?? value.args;
  if (!name || !tools.some((tool) => tool.function.name === name)) return undefined;
  const args = typeof raw === "string" ? safeParse(raw) : raw;
  if (!isRecord(args) || Object.keys(value).some((key) => !["name", "tool", "arguments", "parameters", "args"].includes(key))) return undefined;
  return { name, args };
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function typeAccepts(schema: unknown, value: unknown): boolean {
  const declared = isRecord(schema) ? schema.type : undefined;
  const types = Array.isArray(declared) ? declared : typeof declared === "string" ? [declared] : [];
  if (types.length === 0) return true;
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
  return types.some((type) => type === actual || (type === "number" && actual === "integer"));
}

function acceptedBy(tool: ToolDefinition, value: Record<string, unknown>): { name: string; args: Record<string, unknown> } | undefined {
  const { properties, required } = parameters(tool);
  const keys = Object.keys(value);
  const accepted = keys.length > 0 && required.length > 0
    && required.every((key) => key in value)
    && keys.every((key) => key in properties && typeAccepts(properties[key], value[key]));
  return accepted ? { name: tool.function.name, args: value } : undefined;
}
