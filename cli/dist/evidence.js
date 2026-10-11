import { capText, stripEscapes } from "./protocol.js";
import { redactSecrets } from "./ui.js";
import { requirementRows } from "./core/objective.js";
export const MAX_DETAIL = 64_000;
/** Full diffs are kept larger than other detail: inspecting the complete change is their purpose. */
export const MAX_DIFF_DETAIL = 256_000;
export const MAX_EVIDENCE = 200;
/**
 * Pretty JSON with each string value redacted before encoding: quoting turns `KEY="value"` into `KEY=\"value\"`
 * and escapes into literal `\u001b`, both of which a pass over the encoded text misses.
 */
export function redactedJson(value) {
    const json = JSON.stringify(value ?? {}, (_key, v) => (typeof v === "string" ? redactSecrets(stripEscapes(v)) : v), 2);
    return redactSecrets(json);
}
/** Tool output is usually JSON text; its string values are redacted before re-encoding, as with arguments. */
function redactedOutput(text) {
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed === "string" || (parsed !== null && typeof parsed === "object"))
            return redactedJson(parsed);
    }
    catch {
        // Plain text output.
    }
    return text;
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
        record.output = clean(parts.filter(Boolean).map(redactedOutput).join("\n"));
        record.durationMs = Math.max(0, this.now() - record.startedAt);
    }
    /** Attaches the diff of the change the call made; several files (rare) are appended in order. */
    attachDiff(evidence, diff) {
        const record = this.records.get(evidence);
        if (!record || !diff)
            return;
        const text = capText(redactSecrets(stripEscapes(diff)), MAX_DIFF_DETAIL);
        record.diff = record.diff ? capText(`${record.diff}\n${text}`, MAX_DIFF_DETAIL) : text;
    }
    get(evidence) {
        return this.records.get(evidence);
    }
}
export function receiptSections(last, receipt, objective) {
    return [turnSection(last), ...(objective ? [requirementSection(objective)] : []), verifierSection(last?.turn ?? null), validationSection(receipt)];
}
/** Requirement-level state of the operator's objective; a completed plan phase never stands in for these rows. */
function requirementSection(ledger) {
    const rows = requirementRows(ledger).map(([id, value]) => [id, clean(value)]);
    const outcome = ledger.outcome;
    if (outcome) {
        rows.push(["objective", outcome.status.toUpperCase()]);
        if (outcome.failedCheck)
            rows.push(["failed check", clean(outcome.failedCheck)]);
        if (outcome.nextAction)
            rows.push(["next action", clean(outcome.nextAction)]);
    }
    const steering = ledger.steering.filter((s) => s.status !== "cancelled");
    if (steering.length)
        rows.push(["steering", `${steering.filter((s) => s.status === "applied").length} applied, ${steering.filter((s) => s.status === "queued").length} queued`]);
    if (ledger.scopeChanges.length)
        rows.push(["scope changes", ledger.scopeChanges.map((c) => `${c.requirement} ${c.from}->${c.to}`).join(", ")]);
    const note = rows.length ? undefined : "The objective is a single request; no separate acceptance requirements were listed.";
    return { title: "Requirements", rows, ...(note ? { note } : {}) };
}
/** Receipts can be read back from state files written by older or damaged runs, so any field may be missing. */
function row(rows, label, value) {
    if (value !== null && value !== undefined)
        rows.push([label, clean(String(value))]);
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
    const rows = [];
    row(rows, "status", receipt.status);
    row(rows, "receipt", receipt.receiptId);
    row(rows, "command", receipt.verifierCommand);
    row(rows, "exit code", receipt.exitCode);
    row(rows, "stdout sha256", receipt.stdoutHash);
    row(rows, "candidate", receipt.candidateId);
    row(rows, "recorded", receipt.timestamp);
    if (receipt.invalidationReason) {
        row(rows, "invalidated", `${receipt.invalidationReason}${receipt.invalidatedAt ? ` (${receipt.invalidatedAt})` : ""}`);
    }
    return { title: "Validation receipt", rows };
}
/** The sections as plain text, for clients without the receipt panel. */
export function receiptText(sections) {
    return sections
        .map((s) => [s.title, ...s.rows.map(([label, value]) => `  ${label.padEnd(14)}${value}`), ...(s.note ? [`  ${s.note}`] : [])].join("\n"))
        .join("\n\n");
}
