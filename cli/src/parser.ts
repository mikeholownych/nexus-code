import { ToolCall, ChatMessage } from "./types.js";
import { HARNESS_TOOLS } from "./tools.js";

const KNOWN_TOOLS = new Set<string>(HARNESS_TOOLS.map((t) => t.function.name));
["update_requirements", "task_completed", "manage_knowledge", "update_plan", "spawn_subagent"].forEach((t) => KNOWN_TOOLS.add(t));

export function isKnownToolName(name: string): boolean {
  if (typeof name !== "string") return false;
  return KNOWN_TOOLS.has(name) || name.startsWith("mcp__") || name.startsWith("custom__");
}

export interface ParsedModelOutput {
  thoughtText: string;
  reasoningText?: string;
  toolCalls: ToolCall[];
}

function escapeControlCharsInStrings(str: string): string {
  let inString = false;
  let isEscaped = false;
  let quoteChar = "";
  let buf = "";
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      if (isEscaped) {
        buf += ch;
        isEscaped = false;
      } else if (ch === "\\") {
        buf += ch;
        isEscaped = true;
      } else if (ch === quoteChar) {
        buf += ch;
        inString = false;
        quoteChar = "";
      } else if (ch === "\n") {
        buf += "\\n";
      } else if (ch === "\r") {
        buf += "\\r";
      } else if (ch === "\t") {
        buf += "\\t";
      } else {
        buf += ch;
      }
    } else {
      if (ch === '"' || ch === "'") {
        inString = true;
        quoteChar = ch;
      }
      buf += ch;
    }
  }
  return buf;
}

function replaceUnquotedPythonLiterals(str: string): string {
  let result = "";
  let inString = false;
  let isEscaped = false;
  let quoteChar = "";

  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (inString) {
      result += ch;
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === "\\") {
        isEscaped = true;
      } else if (ch === quoteChar) {
        inString = false;
        quoteChar = "";
      }
      i++;
    } else {
      if (ch === '"' || ch === "'") {
        inString = true;
        quoteChar = ch;
        result += ch;
        i++;
      } else if (str.startsWith("True", i) && !/[a-zA-Z0-9_]/.test(str[i + 4] || "")) {
        result += "true";
        i += 4;
      } else if (str.startsWith("False", i) && !/[a-zA-Z0-9_]/.test(str[i + 5] || "")) {
        result += "false";
        i += 5;
      } else if (str.startsWith("None", i) && !/[a-zA-Z0-9_]/.test(str[i + 4] || "")) {
        result += "null";
        i += 4;
      } else {
        result += ch;
        i++;
      }
    }
  }
  return result;
}

/**
 * Lenient self-healing JSON parser tailored for local LLM formatting artifacts.
 * Automatically repairs trailing commas, single quotes, unquoted keys, Python literals outside strings,
 * unescaped newlines/tabs inside string values, and missing closing brackets.
 */
/** Applies `fix` to the parts of `str` outside double-quoted JSON strings, leaving string contents untouched. */
function mapOutsideStrings(str: string, fix: (segment: string) => string): string {
  let out = "";
  let segment = "";
  let inString = false;
  let escaped = false;
  for (const ch of str) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      out += fix(segment) + ch;
      segment = "";
      inString = true;
    } else {
      segment += ch;
    }
  }
  return out + (inString ? segment : fix(segment));
}

