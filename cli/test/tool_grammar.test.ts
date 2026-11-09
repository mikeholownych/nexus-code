import { test } from "node:test";
import assert from "node:assert/strict";
import { HARNESS_TOOLS } from "../src/core/capabilities.js";
import type { ToolDefinition } from "../src/types.js";
import {
  GBNF_TOOL_ALLOWLIST,
  generateRegisteredToolArgumentGrammars,
  generateToolArgumentsGbnf,
} from "../src/core/tool_grammar.js";

const schemaFor = (name: string) => HARNESS_TOOLS.find((tool) => tool.function.name === name)!;

test("GBNF grammars are generated from exactly the four registered tool schemas", () => {
  const grammars = generateRegisteredToolArgumentGrammars();
  assert.deepEqual(Object.keys(grammars), [...GBNF_TOOL_ALLOWLIST]);

  for (const name of GBNF_TOOL_ALLOWLIST) {
    const parameters = schemaFor(name).function.parameters;
    const grammar = grammars[name];
    const generatedNames = [...grammar.matchAll(/^member-\d+ ::= ("(?:\\.|[^"\\])*") ws ":" ws /gm)]
      .map((match) => JSON.parse(JSON.parse(match[1])));
    assert.deepEqual(generatedNames, Object.keys(parameters.properties), `${name} field names must match its registered schema`);
    for (const match of grammar.matchAll(/^member-\d+ ::= ("(?:\\.|[^"\\])*") ws ":" ws (json-string|json-number|json-boolean)$/gm)) {
      const field = JSON.parse(JSON.parse(match[1]));
      const type = parameters.properties[field as keyof typeof parameters.properties].type;
      const expectedRule = type === "string" ? "json-string" : type === "number" ? "json-number" : "json-boolean";
      assert.equal(match[2], expectedRule, `${name}.${field} value rule must match its registered schema`);
    }
    assert.match(grammar, /^root ::= ws "\{" ws object-fields ws "}" ws$/m);
  }
});

test("GBNF object states permit every property order without duplicate fields and enforce required fields", () => {
  const tool = schemaFor("read_file");
  const grammar = generateToolArgumentsGbnf("read_file");
  const names = Object.keys(tool.function.parameters.properties);
  const requiredMask = (tool.function.parameters.required ?? []).reduce((mask, name) => mask | (1 << names.indexOf(name)), 0);
  const requiredTail = new RegExp(`^fields-tail-${requiredMask} ::= "" \\|`, "m");
  const initialTail = /^fields-tail-0 ::= ""/m;

  assert.match(grammar, requiredTail, "the state containing required path can terminate");
  assert.doesNotMatch(grammar, initialTail, "an object cannot terminate before required path is emitted");
  assert.match(grammar, /"," ws member-0 fields-tail-/);
  assert.match(grammar, /"," ws member-4 fields-tail-/);
});

test("GBNF generation fails closed for recursive or unsupported property schemas", () => {
  const original = schemaFor("read_file");
  const recursive = structuredClone(original) as ToolDefinition;
  recursive.function.parameters.properties.path = {
    type: "object",
    properties: { child: { $ref: "#/$defs/path" } },
  } as never;
  const registered = HARNESS_TOOLS.filter((tool) => tool.function.name !== "read_file").concat(recursive);
  assert.throws(() => generateToolArgumentsGbnf("read_file", registered), /unsupported JSON Schema type/);

  const referenced = structuredClone(original) as ToolDefinition;
  referenced.function.parameters.properties.path = { type: "string", $ref: "#/$defs/path" } as never;
  const withReference = HARNESS_TOOLS.filter((tool) => tool.function.name !== "read_file").concat(referenced);
  assert.throws(() => generateToolArgumentsGbnf("read_file", withReference), /unsupported schema keyword \$ref/);
});

test("GBNF generation rejects missing, duplicate, out-of-scope, and overlarge schemas", () => {
  const readFile = schemaFor("read_file");
  assert.throws(
    () => generateToolArgumentsGbnf("read_file", HARNESS_TOOLS.filter((tool) => tool.function.name !== "read_file")),
    /found 0/,
  );
  assert.throws(() => generateToolArgumentsGbnf("read_file", [...HARNESS_TOOLS, readFile]), /found 2/);
  assert.throws(() => generateToolArgumentsGbnf("list_dir" as never), /not enabled/);

  const oversized = structuredClone(readFile) as ToolDefinition;
  for (let i = 0; i < 9; i++) oversized.function.parameters.properties[`extra_${i}`] = { type: "string" };
  const registered = HARNESS_TOOLS.filter((tool) => tool.function.name !== "read_file").concat(oversized);
  assert.throws(() => generateToolArgumentsGbnf("read_file", registered), /8-property GBNF bound/);
});

test("compiled argument grammars accept valid argument objects and reject invalid ones (structural)", async () => {
  const { gbnfAccepts } = await import("./helpers/gbnf_match.js");
  const read = generateToolArgumentsGbnf("read_file");
  assert.equal(gbnfAccepts(read, '{"path":"a.txt"}'), true);
  assert.equal(gbnfAccepts(read, '{"start_line":2,"path":"a.txt"}'), true);
  assert.equal(gbnfAccepts(read, '{"start_line":2}'), false, "a required property is mandatory");
  assert.equal(gbnfAccepts(read, '{"path":"a.txt","path":"b"}'), false, "no duplicate properties");
  assert.equal(gbnfAccepts(read, '{path:"a.txt"}'), false, "property names are quoted JSON strings");
});
