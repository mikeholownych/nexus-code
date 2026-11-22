// What the generators of the two command-result schemas share (gen_run_result_schema.mjs for `nexus run --json`,
// gen_verify_result_schema.mjs for `nexus verify --json`): one root type and one version constant in one contract
// source, written with the `SchemaBuilder` of gen_protocol_schema.mjs, and a ledger keyed by `schema_version`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API, SymbolFlags } from "typescript/unstable/sync";
import { SchemaBuilder, sha256, sortKeys } from "./gen_protocol_schema.mjs";

export const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const repo = path.resolve(cli, "..");

/**
 * The schema text for `rootType` as `source` (relative to cli/) declares it now, and the value of `versionConst`.
 * `script` names the generator in errors; `title(version)` and `description` are the schema's annotations.
 */
export function generateResultSchema({ script, source, rootType, versionConst, title, description }) {
  const api = new API({ cwd: cli });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [path.join(cli, "tsconfig.json")] });
    const project = snapshot.getProjects()[0];
    if (!project) throw new Error(`${script}: cli/tsconfig.json did not load as a project`);
    const checker = project.checker;
    const sourceAt = { document: path.join(cli, source), position: 0 };
    const versionSymbol = checker.resolveName(versionConst, SymbolFlags.Value, sourceAt);
    const version = versionSymbol && checker.getTypeOfSymbol(versionSymbol)?.value;
    if (!Number.isInteger(version)) throw new Error(`${script}: ${versionConst} is not an integer literal in ${source}`);
    const rootSymbol = checker.resolveName(rootType, SymbolFlags.TypeAlias, sourceAt);
    if (!rootSymbol) throw new Error(`${script}: ${rootType} is not declared in ${source}`);
    const root = checker.getDeclaredTypeOfSymbol(rootSymbol);
    if (root.isErrorType()) throw new Error(`${script}: ${rootType} did not resolve`);

    const builder = new SchemaBuilder(checker);
    const rootSchema = builder.schemaOf(root, rootType);
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: title(version),
      description,
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
export function resultLedgerProblem(schemaText, ledger, version, versionConst) {
  if (!Array.isArray(ledger) || ledger.length === 0) return "the ledger has no entries";
  const last = ledger[ledger.length - 1];
  if (last.schema_version !== version) return `the newest ledger entry is for schema_version ${last.schema_version}, but ${versionConst} is ${version}`;
  const hash = sha256(schemaText);
  if (last.schemaSha256 !== hash) return `the newest ledger entry records schema ${last.schemaSha256}, but the schema is ${hash}: add an entry that records the version decision`;
  return undefined;
}

/** The command line of a generator: write the schema, or with `--check` exit 1 when the schema or its ledger is stale. */
export function resultSchemaMain({ script, generate, schemaFile, ledgerFile, ledgerProblem }) {
  const { version, text } = generate();
  const file = schemaFile(version);
  const shown = path.relative(repo, file).split(path.sep).join("/");
  const ledgerShown = path.relative(repo, ledgerFile).split(path.sep).join("/");
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
    if (current !== text) {
      console.error(`${shown} is ${current === undefined ? "missing" : "out of date"}: run \`node cli/scripts/${script}.mjs\`, then record the version decision in ${ledgerShown}`);
      process.exit(1);
    }
    const problem = ledgerProblem(current, fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, "utf8")) : [], version);
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
