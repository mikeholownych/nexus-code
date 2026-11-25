/**
 * Names that come from a repository (file names, plugin and hook names, error text) on their way to the operator's
 * terminal. A name may hold an escape sequence that moves the cursor and rewrites what was printed, a newline that
 * starts a line of its own, or a bidirectional control that reorders what is read. Such characters are shown as
 * `\uXXXX`, never sent, and the text is bounded. This is the one place that says which characters those are.
 */

// C0 and C1 controls and DEL; the soft hyphen; bidirectional controls (U+061C, U+200E/F, U+202A-E, U+2066-9);
// zero-width and other format characters (U+200B-D, U+2060-5, U+FEFF); line and paragraph separators; interlinear
// annotation (U+FFF9-B); the tag block (U+E0000-E007F); and surrogates that are not half of a pair.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]|\p{Cs}/gu;

const escaped = (character: string): string => {
  const code = character.codePointAt(0)!;
  return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
};

/** `text` with every control and formatting character written out as `\uXXXX`, cut to `limit` characters. */
export function printable(text: unknown, limit = 300): string {
  const shown = String(text).replace(UNPRINTABLE, escaped);
  return shown.length > limit ? `${shown.slice(0, limit - 1)}…` : shown;
}

/** `text` with every such character replaced by a space: for text that is folded into one line anyway. */
export function withoutUnprintable(text: string): string {
  return text.replace(UNPRINTABLE, " ");
}

/** Whether `text` holds a character `printable` would write out. */
export function hasUnprintable(text: string): boolean {
  UNPRINTABLE.lastIndex = 0;
  return UNPRINTABLE.test(text);
}
