/**
 * JSON for records a later decision rests on. `JSON.parse` keeps the last of two equal keys, so a record can show one
 * value to a reader that scans the text and another to the program; this parser refuses a repeated key, and bounds
 * nesting. Everything else is RFC 8259 as `JSON.parse` reads it.
 */

export class StrictJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrictJsonError";
  }
}

export const STRICT_JSON_MAX_DEPTH = 32;

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const SPACE = /[ \t\n\r]*/y;

/** Parses `text` as one JSON value. Throws `StrictJsonError` on a syntax error, a repeated key or too deep a nesting. */
export function parseStrictJson(text: string, maxDepth: number = STRICT_JSON_MAX_DEPTH): unknown {
  let at = 0;
  const fail = (what: string): never => {
    throw new StrictJsonError(`${what} at offset ${at}`);
  };
  const skip = () => {
    SPACE.lastIndex = at;
    SPACE.exec(text);
    at = SPACE.lastIndex;
  };
  const token = (pattern: RegExp): string | undefined => {
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (!match) return undefined;
    at = pattern.lastIndex;
    return match[0];
  };
  const string = (): string => {
    const raw = token(STRING);
    return raw === undefined ? fail("invalid string") : (JSON.parse(raw) as string);
  };
  const value = (depth: number): unknown => {
    if (depth > maxDepth) fail(`nesting deeper than ${maxDepth}`);
    skip();
    const c = text[at];
    if (c === "{") {
      at++;
      // Entries, not assignment: a key named `__proto__` stays an own property.
      const entries: Array<[string, unknown]> = [];
      const seen = new Set<string>();
      skip();
      if (text[at] === "}") { at++; return {}; }
      for (;;) {
        skip();
        const key = string();
        if (seen.has(key)) throw new StrictJsonError(`duplicate key '${key}'`);
        seen.add(key);
        skip();
        if (text[at] !== ":") fail("expected ':'");
        at++;
        entries.push([key, value(depth + 1)]);
        skip();
        if (text[at] === ",") { at++; continue; }
        if (text[at] === "}") { at++; return Object.fromEntries(entries); }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      at++;
      const items: unknown[] = [];
      skip();
      if (text[at] === "]") { at++; return items; }
      for (;;) {
        items.push(value(depth + 1));
        skip();
        if (text[at] === ",") { at++; continue; }
        if (text[at] === "]") { at++; return items; }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') return string();
    for (const [word, literal] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, at)) { at += word.length; return literal; }
    }
    const number = token(NUMBER);
    return number === undefined ? fail("unexpected token") : Number(number);
  };
  const result = value(1);
  skip();
  if (at !== text.length) fail("unexpected text after the value");
  return result;
}
