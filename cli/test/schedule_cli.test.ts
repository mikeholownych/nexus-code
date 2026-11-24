/**
 * BG-2: `nexus schedule add|list|status|remove|pause|resume|run-now` as the real CLI. What a schedule can ask for is
 * what a job can ask for and no more; the permission level is fixed at creation; an untrusted workspace, a bad
 * expression, a schedule file that does not look like one this program wrote, and a 65th schedule are refused.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { listJobs } from "../src/core/runner_store.js";
import { listSchedules, MAX_SCHEDULES, newScheduleState, readSchedule, schedulePaths, writeSchedule, type ScheduleRecord } from "../src/core/schedule_store.js";
import { DEFAULT_JOB_BUDGETS } from "../src/core/runner_store.js";
import { makeRepo } from "./helpers/fixtures.js";
import { runnerWorld, stalledGateway, type RunnerWorld } from "./helpers/runner_fixture.js";

async function withWorld(body: (world: RunnerWorld, repo: string, trusted: () => Promise<void>) => Promise<void>): Promise<void> {
  const world = runnerWorld();
  const repo = fs.realpathSync(makeRepo({ "README.md": "hello\n" }));
  try {
    await body(world, repo, async () => {
      const trust = await world.run(["trust", repo]);
      assert.equal(trust.code, 0, trust.stderr);
    });
  } finally {
    await world.cleanup();
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

const add = (world: RunnerWorld, repo: string, ...args: string[]) => world.run(["schedule", "add", "--prompt", "look at the tests", "-w", repo, ...args]);

test("add refuses a workspace the operator has not trusted, and nothing is written", { timeout: 120_000 }, async () => {
  await withWorld(async (world, repo) => {
    const result = await add(world, repo, "--name", "nightly", "--every", "15m");
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /not a trusted workspace/);
    assert.match(result.stderr, /nexus trust/);
    assert.deepEqual(listSchedules(schedulePaths(world.paths)).schedules, []);
    const writable = await add(world, repo, "--name", "nightly", "--every", "15m", "--allow-worktree-write");
    assert.equal(writable.code, 2, "asking for write access does not change that");
    assert.match(writable.stderr, /not a trusted workspace/);
  });
});

test("add, list, status, pause, resume and remove: the operator's whole loop", { timeout: 180_000 }, async () => {
  await withWorld(async (world, repo, trusted) => {
    await trusted();
    const added = await add(world, repo, "--name", "nightly", "--cron", "0 3 * * 1-5", "--verifier", "node --test", "--max-runs", "5", "--json");
    assert.equal(added.code, 0, added.stderr);
    const shown = JSON.parse(added.stdout);
    assert.equal(shown.schedule.id, "nightly");
    assert.equal(shown.schedule.policy, "read-only", "read-only unless the operator says otherwise");
    assert.equal(shown.schedule.verifier, "node --test");
    assert.equal(shown.schedule.remainingRuns, 5);
    assert.equal(shown.schedule.onMissed, "report", "a missed schedule must be reported unless catch-up is explicitly requested");
    assert.equal(shown.upcoming.length, 3);
    assert.equal(shown.schedule.state.nextDueAt, shown.upcoming[0]);
    const paths = schedulePaths(world.paths);
    assert.equal(fs.statSync(paths.record("nightly")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths.dir).mode & 0o777, 0o700);
    assert.equal(readSchedule(paths, "nightly")?.workspace, repo);

    const text = await add(world, repo, "--name", "weekly", "--every", "1d", "--allow-worktree-write", "--on-missed", "report");
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /Added schedule weekly/);
    assert.match(text.stdout, /next runs: /);
    assert.match(text.stdout, /writes? inside that worktree only|may write inside that worktree only/);
    assert.equal(readSchedule(paths, "weekly")?.policy, "worktree-write");
    assert.equal(readSchedule(paths, "weekly")?.onMissed, "report");
    assert.match(text.stderr, /no runner is running/);

    const listed = JSON.parse((await world.run(["schedule", "list", "--json"])).stdout);
    assert.deepEqual(listed.schedules.map((s: ScheduleRecord) => s.id), ["nightly", "weekly"]);
    assert.deepEqual(listed.invalid, []);
    const plain = await world.run(["schedule", "list"]);
    assert.match(plain.stdout, /nightly\s+enabled\s+cron 0 3 \* \* 1-5 \(UTC\)\s+read-only/);

    const status = JSON.parse((await world.run(["schedule", "status", "nightly", "--json"])).stdout);
    assert.equal(status.schedule.id, "nightly");
    assert.equal(status.latest_job, null);
    const statusText = await world.run(["schedule", "status", "nightly"]);
    assert.match(statusText.stdout, /missed runs: 0 \(none\)/);

    assert.equal((await world.run(["schedule", "pause", "nightly"])).code, 0);
    assert.equal(readSchedule(paths, "nightly")?.enabled, false);
    assert.equal((await world.run(["schedule", "resume", "nightly"])).code, 0);
    assert.equal(readSchedule(paths, "nightly")?.enabled, true);

    // A leftover pointer and missed-run receipt go with the schedule.
    fs.writeFileSync(paths.latest("nightly"), "{}", { mode: 0o600 });
    fs.writeFileSync(paths.missed("nightly", "2026-11-24T00:00:00.000Z"), "{}", { mode: 0o600 });
    assert.equal((await world.run(["schedule", "rm", "nightly"])).code, 0);
    assert.deepEqual(fs.readdirSync(paths.dir).filter((n) => n.startsWith("nightly")), []);
    assert.deepEqual(listSchedules(paths).schedules.map((s) => s.id), ["weekly"]);

    const missing = await world.run(["schedule", "status", "nightly"]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /There is no schedule nightly/);
  });
});

test("what is not a schedule's to ask: modes, sandbox flags, a second trigger, a bad name, a duplicate, a past time", { timeout: 240_000 }, async () => {
  await withWorld(async (world, repo, trusted) => {
    await trusted();
    for (const flags of [["--yes"], ["--mode", "auto"], ["--approve"], ["--sandbox", "none"], ["--sandbox-network"], ["--read-only"], ["--dry-run"]]) {
      const result = await world.run([...flags, "schedule", "add", "--prompt", "p", "-w", repo, "--every", "15m"]);
      assert.equal(result.code, 2, `${flags.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, /does not apply to a background job and is refused/);
    }
    const auto = await add(world, repo, "--every", "15m");
    assert.equal(auto.code, 0, auto.stderr);
    const env = await world.run(["schedule", "add", "--prompt", "p", "-w", repo, "--every", "15m"], { NEXUS_APPROVAL_MODE: "auto" });
    assert.equal(env.code, 2);
    assert.match(env.stderr, /never runs in auto mode/);

    const cases: Array<[string[], RegExp]> = [
      [[], /exactly one of --cron/],
      [["--cron", "* * * * *", "--every", "5m"], /exactly one of --cron/],
      [["--every", "1m"], /an interval is from 300 seconds/],
      [["--cron", "*/0 * * * *"], /step of 0/],
      [["--cron", "0 0 30 2 *"], /never matches/],
      [["--cron", "0 0 31 2 *"], /never matches/],
      [["--cron", "59,0 23,0 1,2 * *"], /at least 5 minutes apart/],
      [["--cron", "@daily"], /shortcuts/],
      [["--at", "2020-01-01T00:00:00Z"], /not in the future/],
      [["--at", "tomorrow"], /not a UTC time/],
      [["--every", "15m", "--name", "Bad Name"], /not a schedule id/],
      [["--every", "15m", "--name", "../escape"], /not a schedule id/],
      [["--every", "15m", "--max-runs", "0"], /--max-runs must be/],
      [["--every", "15m", "--on-missed", "run-all"], /--on-missed must be/],
      [["--every", "15m", "--verifier", "  "], /--verifier needs a command/],
      [["--every", "15m", "--deliverable-file", "../../etc/passwd"], /.+/],
    ];
    for (const [flags, pattern] of cases) {
      const result = await add(world, repo, ...flags);
      assert.equal(result.code, 2, `${flags.join(" ")}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, pattern, flags.join(" "));
    }
    assert.equal(listSchedules(schedulePaths(world.paths)).schedules.length, 1, "only the one valid add left a schedule");

    assert.equal((await add(world, repo, "--name", "same", "--every", "15m")).code, 0);
    const dup = await add(world, repo, "--name", "same", "--every", "15m");
    assert.equal(dup.code, 2);
    assert.match(dup.stderr, /already a schedule same/);
  });
});

test("the 65th schedule is refused", { timeout: 120_000 }, async () => {
  await withWorld(async (world, repo, trusted) => {
    await trusted();
    const paths = schedulePaths(world.paths);
    fs.mkdirSync(world.paths.root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    for (let i = 0; i < MAX_SCHEDULES; i++) {
      writeSchedule(paths, {
        format: "nexus-schedule", version: 1, id: `s${String(i).padStart(2, "0")}`, createdAt: "2026-11-24T00:00:00.000Z", enabled: false, workspace: repo, trigger: { kind: "every", seconds: 3600 },
        task: { prompt: "p" }, policy: "read-only", verifier: null, deliverables: [], provider: {}, budgets: { ...DEFAULT_JOB_BUDGETS }, remainingRuns: null, onMissed: "report", state: newScheduleState(null),
      });
    }
    const result = await add(world, repo, "--name", "one-too-many", "--every", "15m");
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /already 64 schedules/);
    assert.equal(readSchedule(paths, "one-too-many"), undefined);
  });
});

test("a schedule file that was edited by hand is shown as invalid and is not used by the commands that would change it", { timeout: 120_000 }, async () => {
  await withWorld(async (world, repo, trusted) => {
    await trusted();
    assert.equal((await add(world, repo, "--name", "tampered", "--every", "15m")).code, 0);
    const file = schedulePaths(world.paths).record("tampered");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"read-only"', '"full-access"'), { mode: 0o600 });
    const listed = JSON.parse((await world.run(["schedule", "list", "--json"])).stdout);
    assert.equal(listed.schedules.length, 0);
    assert.match(listed.invalid[0].error, /policy must be one of read-only, worktree-write/);
    assert.match((await world.run(["schedule", "list"])).stderr, /Invalid schedule tampered \(it will not run\)/);
    for (const verb of ["pause", "resume", "status", "run-now"]) {
      const result = await world.run(["schedule", verb, "tampered"]);
      assert.equal(result.code, 2, `${verb}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /policy must be one of/, verb);
    }
  });
});

