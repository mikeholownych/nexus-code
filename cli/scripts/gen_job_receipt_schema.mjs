// Generates the two JSON Schemas (draft 2020-12) of what a detached job reports (BG-1) from the types in
// src/core/job_receipt.ts, with the `SchemaBuilder` of gen_protocol_schema.mjs through result_schema.mjs (see
// docs/protocol/README.md): deterministic output, compared byte for byte.
//   job-receipt-v<N>.schema.json   `JobReceiptDocument`: jobs/<id>/receipt.json
//   job-status-v<N>.schema.json    `JobStatusDocument`: the document `nexus job status <id> --json` prints
//
//   node scripts/gen_job_receipt_schema.mjs           write both schemas under docs/protocol/
//   node scripts/gen_job_receipt_schema.mjs --check   exit 1 when a checked-in schema or its version ledger is stale
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

export const JOB_STATUS_LEDGER_FILE = path.join(repo, "docs", "protocol", "JOB_STATUS_VERSIONS.json");
export const jobStatusSchemaFile = (version) => path.join(repo, "docs", "protocol", `job-status-v${version}.schema.json`);

/** The schema text for `JobStatusDocument` as src/core/job_receipt.ts declares it now, and its `JOB_STATUS_SCHEMA_VERSION`. */
export function generateJobStatusSchema() {
  return generateResultSchema({
    script: SCRIPT,
    source: "src/core/job_receipt.ts",
    rootType: "JobStatusDocument",
    versionConst: "JOB_STATUS_SCHEMA_VERSION",
    title: (version) => `nexus job status v${version}`,
    description:
      "Generated from JobStatusDocument in cli/src/core/job_receipt.ts by cli/scripts/gen_job_receipt_schema.mjs. Do not edit by hand. The one JSON document `nexus job status <id> --json` prints; `schema_version` is its first member. It carries the job record, a summary of the job's operation and, once the job ended, its receipt.",
  });
}

/** The version-decision rule for the status ledger (see resultLedgerProblem). */
export function jobStatusLedgerProblem(schemaText, ledger, version) {
  return resultLedgerProblem(schemaText, ledger, version, "JOB_STATUS_SCHEMA_VERSION");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Each call exits 1 on a stale schema or ledger, so with --check the second runs only when the first is current.
  resultSchemaMain({ script: SCRIPT, generate: generateJobStatusSchema, schemaFile: jobStatusSchemaFile, ledgerFile: JOB_STATUS_LEDGER_FILE, ledgerProblem: jobStatusLedgerProblem });
  resultSchemaMain({ script: SCRIPT, generate: generateJobReceiptSchema, schemaFile: jobReceiptSchemaFile, ledgerFile: JOB_RECEIPT_LEDGER_FILE, ledgerProblem: jobReceiptLedgerProblem });
}
