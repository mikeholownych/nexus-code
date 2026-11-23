// Generates the JSON Schema (draft 2020-12) of the document `nexus verify --json` prints (the same document
// `--receipt <file>` writes), from the type `VerifyJsonOutput` in src/verify_contract.ts, with the `SchemaBuilder` of
// gen_protocol_schema.mjs (see docs/protocol/README.md): deterministic output, compared byte for byte.
//
//   node scripts/gen_verify_result_schema.mjs           write docs/protocol/verify-result-v<N>.schema.json
//   node scripts/gen_verify_result_schema.mjs --check   exit 1 when the checked-in schema or the version ledger is stale
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateResultSchema, repo, resultLedgerProblem, resultSchemaMain } from "./result_schema.mjs";

const SCRIPT = "gen_verify_result_schema";

export const VERIFY_RESULT_LEDGER_FILE = path.join(repo, "docs", "protocol", "VERIFY_RESULT_VERSIONS.json");
export const verifyResultSchemaFile = (version) => path.join(repo, "docs", "protocol", `verify-result-v${version}.schema.json`);

/** The schema text for `VerifyJsonOutput` as src/verify_contract.ts declares it now, and its `VERIFY_RESULT_SCHEMA_VERSION`. */
export function generateVerifyResultSchema() {
  return generateResultSchema({
    script: SCRIPT,
    source: "src/verify_contract.ts",
    rootType: "VerifyJsonOutput",
    versionConst: "VERIFY_RESULT_SCHEMA_VERSION",
    title: (version) => `nexus verify --json output v${version}`,
    description:
      "Generated from VerifyJsonOutput in cli/src/verify_contract.ts by cli/scripts/gen_verify_result_schema.mjs. Do not edit by hand. The one JSON document `nexus verify --json` writes to stdout and `--receipt` writes to a file; `schema_version` is its first member.",
  });
}

/** The version-decision rule for the verify-result ledger (see resultLedgerProblem). Returns what is wrong, or undefined. */
export function verifyResultLedgerProblem(schemaText, ledger, version) {
  return resultLedgerProblem(schemaText, ledger, version, "VERIFY_RESULT_SCHEMA_VERSION");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  resultSchemaMain({ script: SCRIPT, generate: generateVerifyResultSchema, schemaFile: verifyResultSchemaFile, ledgerFile: VERIFY_RESULT_LEDGER_FILE, ledgerProblem: verifyResultLedgerProblem });
}
