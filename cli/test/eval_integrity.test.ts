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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const proxyModule = path.join(ROOT, "eval/model_proxy.mjs");

test("the model proxy forwards requests and counts answers and upstream failures", async () => {
  const { startModelProxy, isInfrastructureFailure } = await import(proxyModule);
  const upstream = http.createServer((req, res) => {
    if (req.url?.endsWith("/down")) {
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
    assert.equal((await fetch(`${proxy.url}/down`)).status, 503);
    const stats = proxy.stats();
    assert.equal(stats.requests, 2);
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

test("task validation: pinned repos, one source, hidden command; qualification also needs class and difficulty", async () => {
  const { validateTask } = await import(path.join(ROOT, "eval/validate.mjs"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t2-x-"));
  const id = path.basename(dir);
  const good = { id, tier: "T2", objective: "fix it", repo: { url: "https://example.invalid/r.git", commit: "a".repeat(40) }, hidden: { command: "npm test" } };
  assert.deepEqual(validateTask(good, dir), []);
  assert.match(validateTask({ ...good, repo: { url: good.repo.url, commit: "main" } }, dir).join(), /pinned/);
  assert.match(validateTask({ ...good, fixture: "repo" }, dir).join(), /exactly one of fixture or repo/);
  assert.match(validateTask({ ...good, hidden: {} }, dir).join(), /hidden.command/);
  assert.equal(validateTask(good, dir, { qualification: true }).length, 2);
  assert.deepEqual(validateTask({ ...good, class: "bugfix", difficulty: "medium" }, dir, { qualification: true }), []);
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

test("hidden tests must be unreadable to the agent's own user", async () => {
  const { hiddenTestIsolationProblem, asUser } = await import(path.join(ROOT, "eval/validate.mjs"));
  const tasks = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-tasks-"));
  fs.chmodSync(tasks, 0o755);
  assert.equal(hiddenTestIsolationProblem({}, tasks), null, "development runs may run as the operator");
  assert.match(hiddenTestIsolationProblem({ qualification: true }, tasks), /need runAs/);
  assert.match(hiddenTestIsolationProblem({ runAs: "nexus-eval" }, tasks), /readable by other users/);
  fs.chmodSync(tasks, 0o700);
  assert.equal(hiddenTestIsolationProblem({ runAs: "nexus-eval" }, tasks), null);
  assert.match(hiddenTestIsolationProblem({ runAs: "bad user;" }, tasks), /not a valid user name/);
  const wrapped = asUser("nexus-eval", "node", ["index.js", "run"], { HOME: "/tmp/h", PATH: "/usr/bin" });
  assert.equal(wrapped.cmd, "sudo");
  assert.deepEqual(wrapped.argv, ["-n", "-u", "nexus-eval", "--", "env", "-i", "HOME=/tmp/h", "PATH=/usr/bin", "node", "index.js", "run"]);
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
