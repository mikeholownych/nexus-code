/**
 * GV-1: the parser for managed policy files. It accepts a deliberately small subset of TOML and rejects everything
 * else with the line number and a message a person can act on. A policy file restricts what Nexus may do, so a
 * construct this parser does not understand must never be skipped or guessed at: the whole file is refused.
 *
 * Accepted:
 *   - UTF-8 text, LF or CRLF line ends, no byte-order mark, no control character other than tab;
 *   - blank lines and `#` comments (a whole line, or after a value or a table header);
 *   - `key = value` lines, at the root (before any table) or inside a table;
 *   - `[table]` headers, one level deep;
 *   - keys and table names of the form [a-z][a-z0-9_]*;
 *   - values: a basic string "..." on one line with only the escapes \" and \\; `true` or `false`; a non-negative
 *     decimal whole number; an array of basic strings (it may span lines; a trailing comma and comments are allowed).
 *
 * Everything else is an error: literal ('...') and multi-line strings, any other escape, floats, signs, hex, digit
 * separators, dates, inline tables, dotted or quoted keys, arrays of tables, nested or mixed arrays, a duplicate key or
 * table, anything after a value except a comment, and anything over the limits below.
 *
 * The parser knows nothing about the policy schema: it returns the root keys and the tables with a line number per
 * key. `validatePolicyDocument` in managed_policy.ts decides which tables and keys exist. It throws only
 * `PolicyParseError`, for any input, and always terminates: every loop consumes at least one character.
 */

/** The bounds of a policy file. Each has its own error code. */
export const POLICY_TOML_LIMITS = {
  /** Largest file, in bytes of UTF-8. */
  fileBytes: 64 * 1024,
  /** Longest string value, in characters (UTF-16 code units). */
  stringChars: 1024,
  /** Most items in one array. */
  arrayItems: 500,
} as const;

export type PolicyParseCode =
  | "file_too_large"
  | "string_too_long"
  | "array_too_long"
  | "bom"
  | "control_character"
  | "invalid_unicode"
  | "duplicate_key"
  | "duplicate_table"
  | "unsupported"
  | "syntax";

/** The one error this module throws. `message` is `line N: <detail>`; `detail` has no trailing period. */
export class PolicyParseError extends Error {
  constructor(
    public readonly line: number,
    public readonly code: PolicyParseCode,
    public readonly detail: string,
  ) {
    super(`line ${line}: ${detail}`);
    this.name = "PolicyParseError";
  }
}

export type PolicyTomlValue = string | boolean | number | string[];

export interface PolicyTomlEntry {
  value: PolicyTomlValue;
  /** The line of the key, 1-based. */
  line: number;
  /** For an array: the line of each item. */
  itemLines?: number[];
}

export interface PolicyTomlTable {
  /** The line of the `[table]` header. */
  line: number;
  entries: Map<string, PolicyTomlEntry>;
}

/** Maps, not objects: a key such as `constructor` is a legal name and must not meet an object prototype. */
export interface PolicyTomlDocument {
  root: Map<string, PolicyTomlEntry>;
  tables: Map<string, PolicyTomlTable>;
}

const KEY = /^[a-z][a-z0-9_]*$/;
const WHOLE_NUMBER = /^(?:0|[1-9][0-9]*)$/;

