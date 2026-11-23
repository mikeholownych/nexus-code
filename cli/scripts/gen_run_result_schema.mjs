// Generates the JSON Schema (draft 2020-12) of the document `nexus run --json` prints, from the type `RunJsonOutput` in
// src/run_contract.ts. The type-to-schema rules are those of the sidecar protocol schema: this script reuses the
// `SchemaBuilder` of gen_protocol_schema.mjs (see docs/protocol/README.md), so the output is deterministic and can be
// compared byte for byte.
//
//   node scripts/gen_run_result_schema.mjs           write docs/protocol/run-result-v<N>.schema.json
//   node scripts/gen_run_result_schema.mjs --check   exit 1 when the checked-in schema or the version ledger is stale
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateResultSchema, repo, resultLedgerProblem, resultSchemaMain } from "./result_schema.mjs";

const SCRIPT = "gen_run_result_schema";

export const RUN_RESULT_LEDGER_FILE = path.join(repo, "docs", "protocol", "RUN_RESULT_VERSIONS.json");
export const runResultSchemaFile = (version) => path.join(repo, "docs", "protocol", `run-result-v${version}.schema.json`);

/** The schema text for `RunJsonOutput` as src/run_contract.ts declares it now, and its `RUN_RESULT_SCHEMA_VERSION`. */
export function generateRunResultSchema() {
  return generateResultSchema({
    script: SCRIPT,
    source: "src/run_contract.ts",
    rootType: "RunJsonOutput",
    versionConst: "RUN_RESULT_SCHEMA_VERSION",
    title: (version) => `nexus run --json output v${version}`,
    description:
      "Generated from RunJsonOutput in cli/src/run_contract.ts by cli/scripts/gen_run_result_schema.mjs. Do not edit by hand. The one JSON document `nexus run --json` writes to stdout; `schema_version` is its first member.",
  });
}

/** The version-decision rule for the run-result ledger (see resultLedgerProblem). Returns what is wrong, or undefined. */
export function runResultLedgerProblem(schemaText, ledger, version) {
  return resultLedgerProblem(schemaText, ledger, version, "RUN_RESULT_SCHEMA_VERSION");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  resultSchemaMain({ script: SCRIPT, generate: generateRunResultSchema, schemaFile: runResultSchemaFile, ledgerFile: RUN_RESULT_LEDGER_FILE, ledgerProblem: runResultLedgerProblem });
}
