import type { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import pc from "picocolors";
import { HarnessOrchestrator } from "./core/harness/orchestrator.js";
import { HarnessStore } from "./core/harness/store.js";
import { setLibraryEntryStatus } from "./core/harness/library.js";

function out(obj: unknown, json = false): void {
  if (json) {
    console.log(JSON.stringify(obj, null, 2));
    return;
  }
  if (typeof obj === "string") console.log(obj);
  else console.log(JSON.stringify(obj, null, 2));
}

function storeFrom(opts: { stateDir?: string }): HarnessStore {
  return new HarnessStore(opts.stateDir ? { rootDir: path.resolve(opts.stateDir) } : {});
}

function statusLine(run: any): string {
  return `${run.id} ${run.status} base=${run.baseHarnessId} probes=${run.actualUsage?.probes ?? 0} report=${run.promotionReportId ?? "-"}`;
}

export function registerHarnessCommands(program: Command): void {
  const harness = program.command("harness").description("Evidence-gated harness improvement runs (no live mutation)");

  harness.command("init")
    .description("Create a harness improvement run from a base harness and task suite")
    .requiredOption("--task-suite <path>", "Task suite JSON file")
    .requiredOption("--base <path>", "Base harness directory or profile path")
    .option("--base-kind <kind>", "fixture|path|profile", "path")
    .option("--state-dir <path>", "Harness state root (defaults to NEXUS_STATE_DIR/harness or ~/.nexus/harness)")
    .option("--json", "Emit JSON")
    .action(async (opts) => {
      const store = storeFrom(opts);
      const orch = new HarnessOrchestrator(store);
      const run = await orch.init({ taskSuitePath: opts.taskSuite, basePath: opts.base, baseKind: opts.baseKind, store });
      out(opts.json ? run : `Created ${statusLine(run)}\n${run.nextAction ?? ""}`.trim(), opts.json);
    });

  harness.command("run <id>")
    .description("Run a harness improvement run")
    .option("--mock", "Use deterministic mock probe adapter (no network, no live model)")
    .option("--real", "Use isolated real probe adapter (deterministic verifier/artifact cases only; no live harness mutation)")
    .option("--dry-run", "Validate/plan only; no probes executed")
    .option("--candidate <path>", "Candidate harness directory; defaults to base tree")
    .option("--state-dir <path>", "Harness state root")
    .option("--json", "Emit JSON")
    .action(async (id, opts) => {
      const store = storeFrom(opts);
      const orch = new HarnessOrchestrator(store);
      const run = await orch.run(id, { store, mock: !!opts.mock, real: !!opts.real, dryRun: !!opts.dryRun, candidatePath: opts.candidate });
      out(opts.json ? run : `Run ${statusLine(run)}${run.reason ? `\nreason: ${run.reason}` : ""}${run.nextAction ? `\nnext: ${run.nextAction}` : ""}`, opts.json);
    });

  harness.command("status [id]")
    .description("Show harness improvement run status")
    .option("--state-dir <path>", "Harness state root")
    .option("--json", "Emit JSON")
    .action(async (id, opts) => {
      const store = storeFrom(opts);
      if (!id) {
        const runs = store.listRuns().map((r) => ({ id: r.id, status: r.status, updatedAt: r.updatedAt, baseHarnessId: r.baseHarnessId, promotionReportId: r.promotionReportId, probes: r.actualUsage.probes, reason: r.reason }));
        out(opts.json ? runs : runs.map((r) => `${r.id} ${r.status} probes=${r.probes} report=${r.promotionReportId ?? "-"}`).join("\n") || "No harness runs.", opts.json);
        return;
      }
      const run = store.loadRun(id);
      const payload = { ...run, liveMutation: false };
      out(opts.json ? payload : `${statusLine(run)}\nreason: ${run.reason ?? "-"}\nnext: ${run.nextAction ?? "-"}\nliveMutation: false`, opts.json);
    });

  harness.command("show <id>")
    .description("Show detailed harness improvement run")
    .option("--state-dir <path>", "Harness state root")
    .option("--json", "Emit JSON")
    .action(async (id, opts) => {
      const store = storeFrom(opts);
      const run = store.loadRun(id);
      const report = store.loadReport(id);
      const payload = { run, report, events: store.readEvents(id).slice(-50), liveMutation: false };
      out(opts.json ? payload : JSON.stringify(payload, null, 2), opts.json);
    });

  harness.command("report <id>")
    .description("Show or write promotion report")
    .option("--state-dir <path>", "Harness state root")
    .option("--out <path>", "Write markdown report to path")
    .option("--json", "Emit JSON")
    .action(async (id, opts) => {
      const store = storeFrom(opts);
      const report = store.loadReport(id);
      if (!report) throw new Error(`No report for ${id}`);
      if (opts.out) fs.writeFileSync(path.resolve(opts.out), fs.existsSync(store.reportMdPath(id)) ? fs.readFileSync(store.reportMdPath(id), "utf8") : JSON.stringify(report, null, 2));
      out(opts.json ? report : (fs.existsSync(store.reportMdPath(id)) ? fs.readFileSync(store.reportMdPath(id), "utf8") : JSON.stringify(report, null, 2)), opts.json);
    });

  harness.command("cancel <id>")
    .description("Cancel a harness improvement run")
    .option("--state-dir <path>", "Harness state root")
    .option("--json", "Emit JSON")
    .action(async (id, opts) => {
      const store = storeFrom(opts);
      const orch = new HarnessOrchestrator(store);
      const run = orch.cancel(id);
      out(opts.json ? run : `Cancelled ${statusLine(run)}`, opts.json);
    });

  const library = harness.command("library").description("Harness improvement library (draft lessons; no live mutation)");
  library.command("list")
    .option("--state-dir <path>", "Harness state root")
    .option("--json", "Emit JSON")
    .action(async (opts) => {
      const store = storeFrom(opts);
      const entries = store.listLibraryEntries();
      out(opts.json ? entries : entries.map((e) => `${e.id} ${e.status} run=${e.runId} ${e.statement}`).join("\n") || "No library entries.", opts.json);
    });
  library.command("show <id>")
    .option("--state-dir <path>", "Harness state root")
    .option("--json", "Emit JSON")
    .action(async (id, opts) => {
      const store = storeFrom(opts);
      out(store.loadLibraryEntry(id), opts.json);
    });
  library.command("accept <id>")
    .option("--state-dir <path>", "Harness state root")
    .option("--json", "Emit JSON")
    .action(async (id, opts) => {
      const store = storeFrom(opts);
      out(setLibraryEntryStatus(store, id, "accepted"), opts.json);
    });
  library.command("reject <id>")
    .option("--state-dir <path>", "Harness state root")
    .option("--json", "Emit JSON")
    .action(async (id, opts) => {
      const store = storeFrom(opts);
      out(setLibraryEntryStatus(store, id, "rejected"), opts.json);
    });
}
