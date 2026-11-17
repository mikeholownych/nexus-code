/** VC-1: an operator declares boundary rules in the operation spec; they are stored with the operation and a damaged record is refused. */
import test from "node:test";
import assert from "node:assert/strict";
import { OperationSpecError, validateOperationSpec } from "../src/operation_cli.js";
import { newOperation } from "../src/core/operation.js";
import { InvalidOperationStateError, migrateOperationState } from "../src/core/operation_schema.js";

const base = { objective: "o", units: [{ id: "impl", prompt: "do it" }, { id: "rev", role: "reviewer", prompt: "review", dependsOn: ["impl"] }] };
const RULES = { imports: [{ name: "ui-not-db", from: ["src/ui/**"], deny: ["src/db/**"] }], protected: ["src/api/public.ts"] };

test("a spec may declare boundary rules; errors name the field and an unknown key is still refused", () => {
  assert.doesNotThrow(() => validateOperationSpec({ ...base, boundaries: RULES }));
  assert.doesNotThrow(() => validateOperationSpec(base), "rules absent is the existing spec");
  const bad: Array<[unknown, RegExp]> = [
    [{ imports: [{ name: "x", from: ["a/**"] }] }, /operation spec boundaries\.imports\[0\]: needs deny, allow or both/],
    [{ surprise: 1 }, /operation spec boundaries\.surprise: unknown field/],
    ["rules", /operation spec boundaries: must be an object/],
  ];
  for (const [boundaries, re] of bad) assert.throws(() => validateOperationSpec({ ...base, boundaries }), (e: Error) => e instanceof OperationSpecError && re.test(e.message));
});

test("the rules are stored with the operation and survive a save and load; a record without them loads unchanged", () => {
  const state = newOperation("op1", "o", base.units as any, [{ id: "r", model: "m", capabilities: [], qualifications: [], contextLength: 8192 } as any], 0);
  state.boundaries = RULES;
  const loaded = migrateOperationState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(loaded.boundaries, RULES);
  delete state.boundaries;
  const older = migrateOperationState(JSON.parse(JSON.stringify(state)));
  assert.equal("boundaries" in older, false);
});

test("a damaged boundary declaration in a stored record is refused, never skipped (skipping would switch the check off)", () => {
  const state = newOperation("op2", "o", base.units as any, [{ id: "r", model: "m", capabilities: [], qualifications: [], contextLength: 8192 } as any], 0);
  state.boundaries = { imports: [{ name: "x", from: ["a/**"] }] } as any;
  assert.throws(() => migrateOperationState(JSON.parse(JSON.stringify(state))), (e: Error) => e instanceof InvalidOperationStateError && /operation op2: boundaries\.imports\[0\]: needs deny, allow or both/.test(e.message));
});
