import { capText, stripEscapes } from "./protocol.js";
import { redactSecrets } from "./ui.js";
export const MAX_DETAIL = 64_000;
export const MAX_EVIDENCE = 200;
/**
 * Pretty JSON with each string value redacted before encoding: quoting turns `KEY="value"` into `KEY=\"value\"`
 * and escapes into literal `\u001b`, both of which a pass over the encoded text misses.
 */
export function redactedJson(value) {
    const json = JSON.stringify(value ?? {}, (_key, v) => (typeof v === "string" ? redactSecrets(stripEscapes(v)) : v), 2);
    return redactSecrets(json);
}
function clean(text) {
    return capText(redactSecrets(stripEscapes(text)), MAX_DETAIL);
}
/** The latest tool calls of this session; the oldest is dropped first. */
export class EvidenceLedger {
    limit;
    now;
    records = new Map();
    seq = 0;
    constructor(limit = MAX_EVIDENCE, now = Date.now) {
        this.limit = limit;
        this.now = now;
    }
    start(turnId, tool, subject, args) {
        const evidence = `e${++this.seq}`;
        this.records.set(evidence, {
            evidence,
            turnId,
            tool,
            subject,
            args: clean(redactedJson(args)),
            status: "running",
            output: "",
            startedAt: this.now(),
            durationMs: null,
        });
        for (const oldest of this.records.keys()) {
            if (this.records.size <= this.limit)
                break;
            this.records.delete(oldest);
        }
        return evidence;
    }
    end(evidence, success, output, error) {
        const record = this.records.get(evidence);
        if (!record)
            return;
        const parts = success || !error || error === output ? [output] : [output, error];
        record.status = success ? "succeeded" : "failed";
        record.output = clean(parts.filter(Boolean).join("\n"));
        record.durationMs = Math.max(0, this.now() - record.startedAt);
    }
    get(evidence) {
        return this.records.get(evidence);
    }
}
export function receiptSections(last, receipt) {
    return [turnSection(last), verifierSection(last?.turn ?? null), validationSection(receipt)];
}
function turnSection(last) {
    if (!last)
        return { title: "Last turn", rows: [], note: "No turn has finished in this session yet." };
    const t = last.turn;
    const rows = [
        ["result", clean(last.heading)],
        ["execution", t.execution],
        ["outcome", t.outcome],
    ];
    if (t.reason)
        rows.push(["reason", t.reason]);
    if (t.detail)
        rows.push(["detail", clean(t.detail)]);
    rows.push(["steps", `${t.steps.used} of ${t.steps.max}${t.steps.limitReached ? " · limit reached" : ""}`]);
    rows.push(["model stop", t.modelStop]);
    if (t.interruption) {
        rows.push(["interrupted", `during ${t.interruption.phase.replace(/_/g, " ")}`]);
        if (t.interruption.outstandingTool)
            rows.push(["outstanding", clean(t.interruption.outstandingTool)]);
    }
    if (t.inferenceFailure) {
        const failure = t.inferenceFailure;
        rows.push(["inference", `${failure.kind} (${failure.origin}): ${clean(failure.message)}`]);
    }
    if (t.unverifiedChangesPending)
        rows.push(["pending", "workspace changes that no passing verifier run covers"]);
    rows.push(["finished", t.finishedAt]);
    return { title: "Last turn", rows };
}
function verifierSection(turn) {
    const v = turn?.verification;
    if (!v)
        return { title: "Verifier", rows: [], note: turn ? "No verifier ran for this turn." : "Nothing to report until a turn finishes." };
    const rows = [["status", v.status]];
    if (v.command)
        rows.push(["command", clean(v.command)]);
    if (v.source)
        rows.push(["source", v.source]);
    if (v.exitSuccess !== undefined)
        rows.push(["exit", v.exitSuccess ? "success" : "failure"]);
    if (v.outputSha256)
        rows.push(["output sha256", v.outputSha256]);
    if (v.candidateId)
        rows.push(["candidate", v.candidateId]);
    rows.push(["at", v.at]);
    return { title: "Verifier", rows };
}
function validationSection(receipt) {
    if (!receipt) {
        return {
            title: "Validation receipt",
            rows: [],
            note: "No validation receipt is active. Authoritative verifier runs (--authoritative-verifier) record one.",
        };
    }
    const rows = [
        ["status", receipt.status],
        ["receipt", receipt.receiptId],
        ["command", clean(receipt.verifierCommand)],
        ["exit code", String(receipt.exitCode)],
        ["stdout sha256", receipt.stdoutHash],
        ["candidate", receipt.candidateId],
        ["recorded", receipt.timestamp],
    ];
    if (receipt.invalidationReason) {
        rows.push(["invalidated", `${clean(receipt.invalidationReason)}${receipt.invalidatedAt ? ` (${receipt.invalidatedAt})` : ""}`]);
    }
    return { title: "Validation receipt", rows };
}
/** The sections as plain text, for clients without the receipt panel. */
export function receiptText(sections) {
    return sections
        .map((s) => [s.title, ...s.rows.map(([label, value]) => `  ${label.padEnd(14)}${value}`), ...(s.note ? [`  ${s.note}`] : [])].join("\n"))
        .join("\n\n");
}
