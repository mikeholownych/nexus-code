/**
 * Leak and hang guard: `import "./helpers/leak_guard.js";` at the top of a test file fails the file in teardown, naming
 * every RustCoreBridge or AutonomousAgent not shut down, scripted gateway not closed, child process still running and
 * timer still pending, then releases them so the process can exit instead of hanging the job.
 * Resources it cannot see by itself (a custom server) can be registered with `trackResource`.
 * Timers: ref'd timeouts above the count when the file finished loading (a timer created while the file loads is not
 * counted; node:test's own timers are gone by teardown). The check hook is registered once the file has finished
 * loading, so it runs after the file's own `after` hooks; a file that registers hooks after a top-level `await` can run
 * its hooks after the guard's check, and should then release in the test itself.
 */
import { after } from "node:test";
import childProcess from "node:child_process";
import { RustCoreBridge } from "../../src/tools.js";
import { survivors, trackResource, clearTracked } from "./leak_registry.js";

export { trackResource };

const proto = childProcess.ChildProcess.prototype as any;
const originalSpawn = proto.spawn;
proto.spawn = function (this: childProcess.ChildProcess, ...args: unknown[]) {
  const result = originalSpawn.apply(this, args);
  const command = [String((this as any).spawnfile ?? ""), ...((this as any).spawnargs ?? []).slice(1)].join(" ").slice(0, 120);
  trackResource("child process", `pid ${this.pid} ${command}`, () => this.exitCode === null && this.signalCode === null, () => {
    try { process.kill(-(this.pid as number), "SIGKILL"); } catch { this.kill("SIGKILL"); }
  });
  return result;
};

let baselineTimers = 0;
function activeTimers(): number {
  return process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
}

export function describeSurvivors(): string[] {
  const lines = survivors().map((s) => `${s.kind}: ${s.name}`);
  for (const bridge of (RustCoreBridge as any).activeBridges as Set<RustCoreBridge>) lines.push(`RustCoreBridge not shut down (workspace ${(bridge as any).workspace}); an AutonomousAgent owns one: call agent.shutdown()`);
  const timers = activeTimers() - baselineTimers;
  if (timers > 0) lines.push(`${timers} timer(s) still pending`);
  return lines;
}

// Registered once the file has finished loading so it runs after the file's own `after` hooks.
queueMicrotask(() => {
  baselineTimers = activeTimers();
  after(async () => {
    let lines = describeSurvivors();
    for (let i = 0; i < 20 && lines.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      lines = describeSurvivors();
    }
    if (!lines.length) return;
    for (const s of survivors()) await Promise.resolve(s.release()).catch(() => {});
    (RustCoreBridge as any).shutdownAllGlobal();
    clearTracked();
    setTimeout(() => process.stdout.write("", () => process.exit(1)), 5_000).unref();
    throw new Error(`${process.argv[1] ?? "test file"} leaked ${lines.length} resource(s) past the end of the file:\n  ${lines.join("\n  ")}`);
  });
});
