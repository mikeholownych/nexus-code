import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CeriBaselineComparator } from "../src/ceri/baseline.js";
import { CeriEvidenceStore } from "../src/ceri/evidence_store.js";
import { CeriEvaluationRunner } from "../src/ceri/runner.js";
import { CeriReportGenerator } from "../src/ceri/reporting.js";
import type { RunManifest } from "../src/ceri/contracts.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_EVIL = `sha256:${"e".repeat(64)}`;

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
    status: "COMPLETED",
    mandatoryComparabilityKeys: [],
    ...overrides,
  };
}

const meta = { baselineId: "run-base", selectionRationale: "bound baseline", establishedAt: "2026-11-15T00:00:00.000Z" };
const A = { "a-1": true };

test("MQ-5: bindBaseline records model digest, sampling, configuration hash, evaluator and tool versions", () => {
  const base = manifest({ runId: "run-base" });
  const spec = CeriBaselineComparator.bindBaseline(base, meta);
  assert.equal(spec.identity?.model.digest, DIGEST_A);
  assert.deepEqual(spec.identity?.sampling, { temperature: 0, seed: 7 });
  assert.match(spec.identity?.configurationSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(spec.identity?.evaluatorVersion, "1.2.1");
  assert.deepEqual(spec.identity?.toolchainVersions, { node: "22.0.0" });
  assert.equal(spec.manifestSha256, CeriBaselineComparator.manifestSha256(base));
  assert.equal(spec.manifestSha256, CeriBaselineComparator.manifestSha256(JSON.parse(JSON.stringify(base))));
});

test("MQ-5: both bound and matching is IDENTITY_BOUND and records both identities", () => {
  const base = manifest({ runId: "run-base" });
  const spec = CeriBaselineComparator.bindBaseline(base, meta);
  const res = CeriBaselineComparator.compareRuns(manifest(), A, spec, A, false, { baselineManifest: base });
  assert.equal(res.outcome, "PASS");
  assert.equal(res.identityBinding?.status, "IDENTITY_BOUND");
  assert.deepEqual(res.identityBinding?.reasons, []);
  assert.deepEqual(res.identityBinding?.baselineIdentity, spec.identity);
  assert.equal(res.identityBinding?.currentIdentity.model.digest, DIGEST_A);
});

test("MQ-5: missing or unbound identity is UNBOUND with a reason", () => {
  const base = manifest({ runId: "run-base" });
  const spec = CeriBaselineComparator.bindBaseline(base, meta);
  const legacy = { ...spec, identity: undefined };
  const r1 = CeriBaselineComparator.compareRuns(manifest(), A, legacy, A);
  assert.equal(r1.identityBinding?.status, "UNBOUND");
  assert.match(r1.identityBinding?.reasons.join(";") ?? "", /BASELINE_IDENTITY_UNBOUND.*identity not recorded/);

  const r2 = CeriBaselineComparator.compareRuns(manifest(), A, spec, A);
  assert.equal(r2.identityBinding?.status, "UNBOUND");
  assert.match(r2.identityBinding?.reasons.join(";") ?? "", /baseline manifest not supplied/);

  const noDigestBase = manifest({ runId: "run-base", model: { name: "m", parameters: { temperature: 0, seed: 7 } } });
  const noDigestSpec = CeriBaselineComparator.bindBaseline(noDigestBase, meta);
  const r3 = CeriBaselineComparator.compareRuns(manifest(), A, noDigestSpec, A, false, { baselineManifest: noDigestBase });
  assert.equal(r3.identityBinding?.status, "UNBOUND");
  assert.match(r3.identityBinding?.reasons.join(";") ?? "", /model digest not recorded or malformed/);
});

test("MQ-5: a bound identity that differs from the current run is UNBOUND", () => {
  const base = manifest({ runId: "run-base" });
  const spec = CeriBaselineComparator.bindBaseline(base, meta);
  for (const [name, current, pattern] of [
    ["digest", manifest({ model: { name: "m", digest: DIGEST_B, parameters: { temperature: 0, seed: 7 } } }), /model digest/],
    ["sampling", manifest({ model: { name: "m", digest: DIGEST_A, parameters: { temperature: 0.7, seed: 7 } } }), /sampling/],
    ["configuration", manifest({ routingConfig: { gatewayUrl: "http://other", specialistRouting: true } }), /configuration/],
    ["evaluator", manifest({ harnessVersion: "9.9.9" }), /evaluator version/],
    ["toolchain", manifest({ toolchainVersions: { node: "20.0.0" } }), /toolchain/],
  ] as const) {
    const res = CeriBaselineComparator.compareRuns(current, A, spec, A, false, { baselineManifest: base });
    assert.equal(res.identityBinding?.status, "UNBOUND", name);
    assert.match(res.identityBinding?.reasons.join(";") ?? "", pattern, name);
  }
});

test("MQ-5: comparing against an edited or swapped baseline manifest fails", () => {
  const base = manifest({ runId: "run-base" });
  const spec = CeriBaselineComparator.bindBaseline(base, meta);

  const swapped = manifest({ runId: "run-base", model: { name: "m", digest: DIGEST_EVIL, parameters: { temperature: 0, seed: 7 } } });
  const r1 = CeriBaselineComparator.compareRuns(manifest(), A, spec, A, false, { baselineManifest: swapped });
  assert.equal(r1.outcome, "INCOMPARABLE");
  assert.equal(r1.isEligibleForComparison, false);
  assert.equal(r1.identityBinding?.status, "UNBOUND");
  assert.match(r1.incomparabilityReasons?.join(";") ?? "", /BASELINE_MANIFEST_MISMATCH/);

  const editedSpec = { ...spec, identity: { ...spec.identity!, sampling: { temperature: 0.9 } } };
  const r2 = CeriBaselineComparator.compareRuns(manifest(), A, editedSpec, A, false, { baselineManifest: base });
  assert.equal(r2.outcome, "INCOMPARABLE");
  assert.match(r2.incomparabilityReasons?.join(";") ?? "", /BASELINE_IDENTITY_MISMATCH/);
});

test("MQ-5: a legacy spec with a malformed manifestSha256 stays UNBOUND with BASELINE_IDENTITY_UNBOUND, even if a manifest is supplied", () => {
  const base = manifest({ runId: "run-base" });
  for (const fake of ["hash-001", "hash", "", "A".repeat(64), "f".repeat(63)]) {
    const spec = { ...CeriBaselineComparator.bindBaseline(base, meta), manifestSha256: fake };
    const res = CeriBaselineComparator.compareRuns(manifest(), A, spec, A, false, { baselineManifest: base });
    assert.equal(res.outcome, "PASS", fake);
    assert.equal(res.isEligibleForComparison, true, fake);
    assert.equal(res.identityBinding?.status, "UNBOUND", fake);
    assert.match(res.identityBinding?.reasons.join(";") ?? "", /BASELINE_IDENTITY_UNBOUND/, fake);
  }
});

test("MQ-5: a well-formed hash that does not match the supplied manifest is INCOMPARABLE", () => {
  const base = manifest({ runId: "run-base" });
  const spec = { ...CeriBaselineComparator.bindBaseline(base, meta), manifestSha256: "0".repeat(64) };
  const res = CeriBaselineComparator.compareRuns(manifest(), A, spec, A, false, { baselineManifest: base });
  assert.equal(res.outcome, "INCOMPARABLE");
});

test("MQ-5: unknown, none, whitespace and malformed model digests are not bound", () => {
  for (const digest of ["unknown", "none", " ", "sha256:abc", `sha256:${"A".repeat(64)}`, ` ${DIGEST_A}`, "md5:" + "a".repeat(32)]) {
    const base = manifest({ runId: "run-base", model: { name: "m", digest, parameters: { temperature: 0, seed: 7 } } });
    const spec = CeriBaselineComparator.bindBaseline(base, meta);
    const res = CeriBaselineComparator.compareRuns(base, A, spec, A, false, { baselineManifest: base });
    assert.equal(res.identityBinding?.status, "UNBOUND", JSON.stringify(digest));
    assert.match(res.identityBinding?.reasons.join(";") ?? "", /model digest not recorded or malformed/, JSON.stringify(digest));
  }
});

test("MQ-5: NaN, null and undefined sampling values are treated as absent, and a missing temperature is unbound", () => {
  const withParams = (parameters: Record<string, unknown>) =>
    manifest({ runId: "run-base", model: { name: "m", digest: DIGEST_A, parameters: parameters as never } });
  const base = withParams({ temperature: 0, topP: undefined });
  const spec = CeriBaselineComparator.bindBaseline(base, meta);
  for (const equal of [{ temperature: 0 }, { temperature: 0, topP: Number.NaN }, { temperature: 0, topP: null }]) {
    const res = CeriBaselineComparator.compareRuns(withParams(equal), A, spec, A, false, { baselineManifest: base });
    assert.equal(res.identityBinding?.status, "IDENTITY_BOUND", JSON.stringify(equal));
  }
  const nanTemp = CeriBaselineComparator.compareRuns(withParams({ temperature: Number.NaN }), A, spec, A, false, { baselineManifest: base });
  assert.equal(nanTemp.identityBinding?.status, "UNBOUND");
  assert.match(nanTemp.identityBinding?.reasons.join(";") ?? "", /sampling temperature not recorded/);
  const differs = CeriBaselineComparator.compareRuns(withParams({ temperature: 0, topP: 0.9 }), A, spec, A, false, { baselineManifest: base });
  assert.match(differs.identityBinding?.reasons.join(";") ?? "", /sampling parameters differ/);
});

test("MQ-5: bindBaseline refuses a manifest that is not finished", () => {
  assert.throws(() => CeriBaselineComparator.bindBaseline(manifest({ status: "RUNNING" }), meta), /finished/);
});

test("MQ-5: the report shows the identity label and reasons beside the non-qualification caveat", () => {
  const base = manifest({ runId: "run-base" });
  const spec = CeriBaselineComparator.bindBaseline(base, meta);
  const bound = CeriBaselineComparator.compareRuns(manifest(), A, spec, A, false, { baselineManifest: base });
  const unbound = CeriBaselineComparator.compareRuns(manifest({ runId: "run-2" }), A, { ...spec, identity: undefined }, A);
  const report = CeriReportGenerator.generateOperationalReport(
    [{ manifest: manifest(), comparison: bound }, { manifest: manifest({ runId: "run-2" }), comparison: unbound }],
    1,
  );
  assert.equal(report.identityBinding?.bound, 1);
  assert.equal(report.identityBinding?.unbound, 1);
  const md = CeriReportGenerator.formatMarkdownReport(report);
  assert.match(md, /IDENTITY_BOUND: 1/);
  assert.match(md, /UNBOUND: 1/);
  assert.match(md, /BASELINE_IDENTITY_UNBOUND/);
  assert.match(md, /local, unsigned identity binding; not external qualification; an attacker who edits manifest, hash and identity together passes/);
});

function runnerDef() {
  return {
    id: "eval-rt",
    version: "1.0.0",
    domain: "code_comprehension" as const,
    objective: "runner integration",
    fixturePath: "eval/fixtures",
    expectedOutputs: [],
    authorizedTools: [],
    executionBudget: { maxSteps: 5, timeoutSeconds: 30 },
    deterministicAssertions: [{ id: "a-1", description: "d", command: "true", expectedExitCode: 0 }],
    independentValidationCriteria: [],
  };
}

const runnerOptions = (store: CeriEvidenceStore) => ({
  model: { name: "m", digest: DIGEST_A, parameters: { temperature: 0 } },
  gatewayUrl: "http://localhost:9200",
  baseCommit: "abcd",
  dirtyWorktree: false,
  evidenceStore: store,
});

test("MQ-5 runner: a bound baseline run is IDENTITY_BOUND; an edited baseline manifest is INCOMPARABLE; a legacy spec stays UNBOUND", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ceri-mq5-"));
  try {
    const store = new CeriEvidenceStore(dir);
    const pass = async () => true;
    const baseRun = await CeriEvaluationRunner.runEvaluation(runnerDef(), runnerOptions(store), pass);
    const onDisk = store.loadManifest("eval-rt", baseRun.manifest.runId)!;
    const spec = CeriBaselineComparator.bindBaseline(onDisk, { baselineId: baseRun.manifest.runId, selectionRationale: "r", establishedAt: onDisk.startedAt });

    const ok = await CeriEvaluationRunner.runEvaluation(runnerDef(), { ...runnerOptions(store), baseline: spec }, pass);
    assert.equal(ok.comparison?.identityBinding?.status, "IDENTITY_BOUND", JSON.stringify(ok.comparison?.identityBinding?.reasons));
    assert.equal(ok.comparison?.outcome, "PASS");

    const legacy = { ...spec, manifestSha256: "hash-001", identity: undefined };
    const leg = await CeriEvaluationRunner.runEvaluation(runnerDef(), { ...runnerOptions(store), baseline: legacy }, pass);
    assert.equal(leg.comparison?.outcome, "PASS");
    assert.equal(leg.comparison?.identityBinding?.status, "UNBOUND");
    assert.match(leg.comparison?.identityBinding?.reasons.join(";") ?? "", /BASELINE_IDENTITY_UNBOUND/);

    const manifestPath = path.join(dir, "eval-rt", baseRun.manifest.runId, "manifest.json");
    const edited = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    edited.model.digest = DIGEST_EVIL;
    fs.writeFileSync(manifestPath, JSON.stringify(edited));
    // Integrity layer (MQ-6): an edit that was not re-recorded is rejected on load, before identity is even compared.
    const tampered = await CeriEvaluationRunner.runEvaluation(runnerDef(), { ...runnerOptions(store), baseline: spec }, pass);
    assert.equal(tampered.comparison?.outcome, "INCOMPARABLE");
    assert.match(tampered.comparison?.incomparabilityReasons?.join(";") ?? "", /HASH_MISMATCH/);
    // Identity layer (MQ-5): once an operator re-records the edited run, the store accepts it and the baseline's bound
    // manifest hash no longer matches.
    store.migrateLegacyRun("eval-rt", baseRun.manifest.runId, "operator re-recorded an edited manifest");
    const rebound = await CeriEvaluationRunner.runEvaluation(runnerDef(), { ...runnerOptions(store), baseline: spec }, pass);
    assert.equal(rebound.comparison?.outcome, "INCOMPARABLE");
    assert.match(rebound.comparison?.incomparabilityReasons?.join(";") ?? "", /BASELINE_MANIFEST_MISMATCH/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MQ-5 runner: an integrity error from the evidence store becomes INCOMPARABLE with the named reason, not an exception", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ceri-mq5-"));
  try {
    const real = new CeriEvidenceStore(dir);
    const base = manifest({ runId: "run-base" });
    const spec = CeriBaselineComparator.bindBaseline(base, meta);
    const store = Object.create(real) as CeriEvidenceStore;
    store.loadManifest = () => {
      const err = new Error("CERI evidence rejected (HASH_MISMATCH): manifest.json does not match its recorded hash");
      err.name = "CeriEvidenceIntegrityError";
      throw err;
    };
    const res = await CeriEvaluationRunner.runEvaluation(
      { ...runnerDef(), id: "eval-1" },
      { ...runnerOptions(store), baseline: spec, baselineAssertions: A },
      async () => true,
    );
    assert.equal(res.comparison?.outcome, "INCOMPARABLE");
    assert.match(res.comparison?.incomparabilityReasons?.join(";") ?? "", /HASH_MISMATCH/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
