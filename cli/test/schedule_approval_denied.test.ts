/**
 * BG-2 acceptance (b): "an unattended run asking for approval is denied, not blocked forever". Two real schedules in a
 * real runner. The first one's scripted model asks for a network fetch and for the same un-allowed command twice: every
 * call is denied (nothing is remembered between the two commands, so there is no allow-always), the job ends BLOCKED
 * with the question recorded in its receipt, no worker is left waiting, and the runner goes on to fire the second
 * schedule, which completes.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readReceipt } from "../src/core/job_runner.js";
import { sameProcess } from "../src/core/process_identity.js";
import { isSandboxAvailable } from "../src/sandbox.js";
import { makeRepo, startGateway } from "./helpers/fixtures.js";
import { runnerWorld } from "./helpers/runner_fixture.js";
import { addSchedule, firstJobOf, reseed, trustRepo } from "./helpers/schedule_fixture.js";

test("a scheduled run that asks for approval is denied and ends BLOCKED, never left waiting, and the runner keeps firing other schedules", { timeout: 290_000, skip: isSandboxAvailable("auto") ? false : "worktree-write needs a sandbox engine" }, async () => {
  const world = runnerWorld();
  const repo = fs.realpathSync(makeRepo({ "README.md": "hello\n" }));
  const command = { name: "run_command", args: { command: "touch ran.txt" } };
  // One gateway for both schedules; the first request belongs to the first schedule's job (it fires first, alone: one job at a time).
  const gw = await startGateway((n) =>
    n === 1
      ? { kind: "tools", calls: [{ name: "fetch_web", args: { url: "https://example.test/" } }, command, command] }
      : { kind: "tools", calls: [{ name: "task_completed", args: { summary: "nothing could be run; reporting that" } }] },
  );
  try {
    await trustRepo(world, repo);
    await addSchedule(world, repo, "Fetch https://example.test/ and run touch ran.txt.", "--name", "asks", "--every", "5m", "--allow-worktree-write", "-e", gw.url, "-m", "m");
    await addSchedule(world, repo, "Say that you are alive.", "--name", "other", "--every", "5m", "-e", gw.url, "-m", "m");
    await world.startRunner();
    reseed(world, "asks", 4);
    const asks = await firstJobOf(world, "asks");
    const ended = await world.waitJob(asks.id, ["BLOCKED", "COMPLETE", "FAILED", "CANCELLED", "TIMED_OUT"], 240_000);
    const receipt = readReceipt(world.paths, asks.id)!;
    assert.equal(ended.state, "BLOCKED", JSON.stringify(receipt));
    assert.equal(receipt.schedule_id, "asks");
    assert.equal(receipt.approval_mode, "review", "write inside the fresh worktree only; never auto");
    assert.equal(receipt.unattended, true);
    assert.match(receipt.summary, /^BLOCKED: unit 'task'/);
    assert.equal(receipt.pending_decisions.length, 1, "the question is recorded for the operator");
    assert.equal(receipt.units[0].status, "BLOCKED");

    // Every call was denied at once: the model was told no operator is present, three times over.
    const results = ((gw.requests[1] as any).messages as any[]).filter((message) => message.role === "tool").map((message) => String(message.content));
    assert.equal(results.length, 3);
    for (const result of results) assert.match(result, /requires operator approval \((exec|egress|network)[a-z_]*\), but no operator is present/);
    const events = fs.readFileSync(world.paths.events(asks.id), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const tools = events.filter((event) => event.type === "TOOL_END" && event.tool !== "task_completed");
    assert.deepEqual(tools.map((event) => [event.tool, event.success]), [["fetch_web", false], ["run_command", false], ["run_command", false]]);
    assert.deepEqual(fs.readdirSync(path.join(repo, ".nexus", "worktrees"), { recursive: true }).filter((name) => String(name).endsWith("ran.txt")), [], "the command never ran");

    // Not blocked forever: the job ended by itself, and its worker is gone.
    assert.equal(sameProcess(ended.attempts[0]), false);
    assert.equal(ended.attempts.length, 1, "denying is not a crash and costs no resume");
    assert.equal(ended.autoResumes, 0);

    // The runner is still serving the schedules: the other one fires and completes.
    reseed(world, "other", 2);
    const other = await firstJobOf(world, "other");
    const done = await world.waitJob(other.id, ["COMPLETE", "BLOCKED", "FAILED", "CANCELLED", "TIMED_OUT"], 240_000);
    assert.equal(done.state, "COMPLETE", JSON.stringify(readReceipt(world.paths, other.id)));
    assert.equal(readReceipt(world.paths, other.id)?.schedule_id, "other");
  } finally {
    await world.cleanup();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
