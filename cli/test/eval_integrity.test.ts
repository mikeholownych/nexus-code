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
  // Owner decision 2026-10-18: qualification accepts a legacy hidden command only as a hardened check carrying its files.
  assert.match(validateTask(good, dir, { qualification: true }).join(), /hardened legacy hidden test must carry its files in hidden.dir/);
  assert.deepEqual(validateTask({ ...good, class: "bugfix", difficulty: "medium", hidden: { dir: "candidate", command: "npm test" } }, dir, { qualification: true }), []);
  assert.match(validateTask({ ...good, class: "bugfix", difficulty: "medium", hidden: { protocol: "blackbox-v1", command: "npm test" } }, dir, { qualification: true }).join(), /exactly one hidden oracle/);
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
  assert.match(qualificationResourceIsolationProblem({ resources: { ...ok, storageBytes: ok.storageBytes - 4096 } }) ?? "", /tmpfs with size<=storageBytes/);
  assert.match(qualificationResourceIsolationProblem({ resources: { ...ok, storageBytes: undefined } }) ?? "", /storageBytes/);
  const isolation = qualificationResourceIsolationProblem({ resources: ok });
  if (process.env.NEXUS_EVAL_TEST_WORKSPACE_ROOT) assert.equal(isolation, null, "the dedicated test tmpfs and kernel resource contract must pass preflight");
  else assert.match(isolation ?? "", /dedicated tmpfs|exact mount point/, "a shared /dev/shm must fail qualification preflight");
  if (process.env.NEXUS_EVAL_TEST_WORKSPACE_ROOT) {
    fs.chmodSync(workspaceRoot, 0o755);
    try {
      assert.match(qualificationResourceIsolationProblem({ resources: ok }) ?? "", /non-readable\/non-writable by group or other/);
    } finally {
      fs.chmodSync(workspaceRoot, 0o700);
    }
    assert.equal(qualificationResourceIsolationProblem({ resources: ok }), null, "restored dedicated mount root must pass preflight");
    fs.chmodSync(workspaceRoot, 0o731);
    try {
      assert.match(qualificationResourceIsolationProblem({ resources: ok }) ?? "", /non-readable\/non-writable by group or other/);
    } finally {
      fs.chmodSync(workspaceRoot, 0o700);
    }
    fs.chmodSync(workspaceRoot, 0o711);
    try {
      assert.equal(qualificationResourceIsolationProblem({ resources: ok }), null, "execute-only traversal for the isolated evaluator account is compatible with the private root");
    } finally {
      fs.chmodSync(workspaceRoot, 0o700);
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
    const memory = await run("tail /dev/zero");
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

    // The dedicated workspace mount caps storage before the larger memory limit; sandbox /tmp is separately charged
    // to the task cgroup and must hit memory.max. Neither failure may leave a task process behind.
    const workspaceDisk = await run("dd if=/dev/zero of=/workspace/fill bs=1M count=512 status=none");
    assert.notEqual(workspaceDisk.status, 0, JSON.stringify(workspaceDisk));
    assert.equal(workspaceDisk.resources.oomKills, 0, JSON.stringify(workspaceDisk.resources));
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
    const candidateProbe = `const fs=require('node:fs'),cp=require('node:child_process');const run=(args)=>cp.spawnSync('git',args,{cwd:'/workspace',encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:'/home/eval',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});const head=run(['rev-parse','HEAD']),baselineObject=run(['cat-file','-e',${JSON.stringify(`${baseline}^{commit}`)}]),object=run(['cat-file','-e',${JSON.stringify(`${child}^{commit}`)}]),source=fs.readFileSync('/workspace/lib.txt','utf8');let external='';for(const p of [${JSON.stringify(externalCanary)},${JSON.stringify(path.join(cache, ".git/objects"))},'/home/mike/nexus-heldout-v2']){try{const s=fs.statSync(p);external+=s.isDirectory()?'directory ':fs.readFileSync(p,'utf8')}catch{external+='unavailable '}};const refs=run(['rev-list','--all','--reflog','--objects']);console.log(JSON.stringify({head:head.stdout.trim(),headStatus:head.status,baselineObjectStatus:baselineObject.status,objectStatus:object.status,objectOutput:object.stdout+object.stderr,source,external,refs:refs.stdout+refs.stderr,workspace:fs.realpathSync('/workspace')}))`;
    const task = await runSandbox(sandbox.cmd, sandbox.argv, JSON.stringify({ command: nodeRuntime, argv: ["-e", candidateProbe], env: { PATH: "/usr/bin:/bin" } }));
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
    const objectProbe = `const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path');const run=(args)=>cp.spawnSync('git',args,{cwd:'/workspace',encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:'/home/eval',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});let disk='';const walk=(d)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else try{disk+=fs.readFileSync(p).toString('utf8')}catch{}}};walk('/workspace/.git');console.log(JSON.stringify({fsck:run(['fsck','--unreachable']),all:run(['cat-file','--batch-check=%(objectname)','--batch-all-objects']),blob:run(['cat-file','-p',${JSON.stringify(danglingBlob)}]),commit:run(['cat-file','-p',${JSON.stringify(danglingCommit)}]),disk}))`;
    const objectTask = await runSandbox(sandbox.cmd, sandbox.argv, JSON.stringify({ command: nodeRuntime, argv: ["-e", objectProbe], env: { PATH: "/usr/bin:/bin" } }));
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
  let proxy: Awaited<ReturnType<typeof startModelProxy>> | undefined;
  try {
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    proxy = await startModelProxy({ upstream: `http://127.0.0.1:${(upstream.address() as any).port}/v1`, authToken: "UPSTREAM_AUTH_CANARY", clientToken: "RUN_LOCAL_TOKEN", socketPath: path.join(proxyDirectory, "proxy.sock") });
    const nodeRuntime = process.execPath;
    const sandbox = agentSandboxArgv({ cwd: workspace, home, proxyDirectory, readOnlyPaths: [nodeRuntime], runtimeExecutablePaths: [nodeRuntime], supervisorPath: path.join(ROOT, "eval/agent_sandbox.mjs") });
    const script = `const fs=require('fs'),cp=require('child_process');fetch('http://127.0.0.1:40127/v1/models',{headers:{authorization:'Bearer '+process.env.OPENAI_API_KEY},signal:AbortSignal.timeout(2000)}).then(async r=>{let value='';try{value=fs.readFileSync(${JSON.stringify(canary)},'utf8')}catch{};try{fs.writeFileSync('/tmp/host-write-canary','changed')}catch{};const nested=cp.spawnSync('/usr/bin/unshare',['-Ur','true']);console.log(JSON.stringify({status:r.status,token:process.env.OPENAI_API_KEY,upstreamVisible:process.env.UPSTREAM_AUTH_CANARY??null,canary:value,nestedUserns:nested.status}))}).catch(e=>{console.error(e.message);process.exit(1)})`;
    process.env.UPSTREAM_AUTH_CANARY = "UPSTREAM_AUTH_CANARY";
    const child = await runSandbox(sandbox.cmd, sandbox.argv, JSON.stringify({ command: nodeRuntime, argv: ["-e", script], env: { PATH: "/usr/bin:/bin", OPENAI_API_KEY: "RUN_LOCAL_TOKEN" } }));
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
