import { test } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeEvent, parseCommand, PROTOCOL_VERSION } from "../src/protocol.js";
import type { SidecarEvent } from "../src/protocol.js";

// Shared with the Rust TUI test in core/src/bin/nexus_tui/protocol.rs. A change to either side's wire
// format must be accompanied by a deliberate corpus update, not discovered by a downstream consumer.
const corpusPath = fileURLToPath(new URL("./fixtures/protocol_v1_golden.jsonl", import.meta.url));
const records = fs.readFileSync(corpusPath, "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line, index) => ({ ...JSON.parse(line), index }));

test("protocol golden corpus is present and versioned", () => {
  assert.ok(records.length >= 8, "the golden corpus must cover both directions of the v1 protocol");
  for (const record of records) {
    const value = JSON.parse(record.json);
    assert.equal(value.v, PROTOCOL_VERSION, `record ${record.index} must be protocol v${PROTOCOL_VERSION}`);
    assert.equal(value.type, record.name, `record ${record.index} type must match its corpus name`);
    assert.ok(["event", "command"].includes(record.direction), `record ${record.index} has a known direction`);
  }
});

test("the current hello carries the typed slash-command catalogue", () => {
  const hello = records.find((record) => record.name === "hello" && Array.isArray(JSON.parse(record.json).commands));
  assert.ok(hello, "the corpus includes the current hello event");
  const value = JSON.parse(hello.json);
  assert.deepEqual(value.commands[0], { name: "help", usage: "/help", summary: "Show help" });
});

test("the golden corpus covers capability negotiation in both directions", () => {
  const named = (direction: string, name: string) => records.filter((r) => r.direction === direction && r.name === name).map((r) => JSON.parse(r.json));
  const hellos = named("event", "hello");
  assert.ok(hellos.some((hello) => hello.protocol_min === undefined), "a hello from a sidecar older than negotiation stays in the corpus");
  const hello = hellos.find((h) => h.protocol_min !== undefined);
  assert.ok(hello, "a hello with the negotiation fields");
  assert.ok(Number.isInteger(hello.protocol_min) && Number.isInteger(hello.protocol_max) && hello.protocol_min <= hello.protocol && hello.protocol <= hello.protocol_max);
  assert.ok(Array.isArray(hello.capabilities) && Array.isArray(hello.experimental));
  assert.equal(named("command", "initialize").length, 1);
  const [initialized] = named("event", "initialized");
  assert.ok(initialized && Array.isArray(initialized.capabilities) && Array.isArray(initialized.experimental));
});

test("sidecar events in the golden corpus encode to exactly the recorded wire shape", () => {
  for (const record of records.filter((r) => r.direction === "event")) {
    const { v: _version, ...event } = JSON.parse(record.json);
    const line = encodeEvent(event as SidecarEvent);
    assert.ok(line.endsWith("\n"), `${record.name} encodes as one NDJSON line`);
    assert.equal(line.indexOf("\n"), line.length - 1, `${record.name} has no embedded raw newline`);
    assert.deepEqual(JSON.parse(line), { v: PROTOCOL_VERSION, ...event }, `${record.name} wire shape`);
  }
});

test("Rust TUI commands in the golden corpus parse to exactly the recorded values", () => {
  for (const record of records.filter((r) => r.direction === "command")) {
    const { v: _version, ...expected } = JSON.parse(record.json);
    assert.deepEqual(parseCommand(record.json), expected, `${record.name} parsed command`);
  }
});
