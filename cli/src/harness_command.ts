import type { HarnessConfig } from "./types.js";
import { HarnessOrchestrator } from "./core/harness/orchestrator.js";
import { HarnessStore } from "./core/harness/store.js";
import { setLibraryEntryStatus } from "./core/harness/library.js";

export interface HarnessCommandResult { success: boolean; output: string }

const USAGE = [
  "Usage: /harness init --task-suite <path> --base <path> [--base-kind path|profile|fixture]",
  "       /harness run <id> [--mock|--real] [--allow-unsandboxed-real-probe] [--candidate <path>]",
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

function getFlag(parts: string[], name: string): string | undefined {
  const i = parts.indexOf(name);
  return i >= 0 ? parts[i + 1] : undefined;
}

export async function executeHarnessSlashCommand(args: string, _config: HarnessConfig, _signal: AbortSignal): Promise<HarnessCommandResult> {
  const parts = parseArgs(args.trim());
  if (parts.length === 0) return { success: false, output: USAGE };
  const stateDir = getFlag(parts, "--state-dir") ?? (process.env.NEXUS_STATE_DIR ? `${process.env.NEXUS_STATE_DIR}/harness` : undefined);
  const filtered: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "--state-dir") { i++; continue; }
    filtered.push(parts[i]);
  }
  const [sub, ...rest] = filtered;
  if (!sub) return { success: false, output: USAGE };
  const store = new HarnessStore(stateDir ? { rootDir: stateDir } : {});
  const orch = new HarnessOrchestrator(store);
  try {
    if (sub === "init") {
      const taskSuite = getFlag(rest, "--task-suite") ?? "";
      const base = getFlag(rest, "--base") ?? "";
      const baseKind = (getFlag(rest, "--base-kind") as "path" | "profile" | "fixture" | undefined) ?? "path";
      if (!taskSuite || !base) return { success: false, output: USAGE };
      const run = await orch.init({ taskSuitePath: taskSuite, basePath: base, baseKind, store });
      return { success: true, output: JSON.stringify(run, null, 2) };
    }
    if (sub === "run") {
      const id = rest.find((t) => !t.startsWith("--") && rest[rest.indexOf(t) - 1] !== "--candidate");
      if (!id) return { success: false, output: USAGE };
      const mock = rest.includes("--mock");
      const real = rest.includes("--real");
      const allowUnsandboxedRealProbe = rest.includes("--allow-unsandboxed-real-probe");
      const candidatePath = getFlag(rest, "--candidate");
      const run = await orch.run(id, { store, mock, real, candidatePath, allowUnsandboxedRealProbe });
      return { success: run.status !== "FAILED", output: JSON.stringify(run, null, 2) };
    }
    if (sub === "status") {
      const id = rest.find((t) => !t.startsWith("--"));
      if (!id) return { success: true, output: JSON.stringify(store.listRuns().map((r) => ({ id: r.id, status: r.status, probes: r.actualUsage.probes, report: r.promotionReportId, reason: r.reason })), null, 2) };
      return { success: true, output: JSON.stringify({ ...store.loadRun(id), liveMutation: false }, null, 2) };
    }
    if (sub === "show") {
      const id = rest.find((t) => !t.startsWith("--"));
      if (!id) return { success: false, output: USAGE };
      return { success: true, output: JSON.stringify({ run: store.loadRun(id), report: store.loadReport(id), liveMutation: false }, null, 2) };
    }
    if (sub === "report") {
      const id = rest.find((t) => !t.startsWith("--"));
      if (!id) return { success: false, output: USAGE };
      const report = store.loadReport(id);
      if (!report) return { success: false, output: `No report for ${id}` };
      return { success: true, output: JSON.stringify(report, null, 2) };
    }
    if (sub === "cancel") {
      const id = rest.find((t) => !t.startsWith("--"));
      if (!id) return { success: false, output: USAGE };
      return { success: true, output: JSON.stringify(orch.cancel(id), null, 2) };
    }
    if (sub === "library") {
      const action = rest[0];
      if (action === "list") return { success: true, output: JSON.stringify(store.listLibraryEntries(), null, 2) };
      if (action === "show" && rest[1]) return { success: true, output: JSON.stringify(store.loadLibraryEntry(rest[1]), null, 2) };
      if ((action === "accept" || action === "reject") && rest[1]) {
        return { success: true, output: JSON.stringify(setLibraryEntryStatus(store, rest[1], action as "accepted" | "rejected"), null, 2) };
      }
      return { success: false, output: USAGE };
    }
    return { success: false, output: USAGE };
  } catch (err) {
    return { success: false, output: err instanceof Error ? err.message : String(err) };
  }
}
