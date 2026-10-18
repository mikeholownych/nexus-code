/**
 * Evaluator-account plumbing (qualification runAs): the harness keeps access to what the evaluator creates, and a
 * wrapped process spec keeps its timeout. Both defects were found by eval/host/validate.mjs on the provisioned host.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("disposable paths grant the evaluator and the harness operator access, with matching defaults", async () => {
  const { runAsAclArgs } = await import(path.join(ROOT, "eval/isolate.mjs"));
  const dir = runAsAclArgs("nexus-eval", 1000, "/srv/q/ws/run", true);
  assert.deepEqual(dir.access, ["-R", "-m", "u:nexus-eval:rwX,u:1000:rwX", "/srv/q/ws/run"]);
  assert.deepEqual(dir.defaults, ["-m", "d:u:nexus-eval:rwx,d:u:1000:rwx", "/srv/q/ws/run"], "files the evaluator creates stay readable by the harness");
  assert.equal(runAsAclArgs("nexus-eval", 1000, "/srv/q/ws/file", false).defaults, null);
});

test("a spec wrapped for the evaluator keeps its timeout, and a spec without one is refused", async () => {
  const { asUserSpec } = await import(path.join(ROOT, "eval/validate.mjs"));
  const { runIsolatedProcess } = await import(path.join(ROOT, "eval/isolate.mjs"));
  const wrapped = asUserSpec("nexus-eval", { cmd: "/usr/bin/bwrap", argv: ["--", "/usr/bin/true"], timeoutMs: 5000 });
  assert.equal(wrapped.cmd, "/usr/bin/sudo");
  assert.deepEqual(wrapped.argv, ["-n", "-u", "nexus-eval", "--", "/usr/bin/bwrap", "--", "/usr/bin/true"]);
  assert.equal(wrapped.timeoutMs, 5000, "dropping timeoutMs made the process time out at once");
  assert.throws(() => runIsolatedProcess({ cmd: "/usr/bin/true", argv: [] }), /no timeoutMs/);
});
