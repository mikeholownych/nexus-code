import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CeriEvidenceStore } from "../src/ceri/evidence_store.js";
import type { RunManifest } from "../src/ceri/contracts.js";

test("CeriEvidenceStore initializes run, appends events, redacts secrets, and computes integrity hash", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ceri-evidence-"));
  try {
    const store = new CeriEvidenceStore(tmpDir);

    const manifest: RunManifest = {
      runId: "run-001",
      evaluationId: "eval-ast",
      evaluationVersion: "1.0.0",
      sourceCommit: "abcd1234abcd1234abcd1234abcd1234abcd1234",
      dirtyWorktree: false,
      model: {
        name: "test-model",
        parameters: { temperature: 0.0 },
      },
      routingConfig: {
        gatewayUrl: "http://localhost:9200",
        specialistRouting: true,
      },
      agentProfileVersion: "1.1.2",
      harnessVersion: "1.1.2",
      toolchainVersions: { node: "22.0.0" },
      environment: { os: "Linux", kernel: "6.8.0", nodeVersion: "22.0.0" },
      hardware: { cpuModel: "Intel", totalMemoryBytes: 32000000000 },
      startedAt: new Date().toISOString(),
      status: "RUNNING",
      mandatoryComparabilityKeys: ["evaluationId", "evaluationVersion", "model.name"],
    };

    const runDir = store.initRun(manifest);
    assert.ok(fs.existsSync(path.join(runDir, "manifest.json")));

    // Append event with a secret
    store.appendEvent({
      action: "call_tool",
      apiKey: "sk-ant-api03-abcdef1234567890abcdef1234567890",
      payload: "safe data",
    });

    // Record assertions
    store.recordAssertions([{ assertionId: "a1", passed: true }]);

    // Finalize run
    const finalized = store.finalizeRun("COMPLETED", "All checks passed");
    assert.ok(finalized.integrityHash);
    assert.equal(finalized.runDir, runDir);

    // Verify secrets are redacted in events.jsonl
    const eventsContent = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf-8");
    assert.ok(!eventsContent.includes("sk-ant-api03"));
    assert.ok(eventsContent.includes("[REDACTED"));

    // Verify integrity.json was written
    const integrityContent = JSON.parse(
      fs.readFileSync(path.join(runDir, "integrity.json"), "utf-8")
    );
    assert.equal(integrityContent.compositeSha256, finalized.integrityHash);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("CeriEvidenceStore detects interrupted runs", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ceri-interrupted-"));
  try {
    const store = new CeriEvidenceStore(tmpDir);

    const manifest: RunManifest = {
      runId: "run-crashed",
      evaluationId: "eval-crash",
      evaluationVersion: "1.0.0",
      sourceCommit: "abcd",
      dirtyWorktree: false,
      model: { name: "model-x", parameters: { temperature: 0 } },
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

    store.initRun(manifest);
    // Simulate process crash: finalizeRun is NOT called

    const interrupted = store.detectInterruptedRuns();
    assert.deepEqual(interrupted, ["run-crashed"]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("CeriEvidenceStore rejects path traversal in evaluationId and runId", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ceri-traversal-"));
  try {
    const store = new CeriEvidenceStore(tmpDir);

    const baseManifest: RunManifest = {
      runId: "run-01",
      evaluationId: "eval-01",
      evaluationVersion: "1.0.0",
      sourceCommit: "abcd",
      dirtyWorktree: false,
      model: { name: "model-x", parameters: { temperature: 0 } },
      routingConfig: { gatewayUrl: "http://localhost", specialistRouting: false },
      agentProfileVersion: "1.1.2",
      harnessVersion: "1.1.2-rc.1",
      toolchainVersions: {},
      environment: { os: "Linux", kernel: "x", nodeVersion: "22" },
      hardware: { cpuModel: "Intel", totalMemoryBytes: 1000 },
      startedAt: new Date().toISOString(),
      status: "RUNNING",
      mandatoryComparabilityKeys: [],
    };

    assert.throws(
      () => store.initRun({ ...baseManifest, evaluationId: "../../etc" }),
      /contains invalid characters or path traversal elements/
    );

    assert.throws(
      () => store.initRun({ ...baseManifest, runId: "sub/../../escape" }),
      /contains invalid characters or path traversal elements/
    );

    // "." would collapse into the parent directory (a run written into the evaluation directory itself).
    assert.throws(
      () => store.initRun({ ...baseManifest, runId: "." }),
      /contains invalid characters or path traversal elements/
    );
    assert.throws(
      () => store.initRun({ ...baseManifest, evaluationId: " . " }),
      /contains invalid characters or path traversal elements/
    );

    assert.throws(
      () => store.loadAssertions("../etc", "run-01"),
      /contains invalid characters or path traversal elements/
    );

    assert.throws(
      () => store.loadManifest("eval-01", "../escape"),
      /contains invalid characters or path traversal elements/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
