/**
 * What a delete approval shows: the path, what is there (file, directory, link), its size, the entry count of a
 * directory, and a bounded look at the content or listing, so the operator sees what a delete removes the way a write
 * shows its diff.
 *
 * Reads only inside the workspace, and never follows a symlink: the target is reached through the real path of its
 * parent directory and looked at with `lstat`, a directory is walked without entering links, and a file is opened
 * with `O_NOFOLLOW` for at most `DELETE_PEEK_BYTES`. All the work is bounded by the limits below.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { redactSecrets } from "./ui.js";

/** Directory entries counted before the walk stops and the count is reported as a lower bound. */
export const DELETE_VISIT_LIMIT = 2000;
/** Names of a directory's entries listed. */
export const DELETE_LISTING_ROWS = 12;
/** Lines of a file's start shown, and the bytes read to find them. */
export const DELETE_PEEK_LINES = 12;
export const DELETE_PEEK_BYTES = 4096;
const ROW_CHARS = 160;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** What Rust's `str::trim` strips (Unicode White_Space): the engine trims the path this way before it resolves it. */
const RUST_TRIM = /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
/** One row of text: tabs as spaces, every control, line break and bidirectional override replaced by a visible mark, so a name or a line of content can never start another row or hide what a row says. */
const flat = (text: string) => text.replace(/\t/g, "    ").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "\u{fffd}");
const cut = (text: string) => (text.length > ROW_CHARS ? `${flat(text.slice(0, ROW_CHARS))}…` : flat(text));
const inside = (root: string, candidate: string) => candidate === root || candidate.startsWith(root + path.sep);

interface Walk {
  files: number;
  folders: number;
  links: number;
  others: number;
  bytes: number;
  listing: string[];
  counted: number;
  truncated: boolean;
  unreadable: boolean;
}

/** Depth-first, names in order; links and special files are counted and listed, never entered or sized. */
function walk(dir: string, limit: number): Walk {
  const out: Walk = { files: 0, folders: 0, links: 0, others: 0, bytes: 0, listing: [], counted: 0, truncated: false, unreadable: false };
  const stack: Array<{ abs: string; rel: string }> = [{ abs: dir, rel: "" }];
  while (stack.length > 0 && !out.truncated) {
    const { abs, rel } = stack.pop()!;
    let entries: fs.Dirent[] = [];
    let handle: fs.Dir | undefined;
    try {
      // A directory swapped for a link since it was listed is not entered; only as many entries are read as can still be counted.
      if (!fs.lstatSync(abs).isDirectory()) continue;
      handle = fs.opendirSync(abs);
      for (let read = 0; read <= limit - out.counted; read++) {
        const entry = handle.readSync();
        if (!entry) break;
        entries.push(entry);
      }
    } catch {
      out.unreadable = true;
    } finally {
      try { handle?.closeSync(); } catch { /* nothing to release */ }
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const children: Array<{ abs: string; rel: string }> = [];
    for (const entry of entries) {
      if (out.counted >= limit) {
        out.truncated = true;
        break;
      }
      out.counted++;
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      const here = path.join(abs, entry.name);
      let label = name;
      if (entry.isDirectory()) {
        out.folders++;
        label = `${name}/`;
        children.push({ abs: here, rel: name });
      } else if (entry.isFile()) {
        out.files++;
        try {
          out.bytes += fs.lstatSync(here).size;
        } catch {
          out.unreadable = true;
        }
      } else if (entry.isSymbolicLink()) {
        out.links++;
        label = `${name} (link)`;
      } else {
        out.others++;
        label = `${name} (special file)`;
      }
      if (out.listing.length < DELETE_LISTING_ROWS) out.listing.push(label);
    }
    // Depth first, in name order: the first child is visited next.
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
  }
  return out;
}

/** The first lines of a regular file, read without following a link and at most DELETE_PEEK_BYTES. */
function peek(file: string, size: number): string[] {
  if (size === 0) return ["(empty file)"];
  let descriptor: number | undefined;
  try {
    // O_NONBLOCK: a file swapped for a FIFO since the lstat must not hang the sidecar; fstat then refuses anything but a file.
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(descriptor).isFile()) return ["content not shown"];
    const buffer = Buffer.alloc(Math.min(size, DELETE_PEEK_BYTES));
    const read = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, read);
    if (bytes.includes(0)) return ["binary content not shown"];
    const more = size > read;
    // A key cut off by the read has no END line for the redaction to match: nothing of it after its BEGIN line is shown.
    const text = bytes.toString("utf-8");
    const begin = text.search(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/);
    let lines = redactSecrets(begin >= 0 && !/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(text.slice(begin)) ? `${text.slice(0, begin)}[private key not shown]` : text).split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    else if (more && lines.length > 1) lines.pop(); // the read ended inside a line
    const rows = lines.slice(0, DELETE_PEEK_LINES).map((row) => `▎ ${cut(row)}`);
    if (more || lines.length > DELETE_PEEK_LINES) rows.push("… more content not shown");
    return rows;
  } catch {
    return ["content could not be read"];
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* nothing to release */ }
  }
}

