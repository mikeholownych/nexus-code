import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  assessContextMaturity,
  buildContextInventory,
  buildInferenceContextManifest,
  buildSessionContextInventory,
  compareWorkspaceState,
  isInferenceContextManifest,
  isContextInventorySnapshot,
  inventorySourcesFromMessages,
  markInterruptedInferenceManifestsUnknown,
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
import { AutonomousAgent } from "../src/agent.js";
import { calculateContextBudget } from "../src/tokens.js";
import { inspectWorkspaceGitSafety } from "../src/core/workspace_git_safety.js";

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
  const malformedVersion = buildContextInventory({ sources: [{ name: "versioned", status: "ok", durationMs: 1, items: [{
    ...input("memory:1"), sourceVersion: "`untrusted\nmarker`",
  }] }] });
  assert.equal(malformedVersion.items[0].sourceVersion, undefined, "untrusted version labels are omitted from diagnostics");
  assert.equal(isContextInventorySnapshot(malformedVersion), true);
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

test("workspace fingerprints detect changed repository state and retain only stale repository references", () => {
  const prior = buildContextInventory({
    workspaceState: { fingerprint: "a".repeat(64), comparison: "no_previous_capture", invalidatedRepositoryItemIds: [] },
    sources: [{ name: "repository", status: "ok", durationMs: 1, items: [{ ...input("repository:doc", "repository"), freshness: "current", freshnessRule: "bound to captured workspace state" }] }],
  });
  const changed = compareWorkspaceState(prior, "b".repeat(64));
  assert.equal(changed.comparison, "changed");
  assert.deepEqual(changed.invalidatedRepositoryItemIds, [prior.items[0].id]);
  const current = buildContextInventory({ workspaceState: changed, sources: [] });
  assert.equal(current.workspaceState?.fingerprint, "b".repeat(64));
  assert.match(current.coverageGaps.join("\n"), /workspace state changed/);
  assert.equal(current.coverage, "partial");
  assert.equal(isContextInventorySnapshot(current), true);
  assert.equal(compareWorkspaceState(prior, "a".repeat(64)).comparison, "unchanged");
  assert.equal(compareWorkspaceState(prior, undefined).comparison, "unavailable");
  assert.equal(compareWorkspaceState(undefined, "c".repeat(64)).comparison, "no_previous_capture");
  const legacy = buildContextInventory({ sources: [{ name: "repository", status: "ok", durationMs: 1, items: [input("repository:legacy", "repository")] }] });
  const legacyComparison = compareWorkspaceState(legacy, "d".repeat(64));
  assert.equal(legacyComparison.comparison, "previous_capture_unversioned");
  assert.deepEqual(legacyComparison.invalidatedRepositoryItemIds, [legacy.items[0].id]);
});

