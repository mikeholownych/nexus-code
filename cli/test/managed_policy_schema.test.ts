/**
 * GV-1: the policy document as a contract. The validator (`validatePolicyDocument`), the published JSON Schema
 * (docs/protocol/policy-v1.schema.json) with its version ledger, and the examples of docs/MANAGED_POLICY.md: the three
 * must agree, so that the documentation cannot drift from the parser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../scripts/gen_protocol_schema.mjs";
import { generatePolicySchema, POLICY_LEDGER_FILE, policyLedgerProblem, policySchemaFile } from "../scripts/gen_policy_schema.mjs";
import { mergePolicies, POLICY_KEYS, POLICY_SCHEMA_VERSION, PolicyValidationError, SUPPORTED_POLICY_SCHEMA_VERSIONS, validatePolicyDocument, type PolicyValidationCode } from "../src/core/managed_policy.js";
import { parsePolicyToml } from "../src/core/managed_policy_toml.js";
import { validate } from "./helpers/json_schema.js";
import { PLAN_KEYS, randomDocument, renderPolicyToml, seeded, type Loose } from "./helpers/policy_fixture.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCHEMA_TEXT = fs.readFileSync(policySchemaFile(POLICY_SCHEMA_VERSION), "utf8");
const schema = JSON.parse(SCHEMA_TEXT);
const check = (text: string) => validatePolicyDocument(parsePolicyToml(text));

test("the checked-in policy schema equals a fresh generation from src/core/managed_policy.ts", () => {
  const generated = generatePolicySchema();
  assert.equal(generated.version, POLICY_SCHEMA_VERSION);
  assert.equal(generated.text, SCHEMA_TEXT, "docs/protocol/policy schema is out of date: run `node cli/scripts/gen_policy_schema.mjs`, then record the version decision in POLICY_VERSIONS.json");
});

test("the newest policy ledger entry records the current schema and schema_version", () => {
  const ledger = JSON.parse(fs.readFileSync(POLICY_LEDGER_FILE, "utf8"));
  assert.equal(policyLedgerProblem(SCHEMA_TEXT, ledger, POLICY_SCHEMA_VERSION), undefined);
  for (const entry of ledger) {
    assert.ok(Number.isInteger(entry.schema_version) && /^[0-9a-f]{64}$/.test(entry.schemaSha256) && typeof entry.note === "string" && entry.note.trim(), "each entry has schema_version, schemaSha256 and a note");
  }
  assert.match(policyLedgerProblem(`${SCHEMA_TEXT} `, ledger, POLICY_SCHEMA_VERSION) ?? "", /add an entry/);
  assert.match(policyLedgerProblem(SCHEMA_TEXT, ledger, POLICY_SCHEMA_VERSION + 1) ?? "", /POLICY_SCHEMA_VERSION is/);
  assert.match(policyLedgerProblem(SCHEMA_TEXT, [], POLICY_SCHEMA_VERSION) ?? "", /no entries/);
  assert.equal(ledger[ledger.length - 1].schemaSha256, sha256(SCHEMA_TEXT));
  assert.deepEqual(SUPPORTED_POLICY_SCHEMA_VERSIONS, [POLICY_SCHEMA_VERSION]);
});

test("the schema and the validator name the same tables and keys, with matching types", () => {
  const root = schema.$defs.ManagedPolicyFile;
  assert.deepEqual(root.required, ["schema_version"]);
  assert.deepEqual(root.properties.schema_version.const, POLICY_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(root.properties).sort(), [...Object.keys(POLICY_KEYS), "schema_version"].sort());
  for (const [table, keys] of Object.entries(POLICY_KEYS)) {
    const tableSchema = schema.$defs[root.properties[table].$ref.split("/").pop()];
    assert.deepEqual(Object.keys(tableSchema.properties).sort(), Object.keys(keys).sort(), table);
    assert.equal(tableSchema.required, undefined, `${table}: every key is optional`);
    for (const [key, spec] of Object.entries(keys)) {
      let member = tableSchema.properties[key];
      if (member.$ref) member = schema.$defs[member.$ref.split("/").pop()];
      const name = `${table}.${key}`;
      if (spec.kind === "bool") assert.equal(member.type, "boolean", name);
      else if (spec.kind === "enum") assert.deepEqual(member.enum, [...spec.values].sort(), name);
      else assert.equal(member.type, "array", name);
    }
  }
  // An enumeration of list items: the schema lists the same values the validator accepts.
  assert.deepEqual(schema.$defs.HumanEffect.enum, ["egress", "exec", "write_workspace"]);
  // No key of any table can express a grant: the names say what they switch off, require, forbid, protect or admit.
  assert.ok(!JSON.stringify(Object.keys(POLICY_KEYS.commands)).includes("allow\""), "commands has no allow list");
  assert.deepEqual(POLICY_KEYS.verification.mode.values, ["approve", "block"]);
  assert.deepEqual(POLICY_KEYS.egress.inspector.values, ["record", "block"]);
});

const GENERATED = 300;

test(`${GENERATED} generated policy files: the validator returns the document, and the document passes the published schema`, () => {
  const random = seeded(0x5c4e);
  for (let i = 0; i < GENERATED; i++) {
    const document = randomDocument(random);
    const text = renderPolicyToml(document, { random });
    const validated = check(text);
    assert.equal(validated.schemaVersion, 1);
    assert.deepEqual(validated.document, document, text);
    assert.deepEqual(validate({ schema_version: 1, ...validated.document }, schema, schema), [], text);
    // Every key that is set has a line, and only those.
    const set = Object.entries(document as Loose).flatMap(([table, keys]) => Object.keys(keys ?? {}).map((key) => `${table}.${key}`));
    assert.deepEqual([...validated.lines.keys()].sort(), set.sort());
    for (const line of validated.lines.values()) assert.ok(line >= 1 && line <= text.split("\n").length);
  }
});

test("the schema rejects what it can express: a missing or wrong schema_version, a wrong type, a value outside an enumeration", () => {
  assert.ok(validate({}, schema, schema).length > 0);
  assert.ok(validate({ schema_version: 2 }, schema, schema).length > 0);
  assert.ok(validate({ schema_version: 1, approval: { strict: "yes" } }, schema, schema).length > 0);
  assert.ok(validate({ schema_version: 1, verification: { mode: "off" } }, schema, schema).length > 0);
  assert.ok(validate({ schema_version: 1, egress: { inspector: "off" } }, schema, schema).length > 0);
  assert.ok(validate({ schema_version: 1, approval: { require_human: ["read"] } }, schema, schema).length > 0);
  assert.ok(validate({ schema_version: 1, mcp: { allow: "github" } }, schema, schema).length > 0);
  // Known gap, stated in docs/protocol/README.md: the schema is open, the validator is not.
  assert.deepEqual(validate({ schema_version: 1, approval: { unknown_key: true }, unknown_table: {} }, schema, schema), []);
  assert.throws(() => check("schema_version = 1\n[unknown_table]\n"), /unknown table/);
});

const INVALID: { name: string; text: string; code: PolicyValidationCode; line?: number; message: string }[] = [
  { name: "an empty file", text: "", code: "empty", message: "the file is empty; a policy file needs at least the line `schema_version = 1`" },
  { name: "comments only", text: "# later\n", code: "empty", message: "the file is empty; a policy file needs at least the line `schema_version = 1`" },
  { name: "no schema_version", text: "[approval]\nstrict = true", code: "schema_version_missing", message: "schema_version is missing; add `schema_version = 1` as the first line" },
  { name: "an empty table and no schema_version", text: "[approval]", code: "schema_version_missing", message: "schema_version is missing; add `schema_version = 1` as the first line" },
  { name: "schema_version as a string", text: 'schema_version = "1"', code: "wrong_type", line: 1, message: "line 1: key 'schema_version' must be a whole number" },
  { name: "schema_version as a boolean", text: "schema_version = true", code: "wrong_type", line: 1, message: "line 1: key 'schema_version' must be a whole number" },
  { name: "a newer schema_version", text: "\nschema_version = 2", code: "schema_version_unsupported", line: 2, message: "line 2: schema_version 2 is not supported by this Nexus (supported: 1); upgrade Nexus before rolling out this policy" },
  { name: "a newer schema_version with keys this build does not know", text: "schema_version = 3\n[future]\nkey = 1", code: "schema_version_unsupported", line: 1, message: "line 1: schema_version 3 is not supported by this Nexus (supported: 1); upgrade Nexus before rolling out this policy" },
  { name: "schema_version inside a table", text: "[approval]\nschema_version = 1", code: "schema_version_missing", message: "schema_version is missing; add `schema_version = 1` as the first line" },
  { name: "an unknown root key", text: "schema_version = 1\nstrict = true", code: "unknown_key", line: 2, message: "line 2: unknown key 'strict'" },
  { name: "a table name used as a root key", text: "schema_version = 1\napproval = true", code: "unknown_key", line: 2, message: "line 2: unknown key 'approval' ('approval' is a table: write [approval])" },
  { name: "an unknown table", text: "schema_version = 1\n[aproval]", code: "unknown_table", line: 2, message: "line 2: unknown table '[aproval]'" },
  { name: "a table that is an object member", text: "schema_version = 1\n[constructor]", code: "unknown_table", line: 2, message: "line 2: unknown table '[constructor]'" },
  { name: "an unknown key", text: "schema_version = 1\n[approval]\n\ndisable_yess = true", code: "unknown_key", line: 4, message: "line 4: unknown key 'approval.disable_yess'" },
  { name: "a key that is an object member", text: "schema_version = 1\n[approval]\nto_string = true", code: "unknown_key", line: 3, message: "line 3: unknown key 'approval.to_string'" },
  { name: "a grant: commands.allow", text: 'schema_version = 1\n[commands]\nallow = ["ls"]', code: "unknown_key", line: 3, message: "line 3: unknown key 'commands.allow'" },
  { name: "a grant: workspace.trusted", text: "schema_version = 1\n[workspace]\ntrusted = true", code: "unknown_key", line: 3, message: "line 3: unknown key 'workspace.trusted'" },
  { name: "a grant: approval.mode", text: 'schema_version = 1\n[approval]\nmode = "auto"', code: "unknown_key", line: 3, message: "line 3: unknown key 'approval.mode'" },
  { name: "a boolean as a string", text: 'schema_version = 1\n[approval]\nstrict = "true"', code: "wrong_type", line: 3, message: "line 3: key 'approval.strict' must be true or false" },
  { name: "a boolean as a number", text: "schema_version = 1\n[sandbox]\nrequired = 1", code: "wrong_type", line: 3, message: "line 3: key 'sandbox.required' must be true or false" },
  { name: "a list as a string", text: 'schema_version = 1\n[mcp]\nallow = "github"', code: "wrong_type", line: 3, message: "line 3: key 'mcp.allow' must be an array of strings (MCP server entries)" },
  { name: "a list as a boolean", text: "schema_version = 1\n[commands]\nforbid = true", code: "wrong_type", line: 3, message: "line 3: key 'commands.forbid' must be an array of strings (command prefixes)" },
  { name: "an enumeration as a boolean", text: "schema_version = 1\n[verification]\nmode = true", code: "wrong_type", line: 3, message: `line 3: key 'verification.mode' must be "approve" or "block"` },
  { name: "verification.mode off", text: 'schema_version = 1\n[verification]\nmode = "off"', code: "bad_value", line: 3, message: `line 3: key 'verification.mode' must be "approve" or "block" (found "off"); a policy can only raise this, never lower it` },
  { name: "verification.mode record", text: 'schema_version = 1\n[verification]\nmode = "record"', code: "bad_value", line: 3, message: `line 3: key 'verification.mode' must be "approve" or "block" (found "record"); a policy can only raise this, never lower it` },
  { name: "egress.inspector off", text: 'schema_version = 1\n[egress]\ninspector = "off"', code: "bad_value", line: 3, message: `line 3: key 'egress.inspector' must be "record" or "block" (found "off"); a policy can only raise this, never lower it` },
  { name: "an unknown effect", text: 'schema_version = 1\n[approval]\nrequire_human = ["exec", "read"]', code: "bad_value", line: 3, message: `line 3: key 'approval.require_human', item 2 ("read") must be one of "exec", "write_workspace", "egress"` },
  { name: "an empty glob, on its own line", text: 'schema_version = 1\n[paths]\nprotected = [\n  "a",\n  "",\n]', code: "bad_value", line: 5, message: `line 5: key 'paths.protected', item 2 ("") must not be empty` },
  { name: "a padded glob", text: 'schema_version = 1\n[verification]\nprotected = [" ci/**"]', code: "bad_value", line: 3, message: `line 3: key 'verification.protected', item 1 (" ci/**") must not start or end with a space` },
  { name: "a command with doubled spaces", text: 'schema_version = 1\n[commands]\nforbid = ["git  push"]', code: "bad_value", line: 3, message: `line 3: key 'commands.forbid', item 1 ("git  push") must be command words separated by single spaces, such as "git push"` },
  { name: "an empty command", text: 'schema_version = 1\n[commands]\nprompt = [""]', code: "bad_value", line: 3, message: `line 3: key 'commands.prompt', item 1 ("") must be command words separated by single spaces, such as "git push"` },
  { name: "a command of 17 words", text: `schema_version = 1\n[commands]\nforbid = ["${Array.from({ length: 17 }, () => "w").join(" ")}"]`, code: "bad_value", line: 3, message: `line 3: key 'commands.forbid', item 1 ("w w w w w w w w w w w w w w w w w") must have at most 16 words` },
  { name: "an uppercase host", text: 'schema_version = 1\n[egress]\nallowed_domains = ["Example.com"]', code: "bad_value", line: 3, message: `line 3: key 'egress.allowed_domains', item 1 ("Example.com") must be a lowercase host name such as "example.com", or "*.example.com" for its subdomains` },
  { name: "a URL as a host", text: 'schema_version = 1\n[egress]\nallowed_domains = ["https://example.com"]', code: "bad_value", line: 3, message: `line 3: key 'egress.allowed_domains', item 1 ("https://example.com") must be a lowercase host name such as "example.com", or "*.example.com" for its subdomains` },
  { name: "a wildcard in the middle of a host", text: 'schema_version = 1\n[egress]\nallowed_domains = ["api.*.example.com"]', code: "bad_value", line: 3, message: `line 3: key 'egress.allowed_domains', item 1 ("api.*.example.com") must be a lowercase host name such as "example.com", or "*.example.com" for its subdomains` },
  { name: "a bare wildcard host", text: 'schema_version = 1\n[egress]\nallowed_domains = ["*"]', code: "bad_value", line: 3, message: `line 3: key 'egress.allowed_domains', item 1 ("*") must be a lowercase host name such as "example.com", or "*.example.com" for its subdomains` },
  { name: "an origin with a path", text: 'schema_version = 1\n[egress]\nsecret_destinations = ["https://api.example.com/v1"]', code: "bad_value", line: 3, message: `line 3: key 'egress.secret_destinations', item 1 ("https://api.example.com/v1") must be an origin in canonical form, such as "https://api.example.com" (scheme and lowercase host, optional port, no path)` },
  { name: "an origin that is not canonical", text: 'schema_version = 1\n[egress]\nsecret_destinations = ["https://API.example.com:443"]', code: "bad_value", line: 3, message: `line 3: key 'egress.secret_destinations', item 1 ("https://API.example.com:443") must be an origin in canonical form, such as "https://api.example.com" (scheme and lowercase host, optional port, no path)` },
  { name: "an origin of another scheme", text: 'schema_version = 1\n[egress]\nsecret_destinations = ["file:///etc"]', code: "bad_value", line: 3, message: `line 3: key 'egress.secret_destinations', item 1 ("file:///etc") must be an origin in canonical form, such as "https://api.example.com" (scheme and lowercase host, optional port, no path)` },
  { name: "an mcp entry with an unknown prefix", text: 'schema_version = 1\n[mcp]\nallow = ["cmd:/usr/bin/x"]', code: "bad_value", line: 3, message: `line 3: key 'mcp.allow', item 1 ("cmd:/usr/bin/x") must be a server name (letters, digits, '.', '_', '-'), "command:/absolute/path" or "url:https://origin"` },
  { name: "an mcp command that is relative", text: 'schema_version = 1\n[mcp]\nallow = ["command:bin/server"]', code: "bad_value", line: 3, message: `line 3: key 'mcp.allow', item 1 ("command:bin/server") a command: entry needs an absolute, normalized path, such as "command:/usr/local/bin/server"` },
  { name: "an mcp command with a parent segment", text: 'schema_version = 1\n[mcp]\nallow = ["command:/usr/../bin/server"]', code: "bad_value", line: 3, message: `line 3: key 'mcp.allow', item 1 ("command:/usr/../bin/server") a command: entry needs an absolute, normalized path, such as "command:/usr/local/bin/server"` },
  { name: "an mcp url with a path", text: 'schema_version = 1\n[mcp]\nallow = ["url:https://mcp.example.com/sse"]', code: "bad_value", line: 3, message: `line 3: key 'mcp.allow', item 1 ("url:https://mcp.example.com/sse") a url: entry needs an origin in canonical form, such as "url:https://mcp.example.com"` },
  { name: "an mcp wildcard", text: 'schema_version = 1\n[mcp]\nallow = ["*"]', code: "bad_value", line: 3, message: `line 3: key 'mcp.allow', item 1 ("*") must be a server name (letters, digits, '.', '_', '-'), "command:/absolute/path" or "url:https://origin"` },
  { name: "a plugin by name", text: 'schema_version = 1\n[plugins]\nallow = ["audit"]', code: "bad_value", line: 3, message: `line 3: key 'plugins.allow', item 1 ("audit") must be "sha256:<64 hex digits>" or "file:/absolute/path"` },
  { name: "a short plugin hash", text: 'schema_version = 1\n[plugins]\nallow = ["sha256:abc123"]', code: "bad_value", line: 3, message: `line 3: key 'plugins.allow', item 1 ("sha256:abc123") a sha256: entry needs 64 lowercase hexadecimal digits` },
  { name: "an uppercase plugin hash", text: `schema_version = 1\n[plugins]\nallow = ["sha256:${"AB".repeat(32)}"]`, code: "bad_value", line: 3, message: `line 3: key 'plugins.allow', item 1 ("sha256:${"AB".repeat(32).slice(0, 53)}...") a sha256: entry needs 64 lowercase hexadecimal digits` },
  { name: "a relative plugin file", text: 'schema_version = 1\n[plugins]\nallow = ["file:plugins/x.mjs"]', code: "bad_value", line: 3, message: `line 3: key 'plugins.allow', item 1 ("file:plugins/x.mjs") a file: entry needs an absolute, normalized path, such as "file:/opt/nexus/plugins/audit.mjs"` },
];

for (const { name, text, code, line, message } of INVALID) {
  test(`validator rejects: ${name}`, () => {
    assert.throws(
      () => check(text),
      (error: unknown) => {
        assert.ok(error instanceof PolicyValidationError, `threw ${String(error)}`);
        assert.deepEqual([error.code, error.line, error.message], [code, line, message]);
        return true;
      },
    );
  });
}

test("the validator accepts the smallest file, every key at once, and folds duplicate items", () => {
  assert.deepEqual(check("schema_version = 1"), { schemaVersion: 1, document: {}, lines: new Map() });
  assert.deepEqual(check("schema_version = 1\n[approval]\n[mcp]").document, { approval: {}, mcp: {} });
  assert.deepEqual(check('schema_version = 1\n[commands]\nforbid = ["git push", "rm -rf", "git push"]\n[mcp]\nallow = []').document, { commands: { forbid: ["git push", "rm -rf"] }, mcp: { allow: [] } });
  const everything: Loose = {};
  for (const row of PLAN_KEYS) (everything[row.table] ??= {})[row.key] = row.rule === "or" ? true : row.rule === "max" ? row.values[1] : [...row.values];
  const validated = check(renderPolicyToml(everything));
  assert.deepEqual(validated.document, everything);
  assert.equal(validated.lines.size, PLAN_KEYS.length);
  assert.deepEqual(validate({ schema_version: 1, ...validated.document }, schema, schema), []);
});

// ---------------------------------------------------------------------------------------------------------------------
// docs/MANAGED_POLICY.md

const DOC = fs.readFileSync(path.join(repo, "docs", "MANAGED_POLICY.md"), "utf8");

function fenced(language: string): { text: string; line: number }[] {
  const blocks: { text: string; line: number }[] = [];
  const lines = DOC.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== `\`\`\`${language}`) continue;
    const start = i + 1;
    while (++i < lines.length && lines[i].trim() !== "```");
    blocks.push({ text: `${lines.slice(start, i).join("\n")}\n`, line: start });
  }
  return blocks;
}

test("every TOML example in docs/MANAGED_POLICY.md parses, validates and passes the published schema", () => {
  const blocks = fenced("toml");
  assert.equal(blocks.length, 5, "the examples of the document (update this count when adding one)");
  for (const { text, line } of blocks) {
    const validated = check(text);
    assert.deepEqual(validate({ schema_version: 1, ...validated.document }, schema, schema), [], `the example at line ${line}`);
  }
  // No other fence carries policy text that would escape the check.
  assert.deepEqual([...DOC.matchAll(/^```(\w*)$/gm)].map((m) => m[1]).filter((language) => !["toml", "text", ""].includes(language)), []);
});

test("the complete example sets every key of the format, and the worked examples give the documented results", () => {
  const blocks = fenced("toml").map(({ text }) => check(text));
  const complete = blocks.find((block) => block.lines.size === PLAN_KEYS.length);
  assert.ok(complete, "one example sets every key");
  // Example 1: a user file's `false` does not undo the system's `true`.
  const [system1, user1, system2, user2] = blocks;
  const one = mergePolicies({ document: system1.document, file: "/etc/nexus/policy.toml" }, { document: user1.document });
  assert.deepEqual([one.approval.strict.value, one.approval.disable_yes.value, one.approval.disable_yes.source.tier, one.approval.disable_yes.source.key], [true, true, "system", "approval.strict"]);
  // Example 2: only the entry both lists have.
  const two = mergePolicies({ document: system2.document }, { document: user2.document });
  assert.deepEqual(two.mcp.allow.values, ["github"]);
});

test("the document says, at the top, what is enforced and what is not yet, and lists every key and every error code", () => {
  const head = DOC.split("\n").slice(0, 14).join("\n");
  assert.match(head, /Status: enforced, with two gaps/);
  assert.match(head, /`egress\.secret_destinations` is not in yet: it is marked "not yet" below, is accepted and\n> merged, and changes nothing/);
  // The keys nothing acts on yet are marked so in the enforcement table; no other row is.
  const notYet = DOC.split("\n").filter((line) => /^\| `[a-z_.`, ]+ \| not yet \|/.test(line)).map((line) => line.split("|")[1].trim());
  assert.deepEqual(notYet, ["`egress.secret_destinations`"]);
  for (const row of PLAN_KEYS) assert.ok(DOC.includes(`| \`${row.table}.${row.key}\` |`), `${row.table}.${row.key} is in the key table`);
  for (const code of ["directory_unsafe", "symlink", "not_regular", "unreadable", "changed", "owner", "mode", "too_large", "invalid_utf8", "bom", "nul", "empty", "schema_version_missing", "schema_version_unsupported", "syntax", "unsupported", "duplicate_key", "duplicate_table", "string_too_long", "array_too_long", "control_character", "invalid_unicode", "unknown_table", "unknown_key", "wrong_type", "bad_value"]) {
    assert.ok(DOC.includes(`\`${code}\``), `error code ${code}`);
  }
  for (const status of ["ABSENT", "NEW", "MATCH", "MISMATCH", "REMOVED", "ENV_TRUSTED", "UNREADABLE"]) assert.ok(DOC.includes(`| \`${status}\` |`), status);
});
