import type { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import pc from "picocolors";
import { HarnessOrchestrator } from "./core/harness/orchestrator.js";
import { HarnessStore } from "./core/harness/store.js";
import { setLibraryEntryStatus } from "./core/harness/library.js";
import { buildApplyPreview } from "./core/harness/apply_preview.js";

function out(obj: unknown, json = false): void {
  if (json) {
    process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
    return;
  }
  if (typeof obj === "string") process.stdout.write(obj + "\n");
  else process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

export async function withJsonStdout<T>(json: boolean, fn: () => Promise<T>): Promise<T> {
  if (!json) return fn();
  const originalWrite = process.stdout.write;
  (process.stdout.write as any) = ((chunk: any, enc?: any, cb?: any) => process.stderr.write(chunk, enc, cb));
  try {
    return await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
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
    .option("--max-rounds <n>", "Maximum rounds (default 1)", (v) => parseInt(v, 10))
    .option("--max-candidates-per-round <n>", "Maximum candidates per round (default 4)", (v) => parseInt(v, 10))
    .option("--max-probes <n>", "Maximum probes (default 8)", (v) => parseInt(v, 10))
    .option("--state-dir <path>", "Harness state root (defaults to NEXUS_STATE_DIR/harness or ~/.nexus/harness)")
    .option("--json", "Emit JSON")
    .action(async (opts) => {
      const store = storeFrom(opts);
      const orch = new HarnessOrchestrator(store);
      const run = await orch.init({
        taskSuitePath: opts.taskSuite,
        basePath: opts.base,
        baseKind: opts.baseKind,
        store,
        maxRounds: Number.isFinite(opts.maxRounds) ? opts.maxRounds : undefined,
        maxCandidatesPerRound: Number.isFinite(opts.maxCandidatesPerRound) ? opts.maxCandidatesPerRound : undefined,
        maxProbes: Number.isFinite(opts.maxProbes) ? opts.maxProbes : undefined,
      });
      out(opts.json ? run : `Created ${statusLine(run)}\n${run.nextAction ?? ""}`.trim(), opts.json);
    });

  harness.command("run <id>")
    .description("Run a harness improvement run")
    .option("--mock", "Use deterministic mock probe adapter (no network, no live model)")
    .option("--real", "Use isolated real probe adapter (deterministic verifier/artifact cases only; no live harness mutation)")
    .option("--nexus-agent", "Use Nexus agent probe adapter in isolated candidate workspace (deterministic oracle required; trajectory captured; requires harness-core binary or NEXUS_CORE_BIN)")
    .option("--nexus-model <id>", "Model for --nexus-agent (provider/model or model id)")
    .option("--nexus-endpoint <url>", "Endpoint for --nexus-agent")
    .option("--nexus-api-key <key>", "API key for --nexus-agent (prefer env/config; avoid in shell history)")
    .option("--nexus-max-steps <n>", "Max agent steps for --nexus-agent (default 8)", (v) => parseInt(v, 10))
    .option("--nexus-propose", "Use Nexus model proposal adapter for round>1 candidate generation (isolated, no live mutation)")
    .option("--nexus-propose-model <id>", "Model for --nexus-propose (defaults to --nexus-model/NEXUS_MODEL)")
    .option("--nexus-propose-endpoint <url>", "Endpoint for --nexus-propose (defaults to --nexus-endpoint/NEXUS_ENDPOINT)")
    .option("--nexus-propose-api-key <key>", "API key for --nexus-propose (prefer env/config)")
    .option("--allow-unsandboxed-real-probe", "OWNER-APPROVED ONLY: allow real probes when OS sandbox is unavailable (unsafe)")
    .option("--dry-run", "Validate/plan only; no probes executed")
    .option("--candidate <path>", "Candidate harness directory; can be repeated", (v: string, prev: string[] = []) => prev.concat([v]), [] as string[])
    .option("--state-dir <path>", "Harness state root")
    .option("--json", "Emit JSON")
    .action(async (id, opts) => {
      const store = storeFrom(opts);
      const orch = new HarnessOrchestrator(store);
      const candidatePaths = Array.isArray(opts.candidate) ? opts.candidate.filter(Boolean) : (opts.candidate ? [opts.candidate] : []);
      const nexusAgentConfig = opts.nexusAgent ? {
        model: opts.nexusModel || process.env.NEXUS_MODEL || "gpt-4o-mini",
        endpoint: opts.nexusEndpoint || process.env.NEXUS_ENDPOINT || process.env.OPENAI_BASE_URL || "http://127.0.0.1:11434/v1",
        apiKey: opts.nexusApiKey || process.env.NEXUS_API_KEY || process.env.OPENAI_API_KEY,
        maxSteps: Number.isFinite(opts.nexusMaxSteps) ? opts.nexusMaxSteps : undefined,
      } : undefined;
      const nexusProposalConfig = opts.nexusPropose ? {
        model: opts.nexusProposeModel || opts.nexusModel || process.env.NEXUS_MODEL || "gpt-4o-mini",
        endpoint: opts.nexusProposeEndpoint || opts.nexusEndpoint || process.env.NEXUS_ENDPOINT || process.env.OPENAI_BASE_URL || "http://127.0.0.1:11434/v1",
        apiKey: opts.nexusProposeApiKey || opts.nexusApiKey || process.env.NEXUS_API_KEY || process.env.OPENAI_API_KEY,
      } : undefined;
      const run = await withJsonStdout(!!opts.json, () => orch.run(id, {
        store,
        mock: !!opts.mock,
        real: !!opts.real,
        nexusAgent: !!opts.nexusAgent,
        nexusPropose: !!opts.nexusPropose,
        nexusAgentConfig,
        nexusProposalConfig,
        dryRun: !!opts.dryRun,
        candidatePath: candidatePaths[0],
        candidatePaths,
        allowUnsandboxedRealProbe: !!opts.allowUnsandboxedRealProbe,
      }));
      out(opts.json ? run : `Run ${statusLine(run)}${run.reason ? `\nreason: ${run.reason}` : ""}${run.nextAction ? `\nnext: ${run.nextAction}` : ""}`, opts.json);
      if (run.status !== "COMPLETED") process.exitCode = 1;
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

  harness.command("apply-preview <id>")
    .description("Generate review-only apply preview artifacts (NO live mutation)")
    .option("--state-dir <path>", "Harness state root")
    .option("--json", "Emit JSON")
    .action(async (id, opts) => {
      const store = storeFrom(opts);
      const preview = buildApplyPreview(store, id);
      out(opts.json ? preview : `Apply preview (review-only, no live mutation)\nrun=${preview.runId}\nreport=${preview.reportId}\ncandidate=${preview.candidateId ?? "-"}\ndir=${preview.previewDir}\n${preview.files.map((f) => `- ${f}`).join("\n")}`, opts.json);
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
