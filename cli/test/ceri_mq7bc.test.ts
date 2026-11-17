import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CeriBaselineComparator, VerifiedBaseline } from "../src/ceri/baseline.js";
import { CeriEvidenceStore } from "../src/ceri/evidence_store.js";
import { CeriEvaluationRunner } from "../src/ceri/runner.js";
import { hashFixture } from "../src/ceri/fixture_identity.js";
import type { RunManifest } from "../src/ceri/contracts.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const FIX_A = "1".repeat(64);
const FIX_B = "2".repeat(64);

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: "run-1",
    evaluationId: "eval-1",
    evaluationVersion: "1.0.0",
    sourceCommit: "abcd",
    dirtyWorktree: false,
    model: { name: "m", digest: DIGEST_A, parameters: { temperature: 0, seed: 7 } },
    routingConfig: { gatewayUrl: "http://localhost", specialistRouting: true },
    agentProfileVersion: "1.1.2",
    harnessVersion: "1.2.1",
    toolchainVersions: { node: "22.0.0" },
    environment: { os: "Linux", kernel: "x", nodeVersion: "22" },
    hardware: { cpuModel: "Intel", totalMemoryBytes: 1 },
    startedAt: "2026-11-15T00:00:00.000Z",
    status: "RUNNING",
    fixtureSha256: FIX_A,
    mandatoryComparabilityKeys: [],
    ...overrides,
  };
}

function tmp<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ceri-mq7bc-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function finalize(store: CeriEvidenceStore, m: RunManifest, assertions: Record<string, boolean>, status: "COMPLETED" | "FAILED" = "COMPLETED"): RunManifest {
  store.initRun(m);
  store.recordAssertions(Object.entries(assertions).map(([id, passed]) => ({ id, passed })));
  store.finalizeRun(status, "t");
  return store.loadManifest(m.evaluationId, m.runId)!;
}

// ---------------------------------------------------------------------------------------------- Slice B

