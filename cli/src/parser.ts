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
  notices?: string[];
}

export interface ParseModelResponseOptions {
  offered?: Iterable<string>;
  nativeTools?: boolean;
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

function extractReasoning(message: ChatMessage, rawContent: string): { thoughtText: string; reasoningText?: string } {
  const reasoningParts: string[] = [];

  const msgObj = message as Record<string, any>;
  if (typeof msgObj.reasoning_content === "string" && msgObj.reasoning_content.trim()) {
    reasoningParts.push(msgObj.reasoning_content.trim());
  } else if (typeof msgObj.reasoning === "string" && msgObj.reasoning.trim()) {
    reasoningParts.push(msgObj.reasoning.trim());
  }

  let text = rawContent;

  // 1. Paired tags: <think>...</think>, <thought>...</thought>, <reasoning>...</reasoning>
  const pairedRegex = /<(think|thought|reasoning)>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = pairedRegex.exec(text)) !== null) {
    if (match[2].trim()) {
      reasoningParts.push(match[2].trim());
    }
  }
  text = text.replace(pairedRegex, "");

  // 2. Lone closing tag: </think>, </thought>, </reasoning>
  // "Text before a lone </think> ... is reasoning and is never parsed for tool calls" (REQ-AGT-113)
  const loneCloseMatch = /<\/(?:think|thought|reasoning)>/i.exec(text);
  if (loneCloseMatch) {
    const beforeClose = text.slice(0, loneCloseMatch.index).trim();
    if (beforeClose) {
      reasoningParts.push(beforeClose);
    }
    text = text.slice(loneCloseMatch.index + loneCloseMatch[0].length);
  }

  // 3. Unclosed opening tag: <think>, <thought>, <reasoning>
  // "text after an unclosed <think> is reasoning and is never parsed for tool calls" (REQ-AGT-113)
  const unclosedOpenMatch = /<(?:think|thought|reasoning)>/i.exec(text);
  if (unclosedOpenMatch) {
    const afterOpen = text.slice(unclosedOpenMatch.index + unclosedOpenMatch[0].length).trim();
    if (afterOpen) {
      reasoningParts.push(afterOpen);
    }
    text = text.slice(0, unclosedOpenMatch.index);
  }

  const thoughtText = text.trim();
  const reasoningText = reasoningParts.length > 0 ? reasoningParts.join("\n\n") : undefined;
  return { thoughtText, reasoningText };
}

function extractSoleFencedCall(text: string): { raw: string; content: string } | null {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (!match) return null;
  if (match[1].includes("```")) return null;
  return { raw: trimmed, content: match[1].trim() };
}

/**
 * Parses an assistant message into reply text, reasoning and tool calls.
 * Implements REQ-AGT-112, REQ-AGT-113, and REQ-AGT-117 (PLAN-11).
 * When nativeTools is enabled (or native tool_calls are present), only native tool_calls are parsed.
 * On text connections, only <tool_call> tags or a reply that consists solely of one fenced JSON call are parsed.
 * Prose JSON is never parsed.
 */
