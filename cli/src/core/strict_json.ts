/**
 * A strict, bounded JSON reader for files that decide what runs (hook declarations, the extension trust store):
 * `JSON.parse` keeps the last of two equal keys, so a second `"pre-tool"` further down a file would silently replace
 * the first and drop a guard. This reader refuses a duplicate key at any depth, bounds the nesting, and reports where
 * the problem is. The file open is the hardened one of the operator's `config.json` (config.ts), with the owner and
 * mode checks made optional for files whose trust comes from a content hash instead.
 */
import * as fs from "node:fs";
import { createHash } from "node:crypto";

/** Default nesting bound for records that are not hook files (matches the BG-1 reader). */
export const STRICT_JSON_MAX_DEPTH = 32;

export class StrictJsonError extends Error {
  constructor(message: string, readonly line?: number, readonly column?: number) {
    super(line === undefined ? message : `line ${line}, column ${column}: ${message}`);
    this.name = "StrictJsonError";
  }
}

/** Where each key of each parsed object was written, for messages about a key the caller rejects. */
export type KeyPositions = WeakMap<object, Map<string, { line: number; column: number }>>;

export interface StrictJsonOptions {
  /** Deepest allowed nesting of objects and arrays (the root container is depth 1). Default `STRICT_JSON_MAX_DEPTH`. */
  maxDepth?: number;
  /** Filled with the position of every object key when given. */
  positions?: KeyPositions;
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** Parses one JSON value. Throws `StrictJsonError` on a syntax error, a duplicate key or nesting past `maxDepth`. */
export function parseStrictJson(text: string, options: StrictJsonOptions | number = {}): unknown {
  const opts: StrictJsonOptions = typeof options === "number" ? { maxDepth: options } : options;
  const maxDepth = opts.maxDepth ?? STRICT_JSON_MAX_DEPTH;
  let at = 0;

  const where = (offset: number) => {
    let line = 1;
    let lineStart = 0;
    for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) {
      line++;
      lineStart = i + 1;
    }
    return { line, column: offset - lineStart + 1 };
  };
  const fail = (message: string, offset = at): never => {
    const { line, column } = where(offset);
    throw new StrictJsonError(message, line, column);
  };
  const skip = () => {
    while (at < text.length && WHITESPACE.has(text[at])) at++;
  };

  const string = (): string => {
    const start = at++;
    let out = "";
    for (;;) {
      if (at >= text.length) fail("unterminated string", start);
      const ch = text[at++];
      if (ch === '"') return out;
      if (ch < " ") fail("control character in a string", at - 1);
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      const escape = text[at++];
      const simple = ({ '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<string, string>)[escape];
      if (simple !== undefined) out += simple;
      else if (escape === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(at, at + 4))) {
        out += String.fromCharCode(Number.parseInt(text.slice(at, at + 4), 16));
        at += 4;
      } else fail("invalid escape in a string", at - 2);
    }
  };

  const value = (depth: number): unknown => {
    skip();
    const ch = text[at];
    if (ch === "{" || ch === "[") {
      if (depth >= maxDepth) fail(`nesting is deeper than ${maxDepth} levels`);
      return ch === "{" ? object(depth + 1) : array(depth + 1);
    }
    if (ch === '"') return string();
    for (const [word, literal] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, at)) {
        at += word.length;
        return literal;
      }
    }
    NUMBER.lastIndex = at;
    const number = NUMBER.exec(text);
    if (!number) return fail(at >= text.length ? "unexpected end of input" : `unexpected character ${JSON.stringify(ch)}`);
    at += number[0].length;
    return Number(number[0]);
  };

  const object = (depth: number): Record<string, unknown> => {
    at++;
    const out: Record<string, unknown> = {};
    const seen = new Map<string, { line: number; column: number }>();
    opts.positions?.set(out, seen);
    skip();
    if (text[at] === "}") {
      at++;
      return out;
    }
    for (;;) {
      skip();
      if (text[at] !== '"') fail("expected a string key");
      const keyAt = at;
      const key = string();
      if (seen.has(key)) fail(`duplicate key ${JSON.stringify(key)} (first at line ${seen.get(key)!.line})`, keyAt);
      seen.set(key, where(keyAt));
      skip();
      if (text[at] !== ":") fail("expected ':' after a key");
      at++;
      // defineProperty keeps a key such as `__proto__` an ordinary member.
      Object.defineProperty(out, key, { value: value(depth), enumerable: true, writable: true, configurable: true });
      skip();
      if (text[at] === ",") {
        at++;
        continue;
      }
      if (text[at] === "}") {
        at++;
        return out;
      }
      fail("expected ',' or '}'");
    }
  };

  const array = (depth: number): unknown[] => {
    at++;
    const out: unknown[] = [];
    skip();
    if (text[at] === "]") {
      at++;
      return out;
    }
    for (;;) {
      out.push(value(depth));
      skip();
      if (text[at] === ",") {
        at++;
        continue;
      }
      if (text[at] === "]") {
        at++;
        return out;
      }
      fail("expected ',' or ']'");
    }
  };

  const result = value(0);
  skip();
  if (at < text.length) fail("unexpected content after the JSON value");
  return result;
}

