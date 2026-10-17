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

// ---------------------------------------------------------------- run validity (REQ-QUAL-101/102/106)

test("task validation: pinned repos, one source, and black-box hidden oracle for qualification", async () => {
  const { validateTask } = await import(path.join(ROOT, "eval/validate.mjs"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t2-x-"));
  const id = path.basename(dir);
  const good = { id, tier: "T2", objective: "fix it", repo: { url: "https://example.invalid/r.git", commit: "a".repeat(40) }, hidden: { command: "npm test" } };
  fs.mkdirSync(path.join(dir, "candidate"));
  assert.deepEqual(validateTask(good, dir), []);
  assert.match(validateTask({ ...good, repo: { url: good.repo.url, commit: "main" } }, dir).join(), /pinned/);
  assert.match(validateTask({ ...good, fixture: "repo" }, dir).join(), /exactly one of fixture or repo/);
  assert.match(validateTask({ ...good, hidden: {} }, dir).join(), /hidden.command/);
  assert.match(validateTask(good, dir, { qualification: true }).join(), /blackbox-v1/);
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
  assert.match(hiddenTestIsolationProblem({ runAs: "nexus-eval" }, tasks), /evaluator account|setfacl/);
  assert.match(hiddenTestIsolationProblem({ runAs: "bad user;" }, tasks), /not a valid user name/);
  const wrapped = asUser("nexus-eval", "node", ["index.js", "run"], { HOME: "/tmp/h", PATH: "/usr/bin" });
  assert.equal(wrapped.cmd, "sudo");
  assert.deepEqual(wrapped.argv, ["-n", "-u", "nexus-eval", "--", "env", "-i", "HOME=/tmp/h", "PATH=/usr/bin", "node", "index.js", "run"]);
});

test("qualification remains fail-closed without enforced aggregate resource controls", async () => {
  const { qualificationResourceIsolationProblem } = await import(path.join(ROOT, "eval/validate.mjs"));
  assert.match(qualificationResourceIsolationProblem(), /enforced CPU, memory, process-count, and workspace-storage limits/);
});

test("task paths reject traversal, symlink escapes, and unstable task trees", async () => {
  const { taskTreeDigest } = await import(path.join(ROOT, "eval/validate.mjs"));
  const { confinedPath, runtimeMountProblem } = await import(path.join(ROOT, "eval/isolate.mjs"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-path-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "eval-path-outside-"));
  fs.mkdirSync(path.join(root, "fixture"));
  fs.writeFileSync(path.join(outside, "canary"), "protected");
  fs.symlinkSync(outside, path.join(root, "escape"));
  assert.throws(() => confinedPath(root, "../outside"), /unsafe task path/);
  assert.throws(() => confinedPath(root, "escape/canary"), /symlink/);
  assert.throws(() => taskTreeDigest(root), /symlink/);
  assert.match(runtimeMountProblem(["/dev/null"], [ROOT]) ?? "", /protected candidate runtime path/);
  assert.match(runtimeMountProblem([path.join(ROOT, "cli/package.json")], [path.join(ROOT, "eval")]) ?? "", /outside its explicit allowlist/);
  assert.match(runtimeMountProblem([], [path.join(os.homedir(), ".cache")]) ?? "", /sensitive candidate runtime root/);
  assert.equal(fs.readFileSync(path.join(outside, "canary"), "utf8"), "protected");
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

test("candidate namespace reaches only its authenticated run proxy and cannot read host files", async () => {
  const { agentSandboxArgv } = await import(path.join(ROOT, "eval/isolate.mjs"));
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
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = await startModelProxy({ upstream: `http://127.0.0.1:${(upstream.address() as any).port}/v1`, authToken: "UPSTREAM_AUTH_CANARY", clientToken: "RUN_LOCAL_TOKEN", socketPath: path.join(proxyDirectory, "proxy.sock") });
  const sandbox = agentSandboxArgv({ cwd: workspace, home, proxyDirectory, readOnlyPaths: ["/usr/bin/node"], supervisorPath: path.join(ROOT, "eval/agent_sandbox.mjs") });
  const script = `const fs=require('fs'),cp=require('child_process');fetch('http://127.0.0.1:40127/v1/models',{headers:{authorization:'Bearer '+process.env.OPENAI_API_KEY},signal:AbortSignal.timeout(2000)}).then(async r=>{let value='';try{value=fs.readFileSync(${JSON.stringify(canary)},'utf8')}catch{};try{fs.writeFileSync('/tmp/host-write-canary','changed')}catch{};const nested=cp.spawnSync('/usr/bin/unshare',['-Ur','true']);console.log(JSON.stringify({status:r.status,token:process.env.OPENAI_API_KEY,upstreamVisible:process.env.UPSTREAM_AUTH_CANARY??null,canary:value,nestedUserns:nested.status}))}).catch(e=>{console.error(e.message);process.exit(1)})`;
  process.env.UPSTREAM_AUTH_CANARY = "UPSTREAM_AUTH_CANARY";
  const child = await runSandbox(sandbox.cmd, sandbox.argv, JSON.stringify({ command: "/usr/bin/node", argv: ["-e", script], env: { PATH: "/usr/bin:/bin", OPENAI_API_KEY: "RUN_LOCAL_TOKEN" } }));
  try {
    assert.equal(child.status, 0, `${child.error ?? ""}\n${child.stderr}\n${child.stdout}\nproxy=${JSON.stringify(proxy.stats())}\nupstream=${JSON.stringify(seen)}`);
    const output = JSON.parse(child.stdout.trim());
    assert.equal(output.status, 200);
    assert.equal(output.token, "RUN_LOCAL_TOKEN");
    assert.equal(output.upstreamVisible, null);
    assert.equal(output.canary, "");
    assert.notEqual(output.nestedUserns, 0, "candidate code could create a nested user namespace");
    assert.deepEqual(seen, ["Bearer UPSTREAM_AUTH_CANARY"]);
    assert.equal(fs.existsSync("/tmp/host-write-canary"), false);
    assert.doesNotMatch(`${child.stdout}${child.stderr}`, /HOST_PRIVATE_CANARY|UPSTREAM_AUTH_CANARY/);
  } finally {
    delete process.env.UPSTREAM_AUTH_CANARY;
    await proxy.close();
    upstream.close();
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