export function parseModelResponse(
  message: ChatMessage,
  optionsOrOffered?: Iterable<string> | ParseModelResponseOptions
): ParsedModelOutput {
  let offered: Iterable<string> | undefined;
  let nativeTools: boolean | undefined;

  if (optionsOrOffered) {
    if (typeof (optionsOrOffered as any)[Symbol.iterator] === "function" && !(optionsOrOffered as any).offered) {
      offered = optionsOrOffered as Iterable<string>;
    } else {
      const opts = optionsOrOffered as ParseModelResponseOptions;
      offered = opts.offered;
      nativeTools = opts.nativeTools;
    }
  }

  const offeredNames = offered ? new Set(offered) : null;
  const known = (name: string): boolean => (offeredNames ? offeredNames.has(name) : isKnownToolName(name));
  const toolCalls: ToolCall[] = [];
  const notices: string[] = [];

  const rawContent = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? JSON.stringify(message.content)
      : "";

  let { thoughtText, reasoningText } = extractReasoning(message, rawContent);

  const isNative = nativeTools !== undefined
    ? nativeTools
    : Boolean(message.tool_calls && Array.isArray(message.tool_calls) && message.tool_calls.length > 0);

  // Native connection: execute only native tool_calls
  if (isNative) {
    if (message.tool_calls && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      for (const tc of message.tool_calls) {
        if (
          !tc ||
          typeof tc !== "object" ||
          !tc.function ||
          typeof tc.function !== "object" ||
          typeof tc.function.name !== "string" ||
          !tc.function.name.trim()
        ) {
          notices.push("Malformed native tool call dropped: missing function object or name.");
          continue;
        }
        const name = tc.function.name.trim();
        if (!known(name)) {
          notices.push(`Tool "${name}" is not offered on this request and was not executed.`);
          continue;
        }
        toolCalls.push({
          id: tc.id || `call_${Math.random().toString(36).substring(2, 9)}`,
          type: "function",
          function: {
            name,
            arguments: normalizeToolArgs(tc.function.arguments),
          },
        });
      }
    }
    return {
      thoughtText,
      reasoningText,
      toolCalls,
      ...(notices.length > 0 ? { notices } : {}),
    };
  }

  // Text-only connection:
  // 1. If native tool_calls are present on message, validate and accept them
  if (message.tool_calls && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      if (
        !tc ||
        typeof tc !== "object" ||
        !tc.function ||
        typeof tc.function !== "object" ||
        typeof tc.function.name !== "string" ||
        !tc.function.name.trim()
      ) {
        notices.push("Malformed native tool call dropped: missing function object or name.");
        continue;
      }
      const name = tc.function.name.trim();
      if (!known(name)) {
        notices.push(`Tool "${name}" is not offered on this request and was not executed.`);
        continue;
      }
      toolCalls.push({
        id: tc.id || `call_${Math.random().toString(36).substring(2, 9)}`,
        type: "function",
        function: {
          name,
          arguments: normalizeToolArgs(tc.function.arguments),
        },
      });
    }
    if (toolCalls.length > 0) {
      return {
        thoughtText,
        reasoningText,
        toolCalls,
        ...(notices.length > 0 ? { notices } : {}),
      };
    }
  }

  if (!thoughtText && !reasoningText) {
    return {
      thoughtText: "",
      toolCalls: [],
      ...(notices.length > 0 ? { notices } : {}),
    };
  }

  // 2. Try XML style: <tool_call> ... </tool_call>
  const xmlRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let xmlMatch: RegExpExecArray | null;
  while ((xmlMatch = xmlRegex.exec(thoughtText)) !== null) {
    const raw = xmlMatch[1].trim();
    try {
      const parsed = repairJson(raw);
      const name = parsed.name || parsed.tool || parsed.function;
      const args = parsed.arguments || parsed.parameters || parsed.args || {};
      if (name && typeof name === "string") {
        if (known(name)) {
          toolCalls.push({
            id: `call_${Math.random().toString(36).substring(2, 9)}`,
            type: "function",
            function: {
              name,
              arguments: normalizeToolArgs(args),
            },
          });
        } else {
          notices.push(`Tool "${name}" is not offered on this request and was not executed.`);
        }
      }
    } catch {
      // Ignore invalid JSON inside tool_call tag
    }
  }

  if (toolCalls.length > 0) {
    thoughtText = thoughtText.replace(xmlRegex, "").trim();
    return {
      thoughtText,
      reasoningText,
      toolCalls,
      ...(notices.length > 0 ? { notices } : {}),
    };
  }

  // 3. Try sole fenced JSON tool call:
  // "a reply that consists solely of one fenced JSON tool call" (REQ-AGT-112)
  const soleFenced = extractSoleFencedCall(thoughtText);
  if (soleFenced) {
    try {
      const parsed = repairJson(soleFenced.content);
      if (typeof parsed === "object" && parsed !== null) {
        const name = parsed.name || parsed.tool || parsed.action;
        const args = parsed.arguments || parsed.parameters || parsed.args || parsed.input;
        if (name && typeof name === "string") {
          if (known(name)) {
            toolCalls.push({
              id: `call_${Math.random().toString(36).substring(2, 9)}`,
              type: "function",
              function: {
                name,
                arguments: normalizeToolArgs(args),
              },
            });
            thoughtText = "";
            return {
              thoughtText,
              reasoningText,
              toolCalls,
              ...(notices.length > 0 ? { notices } : {}),
            };
          } else {
            notices.push(`Tool "${name}" is not offered on this request and was not executed.`);
          }
        }
      }
    } catch {
      // Not valid JSON in code block
    }
  }

  // 4. One-RC escape hatch: NEXUS_TEXT_TOOL_PARSING=legacy
  if (process.env.NEXUS_TEXT_TOOL_PARSING === "legacy") {
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
      } catch {}
    }

    if (toolCalls.length > 0) {
      thoughtText = thoughtText.replace(codeBlockRegex, "").trim();
      return {
        thoughtText,
        reasoningText,
        toolCalls,
        ...(notices.length > 0 ? { notices } : {}),
      };
    }

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
        return {
          thoughtText,
          reasoningText,
          toolCalls,
          ...(notices.length > 0 ? { notices } : {}),
        };
      }
    }
  }

  return {
    thoughtText,
    reasoningText,
    toolCalls,
    ...(notices.length > 0 ? { notices } : {}),
  };
}
