/**
 * BG-2 / G-3 for schedules: a hostile model, repository or file cannot create or widen a schedule, and a schedule
 * cannot widen a job. Each test here fails when the guard it names is removed (see the notes beside each).
 */
import "./helpers/leak_guard.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AutonomousAgent } from "../src/agent.js";
import { buildConfig } from "../src/config.js";
import { DEFAULT_JOB_BUDGETS, newJobRecord, runnerPaths, type JobPolicy } from "../src/core/runner_store.js";
import { submissionFor } from "../src/core/schedule_engine.js";
import { ensureScheduleDir, newScheduleState, parseScheduleRecord, readSchedule, schedulePaths, writeSchedule, type ScheduleRecord } from "../src/core/schedule_store.js";
import { unattendedConfig } from "../src/core/unattended.js";
import { setWorkspaceTrusted } from "../src/workspace_trust.js";
import { makeRepo } from "./helpers/fixtures.js";
import { dispatch, hookAgent } from "./helpers/hooks_fixture.js";
import { bench } from "./helpers/runner_fixture.js";
import { listJobs } from "../src/core/runner_store.js";

const T0 = Date.parse("2026-11-24T00:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const temp: string[] = [];
const agents: AutonomousAgent[] = [];
const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sched-hostile-home-"));
process.env.HOME = home;
temp.push(home);
after(() => {
  for (const agent of agents) agent.shutdown();
  for (const dir of temp) fs.rmSync(dir, { recursive: true, force: true });
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
});

const record = (workspace: string, overrides: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  format: "nexus-schedule", version: 1, id: "hourly", createdAt: iso(T0), enabled: true, workspace, trigger: { kind: "every", seconds: 3600 }, task: { prompt: "look around" }, policy: "read-only",
  verifier: null, deliverables: [], provider: {}, budgets: { ...DEFAULT_JOB_BUDGETS }, remainingRuns: null, onMissed: "run-once", state: newScheduleState(iso(T0 + HOUR)), ...overrides,
});

test("the agent's own write tools cannot create, change or delete a schedule, even with full access and the store inside its workspace", async () => {
  // Guard: "nexus-schedules*" in DEFAULT_PROTECTED_PATHS (security.ts). Without it each write below lands.
  const repo = fs.realpathSync(makeRepo({ "a.txt": "hello\n" }));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sched-hostile-agent-"));
  temp.push(repo, stateDir);
  const runner = runnerPaths(path.join(repo, "state", "runner"));
  const paths = schedulePaths(runner);
  fs.mkdirSync(runner.root, { recursive: true, mode: 0o700 });
  ensureScheduleDir(paths);
  const existing = record(repo, { id: "existing" });
  writeSchedule(paths, existing);
  const before = fs.readFileSync(paths.record("existing"), "utf8");

  const agent = hookAgent({ repo, stateDir, mode: "auto", fullAccess: true });
  agents.push(agent);
  const evil = JSON.stringify({ ...record(repo, { id: "evil", policy: "worktree-write" }) }, null, 2);
  const refused = async (name: string, args: Record<string, unknown>) => {
    const receipt = await dispatch(agent, name, args);
    assert.equal(receipt.success, false, `${name} ${JSON.stringify(args).slice(0, 80)}: ${JSON.stringify(receipt).slice(0, 300)}`);
    assert.match(JSON.stringify(receipt), /Security Policy Violation|protected/i, `${name}: refused for the right reason`);
  };

  await refused("write_file", { path: paths.record("evil"), content: evil });
  await refused("write_file", { path: path.relative(repo, paths.record("evil")), content: evil });
  await refused("write_file", { path: paths.record("existing"), content: evil.replace('"evil"', '"existing"') });
  await refused("edit_file", { path: paths.record("existing"), old_content: '"read-only"', new_content: '"worktree-write"' });
  await refused("delete_file", { path: paths.record("existing") });
  await refused("write_file", { path: paths.latest("evil"), content: "{}" });
  await refused("write_file", { path: paths.guard, content: "" });
  await refused("read_file", { path: paths.record("existing") });
  assert.equal(fs.existsSync(paths.record("evil")), false);
  assert.equal(fs.readFileSync(paths.record("existing"), "utf8"), before);
  assert.deepEqual(readSchedule(paths, "existing"), existing);

  // Control: the same agent writes next to the store without trouble, so the refusals above are the guard's.
  const control = await dispatch(agent, "write_file", { path: "state/notes.txt", content: "ok\n" });
  assert.equal(control.success, true, JSON.stringify(control).slice(0, 300));
});

