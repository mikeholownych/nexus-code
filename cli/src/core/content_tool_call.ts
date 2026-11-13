import type { ChatMessage, ToolCall, ToolDefinition } from "../types.js";

/**
 * Some servers answer a tool request with the call's arguments as JSON text in `content` (plain, or in one fenced block,
 * sometimes with leftover closing tags) and no `tool_calls`, so the turn would end as a text reply and the call would be
 * lost. This recovers such a reply into one native call, and only when the reply is nothing but that call:
 * - strictly parseable JSON, no repair, no prose around it;
 * - either {"name": <offered tool>, "arguments": {...}} or an arguments object that exactly one offered tool accepts
 *   (every required key present, no key outside its properties, declared primitive types respected).
 * Anything else is left untouched, so an ordinary answer that happens to be JSON is not turned into a call.
 */
export function recoverContentToolCall(message: ChatMessage, tools: readonly ToolDefinition[]): ChatMessage {
  if (tools.length === 0 || (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) || typeof message.content !== "string") return message;
  const body = soleJsonBody(message.content);
  if (body === undefined) return message;
  let value: unknown;
  try { value = JSON.parse(body); } catch { return message; }
  if (!isRecord(value)) return message;
  const call = namedCall(value, tools) ?? uniqueMatch(value, tools);
  if (!call) return message;
  const recovered: ToolCall = { id: `call_content_${Math.random().toString(36).slice(2, 9)}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } };
  return { ...message, content: "", tool_calls: [recovered], toolCallSource: "content" };
}

function soleJsonBody(content: string): string | undefined {
  let text = content.replace(/<(think|thought|reasoning)>[\s\S]*?<\/\1>/gi, "").trim();
  text = text.replace(/(?:\s*<\/(?:invoke|function|tool_call|parameter)>)+$/i, "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced) text = fenced[1]!.includes("```") ? "" : fenced[1]!.trim();
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

function uniqueMatch(value: Record<string, unknown>, tools: readonly ToolDefinition[]): { name: string; args: Record<string, unknown> } | undefined {
  const keys = Object.keys(value);
  const matches = tools.filter((tool) => {
    const { properties, required } = parameters(tool);
    return keys.length > 0
      && required.every((key) => key in value)
      && keys.every((key) => key in properties && typeAccepts(properties[key], value[key]));
  });
  return matches.length === 1 ? { name: matches[0]!.function.name, args: value } : undefined;
}
