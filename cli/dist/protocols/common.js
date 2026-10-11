import { createHash } from "node:crypto";
/** A provider-reported error inside a stream (or an unusable stream). The client maps it to an InferenceError. */
export class ProviderStreamError extends Error {
    errorType;
    partialText;
    malformed;
    constructor(message, errorType, partialText, malformed = false) {
        super(message);
        this.errorType = errorType;
        this.partialText = partialText;
        this.malformed = malformed;
        this.name = "ProviderStreamError";
    }
}
/**
 * Reads an SSE body, handing each complete event to `onEvent`. Handles CRLF, comments/heartbeats, multi-line data and
 * events split at any byte (including inside UTF-8 sequences). `[DONE]` sentinels are ignored.
 */
export async function readSse(body, onEvent) {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let name;
    let data = [];
    const dispatch = () => {
        if (data.length) {
            const joined = data.join("\n");
            if (joined.trim() !== "[DONE]")
                onEvent(name, joined);
        }
        name = undefined;
        data = [];
    };
    const line = (raw) => {
        const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (l === "")
            return dispatch();
        if (l.startsWith(":"))
            return;
        const colon = l.indexOf(":");
        const field = colon < 0 ? l : l.slice(0, colon);
        let value = colon < 0 ? "" : l.slice(colon + 1);
        if (value.startsWith(" "))
            value = value.slice(1);
        if (field === "event")
            name = value;
        else if (field === "data")
            data.push(value);
    };
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const l of lines)
                line(l);
        }
        buffer += decoder.decode();
        if (buffer)
            line(buffer);
        dispatch();
    }
    catch (err) {
        try {
            await reader.cancel();
        }
        catch { }
        throw err;
    }
}
export function stateDigest(items) {
    return createHash("sha256").update(JSON.stringify(items)).digest("hex");
}
/** Opaque state replayable to `owner`: same owner and unaltered since capture. */
export function ownedState(m, owner) {
    const s = m.provider_state;
    if (!s || s.owner !== owner || !Array.isArray(s.items))
        return undefined;
    return stateDigest(s.items) === s.digest ? s.items : undefined;
}
/** Tool ids must match ^[A-Za-z0-9_-]+$ for Anthropic; the mapping is deterministic so calls and results still pair. */
export function wireToolId(id) {
    const clean = (id || "call").replace(/[^A-Za-z0-9_-]/g, "_");
    return clean.slice(0, 64) || "call";
}
export function textOf(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content.map((p) => (typeof p === "string" ? p : p?.type === "text" ? p.text ?? "" : "")).join("");
    }
    return "";
}
/** Tool-call arguments as an object for protocols that take structured input; malformed text is preserved as {raw}. */
export function argumentsObject(args) {
    try {
        const v = JSON.parse(args || "{}");
        return v && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
    }
    catch {
        return { raw: args };
    }
}
export function num(v) {
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
