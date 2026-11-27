import { parseBatchWords } from "./batch.js";
import { parseLoopDuration } from "./loop_command.js";
import { OperationMonitor, parsePollTarget, type PollRecord, type PollRuntime } from "./poll.js";
import type { HarnessConfig } from "./types.js";
import { formatDiagnosticForOutput } from "./ui.js";

export const POLL_USAGE = [
  "Usage: /poll start operation:<id> --interval <duration> --timeout <duration> --max-calls <n>",
  "       /poll status <poll-id> | resume <poll-id> | cancel <poll-id> | list",
  "Interval: 5 seconds minimum. Timeout: 1 second to 24 hours. Call limit: 1 to 100.",
].join("\n");

function render(record: PollRecord): string {
  const lines = [
    `Poll ${record.id}: ${record.status}`,
    `Read-only target: operation:${record.target.operationId}`,
    `Calls: ${record.attempts.length}/${record.maxCalls}. Deadline: ${new Date(record.deadlineAt).toISOString()}`,
  ];
  if (record.status === "WAITING") lines.push(`Earliest next read: ${new Date(record.nextDueAt).toISOString()}`);
  for (const attempt of record.attempts) {
    const detail = attempt.status === "OBSERVED"
      ? `recorded operation status ${attempt.observation.recordedStatus}`
      : attempt.status === "UNKNOWN" ? `UNKNOWN (${attempt.reason})` : "UNKNOWN (no result recorded yet)";
    lines.push(`  #${attempt.number} ${new Date(attempt.startedAt).toISOString()} ${detail}`);
  }
  if (record.status === "OBSERVED_TERMINAL") lines.push("The poll observed a recorded terminal status for the target.");
  if (record.status === "CLOCK_CHANGED") lines.push("The clock moved backwards. Start a new poll when the clock is stable.");
  return lines.join("\n");
}

export async function executePollCommand(
  args: string,
  config: HarnessConfig,
  signal?: AbortSignal,
  runtime: PollRuntime = {},
): Promise<{ success: boolean; output: string }> {
  try {
    const words = parseBatchWords(args);
    const action = words[0];
    if (!action) return { success: false, output: POLL_USAGE };
    if ((action === "list" && words.length !== 1)
      || (["status", "resume", "cancel"].includes(action) && words.length !== 2)
      || (!["start", "list", "status", "resume", "cancel"].includes(action))) {
      return { success: false, output: POLL_USAGE };
    }
    if (["start", "resume", "cancel"].includes(action)
      && (config.readOnly || config.dryRun || config.approvalMode === "read-only")) {
      return { success: false, output: "This mode cannot create, resume or cancel a poll." };
    }
    const monitor = new OperationMonitor(config.workspace, runtime);
    if (action === "list") {
      const rows = monitor.store.list();
      return {
        success: true,
        output: rows.length ? rows.map((row) =>
          `${row.id}  ${row.status}  operation:${row.target.operationId}  ${row.attempts.length}/${row.maxCalls}`).join("\n")
          : "No polls in this workspace.",
      };
    }
    if (action === "status") return { success: true, output: render(monitor.store.load(words[1])) };
    if (action === "cancel") return { success: true, output: render(monitor.cancel(words[1])) };
    if (action === "resume") return { success: true, output: render(await monitor.resume(words[1], signal)) };
    if (words.length !== 8) return { success: false, output: POLL_USAGE };
    const target = parsePollTarget(words[1]);
    const values = new Map<string, string>();
    for (let index = 2; index < words.length; index += 2) {
      const flag = words[index];
      if (values.has(flag)) return { success: false, output: POLL_USAGE };
      values.set(flag, words[index + 1]);
    }
    const intervalMs = parseLoopDuration(values.get("--interval") ?? "");
    const timeoutMs = parseLoopDuration(values.get("--timeout") ?? "");
    const maxCalls = values.get("--max-calls") ?? "";
    if (intervalMs === undefined || timeoutMs === undefined || !/^\d+$/.test(maxCalls)) {
      return { success: false, output: POLL_USAGE };
    }
    const record = await monitor.start({ target, intervalMs, timeoutMs, maxCalls: Number(maxCalls) }, signal);
    return { success: true, output: render(record) };
  } catch (error) {
    return { success: false, output: formatDiagnosticForOutput(error) };
  }
}
