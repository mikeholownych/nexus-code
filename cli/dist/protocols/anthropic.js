import { argumentsObject, num, ownedState, ProviderStreamError, stateDigest, textOf, wireToolId, } from "./common.js";
function userBlocks(content) {
    if (!Array.isArray(content)) {
        const t = textOf(content);
        return t ? [{ type: "text", text: t }] : [];
    }
    const out = [];
    for (const p of content) {
        if (typeof p === "string")
            out.push({ type: "text", text: p });
        else if (p?.type === "text" && p.text)
            out.push({ type: "text", text: p.text });
        else if (p?.type === "image_url" && typeof p.image_url?.url === "string") {
            const m = /^data:([^;]+);base64,(.*)$/s.exec(p.image_url.url);
            out.push(m ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } } : { type: "image", source: { type: "url", url: p.image_url.url } });
        }
    }
    return out;
}
/** Thinking is replayable only when the trailing assistant tool turn carries this owner's intact signed thinking. */
function trailingToolTurnHasThinking(messages, owner) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === "tool")
            continue;
        if (m.role === "assistant" && m.tool_calls?.length)
            return Boolean(ownedState(m, owner)?.length);
        return true; // not inside a tool loop: thinking may start fresh
    }
    return true;
}
export function buildAnthropicRequest(input) {
    const thinking = input.thinkingBudget !== undefined && trailingToolTurnHasThinking(input.messages, input.owner);
    const systemParts = [];
    const turns = [];
    let droppedState = 0;
    let seenNonSystem = false;
    const push = (role, blocks) => {
        if (!blocks.length)
            return;
        const last = turns[turns.length - 1];
        if (last && last.role === role)
            last.content.push(...blocks);
        else
            turns.push({ role, content: blocks });
    };
    for (const m of input.messages) {
        if (m.role === "system") {
            const t = textOf(m.content);
            if (!seenNonSystem)
                systemParts.push(t);
            else if (t)
                push("user", [{ type: "text", text: `[System notice]\n${t}` }]);
            continue;
        }
        seenNonSystem = true;
        if (m.role === "user")
            push("user", userBlocks(m.content));
        else if (m.role === "tool") {
            const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
            push("user", [{ type: "tool_result", tool_use_id: wireToolId(m.tool_call_id ?? ""), content: content || "(no output)" }]);
        }
        else {
            const blocks = [];
            const owned = ownedState(m, input.owner);
            if (m.provider_state && !owned)
                droppedState++;
            if (thinking && owned)
                blocks.push(...owned);
            const t = textOf(m.content);
            if (t.trim())
                blocks.push({ type: "text", text: t });
            for (const tc of m.tool_calls ?? []) {
                blocks.push({ type: "tool_use", id: wireToolId(tc.id), name: tc.function.name, input: argumentsObject(tc.function.arguments) });
            }
            push("assistant", blocks.length ? blocks : [{ type: "text", text: "(no content)" }]);
        }
    }
    if (turns[0]?.role !== "user")
        turns.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });
    const body = {
        model: input.model,
        max_tokens: input.maxOutputTokens,
        messages: turns,
        stream: input.stream,
    };
    const system = systemParts.filter(Boolean).join("\n\n");
    if (system)
        body.system = system;
    if (input.tools.length) {
        body.tools = input.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
    }
    if (thinking) {
        // Extended thinking requires max_tokens above the budget and does not accept a custom temperature.
        const budget = Math.max(1024, Math.min(input.thinkingBudget, input.maxOutputTokens - 1024));
        body.thinking = { type: "enabled", budget_tokens: budget };
        if (input.maxOutputTokens <= budget)
            body.max_tokens = budget + 1024;
    }
    else if (input.temperature !== undefined) {
        body.temperature = Math.min(1, Math.max(0, input.temperature));
    }
    return { path: "/messages", body, droppedState };
}
function finishOf(stop, hasTools) {
    if (stop === "max_tokens" || stop === "model_context_window_exceeded")
        return "length";
    if (stop === "refusal")
        return "refusal";
    if (stop === "tool_use" || hasTools)
        return "tool_calls";
    return "stop";
}
function usageOf(u, prev = {}) {
    if (!u || typeof u !== "object")
        return prev;
    return {
        ...prev,
        ...(num(u.input_tokens) !== undefined ? { inputTokens: u.input_tokens } : {}),
        ...(num(u.output_tokens) !== undefined ? { outputTokens: u.output_tokens } : {}),
        ...(num(u.cache_read_input_tokens) !== undefined ? { cachedInputTokens: u.cache_read_input_tokens } : {}),
        ...(num(u.cache_creation_input_tokens) !== undefined ? { cacheWriteTokens: u.cache_creation_input_tokens } : {}),
    };
}
function assemble(blocks, stop, owner, usage, id, model) {
    let text = "";
    const toolCalls = [];
    const opaque = [];
    for (const b of blocks) {
        if (b.type === "text")
            text += b.text ?? "";
        else if (b.type === "tool_use") {
            const args = typeof b.input === "object" && b.input !== null ? JSON.stringify(b.input) : (b.json || "{}");
            toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: args } });
        }
        else if (b.type === "thinking")
            opaque.push({ type: "thinking", thinking: b.thinking ?? "", signature: b.signature ?? "" });
        else if (b.type === "redacted_thinking")
            opaque.push({ type: "redacted_thinking", data: b.data });
    }
    const message = {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...(opaque.length ? { provider_state: { owner, items: opaque, digest: stateDigest(opaque) } } : {}),
    };
    return { message, finish: finishOf(stop, toolCalls.length > 0), usage, providerRequestId: id, effectiveModel: model, text };
}
export function parseAnthropicResponse(data, owner) {
    if (!data || !Array.isArray(data.content))
        throw new ProviderStreamError("Anthropic response has no content array", undefined, "", true);
    return assemble(data.content, data.stop_reason, owner, usageOf(data.usage), data.id, data.model);
}
export function anthropicStreamParser(owner, onToken) {
    const blocks = [];
    const open = new Set();
    let stop;
    let stopped = false;
    let usage;
    let id;
    let model;
    let text = "";
    return {
        text: () => text,
        event(_name, ev) {
            switch (ev?.type) {
                case "message_start":
                    id = ev.message?.id;
                    model = ev.message?.model;
                    usage = usageOf(ev.message?.usage);
                    return;
                case "content_block_start": {
                    const cb = { ...(ev.content_block ?? {}) };
                    if (cb.type === "tool_use") {
                        cb.json = "";
                        delete cb.input;
                    }
                    if (cb.type === "thinking") {
                        cb.thinking ??= "";
                        cb.signature ??= "";
                    }
                    if (cb.type === "text")
                        cb.text ??= "";
                    blocks[ev.index] = cb;
                    open.add(ev.index);
                    return;
                }
                case "content_block_delta": {
                    const b = blocks[ev.index];
                    const d = ev.delta ?? {};
                    if (!b)
                        throw new ProviderStreamError(`content_block_delta for unknown block ${ev.index}`, undefined, text, true);
                    if (d.type === "text_delta") {
                        b.text += d.text ?? "";
                        text += d.text ?? "";
                        if (d.text)
                            onToken?.(d.text);
                    }
                    else if (d.type === "input_json_delta")
                        b.json += d.partial_json ?? "";
                    else if (d.type === "thinking_delta")
                        b.thinking += d.thinking ?? "";
                    else if (d.type === "signature_delta")
                        b.signature += d.signature ?? "";
                    return;
                }
                case "content_block_stop":
                    open.delete(ev.index);
                    return;
                case "message_delta":
                    if (ev.delta?.stop_reason)
                        stop = ev.delta.stop_reason;
                    usage = usageOf(ev.usage, usage);
                    return;
                case "message_stop":
                    stopped = true;
                    return;
                case "error":
                    throw new ProviderStreamError(`Provider error frame mid-stream: ${ev.error?.message ?? JSON.stringify(ev.error)}`, ev.error?.type, text);
                default:
                    return; // ping and future event types
            }
        },
        result() {
            if (!stopped || open.size > 0) {
                return { message: { role: "assistant", content: text || null }, finish: "incomplete", usage, providerRequestId: id, effectiveModel: model, text };
            }
            for (const b of blocks) {
                if (b?.type === "tool_use") {
                    try {
                        b.input = JSON.parse(b.json || "{}");
                    }
                    catch {
                        b.input = undefined; // kept as raw text; the agent's parser reports malformed arguments, nothing runs on a guess
                    }
                }
            }
            return assemble(blocks.filter(Boolean), stop, owner, usage, id, model);
        },
    };
}
