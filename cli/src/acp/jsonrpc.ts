/**
 * Newline-delimited JSON-RPC 2.0 for the ACP adapter: a bounded line reader, classification of one line, encoding, and
 * the correlator of agent-to-client requests. "Messages are delimited by newlines, and MUST NOT contain embedded
 * newlines"; UTF-8 (published specification, transports).
 *
 * Pure: it takes chunks and returns results. No process, no stdio, no timer.
 */
import { randomInt } from "node:crypto";
import {
  ACP_ERROR,
  ACP_MAX_JSON_DEPTH,
  ACP_MAX_LINE_BYTES,
  ACP_MAX_METHOD_CHARS,
  ACP_MAX_REQUEST_ID_CHARS,
  ACP_NV_BATCH_CODE,
  ACP_TOMBSTONE_COUNT,
  JSONRPC_VERSION,
} from "./types.js";
import type { AcpClientError, AcpError, AcpErrorCode, AcpErrorData, AcpErrorResponse, AcpId } from "./types.js";

const NEWLINE = 0x0a;

export type LineEvent =
  /** One complete line, decoded, without its terminator. Blank lines are never reported. */
  | { kind: "line"; text: string }
  /** A line longer than the cap. Reported once, when the cap is passed; the rest of the line is discarded unread. */
  | { kind: "oversized" };

/**
 * Splits a byte stream into lines without ever holding more than `maxBytes` of one line: when a line passes the cap,
 * what was buffered is dropped, `oversized` is reported once, and bytes are discarded up to the next newline. A line of
 * exactly `maxBytes` bytes (terminator not counted) is accepted. `\r\n` is accepted; blank lines are ignored.
 */
export class BoundedLineReader {
  private parts: Buffer[] = [];
  private held = 0;
  private discarding = false;
  private oversized = 0;

  constructor(private readonly maxBytes: number = ACP_MAX_LINE_BYTES) {}

  /** Bytes of the unfinished line held now: never more than the cap, and 0 while an oversized line is being discarded. */
  get bufferedBytes(): number {
    return this.held;
  }

  /** Lines over the cap seen so far. */
  get oversizedLines(): number {
    return this.oversized;
  }

  push(chunk: Uint8Array): LineEvent[] {
    const events: LineEvent[] = [];
    let at = 0;
    while (at < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, at);
      const end = newline < 0 ? chunk.length : newline;
      const length = end - at;
      if (!this.discarding) {
        if (this.held + length > this.maxBytes) {
          this.drop();
          this.discarding = true;
          this.oversized++;
          events.push({ kind: "oversized" });
        } else if (length > 0) {
          // Copied: the caller may reuse its chunk.
          this.parts.push(Buffer.from(chunk.subarray(at, end)));
          this.held += length;
        }
      }
      if (newline < 0) break;
      if (this.discarding) this.discarding = false;
      else this.finish(events);
      at = newline + 1;
    }
    return events;
  }

  /** The stream ended: an unterminated last line is still a line. */
  end(): LineEvent[] {
    const events: LineEvent[] = [];
    if (!this.discarding) this.finish(events);
    this.discarding = false;
    return events;
  }

  private drop(): void {
    this.parts = [];
    this.held = 0;
  }

  private finish(events: LineEvent[]): void {
    if (this.held === 0) return;
    const text = (this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.held)).toString("utf8");
    this.drop();
    const line = text.endsWith("\r") ? text.slice(0, -1) : text;
    if (line.trim()) events.push({ kind: "line", text: line });
  }
}

/**
 * Whether `text` nests arrays and objects deeper than `max`, decided before parsing so a depth bomb never reaches
 * `JSON.parse`. Brackets inside strings are not counted.
 */
export function exceedsDepth(text: string, max: number = ACP_MAX_JSON_DEPTH): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (inString) {
      if (code === 0x5c) i++; // a backslash escapes the next character
      else if (code === 0x22) inString = false;
      continue;
    }
    if (code === 0x22) inString = true;
    else if (code === 0x5b || code === 0x7b) {
      if (++depth > max) return true;
    } else if (code === 0x5d || code === 0x7d) depth--;
  }
  return false;
}

