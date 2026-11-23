import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  assessContextMaturity,
  buildContextInventory,
  buildSessionContextInventory,
  isContextInventorySnapshot,
  inventorySourcesFromMessages,
  markPersistedContextFreshnessUnknown,
  mergeContextInventorySnapshots,
} from "../src/core/context_inventory.js";
import { SessionManager } from "../src/session.js";
import { WorkspacePath } from "../src/core/workspace_path.js";
import { buildSessionExport } from "../src/session_export.js";
import { hasHandler, routeSlash } from "../src/slash/router.js";
import { SLASH_COMMANDS } from "../src/slash/catalog.js";
import { replReadOnlyAllowed } from "../src/repl.js";
import { readOnlySlashAllowed } from "../src/sidecar.js";

const input = (sourceLocation: string, scope: "session" | "repository" = "session", content = "sensitive source text") => ({
  sourceType: "note", sourceLocation, scope, content, trust: "persisted_unverified" as const,
  retention: "session", inclusionReason: "explicit test fixture", retrievalMethod: "fixture",
});

test("inventory has stable source identity, scope isolation, and omits source text", () => {
  const first = buildContextInventory({ capturedAt: "2026-11-22T00:00:00.000Z", sources: [{ name: "notes", status: "ok", durationMs: 3, items: [input("notes:1")] }] });
  const second = buildContextInventory({ capturedAt: "2026-11-23T00:00:00.000Z", sources: [{ name: "notes", status: "ok", durationMs: 3, items: [input("notes:1")] }] });
  const repository = buildContextInventory({ sources: [{ name: "notes", status: "ok", durationMs: 3, items: [input("notes:1", "repository")] }] });
  assert.equal(first.items[0].id, second.items[0].id);
  assert.notEqual(first.items[0].id, repository.items[0].id);
  assert.equal(JSON.stringify(first).includes("sensitive source text"), false);
  assert.equal(first.items[0].freshness, "unknown");
  assert.equal(first.items[0].trust, "persisted_unverified");
});

test("freshness is asserted only with an invalidation rule and is demoted after persistence", () => {
  const snapshot = buildContextInventory({ sources: [{
    name: "live",
    status: "ok",
    durationMs: 1,
    items: [
      { ...input("repo:state", "repository"), freshness: "current", freshnessRule: "live source; invalidate on workspace mutation" },
      { ...input("repo:unbound", "repository"), freshness: "current" },
    ],
  }] });
  assert.equal(snapshot.items[0].freshness, "current");
  assert.equal(snapshot.items[1].freshness, "unknown");
  const restored = markPersistedContextFreshnessUnknown(snapshot);
  assert.equal(restored.items[0].freshness, "unknown");
  assert.match(restored.items[0].freshnessRule!, /requires revalidation/);
  assert.equal(restored.coverage, "partial");
});

test("message provenance retains opaque tool-call references without exposing raw identifiers", () => {
  const rawId = "VERY_SECRET_TOOL_CALL_IDENTIFIER";
  const items = inventorySourcesFromMessages([{ role: "tool", tool_call_id: rawId, content: "tool result" }]);
  const snapshot = buildContextInventory({ sources: [{ name: "messages", status: "ok", durationMs: 1, items }] });
  assert.match(snapshot.items[0].sourceRefs?.[0] ?? "", /^tool-call:[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(snapshot).includes(rawId), false);
});

test("source failures and deterministic inventory limits report incomplete context", () => {
  const snapshot = buildContextInventory({
    maxItems: 1,
    contextLimit: 100,
    sources: [
      { name: "repo", status: "ok", durationMs: 4, items: [input("repo:a", "repository"), input("repo:b", "repository")] },
      { name: "memory", status: "failed", durationMs: 20, items: [], detail: "timed out" },
    ],
  });
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.metrics.omittedItems, 1);
  assert.equal(snapshot.coverage, "partial");
  assert.equal(snapshot.metrics.budgetStatus, "unknown");
  assert.match(snapshot.coverageGaps.join(" "), /partial or unavailable/);
  assert.equal(snapshot.sourceMeasurements.find((item) => item.source === "memory")?.status, "failed");
});

