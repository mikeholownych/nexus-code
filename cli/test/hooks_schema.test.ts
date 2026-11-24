/**
 * HK-1: the hook contract as published. The checked-in JSON Schema (docs/protocol/hooks-v1.schema.json) is what the
 * types generate, its ledger records the version decision, and documents the reader accepts fit the schema.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../scripts/gen_protocol_schema.mjs";
import { generateHooksSchema, HOOKS_LEDGER_FILE, hooksLedgerProblem, hooksSchemaFile } from "../scripts/gen_hooks_schema.mjs";
import { EXTENSION_TRUST_VERSION } from "../src/core/content_trust.js";
import { HOOK_EVENTS, HOOKS_SCHEMA_VERSION, parseHooksFile } from "../src/core/hooks.js";
import { validate } from "./helpers/json_schema.js";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_TEXT = fs.readFileSync(hooksSchemaFile(HOOKS_SCHEMA_VERSION), "utf8");
const schema = JSON.parse(SCHEMA_TEXT);
const fits = (value: unknown, def: string) => validate(value, schema.$defs[def], schema);

test("the checked-in hooks schema equals a fresh generation from src/core/hooks.ts", () => {
  const generated = generateHooksSchema();
  assert.equal(generated.version, HOOKS_SCHEMA_VERSION);
  assert.equal(generated.text, SCHEMA_TEXT, "docs/protocol/hooks schema is out of date: run `node cli/scripts/gen_hooks_schema.mjs`, then record the version decision in HOOKS_VERSIONS.json");
});

test("the generator's --check passes on the checked-in schema and ledger", () => {
  const out = execFileSync(process.execPath, [path.join(cli, "scripts", "gen_hooks_schema.mjs"), "--check"], { cwd: cli, encoding: "utf8" });
  assert.match(out, /hooks-v1\.schema\.json is current/);
});

test("the newest hooks ledger entry records the current schema and schema_version", () => {
  const ledger = JSON.parse(fs.readFileSync(HOOKS_LEDGER_FILE, "utf8"));
  assert.equal(hooksLedgerProblem(SCHEMA_TEXT, ledger, HOOKS_SCHEMA_VERSION), undefined);
  for (const entry of ledger) {
    assert.ok(Number.isInteger(entry.schema_version) && /^[0-9a-f]{64}$/.test(entry.schemaSha256) && typeof entry.note === "string" && entry.note.trim(), "each entry has schema_version, schemaSha256 and a note");
  }
  assert.equal(ledger[ledger.length - 1].schemaSha256, sha256(SCHEMA_TEXT));
  assert.match(hooksLedgerProblem(`${SCHEMA_TEXT} `, ledger, HOOKS_SCHEMA_VERSION) ?? "", /add an entry/);
  assert.match(hooksLedgerProblem(SCHEMA_TEXT, ledger, HOOKS_SCHEMA_VERSION + 1) ?? "", /HOOKS_SCHEMA_VERSION is/);
});

test("the schema names the documents, the events and the versions the code uses", () => {
  for (const def of ["HooksFile", "HookDeclaration", "HookInput", "HookOutput", "ExtensionTrustStore", "ExtensionTrustEntry"]) assert.ok(schema.$defs[def], def);
  const file = schema.$defs.HooksFile;
  assert.deepEqual(file.required, ["hooks", "version"]);
  assert.equal(file.properties.version.const, HOOKS_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(file.properties.hooks.properties).sort(), [...HOOK_EVENTS].sort());
  assert.equal(schema.$defs.ExtensionTrustStore.properties.version.const, EXTENSION_TRUST_VERSION);
  assert.deepEqual(schema.$defs.HookDeclaration.required, ["command", "name", "tools"]);
  // No member of a hook's answer is required: empty output is a valid answer.
  assert.equal(schema.$defs.HookOutput.required, undefined);
});

test("documents the reader accepts fit the schema, and shape errors do not", () => {
  const accepted = [
    '{"version":1,"hooks":{}}',
    '{"version":1,"hooks":{"pre-tool":[{"name":"g","tools":["run_command"],"command":"~/bin/guard.sh","timeout_secs":10}],"post-tool":[{"name":"a","tools":["*"],"command":["/usr/bin/logger","-t","nexus-hook"]}]}}',
  ];
  for (const text of accepted) assert.deepEqual(fits(parseHooksFile(text), "HooksFile"), [], text);
  assert.notDeepEqual(fits({ version: 2, hooks: {} }, "HooksFile"), []);
  assert.notDeepEqual(fits({ version: 1 }, "HooksFile"), []);
  assert.notDeepEqual(fits({ version: 1, hooks: { "pre-tool": [{ name: "g", tools: "run_command", command: "x" }] } }, "HooksFile"), []);
  assert.notDeepEqual(fits({ version: 1, hooks: { "pre-tool": [{ name: "g", tools: ["x"], command: 5 }] } }, "HooksFile"), []);

  const input = { session_id: "t", cwd: "/w", hook_event_name: "PreToolUse", nexus_event: "pre-tool", permission_mode: "auto", tool_name: "run_command", tool_input: { command: "ls" } };
  assert.deepEqual(fits(input, "HookInput"), []);
  assert.deepEqual(fits({ ...input, hook_event_name: "PostToolUse", nexus_event: "post-tool", tool_response: { success: true, output: "x", error: null } }, "HookInput"), []);
  assert.notDeepEqual(fits({ ...input, hook_event_name: "SessionStart" }, "HookInput"), []);
  assert.notDeepEqual(fits({ ...input, permission_mode: "yolo" }, "HookInput"), []);

  assert.deepEqual(fits({}, "HookOutput"), []);
  assert.deepEqual(fits({ decision: "block", reason: "no" }, "HookOutput"), []);
  assert.deepEqual(fits({ hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "why" } }, "HookOutput"), []);
  assert.notDeepEqual(fits({ decision: "maybe" }, "HookOutput"), []);

  const entry = { kind: "project-hooks", scope: "/w", key: ".nexus/hooks.json", sha256: "0".repeat(64), approvedAt: "2026-11-24T00:00:00.000Z", summary: "s" };
  assert.deepEqual(fits({ version: 1, entries: [entry] }, "ExtensionTrustStore"), []);
  assert.notDeepEqual(fits({ version: 1, entries: [{ ...entry, kind: "anything" }] }, "ExtensionTrustStore"), []);
});
