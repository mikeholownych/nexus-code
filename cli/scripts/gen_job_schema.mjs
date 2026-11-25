// Generates the two JSON Schemas (draft 2020-12) of the detached runner's own files (BG-1) from the types in
// src/core/runner_store.ts, with the `SchemaBuilder` of gen_protocol_schema.mjs through result_schema.mjs (see
// docs/protocol/README.md): deterministic output, compared byte for byte.
//   job-v<N>.schema.json            `JobRecordDocument`: jobs/<id>/job.json
//   runner-files-v<N>.schema.json   `RunnerFileDocument`: a request in the inbox, runner.json, and a job's worker.json,
//                                   result.json and spec.json
//
//   node scripts/gen_job_schema.mjs           write both schemas under docs/protocol/
//   node scripts/gen_job_schema.mjs --check   exit 1 when a checked-in schema or its version ledger is stale
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

export const RUNNER_FILE_LEDGER_FILE = path.join(repo, "docs", "protocol", "RUNNER_FILE_VERSIONS.json");
export const runnerFileSchemaFile = (version) => path.join(repo, "docs", "protocol", `runner-files-v${version}.schema.json`);

/** The schema text for `RunnerFileDocument` as src/core/runner_store.ts declares it now, and its `RUNNER_FILE_VERSION`. */
export function generateRunnerFileSchema() {
  return generateResultSchema({
    script: SCRIPT,
    source: "src/core/runner_store.ts",
    rootType: "RunnerFileDocument",
    versionConst: "RUNNER_FILE_VERSION",
    title: (version) => `nexus runner files v${version}`,
    description:
      "Generated from RunnerFileDocument in cli/src/core/runner_store.ts by cli/scripts/gen_job_schema.mjs. Do not edit by hand. One of the detached runner's files, told apart by `format`: a client's request (nexus-runner-request), the runner record (nexus-runner), and a job's worker record (nexus-job-worker), worker result (nexus-job-result) and frozen operation spec (nexus-job-spec). The schema describes shape only; the readers also refuse unknown keys, repeated keys and out-of-range values.",
  });
}

/** The version-decision rule for the runner-file ledger (see resultLedgerProblem). */
export function runnerFileLedgerProblem(schemaText, ledger, version) {
  return resultLedgerProblem(schemaText, ledger, version, "RUNNER_FILE_VERSION");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Each call exits 1 on a stale schema or ledger, so with --check the second runs only when the first is current.
  resultSchemaMain({ script: SCRIPT, generate: generateJobSchema, schemaFile: jobSchemaFile, ledgerFile: JOB_LEDGER_FILE, ledgerProblem: jobLedgerProblem });
  resultSchemaMain({ script: SCRIPT, generate: generateRunnerFileSchema, schemaFile: runnerFileSchemaFile, ledgerFile: RUNNER_FILE_LEDGER_FILE, ledgerProblem: runnerFileLedgerProblem });
}
