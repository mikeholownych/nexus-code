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
  if (asksForExampleCall(requestMessages)) return false;
  if (tools.length === 0 || (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) || typeof message.content !== "string") return false;
  const body = soleJsonBody(message.content);
  if (body === undefined) return isFunctionCallText(message.content, tools, requestMessages);
  let value: unknown;
  try { value = JSON.parse(body); } catch { return false; }
  if (!isRecord(value) || echoedFromRequest(body, value, requestMessages)) return false;
  return (namedCall(value, tools) ?? (tools.length === 1 ? acceptedBy(tools[0]!, value) : undefined)) !== undefined;
}

const EXAMPLE_WORD = /\b(?:examples?|samples?|illustrat\w*|demonstrat\w*)\b/i;
const CALL_WORD = /\b(?:calls?|invoc\w*|invok\w*|tools?|json)\b/i;

/**
 * Whether the latest user turn asks to be shown an example call (CS-5). The call-shaped text is then the answer, so the
 * client must neither ask again nor force `tool_choice: required`: under auto or full-access approval that would turn
 * a demonstration into an executed call. Both an example word and a call word are required, so "add an example to the
 * README" does not switch the recovery off.
 */
function asksForExampleCall(requestMessages: readonly ChatMessage[]): boolean {
  const last = [...requestMessages].reverse().find((message) => message.role === "user");
  return typeof last?.content === "string" && EXAMPLE_WORD.test(last.content) && CALL_WORD.test(last.content);
}

