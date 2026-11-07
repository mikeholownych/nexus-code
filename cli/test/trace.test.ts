import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InformationFlowBoundary } from "../src/core/egress.js";
import { LocalTraceRecorder } from "../src/core/trace.js";
import { getBuildIdentity } from "../src/build_identity.js";

function home(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-trace-test-"));
}

test("writes nested spans as OTLP/JSON under the per-session traces directory", () => {
  const isolatedHome = home();
  const recorder = new LocalTraceRecorder({ sessionId: "session_test-1", homeDir: isolatedHome });
  const turn = recorder.startSpan({ name: "nexus.agent.turn", attributes: { "nexus.turn.outcome": "SUCCESS" } });
  const inference = recorder.startGenAiInference({
    operationName: "chat",
    providerName: "openai",
    requestModel: "test-model",
    parentSpanId: turn.spanId,
  });
  assert.equal(inference.end({ status: "ok", attributes: { "gen_ai.usage.input_tokens": 12 } }), true);
  assert.equal(turn.end(), true);
  assert.equal(turn.end(), false);

  assert.equal(recorder.filePath, path.join(isolatedHome, ".local/share/nexus/traces/session_test-1/trace.jsonl"));
  const lines = fs.readFileSync(recorder.filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  for (const record of lines) {
    const spans = record.resourceSpans[0].scopeSpans[0].spans;
    assert.match(spans[0].traceId, /^[a-f0-9]{32}$/);
    assert.match(spans[0].spanId, /^[a-f0-9]{16}$/);
    assert.match(spans[0].startTimeUnixNano, /^\d+$/);
    assert.match(spans[0].endTimeUnixNano, /^\d+$/);
  }
  const inferenceSpan = lines[0].resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(inferenceSpan.kind, 3);
  assert.equal(inferenceSpan.parentSpanId, turn.spanId);
  const attrs = Object.fromEntries(inferenceSpan.attributes.map((attribute: any) => [attribute.key, attribute.value]));
  assert.equal(attrs["gen_ai.operation.name"].stringValue, "chat");
  assert.equal(attrs["gen_ai.provider.name"].stringValue, "openai");
  assert.equal(attrs["gen_ai.request.model"].stringValue, "test-model");
  assert.equal(attrs["gen_ai.usage.input_tokens"].intValue, "12");
  assert.equal(fs.statSync(recorder.filePath).mode & 0o777, 0o600);
});

test("the OTLP scope version is the running build's version", () => {
  const recorder = new LocalTraceRecorder({ sessionId: "session_scope_version", homeDir: home() });
  assert.equal(recorder.startSpan({ name: "nexus.agent.turn" }).end(), true);
  const record = JSON.parse(fs.readFileSync(recorder.filePath, "utf8").trim());
  assert.equal(record.resourceSpans[0].scopeSpans[0].scope.version, getBuildIdentity().version);
});

test("redacts synthetic credentials before writing and refuses deprecated provider attribute", () => {
  const isolatedHome = home();
  const secret = "synthetic_trace_secret_abc123";
  const boundary = new InformationFlowBoundary({ explicitSecrets: [secret] });
  const recorder = new LocalTraceRecorder({ sessionId: "session_redact", homeDir: isolatedHome, redact: (value) => boundary.redactForTelemetry(value) });
  const span = recorder.startGenAiInference({
    operationName: "chat",
    providerName: "openai",
    attributes: { "nexus.test.value": secret },
  });
  assert.equal(span.end(), true);
  const stored = fs.readFileSync(recorder.filePath, "utf8");
  assert.equal(stored.includes(secret), false);
  assert.match(stored, /REDACTED/);
  assert.throws(() => recorder.startGenAiInference({
    operationName: "chat",
    providerName: "openai",
    attributes: { "gen_ai.system": "openai" },
  }), /deprecated/);
  for (const deprecated of ["gen_ai.prompt", "gen_ai.completion", "gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.usage.prompt_tokens", "gen_ai.usage.completion_tokens"]) {
    assert.throws(() => recorder.startGenAiInference({
      operationName: "chat",
      providerName: "openai",
      attributes: { [deprecated]: "legacy" },
    }), /deprecated/);
  }
  assert.throws(() => recorder.startGenAiInference({ operationName: "", providerName: "openai" }), /requires/);
});

test("returns false without throwing when redaction or persistence fails", () => {
  const isolatedHome = home();
  const failedRedaction = new LocalTraceRecorder({ sessionId: "session_redaction_failure", homeDir: isolatedHome, redact: () => { throw new Error("synthetic failure"); } });
  assert.equal(failedRedaction.startSpan({ name: "safe" }).end(), false);
  assert.equal(fs.existsSync(failedRedaction.filePath), false);

  const blockedPath = new LocalTraceRecorder({ sessionId: "session_blocked", homeDir: isolatedHome });
  const traces = path.dirname(path.dirname(blockedPath.filePath));
  fs.mkdirSync(traces, { recursive: true });
  fs.symlinkSync(os.tmpdir(), path.join(traces, "session_blocked"));
  assert.equal(blockedPath.startSpan({ name: "safe" }).end(), false);

  const linkedPath = new LocalTraceRecorder({ sessionId: "session_hardlink", homeDir: isolatedHome });
  fs.mkdirSync(path.dirname(linkedPath.filePath), { recursive: true });
  const outsideFile = path.join(isolatedHome, "outside.jsonl");
  fs.writeFileSync(outsideFile, "preserve\n", { mode: 0o600 });
  fs.linkSync(outsideFile, linkedPath.filePath);
  assert.equal(linkedPath.startSpan({ name: "safe" }).end(), false);
  assert.equal(fs.readFileSync(outsideFile, "utf8"), "preserve\n");
});

test("rejects unsafe session identifiers before constructing a trace path", () => {
  assert.throws(() => new LocalTraceRecorder({ sessionId: "../../outside" }), /Invalid trace session id/);
});
