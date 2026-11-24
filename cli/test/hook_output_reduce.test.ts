/**
 * HK-1: what a hook's answer means (`reduceHookOutput`), row by row of the contract table in docs/HOOKS.md. The rule
 * under test: an answer can deny or say nothing. No answer admits a call, and anything unreadable denies.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceHookOutput, type HookProcessResult, type HookVerdict } from "../src/core/hook_runner.js";

const ran = (over: Partial<HookProcessResult> = {}) => ({ exit: 0, signal: null, stdout: "", stderr: "", ...over });
const answered = (json: unknown) => reduceHookOutput(ran({ stdout: JSON.stringify(json) }));
/** Whether a pre-tool run with this verdict refuses the call (the registry's rule, restated). */
const refuses = (verdict: HookVerdict) => verdict.decision === "deny" || verdict.decision === "error";

test("exit 0 with no output is no opinion", () => {
  assert.deepEqual(reduceHookOutput(ran()), { decision: "none" });
  assert.deepEqual(reduceHookOutput(ran({ stdout: "  \n" })), { decision: "none" });
  // Standard error alone is not an answer.
  assert.deepEqual(reduceHookOutput(ran({ stderr: "warning: something" })), { decision: "none" });
});

test("a denying answer denies, with the hook's reason", () => {
  assert.deepEqual(answered({ decision: "block", reason: "force pushes are not allowed here" }), { decision: "deny", denialReason: "HOOK_DENIED", reason: "force pushes are not allowed here" });
  assert.deepEqual(answered({ decision: "deny" }), { decision: "deny", denialReason: "HOOK_DENIED", reason: "the hook answered deny" });
  assert.deepEqual(answered({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" } }), { decision: "deny", denialReason: "HOOK_DENIED", reason: "no" });
  assert.deepEqual(answered({ continue: false, stopReason: "stop now" }), { decision: "deny", denialReason: "HOOK_DENIED", reason: "stop now" });
  assert.deepEqual(answered({ continue: false }), { decision: "deny", denialReason: "HOOK_DENIED", reason: "the hook answered continue: false" });
});

test("ask is a denial in this version", () => {
  const verdict = answered({ hookSpecificOutput: { permissionDecision: "ask" } });
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.denialReason, "HOOK_DENIED");
  assert.match(verdict.reason!, /asked for a human; this version treats ask as deny/);
  assert.equal(answered({ hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "check with ops" } }).reason, "check with ops");
});

test("an allow answer is ignored and recorded as ignored", () => {
  for (const json of [
    { decision: "approve" },
    { decision: "allow", reason: "looks fine" },
    { hookSpecificOutput: { permissionDecision: "allow", permissionDecisionReason: "trusted" } },
    { decision: "approve", hookSpecificOutput: { permissionDecision: "allow" } },
    { continue: true, decision: "approve" },
  ]) {
    const verdict = answered(json);
    assert.equal(verdict.decision, "ignored_allow", JSON.stringify(json));
    assert.equal(verdict.denialReason, undefined);
    assert.equal(refuses(verdict), false);
  }
});

test("updatedInput and the other steering members are ignored and named", () => {
  assert.deepEqual(answered({ updatedInput: { path: "/etc/passwd" }, additionalContext: "x", suppressOutput: true, systemMessage: "y" }), {
    decision: "none",
    ignored: ["updatedInput", "additionalContext", "suppressOutput", "systemMessage"],
  });
  assert.deepEqual(answered({ decision: "approve", hookSpecificOutput: { permissionDecision: "allow", updatedInput: { command: "rm -rf /" }, additionalContext: "z" } }), {
    decision: "ignored_allow",
    ignored: ["hookSpecificOutput.updatedInput", "hookSpecificOutput.additionalContext"],
  });
  // A denial keeps the list too.
  assert.deepEqual(answered({ decision: "block", reason: "r", updatedInput: {} }).ignored, ["updatedInput"]);
});

test("a denial anywhere in the answer wins over an allow anywhere else", () => {
  for (const json of [
    { decision: "approve", hookSpecificOutput: { permissionDecision: "deny" } },
    { decision: "block", hookSpecificOutput: { permissionDecision: "allow" } },
    { decision: "allow", continue: false },
    { decision: "approve", hookSpecificOutput: { permissionDecision: "ask" } },
  ]) {
    assert.equal(answered(json).decision, "deny", JSON.stringify(json));
  }
});

test("output that starts like JSON and is not a readable object denies", () => {
  for (const stdout of ['{"decision": "approve"', "{not json}", '{"decision":"block","decision":"approve"}', '{"decision":"approve","decision":"block"}', `{"a":${"[".repeat(40)}`]) {
    const verdict = reduceHookOutput(ran({ stdout }));
    assert.equal(verdict.decision, "error", stdout);
    assert.equal(verdict.denialReason, "HOOK_OUTPUT_INVALID", stdout);
    assert.equal(refuses(verdict), true);
  }
  assert.equal(answered({ hookSpecificOutput: "allow" }).denialReason, "HOOK_OUTPUT_INVALID");
  assert.equal(answered({ hookSpecificOutput: null }).denialReason, "HOOK_OUTPUT_INVALID");
  assert.equal(answered({ hookSpecificOutput: [] }).denialReason, "HOOK_OUTPUT_INVALID");
});

test("a decision value this version does not know denies instead of passing", () => {
  for (const json of [{ decision: "maybe" }, { decision: true }, { decision: null }, { decision: "ALLOW" }, { hookSpecificOutput: { permissionDecision: "defer" } }, { hookSpecificOutput: { permissionDecision: 1 } }, { continue: "false" }, { continue: 0 }]) {
    const verdict = answered(json);
    assert.equal(verdict.decision, "error", JSON.stringify(json));
    assert.equal(verdict.denialReason, "HOOK_OUTPUT_INVALID", JSON.stringify(json));
  }
});

test("plain text on exit 0 is no opinion, kept as a bounded one-line note", () => {
  assert.deepEqual(reduceHookOutput(ran({ stdout: "checked 3 files\nall fine\n" })), { decision: "none", reason: "checked 3 files all fine" });
  const long = reduceHookOutput(ran({ stdout: "x".repeat(5000) }));
  assert.equal(long.decision, "none");
  assert.equal(long.reason!.length, 1000);
  // Text that merely contains the word is not an answer.
  assert.equal(reduceHookOutput(ran({ stdout: 'decision: "approve"' })).decision, "none");
  assert.equal(reduceHookOutput(ran({ stdout: '["approve"]' })).decision, "none");
});

test("exit 2 denies with standard error as the reason, whatever standard output says", () => {
  assert.deepEqual(reduceHookOutput(ran({ exit: 2, stderr: "blocked: force push\nsee policy\n" })), { decision: "deny", denialReason: "HOOK_DENIED", reason: "blocked: force push see policy" });
  assert.deepEqual(reduceHookOutput(ran({ exit: 2 })), { decision: "deny", denialReason: "HOOK_DENIED", reason: "the hook exited with status 2" });
  assert.equal(reduceHookOutput(ran({ exit: 2, stdout: '{"decision":"approve"}' })).decision, "deny");
});

test("any other exit, a signal, a start failure, a timeout or too much output denies (fail closed)", () => {
  const cases: Array<[Partial<HookProcessResult>, RegExp]> = [
    [{ exit: 1 }, /exited with status 1/],
    [{ exit: 127, stderr: "sh: not found" }, /exited with status 127/],
    [{ exit: 1, stdout: '{"decision":"approve"}' }, /exited with status 1/],
    [{ exit: null, signal: "SIGSEGV" }, /ended by SIGSEGV/],
    [{ exit: null, signal: "SIGKILL", failure: "timeout" }, /did not finish in time/],
    [{ exit: null, failure: "spawn", detail: "spawn /nope ENOENT" }, /could not be started \(spawn \/nope ENOENT\)/],
    [{ exit: 0, failure: "stdout_oversize", stdout: '{"decision":"approve"}' }, /more than 64 KiB to standard output/],
    [{ exit: 0, failure: "stderr_oversize" }, /more than 8 KiB to standard error/],
    [{ exit: 0, failure: "output_left_open", stdout: "" }, /kept its output open/],
  ];
  for (const [result, pattern] of cases) {
    const verdict = reduceHookOutput(ran(result));
    assert.equal(verdict.decision, "error", JSON.stringify(result));
    assert.equal(verdict.denialReason, "HOOK_FAILED", JSON.stringify(result));
    assert.match(verdict.reason!, pattern);
    assert.equal(refuses(verdict), true);
  }
});

test("a reason is one bounded line with control characters removed", () => {
  const verdict = answered({ decision: "block", reason: `line one\nline two\u001b[31m red\u0007 ${"y".repeat(3000)}` });
  assert.equal(verdict.reason!.length, 1000);
  assert.ok(!/[\u0000-\u001f\u007f]/.test(verdict.reason!));
  assert.ok(verdict.reason!.startsWith("line one line two [31m red"));
  // A non-string reason is not shown.
  assert.equal(answered({ decision: "block", reason: { nested: true } }).reason, "the hook answered block");
});

test("no result admits: every verdict is none, ignored_allow, deny or error", () => {
  const stdouts = ["", "ok", '{"decision":"approve"}', '{"decision":"allow"}', '{"hookSpecificOutput":{"permissionDecision":"allow"}}', '{"allow":true}', '{"approved":true,"decision":"approve","permissionDecision":"allow"}', '{"continue":true}', "{}"];
  for (const stdout of stdouts) {
    for (const exit of [0, 1, 2, 3]) {
      const verdict = reduceHookOutput(ran({ stdout, exit }));
      assert.ok(["none", "ignored_allow", "deny", "error"].includes(verdict.decision));
      assert.equal(refuses(verdict), exit !== 0, `${stdout} exit ${exit}`);
    }
  }
});
