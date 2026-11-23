// Generates the two JSON Schemas (draft 2020-12) of the audit bundle (GV-2) from the types in src/audit_contract.ts,
// with the `SchemaBuilder` of gen_protocol_schema.mjs (see docs/protocol/README.md): deterministic output, compared
// byte for byte.
//   audit-bundle-v<N>.schema.json          `AuditBundleDocument`: manifest.json, or the signature envelope manifest.sig.json
//   audit-verify-result-v<N>.schema.json   `AuditVerifyOutput`: the document a verification prints
//
//   node scripts/gen_audit_schema.mjs           write both schemas under docs/protocol/
//   node scripts/gen_audit_schema.mjs --check   exit 1 when a checked-in schema or its version ledger is stale
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateResultSchema, repo, resultLedgerProblem, resultSchemaMain } from "./result_schema.mjs";

const SCRIPT = "gen_audit_schema";
const SOURCE = "src/audit_contract.ts";

export const AUDIT_BUNDLE_LEDGER_FILE = path.join(repo, "docs", "protocol", "AUDIT_BUNDLE_VERSIONS.json");
export const auditBundleSchemaFile = (version) => path.join(repo, "docs", "protocol", `audit-bundle-v${version}.schema.json`);
export const AUDIT_VERIFY_RESULT_LEDGER_FILE = path.join(repo, "docs", "protocol", "AUDIT_VERIFY_RESULT_VERSIONS.json");
export const auditVerifyResultSchemaFile = (version) => path.join(repo, "docs", "protocol", `audit-verify-result-v${version}.schema.json`);

/** The schema text for `AuditBundleDocument` as src/audit_contract.ts declares it now, and its `AUDIT_BUNDLE_SCHEMA_VERSION`. */
export function generateAuditBundleSchema() {
  return generateResultSchema({
    script: SCRIPT,
    source: SOURCE,
    rootType: "AuditBundleDocument",
    versionConst: "AUDIT_BUNDLE_SCHEMA_VERSION",
    title: (version) => `nexus audit bundle v${version}`,
    description:
      "Generated from AuditBundleDocument in cli/src/audit_contract.ts by cli/scripts/gen_audit_schema.mjs. Do not edit by hand. A document of an audit bundle: manifest.json (AuditManifest), or the detached signature envelope manifest.sig.json (AuditSignatureEnvelope).",
  });
}

/** The schema text for `AuditVerifyOutput` as src/audit_contract.ts declares it now, and its `AUDIT_VERIFY_RESULT_SCHEMA_VERSION`. */
export function generateAuditVerifyResultSchema() {
  return generateResultSchema({
    script: SCRIPT,
    source: SOURCE,
    rootType: "AuditVerifyOutput",
    versionConst: "AUDIT_VERIFY_RESULT_SCHEMA_VERSION",
    title: (version) => `nexus audit verify output v${version}`,
    description:
      "Generated from AuditVerifyOutput in cli/src/audit_contract.ts by cli/scripts/gen_audit_schema.mjs. Do not edit by hand. The one JSON document a verification of an audit bundle prints; `schema_version` is its first member. A result has `result`; an error document does not.",
  });
}

/** The version-decision rule for the bundle ledger (see resultLedgerProblem). Returns what is wrong, or undefined. */
export function auditBundleLedgerProblem(schemaText, ledger, version) {
  return resultLedgerProblem(schemaText, ledger, version, "AUDIT_BUNDLE_SCHEMA_VERSION");
}

/** The version-decision rule for the verify-result ledger (see resultLedgerProblem). Returns what is wrong, or undefined. */
export function auditVerifyResultLedgerProblem(schemaText, ledger, version) {
  return resultLedgerProblem(schemaText, ledger, version, "AUDIT_VERIFY_RESULT_SCHEMA_VERSION");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Each call exits 1 on a stale schema or ledger, so with --check the second runs only when the first is current.
  resultSchemaMain({ script: SCRIPT, generate: generateAuditBundleSchema, schemaFile: auditBundleSchemaFile, ledgerFile: AUDIT_BUNDLE_LEDGER_FILE, ledgerProblem: auditBundleLedgerProblem });
  resultSchemaMain({ script: SCRIPT, generate: generateAuditVerifyResultSchema, schemaFile: auditVerifyResultSchemaFile, ledgerFile: AUDIT_VERIFY_RESULT_LEDGER_FILE, ledgerProblem: auditVerifyResultLedgerProblem });
}