test("a record planted for an untrusted workspace never fires; trust is read from the operator's own list at fire time", async () => {
  // Guard: the engine's `workspaceListed` (isWorkspaceListed by default). Planted as a shell command could, with the agent's file tools refused.
  const repo = fs.realpathSync(makeRepo({ "README.md": "x\n" }));
  temp.push(repo);
  const b = bench(repo);
  const clock = { ms: T0 };
  try {
    const runner = b.runner({ now: () => new Date(clock.ms), schedules: { scanMs: 0 }, standIn: () => ({ command: ["true"], result: { operationStatus: "BLOCKED", exit: 2 } }) });
    fs.mkdirSync(b.paths.root, { recursive: true, mode: 0o700 });
    runner.start();
    const paths = schedulePaths(b.paths);
    ensureScheduleDir(paths);
    writeSchedule(paths, record(repo, { id: "planted", policy: "worktree-write" }));
    clock.ms = T0 + HOUR + 1_000;
    runner.tick();
    assert.equal(listJobs(b.paths).jobs.length, 0, "not trusted: no job");
    const refused = readSchedule(paths, "planted")!;
    assert.equal(refused.state.lastOutcome, "REFUSED");
    assert.match(refused.state.missed[0].detail ?? "", /not in the trusted-workspace list/);
    assert.equal(refused.policy, "worktree-write", "the record was neither run nor rewritten");

    // The operator's own decision is what changes this, and it takes effect at the next slot.
    setWorkspaceTrusted(repo, true);
    clock.ms = T0 + 2 * HOUR + 1_000;
    runner.tick();
    assert.equal(listJobs(b.paths).jobs.length, 1);
    await b.drive(runner, () => listJobs(b.paths).jobs.every((job) => job.outcome !== undefined));
    setWorkspaceTrusted(repo, false);
    clock.ms = T0 + 3 * HOUR + 1_000;
    runner.tick();
    assert.equal(listJobs(b.paths).jobs.length, 1, "trust withdrawn: the next slot is refused again");
    assert.equal(readSchedule(paths, "planted")!.state.lastOutcome, "REFUSED");
  } finally {
    await b.cleanup();
  }
});

test("a hand-made schedule that reaches past what the CLI allows is never run: the engine reads it as strictly as it is written", async () => {
  // Guards: parseScheduleRecord (unknown keys, enums), readPrivateJson (mode, links, owner, duplicate keys).
  const repo = fs.realpathSync(makeRepo({ "README.md": "x\n" }));
  temp.push(repo);
  setWorkspaceTrusted(repo, true);
  const b = bench(repo);
  const clock = { ms: T0 };
  try {
    const runner = b.runner({ now: () => new Date(clock.ms), schedules: { scanMs: 0 } });
    fs.mkdirSync(b.paths.root, { recursive: true, mode: 0o700 });
    runner.start();
    const paths = schedulePaths(b.paths);
    ensureScheduleDir(paths);
    const good = JSON.stringify(record(repo), null, 2);
    const plant = (id: string, text: string, mode = 0o600) => fs.writeFileSync(paths.record(id), text.replace(/"id": "hourly"/, `"id": "${id}"`), { mode });
    plant("full-access", good.replace('"read-only"', '"full-access"'));
    plant("auto-key", good.replace('"policy"', '"approval": "auto",\n  "policy"'));
    plant("allow-always", good.replace('"policy"', '"allowAlways": true,\n  "policy"'));
    plant("dup-policy", good.replace('"policy": "read-only",', '"policy": "read-only",\n  "policy": "worktree-write",'));
    plant("loose-mode", good, 0o644);
    plant("relative-ws", good.replace(JSON.stringify(repo), '"repo"'));
    plant("webhook", good.replace('"kind": "every"', '"kind": "webhook"'));
    fs.symlinkSync(path.join(paths.dir, "loose-mode.json"), paths.record("symlinked"));
    clock.ms = T0 + HOUR + 1_000;
    runner.tick();
    assert.equal(listJobs(b.paths).jobs.length, 0, "none of them ran");
    const logged = b.log.filter((line) => /is not valid and will not run/.test(line));
    assert.equal(logged.length, 8, logged.join("\n"));


  } finally {
    await b.cleanup();
  }
});