test("merging a saved inventory with archive references stays bounded and reports omissions", () => {
  const make = (prefix: string, count: number) => buildContextInventory({
    sources: [{ name: prefix, status: "ok", durationMs: 1, items: Array.from({ length: count }, (_, index) => input(`${prefix}:${index}`)) }],
  });
  const merged = mergeContextInventorySnapshots(make("saved", 400), make("archive", 200));
  assert.equal(merged.items.length, 500);
  assert.equal(merged.metrics.omittedItems, 100);
  assert.equal(merged.coverage, "partial");
  assert.equal(merged.metrics.budgetStatus, "unknown");
});

test("assessment keeps dimensions separate and reports insufficient evidence", () => {
  const empty = buildContextInventory({ sources: [] });
  const assessment = assessContextMaturity(empty, { hasDurableKnowledge: false, hasActiveSkills: false });
  assert.equal(assessment.dimensions.length, 4);
  assert.equal(assessment.dimensions.find((item) => item.dimension === "navigability")?.level, null);
  assert.equal(assessment.dimensions.find((item) => item.dimension === "retrieval_speed")?.level, null);
  assert.equal(assessment.dimensions.find((item) => item.dimension === "freshness")?.level, null);
  assert.equal(assessment.dimensions.find((item) => item.dimension === "compounding_value")?.level, null);
  assert.equal("overallLevel" in assessment, false);

  const catalogOnly = buildContextInventory({ sources: [{
    name: "knowledge_catalog", status: "ok", durationMs: 1,
    items: [{ ...input("repository:knowledge:1", "repository"), sourceType: "durable_knowledge" }],
  }] });
  assert.equal(assessContextMaturity(catalogOnly, { hasDurableKnowledge: true, hasActiveSkills: false }).dimensions.find((item) => item.dimension === "compounding_value")?.level, 1,
    "a stored memory catalog alone does not establish carried forward use");

  const carried = buildContextInventory({ sources: [{
    name: "session", status: "ok", durationMs: 1,
    items: [{ ...input("session:summary", "session"), sourceType: "compaction_summary" }],
  }] });
  assert.equal(assessContextMaturity(carried, { hasDurableKnowledge: false, hasActiveSkills: false }).dimensions.find((item) => item.dimension === "compounding_value")?.level, 2,
    "a carried compaction summary is observable cross-turn context evidence");
});

test("context command is discoverable and dispatched through the common REPL/TUI route", async () => {
  const spec = SLASH_COMMANDS.find((item) => item.name === "context");
  assert.ok(spec);
  assert.ok(spec.usage.includes("/context inspect"));
  assert.equal(hasHandler("context"), true);
  const outcome = await routeSlash({} as any, "context", "not-a-view", new AbortController().signal);
  assert.equal(outcome.kind, "reply");
  assert.equal(outcome.command, "context");
  assert.equal(outcome.success, false);
  assert.equal(replReadOnlyAllowed("context", "inspect --json"), true);
  assert.equal(replReadOnlyAllowed("context", "inspect --record"), false);
  assert.equal(readOnlySlashAllowed("context", "maturity --json"), true);
  assert.equal(readOnlySlashAllowed("context", "inspect --record"), false);
});

