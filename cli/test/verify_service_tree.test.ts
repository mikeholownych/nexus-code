/**
 * VR-1 (#770 follow-up): the sweep that ends a cancelled verification must reach a process tree deeper than the
 * listing bound, and must not leave a process behind that kept forking while the sweep ran.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mergePolicies } from "../src/core/managed_policy.js";
import { pinBase, VerifyService, type PinnedBase, type VerifyServiceConfig, type VerifyServiceDeps } from "../src/core/verify_service.js";
import { makeHome, processGone, waitUntil } from "./helpers/fixtures.js";
import { GOOD, BASE_FILES, withRepos, writeFiles } from "./helpers/verify_fixture.js";

function processStartTime(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return fields[19]; // field 22 (starttime), relative to field 3 after the command name
  } catch {
    return undefined;
  }
}

const processes = () => spawnSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8" }).stdout.split("\n").map((line) => {
  const [, pid, ppid, args] = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line) ?? [];
  const parsedPid = Number(pid);
  return { pid: parsedPid, ppid: Number(ppid), args: args ?? "", startTime: parsedPid > 0 ? processStartTime(parsedPid) : undefined };
}).filter((entry) => entry.pid > 0);

async function isolated<T>(check: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  const home = makeHome();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-tree-tmp-"));
  for (const key of Object.keys(process.env)) if (/^(LOCAL_LLM_|LOCAL_HARNESS_|NEXUS_|GIT_|XDG_)/.test(key) || key === "NODE_TEST_CONTEXT") delete process.env[key];
  Object.assign(process.env, { HOME: home, TMPDIR: tmp });
  try { return await check(); } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    for (const dir of [tmp, home]) fs.rmSync(dir, { recursive: true, force: true });
  }
}

const service = (repo: string, command: string, deps: VerifyServiceDeps = {}) =>
  new VerifyService({ worktree: repo, verifierCommand: command, deliverables: ["src/math.js"], readOnly: false, surface: "mcp" } as VerifyServiceConfig, { policy: () => mergePolicies(), ...deps });

/** Cancel a verification whose command is `command`; every process carrying `marker` must be gone afterwards. */
async function cancelledLeavesNothing(command: string, marker: string, wanted: number): Promise<void> {
  await withRepos([BASE_FILES], (repo) => isolated(async () => {
    const base = pinBase(repo) as PinnedBase;
    writeFiles(repo, GOOD);
    const svc = service(repo, command, { killGraceMs: 2_000 });
    const controller = new AbortController();
    const running = svc.verify({ base }, controller.signal);
    void running.catch(() => undefined);
    const live = () => processes().filter((entry) => entry.args.includes(marker));
    try {
      await waitUntil(() => live().length >= wanted, 60_000);
      controller.abort();
      const outcome: any = await running;
      assert.equal(outcome.error.kind, "interrupted");
      await waitUntil(() => live().length === 0, 8_000);
    } finally {
      controller.abort();
      // On assertion/timeout paths, give VerifyService its normal cleanup window before cleaning any leak.
      await waitUntil(() => live().length === 0, 8_000).catch(() => undefined);
      for (const leakedProcess of live()) {
        // Never signal a PID saved before a wait: it may have exited and been reused. On Linux, also bind cleanup
        // to /proc starttime and the exact argv observed immediately before the signal.
        if (!leakedProcess.startTime) continue;
        const current = processes().find((entry) =>
          entry.pid === leakedProcess.pid && entry.startTime === leakedProcess.startTime && entry.args === leakedProcess.args && entry.args.includes(marker));
        if (current) try { process.kill(current.pid, "SIGKILL"); } catch { /* gone */ }
      }
    }
    assert.deepEqual(live().map((entry) => entry.pid).filter((pid) => !processGone(pid)), [], "no process of the tree outlives the cancellation");
  }));
}

test("a SIGTERM-ignoring chain of 14 generations is gone after a cancellation", { timeout: 180_000 }, async () => {
  const marker = `41${process.pid}.${Date.now() % 100000}`;
  await cancelledLeavesNothing(`f(){ trap '' TERM; if [ $1 -gt 0 ]; then f $(($1-1)) & wait; else sleep ${marker}; fi; }; f 14`, marker, 14);
});