test("agent workspace fingerprint is bounded by candidate limits and returns unknown on failure", () => {
  const agent: any = Object.create(AutonomousAgent.prototype);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-context-bounded-fingerprint-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "config", "user.email", "context-test@example.invalid"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Context Test"]);
    fs.writeFileSync(path.join(root, "README.md"), "bounded fixture\n");
    execFileSync("git", ["-C", root, "add", "README.md"]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "baseline"]);
    Object.assign(agent, { config: { workspace: root } });
    assert.match(agent.getWorkspaceContextFingerprint(), /^[a-f0-9]{64}$/);
    agent.config.workspace = path.join(os.tmpdir(), `missing-context-workspace-${process.pid}`);
    assert.equal(agent.getWorkspaceContextFingerprint(), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace candidate fingerprint changes when tracked repository content changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-context-fingerprint-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "config", "user.email", "context-test@example.invalid"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Context Test"]);
    fs.writeFileSync(path.join(root, "README.md"), "before\n");
    execFileSync("git", ["-C", root, "add", "README.md"]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "baseline"]);
    const agent: any = Object.create(AutonomousAgent.prototype);
    Object.assign(agent, { config: { workspace: root } });
    const before = agent.getWorkspaceContextFingerprint();
    assert.match(before, /^[a-f0-9]{64}$/);
    assert.equal(agent.getWorkspaceContextFingerprint(), before);
    fs.writeFileSync(path.join(root, "README.md"), "after\n");
    assert.notEqual(agent.getWorkspaceContextFingerprint(), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("context fingerprint refuses a configured clean filter without running it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-context-clean-filter-"));
  const marker = path.join(root, "filter-ran");
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "config", "user.email", "context-test@example.invalid"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Context Test"]);
    fs.writeFileSync(path.join(root, ".gitattributes"), "tracked.txt filter=hostile\n");
    fs.writeFileSync(path.join(root, "tracked.txt"), "baseline\n");
    execFileSync("git", ["-C", root, "add", ".gitattributes", "tracked.txt"]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "baseline"]);
    fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n");
    execFileSync("git", ["-C", root, "config", "filter.hostile.clean", `touch '${marker}'`]);

    assert.deepEqual(inspectWorkspaceGitSafety(root), { safe: false, reason: "program_settings_present" });
    const agent: any = Object.create(AutonomousAgent.prototype);
    Object.assign(agent, { config: { workspace: root } });
    assert.deepEqual(agent.getWorkspaceContextFingerprintResult(), { unavailableReason: "program_settings_present" });
    assert.equal(fs.existsSync(marker), false, "fingerprinting must not invoke the configured clean filter");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("context fingerprint refuses fsmonitor and included Git configuration before invoking commands", () => {
  for (const unsafeSetting of ["fsmonitor", "include"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `nexus-context-${unsafeSetting}-`));
    const marker = path.join(root, "program-ran");
    try {
      execFileSync("git", ["init", "-q", root]);
      const config = path.join(root, ".git", "config");
      if (unsafeSetting === "fsmonitor") {
        fs.appendFileSync(config, `\n[core]\n\tfsmonitor = !touch '${marker}'\n`);
      } else {
        const included = path.join(root, "included-git-config");
        fs.writeFileSync(included, `[core]\n\tfsmonitor = !touch '${marker}'\n`);
        fs.appendFileSync(config, `\n[include]\n\tpath = ${included}\n`);
      }

      const agent: any = Object.create(AutonomousAgent.prototype);
      Object.assign(agent, { config: { workspace: root } });
      const result = agent.getWorkspaceContextFingerprintResult();
      assert.equal(result.fingerprint, undefined);
      assert.ok(result.unavailableReason === "program_settings_present");
      assert.equal(fs.existsSync(marker), false, `${unsafeSetting} configuration must not execute`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("context fingerprint refuses a global clean filter used by workspace attributes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-context-global-filter-"));
  const marker = path.join(root, "global-filter-ran");
  const globalConfig = path.join(root, "global-git-config");
  const priorGlobal = process.env.GIT_CONFIG_GLOBAL;
  const priorNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "config", "user.email", "context-test@example.invalid"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Context Test"]);
    fs.writeFileSync(path.join(root, ".gitattributes"), "tracked.txt filter=hostile\n");
    fs.writeFileSync(path.join(root, "tracked.txt"), "baseline\n");
    execFileSync("git", ["-C", root, "add", ".gitattributes", "tracked.txt"]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "baseline"]);
    fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n");
    fs.writeFileSync(globalConfig, `[filter "hostile"]\n\tclean = touch '${marker}'\n`);
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    process.env.GIT_CONFIG_NOSYSTEM = "1";

    const agent: any = Object.create(AutonomousAgent.prototype);
    Object.assign(agent, { config: { workspace: root } });
    assert.deepEqual(agent.getWorkspaceContextFingerprintResult(), { unavailableReason: "program_settings_present" });
    assert.equal(fs.existsSync(marker), false, "a repository attribute must not activate a configured global filter");
  } finally {
    if (priorGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = priorGlobal;
    if (priorNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = priorNoSystem;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("message provenance retains opaque tool-call references without exposing raw identifiers", () => {
  const rawId = "VERY_SECRET_TOOL_CALL_IDENTIFIER";
  const items = inventorySourcesFromMessages([{ role: "tool", tool_call_id: rawId, content: "tool result" }]);
  const snapshot = buildContextInventory({ sources: [{ name: "messages", status: "ok", durationMs: 1, items }] });
  assert.match(snapshot.items[0].sourceRefs?.[0] ?? "", /^tool-call:[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(snapshot).includes(rawId), false);
});

test("inference request manifests capture the exact dispatch arrays without retaining content", async () => {
  const agent: any = Object.create(AutonomousAgent.prototype);
  const messages = [
    { role: "system", content: "PRIVATE_PROMPT_SECRET" },
    { role: "user", content: "task instructions" },
    { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "private_tool_name", arguments: "{}" } }] },
  ];
  const tools = [{ type: "function", function: { name: "private_tool_name", description: "PRIVATE_SCHEMA_SECRET", parameters: { type: "object" } } }];
  const persistence: unknown[] = [];
  Object.assign(agent, {
    inferenceContextManifests: [], inferenceContextSequence: 0, currentTaskId: "ctx-task", workspacePathIdentity: { value: "/repo" },
    config: {}, durable: true, capabilities: undefined, lastRequestCount: { step: 7, promptTokens: 33, source: "exact_admitted" },
    recoveryClock: { now: (() => { let n = 0; return () => ++n; })() },
    getEffectiveTools: () => tools,
    effectiveLimits: () => ({ contextLimit: 2048 }),
    getContextReserves: () => ({ completion: 128, toolResponse: 64 }),
    persistProgress: (progress: unknown) => { persistence.push(progress); return true; },
  });
  let observedBeforeSend: any;
  const result = await agent.submitGuardingLength({ step: 7, cutAfterMs: 0 }, messages, async (request: unknown[]) => {
    observedBeforeSend = agent.getInferenceContextManifests()[0];
    assert.deepEqual(request, messages);
    return "received";
  });
  assert.equal(result, "received");
  const manifest = agent.getInferenceContextManifests()[0];
  assert.equal(observedBeforeSend.status, "dispatching", "manifest is persisted before provider dispatch");
  assert.equal(manifest.status, "response_received");
  assert.equal(manifest.messages.length, 3);
  assert.equal(manifest.messages[0].sourceRef, "request:message:0");
  assert.equal(manifest.tools.count, 1);
  assert.equal(manifest.budget.requestEstimateTokens, calculateContextBudget(messages as any, tools as any, 2048).totalActiveTokens);
  assert.deepEqual(manifest.tools.schemaRefs, ["request:tool-schema:0"]);
  assert.equal("admission" in manifest.budget, false, "provider counts are reported separately and not attached to a request unless their exact arrays are bound");
  assert.equal(isInferenceContextManifest(manifest), true);
  assert.equal(JSON.stringify(manifest).includes("PRIVATE_PROMPT_SECRET"), false);
  assert.equal(JSON.stringify(manifest).includes("PRIVATE_SCHEMA_SECRET"), false);
  assert.equal(JSON.stringify(manifest).includes("private_tool_name"), false);
  assert.equal(isInferenceContextManifest({ ...manifest, leakedPrompt: "PRIVATE_PROMPT_SECRET" }), false, "future or untrusted fields are rejected rather than exported");
  assert.equal(persistence.length, 2, "dispatch and response states are durably checkpointed");
});

test("manifest estimates include all request messages even when source references are capped", () => {
  const messages = Array.from({ length: 4097 }, (_, position) => ({ role: "user", content: `message ${position}` }));
  const tools: unknown[] = [];
  const manifest = buildInferenceContextManifest({
    id: "ctxreq_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    sequence: 1,
    messages,
    tools,
    contextLimit: 65536,
    contextLimitSource: "client_default",
    outputAllowance: 4096,
    outputAllowanceSource: "client_default",
    toolResponseReserve: 4096,
  });
  assert.equal(manifest.messages.length, 4096);
  assert.equal(manifest.coverage, "partial");
  assert.equal(manifest.budget.requestEstimateTokens, calculateContextBudget(messages as any, tools as any, 65536).totalActiveTokens);
});

test("active system-prompt inventory slices current bytes and refuses stale offsets", () => {
  const prompt = "base policy\nproject rules\nruntime identity";
  const agent: any = Object.create(AutonomousAgent.prototype);
  Object.assign(agent, {
    messages: [{ role: "system", content: prompt }],
    systemPromptSectionMessageDigest: createHash("sha256").update(prompt).digest("hex"),
    systemPromptSectionReferences: [
      { sourceType: "client_system_prompt", sourceLocation: "client:runtime-system-prompt:segment:1", scope: "profile", trust: "system_instruction", retention: "runtime_prompt", inclusionReason: "runtime policy", retrievalMethod: "system_prompt_builder", segments: [{ start: 0, end: 11 }] },
      { sourceType: "project_rules", sourceLocation: "repository:/repo:rules", scope: "repository", trust: "persisted_unverified", retention: "workspace_rules_policy", inclusionReason: "workspace rules remain untrusted", retrievalMethod: "trusted_project_rules", segments: [{ start: 12, end: 25 }] },
    ],
  });
  const sources = agent.getSystemPromptContextSources();
  assert.equal(sources[0].content, "base policy");
  assert.equal(sources[1].content, "project rules");
  assert.equal(sources[1].trust, "persisted_unverified");
  assert.deepEqual(sources.map((source: any) => source.sourceRefs), [["request:message:0"], ["request:message:0"]]);
  assert.equal(JSON.stringify(buildContextInventory({ sources: [{ name: "prompt", status: "ok", durationMs: 1, items: sources }] })).includes("project rules"), false);
  agent.messages[0].content += " changed";
  assert.equal(agent.getSystemPromptContextSources(), undefined, "changed prompt bytes cannot reuse old offsets");
});

test("failed and interrupted inference manifest states remain unknown rather than successful", async () => {
  const agent: any = Object.create(AutonomousAgent.prototype);
  Object.assign(agent, {
    inferenceContextManifests: [], inferenceContextSequence: 0, currentTaskId: "ctx-task", workspacePathIdentity: { value: "/repo" },
    config: {}, durable: true, capabilities: undefined, recoveryClock: { now: (() => { let n = 0; return () => ++n; })() },
    getEffectiveTools: () => [], effectiveLimits: () => ({ contextLimit: 1024 }), getContextReserves: () => ({ completion: 64, toolResponse: 32 }),
    persistProgress: () => true,
  });
  await assert.rejects(agent.submitGuardingLength({ step: 1, cutAfterMs: 0 }, [{ role: "user", content: "task" }], async () => { throw new Error("connection dropped"); }));
  assert.equal(agent.getInferenceContextManifests()[0].status, "unknown_effect");

  const persistenceBlocked: any = Object.create(AutonomousAgent.prototype);
  Object.assign(persistenceBlocked, {
    inferenceContextManifests: [], inferenceContextSequence: 0, currentTaskId: "ctx-task", workspacePathIdentity: { value: "/repo" },
    config: {}, durable: true, capabilities: undefined, recoveryClock: { now: () => 0 },
    getEffectiveTools: () => [], effectiveLimits: () => ({ contextLimit: 1024 }), getContextReserves: () => ({ completion: 64, toolResponse: 32 }),
    persistProgress: () => false,
  });
  let dispatched = false;
  await assert.rejects(persistenceBlocked.submitGuardingLength({ step: 2, cutAfterMs: 0 }, [{ role: "user", content: "task" }], async () => { dispatched = true; }));
  assert.equal(dispatched, false, "the provider is not called when a configured durable sink refuses the pre-dispatch manifest");
  assert.equal(persistenceBlocked.getInferenceContextManifests()[0].status, "not_dispatched");

  const interrupted = markInterruptedInferenceManifestsUnknown([{
    ...buildInferenceContextManifest({ id: `ctxreq_${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}`, sequence: 1, messages: [{ role: "user", content: "task" }], tools: [], contextLimit: 1024, contextLimitSource: "operator", outputAllowance: 64, outputAllowanceSource: "operator", toolResponseReserve: 32 }),
  }]);
  assert.equal(interrupted[0].status, "unknown_effect");
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
  assert.equal(isContextInventorySnapshot(snapshot), true, "timeout details remain valid additive schema-1 metadata");
  assert.match(snapshot.coverageGaps.join(" "), /partial or unavailable/);
  assert.equal(snapshot.sourceMeasurements.find((item) => item.source === "memory")?.status, "failed");
});

test("context inspection enforces a total retrieval budget and records timed-out sources", async () => {
  let resolveLate!: (messages: Array<{ role: string; content: string }>) => void;
  const agent = {
    getMessages: () => new Promise((resolve) => { resolveLate = resolve; }),
    getObjective: () => null,
    getActivePlan: () => [],
    getKnowledgeGraph: () => ({ list: () => [] }),
    getSkillManager: () => ({ listSkills: () => [] }),
    getEffectiveTools: () => [],
    getProviderCapabilities: () => null,
    getLastRequestCount: () => undefined,
    getContextBudget: () => ({ contextLimit: 2048 }),
    getTaskId: () => "ctx-task",
    getWorkspaceContextFingerprint: () => "b".repeat(64),
    getInferenceContextManifests: () => [],
  };
  const host = {
    app: {
      getAgent: () => agent,
      getConfig: () => ({ workspace: process.cwd() }),
      getSessionManager: () => ({ loadSession: () => null }),
    },
    sessionId: () => "ctx-session",
  } as any;

  const started = performance.now();
  const outcome = await routeSlash(host, "context", "inspect --json --budget-ms 30", new AbortController().signal);
  const elapsed = performance.now() - started;
  assert.equal(outcome.kind, "reply");
  assert.equal(outcome.success, true);
  const snapshot = JSON.parse(outcome.output);
  const messages = snapshot.sourceMeasurements.find((source: any) => source.source === "session_messages");
  assert.equal(messages.status, "failed");
  assert.equal(messages.outcome, "timed_out");
  assert.equal(messages.itemCount, 0);
  assert.equal(snapshot.coverage, "partial");
  assert.equal(snapshot.metrics.budgetStatus, "unknown");
  assert.ok(snapshot.coverageGaps.some((gap: string) => gap.includes("session_messages") && gap.includes("inspection budget")));
  assert.ok(snapshot.metrics.assemblyDurationMs < 500, `inspection should not wait for the pending source, got ${snapshot.metrics.assemblyDurationMs}ms`);
  assert.ok(elapsed < 500, `command should not wait for the pending source, got ${elapsed}ms`);
  resolveLate([{ role: "user", content: "late source" }]);

  const invalid = await routeSlash(host, "context", "inspect --json --budget-ms 0", new AbortController().signal);
  assert.equal(invalid.success, false);
  const tooManyItems = await routeSlash(host, "context", "inspect --max-items 501", new AbortController().signal);
  assert.equal(tooManyItems.success, false);

  const cancelController = new AbortController();
  const cancelOutcomePromise = routeSlash(host, "context", "inspect --json --budget-ms 2000", cancelController.signal);
  setTimeout(() => cancelController.abort(), 5);
  const cancelOutcome = await cancelOutcomePromise;
  assert.equal(cancelOutcome.success, true);
  const cancelledSnapshot = JSON.parse(cancelOutcome.output);
  const cancelledSource = cancelledSnapshot.sourceMeasurements.find((source: any) => source.source === "session_messages");
  assert.equal(cancelledSource.status, "failed");
  assert.equal(cancelledSource.outcome, "cancelled");
  resolveLate([{ role: "user", content: "cancelled late source" }]);

  const rejectedHost = {
    ...host,
    app: { ...host.app, getAgent: () => ({ ...agent, getMessages: () => Promise.reject(new Error("untrusted source error")) }) },
  };
  const rejected = await routeSlash(rejectedHost, "context", "inspect --json", new AbortController().signal);
  const rejectedSnapshot = JSON.parse(rejected.output);
  const failedSource = rejectedSnapshot.sourceMeasurements.find((source: any) => source.source === "session_messages");
  assert.equal(failedSource.status, "failed");
  assert.equal(failedSource.outcome, undefined);
  assert.equal(JSON.stringify(rejectedSnapshot).includes("untrusted source error"), false, "source errors must not leak arbitrary content into diagnostics");

  let syncReadCompleted = false;
  const slowHost = {
    ...host,
    app: {
      ...host.app,
      getAgent: () => ({ ...agent, getMessages: () => {
        const until = performance.now() + 80;
        while (performance.now() < until) { /* exercise a synchronous source that cannot be preempted */ }
        syncReadCompleted = true;
        return [{ role: "user", content: "late synchronous result" }];
      } }),
    },
  };
  const slow = await routeSlash(slowHost, "context", "inspect --json --budget-ms 30", new AbortController().signal);
  const slowSnapshot = JSON.parse(slow.output);
  const slowSource = slowSnapshot.sourceMeasurements.find((source: any) => source.source === "session_messages");
  assert.equal(syncReadCompleted, true);
  assert.equal(slowSource.status, "failed");
  assert.equal(slowSource.outcome, "timed_out");
  assert.equal(slowSource.itemCount, 0);
  assert.match(slowSource.detail, /synchronous reads cannot be preempted/);
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
  assert.ok(spec.usage.includes("--budget-ms"));
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
  const systemPrompt = "private composite system prompt";
  const agent = {
    getMessages: () => [{ role: "system", content: systemPrompt }, { role: "user", content: "private prompt text" }],
    getSystemPromptContextSources: () => [{ ...input("client:system-policy", "session", systemPrompt), sourceType: "client_system_prompt", sourceRefs: ["request:message:0"] }],
    getObjective: () => null,
    getActivePlan: () => [],
    getKnowledgeGraph: () => ({
      list: () => [{
        id: "memory-1",
        updatedAt: "2026-11-23T10:00:00.000Z",
        category: "rule",
        key: "test rule",
        value: "remembered claim",
        validationStatus: "operator_reviewed_unverified",
        provenance: { sourceRefs: ["operator-note:1"] },
        retention: { policy: "until_deleted" },
      }],
    }),
    getSkillManager: () => ({ listSkills: () => [
      { name: "workspace-guide", description: "Workspace rules", path: path.join(process.cwd(), ".agents/skills/workspace-guide/SKILL.md"), isWorkspaceSkill: true, trusted: true },
      { name: "profile-guide", description: "Profile rules", path: path.join(os.homedir(), ".nexus/skills/profile-guide/SKILL.md"), isWorkspaceSkill: false, trusted: true },
    ] }),
    getEffectiveTools: () => [],
    getProviderCapabilities: () => null,
    getLastRequestCount: () => undefined,
    getContextBudget: () => ({ contextLimit: 2048 }),
    getTaskId: () => "ctx-task",
    getWorkspaceContextFingerprint: () => "b".repeat(64),
    getInferenceContextManifests: () => [buildInferenceContextManifest({
      id: "ctxreq_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", sequence: 1,
      messages: [{ role: "user", content: "private request body" }], tools: [],
      contextLimit: 2048, contextLimitSource: "client_default", outputAllowance: 128, outputAllowanceSource: "client_default", toolResponseReserve: 64,
    })],
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
  assert.ok(snapshot.items.some((item: any) => item.sourceType === "inference_request_manifest"));
  assert.equal(snapshot.coverageGaps.some((gap: string) => gap.includes("does not yet persist a per-inference manifest")), false);
  assert.equal(snapshot.coverageGaps.some((gap: string) => gap.includes("active system prompt sections could not be linked")), false);
  assert.equal(snapshot.items.some((item: any) => item.sourceRefs?.includes("request:message:0")), true);
  const memoryItem = snapshot.items.find((item: any) => item.sourceType === "durable_knowledge");
  assert.equal(memoryItem?.freshness, "unknown");
  assert.match(memoryItem?.freshnessRule ?? "", /underlying memory sources are not fingerprinted/);
  assert.equal(memoryItem?.sourceVersion, JSON.stringify(["2026-11-23T10:00:00.000Z", "operator_reviewed_unverified"]));
  assert.equal(memoryItem?.sourceRefs?.includes("operator-note:1"), true);
  const workspaceSkill = snapshot.items.find((item: any) => item.sourceLocation === "repository:skill:.agents/skills/workspace-guide/SKILL.md");
  const profileSkill = snapshot.items.find((item: any) => item.sourceLocation === "profile:skill:profile-guide");
  assert.equal(workspaceSkill?.scope, "repository");
  assert.equal(workspaceSkill?.freshness, "unknown", "inventory does not claim file freshness without source revalidation");
  assert.equal(profileSkill?.scope, "profile");
  assert.equal(profileSkill?.freshness, "unknown");
  assert.equal(snapshot.items.some((item: any) => item.sourceType === "system_context"), false);
  assert.equal(snapshot.metrics.tokenSource, "client_estimate");
  const bounded = await routeSlash(host, "context", "inspect --json --max-items 1", new AbortController().signal);
  const boundedSnapshot = JSON.parse(bounded.output);
  assert.equal(boundedSnapshot.items.length, 1);
  assert.ok(boundedSnapshot.metrics.omittedItems > 0);
  assert.equal(boundedSnapshot.coverage, "partial");
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

  const previous = buildContextInventory({
    workspaceState: { fingerprint: "a".repeat(64), comparison: "no_previous_capture", invalidatedRepositoryItemIds: [] },
    sources: [{ name: "repository", status: "ok", durationMs: 1, items: [
      input("repository:old", "repository"),
      { ...input("repository:skill:.agents/skills/workspace-guide/SKILL.md", "repository"), sourceType: "skill_catalog_entry", freshness: "unknown", freshnessRule: "workspace skill file content is not revalidated here" },
    ] }],
  });
  const changedHost = {
    ...host,
    app: {
      ...host.app,
      getSessionManager: () => ({ loadSession: () => ({ contextInventory: previous }) }),
    },
  };
  const changed = await routeSlash(changedHost, "context", "inspect --json", new AbortController().signal);
  const changedSnapshot = JSON.parse(changed.output);
  assert.equal(changedSnapshot.workspaceState.comparison, "changed");
  assert.deepEqual(changedSnapshot.workspaceState.invalidatedRepositoryItemIds, previous.items.map((item) => item.id));
  assert.ok(changedSnapshot.coverageGaps.some((gap: string) => gap.includes("workspace state changed")));

  const priorKnowledge = buildContextInventory({
    sources: [{ name: "project_knowledge", status: "ok", durationMs: 1, items: [{
      ...input("repository:knowledge:memory-1", "repository"),
      sourceType: "durable_knowledge",
      sourceVersion: JSON.stringify(["2026-11-20T10:00:00.000Z", "operator_reviewed_unverified"]),
    }] }],
  });
  const changedKnowledgeHost = {
    ...host,
    app: {
      ...host.app,
      getAgent: () => ({ ...agent, getKnowledgeGraph: () => ({ list: () => [{
        id: "memory-1", updatedAt: "2026-11-23T10:00:00.000Z", category: "rule", key: "test rule", value: "remembered claim",
        validationStatus: "operator_reviewed_unverified", provenance: { sourceRefs: ["operator-note:1"] }, retention: { policy: "until_deleted" },
      }] }) }),
      getSessionManager: () => ({ loadSession: () => ({ contextInventory: priorKnowledge }) }),
    },
  };
  const changedKnowledge = await routeSlash(changedKnowledgeHost, "context", "inspect --json", new AbortController().signal);
  const changedKnowledgeSnapshot = JSON.parse(changedKnowledge.output);
  const currentKnowledgeItem = changedKnowledgeSnapshot.items.find((item: any) => item.sourceType === "durable_knowledge");
  assert.equal(currentKnowledgeItem?.freshness, "unknown", "record change detection cannot verify the underlying remembered claim");
  assert.equal(currentKnowledgeItem?.sourceVersion, JSON.stringify(["2026-11-23T10:00:00.000Z", "operator_reviewed_unverified"]));
  assert.ok(changedKnowledgeSnapshot.coverageGaps.some((gap: string) => gap.includes("project knowledge record changed since the previous capture")));

  const changedValidationHost = {
    ...host,
    app: {
      ...host.app,
      getAgent: () => ({ ...agent, getKnowledgeGraph: () => ({ list: () => [{
        id: "memory-1", updatedAt: "2026-11-20T10:00:00.000Z", category: "rule", key: "test rule", value: "remembered claim",
        validationStatus: "legacy_unverified", provenance: { sourceRefs: ["operator-note:1"] }, retention: { policy: "until_deleted" },
      }] }) }),
      getSessionManager: () => ({ loadSession: () => ({ contextInventory: priorKnowledge }) }),
    },
  };
  const changedValidation = await routeSlash(changedValidationHost, "context", "inspect --json", new AbortController().signal);
  const changedValidationSnapshot = JSON.parse(changedValidation.output);
  assert.equal(changedValidationSnapshot.items.find((item: any) => item.sourceType === "durable_knowledge")?.sourceVersion, JSON.stringify(["2026-11-20T10:00:00.000Z", "legacy_unverified"]));
  assert.ok(changedValidationSnapshot.coverageGaps.some((gap: string) => gap.includes("project knowledge record changed since the previous capture")));

  const unavailableHost = {
    ...host,
    app: {
      ...host.app,
      getAgent: () => ({ ...agent, getWorkspaceContextFingerprint: () => undefined }),
    },
  };
  const unavailable = await routeSlash(unavailableHost, "context", "inspect --json", new AbortController().signal);
  const unavailableSnapshot = JSON.parse(unavailable.output);
  assert.equal(unavailableSnapshot.workspaceState.comparison, "unavailable");
  assert.equal(unavailableSnapshot.sourceMeasurements.find((source: any) => source.source === "workspace_state_fingerprint").status, "failed");
  assert.ok(unavailableSnapshot.coverageGaps.some((gap: string) => gap.includes("could not be fingerprinted")));

  const unsafeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-context-inspect-unsafe-git-"));
  const marker = path.join(unsafeRoot, "filter-ran");
  try {
    execFileSync("git", ["init", "-q", unsafeRoot]);
    execFileSync("git", ["-C", unsafeRoot, "config", "user.email", "context-test@example.invalid"]);
    execFileSync("git", ["-C", unsafeRoot, "config", "user.name", "Context Test"]);
    fs.writeFileSync(path.join(unsafeRoot, ".gitattributes"), "tracked.txt filter=hostile\n");
    fs.writeFileSync(path.join(unsafeRoot, "tracked.txt"), "baseline\n");
    execFileSync("git", ["-C", unsafeRoot, "add", ".gitattributes", "tracked.txt"]);
    execFileSync("git", ["-C", unsafeRoot, "commit", "-q", "-m", "baseline"]);
    fs.writeFileSync(path.join(unsafeRoot, "tracked.txt"), "changed\n");
    execFileSync("git", ["-C", unsafeRoot, "config", "filter.hostile.clean", `touch '${marker}'`]);
    const unsafeAgent = Object.assign(Object.create(AutonomousAgent.prototype), agent, { config: { workspace: unsafeRoot } });
    const unsafeWorkspaceHost = {
      ...host,
      app: {
        ...host.app,
        getAgent: () => unsafeAgent,
        getConfig: () => ({ workspace: unsafeRoot }),
      },
    };
    const unsafeWorkspace = await routeSlash(unsafeWorkspaceHost, "context", "inspect --json", new AbortController().signal);
    const unsafeWorkspaceSnapshot = JSON.parse(unsafeWorkspace.output);
    assert.equal(unsafeWorkspaceSnapshot.workspaceState.comparison, "unavailable");
    const unsafeMeasurement = unsafeWorkspaceSnapshot.sourceMeasurements.find((source: any) => source.source === "workspace_state_fingerprint");
    assert.equal(unsafeMeasurement.status, "failed");
    assert.match(unsafeMeasurement.detail, /program settings; fingerprinting was refused and freshness is unknown/);
    assert.equal(fs.existsSync(marker), false, "/context inspect must not execute the configured filter");
  } finally {
    fs.rmSync(unsafeRoot, { recursive: true, force: true });
  }
});

test("session save, resume, compaction, and export retain source references without promoting memory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-context-inventory-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const manager = new SessionManager(path.join(root, "sessions"), () => WorkspacePath.fromSelectedWorkspace(workspace));
  try {
    const compactionProvenance = { recordId: "compact-1", predecessorIds: ["history-1", "history-2"], summaryContent: "summary claim" };
    const pendingRequest = buildInferenceContextManifest({
      id: "ctxreq_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", sequence: 1,
      messages: [{ role: "user", content: "PRIVATE_RESUMED_REQUEST" }], tools: [],
      contextLimit: 1024, contextLimitSource: "operator", outputAllowance: 64, outputAllowanceSource: "operator", toolResponseReserve: 32,
    });
    manager.saveSession({
      id: "ctx-session", workspace, messages: [
        { role: "system", content: "[Structured Context Memory - durable task state] summary claim" },
        { role: "user", content: "original objective" },
      ],
      durableNotes: ["remembered but unverified"], compactionProvenance,
      inferenceContextManifests: [pendingRequest],
    } as any);
    const resumed = manager.loadSession("ctx-session")!;
    assert.ok(isContextInventorySnapshot(resumed.contextInventory));
    const provenance = resumed.contextInventory!.items.find((item) => item.sourceType === "compaction_provenance");
    assert.deepEqual(provenance?.sourceRefs, ["compact-1", "history-1", "history-2"]);
    assert.equal(resumed.contextInventory!.items.find((item) => item.sourceType === "durable_note")?.trust, "persisted_unverified");
    assert.equal(resumed.inferenceContextManifests?.[0].status, "unknown_effect", "a persisted dispatch without a response is reconciled as unknown on resume");

    const archiveMessages = [{ role: "assistant", content: "archived answer" }];
    const exported = buildSessionExport({ readArchivedHistory: () => ({ messages: archiveMessages, unreadableLines: 0 }) } as any, resumed as any);
    const exportInventory = (exported.json as any).contextInventory;
    assert.ok(exportInventory.items.some((item: any) => item.sourceLocation.startsWith("archive:message:")));
    assert.ok(exportInventory.items.some((item: any) => item.sourceRefs?.includes("history-1")));
    assert.match(exported.markdown, /Context inventory \(source references; content omitted\)/);
    assert.match(exported.markdown, /Inference context manifests \(content omitted\)/);
    assert.match(exported.markdown, /status=unknown_effect/);
    assert.equal(JSON.stringify(exported.json.contextInventory).includes("remembered but unverified"), false);
    assert.equal(JSON.stringify(exported.json.inferenceContextManifests).includes("PRIVATE_RESUMED_REQUEST"), false);

    const malformed = { ...exportInventory, schemaVersion: 999 };
    const merged = mergeContextInventorySnapshots(resumed.contextInventory!, malformed as any);
    assert.equal(merged.items.some((item) => item.sourceRefs?.includes("history-1")), true);

    const liveInventory = buildContextInventory({
      sessionId: "ctx-live",
      workspace,
      workspaceState: { fingerprint: "a".repeat(64), comparison: "no_previous_capture", invalidatedRepositoryItemIds: [] },
      sources: [{ name: "repository", status: "ok", durationMs: 1, items: [{
        ...input("repository:status", "repository"),
        freshness: "current",
        freshnessRule: "live at capture; invalidate after workspace changes",
        sourceVersion: JSON.stringify(["capture-1", "current"]),
      }] }],
    });
    manager.saveSession({ id: "ctx-live", workspace, messages: [], contextInventory: liveInventory } as any);
    const restoredLive = manager.loadSession("ctx-live")!;
    assert.equal(restoredLive.contextInventory?.items[0].freshness, "unknown");
    assert.match(restoredLive.contextInventory?.items[0].freshnessRule ?? "", /requires revalidation/);
    assert.equal(restoredLive.contextInventory?.items[0].sourceVersion, JSON.stringify(["capture-1", "current"]));
    assert.equal(restoredLive.contextInventory?.workspaceState?.fingerprint, "a".repeat(64));
    assert.equal(compareWorkspaceState(restoredLive.contextInventory, "b".repeat(64)).comparison, "changed");
    const exportedLive = buildSessionExport(manager, restoredLive as any);
    assert.equal((exportedLive.json as any).contextInventory.workspaceState.fingerprint, "a".repeat(64));
    assert.equal((exportedLive.json as any).contextInventory.items[0].sourceVersion, JSON.stringify(["capture-1", "current"]));
    assert.match(exportedLive.markdown, /source-version=`%5B%22capture-1%22%2C%22current%22%5D`/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
