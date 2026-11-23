import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { KnowledgeGraph } from "../src/knowledge.js";
import { createManageKnowledgeHandler } from "../src/core/spine_handlers.js";
import { manageKnowledgeCapability } from "../src/core/capability_definitions/knowledge.js";

function temporaryWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-knowledge-memory-"));
}

test("operator promotion carries scope, provenance, validation, and retention metadata", () => {
  const workspace = temporaryWorkspace();
  try {
    const graph = new KnowledgeGraph(workspace, { trusted: true });
    const entry = graph.set("test-command", "Run npm test from cli", "rule", {
      sourceRefs: ["operator-note:reviewed-1"],
      retention: { policy: "until_deleted" },
    });
    assert.equal(entry.scope, "repository");
    assert.deepEqual(entry.provenance, { source: "operator_entry", sourceRefs: ["operator-note:reviewed-1"] });
    assert.equal(entry.validationStatus, "operator_reviewed_unverified");
    assert.deepEqual(entry.retention, { policy: "until_deleted" });
    assert.ok(entry.createdAt && entry.updatedAt);
    assert.match(graph.exportPromptSection(), /unverified memory; not evidence/);
    assert.match(graph.exportPromptSection(), /operator_reviewed_unverified/);
    assert.match(graph.exportPromptSection(), /freshness: unknown; source references are not revalidated/);
    assert.throws(() => graph.set("expired-at-entry", "Rule", "rule", {
      retention: { policy: "expires_at", expiresAt: "2000-01-01T00:00:00.000Z" },
    }), /expiry must be in the future/);
    assert.throws(() => graph.set("bad-reference", "Rule", "rule", { sourceRefs: ["bad\nreference"] }), /provenance references/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("legacy entries migrate additively as unverified and expired entries are not retrieved", () => {
  const workspace = temporaryWorkspace();
  try {
    const nexusDir = path.join(workspace, ".nexus");
    fs.mkdirSync(nexusDir);
    fs.writeFileSync(path.join(nexusDir, "knowledge.json"), JSON.stringify({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      entries: [
        { id: "legacy-1", key: "old", value: "Old memory", category: "rule", confidence: 0.8, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "expired-1", key: "expired", value: "Expired memory", category: "rule", confidence: 0.8, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", scope: "repository", provenance: { source: "operator_entry", sourceRefs: [] }, validationStatus: "operator_reviewed_unverified", retention: { policy: "expires_at", expiresAt: "2000-01-01T00:00:00.000Z" } },
      ],
    }));

    const graph = new KnowledgeGraph(workspace);
    const legacy = graph.get("old");
    assert.equal(legacy?.validationStatus, "legacy_unverified");
    assert.deepEqual(legacy?.provenance, { source: "legacy_import", sourceRefs: [] });
    assert.equal(legacy?.scope, "repository");
    assert.equal(graph.get("expired"), undefined);
    assert.deepEqual(graph.list().map((entry) => entry.key), ["old"]);
    const persisted = JSON.parse(fs.readFileSync(path.join(nexusDir, "knowledge.json"), "utf8"));
    assert.equal(persisted.version, 2);
    assert.equal(persisted.entries.some((entry: any) => entry.key === "expired"), false);
    assert.equal(persisted.entries[0].validationStatus, "legacy_unverified");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("model knowledge adapter denies promotion even when called through its internal handler", async () => {
  const workspace = temporaryWorkspace();
  try {
    const graph = new KnowledgeGraph(workspace);
    const handler = createManageKnowledgeHandler(graph);
    const result = await handler({ action: "set", key: "forged", value: "model assertion" });
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /operator command/);
    assert.equal(graph.get("forged"), undefined);
    assert.equal(fs.existsSync(path.join(workspace, ".nexus", "knowledge.json")), false);
    const actions = (manageKnowledgeCapability.toolDefinition.function.parameters as any).properties.action.enum;
    assert.equal(actions.includes("set"), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
