/**
 * Untrusted HTML to readable text (CodeQL remediation for js/bad-tag-filter
 * and js/incomplete-multi-character-sanitization).
 *
 * Fetch and search results are reduced to plain text before they reach the
 * model. Regex-based tag filters are bypassable (nested or malformed tags can
 * reassemble after stripping) and the patterns themselves are pathological
 * shapes, so extraction happens in one linear scan instead:
 * - `<script>`/`<style>` elements are dropped with their contents (per HTML5
 *   raw-text semantics the contents end at the first matching close tag).
 * - Every remaining tag is dropped by a character scanner, so a `<` that
 *   opens anything tag-like is never emitted; a stray `<` before whitespace
 *   or a digit stays literal text.
 * - A fixed entity set is decoded afterwards, with `&amp;` decoded last so
 *   double-encoded input stays literal.
 */

const RAW_TEXT_ELEMENTS = ["script", "style"] as const;

function isTagNameStart(input: string, i: number): boolean {
  return /[a-zA-Z]/.test(input[i]);
}

/** True when input.startsWith(tag, i) and the tag name ends there. */
function matchesTagName(input: string, i: number, tag: string): boolean {
  if (input.slice(i, i + tag.length).toLowerCase() !== tag) return false;
  const next = input[i + tag.length];
  return next === undefined || next === ">" || /[\s/]/.test(next);
}

function findTagEnd(input: string, from: number): number {
  return input.indexOf(">", from);
}

/** Next closing tag whose name is exactly `tag` (a spec boundary follows the name). */
function findRawTextClose(lower: string, tag: string, from: number): number {
  const needle = `</${tag}`;
  let at = lower.indexOf(needle, from);
  while (at >= 0) {
    const after = lower[at + needle.length];
    if (after === undefined || after === ">" || after === "/" || /\s/.test(after)) return at;
    at = lower.indexOf(needle, at + 1);
  }
  return -1;
}

export function htmlToText(input: string): string {
  const lower = input.toLowerCase();
  let out = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch !== "<") {
      out += ch;
      i += 1;
      continue;
    }
    // A "<" only starts a tag before a letter, "/", "!" or "?".
    const next = input[i + 1];
    const tagLike = next !== undefined && (isTagNameStart(input, i + 1) || next === "/" || next === "!" || next === "?");
    if (!tagLike) {
      out += ch;
      i += 1;
      continue;
    }
    // Raw-text elements: drop the open tag, its contents, and its close tag.
    let dropped = false;
    for (const tag of RAW_TEXT_ELEMENTS) {
      if (next === "/" || !matchesTagName(input, i + 1, tag)) continue;
      const openEnd = findTagEnd(input, i + 1);
      if (openEnd < 0) return collapse(out); // unterminated tag: drop the rest
      const close = findRawTextClose(lower, tag, openEnd + 1);
      if (close < 0) return collapse(out); // unterminated element: drop the rest
      const closeEnd = findTagEnd(input, close + 2 + tag.length);
      i = closeEnd < 0 ? input.length : closeEnd + 1;
      out += " ";
      dropped = true;
      break;
    }
    if (dropped) continue;
    const tagEnd = findTagEnd(input, i + 1);
    if (tagEnd < 0) return collapse(out); // unterminated tag: drop the rest
    out += " ";
    i = tagEnd + 1;
  }
  return collapse(out);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode a fixed entity set; `&amp;` runs last so `&amp;lt;` stays literal. */
export function decodeHtmlEntities(text: string): string {
  let decoded = text.replace(/&#(x[0-9a-fA-F]+|[0-9]+);/g, (match, code: string) => {
    const value = code[0] === "x" || code[0] === "X" ? parseInt(code.slice(1), 16) : parseInt(code, 10);
    if (!Number.isInteger(value) || value < 9 || value > 0x10ffff) return match;
    try {
      return String.fromCodePoint(value);
    } catch {
      return match;
    }
  });
  for (const [name, value] of Object.entries(NAMED_ENTITIES)) {
    decoded = decoded.replaceAll(`&${name};`, value);
  }
  decoded = decoded.replaceAll("&amp;", "&");
  return decoded;
}

/** htmlToText plus entity decoding; tags never survive into the result. */
export function htmlToReadableText(input: string): string {
  return decodeHtmlEntities(htmlToText(input));
}
