/**
 * What the schedule tests share (BG-2): the operator's steps through the real CLI (trust the repository, add a
 * schedule), a way to make a schedule due in a few seconds of real time, and reading the jobs a schedule started.
 */
import assert from "node:assert/strict";
import { listJobs, type JobRecord } from "../../src/core/runner_store.js";
import { readSchedule, schedulePaths, withScheduleLock, writeSchedule, type ScheduleRecord } from "../../src/core/schedule_store.js";
import { until, type RunnerWorld } from "./runner_fixture.js";

export async function trustRepo(world: RunnerWorld, repo: string): Promise<void> {
  const result = await world.run(["trust", repo]);
  assert.equal(result.code, 0, result.stderr);
}

/** `nexus schedule add --prompt <prompt> -w <repo> ...args`; returns the printed record when `--json` is among the args. */
export async function addSchedule(world: RunnerWorld, repo: string, prompt: string, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const result = await world.run(["schedule", "add", "--prompt", prompt, "-w", repo, ...args]);
  assert.equal(result.code, 0, result.stderr);
  return result;
}

/**
 * Changes a schedule as the operator's own editor would, under the schedule lock: `secondsAhead` makes its next slot
 * that far from now (an `every` schedule keeps its grid, so the anchor moves instead of the period).
 */
export function reseed(world: RunnerWorld, id: string, secondsAhead: number, change: (record: ScheduleRecord) => ScheduleRecord = (record) => record): void {
  const paths = schedulePaths(world.paths);
  withScheduleLock(paths, () => {
    const record = readSchedule(paths, id)!;
    assert.equal(record.trigger.kind, "every");
    const now = Date.now();
    const createdAt = new Date(now + secondsAhead * 1000 - (record.trigger as { seconds: number }).seconds * 1000).toISOString();
    writeSchedule(paths, change({ ...record, createdAt, state: { ...record.state, nextDueAt: new Date(now + secondsAhead * 1000).toISOString() } }));
  });
}

export const jobsOf = (world: RunnerWorld, id: string): JobRecord[] =>
  listJobs(world.paths).jobs.filter((job) => job.origin.kind === "schedule" && job.origin.scheduleId === id);

/** The first job the schedule has started, once there is one. */
export const firstJobOf = (world: RunnerWorld, id: string, timeoutMs = 120_000): Promise<JobRecord> =>
  until(() => jobsOf(world, id)[0], timeoutMs, () => `a job of schedule ${id}\n${JSON.stringify(readSchedule(schedulePaths(world.paths), id)?.state)}`);
