import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Imports nest at most this deep (the instruction file itself is depth 0). */
export const MAX_IMPORT_DEPTH = 5;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;

export interface ExpandedRules {
  /** The instruction text with `@path` imports replaced by the imported files' contents. */
  text: string;
  /** Workspace-relative paths of the imported files that were read, in load order (the root file is not listed). */
  imports: string[];
}

/** `@path` at the start of a token; the path must contain a dot or a slash so `@mentions` are left alone. Linear: no nested quantifiers. */
const IMPORT_TOKEN = /(^|[\s(])@([A-Za-z0-9_.\-/~]+)/g;

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Expand `@path` imports in a project instruction file. Imports resolve against the importing file's directory,
 * must stay inside the workspace by real path (symlinks included), must be regular files, are read once each,
 * and nest at most MAX_IMPORT_DEPTH levels. Text inside code fences and inline code is never treated as an import.
 * Anything that cannot be imported is left as the literal text. `trusted` false disables expansion entirely.
 */
export function expandImports(rootFile: string, content: string, workspace: string, trusted: boolean): ExpandedRules {
  const imports: string[] = [];
  if (!trusted) return { text: content, imports };
  let realWorkspace: string;
  let realRoot: string;
  try {
    realWorkspace = fs.realpathSync(workspace);
    realRoot = fs.realpathSync(rootFile);
  } catch {
    return { text: content, imports };
  }
  const seen = new Set<string>([realRoot]);
  let total = 0;

  const expand = (text: string, dir: string, depth: number): string => {
    let inFence = false;
    return text
      .split("\n")
      .map((line) => {
        if (/^\s*(```|~~~)/.test(line)) {
          inFence = !inFence;
          return line;
        }
        if (inFence) return line;
        // Even-indexed segments are outside backticks.
        return line
          .split("`")
          .map((segment, i) => (i % 2 === 1 ? segment : expandSegment(segment, dir, depth)))
          .join("`");
      })
      .join("\n");
  };

  const expandSegment = (segment: string, dir: string, depth: number): string =>
    segment.replace(IMPORT_TOKEN, (match: string, lead: string, raw: string) => {
      const rel = raw.replace(/[.,;:]+$/, "");
      const trailing = raw.slice(rel.length);
      if (!rel.includes(".") && !rel.includes("/")) return match;
      if (depth >= MAX_IMPORT_DEPTH) return match;
      let real: string;
      try {
        const target = rel.startsWith("~/")
          ? path.resolve(os.homedir(), rel.slice(2))
          : path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(dir, rel);
        real = fs.realpathSync(target);
        if (!isInside(realWorkspace, real) || !fs.statSync(real).isFile()) return match;
      } catch {
        return match;
      }
      if (seen.has(real)) return lead + trailing; // already loaded (or an import cycle): the content appears once
      let body: string;
      try {
        if (fs.statSync(real).size > MAX_FILE_BYTES || total + fs.statSync(real).size > MAX_TOTAL_BYTES) return match;
        body = fs.readFileSync(real, "utf-8");
      } catch {
        return match;
      }
      seen.add(real);
      total += Buffer.byteLength(body);
      imports.push(path.relative(realWorkspace, real));
      return lead + expand(body.trim(), path.dirname(real), depth + 1) + trailing;
    });

  return { text: expand(content, path.dirname(realRoot), 0), imports };
}
