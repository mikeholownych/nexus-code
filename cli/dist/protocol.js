import { redactSecrets } from "./ui.js";
import { visibleControls } from "./file_diff.js";
export const PROTOCOL_VERSION = 1;
export const MAX_TEXT_FIELD = 8000;
export const MAX_SUMMARY = 160;
export const MAX_SLASH_OUTPUT = 32_000;
/** Lines of a file diff shown in the transcript; the full diff is in the tool call's detail record. */
export const DIFF_PREVIEW_LINES = 40;
export const DIFF_PREVIEW_CHARS = 6000;
export class ProtocolError extends Error {
    id;
    constructor(message, id) {
        super(message);
        this.id = id;
        this.name = "ProtocolError";
    }
}
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** Truncation can split a surrogate pair; a lone surrogate would serialize as JSON the client cannot decode. */
export function encodeEvent(event) {
    const wellFormed = (_key, value) => (typeof value === "string" ? value.replace(LONE_SURROGATE, "\uFFFD") : value);
    return JSON.stringify({ v: PROTOCOL_VERSION, ...event }, wellFormed) + "\n";
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
        case "steer": {
            const requestId = requireId("steer");
            const text = msg.text;
            if (typeof text !== "string" || !text.trim())
                throw new ProtocolError("steer requires non-empty text", requestId);
            return { type: "steer", id: requestId, text };
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
        case "tool.detail": {
            const requestId = requireId("tool.detail");
            const evidence = msg.evidence;
            if (typeof evidence !== "string" || !evidence)
                throw new ProtocolError("tool.detail requires evidence", requestId);
            return { type: "tool.detail", id: requestId, evidence };
        }
        case "receipt":
            return { type: "receipt", id: requireId("receipt") };
        case "models.list":
            return { type: "models.list", id: requireId("models.list") };
        case "model.select": {
            const requestId = requireId("model.select");
            if (typeof msg.provider !== "string" || !msg.provider || typeof msg.model !== "string" || !msg.model.trim()) {
                throw new ProtocolError("model.select requires provider and model", requestId);
            }
            return { type: "model.select", id: requestId, provider: msg.provider, model: msg.model };
        }
        case "provider.connect": {
            const requestId = requireId("provider.connect");
            if (typeof msg.provider !== "string" || !msg.provider || typeof msg.method !== "string" || !msg.method) {
                throw new ProtocolError("provider.connect requires provider and method", requestId);
            }
            if (msg.key !== undefined && typeof msg.key !== "string")
                throw new ProtocolError("provider.connect key must be a string", requestId);
            return { type: "provider.connect", id: requestId, provider: msg.provider, method: msg.method, ...(typeof msg.key === "string" ? { key: msg.key } : {}) };
        }
        case "provider.cancel":
            return { type: "provider.cancel", id: requireId("provider.cancel") };
        case "provider.disconnect": {
            const requestId = requireId("provider.disconnect");
            if (typeof msg.provider !== "string" || !msg.provider)
                throw new ProtocolError("provider.disconnect requires provider", requestId);
            return { type: "provider.disconnect", id: requestId, provider: msg.provider };
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
/** CSI sequences, OSC sequences (BEL or ST terminated), then the remaining two-character escapes. */
const TERMINAL_ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[0-~]/g;
export function stripEscapes(text) {
    return text.replace(TERMINAL_ESCAPE, "");
}
export function toolSubject(args) {
    const subject = args.path ?? args.file_path ?? args.command ?? args.url ?? args.query ?? args.name ?? "";
    return redactSecrets(stripEscapes(String(subject))).replace(/\s+/g, " ").trim().slice(0, 200);
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
        ...(turn.providerRecovery
            ? {
                providerRecovery: turn.providerRecovery.map((r) => ({
                    ...r,
                    reason: redactOptional(r.reason),
                    submissions: r.submissions.map((s) => ({ ...s, message: redactSecrets(s.message) })),
                })),
            }
            : {}),
    };
}
/** One-line operator notice for a provider recovery transition; PROBING produces none. */
export function providerRecoveryNotice(record, discardedPartialOutput) {
    const last = record.submissions[record.submissions.length - 1];
    const condition = record.condition.toLowerCase().replace(/_/g, " ");
    const discarded = discardedPartialOutput ? " The partial response was discarded." : "";
    switch (record.state) {
        case "WAITING": {
            const secs = record.nextAttemptAt ? Math.max(0, Math.round((Date.parse(record.nextAttemptAt) - Date.parse(record.updatedAt)) / 1000)) : 0;
            return `Inference provider ${condition} (${last?.httpStatus ? `HTTP ${last.httpStatus}` : last?.kind ?? "failure"}); waiting ${secs}s before checking again. Work is preserved.${discarded}`;
        }
        case "RESUMED":
            return `Inference provider recovered after ${Math.round(record.waitedMs / 1000)}s; step ${record.step} resumed.`;
        case "PROBING":
            return undefined;
        default:
            return redactSecrets(`Provider recovery ${record.state.toLowerCase()}: ${record.reason ?? condition}`);
    }
}
/** Lines of a command's output carried in `tool.end` for the transcript preview. */
export const TOOL_PREVIEW_LINES = 8;
/**
 * What the transcript shows for a finished tool. A command's JSON result (`stdout`, `stderr`, `exit_code`) becomes a
 * real summary (`exit 0 · 122 lines`, or `no output`), the count of its output lines and a bounded preview of them;
 * other tools keep the first line of their output (or error) as the summary.
 */
export function toolSummary(success, output, error) {
    const command = commandResult(output);
    if (command) {
        const body = [command.stdout.trimEnd(), command.stderr.trimEnd()].filter(Boolean).join("\n");
        const rows = body ? body.split(/\r?\n/) : [];
        const exit = command.timed_out ? "timed out" : command.exit_code === null ? "no exit code" : `exit ${command.exit_code}`;
        const failure = success ? "" : (error ?? "").split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
        const summary = failure && !failure.startsWith("{") ? failure : `${exit} · ${rows.length ? `${rows.length} line${rows.length === 1 ? "" : "s"}` : "no output"}`;
        return {
            summary: redactSecrets(stripEscapes(summary)).replace(/\s+/g, " ").slice(0, MAX_SUMMARY),
            lines: rows.length,
            preview: (rows.length > TOOL_PREVIEW_LINES ? rows.slice(-TOOL_PREVIEW_LINES) : rows).map((row) => visibleControls(redactSecrets(row)).slice(0, 400)).join("\n"),
            exit_code: command.exit_code,
            ...(command.duration_ms !== undefined ? { duration_ms: command.duration_ms } : {}),
            ...(command.timed_out ? { timed_out: true } : {}),
        };
    }
    const text = redactSecrets(stripEscapes(success ? output || "" : error || output || "")).trim();
    const first = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? (success ? "Completed" : "Tool failed");
    return { summary: first.replace(/\s+/g, " ").slice(0, MAX_SUMMARY), lines: text ? text.split(/\r?\n/).length : 0 };
}
/** The structured result of a shell command tool, when `output` is one. */
function commandResult(output) {
    if (!output || output.trimStart()[0] !== "{")
        return undefined;
    try {
        const parsed = JSON.parse(output);
        if (parsed && typeof parsed === "object" && typeof parsed.stdout === "string" && "exit_code" in parsed) {
            return {
                stdout: parsed.stdout,
                stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
                exit_code: typeof parsed.exit_code === "number" ? parsed.exit_code : null,
                ...(typeof parsed.duration_ms === "number" ? { duration_ms: parsed.duration_ms } : {}),
                ...(parsed.timed_out === true ? { timed_out: true } : {}),
            };
        }
    }
    catch { }
    return undefined;
}
