import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CeriEvidenceStore, CeriEvidenceIntegrityError } from "../src/ceri/evidence_store.js";
import type { RunManifest } from "../src/ceri/contracts.js";

function manifest(runId: string): RunManifest {
  return {
    runId,
    evaluationId: "eval-1",
    evaluationVersion: "1.0.0",
    sourceCommit: "abcd",
    dirtyWorktree: false,
    model: { name: "m", parameters: { temperature: 0 } },
    routingConfig: { gatewayUrl: "http://localhost", specialistRouting: false },
    agentProfileVersion: "1.1.2",
    harnessVersion: "1.1.2",
    toolchainVersions: {},
    environment: { os: "Linux", kernel: "x", nodeVersion: "22" },
    hardware: { cpuModel: "Intel", totalMemoryBytes: 1000 },
    startedAt: new Date().toISOString(),
    status: "RUNNING",
    mandatoryComparabilityKeys: [],
  };
}

function withStore(fn: (store: CeriEvidenceStore, dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ceri-mq6-"));
  try {
    fn(new CeriEvidenceStore(dir), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function finalized(store: CeriEvidenceStore, runId: string, assertions: Record<string, unknown>[]): string {
  const runDir = store.initRun(manifest(runId));
  store.recordAssertions(assertions);
  store.finalizeRun("COMPLETED", "ok");
  return runDir;
}

test("MQ-6 round trip: a finalized run loads its assertions and manifest", () => {
  withStore((store) => {
    finalized(store, "r1", [{ id: "a", passed: true }, { id: "b", passed: false }]);
    assert.deepEqual(store.loadAssertions("eval-1", "r1"), { a: true, b: false });
    assert.equal(store.loadManifest("eval-1", "r1")?.status, "COMPLETED");
    assert.deepEqual(store.verifyRun("eval-1", "r1"), { ok: true });
    assert.equal(store.loadAssertions("eval-1", "absent"), undefined);
  });
});

test("MQ-6 defect 1: passed:\"false\" (string) does not load as true", () => {
  withStore((store) => {
    finalized(store, "r1", [{ id: "a", passed: "false" }]);
    assert.throws(() => store.loadAssertions("eval-1", "r1"), /NON_BOOLEAN_PASSED/);
  });
  withStore((store, dir) => {
    const runDir = finalized(store, "r1", [{ id: "a", passed: true }]);
    fs.writeFileSync(path.join(runDir, "assertions.json"), JSON.stringify({ a: "false" }));
    assert.throws(() => store.loadAssertions("eval-1", "r1"), CeriEvidenceIntegrityError);
    void dir;
  });
});

test("MQ-6 defect 2: a second run with an existing id is refused and never overwrites", () => {
  withStore((store) => {
    const runDir = finalized(store, "r1", [{ id: "a", passed: true }]);
    const before = fs.readFileSync(path.join(runDir, "manifest.json"), "utf-8");
    assert.throws(() => store.initRun(manifest("r1")), /already exists/);
    assert.equal(fs.readFileSync(path.join(runDir, "manifest.json"), "utf-8"), before);
    assert.deepEqual(store.loadAssertions("eval-1", "r1"), { a: true });
  });
});

test("MQ-6 defect 3: tampered or hash-mismatched records are rejected on load with a named reason", () => {
  const cases: Array<[string, (runDir: string) => void, RegExp]> = [
    ["edited assertions", (d) => fs.writeFileSync(path.join(d, "assertions.json"), JSON.stringify([{ id: "a", passed: false }])), /HASH_MISMATCH/],
    ["extra file", (d) => fs.writeFileSync(path.join(d, "extra.json"), "{}"), /FILE_SET_MISMATCH/],
    ["deleted integrity record", (d) => fs.rmSync(path.join(d, "integrity.json")), /INTEGRITY_MISSING/],
    ["corrupt integrity record", (d) => fs.writeFileSync(path.join(d, "integrity.json"), "{not json"), /INTEGRITY_UNREADABLE/],
    [
      "forged composite",
      (d) => {
        const p = path.join(d, "integrity.json");
        const rec = JSON.parse(fs.readFileSync(p, "utf-8"));
        rec.compositeSha256 = "0".repeat(64);
        fs.writeFileSync(p, JSON.stringify(rec));
      },
      /COMPOSITE_MISMATCH/,
    ],
    [
      "record for another run",
      (d) => {
        const p = path.join(d, "integrity.json");
        const rec = JSON.parse(fs.readFileSync(p, "utf-8"));
        rec.runId = "other";
        fs.writeFileSync(p, JSON.stringify(rec));
      },
      /RUN_ID_MISMATCH/,
    ],
  ];
  for (const [name, tamper, reason] of cases) {
    withStore((store) => {
      const runDir = finalized(store, "r1", [{ id: "a", passed: true }]);
      tamper(runDir);
      assert.throws(() => store.loadAssertions("eval-1", "r1"), reason, `${name}: loadAssertions`);
      assert.throws(() => store.loadManifest("eval-1", "r1"), reason, `${name}: loadManifest`);
      assert.equal(store.verifyRun("eval-1", "r1").ok, false, name);
    });
  }
});
