/**
 * VR-2: the verification service a server offers to untrusted callers. Receipt identity and the store, single-flight,
 * the refusals, the watchdog and the size cap run against an injected runner; the pinned base and the kill of a
 * running verifier run against the real worker (which needs a sandbox engine, as the other verify tests do).
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mergePolicies } from "../src/core/managed_policy.js";
import { ManagedPolicyError } from "../src/core/managed_policy_load.js";
import {
  pinBase, VerifyService, VERIFY_MAX_RESULT_BYTES, VERIFY_RECEIPT_STORE_SIZE, VERIFY_WORKER_TAG,
  type PinnedBase, type VerifyRunner, type VerifyServiceConfig, type VerifyServiceDeps, type VerifyWorkerReply,
} from "../src/core/verify_service.js";
import { makeHome, processGone, waitUntil } from "./helpers/fixtures.js";
import { assertVerifyResult, BAD, BASE_FILES, commit, GOOD, head, withRepos, writeFiles } from "./helpers/verify_fixture.js";

const BASE: PinnedBase = { commit: "a".repeat(40), at: "2026-11-23T00:00:00.000Z" };
const NO_POLICY = () => mergePolicies();
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** A document with the members the service reads; the schema is checked where the real worker produced the result. */
const canned = (verdict = "BLOCKED", extra: Record<string, unknown> = {}): any => ({
  schema_version: 3, verdict, outcome: verdict === "VERIFIED" ? "VERIFIED" : "NOT_ESTABLISHED",
  ...(verdict === "VERIFIED" ? {} : { reason: "VERIFIER_NOT_APPROVED", detail: "approval needed" }), exitCode: 3, runs: [], ...extra,
});

function service(run: VerifyRunner, config: Partial<VerifyServiceConfig> = {}, deps: VerifyServiceDeps = {}): VerifyService {
  return new VerifyService({ worktree: "/nonexistent/ws", deliverables: [], readOnly: false, surface: "mcp", ...config }, { run, policy: NO_POLICY, ...deps });
}

/** A runner that waits to be told its reply, and replies "interrupted" when aborted, as the worker does. */
function heldRunner() {
  const calls: Array<{ job: any; release: (reply: VerifyWorkerReply) => void }> = [];
  const run: VerifyRunner = (job, signal) => new Promise((resolve) => {
    calls.push({ job, release: resolve });
    signal.addEventListener("abort", () => resolve({ interrupted: true }), { once: true });
  });
  return { run, calls };
}

test("a receipt has a server-drawn id, the hash of the document it serves, and cannot be changed", async () => {
  const jobs: any[] = [];
  const svc = service(async (job) => {
    jobs.push(job);
    return { result: canned() };
  }, { verifierCommand: "npm test", deliverables: ["src/a.js"], timeoutSecs: 7 });
  const first: any = await svc.verify({ base: BASE });
  const second: any = await svc.verify({ base: BASE });
  for (const outcome of [first, second]) {
    assert.match(outcome.summary.receipt_id, /^vr-[0-9a-f]{32}$/);
    assert.equal(outcome.summary.receipt_uri, `nexus://verify-receipt/${outcome.summary.receipt_id}`);
    assert.equal(outcome.summary.verdict, "BLOCKED");
    assert.match(outcome.summary.operator_hint, /--authoritative-verifier/);
  }
  assert.notEqual(first.summary.receipt_id, second.summary.receipt_id, "ids are random, not derived from the result");
  // The job holds the operator's settings and the pinned base, and has no member for an approval, a head or a sandbox.
  assert.deepEqual(jobs[0], { tag: VERIFY_WORKER_TAG, request: { worktree: "/nonexistent/ws", base: BASE.commit }, operator: { verifierCommand: "npm test", deliverables: ["src/a.js"], timeoutSecs: 7 } });

  const id = first.summary.receipt_id;
  const text = svc.receiptText(id)!;
  const served = JSON.parse(text);
  assert.equal(served.receipt_sha256, sha256(JSON.stringify(served.result)), "the hash is of the result as served");
  assert.ok(text.includes(JSON.stringify(served.result)));
  assert.equal(served.receipt_sha256, first.summary.receipt_sha256);
  assert.deepEqual([served.surface, served.session_id, served.base_pinned_at], ["mcp", null, BASE.at]);
  assert.equal(svc.receiptText(id), text, "the same bytes on every read");

  const receipt: any = svc.receipt(id);
  assert.throws(() => { receipt.result.verdict = "VERIFIED"; }, TypeError);
  assert.throws(() => { receipt.receipt_sha256 = "0"; }, TypeError);
  assert.throws(() => { receipt.result.runs.push({}); }, TypeError);
  assert.equal(JSON.parse(svc.receiptText(id)!).result.verdict, "BLOCKED");
});

