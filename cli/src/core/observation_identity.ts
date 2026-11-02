import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * Resource identity of workspace file reads, independent of the interface that performed them: `read_file`,
 * `batch_read`, and a deliberately small set of shell forms (`cat F`, `head [-n N|-N] F`, `sed -n 'A,Bp' F`, each
 * optionally after `cd DIR &&`). Two reads are equivalent when they cover the same lines of the same file on the same
 * workspace state, whatever tool, argument spelling or path spelling produced them.
 *
 * Classification is conservative by construction: anything not recognised exactly (pipes, redirections, globs,
 * variables, several files, flags not listed, a path outside the workspace, byte offsets) is not a classifiable read
 * and is never judged equivalent to anything. Coverage comes from what a read actually returned (the reported line
 * range, or the lines a shell read printed), not from what was asked for.
 */

/** A read that can be judged before it runs: lines `start`..`end` (inclusive, 1-based); `end` undefined = to EOF. */
export interface ReadRequest {
  path: string;
  start: number;
  end?: number;
}

/** Lines a read actually returned, with a digest of their text. `total` is the file's line count when known. */
export interface ReadCoverage {
  path: string;
  start: number;
  end: number;
  total?: number;
  fingerprint: string;
  /**
   * The file's identity when the read ran (size, change/modification times, inode; see fileSignature). The workspace
   * state identity does not cover every file (ignored files such as logs), so coverage counts for a later read only
   * while the file's own signature is unchanged.
   */
  sig?: string;
}

/** Identity of a workspace file as it is now (size, mtime, ctime, inode), or undefined when it cannot be read. */
export function fileSignature(workspace: string, relPath: string): string | undefined {
  try {
    const st = fs.statSync(path.resolve(workspace, relPath), { bigint: true });
    if (!st.isFile()) return undefined;
    return `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`;
  } catch {
    return undefined;
  }
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

function parseArgs(args: unknown): Record<string, unknown> | undefined {
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : undefined;
}

/** Workspace-relative POSIX path, or undefined when it leaves the workspace or is empty. */
export function normalizeWorkspacePath(workspace: string, p: string, cwd = workspace): string | undefined {
  if (typeof p !== "string" || !p.trim()) return undefined;
  const root = path.resolve(workspace);
  const abs = path.resolve(cwd, p.trim());
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join("/");
}

const positive = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : undefined);

