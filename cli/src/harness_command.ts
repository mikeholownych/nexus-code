import type { HarnessConfig } from "./types.js";
import { HarnessOrchestrator } from "./core/harness/orchestrator.js";
import { HarnessStore } from "./core/harness/store.js";

export interface HarnessCommandResult { success: boolean; output: string }

const USAGE = [
  "Usage: /harness init --task-suite <path> --base <path> [--base-kind path|profile|fixture]",
  "       /harness run <id> [--mock|--real] [--candidate <path>]",
  "       /harness status [id] | show <id> | report <id> | cancel <id>",
  "       /harness library list|show <id>|accept <id>|reject <id>",
  "Note: HIR never mutates live harness/profile state; promotion reports are review-only.",
].join("\n");

function parseArgs(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m; (m = re.exec(args)); ) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export async function executeHarnessSlashCommand(args: string, config: HarnessConfig, _signal: AbortSignal): Promise<HarnessCommandResult> {
  const parts = parseArgs(args.trim());
  const [sub, ...rest] = parts;
  if (!sub) return { success: false, output: USAGE };
  const stateDirFlagIdx = parts.indexOf("--state-dir");
  const stateDir = stateDirFlagIdx >= 0 ? parts[stateDirFlagIdx + 1] : (process.env.NEXUS_STATE_DIR ? `${process.env.NEXUS_STATE_DIR}/harness` : undefined);
  const filtered = parts.filter((t, i) => !(t === "--state-dir" || i === stateDirFlagIdx + 1));
  const [sub2, ...rest2] = filtered;
  const subUse = sub2 ?? sub;
  const restUse = sub2 ? rest2 : rest;
  const store = new HarnessStore(stateDir ? { rootDir: stateDir } : {});
  const orch = new HarnessOrchestrator(store);
  try {
    if (subUse === "init") {
      let taskSuite = "", base = "", baseKind: "path"|"profile"|"fixture" = "path";
      for (let i = 0; i < restUse.length; i++) {
        const t = restUse[i];
        if (t === "--task-suite") taskSuite = restUse[++i] ?? "";
        else if (t === "--base") base = restUse[++i] ?? "";
        else if (t === "--base-kind") baseKind = (restUse[++i] as any) ?? "path";
      }
      if (!taskSuite || !base) return { success: false, output: USAGE };
      const run = await orch.init({ taskSuitePath: taskSuite, basePath: base, baseKind, store });
      return { success: true, output: JSON.stringify(run, null, 2) };
    }
    if (subUse === "run") {
      const id = restUse[0];
      if (!id) return { success: false, output: USAGE };
      const mock = restUse.includes("--mock");
      const real = restUse.includes("--real");
      const candIdx = restUse.indexOf("--candidate");
      const candidatePath = candIdx >= 0 ? restUse[candIdx + 1] : undefined;
      const run = await orch.run(id, { store, mock, real, candidatePath });
      return { success: run.status !== "FAILED", output: JSON.stringify(run, null, 2) };
    }
    if (subUse === "status") {
      const id = restUse[0];
      if (!id) return { success: true, output: JSON.stringify(store.listRuns().map((r) => ({ id: r.id, status: r.status, probes: r.actualUsage.probes, report: r.promotionReportId })), null, 2) };
      return { success: true, output: JSON.stringify({ ...store.loadRun(id), liveMutation: false }, null, 2) };
    }
    if (subUse === "show") {
      const id = restUse[0]; if (!id) return { success: false, output: USAGE };
      return { success: true, output: JSON.stringify({ run: store.loadRun(id), report: store.loadReport(id), liveMutation: false }, null, 2) };
    }
    if (subUse === "report") {
      const id = restUse[0]; if (!id) return { success: false, output: USAGE };
      const report = store.loadReport(id);
      if (!report) return { success: false, output: `No report for ${id}` };
      return { success: true, output: JSON.stringify(report, null, 2) };
    }
    if (subUse === "cancel") {
      const id = restUse[0]; if (!id) return { success: false, output: USAGE };
      return { success: true, output: JSON.stringify(orch.cancel(id), null, 2) };
    }
    if (subUse === "library") {
      const action = restUse[0];
      if (action === "list") return { success: true, output: JSON.stringify(store.listLibraryEntries(), null, 2) };
      if (action === "show" && restUse[1]) return { success: true, output: JSON.stringify(store.loadLibraryEntry(restUse[1]), null, 2) };
      if ((action === "accept" || action === "reject") && restUse[1]) {
        const { setLibraryEntryStatus } = await import("./core/harness/library.js");
        return { success: true, output: JSON.stringify(setLibraryEntryStatus(store, restUse[1], action as "accepted"|"rejected"), null, 2) };
      }
      return { success: false, output: USAGE };
    }
    return { success: false, output: USAGE };
  } catch (err) {
    return { success: false, output: err instanceof Error ? err.message : String(err) };
  }
}
