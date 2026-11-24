/**
 * BG-3 trust model: the trigger trust store. Never fails open; a malformed store holds no approvals. Approvals are
 * keyed by SHA-256 of the exact spec bytes; changed bytes are MISMATCH / REMOVED and not in force.
 */
import "./helpers/leak_guard.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readTriggerTrustStore,
  approveTrigger,
  revokeTrigger,
  entryForSpec,
  triggerTrustEntry,
  workspaceMayHaveTriggers,
  decideTriggerTrust,
  triggerMayRun,
  triggerTrustStorePath,
  TRIGGER_TRUST_VERSION,
  type TriggerTrustEntry,
} from "../src/core/trigger_trust.js";
import {
  parseTriggerSpec,
  canonicalizeTriggerSpec,
  triggerSpecSha256,
  triggerTrustStatus,
  defaultTriggerBounds,
  defaultTriggerRate,
  type TriggerSpec,
} from "../src/core/trigger_spec.js";

let home = "", previousHome: string | undefined, storePath = "";
beforeEach(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-trigger-trust-home-"));
  process.env.HOME = home;
  storePath = triggerTrustStorePath();
  // ensure the store dir does not pre-exist with stale content
  fs.rmSync(path.dirname(storePath), { recursive: true, force: true });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
});

const spec = (id = "lint-on-save", overrides: Partial<TriggerSpec> = {}): TriggerSpec =>
  parseTriggerSpec(JSON.stringify({
    format: "nexus-trigger",
    version: 1,
    id,
    event: { kind: "file-change", paths: ["src/**/*.ts"] },
    action: { prompt: "run lint", policy: "read-only" },
    rate: defaultTriggerRate(),
    bounds: defaultTriggerBounds(),
    ...overrides,
  }));

const entry = (id = "lint-on-save", scope = "/ws"): TriggerTrustEntry =>
  entryForSpec(scope, spec(id), "2026-01-01T00:00:00.000Z");

test("a missing store holds no approvals and reports no problem", () => {
  const result = readTriggerTrustStore();
  assert.deepEqual(result.entries, []);
  assert.equal(result.problem, undefined);
});

test("approveTrigger writes a private store; reading it back yields the entry", () => {
  const s = spec("t");
  const e = entryForSpec("/ws", s, new Date().toISOString());
  approveTrigger(e, { workspaceTrusted: true, storePath });
  const result = readTriggerTrustStore(storePath);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].key, "t");
  assert.equal(result.entries[0].sha256, triggerSpecSha256(Buffer.from(canonicalizeTriggerSpec(s), "utf8")));
});

test("approveTrigger refuses when the workspace is not trusted", () => {
  const s = spec("t");
  const e = entryForSpec("/ws", s, new Date().toISOString());
  assert.throws(() => approveTrigger(e, { workspaceTrusted: false, storePath }), /not trusted/);
});

test("approveTrigger replaces an earlier approval of the same item", () => {
  const s1 = spec("t", { event: { kind: "file-change", paths: ["a.ts"] } });
  const s2 = spec("t", { event: { kind: "file-change", paths: ["b.ts"] } });
  approveTrigger(entryForSpec("/ws", s1, new Date().toISOString()), { workspaceTrusted: true, storePath });
  approveTrigger(entryForSpec("/ws", s2, new Date().toISOString()), { workspaceTrusted: true, storePath });
  const result = readTriggerTrustStore(storePath);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].sha256, triggerSpecSha256(Buffer.from(canonicalizeTriggerSpec(s2), "utf8")));
});

test("revokeTrigger removes an approval and returns true; missing returns false", () => {
  const e = entry("t", "/ws");
  approveTrigger(e, { workspaceTrusted: true, storePath });
  assert.equal(revokeTrigger({ scope: "/ws", key: "t" }, storePath), true);
  assert.equal(revokeTrigger({ scope: "/ws", key: "t" }, storePath), false);
  assert.equal(readTriggerTrustStore(storePath).entries.length, 0);
});

test("store across scope+key: same id in two scopes are distinct entries", () => {
  const sa = spec("t"); const sb = spec("t");
  approveTrigger(entryForSpec("/ws-a", sa, new Date().toISOString()), { workspaceTrusted: true, storePath });
  approveTrigger(entryForSpec("/ws-b", sb, new Date().toISOString()), { workspaceTrusted: true, storePath });
  assert.equal(readTriggerTrustStore(storePath).entries.length, 2);
});

