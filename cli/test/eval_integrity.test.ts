/**
 * Scoring integrity of the evaluation harness (REQ-QUAL-106, EVL-002/003/005): infrastructure failures are decided by
 * what the harness's model proxy observed, the same way for every agent; contaminated runs leave the pass rate;
 * reruns are listed; crashes are counted as crashes rather than rerun.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const proxyModule = path.join(ROOT, "eval/model_proxy.mjs");

test("the model proxy forwards requests and counts answers and upstream failures", async () => {
  const { startModelProxy, isInfrastructureFailure } = await import(proxyModule);
  const upstream = http.createServer((req, res) => {
    if (req.url?.endsWith("/chat/completions")) {
      res.writeHead(503);
      return void res.end("busy");
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ path: req.url }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const port = (upstream.address() as any).port;
  const proxy = await startModelProxy({ upstream: `http://127.0.0.1:${port}/v1` });
  try {
    assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    const ok = await (await fetch(`${proxy.url}/models`)).json();
    assert.equal(ok.path, "/v1/models");
    assert.equal((await fetch(`${proxy.url}/chat/completions`, { method: "POST", body: "{}" })).status, 503);
    assert.equal((await fetch(`${proxy.url}/admin/secrets`)).status, 404, "control-plane paths are not forwarded");
    assert.equal((await fetch(`${proxy.url}/chat/completions`, { method: "GET" })).status, 404, "unsupported methods are not forwarded");
    const stats = proxy.stats();
    assert.equal(stats.requests, 4);
    assert.equal(stats.answered, 1);
    assert.equal(stats.upstreamFailures, 1);
    assert.equal(isInfrastructureFailure({ model: stats }), false, "the model answered: the run is scored");
  } finally {
    await proxy.close();
    upstream.close();
  }

  const dead = await startModelProxy({ upstream: "http://127.0.0.1:9/v1" });
  try {
    assert.equal((await fetch(`${dead.url}/chat/completions`, { method: "POST", body: "{}" })).status, 502);
    assert.equal(isInfrastructureFailure({ model: dead.stats() }), true, "the model never answered and the endpoint failed");
  } finally {
    await dead.close();
  }
});

test("the evaluation proxy authenticates the local run token and replaces it with the upstream credential", async () => {
  const { startModelProxy } = await import(proxyModule);
  const seen: string[] = [];
  const upstream = http.createServer((req, res) => {
    seen.push(String(req.headers.authorization ?? ""));
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as any).port;
  const proxy = await startModelProxy({ upstream: `http://127.0.0.1:${port}/v1`, authToken: "UPSTREAM_SECRET_CANARY", clientToken: "RUN_SCOPED_TOKEN" });
  try {
    assert.equal((await fetch(`${proxy.url}/models`)).status, 401);
    const accepted = await fetch(`${proxy.url}/models`, { headers: { authorization: "Bearer RUN_SCOPED_TOKEN" } });
    assert.equal(accepted.status, 200);
    assert.deepEqual(seen, ["Bearer UPSTREAM_SECRET_CANARY"]);
    assert.equal((await fetch(`${proxy.url}/admin`, { headers: { authorization: "Bearer RUN_SCOPED_TOKEN" } })).status, 404);
  } finally {
    await proxy.close();
    upstream.close();
  }
});

test("the evaluation proxy bounds request count and body size", async () => {
  const { startModelProxy } = await import(proxyModule);
  let upstreamRequests = 0;
  const upstream = http.createServer((req, res) => { upstreamRequests++; req.resume(); res.end("ok"); });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as any).port;
  const proxy = await startModelProxy({ upstream: `http://127.0.0.1:${port}/v1`, maxRequests: 1, maxRequestBytes: 8 });
  try {
    const oversized = await fetch(`${proxy.url}/chat/completions`, { method: "POST", body: "123456789" }).catch(() => null);
    assert.ok(oversized === null || oversized.status === 413);
    assert.equal(upstreamRequests, 0, "oversized bodies never reach the provider");
    assert.equal((await fetch(`${proxy.url}/models`)).status, 429);
  } finally {
    await proxy.close();
    upstream.close();
  }
});

test("the evaluation proxy bounds concurrent inference and cancels upstream work on client abort", { timeout: 10_000 }, async () => {
  const { startModelProxy, isInfrastructureFailure } = await import(proxyModule);
  let upstreamRequests = 0;
  let resolveFirstStarted!: () => void;
  let resolveFirstClosed!: () => void;
  const firstStarted = new Promise<void>((resolve) => { resolveFirstStarted = resolve; });
  const firstClosed = new Promise<void>((resolve) => { resolveFirstClosed = resolve; });
  const upstream = http.createServer((req, res) => {
    upstreamRequests++;
    req.resume();
    if (upstreamRequests === 1) {
      resolveFirstStarted();
      res.once("close", resolveFirstClosed);
      return;
    }
    res.end("second request accepted after cancellation");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as any).port;
  const proxy = await startModelProxy({ upstream: `http://127.0.0.1:${port}/v1` });
  const body = JSON.stringify({ max_tokens: 1 });
  const send = (signal?: AbortSignal) => fetch(`${proxy.url}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal,
  });
  try {
    const controller = new AbortController();
    const first = send(controller.signal);
    await firstStarted;
    assert.equal(proxy.stats().activeInferenceRequests, 1);

    const concurrent = await send();
    assert.equal(concurrent.status, 429);
    assert.equal((await concurrent.json()).error.type, "concurrency_limit");
    assert.equal(upstreamRequests, 1, "a rejected concurrent request never reaches the provider");

    controller.abort();
    await assert.rejects(first, { name: "AbortError" });
    await Promise.race([
      firstClosed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("upstream remained open after client abort")), 1_000)),
    ]);
    assert.equal(proxy.stats().cancelledRequests, 1);
    assert.equal(proxy.stats().activeInferenceRequests, 0, "cancellation releases the concurrency slot");
    assert.equal(proxy.stats().upstreamFailures, 0, "intentional cancellation is not a provider failure");
    assert.equal(isInfrastructureFailure({ model: proxy.stats() }), false, "a cancelled candidate request is scored, not rerun as infrastructure");

    const recovered = await send();
    assert.equal(recovered.status, 200);
    assert.equal(await recovered.text(), "second request accepted after cancellation");
    assert.equal(upstreamRequests, 2);
  } finally {
    await proxy.close();
    upstream.close();
  }
});

test("the evaluation proxy enforces per-request and aggregate requested completion-token ceilings", async () => {
  const { startModelProxy } = await import(proxyModule);
  let forwarded = 0;
  const upstream = http.createServer((req, res) => { forwarded++; req.resume(); res.end("ok"); });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as any).port;
  const proxy = await startModelProxy({ upstream: `http://127.0.0.1:${port}/v1`, maxCompletionTokens: 4, maxTotalCompletionTokens: 6 });
  const send = (max_tokens: number) => fetch(`${proxy.url}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ max_tokens }) });
  try {
    assert.equal((await send(5)).status, 400);
    assert.equal((await send(4)).status, 200);
    assert.equal((await send(2)).status, 200);
    assert.equal((await send(1)).status, 400);
    assert.equal(forwarded, 2);
    assert.equal(proxy.stats().requestedCompletionTokens, 6);
  } finally {
    await proxy.close();
    upstream.close();
  }
});

test("the evaluation proxy never forwards the local token when the upstream is unauthenticated", async () => {
  const { startModelProxy } = await import(proxyModule);
  let authorization = "<missing>";
  const upstream = http.createServer((req, res) => { authorization = String(req.headers.authorization ?? "<missing>"); req.resume(); res.end("ok"); });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as any).port;
  const proxy = await startModelProxy({ upstream: `http://127.0.0.1:${port}/v1`, clientToken: "LOCAL_ONLY_CANARY" });
  try {
    assert.equal((await fetch(`${proxy.url}/models`, { headers: { authorization: "Bearer LOCAL_ONLY_CANARY" } })).status, 200);
    assert.equal(authorization, "<missing>");
  } finally {
    await proxy.close();
    upstream.close();
  }
});

function writeResults(records: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-integrity-"));
  fs.writeFileSync(path.join(dir, "results.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return dir;
}
const base = { config: "c", tier: "T2", wallMs: 1000, hiddenPass: false, falseVerified: false, contaminated: false, timedOut: false, exitCode: 1 };

test("infrastructure reruns use one rule for every agent: a crash after the model answered is scored", () => {
  const dir = writeResults([
    { ...base, agent: "nexus", task: "crash-after-answers", run: 1, turn: null, model: { requests: 4, answered: 4, upstreamFailures: 0 } },
    { ...base, agent: "goose", task: "endpoint-down", run: 1, model: { requests: 3, answered: 0, upstreamFailures: 3 } },
    { ...base, agent: "nexus", task: "endpoint-down", run: 1, turn: null, model: { requests: 2, answered: 0, upstreamFailures: 2 } },
    { ...base, agent: "opencode", task: "slow-but-answered", run: 1, model: { requests: 5, answered: 3, upstreamFailures: 2 } },
  ]);
  const out = spawnSync(process.execPath, [path.join(ROOT, "eval/infra.mjs"), dir], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.stdout.trim().split("\n").sort(), ["endpoint-down 1", "endpoint-down 1"]);
});

test("contaminated runs leave the pass rate, crashes are counted, and reruns are listed", () => {
  const first = writeResults([
    { ...base, agent: "nexus", task: "a", run: 1, hiddenPass: true, turn: { outcome: "VERIFIED" }, exitCode: 0, tokens: { total: 1000 } },
    { ...base, agent: "nexus", task: "b", run: 1, hiddenPass: true, contaminated: true, turn: { outcome: "VERIFIED" }, exitCode: 0, tokens: { total: 1000 } },
    { ...base, agent: "nexus", task: "c", run: 1, turn: null },
    { ...base, agent: "nexus", task: "d", run: 1, error: "workspace setup failed" },
  ]);
  const rerun = writeResults([{ ...base, agent: "nexus", task: "d", run: 1, turn: { outcome: "UNVERIFIED" }, exitCode: 2, tokens: { total: 1000 } }]);
  const out = spawnSync(process.execPath, [path.join(ROOT, "eval/score.mjs"), path.join(first, "results.jsonl"), path.join(rerun, "results.jsonl"), "--json"], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  const score = JSON.parse(out.stdout);
  const pooled = score.pooled[0];
  assert.equal(pooled.excludedContaminated, 1);
  assert.equal(pooled.n, 3, "the contaminated run is not in the denominator");
  assert.equal(pooled.correct, 1, "the contaminated pass is not counted");
  assert.equal(score.totals.crashed, 1, "a Nexus run without a result is a crash");
  assert.equal(pooled.crashRate, 0.25);
  assert.equal(pooled.tokensPerCorrect, 2000);
  assert.deepEqual(score.replacements, [{ config: "c", task: "d", run: 1, was: "error: workspace setup failed", now: "UNVERIFIED" }]);
});

test("T4 scoring requires all nine classes and five injected runs per class", () => {
  const kinds = ["refuse", "overloaded", "stream_cut", "truncate", "hanging_test_command", "full_disk", "context_overflow", "malformed_tool_json", "sigterm_resume"];
  const records = kinds.flatMap((kind) => Array.from({ length: 5 }, (_, index) => {
    const runnerClass = ["hanging_test_command", "full_disk", "sigterm_resume"].includes(kind);
    const evidence = kind === "sigterm_resume"
      ? { signal: "SIGTERM", delivered: true, deliveredProcesses: 1, signalDuringActiveTurn: true, payloadExitSignal: "SIGTERM", supervisorWrapperExitSignal: null, resumed: true, resumeExitCode: 0, resumeTurnExecution: "COMPLETED" }
      : kind === "hanging_test_command"
        ? { observedHung: true, timedOut: true, containmentCleaned: true, tool: "run_command", commandSha256: "a".repeat(64), timeoutSecs: 60, runnerExitCode: null }
        : kind === "full_disk"
          ? { storageExhausted: true, containmentCleaned: true, tool: "run_command", commandSha256: "a".repeat(64), storageLimitBytes: 64 * 1024 * 1024, availableBeforeBytes: 64 * 1024 * 1024, availableAfterBytes: 0, runnerExitCode: 1 }
          : undefined;
    const event = { kind, source: runnerClass ? "task_fixture_or_runner" : "model_proxy", ...(evidence ? { evidence } : {}) };
    return {
      ...base,
      agent: "nexus",
      tier: "T4",
      task: `t4-${kind}`,
      run: index + 1,
      hiddenPass: true,
      exitCode: 0,
      turn: { execution: "COMPLETED", outcome: "UNVERIFIED" },
      model: ["hanging_test_command", "full_disk", "sigterm_resume"].includes(kind) ? { faultsInjected: [] } : { faultsInjected: [event] },
      t4FaultsInjected: ["hanging_test_command", "full_disk", "sigterm_resume"].includes(kind) ? [event] : [],
    };
  }));
  const full = writeResults(records);
  const fullOut = spawnSync(process.execPath, [path.join(ROOT, "eval/score.mjs"), path.join(full, "results.jsonl"), "--json"], { encoding: "utf8" });
  assert.equal(fullOut.status, 0, fullOut.stderr);
  const fullScore = JSON.parse(fullOut.stdout);
  assert.equal(fullScore.t4.gate, "PASS");
  assert.equal(fullScore.t4.observedClasses, 9);
  assert.equal(fullScore.t4.totalRuns, 45);
  assert.deepEqual(fullScore.faults.map((fault: any) => fault.n), Array(9).fill(5));

  const proxyOnly = writeResults(records.filter((record) => ["refuse", "overloaded", "stream_cut", "truncate", "context_overflow", "malformed_tool_json"].some((kind) => record.task === `t4-${kind}`)).slice(0, 6));
  const partialOut = spawnSync(process.execPath, [path.join(ROOT, "eval/score.mjs"), path.join(proxyOnly, "results.jsonl"), "--json"], { encoding: "utf8" });
  assert.equal(partialOut.status, 0, partialOut.stderr);
  const partialScore = JSON.parse(partialOut.stdout);
  assert.equal(partialScore.faults.length, 9, "missing fixture and runner classes remain visible");
  assert.equal(partialScore.t4.gate, "FAIL", "a partial proxy-only run cannot pass T4");

  const forged = writeResults([{
    ...base,
    tier: "T4",
    task: "t4-forged-source",
    run: 1,
    model: { faultsInjected: [{ kind: "sigterm_resume", source: "model_proxy" }] },
    t4FaultsInjected: [],
  }]);
  const forgedOut = spawnSync(process.execPath, [path.join(ROOT, "eval/score.mjs"), path.join(forged, "results.jsonl"), "--json"], { encoding: "utf8" });
  assert.equal(forgedOut.status, 0, forgedOut.stderr);
  const forgedScore = JSON.parse(forgedOut.stdout);
  assert.equal(forgedScore.t4.invalidEvents, 1, "runner-only faults cannot be claimed as proxy injections");
  assert.equal(forgedScore.t4.gate, "FAIL");

  const missingRunnerEvidence = writeResults([{
    ...base,
    tier: "T4",
    task: "t4-missing-runner-evidence",
    run: 1,
    t4FaultsInjected: [{ kind: "sigterm_resume", source: "task_fixture_or_runner" }],
  }]);
  const missingEvidenceOut = spawnSync(process.execPath, [path.join(ROOT, "eval/score.mjs"), path.join(missingRunnerEvidence, "results.jsonl"), "--json"], { encoding: "utf8" });
  assert.equal(missingEvidenceOut.status, 0, missingEvidenceOut.stderr);
  assert.equal(JSON.parse(missingEvidenceOut.stdout).t4.invalidEvents, 1, "runner fault labels without observed evidence are invalid");

  const missingResumeEvidence = writeResults([{
    ...base,
    tier: "T4",
    task: "t4-missing-resume-evidence",
    run: 1,
    t4FaultsInjected: [{
      kind: "sigterm_resume",
      source: "task_fixture_or_runner",
      evidence: { signal: "SIGTERM", delivered: true, deliveredProcesses: 1, signalDuringActiveTurn: true, payloadExitSignal: "SIGTERM", supervisorWrapperExitSignal: null, resumed: true },
    }],
  }]);
  const missingResumeOut = spawnSync(process.execPath, [path.join(ROOT, "eval/score.mjs"), path.join(missingResumeEvidence, "results.jsonl"), "--json"], { encoding: "utf8" });
  assert.equal(missingResumeOut.status, 0, missingResumeOut.stderr);
  assert.equal(JSON.parse(missingResumeOut.stdout).t4.invalidEvents, 1, "missing resume exit and resulting-turn evidence are invalid");

  const inactiveSignal = writeResults([{
    ...base,
    tier: "T4",
    task: "t4-inactive-signal",
    run: 1,
    t4FaultsInjected: [{
      kind: "sigterm_resume",
      source: "task_fixture_or_runner",
      evidence: { signal: "SIGTERM", delivered: true, deliveredProcesses: 1, signalDuringActiveTurn: false, payloadExitSignal: "SIGTERM", supervisorWrapperExitSignal: null, resumed: true, resumeExitCode: 0, resumeTurnExecution: "COMPLETED" },
    }],
  }]);
  const inactiveSignalOut = spawnSync(process.execPath, [path.join(ROOT, "eval/score.mjs"), path.join(inactiveSignal, "results.jsonl"), "--json"], { encoding: "utf8" });
  assert.equal(inactiveSignalOut.status, 0, inactiveSignalOut.stderr);
  assert.equal(JSON.parse(inactiveSignalOut.stdout).t4.invalidEvents, 1, "an interruption outside an active inference turn is invalid");

  const wrapperOnlySignal = writeResults([{
    ...base,
    tier: "T4",
    task: "t4-wrapper-only-signal",
    run: 1,
    t4FaultsInjected: [{
      kind: "sigterm_resume",
      source: "task_fixture_or_runner",
      evidence: { signal: "SIGTERM", delivered: true, deliveredProcesses: 1, signalDuringActiveTurn: true, payloadExitSignal: null, supervisorWrapperExitSignal: "SIGTERM", resumed: true, resumeExitCode: 0, resumeTurnExecution: "COMPLETED" },
    }],
  }]);
  const wrapperOnlyOut = spawnSync(process.execPath, [path.join(ROOT, "eval/score.mjs"), path.join(wrapperOnlySignal, "results.jsonl"), "--json"], { encoding: "utf8" });
  assert.equal(wrapperOnlyOut.status, 0, wrapperOnlyOut.stderr);
  assert.equal(JSON.parse(wrapperOnlyOut.stdout).t4.invalidEvents, 1, "wrapper signal metadata cannot substitute for the payload supervisor report");

  const nonT4 = writeResults([{
    ...base,
    tier: "T2",
    task: "t2-fault-metadata",
    run: 1,
    model: { faultsInjected: [{ kind: "overloaded", atRequest: 1 }] },
  }]);
  const nonT4Out = spawnSync(process.execPath, [path.join(ROOT, "eval/score.mjs"), path.join(nonT4, "results.jsonl"), "--json"], { encoding: "utf8" });
  assert.equal(nonT4Out.status, 0, nonT4Out.stderr);
  assert.equal(JSON.parse(nonT4Out.stdout).t4.observedClasses, 0, "non-T4 runs cannot satisfy the fault-class gate");
});

// ---------------------------------------------------------------- run validity (REQ-QUAL-101/102/106)

test("task validation: pinned repos, one source, and black-box hidden oracle for qualification", async () => {
  const { validateTask } = await import(path.join(ROOT, "eval/validate.mjs"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t2-x-"));
  const id = path.basename(dir);
  const good = { id, tier: "T2", objective: "fix it", repo: { url: "https://example.invalid/r.git", commit: "a".repeat(40) }, hidden: { command: "npm test" } };
  fs.mkdirSync(path.join(dir, "candidate"));
  assert.deepEqual(validateTask(good, dir), []);
  assert.match(validateTask({ ...good, t4RunnerFault: "sigterm_resume" }, dir).join(), /supported only as sigterm_resume on a T4 task/);
  assert.deepEqual(validateTask({ ...good, tier: "T4", t4RunnerFault: "sigterm_resume" }, dir), []);
  assert.match(validateTask({ ...good, tier: "T4", t4RunnerFault: "full_disk" }, dir).join(), /supported only as sigterm_resume on a T4 task/);
  assert.deepEqual(validateTask({ ...good, tier: "T4", t4Fixture: { kind: "hanging_test_command", tool: "run_command", command: "npm test", timeoutSecs: 60 } }, dir), []);
  assert.deepEqual(validateTask({ ...good, tier: "T4", t4Fixture: { kind: "full_disk", tool: "run_command", command: "./test-disk-cap.sh", storageLimitBytes: 64 * 1024 * 1024 } }, dir), []);
  assert.match(validateTask({ ...good, t4Fixture: { kind: "full_disk", tool: "run_command", command: "./test-disk-cap.sh", storageLimitBytes: 64 } }, dir).join(), /only as an object on a T4 task/);
  assert.match(validateTask({ ...good, tier: "T4", t4Fixture: { kind: "full_disk", tool: "run_command", command: "./test-disk-cap.sh" } }, dir).join(), /positive storageLimitBytes/);
  assert.match(validateTask({ ...good, repo: { url: good.repo.url, commit: "main" } }, dir).join(), /pinned/);
  assert.match(validateTask({ ...good, fixture: "repo" }, dir).join(), /exactly one of fixture or repo/);
  assert.match(validateTask({ ...good, hidden: {} }, dir).join(), /hidden.command/);
  // Legacy checks execute candidate modules in the validator process and are therefore not independent qualification.
  assert.match(validateTask(good, dir, { qualification: true }).join(), /qualification requires the isolated blackbox-v1 hidden oracle/);
  assert.match(validateTask({ ...good, class: "bugfix", difficulty: "medium", hidden: { dir: "candidate", command: "npm test" } }, dir, { qualification: true }).join(), /in-process legacy validators are not accepted/);
  assert.match(validateTask({ ...good, class: "bugfix", difficulty: "medium", hidden: { protocol: "blackbox-v1", command: "npm test" } }, dir, { qualification: true }).join(), /unsupported fields/);
  const cases = path.join(dir, "private-cases.json");
  fs.writeFileSync(cases, JSON.stringify([{ input: { x: 1 }, expected: { x: 1 } }]));
  fs.symlinkSync(cases, path.join(dir, "private-cases-link.json"));
  const oracle = { protocol: "blackbox-v1", casesFile: "private-cases.json", runtime: "node", argv: ["candidate/solution.mjs"], timeoutMs: 1000, totalTimeoutMs: 2000, maxOutputBytes: 4096 };
  const qualifiedTask = { ...good, fixture: "candidate", repo: undefined, class: "bugfix", difficulty: "medium", hidden: oracle };
  assert.deepEqual(validateTask(qualifiedTask, dir, { qualification: true }), []);
  assert.match(validateTask({ ...good, class: "bugfix", difficulty: "medium", hidden: { ...oracle, runtime: "bash" } }, dir, { qualification: true }).join(), /runtime is not allowlisted/);
  for (const runtime of ["constructor", "toString", "__proto__"]) {
    assert.match(validateTask({ ...qualifiedTask, hidden: { ...oracle, runtime } }, dir, { qualification: true }).join(), /runtime is not allowlisted/);
  }
  assert.match(validateTask({ ...good, class: "bugfix", difficulty: "medium", hidden: { ...oracle, casesFile: "../private-cases.json" } }, dir, { qualification: true }).join(), /casesFile is unsafe/);
  assert.match(validateTask({ ...qualifiedTask, hidden: { ...oracle, casesFile: "private-cases-link.json" } }, dir, { qualification: true }).join(), /casesFile is unsafe/);
  fs.writeFileSync(path.join(dir, "candidate", "private-cases.json"), fs.readFileSync(cases));
  assert.match(validateTask({ ...qualifiedTask, hidden: { ...oracle, casesFile: "candidate/private-cases.json" } }, dir, { qualification: true }).join(), /outside the candidate fixture/);
  assert.match(validateTask({ ...qualifiedTask, hidden: { ...oracle, argv: ["--eval"] } }, dir, { qualification: true }).join(), /normalized relative candidate entrypoint/);
});

test("T4 fixture evidence requires an exact CLI runner receipt and measured storage boundary", async () => {
  const { observeT4Fixture } = await import(path.join(ROOT, "eval/t4_fixtures.mjs"));
  const task = { tier: "T4", t4Fixture: { kind: "hanging_test_command", tool: "run_command", command: "npm test", timeoutSecs: 30 } };
  const commandSha256 = createHash("sha256").update("npm test").digest("hex");
  const agent = { json: { evaluationToolReceipts: [{ invocationId: "call-1", tool: "run_command", commandSha256, timeoutSecs: 30, exitCode: null, timedOut: true }] } };
  const containment = { cleaned: true, survivorsAfterExit: 0 };
  const hang = observeT4Fixture(task, agent, containment, { storageBytes: 64 * 1024 * 1024 });
  assert.equal(hang[0].evidence.observedHung, true);
  assert.equal(observeT4Fixture(task, { json: { messages: [{ role: "tool", content: "timed out" }] } }, containment, {}).length, 0, "printable transcript text is not trusted evidence");
  assert.equal(observeT4Fixture(task, agent, { cleaned: false, survivorsAfterExit: 1 }, {}).at(0).evidence.containmentCleaned, false);

  const diskTask = { tier: "T4", t4Fixture: { kind: "full_disk", tool: "run_command", command: "./test-disk-cap.sh", storageLimitBytes: 64 * 1024 * 1024 } };
  const diskHash = createHash("sha256").update("./test-disk-cap.sh").digest("hex");
  const diskAgent = { json: { evaluationToolReceipts: [{ invocationId: "call-2", tool: "run_command", commandSha256: diskHash, timeoutSecs: 30, exitCode: 1, timedOut: false, workspaceAvailableBeforeBytes: 64 * 1024 * 1024, workspaceAvailableAfterBytes: 0 }] } };
  assert.equal(observeT4Fixture(diskTask, diskAgent, containment, { storageBytes: 64 * 1024 * 1024 })[0].evidence.storageExhausted, true);
  assert.equal(observeT4Fixture(diskTask, diskAgent, containment, { storageBytes: 128 * 1024 * 1024 }).length, 0);
  assert.equal(observeT4Fixture(diskTask, { json: { evaluationToolReceipts: [{ ...diskAgent.json.evaluationToolReceipts[0], workspaceAvailableAfterBytes: 8 * 1024 * 1024 }] } }, containment, { storageBytes: 64 * 1024 * 1024 }).length, 0, "a printed ENOSPC message without exhausted storage is insufficient");
});

test("black-box oracle keeps canary expectations outside the candidate process and returns sanitized evidence", { timeout: 15_000 }, async () => {
  const { runBlackBoxOracle } = await import(path.join(ROOT, "eval/oracle.mjs"));
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-private-task-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "eval-oracle-candidate-"));
  const privateFile = path.join(taskDir, "private-cases.json");
  const canary = "ORACLE_EXPECTATION_CANARY_8f3c";
  const diagnosticCanary = "SYNTHETIC_DIAGNOSTIC_CANARY_a219";
  fs.writeFileSync(privateFile, JSON.stringify([{ input: { value: "public-input" }, expected: { value: "public-input", oracle: null } }]));
  const candidate = path.join(workspace, "solution.mjs");
  fs.writeFileSync(candidate, `import fs from 'node:fs';\nlet value;try{value=fs.readFileSync(${JSON.stringify(privateFile)},'utf8')}catch{};\ntry{fs.writeFileSync('/workspace/solution.mjs','tampered')}catch{};\nconst input=JSON.parse(fs.readFileSync(0,'utf8'));\nconsole.error(${JSON.stringify(diagnosticCanary)});\nconsole.log(JSON.stringify({value:input.value,oracle:value??null}));\n`);
  const candidateBefore = fs.readFileSync(candidate);
  const check = { protocol: "blackbox-v1", casesFile: "private-cases.json", runtime: "node", argv: ["solution.mjs"], timeoutMs: 3000, totalTimeoutMs: 5000, maxOutputBytes: 4096 };
  const result = await runBlackBoxOracle({ dir: taskDir }, workspace, check);
  assert.deepEqual(result, {
    pass: true,
    cases: 1,
    failedCases: [],
    timeoutCases: [],
    outputLimitCases: [],
    executionFailureCases: [],
    invalidOutputCases: [],
    mismatchCases: [],
    timedOut: false,
    overflow: false,
    outcome: "matched",
    resources: null,
  });
  assert.deepEqual(fs.readFileSync(candidate), candidateBefore, "candidate workspace is read-only during oracle execution");
  assert.equal(JSON.stringify(result).includes(canary), false, "oracle evidence never serializes hidden expectations or candidate output");
  assert.equal(JSON.stringify(result).includes(diagnosticCanary), false, "candidate diagnostics are not persisted in oracle evidence");
  assert.equal(fs.readFileSync(privateFile, "utf8").includes(canary), false);

  fs.writeFileSync(privateFile, JSON.stringify([{ input: { value: "public-input" }, expected: { value: "different", oracle: canary } }]));
  const failed = await runBlackBoxOracle({ dir: taskDir }, workspace, check);
  assert.equal(failed.pass, false);
  assert.deepEqual(failed.failedCases, [0]);
  assert.deepEqual(failed.mismatchCases, [0]);
  assert.equal(JSON.stringify(failed).includes(canary), false, "failure summaries do not leak hidden values");

  fs.writeFileSync(candidate, "console.log('x'.repeat(10000));\n");
  const overflow = await runBlackBoxOracle({ dir: taskDir }, workspace, { ...check, maxOutputBytes: 64 });
  assert.equal(overflow.pass, false);
  assert.deepEqual(overflow.outputLimitCases, [0]);
  assert.equal(overflow.overflow, true);
  assert.equal(JSON.stringify(overflow).includes("xxxx"), false, "output-overflow evidence discards candidate output");

  fs.writeFileSync(candidate, "while (true) {}\n");
  const timed = await runBlackBoxOracle({ dir: taskDir }, workspace, { ...check, timeoutMs: 100, totalTimeoutMs: 500 });
  assert.equal(timed.pass, false);
  assert.deepEqual(timed.timeoutCases, [0]);
  assert.equal(timed.timedOut, true);
  assert.equal(JSON.stringify(timed).includes(canary), false);

  const fixtureTask = fs.mkdtempSync(path.join(os.tmpdir(), "eval-oracle-fixture-task-"));
  const fixtureWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "eval-oracle-fixture-ws-"));
  fs.mkdirSync(path.join(fixtureTask, "fixture"));
  fs.writeFileSync(path.join(fixtureTask, "fixture", "private.json"), JSON.stringify([{ input: {}, expected: canary }]));
  await assert.rejects(
    runBlackBoxOracle({ dir: fixtureTask, fixture: "fixture" }, fixtureWorkspace, { ...check, casesFile: "fixture/private.json" }),
    /outside the candidate fixture/,
  );
});

test("Python black-box oracle uses only pinned offline Go and Rust toolchains, or fails preflight", { timeout: 60_000 }, async (t) => {
  const { blackBoxOracleProblem, runBlackBoxOracle } = await import(path.join(ROOT, "eval/oracle.mjs"));
  const { candidateToolchainRootProblem, candidateToolchainRootSources, candidateToolchainVersionProblem, selectCandidateToolchainSource, compilerExposureMaskArgs, scanOracleCompilerExposure, oracleToolchainPathProblem, oracleToolchainVersionProblem, oracleToolchainsProblem, isolatedProcessArgv, sandboxAvailable } = await import(path.join(ROOT, "eval/isolate.mjs"));
  const toolchainPolicy = JSON.parse(fs.readFileSync(path.join(ROOT, "eval/toolchain-versions.json"), "utf8"));
  const rustToolchain = fs.readFileSync(path.join(ROOT, "rust-toolchain.toml"), "utf8");
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.equal(toolchainPolicy.go, "1.22.12");
  assert.equal(toolchainPolicy.rust, /^channel = "([^"]+)"$/m.exec(rustToolchain)?.[1]);
  assert.equal((workflow.match(/go-version: '([^']+)'/g) ?? []).length, 2);
  assert.equal((workflow.match(/go-version: '1\.22\.12'/g) ?? []).length, 2, "both CI jobs install the exact approved Go version");
  assert.equal((workflow.match(/run: bash scripts\/install-evaluator-toolchains\.sh/g) ?? []).length, 2, "both CI jobs use the same exact-version installer");
  assert.equal(oracleToolchainVersionProblem({
    goVersion: "go version go1.22.12 linux/amd64",
    rustcVersion: "rustc 1.95.0 (fixture)",
    cargoVersion: "cargo 1.95.0 (fixture)",
  }), null);
  assert.match(oracleToolchainVersionProblem({
    goVersion: "go version go1.22.11 linux/amd64",
    rustcVersion: "rustc 1.95.0 (fixture)",
    cargoVersion: "cargo 1.95.0 (fixture)",
  }), /do not match policy/);
  assert.equal(candidateToolchainVersionProblem("/usr/local/go", { goVersion: "go version go1.22.12 linux/amd64" }), null);
  assert.match(candidateToolchainVersionProblem("/usr/local/go", { goVersion: "go version go1.22.11 linux/amd64" }), /expected 1\.22\.12/);
  assert.equal(candidateToolchainVersionProblem("/usr/local/nexus-qual/rust", {
    rustcVersion: "rustc 1.95.0 (fixture)", cargoVersion: "cargo 1.95.0 (fixture)",
  }), null);
  assert.match(candidateToolchainVersionProblem("/usr/local/nexus-qual/rust", {
    rustcVersion: "rustc 1.94.0 (fixture)", cargoVersion: "cargo 1.95.0 (fixture)",
  }), /expected 1\.95\.0/);
  const staleGoFallback = "/opt/nexus-qual/go";
  const pinnedGoFallback = "/usr/local/go";
  assert.equal(selectCandidateToolchainSource([staleGoFallback, pinnedGoFallback], (sourceRoot) => candidateToolchainVersionProblem("/usr/local/go", {
    goVersion: sourceRoot === staleGoFallback ? "go version go1.22.11 linux/amd64" : "go version go1.22.12 linux/amd64",
  })), pinnedGoFallback, "a stale fallback is skipped and the later pinned candidate compiler is selected");
  assert.match(oracleToolchainVersionProblem({
    goVersion: "go version go1.22.12 linux/amd64",
    rustcVersion: "rustc 1.94.0 (fixture)",
    cargoVersion: "cargo 1.95.0 (fixture)",
  }), /do not match policy/);

  const fakeSystem = fs.mkdtempSync(path.join(os.tmpdir(), "eval-oracle-unpinned-compiler-system-"));
  const batchedSystem = fs.mkdtempSync(path.join(os.tmpdir(), "eval-oracle-batched-compiler-system-"));
  const changingSystem = fs.mkdtempSync(path.join(os.tmpdir(), "eval-oracle-changing-compiler-system-"));
  const fakeSystemAlias = `${fakeSystem}-alias`;
  const fakeAlternatives = fs.mkdtempSync(path.join(os.tmpdir(), "eval-oracle-unpinned-compiler-alternatives-"));
  const fakeSymlinkTarget = fs.mkdtempSync(path.join(os.tmpdir(), "eval-oracle-unpinned-compiler-target-"));
  const fakeMountedRuntime = fs.mkdtempSync(path.join(os.tmpdir(), "eval-oracle-mounted-runtime-"));
  const fakeApprovedToolchain = fs.mkdtempSync(path.join(os.tmpdir(), "eval-oracle-approved-toolchain-"));
  const fakeLib = path.join(fakeSystem, "rustlib", "bin");
  const fakeGoTarget = path.join(fakeSystem, "lib", "go-1.22.12", "go");
  const fakeExternalGoTarget = path.join(fakeMountedRuntime, "go");
  fs.mkdirSync(path.join(fakeSystem, "bin"), { recursive: true });
  fs.mkdirSync(fakeLib, { recursive: true });
  fs.mkdirSync(path.dirname(fakeGoTarget), { recursive: true });
  const compilerCanary = "#!/bin/sh\nprintf '%s\\n' UNPINNED_COMPILER_CANARY\n";
  const fakeGo = path.join(fakeSystem, "bin", "go");
  const fakeRustc = path.join(fakeLib, "rustc");
  const fakeCargo = path.join(fakeSystem, "bin", "cargo-1.94.0");
  const fakeNoShebang = path.join(fakeSystem, "bin", "rustc-1.94.0");
  const fakeTerminfo = path.join(fakeSystem, "share", "terminfo", "g", "go-225");
  fs.mkdirSync(path.dirname(fakeTerminfo), { recursive: true });
  fs.writeFileSync(fakeTerminfo, Buffer.from([0x1a, 0x01, 0x00, 0x00]));
  fs.chmodSync(fakeTerminfo, 0o755);
  for (const file of [fakeGoTarget, fakeExternalGoTarget, fakeRustc, fakeCargo]) {
    fs.writeFileSync(file, compilerCanary);
    fs.chmodSync(file, 0o755);
  }
  fs.symlinkSync(fakeGoTarget, fakeGo);
  fs.symlinkSync(fakeExternalGoTarget, path.join(fakeSystem, "bin", "go-1.99.0"));
  fs.writeFileSync(fakeNoShebang, "exit 7\n");
  fs.chmodSync(fakeNoShebang, 0o755);
  fs.symlinkSync(fakeCargo, path.join(fakeAlternatives, "cargo"));
  fs.symlinkSync(fakeCargo, path.join(fakeAlternatives, "compiler-alias"));
  fs.writeFileSync(path.join(fakeSymlinkTarget, "rustc"), compilerCanary);
  fs.chmodSync(path.join(fakeSymlinkTarget, "rustc"), 0o755);
  fs.symlinkSync(fakeSymlinkTarget, path.join(fakeSystem, "compiler-reach"));
  fs.symlinkSync(path.join(fakeSymlinkTarget, "rustc"), path.join(fakeSystem, "bin", "rustc-alias"));
  fs.symlinkSync(fakeSystem, fakeSystemAlias, "dir");
  t.after(() => {
    fs.rmSync(fakeSystem, { recursive: true, force: true });
    fs.rmSync(batchedSystem, { recursive: true, force: true });
    fs.rmSync(changingSystem, { recursive: true, force: true });
    fs.rmSync(fakeSystemAlias, { recursive: true, force: true });
    fs.rmSync(fakeAlternatives, { recursive: true, force: true });
    fs.rmSync(fakeSymlinkTarget, { recursive: true, force: true });
    fs.rmSync(fakeMountedRuntime, { recursive: true, force: true });
    fs.rmSync(fakeApprovedToolchain, { recursive: true, force: true });
  });
  // Keep the compiler under the 65th depth-3 subtree so this catches dropped later batches.
  const batchedChildren = Array.from({ length: 65 }, (_, index) => {
    const child = path.join(batchedSystem, `child-${String(index).padStart(2, "0")}`);
    const scanDirectory = path.join(child, "scan-subtree", "deep");
    fs.mkdirSync(scanDirectory, { recursive: true });
    return scanDirectory;
  });
  const batchedRootEntries = spawnSync("/usr/bin/find", ["-P", batchedSystem, "-mindepth", "3", "-maxdepth", "3", "-type", "d", "-print0"], { encoding: "buffer" });
  assert.equal(batchedRootEntries.status, 0, "the fixture can enumerate the bounded directory batches");
  const orderedBatchedChildren = batchedRootEntries.stdout.toString("utf8").split("\0").filter(Boolean);
  assert.equal(orderedBatchedChildren.length, batchedChildren.length);
  const lateBatchedCompiler = path.join(orderedBatchedChildren.at(-1), "rustc");
  fs.writeFileSync(lateBatchedCompiler, compilerCanary);
  fs.chmodSync(lateBatchedCompiler, 0o755);
  const batchedExposure = scanOracleCompilerExposure([batchedSystem], [], []);
  assert.equal(batchedExposure.problem, null);
  assert.ok(batchedExposure.paths.includes(lateBatchedCompiler), "compiler binaries in later sibling batches remain discoverable and maskable");
  assert.deepEqual(scanOracleCompilerExposure([changingSystem], [], []), { paths: [], problem: null }, "an initially clean mounted system has no compiler masks");
  const introducedCompiler = path.join(changingSystem, "go");
  fs.writeFileSync(introducedCompiler, compilerCanary);
  fs.chmodSync(introducedCompiler, 0o755);
  const changedScan = scanOracleCompilerExposure([changingSystem], [], []);
  assert.equal(changedScan.problem, null);
  assert.ok(changedScan.paths.includes(introducedCompiler), "compiler exposure is rescanned after filesystem changes");
  assert.deepEqual(compilerExposureMaskArgs(changedScan), ["--ro-bind", "/dev/null", introducedCompiler], "the discovered compiler is converted to an actual sandbox mask");
  const exposure = scanOracleCompilerExposure([fakeSystem], [fakeAlternatives]);
  assert.equal(exposure.problem, null);
  assert.ok(exposure.paths.some((item) => item.includes("rustlib/bin/rustc")));
  assert.ok(exposure.paths.some((item) => item.includes("bin/cargo-1.94.0")));
  assert.ok(!exposure.paths.some((item) => item.includes("rustc-alias")), "a symlink to a compiler outside mounted system roots is not reachable in the sandbox");
  assert.ok(!exposure.paths.some((item) => item.includes("eval-oracle-unpinned-compiler-alternatives-") && item.endsWith("/cargo")));
  assert.ok(!exposure.paths.some((item) => item.includes("eval-oracle-unpinned-compiler-alternatives-") && item.endsWith("/compiler-alias")));
  assert.ok(exposure.paths.some((item) => item.includes("rustc-1.94.0")), "no-shebang executable compilers must be detected and masked");
  assert.ok(!exposure.paths.some((item) => item.includes("go-225")), "executable-mode terminfo data is not a compiler binary");
  const externalMountedExposure = scanOracleCompilerExposure([fakeSystem], [], [fakeExternalGoTarget]);
  assert.ok(externalMountedExposure.paths.includes(fakeExternalGoTarget), "a compiler target outside system roots must be masked when separately mounted");
  const fakeExcludedRuntime = path.join(fakeMountedRuntime, "android-sdk");
  const excludedCompiler = path.join(fakeExcludedRuntime, "platform-tools", "go");
  fs.mkdirSync(path.dirname(excludedCompiler), { recursive: true });
  fs.writeFileSync(excludedCompiler, compilerCanary);
  fs.chmodSync(excludedCompiler, 0o755);
  const excludedTreeScan = scanOracleCompilerExposure([fakeMountedRuntime], [], [], [], [fakeExcludedRuntime]);
  assert.equal(excludedTreeScan.problem, null);
  assert.ok(excludedTreeScan.paths.includes(fakeExternalGoTarget), "compiler paths outside the masked SDK subtree remain scanned");
  assert.ok(!excludedTreeScan.paths.includes(excludedCompiler), "compiler paths below a candidate-hidden SDK subtree are not exposed to the candidate");
  const approvedToolchainCompiler = path.join(fakeApprovedToolchain, "bin", "rustc");
  fs.mkdirSync(path.dirname(approvedToolchainCompiler), { recursive: true });
  fs.writeFileSync(approvedToolchainCompiler, compilerCanary);
  fs.chmodSync(approvedToolchainCompiler, 0o755);
  const approvedToolchainScan = scanOracleCompilerExposure([], [], [approvedToolchainCompiler], [fakeApprovedToolchain]);
  assert.deepEqual(approvedToolchainScan, { paths: [], problem: null }, "an independently validated approved toolchain is excluded from the unapproved compiler inventory");
  const mixedToolchainScan = scanOracleCompilerExposure([], [], [approvedToolchainCompiler, fakeExternalGoTarget], [fakeApprovedToolchain]);
  assert.deepEqual(mixedToolchainScan.paths, [fakeExternalGoTarget], "excluding an approved toolchain does not skip other separately mounted compiler paths");
  const aliasedExposure = scanOracleCompilerExposure([fakeSystem, fakeSystemAlias], []);
  assert.ok(aliasedExposure.paths.includes(fakeGoTarget), "the canonical mounted spelling is scanned and masked");
  assert.ok(aliasedExposure.paths.includes(path.join(fakeSystemAlias, path.relative(fakeSystem, fakeGoTarget))), "every mounted spelling of a shared system directory is scanned and masked");
  const invalidUtf8Directory = Buffer.concat([Buffer.from(fakeSystem), Buffer.from([path.sep.charCodeAt(0), 0xff])]);
  const invalidUtf8Compiler = Buffer.concat([invalidUtf8Directory, Buffer.from("/rustc")]);
  fs.mkdirSync(invalidUtf8Directory);
  fs.writeFileSync(invalidUtf8Compiler, compilerCanary);
  fs.chmodSync(invalidUtf8Compiler, 0o755);
  const invalidUtf8Exposure = scanOracleCompilerExposure([fakeSystem], [], []);
  assert.match(invalidUtf8Exposure.problem ?? "", /compiler exposure could not be checked/, "non-UTF-8 path bytes fail closed instead of being replaced with a different path");
  const nestedUtf8System = fs.mkdtempSync(path.join(os.tmpdir(), "eval-oracle-nested-invalid-compiler-system-"));
  const nestedParent = path.join(nestedUtf8System, "nested-parent");
  fs.mkdirSync(nestedParent);
  const nestedInvalidDirectory = Buffer.concat([Buffer.from(nestedParent), Buffer.from(path.sep), Buffer.from([0xff])]);
  const nestedInvalidCompiler = Buffer.concat([nestedInvalidDirectory, Buffer.from("/rustc")]);
  fs.mkdirSync(nestedInvalidDirectory);
  fs.writeFileSync(nestedInvalidCompiler, compilerCanary);
  fs.chmodSync(nestedInvalidCompiler, 0o755);
  t.after(() => fs.rmSync(nestedUtf8System, { recursive: true, force: true }));
  const nestedInvalidUtf8Exposure = scanOracleCompilerExposure([nestedUtf8System], [], []);
  assert.match(nestedInvalidUtf8Exposure.problem ?? "", /compiler exposure could not be checked/, "nested non-UTF-8 compiler paths fail closed instead of disappearing during output decoding");
  const fakeGoAliasTarget = path.join(fakeSystemAlias, "lib", "go-1.22.12", "go");
  const maskArgs = compilerExposureMaskArgs({ paths: [fakeGoTarget, fakeGoAliasTarget, fakeCargo, fakeCargo], problem: null });
  const maskedDestinations = maskArgs.filter((value, index) => index > 0 && maskArgs[index - 1] === "/dev/null");
  assert.ok(maskedDestinations.includes(fakeGoTarget), "the canonical compiler mount spelling must be masked");
  assert.ok(maskedDestinations.includes(fakeGoAliasTarget), "the compiler's alternate mounted spelling must remain masked");
  assert.equal(maskedDestinations.filter((destination) => destination === fakeCargo).length, 1, "duplicate regular-file mount destinations must be deduplicated");
  assert.ok(!maskedDestinations.includes(fakeGo), "Bubblewrap must not bind over a symlink destination");
  assert.ok(!maskedDestinations.includes(path.join(fakeSystemAlias, "bin", "go")), "Bubblewrap must not bind over an aliased symlink destination");
  const invalidRootTarget = fs.mkdtempSync(path.join(os.tmpdir(), "eval-oracle-invalid-candidate-toolchain-target-"));
  const invalidCandidateRoot = `${invalidRootTarget}-link`;
  const danglingCandidateRoot = `${invalidRootTarget}-dangling`;
  fs.mkdirSync(path.join(invalidRootTarget, "bin"));
  const invalidRootCompiler = path.join(invalidRootTarget, "bin", "rustc");
  fs.writeFileSync(invalidRootCompiler, compilerCanary);
  fs.chmodSync(invalidRootCompiler, 0o755);
  fs.symlinkSync(invalidRootTarget, invalidCandidateRoot, "dir");
  fs.symlinkSync(path.join(invalidRootTarget, "missing-target"), danglingCandidateRoot, "dir");
  t.after(() => {
    fs.rmSync(invalidRootTarget, { recursive: true, force: true });
    fs.rmSync(invalidCandidateRoot, { recursive: true, force: true });
    fs.rmSync(danglingCandidateRoot, { recursive: true, force: true });
  });
  const inactiveRustToolchain = {
    root: "/usr/local/nexus-qual/rust",
    sourceRoots: [invalidCandidateRoot],
    required: ["bin/rustc"],
  };
  const inactiveRustSource = candidateToolchainRootSources([inactiveRustToolchain]);
  assert.deepEqual(inactiveRustSource, { "/usr/local/nexus-qual/rust": null }, "an unsafe configured Rust fallback is omitted from candidate mounts rather than blocking compiler-independent tasks");
  const legacyExposure = scanOracleCompilerExposure([], [], [invalidRootCompiler], inactiveRustToolchain.sourceRoots);
  assert.ok(!legacyExposure.paths.includes(invalidRootCompiler), "approving every configured source root reproduces the old bypass by suppressing this compiler mask");
  const danglingRustSource = candidateToolchainRootSources([{
    root: "/usr/local/nexus-qual/rust",
    sourceRoots: [danglingCandidateRoot, "/usr/local/go"],
    required: ["bin/go"],
  }]);
  assert.deepEqual(danglingRustSource, { "/usr/local/nexus-qual/rust": null }, "a Go fallback cannot be mounted as the pinned Rust toolchain when Rust executables are absent");
  const selectedToolchainRoots = Object.values(inactiveRustSource).filter(Boolean);
  const invalidRootExposure = scanOracleCompilerExposure([], [], [invalidRootCompiler], selectedToolchainRoots);
  assert.ok(invalidRootExposure.paths.includes(invalidRootCompiler), "compiler under an inactive configured Rust source remains masked when separately mounted as a runtime file");
  if (sandboxAvailable() && fs.existsSync("/usr/local/lib/android")) {
    const systemSdkMasked = isolatedProcessArgv({
      cwd: fakeSystem,
      command: "/usr/bin/true",
      systemDirectories: ["/usr/local/lib"],
      systemEtcDirectories: [],
    });
    const sdkMaskIndex = systemSdkMasked.argv.findIndex((value, index) => value === "--tmpfs" && systemSdkMasked.argv[index + 1] === "/usr/local/lib/android");
    const libBindIndex = systemSdkMasked.argv.findIndex((value, index) => value === "--ro-bind" && systemSdkMasked.argv[index + 1] === "/usr/local/lib" && systemSdkMasked.argv[index + 2] === "/usr/local/lib");
    assert.ok(libBindIndex >= 0 && sdkMaskIndex > libBindIndex, "the host-only Android SDK is hidden after its parent runtime directory is mounted");
  }
  if (sandboxAvailable() && !oracleToolchainsProblem({ systemDirectories: [fakeSystem, fakeSystemAlias], systemEtcDirectories: [fakeAlternatives], additionalMountedPaths: [fakeExternalGoTarget] })) {
    const isolated = isolatedProcessArgv({
      cwd: fakeSystem,
      command: "/usr/bin/true",
      readOnlyPaths: ["/usr/bin/true"],
      allowedFiles: ["/usr/bin/true"],
      oracleToolchains: true,
      systemDirectories: [fakeSystem, fakeSystemAlias],
      systemEtcDirectories: [fakeAlternatives],
    });
    for (const executable of [fakeGo, fakeRustc, fakeCargo, fakeNoShebang, path.join(fakeAlternatives, "cargo"), path.join(fakeAlternatives, "compiler-alias")]) {
      const mountedTargets = [executable, fs.realpathSync(executable)];
      assert.ok(mountedTargets.some((target) => isolated.argv.some((value, index) => value === "--ro-bind" && isolated.argv[index + 1] === "/dev/null" && isolated.argv[index + 2] === target)), `unapproved compiler target is not masked in the execution namespace: ${executable}`);
    }
    assert.ok(!isolated.argv.includes(fakeTerminfo), "non-executable compiler-like data must not be masked");
    const actualMaskDestinations = isolated.argv.filter((value, index) => index > 0 && isolated.argv[index - 1] === "/dev/null");
    assert.ok(actualMaskDestinations.includes(fakeGoTarget), "the canonical system mount spelling is masked in the actual candidate argv");
    assert.ok(actualMaskDestinations.includes(fakeGoAliasTarget), "the alternate system mount spelling is masked in the actual candidate argv");
    const externalRuntime = isolatedProcessArgv({
      cwd: fakeSystem,
      command: "/usr/bin/true",
      readOnlyPaths: ["/usr/bin/true", fakeExternalGoTarget],
      allowedFiles: ["/usr/bin/true", fakeExternalGoTarget],
      oracleToolchains: true,
      systemDirectories: [fakeSystem],
      systemEtcDirectories: [fakeAlternatives],
    });
    const externalMaskIndex = externalRuntime.argv.findIndex((value, index) => value === "--ro-bind" && externalRuntime.argv[index + 1] === "/dev/null" && externalRuntime.argv[index + 2] === fakeExternalGoTarget);
    const externalRuntimeMountIndex = externalRuntime.argv.findIndex((value, index) => value === "--ro-bind" && externalRuntime.argv[index + 1] === fakeExternalGoTarget && externalRuntime.argv[index + 2] === fakeExternalGoTarget);
    assert.ok(externalMaskIndex > externalRuntimeMountIndex, "external compiler mask must follow and override its explicit runtime mount");
  }

  assert.equal(oracleToolchainPathProblem({ uid: 0, mode: 0o040755 }), null, "root-owned read-only directories are eligible");
  assert.match(oracleToolchainPathProblem({ uid: 0, mode: 0o040775 }), /without group or other write permission/, "group-writable toolchain paths must fail closed");
  assert.match(oracleToolchainPathProblem({ uid: 0, mode: 0o040757 }), /without group or other write permission/, "other-writable toolchain paths must fail closed");
  assert.match(oracleToolchainPathProblem({ uid: 1234, mode: 0o040755 }), /root-owned/, "non-root-owned paths are not pinned roots");
  const candidateRootStat = { uid: 0, mode: 0o040755, isDirectory: () => true, isSymbolicLink: () => false };
  assert.equal(candidateToolchainRootProblem(candidateRootStat, "/usr/local/nexus-qual/rust", "/usr/local/nexus-qual/rust"), null);
  assert.match(candidateToolchainRootProblem({ ...candidateRootStat, isSymbolicLink: () => true }, "/usr/local/nexus-qual/rust", "/usr/local/nexus-qual/rust"), /safe real directory/, "candidate mounts reject symlinked toolchain roots");
  assert.match(candidateToolchainRootProblem({ ...candidateRootStat, mode: 0o040775 }, "/usr/local/nexus-qual/rust", "/usr/local/nexus-qual/rust"), /safe real directory/, "candidate mounts reject group-writable toolchain roots");
  assert.match(candidateToolchainRootProblem(candidateRootStat, "/tmp/toolchain", "/usr/local/nexus-qual/rust"), /safe real directory/, "candidate mounts reject roots resolving outside the pinned path");
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-oracle-toolchain-task-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "eval-oracle-toolchain-candidate-"));
  t.after(() => {
    fs.rmSync(taskDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(taskDir, "private-cases.json"), JSON.stringify([{ input: { value: "fixture" }, expected: { value: "fixture", go: "go-ok", rust: "rust-ok" } }]));
  fs.writeFileSync(path.join(workspace, "main.go"), 'package main\nimport "fmt"\nfunc main(){fmt.Print("go-ok")}\n');
  fs.writeFileSync(path.join(workspace, "Cargo.toml"), '[package]\nname = "nexus-oracle-canary"\nversion = "0.1.0"\nedition = "2021"\n');
  fs.writeFileSync(path.join(workspace, "Cargo.lock"), '# This file is automatically @generated by Cargo.\nversion = 4\n\n[[package]]\nname = "nexus-oracle-canary"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(workspace, "src/main.rs"), 'fn main(){print!("rust-ok")}\n');
  fs.writeFileSync(path.join(workspace, "check.py"), [
    "import json, subprocess, sys",
    "for executable, expected in (('/usr/bin/go', 'go1.22.12'), ('/usr/bin/rustc', '1.95.0'), ('/usr/bin/cargo', '1.95.0')):",
    "    try:",
    "        result = subprocess.run([executable, '--version'], capture_output=True, text=True)",
    "    except FileNotFoundError:",
    "        continue",
    "    reported = (result.stdout + result.stderr).strip()",
    "    if result.returncode == 0 and expected not in reported:",
    "        raise SystemExit('unapproved compiler reached by absolute path: ' + executable)",
    "subprocess.run(['go', 'build', '-o', '/tmp/nexus-oracle-go', '/workspace/main.go'], check=True, capture_output=True, text=True)",
    "subprocess.run(['cargo', 'build', '--locked', '--offline', '--manifest-path', '/workspace/Cargo.toml'], check=True, capture_output=True, text=True)",
    "go = subprocess.run(['/tmp/nexus-oracle-go'], check=True, capture_output=True, text=True).stdout",
    "rust = subprocess.run(['/tmp/cargo-target/debug/nexus-oracle-canary'], check=True, capture_output=True, text=True).stdout",
    "value = json.loads(sys.stdin.readline())['value']",
    "print(json.dumps({'value': value, 'go': go, 'rust': rust}))",
    "",
  ].join("\n"));
  const check = { protocol: "blackbox-v1", casesFile: "private-cases.json", runtime: "python3", argv: ["check.py"], timeoutMs: 30_000, totalTimeoutMs: 45_000, maxOutputBytes: 4096 };
  const problem = oracleToolchainsProblem();
  if (problem) {
    assert.equal(blackBoxOracleProblem(check, taskDir), problem, "qualification preflight must fail closed when pinned toolchains are unavailable");
    return;
  }
  assert.equal(blackBoxOracleProblem(check, taskDir), null);
  const candidateToolchainRoots = candidateToolchainRootSources();
  assert.ok(candidateToolchainRoots["/usr/local/go"], "the pinned Go source used by the candidate runtime is available");
  const sourceFiles = ["main.go", "Cargo.toml", "Cargo.lock", "src/main.rs", "check.py"];
  const sourceBefore = sourceFiles.map((file) => fs.readFileSync(path.join(workspace, file), "utf8"));
  await assert.rejects(
    runBlackBoxOracle({ dir: taskDir }, workspace, check, { protectedCorpusPaths: [candidateToolchainRoots["/usr/local/go"]!] }),
    /overlaps protected corpus/,
    "the oracle refuses even a pinned runtime root if it overlaps protected corpus material",
  );
  const result = await runBlackBoxOracle({ dir: taskDir }, workspace, check, { protectedCorpusPaths: [taskDir] });
  assert.equal(result.pass, true, `pinned offline compiler fixture failed: ${JSON.stringify(result)}`);
  assert.equal(JSON.stringify(result).includes("go-ok"), false);
  assert.equal(JSON.stringify(result).includes("rust-ok"), false);
  assert.deepEqual(sourceFiles.map((file) => fs.readFileSync(path.join(workspace, file), "utf8")), sourceBefore, "the oracle build leaves the read-only candidate workspace unchanged");
});

test("a qualification run is refused without a model fingerprint (weights, server build, sampling)", async () => {
  const { modelFingerprint } = await import(path.join(ROOT, "eval/validate.mjs"));
  const entry = { id: "m", owned_by: "llamacpp", meta: { n_ctx_train: 32768 } };
  assert.equal(modelFingerprint({ model: "m" }, entry).missing.length, 0, "a development run needs no fingerprint");
  const missing = modelFingerprint({ model: "m", qualification: true }, entry).missing;
  assert.equal(missing.length, 3);
  const ok = modelFingerprint({ model: "m", qualification: true, fingerprint: { weightsSha256: "b".repeat(64), serverBuild: "llama.cpp b6000" }, sampling: { temperature: 0, seed: 1 } }, entry);
  assert.deepEqual(ok.missing, []);
  assert.equal(ok.fingerprint.ownedBy, "llamacpp");
  assert.equal(ok.fingerprint.contextLength, 32768);
  assert.equal(modelFingerprint({ model: "m", qualification: true, fingerprint: ok.fingerprint, sampling: { temperature: 0 } }, null).missing[0], "the endpoint does not list model m");
});

test("qualification requires frozen request and aggregate output budgets", async () => {
  const { qualificationBudgetProblem } = await import(path.join(ROOT, "eval/validate.mjs"));
  assert.match(qualificationBudgetProblem({ qualification: true, limits: { context: 65536, output: 8192 } }), /limits.requests/);
  assert.match(qualificationBudgetProblem({ limits: { output: 8192, requests: 5 } }), /limits.totalOutput/);
  assert.match(qualificationBudgetProblem({ limits: { output: 8192, requests: 5, totalOutput: 4096 } }), /cannot be lower/);
  assert.equal(qualificationBudgetProblem({ limits: { output: 8192, requests: 5, totalOutput: 32768 } }), null);
});

test("hidden tests must be unreadable to the agent's own user", async () => {
  const { hiddenTestIsolationProblem, asUser } = await import(path.join(ROOT, "eval/validate.mjs"));
  const tasks = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-tasks-"));
  fs.chmodSync(tasks, 0o755);
  assert.equal(hiddenTestIsolationProblem({}, tasks), null, "development runs may run as the operator");
  assert.match(hiddenTestIsolationProblem({ qualification: true }, tasks), /need runAs/);
  assert.match(hiddenTestIsolationProblem({ runAs: "nexus-eval" }, tasks), /evaluator account|setfacl|sandboxRuntimePaths/);
  assert.match(hiddenTestIsolationProblem({ runAs: "bad user;" }, tasks), /not a valid user name/);
  const wrapped = asUser("nexus-eval", "/usr/bin/bwrap", ["--unshare-all", "--", "/runner/node"]);
  // Exactly the form the provisioned sudoers rule permits: no env wrapper that would need an any-command rule.
  assert.equal(wrapped.cmd, "/usr/bin/sudo");
  assert.deepEqual(wrapped.argv, ["-n", "-u", "nexus-eval", "--", "/usr/bin/bwrap", "--unshare-all", "--", "/runner/node"]);
  assert.throws(() => asUser("nexus-eval", "bwrap", []), /absolute/);
  const sudoers = fs.readFileSync(path.join(ROOT, "eval/host/provision.sh"), "utf8");
  assert.match(sudoers, /ALL=\(%s\) !ALL\\n%s ALL=\(%s\) NOPASSWD: \/usr\/bin\/bwrap\\n/, "the explicit deny-all precedes the exact bwrap grant");
});

test("candidate agents receive only the approved read-only Go and Rust toolchain mounts", async () => {
  const { candidateAgentPath, candidateToolchainMountArgs } = await import(path.join(ROOT, "eval/isolate.mjs"));
  const toolchains = { goRoot: "/host/toolchains/go", rustRoot: "/host/toolchains/rust" };
  assert.equal(
    candidateAgentPath("/custom/bin:/usr/bin:/bin", toolchains),
    "/usr/local/nexus-qual/rust/bin:/usr/local/go/bin:/custom/bin:/usr/bin:/bin",
  );
  assert.deepEqual(candidateToolchainMountArgs(toolchains), [
    "--dir", "/usr/local", "--ro-bind", toolchains.goRoot, "/usr/local/go",
    "--dir", "/usr/local/nexus-qual", "--ro-bind", toolchains.rustRoot, "/usr/local/nexus-qual/rust",
  ]);
  assert.deepEqual(candidateToolchainMountArgs({ goRoot: null, rustRoot: toolchains.rustRoot }), [
    "--dir", "/usr/local", "--dir", "/usr/local/nexus-qual", "--ro-bind", toolchains.rustRoot, "/usr/local/nexus-qual/rust",
  ]);
  assert.deepEqual(candidateToolchainMountArgs({ goRoot: null, rustRoot: null }), []);
  assert.deepEqual(candidateToolchainMountArgs({ goRoot: toolchains.goRoot, rustRoot: null }, ["/usr/local/lib"]), [
    "--ro-bind", toolchains.goRoot, "/usr/local/go",
  ]);
});

test("qualification runtime mounts cannot overlap the task tree, held-out store, or private validator paths", async () => {
  const { hiddenTestIsolationProblem, runtimeCorpusOverlapProblem } = await import(path.join(ROOT, "eval/validate.mjs"));
  const { agentSandboxArgv, candidateSandboxHostMountSources, candidateToolchainRootSources, isolatedArgv, sandboxAvailable } = await import(path.join(ROOT, "eval/isolate.mjs"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-corpus-overlap-"));
  try {
    const store = path.join(root, "heldout-v2");
    const tasks = path.join(store, "tasks");
    const references = path.join(store, "reference");
    const runtimeRoot = path.join(root, "runtime");
    const home = path.join(root, "home");
    const proxyDirectory = path.join(root, "proxy");
    const readOnlyRuntime = path.join(runtimeRoot, "runtime.bin");
    const inactiveToolchainRoot = path.join(root, "inactive-toolchain");
    const inactiveCompiler = path.join(inactiveToolchainRoot, "bin", "rustc");
    const supervisorPath = path.join(ROOT, "eval/agent_sandbox.mjs");
    const privateValidator = path.join(root, "private-validator");
    fs.mkdirSync(tasks, { recursive: true });
    fs.mkdirSync(references);
    fs.mkdirSync(runtimeRoot);
    fs.mkdirSync(home);
    fs.mkdirSync(proxyDirectory);
    fs.mkdirSync(privateValidator);
    fs.mkdirSync(path.dirname(inactiveCompiler), { recursive: true });
    fs.writeFileSync(readOnlyRuntime, "runtime\n");
    fs.writeFileSync(inactiveCompiler, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(inactiveCompiler, 0o755);
    fs.writeFileSync(path.join(tasks, "task.json"), "{}\n");
    fs.writeFileSync(path.join(references, "solution.patch"), "REFERENCE_SOLUTION_CANARY\n");
    fs.writeFileSync(path.join(privateValidator, "validate.mjs"), "PRIVATE_VALIDATOR_CANARY\n");
    const alias = path.join(root, "store-alias");
    fs.symlinkSync(store, alias, "dir");

    const mountContext = { cwd: runtimeRoot, home, proxyDirectory, nodeRuntime: process.execPath, supervisorPath };
    const hostMounts = candidateSandboxHostMountSources({ ...mountContext, readOnlyPaths: [readOnlyRuntime] });
    const expectedToolchains = Object.values(candidateToolchainRootSources()).filter(Boolean);
    const existingDirectories = ["/usr/bin", "/usr/lib", "/usr/lib64", "/usr/libexec", "/usr/share/git-core/templates", "/usr/share/terminfo", "/usr/share/zoneinfo", "/lib", "/lib64", "/usr/local/lib"]
      .filter((item) => { try { return fs.statSync(item).isDirectory(); } catch { return false; } });
    const existingEtcFiles = ["/etc/ld.so.cache", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/localtime"]
      .filter((item) => { try { return fs.statSync(item).isFile(); } catch { return false; } });
    const existingEtcDirectories = ["/etc/alternatives"]
      .filter((item) => { try { return fs.statSync(item).isDirectory(); } catch { return false; } });
    assert.deepEqual(hostMounts.systemDirectories, existingDirectories);
    assert.ok(!hostMounts.systemDirectories.includes("/usr/share"), "candidate runtimes do not mount the host's broad application-data tree");
    assert.deepEqual(hostMounts.systemFiles, existingEtcFiles);
    assert.deepEqual(hostMounts.systemEtcDirectories, existingEtcDirectories);
    assert.deepEqual(hostMounts.toolchainDirectories, expectedToolchains);
    assert.deepEqual(hostMounts.runtimeSources, {
      cwd: fs.realpathSync(runtimeRoot),
      home: fs.realpathSync(home),
      proxyDirectory,
      nodeRuntime: fs.realpathSync(process.execPath),
      supervisorPath: fs.realpathSync(supervisorPath),
      readOnlyPaths: [fs.realpathSync(readOnlyRuntime)],
    });

    if (sandboxAvailable()) {
      const candidate = agentSandboxArgv({
        ...mountContext,
        readOnlyPaths: [readOnlyRuntime, inactiveCompiler],
        runtimeExecutablePaths: [readOnlyRuntime, inactiveCompiler],
        supervisorPath,
      });
      const compilerMount = candidate.argv.findIndex((value, index) => value === "--ro-bind" && candidate.argv[index + 1] === inactiveCompiler && candidate.argv[index + 2] === inactiveCompiler);
      const compilerMask = candidate.argv.findIndex((value, index) => value === "--ro-bind" && candidate.argv[index + 1] === "/dev/null" && candidate.argv[index + 2] === inactiveCompiler);
      assert.ok(compilerMount >= 0 && compilerMask > compilerMount, "an explicitly mounted inactive compiler root is masked after its bind");
    }

    assert.equal(runtimeCorpusOverlapProblem([runtimeRoot], [runtimeRoot], tasks), null, "an unrelated pinned runtime remains usable");
    assert.match(runtimeCorpusOverlapProblem([path.join(references, "solution.patch")], [store], tasks) ?? "", /overlaps protected corpus material/);
    assert.match(runtimeCorpusOverlapProblem([runtimeRoot], [store], tasks) ?? "", /overlaps protected corpus material/, "a broad allowlist root cannot contain the corpus store");
    assert.match(runtimeCorpusOverlapProblem([path.join(alias, "reference", "solution.patch")], [alias], tasks) ?? "", /overlaps protected corpus material/, "symlink aliases are resolved before comparing paths");
    assert.match(runtimeCorpusOverlapProblem([privateValidator], [privateValidator], tasks, [privateValidator]) ?? "", /overlaps protected corpus material/);
    assert.match(runtimeCorpusOverlapProblem([runtimeRoot], [runtimeRoot], tasks, [path.join(root, "missing-validator")]) ?? "", /private corpus path is unavailable/);
    assert.equal(runtimeCorpusOverlapProblem([], [], path.join(ROOT, "eval/tasks")), null, "default in-repo development eval/tasks does not collide with eval/agent_sandbox.mjs");
    assert.equal(runtimeCorpusOverlapProblem([path.join(ROOT, "cli/dist")], [path.join(ROOT, "cli"), path.join(ROOT, "core")], path.join(ROOT, "eval/tasks")), null, "default development Nexus runtime roots do not overlap eval/tasks");
    assert.match(runtimeCorpusOverlapProblem([], [], path.join(ROOT, "eval/tasks"), [], { qualification: true }) ?? "", /overlaps protected corpus material/, "qualification mode still rejects using in-repo eval/tasks because its parent overlaps eval/agent_sandbox.mjs");

    const unconditionalMountPaths = [
      ...hostMounts.systemDirectories.map((source) => path.join(source, "synthetic-corpus-subdir")),
      ...hostMounts.systemFiles,
      ...hostMounts.systemEtcDirectories.map((source) => path.join(source, "synthetic-corpus-subdir")),
      ...hostMounts.toolchainDirectories.map((source) => path.join(source, "synthetic-corpus-subdir")),
    ];
    const runtimeMountPaths = [
      path.join(runtimeRoot, "corpus-leak"),
      path.join(home, "corpus-leak"),
      path.join(proxyDirectory, "corpus-leak"),
      process.execPath,
      supervisorPath,
      readOnlyRuntime,
    ];
    for (const protectedPath of [...unconditionalMountPaths, ...runtimeMountPaths]) {
      assert.match(
        runtimeCorpusOverlapProblem([], [], tasks, [protectedPath], mountContext) ?? "",
        /overlaps protected corpus material/,
        `runtime preflight rejects mounted corpus path ${protectedPath}`,
      );
      assert.match(
        hiddenTestIsolationProblem({ qualification: true, sandboxRuntimePaths: [], sandboxRuntimeRoots: [], corpusCustody: { storeRoot: protectedPath }, mountContext }, tasks) ?? "",
        /overlaps protected corpus material/,
        `hidden-test qualification preflight rejects mounted corpus path ${protectedPath}`,
      );
      assert.throws(() => agentSandboxArgv({
        cwd: runtimeRoot,
        home,
        proxyDirectory,
        readOnlyPaths: [readOnlyRuntime],
        supervisorPath,
        protectedCorpusPaths: [protectedPath],
      }), /overlaps protected corpus material/);
      if (unconditionalMountPaths.includes(protectedPath)) {
        // This check precedes Bubblewrap availability, including on minimal CI hosts.
        assert.throws(() => isolatedArgv({ cwd: runtimeRoot, command: "true", protectedCorpusPaths: [protectedPath] }), /overlaps protected corpus material/);
      }
    }
    assert.match(
      runtimeCorpusOverlapProblem([], ["/usr/bin"], tasks, [path.join("/usr/bin", "synthetic-corpus-subdir")]) ?? "",
      /overlaps protected corpus material/,
      "a runtime allowlist root below an unconditional system mount is rejected",
    );
    assert.match(
      runtimeCorpusOverlapProblem([readOnlyRuntime], [], tasks, [readOnlyRuntime], mountContext) ?? "",
      /overlaps protected corpus material/,
      "an explicit read-only runtime source is checked against the corpus",
    );
    assert.match(
      hiddenTestIsolationProblem({ qualification: true, sandboxRuntimePaths: [readOnlyRuntime], sandboxRuntimeRoots: [], corpusCustody: { storeRoot: readOnlyRuntime }, mountContext }, tasks) ?? "",
      /overlaps protected corpus material/,
      "hidden-test preflight checks explicit read-only runtime sources",
    );
    const custodyReportPath = readOnlyRuntime;
    assert.match(hiddenTestIsolationProblem({
      qualification: true,
      runAs: "nexus-eval",
      sandboxRuntimePaths: [readOnlyRuntime],
      sandboxRuntimeRoots: [runtimeRoot],
      corpusCustody: { reportPath: custodyReportPath },
      mountContext,
    }, tasks) ?? "", /overlaps protected corpus material/);
    assert.throws(() => agentSandboxArgv({
      cwd: runtimeRoot,
      home,
      proxyDirectory,
      readOnlyPaths: [readOnlyRuntime],
      supervisorPath,
      protectedCorpusPaths: [custodyReportPath],
    }), /overlaps protected corpus material/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("qualification remains fail-closed without enforced aggregate resource controls", async () => {
  const { qualificationResourceIsolationProblem } = await import(path.join(ROOT, "eval/validate.mjs"));
  const { dedicatedTmpfsMountProblem } = await import(path.join(ROOT, "eval/resources.mjs"));
  const workspaceRoot = process.env.NEXUS_EVAL_TEST_WORKSPACE_ROOT ?? "/dev/shm";
  const tmpfs = fs.statfsSync(workspaceRoot);
  const ok = { cpuPercent: 100, memoryBytes: 256 * 1024 * 1024, tasks: 64, storageBytes: tmpfs.blocks * tmpfs.bsize, workspaceRoot };
  const shared = fs.statfsSync("/dev/shm");
  assert.match(qualificationResourceIsolationProblem({ resources: { ...ok, workspaceRoot: "/dev/shm", storageBytes: shared.blocks * shared.bsize } }) ?? "", /dedicated tmpfs|exact mount point/);
  assert.match(qualificationResourceIsolationProblem(), /enforced CPU, memory, process-count, and workspace-storage limits/);
  assert.match(qualificationResourceIsolationProblem({ resources: { ...ok, workspaceRoot: ROOT } }) ?? "", /tmpfs/);
  const nested = fs.mkdtempSync(path.join(workspaceRoot, "nested-"));
  try {
    assert.match(qualificationResourceIsolationProblem({ resources: { ...ok, workspaceRoot: nested } }) ?? "", /exact mount point/);
  } finally {
    fs.rmdirSync(nested);
  }
  assert.match(qualificationResourceIsolationProblem({ resources: { ...ok, memoryBytes: 1024 } }) ?? "", /memoryBytes/);
  assert.match(qualificationResourceIsolationProblem({ resources: { ...ok, tasks: 0 } }) ?? "", /tasks/);
  assert.match(qualificationResourceIsolationProblem({ resources: { ...ok, cpuPercent: 1.5 } }) ?? "", /cpuPercent/);
  assert.match(qualificationResourceIsolationProblem({ resources: { ...ok, memoryBytes: 256 * 1024 * 1024 + 1 } }) ?? "", /multiple of 4096/);
  assert.match(qualificationResourceIsolationProblem({ resources: { ...ok, storageBytes: ok.storageBytes - 4096 } }) ?? "", /tmpfs with size<=storageBytes|owner-accessible/);
  assert.match(qualificationResourceIsolationProblem({ resources: { ...ok, storageBytes: undefined } }) ?? "", /storageBytes/);
  const isolation = qualificationResourceIsolationProblem({ resources: ok });
  if (process.env.NEXUS_EVAL_TEST_WORKSPACE_ROOT) assert.equal(isolation, null, "the dedicated test tmpfs and kernel resource contract must pass preflight");
  else assert.match(isolation ?? "", /dedicated tmpfs|exact mount point/, "a shared /dev/shm must fail qualification preflight");
  if (process.env.NEXUS_EVAL_TEST_WORKSPACE_ROOT) {
    // CI mounts the capped workspace as 0711 (owner rwx, other --x). Mode probes must restore
    // that contract so later runAs / version-probe suites can still traverse as the evaluator.
    const restoreMode = 0o711;
    fs.chmodSync(workspaceRoot, 0o755);
    try {
      assert.match(qualificationResourceIsolationProblem({ resources: ok }) ?? "", /non-readable\/non-writable by group or other/);
    } finally {
      fs.chmodSync(workspaceRoot, restoreMode);
    }
    assert.equal(qualificationResourceIsolationProblem({ resources: ok }), null, "restored dedicated mount root must pass preflight");
    fs.chmodSync(workspaceRoot, 0o731);
    try {
      assert.match(qualificationResourceIsolationProblem({ resources: ok }) ?? "", /non-readable\/non-writable by group or other/);
    } finally {
      fs.chmodSync(workspaceRoot, restoreMode);
    }
    fs.chmodSync(workspaceRoot, 0o711);
    try {
      assert.equal(qualificationResourceIsolationProblem({ resources: ok }), null, "execute-only traversal for the isolated evaluator account is compatible with the private root");
    } finally {
      fs.chmodSync(workspaceRoot, restoreMode);
    }
  }
  const syntheticRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-mount-mode-"));
  try {
    fs.chmodSync(syntheticRoot, 0o711);
    const syntheticMount = `101 1 0:88 / ${syntheticRoot} rw,relatime - tmpfs tmpfs rw,size=131072k,mode=711,uid=${process.getuid()}`;
    assert.match(dedicatedTmpfsMountProblem(syntheticRoot, `${syntheticMount}\n${syntheticMount.replace("101 ", "102 ")}`) ?? "", /stacked or duplicate/);
    assert.equal(dedicatedTmpfsMountProblem(syntheticRoot, syntheticMount), null, "execute-only traversal is permitted for the isolated evaluator account");
    assert.match(dedicatedTmpfsMountProblem(syntheticRoot, syntheticMount.replace("mode=711", "mode=755")) ?? "", /non-readable\/non-writable by group or other/);
    assert.match(dedicatedTmpfsMountProblem(syntheticRoot, syntheticMount.replace("mode=711", "mode=721")) ?? "", /non-readable\/non-writable by group or other/);
  } finally {
    fs.chmodSync(syntheticRoot, 0o700);
    fs.rmdirSync(syntheticRoot);
  }
});

test("resource contract: candidate memory, processes, storage and CPU are kernel-bounded and every process is reaped", async () => {
  const { runIsolated, sandboxAvailable } = await import(path.join(ROOT, "eval/isolate.mjs"));
  const { spawnContained } = await import(path.join(ROOT, "eval/resources.mjs"));
  assert.equal(sandboxAvailable(), true, "this security test requires the real Bubblewrap executable");
  const memoryBytes = 256 * 1024 * 1024;
  const workspaceRoot = process.env.NEXUS_EVAL_TEST_WORKSPACE_ROOT ?? "/dev/shm";
  const tmpfs = fs.statfsSync(workspaceRoot);
  const resources = { cpuPercent: 20, memoryBytes, tasks: 16, storageBytes: tmpfs.blocks * tmpfs.bsize, workspaceRoot };
  const ws = fs.mkdtempSync(path.join(resources.workspaceRoot, "eval-resources-"));
  const run = (command: string, timeoutSec = 30) => runIsolated(command, { cwd: ws, home: true, timeoutSec, resources });
  try {
    // Actually allocate task-charged tmpfs pages. Streaming zeros to the captured pipe only tests output limits.
    const memory = await run("dd if=/dev/zero of=/tmp/memory-fill bs=1M count=512 status=none");
    assert.notEqual(memory.status, 0);
    assert.ok(memory.resources.oomKills >= 1, JSON.stringify(memory.resources));
    assert.equal(memory.resources.limits["memory.oom.group"], "1");
    assert.equal(memory.resources.limits["memory.max"], String(memoryBytes));
    assert.equal(memory.resources.limits["memory.swap.max"], "0");
    assert.equal(memory.containmentProblem, null);

    const forks = await run("for i in $(seq 64); do sleep 30 & done; wait", 10);
    assert.ok(forks.resources.pidsMaxEvents >= 1, JSON.stringify(forks.resources));
    assert.ok(forks.resources.pidsPeak <= 16);
    assert.equal(forks.resources.cleaned, true);

    // A dedicated mount smaller than memory caps storage with ENOSPC; a larger host mount reaches memory.max first.
    // Sandbox /tmp is separately charged to the task cgroup and must hit memory.max. Neither path may leave a process.
    if (process.env.NEXUS_EVAL_TEST_WORKSPACE_ROOT) {
      assert.ok(resources.storageBytes < memoryBytes, "the CI workspace fixture must exercise its storage cap before memory exhaustion");
    }
    const workspaceDisk = await run("dd if=/dev/zero of=/workspace/fill bs=1M count=512 status=none");
    assert.notEqual(workspaceDisk.status, 0, JSON.stringify(workspaceDisk));
    if (resources.storageBytes < memoryBytes) assert.equal(workspaceDisk.resources.oomKills, 0, JSON.stringify(workspaceDisk.resources));
    else assert.ok(workspaceDisk.resources.oomKills >= 1, JSON.stringify(workspaceDisk.resources));
    assert.equal(workspaceDisk.resources.cleaned, true);
    assert.ok((fs.existsSync(path.join(ws, "fill")) ? fs.statSync(path.join(ws, "fill")).size : 0) <= resources.storageBytes);

    const sandboxDisk = await run("dd if=/dev/zero of=/tmp/fill bs=1M count=512 status=none");
    assert.notEqual(sandboxDisk.status, 0, JSON.stringify(sandboxDisk));
    assert.ok(sandboxDisk.resources.oomKills >= 1, JSON.stringify(sandboxDisk.resources));
    assert.equal(sandboxDisk.resources.cleaned, true);

    const cpu = await run("timeout 2 sh -c 'while :; do :; done' & timeout 2 sh -c 'while :; do :; done' & wait");
    assert.equal(cpu.resources.limits["cpu.max"], "20000 100000");
    assert.ok(cpu.resources.cpuUsageUsec < 1_000_000, `two busy loops for 2 s at 20% used ${cpu.resources.cpuUsageUsec} us`);
    assert.ok(cpu.resources.cpuThrottledUsec > 0);

    // The wall-clock kill goes through the cgroup, so the supervisor still proves cleanup.
    const slow = await run("sleep 60", 1);
    assert.equal(slow.timedOut, true);
    assert.equal(slow.resources.cleaned, true);
    assert.equal(slow.containmentProblem, null);

    // A stop requested at once (before the payload can have joined its leaf) still ends the payload.
    const early = await new Promise<any>((resolve) => {
      const started = Date.now();
      const { child, containment } = spawnContained({ cmd: "/bin/sleep", argv: ["60"] }, resources, { cwd: "/", stdio: ["ignore", "ignore", "ignore"], detached: true });
      containment!.kill();
      child.on("close", async () => resolve({ ms: Date.now() - started, final: await containment!.final }));
    });
    assert.ok(early.ms < 15_000, `early stop took ${early.ms} ms`);
    assert.notEqual(early.final?.exitCode, 0);

    // A process that leaves the session and process group is still found in, and removed from, the cgroup.
    const readyMarker = path.join(ws, "escaped-process-ready");
    const escapedMarker = path.join(ws, "escaped-process-survived");
    const escaped = await new Promise<any>((resolve) => {
      const { child, containment } = spawnContained({ cmd: "/bin/sh", argv: ["-c", `setsid sh -c 'touch ${readyMarker}; sleep 2; touch ${escapedMarker}' </dev/null >/dev/null 2>&1 & while [ ! -e '${readyMarker}' ]; do sleep 0.01; done`] }, resources, { cwd: "/", stdio: ["ignore", "ignore", "ignore"], detached: true });
      child.on("close", async () => resolve(await containment!.final));
    });
    assert.ok(escaped.survivorsAfterExit >= 1, JSON.stringify(escaped));
    assert.equal(escaped.cleaned, true);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.equal(fs.existsSync(escapedMarker), false, "a session-escaped task process survived cgroup cleanup");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("resource supervisor preserves SIGTERM grace for descendants after the main payload exits", { timeout: 30_000 }, async () => {
  const { spawnContained } = await import(path.join(ROOT, "eval/resources.mjs"));
  const workspaceRoot = process.env.NEXUS_EVAL_TEST_WORKSPACE_ROOT ?? "/dev/shm";
  const tmpfs = fs.statfsSync(workspaceRoot);
  const resources = { cpuPercent: 20, memoryBytes: 256 * 1024 * 1024, tasks: 16, storageBytes: tmpfs.blocks * tmpfs.bsize, workspaceRoot };
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sigterm-resource-test-"));
  const readyMarker = path.join(markerDir, "payload-ready");
  const signalMarker = path.join(markerDir, "flushed-state");
  try {
    const result = await new Promise<any>((resolve, reject) => {
      // Marker paths arrive as argv, never interpolated into the executed source: the paths derive from the
      // environment's temporary directory, and building code from them is both unnecessary and unsafe.
      const childScript = `const fs=require('node:fs');const [signal,ready]=process.argv.slice(1);process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(signal,'flushed');process.exit(143)},400));fs.writeFileSync(ready,'ready');setInterval(()=>{},1000)`;
      const parentScript = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)},process.argv[1],process.argv[2]],{stdio:'ignore'});setInterval(()=>{},1000)`;
      const { child, containment } = spawnContained({ cmd: process.execPath, argv: ["-e", parentScript, signalMarker, readyMarker] }, resources, { cwd: "/", stdio: ["ignore", "ignore", "ignore"], detached: true });
      const timeout = setTimeout(() => { containment!.kill(); reject(new Error("graceful SIGTERM fixture did not exit")); }, 15_000);
      child.on("error", (error) => { clearTimeout(timeout); reject(error); });
      child.on("close", async () => { clearTimeout(timeout); resolve(await containment!.final); });
      const sendAfterReady = async () => {
        const deadline = Date.now() + 10_000;
        while (!fs.existsSync(readyMarker) && Date.now() < deadline) await new Promise((wait) => setTimeout(wait, 20));
        if (!fs.existsSync(readyMarker)) return reject(new Error("contained payload did not report ready"));
        if (!containment!.signal("SIGTERM", 2000)) reject(new Error("supervisor control channel rejected SIGTERM"));
      };
      void sendAfterReady().catch(reject);
    });
    assert.equal(fs.readFileSync(signalMarker, "utf8"), "flushed", "the payload did not receive SIGTERM before forced cleanup");
    assert.equal(result.cleaned, true, JSON.stringify(result));
    assert.deepEqual(result.signals.map((entry: any) => [entry.name, entry.forced]), [["SIGTERM", false]]);
  } finally {
    fs.rmSync(markerDir, { recursive: true, force: true });
  }
});

test("candidate sandbox and resource supervisor compose around a staged repository", { timeout: 30_000 }, async () => {
  const { stageRepoWorkspace } = await import(path.join(ROOT, "eval/workspace.mjs"));
  const { agentSandboxArgv } = await import(path.join(ROOT, "eval/isolate.mjs"));
  const { resourceConfigProblem, spawnContained } = await import(path.join(ROOT, "eval/resources.mjs"));
  assert.equal((await import(path.join(ROOT, "eval/isolate.mjs"))).sandboxAvailable(), true, "this security test requires the real Bubblewrap executable");

  let base: string | null = null;
  let workspace: string | null = null;
  let contained: ReturnType<typeof spawnContained> | null = null;
  let childClosed: Promise<void> | null = null;
  let candidateProcessClosed = false;
  let shutdownComplete = false;
  let executionStarted = false;
  let candidateSpawnError: Error | undefined;
  let timedOut = false;
  try {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "eval-contained-candidate-"));
    const profile = JSON.parse(fs.readFileSync(path.join(ROOT, "eval/host/resource-profile.json"), "utf8"));
    const workspaceRoot = process.env.NEXUS_EVAL_TEST_WORKSPACE_ROOT ?? profile.workspaceRoot;
    const resources = {
      cpuPercent: profile.cpuPercent,
      memoryBytes: profile.memoryBytes,
      tasks: profile.tasks,
      storageBytes: profile.storageBytes,
      workspaceRoot,
    };
    assert.equal(resourceConfigProblem(resources), null, "the test requires the configured dedicated tmpfs resource boundary");
    workspace = fs.mkdtempSync(path.join(workspaceRoot, "eval-contained-candidate-ws-"));
    const fixtureBase = base;
    const fixtureWorkspace = workspace;
    const env = { PATH: "/usr/bin:/bin", HOME: fixtureBase, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
    const git = (cwd: string, ...argv: string[]) => {
      const result = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "init.defaultBranch=main", ...argv], { cwd, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const upstream = path.join(fixtureBase, "upstream");
    fs.mkdirSync(upstream);
    git(upstream, "init", "-q");
    fs.writeFileSync(path.join(upstream, "input.txt"), "baseline-input\n");
    git(upstream, "add", "-A");
    git(upstream, "commit", "-qm", "baseline");
    const baseline = git(upstream, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(upstream, "input.txt"), "SYNTHETIC_FUTURE_SOLUTION_CANARY_71ad\n");
    git(upstream, "commit", "-qam", "synthetic future solution");
    const future = git(upstream, "rev-parse", "HEAD");
    const cache = path.join(fixtureBase, "cache");
    git(fixtureBase, "clone", "-q", "--no-checkout", upstream, cache);

    const staged = path.join(fixtureWorkspace, "repo");
    stageRepoWorkspace(cache, baseline, staged);
    const candidateHome = path.join(fixtureWorkspace, "home");
    const proxyDirectory = path.join(fixtureWorkspace, "proxy");
    fs.mkdirSync(candidateHome);
    fs.mkdirSync(proxyDirectory);
    const externalCanary = path.join(fixtureBase, "synthetic-private-validator.txt");
    fs.writeFileSync(externalCanary, "SYNTHETIC_EXTERNAL_VALIDATOR_CANARY_9c32");
    const readyMarker = path.join(staged, "descendant-ready");
    const lateMarker = path.join(staged, "descendant-survived");
    const nodeRuntime = process.execPath;
    const sandbox = agentSandboxArgv({
      cwd: staged,
      home: candidateHome,
      proxyDirectory,
      readOnlyPaths: [nodeRuntime],
      runtimeExecutablePaths: [nodeRuntime],
      supervisorPath: path.join(ROOT, "eval/agent_sandbox.mjs"),
    });

    // This descendant deliberately outlives the candidate command. The resource supervisor must reap it after the
    // production candidate sandbox exits, while the candidate only receives the staged baseline and no host canary.
    const candidate = `const fs=require('node:fs'),cp=require('node:child_process');const git=(args)=>cp.spawnSync('git',args,{cwd:'/workspace',encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:'/home/eval',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});const baseline=git(['rev-parse','HEAD']),future=git(['cat-file','-p',process.argv[1]]),source=fs.readFileSync('/workspace/input.txt','utf8');let externalReadable=false;try{fs.readFileSync(process.argv[2],'utf8');externalReadable=true}catch{};const child=cp.spawn(process.execPath,['-e',\`const fs=require('node:fs');fs.writeFileSync(process.argv[1],'ready');setTimeout(()=>fs.writeFileSync(process.argv[2],'survived'),2500)\`,process.argv[3],process.argv[4]],{detached:true,stdio:'ignore'});child.unref();const deadline=Date.now()+5000;while(!fs.existsSync(process.argv[3])&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);console.log(JSON.stringify({head:baseline.stdout.trim(),headStatus:baseline.status,source,futureStatus:future.status,externalReadable,ready:fs.existsSync(process.argv[3])}))`;
    const execution = spawnContained(sandbox, resources, { cwd: "/", env: {}, stdio: ["pipe", "pipe", "pipe"], detached: true });
    contained = execution;
    executionStarted = true;
    let stdout = "";
    let stderr = "";
    execution.child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    execution.child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    childClosed = new Promise<void>((resolve) => {
      execution.child.once("error", (error) => { candidateSpawnError = error; });
      execution.child.once("close", () => { candidateProcessClosed = true; resolve(); });
    });
    execution.child.stdin.end(JSON.stringify({ command: nodeRuntime, argv: ["-e", candidate, `${future}^{commit}`, externalCanary, "/workspace/descendant-ready", "/workspace/descendant-survived"], env: { PATH: "/usr/bin:/bin" } }));
    let timeout: NodeJS.Timeout;
    await Promise.race([
      childClosed,
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => { timedOut = true; execution.containment?.kill(); resolve(); }, 20_000);
      }),
    ]);
    clearTimeout(timeout!);
    if (timedOut) {
      await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 15_000))]);
    }
    assert.equal(candidateProcessClosed, true, "contained candidate did not shut down after timeout/kill");
    assert.equal(candidateSpawnError, undefined, candidateSpawnError?.message);
    const final = await execution.containment!.final;
    shutdownComplete = final?.cleaned === true;
    assert.ok(final, `resource supervisor did not report: ${stderr}`);
    assert.equal(timedOut, false, "contained candidate timed out");
    assert.equal(final.error, undefined, JSON.stringify(final));
    assert.equal(final.exitCode, 0, `${stderr}\n${stdout}\n${JSON.stringify(final)}`);
    assert.equal(final.limits["cpu.max"], `${resources.cpuPercent * 1000} 100000`);
    assert.equal(final.limits["memory.max"], String(resources.memoryBytes));
    assert.equal(final.limits["memory.swap.max"], "0");
    assert.equal(final.limits["pids.max"], String(resources.tasks));
    assert.equal(final.cleaned, true, JSON.stringify(final));

    const observed = JSON.parse(stdout.trim());
    assert.equal(observed.headStatus, 0);
    assert.equal(observed.head, baseline, "candidate did not run in the staged baseline workspace");
    assert.equal(observed.source, "baseline-input\n", "candidate did not receive the approved task input");
    assert.notEqual(observed.futureStatus, 0, "candidate retrieved the synthetic future solution object");
    assert.equal(observed.externalReadable, false, "candidate read a synthetic external validator canary");
    assert.equal(observed.ready, true, "the process-cleanup descendant did not start before candidate exit");
    assert.doesNotMatch(`${stdout}${stderr}`, /SYNTHETIC_FUTURE_SOLUTION_CANARY_71ad|SYNTHETIC_EXTERNAL_VALIDATOR_CANARY_9c32/);
    await new Promise((resolve) => setTimeout(resolve, 2800));
    assert.equal(fs.existsSync(lateMarker), false, "a candidate descendant survived resource-supervisor cleanup");
  } finally {
    if (contained && executionStarted && !shutdownComplete) {
      contained.containment?.kill();
      if (childClosed && !candidateProcessClosed) {
        await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 15_000))]);
      }
      if (candidateProcessClosed) {
        const final = await contained.containment?.final;
        shutdownComplete = final?.cleaned === true;
      }
    }
    // Never remove mounted candidate paths until the resource supervisor confirms that its cgroup was emptied.
    if (!executionStarted || shutdownComplete) {
      if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
      if (base) fs.rmSync(base, { recursive: true, force: true });
    } else {
      console.error(`preserving evaluator fixture paths because process cleanup was not confirmed: ${workspace ?? "workspace unavailable"}`);
    }
  }
});

test("repository workspaces carry no history beyond the pinned baseline commit", { timeout: 15_000 }, async () => {
  const { stageRepoWorkspace, workspaceHistoryProblem } = await import(path.join(ROOT, "eval/workspace.mjs"));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "eval-ws-history-"));
  const env = { PATH: "/usr/bin:/bin", HOME: base, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (cwd: string, ...argv: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...argv], { cwd, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  try {
    // Upstream: baseline, then the "reference fix" child, a tag on the child and a side branch beyond it.
    const upstream = path.join(base, "upstream");
    fs.mkdirSync(upstream);
    git(upstream, "init", "-q");
    fs.writeFileSync(path.join(upstream, "lib.txt"), "buggy\n");
    git(upstream, "add", "-A");
    git(upstream, "commit", "-qm", "baseline");
    const baseline = git(upstream, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(upstream, "lib.txt"), "REFERENCE_SOLUTION_CANARY_72d9\n");
    git(upstream, "commit", "-qam", "reference fix");
    const child = git(upstream, "rev-parse", "HEAD");
    git(upstream, "tag", "v-fix");
    const danglingBlobResult = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: upstream, env, input: "DANGLING_BLOB_CANARY_999", encoding: "utf8" });
    assert.equal(danglingBlobResult.status, 0, danglingBlobResult.stderr);
    const danglingBlob = danglingBlobResult.stdout.trim();
    const baselineTree = git(upstream, "rev-parse", `${baseline}^{tree}`);
    const danglingCommitEnv = { ...env, GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" };
    const danglingCommitResult = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit-tree", baselineTree, "-p", baseline, "-m", "DANGLING_COMMIT_CANARY_999"], { cwd: upstream, env: danglingCommitEnv, encoding: "utf8" });
    assert.equal(danglingCommitResult.status, 0, danglingCommitResult.stderr);
    const danglingCommit = danglingCommitResult.stdout.trim();
    git(upstream, "update-ref", "--create-reflog", "HEAD", danglingCommit);
    git(upstream, "update-ref", "HEAD", child);
    const danglingReflog = fs.readFileSync(path.join(upstream, ".git/logs/HEAD"), "utf8");
    assert.match(danglingReflog, new RegExp(danglingCommit), "the upstream fixture has a HEAD reflog pointing at the dangling commit");
    git(upstream, "checkout", "-qb", "later");
    fs.writeFileSync(path.join(upstream, "later.txt"), "later\n");
    git(upstream, "add", "-A");
    git(upstream, "commit", "-qm", "later work");
    const cache = path.join(base, "cache");
    git(base, "clone", "-q", "--no-checkout", upstream, cache);
    const cacheBlobResult = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: cache, env, input: "DANGLING_BLOB_CANARY_999", encoding: "utf8" });
    assert.equal(cacheBlobResult.status, 0, cacheBlobResult.stderr);
    assert.equal(cacheBlobResult.stdout.trim(), danglingBlob, "the cache contains the dangling blob object");
    const cacheCommitResult = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit-tree", baselineTree, "-p", baseline, "-m", "DANGLING_COMMIT_CANARY_999"], { cwd: cache, env: danglingCommitEnv, encoding: "utf8" });
    assert.equal(cacheCommitResult.status, 0, cacheCommitResult.stderr);
    assert.equal(cacheCommitResult.stdout.trim(), danglingCommit, "the cache contains the dangling commit object");
    const cacheHead = git(cache, "rev-parse", "HEAD");
    git(cache, "update-ref", "--create-reflog", "HEAD", danglingCommit);
    git(cache, "update-ref", "HEAD", cacheHead);
    assert.match(fs.readFileSync(path.join(cache, ".git/logs/HEAD"), "utf8"), new RegExp(danglingCommit), "the cache HEAD reflog points at the dangling commit");

    // Control: the former `clone --shared` + checkout layout exposes the child and is detected.
    const leaky = path.join(base, "leaky");
    git(base, "clone", "-q", "--shared", cache, leaky);
    git(leaky, "checkout", "-q", baseline);
    assert.match(workspaceHistoryProblem(leaky, baseline) ?? "", /alternates/);
    assert.equal(spawnSync("git", ["cat-file", "-e", `${child}^{commit}`], { cwd: leaky, env }).status, 0, "control must expose the child");
    // A full (non-shared) clone has no alternates but still exposes the child; detection must not rely on alternates.
    const copied = path.join(base, "copied");
    git(base, "clone", "-q", "--no-local", cache, copied);
    git(copied, "checkout", "-q", baseline);
    git(copied, "remote", "remove", "origin");
    assert.equal(spawnSync("git", ["cat-file", "-e", `${child}^{commit}`], { cwd: copied, env }).status, 0, "control must expose the child");
    assert.match(workspaceHistoryProblem(copied, baseline) ?? "", /not ancestors/);

    const ws = path.join(base, "ws");
    stageRepoWorkspace(cache, baseline, ws);
    assert.equal(workspaceHistoryProblem(ws, baseline), null);
    assert.equal(git(ws, "rev-parse", "HEAD"), baseline);
    assert.equal(fs.readFileSync(path.join(ws, "lib.txt"), "utf8"), "buggy\n");
    // (a) nothing reachable that is not an ancestor of the baseline
    assert.equal(git(ws, "rev-list", "--all", "--reflog", `^${baseline}`), "");
    // (b) no alternates link to the cache
    assert.equal(fs.existsSync(path.join(ws, ".git/objects/info/alternates")), false);
    // (c) the reference-fix commit object is absent
    assert.notEqual(spawnSync("git", ["cat-file", "-e", `${child}^{commit}`], { cwd: ws, env }).status, 0);
    // (d) no remotes, tags or FETCH_HEAD naming the cache
    assert.equal(git(ws, "remote"), "");
    assert.equal(git(ws, "tag", "--list"), "");
    assert.equal(fs.existsSync(path.join(ws, ".git/FETCH_HEAD")), false);
    const allObjects = spawnSync("git", ["cat-file", "--batch-check=%(objectname)", "--batch-all-objects"], { cwd: ws, env, encoding: "utf8" });
    assert.equal(allObjects.status, 0, allObjects.stderr);
    assert.doesNotMatch(allObjects.stdout, new RegExp(danglingBlob));
    assert.doesNotMatch(allObjects.stdout, new RegExp(danglingCommit));
    assert.notEqual(spawnSync("git", ["cat-file", "-p", danglingBlob], { cwd: ws, env, encoding: "utf8" }).status, 0);
    assert.notEqual(spawnSync("git", ["cat-file", "-p", danglingCommit], { cwd: ws, env, encoding: "utf8" }).status, 0);
    const planted = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: ws, env, input: "PLANTED_DANGLING_CANARY", encoding: "utf8" });
    assert.equal(planted.status, 0, planted.stderr);
    assert.match(workspaceHistoryProblem(ws, baseline) ?? "", /unreachable object/);
    fs.rmSync(path.join(ws, ".git", "objects", planted.stdout.trim().slice(0, 2), planted.stdout.trim().slice(2)));
    assert.throws(() => stageRepoWorkspace(cache, "main", path.join(base, "ws-ref")), /full pinned commit/);

    // Exercise the production workspace stager and candidate sandbox together. The future solution remains in the
    // trusted cache and a second synthetic canary stands in for external custody material; task code sees neither.
    const privateStore = path.join(base, "private-store");
    fs.mkdirSync(privateStore);
    const externalCanary = path.join(privateStore, "validator.txt");
    fs.writeFileSync(externalCanary, "EXTERNAL_VALIDATOR_CANARY_0e42");
    const { agentSandboxArgv } = await import(path.join(ROOT, "eval/isolate.mjs"));
    const home = path.join(base, "candidate-home");
    const proxyDirectory = path.join(base, "proxy");
    fs.mkdirSync(home);
    fs.mkdirSync(proxyDirectory);
    const nodeRuntime = process.execPath;
    const sandbox = agentSandboxArgv({
      cwd: ws,
      home,
      proxyDirectory,
      readOnlyPaths: [nodeRuntime],
      runtimeExecutablePaths: [nodeRuntime],
      supervisorPath: path.join(ROOT, "eval/agent_sandbox.mjs"),
    });
    const candidateProbe = `const fs=require('node:fs'),cp=require('node:child_process');const run=(args)=>cp.spawnSync('git',args,{cwd:'/workspace',encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:'/home/eval',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});const head=run(['rev-parse','HEAD']),[baselineRef,childRef,...externalPaths]=process.argv.slice(1),baselineObject=run(['cat-file','-e',baselineRef]),object=run(['cat-file','-e',childRef]),source=fs.readFileSync('/workspace/lib.txt','utf8');let external='';for(const p of [...externalPaths,'/home/mike/nexus-heldout-v2']){try{const s=fs.statSync(p);external+=s.isDirectory()?'directory ':fs.readFileSync(p,'utf8')}catch{external+='unavailable '}};const refs=run(['rev-list','--all','--reflog','--objects']);console.log(JSON.stringify({head:head.stdout.trim(),headStatus:head.status,baselineObjectStatus:baselineObject.status,objectStatus:object.status,objectOutput:object.stdout+object.stderr,source,external,refs:refs.stdout+refs.stderr,workspace:fs.realpathSync('/workspace')}))`;
    const task = await runSandbox(sandbox.cmd, sandbox.argv, JSON.stringify({ command: nodeRuntime, argv: ["-e", candidateProbe, `${baseline}^{commit}`, `${child}^{commit}`, externalCanary, path.join(cache, ".git/objects")], env: { PATH: "/usr/bin:/bin" } }));
    assert.equal(task.status, 0, `${task.error ?? ""}\n${task.stderr}\n${task.stdout}`);
    const observed = JSON.parse(task.stdout.trim());
    assert.equal(observed.headStatus, 0);
    assert.equal(observed.head, baseline, "candidate did not see the pinned baseline repository");
    assert.equal(observed.baselineObjectStatus, 0, "candidate could not read the pinned baseline object");
    assert.equal(observed.source, "buggy\n", "candidate did not see the baseline task input");
    assert.notEqual(observed.objectStatus, 0, "candidate could retrieve the future reference-solution object");
    assert.match(observed.objectOutput, /not a valid object name|could not get object info|bad object/i, "future-object lookup failed for a reason other than absence");
    assert.equal(observed.external, "unavailable unavailable unavailable ", "candidate could access an external cache, validator, or custodian path");
    assert.doesNotMatch(observed.refs, new RegExp(child));
    assert.doesNotMatch(`${task.stdout}${task.stderr}`, /REFERENCE_SOLUTION_CANARY_72d9|EXTERNAL_VALIDATOR_CANARY_0e42/);
    const objectProbe = `const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path');const run=(args)=>cp.spawnSync('git',args,{cwd:'/workspace',encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:'/home/eval',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});let disk='';const walk=(d)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else try{disk+=fs.readFileSync(p).toString('utf8')}catch{}}};walk('/workspace/.git');console.log(JSON.stringify({fsck:run(['fsck','--unreachable']),all:run(['cat-file','--batch-check=%(objectname)','--batch-all-objects']),blob:run(['cat-file','-p',process.argv[1]]),commit:run(['cat-file','-p',process.argv[2]]),disk}))`;
    const objectTask = await runSandbox(sandbox.cmd, sandbox.argv, JSON.stringify({ command: nodeRuntime, argv: ["-e", objectProbe, danglingBlob, danglingCommit], env: { PATH: "/usr/bin:/bin" } }));
    assert.equal(objectTask.status, 0, `${objectTask.error ?? ""}\n${objectTask.stderr}`);
    const objectObserved = JSON.parse(objectTask.stdout.trim());
    assert.equal(objectObserved.fsck.status, 0);
    assert.doesNotMatch(objectObserved.fsck.stdout, /unreachable/);
    assert.doesNotMatch(objectObserved.all.stdout, new RegExp(`${danglingBlob}|${danglingCommit}`));
    assert.notEqual(objectObserved.blob.status, 0);
    assert.notEqual(objectObserved.commit.status, 0);
    assert.doesNotMatch(`${objectObserved.disk}${objectObserved.fsck.stderr}${objectObserved.blob.stderr}${objectObserved.commit.stderr}`, /DANGLING_(?:BLOB|COMMIT)_CANARY_999/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("task paths reject traversal, symlink escapes, and unstable task trees", async () => {
  const { taskTreeDigest } = await import(path.join(ROOT, "eval/validate.mjs"));
  const { confinedPath, runtimeMountProblem } = await import(path.join(ROOT, "eval/isolate.mjs"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-path-root-"));
  let outside: string | undefined;
  let allowedRoot: string | undefined;
  let otherRuntimeRoot: string | undefined;
  try {
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "eval-path-outside-"));
    // Runtime allowlist roots must be outside protected roots such as /tmp.
    // The checkout may itself live under /tmp in CI, so use private temporary
    // roots under a safe home directory for these path-policy assertions.
    const runtimeTestBase = os.userInfo().homedir === "/root" ? "/home" : os.userInfo().homedir;
    allowedRoot = fs.mkdtempSync(path.join(runtimeTestBase, "nexus-eval-allowlist-"));
    otherRuntimeRoot = fs.mkdtempSync(path.join(runtimeTestBase, "nexus-eval-outside-allowlist-"));
    fs.chmodSync(allowedRoot, 0o700);
    fs.chmodSync(otherRuntimeRoot, 0o700);
    fs.mkdirSync(path.join(root, "fixture"));
    fs.writeFileSync(path.join(outside, "canary"), "protected");
    fs.writeFileSync(path.join(otherRuntimeRoot, "package.json"), "{}");
    fs.symlinkSync(outside, path.join(root, "escape"));
    assert.throws(() => confinedPath(root, "../outside"), /unsafe task path/);
    assert.throws(() => confinedPath(root, "escape/canary"), /symlink/);
    assert.throws(() => taskTreeDigest(root), /symlink/);
    assert.match(runtimeMountProblem(["/dev/null"], [allowedRoot]) ?? "", /protected candidate runtime path/);
    assert.match(runtimeMountProblem([path.join(otherRuntimeRoot, "package.json")], [allowedRoot]) ?? "", /outside its explicit allowlist/);
    assert.match(runtimeMountProblem([], [path.join(os.homedir(), ".cache")]) ?? "", /sensitive candidate runtime root/);
    assert.equal(fs.readFileSync(path.join(outside, "canary"), "utf8"), "protected");
  } finally {
    for (const directory of [root, outside, allowedRoot, otherRuntimeRoot]) {
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("task-tree digests frame paths, entry types, executable mode, and content lengths", async () => {
  const { taskTreeDigest } = await import(path.join(ROOT, "eval/validate.mjs"));
  const left = fs.mkdtempSync(path.join(os.tmpdir(), "eval-digest-left-"));
  const right = fs.mkdtempSync(path.join(os.tmpdir(), "eval-digest-right-"));
  fs.writeFileSync(path.join(left, "one"), "xtwo\0y");
  fs.writeFileSync(path.join(right, "one"), "x");
  fs.writeFileSync(path.join(right, "two"), "y");
  assert.notEqual(taskTreeDigest(left), taskTreeDigest(right), "ambiguous path/content concatenation must not collide");

  const file = path.join(left, "one");
  const original = taskTreeDigest(left);
  fs.chmodSync(file, 0o755);
  assert.notEqual(taskTreeDigest(left), original, "executable mode affects task identity");
  const beforeEmptyDirectory = taskTreeDigest(left);
  fs.mkdirSync(path.join(left, "empty-dir"));
  assert.notEqual(taskTreeDigest(left), beforeEmptyDirectory, "empty directories are represented in the digest");
});

test("task setup and validators run with cleared env, no network, confined filesystem, bounded output and timeout", async () => {
  const { runIsolated, sandboxAvailable } = await import(path.join(ROOT, "eval/isolate.mjs"));
  assert.equal(sandboxAvailable(), true, "this security test requires the real Bubblewrap executable");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-isolated-workspace-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "eval-isolated-outside-"));
  const canary = path.join(outside, "protected.txt");
  fs.writeFileSync(canary, "HOST_CANARY_7f4a");
  process.env.EVAL_SYNTHETIC_SECRET = "ENV_CANARY_9ac2";
  const probeScript = `const fs=require('fs'),cp=require('child_process');let read='';try{read=fs.readFileSync(${JSON.stringify(canary)},'utf8')}catch{};try{fs.writeFileSync('/tmp/host-write-canary','changed')}catch{};const nested=cp.spawnSync('/usr/bin/unshare',['-Ur','true']);console.log(JSON.stringify({secret:process.env.EVAL_SYNTHETIC_SECRET??null,read,home:process.env.HOME,host:fs.existsSync('/home/mike/.ssh'),nestedUserns:nested.status}))`;
  const hiddenProbe = await runIsolated(`node -e ${JSON.stringify(probeScript)}`, { cwd: root, home: true, timeoutSec: 5 });
  assert.equal(hiddenProbe.status, 0, hiddenProbe.stderr);
  const observed = JSON.parse(hiddenProbe.stdout.trim());
  assert.equal(observed.secret, null);
  assert.equal(observed.read, "");
  assert.equal(observed.host, false);
  assert.notEqual(observed.nestedUserns, 0, "task code could create a nested user namespace");
  assert.equal(fs.existsSync("/tmp/host-write-canary"), false);
  const networkServer = http.createServer((_req, res) => res.end("reachable"));
  await new Promise<void>((resolve) => networkServer.listen(0, "127.0.0.1", resolve));
  const port = (networkServer.address() as any).port;
  const netResult = await runIsolated(`node -e \"fetch('http://127.0.0.1:${port}').then(()=>process.exit(5)).catch(()=>process.exit(0))\"`, { cwd: root, timeoutSec: 5 });
  assert.equal(netResult.status, 0, "untrusted check could reach a host-network service");
  const noisy = await runIsolated("yes OUTPUT_CANARY", { cwd: root, timeoutSec: 5, outputLimit: 4096 });
  assert.equal(noisy.overflow, true);
  const timed = await runIsolated("sleep 30 & wait", { cwd: root, timeoutSec: 1 });
  assert.equal(timed.timedOut, true);
  const descendantMarker = path.join(root, "descendant-survived-timeout");
  const descendant = await runIsolated(`(sleep 2; touch ${JSON.stringify(descendantMarker)}) & wait`, { cwd: root, timeoutSec: 1 });
  assert.equal(descendant.timedOut, true);
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(fs.existsSync(descendantMarker), false, "a descendant survived evaluator timeout and wrote to the workspace");
  networkServer.close();
  delete process.env.EVAL_SYNTHETIC_SECRET;
});

test("candidate namespace cannot read host files or bypass pinned compilers with absolute paths", async () => {
  const { agentSandboxArgv, candidateAgentPath } = await import(path.join(ROOT, "eval/isolate.mjs"));
  const { startModelProxy } = await import(proxyModule);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "eval-agent-ws-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "eval-agent-home-"));
  const proxyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "eval-agent-proxy-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "eval-agent-outside-"));
  const canary = path.join(outside, "canary.txt");
  fs.writeFileSync(canary, "HOST_PRIVATE_CANARY");
  const seen: string[] = [];
  const upstream = http.createServer((req, res) => {
    seen.push(String(req.headers.authorization ?? ""));
    res.end(JSON.stringify({ data: [{ id: "synthetic-model" }] }));
  });
  let proxy: Awaited<ReturnType<typeof startModelProxy>> | undefined;
  try {
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    proxy = await startModelProxy({ upstream: `http://127.0.0.1:${(upstream.address() as any).port}/v1`, authToken: "UPSTREAM_AUTH_CANARY", clientToken: "RUN_LOCAL_TOKEN", socketPath: path.join(proxyDirectory, "proxy.sock") });
    const nodeRuntime = process.execPath;
    const sandbox = agentSandboxArgv({ cwd: workspace, home, proxyDirectory, readOnlyPaths: [nodeRuntime], runtimeExecutablePaths: [nodeRuntime], supervisorPath: path.join(ROOT, "eval/agent_sandbox.mjs") });
    const script = `const fs=require('fs'),cp=require('child_process');fetch('http://127.0.0.1:40127/v1/models',{headers:{authorization:'Bearer '+process.env.OPENAI_API_KEY},signal:AbortSignal.timeout(2000)}).then(async r=>{let value='';try{value=fs.readFileSync(${JSON.stringify(canary)},'utf8')}catch{};try{fs.writeFileSync('/tmp/host-write-canary','changed')}catch{};const nested=cp.spawnSync('/usr/bin/unshare',['-Ur','true']);const toolchains={};for(const [name,args] of [['go',['version']],['rustc',['--version']],['cargo',['--version']]]){if(process.env.PATH.includes(name==='go'?'/usr/local/go/bin':'/usr/local/nexus-qual/rust/bin')){const check=cp.spawnSync(name,args,{encoding:'utf8'});toolchains[name]={status:check.status,stdout:check.stdout,stderr:check.stderr}}};const absoluteToolchains={};for(const [name,command,args] of [['go','/usr/bin/go',['version']],['rustc','/usr/bin/rustc',['--version']],['cargo','/usr/bin/cargo',['--version']]]){const check=cp.spawnSync(command,args,{encoding:'utf8'});absoluteToolchains[name]={status:check.status,error:check.error?.code??null,version:check.status===0?check.stdout.trim():null}};console.log(JSON.stringify({status:r.status,token:process.env.OPENAI_API_KEY,upstreamVisible:process.env.UPSTREAM_AUTH_CANARY??null,canary:value,nestedUserns:nested.status,toolchains,absoluteToolchains}))}).catch(e=>{console.error(e.message);process.exit(1)})`;
    process.env.UPSTREAM_AUTH_CANARY = "UPSTREAM_AUTH_CANARY";
    const candidatePath = candidateAgentPath("/usr/bin:/bin");
    const child = await runSandbox(sandbox.cmd, sandbox.argv, JSON.stringify({ command: nodeRuntime, argv: ["-e", script], env: { PATH: candidatePath, OPENAI_API_KEY: "RUN_LOCAL_TOKEN" } }));
    assert.equal(child.status, 0, `${child.error ?? ""}\n${child.stderr}\n${child.stdout}\nproxy=${JSON.stringify(proxy.stats())}\nupstream=${JSON.stringify(seen)}`);
    const output = JSON.parse(child.stdout.trim());
    assert.equal(output.status, 200);
    assert.equal(output.token, "RUN_LOCAL_TOKEN");
    assert.equal(output.upstreamVisible, null);
    assert.equal(output.canary, "");
    assert.notEqual(output.nestedUserns, 0, "candidate code could create a nested user namespace");
    if (candidatePath.includes("/usr/local/go/bin")) assert.equal(output.toolchains.go?.status, 0, `Go toolchain is not executable in candidate namespace: ${JSON.stringify(output.toolchains.go)}`);
    if (candidatePath.includes("/usr/local/nexus-qual/rust/bin")) {
      assert.equal(output.toolchains.rustc?.status, 0, `Rust compiler is not executable in candidate namespace: ${JSON.stringify(output.toolchains.rustc)}`);
      assert.equal(output.toolchains.cargo?.status, 0, `Cargo is not executable in candidate namespace: ${JSON.stringify(output.toolchains.cargo)}`);
    }
    for (const [name, pinnedVersion] of [["go", "go version go1.22.12"], ["rustc", "rustc 1.95.0"], ["cargo", "cargo 1.95.0"]] as const) {
      const absolute = output.absoluteToolchains[name];
      assert.ok(absolute.error === "ENOENT" || absolute.status !== 0 || absolute.version.startsWith(pinnedVersion), `${name} via absolute /usr/bin path was not pinned: ${JSON.stringify(absolute)}`);
    }
    assert.deepEqual(seen, ["Bearer UPSTREAM_AUTH_CANARY"]);
    assert.equal(fs.existsSync("/tmp/host-write-canary"), false);
    assert.doesNotMatch(`${child.stdout}${child.stderr}`, /HOST_PRIVATE_CANARY|UPSTREAM_AUTH_CANARY/);
  } finally {
    delete process.env.UPSTREAM_AUTH_CANARY;
    if (proxy) await proxy.close();
    if (upstream.listening) await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

function runSandbox(command: string, args: string[], input: string): Promise<{ status: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: {}, detached: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, 10_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error: error.message });
    });
    child.on("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

test("qualification corpus binding rejects missing, mismatched, and post-seal task content", async () => {
  const { corpusManifestProblem, corpusTaskRows, taskTreeDigest } = await import(path.join(ROOT, "eval/validate.mjs"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-corpus-"));
  const taskDir = path.join(root, "task-a");
  fs.mkdirSync(path.join(taskDir, "repo"), { recursive: true });
  fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({ id: "task-a" }));
  fs.writeFileSync(path.join(taskDir, "repo", "source.txt"), "fixture-v1");
  const rows = corpusTaskRows(root, ["task-a"]);
  const manifest = { schemaVersion: 1, split: "heldout", custody: { status: "approved", custodian: "independent-role", approvedAt: "2026-01-01T00:00:00Z" }, tasks: rows };
  const file = path.join(root, "manifest.json");
  fs.writeFileSync(file, JSON.stringify(manifest));
  const sha = (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  assert.match(corpusManifestProblem({}, root, ["task-a"]), /requires a frozen corpusManifest/);
  assert.equal(corpusManifestProblem({ corpusManifest: file, corpusManifestSha256: sha }, root, ["task-a"], rows), null);
  fs.writeFileSync(path.join(taskDir, "repo", "source.txt"), "fixture-v2");
  assert.match(corpusManifestProblem({ corpusManifest: file, corpusManifestSha256: sha }, root, ["task-a"], rows), /source task content changed|differs from the frozen/);
  assert.notEqual(taskTreeDigest(taskDir), rows[0].treeSha256);
});

test("run.mjs refuses to start on an invalid task", () => {
  const tasks = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-bad-"));
  fs.mkdirSync(path.join(tasks, "broken"));
  fs.writeFileSync(path.join(tasks, "broken", "task.json"), JSON.stringify({ id: "broken", tier: "T9", objective: "" }));
  const config = path.join(tasks, "config.json");
  fs.writeFileSync(config, JSON.stringify({ name: "c", agent: "nexus", endpoint: "http://127.0.0.1:9/v1", model: "m", proxy: false }));
  const out = spawnSync(process.execPath, [path.join(ROOT, "eval/run.mjs"), "--config", config, "--tasks", tasks, "--out", path.join(tasks, "out")], { encoding: "utf8" });
  assert.equal(out.status, 2, out.stdout + out.stderr);
  assert.match(out.stderr, /not starting/);
  assert.match(out.stderr, /broken: tier must be one of/);
  assert.ok(!fs.existsSync(path.join(tasks, "out", "results.jsonl")), "no run was recorded");
});

// ---------------------------------------------------------------- T4 fault injection (REQ-QUAL-105)

test("the model proxy injects each scheduled fault into the chat request it names, and records it", async () => {
  const { startModelProxy, isInfrastructureFailure } = await import(proxyModule);
  const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "read_file", arguments: "" } }] } }] }) +
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] } }] }) +
      sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n",
    );
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const port = (upstream.address() as any).port;
  const kinds = ["refuse", "overloaded", "stream_cut", "truncate", "context_overflow", "malformed_tool_json"];
  const proxy = await startModelProxy({ upstream: `http://127.0.0.1:${port}/v1`, faults: kinds.map((kind, i) => ({ kind, atRequest: i + 1 })) });
  const chat = () => fetch(`${proxy.url}/chat/completions`, { method: "POST", body: "{}" });
  try {
    await assert.rejects(chat(), "refuse: the connection is dropped");
    const overloaded = await chat();
    assert.equal(overloaded.status, 503);
    assert.equal(overloaded.headers.get("retry-after"), "1");
    await overloaded.text();
    const cut = await chat().then((r) => r.text()).catch(() => "");
    assert.ok(!cut.includes("finish_reason"), "stream_cut: nothing after the first tool-call fragment arrives");
    const truncated = await (await chat()).text();
    assert.match(truncated, /"finish_reason":"length"/);
    assert.doesNotMatch(truncated, /"finish_reason":"tool_calls"/);
    const overflow = await chat();
    assert.equal(overflow.status, 400);
    assert.equal((await overflow.json()).error.type, "exceed_context_size_error");
    assert.match(await (await chat()).text(), /\\"broken/, "malformed_tool_json: the first arguments fragment is corrupted");
    assert.match(await (await chat()).text(), /"finish_reason":"tool_calls"/, "requests without a scheduled fault pass unchanged");
    const stats = proxy.stats();
    assert.deepEqual(stats.faultsInjected.map((f: any) => f.kind), kinds);
    assert.equal(isInfrastructureFailure({ model: { ...stats, answered: 0, upstreamFailures: 3 } }), false, "injected faults are never infrastructure reruns");
  } finally {
    await proxy.close();
    upstream.close();
  }
  await assert.rejects(startModelProxy({ upstream: "http://127.0.0.1:9/v1", faults: [{ kind: "nope", atRequest: 1 }] }), /invalid fault/);
});

test("executable probes refuse bind sources that overlap protected corpus material", async () => {
  const { isolatedProcessArgv } = await import(path.join(ROOT, "eval/isolate.mjs"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-probe-overlap-"));
  try {
    const store = path.join(root, "heldout-v2");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(path.join(store, "reference"), { recursive: true });
    fs.mkdirSync(workspace);
    const alias = path.join(root, "store-alias");
    fs.symlinkSync(store, alias, "dir");
    const probe = (options: Record<string, unknown>) => () => isolatedProcessArgv({ command: "/usr/bin/true", argv: ["--version"], ...options });
    assert.throws(probe({ cwd: workspace, protectedCorpusPaths: ["/usr/share/git-core/templates/nexus-heldout"] }), /overlaps protected corpus material: \/usr\/share\/git-core\/templates/, "Git template bind containing a protected path");
    assert.throws(probe({ cwd: workspace, protectedCorpusPaths: ["/usr/share/terminfo/nexus-heldout"] }), /overlaps protected corpus material: \/usr\/share\/terminfo/, "system bind containing a protected path");
    assert.doesNotThrow(probe({ cwd: workspace, protectedCorpusPaths: ["/usr/share/nexus-heldout"] }), "unmounted host application data does not overlap candidate runtime mounts");
    assert.throws(probe({ cwd: path.join(alias, "reference"), protectedCorpusPaths: [store] }), /overlaps protected corpus material/, "workspace bind through a symlink alias");
    assert.doesNotThrow(probe({ cwd: workspace, protectedCorpusPaths: [store] }), "an unrelated workspace remains usable");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
