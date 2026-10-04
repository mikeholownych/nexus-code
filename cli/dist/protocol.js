import { redactSecrets } from "./ui.js";
export const PROTOCOL_VERSION = 1;
export const MAX_TEXT_FIELD = 8000;
export const MAX_SUMMARY = 160;
export class ProtocolError extends Error {
    id;
    constructor(message, id) {
        super(message);
        this.id = id;
        this.name = "ProtocolError";
    }
}
export function encodeEvent(event) {
    return JSON.stringify({ v: PROTOCOL_VERSION, ...event }) + "\n";
}
export function parseCommand(line) {
    let raw;
    try {
        raw = JSON.parse(line);
    }
    catch {
        throw new ProtocolError("line is not valid JSON");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new ProtocolError("message must be a JSON object");
    const msg = raw;
    const id = typeof msg.id === "string" && msg.id ? msg.id : undefined;
    if (msg.v !== PROTOCOL_VERSION)
        throw new ProtocolError(`unsupported protocol version: ${String(msg.v)}`, id);
    const requireId = (type) => {
        if (!id)
            throw new ProtocolError(`${type} requires id`);
        return id;
    };
    switch (msg.type) {
        case "prompt.submit": {
            const requestId = requireId("prompt.submit");
            const text = msg.text;
            if (typeof text !== "string" || !text.trim())
                throw new ProtocolError("prompt.submit requires non-empty text", requestId);
            return { type: "prompt.submit", id: requestId, text };
        }
        case "cancel":
            return { type: "cancel" };
        case "approve":
            return { type: "approve", id: requireId("approve"), always: msg.always === true };
        case "deny":
            return { type: "deny", id: requireId("deny") };
        case "slash": {
            const requestId = requireId("slash");
            const command = msg.command;
            if (typeof command !== "string" || !command.trim())
                throw new ProtocolError("slash requires command", requestId);
            return { type: "slash", id: requestId, command, args: typeof msg.args === "string" ? msg.args : "" };
        }
        case "shutdown":
            return { type: "shutdown" };
        default:
            throw new ProtocolError(`unknown message type: ${String(msg.type)}`, id);
    }
}
export function capText(text, max = MAX_TEXT_FIELD) {
    if (text.length <= max)
        return text;
    return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}
export function toolSubject(args) {
    const subject = args.path ?? args.file_path ?? args.command ?? args.url ?? args.query ?? args.name ?? "";
    return redactSecrets(String(subject)).replace(/\s+/g, " ").trim().slice(0, 200);
}
/** Copy of a turn with secrets redacted from its free-text fields; enums, counts, ids and hashes are left as-is. */
export function projectTurn(turn) {
    const redactOptional = (text) => (text === undefined ? undefined : redactSecrets(text));
    return {
        ...turn,
        detail: redactOptional(turn.detail),
        verification: turn.verification ? { ...turn.verification, command: redactOptional(turn.verification.command) } : null,
        interruption: turn.interruption ? { ...turn.interruption, outstandingTool: redactOptional(turn.interruption.outstandingTool) } : null,
        inferenceFailure: turn.inferenceFailure ? { ...turn.inferenceFailure, message: redactSecrets(turn.inferenceFailure.message) } : null,
    };
}
export function toolSummary(success, output, error) {
    const text = redactSecrets(success ? output || "" : error || output || "").trim();
    const first = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? (success ? "Completed" : "Tool failed");
    return { summary: first.replace(/\s+/g, " ").slice(0, MAX_SUMMARY), lines: text ? text.split(/\r?\n/).length : 0 };
}