/**
 * Human text for the delete approval; never throws. It follows `delete_file` in core/src/file_ops.rs: the path is
 * trimmed and its backslashes are slashes; an absolute path is canonicalised (a link is followed to what it points to);
 * a relative path keeps its final link, which must resolve inside the workspace, outside `.git`, and not to the
 * workspace root; a directory (or a link to one) needs `recursive`; removing a link removes the link only.
 */
export function describeDeletion(workspace: string, args: Record<string, any>, limit = DELETE_VISIT_LIMIT): string {
  const given = typeof args.path === "string" ? args.path : "";
  const clean = given.replace(RUST_TRIM, "").replace(/\\/g, "/");
  const shown = cut(given);
  const recursive = args.recursive === true;
  const header = [shown || "(no path given)"];
  const refused = (why: string) => [...header, `${why} · the delete will be refused. Nothing there is shown.`].join("\n");
  const missing = () => [...header, "does not exist · the delete will fail."].join("\n");
  try {
    const root = fs.realpathSync(workspace);
    const outsideText = (rel: string) => rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    const hasGit = (target: string) => path.relative(root, target).split(path.sep).includes(".git");
    let target: string;
    if (!clean) return refused("no path given, or outside the workspace");
    if (path.isAbsolute(clean)) {
      // The engine canonicalises an absolute path: what it names is the real file or folder, never a link.
      let real: string;
      try { real = fs.realpathSync(clean); } catch { return refused("outside the workspace, or not there"); }
      if (!inside(root, real)) return refused("outside the workspace");
      target = real;
    } else {
      const lexical = path.resolve(root, clean);
      if (outsideText(path.relative(root, lexical))) return refused("outside the workspace");
      const shownRel = path.relative(root, lexical);
      if (clean.replace(/^\.\//, "") !== shownRel) header.push(`resolves to ${cut(shownRel)}`);
      let parent: string;
      try { parent = fs.realpathSync(path.dirname(lexical)); } catch { return missing(); }
      if (!inside(root, parent)) return refused("outside the workspace (through a link)");
      target = path.join(parent, path.basename(lexical));
    }
    if (target === root) return refused("the workspace itself");
    let stat: fs.Stats;
    try { stat = fs.lstatSync(target); } catch { return missing(); }
    if (hasGit(target)) return refused("inside .git");
    if (stat.isSymbolicLink()) {
      let real: string;
      try { real = fs.realpathSync(target); } catch { return missing(); }
      if (!inside(root, real)) return refused("a link that points outside the workspace");
      if (real === root) return refused("a link to the workspace itself");
      if (hasGit(real)) return refused("a link into .git");
      const pointsTo = fs.readlinkSync(target);
      const folder = fs.statSync(real).isDirectory();
      if (folder && !recursive) return [...header, `symbolic link -> ${cut(pointsTo)}`, "This will be refused: a directory needs recursive=true, and the model did not set it."].join("\n");
      return [...header, `symbolic link -> ${cut(pointsTo)}`, `Only the link is removed; the ${folder ? "folder" : "file"} it points to stays.`].join("\n");
    }
    if (stat.isFile()) {
      return [...header, `file · ${formatBytes(stat.size)}`, "Only this file is removed.", ...(stat.size === 0 ? [] : ["start of the file:"]), ...peek(target, stat.size)].join("\n");
    }
    if (stat.isDirectory()) {
      const found = walk(target, limit);
      const parts = [
        found.files ? plural(found.files, "file") : "",
        found.folders ? plural(found.folders, "folder") : "",
        found.links ? plural(found.links, "link") : "",
        found.others ? plural(found.others, "special file") : "",
      ].filter(Boolean);
      const count = found.truncated ? `at least ${limit} entries` : plural(found.counted, "entry", "entries");
      const lines = [
        ...header,
        `directory · ${count}${parts.length ? ` (${parts.join(", ")})` : ""} · ${formatBytes(found.bytes)}${found.truncated ? "+" : ""}`,
        recursive ? "Everything inside it is removed. Links inside are removed, not followed." : "This will be refused: a directory needs recursive=true, and the model did not set it.",
      ];
      if (found.unreadable) lines.push("some entries could not be read, so the count may be low");
      if (found.listing.length > 0) lines.push("contents:", ...found.listing.map((name) => `▎ ${cut(name)}`));
      const unlisted = found.counted - found.listing.length;
      if (found.truncated) lines.push(`… and more entries not listed (the count stopped at ${limit})`);
      else if (unlisted > 0) lines.push(`… ${unlisted} more entries not listed`);
      return lines.join("\n");
    }
    return [...header, "special file (not a regular file or folder) · contents are not shown."].join("\n");
  } catch {
    return [shown || "(no path given)", "could not be inspected · the delete will still be attempted as written."].join("\n");
  }
}
