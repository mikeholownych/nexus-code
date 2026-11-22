/**
 * GV-4: local traces can be turned off, are pruned after a retention period, and never leave the host.
 * What they contain is documented in docs/TELEMETRY.md; the attribute-name check below keeps that page honest.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// Default imports: the CommonJS module objects, whose functions can be replaced (a namespace import is read-only).
import net from "node:net";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import dgram from "node:dgram";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import { DEFAULT_TRACE_RETENTION_DAYS, LocalTraceRecorder, pruneOldTraces, traceSettings } from "../src/core/trace.js";

const DAY = 86_400_000;
const home = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "nexus-trace-gv4-"));
const tracesDir = (h: string): string => path.join(h, ".local", "share", "nexus", "traces");
const repoFile = (rel: string): string => fileURLToPath(new URL(`../../${rel}`, import.meta.url));

/** A session directory holding a trace file last written `ageDays` ago. */
function seed(h: string, session: string, ageDays: number, now: number): string {
  const dir = path.join(tracesDir(h), session);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "trace.jsonl");
  fs.writeFileSync(file, "{}\n", { mode: 0o600 });
  const when = new Date(now - ageDays * DAY);
  fs.utimesSync(file, when, when);
  return file;
}

describe("trace settings", () => {
  test("traces are on by default and kept for the default period", () => {
    assert.deepEqual(traceSettings({}), { enabled: true, retentionDays: DEFAULT_TRACE_RETENTION_DAYS });
  });

  test("NEXUS_TRACES off, 0, false or no (any case, padded) turns them off; anything else leaves them on", () => {
    for (const value of ["off", "OFF", " 0 ", "false", "No"]) assert.equal(traceSettings({ NEXUS_TRACES: value }).enabled, false, value);
    for (const value of ["on", "1", "true", "", "maybe"]) assert.equal(traceSettings({ NEXUS_TRACES: value }).enabled, true, value);
  });

  test("NEXUS_TRACE_RETENTION_DAYS takes whole days, 0 meaning indefinitely; an unparseable value falls back to the default", () => {
    assert.equal(traceSettings({ NEXUS_TRACE_RETENTION_DAYS: "7" }).retentionDays, 7);
    assert.equal(traceSettings({ NEXUS_TRACE_RETENTION_DAYS: "0" }).retentionDays, 0);
    for (const value of ["-1", "1.5", "forever", "1e9", "999999"]) {
      assert.equal(traceSettings({ NEXUS_TRACE_RETENTION_DAYS: value }).retentionDays, DEFAULT_TRACE_RETENTION_DAYS, value);
    }
  });
});

describe("turning traces off", () => {
  test("a disabled recorder accepts spans, reports them unwritten and creates neither file nor directory", () => {
    const h = home();
    const recorder = new LocalTraceRecorder({ sessionId: "session-off", homeDir: h, env: { NEXUS_TRACES: "off" } });
    assert.equal(recorder.enabled, false);
    const turn = recorder.startSpan({ name: "nexus.agent.turn", attributes: { "nexus.turn.outcome": "SUCCESS" } });
    const inference = recorder.startGenAiInference({ operationName: "chat", providerName: "openai", requestModel: "m", parentSpanId: turn.spanId });
    assert.equal(inference.end({ status: "ok" }), false);
    assert.equal(turn.end(), false);
    assert.equal(fs.existsSync(path.join(h, ".local")), false, "nothing was created under the home directory");
  });

  test("the same spans are written when traces are on", () => {
    const h = home();
    const recorder = new LocalTraceRecorder({ sessionId: "session-on", homeDir: h, env: {} });
    assert.equal(recorder.enabled, true);
    assert.equal(recorder.startSpan({ name: "nexus.agent.turn" }).end(), true);
    assert.equal(fs.readFileSync(recorder.filePath, "utf8").trim().split("\n").length, 1);
  });
});