test("malformed store holds no approvals", () => {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, "{ not json");
  const result = readTriggerTrustStore(storePath);
  assert.equal(result.entries.length, 0);
  assert.ok(result.problem);
});

test("wrong version holds no approvals", () => {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify({ version: 2, entries: [] }));
  assert.equal(readTriggerTrustStore(storePath).entries.length, 0);
});

test("triggerTrustStatus: NEW / MATCH / MISMATCH / REMOVED / ABSENT", () => {
  const s = spec("t");
  const sha = triggerSpecSha256(Buffer.from(canonicalizeTriggerSpec(s), "utf8"));
  const entries: TriggerTrustEntry[] = [entryForSpec("/ws", s, "2026-01-01T00:00:00.000Z")];
  assert.equal(triggerTrustStatus(entries, "t", "/ws", undefined), "REMOVED");
  assert.equal(triggerTrustStatus(entries, "t", "/ws", sha), "MATCH");
  assert.equal(triggerTrustStatus(entries, "t", "/ws", "bbb"), "MISMATCH");
  assert.equal(triggerTrustStatus(entries, "missing", "/ws", "x"), "NEW");
  assert.equal(triggerTrustStatus([], "t", "/ws", undefined), "ABSENT");
});

test("triggerTrustEntry finds by scope+key", () => {
  const e = entry("t", "/ws");
  const entries = [e, entry("u", "/ws")];
  assert.equal(triggerTrustEntry(entries, { scope: "/ws", key: "t" }), e);
  assert.equal(triggerTrustEntry(entries, { scope: "/other", key: "t" }), undefined);
});

test("workspaceMayHaveTriggers delegates to workspace trust", () => {
  assert.equal(workspaceMayHaveTriggers("/anything"), false);
  // trust it via the store
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify({ trustedPaths: ["/ws"] }));
  // storePath is trigger_trust.json; workspace trust uses trusted_workspaces.json, so write that too
  const wsStore = path.join(path.dirname(storePath), "trusted_workspaces.json");
  fs.writeFileSync(wsStore, JSON.stringify({ trustedPaths: ["/ws"] }));
  assert.equal(workspaceMayHaveTriggers("/ws"), true);
});

test("decideTriggerTrust: workspace not trusted => may not run", () => {
  const s = spec("t");
  const sha = triggerSpecSha256(Buffer.from(canonicalizeTriggerSpec(s), "utf8"));
  const decision = decideTriggerTrust([], "/ws", s, sha);
  assert.equal(decision.workspaceTrusted, false);
  assert.equal(decision.status, "NEW");
  assert.equal(triggerMayRun(decision), false);
});

test("decideTriggerTrust: trusted + MATCH => may run", () => {
  const wsStore = path.join(path.dirname(storePath), "trusted_workspaces.json");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(wsStore, JSON.stringify({ trustedPaths: ["/ws"] }));
  try {
    const s = spec("t");
    const sha = triggerSpecSha256(Buffer.from(canonicalizeTriggerSpec(s), "utf8"));
    const entries = [entryForSpec("/ws", s, new Date().toISOString())];
    const decision = decideTriggerTrust(entries, "/ws", s, sha);
    assert.equal(decision.workspaceTrusted, true);
    assert.equal(decision.status, "MATCH");
    assert.equal(triggerMayRun(decision), true);
  } finally {
    fs.rmSync(wsStore, { force: true });
  }
});

test("decideTriggerTrust: trusted + MISMATCH => may not run", () => {
  const wsStore = path.join(path.dirname(storePath), "trusted_workspaces.json");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(wsStore, JSON.stringify({ trustedPaths: ["/ws"] }));
  try {
    const s = spec("t");
    const decision = decideTriggerTrust([entry("t", "/ws", "aaa")], "/ws", s, "bbb");
    assert.equal(decision.status, "MISMATCH");
    assert.equal(triggerMayRun(decision), false);
  } finally {
    fs.rmSync(wsStore, { force: true });
  }
});

test("TRIGGER_TRUST_VERSION is 1", () => {
  assert.equal(TRIGGER_TRUST_VERSION, 1);
});