/** The text of `bytes` as strict UTF-8: no byte order mark, no NUL, no invalid sequence. */
export function decodeStrictUtf8(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new StrictJsonError("the file starts with a byte order mark");
  if (bytes.includes(0)) throw new StrictJsonError("the file contains a NUL byte");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StrictJsonError("the file is not valid UTF-8");
  }
}

export interface HardenedReadOptions {
  /** Largest accepted file, in bytes. */
  maxBytes: number;
  /**
   * Permission bits that refuse the file when set, checked together with "owned by this user" (or root). 0o022 for
   * operator configuration; 0o077 for a private store. Undefined skips both checks: for a file trusted by the hash of
   * the bytes read here, not by who may write it.
   */
  forbiddenMode?: number;
}

export interface HardenedFile {
  bytes: Buffer;
  sha256: string;
  /** Identity of the file that was read: a later `fs.statSync` with the same stamp is the same content. */
  stamp: string;
}

/**
 * The identity of a file's content as a stat shows it (device, inode, size, modification and change time, mode,
 * owner): the cheap "has it changed" check. The change time is included because a writer cannot set it back.
 * Undefined when the file cannot be inspected.
 */
export function fileStamp(file: string): string | undefined {
  try {
    return stampOf(fs.lstatSync(file, { bigint: true }));
  } catch {
    return undefined;
  }
}

function stampOf(stat: fs.BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}:${stat.uid}`;
}

/**
 * Reads a regular file that is not a symbolic link, re-checked on the open descriptor, bounded, and (when
 * `forbiddenMode` is given) owned by this user or root with none of those permission bits. Absent file: undefined.
 * Anything else that is wrong throws `StrictJsonError` saying what.
 */
export function readHardenedFile(file: string, options: HardenedReadOptions): HardenedFile | undefined {
  let fd: number;
  try {
    const before = fs.lstatSync(file);
    if (before.isSymbolicLink()) throw new StrictJsonError("the file must not be a symbolic link");
    if (!before.isFile()) throw new StrictJsonError("the file must be a regular file");
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error: any) {
    if (error instanceof StrictJsonError) throw error;
    if (error?.code === "ENOENT") return undefined;
    if (error?.code === "ELOOP") throw new StrictJsonError("the file must not be a symbolic link");
    throw new StrictJsonError(`the file cannot be read (${error?.code ?? "error"})`);
  }
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw new StrictJsonError("the file must be a regular file");
    if (stat.size > BigInt(options.maxBytes)) throw new StrictJsonError(`the file exceeds the ${Math.round(options.maxBytes / 1024)} KiB size limit`);
    if (options.forbiddenMode !== undefined) {
      const uid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
      if (uid !== undefined && Number(stat.uid) !== uid && Number(stat.uid) !== 0) throw new StrictJsonError("the file is owned by another user");
      const bits = Number(stat.mode) & options.forbiddenMode;
      if (bits) throw new StrictJsonError(`the file's permissions are too open (mode ${(Number(stat.mode) & 0o777).toString(8).padStart(3, "0")}; clear ${bits.toString(8).padStart(3, "0")})`);
    }
    // One byte past the limit shows a file that grew after the size check.
    const buffer = Buffer.alloc(options.maxBytes + 1);
    let length = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > options.maxBytes) throw new StrictJsonError(`the file exceeds the ${Math.round(options.maxBytes / 1024)} KiB size limit`);
    }
    const bytes = buffer.subarray(0, length);
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), stamp: stampOf(stat) };
  } finally {
    fs.closeSync(fd);
  }
}