describe("retention", () => {
  test("trace files older than the period are removed with their emptied directory; newer ones stay", () => {
    const h = home();
    const now = Date.parse("2026-11-22T00:00:00Z");
    const old = seed(h, "old-session", 31, now);
    const edge = seed(h, "edge-session", 29, now);
    assert.equal(pruneOldTraces(h, 30, now), 1);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(path.dirname(old)), false, "the emptied session directory is removed");
    assert.equal(fs.existsSync(edge), true);
  });

  test("a retention of 0 removes nothing", () => {
    const h = home();
    const now = Date.now();
    const old = seed(h, "ancient", 4000, now);
    assert.equal(pruneOldTraces(h, 0, now), 0);
    assert.equal(fs.existsSync(old), true);
  });

  test("only a real trace file in a real session directory is removed: links, foreign files and odd names are left alone", () => {
    const h = home();
    const now = Date.now();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-trace-outside-"));
    const victim = path.join(outside, "trace.jsonl");
    fs.writeFileSync(victim, "keep me\n");
    const longAgo = new Date(now - 400 * DAY);
    fs.utimesSync(victim, longAgo, longAgo);
    fs.mkdirSync(tracesDir(h), { recursive: true });
    // A session "directory" that is a link to somewhere else.
    fs.symlinkSync(outside, path.join(tracesDir(h), "linked-session"));
    // A trace "file" that is a link to a file elsewhere.
    const linkedFileDir = path.join(tracesDir(h), "linked-file");
    fs.mkdirSync(linkedFileDir);
    fs.symlinkSync(victim, path.join(linkedFileDir, "trace.jsonl"));
    // A hard-linked trace file (two names for one inode).
    const hardDir = path.join(tracesDir(h), "hard-linked");
    fs.mkdirSync(hardDir);
    fs.linkSync(victim, path.join(hardDir, "trace.jsonl"));
    // An old trace beside a file that is not ours: the trace goes, the directory and the other file stay.
    const mixed = seed(h, "mixed", 400, now);
    const foreign = path.join(path.dirname(mixed), "notes.txt");
    fs.writeFileSync(foreign, "mine\n");
    // A name no session id can have.
    const odd = path.join(tracesDir(h), "not a session");
    fs.mkdirSync(odd);
    fs.writeFileSync(path.join(odd, "trace.jsonl"), "{}\n");
    fs.utimesSync(path.join(odd, "trace.jsonl"), longAgo, longAgo);

    assert.equal(pruneOldTraces(h, 30, now), 1, "only the plain old trace is removed");
    assert.equal(fs.readFileSync(victim, "utf8"), "keep me\n", "the file outside the traces directory is untouched");
    assert.equal(fs.existsSync(path.join(hardDir, "trace.jsonl")), true);
    assert.equal(fs.lstatSync(path.join(linkedFileDir, "trace.jsonl")).isSymbolicLink(), true);
    assert.equal(fs.existsSync(mixed), false);
    assert.equal(fs.readFileSync(foreign, "utf8"), "mine\n");
    assert.equal(fs.existsSync(path.join(odd, "trace.jsonl")), true);
  });

  test("a missing traces directory, or a home that does not exist, is not an error", () => {
    assert.equal(pruneOldTraces(home(), 30), 0);
    assert.equal(pruneOldTraces(path.join(os.tmpdir(), "nexus-no-such-home-gv4"), 30), 0);
  });

  test("a new recorder prunes its home once, using the configured period", () => {
    const h = home();
    const old = seed(h, "stale", 10, Date.now());
    const fresh = seed(h, "fresh", 1, Date.now());
    new LocalTraceRecorder({ sessionId: "s1", homeDir: h, env: { NEXUS_TRACE_RETENTION_DAYS: "5" } });
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(fresh), true);
    // Pruning runs once per home per process: a later recorder does not rescan.
    const later = seed(h, "stale-later", 10, Date.now());
    new LocalTraceRecorder({ sessionId: "s2", homeDir: h, env: { NEXUS_TRACE_RETENTION_DAYS: "5" } });
    assert.equal(fs.existsSync(later), true);
  });
});

