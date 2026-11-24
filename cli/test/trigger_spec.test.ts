/**
 * BG-3 trust model: trigger spec parsing and validation. Every rejection is an abuse surface closed at the
 * boundary; a spec that parses is the only shape a firer may accept.
 */
import "./helpers/leak_guard.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseTriggerSpec,
  triggerSpecSha256,
  canonicalizeTriggerSpec,
  defaultTriggerBounds,
  defaultTriggerRate,
  triggerTrustStatus,
  type TriggerSpec,
} from "../src/core/trigger_spec.js";

let home = "", previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-trigger-spec-home-"));
  process.env.HOME = home;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
});

const baseSpec: TriggerSpec = {
  format: "nexus-trigger",
  version: 1,
  id: "lint-on-save",
  event: { kind: "file-change", paths: ["src/**/*.ts"] },
  action: { prompt: "run lint", policy: "read-only" },
  rate: { maxPerMinute: 5, maxPerHour: 60, maxPerDay: 500 },
  bounds: { maxToolInvocations: 200, maxRounds: 5, maxTurnMinutes: 30 },
};

const serialize = (spec: unknown) => JSON.stringify(spec);

test("parses a valid file-change trigger", () => {
  const spec = parseTriggerSpec(serialize(baseSpec));
  assert.equal(spec.id, "lint-on-save");
  assert.equal(spec.event.kind, "file-change");
  assert.equal(spec.action.policy, "read-only");
});

test("parses a valid webhook trigger", () => {
  const spec = parseTriggerSpec(serialize({ ...baseSpec, id: "web-deploy", event: { kind: "webhook", secret: "abc123" } }));
  assert.equal(spec.event.kind, "webhook");
  assert.equal(spec.event.secret, "abc123");
  assert.equal(spec.event.paths, undefined);
});

test("canonicalizes deterministically regardless of input key order", () => {
  const a = canonicalizeTriggerSpec(baseSpec);
  const scrambled = JSON.parse(serialize(baseSpec));
  // reverse keys where possible
  const reversed = {
    format: scrambled.format,
    version: scrambled.version,
    id: scrambled.id,
    event: scrambled.event,
    action: scrambled.action,
    rate: scrambled.rate,
    bounds: scrambled.bounds,
  };
  assert.equal(canonicalizeTriggerSpec(reversed as TriggerSpec), a);
});

test("sha256 is stable across equivalent specs", () => {
  const a = triggerSpecSha256(Buffer.from(canonicalizeTriggerSpec(baseSpec), "utf8"));
  const b = triggerSpecSha256(Buffer.from(canonicalizeTriggerSpec(baseSpec), "utf8"));
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("rejects non-object document", () => {
  assert.throws(() => parseTriggerSpec("[1,2]"), /not an object/);
});

test("rejects wrong format", () => {
  assert.throws(() => parseTriggerSpec(serialize({ ...baseSpec, format: "other" })), /format/);
});

test("rejects unknown version", () => {
  assert.throws(() => parseTriggerSpec(serialize({ ...baseSpec, version: 2 })), /version/);
});

test("rejects bad id", () => {
  for (const id of ["", "UPPER", "has space", "a".repeat(65), "-leading", ".dot"]) {
    assert.throws(() => parseTriggerSpec(serialize({ ...baseSpec, id })), /id/);
  }
});

test("rejects unknown event kind", () => {
  assert.throws(() => parseTriggerSpec(serialize({ ...baseSpec, event: { kind: "ssh" as any } })), /event.kind/);
});

test("file-change requires paths; webhook requires secret", () => {
  assert.throws(() => parseTriggerSpec(serialize({ ...baseSpec, event: { kind: "file-change" } })), /paths/);
  assert.throws(() => parseTriggerSpec(serialize({ ...baseSpec, id: "w", event: { kind: "webhook" } })), /secret/);
});

test("file-change may not set secret; webhook may not set paths", () => {
  assert.throws(() => parseTriggerSpec(serialize({ ...baseSpec, event: { kind: "file-change", paths: ["x"], secret: "s" } })), /may not set/);
  assert.throws(() => parseTriggerSpec(serialize({ ...baseSpec, id: "w", event: { kind: "webhook", secret: "s", paths: ["x"] } })), /may not set/);
});

test("rejects path with .. or absolute", () => {
  assert.throws(() => parseTriggerSpec(serialize({ ...baseSpec, event: { kind: "file-change", paths: ["../x"] } })), /\.\./);
  assert.throws(() => parseTriggerSpec(serialize({ ...baseSpec, event: { kind: "file-change", paths: ["/abs"] } })), /absolute/);
});

test("worktree-write refused without --allow-worktree-write", () => {
  assert.throws(() => parseTriggerSpec(serialize({ ...baseSpec, action: { ...baseSpec.action, policy: "worktree-write" } })), /worktree-write/);
});

test("worktree-write accepted with allowWorktreeWrite", () => {
  const spec = parseTriggerSpec(serialize({ ...baseSpec, action: { ...baseSpec.action, policy: "worktree-write" } }), { allowWorktreeWrite: true });
  assert.equal(spec.action.policy, "worktree-write");
});

test("rejects unknown top-level keys", () => {
  assert.throws(() => parseTriggerSpec(serialize({ ...baseSpec, extra: true })), /unknown keys/);
});

test("rejects unknown event keys", () => {
  assert.throws(() => parseTriggerSpec(serialize({ ...baseSpec, event: { ...baseSpec.event, bogus: 1 } })), /unknown event keys/);
});

test("rate limits are bounded and ordered", () => {
  assert.throws(() => parseTriggerSpec(serialize({ ...baseSpec, rate: { ...baseSpec.rate, maxPerMinute: 0 } })), /rate.maxPerMinute/);
  assert.throws(() => parseTriggerSpec(serialize({ ...baseSpec, rate: { ...baseSpec.rate, maxPerMinute: 70, maxPerHour: 60 } })), /maxPerMinute may not exceed/);
});

test("bounds are bounded", () => {
  assert.throws(() => parseTriggerSpec(serialize({ ...baseSpec, bounds: { ...baseSpec.bounds, maxToolInvocations: 0 } })), /maxToolInvocations/);
});

test("prompt is bounded and non-empty", () => {
  assert.throws(() => parseTriggerSpec(serialize({ ...baseSpec, action: { ...baseSpec.action, prompt: "" } })), /prompt/);
});

test("default bounds and rate", () => {
  assert.deepEqual(defaultTriggerBounds(), { maxToolInvocations: 200, maxRounds: 5, maxTurnMinutes: 30 });
  assert.deepEqual(defaultTriggerRate(), { maxPerMinute: 5, maxPerHour: 60, maxPerDay: 500 });
});

test("triggerTrustStatus NEW/MATCH/MISMATCH/REMOVED/ABSENT", () => {
  const entries = [{ kind: "trigger", scope: "/ws", key: "t", sha256: "aaa", approvedAt: "now", summary: "s" }];
  assert.equal(triggerTrustStatus(entries, "t", "/ws", undefined), "REMOVED");
  assert.equal(triggerTrustStatus(entries, "t", "/ws", "aaa"), "MATCH");
  assert.equal(triggerTrustStatus(entries, "t", "/ws", "bbb"), "MISMATCH");
  assert.equal(triggerTrustStatus(entries, "missing", "/ws", "x"), "NEW");
  assert.equal(triggerTrustStatus([], "t", "/ws", undefined), "ABSENT");
});
