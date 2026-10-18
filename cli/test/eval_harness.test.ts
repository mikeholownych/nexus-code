/**
 * The evaluation harness end to end against a scripted model (Stage 8, T1 smoke): fresh workspaces, hidden tests the
 * agent never sees, separate scores. The self-test task is the assessment's A1 case: a repository whose own suite is
 * green but never exercises the deliverable. A wrong deliverable must fail the hidden test and must never be VERIFIED.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startGateway, Reply } from "./helpers/fixtures.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function sealTestTasks(tasksDir: string, taskId: string) {
  const { corpusTaskRows } = await import(path.join(ROOT, "eval/validate.mjs"));
  const rows = corpusTaskRows(tasksDir, [taskId]);
  const manifestPath = path.join(tasksDir, "custody-manifest.json");
  const manifest = { schemaVersion: 1, split: "heldout", custody: { status: "approved", custodian: "synthetic-test-role", approvedAt: "2026-01-01T00:00:00Z" }, tasks: rows };
  const bytes = JSON.stringify(manifest);
  fs.writeFileSync(manifestPath, bytes);
  return { corpusManifest: manifestPath, corpusManifestSha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Async: the scripted gateway answers from this process, so the runner must not block its event loop. */
function runNode(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function writer(content: string) {
  return (_n: number, body: any): Reply => {
    const tools = (body?.messages ?? []).filter((m: any) => m.role === "tool").length;
    if (tools === 0) return { kind: "tools", calls: [{ name: "write_file", args: { path: "math.js", content } }] };
    if (tools === 1) return { kind: "tools", calls: [{ name: "task_completed", args: { summary: "math.js added" } }] };
    return { kind: "text", content: "Done." };
  };
}

async function evaluate(content: string, extra: Record<string, unknown> = {}): Promise<{ records: any[]; score: any; hiddenLog: string; agentLog: string; agentError: string }> {
  const gw = await startGateway(writer(content));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-out-"));
  const out = path.join(root, "run");
  const config = path.join(root, "config.json");
  fs.writeFileSync(config, JSON.stringify({ name: "nexus@mock", agent: "nexus", endpoint: gw.url, model: "m", runs: 1, steps: 20, minutes: 5, ...extra }));
  try {
    const run = await runNode([path.join(ROOT, "eval/run.mjs"), "--config", config, "--out", out, "--only", "selftest-add"]);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const records = fs.readFileSync(path.join(out, "results.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const scored = spawnSync(process.execPath, [path.join(ROOT, "eval/score.mjs"), path.join(out, "results.jsonl"), "--json"], { encoding: "utf8" });
    assert.equal(scored.status, 0, scored.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.tasks.map((task: any) => task.id), ["selftest-add"]);
    assert.match(manifest.harness.sourceSha256, /^[0-9a-f]{64}$/);
    assert.match(manifest.configSha256, /^[0-9a-f]{64}$/);
    const priorResults = fs.readFileSync(path.join(out, "results.jsonl"), "utf8");
    const replay = await runNode([path.join(ROOT, "eval/run.mjs"), "--config", config, "--out", out, "--only", "selftest-add"]);
    assert.equal(replay.status, 2);
    assert.match(replay.stderr, /output directory must be new/);
    assert.equal(fs.readFileSync(path.join(out, "results.jsonl"), "utf8"), priorResults, "reusing an output directory changed prior evidence");
    assert.match(manifest.harness.string, /^[0-9a-f]{12}/);
    const logDir = records[0].logs ? path.join(out, records[0].logs) : null;
    const readLog = (file: string) => logDir && fs.existsSync(path.join(logDir, file)) ? fs.readFileSync(path.join(logDir, file), "utf8") : "<not written>";
    return { records, score: JSON.parse(scored.stdout), hiddenLog: readLog("hidden.log"), agentLog: readLog("agent.stdout.json"), agentError: readLog("agent.stderr.log") };
  } finally {
    await gw.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a correct deliverable passes the hidden test; a wrong one fails it and is never VERIFIED (A1)", { timeout: 300_000 }, async () => {
  const good = await evaluate("exports.add = (a, b) => a + b;\n");
  assert.equal(good.records.length, 1);
  assert.equal(good.records[0].hiddenPass, true, `${JSON.stringify(good.records[0])}\nagent=${good.agentLog}\nagent-error=${good.agentError}\nhidden=${good.hiddenLog}`);
  assert.equal(good.records[0].regressionPass, true);
  assert.equal(good.records[0].falseVerified, false);

  const wrong = await evaluate("exports.add = (a, b) => a - b;\n");
  const r = wrong.records[0];
  assert.equal(r.hiddenPass, false, "the hidden test catches the wrong deliverable");
  assert.equal(r.regressionPass, true, "the repository's own suite is still green");
  assert.notEqual(r.turn?.outcome, "VERIFIED", `an unrelated green suite does not verify it: ${JSON.stringify(r.turn)}`);
  assert.equal(r.falseVerified, false);
  assert.equal(wrong.score.totals.falseVerified, 0);
  assert.equal(wrong.score.rows[0].correct, 0);
});

// REQ-QUAL-110: T4 smoke in `make test` — faults injected by the harness's model proxy end truthfully.
test("standalone profile context discovery is not overridden by the harness default", async () => {
  const { nexusContextLimitArgs } = await import(path.join(ROOT, "eval/validate.mjs"));
  assert.deepEqual(nexusContextLimitArgs({ serverProfile: "llamacpp" }, 65536), []);
  assert.deepEqual(nexusContextLimitArgs({ serverProfile: "llamacpp", limits: { context: 8192 } }, 65536), ["--context-limit", "8192"]);
  assert.deepEqual(nexusContextLimitArgs({}, 65536), ["--context-limit", "65536"]);
});

test("a standalone server-profile run discovers context instead of forcing the harness default", { timeout: 300_000 }, async () => {
  const result = await evaluate("exports.add = (a, b) => a + b;\n", { serverProfile: "llamacpp" });
  assert.equal(result.records[0].hiddenPass, true);
  assert.ok(result.records[0].model.profileContextLookups > 0, "llama.cpp context comes from the profile endpoint");
});

test("T4 smoke: an overloaded endpoint is waited out and the task still completes; the fault is recorded", { timeout: 300_000 }, async () => {
  const { records, score } = await evaluate("exports.add = (a, b) => a + b;\n", { faults: [{ kind: "overloaded", atRequest: 1 }] });
  const r = records[0];
  assert.deepEqual(r.model.faultsInjected, [{ kind: "overloaded", atRequest: 1 }]);
  assert.equal(r.hiddenPass, true, JSON.stringify(r.turn));
  assert.equal(r.falseVerified, false);
  assert.deepEqual(score.faults.map((f: any) => [f.kind, f.n, f.truthful, f.recovered]), [["overloaded", 1, 1, 1]]);
});

test("T4 smoke: a reply cut at the output limit is never run as a tool call, and the run ends truthfully", { timeout: 300_000 }, async () => {
  const { records, score } = await evaluate("exports.add = (a, b) => a + b;\n", { faults: [{ kind: "truncate", atRequest: 1 }] });
  const r = records[0];
  assert.equal(r.model.faultsInjected[0].kind, "truncate");
  assert.equal(r.falseVerified, false);
  assert.ok(r.turn, "the run produced its own result (no crash)");
  assert.equal(score.faults[0].truthful, 1);
});

test("peer run records the executable version and effective budget", { timeout: 300_000 }, async () => {
  const gw = await startGateway(() => ({ kind: "text", content: "not used by the fake peer" }));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-peer-out-"));
  const runOut = path.join(out, "run");
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-peer-bin-"));
  const config = path.join(out, "config.json");
  const fakeOpenCode = path.join(bin, "opencode");
  fs.writeFileSync(fakeOpenCode, `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("OpenCode 9.8.7"); process.exit(0); }
const cfg = JSON.parse(require("node:fs").readFileSync(require("node:path").join(process.env.HOME, ".config/opencode/opencode.json"), "utf8"));
require("node:fs").writeFileSync(require("node:path").join(process.cwd(), "math.js"), "exports.add = (a, b) => a + b;\\n");
console.log(JSON.stringify({ observed: { agent: cfg.agent["nexus-eval"], model: cfg.provider.gw.models.m } }));
console.log(JSON.stringify({ turn: { execution: "COMPLETED", outcome: "NOT_REQUIRED", steps: { used: 1 } } }));
`);
  fs.chmodSync(fakeOpenCode, 0o755);
  fs.writeFileSync(config, JSON.stringify({ name: "opencode@mock", agent: "opencode", endpoint: gw.url, model: "m", runs: 1, steps: 20, minutes: 5, sampling: { temperature: 0, seed: 17 } }));
  try {
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
    const run = await runNode([path.join(ROOT, "eval/run.mjs"), "--config", config, "--out", runOut, "--only", "selftest-add"], env);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(runOut, "manifest.json"), "utf8"));
    const record = JSON.parse(fs.readFileSync(path.join(runOut, "results.jsonl"), "utf8").trim());
    assert.equal(manifest.agentVersion.agent, "opencode");
    assert.equal(manifest.agentVersion.version, "OpenCode 9.8.7");
    assert.equal(manifest.agentVersion.executablePath, fs.realpathSync(fakeOpenCode));
    assert.match(manifest.agentVersion.executableSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(record.agentVersion, manifest.agentVersion);
    assert.deepEqual(record.budget, { steps: 20, minutes: 5 });
    assert.equal(record.hiddenPass, true);
    const stdout = fs.readFileSync(path.join(runOut, record.logs, "agent.stdout.json"), "utf8");
    const observedConfig = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).find((value) => value.observed).observed;
    assert.equal(observedConfig.agent.steps, 20);
    assert.deepEqual(observedConfig.model.options, { temperature: 0, seed: 17 });
  } finally {
    await gw.close();
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("Goose adapter applies the matched turn, context, output, and temperature budgets", { timeout: 300_000 }, async () => {
  const gw = await startGateway(() => ({ kind: "text", content: "not used by the fake peer" }));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-goose-out-"));
  const runOut = path.join(out, "run");
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-goose-bin-"));
  const config = path.join(out, "config.json");
  const fakeGoose = path.join(bin, "goose");
  fs.writeFileSync(fakeGoose, `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("Goose 1.27.2"); process.exit(0); }
console.log(JSON.stringify({ observed: { args: process.argv.slice(2), context: process.env.GOOSE_CONTEXT_LIMIT, output: process.env.GOOSE_MAX_TOKENS, turns: process.env.GOOSE_MAX_TURNS, temperature: process.env.GOOSE_TEMPERATURE } }));
require("node:fs").writeFileSync(require("node:path").join(process.cwd(), "math.js"), "exports.add = (a, b) => a + b;\\n");
console.log(JSON.stringify({ turn: { execution: "COMPLETED", outcome: "NOT_REQUIRED", steps: { used: 1 } } }));
`);
  fs.chmodSync(fakeGoose, 0o755);
  fs.writeFileSync(config, JSON.stringify({ name: "goose@mock", agent: "goose", endpoint: gw.url, model: "m", runs: 1, steps: 20, minutes: 5, limits: { context: 65536, output: 8192 }, sampling: { temperature: 0 } }));
  try {
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
    const run = await runNode([path.join(ROOT, "eval/run.mjs"), "--config", config, "--out", runOut, "--only", "selftest-add"], env);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(runOut, "manifest.json"), "utf8"));
    const record = JSON.parse(fs.readFileSync(path.join(runOut, "results.jsonl"), "utf8").trim());
    const stdout = fs.readFileSync(path.join(runOut, record.logs, "agent.stdout.json"), "utf8");
    const captured = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).find((value) => value.observed).observed;
    assert.equal(manifest.agentVersion.agent, "goose");
    assert.equal(manifest.agentVersion.version, "Goose 1.27.2");
    assert.equal(manifest.agentVersion.executablePath, fs.realpathSync(fakeGoose));
    assert.match(manifest.agentVersion.executableSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(record.agentVersion, manifest.agentVersion);
    assert.deepEqual(record.budget, { steps: 20, minutes: 5 });
    assert.ok(captured.args.includes("--max-turns") && captured.args.includes("20"));
    assert.deepEqual([captured.context, captured.output, captured.turns, captured.temperature], ["65536", "8192", "20", "0"]);
    assert.equal(record.hiddenPass, true);
  } finally {
    await gw.close();
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("version identity probes run inside the sandbox and reject a mismatched expected peer version", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-rc-version-"));
  const tasks = path.join(out, "tasks");
  const task = path.join(tasks, "qual-fixture");
  fs.mkdirSync(path.join(task, "fixture"), { recursive: true, mode: 0o700 });
  fs.chmodSync(tasks, 0o700);
  fs.writeFileSync(path.join(task, "task.json"), JSON.stringify({
    id: "qual-fixture",
    tier: "T2",
    objective: "Inspect the fixture",
    fixture: "fixture",
    hidden: { command: "true" },
    class: "bugfix",
    difficulty: "easy",
  }));
  const installed = path.join(out, "goose");
  const probeMarker = `/tmp/nexus-version-probe-${process.pid}-${Date.now()}`;
  fs.writeFileSync(installed, `#!/bin/sh\n[ -z "$EVAL_VERSION_PROBE_CANARY" ] || exit 9\ntouch ${probeMarker}\nprintf '%s\\n' '0.1.0-alpha.2 (legacy, main)'\n`);
  fs.chmodSync(installed, 0o755);
  const config = path.join(out, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    name: "goose@expected",
    agent: "goose",
    expectedAgentVersion: "1.0.0-rc.1",
    endpoint: "http://127.0.0.1:1/v1",
    model: "m",
    fingerprint: { weightsSha256: "a".repeat(64), serverBuild: "fixture server" },
    sampling: { temperature: 0.2, seed: 1 },
    runs: 1,
  }));
  try {
    process.env.EVAL_VERSION_PROBE_CANARY = "VERSION_PROBE_HOST_CANARY";
    process.env.EVAL_VERSION_PROBE_CANARY = "VERSION_PROBE_HOST_CANARY";
    const env = { ...process.env, PATH: `${out}${path.delimiter}${process.env.PATH ?? ""}` };
    const run = await runNode([path.join(ROOT, "eval/run.mjs"), "--config", config, "--out", path.join(out, "results"), "--tasks", tasks, "--only", "no-task-selected"], env);
    assert.equal(run.status, 2, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /goose version 0\.1\.0-alpha\.2 does not match expected version 1\.0\.0-rc\.1/);
    assert.equal(fs.existsSync(probeMarker), false, "version probe writes only into the sandbox tmpfs");
    assert.equal(fs.existsSync(path.join(out, "results", "manifest.json")), false, "a mismatched install cannot write qualification evidence");
  } finally {
    delete process.env.EVAL_VERSION_PROBE_CANARY;
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("qualification refuses peer output limits that differ from the installed Nexus limit", async () => {
  const { nexusLimitsProblem } = await import(path.join(ROOT, "eval/validate.mjs"));
  const entry = { id: "m", context_length: 65536, max_completion_tokens: 8192 };
  assert.equal(nexusLimitsProblem({ limits: { context: 65536, output: 8192 } }, entry), null);
  assert.match(nexusLimitsProblem({ limits: { context: 65536, output: 4096 } }, entry), /Nexus output allowance 8192 differs from matched peer limit 4096/);
  assert.match(nexusLimitsProblem({ limits: { context: 131072, output: 8192 } }, entry), /configured context limit 131072 exceeds/);
  assert.match(nexusLimitsProblem({ limits: { context: 65536, output: 4096 } }, null), /Nexus output allowance 8192 differs/);
});

function writePeerResults(root: string, agent: string, overrides: Record<string, unknown> = {}): string {
  const dir = path.join(root, agent);
  fs.mkdirSync(dir, { recursive: true });
  const fingerprint = { alias: "engineering/deep", listed: true, ownedBy: "fixture", contextLength: 65536, weightsSha256: "a".repeat(64), serverBuild: "llama.cpp b123", sampling: { temperature: 0, seed: 17 } };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    ...overrides,
    config: { name: `${agent}@engineering/deep`, agent, model: "engineering/deep", qualification: true, limits: { context: 65536, output: 8192, requests: 200, totalOutput: 100_000 }, resources: { cpuPercent: 800, memoryBytes: 17179869184, tasks: 4096, storageBytes: 21474836480, workspaceRoot: "/srv/nexus-qual/ws" }, sampling: { temperature: 0, seed: 17 }, ...(agent === "nexus" ? { nexusPackageSha256: "d".repeat(64) } : {}), ...(overrides.config as object ?? {}) },
    fingerprint: { ...fingerprint, ...(overrides.fingerprint as object ?? {}) },
    agentVersion: { agent, version: `${agent} 1.2.3`, executablePath: `/usr/bin/${agent}`, executableSha256: "c".repeat(64), ...(agent === "nexus" ? { packageSha256: "d".repeat(64) } : {}) },
    runs: 5,
  }));
  const results = path.join(dir, "results.jsonl");
  fs.writeFileSync(results, Array.from({ length: 5 }, (_, index) => JSON.stringify({
    config: `${agent}@engineering/deep`,
    agent,
    agentVersion: { agent, version: `${agent} 1.2.3` },
    task: "task-1",
    run: index + 1,
    budget: { steps: 40, minutes: 15 },
    hiddenPass: true,
    claimedComplete: true,
    falseVerified: false,
    regressionPass: true,
    wallMs: 1000,
    ...overrides.record,
  })).join("\n") + "\n");
  return results;
}

test("--pairs reports only model-, limit-, and budget-matched Nexus, Goose, and OpenCode runs", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-pairs-"));
  try {
    const files = ["nexus", "goose", "opencode"].map((agent) => writePeerResults(out, agent));
    const scored = spawnSync(process.execPath, [path.join(ROOT, "eval/score.mjs"), "--pairs", ...files, "--json"], { encoding: "utf8" });
    assert.equal(scored.status, 0, scored.stderr);
    const result = JSON.parse(scored.stdout);
    assert.equal(result.peerComparison.matchedRuns, 5);
    assert.deepEqual(result.peerComparison.agents, ["goose", "nexus", "opencode"]);
    assert.equal(result.peerComparison.versions.opencode, "opencode 1.2.3");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("--pairs rejects a peer run with a different model fingerprint or effective budget", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-pair-mismatch-"));
  try {
    for (const mismatch of [
      { dir: "budget", goose: { record: { budget: { steps: 41, minutes: 15 } } }, message: /peer conditions do not match.*task-1 run 1/i },
      { dir: "fingerprint", goose: { fingerprint: { weightsSha256: "b".repeat(64) } }, message: /model fingerprint differs for goose/i },
      { dir: "limits", goose: { config: { limits: { context: 65536, output: 4096, requests: 200, totalOutput: 100_000 } } }, message: /context\/output\/request\/aggregate-output limits differ for goose/i },
      { dir: "resources", goose: { config: { resources: { cpuPercent: 400, memoryBytes: 17179869184, tasks: 4096, storageBytes: 21474836480, workspaceRoot: "/srv/nexus-qual/ws" } } }, message: /resource limits differ for goose/i },
    ]) {
      const root = path.join(out, mismatch.dir);
      const files = [
        writePeerResults(root, "nexus"),
        writePeerResults(root, "goose", mismatch.goose),
        writePeerResults(root, "opencode"),
      ];
      const scored = spawnSync(process.execPath, [path.join(ROOT, "eval/score.mjs"), "--pairs", ...files, "--json"], { encoding: "utf8" });
      assert.equal(scored.status, 2, scored.stdout);
      assert.match(scored.stderr, mismatch.message);
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