/** A piece of the input quoted in a message: short, so one bad line cannot produce a huge error. */
function shown(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}...` : text;
}

/** Parses the text of a policy file. Throws `PolicyParseError`. */
export function parsePolicyToml(text: string): PolicyTomlDocument {
  if (typeof text !== "string") throw new PolicyParseError(1, "syntax", "the policy text is not a string");
  // A string is never shorter in UTF-8 bytes than in code units, so the first test bounds the second.
  if (text.length > POLICY_TOML_LIMITS.fileBytes || Buffer.byteLength(text, "utf8") > POLICY_TOML_LIMITS.fileBytes) {
    throw new PolicyParseError(1, "file_too_large", "the file is larger than 64 KiB");
  }
  if (text.charCodeAt(0) === 0xfeff) {
    throw new PolicyParseError(1, "bom", "the file starts with a byte-order mark; save it as UTF-8 without a BOM");
  }
  const length = text.length;

  // One pass over the characters before any structure is read, so a control character is reported as what it is.
  for (let i = 0, at = 1; i < length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a) {
      at++;
    } else if (code === 0x0d) {
      if (text.charCodeAt(i + 1) !== 0x0a) throw new PolicyParseError(at, "control_character", "a carriage return that is not part of a CRLF line end");
    } else if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
      throw new PolicyParseError(at, "control_character", `control character U+${code.toString(16).toUpperCase().padStart(4, "0")}; only tab is allowed`);
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new PolicyParseError(at, "invalid_unicode", "text that is not valid Unicode (an unpaired surrogate)");
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new PolicyParseError(at, "invalid_unicode", "text that is not valid Unicode (an unpaired surrogate)");
    }
  }

  let pos = 0;
  let line = 1;
  const fail = (code: PolicyParseCode, detail: string, at = line): never => {
    throw new PolicyParseError(at, code, detail);
  };
  const atLineEnd = (): boolean => pos >= length || text[pos] === "\n" || text[pos] === "\r";
  const skipSpaces = (): void => {
    while (pos < length && (text[pos] === " " || text[pos] === "\t")) pos++;
  };
  const skipComment = (): void => {
    if (text[pos] === "#") while (!atLineEnd()) pos++;
  };
  /** Consumes one line end (the pre-pass guarantees a `\r` is followed by `\n`). */
  const consumeLineEnd = (): void => {
    if (pos >= length) return;
    if (text[pos] === "\r") pos++;
    pos++;
    line++;
  };
  const finishLine = (after: string): void => {
    skipSpaces();
    skipComment();
    if (!atLineEnd()) fail("syntax", `unexpected text after ${after} ('${shown(text.slice(pos, text.indexOf("\n", pos) === -1 ? length : text.indexOf("\n", pos)).trimEnd())}'); only a # comment may follow`);
  };

  const readName = (what: "key" | "table name"): string => {
    if (text[pos] === '"' || text[pos] === "'") fail("unsupported", `quoted ${what}s are not supported; write the ${what} bare`);
    const start = pos;
    while (pos < length && /[A-Za-z0-9_-]/.test(text[pos])) pos++;
    const name = text.slice(start, pos);
    if (name === "") fail("syntax", pos < length && !atLineEnd() ? `expected a ${what}, found '${shown(text[pos])}'` : `expected a ${what}`);
    if (!KEY.test(name)) fail("syntax", `invalid ${what} '${shown(name)}': use lowercase letters, digits and '_', starting with a letter`);
    return name;
  };

  const readString = (): string => {
    if (text.startsWith('"""', pos)) fail("unsupported", 'multi-line strings (""") are not supported; write the string on one line');
    pos++; // the opening quote
    let value = "";
    for (;;) {
      if (atLineEnd()) fail("syntax", "unterminated string: a string must close with \" on the line it starts on");
      const c = text[pos];
      if (c === '"') {
        pos++;
        return value;
      }
      if (c === "\\") {
        const escaped = text[pos + 1];
        if (escaped !== '"' && escaped !== "\\") {
          fail("unsupported", `unsupported escape '\\${escaped === undefined || escaped === "\n" || escaped === "\r" ? "" : escaped}' in a string; only \\" and \\\\ are accepted`);
        }
        value += escaped;
        pos += 2;
      } else {
        value += c;
        pos++;
      }
      if (value.length > POLICY_TOML_LIMITS.stringChars) fail("string_too_long", `a string is longer than ${POLICY_TOML_LIMITS.stringChars} characters`);
    }
  };

  const readArray = (): { value: string[]; itemLines: number[] } => {
    const opened = line;
    pos++; // the opening bracket
    const value: string[] = [];
    const itemLines: number[] = [];
    const skipFiller = (): void => {
      for (;;) {
        skipSpaces();
        skipComment();
        if (pos < length && atLineEnd()) consumeLineEnd();
        else return;
      }
    };
    for (;;) {
      skipFiller();
      if (pos >= length) fail("syntax", `unterminated array: no closing ']' for the array opened on line ${opened}`);
      const c = text[pos];
      if (c === "]") {
        pos++;
        return { value, itemLines };
      }
      if (c === "[") fail("unsupported", "nested arrays are not supported; an array holds strings only");
      if (c === "{") fail("unsupported", "inline tables are not supported; an array holds strings only");
      if (c === "'") fail("unsupported", "literal strings ('...') are not supported; use a basic string \"...\"");
      if (c === ",") fail("syntax", "unexpected ',' in an array: an item is missing before it");
      if (c !== '"') fail("unsupported", "an array may hold only strings (\"...\"); found another kind of value");
      itemLines.push(line);
      value.push(readString());
      if (value.length > POLICY_TOML_LIMITS.arrayItems) fail("array_too_long", `an array has more than ${POLICY_TOML_LIMITS.arrayItems} items`);
      skipFiller();
      if (pos >= length) fail("syntax", `unterminated array: no closing ']' for the array opened on line ${opened}`);
      if (text[pos] === ",") pos++;
      else if (text[pos] !== "]") fail("syntax", "expected ',' or ']' after an array item");
    }
  };

  const readValue = (key: string): { value: PolicyTomlValue; itemLines?: number[] } => {
    if (atLineEnd()) fail("syntax", `missing value after '${key} ='`);
    const c = text[pos];
    if (c === '"') return { value: readString() };
    if (c === "'") fail("unsupported", "literal strings ('...') are not supported; use a basic string \"...\"");
    if (c === "[") return readArray();
    if (c === "{") fail("unsupported", "inline tables are not supported; use a [table] header");
    const start = pos;
    while (pos < length && /[A-Za-z0-9_+\-.:]/.test(text[pos])) pos++;
    const token = text.slice(start, pos);
    if (token === "") fail("syntax", `unsupported value starting with '${shown(c)}': expected a "string", true, false, a whole number or an array of strings`);
    if (token === "true") return { value: true };
    if (token === "false") return { value: false };
    if (WHOLE_NUMBER.test(token)) {
      const number = Number(token);
      if (!Number.isSafeInteger(number)) fail("unsupported", `the number ${shown(token)} is too large`);
      return { value: number };
    }
    if (/^[+-]?(?:inf|nan)$/.test(token)) fail("unsupported", "floats (inf, nan) are not supported; use a non-negative whole number");
    if (/^[+-]/.test(token)) fail("unsupported", `signed numbers are not supported ('${shown(token)}'); use a non-negative whole number`);
    if (/^[0-9]/.test(token)) {
      if (/^0[xob]/.test(token)) fail("unsupported", `hexadecimal, octal and binary numbers are not supported ('${shown(token)}'); use a decimal whole number`);
      if (/^[0-9]{4}-[0-9]{2}/.test(token) || token.includes(":")) fail("unsupported", `dates and times are not supported ('${shown(token)}')`);
      if (token.includes("_")) fail("unsupported", `digit separators are not supported ('${shown(token)}'); write the number without '_'`);
      if (/[.eE]/.test(token)) fail("unsupported", `floats are not supported ('${shown(token)}'); use a non-negative whole number`);
      if (/^0[0-9]+$/.test(token)) fail("unsupported", `a number may not start with a zero ('${shown(token)}')`);
    }
    return fail("syntax", `unsupported value '${shown(token)}': expected a "string", true, false, a whole number or an array of strings`);
  };

  const root = new Map<string, PolicyTomlEntry>();
  const tables = new Map<string, PolicyTomlTable>();
  let current = root;
  let currentTable: string | undefined;

  while (pos < length) {
    skipSpaces();
    if (atLineEnd()) {
      consumeLineEnd();
      continue;
    }
    if (text[pos] === "#") {
      skipComment();
      continue;
    }
    if (text[pos] === "[") {
      if (text[pos + 1] === "[") fail("unsupported", "arrays of tables ([[...]]) are not supported");
      pos++;
      skipSpaces();
      const name = readName("table name");
      skipSpaces();
      if (text[pos] === ".") fail("unsupported", "dotted table names (nested tables) are not supported; tables are one level deep");
      if (text[pos] !== "]") fail("syntax", `expected ']' to close the table header '[${name}'`);
      pos++;
      const earlier = tables.get(name);
      if (earlier) fail("duplicate_table", `duplicate table '[${name}]' (first defined on line ${earlier.line}); merge the two into one`);
      const rootKey = root.get(name);
      if (rootKey) fail("duplicate_table", `table '[${name}]' has the name of a key set on line ${rootKey.line}`);
      const table: PolicyTomlTable = { line, entries: new Map() };
      tables.set(name, table);
      current = table.entries;
      currentTable = name;
      finishLine("the table header");
      continue;
    }
    const keyLine = line;
    const key = readName("key");
    skipSpaces();
    if (text[pos] === ".") fail("unsupported", "dotted keys are not supported; put the key under a [table] header");
    if (text[pos] !== "=") fail("syntax", `expected '=' after the key '${key}'`);
    pos++;
    skipSpaces();
    const full = currentTable ? `${currentTable}.${key}` : key;
    const earlier = current.get(key);
    if (earlier) fail("duplicate_key", `duplicate key '${full}' (first set on line ${earlier.line}); a key may be set once`, keyLine);
    const parsed = readValue(key);
    current.set(key, { value: parsed.value, line: keyLine, ...(parsed.itemLines ? { itemLines: parsed.itemLines } : {}) });
    finishLine("the value");
  }
  return { root, tables };
}

/** A basic string as this parser reads it back. For a writer of policy text (the tests' round trip, and later a `policy show`). */
export function renderPolicyTomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
