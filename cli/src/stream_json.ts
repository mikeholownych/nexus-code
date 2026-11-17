/**
 * `nexus run --output stream-json`: one JSON object per line (NDJSON) on stdout, nothing else. Documented in
 * docs/STREAM_JSON.md. Every event carries `schemaVersion`, a per-run increasing `seq` and its `type`; `result` is the
 * same document `--json` prints. Free text that is not the model's own words (tool errors, notices) is redacted.
 */
import type { AgentObserver } from "./agent.js";
import { redactSecrets } from "./ui.js";

export const STREAM_JSON_SCHEMA_VERSION = 1;

const MAX_DETAIL_CHARS = 500;

export type StreamEventSink = (type: string, fields?: Record<string, unknown>) => void;

/** U+2028/U+2029 are legal inside JSON strings but split lines in some NDJSON readers: escape them. */
export function ndjsonLine(value: unknown): string {
  return `${JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")}\n`;
}

/** An event sink that writes complete lines with the given write function (captured before any stdout interception). */
export function streamEventSink(write: (chunk: string) => unknown, clock: () => string = () => new Date().toISOString()): StreamEventSink {
  let seq = 0;
  return (type, fields = {}) => {
    write(ndjsonLine({ schemaVersion: STREAM_JSON_SCHEMA_VERSION, seq: ++seq, ts: clock(), type, ...fields }));
  };
}

const detail = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : redactSecrets(text).slice(0, MAX_DETAIL_CHARS);

/** Maps the agent's live callbacks onto stream events. Tool arguments and outputs are not streamed (the result has the evidence). */
export function streamObserver(emit: StreamEventSink): AgentObserver {
  return {
    onAssistantDelta: (text) => emit("assistant.delta", { text }),
    onToolStart: ({ callId, tool }) => emit("tool.start", { call_id: callId, tool }),
    onInjectionSuspected: ({ tool, step, signals }) => emit("security.injection_suspected", { tool, step, signals }),
    onToolEnd: ({ callId, tool, success, output, error, denied }) =>
      emit("tool.end", {
        call_id: callId,
        tool,
        success,
        output_chars: output.length,
        ...(error ? { error: detail(error) } : {}),
        ...(denied ? { denied: true } : {}),
      }),
    onNotice: (text) => emit("notice", { text: detail(text) }),
  };
}
