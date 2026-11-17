/**
 * Reading paths out of a unified diff: Git's C-quoted paths, `a/` and `b/` prefixes, rename headers, and the list of
 * every file a diff touches. Shared by the independent-review gate and the boundary check.
 */

/**
 * Reads one path token as Git writes it: either bare, or C-quoted ("a/\303\251.ts", with \t, \", \\ and octal
 * byte escapes) when the path contains non-ASCII bytes, tabs, quotes or backslashes. Returns the decoded path and
 * the text after the token.
 */
function readGitPath(text: string): { path: string; rest: string } | undefined {
  if (!text.startsWith('"')) return undefined;
  const bytes: number[] = [];
  const named: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      return { path: Buffer.from(bytes).toString("utf-8"), rest: text.slice(i + 1) };
    }
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf-8"));
      continue;
    }
    const next = text[++i];
    if (next === undefined) return undefined;
    if (/[0-7]/.test(next)) {
      const octal = text.slice(i, i + 3);
      if (!/^[0-7]{3}$/.test(octal)) return undefined;
      bytes.push(parseInt(octal, 8));
      i += 2;
    } else if (next in named) {
      bytes.push(named[next]);
    } else {
      return undefined;
    }
  }
  return undefined; // unterminated quote
}

/** Strips the a/ or b/ prefix Git adds; /dev/null means "no file on this side". */
export function diffSidePath(raw: string, prefix: "a/" | "b/"): string | undefined {
  const path = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  return path === "/dev/null" || path === "dev/null" || raw === "/dev/null" ? undefined : path;
}

/** Parses the path written after `---`/`+++`/`rename from`/`rename to`, quoted or bare (bare runs to end of line). */
export function headerPath(text: string): string | undefined {
  if (text.startsWith('"')) return readGitPath(text)?.path;
  const bare = text.replace(/\t.*$/, ""); // GNU diff may append a tab and timestamp
  return bare || undefined;
}

/**
 * Lists every file a unified diff touches, on both sides of renames, from `diff --git`, `---`/`+++` and
 * `rename from`/`rename to` headers. Handles Git's C-quoted paths and bare paths containing spaces.
 * A header that cannot be parsed yields a sentinel entry so the scope check fails closed instead of skipping it.
 */
export function extractModifiedFilesFromDiff(diff: string): string[] {
  const modified = new Set<string>();
  const add = (p: string | undefined) => {
    if (p) modified.add(p);
  };
  // File headers (---/+++/rename) only appear outside a hunk. A hunk's `@@ -a,b +c,d @@` line says exactly how many
  // old and new lines follow, so those lines are consumed by count: a removed line "-- note" is written "--- note"
  // and an added "++ note" is written "+++ note", and neither is a path. A count that is omitted means 1.
  let inHeader = true;
  let oldLeft = 0;
  let newLeft = 0;
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (oldLeft > 0 || newLeft > 0) {
      // A file header pair followed by a hunk header cannot be hunk content (a body line never starts with "@@"), so a
      // hunk whose counts overstate its body must not swallow the next file's headers.
      if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ") && lines[i + 2]?.startsWith("@@")) {
        oldLeft = 0;
        newLeft = 0;
      } else if (line.startsWith("\\")) continue; // "\ No newline at end of file"
      if (line.startsWith(" ") || line === "") {
        oldLeft = Math.max(0, oldLeft - 1);
        newLeft = Math.max(0, newLeft - 1);
        continue;
      }
      if (line.startsWith("-") && oldLeft > 0) {
        oldLeft--;
        continue;
      }
      if (line.startsWith("+") && newLeft > 0) {
        newLeft--;
        continue;
      }
      // The hunk ended earlier than its header promised: read this line as structure, not content.
      oldLeft = 0;
      newLeft = 0;
    }
    // A plain unified diff (no "diff --git" lines) starts each later file with a "---"/"+++" pair.
    if (!inHeader && line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) inHeader = true;
    if (line.startsWith("@@")) {
      inHeader = false;
      const counts = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (counts) {
        oldLeft = counts[1] === undefined ? 1 : Number(counts[1]);
        newLeft = counts[2] === undefined ? 1 : Number(counts[2]);
      }
      continue;
    }
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      const rest = line.slice("diff --git ".length);
      if (rest.startsWith('"')) {
        const first = readGitPath(rest);
        const second = first && first.rest.startsWith(" ") ? first.rest.slice(1) : undefined;
        const b = second?.startsWith('"') ? readGitPath(second)?.path : second;
        if (!first || b === undefined) {
          add(`<unparseable diff header: ${line}>`);
          continue;
        }
        add(diffSidePath(first.path, "a/"));
        add(diffSidePath(b, "b/"));
      } else {
        // Bare: "a/<path> b/<path>". With identical sides the split point is the midpoint; otherwise the
        // ---/+++ or rename headers that follow carry the exact paths.
        const half = (rest.length - 1) / 2;
        if (Number.isInteger(half) && rest[half] === " " && rest.slice(2, half) === rest.slice(half + 3)) {
          add(diffSidePath(rest.slice(0, half), "a/"));
        } else {
          const quotedB = rest.indexOf(' "b/');
          const bareB = rest.lastIndexOf(" b/");
          const cut = quotedB >= 0 ? quotedB : bareB;
          if (cut < 0) {
            add(`<unparseable diff header: ${line}>`);
            continue;
          }
          add(diffSidePath(rest.slice(0, cut), "a/"));
          const bSide = rest.slice(cut + 1);
          add(diffSidePath(bSide.startsWith('"') ? readGitPath(bSide)?.path ?? `<unparseable diff header: ${line}>` : bSide, "b/"));
        }
      }
    } else if (!inHeader) {
      continue;
    } else if (line.startsWith("--- ")) {
      const p = headerPath(line.slice(4));
      add(p === undefined ? `<unparseable diff header: ${line}>` : diffSidePath(p, "a/"));
    } else if (line.startsWith("+++ ")) {
      const p = headerPath(line.slice(4));
      add(p === undefined ? `<unparseable diff header: ${line}>` : diffSidePath(p, "b/"));
    } else if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      const p = headerPath(line.replace(/^rename (?:from|to) /, ""));
      add(p ?? `<unparseable diff header: ${line}>`);
    }
  }
  return Array.from(modified);
}
