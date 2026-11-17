/**
 * AWS event-stream binary framing (application/vnd.amazon.eventstream), as used by ConverseStream.
 * Frame: total length (4), headers length (4), prelude CRC32 (4), headers, payload, message CRC32 (4); big-endian.
 * Header: name length (1), name, value type (1), value. Both CRCs are verified; any framing fault is malformed.
 */
import { ProviderStreamError } from "./common.js";

export interface EventFrame {
  headers: Record<string, string | number | boolean | Uint8Array>;
  payload: Buffer;
}

/** A frame larger than this is treated as corrupt instead of buffered (AWS limits a message to 24 MiB). */
const MAX_FRAME = 24 * 1024 * 1024;
const MIN_FRAME = 16;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function bad(msg: string): ProviderStreamError {
  return new ProviderStreamError(`Malformed event stream: ${msg}`, undefined, "", true);
}

function parseHeaders(buf: Buffer, start: number, end: number): EventFrame["headers"] {
  const out: EventFrame["headers"] = {};
  let p = start;
  const need = (n: number) => {
    if (p + n > end) throw bad("header overruns its block");
  };
  while (p < end) {
    need(1);
    const nameLen = buf[p++];
    need(nameLen + 1);
    const name = buf.toString("utf8", p, p + nameLen);
    p += nameLen;
    const type = buf[p++];
    switch (type) {
      case 0: out[name] = true; break;
      case 1: out[name] = false; break;
      case 2: need(1); out[name] = buf.readInt8(p); p += 1; break;
      case 3: need(2); out[name] = buf.readInt16BE(p); p += 2; break;
      case 4: need(4); out[name] = buf.readInt32BE(p); p += 4; break;
      case 5: need(8); out[name] = Number(buf.readBigInt64BE(p)); p += 8; break;
      case 8: need(8); out[name] = Number(buf.readBigInt64BE(p)); p += 8; break;
      case 9: need(16); out[name] = buf.subarray(p, p + 16); p += 16; break;
      case 6:
      case 7: {
        need(2);
        const len = buf.readUInt16BE(p);
        p += 2;
        need(len);
        out[name] = type === 7 ? buf.toString("utf8", p, p + len) : buf.subarray(p, p + len);
        p += len;
        break;
      }
      default:
        throw bad(`unknown header value type ${type}`);
    }
  }
  return out;
}

/** Incremental decoder: push chunks at any boundary, receive each complete frame. */
export class EventStreamDecoder {
  private buf = Buffer.alloc(0);

  push(chunk: Uint8Array): EventFrame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const frames: EventFrame[] = [];
    while (this.buf.length >= 12) {
      const total = this.buf.readUInt32BE(0);
      const headersLen = this.buf.readUInt32BE(4);
      if (total < MIN_FRAME || total > MAX_FRAME) throw bad(`frame length ${total} out of range`);
      if (headersLen > total - MIN_FRAME) throw bad("headers length exceeds the frame");
      if (crc32(this.buf, 0, 8) !== this.buf.readUInt32BE(8)) throw bad("prelude checksum mismatch");
      if (this.buf.length < total) break;
      if (crc32(this.buf, 0, total - 4) !== this.buf.readUInt32BE(total - 4)) throw bad("message checksum mismatch");
      const headers = parseHeaders(this.buf, 12, 12 + headersLen);
      frames.push({ headers, payload: Buffer.from(this.buf.subarray(12 + headersLen, total - 4)) });
      this.buf = this.buf.subarray(total);
    }
    return frames;
  }

  /** Bytes of an unfinished frame left at end of stream. */
  get pending(): number {
    return this.buf.length;
  }
}

/** Encodes one frame; used by tests and fixtures. Headers are strings (type 7). */
export function encodeFrame(headers: Record<string, string>, payload: Uint8Array | string): Buffer {
  const hdr = Buffer.concat(
    Object.entries(headers).map(([k, v]) => {
      const name = Buffer.from(k, "utf8");
      const val = Buffer.from(v, "utf8");
      const out = Buffer.alloc(1 + name.length + 1 + 2 + val.length);
      let p = 0;
      out[p++] = name.length;
      name.copy(out, p); p += name.length;
      out[p++] = 7;
      out.writeUInt16BE(val.length, p); p += 2;
      val.copy(out, p);
      return out;
    }),
  );
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  const total = 12 + hdr.length + body.length + 4;
  const out = Buffer.alloc(total);
  out.writeUInt32BE(total, 0);
  out.writeUInt32BE(hdr.length, 4);
  out.writeUInt32BE(crc32(out, 0, 8), 8);
  hdr.copy(out, 12);
  body.copy(out, 12 + hdr.length);
  out.writeUInt32BE(crc32(out, 0, total - 4), total - 4);
  return out;
}

/**
 * Reads an event-stream body. `onEvent` gets the event name and the payload text: the `:event-type` for an event, and
 * `exception:<type>` or `error:<code>` for an exception or error message (whose payload carries the provider's text).
 */
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (name: string | undefined, data: string) => void,
  onChunk?: () => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new EventStreamDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk?.();
      for (const f of decoder.push(value)) {
        const h = f.headers;
        const kind = h[":message-type"];
        const name =
          kind === "exception" ? `exception:${String(h[":exception-type"] ?? "unknown")}`
          : kind === "error" ? `error:${String(h[":error-code"] ?? "unknown")}`
          : typeof h[":event-type"] === "string" ? (h[":event-type"] as string)
          : undefined;
        const text = f.payload.toString("utf8");
        onEvent(name, name?.startsWith("error:") ? JSON.stringify({ message: String(h[":error-message"] ?? text) }) : text);
      }
    }
    if (decoder.pending) throw bad("stream ended inside a frame");
  } catch (err) {
    try { await reader.cancel(); } catch {}
    throw err;
  }
}
