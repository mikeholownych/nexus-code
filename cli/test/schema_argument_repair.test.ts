/**
 * WM-1: schema-driven argument repair. A call whose argument values arrive as text for a plain typed property is
 * converted, and counted as `schema` (a repair scored 0.5), never as native valid. Ambiguous values and schemas are
 * left alone, and without declared tools the parser behaves exactly as before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseModelResponse } from "../src/parser.js";
import { HARNESS_TOOLS } from "../src/tools.js";
import { coerceToolArgumentTypes } from "../src/core/tool_arguments.js";
import type { ToolDefinition } from "../src/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { evaluateJsonRepairRate }: any = await import(pathToFileURL(path.join(ROOT, "eval/evaluators/code/json_repair_rate.mjs")).href);

const call = (name: string, args: string, tools: readonly ToolDefinition[] | null = HARNESS_TOOLS) => parseModelResponse(
  { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: args } }] } as any,
  { nativeTools: true, tools: tools ?? undefined },
);
const sent = (out: ReturnType<typeof call>) => JSON.parse(String(out.toolCalls[0].function.arguments));

test("a number written as text is converted and counted as a repair, not native valid", () => {
  const out = call("read_file", '{"path":"a.txt","start_line":"20","end_line":" 30 "}');
  assert.deepEqual(sent(out), { path: "a.txt", start_line: 20, end_line: 30 });
  assert.deepEqual(out.toolCallSyntax, { native: 0, trailing: 0, structural: 0, invalid: 0, schema: 1 });
  const score = evaluateJsonRepairRate(out.toolCallSyntax);
  assert.equal(score.details.native, 0);
  assert.equal(score.details.repaired, 1);
  assert.equal(score.score, 0.5);
});

test("a boolean written as text is converted", () => {
  const out = call("edit_file", '{"path":"a.txt","old_string":"x","new_string":"y","replace_all":"True"}');
  assert.equal(sent(out).replace_all, true);
  assert.equal(out.toolCallSyntax?.schema, 1);
});

test("values that are not unambiguously the declared type are left as sent and the call stays native", () => {
  for (const [args, expect] of [
    ['{"path":"a.txt","start_line":"twenty"}', "twenty"],
    ['{"path":"a.txt","start_line":""}', ""],
    ['{"path":"a.txt","start_line":"0x10"}', "0x10"],
    ['{"path":"a.txt","start_line":"Infinity"}', "Infinity"],
  ] as const) {
    const out = call("read_file", args);
    assert.equal(sent(out).start_line, expect, args);
    assert.deepEqual(out.toolCallSyntax, { native: 1, trailing: 0, structural: 0, invalid: 0, schema: 0 }, args);
  }
});

test("a string-typed property keeps text that looks like a number", () => {
  const out = call("read_file", '{"path":"20"}');
  assert.equal(sent(out).path, "20");
  assert.equal(out.toolCallSyntax?.native, 1);
});

test("without declared tools nothing is converted (the parser is unchanged)", () => {
  const out = call("read_file", '{"path":"a.txt","start_line":"20"}', null);
  assert.equal(sent(out).start_line, "20");
  assert.equal(out.toolCallSyntax?.native, 1);
});

test("a call that already needed a syntax repair keeps that class: one call, one count", () => {
  const out = call("read_file", '{"path":"a.txt","start_line":"20",}');
  assert.equal(sent(out).start_line, 20);
  assert.deepEqual(out.toolCallSyntax, { native: 0, trailing: 1, structural: 0, invalid: 0, schema: 0 });
});

test("a call wrapped in an input object is unwrapped before its values are converted", () => {
  const out = call("read_file", '{"input":{"path":"a.txt","start_line":"5"}}');
  assert.deepEqual(sent(out), { path: "a.txt", start_line: 5 });
  assert.equal(out.toolCallSyntax?.schema, 1);
});

const custom: ToolDefinition[] = [{
  type: "function",
  function: {
    name: "probe",
    description: "t",
    parameters: {
      type: "object",
      properties: {
        list: { type: "array", items: { type: "string" } },
        opts: { type: "object" },
        either: { anyOf: [{ type: "integer" }, { type: "string" }] },
        mode: { type: "integer", enum: [1, 2] },
        n: { type: "integer" },
      },
    },
  },
} as ToolDefinition];

test("a JSON string for an array or object property is parsed only when it is the declared kind", () => {
  const ok = coerceToolArgumentTypes("probe", { list: '["a","b"]', opts: '{"k":1}' }, custom);
  assert.deepEqual(ok.args, { list: ["a", "b"], opts: { k: 1 } });
  assert.deepEqual(ok.repairs, ["list", "opts"]);
  const wrongKind = coerceToolArgumentTypes("probe", { list: '{"a":1}', opts: "[1]" }, custom);
  assert.deepEqual(wrongKind.args, { list: '{"a":1}', opts: "[1]" });
  assert.deepEqual(wrongKind.repairs, []);
  const broken = coerceToolArgumentTypes("probe", { list: '["a",' }, custom);
  assert.deepEqual(broken.repairs, []);
});

test("unions and enums are never converted; a plain integer beside them still is", () => {
  const r = coerceToolArgumentTypes("probe", { either: "7", mode: "1", n: "7", unknown: "7" }, custom);
  assert.deepEqual(r.args, { either: "7", mode: "1", n: 7, unknown: "7" });
  assert.deepEqual(r.repairs, ["n"]);
});

test("an integer property refuses a fraction and a value beyond the safe range", () => {
  const r = coerceToolArgumentTypes("probe", { n: "2.5" }, custom);
  assert.deepEqual(r.repairs, []);
  assert.deepEqual(coerceToolArgumentTypes("probe", { n: "9007199254740993" }, custom).repairs, []);
});

test("a scalar is never wrapped into an array", () => {
  assert.deepEqual(coerceToolArgumentTypes("probe", { list: "a" }, custom).repairs, []);
});
