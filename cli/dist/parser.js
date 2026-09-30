export function parseModelResponse(message) {
    const toolCalls = [];
    let thoughtText = typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
            ? JSON.stringify(message.content)
            : "";
    // 1. If standard OpenAI function calling tool_calls are present:
    if (message.tool_calls && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        for (const tc of message.tool_calls) {
            toolCalls.push(tc);
        }
        return { thoughtText, toolCalls };
    }
    if (!thoughtText) {
        return { thoughtText: "", toolCalls: [] };
    }
    // 2. Try XML style fallback: <tool_call> ... </tool_call>
    const xmlRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
    let xmlMatch;
    while ((xmlMatch = xmlRegex.exec(thoughtText)) !== null) {
        const raw = xmlMatch[1].trim();
        try {
            const parsed = JSON.parse(raw);
            const name = parsed.name || parsed.tool || parsed.function;
            const args = parsed.arguments || parsed.parameters || parsed.args || {};
            if (name) {
                toolCalls.push({
                    id: `call_${Math.random().toString(36).substring(2, 9)}`,
                    type: "function",
                    function: {
                        name,
                        arguments: typeof args === "string" ? args : JSON.stringify(args),
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
        return { thoughtText, toolCalls };
    }
    // 3. Try Markdown code blocks: ```json { "name": "...", "arguments": { ... } } ```
    const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    let blockMatch;
    while ((blockMatch = codeBlockRegex.exec(thoughtText)) !== null) {
        const raw = blockMatch[1].trim();
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed === "object" && parsed !== null) {
                const name = parsed.name || parsed.tool || parsed.action;
                const args = parsed.arguments || parsed.parameters || parsed.args || parsed.input;
                if (name && typeof name === "string") {
                    toolCalls.push({
                        id: `call_${Math.random().toString(36).substring(2, 9)}`,
                        type: "function",
                        function: {
                            name,
                            arguments: typeof args === "string" ? args : JSON.stringify(args || {}),
                        },
                    });
                }
            }
        }
        catch {
            // Not a JSON tool block
        }
    }
    if (toolCalls.length > 0) {
        thoughtText = thoughtText.replace(codeBlockRegex, "").trim();
        return { thoughtText, toolCalls };
    }
    // 4. Try raw JSON object at start or end of text
    const trimmed = thoughtText.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
            const parsed = JSON.parse(trimmed);
            const name = parsed.name || parsed.tool;
            const args = parsed.arguments || parsed.parameters || {};
            if (name) {
                toolCalls.push({
                    id: `call_${Math.random().toString(36).substring(2, 9)}`,
                    type: "function",
                    function: {
                        name,
                        arguments: typeof args === "string" ? args : JSON.stringify(args),
                    },
                });
                thoughtText = "";
            }
        }
        catch {
            // Regular text starting with { and ending with }
        }
    }
    return { thoughtText, toolCalls };
}
