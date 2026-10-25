import { createHash } from "node:crypto";

const FIXTURE_KINDS = new Set(["hanging_test_command", "full_disk"]);

/** Validate the public task-authored hook used to identify a real fixture command in the agent transcript. */
export function t4FixtureProblems(task) {
  const fixture = task.t4Fixture;
  if (fixture === undefined) return [];
  const problems = [];
  if (task.tier !== "T4" || !fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
    return ["t4Fixture is supported only as an object on a T4 task"];
  }
  if (!FIXTURE_KINDS.has(fixture.kind)) problems.push("t4Fixture.kind must be hanging_test_command or full_disk");
  if (typeof fixture.command !== "string" || fixture.command.trim().length === 0 || fixture.command.length > 4096) {
    problems.push("t4Fixture.command must be a non-empty command of at most 4096 characters");
  }
  if (fixture.kind === "hanging_test_command") {
    if (fixture.tool !== "run_command") problems.push("hanging_test_command requires tool run_command");
    if (!Number.isSafeInteger(fixture.timeoutSecs) || fixture.timeoutSecs < 1 || fixture.timeoutSecs > 600) {
      problems.push("hanging_test_command requires timeoutSecs from 1 to 600");
    }
  }
  if (fixture.kind === "full_disk" && fixture.tool !== "run_command") {
    problems.push("full_disk requires tool run_command");
  }
  if (fixture.kind === "full_disk" && (!Number.isSafeInteger(fixture.storageLimitBytes) || fixture.storageLimitBytes < 1)) {
    problems.push("full_disk requires a positive storageLimitBytes matching the qualification resource contract");
  }
  return problems;
}

/** Derive fixture evidence only from evaluator-only receipts emitted by the Nexus runner. */
export function observeT4Fixture(task, agent, containment, resourceContract) {
  const fixture = task.t4Fixture;
  if (!fixture || t4FixtureProblems(task).length || !Array.isArray(agent?.json?.evaluationToolReceipts)) return [];
  const expectedCommandSha256 = createHash("sha256").update(fixture.command).digest("hex");
  const receipt = agent.json.evaluationToolReceipts.find((value) => value?.tool === fixture.tool
    && value.commandSha256 === expectedCommandSha256 && typeof value.invocationId === "string");
  if (!receipt) return [];
  const clean = containment?.cleaned === true && containment?.survivorsAfterExit === 0;
  if (fixture.kind === "hanging_test_command" && receipt.timedOut === true && receipt.timeoutSecs === fixture.timeoutSecs) {
    return [{ kind: fixture.kind, source: "task_fixture_or_runner", evidence: {
      observedHung: true, timedOut: true, containmentCleaned: clean, tool: fixture.tool,
      commandSha256: expectedCommandSha256, timeoutSecs: fixture.timeoutSecs,
      runnerExitCode: receipt.exitCode,
    } }];
  }
  if (fixture.kind === "full_disk") {
    const limit = Number(resourceContract?.storageBytes);
    const before = receipt.workspaceAvailableBeforeBytes;
    const after = receipt.workspaceAvailableAfterBytes;
    const exhausted = limit === fixture.storageLimitBytes
      && Number.isSafeInteger(before) && Number.isSafeInteger(after)
      && before > 1024 * 1024 && after <= Math.min(1024 * 1024, limit * 0.01)
      && before - after > 1024 * 1024
      && Number.isSafeInteger(receipt.exitCode) && receipt.exitCode !== 0
      && receipt.timedOut === false;
    if (exhausted) return [{ kind: fixture.kind, source: "task_fixture_or_runner", evidence: {
      storageExhausted: true, containmentCleaned: clean, tool: fixture.tool,
      commandSha256: expectedCommandSha256, storageLimitBytes: limit,
      availableBeforeBytes: before, availableAfterBytes: after, runnerExitCode: receipt.exitCode,
    } }];
  }
  return [];
}
