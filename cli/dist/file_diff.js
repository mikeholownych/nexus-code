/**
 * Per-operation file diffs: the content of a file just before a file-edit tool ran and just after it succeeded.
 * Diffing the operation's own before/after (never `git diff`) keeps changes that were already in the working tree
 * out of what is attributed to the agent.
 */
import * as fs from "node:fs";
import * as path from "node:path";
/** Files larger than this are not snapshotted; the change is reported without line detail. */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
/** Above this many lines on either side the diff falls back to a whole-file replacement hunk. */
const MAX_DIFF_LINES = 20_000;
const CONTEXT = 3;
/** Tools whose successful result changes exactly the file named by their `path` argument. */
export const FILE_EDIT_TOOLS = new Set(["write_file", "edit_file", "patch_file", "delete_file"]);
export function editTarget(tool, args, workspace) {
    if (!FILE_EDIT_TOOLS.has(tool))
        return undefined;
    const raw = args.path ?? args.file_path ?? args.target_file;
    if (typeof raw !== "string" || !raw.trim())
        return undefined;
    return path.resolve(workspace, raw);
}
export function snapshot(file) {
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile())
            return { state: "unreadable", reason: "not a regular file" };
        if (stat.size > MAX_SNAPSHOT_BYTES)
            return { state: "unreadable", reason: `larger than ${MAX_SNAPSHOT_BYTES} bytes` };
        const buffer = fs.readFileSync(file);
        if (buffer.includes(0))
            return { state: "unreadable", reason: "binary content" };
        return { state: "text", content: buffer.toString("utf8") };
    }
    catch (err) {
        if (err?.code === "ENOENT")
            return { state: "absent" };
        return { state: "unreadable", reason: err?.code ?? "unreadable" };
    }
}
/** The change one operation made, or undefined when the file is byte-identical before and after. */
export function describeChange(displayPath, before, after) {
    if (before.state === "absent" && after.state === "absent")
        return undefined;
    if (before.state === "text" && after.state === "text" && before.content === after.content)
        return undefined;
    const kind = before.state === "absent" ? "added" : after.state === "absent" ? "deleted" : "modified";
    if (before.state === "unreadable" || after.state === "unreadable") {
        const reason = before.state === "unreadable" ? before.reason : after.reason;
        return { kind, added: 0, removed: 0, diff: "", note: `no line detail: ${reason}` };
    }
    const oldText = before.state === "text" ? before.content : "";
    const newText = after.state === "text" ? after.content : "";
    return unifiedDiff(displayPath, oldText, newText, kind);
}
function splitLines(text) {
    if (!text)
        return [];
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "")
        lines.pop();
    return lines;
}
/** Myers O(ND) shortest edit script over lines. */
function diffLines(a, b) {
    const n = a.length;
    const m = b.length;
    if (n + m > MAX_DIFF_LINES * 2 || n > MAX_DIFF_LINES || m > MAX_DIFF_LINES) {
        return [...a.map((line) => ({ kind: "-", line })), ...b.map((line) => ({ kind: "+", line }))];
    }
    const max = n + m;
    const offset = max;
    const v = new Int32Array(2 * max + 2);
    const trace = [];
    let found = false;
    for (let d = 0; d <= max && !found; d++) {
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[offset + k] = x;
            if (x >= n && y >= m) {
                found = true;
                break;
            }
        }
    }
    // Backtrack through the saved frontiers.
    const ops = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
        const frontier = trace[d];
        const k = x - y;
        const prevK = k === -d || (k !== d && frontier[offset + k - 1] < frontier[offset + k + 1]) ? k + 1 : k - 1;
        const prevX = frontier[offset + prevK];
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
            ops.push({ kind: " ", line: a[x - 1] });
            x--;
            y--;
        }
        if (d > 0) {
            if (x === prevX)
                ops.push({ kind: "+", line: b[y - 1] });
            else
                ops.push({ kind: "-", line: a[x - 1] });
        }
        x = prevX;
        y = prevY;
    }
    return ops.reverse();
}
export function unifiedDiff(displayPath, oldText, newText, kind = "modified") {
    const a = splitLines(oldText);
    const b = splitLines(newText);
    const ops = diffLines(a, b);
    const added = ops.filter((op) => op.kind === "+").length;
    const removed = ops.filter((op) => op.kind === "-").length;
    const header = [
        kind === "added" ? "--- /dev/null" : `--- a/${displayPath}`,
        kind === "deleted" ? "+++ /dev/null" : `+++ b/${displayPath}`,
    ];
    const hunks = [];
    let i = 0;
    // Line numbers before each op.
    const oldNo = [];
    const newNo = [];
    let o = 1;
    let nn = 1;
    for (const op of ops) {
        oldNo.push(o);
        newNo.push(nn);
        if (op.kind !== "+")
            o++;
        if (op.kind !== "-")
            nn++;
    }
    while (i < ops.length) {
        if (ops[i].kind === " ") {
            i++;
            continue;
        }
        let start = Math.max(0, i - CONTEXT);
        let end = i;
        // Extend while changes are within 2*CONTEXT of each other.
        while (end < ops.length) {
            if (ops[end].kind !== " ") {
                end++;
                continue;
            }
            let run = 0;
            while (end + run < ops.length && ops[end + run].kind === " ")
                run++;
            if (end + run >= ops.length || run > CONTEXT * 2) {
                end = Math.min(ops.length, end + Math.min(run, CONTEXT));
                break;
            }
            end += run;
        }
        const slice = ops.slice(start, end);
        const oldCount = slice.filter((op) => op.kind !== "+").length;
        const newCount = slice.filter((op) => op.kind !== "-").length;
        const oldStart = oldCount === 0 ? oldNo[start] - 1 : oldNo[start];
        const newStart = newCount === 0 ? newNo[start] - 1 : newNo[start];
        hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
        for (const op of slice)
            hunks.push(`${op.kind}${op.line}`);
        i = end;
        start = end;
    }
    const noNewline = (text) => text.length > 0 && !text.endsWith("\n");
    if (noNewline(oldText) !== noNewline(newText) && hunks.length)
        hunks.push("\\ No newline at end of file (one side)");
    return { kind, added, removed, diff: hunks.length ? [...header, ...hunks].join("\n") : "" };
}
/** At most `maxLines` lines / `maxChars` characters of a diff, and whether it was cut. */
export function previewDiff(diff, maxLines = 40, maxChars = 6000) {
    const lines = diff ? diff.split("\n") : [];
    let out = "";
    let count = 0;
    for (const line of lines) {
        if (count >= maxLines || out.length + line.length + 1 > maxChars)
            break;
        out += (count ? "\n" : "") + line;
        count++;
    }
    return { preview: out, truncated: count < lines.length, totalLines: lines.length };
}
