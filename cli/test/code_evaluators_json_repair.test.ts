/** WP-1302: json_repair_rate input handling. */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ev: any = await import(pathToFileURL(path.join(ROOT, "eval/evaluators/code/index.mjs")).href);

test("json_repair_rate rejects whole turn results instead of reporting 'no tool calls'", () => {
  assert.throws(() => ev.evaluateJsonRepairRate({ execution: "COMPLETED", outcome: "VERIFIED", toolCallSyntax: { native: 2, trailing: 0, structural: 0, invalid: 0 } }), /toolCallSyntax/);
  assert.throws(() => ev.evaluateJsonRepairRate([{ steps: 3 }]), /toolCallSyntax/);
  assert.equal(ev.evaluateJsonRepairRate({ native: 2, trailing: 0, structural: 0, invalid: 0 }).passed, true);
  assert.equal(ev.evaluateJsonRepairRate(undefined).details.error, "no tool calls recorded");
});