test("the store keeps 32 receipts, and only a well-formed id issued here to this session finds one", async () => {
  const svc = service(async () => ({ result: canned() }));
  const ids: string[] = [];
  for (let i = 0; i < VERIFY_RECEIPT_STORE_SIZE + 1; i++) ids.push(((await svc.verify({ base: BASE })) as any).summary.receipt_id);
  assert.equal(svc.list().length, VERIFY_RECEIPT_STORE_SIZE);
  assert.equal(svc.receipt(ids[0]), undefined, "the oldest receipt was evicted");
  assert.ok(svc.receipt(ids[1]));
  assert.ok(svc.receipt(ids.at(-1)));

  const real = ids.at(-1)!;
  const forged = [
    `vr-${"0".repeat(32)}`, real.toUpperCase(), `${real}\n`, ` ${real}`, `${real}0`, real.slice(0, -1), `../${real}`, `rcpt-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`,
    "turn:session:1", "", "__proto__", "constructor", "vr-" + "g".repeat(32), "x".repeat(10_000), undefined, null, 7, {}, [real],
  ];
  for (const id of forged) {
    assert.equal(svc.receipt(id), undefined, `not available: ${String(id).slice(0, 40)}`);
    assert.equal(svc.receiptText(id), undefined);
  }

  // A receipt issued to a session is read only with that session.
  const bound = ((await svc.verify({ base: BASE, sessionId: "session-a" })) as any).summary.receipt_id;
  assert.equal(svc.receipt(bound), undefined);
  assert.equal(svc.receipt(bound, "session-b"), undefined);
  assert.equal(svc.receipt(bound, "session-a")!.session_id, "session-a");
  assert.deepEqual(svc.list("session-a").map((entry) => entry.receipt_id), [bound]);
});

test("one verification at a time: a concurrent call is refused, not queued", async () => {
  const held = heldRunner();
  const svc = service(held.run);
  const first = svc.verify({ base: BASE });
  const second: any = await svc.verify({ base: BASE });
  assert.equal(second.error.kind, "busy");
  assert.equal(held.calls.length, 1, "the second call started nothing");
  held.calls[0].release({ result: canned("VERIFIED") });
  assert.equal(((await first) as any).summary.verdict, "VERIFIED");
  assert.equal(svc.list().length, 1);
  // The refused call left nothing behind that blocks the next one.
  const third = svc.verify({ base: BASE });
  held.calls[1].release({ result: canned() });
  assert.equal(((await third) as any).summary.verdict, "BLOCKED");
});

test("read-only mode and a managed policy that requires a person refuse before anything runs", async () => {
  let ran = 0;
  const run: VerifyRunner = async () => {
    ran++;
    return { result: canned("VERIFIED") };
  };
  const readOnly: any = await service(run, { readOnly: true }).verify({ base: BASE });
  assert.equal(readOnly.error.kind, "read_only");
  assert.match(readOnly.error.message, /read-only mode does not allow/);

  const requireHuman = mergePolicies(undefined, { document: { approval: { require_human: ["exec"] } }, file: "/fake/home/.config/nexus/policy.toml" });
  const human: any = await service(run, {}, { policy: () => requireHuman }).verify({ base: BASE });
  assert.equal(human.error.kind, "policy_requires_human");

  const broken: any = await service(run, {}, { policy: () => { throw new ManagedPolicyError("user", "/fake/policy.toml", "PARSE" as any, "bad"); } }).verify({ base: BASE });
  assert.equal(broken.error.kind, "policy_error");

  const unbound: any = await new VerifyService({ deliverables: [], readOnly: false, surface: "acp" }, { run, policy: NO_POLICY }).verify({ base: BASE });
  assert.equal(unbound.error.kind, "no_workspace");
  assert.equal(ran, 0, "nothing was run for any refusal");

  // A policy that requires a person for something else does not refuse verification.
  const egressOnly = mergePolicies(undefined, { document: { approval: { require_human: ["egress"] } }, file: "/fake/policy.toml" });
  assert.equal(((await service(run, {}, { policy: () => egressOnly }).verify({ base: BASE })) as any).summary.verdict, "VERIFIED");
});

