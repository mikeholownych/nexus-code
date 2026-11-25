/**
 * HK-1: the `nexus-hooks` v1 declaration file. Every rejection here is a file Nexus refuses to act on; for the
 * operator's file that means every tool call is denied until it is fixed, so the messages must say what to fix.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hooksFor, loadHooksFile, parseHooksFile, HOOKS_PER_EVENT_LIMIT } from "../src/core/hooks.js";

const hook = (over: Record<string, unknown> = {}) => ({ name: "guard", tools: ["run_command"], command: "exit 0", ...over });
const doc = (pre: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, hooks: { "pre-tool": pre, ...extra } });

test("the documented example is accepted and comes back typed", () => {
  const file = parseHooksFile(`{
    "version": 1,
    "hooks": {
      "pre-tool": [ { "name": "no-force-push", "tools": ["run_command"], "command": "~/bin/nexus-guard.sh", "timeout_secs": 10 } ],
      "post-tool": [ { "name": "audit", "tools": ["*"], "command": ["/usr/bin/logger", "-t", "nexus-hook"], "timeout_secs": 5 } ]
    }
  }`);
  assert.deepEqual(file, {
    version: 1,
    hooks: {
      "pre-tool": [{ name: "no-force-push", tools: ["run_command"], command: "~/bin/nexus-guard.sh", timeout_secs: 10 }],
      "post-tool": [{ name: "audit", tools: ["*"], command: ["/usr/bin/logger", "-t", "nexus-hook"], timeout_secs: 5 }],
    },
  });
  assert.deepEqual(hooksFor(file, "pre-tool", "run_command").map((h) => h.name), ["no-force-push"]);
  assert.deepEqual(hooksFor(file, "pre-tool", "write_file"), []);
  assert.deepEqual(hooksFor(file, "post-tool", "anything").map((h) => h.name), ["audit"], '"*" names every tool');
});

test("accepted documents", () => {
  for (const text of [
    '{"version":1,"hooks":{}}',
    doc([]),
    doc([hook({ timeout_secs: 1 }), hook({ name: "b.B_2-x", timeout_secs: 60 })]),
    doc([hook({ tools: ["mcp__server__tool", "read_file"] })]),
    doc([hook({ command: ["/bin/true"] })]),
    doc(Array.from({ length: HOOKS_PER_EVENT_LIMIT }, (_, i) => hook({ name: `h${i}` }))),
    // The same name in the two events is two different hooks.
    doc([hook()], { "post-tool": [hook()] }),
  ]) {
    assert.doesNotThrow(() => parseHooksFile(text), text);
  }
});

test("rejected documents, each with a message that names the problem", () => {
  const cases: Array<[string, RegExp]> = [
    ["[]", /must be a JSON object/],
    ['{"hooks":{}}', /version must be 1/],
    ['{"version":2,"hooks":{}}', /version must be 1/],
    ['{"version":"1","hooks":{}}', /version must be 1/],
    ['{"version":1}', /hooks must be an object/],
    ['{"version":1,"hooks":[]}', /hooks must be an object/],
    ['{"version":1,"hooks":{},"disable":["operator"]}', /line 1: unknown key 'disable'/],
    ['{"version":1,"hooks":{"PreToolUse":[]}}', /unknown event 'PreToolUse' in hooks/],
    ['{"version":1,"hooks":{"session-start":[]}}', /event 'session-start' is not supported in this version/],
    ['{"version":1,"hooks":{"pre-verify":[]}}', /event 'pre-verify' is not supported in this version/],
    ['{"version":1,"hooks":{"pre-tool":{}}}', /hooks\.pre-tool must be an array/],
    [doc(["x"]), /hooks\.pre-tool\[0\] must be an object/],
    [doc([hook({ tool: "run_command" })]), /unknown key 'tool' in hooks\.pre-tool\[0\]/],
    [doc([hook({ matcher: "Bash" })]), /unknown key 'matcher'/],
    [doc([hook({ name: "" })]), /name must be 1 to 64 characters/],
    [doc([hook({ name: "has space" })]), /name must be/],
    [doc([hook({ name: "x".repeat(65) })]), /name must be/],
    [doc([hook({ name: 7 })]), /name must be/],
    [doc([hook(), hook()]), /name 'guard' is used twice in pre-tool/],
    [doc([hook({ tools: [] })]), /tools must list 1 to 64 tool names/],
    [doc([hook({ tools: "run_command" })]), /tools must list/],
    [doc([hook({ tools: Array.from({ length: 65 }, (_, i) => `t${i}`) })]), /tools must list 1 to 64/],
    // Anything that looks like a pattern: only exact names and the lone "*" exist.
    [doc([hook({ tools: ["run_.*"] })]), /"run_\.\*" is not an exact tool name/],
    [doc([hook({ tools: ["^write"] })]), /not an exact tool name/],
    [doc([hook({ tools: ["write_file|edit_file"] })]), /not an exact tool name/],
    [doc([hook({ tools: ["*", "run_command"] })]), /"\*" is not an exact tool name/],
    [doc([hook({ tools: ["run_*"] })]), /not an exact tool name/],
    [doc([hook({ tools: [1] })]), /not an exact tool name/],
    [doc([hook({ command: "" })]), /command must be a non-empty string/],
    [doc([hook({ command: "   " })]), /command must be a non-empty string/],
    [doc([hook({ command: [] })]), /command must be/],
    [doc([hook({ command: ["/bin/true", 1] })]), /command must be/],
    [doc([hook({ command: ["/bin/true", ""] })]), /command must be/],
    [doc([hook({ command: { run: "x" } })]), /command must be/],
    [doc([hook({ command: "a\u0000b" })]), /command must be/],
    [doc([hook({ timeout_secs: 0 })]), /timeout_secs must be a whole number from 1 to 60/],
    [doc([hook({ timeout_secs: 61 })]), /timeout_secs must be a whole number from 1 to 60/],
    [doc([hook({ timeout_secs: 1.5 })]), /timeout_secs must be/],
    [doc([hook({ timeout_secs: "10" })]), /timeout_secs must be/],
    [doc(Array.from({ length: HOOKS_PER_EVENT_LIMIT + 1 }, (_, i) => hook({ name: `h${i}` }))), /has 17 hooks; at most 16/],
  ];
  for (const [text, pattern] of cases) {
    assert.throws(() => parseHooksFile(text), (error: unknown) => error instanceof Error && pattern.test(error.message), `${text}\n  expected ${pattern}`);
  }
});

test("a second \"pre-tool\" key is refused instead of silently replacing the first", () => {
  // JSON.parse keeps the last key: this file would lose its guard without a word.
  const text = `{
  "version": 1,
  "hooks": {
    "pre-tool": [ { "name": "guard", "tools": ["*"], "command": "exit 2" } ],
    "pre-tool": []
  }
}`;
  assert.deepEqual(JSON.parse(text).hooks["pre-tool"], [], "what JSON.parse would have given");
  assert.throws(() => parseHooksFile(text), /line 5, column 5: duplicate key "pre-tool"/);
});

test("an unknown key is reported with its line", () => {
  const text = '{\n  "version": 1,\n  "hooks": {\n    "pre-tool": [\n      {\n        "name": "g",\n        "tool": "run_command",\n        "command": "x"\n      }\n    ]\n  }\n}';
  assert.throws(() => parseHooksFile(text), /^HooksConfigError: line 7: unknown key 'tool' in hooks\.pre-tool\[0\]$|^line 7: unknown key 'tool' in hooks\.pre-tool\[0\]$/);
});

test("loading from disk: absent, valid, invalid, oversize, and the operator file's ownership rules", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nx-hooks-config-"));
  try {
    const file = path.join(dir, "hooks.json");
    assert.deepEqual(loadHooksFile(file, true), { state: "absent" });

    fs.writeFileSync(file, doc([hook()]), { mode: 0o600 });
    const ok = loadHooksFile(file, true);
    assert.equal(ok.state, "ok");
    assert.match((ok as any).sha256, /^[0-9a-f]{64}$/);

    fs.writeFileSync(file, '{"version":1,"hooks":{"pre-tool":[{"name":"g"}]}}');
    const invalid = loadHooksFile(file, true);
    assert.equal(invalid.state, "invalid");
    assert.match((invalid as any).problem, /tools must list/);
    assert.match((invalid as any).sha256, /^[0-9a-f]{64}$/, "an invalid file still has a hash to show");

    fs.writeFileSync(file, "{not json");
    assert.match((loadHooksFile(file, true) as any).problem, /line 1, column 2/);

    fs.writeFileSync(file, Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]));
    assert.match((loadHooksFile(file, true) as any).problem, /byte order mark/);

    fs.writeFileSync(file, `${doc([hook()])}${" ".repeat(64 * 1024)}`);
    assert.match((loadHooksFile(file, true) as any).problem, /exceeds the 64 KiB size limit/);

    // A group-writable operator file is refused; the same bytes as a project file are read (its trust is the hash).
    fs.writeFileSync(file, doc([hook()]));
    fs.chmodSync(file, 0o664);
    assert.match((loadHooksFile(file, true) as any).problem, /permissions are too open/);
    assert.equal(loadHooksFile(file, false).state, "ok");

    const link = path.join(dir, "link.json");
    fs.symlinkSync(file, link);
    assert.match((loadHooksFile(link, false) as any).problem, /symbolic link/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