test("context inspection and maturity execute without provider calls and emit parseable evidence", async () => {
  const agent = {
    getMessages: () => [{ role: "user", content: "private prompt text" }],
    getObjective: () => null,
    getActivePlan: () => [],
    getKnowledgeGraph: () => ({ list: () => [] }),
    getSkillManager: () => ({ listSkills: () => [] }),
    getEffectiveTools: () => [],
    getProviderCapabilities: () => null,
    getLastRequestCount: () => undefined,
    getContextBudget: () => ({ contextLimit: 2048 }),
    getTaskId: () => "ctx-task",
  };
  const host = {
    app: {
      getAgent: () => agent,
      getConfig: () => ({ workspace: process.cwd() }),
      getSessionManager: () => ({ loadSession: () => null }),
    },
    sessionId: () => "ctx-session",
  } as any;
  const inspected = await routeSlash(host, "context", "inspect --json", new AbortController().signal);
  assert.equal(inspected.kind, "reply");
  assert.equal(inspected.success, true);
  const snapshot = JSON.parse(inspected.output);
  assert.equal(snapshot.sessionId, "ctx-session");
  assert.equal(snapshot.coverage, "partial");
  assert.equal(JSON.stringify(snapshot).includes("private prompt text"), false);
  assert.equal(snapshot.metrics.tokenSource, "client_estimate");
  const maturity = await routeSlash(host, "context", "maturity --json", new AbortController().signal);
  const assessment = JSON.parse(maturity.output);
  assert.equal(assessment.basis, "deterministic_client_evidence");
  assert.equal(assessment.dimensions.length, 4);

  const durableHost = {
    ...host,
    app: {
      ...host.app,
      getSessionManager: () => ({ loadSession: () => ({ durableNotes: ["VERY_SECRET_NOTE_CONTENT"], compactionProvenance: { recordId: "compact-2", predecessorIds: ["history-3"], summaryContent: "summary" } }) }),
    },
  };
  const durable = await routeSlash(durableHost, "context", "inspect --json", new AbortController().signal);
  const durableSnapshot = JSON.parse(durable.output);
  assert.ok(durableSnapshot.items.some((item: any) => item.sourceType === "durable_note"));
  assert.ok(durableSnapshot.items.some((item: any) => item.sourceRefs?.includes("history-3")));
  assert.equal(JSON.stringify(durableSnapshot).includes("VERY_SECRET_NOTE_CONTENT"), false);
});

test("session save, resume, compaction, and export retain source references without promoting memory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-context-inventory-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const manager = new SessionManager(path.join(root, "sessions"), () => WorkspacePath.fromSelectedWorkspace(workspace));
  try {
    const compactionProvenance = { recordId: "compact-1", predecessorIds: ["history-1", "history-2"], summaryContent: "summary claim" };
    manager.saveSession({
      id: "ctx-session", workspace, messages: [
        { role: "system", content: "[Structured Context Memory - durable task state] summary claim" },
        { role: "user", content: "original objective" },
      ],
      durableNotes: ["remembered but unverified"], compactionProvenance,
    } as any);
    const resumed = manager.loadSession("ctx-session")!;
    assert.ok(isContextInventorySnapshot(resumed.contextInventory));
    const provenance = resumed.contextInventory!.items.find((item) => item.sourceType === "compaction_provenance");
    assert.deepEqual(provenance?.sourceRefs, ["compact-1", "history-1", "history-2"]);
    assert.equal(resumed.contextInventory!.items.find((item) => item.sourceType === "durable_note")?.trust, "persisted_unverified");

    const archiveMessages = [{ role: "assistant", content: "archived answer" }];
    const exported = buildSessionExport({ readArchivedHistory: () => ({ messages: archiveMessages, unreadableLines: 0 }) } as any, resumed as any);
    const exportInventory = (exported.json as any).contextInventory;
    assert.ok(exportInventory.items.some((item: any) => item.sourceLocation.startsWith("archive:message:")));
    assert.ok(exportInventory.items.some((item: any) => item.sourceRefs?.includes("history-1")));
    assert.match(exported.markdown, /Context inventory \(source references; content omitted\)/);
    assert.equal(JSON.stringify(exported.json.contextInventory).includes("remembered but unverified"), false);

    const malformed = { ...exportInventory, schemaVersion: 999 };
    const merged = mergeContextInventorySnapshots(resumed.contextInventory!, malformed as any);
    assert.equal(merged.items.some((item) => item.sourceRefs?.includes("history-1")), true);

    const liveInventory = buildContextInventory({
      sessionId: "ctx-live",
      workspace,
      sources: [{ name: "repository", status: "ok", durationMs: 1, items: [{
        ...input("repository:status", "repository"),
        freshness: "current",
        freshnessRule: "live at capture; invalidate after workspace changes",
      }] }],
    });
    manager.saveSession({ id: "ctx-live", workspace, messages: [], contextInventory: liveInventory } as any);
    const restoredLive = manager.loadSession("ctx-live")!;
    assert.equal(restoredLive.contextInventory?.items[0].freshness, "unknown");
    assert.match(restoredLive.contextInventory?.items[0].freshnessRule ?? "", /requires revalidation/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
