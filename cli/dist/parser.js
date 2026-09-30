/**
 * Lenient self-healing JSON parser tailored for local LLM formatting artifacts.
 * Automatically repairs trailing commas, single quotes, unquoted keys, Python literals,
 * unescaped newlines/tabs inside string values, and markdown code fences.
 */
export function repairJson(raw) {
    if (typeof raw !== "string")
        return raw;
    let str = raw.trim();
    // Strip wrapping markdown code blocks if present
    const codeBlockMatch = str.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (codeBlockMatch) {
        str = codeBlockMatch[1].trim();
    }
    // Fast path: try standard JSON.parse first
    try {
        return JSON.parse(str);
    }
    catch {
        // Proceed to heuristic repairs
    }
    let cleaned = str;
    // 1. Replace Python boolean and null literals
    cleaned = cleaned
        .replace(/\bTrue\b/g, "true")
        .replace(/\bFalse\b/g, "false")
        .replace(/\bNone\b/g, "null");
    // 2. Remove trailing commas before closing braces/brackets
    cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
    // 3. Fix unquoted keys: { key: "value" } -> { "key": "value" }
    cleaned = cleaned.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_-]*)\s*:/g, '$1"$2":');
    // 4. Try parsing after structural repairs
    try {
        return JSON.parse(cleaned);
    }
    catch {
        // Continue to quote repairs
    }
    // 5. Convert single-quoted keys and string literals: 'key': 'value' -> "key": "value"
    const singleQuoteCleaned = cleaned.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner) => {
        const escaped = inner.replace(/"/g, '\\"');
        return `"${escaped}"`;
    });
    try {
        return JSON.parse(singleQuoteCleaned);
    }
    catch {
        // Continue to control character repairs
    }
    // 6. Handle unescaped control characters inside string literals (common in multiline code snippets)
    let inString = false;
    let isEscaped = false;
    let buf = "";
    for (let i = 0; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (inString) {
            if (isEscaped) {
                buf += ch;
                isEscaped = false;
            }
            else if (ch === "\\") {
                buf += ch;
                isEscaped = true;
            }
            else if (ch === '"') {
                buf += ch;
                inString = false;
            }
            else if (ch === "\n") {
                buf += "\\n";
            }
            else if (ch === "\r") {
                buf += "\\r";
            }
            else if (ch === "\t") {
                buf += "\\t";
            }
            else {
                buf += ch;
            }
        }
        else {
            if (ch === '"') {
                inString = true;
            }
            buf += ch;
        }
    }
    try {
        return JSON.parse(buf);
    }
    catch {
        // Fall back to original attempt to trigger standard SyntaxError
        return JSON.parse(str);
    }
}
/**
 * Normalizes tool arguments, unwrapping nested wrapper payloads (input, parameters, args)
 * and repairing malformed JSON strings.
 */
function normalizeToolArgs(args) {
    if (typeof args === "string") {
        try {
            const parsed = repairJson(args);
            return normalizeToolArgs(parsed);
        }
        catch {
            return args;
        }
    }
    if (typeof args === "object" && args !== null) {
        if (args.input && typeof args.input === "object" && !Array.isArray(args.input) && Object.keys(args).length === 1) {
            args = args.input;
        }
        else if (args.parameters && typeof args.parameters === "object" && !Array.isArray(args.parameters) && Object.keys(args).length === 1) {
            args = args.parameters;
        }
        else if (args.args && typeof args.args === "object" && !Array.isArray(args.args) && Object.keys(args).length === 1) {
            args = args.args;
        }
        return JSON.stringify(args);
    }
    return JSON.stringify(args || {});
}
/**
 * Extracts balanced JSON substrings containing tool definitions from unstructured text.
 */