test("the watchdog and an abort end the run with an error and no receipt, whatever the runner then says", async () => {
  const held = heldRunner();
  const timed = service(held.run, {}, { watchdogMs: 30 });
  const late: any = await timed.verify({ base: BASE });
  assert.equal(late.error.kind, "timeout");
  assert.equal(timed.list().length, 0);

  const svc = service(held.run);
  const viaAbort = svc.verify({ base: BASE });
  svc.abort();
  assert.equal(((await viaAbort) as any).error.kind, "interrupted");

  const controller = new AbortController();
  const viaSignal = svc.verify({ base: BASE }, controller.signal);
  controller.abort();
  assert.equal(((await viaSignal) as any).error.kind, "interrupted");

  controller.abort();
  assert.equal(((await svc.verify({ base: BASE }, controller.signal)) as any).error.kind, "interrupted", "an aborted signal starts nothing");

  // A runner that answers VERIFIED once it is aborted: the answer is not a verdict.
  const lying: VerifyRunner = (_job, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ result: canned("VERIFIED") }), { once: true }));
  const cheated = service(lying, {}, { watchdogMs: 30 });
  assert.equal(((await cheated.verify({ base: BASE })) as any).error.kind, "timeout");
  assert.equal(cheated.list().length, 0);
  assert.equal(svc.list().length, 0);
});

test("a result that is too large, or is not a verify result, becomes an error with no receipt", async () => {
  const cases: Array<[VerifyWorkerReply, string]> = [
    [{ result: canned("VERIFIED", { detail: "x".repeat(VERIFY_MAX_RESULT_BYTES) }) }, "too_large"],
    [{ result: canned("SUPER_VERIFIED") }, "worker_failed"],
    [{ result: { ...canned("VERIFIED"), schema_version: 99 } }, "worker_failed"],
    [{ result: "VERIFIED" as any }, "worker_failed"],
    [{ verdict: "VERIFIED" } as any, "worker_failed"],
    [{ failed: "boom" }, "worker_failed"],
    [{ usage: "not a Git working tree" }, "usage"],
    [{ interrupted: true }, "interrupted"],
  ];
  for (const [reply, kind] of cases) {
    const svc = service(async () => reply);
    const outcome: any = await svc.verify({ base: BASE });
    assert.equal(outcome.error?.kind, kind, JSON.stringify(reply).slice(0, 80));
    assert.equal(svc.list().length, 0);
  }
  const thrown: any = await service(async () => { throw new Error("no fork"); }).verify({ base: BASE });
  assert.equal(thrown.error.kind, "worker_failed");
});

// ---- The real worker ----

/** The environment the worker inherits: a throwaway HOME and temp directory and no operator or test-runner settings. */
async function isolated<T>(check: (tmp: string) => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  const home = makeHome();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-service-tmp-"));
  for (const key of Object.keys(process.env)) if (/^(LOCAL_LLM_|LOCAL_HARNESS_|NEXUS_|GIT_|XDG_)/.test(key) || key === "NODE_TEST_CONTEXT") delete process.env[key];
  Object.assign(process.env, { HOME: home, TMPDIR: tmp });
  try {
    return await check(tmp);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    for (const dir of [tmp, home]) fs.rmSync(dir, { recursive: true, force: true });
  }
}

const realService = (repo: string, config: Partial<VerifyServiceConfig> = {}, deps: VerifyServiceDeps = {}) =>
  new VerifyService({ worktree: repo, verifierCommand: "npm test", deliverables: ["src/math.js"], readOnly: false, surface: "mcp", ...config }, { policy: NO_POLICY, ...deps });