test("run-now needs a runner and a trusted workspace, and refuses while the schedule's previous job runs", { timeout: 120_000 }, async () => {
  await withWorld(async (world, repo, trusted) => {
    await trusted();
    assert.equal((await add(world, repo, "--name", "n", "--every", "15m")).code, 0);
    const none = await world.run(["schedule", "run-now", "n"]);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /no runner is running/);
    assert.equal((await world.run(["trust", "--remove", repo])).code, 0);
    const untrusted = await world.run(["schedule", "run-now", "n"]);
    assert.equal(untrusted.code, 2);
    assert.match(untrusted.stderr, /not a trusted workspace/);
  });
});

test("two run-now at once start one job: the running-job check and the runner's acceptance happen under the schedule lock", { timeout: 240_000 }, async () => {
  const world = runnerWorld();
  const repo = fs.realpathSync(makeRepo({ "README.md": "hello\n" }));
  const gw = await stalledGateway();
  try {
    assert.equal((await world.run(["trust", repo])).code, 0);
    assert.equal((await add(world, repo, "--name", "n", "--every", "15m", "-e", gw.url, "-m", "m")).code, 0);
    await world.startRunner();
    const runs = await Promise.all([world.run(["schedule", "run-now", "n"]), world.run(["schedule", "run-now", "n"])]);
    const ok = runs.filter((run) => run.code === 0);
    const refused = runs.filter((run) => run.code === 2);
    assert.equal(ok.length, 1, JSON.stringify(runs));
    assert.equal(refused.length, 1, JSON.stringify(runs));
    assert.match(refused[0].stderr, /still has a running job/);
    assert.equal(listJobs(world.paths).jobs.filter((job) => job.origin.kind === "schedule" && job.origin.scheduleId === "n").length, 1);
  } finally {
    await world.cleanup();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("add warns that a read-only run does not run its verifier", { timeout: 120_000 }, async () => {
  await withWorld(async (world, repo, trusted) => {
    await trusted();
    const result = await add(world, repo, "--name", "w", "--every", "15m", "--verifier", "node --test");
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /a read-only run does not run its verifier/);
    const writable = await add(world, repo, "--name", "x", "--every", "15m", "--verifier", "node --test", "--allow-worktree-write");
    assert.doesNotMatch(writable.stderr, /does not run its verifier/);
    const bad = await add(world, repo, "--name", "y", "--every", "15m", "--verifier", "rm -rf /", "--allow-worktree-write");
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /refused by the security policy/);
    const fast = await add(world, repo, "--name", "z", "--cron", "*/2 * * * *");
    assert.equal(fast.code, 2);
    assert.match(fast.stderr, /at least 5 minutes apart/);
  });
});
