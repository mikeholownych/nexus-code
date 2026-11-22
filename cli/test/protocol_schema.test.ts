import { test } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { EXPERIMENTAL_FEATURES, PROTOCOL_MAX, PROTOCOL_MIN, PROTOCOL_VERSION, SIDECAR_CAPABILITIES } from "../src/protocol.js";
import { generateProtocolSchema, ledgerProblem, LEDGER_FILE, schemaFile, sha256 } from "../scripts/gen_protocol_schema.mjs";
import { validate, type Schema } from "./helpers/json_schema.js";

// The published schema (docs/protocol) is generated from src/protocol.ts. These tests fail when a protocol type changes
// without the schema being regenerated and the version decision being recorded in the ledger.
const generated = generateProtocolSchema();
const checkedIn = fs.readFileSync(schemaFile(PROTOCOL_VERSION), "utf8");
const schema: Schema = JSON.parse(checkedIn);
const direction = { event: { $ref: "#/$defs/SidecarEvent" }, command: { $ref: "#/$defs/SidecarCommand" } };
const check = (message: unknown, to: keyof typeof direction) => validate(message, direction[to], schema);
const variantTypes = (name: "SidecarEvent" | "SidecarCommand"): string[] => schema.$defs[name].oneOf.map((variant: Schema) => variant.properties.type.const);

test("the checked-in protocol schema equals a fresh generation from src/protocol.ts", () => {
  assert.equal(generated.version, PROTOCOL_VERSION);
  assert.equal(
    checkedIn,
    generated.text,
    "docs/protocol schema is out of date: run `node cli/scripts/gen_protocol_schema.mjs`, then record the version decision in docs/protocol/VERSIONS.json",
  );
});

test("the newest version-ledger entry records the current schema and protocol version", () => {
  const ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
  assert.equal(ledgerProblem(checkedIn, ledger, PROTOCOL_VERSION), undefined);
  for (const entry of ledger) {
    assert.ok(Number.isInteger(entry.protocol) && /^[0-9a-f]{64}$/.test(entry.schemaSha256) && typeof entry.note === "string" && entry.note.trim(), "each entry has protocol, schemaSha256 and a note");
  }
  // The rule itself: a changed schema, or a version bump, without a new entry is a failure.
  assert.match(ledgerProblem(`${checkedIn} `, ledger, PROTOCOL_VERSION) ?? "", /add an entry/);
  assert.match(ledgerProblem(checkedIn, ledger, PROTOCOL_VERSION + 1) ?? "", /PROTOCOL_VERSION is/);
  assert.match(ledgerProblem(checkedIn, [], PROTOCOL_VERSION) ?? "", /no entries/);
  assert.equal(ledger[ledger.length - 1].schemaSha256, sha256(checkedIn));
});

// Golden records that predate a field the type now requires. The Rust client still accepts them (older sidecars), so
// they stay in the corpus; each must fail for exactly the reason listed, so this list can only shrink.
const GOLDEN_MISSING_REQUIRED: Record<string, string[]> = {
  hello: ["$: missing required commands"],
  "tool.end": ["$: missing required evidence"],
};