export type Incoming =
  | { kind: "request"; id: AcpId; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown }
  /** A reply to an agent request: exactly one of `result` and `error` is present. */
  | { kind: "response"; id: AcpId; result: unknown; error?: undefined }
  | { kind: "response"; id: AcpId; result?: undefined; error: AcpClientError }
  /**
   * Not a message Nexus can act on. `respond`: whether to answer with `error` (false for something shaped like a reply,
   * which is logged and dropped: answering a reply with an error invites a loop).
   */
  | { kind: "invalid"; id: AcpId | null; error: AcpError; respond: boolean };

function own(object: object, key: string): boolean {
  return Object.hasOwn(object, key);
}

/** A request id Nexus accepts: a string of bounded length, or an integer. Null, a fraction and anything else are refused. */
export function isRequestId(value: unknown): value is AcpId {
  if (typeof value === "string") return value.length <= ACP_MAX_REQUEST_ID_CHARS;
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function rpcError(code: AcpErrorCode, message: string, data?: AcpErrorData): AcpError {
  return { code, message, ...(data ? { data } : {}) };
}

function invalid(code: AcpErrorCode, message: string, id: AcpId | null = null, respond = true): Incoming {
  return { kind: "invalid", id, error: rpcError(code, message), respond };
}

/** The answer to a line the reader reported as oversized. */
export function oversizedLineError(maxBytes: number = ACP_MAX_LINE_BYTES): AcpErrorResponse {
  return errorResponse(null, rpcError(ACP_ERROR.PARSE_ERROR, `a message is longer than ${maxBytes} bytes and was discarded`));
}

/** Classifies one line. Never throws. */
export function parseMessage(line: string): Incoming {
  if (exceedsDepth(line)) return invalid(ACP_ERROR.PARSE_ERROR, `the message nests deeper than ${ACP_MAX_JSON_DEPTH} levels`);
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return invalid(ACP_ERROR.PARSE_ERROR, "the line is not valid JSON");
  }
  if (Array.isArray(raw)) return invalid(ACP_NV_BATCH_CODE, "batch requests are not supported");
  if (!raw || typeof raw !== "object") return invalid(ACP_ERROR.INVALID_REQUEST, "a message must be a JSON object");
  const message = raw as Record<string, unknown>;
  const hasId = own(message, "id");
  const id = hasId && isRequestId(message.id) ? message.id : null;
  const hasMethod = own(message, "method");
  // Something without a method is a reply (or nothing): it is never answered.
  const respond = hasMethod;
  if (message.jsonrpc !== JSONRPC_VERSION) return invalid(ACP_ERROR.INVALID_REQUEST, 'jsonrpc must be "2.0"', id, respond);
  if (hasMethod) {
    const method = message.method;
    if (typeof method !== "string" || !method || method.length > ACP_MAX_METHOD_CHARS) return invalid(ACP_ERROR.INVALID_REQUEST, "method must be a non-empty string", id);
    const params = own(message, "params") ? message.params : undefined;
    if (!hasId) return { kind: "notification", method, params };
    if (id === null) return invalid(ACP_ERROR.INVALID_REQUEST, "id must be a string or an integer");
    return { kind: "request", id, method, params };
  }
  if (id === null) return invalid(ACP_ERROR.INVALID_REQUEST, "a message needs a method, or the id of the request it answers", null, false);
  const hasResult = own(message, "result");
  const hasError = own(message, "error");
  if (hasResult === hasError) return invalid(ACP_ERROR.INVALID_REQUEST, "a response carries exactly one of result and error", id, false);
  if (hasResult) return { kind: "response", id, result: message.result };
  const error = message.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return invalid(ACP_ERROR.INVALID_REQUEST, "a response error must be an object", id, false);
  const { code, message: text } = error as Record<string, unknown>;
  if (typeof code !== "number" || typeof text !== "string") return invalid(ACP_ERROR.INVALID_REQUEST, "a response error needs a numeric code and a string message", id, false);
  return { kind: "response", id, error: { code, message: text, ...(own(error, "data") ? { data: (error as Record<string, unknown>).data } : {}) } };
}

