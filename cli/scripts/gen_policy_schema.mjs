// Generates the JSON Schema (draft 2020-12) of a managed policy document (GV-1) from the type `ManagedPolicyFile` in
// src/core/managed_policy.ts, with the `SchemaBuilder` of gen_protocol_schema.mjs through result_schema.mjs (see
// docs/protocol/README.md): deterministic output, compared byte for byte. A policy file is TOML; the schema describes
// the same data as a JSON document (a table is an object), for an operator's editor or linter.
//
//   node scripts/gen_policy_schema.mjs           write docs/protocol/policy-v<N>.schema.json
//   node scripts/gen_policy_schema.mjs --check   exit 1 when the checked-in schema or the version ledger is stale
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateResultSchema, repo, resultLedgerProblem, resultSchemaMain } from "./result_schema.mjs";

const SCRIPT = "gen_policy_schema";

export const POLICY_LEDGER_FILE = path.join(repo, "docs", "protocol", "POLICY_VERSIONS.json");
export const policySchemaFile = (version) => path.join(repo, "docs", "protocol", `policy-v${version}.schema.json`);

/** The schema text for `ManagedPolicyFile` as src/core/managed_policy.ts declares it now, and its `POLICY_SCHEMA_VERSION`. */
export function generatePolicySchema() {
  return generateResultSchema({
    script: SCRIPT,
    source: "src/core/managed_policy.ts",
    rootType: "ManagedPolicyFile",
    versionConst: "POLICY_SCHEMA_VERSION",
    title: (version) => `nexus managed policy v${version}`,
    description:
      "Generated from ManagedPolicyFile in cli/src/core/managed_policy.ts by cli/scripts/gen_policy_schema.mjs. Do not edit by hand. The data of a managed policy file (policy.toml): each TOML table is an object, and `schema_version` is required. The schema describes shape only; Nexus's own validator is stricter (see docs/MANAGED_POLICY.md).",
  });
}

/** The version-decision rule for the policy ledger (see resultLedgerProblem). Returns what is wrong, or undefined. */
export function policyLedgerProblem(schemaText, ledger, version) {
  return resultLedgerProblem(schemaText, ledger, version, "POLICY_SCHEMA_VERSION");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  resultSchemaMain({ script: SCRIPT, generate: generatePolicySchema, schemaFile: policySchemaFile, ledgerFile: POLICY_LEDGER_FILE, ledgerProblem: policyLedgerProblem });
}
