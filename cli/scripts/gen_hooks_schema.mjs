// Generates the JSON Schema (draft 2020-12) of the command-hook contract (HK-1) from the type `HooksDocument` in
// src/core/hooks.ts, with the `SchemaBuilder` of gen_protocol_schema.mjs through result_schema.mjs (see
// docs/protocol/README.md): deterministic output, compared byte for byte. `$defs` holds the four documents: HooksFile
// (a hooks.json), HookInput (a hook's standard input), HookOutput (its standard output) and ExtensionTrustStore
// (extension_trust.json).
//
//   node scripts/gen_hooks_schema.mjs           write docs/protocol/hooks-v<N>.schema.json
//   node scripts/gen_hooks_schema.mjs --check   exit 1 when the checked-in schema or the version ledger is stale
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateResultSchema, repo, resultLedgerProblem, resultSchemaMain } from "./result_schema.mjs";

const SCRIPT = "gen_hooks_schema";

export const HOOKS_LEDGER_FILE = path.join(repo, "docs", "protocol", "HOOKS_VERSIONS.json");
export const hooksSchemaFile = (version) => path.join(repo, "docs", "protocol", `hooks-v${version}.schema.json`);

/** The schema text for `HooksDocument` as src/core/hooks.ts declares it now, and its `HOOKS_SCHEMA_VERSION`. */
export function generateHooksSchema() {
  return generateResultSchema({
    script: SCRIPT,
    source: "src/core/hooks.ts",
    rootType: "HooksDocument",
    versionConst: "HOOKS_SCHEMA_VERSION",
    title: (version) => `nexus hooks v${version}`,
    description:
      "Generated from HooksDocument in cli/src/core/hooks.ts by cli/scripts/gen_hooks_schema.mjs. Do not edit by hand. $defs.HooksFile is a hooks file (hooks.json), $defs.HookInput what a hook reads on standard input, $defs.HookOutput what it may print, $defs.ExtensionTrustStore the approval store (extension_trust.json). The schema describes shape only; Nexus's own reader is stricter (unknown and duplicate keys are refused; see docs/HOOKS.md).",
  });
}

/** The version-decision rule for the hooks ledger (see resultLedgerProblem). Returns what is wrong, or undefined. */
export function hooksLedgerProblem(schemaText, ledger, version) {
  return resultLedgerProblem(schemaText, ledger, version, "HOOKS_SCHEMA_VERSION");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  resultSchemaMain({ script: SCRIPT, generate: generateHooksSchema, schemaFile: hooksSchemaFile, ledgerFile: HOOKS_LEDGER_FILE, ledgerProblem: hooksLedgerProblem });
}