export function repairJson<T = any>(raw: string): T {
  if (typeof raw !== "string") return raw as unknown as T;
  let str = raw.trim();

  // Strip wrapping markdown code blocks if present
  const codeBlockMatch = str.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (codeBlockMatch) {
    str = codeBlockMatch[1].trim();
  }

  // Fast path: try standard JSON.parse first
  try {
    return JSON.parse(str);
  } catch {
    // Proceed to heuristic repairs
  }

  // 1. Escape unescaped newlines/tabs inside string literals
  const controlsEscaped = escapeControlCharsInStrings(str);
  try {
    return JSON.parse(controlsEscaped);
  } catch {
    // Continue
  }

  // 2. Replace Python literals outside string values
  let cleaned = replaceUnquotedPythonLiterals(controlsEscaped);
  try {
    return JSON.parse(cleaned);
  } catch {
    // Continue
  }

  // 3. Remove trailing commas before closing braces/brackets
  cleaned = mapOutsideStrings(cleaned, (part) => part.replace(/,\s*([}\]])/g, "$1"));
  try {
    return JSON.parse(cleaned);
  } catch {
    // Continue
  }

  // 4. Fix unquoted keys: { key: "value" } -> { "key": "value" }
  cleaned = mapOutsideStrings(cleaned, (part) => part.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_-]*)\s*:/g, '$1"$2":'));
  try {
    return JSON.parse(cleaned);
  } catch {
    // Continue to quote repairs
  }

  // 5. Convert single-quoted keys and string literals: 'key': 'value' -> "key": "value"
  const singleQuoteCleaned = cleaned.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner) => {
    const escaped = inner.replace(/"/g, '\\"');
    return `"${escaped}"`;
  });

  try {
    return JSON.parse(singleQuoteCleaned);
  } catch {
    // Continue to bracket repair
  }

  // 6. Handle truncated/missing closing braces/brackets and unclosed quotes
  let openBraces = 0;
  let openBrackets = 0;
  let inStr = false;
  let isEsc = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (isEsc) isEsc = false;
      else if (ch === "\\") isEsc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{") openBraces++;
      else if (ch === "}") openBraces = Math.max(0, openBraces - 1);
      else if (ch === "[") openBrackets++;
      else if (ch === "]") openBrackets = Math.max(0, openBrackets - 1);
    }
  }
  let balanced = cleaned;
  if (inStr) balanced += '"';
  while (openBrackets > 0) { balanced += "]"; openBrackets--; }
  while (openBraces > 0) { balanced += "}"; openBraces--; }
  try {
    return JSON.parse(balanced);
  } catch {
    return JSON.parse(str);
  }
}

/**
 * Normalizes tool arguments, unwrapping nested wrapper payloads (input, parameters, args)
 * and repairing malformed JSON strings.
 */
function normalizeToolArgs(args: any): string {
  if (typeof args === "string") {
    try {
      const parsed = repairJson(args);
      return normalizeToolArgs(parsed);
    } catch {
      return args;
    }
  }
  if (typeof args === "object" && args !== null) {
    if (args.input && typeof args.input === "object" && !Array.isArray(args.input) && Object.keys(args).length === 1) {
      args = args.input;
    } else if (args.parameters && typeof args.parameters === "object" && !Array.isArray(args.parameters) && Object.keys(args).length === 1) {
      args = args.parameters;
    } else if (args.args && typeof args.args === "object" && !Array.isArray(args.args) && Object.keys(args).length === 1) {
      args = args.args;
    }
    return JSON.stringify(args);
  }
  return JSON.stringify(args || {});
}

/**
 * Extracts balanced JSON substrings containing tool definitions from unstructured text.
 */
function extractBalancedJsonObjects(text: string, known: (name: string) => boolean = isKnownToolName): Array<{ raw: string; start: number; end: number; parsed: any }> {
  const results: Array<{ raw: string; start: number; end: number; parsed: any }> = [];
  let depth = 0;
  let startIdx = -1;
  let inString = false;
  let isEscaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === "\\") {
        isEscaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) {
        startIdx = i;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && startIdx !== -1) {
        const candidate = text.slice(startIdx, i + 1);
        try {
          const parsed = repairJson(candidate);
          if (parsed && typeof parsed === "object") {
            const name = parsed.name || parsed.tool || parsed.action;
            if (name && typeof name === "string" && known(name)) {
              results.push({ raw: candidate, start: startIdx, end: i + 1, parsed });
            }
          }
        } catch {
          // Candidate wasn't a valid tool call object
        }
        startIdx = -1;
      }
    }
  }

  return results;
}

/**
 * Robust model response parser optimized for local LLM output patterns.
 * Isolates DeepSeek R1 reasoning (<think> tags), handles standard tool_calls,
 * XML <tool_call> tags, Markdown json codeblocks, and embedded JSON objects with self-healing JSON repair.
 */
/**
 * Parses an assistant message into reply text, reasoning and tool calls. Tool calls written as text (JSON blocks,
 * `<tool_call>` tags) are accepted only for tools offered on that request (`offered`, when given) or known built-ins.
 */
