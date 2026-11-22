/**
 * VR-1: the published schema of the `nexus verify --json` document (docs/protocol/verify-result-v1.schema.json) and its
 * version ledger. The documents themselves are validated where they are produced: every result in
 * test/verify_command.test.ts and test/verify_typecheck_guard.test.ts goes through the schema (helpers/verify_fixture.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sha256 } from "../scripts/gen_protocol_schema.mjs";
import { generateVerifyResultSchema, verifyResultLedgerProblem, VERIFY_RESULT_LEDGER_FILE } from "../scripts/gen_verify_result_schema.mjs";
import { VERIFY_REASONS, VERIFY_RESULT_SCHEMA_VERSION, type VerifyJsonError } from "../src/verify_contract.js";
import { validate } from "./helpers/json_schema.js";
import { VERIFY_SCHEMA as schema, VERIFY_SCHEMA_TEXT as checkedIn } from "./helpers/verify_fixture.js";

test("the checked-in verify-result schema equals a fresh generation from src/verify_contract.ts", () => {
  const generated = generateVerifyResultSchema();
  assert.equal(generated.version, VERIFY_RESULT_SCHEMA_VERSION);
  assert.equal(
    generated.text,
    checkedIn,
    "docs/protocol/verify-result schema is out of date: run `node cli/scripts/gen_verify_result_schema.mjs`, then record the version decision in docs/protocol/VERIFY_RESULT_VERSIONS.json",
  );
});

test("the newest verify-result ledger entry records the current schema and schema_version", () => {
  const ledger = JSON.parse(fs.readFileSync(VERIFY_RESULT_LEDGER_FILE, "utf8"));
  assert.equal(verifyResultLedgerProblem(checkedIn, ledger, VERIFY_RESULT_SCHEMA_VERSION), undefined);
  for (const entry of ledger) {
    assert.ok(Number.isInteger(entry.schema_version) && /^[0-9a-f]{64}$/.test(entry.schemaSha256) && typeof entry.note === "string" && entry.note.trim(), "each entry has schema_version, schemaSha256 and a note");
  }
  // The rule itself: a changed schema, or a version bump, without a new entry is a failure.
  assert.match(verifyResultLedgerProblem(`${checkedIn} `, ledger, VERIFY_RESULT_SCHEMA_VERSION) ?? "", /add an entry/);
  assert.match(verifyResultLedgerProblem(checkedIn, ledger, VERIFY_RESULT_SCHEMA_VERSION + 1) ?? "", /VERIFY_RESULT_SCHEMA_VERSION is/);
  assert.match(verifyResultLedgerProblem(checkedIn, [], VERIFY_RESULT_SCHEMA_VERSION) ?? "", /no entries/);
  assert.equal(ledger[ledger.length - 1].schemaSha256, sha256(checkedIn));
});

test("the schema is a union of a result and an error document; its reasons and verdicts are the contract's", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(schema.$defs.VerifyJsonOutput.anyOf, [{ $ref: "#/$defs/VerifyJsonError" }, { $ref: "#/$defs/VerifyJsonResult" }]);
  for (const name of ["VerifyJsonResult", "VerifyJsonError"]) {
    const branch = schema.$defs[name];
    assert.equal(branch.properties.schema_version.const, VERIFY_RESULT_SCHEMA_VERSION);
    assert.ok(branch.required.includes("schema_version") && branch.required.includes("exitCode"));
  }
  for (const member of ["verdict", "outcome", "typecheck", "guard", "review", "environment", "approvedVerificationEdits"]) assert.ok(schema.$defs.VerifyJsonResult.required.includes(member), member);
  assert.ok(!("verdict" in schema.$defs.VerifyJsonError.properties));
  assert.deepEqual(schema.$defs.VerifyReason.enum, Object.keys(VERIFY_REASONS).sort());
  assert.deepEqual(schema.$defs.VerifyVerdict.enum, ["BLOCKED", "REGRESSION_FREE", "UNVERIFIED", "VERIFIED"]);
  assert.deepEqual(schema.$defs.VerifyJsonResult.properties.outcome.enum, ["NOT_ESTABLISHED", "REGRESSION_FREE", "UNVERIFIED", "VERIFIED"]);
  assert.deepEqual(schema.$defs.VerifyGuard.properties.status.enum, ["BLOCKED", "CLEAR", "NOT_RUN"]);
  assert.ok(schema.$defs.VerifyGuardFinding.required.includes("requiresApproval") && schema.$defs.VerifyGuardFinding.required.includes("approved"));
});

test("the schema accepts the error document and rejects what a consumer relies on being there", () => {
  const error: VerifyJsonError = { schema_version: VERIFY_RESULT_SCHEMA_VERSION, error: "--base x does not name a commit in this repository", exitCode: 2 };
  assert.deepEqual(validate(error, schema, schema), []);
  assert.ok(validate({ ...error, schema_version: 2 }, schema, schema).length > 0);
  assert.ok(validate({ error: "x", exitCode: 2 }, schema, schema).length > 0, "a document without schema_version");
  assert.ok(validate({ schema_version: VERIFY_RESULT_SCHEMA_VERSION, verdict: "VERIFIED" }, schema, schema).length > 0, "a result without its required members");
});
