import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { HarnessOrchestrator } from "../src/core/harness/orchestrator.js";
import { HarnessStore } from "../src/core/harness/store.js";
import { MockProbeAdapter, type ProbeInput } from "../src/core/harness/probe_adapter.js";
import { RealProbeAdapter } from "../src/core/harness/real_probe_adapter.js";
import { runProbeProcess } from "../src/core/harness/probe_process.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hir-assurance-"));
  const base = path.join(root, "base");
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, "artifact.txt"), "ok\n");
  const suite = path.join(root, "suite.json");
  fs.writeFileSync(suite, JSON.stringify({
    schemaVersion: 1,
    id: "assurance-suite",
    cases: [{ id: "case-1", description: "fixture", prompt: "inspect fixture", expected: { artifactPath: "artifact.txt" } }],
  }));
  const store = new HarnessStore({ rootDir: path.join(root, "state") });
  return { root, base, suite, store };
}

function probe(input: ProbeInput) {
  const at = new Date().toISOString();
  return {
    schemaVersion: 1 as const,
    id: `hprobe-${input.candidateId}`,
    runId: input.runId,
    candidateId: input.candidateId,
    caseId: input.case.id,
    status: "SUCCEEDED" as const,
    startedAt: at,
    endedAt: at,
    metrics: { wallClockMs: 1, tokens: 0, toolErrors: 0, verifierPass: true, score: 1 },
    artifacts: {},
    observations: [],
  };
}

test("mock verifier never runs task-suite shell with host environment or writable host filesystem", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hir-mock-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate");
  fs.mkdirSync(candidate);
  const marker = path.join(root, "host-write.txt");
  const original = process.env.HIR_TEST_SECRET;
  process.env.HIR_TEST_SECRET = "HIR_HOST_SECRET_SENTINEL";
  try {
    const result = await new MockProbeAdapter().run({
      runId: "hir-mock-boundary",
      candidateId: "candidate",
      candidatePath: candidate,
      case: {
        id: "untrusted-shell",
        description: "attempt host access",
        prompt: "not used by the mock adapter",
        expected: { verifierCommand: `printf '%s' "$HIR_TEST_SECRET" > '${marker}'` },
      },
      timeoutMs: 2_000,
    });
    assert.notEqual(result.status, "SUCCEEDED");
    assert.equal(fs.existsSync(marker), false, "the verifier could not write outside its temporary probe workspace");
    assert.ok(result.observations.some((entry) => entry.startsWith("os_sandbox=") || entry.startsWith("os_sandbox_unavailable:")));
  } finally {
    if (original === undefined) delete process.env.HIR_TEST_SECRET;
    else process.env.HIR_TEST_SECRET = original;
  }
});

test("operator cancellation stops an in-flight probe and cannot be overwritten by its stale run snapshot", async (t) => {
  const { root, base, suite, store } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = new HarnessOrchestrator(store);
  const run = await owner.init({ taskSuitePath: suite, basePath: base, store });
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pendingProbe = new Promise<void>((resolve) => { finish = resolve; });
  const adapter = {
    async run(input: ProbeInput) {
      entered();
      await pendingProbe;
      return probe(input);
    },
  };

  const running = owner.run(run.id, { store, adapter });
  await started;
  const cancelled = new HarnessOrchestrator(store).cancel(run.id);
  assert.equal(cancelled.status, "CANCELLED");
  finish();

  const result = await running;
  assert.equal(result.status, "CANCELLED");
  assert.equal(store.loadRun(run.id).status, "CANCELLED");
  assert.equal(store.loadReport(run.id), undefined);
});

test("probe cancellation terminates its child before a delayed side effect", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hir-process-cancel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const started = path.join(root, "started");
  const late = path.join(root, "late");
  const controller = new AbortController();
  const script = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(started)}, 'started'); setTimeout(() => fs.writeFileSync(${JSON.stringify(late)}, 'late'), 600); setInterval(() => {}, 1000);`;
  const running = runProbeProcess(process.execPath, ["-e", script], { cwd: root, timeoutMs: 5_000, signal: controller.signal });
  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(started) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(started), "the probe process started before cancellation");
  controller.abort();
  const result = await running;
  assert.equal(result.cancelled, true);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(fs.existsSync(late), false, "the cancelled process did not continue to its later side effect");
});

test("probe adapters reject directory symlink cycles while copying candidate trees", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hir-symlink-cycle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate");
  fs.mkdirSync(candidate);
  fs.symlinkSync(".", path.join(candidate, "loop"), "dir");
  const input: ProbeInput = {
    runId: "hir-symlink-cycle",
    candidateId: "candidate",
    candidatePath: candidate,
    case: { id: "cycle", description: "cycle", prompt: "unused", expected: { artifactPath: "missing" } },
    timeoutMs: 1_000,
  };

  for (const adapter of [new MockProbeAdapter(), new RealProbeAdapter()]) {
    const result = await adapter.run(input);
    assert.equal(result.status, "FAILED");
    assert.ok(result.observations.some((entry) => entry.includes("directory symlink cycle")));
  }
});