export function parseModelResponse(message: ChatMessage, offered?: Iterable<string>): ParsedModelOutput {
  const offeredNames = offered ? new Set(offered) : null;
  const known = (name: string): boolean => (offeredNames ? offeredNames.has(name) : isKnownToolName(name));
  const toolCalls: ToolCall[] = [];
  let thoughtText = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? JSON.stringify(message.content)
      : "";

  let reasoningText: string | undefined = undefined;

  // 1. Extract DeepSeek R1 / thinking tags: <think>...</think> and <thought>...</thought>
  const thinkRegex = /<(?:think|thought)>([\s\S]*?)<\/(?:think|thought)>/gi;
  const thinkMatches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = thinkRegex.exec(thoughtText)) !== null) {
    if (match[1].trim()) {
      thinkMatches.push(match[1].trim());
    }
  }

  if (thinkMatches.length > 0) {
    reasoningText = thinkMatches.join("\n\n");
    thoughtText = thoughtText.replace(thinkRegex, "").trim();
  }

  // 2. If standard OpenAI function calling tool_calls are present:
  if (message.tool_calls && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      toolCalls.push({
        id: tc.id || `call_${Math.random().toString(36).substring(2, 9)}`,
        type: "function",
        function: {
          name: tc.function.name,
          arguments: normalizeToolArgs(tc.function.arguments),
        },
      });
    }
    return { thoughtText, reasoningText, toolCalls };
  }

  if (!thoughtText && !reasoningText) {
    return { thoughtText: "", toolCalls: [] };
  }

  // 3. Try XML style fallback: <tool_call> ... </tool_call>
  const xmlRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let xmlMatch: RegExpExecArray | null;
  while ((xmlMatch = xmlRegex.exec(thoughtText)) !== null) {
    const raw = xmlMatch[1].trim();
    try {
      const parsed = repairJson(raw);
      const name = parsed.name || parsed.tool || parsed.function;
      const args = parsed.arguments || parsed.parameters || parsed.args || {};
      if (name && typeof name === "string" && known(name)) {
        toolCalls.push({
          id: `call_${Math.random().toString(36).substring(2, 9)}`,
          type: "function",
          function: {
            name,
            arguments: normalizeToolArgs(args),
          },
        });
      }
    } catch {
      // Ignore invalid JSON inside tool_call tag
    }
  }

  if (toolCalls.length > 0) {
    thoughtText = thoughtText.replace(xmlRegex, "").trim();
    return { thoughtText, reasoningText, toolCalls };
  }

  // 4. Try Markdown code blocks: ```json { "name": "...", "arguments": { ... } } ```
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = codeBlockRegex.exec(thoughtText)) !== null) {
    const raw = blockMatch[1].trim();
    try {
      const parsed = repairJson(raw);
      if (typeof parsed === "object" && parsed !== null) {
        const name = parsed.name || parsed.tool || parsed.action;
        const args = parsed.arguments || parsed.parameters || parsed.args || parsed.input;
        if (name && typeof name === "string" && known(name)) {
          toolCalls.push({
            id: `call_${Math.random().toString(36).substring(2, 9)}`,
            type: "function",
            function: {
              name,
              arguments: normalizeToolArgs(args),
            },
          });
        }
      }
    } catch {
      // Not a valid tool call code block
    }
  }

  if (toolCalls.length > 0) {
    thoughtText = thoughtText.replace(codeBlockRegex, "").trim();
    return { thoughtText, reasoningText, toolCalls };
  }

  // 5. Try embedded balanced JSON objects in text (e.g. model generates explanation + raw JSON without markdown)
  const balancedObjects = extractBalancedJsonObjects(thoughtText, known);
  if (balancedObjects.length > 0) {
    for (const item of balancedObjects) {
      const name = item.parsed.name || item.parsed.tool || item.parsed.action;
      const args = item.parsed.arguments || item.parsed.parameters || item.parsed.args || item.parsed.input;
      if (name && typeof name === "string" && known(name)) {
        toolCalls.push({
          id: `call_${Math.random().toString(36).substring(2, 9)}`,
          type: "function",
          function: {
            name,
            arguments: normalizeToolArgs(args),
          },
        });
        thoughtText = thoughtText.replace(item.raw, "").trim();
      }
    }
    if (toolCalls.length > 0) {
      return { thoughtText, reasoningText, toolCalls };
    }
  }

  return { thoughtText, reasoningText, toolCalls };
}
