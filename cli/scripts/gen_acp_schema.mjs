// Generates the JSON Schema (draft 2020-12) of the messages of the ACP adapter (AC-1) from the type `AcpAdapterDocument`
// in src/acp/types.ts, with the `SchemaBuilder` of gen_protocol_schema.mjs through result_schema.mjs (see
// docs/protocol/README.md): deterministic output, compared byte for byte. The schema describes the SUBSET of the Agent
// Client Protocol that Nexus accepts and sends, plus Nexus's own extension method and `_meta` members. It is not the
// ACP schema.
//
//   node scripts/gen_acp_schema.mjs           write docs/protocol/acp-adapter-v<N>.schema.json
//   node scripts/gen_acp_schema.mjs --check   exit 1 when the checked-in schema or the version ledger is stale
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateResultSchema, repo, resultLedgerProblem, resultSchemaMain } from "./result_schema.mjs";

const SCRIPT = "gen_acp_schema";

export const ACP_ADAPTER_LEDGER_FILE = path.join(repo, "docs", "protocol", "ACP_ADAPTER_VERSIONS.json");
export const acpAdapterSchemaFile = (version) => path.join(repo, "docs", "protocol", `acp-adapter-v${version}.schema.json`);

/** The schema text for `AcpAdapterDocument` as src/acp/types.ts declares it now, and its `ACP_ADAPTER_SCHEMA_VERSION`. */
export function generateAcpAdapterSchema() {
  return generateResultSchema({
    script: SCRIPT,
    source: "src/acp/types.ts",
    rootType: "AcpAdapterDocument",
    versionConst: "ACP_ADAPTER_SCHEMA_VERSION",
    title: (version) => `nexus ACP adapter v${version}: Nexus's subset of the Agent Client Protocol`,
    description:
      "Generated from AcpAdapterDocument in cli/src/acp/types.ts by cli/scripts/gen_acp_schema.mjs. Do not edit by hand. One line of an ACP connection to Nexus (newline-delimited JSON-RPC 2.0), in either direction: a message a client may send that Nexus acts on (AcpClientMessage), or a message Nexus sends (AcpAgentMessage). This is NOT the schema of the Agent Client Protocol: it describes only the subset of ACP version 1 that Nexus implements, plus Nexus's own extension methods (`_nexus/receipt/get`, `_nexus/verify`) and its `_meta` members (`nexus/...`). A valid ACP message outside this subset is answered with an error or ignored. Experimental: names and fields may change.",
  });
}

/** The version-decision rule for the adapter ledger (see resultLedgerProblem). Returns what is wrong, or undefined. */
export function acpAdapterLedgerProblem(schemaText, ledger, version) {
  return resultLedgerProblem(schemaText, ledger, version, "ACP_ADAPTER_SCHEMA_VERSION");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  resultSchemaMain({ script: SCRIPT, generate: generateAcpAdapterSchema, schemaFile: acpAdapterSchemaFile, ledgerFile: ACP_ADAPTER_LEDGER_FILE, ledgerProblem: acpAdapterLedgerProblem });
}
