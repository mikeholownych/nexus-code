// Generates the JSON Schema (draft 2020-12) of the document `nexus run --json` prints, from the type `RunJsonOutput` in
// src/run_contract.ts. The type-to-schema rules are those of the sidecar protocol schema: this script reuses the
// `SchemaBuilder` of gen_protocol_schema.mjs (see docs/protocol/README.md), so the output is deterministic and can be
// compared byte for byte.
//
//   node scripts/gen_run_result_schema.mjs           write docs/protocol/run-result-v<N>.schema.json
//   node scripts/gen_run_result_schema.mjs --check   exit 1 when the checked-in schema or the version ledger is stale
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API, SymbolFlags } from "typescript/unstable/sync";
import { SchemaBuilder, sha256, sortKeys } from "./gen_protocol_schema.mjs";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(cli, "..");
const contractSource = path.join(cli, "src", "run_contract.ts");
const ROOT_TYPE = "RunJsonOutput";

export const RUN_RESULT_LEDGER_FILE = path.join(repo, "docs", "protocol", "RUN_RESULT_VERSIONS.json");
export const runResultSchemaFile = (version) => path.join(repo, "docs", "protocol", `run-result-v${version}.schema.json`);

/** The schema text for `RunJsonOutput` as src/run_contract.ts declares it now, and its `RUN_RESULT_SCHEMA_VERSION`. */
export function generateRunResultSchema() {
  const api = new API({ cwd: cli });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [path.join(cli, "tsconfig.json")] });
    const project = snapshot.getProjects()[0];
    if (!project) throw new Error("gen_run_result_schema: cli/tsconfig.json did not load as a project");
    const checker = project.checker;
    const sourceAt = { document: contractSource, position: 0 };
    const versionSymbol = checker.resolveName("RUN_RESULT_SCHEMA_VERSION", SymbolFlags.Value, sourceAt);
    const version = versionSymbol && checker.getTypeOfSymbol(versionSymbol)?.value;
    if (!Number.isInteger(version)) throw new Error("gen_run_result_schema: RUN_RESULT_SCHEMA_VERSION is not an integer literal in src/run_contract.ts");
    const rootSymbol = checker.resolveName(ROOT_TYPE, SymbolFlags.TypeAlias, sourceAt);
    if (!rootSymbol) throw new Error(`gen_run_result_schema: ${ROOT_TYPE} is not declared in src/run_contract.ts`);
    const root = checker.getDeclaredTypeOfSymbol(rootSymbol);
    if (root.isErrorType()) throw new Error(`gen_run_result_schema: ${ROOT_TYPE} did not resolve`);

    const builder = new SchemaBuilder(checker);
    const rootSchema = builder.schemaOf(root, ROOT_TYPE);
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: `nexus run --json output v${version}`,
      description:
        "Generated from RunJsonOutput in cli/src/run_contract.ts by cli/scripts/gen_run_result_schema.mjs. Do not edit by hand. The one JSON document `nexus run --json` writes to stdout; `schema_version` is its first member.",
      ...rootSchema,
      $defs: sortKeys(builder.defs),
    };
    return { version, text: `${JSON.stringify(schema, null, 2)}\n` };
  } finally {
    api.close();
  }
}

/**
 * The version-decision rule (the same as the protocol ledger's, with the key `schema_version`): the newest ledger entry
 * must name the current schema version and the hash of the checked-in schema. Returns what is wrong, or undefined.
 */
export function runResultLedgerProblem(schemaText, ledger, version) {
  if (!Array.isArray(ledger) || ledger.length === 0) return "the ledger has no entries";
  const last = ledger[ledger.length - 1];
  if (last.schema_version !== version) return `the newest ledger entry is for schema_version ${last.schema_version}, but RUN_RESULT_SCHEMA_VERSION is ${version}`;
  const hash = sha256(schemaText);
  if (last.schemaSha256 !== hash) return `the newest ledger entry records schema ${last.schemaSha256}, but the schema is ${hash}: add an entry that records the version decision`;
  return undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version, text } = generateRunResultSchema();
  const file = runResultSchemaFile(version);
  const shown = path.relative(repo, file).split(path.sep).join("/");
  const ledgerShown = path.relative(repo, RUN_RESULT_LEDGER_FILE).split(path.sep).join("/");
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
    if (current !== text) {
      console.error(`${shown} is ${current === undefined ? "missing" : "out of date"}: run \`node cli/scripts/gen_run_result_schema.mjs\`, then record the version decision in ${ledgerShown}`);
      process.exit(1);
    }
    const problem = runResultLedgerProblem(current, fs.existsSync(RUN_RESULT_LEDGER_FILE) ? JSON.parse(fs.readFileSync(RUN_RESULT_LEDGER_FILE, "utf8")) : [], version);
    if (problem) {
      console.error(`${ledgerShown}: ${problem}`);
      process.exit(1);
    }
    console.log(`${shown} is current`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`wrote ${shown} (sha256 ${sha256(text)})`);
  }
}