test("a schedule directory that belongs to another user is not read at all, however sound its records", async () => {
  // Guard: the owner check in ensureScheduleDir / readPrivateJson, reached through the engine (the foreign uid is injected).
  const repo = fs.realpathSync(makeRepo({ "README.md": "x\n" }));
  temp.push(repo);
  setWorkspaceTrusted(repo, true);
  const b = bench(repo);
  const clock = { ms: T0 };
  try {
    const runner = b.runner({ now: () => new Date(clock.ms), schedules: { scanMs: 0, owner: process.geteuid!() + 1 } });
    fs.mkdirSync(b.paths.root, { recursive: true, mode: 0o700 });
    runner.start();
    const paths = schedulePaths(b.paths);
    ensureScheduleDir(paths);
    writeSchedule(paths, record(repo));
    clock.ms = T0 + HOUR + 1_000;
    runner.tick();
    assert.equal(listJobs(b.paths).jobs.length, 0);
    assert.ok(b.log.some((line) => /schedules: .*not owned by the running user/.test(line)), b.log.join("\n"));
  } finally {
    await b.cleanup();
  }
});

test("a schedule cannot widen a job: its submission carries only the two policy levels, never auto mode, full access or a grant", () => {
  // Guard: unattendedConfig / assertUnattended (BG-1) fed by the submission the schedule builds; the record has no approval field to set.
  const repo = fs.realpathSync(makeRepo({ "README.md": "x\n" }));
  temp.push(repo);
  const saved = { mode: process.env.NEXUS_APPROVAL_MODE, trust: process.env.NEXUS_TRUST_WORKSPACE };
  process.env.NEXUS_APPROVAL_MODE = "auto";
  try {
    for (const policy of ["read-only", "worktree-write"] as JobPolicy[]) {
      const { job, spec } = submissionFor(record(repo, { policy }), iso(T0 + HOUR));
      assert.deepEqual(Object.keys(job).sort(), ["baseCommit", "budgets", "deliverables", "id", "operationId", "origin", "policy", "provider", "specSha256", "unattended", "verifier", "workspace"]);
      assert.equal(job.unattended, true);
      assert.equal(job.policy, policy);
      assert.deepEqual(job.origin, { kind: "schedule", scheduleId: "hourly", dueAt: iso(T0 + HOUR) });
      assert.equal((spec.git as { isolate: boolean }).isolate, true, "always a fresh worktree");
      assert.equal(JSON.stringify(spec).includes("allow"), false, "no grant in the spec");
      const config = unattendedConfig(newJobRecord(job, new Date(T0)), buildConfig, false);
      assert.equal(config.approvalMode, policy === "worktree-write" ? "review" : "read-only");
      assert.equal(Boolean(config.fullAccess), false);
      assert.equal(Boolean(config.yes), false);
      assert.notEqual(config.approvalMode, "auto", "the runner's own NEXUS_APPROVAL_MODE=auto does not reach the job");
    }
  } finally {
    if (saved.mode === undefined) delete process.env.NEXUS_APPROVAL_MODE; else process.env.NEXUS_APPROVAL_MODE = saved.mode;
  }
});

test("paths outside the workspace: a deliverable that climbs out, a workspace that is a link, and a directory that is not a repository are all refused at fire time", () => {
  // Guards: normalizeTrustedDeliverableFiles, the real-path check in submissionFor, chooseJobIds.
  const repo = fs.realpathSync(makeRepo({ "README.md": "x\n" }));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sched-outside-"));
  const link = path.join(outside, "link");
  fs.symlinkSync(repo, link);
  temp.push(repo, outside);
  for (const deliverables of [["../../etc/passwd"], ["/etc/passwd"], ["a/../../x"]]) {
    assert.throws(() => submissionFor(record(repo, { deliverables }), iso(T0 + HOUR)), Error, JSON.stringify(deliverables));
  }
  assert.throws(() => submissionFor(record(link), iso(T0 + HOUR)), /now resolves to/);
  assert.throws(() => submissionFor(record(outside), iso(T0 + HOUR)), /fresh Git worktree|not a git|repository/i);
  assert.throws(() => submissionFor(record("/"), iso(T0 + HOUR)), Error);
  assert.doesNotThrow(() => submissionFor(record(repo), iso(T0 + HOUR)));
});

