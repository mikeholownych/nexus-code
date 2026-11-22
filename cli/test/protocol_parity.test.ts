import { test } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCommand, PROTOCOL_VERSION } from "../src/protocol.js";
import { generateSamples, samplesFile, samplesText, schemaFile } from "../scripts/gen_protocol_samples.mjs";
import { validate, type Schema } from "./helpers/json_schema.js";

// TypeScript/Rust parity, driven by the published schema (PF-1). Two checked-in files carry it between the languages:
//   - fixtures/protocol_v1_schema_samples.jsonl: generated from the schema here; the Rust test
//     `schema_samples_parse_as_their_own_event_variants` parses every event sample into its `Event` enum.
//   - fixtures/protocol_v1_rust_commands.jsonl: the exact lines the Rust client serializes (the Rust test
//     `rust_commands_are_the_checked_in_fixture_and_published_commands` keeps it so); validated here.
const schema: Schema = JSON.parse(fs.readFileSync(schemaFile(PROTOCOL_VERSION), "utf8"));
const direction = { event: { $ref: "#/$defs/SidecarEvent" }, command: { $ref: "#/$defs/SidecarCommand" } };
const variants = (name: "SidecarEvent" | "SidecarCommand"): Schema[] => schema.$defs[name].oneOf;
const checkedIn = fs.readFileSync(samplesFile(PROTOCOL_VERSION), "utf8");
const samples: Array<{ direction: "event" | "command"; name: string; shape: "minimal" | "full"; json: string }> = checkedIn.split("\n").filter(Boolean).map((line) => JSON.parse(line));

test("the checked-in schema samples equal a fresh generation from the schema", () => {
  assert.equal(checkedIn, samplesText(schema), "the schema samples are out of date: run `node cli/scripts/gen_protocol_samples.mjs`");
  assert.deepEqual(generateSamples(schema), generateSamples(schema), "generation is deterministic");
});

test("every sample validates against the schema for its direction", () => {
  assert.ok(samples.length > 0);
  for (const sample of samples) {
    const message = JSON.parse(sample.json);
    assert.equal(message.type, sample.name);
    assert.equal(message.v, PROTOCOL_VERSION);
    assert.deepEqual(validate(message, direction[sample.direction], schema), [], `${sample.direction} ${sample.name} (${sample.shape})`);
  }
});

test("every message has a minimal sample of exactly its required fields and a full sample of every field", () => {
  for (const [to, def] of [["event", "SidecarEvent"], ["command", "SidecarCommand"]] as const) {
    for (const variant of variants(def)) {
      const name = variant.properties.type.const;
      const of = (shape: string) => samples.filter((s) => s.direction === to && s.name === name && s.shape === shape).map((s) => Object.keys(JSON.parse(s.json)).sort());
      assert.deepEqual(of("minimal"), [[...variant.required].sort()], `${to} ${name}: one minimal sample with the required fields only`);
      const full = of("full");
      assert.ok(full.length >= 1, `${to} ${name}: a full sample`);
      for (const keys of full) assert.deepEqual(keys, Object.keys(variant.properties).sort(), `${to} ${name}: a full sample carries every field`);
    }
  }
  const known = new Set([...variants("SidecarEvent").map((v) => `event ${v.properties.type.const}`), ...variants("SidecarCommand").map((v) => `command ${v.properties.type.const}`)]);
  for (const sample of samples) assert.ok(known.has(`${sample.direction} ${sample.name}`), `${sample.direction} ${sample.name} is a published message`);
});

// The schema says what a command's fields are and their JSON types; parseCommand also checks values the schema does
// not describe. A sample of fixed values ("s", 1) passes every such check but these, each refused for the reason given.
const SAMPLE_REFUSED_BY_PARSER: Record<string, RegExp> = {
  answer: /^answer requires question: the 12-character needsInput\.id$/,
};

test("parseCommand accepts every command sample the schema allows", () => {
  const refused = new Set<string>();
  for (const sample of samples.filter((s) => s.direction === "command")) {
    const expected = SAMPLE_REFUSED_BY_PARSER[sample.name];
    if (expected) {
      assert.throws(() => parseCommand(sample.json), { name: "ProtocolError", message: expected }, `${sample.name} (${sample.shape})`);
      refused.add(sample.name);
      continue;
    }
    const parsed = parseCommand(sample.json) as Record<string, unknown>;
    const { v: _version, ...sent } = JSON.parse(sample.json);
    // A full sample comes back whole. A minimal one may gain the defaults parseCommand fills in (initialize's range).
    if (sample.shape === "full") assert.deepEqual(parsed, sent, `${sample.name} (full)`);
    else assert.deepEqual(Object.fromEntries(Object.keys(sent).map((key) => [key, parsed[key]])), sent, `${sample.name} (minimal)`);
  }
  assert.deepEqual([...refused].sort(), Object.keys(SAMPLE_REFUSED_BY_PARSER).sort(), "a listed refusal has no sample");
});

test("every command line the Rust client serializes validates against the schema and is accepted by parseCommand", () => {
  const file = fileURLToPath(new URL(`./fixtures/protocol_v${PROTOCOL_VERSION}_rust_commands.jsonl`, import.meta.url));
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.endsWith("\n"), "each command ends with a newline");
  const lines = text.slice(0, -1).split("\n");
  const published = new Set(variants("SidecarCommand").map((variant) => variant.properties.type.const));
  const sent = new Set<string>();
  for (const line of lines) {
    const message = JSON.parse(line);
    assert.deepEqual(validate(message, direction.command, schema), [], line);
    // parseCommand keeps the fields it knows and drops the rest, so equality here means the Rust client sent no field
    // under a name the sidecar does not read (an optional field renamed on one side only).
    const { v: _version, ...fields } = message;
    assert.deepEqual(parseCommand(line), fields, line);
    assert.ok(published.has(message.type));
    sent.add(message.type);
  }
  assert.ok(sent.size >= 5 && sent.has("initialize") && sent.has("provider.connect"));
});
