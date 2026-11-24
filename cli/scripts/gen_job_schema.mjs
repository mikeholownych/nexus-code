// Generates the JSON Schema (draft 2020-12) of the detached runner's job record (BG-1) from the type
// `JobRecordDocument` in src/core/runner_store.ts, with the `SchemaBuilder` of gen_protocol_schema.mjs through
// result_schema.mjs (see docs/protocol/README.md): deterministic output, compared byte for byte.
//
//   node scripts/gen_job_schema.mjs           write docs/protocol/job-v<N>.schema.json
//   node scripts/gen_job_schema.mjs --check   exit 1 when the checked-in schema or the version ledger is stale
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateResultSchema, repo, resultLedgerProblem, resultSchemaMain } from "./result_schema.mjs";

const SCRIPT = "gen_job_schema";

export const JOB_LEDGER_FILE = path.join(repo, "docs", "protocol", "JOB_VERSIONS.json");
export const jobSchemaFile = (version) => path.join(repo, "docs", "protocol", `job-v${version}.schema.json`);

/** The schema text for `JobRecordDocument` as src/core/runner_store.ts declares it now, and its `JOB_RECORD_VERSION`. */
export function generateJobSchema() {
  return generateResultSchema({
    script: SCRIPT,
    source: "src/core/runner_store.ts",
    rootType: "JobRecordDocument",
    versionConst: "JOB_RECORD_VERSION",
    title: (version) => `nexus job record v${version}`,
    description:
      "Generated from JobRecordDocument in cli/src/core/runner_store.ts by cli/scripts/gen_job_schema.mjs. Do not edit by hand. The record of a detached job (runner/jobs/<id>/job.json). The schema describes shape only; the reader (parseJobRecord) also refuses unknown keys, repeated keys and out-of-range values.",
  });
}

/** The version-decision rule for the job ledger (see resultLedgerProblem); its entries key the version as `schema_version`. */
export function jobLedgerProblem(schemaText, ledger, version) {
  return resultLedgerProblem(schemaText, ledger, version, "JOB_RECORD_VERSION");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  resultSchemaMain({ script: SCRIPT, generate: generateJobSchema, schemaFile: jobSchemaFile, ledgerFile: JOB_LEDGER_FILE, ledgerProblem: jobLedgerProblem });
}
