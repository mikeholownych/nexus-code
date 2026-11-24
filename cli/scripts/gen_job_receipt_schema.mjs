// Generates the JSON Schema (draft 2020-12) of a detached job's receipt (BG-1) from the type `JobReceiptDocument` in
// src/core/job_receipt.ts, with the `SchemaBuilder` of gen_protocol_schema.mjs through result_schema.mjs (see
// docs/protocol/README.md): deterministic output, compared byte for byte.
//
//   node scripts/gen_job_receipt_schema.mjs           write docs/protocol/job-receipt-v<N>.schema.json
//   node scripts/gen_job_receipt_schema.mjs --check   exit 1 when the checked-in schema or the version ledger is stale
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateResultSchema, repo, resultLedgerProblem, resultSchemaMain } from "./result_schema.mjs";

const SCRIPT = "gen_job_receipt_schema";

export const JOB_RECEIPT_LEDGER_FILE = path.join(repo, "docs", "protocol", "JOB_RECEIPT_VERSIONS.json");
export const jobReceiptSchemaFile = (version) => path.join(repo, "docs", "protocol", `job-receipt-v${version}.schema.json`);

/** The schema text for `JobReceiptDocument` as src/core/job_receipt.ts declares it now, and its `JOB_RECEIPT_SCHEMA_VERSION`. */
export function generateJobReceiptSchema() {
  return generateResultSchema({
    script: SCRIPT,
    source: "src/core/job_receipt.ts",
    rootType: "JobReceiptDocument",
    versionConst: "JOB_RECEIPT_SCHEMA_VERSION",
    title: (version) => `nexus job receipt v${version}`,
    description:
      "Generated from JobReceiptDocument in cli/src/core/job_receipt.ts by cli/scripts/gen_job_receipt_schema.mjs. Do not edit by hand. The receipt the runner writes when a detached job ends (jobs/<id>/receipt.json); `unattended` is always true.",
  });
}

/** The version-decision rule for the receipt ledger (see resultLedgerProblem). Returns what is wrong, or undefined. */
export function jobReceiptLedgerProblem(schemaText, ledger, version) {
  return resultLedgerProblem(schemaText, ledger, version, "JOB_RECEIPT_SCHEMA_VERSION");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  resultSchemaMain({ script: SCRIPT, generate: generateJobReceiptSchema, schemaFile: jobReceiptSchemaFile, ledgerFile: JOB_RECEIPT_LEDGER_FILE, ledgerProblem: jobReceiptLedgerProblem });
}