test("every golden corpus record validates against the schema for its direction", () => {
  const corpus = fileURLToPath(new URL("./fixtures/protocol_v1_golden.jsonl", import.meta.url));
  const records = fs.readFileSync(corpus, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(records.length >= 8);
  const exceptions = new Set(Object.keys(GOLDEN_MISSING_REQUIRED));
  for (const record of records) {
    const message = JSON.parse(record.json);
    const errors = check(message, record.direction);
    // A later record of the same name that carries the field (the hello with the negotiation fields) is not a gap.
    const gaps = record.direction === "event" ? (GOLDEN_MISSING_REQUIRED[record.name] ?? []).filter((gap) => !(gap.replace("$: missing required ", "") in message)) : [];
    const expected = gaps.length ? gaps : undefined;
    if (expected) {
      exceptions.delete(record.name);
      assert.deepEqual(errors.filter((error) => !error.includes("oneOf alternative")), expected, `${record.name}: known gap`);
    } else {
      assert.deepEqual(errors, [], `${record.direction} ${record.name}`);
    }
  }
  assert.deepEqual([...exceptions], [], "a listed exception has no golden record");
});

test("messages built to the current types validate", () => {
  assert.deepEqual(check({ v: 1, type: "hello", protocol: 1, pid: 42, commands: [{ name: "help", usage: "/help", summary: "Show help" }] }, "event"), []);
  assert.deepEqual(check({ v: 1, type: "tool.end", turn_id: "t1", call_id: "c1", tool: "run_command", success: true, summary: "ok", lines: 1, evidence: "e1", exit_code: null }, "event"), []);
  assert.deepEqual(check({ v: 1, type: "receipt", id: "r1", sections: [{ title: "Last turn", rows: [["result", "ok"]] }] }, "event"), []);
  assert.deepEqual(check({ v: 1, type: "session.state", workspace: "/w", workspace_name: "w", model: "m", mode: "review", git: null, busy: true }, "event"), []);
  assert.deepEqual(check({ v: 1, type: "checkpoint.choice", id: "c1", choice: "retry" }, "command"), []);
  // Capability negotiation: the hello a current sidecar sends, initialize with and without its optional fields, and the answer.
  assert.deepEqual(check({ v: 1, type: "hello", protocol: 1, pid: 42, commands: [], protocol_min: 1, protocol_max: 1, capabilities: [...SIDECAR_CAPABILITIES], experimental: [] }, "event"), []);
  assert.deepEqual(check({ v: 1, type: "initialize", id: "i1", client: { name: "c", version: "1" } }, "command"), []);
  assert.deepEqual(check({ v: 1, type: "initialize", id: "i1", client: { name: "c", version: "1" }, protocol_min: 1, protocol_max: 2, experimental: true }, "command"), []);
  assert.deepEqual(check({ v: 1, type: "initialized", id: "i1", protocol: 1, capabilities: ["steer"], experimental: [] }, "event"), []);
  assert.deepEqual(check({ v: 1, type: "error", id: "i1", code: "UNSUPPORTED_PROTOCOL", message: "m" }, "event"), []);
  assert.deepEqual(check({ v: 1, type: "error", code: "EXPERIMENTAL_DISABLED", message: "m" }, "event"), []);
  // Forward compatibility: a field a newer peer added is ignored, not rejected.
  assert.deepEqual(check({ v: 1, type: "assistant.delta", turn_id: "t1", text: "hi", added_later: 1 }, "event"), []);
});

test("the validator rejects messages the schema does not allow", () => {
  const rejected = (message: unknown, to: keyof typeof direction, reason: RegExp) => {
    const errors = check(message, to);
    assert.ok(errors.some((error) => reason.test(error)), `expected ${reason} in ${JSON.stringify(errors)}`);
  };
  rejected({ v: 1, type: "no.such.message" }, "event", /matches no oneOf alternative/);
  rejected({ v: 1, type: "no.such.message", id: "x" }, "command", /matches no oneOf alternative/);
  rejected({ v: 1, type: "assistant.delta", turn_id: "t1" }, "event", /missing required text/);
  rejected({ v: 1, type: "prompt.submit", text: "hi" }, "command", /missing required id/);
  rejected({ v: 1, type: "assistant.delta", turn_id: "t1", text: 7 }, "event", /\$\.text: expected string, got number/);
  rejected({ v: 1, type: "approve", id: "a1", always: "yes" }, "command", /\$\.always: expected boolean, got string/);
  rejected({ v: 1, type: "session.state", workspace: "/w", workspace_name: "w", model: "m", mode: "yolo", git: null, busy: true }, "event", /\$\.mode: not one of/);
  rejected({ v: 1, type: "receipt", id: "r1", sections: [{ title: "t", rows: [["only one"]] }] }, "event", /fewer than 2 items/);
  rejected({ v: 2, type: "shutdown" }, "command", /\$\.v: expected 1/);
  rejected({ v: 1, type: "initialize", id: "i1" }, "command", /missing required client/);
  rejected({ v: 1, type: "initialize", id: "i1", client: { name: "c" } }, "command", /missing required version/);
  rejected({ v: 1, type: "initialized", id: "i1", protocol: 1, capabilities: [] }, "event", /missing required experimental/);
  rejected({ v: 1, type: "hello", protocol: 1, pid: 1, commands: [], capabilities: "steer" }, "event", /\$\.capabilities: expected array/);
  rejected({ type: "shutdown" }, "command", /missing required v/);
  // A command of the same name does not pass as the event (tool.detail and receipt exist in both directions).
  rejected({ v: 1, type: "tool.detail", id: "d1", evidence: "e1" }, "event", /missing required/);
  assert.throws(() => validate(1, { minimum: 0 }), /unsupported schema keyword/);
});

test("parseCommand handles exactly the command variants the schema publishes", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/protocol.ts", import.meta.url)), "utf8");
  const start = source.indexOf("export function parseCommand(");
  const end = source.indexOf("\nexport function ", start + 1);
  assert.ok(start >= 0 && end > start, "parseCommand is in src/protocol.ts");
  const handled = [...source.slice(start, end).matchAll(/\bcase "([^"]+)":/g)].map((match) => match[1]).sort();
  assert.ok(handled.length > 0);
  assert.deepEqual(handled, variantTypes("SidecarCommand").sort());
  assert.ok(handled.includes("initialize"));
});

test("every announced capability is a published command type, and the list is sorted and unique", () => {
  const commands = variantTypes("SidecarCommand");
  for (const capability of SIDECAR_CAPABILITIES) assert.ok(commands.includes(capability), `${capability} is a command type`);
  assert.deepEqual([...SIDECAR_CAPABILITIES], [...new Set<string>(SIDECAR_CAPABILITIES)].sort());
  assert.ok(PROTOCOL_MIN <= PROTOCOL_VERSION && PROTOCOL_VERSION <= PROTOCOL_MAX, "the default version lies in the announced range");
  assert.deepEqual(EXPERIMENTAL_FEATURES, [], "no experimental feature is offered yet; the first one updates this");
});

test("message variants are told apart by a constant type and carry the wire version", () => {
  for (const name of ["SidecarEvent", "SidecarCommand"] as const) {
    const types = variantTypes(name);
    assert.equal(new Set(types).size, types.length, `${name} variant types are unique`);
    for (const variant of schema.$defs[name].oneOf) {
      assert.equal(typeof variant.properties.type.const, "string");
      assert.deepEqual(variant.properties.v, { const: PROTOCOL_VERSION });
      assert.ok(variant.required.includes("type") && variant.required.includes("v"));
      assert.notEqual(variant.additionalProperties, false, "messages stay open to fields added later");
    }
  }
});
