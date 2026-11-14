import { test } from "node:test";
import assert from "node:assert/strict";
import { concurrencyIsolationProblem } from "../src/core/operation_schema.js";
import { OperationSpecError, validateOperationSpec } from "../src/operation_cli.js";

const base = {
  objective: "Ship it",
  units: [{ id: "a", prompt: "x" }, { id: "b", prompt: "y" }],
  resources: [{ id: "r1", endpoint: "https://api.test", model: "m" }],
};

test("SI-8: maxConcurrentUnits > 1 without git.isolate is rejected, naming the fix", () => {
  for (const git of [undefined, {}, { isolate: false }]) {
    const spec = { ...base, ...(git ? { git } : {}), policy: { maxConcurrentUnits: 2 } };
    assert.throws(
      () => validateOperationSpec(spec),
      (error: unknown) =>
        error instanceof OperationSpecError &&
        /maxConcurrentUnits is 2/.test(error.message) &&
        /git\.isolate/.test(error.message) &&
        /maxConcurrentUnits 1/.test(error.message),
    );
  }
});

test("SI-8: maxConcurrentUnits > 1 with git.isolate validates", () => {
  assert.doesNotThrow(() => validateOperationSpec({ ...base, git: { isolate: true }, policy: { maxConcurrentUnits: 2 } }));
});

test("SI-8: maxConcurrentUnits 1 or unset is unchanged without isolation", () => {
  assert.doesNotThrow(() => validateOperationSpec({ ...base, policy: { maxConcurrentUnits: 1 } }));
  assert.doesNotThrow(() => validateOperationSpec({ ...base, policy: { maxWaitMs: 1000 } }));
  assert.doesNotThrow(() => validateOperationSpec(base));
});

test("SI-8: the effective (config-merged) policy is checked by the same rule", () => {
  assert.match(concurrencyIsolationProblem(4, false) ?? "", /maxConcurrentUnits is 4/);
  assert.equal(concurrencyIsolationProblem(4, true), undefined);
  assert.equal(concurrencyIsolationProblem(1, false), undefined);
  assert.equal(concurrencyIsolationProblem(undefined, false), undefined);
});