/** One shell word: bare, or wholly single- or double-quoted with no expansion characters inside. */
const WORD = String.raw`(?:'[^']*'|"[^"$\`\\]*"|[^\s'"|;&<>$\`\\(){}*?\[\]!#~]+)`;
const unquote = (w: string) => (/^(['"]).*\1$/.test(w) ? w.slice(1, -1) : w);
const CD_PREFIX = new RegExp(String.raw`^cd\s+(${WORD})\s*&&\s*`);
const CAT = new RegExp(String.raw`^cat\s+(${WORD})$`);
const HEAD = new RegExp(String.raw`^head(?:\s+(?:-n\s*(\d+)|-(\d+)))?\s+(${WORD})$`);
const SED = new RegExp(String.raw`^sed\s+-n\s+(['"]?)(\d+)(?:,(\d+))?p\1\s+(${WORD})$`);

/** The read a simple shell command performs, or undefined when it is anything else. */
export function shellReadRequest(command: string, workspace: string, cwd = workspace): (ReadRequest & { form: "cat" | "head" | "sed" }) | undefined {
  let rest = command.trim();
  let dir = cwd;
  const cd = CD_PREFIX.exec(rest);
  if (cd) {
    const target = unquote(cd[1]);
    const rel = path.resolve(cwd, target);
    const fromRoot = path.relative(path.resolve(workspace), rel);
    if (fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) return undefined;
    dir = rel;
    rest = rest.slice(cd[0].length).trim();
  }
  let m = CAT.exec(rest);
  if (m) {
    const p = normalizeWorkspacePath(workspace, unquote(m[1]), dir);
    return p ? { path: p, start: 1, form: "cat" } : undefined;
  }
  m = HEAD.exec(rest);
  if (m) {
    const n = Number(m[1] ?? m[2] ?? 10);
    const p = normalizeWorkspacePath(workspace, unquote(m[3]), dir);
    return p && n >= 1 ? { path: p, start: 1, end: n, form: "head" } : undefined;
  }
  m = SED.exec(rest);
  if (m) {
    const a = Number(m[2]);
    const b = m[3] === undefined ? a : Number(m[3]);
    const p = normalizeWorkspacePath(workspace, unquote(m[4]), dir);
    return p && a >= 1 && b >= a ? { path: p, start: a, end: b, form: "sed" } : undefined;
  }
  return undefined;
}

/**
 * The file reads a tool call would perform, or undefined when it is not a classifiable read. A call that is only
 * partly classifiable (byte offsets, several shell commands) is not classifiable.
 */
export function readRequests(name: string, rawArgs: unknown, workspace: string): ReadRequest[] | undefined {
  const args = parseArgs(rawArgs);
  if (!args) return undefined;
  if (name === "read_file") {
    if (args.offset !== undefined || args.length !== undefined) return undefined;
    const p = typeof args.path === "string" ? normalizeWorkspacePath(workspace, args.path) : undefined;
    if (!p) return undefined;
    const start = positive(args.start_line) ?? 1;
    const end = positive(args.end_line);
    if (end !== undefined && end < start) return undefined;
    return [{ path: p, start, end }];
  }
  if (name === "batch_read") {
    if (args.offset !== undefined || args.length !== undefined || !Array.isArray(args.paths) || !args.paths.length) return undefined;
    const max = positive(args.max_lines_per_file);
    const out: ReadRequest[] = [];
    for (const raw of args.paths) {
      const p = typeof raw === "string" ? normalizeWorkspacePath(workspace, raw) : undefined;
      if (!p) return undefined;
      out.push({ path: p, start: 1, end: max });
    }
    return out;
  }
  if (name === "run_command" && typeof args.command === "string") {
    if (args.cwd !== undefined && args.cwd !== "." && args.cwd !== "") return undefined;
    const req = shellReadRequest(args.command, workspace);
    return req ? [{ path: req.path, start: req.start, end: req.end }] : undefined;
  }
  return undefined;
}

/** Lines of printed text, split as the engine splits a file (`\n`, an optional `\r` before it; no trailing empty line). */
function textLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/**
 * The file lines of the engine's numbered listing (`{:>5} | line`), or undefined unless every line carries the expected
 * consecutive number from `start`. One fingerprint form for every interface: the same lines through read_file,
 * batch_read or a shell read hash the same.
 */
function numberedLines(content: string, start: number): string[] | undefined {
  const out: string[] = [];
  for (const [i, line] of textLines(content).entries()) {
    const m = /^ *(\d+) \| /.exec(line);
    if (!m || Number(m[1]) !== start + i) return undefined;
    out.push(line.slice(m[0].length));
  }
  return out;
}
const linesDigest = (lines: string[]) => digest(lines.join("\n"));

/** What a successful read actually returned, or undefined when the output cannot be attributed to line ranges. */
export function readCoverage(name: string, rawArgs: unknown, output: string, workspace: string): ReadCoverage[] | undefined {
  const requests = readRequests(name, rawArgs, workspace);
  if (!requests) return undefined;
  if (name === "read_file") {
    let parsed: any;
    try {
      parsed = JSON.parse(output);
    } catch {
      return undefined;
    }
    const start = positive(parsed?.start_line);
    const end = typeof parsed?.end_line === "number" ? parsed.end_line : undefined;
    const total = typeof parsed?.total_lines === "number" ? parsed.total_lines : undefined;
    if (typeof parsed?.content !== "string" || end === undefined || total === undefined) return undefined;
    // An empty file reports no lines: there is nothing to cover.
    if (!start || end < start) return total === 0 ? [{ path: requests[0].path, start: 1, end: 0, total: 0, fingerprint: linesDigest([]) }] : undefined;
    const got = numberedLines(parsed.content, start);
    if (!got || got.length !== end - start + 1) return undefined;
    return [{ path: requests[0].path, start, end, total, fingerprint: linesDigest(got) }];
  }
  if (name === "batch_read") {
    let parsed: any;
    try {
      parsed = JSON.parse(output);
    } catch {
      return undefined;
    }
    // A batch is one observation: if any file failed (or is missing from the result) the successful subset does not
    // stand for it, so the batch is not attributed to line ranges at all.
    if (!Array.isArray(parsed?.files) || parsed.files.length !== requests.length) return undefined;
    if (parsed.files.some((file: any) => !file?.success)) return undefined;
    const out: ReadCoverage[] = [];
    for (const [i, file] of parsed.files.entries()) {
      const req = requests[i];
      if (!req || typeof file.content !== "string") return undefined;
      const got = numberedLines(file.content, 1);
      const total = typeof file.total_lines === "number" ? file.total_lines : undefined;
      if (!got || (got.length === 0 && total !== 0)) return undefined;
      out.push({ path: req.path, start: 1, end: got.length, total, fingerprint: linesDigest(got) });
    }
    return out;
  }
  // run_command: success JSON carries the command's own stdout and exit code.
  let parsed: any;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!parsed || parsed.exit_code !== 0 || parsed.timed_out === true || typeof parsed.stdout !== "string") return undefined;
  // The engine cuts oversized output in place ("[TRUNCATED N BYTES]"): the printed lines are not the file's lines.
  if (parsed.stdout_truncated === true || parsed.truncated === true || /\[TRUNCATED \d+ BYTES\]/.test(parsed.stdout)) return undefined;
  const req = requests[0];
  const printed = textLines(parsed.stdout);
  const lines = printed.length;
  const end = req.start + lines - 1;
  // `cat` printed the whole file; `head -n N` printing fewer than N lines also reached EOF.
  const reachedEof = req.end === undefined || lines < req.end - req.start + 1;
  const total = reachedEof && req.start === 1 ? lines : undefined;
  if (lines === 0) return total === 0 ? [{ path: req.path, start: 1, end: 0, total: 0, fingerprint: linesDigest([]) }] : undefined;
  return [{ path: req.path, start: req.start, end, total, fingerprint: linesDigest(printed) }];
}

/** Merged, sorted, inclusive intervals. */
export function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = intervals.filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Whether [start, end] lies inside the union of `intervals`. */
export function covered(intervals: Array<[number, number]>, start: number, end: number): boolean {
  if (end < start) return true;
  return mergeIntervals(intervals).some(([a, b]) => a <= start && end <= b);
}

/** Whether [start, end] intersects the union of `intervals`. */
export function overlaps(intervals: Array<[number, number]>, start: number, end: number): boolean {
  return intervals.some(([a, b]) => a <= end && start <= b);
}
