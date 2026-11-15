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

test("MQ-6: a directory or symlink inside a run is FILE_SET_MISMATCH, not a raw filesystem error", () => {
  withStore((store) => {
    const runDir = finalized(store, "r1", [{ id: "a", passed: true }]);
    fs.mkdirSync(path.join(runDir, "sub"));
    assert.throws(() => store.loadAssertions("eval-1", "r1"), /FILE_SET_MISMATCH/);
    assert.equal(store.verifyRun("eval-1", "r1").ok, false);
  });
  withStore((store, dir) => {
    const runDir = finalized(store, "r1", [{ id: "a", passed: true }]);
    fs.symlinkSync(path.join(dir, "eval-1", "r1", "manifest.json"), path.join(runDir, "link.json"));
    assert.throws(() => store.loadManifest("eval-1", "r1"), /FILE_SET_MISMATCH/);
  });
  withStore((store, dir) => {
    const runDir = finalized(store, "r1", [{ id: "a", passed: true }]);
    const outside = path.join(dir, "outside.json");
    fs.writeFileSync(outside, "[]");
    fs.rmSync(path.join(runDir, "assertions.json"));
    fs.symlinkSync(outside, path.join(runDir, "assertions.json"));
    assert.throws(() => store.loadAssertions("eval-1", "r1"), CeriEvidenceIntegrityError);
  });
});

test("MQ-6: map-form assertions load strictly", () => {
  withStore((store) => {
    const runDir = finalized(store, "r1", [{ id: "a", passed: true }]);
    const rewrite = (data: unknown) => {
      fs.writeFileSync(path.join(runDir, "assertions.json"), JSON.stringify(data));
      store.migrateLegacyRun("eval-1", "r1", "test rewrite");
    };
    rewrite({ a: true, b: false });
    assert.deepEqual(store.loadAssertions("eval-1", "r1"), { a: true, b: false });
  });
  withStore((store) => {
    const runDir = finalized(store, "r1", [{ id: "a", passed: true }]);
    fs.writeFileSync(path.join(runDir, "assertions.json"), JSON.stringify({ a: 1 }));
    assert.throws(() => store.migrateLegacyRun("eval-1", "r1", "x"), /NON_BOOLEAN_PASSED/);
  });
});

test("MQ-6: a crash between initRun and finalizeRun is recoverable with abandonRun, which never deletes", () => {
  withStore((store, dir) => {
    const runDir = store.initRun(manifest("r1"));
    store.appendEvent({ type: "RUN_STARTED" });
    assert.throws(() => store.loadManifest("eval-1", "r1"), /INTEGRITY_MISSING.*abandonRun/);
    assert.throws(() => store.initRun(manifest("r1")), /abandonRun/);
    assert.deepEqual(store.detectInterruptedRuns(), ["r1"]);

    const moved = store.abandonRun("eval-1", "r1");
    assert.match(path.basename(moved), /^r1\.abandoned-\d+$/);
    assert.equal(fs.existsSync(runDir), false);
    assert.ok(fs.existsSync(path.join(moved, "events.jsonl")), "evidence is kept");
    assert.deepEqual(store.detectInterruptedRuns(), []);

    finalized(store, "r1", [{ id: "a", passed: true }]);
    assert.deepEqual(store.loadAssertions("eval-1", "r1"), { a: true });
    void dir;
  });
});

test("MQ-6: abandonRun refuses a finalized run and an unknown run", () => {
  withStore((store) => {
    finalized(store, "r1", [{ id: "a", passed: true }]);
    assert.throws(() => store.abandonRun("eval-1", "r1"), /finalized/);
    assert.throws(() => store.abandonRun("eval-1", "nope"), /no run/);
  });
});

test("MQ-6 legacy: a pre-integrity run is rejected, and migrateLegacyRun writes a new marked record without losing the original", () => {
  withStore((store, dir) => {
    const runDir = path.join(dir, "eval-1", "legacy");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest("legacy")));
    const legacyAssertions = JSON.stringify([{ id: "a", passed: "false" }, { id: "b", passed: true }]);
    fs.writeFileSync(path.join(runDir, "assertions.json"), legacyAssertions);
    fs.writeFileSync(path.join(runDir, "integrity.json"), JSON.stringify({ runId: "[REDACTED:HIGH_ENTROPY_STRING]", fileHashes: {}, compositeSha256: "x" }));

    assert.throws(() => store.loadAssertions("eval-1", "legacy"), /RUN_ID_MISMATCH.*migrateLegacyRun/);
    assert.throws(() => store.migrateLegacyRun("eval-1", "legacy", "  "), /reason/);

    const result = store.migrateLegacyRun("eval-1", "legacy", "v1.1.x evidence, redacted integrity record");
    assert.equal(result.runDir, runDir);
    assert.deepEqual(store.loadAssertions("eval-1", "legacy"), { a: false, b: true });
    assert.deepEqual(store.verifyRun("eval-1", "legacy"), { ok: true, migrated: true });

    const record = JSON.parse(fs.readFileSync(path.join(runDir, "integrity.json"), "utf-8"));
    assert.equal(record.migrated, true);
    assert.equal(record.migrationReason, "v1.1.x evidence, redacted integrity record");
    assert.deepEqual(record.normalizedAssertions, ["a"]);
    const kept = fs.readdirSync(runDir);
    assert.ok(kept.some((f) => f.startsWith("assertions.pre-migration-")));
    assert.ok(kept.some((f) => f.startsWith("integrity.pre-migration-")));
    const orig = kept.find((f) => f.startsWith("assertions.pre-migration-"))!;
    assert.equal(fs.readFileSync(path.join(runDir, orig), "utf-8"), legacyAssertions);
  });
});

test("MQ-6 legacy: migration refuses a verified run and unrecoverable string values", () => {
  withStore((store) => {
    finalized(store, "r1", [{ id: "a", passed: true }]);
    assert.throws(() => store.migrateLegacyRun("eval-1", "r1", "why"), /already verifies/);
  });
  withStore((store, dir) => {
    const runDir = path.join(dir, "eval-1", "legacy");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "assertions.json"), JSON.stringify([{ id: "a", passed: "maybe" }]));
    assert.throws(() => store.migrateLegacyRun("eval-1", "legacy", "why"), /NON_BOOLEAN_PASSED/);
    assert.equal(fs.existsSync(path.join(runDir, "integrity.json")), false);
  });
});
