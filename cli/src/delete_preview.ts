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
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      out.unreadable = true;
      continue;
    }
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
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(Math.min(size, DELETE_PEEK_BYTES));
    const read = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, read);
    if (bytes.includes(0)) return ["binary content not shown"];
    const more = size > read;
    let lines = redactSecrets(bytes.toString("utf-8")).split(/\r?\n/);
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

/** Human text for the delete approval; never throws. */
export function describeDeletion(workspace: string, args: Record<string, any>, limit = DELETE_VISIT_LIMIT): string {
  const given = typeof args.path === "string" ? args.path : "";
  const shown = cut(given);
  const recursive = args.recursive === true;
  try {
    const root = fs.realpathSync(workspace);
    const lexical = path.resolve(root, given);
    const rel = path.relative(root, lexical);
    const header = [shown || "(no path given)"];
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && given.replace(/^\.\//, "") !== rel) header.push(`resolves to ${cut(rel)}`);
    if (!given || !rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      return [...header, "outside the workspace, or not a file or folder inside it · the delete will be refused. Nothing there is shown."].join("\n");
    }
    let parent: string;
    try {
      parent = fs.realpathSync(path.dirname(lexical));
    } catch {
      return [...header, "does not exist · the delete will fail."].join("\n");
    }
    if (!inside(root, parent)) {
      return [...header, "outside the workspace (through a link) · the delete will be refused. Nothing there is shown."].join("\n");
    }
    const target = path.join(parent, path.basename(lexical));
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch {
      return [...header, "does not exist · the delete will fail."].join("\n");
    }
    if (stat.isSymbolicLink()) {
      let pointsTo = "";
      try { pointsTo = fs.readlinkSync(target); } catch { /* shown without it */ }
      return [...header, `symbolic link${pointsTo ? ` -> ${cut(pointsTo)}` : ""}`, "Only the link is removed; what it points to is not touched or shown."].join("\n");
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
      if (unlisted > 0 || found.truncated) lines.push(`… ${found.truncated && unlisted <= 0 ? "more" : unlisted} more entries not listed`);
      return lines.join("\n");
    }
    return [...header, "special file (not a regular file or folder) · contents are not shown."].join("\n");
  } catch {
    return [shown || "(no path given)", "could not be inspected · the delete will still be attempted as written."].join("\n");
  }
}
