import test from "node:test";
import assert from "node:assert/strict";
import { CeriBaselineComparator } from "../src/ceri/baseline.js";
import type { RunManifest } from "../src/ceri/contracts.js";

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: "run-1",
    evaluationId: "eval-1",
    evaluationVersion: "1.0.0",
    sourceCommit: "abcd",
    dirtyWorktree: false,
    model: { name: "m", digest: "sha256:aaa", parameters: { temperature: 0, seed: 7 } },
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
  assert.equal(spec.identity?.model.digest, "sha256:aaa");
  assert.deepEqual(spec.identity?.sampling, { temperature: 0, seed: 7 });
  assert.match(spec.identity?.configurationSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(spec.identity?.evaluatorVersion, "1.2.1");
  assert.deepEqual(spec.identity?.toolchainVersions, { node: "22.0.0" });
  assert.equal(spec.manifestSha256, CeriBaselineComparator.manifestSha256(base));
  assert.equal(spec.manifestSha256, CeriBaselineComparator.manifestSha256(JSON.parse(JSON.stringify(base))));
});

test("MQ-5: both bound and matching is CERTIFYING and records both identities", () => {
  const base = manifest({ runId: "run-base" });
  const spec = CeriBaselineComparator.bindBaseline(base, meta);
  const res = CeriBaselineComparator.compareRuns(manifest(), A, spec, A, false, { baselineManifest: base });
  assert.equal(res.outcome, "PASS");
  assert.equal(res.certification?.status, "CERTIFYING");
  assert.deepEqual(res.certification?.reasons, []);
  assert.deepEqual(res.certification?.baselineIdentity, spec.identity);
  assert.equal(res.certification?.currentIdentity.model.digest, "sha256:aaa");
});

test("MQ-5: missing or unbound identity is NON_CERTIFYING with a reason", () => {
  const base = manifest({ runId: "run-base" });
  const spec = CeriBaselineComparator.bindBaseline(base, meta);
  const legacy = { ...spec, identity: undefined };
  const r1 = CeriBaselineComparator.compareRuns(manifest(), A, legacy, A);
  assert.equal(r1.certification?.status, "NON_CERTIFYING");
  assert.match(r1.certification?.reasons.join(";") ?? "", /identity not recorded/);

  const r2 = CeriBaselineComparator.compareRuns(manifest(), A, spec, A);
  assert.equal(r2.certification?.status, "NON_CERTIFYING");
  assert.match(r2.certification?.reasons.join(";") ?? "", /baseline manifest not supplied/);

  const noDigestBase = manifest({ runId: "run-base", model: { name: "m", parameters: { temperature: 0, seed: 7 } } });
  const noDigestSpec = CeriBaselineComparator.bindBaseline(noDigestBase, meta);
  const r3 = CeriBaselineComparator.compareRuns(manifest(), A, noDigestSpec, A, false, { baselineManifest: noDigestBase });
  assert.equal(r3.certification?.status, "NON_CERTIFYING");
  assert.match(r3.certification?.reasons.join(";") ?? "", /model digest not recorded/);
});

test("MQ-5: a bound identity that differs from the current run is NON_CERTIFYING", () => {
  const base = manifest({ runId: "run-base" });
  const spec = CeriBaselineComparator.bindBaseline(base, meta);
  for (const [name, current, pattern] of [
    ["digest", manifest({ model: { name: "m", digest: "sha256:bbb", parameters: { temperature: 0, seed: 7 } } }), /model digest/],
    ["sampling", manifest({ model: { name: "m", digest: "sha256:aaa", parameters: { temperature: 0.7, seed: 7 } } }), /sampling/],
    ["configuration", manifest({ routingConfig: { gatewayUrl: "http://other", specialistRouting: true } }), /configuration/],
    ["evaluator", manifest({ harnessVersion: "9.9.9" }), /evaluator version/],
    ["toolchain", manifest({ toolchainVersions: { node: "20.0.0" } }), /toolchain/],
  ] as const) {
    const res = CeriBaselineComparator.compareRuns(current, A, spec, A, false, { baselineManifest: base });
    assert.equal(res.certification?.status, "NON_CERTIFYING", name);
    assert.match(res.certification?.reasons.join(";") ?? "", pattern, name);
  }
});

test("MQ-5: comparing against an edited or swapped baseline manifest fails", () => {
  const base = manifest({ runId: "run-base" });
  const spec = CeriBaselineComparator.bindBaseline(base, meta);

  const swapped = manifest({ runId: "run-base", model: { name: "m", digest: "sha256:evil", parameters: { temperature: 0, seed: 7 } } });
  const r1 = CeriBaselineComparator.compareRuns(manifest(), A, spec, A, false, { baselineManifest: swapped });
  assert.equal(r1.outcome, "INCOMPARABLE");
  assert.equal(r1.isEligibleForComparison, false);
  assert.equal(r1.certification?.status, "NON_CERTIFYING");
  assert.match(r1.incomparabilityReasons?.join(";") ?? "", /BASELINE_MANIFEST_MISMATCH/);

  const editedSpec = { ...spec, identity: { ...spec.identity!, sampling: { temperature: 0.9 } } };
  const r2 = CeriBaselineComparator.compareRuns(manifest(), A, editedSpec, A, false, { baselineManifest: base });
  assert.equal(r2.outcome, "INCOMPARABLE");
  assert.match(r2.incomparabilityReasons?.join(";") ?? "", /BASELINE_IDENTITY_MISMATCH/);
});
