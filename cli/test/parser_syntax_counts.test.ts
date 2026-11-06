/**
 * WP-1302b: `toolCallSyntax` counts every tool call the parser executes, including the legacy text-mode paths, and
 * classifies Markdown-fence removal as a repair. Each case drives parseModelResponse and scores the result with the
 * real json_repair_rate evaluator, so an evaluator change cannot hide a counting regression.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseModelResponse } from "../src/parser.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { evaluateJsonRepairRate }: any = await import(pathToFileURL(path.join(ROOT, "eval/evaluators/code/json_repair_rate.mjs")).href);

function withLegacy<T>(fn: () => T): T {
  const prior = process.env.NEXUS_TEXT_TOOL_PARSING;
  process.env.NEXUS_TEXT_TOOL_PARSING = "legacy";
  try { return fn(); } finally {
    if (prior === undefined) delete process.env.NEXUS_TEXT_TOOL_PARSING; else process.env.NEXUS_TEXT_TOOL_PARSING = prior;
  }
}

const nativeCall = (args: string) => parseModelResponse(
  { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: args } }] } as any,
  { nativeTools: true },
);

test("legacy code-block calls are counted and scored", () => {
  const out = withLegacy(() => parseModelResponse({
    role: "assistant",
    content: 'I will read it.\n```json\n{"name":"read_file","arguments":{"path":"a.txt"}}\n```\nThen continue.',
  }, { nativeTools: false }));
  assert.equal(out.toolCalls.length, 1);
  assert.deepEqual(out.toolCallSyntax, { native: 1, trailing: 0, structural: 0, invalid: 0 });
  const score = evaluateJsonRepairRate(out.toolCallSyntax);
  assert.equal(score.details.total, 1);
  assert.equal(score.score, 1);
});

test("legacy code-block calls with repaired arguments score 0.5", () => {
  const out = withLegacy(() => parseModelResponse({
    role: "assistant",
    content: 'Reading.\n```json\n{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\",}"}\n```\nDone.',
  }, { nativeTools: false }));
  assert.equal(out.toolCalls.length, 1);
  assert.deepEqual(out.toolCallSyntax, { native: 0, trailing: 1, structural: 0, invalid: 0 });
  assert.equal(evaluateJsonRepairRate(out.toolCallSyntax).score, 0.5);
});

test("legacy balanced-object calls are counted and scored", () => {
  const out = withLegacy(() => parseModelResponse({
    role: "assistant",
    content: 'First {"name":"read_file","arguments":{"path":"a.txt"}} and then {"name":"read_file","arguments":{"path":"b.txt"}}.',
  }, { nativeTools: false }));
  assert.equal(out.toolCalls.length, 2);
  assert.deepEqual(out.toolCallSyntax, { native: 2, trailing: 0, structural: 0, invalid: 0 });
  assert.equal(evaluateJsonRepairRate(out.toolCallSyntax).details.total, 2);
});

test("native arguments wrapped in a Markdown fence count as a repair, not native", () => {
  const out = nativeCall('```json\n{"path":"a.txt"}\n```');
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0].function.arguments, '{"path":"a.txt"}');
  assert.deepEqual(out.toolCallSyntax, { native: 0, trailing: 1, structural: 0, invalid: 0 });
  const score = evaluateJsonRepairRate(out.toolCallSyntax);
  assert.equal(score.score, 0.5);
  assert.equal(score.details.repaired, 1);
});

test("a fenced argument string that also needs structural repair stays structural", () => {
  const out = nativeCall('```json\n{"path":"a.txt"\n```');
  assert.equal(out.toolCallSyntax?.structural, 1);
  assert.equal(out.toolCallSyntax?.native, 0);
});

test("plain native, tag and sole-fence calls keep their classification", () => {
  assert.deepEqual(nativeCall('{"path":"a.txt"}').toolCallSyntax, { native: 1, trailing: 0, structural: 0, invalid: 0 });
  const tag = parseModelResponse({ role: "assistant", content: '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>' }, { nativeTools: false });
  assert.deepEqual(tag.toolCallSyntax, { native: 1, trailing: 0, structural: 0, invalid: 0 });
  const fenced = parseModelResponse({ role: "assistant", content: '```json\n{"name":"read_file","arguments":{"path":"a.txt"}}\n```' }, { nativeTools: false });
  assert.deepEqual(fenced.toolCallSyntax, { native: 1, trailing: 0, structural: 0, invalid: 0 });
});