export function resultResponse<T>(id: AcpId, result: T): { jsonrpc: "2.0"; id: AcpId; result: T } {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function errorResponse(id: AcpId | null, error: AcpError): AcpErrorResponse {
  return { jsonrpc: JSONRPC_VERSION, id, error };
}

export function notification<M extends string, P>(method: M, params: P): { jsonrpc: "2.0"; method: M; params: P } {
  return { jsonrpc: JSONRPC_VERSION, method, params };
}

export function request<M extends string, P>(id: number, method: M, params: P): { jsonrpc: "2.0"; id: number; method: M; params: P } {
  return { jsonrpc: JSONRPC_VERSION, id, method, params };
}

/** The same expression as `encodeEvent` in protocol.ts (a test compares the two). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * One message as one line. `JSON.stringify` escapes every control character, so the only raw newline is the
 * terminator; a lone surrogate (a cut can split a pair) is replaced, because the client could not decode it.
 */
export function encodeMessage(message: object): string {
  const wellFormed = (_key: string, value: unknown) => (typeof value === "string" ? value.replace(LONE_SURROGATE, "�") : value);
  return JSON.stringify(message, wellFormed) + "\n";
}

export type Settlement<T> =
  /** The first reply to an open request: `context` is what the request was opened with. */
  | { state: "matched"; context: T }
  /** A reply to a request that was already answered or abandoned (cancel, timeout, turn end). */
  | { state: "stale" }
  /** A reply to an id Nexus never issued (or one too old to remember), or an id that is not an integer. */
  | { state: "unknown" };

const MAX_ID = 0x7fffffff;

/**
 * Correlates agent-to-client requests with their replies. Ids are integers counted from a random 31-bit start, so a
 * reply written before the request exists matches nothing. Each id is answered at most once: the first reply is
 * `matched`, any later one `stale`. The last `tombstones` settled or abandoned ids are remembered for that distinction.
 */
export class RequestCorrelator<T> {
  private readonly open_ = new Map<number, T>();
  /** Insertion-ordered: the oldest tombstone is dropped first. */
  private readonly tombstones = new Set<number>();
  private next: number;

  constructor(private readonly options: { start?: number; tombstones?: number } = {}) {
    this.next = options.start ?? randomInt(1, MAX_ID);
    if (!Number.isInteger(this.next) || this.next < 1 || this.next > MAX_ID) throw new RangeError("the first request id must be an integer from 1 to 2^31-1");
  }

  get pending(): number {
    return this.open_.size;
  }

  /** Registers a request and returns its id. */
  open(context: T): number {
    let id = this.next;
    while (this.open_.has(id)) id = id >= MAX_ID ? 1 : id + 1;
    this.next = id >= MAX_ID ? 1 : id + 1;
    this.tombstones.delete(id);
    this.open_.set(id, context);
    return id;
  }

  /** Takes the reply to `id`. Only `matched` may lead to an action. */
  settle(id: unknown): Settlement<T> {
    if (typeof id !== "number" || !Number.isInteger(id)) return { state: "unknown" };
    if (this.open_.has(id)) {
      const context = this.open_.get(id) as T;
      this.close(id);
      return { state: "matched", context };
    }
    return this.tombstones.has(id) ? { state: "stale" } : { state: "unknown" };
  }

  /** Closes a request without a reply (cancel, timeout, turn end, disconnect); a later reply to it is `stale`. */
  abandon(id: number): T | undefined {
    if (!this.open_.has(id)) return undefined;
    const context = this.open_.get(id);
    this.close(id);
    return context;
  }

  private close(id: number): void {
    this.open_.delete(id);
    this.tombstones.add(id);
    const limit = this.options.tombstones ?? ACP_TOMBSTONE_COUNT;
    for (const oldest of this.tombstones) {
      if (this.tombstones.size <= limit) break;
      this.tombstones.delete(oldest);
    }
  }
}
