/** Local OTLP/JSON trace writer. Telemetry failures never interrupt agent work. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { InformationFlowBoundary } from "./egress.js";
import { getBuildIdentity } from "../build_identity.js";

export type TraceAttributeValue = string | number | boolean | string[] | number[] | boolean[];
export type TraceAttributes = Record<string, TraceAttributeValue>;
export type TraceStatus = "ok" | "error" | "unset";

export interface LocalTraceOptions {
  sessionId: string;
  homeDir?: string;
  serviceName?: string;
  redact?: <T>(value: T) => T;
}

export interface SpanOptions {
  name: string;
  kind?: "internal" | "client" | "server" | "producer" | "consumer";
  attributes?: TraceAttributes;
  parentSpanId?: string;
  startTimeUnixNano?: string;
}

export interface GenAiInferenceOptions {
  operationName: string;
  providerName: string;
  requestModel?: string;
  parentSpanId?: string;
  attributes?: TraceAttributes;
}

export interface SpanHandle {
  readonly traceId: string;
  readonly spanId: string;
  end(options?: { status?: TraceStatus; attributes?: TraceAttributes; endTimeUnixNano?: string }): boolean;
}

const KIND: Record<NonNullable<SpanOptions["kind"]>, number> = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};
const SESSION_ID = /^[A-Za-z0-9._-]{1,160}$/;
const ID = /^[a-f0-9]+$/;
const DEPRECATED_GENAI_ATTRIBUTES = new Set([
  "gen_ai.system",
  "gen_ai.prompt",
  "gen_ai.completion",
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.usage.prompt_tokens",
  "gen_ai.usage.completion_tokens",
]);

function nowUnixNano(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function otelAttributes(attributes: TraceAttributes): Array<{ key: string; value: Record<string, unknown> }> {
  return Object.entries(attributes).map(([key, value]) => {
    const val = Array.isArray(value)
      ? { arrayValue: { values: value.map((entry) => typeof entry === "string" ? { stringValue: entry } : typeof entry === "boolean" ? { boolValue: entry } : { intValue: String(entry) }) } }
      : typeof value === "string"
        ? { stringValue: value }
        : typeof value === "boolean"
          ? { boolValue: value }
          : Number.isInteger(value)
            ? { intValue: String(value) }
            : { doubleValue: value };
    return { key, value: val };
  });
}

function privateDirectory(dir: string, home: string): void {
  const relative = path.relative(home, dir);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("Trace directory escapes home directory");
  }
  const homeStat = fs.lstatSync(home);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) throw new Error("Trace home is not a real directory");
  let current = home;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let created = false;
    try {
      fs.mkdirSync(current, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Trace directory is not a real directory");
    if (created) fs.chmodSync(current, 0o700);
  }
}

/** Writes one OTLP/JSON file-exporter envelope per completed span. */
export class LocalTraceRecorder {
  readonly traceId: string;
  readonly filePath: string;
  private readonly homeDir: string;
  private readonly redact: <T>(value: T) => T;
  private readonly serviceName: string;

  constructor(options: LocalTraceOptions) {
    if (!SESSION_ID.test(options.sessionId)) throw new Error("Invalid trace session id");
    const home = fs.realpathSync(path.resolve(options.homeDir ?? os.homedir()));
    this.homeDir = home;
    this.filePath = path.join(home, ".local", "share", "nexus", "traces", options.sessionId, "trace.jsonl");
    this.traceId = randomHex(16);
    this.redact = options.redact ?? ((value) => new InformationFlowBoundary().redactForTelemetry(value));
    this.serviceName = options.serviceName ?? "nexus-code";
  }

  startSpan(options: SpanOptions): SpanHandle {
    const spanId = randomHex(8);
    const startTimeUnixNano = options.startTimeUnixNano ?? nowUnixNano();
    let ended = false;
    return {
      traceId: this.traceId,
      spanId,
      end: (endOptions = {}) => {
        if (ended) return false;
        ended = true;
        if (!ID.test(spanId) || (options.parentSpanId && !/^[a-f0-9]{16}$/.test(options.parentSpanId))) return false;
        const attributes = { ...(options.attributes ?? {}), ...(endOptions.attributes ?? {}) };
        let safe: { name: string; attributes: TraceAttributes };
        try {
          safe = this.redact({ name: options.name, attributes });
        } catch {
          return false;
        }
        const span = {
          traceId: this.traceId,
          spanId,
          ...(options.parentSpanId ? { parentSpanId: options.parentSpanId } : {}),
          name: safe.name,
          kind: KIND[options.kind ?? "internal"],
          startTimeUnixNano,
          endTimeUnixNano: endOptions.endTimeUnixNano ?? nowUnixNano(),
          attributes: otelAttributes(safe.attributes),
          status: { code: endOptions.status === "error" ? 2 : endOptions.status === "ok" ? 1 : 0 },
        };
        const record = JSON.stringify({
          resourceSpans: [{
            resource: { attributes: [{ key: "service.name", value: { stringValue: this.serviceName } }] },
            scopeSpans: [{ scope: { name: "nexus-code", version: getBuildIdentity().version }, spans: [span] }],
          }],
        });
        try {
          privateDirectory(path.dirname(this.filePath), this.homeDir);
          try {
            const existing = fs.lstatSync(this.filePath);
            if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
          }
          const fd = fs.openSync(this.filePath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
          try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.nlink !== 1) return false;
            fs.fchmodSync(fd, 0o600);
            fs.writeSync(fd, `${record}\n`, undefined, "utf8");
          } finally {
            fs.closeSync(fd);
          }
          return true;
        } catch {
          return false;
        }
      },
    };
  }

  /** Creates a client inference span with the current GenAI convention's required attributes. */
  startGenAiInference(options: GenAiInferenceOptions): SpanHandle {
    if (!options.operationName || !options.providerName) throw new Error("GenAI inference requires operationName and providerName");
    const deprecated = Object.keys(options.attributes ?? {}).find((key) => DEPRECATED_GENAI_ATTRIBUTES.has(key));
    if (deprecated) {
      const replacement = deprecated === "gen_ai.system" ? "; use gen_ai.provider.name" : deprecated === "gen_ai.usage.prompt_tokens" ? "; use gen_ai.usage.input_tokens" : deprecated === "gen_ai.usage.completion_tokens" ? "; use gen_ai.usage.output_tokens" : "";
      throw new Error(`${deprecated} is deprecated${replacement}`);
    }
    const attributes: TraceAttributes = {
      "gen_ai.operation.name": options.operationName,
      "gen_ai.provider.name": options.providerName,
      ...options.attributes,
    };
    if (options.requestModel) attributes["gen_ai.request.model"] = options.requestModel;
    return this.startSpan({
      name: `${options.operationName} ${options.requestModel ?? ""}`.trim(),
      kind: "client",
      parentSpanId: options.parentSpanId,
      attributes,
    });
  }
}