describe("nothing leaves the host", () => {
  test("writing traces opens no socket, makes no HTTP request, resolves no name and calls no fetch", () => {
    const calls: string[] = [];
    const patch = <T extends object, K extends keyof T>(target: T, key: K, label: string): (() => void) => {
      const original = target[key];
      (target as any)[key] = (..._args: unknown[]) => {
        calls.push(label);
        throw new Error(`network call from the trace writer: ${label}`);
      };
      return () => { (target as any)[key] = original; };
    };
    const restore = [
      patch(net.Socket.prototype, "connect", "net.Socket.connect"),
      patch(http, "request", "http.request"),
      patch(http, "get", "http.get"),
      patch(https, "request", "https.request"),
      patch(https, "get", "https.get"),
      patch(dns, "lookup", "dns.lookup"),
      patch(dgram, "createSocket", "dgram.createSocket"),
      patch(globalThis as any, "fetch", "fetch"),
    ];
    // Named and namespace imports of a builtin are copies; this makes them see the replacements too.
    syncBuiltinESMExports();
    try {
      // The replacements are live: a request made the ordinary way is caught. Without this the test could pass by not looking.
      assert.throws(() => http.request("http://127.0.0.1:9"), /network call from the trace writer/);
      assert.deepEqual(calls.splice(0), ["http.request"]);
      const h = home();
      seed(h, "stale", 400, Date.now());
      const recorder = new LocalTraceRecorder({ sessionId: "session-net", homeDir: h, env: {} });
      const turn = recorder.startSpan({ name: "nexus.agent.turn", attributes: { "nexus.task.id": "t1" } });
      const tool = recorder.startSpan({ name: "nexus.agent.tool", parentSpanId: turn.spanId, attributes: { "nexus.tool.name": "run_command" } });
      const inference = recorder.startGenAiInference({ operationName: "chat", providerName: "openai", requestModel: "m", parentSpanId: turn.spanId });
      assert.equal(inference.end({ status: "ok", attributes: { "gen_ai.usage.input_tokens": 3 } }), true);
      assert.equal(tool.end({ status: "error" }), true);
      assert.equal(turn.end(), true);
      assert.equal(fs.readFileSync(recorder.filePath, "utf8").trim().split("\n").length, 3);
    } finally {
      for (const undo of restore) undo();
      syncBuiltinESMExports();
    }
    assert.deepEqual(calls, []);
  });

  test("the trace writer imports no network, process-spawning or exporter module", () => {
    const source = fs.readFileSync(repoFile("cli/src/core/trace.ts"), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(imports, ["../build_identity.js", "./egress.js", "node:crypto", "node:fs", "node:os", "node:path"]);
    assert.doesNotMatch(source, /\bfetch\s*\(|WebSocket|XMLHttpRequest|opentelemetry/);
  });
});

describe("docs/TELEMETRY.md matches the code", () => {
  const doc = fs.readFileSync(repoFile("docs/TELEMETRY.md"), "utf8");

  test("every nexus.* and gen_ai.* attribute and span name the client writes is listed", () => {
    const names = new Set<string>();
    for (const rel of ["cli/src/agent.ts", "cli/src/core/trace.ts"]) {
      const source = fs.readFileSync(repoFile(rel), "utf8");
      for (const m of source.matchAll(/"((?:nexus|gen_ai)\.[a-z_.]+)"/g)) names.add(m[1]);
    }
    assert.ok(names.size >= 15, `found ${names.size} names; the scan must still see the trace attributes`);
    const missing = [...names].filter((name) => !doc.includes(`\`${name}\``)).sort();
    assert.deepEqual(missing, [], "attribute or span names written by the client but absent from docs/TELEMETRY.md");
  });

  test("the settings, the default period and the location are stated", () => {
    assert.match(doc, /NEXUS_TRACES=off/);
    assert.match(doc, /NEXUS_TRACE_RETENTION_DAYS/);
    assert.ok(doc.includes(`${DEFAULT_TRACE_RETENTION_DAYS} days`), "the default retention period");
    assert.match(doc, /~\/\.local\/share\/nexus\/traces\//);
  });
});
