/**
 * Names that come from a repository (file names, plugin and hook names, error text) on their way to the operator's
 * terminal. A name may hold an escape sequence that moves the cursor and rewrites what was printed, a newline that
 * starts a line of its own, or a bidirectional control that reorders what is read. Such characters are shown as
 * `\uXXXX`, never sent, and the text is bounded.
 */

// C0 and C1 controls, DEL, line and paragraph separators, zero-width and bidirectional formatting characters.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/** `text` with every control and formatting character written out as `\uXXXX`, cut to `limit` characters. */
export function printable(text: unknown, limit = 300): string {
  const shown = String(text).replace(UNPRINTABLE, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return shown.length > limit ? `${shown.slice(0, limit - 1)}…` : shown;
}

/** Whether `text` holds a character `printable` would write out. */
export function hasUnprintable(text: string): boolean {
  UNPRINTABLE.lastIndex = 0;
  return UNPRINTABLE.test(text);
}