test("sixty-four schedules due at once: the runner's queue bound holds, the overflow is reported as refused, and every slot is accounted for", async () => {
  // Guards: MAX_SCHEDULES, MAX_QUEUED_JOBS (BG-1) reached through the engine, and the refusal being recorded.
  const repo = fs.realpathSync(makeRepo({ "README.md": "x\n" }));
  temp.push(repo);
  setWorkspaceTrusted(repo, true);
  const b = bench(repo);
  const clock = { ms: T0 };
  try {
    const runner = b.runner({ now: () => new Date(clock.ms), schedules: { scanMs: 0 }, maxJobs: 1 });
    fs.mkdirSync(b.paths.root, { recursive: true, mode: 0o700 });
    runner.start();
    const paths = schedulePaths(b.paths);
    ensureScheduleDir(paths);
    for (let i = 0; i < 70; i++) writeSchedule(paths, record(repo, { id: `s${String(i).padStart(2, "0")}` }));
    clock.ms = T0 + HOUR + 1_000;
    runner.tick();
    const jobs = listJobs(b.paths).jobs;
    assert.ok(jobs.length <= 32, `${jobs.length} jobs queued at most 32`);
    const states = Array.from({ length: 64 }, (_, i) => readSchedule(paths, `s${String(i).padStart(2, "0")}`)!.state);
    assert.equal(states.filter((s) => s.lastFire).length, jobs.length);
    assert.equal(states.filter((s) => s.lastOutcome === "REFUSED").length, 64 - jobs.length, "every slot that did not start says why");
    assert.ok(states.filter((s) => s.lastOutcome === "REFUSED").every((s) => /queue is full/.test(s.missed[0].detail ?? "")));
    assert.equal(b.log.filter((line) => /schedule s6[4-9] is not valid/.test(line)).length, 6, "the six beyond the cap are reported, not run");
    assert.ok(fs.existsSync(paths.record("s69")));
    assert.equal(JSON.parse(fs.readFileSync(paths.record("s69"), "utf8")).state.lastFire, undefined, "the 70th was never run");
  } finally {
    await b.cleanup();
  }
});

test("a hand-edited verifier is held to the command checks when the schedule fires: a tripwire command or one your rules forbid never runs", async () => {
  // Guard: verifierProblem in buildJobSubmission, reached through submissionFor at every fire.
  const repo = fs.realpathSync(makeRepo({ "README.md": "x\n" }));
  temp.push(repo);
  for (const verifier of ["rm -rf /", "sudo rm -rf /"]) {
    assert.throws(() => submissionFor(record(repo, { policy: "worktree-write", verifier }), iso(T0 + HOUR)), /refused by the security policy/, verifier);
  }
  fs.mkdirSync(path.join(home, ".config", "nexus"), { recursive: true });
  const rules = path.join(home, ".config", "nexus", "command_rules.json");
  fs.writeFileSync(rules, JSON.stringify({ version: 1, rules: [{ prefix: ["make", "deploy"], decision: "forbidden", justification: "never from automation" }] }), { mode: 0o600 });
  try {
    assert.throws(() => submissionFor(record(repo, { policy: "worktree-write", verifier: "make deploy" }), iso(T0 + HOUR)), /forbidden by your command rules/);
    assert.doesNotThrow(() => submissionFor(record(repo, { policy: "worktree-write", verifier: "make test" }), iso(T0 + HOUR)));
  } finally { fs.rmSync(rules, { force: true }); }
  // And a record whose verifier is several lines is not even a record.
  assert.throws(() => parseScheduleRecord({ ...JSON.parse(JSON.stringify(record(repo))), verifier: "node --test\nrm -rf x" }), /verifier is not valid/);
});

test("the runner's state directory (inbox, jobs, schedules, lock files) is a protected path for the agent's file tools, under any NEXUS_STATE_DIR", async () => {
  // Guard: the runner root pattern in the security policy and the absolute-directory rule of isPathProtected.
  const repo = fs.realpathSync(makeRepo({ "a.txt": "hello\n" }));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sched-hostile-agent2-"));
  temp.push(repo, stateDir);
  const saved = process.env.NEXUS_STATE_DIR;
  process.env.NEXUS_STATE_DIR = path.join(repo, "state");
  try {
    const root = path.join(repo, "state", "runner");
    const agent = hookAgent({ repo, stateDir, mode: "auto", fullAccess: true });
    agents.push(agent);
    for (const target of ["inbox/req-0123456789abcdef.json", "jobs/job-0123456789ab/job.json", "jobs/job-0123456789ab/receipt.json", "runner.json", "runner.guard"]) {
      for (const where of [path.join("state", "runner", target), path.join(root, target)]) {
        const receipt = await dispatch(agent, "write_file", { path: where, content: "{}" });
        assert.equal(receipt.success, false, where);
        assert.match(JSON.stringify(receipt), /Security Policy Violation|protected/i, where);
      }
    }
    assert.equal(fs.existsSync(path.join(root, "inbox")), false, "nothing was written");
    const ok = await dispatch(agent, "write_file", { path: "state/other.txt", content: "fine\n" });
    assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 200));
  } finally {
    if (saved === undefined) delete process.env.NEXUS_STATE_DIR; else process.env.NEXUS_STATE_DIR = saved;
  }
});