function extractBalancedJsonObjects(text) {
    const results = [];
    let depth = 0;
    let startIdx = -1;
    let inString = false;
    let isEscaped = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (isEscaped) {
                isEscaped = false;
            }
            else if (ch === "\\") {
                isEscaped = true;
            }
            else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
        }
        else if (ch === "{") {
            if (depth === 0) {
                startIdx = i;
            }
            depth++;
        }
        else if (ch === "}") {
            depth--;
            if (depth === 0 && startIdx !== -1) {
                const candidate = text.slice(startIdx, i + 1);
                try {
                    const parsed = repairJson(candidate);
                    if (parsed && typeof parsed === "object" && (parsed.name || parsed.tool || parsed.action)) {
                        results.push({ raw: candidate, start: startIdx, end: i + 1, parsed });
                    }
                }
                catch {
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
export function parseModelResponse(message) {
    const toolCalls = [];
    let thoughtText = typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
            ? JSON.stringify(message.content)
            : "";
    let reasoningText = undefined;
    // 1. Extract DeepSeek R1 / thinking tags: <think>...</think> and <thought>...</thought>
    const thinkRegex = /<(?:think|thought)>([\s\S]*?)<\/(?:think|thought)>/gi;
    const thinkMatches = [];
    let match;
    while ((match = thinkRegex.exec(thoughtText)) !== null) {
        if (match[1].trim()) {
            thinkMatches.push(match[1].trim());
        }
    }
    if (thinkMatches.length > 0) {
        reasoningText = thinkMatches.join("\n\n");
        const remainingText = thoughtText.replace(thinkRegex, "").trim();
        thoughtText = remainingText ? `${reasoningText}\n\n${remainingText}` : reasoningText;
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
    let xmlMatch;
    while ((xmlMatch = xmlRegex.exec(thoughtText)) !== null) {
        const raw = xmlMatch[1].trim();
        try {
            const parsed = repairJson(raw);
            const name = parsed.name || parsed.tool || parsed.function;
            const args = parsed.arguments || parsed.parameters || parsed.args || {};
            if (name) {
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
        catch {
            // Ignore invalid JSON inside tool_call tag
        }
    }
    if (toolCalls.length > 0) {
        thoughtText = thoughtText.replace(xmlRegex, "").trim();
        return { thoughtText, reasoningText, toolCalls };
    }
    // 4. Try Markdown code blocks: ```json { "name": "...", "arguments": { ... } } ```
    const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    let blockMatch;
    while ((blockMatch = codeBlockRegex.exec(thoughtText)) !== null) {
        const raw = blockMatch[1].trim();
        try {
            const parsed = repairJson(raw);
            if (typeof parsed === "object" && parsed !== null) {
                const name = parsed.name || parsed.tool || parsed.action;
                const args = parsed.arguments || parsed.parameters || parsed.args || parsed.input;
                if (name && typeof name === "string") {
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
        }
        catch {
            // Not a valid tool call code block
        }
    }
    if (toolCalls.length > 0) {
        thoughtText = thoughtText.replace(codeBlockRegex, "").trim();
        return { thoughtText, reasoningText, toolCalls };
    }
    // 5. Try embedded balanced JSON objects in text (e.g. model generates explanation + raw JSON without markdown)
    const balancedObjects = extractBalancedJsonObjects(thoughtText);
    if (balancedObjects.length > 0) {
        for (const item of balancedObjects) {
            const name = item.parsed.name || item.parsed.tool || item.parsed.action;
            const args = item.parsed.arguments || item.parsed.parameters || item.parsed.args || item.parsed.input;
            if (name && typeof name === "string") {
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
    // 6. Rescue tool call if accidentally placed inside DeepSeek <think> reasoning
    if (reasoningText && toolCalls.length === 0) {
        const thinkBalanced = extractBalancedJsonObjects(reasoningText);
        if (thinkBalanced.length > 0) {
            for (const item of thinkBalanced) {
                const name = item.parsed.name || item.parsed.tool;
                const args = item.parsed.arguments || item.parsed.parameters || item.parsed.args;
                if (name && typeof name === "string") {
                    toolCalls.push({
                        id: `call_${Math.random().toString(36).substring(2, 9)}`,
                        type: "function",
                        function: {
                            name,
                            arguments: normalizeToolArgs(args),
                        },
                    });
                    reasoningText = reasoningText.replace(item.raw, "").trim();
                }
            }
        }
    }
    return { thoughtText, reasoningText, toolCalls };
}