test("MQ-7B: a symlinked evaluation directory that escapes the store is refused, nothing is written outside", () => {
  tmp((dir) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ceri-outside-"));
    try {
      const base = path.join(dir, "store");
      const store = new CeriEvidenceStore(base);
      fs.symlinkSync(outside, path.join(base, "eval-1"));
      assert.throws(() => store.initRun(manifest()), /outside|symlink|contain/i);
      assert.deepEqual(fs.readdirSync(outside), []);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("MQ-7B: a run directory that is a symlink to evidence elsewhere does not load", () => {
  tmp((dir) => {
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ceri-outside-"));
    try {
      const real = new CeriEvidenceStore(outsideRoot);
      finalize(real, manifest(), { "a-1": true });
      const store = new CeriEvidenceStore(path.join(dir, "store"));
      fs.mkdirSync(path.join(dir, "store", "eval-1"));
      fs.symlinkSync(path.join(outsideRoot, "eval-1", "run-1"), path.join(dir, "store", "eval-1", "run-1"));
      assert.throws(() => store.loadAssertions("eval-1", "run-1"), /outside|symlink|contain|not a directory/i);
      assert.throws(() => store.loadManifest("eval-1", "run-1"), /outside|symlink|contain|not a directory/i);
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});

test("MQ-7B: run ids are validated: reserved suffixes, leading dots, overlong ids and case-only collisions are refused", () => {
  tmp((dir) => {
    const store = new CeriEvidenceStore(dir);
    for (const bad of ["x.abandoned-1", ".hidden", ".tmp-x", "a".repeat(129), "has space", "..", "a/b"]) {
      assert.throws(() => store.initRun(manifest({ runId: bad })), /Invalid runId/, `runId ${JSON.stringify(bad)}`);
    }
    store.initRun(manifest({ runId: "Run-A" }));
    assert.throws(() => store.initRun(manifest({ runId: "run-a" })), /differs only by case|already exists/i);
  });
});

// ---------------------------------------------------------------------------------------------- Slice C

const meta = { baselineId: "run-base", selectionRationale: "bound", establishedAt: "2026-11-15T00:00:00.000Z" };
const A = { "a-1": true };

test("MQ-7C: every mismatched identity field is named in one non-certifying result", () => {
  const base = manifest({ runId: "run-base", status: "COMPLETED" });
  const spec = CeriBaselineComparator.bindBaseline(base, meta);
  const cur = manifest({
    runId: "run-2",
    status: "COMPLETED",
    model: { name: "m", digest: DIGEST_B, parameters: { temperature: 0.5, seed: 7 } },
    fixtureSha256: FIX_B,
    harnessVersion: "9.9.9",
    toolchainVersions: { node: "20.0.0" },
  });
  const res = CeriBaselineComparator.compareRuns(cur, A, spec, A, false, { baselineManifest: base });
  assert.equal(res.certifying, false);
  assert.equal(res.identityBinding?.status, "UNBOUND");
  for (const f of ["model.digest", "sampling", "fixtureSha256", "evaluator.harnessVersion", "toolchainVersions"]) {
    assert.ok(res.identityBinding?.mismatchedFields?.includes(f), `missing ${f}: ${JSON.stringify(res.identityBinding?.mismatchedFields)}`);
  }
  assert.match(res.explanation, /Non-certifying/);
  assert.match(res.explanation, /fixtureSha256/);
});

test("MQ-7C: a baseline or candidate without a recorded fixture identity is not bound", () => {
  const base = manifest({ runId: "run-base", status: "COMPLETED", fixtureSha256: undefined });
  const spec = CeriBaselineComparator.bindBaseline(base, meta);
  const res = CeriBaselineComparator.compareRuns(manifest({ status: "COMPLETED", fixtureSha256: undefined }), A, spec, A, false, { baselineManifest: base });
  assert.equal(res.identityBinding?.status, "UNBOUND");
  assert.equal(res.certifying, false);
  assert.ok(res.identityBinding?.mismatchedFields?.includes("fixtureSha256"));
});

test("MQ-7C: a caller flag alone never reaches CONFIRMED_REGRESSION, bound or not", () => {
  const base = manifest({ runId: "run-base", status: "COMPLETED" });
  const spec = CeriBaselineComparator.bindBaseline(base, meta);
  const cur = manifest({ runId: "run-2", status: "FAILED" });
  const fail = { "a-1": false };
  for (const opts of [{ baselineManifest: base }, { baselineManifest: base, isPriorRegressionCandidate: true }, {}]) {
    for (const flag of [true, false]) {
      const res = CeriBaselineComparator.compareRuns(cur, fail, spec, A, flag, opts);
      assert.equal(res.outcome, "REGRESSION_CANDIDATE");
      assert.equal(res.certifying, false);
    }
  }
});

test("MQ-7C: loadVerifiedBaseline accepts verified evidence and refuses a mismatched hash, missing or unverifiable evidence", () => {
  tmp((dir) => {
    const store = new CeriEvidenceStore(dir);
    const onDisk = finalize(store, manifest({ runId: "run-base" }), A);
    const spec = CeriBaselineComparator.bindBaseline(onDisk, meta);
    const ok = CeriBaselineComparator.loadVerifiedBaseline(store, spec);
    assert.ok(ok.ok);
    if (ok.ok) {
      assert.ok(ok.baseline instanceof VerifiedBaseline);
      assert.deepEqual(ok.baseline.assertions, A);
    }
    const wrongHash = CeriBaselineComparator.loadVerifiedBaseline(store, { ...spec, manifestSha256: "0".repeat(64) });
    assert.ok(!wrongHash.ok);
    if (!wrongHash.ok) assert.match(wrongHash.reasons.join(";"), /manifestSha256/);
    const wrongIdentity = CeriBaselineComparator.loadVerifiedBaseline(store, { ...spec, identity: { ...spec.identity!, configurationSha256: "f".repeat(64) } });
    assert.ok(!wrongIdentity.ok);
    const unknown = CeriBaselineComparator.loadVerifiedBaseline(store, { ...spec, baselineId: "nope" });
    assert.ok(!unknown.ok);
    // On-disk edit without a re-recorded integrity record: rejected, not thrown.
    const mp = path.join(dir, "eval-1", "run-base", "assertions.json");
    fs.writeFileSync(mp, JSON.stringify([{ id: "a-1", passed: false }]));
    const edited = CeriBaselineComparator.loadVerifiedBaseline(store, spec);
    assert.ok(!edited.ok);
    if (!edited.ok) assert.match(edited.reasons.join(";"), /HASH_MISMATCH/);
  });
});

test("MQ-7C: CONFIRMED_REGRESSION needs a verified baseline and a verified earlier run that regressed the same assertion", () => {
  tmp((dir) => {
    const store = new CeriEvidenceStore(dir);
    const onDisk = finalize(store, manifest({ runId: "run-base" }), { "a-1": true, "a-2": true });
    const spec = CeriBaselineComparator.bindBaseline(onDisk, meta);
    const loaded = CeriBaselineComparator.loadVerifiedBaseline(store, spec);
    assert.ok(loaded.ok);
    if (!loaded.ok) return;
    const vb = loaded.baseline;
    const r1m = finalize(store, manifest({ runId: "run-r1" }), { "a-1": true, "a-2": false }, "FAILED");
    const r2m = finalize(store, manifest({ runId: "run-r2" }), { "a-1": true, "a-2": false }, "FAILED");
    const r1 = { manifest: r1m, assertions: { "a-1": true, "a-2": false } };
    const r2 = { manifest: r2m, assertions: { "a-1": true, "a-2": false } };

    const first = CeriBaselineComparator.compareToVerifiedBaseline(r1.manifest, r1.assertions, vb);
    assert.equal(first.outcome, "REGRESSION_CANDIDATE");
    assert.equal(first.certifying, true);

    const confirmed = CeriBaselineComparator.compareToVerifiedBaseline(r2.manifest, r2.assertions, vb, { priorRun: r1 });
    assert.equal(confirmed.outcome, "CONFIRMED_REGRESSION");
    assert.equal(confirmed.certifying, true);

    // The same run cannot confirm itself.
    assert.equal(CeriBaselineComparator.compareToVerifiedBaseline(r1.manifest, r1.assertions, vb, { priorRun: r1 }).outcome, "REGRESSION_CANDIDATE");
    // A prior run that did not regress is not a reproduction.
    const okm = finalize(store, manifest({ runId: "run-ok" }), { "a-1": true, "a-2": true });
    assert.equal(
      CeriBaselineComparator.compareToVerifiedBaseline(r2.manifest, r2.assertions, vb, { priorRun: { manifest: okm, assertions: { "a-1": true, "a-2": true } } }).outcome,
      "REGRESSION_CANDIDATE",
    );
    // A prior run that regressed a different assertion is not a reproduction.
    const other = { manifest: r1m, assertions: { "a-1": false, "a-2": true } };
    assert.equal(CeriBaselineComparator.compareToVerifiedBaseline(r2.manifest, r2.assertions, vb, { priorRun: other }).outcome, "REGRESSION_CANDIDATE");
    // A candidate whose own identity is not bound (another fixture) cannot be confirmed by a bound prior run.
    const unboundNow = CeriBaselineComparator.compareToVerifiedBaseline({ ...r2m, fixtureSha256: FIX_B }, r2.assertions, vb, { priorRun: r1 });
    assert.equal(unboundNow.outcome, "REGRESSION_CANDIDATE");
    assert.equal(unboundNow.certifying, false);
    // A prior run with a different identity (here: another fixture) is not a reproduction.
    const diffFix = { manifest: { ...r1m, fixtureSha256: FIX_B }, assertions: r1.assertions };
    assert.equal(CeriBaselineComparator.compareToVerifiedBaseline(r2.manifest, r2.assertions, vb, { priorRun: diffFix }).outcome, "REGRESSION_CANDIDATE");
  });
});

test("MQ-7C: a VerifiedBaseline cannot be built by hand", () => {
  assert.throws(() => new (VerifiedBaseline as unknown as new (...a: unknown[]) => unknown)(Symbol("x"), {}, {}, {}), /loadVerifiedBaseline/);
});

test("MQ-7C: hashFixture is stable, content-sensitive and does not follow symlinks", () => {
  tmp((dir) => {
    fs.mkdirSync(path.join(dir, "f"));
    fs.writeFileSync(path.join(dir, "f", "a.txt"), "one");
    const h1 = hashFixture(path.join(dir, "f"));
    assert.match(h1 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(hashFixture(path.join(dir, "f")), h1);
    fs.writeFileSync(path.join(dir, "f", "a.txt"), "two");
    assert.notEqual(hashFixture(path.join(dir, "f")), h1);
    assert.equal(hashFixture(path.join(dir, "missing")), undefined);
    fs.writeFileSync(path.join(dir, "secret"), "s");
    fs.symlinkSync(path.join(dir, "secret"), path.join(dir, "f", "ln"));
    const h3 = hashFixture(path.join(dir, "f"));
    fs.writeFileSync(path.join(dir, "secret"), "changed");
    assert.equal(hashFixture(path.join(dir, "f")), h3);
  });
});

test("MQ-7C runner: verified baseline is certifying; priorRunId confirms; caller-supplied assertions are not certifying", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ceri-mq7bc-run-"));
  try {
    const fixture = path.join(dir, "fixture");
    fs.mkdirSync(fixture);
    fs.writeFileSync(path.join(fixture, "x.txt"), "x");
    const def = {
      id: "eval-rt",
      version: "1.0.0",
      domain: "code_comprehension" as const,
      objective: "o",
      fixturePath: fixture,
      expectedOutputs: [],
      authorizedTools: [],
      executionBudget: { maxSteps: 5, timeoutSeconds: 30 },
      deterministicAssertions: [{ id: "a-1", description: "d" }],
      independentValidationCriteria: [],
    };
    const store = new CeriEvidenceStore(path.join(dir, "store"));
    const opts = { model: { name: "m", digest: DIGEST_A, parameters: { temperature: 0 } }, gatewayUrl: "http://localhost:9200", baseCommit: "abcd", dirtyWorktree: false, evidenceStore: store };
    const base = await CeriEvaluationRunner.runEvaluation(def, opts, async () => true);
    assert.match(base.manifest.fixtureSha256 ?? "", /^[0-9a-f]{64}$/);
    const spec = CeriBaselineComparator.bindBaseline(store.loadManifest("eval-rt", base.manifest.runId)!, { baselineId: base.manifest.runId, selectionRationale: "r", establishedAt: "2026-11-15T00:00:00.000Z" });

    const pass = await CeriEvaluationRunner.runEvaluation(def, { ...opts, baseline: spec }, async () => true);
    assert.equal(pass.comparison?.certifying, true, JSON.stringify(pass.comparison?.identityBinding?.reasons));

    const bad1 = await CeriEvaluationRunner.runEvaluation(def, { ...opts, baseline: spec }, async () => false);
    assert.equal(bad1.comparison?.outcome, "REGRESSION_CANDIDATE");
    const bad2 = await CeriEvaluationRunner.runEvaluation(def, { ...opts, baseline: spec, priorRunId: bad1.manifest.runId }, async () => false);
    assert.equal(bad2.comparison?.outcome, "CONFIRMED_REGRESSION");
    // Obsolete flag is not an option any more and changes nothing.
    const flagged = await CeriEvaluationRunner.runEvaluation(def, { ...opts, baseline: spec, isRepeatReproduction: true } as never, async () => false);
    assert.equal(flagged.comparison?.outcome, "REGRESSION_CANDIDATE");
    // An unknown prior run id does not confirm.
    const noPrior = await CeriEvaluationRunner.runEvaluation(def, { ...opts, baseline: spec, priorRunId: "run-does-not-exist" }, async () => false);
    assert.equal(noPrior.comparison?.outcome, "REGRESSION_CANDIDATE");
    // Caller-supplied baseline assertions are unverified: usable, never certifying, never confirming.
    const supplied = await CeriEvaluationRunner.runEvaluation(
      def,
      { ...opts, baseline: spec, baselineAssertions: { "a-1": true }, baselineManifest: store.loadManifest("eval-rt", base.manifest.runId)!, priorRunId: bad1.manifest.runId },
      async () => false,
    );
    assert.equal(supplied.comparison?.outcome, "REGRESSION_CANDIDATE");
    assert.equal(supplied.comparison?.certifying, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
