import { test } from "node:test";
import assert from "node:assert/strict";
import { InformationFlowBoundary } from "../src/core/egress.js";
import { MAX_DIFF_DETAIL } from "../src/evidence.js";
import { encodeEvent, MAX_SLASH_OUTPUT, MAX_TEXT_FIELD, type SidecarEvent } from "../src/protocol.js";
import { formatSafeSidecarEvent, redactThenCap } from "../src/sidecar.js";

const SECRET_BODY = "Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6";
const SECRET = `ghp_${SECRET_BODY}`;
/** Slack between the field limit and the truncation marker `…[truncated N chars]`. */
const MARKER_ALLOWANCE = 40;

function withFreshBoundary<T>(run: () => T): T {
  const original = InformationFlowBoundary.getGlobalInstance();
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary());
  try {
    return run();
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
}

/** No 6-character window of the secret body survives anywhere in the serialized event. */
function assertNoSecretFragment(event: SidecarEvent | undefined, label: string): void {
  assert.ok(event, `${label}: event was dropped`);
  const text = JSON.stringify(event);
  for (let i = 0; i + 6 <= SECRET_BODY.length; i++) {
    assert.ok(!text.includes(SECRET_BODY.slice(i, i + 6)), `${label}: fragment "${SECRET_BODY.slice(i, i + 6)}" survived`);
  }
}

/** A field whose text puts the secret across the field's limit: the old truncation point fell inside it. */
const straddle = (limit: number) => `${"x".repeat(limit - 10)}${SECRET}${" tail".repeat(40)}`;

interface FieldCase {
  name: string;
  limit: number;
  build: (value: string) => SidecarEvent;
  read: (event: any) => string;
}

const FIELD_CASES: FieldCase[] = [
  { name: "steer.ack text", limit: 64_000, build: (text) => ({ type: "steer.ack", id: "s", status: "cancelled", message: "m", text }), read: (e) => e.text },
  { name: "file.diff path", limit: 400, build: (path) => ({ type: "file.diff", turn_id: "t", call_id: "c", evidence: "e", path, kind: "modified", added: 1, removed: 0, preview: "", truncated: false, total_lines: 1, diff_lines: 1, hunks: 1 }), read: (e) => e.path },
  { name: "activity subject", limit: 200, build: (subject) => ({ type: "activity", turn_id: "t", phase: "p", step: 1, segment: 1, subject }), read: (e) => e.subject },
  { name: "activity tool", limit: 200, build: (tool) => ({ type: "activity", turn_id: "t", phase: "p", step: 1, segment: 1, tool }), read: (e) => e.tool },
  { name: "tool.start tool", limit: 200, build: (tool) => ({ type: "tool.start", turn_id: "t", call_id: "c", tool, subject: "s", evidence: "e" }), read: (e) => e.tool },
  { name: "tool.detail diff", limit: MAX_DIFF_DETAIL, build: (diff) => ({ type: "tool.detail", id: "i", evidence: "e", tool: "t", subject: "s", status: "succeeded", args: "{}", output: "", duration_ms: null, diff }), read: (e) => e.diff },
  { name: "approval.request preview", limit: MAX_TEXT_FIELD, build: (preview) => ({ type: "approval.request", id: "a", turn_id: "t", tool: "t", subject: "s", preview, review: {} as any }), read: (e) => e.preview },
  { name: "slash.result output", limit: MAX_SLASH_OUTPUT, build: (output) => ({ type: "slash.result", id: "i", command: "c", success: true, output }), read: (e) => e.output },
  { name: "slash.result prompt", limit: MAX_TEXT_FIELD, build: (prompt) => ({ type: "slash.result", id: "i", command: "c", success: true, output: "", prompt }), read: (e) => e.prompt },
  { name: "error message", limit: MAX_TEXT_FIELD, build: (message) => ({ type: "error", code: "INTERNAL", message }), read: (e) => e.message },
  { name: "provider.result message", limit: MAX_TEXT_FIELD, build: (message) => ({ type: "provider.result", id: "i", provider: "p", success: false, message }), read: (e) => e.message },
  { name: "history user text", limit: 4000, build: (text) => ({ type: "history", session: "s", total: 1, messages: [{ role: "user", text }] }), read: (e) => e.messages[0].text },
  { name: "history tool name", limit: 80, build: (tool) => ({ type: "history", session: "s", total: 0, messages: [{ role: "tool", tool, text: "" }] }), read: (e) => e.messages[0].tool },
  { name: "history tool subject", limit: 200, build: (text) => ({ type: "history", session: "s", total: 0, messages: [{ role: "tool", tool: "t", text }] }), read: (e) => e.messages[0].text },
];

