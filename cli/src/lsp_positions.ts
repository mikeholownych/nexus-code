/**
 * Positions between the language-server tools and a language server. Pure: no file system, no process.
 *
 * THE MODEL-FACING UNIT. In tool input and output a line is counted from 1 and a `character` / `column` is counted from
 * 1 in UNICODE CODE POINTS of that line. The reason is what the model has to count in: read_file shows a file as
 * `<line number> | <text of the line>` with no column, so a column is the model counting the characters of the text it
 * read, and one code point is the closest unit to "one character" that needs no table: an emoji outside the Basic
 * Multilingual Plane is 1 (2 in UTF-16, 4 in UTF-8), an accented letter in its usual precomposed form is 1 (2 in UTF-8).
 * Trade-offs, stated so that nobody has to find them:
 *  - a grapheme cluster is not the unit. A letter followed by a combining mark is 2, a ZWJ emoji sequence (a family, a
 *    flag) is one per code point in it. Counting clusters would need the Unicode segmentation tables, whose answers
 *    change with the Unicode version and would differ between the model's idea of a character and this client's;
 *  - a tab is 1, whatever width it is shown at;
 *  - a line ends before its terminator (`\n`, `\r\n`, or a lone `\r`, as the protocol defines lines): the terminator is
 *    not a column. A column past the end of the line is the end of the line, as the protocol says;
 *  - an unpaired surrogate (text that is not valid Unicode) is 1, and 3 bytes in UTF-8 (what it becomes when encoded).
 *
 * A server counts in the encoding negotiated at `initialize` (`negotiatedEncoding`). Every position sent is converted
 * from the model's unit with `toEncoded`, every position received with `fromEncoded` / `rangeToModel`; both need the
 * text of the line, except in UTF-32, which is the model's unit.
 */

export type PositionEncoding = "utf-8" | "utf-16" | "utf-32";

/**
 * Offered in `general.positionEncodings`, most preferred first. UTF-32 first: it counts code points, the model's unit,
 * so nothing is converted, no line text is needed and no answer is ever approximate. UTF-8 before UTF-16 only because a
 * server that offers it holds its text as UTF-8 and is spared a conversion of its own; for this client the two cost the
 * same. UTF-16 is the protocol's default and must be offered.
 */
export const OFFERED_POSITION_ENCODINGS: readonly PositionEncoding[] = ["utf-32", "utf-8", "utf-16"];

/** The encoding a server that does not name one counts in (the protocol's default). */
export const DEFAULT_POSITION_ENCODING: PositionEncoding = "utf-16";

/**
 * The encoding to use given `capabilities.positionEncoding` of the server's `initialize` result. Absent: UTF-16. A value
 * that was not offered (the protocol forbids it) is not believed: the server is treated as UTF-16, and `rejected` holds
 * what it named, for the server's status.
 */
export function negotiatedEncoding(announced: unknown): { encoding: PositionEncoding; rejected?: string } {
  if (announced === undefined || announced === null) return { encoding: DEFAULT_POSITION_ENCODING };
  const offered = OFFERED_POSITION_ENCODINGS.find((e) => e === announced);
  if (offered) return { encoding: offered };
  return { encoding: DEFAULT_POSITION_ENCODING, rejected: (typeof announced === "string" ? announced : (JSON.stringify(announced) ?? String(announced))).slice(0, 40) };
}

/** The lines of a text as the protocol divides it: at `\r\n`, `\n` and a lone `\r`. A text that ends with a terminator has an empty last line. */
export class TextLines {
  /** The offset at which each line starts. */
  private starts: number[] = [0];

  constructor(private text: string) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
      if (c === 10 || c === 13) this.starts.push(i + 1);
    }
  }

  get count(): number {
    return this.starts.length;
  }

  /** Lines as a reader counts them: the empty line after a final terminator is not one. */
  get shown(): number {
    return this.count > 1 && this.starts[this.count - 1] === this.text.length ? this.count - 1 : this.count;
  }

  /** Line `index` (from 0) without its terminator, or undefined when the text has no such line. */
  line(index: number): string | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) return undefined;
    let end = index + 1 < this.count ? this.starts[index + 1] : this.text.length;
    if (index + 1 < this.count) end -= this.text.charCodeAt(end - 1) === 10 && this.text.charCodeAt(end - 2) === 13 && end - 2 >= this.starts[index] ? 2 : 1;
    return this.text.slice(this.starts[index], end);
  }
}

/** How many units of `encoding` the code point `cp` takes. An unpaired surrogate is encoded as U+FFFD is: 3 bytes. */
function width(cp: number, encoding: PositionEncoding): number {
  if (encoding === "utf-32") return 1;
  if (encoding === "utf-16") return cp > 0xffff ? 2 : 1;
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/**
 * The offset, in units of `encoding`, of the code point at `codePoints` (from 0) in `line`. Past the end of the line:
 * the end of the line.
 */
export function toEncoded(line: string, codePoints: number, encoding: PositionEncoding): number {
  let units = 0;
  for (let i = 0, n = 0; i < line.length && n < codePoints; n++) {
    const cp = line.codePointAt(i)!;
    units += width(cp, encoding);
    i += cp > 0xffff ? 2 : 1;
  }
  return units;
}

/**
 * The index, in code points from 0, of the character at offset `units` of `encoding` in `line`. Past the end of the
 * line: the end of the line. An offset inside a character (between the halves of a surrogate pair, inside a UTF-8
 * sequence) is that character.
 */
export function fromEncoded(line: string, units: number, encoding: PositionEncoding): number {
  let n = 0;
  for (let i = 0, at = 0; i < line.length; n++) {
    const cp = line.codePointAt(i)!;
    at += width(cp, encoding);
    if (at > units) break;
    i += cp > 0xffff ? 2 : 1;
  }
  return n;
}

export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}

/**
 * A range a server sent (lines and offsets from 0, offsets in `encoding`) with its offsets in code points, still from 0.
 * `lines`: the text the range is about, or null when it could not be had. `approximate` is true when an offset was left
 * as the server gave it, as if every character before it were ASCII, because the text of its line was not there to
 * convert with: the caller must say so. Offset 0 is the same in every encoding, and UTF-32 is the model's unit, so
 * neither is ever approximate.
 */
export function rangeToModel(lines: TextLines | null, range: Range, encoding: PositionEncoding): { range: Range; approximate: boolean } {
  let approximate = false;
  const one = (p: Position): Position => {
    const text = lines?.line(p.line);
    if (text !== undefined) return { line: p.line, character: fromEncoded(text, p.character, encoding) };
    if (encoding !== "utf-32" && p.character > 0) approximate = true;
    return { line: p.line, character: p.character };
  };
  const converted = { start: one(range.start), end: one(range.end) };
  return { range: converted, approximate };
}
