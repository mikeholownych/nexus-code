/** RD-3: `nexus run --output stream-json` writes NDJSON events and nothing else on stdout (docs/STREAM_JSON.md). */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ndjsonLine, streamEventSink, streamObserver, STREAM_JSON_SCHEMA_VERSION } from "../src/stream_json.js";
import { startGateway, makeRepo } from "./helpers/fixtures.js";

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(CLI_DIR, "node_modules", ".bin", "tsx");

test("an event is one line: newlines and line separators inside strings are escaped", () => {
  const line = ndjsonLine({ text: "a\nb\u2028c\u2029d" });
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.slice(0, -1).includes("\n"), false);
  assert.equal(/[\u2028\u2029]/.test(line), false);
  assert.deepEqual(JSON.parse(line), { text: "a\nb\u2028c\u2029d" });
});

test("the sink numbers events and stamps the schema version; the observer maps agent callbacks to events", () => {
  const lines: string[] = [];
  const emit = streamEventSink((c) => lines.push(c), () => "T");
  const obs = streamObserver(emit);
  obs.onAssistantDelta!("hi");
  obs.onToolStart!({ dispatch: 1, callId: "c1", tool: "read_file", args: { path: "secret-name.txt" } });
  obs.onToolEnd!({ dispatch: 1, callId: "c1", tool: "read_file", success: false, output: "xyz", error: "boom token=ghp_abcdefghijklmnopqrstuvwxyz0123456789", denied: false });
  obs.onNotice!("heads up");
  const events = lines.map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => [e.seq, e.type, e.schemaVersion, e.ts]), [[1, "assistant.delta", STREAM_JSON_SCHEMA_VERSION, "T"], [2, "tool.start", 1, "T"], [3, "tool.end", 1, "T"], [4, "notice", 1, "T"]]);
  assert.equal(events[1].tool, "read_file");
  assert.equal(JSON.stringify(events).includes("secret-name.txt"), false, "tool arguments are not streamed");
  assert.equal(events[2].output_chars, 3);
  assert.equal(JSON.stringify(events[2]).includes("ghp_abcdefghij"), false, "tool errors are redacted");
  assert.equal(events[2].error.length <= 500, true);
});

async function runStream(extra: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const gateway = await startGateway((n) =>
    n === 1
      ? { kind: "tools", calls: [{ name: "list_dir", args: { path: "." } }] }
      : { kind: "text", content: "all done", chunks: ["all ", "done"] });
  const repo = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-stream-home-"));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(LOCAL_LLM_|LOCAL_HARNESS_|NEXUS_)/.test(key)) delete env[key];
  try {
    return await new Promise((resolve) => {
      const child = spawn(TSX, ["src/index.ts", "-e", gateway.url, "run", "-y", "-m", "m", "-w", repo, ...extra, "list the directory then finish"], {
        cwd: CLI_DIR,
        env: { ...env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache") },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
      child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    });
  } finally {
    await gateway.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

test("a real run streams start, assistant text, a tool call and a final result: every stdout line is an event", async () => {
  const r = await runStream(["--output", "stream-json"]);
  const lines = r.stdout.split("\n");
  assert.equal(lines.at(-1), "", "stdout ends with a newline");
  const events = lines.slice(0, -1).map((l, i) => {
    try { return JSON.parse(l); } catch { assert.fail(`stdout line ${i + 1} is not JSON: ${l.slice(0, 120)}\nstderr: ${r.stderr.slice(0, 300)}`); }
  });
  assert.equal(events[0].type, "start");
  assert.equal(events[0].model, "m");
  assert.equal(events.at(-1).type, "result");
  assert.equal(events.every((e, i) => e.seq === i + 1 && e.schemaVersion === 1), true, "seq increases by one from 1");
  const types = events.map((e) => e.type);
  assert.ok(types.includes("tool.start") && types.includes("tool.end"), types.join(","));
  assert.ok(types.indexOf("tool.start") < types.indexOf("tool.end"));
  const start = events.find((e) => e.type === "tool.start");
  const end = events.find((e) => e.type === "tool.end");
  assert.equal(start.tool, "list_dir");
  assert.equal(end.call_id, start.call_id);
  assert.equal(end.success, true);
  assert.equal(events.filter((e) => e.type === "assistant.delta").map((e) => e.text).join("").includes("all done"), true);
  const result = events.at(-1);
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 300));
  assert.equal(result.output, "all done");
  assert.equal(r.code, result.exitCode);
});

test("--json and --output keep their meanings: --json prints one document, a bad format is a usage error", async () => {
  const json = await runStream(["--json"]);
  const doc = JSON.parse(json.stdout);
  assert.equal(doc.output, "all done");
  const bad = await runStream(["--output", "xml"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--output must be text, json or stream-json/);
  assert.equal(bad.stdout, "");
  const both = await runStream(["--json", "--output", "stream-json"]);
  assert.equal(both.code, 2);
  assert.match(both.stderr, /--json cannot be combined with --output stream-json/);
});