/** Text as a model would quote it back: JSON escapes undone, `N | ` line-number prefixes and all whitespace dropped. */
function quotable(text: string): string {
  return text.replace(/\\(["\\/])/g, "$1").replace(/\\[nrt]/g, "").replace(/^[ \t]*\d+[ \t]*\|[ \t]?/gm, "").replace(/\s+/g, "");
}

function leaves(value: unknown, into: { strings: string[]; keys: string[] } = { strings: [], keys: [] }): { strings: string[]; keys: string[] } {
  if (typeof value === "string") into.strings.push(value);
  else if (Array.isArray(value)) for (const item of value) leaves(item, into);
  else if (isRecord(value)) for (const [key, item] of Object.entries(value)) { into.keys.push(key); leaves(item, into); }
  return into;
}

/** Below this many characters of string values, a match in a tool result says nothing ("ls", ".", a short path). */
const MIN_ECHO_VALUE_CHARS = 24;

/**
 * Whether the request already held this JSON, so the model is quoting what it read rather than asking for a call: the
 * same JSON in any non-assistant turn, or, for a tool result, every key and string value of it when together they are
 * long enough to be distinctive (key order and layout vary).
 */
function echoedFromRequest(body: string, value: unknown, requestMessages: readonly ChatMessage[]): boolean {
  const needle = quotable(body);
  const { strings, keys } = leaves(value);
  const parts = [...strings, ...keys].map(quotable).filter(Boolean);
  const distinctive = strings.map(quotable).join("").length >= MIN_ECHO_VALUE_CHARS;
  return requestMessages.some((message) => {
    if (message.role === "assistant" || typeof message.content !== "string") return false;
    const held = quotable(message.content);
    return held.includes(needle) || (message.role === "tool" && distinctive && parts.every((text) => held.includes(text)));
  });
}

function soleJsonBody(content: string): string | undefined {
  let text = content.replace(/<(think|thought|reasoning)>[\s\S]*?<\/\1>/gi, "").trim();
  text = text.replace(/(?:\s*<\/(?:invoke|function|tool_call|parameter)>)+$/i, "").trim();
  const fenced = extractSoleFencedCall(text);
  if (fenced) text = fenced.content;
  return text.startsWith("{") && text.endsWith("}") ? text : undefined;
}

/** Reply text with think blocks and one surrounding code fence (any language tag) removed. */
function unwrapped(content: string): string {
  const text = content.replace(/<(think|thought|reasoning)>[\s\S]*?<\/\1>/gi, "").trim();
  const fence = /^```[\w+-]*[ \t]*\r?\n?([\s\S]*?)\s*```$/.exec(text);
  return fence && !fence[1]!.includes("```") ? fence[1]!.trim() : text;
}

/**
 * The call written as a function call, `read_file(path="README.md")`, or the "pythonic" list `[a(x=1), b(y=2)]` that some
 * Llama-family chat templates use. Never executed: this only says "the reply was a call as text". Conservative: the whole
 * content must be nothing but such calls to offered tools, with keyword arguments that are literals (strings, numbers,
 * true/false/null/True/False/None, lists, dicts); a variable, a positional argument, an unbalanced bracket, an unknown
 * tool or any text around it is not one. As for JSON, text the request already contained is a quote, not a call.
 */
function isFunctionCallText(content: string, tools: readonly ToolDefinition[], requestMessages: readonly ChatMessage[]): boolean {
  const body = unwrapped(content);
  if (!/^\[?\s*[A-Za-z_]/.test(body)) return false;
  const calls = new CallTextParser(body, new Set(tools.map((tool) => tool.function.name))).parse();
  if (!calls) return false;
  return !calls.some((call) => echoedFromRequest(body, call.args, requestMessages));
}

const MAX_LITERAL_DEPTH = 16;
const FAIL = Symbol("not a call");

/** Recursive-descent reader for one call or a bracketed, comma-separated list of calls. Returns undefined on anything else. */
class CallTextParser {
  private pos = 0;
  constructor(private readonly text: string, private readonly offered: ReadonlySet<string>) {}

  parse(): Array<{ name: string; args: Record<string, unknown> }> | undefined {
    try {
      this.space();
      const listed = this.eat("[");
      const calls = [this.call()];
      if (listed) {
        for (this.space(); this.eat(","); this.space()) { if (this.peek() === "]") break; calls.push(this.call()); this.space(); }
        if (!this.eat("]")) return undefined;
      }
      this.space();
      return this.pos === this.text.length ? calls : undefined;
    } catch (err) {
      if (err === FAIL) return undefined;
      throw err;
    }
  }

  private peek(): string { return this.text[this.pos] ?? ""; }
  private space(): void { while (/\s/.test(this.peek())) this.pos++; }
  private eat(ch: string): boolean { if (this.peek() === ch) { this.pos++; return true; } return false; }
  private need(ch: string): void { if (!this.eat(ch)) throw FAIL; }

  private ident(): string {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    if (!m) throw FAIL;
    this.pos += m[0].length;
    return m[0];
  }

  private call(): { name: string; args: Record<string, unknown> } {
    this.space();
    const name = this.ident();
    if (!this.offered.has(name)) throw FAIL;
    this.space();
    this.need("(");
    const args: Record<string, unknown> = Object.create(null);
    this.space();
    while (this.peek() !== ")") {
      const key = this.ident();
      this.space();
      this.need("=");
      if (key in args) throw FAIL;
      args[key] = this.value(0);
      this.space();
      if (!this.eat(",")) break;
      this.space();
    }
    this.need(")");
    return { name, args };
  }

  private value(depth: number): unknown {
    if (depth > MAX_LITERAL_DEPTH) throw FAIL;
    this.space();
    const ch = this.peek();
    if (ch === '"' || ch === "'") return this.string(ch);
    if (ch === "[") return this.items("]", depth, () => this.value(depth + 1));
    if (ch === "{") {
      const pairs = this.items("}", depth, () => {
        this.space();
        const q = this.peek();
        if (q !== '"' && q !== "'") throw FAIL;
        const key = this.string(q);
        this.space();
        this.need(":");
        return [key, this.value(depth + 1)] as const;
      });
      return Object.fromEntries(pairs);
    }
    const word = /^(?:-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*)/.exec(this.text.slice(this.pos));
    if (!word) throw FAIL;
    this.pos += word[0].length;
    switch (word[0]) {
      case "true": case "True": return true;
      case "false": case "False": return false;
      case "null": case "None": return null;
    }
    const n = Number(word[0]);
    if (!Number.isFinite(n)) throw FAIL;
    return n;
  }

  private items<T>(close: string, depth: number, one: () => T): T[] {
    this.pos++;
    const out: T[] = [];
    this.space();
    while (this.peek() !== close) {
      out.push(one());
      this.space();
      if (!this.eat(",")) break;
      this.space();
    }
    this.need(close);
    return out;
  }

  private string(quote: string): string {
    this.pos++;
    let out = "";
    for (;;) {
      const ch = this.text[this.pos++];
      if (ch === undefined || ch === "\n") throw FAIL;
      if (ch === quote) return out;
      if (ch !== "\\") { out += ch; continue; }
      const esc = this.text[this.pos++];
      const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "\\": "\\", "'": "'", '"': '"', "/": "/" };
      if (esc !== undefined && esc in simple) out += simple[esc];
      else if (esc === "u" && /^[0-9a-fA-F]{4}$/.test(this.text.slice(this.pos, this.pos + 4))) { out += String.fromCharCode(parseInt(this.text.slice(this.pos, this.pos + 4), 16)); this.pos += 4; }
      else throw FAIL;
    }
  }
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
