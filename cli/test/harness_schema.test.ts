import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateHarnessManifest, validateHirRun, validateHirTaskSuite } from "../src/core/harness/schema.js";

describe("harness schema", () => {
  it("accepts a valid manifest", () => {
    const manifest = {
      schemaVersion: 1,
      id: "harn_123",
      createdAt: "2026-11-26T00:00:00.000Z",
      source: { kind: "path", ref: "/tmp/base" },
      components: [{ kind: "system_prompt", path: "SYSTEM.md", contentHash: "abc", bytes: 10, mutable: true }],
    };
    assert.equal(validateHarnessManifest(manifest).ok, true);
  });

  it("rejects path escape in manifest component", () => {
    const manifest = {
      schemaVersion: 1,
      id: "harn_123",
      createdAt: "2026-11-26T00:00:00.000Z",
      source: { kind: "path", ref: "/tmp/base" },
      components: [{ kind: "system_prompt", path: "../escape.md", contentHash: "abc", bytes: 10, mutable: true }],
    };
    const res = validateHarnessManifest(manifest);
    assert.equal(res.ok, false);
  });

  it("accepts a valid task suite", () => {
    const suite = {
      schemaVersion: 1,
      id: "suite_1",
      cases: [{ id: "case1", description: "d", prompt: "p" }],
    };
    assert.equal(validateHirTaskSuite(suite).ok, true);
  });

  it("rejects duplicate case ids", () => {
    const suite = {
      schemaVersion: 1,
      id: "suite_1",
      cases: [{ id: "case1", description: "d", prompt: "p" }, { id: "case1", description: "d2", prompt: "p2" }],
    };
    assert.equal(validateHirTaskSuite(suite).ok, false);
  });

  it("accepts a valid run", () => {
    const run = {
      schemaVersion: 1,
      id: "hir_123",
      status: "CREATED",
      createdAt: "2026-11-26T00:00:00.000Z",
      updatedAt: "2026-11-26T00:00:00.000Z",
      baseHarnessId: "harn_123",
      taskSuiteRef: "suite_1",
      budgets: { maxRounds: 1, maxCandidatesPerRound: 2, maxProbes: 4, maxWallClockMs: 60000, maxProbeWallClockMs: 30000, maxConcurrentProbes: 1 },
      policy: { allowLiveProfileMutation: false, allowRepoMutation: false, allowNetwork: false, redactSecrets: true, approvalModePinned: "pinned" },
      rounds: [],
      candidateIds: [],
      probeIds: [],
      evidenceIds: [],
      actualUsage: { probes: 0, wallClockMs: 0, tokens: 0 },
    };
    assert.equal(validateHirRun(run).ok, true);
  });

  it("rejects run with live mutation allowed", () => {
    const run = {
      schemaVersion: 1,
      id: "hir_123",
      status: "CREATED",
      createdAt: "2026-11-26T00:00:00.000Z",
      updatedAt: "2026-11-26T00:00:00.000Z",
      baseHarnessId: "harn_123",
      taskSuiteRef: "suite_1",
      budgets: { maxRounds: 1, maxCandidatesPerRound: 2, maxProbes: 4, maxWallClockMs: 60000, maxProbeWallClockMs: 30000, maxConcurrentProbes: 1 },
      policy: { allowLiveProfileMutation: true, allowRepoMutation: false, allowNetwork: false, redactSecrets: true, approvalModePinned: "pinned" },
      rounds: [],
      candidateIds: [],
      probeIds: [],
      evidenceIds: [],
      actualUsage: { probes: 0, wallClockMs: 0, tokens: 0 },
    };
    assert.equal(validateHirRun(run).ok, false);
  });
});