const processes = () => spawnSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8" }).stdout.split("\n").map((line) => {
  const [, pid, ppid, args] = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line) ?? [];
  return { pid: Number(pid), ppid: Number(ppid), args: args ?? "" };
}).filter((entry) => entry.pid > 0);

test("pinBase names the commit at the time it is called, and reports a tree with none", () => withRepos([BASE_FILES], async (repo) => {
  const pinned = pinBase(repo) as PinnedBase;
  assert.equal(pinned.commit, head(repo));
  commit(repo, GOOD);
  assert.notEqual(pinned.commit, head(repo), "the pin does not follow HEAD");
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-service-norepo-"));
  try {
    assert.match((pinBase(bare) as { error: string }).error, /no commit to verify against|could not be read/);
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
}));

test("a test weakened in a commit made after the pin is part of the change: not VERIFIED", { timeout: 180_000 }, () => withRepos([BASE_FILES], (repo) => isolated(async (tmp) => {
  const base = pinBase(repo) as PinnedBase;
  // The caller commits the weakened test, hoping to be judged by it, then makes the "fix".
  commit(repo, BAD);
  writeFiles(repo, GOOD);
  const svc = realService(repo);
  const outcome: any = await svc.verify({ base });
  assert.equal(outcome.summary.verdict, "BLOCKED", JSON.stringify(outcome));
  assert.equal(outcome.summary.reason, "VERIFICATION_EDIT_BLOCKED");
  assert.equal(outcome.summary.base.commit, base.commit);
  assert.equal(outcome.summary.head.workingTree, true);
  const receipt = svc.receipt(outcome.summary.receipt_id)!;
  assertVerifyResult(JSON.parse(JSON.stringify(receipt.result)));
  assert.equal(receipt.workspace, fs.realpathSync(repo));
  assert.deepEqual(fs.readdirSync(tmp).filter((name) => name.startsWith("nexus-")), [], "no scratch directory is left behind");
})));

test("the boundary of the pin: a test weakened before the server started is the base it reports", { timeout: 180_000 }, () => withRepos([BASE_FILES], (repo) => isolated(async () => {
  const weakened = commit(repo, BAD);
  const base = pinBase(repo) as PinnedBase;
  writeFiles(repo, GOOD);
  const outcome: any = await realService(repo).verify({ base });
  // The receipt names the base, so a reader can see which commit the change was judged against.
  assert.equal(outcome.summary.base.commit, weakened);
  assert.notEqual(outcome.summary.reason, "VERIFICATION_EDIT_BLOCKED");
})));

test("the watchdog stops the worker and the verifier it was running", { timeout: 180_000 }, () => withRepos([BASE_FILES], (repo) => isolated(async (tmp) => {
  const marker = `31${process.pid}.${Date.now() % 100000}`;
  const base = pinBase(repo) as PinnedBase;
  writeFiles(repo, GOOD);
  const watchdogMs = 25_000;
  const svc = realService(repo, { verifierCommand: `sleep ${marker}` }, { watchdogMs, killGraceMs: 5_000 });
  const started = Date.now();
  const running = svc.verify({ base });
  let worker = 0;
  let sleepers: number[] = [];
  // The verifier must be running before the deadline for this test to show what the deadline stops.
  await waitUntil(() => {
    const all = processes();
    worker ||= all.find((entry) => entry.ppid === process.pid && entry.args.includes("verify_worker"))?.pid ?? 0;
    sleepers = all.filter((entry) => entry.args.includes(`sleep ${marker}`)).map((entry) => entry.pid);
    return worker > 0 && sleepers.length > 0;
  }, watchdogMs - 2_000);
  const outcome: any = await running;
  assert.equal(outcome.error.kind, "timeout");
  assert.ok(Date.now() - started >= watchdogMs - 50);
  assert.equal(svc.list().length, 0, "no receipt");
  assert.ok(processGone(worker), "the worker is gone when the call returns");
  await waitUntil(() => sleepers.every(processGone) && !processes().some((entry) => entry.args.includes(`sleep ${marker}`)));
  assert.deepEqual(fs.readdirSync(tmp).filter((name) => name.startsWith("nexus-")), [], "the stopped worker removed its scratch trees");
})));
