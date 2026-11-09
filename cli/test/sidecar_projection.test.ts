import { test } from "node:test";
import assert from "node:assert/strict";
import { InformationFlowBoundary } from "../src/core/egress.js";
import { MAX_DETAIL, MAX_DIFF_DETAIL } from "../src/evidence.js";
import { capText, encodeEvent, MAX_SLASH_OUTPUT, MAX_TEXT_FIELD, type SidecarEvent } from "../src/protocol.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApplicationCore } from "../src/core/app.js";
import { FIELD_LIMITS, formatSafeSidecarEvent, redactThenCap, SidecarServer } from "../src/sidecar.js";
import { makeHome, makeRepo } from "./helpers/fixtures.js";

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

test("review item 12: a SidecarServer writes a tool.end and a nested history turn redacted and cut, through its write hook", () => {
  const repo = makeRepo();
  const home = makeHome();
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = new ApplicationCore({ endpoint: "http://127.0.0.1:9", model: "m", maxSteps: 1, temperature: 0, workspace: repo, shell: "bash", approvalMode: "auto", fullAccess: true } as any);
  const lines: string[] = [];
  try {
    withFreshBoundary(() => {
      const server = new SidecarServer({ app, mode: "auto", write: (line) => lines.push(line) });
      const emit = (event: SidecarEvent) => (server as any).emit(event);
      emit({ type: "tool.end", turn_id: "t", call_id: "c", tool: "run_command", success: false, evidence: "e", lines: 3, summary: straddle(400), preview: straddle(6_000) });
      emit({
        type: "history", session: "s", total: 2, messages: [
          { role: "user", text: `deploy with ${SECRET}` },
          { role: "outcome", text: "done", heading: `Completed ${SECRET}`, turn: { detail: `token ${SECRET}`, reason: "x" } as any },
        ],
      });
    });
    assert.equal(lines.length, 2, "both frames were written");
    const [toolEnd, history] = lines.map((line) => JSON.parse(line));
    assertNoSecretFragment(toolEnd, "tool.end frame");
    assertNoSecretFragment(history, "history frame");
    for (const field of ["summary", "preview"] as const) {
      const max = (FIELD_LIMITS["tool.end"] as Record<string, number>)[field];
      assert.ok(max, `tool.end ${field} has a limit`);
      assert.ok(toolEnd[field].length <= max + MARKER_ALLOWANCE, `tool.end ${field}: ${toolEnd[field].length} chars, limit ${max}`);
    }
  } finally {
    app.shutdown();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/**
 * Every protocol event type is classified: its free-text fields (text that comes from the model, a tool, the operator
 * or a provider) each have a limit in FIELD_LIMITS, or the type is structured and bounded elsewhere (reason given).
 * A new event type, or a new free-text field, fails here until it is classified.
 */
const FREE_TEXT: Record<string, readonly string[] | string> = {
  hello: "static slash catalog",
  "session.state": "paths go through PATH_FIELDS; model id and enums",
  "assistant.delta": ["text"],
  activity: ["tool", "subject"],
  "file.diff": ["path", "preview", "note"],
  "steer.ack": ["message", "text"],
  "tool.start": ["tool", "subject"],
  "tool.end": ["tool", "summary", "preview"],
  "approval.request": ["tool", "subject", "preview"],
  "checkpoint.choice.request": ["message"],
  "turn.result": ["heading", "line"],
  "slash.result": ["output", "prompt", "composer"],
  notice: ["text"],
  history: "entries cut by HISTORY_LIMITS",
  "tool.detail": ["tool", "subject", "args", "output", "diff"],
  receipt: "structured sections built by Nexus",
  error: ["message"],
  "models.catalog": "structured provider and model lists",
  "provider.auth": ["instructions"],
  "provider.result": ["message"],
  "model.result": ["message"],
};

test("review item 12: FIELD_LIMITS covers every free-text field of every protocol event type, and nothing else", () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "protocol.ts"), "utf8");
  const union = source.slice(source.indexOf("export type SidecarEvent ="), source.indexOf("export type SidecarCommand"));
  const types = [...new Set([...union.matchAll(/type: "([a-z.]+)"/g)].map((m) => m[1]))].sort();
  assert.ok(types.length >= 20, `parsed ${types.length} event types`);
  assert.deepEqual(Object.keys(FREE_TEXT).sort(), types, "every protocol event type is classified, and only those");
  const limits = FIELD_LIMITS as Record<string, Record<string, number>>;
  for (const type of types) {
    const fields = FREE_TEXT[type];
    const table = limits[type] ?? {};
    if (typeof fields === "string") {
      assert.deepEqual(Object.keys(table), [], `${type} is structured (${fields}) and has no field limits`);
      continue;
    }
    for (const field of fields) assert.ok(Number.isInteger(table[field]) && table[field] > 0, `${type}.${field} has a limit`);
    assert.deepEqual(Object.keys(table).sort(), [...fields].sort(), `${type}: no limit on a field the protocol does not carry`);
  }
});

test("Entire 01M70D1HN3YR / 01M70D4NYM7J: an over-cap ledger record keeps the producer's truncation count through the projection", () => {
  withFreshBoundary(() => {
    const big = (n: number) => "line of tool output\n".repeat(Math.ceil(n / 20)).slice(0, n);
    const args = capText(big(MAX_DETAIL + 50_000), MAX_DETAIL);
    const output = capText(big(MAX_DETAIL + 300_000), MAX_DETAIL);
    const diff = capText(big(MAX_DIFF_DETAIL + 900_000), MAX_DIFF_DETAIL);
    const event: any = formatSafeSidecarEvent({ type: "tool.detail", id: "i", evidence: "e", tool: "run_command", subject: "s", status: "succeeded", args, output, duration_ms: 1, diff });
    assert.equal(event.args, args, "args unchanged: …[truncated 50000 chars]");
    assert.equal(event.output, output, "output unchanged: …[truncated 300000 chars]");
    assert.equal(event.diff, diff, "diff unchanged: …[truncated 900000 chars]");
    assert.match(event.output, /…\[truncated 300000 chars\]$/);
  });
});