for (const field of FIELD_CASES) {
  test(`a credential straddling the ${field.name} limit is redacted whole, then the field is cut`, () => {
    withFreshBoundary(() => {
      const event = formatSafeSidecarEvent(field.build(straddle(field.limit)));
      assertNoSecretFragment(event, field.name);
      const value = field.read(event);
      assert.ok(value.length <= field.limit + MARKER_ALLOWANCE, `${field.name}: ${value.length} chars, limit ${field.limit}`);
      assert.match(value, /…\[truncated \d+ chars\]$/, `${field.name}: truncation marker`);
    });
  });
}

test("a field under its limit is not truncated and keeps ordinary text byte-for-byte", () => {
  withFreshBoundary(() => {
    const diff = "diff --git a/Makefile b/Makefile\n--- a/Makefile\n+++ b/Makefile\n@@ -1,2 +1,2 @@\n-all: old\n+all: build\n context line\n";
    const event: any = formatSafeSidecarEvent({
      type: "tool.detail", id: "i", evidence: "e", tool: "edit_file", subject: "Makefile", status: "succeeded", args: "{}", output: "", duration_ms: null, diff,
    });
    assert.equal(event.diff, diff);
  });
});

test("generated workspace paths survive and file paths are not corrupted", () => {
  withFreshBoundary(() => {
    const workspace = "/tmp/nexus-sidecar-otKj5G";
    const state: any = formatSafeSidecarEvent({
      type: "session.state", workspace, workspace_name: "nexus-sidecar-otKj5G", model: "m", mode: "auto", git: null, busy: false,
    });
    assert.equal(state.workspace, workspace);
    assert.equal(state.workspace_name, "nexus-sidecar-otKj5G");
    const file = "/tmp/nexus-sidecar-otKj5G/Makefile";
    const diff: any = formatSafeSidecarEvent({
      type: "file.diff", turn_id: "t", call_id: "c", evidence: "e", path: file, kind: "modified", added: 1, removed: 0, preview: "", truncated: false,
      total_lines: 1, diff_lines: 1, hunks: 1, full_path: "/tmp/nexus-sidecar-otKj5G/.nexus/diffs/e-c.diff",
    });
    assert.equal(diff.path, file);
    assert.equal(diff.full_path, "/tmp/nexus-sidecar-otKj5G/.nexus/diffs/e-c.diff");
  });
});

test("a secret-shaped directory name is redacted in workspace and workspace_name", () => {
  withFreshBoundary(() => {
    const event = formatSafeSidecarEvent({
      type: "session.state", workspace: `/work/${SECRET}`, workspace_name: SECRET, model: "m", mode: "auto", git: null, busy: false,
    });
    assertNoSecretFragment(event, "session.state");
    const state: any = event;
    assert.match(state.workspace, /^\/work\/\[REDACTED:/);
    assert.match(state.workspace_name, /^\[REDACTED:/);
    const diff = formatSafeSidecarEvent({
      type: "file.diff", turn_id: "t", call_id: "c", evidence: "e", path: `/work/${SECRET}/a.ts`, kind: "added", added: 1, removed: 0, preview: "", truncated: false,
      total_lines: 1, diff_lines: 1, hunks: 1, full_path: `/work/${SECRET}/.nexus/e.diff`,
    });
    assertNoSecretFragment(diff, "file.diff");
  });
});

test("embedded caps redact before they cut", () => {
  withFreshBoundary(() => {
    const capped = redactThenCap(straddle(120), 120);
    for (let i = 0; i + 6 <= SECRET_BODY.length; i++) assert.ok(!capped.includes(SECRET_BODY.slice(i, i + 6)));
    assert.match(capped, /…\[truncated \d+ chars\]$/);
  });
});

test("the protocol shape is unchanged for consumers: same fields, same truncation marker, version stamped", () => {
  withFreshBoundary(() => {
    const projected = formatSafeSidecarEvent({
      type: "session.state", workspace: "/w/app", workspace_name: "app", model: "m", mode: "auto", git: { branch: "main", dirty: 2 }, busy: false,
    });
    assert.ok(projected);
    const line = encodeEvent(projected);
    assert.equal(line.endsWith("\n"), true);
    assert.deepEqual(JSON.parse(line), {
      v: 1, type: "session.state", workspace: "/w/app", workspace_name: "app", model: "m", mode: "auto", git: { branch: "main", dirty: 2 }, busy: false,
    });
  });
});

test("an event is dropped, never sent half-redacted, when classification fails", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  const boundary = new InformationFlowBoundary();
  boundary.classifyText = () => { throw new Error("synthetic classifier failure"); };
  InformationFlowBoundary.setGlobalInstance(boundary);
  try {
    assert.equal(formatSafeSidecarEvent({ type: "notice", text: "raw" }), undefined);
    assert.equal(formatSafeSidecarEvent({ type: "session.state", workspace: "/w", workspace_name: "w", model: "m", mode: "auto", git: null, busy: false }), undefined);
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});
