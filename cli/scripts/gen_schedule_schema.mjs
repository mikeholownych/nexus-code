// Generates the JSON Schema (draft 2020-12) of the schedule files (BG-2) from the types in src/core/schedule_store.ts,
// with the `SchemaBuilder` of gen_protocol_schema.mjs through result_schema.mjs (see docs/protocol/README.md):
// deterministic output, compared byte for byte.
//   schedule-v<N>.schema.json   `ScheduleFileDocument`: a schedule record, its latest-result pointer, or a missed-run receipt
//
//   node scripts/gen_schedule_schema.mjs           write the schema under docs/protocol/
//   node scripts/gen_schedule_schema.mjs --check   exit 1 when the checked-in schema or its version ledger is stale
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateResultSchema, repo, resultLedgerProblem, resultSchemaMain } from "./result_schema.mjs";

const SCRIPT = "gen_schedule_schema";

export const SCHEDULE_LEDGER_FILE = path.join(repo, "docs", "protocol", "SCHEDULE_VERSIONS.json");
export const scheduleSchemaFile = (version) => path.join(repo, "docs", "protocol", `schedule-v${version}.schema.json`);

/** The schema text for `ScheduleFileDocument` as src/core/schedule_store.ts declares it now, and its `SCHEDULE_FILE_VERSION`. */
export function generateScheduleSchema() {
  return generateResultSchema({
    script: SCRIPT,
    source: "src/core/schedule_store.ts",
    rootType: "ScheduleFileDocument",
    versionConst: "SCHEDULE_FILE_VERSION",
    title: (version) => `nexus schedule files v${version}`,
    description:
      "Generated from ScheduleFileDocument in cli/src/core/schedule_store.ts by cli/scripts/gen_schedule_schema.mjs. Do not edit by hand. One of the files under runner/nexus-schedules/, told apart by `format`: a schedule record (nexus-schedule), the pointer to its newest result (nexus-schedule-latest) or the receipt of a gap of missed runs (nexus-schedule-missed). The schema describes shape only; the readers (parseScheduleRecord and the others) also refuse unknown keys, repeated keys and out-of-range values.",
  });
}

/** The version-decision rule for the schedule ledger (see resultLedgerProblem); its entries key the version as `schema_version`. */
export function scheduleLedgerProblem(schemaText, ledger, version) {
  return resultLedgerProblem(schemaText, ledger, version, "SCHEDULE_FILE_VERSION");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  resultSchemaMain({ script: SCRIPT, generate: generateScheduleSchema, schemaFile: scheduleSchemaFile, ledgerFile: SCHEDULE_LEDGER_FILE, ledgerProblem: scheduleLedgerProblem });
}
