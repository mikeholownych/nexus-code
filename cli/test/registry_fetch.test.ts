/** The registry lookup behind the dependency deprecation check: transient failures are retried, real answers are not, and exhaustion still throws (so the check stays fail-closed). */
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain ESM script, no declarations
import { fetchRegistryJson } from "../../scripts/registry-fetch.mjs";

type Step = { status: number; body?: unknown } | { error: Error } | { badBody: true };
function script(steps: Step[]) {
  const calls: Array<{ url: string; hasSignal: boolean }> = [];
  const sleeps: number[] = [];
  const fetchImpl = async (url: string, init: { signal?: AbortSignal }) => {
    calls.push({ url, hasSignal: init.signal instanceof AbortSignal });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if ("error" in step) throw step.error;
    return {
      ok: "badBody" in step || ("status" in step && step.status >= 200 && step.status < 300),
      status: "status" in step ? step.status : 200,
      json: async () => {
        if ("badBody" in step) throw new SyntaxError("Unexpected end of JSON input");
        return (step as { body?: unknown }).body ?? {};
      },
    };
  };
  return { calls, sleeps, options: { fetchImpl, sleep: async (ms: number) => void sleeps.push(ms) } };
}
const URL_ = "https://registry.npmjs.org/typescript/7.0.2";

test("a good answer is returned at once: one request, no waiting, a timeout signal attached", async () => {
  const s = script([{ status: 200, body: { name: "typescript" } }]);
  assert.deepEqual(await fetchRegistryJson(URL_, s.options), { name: "typescript" });
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.sleeps, []);
  assert.equal(s.calls[0].hasSignal, true);
});

test("the failure that turned main red (fetch failed) is retried with 1 s then 3 s of backoff and then succeeds", async () => {
  const s = script([{ error: new TypeError("fetch failed") }, { error: new TypeError("fetch failed") }, { status: 200, body: { deprecated: false } }]);
  assert.deepEqual(await fetchRegistryJson(URL_, s.options), { deprecated: false });
  assert.equal(s.calls.length, 3);
  assert.deepEqual(s.sleeps, [1000, 3000]);
});

test("rate limits, server errors, timeouts and a body cut off mid-read are all transient", async () => {
  for (const first of [{ status: 429 }, { status: 500 }, { status: 503 }, { error: Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }) }, { badBody: true }] as Step[]) {
    const s = script([first, { status: 200, body: { ok: 1 } }]);
    assert.deepEqual(await fetchRegistryJson(URL_, s.options), { ok: 1 }, JSON.stringify(first));
    assert.equal(s.calls.length, 2);
  }
});

test("a real answer is not retried: 404 and 403 fail at once with the registry's own status", async () => {
  for (const status of [404, 403, 401]) {
    const s = script([{ status }, { status: 200 }]);
    await assert.rejects(fetchRegistryJson(URL_, s.options), new RegExp(`^Error: registry returned HTTP ${status}$`));
    assert.equal(s.calls.length, 1, `HTTP ${status}`);
    assert.deepEqual(s.sleeps, []);
  }
});

test("when the attempts run out it throws, saying how many were made, so the check stays fail-closed", async () => {
  const s = script([{ error: new TypeError("fetch failed") }]);
  await assert.rejects(fetchRegistryJson(URL_, s.options), /^Error: fetch failed \(after 3 attempts\)$/);
  assert.equal(s.calls.length, 3);
  assert.deepEqual(s.sleeps, [1000, 3000]);
  const server = script([{ status: 503 }]);
  await assert.rejects(fetchRegistryJson(URL_, server.options), /registry returned HTTP 503 \(after 3 attempts\)/);
});

test("the attempt count and the waits are configurable, and a single attempt adds no suffix", async () => {
  const s = script([{ error: new TypeError("fetch failed") }]);
  await assert.rejects(fetchRegistryJson(URL_, { ...s.options, attempts: 1 }), /^Error: fetch failed$/);
  assert.equal(s.calls.length, 1);
  const t = script([{ status: 500 }, { status: 500 }, { status: 200, body: { done: true } }]);
  assert.deepEqual(await fetchRegistryJson(URL_, { ...t.options, attempts: 3, backoffMs: [10] }), { done: true });
  assert.deepEqual(t.sleeps, [10, 10], "the last wait repeats when there are more attempts than waits");
});
