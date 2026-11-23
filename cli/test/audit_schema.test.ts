/**
 * GV-2: the published schemas of the audit bundle (docs/protocol/audit-bundle-v1.schema.json: the manifest and the
 * signature envelope) and of the verification result (audit-verify-result-v1.schema.json), their version ledgers, and
 * the exit-code table. The documents themselves are validated where they are produced: every manifest and every result
 * in test/audit_bundle.test.ts goes through these schemas (helpers/audit_fixture.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sha256 } from "../scripts/gen_protocol_schema.mjs";
import {
  AUDIT_BUNDLE_LEDGER_FILE,
  AUDIT_VERIFY_RESULT_LEDGER_FILE,
  auditBundleLedgerProblem,
  auditVerifyResultLedgerProblem,
  generateAuditBundleSchema,
  generateAuditVerifyResultSchema,
} from "../scripts/gen_audit_schema.mjs";
import {
  AUDIT_BUNDLE_SCHEMA_VERSION,
  AUDIT_CHAINED_LOG_KINDS,
  AUDIT_EXIT_CODES,
  AUDIT_FILE_ROLES,
  AUDIT_VERIFY_RESULT_SCHEMA_VERSION,
  auditExitCode,
  type AuditSignatureEnvelope,
  type AuditVerifyError,
} from "../src/audit_contract.js";
import { RUN_EXIT_CODES } from "../src/run_contract.js";
import { VERIFY_EXIT_CODES } from "../src/verify_contract.js";
import { AUDIT_BUNDLE_SCHEMA as bundleSchema, AUDIT_BUNDLE_SCHEMA_TEXT, AUDIT_VERIFY_SCHEMA as verifySchema, AUDIT_VERIFY_SCHEMA_TEXT } from "./helpers/audit_fixture.js";
import { validate } from "./helpers/json_schema.js";

const published = [
  { name: "audit-bundle", generate: generateAuditBundleSchema, checkedIn: AUDIT_BUNDLE_SCHEMA_TEXT, version: AUDIT_BUNDLE_SCHEMA_VERSION, constant: "AUDIT_BUNDLE_SCHEMA_VERSION", ledgerFile: AUDIT_BUNDLE_LEDGER_FILE, problem: auditBundleLedgerProblem },
  { name: "audit-verify-result", generate: generateAuditVerifyResultSchema, checkedIn: AUDIT_VERIFY_SCHEMA_TEXT, version: AUDIT_VERIFY_RESULT_SCHEMA_VERSION, constant: "AUDIT_VERIFY_RESULT_SCHEMA_VERSION", ledgerFile: AUDIT_VERIFY_RESULT_LEDGER_FILE, problem: auditVerifyResultLedgerProblem },
];

for (const { name, generate, checkedIn, version, constant, ledgerFile, problem } of published) {
  test(`the checked-in ${name} schema equals a fresh generation from src/audit_contract.ts`, () => {
    const generated = generate();
    assert.equal(generated.version, version);
    assert.equal(generated.text, checkedIn, `docs/protocol/${name} schema is out of date: run \`node cli/scripts/gen_audit_schema.mjs\`, then record the version decision in its ledger`);
  });

  test(`the newest ${name} ledger entry records the current schema and schema_version`, () => {
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
    assert.equal(problem(checkedIn, ledger, version), undefined);
    for (const entry of ledger) {
      assert.ok(Number.isInteger(entry.schema_version) && /^[0-9a-f]{64}$/.test(entry.schemaSha256) && typeof entry.note === "string" && entry.note.trim(), "each entry has schema_version, schemaSha256 and a note");
    }
    // The rule itself: a changed schema, or a version bump, without a new entry is a failure.
    assert.match(problem(`${checkedIn} `, ledger, version) ?? "", /add an entry/);
    assert.match(problem(checkedIn, ledger, version + 1) ?? "", new RegExp(`${constant} is`));
    assert.match(problem(checkedIn, [], version) ?? "", /no entries/);
    assert.equal(ledger[ledger.length - 1].schemaSha256, sha256(checkedIn));
  });
}

test("the bundle schema is the manifest or the signature envelope, with the contract's roles, kinds and required members", () => {
  assert.equal(bundleSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(bundleSchema.$defs.AuditBundleDocument.anyOf, [{ $ref: "#/$defs/AuditManifest" }, { $ref: "#/$defs/AuditSignatureEnvelope" }]);
  const manifest = bundleSchema.$defs.AuditManifest;
  assert.deepEqual(manifest.required, ["bundle_id", "chained_logs", "created_at", "files", "files_head", "format", "nexus", "omitted", "redaction", "root_sha256", "schema_version", "subject"]);
  assert.deepEqual([manifest.properties.schema_version.const, manifest.properties.format.const], [AUDIT_BUNDLE_SCHEMA_VERSION, "nexus-audit-bundle/1"]);
  assert.deepEqual(bundleSchema.$defs.AuditFileEntry.required, ["bytes", "chain", "path", "role", "sha256"]);
  assert.deepEqual(bundleSchema.$defs.AuditFileEntry.properties.role.enum, [...AUDIT_FILE_ROLES].sort());
  assert.deepEqual(bundleSchema.$defs.AuditChainedLog.properties.kind.enum, [...AUDIT_CHAINED_LOG_KINDS].sort());
  assert.deepEqual(bundleSchema.$defs.AuditChainedLog.required, ["kind", "path", "records", "status"]);
  assert.deepEqual(bundleSchema.$defs.ChainLink.required, ["hash", "prev", "seq"]);

  const envelope: AuditSignatureEnvelope = { schema_version: 1, algorithm: "ed25519", signed_file: "manifest.json", manifest_sha256: "0".repeat(64), public_key_sha256: "1".repeat(64), signature: "c2ln" };
  assert.deepEqual(validate(envelope, bundleSchema, bundleSchema), []);
  assert.deepEqual(bundleSchema.$defs.AuditSignatureEnvelope.required, Object.keys(envelope).sort());
  assert.ok(validate({ ...envelope, algorithm: "rsa" }, bundleSchema, bundleSchema).length > 0);
  assert.ok(validate({ schema_version: 1, format: "nexus-audit-bundle/1" }, bundleSchema, bundleSchema).length > 0, "a manifest without its required members");
});

test("the audit JSON schema is an export result, verification result, or error document; required fields stay explicit", () => {
  assert.deepEqual(verifySchema.$defs.AuditVerifyOutput.anyOf, [{ $ref: "#/$defs/AuditExportResult" }, { $ref: "#/$defs/AuditVerifyError" }, { $ref: "#/$defs/AuditVerifyResult" }]);
  for (const name of ["AuditExportResult", "AuditVerifyResult", "AuditVerifyError"]) {
    const branch = verifySchema.$defs[name];
    assert.equal(branch.properties.schema_version.const, AUDIT_VERIFY_RESULT_SCHEMA_VERSION);
    assert.ok(branch.required.includes("schema_version") && branch.required.includes("exitCode"));
  }
  assert.deepEqual(verifySchema.$defs.AuditVerifyResult.required, ["bundle_id", "chained_logs", "exitCode", "expected_manifest_sha256", "files", "findings", "findings_total", "manifest_sha256", "notes", "public_key_sha256", "result", "schema_version", "signature"]);
  assert.ok(!("result" in verifySchema.$defs.AuditVerifyError.properties));
  assert.deepEqual(verifySchema.$defs.AuditVerifyResultName.enum, ["intact_signed", "intact_unsigned", "signature_unchecked", "tampered", "unsupported_version"]);
  assert.deepEqual(verifySchema.$defs.AuditFindingKind.enum, [
    "file_altered",
    "file_missing",
    "file_unexpected",
    "limit_exceeded",
    "log_chain_broken",
    "log_head_mismatch",
    "manifest_chain_broken",
    "manifest_malformed",
    "manifest_missing",
    "manifest_not_canonical",
    "manifest_root_mismatch",
    "manifest_sha256_mismatch",
    "signature_invalid",
    "signature_key_mismatch",
    "signature_missing",
    "unreadable_entry",
    "unsafe_entry",
    "unsupported_version",
  ]);
  assert.deepEqual(verifySchema.$defs.AuditSignatureStatus.enum, ["absent", "invalid", "missing", "unchecked", "valid"]);
  // Every result name is a row of the exit-code table.
  for (const name of verifySchema.$defs.AuditVerifyResultName.enum) assert.ok(AUDIT_EXIT_CODES.some((row) => row.name === name), name);

  const error: AuditVerifyError = { schema_version: AUDIT_VERIFY_RESULT_SCHEMA_VERSION, error: "there is no bundle directory at that path", exitCode: 1 };
  assert.deepEqual(validate(error, verifySchema, verifySchema), []);
  assert.ok(validate({ ...error, schema_version: 2 }, verifySchema, verifySchema).length > 0);
  assert.ok(validate({ error: "x", exitCode: 1 }, verifySchema, verifySchema).length > 0, "a document without schema_version");
  assert.ok(validate({ schema_version: AUDIT_VERIFY_RESULT_SCHEMA_VERSION, result: "intact_unsigned" }, verifySchema, verifySchema).length > 0, "a result without its required members");
});

test("the exit-code table: only an export or an intact bundle is 0, and the signing rows are already there", () => {
  assert.deepEqual(
    AUDIT_EXIT_CODES.map((row) => [row.code, row.name]),
    [
      [0, "exported"],
      [0, "intact_signed"],
      [0, "intact_unsigned"],
      [1, "tampered"],
      [1, "error"],
      [1, "option_parse"],
      [2, "signature_unchecked"],
      [2, "unsupported_version"],
      [2, "usage"],
      [2, "subject_not_found"],
      [130, "interrupted"],
    ],
  );
  assert.equal(new Set(AUDIT_EXIT_CODES.map((row) => row.name)).size, AUDIT_EXIT_CODES.length, "each name is one row");
  for (const row of AUDIT_EXIT_CODES) {
    assert.deepEqual(Object.keys(row), ["code", "name", "when"], "the row shape of RUN_EXIT_CODES and VERIFY_EXIT_CODES");
    assert.ok(row.when.trim().length > 0);
    assert.equal(auditExitCode(row.name), row.code);
  }
  assert.deepEqual(Object.keys(RUN_EXIT_CODES[0]), ["code", "name", "when"]);
  assert.deepEqual(Object.keys(VERIFY_EXIT_CODES[0]), ["code", "name", "when"]);
  // The rows shared with the other commands keep their codes.
  for (const name of ["option_parse", "usage", "interrupted"] as const) {
    assert.equal(auditExitCode(name), RUN_EXIT_CODES.find((row) => row.name === name)!.code);
    assert.equal(auditExitCode(name), VERIFY_EXIT_CODES.find((row) => row.name === name)!.code);
  }
});
