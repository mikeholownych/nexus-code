/**
 * DV-3 at the agent layer: completion is refused while an operator-authorised obligation is unmet, and an edit that
 * removes the obligated test is recorded on the ledger whether it comes through a file tool or the shell.
 */
import "./helpers/leak_guard.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, Reply } from "./helpers/fixtures.js";
import { createLedger, recordAttempt, type ObjectiveLedger } from "../src/core/objective.js";
import { authoriseObligation } from "../src/core/regression_obligations.js";

const quiet = (agent: AutonomousAgent) => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (endpoint: string, workspace: string): HarnessConfig => ({
  endpoint, model: "m", maxSteps: 30, temperature: 0, workspace, shell: "bash", approvalMode: "auto", fullAccess: true,
  continuation: { ...DEFAULT_CONTINUATION },
});
const script = (...replies: Reply[]) => (n: number): Reply => replies[n - 1] ?? { kind: "text", content: "stopping" };
const call = (name: string, args: unknown): Reply => ({ kind: "tools", calls: [{ name, args }] });
const done = call("task_completed", { summary: "done" });

const TEST_NAME = "adds numbers";
const TEST_PATH = "test/adds.test.js";
const TEST_BODY = `const t = require("node:test");\nconst assert = require("node:assert");\nt("${TEST_NAME}", () => { assert.equal(1 + 1, 2); });\n`;
const MAKEFILE = ".PHONY: test\ntest:\n\t@echo 'ok 1 - adds numbers'\n\t@echo 'ℹ tests 1'\n";
const COMMAND = "make test";

/** A ledger holding one authorised obligation on a test that failed once under COMMAND. */
function ledgerWithObligation(): ObjectiveLedger {
  const ledger = createLedger("fix it");
  const a = recordAttempt(ledger, { command: COMMAND, inputs: "c0", status: "FAILED", classification: "CANDIDATE_FAILED", exitCode: 1, failingTests: [TEST_NAME], failedCheck: TEST_NAME });
  assert.equal(authoriseObligation(ledger, { authority: "operator", attempt: a.n, testName: TEST_NAME }).ok, true);
  return ledger;
}

async function withAgent(files: Record<string, string>, replies: Reply[], seed: ObjectiveLedger | undefined, fn: (agent: AutonomousAgent, repo: string, requests: number) => Promise<void>) {
  const repo = makeRepo(files);
  const gw = await startGateway(script(...replies));
  const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
  try {
    if (seed) (agent as any).objective = JSON.parse(JSON.stringify(seed));
    await fn(agent, repo, gw.requests.length);
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

const completions = (agent: AutonomousAgent) => (agent as any).messages.filter((m: any) => m.role === "tool" && m.name === "task_completed");

describe("DV-3 completion is refused while an authorised obligation is unmet", () => {
  test("task_completed names the obligation and the command that replays it", { timeout: 90_000 }, async () => {
    await withAgent({ Makefile: MAKEFILE, [TEST_PATH]: TEST_BODY }, [done, { kind: "text", content: "stopping" }], ledgerWithObligation(), async (agent) => {
      await agent.runTurn("continue");
      const first = completions(agent)[0];
      assert.ok(first, "task_completed was dispatched");
      assert.match(first.content, /RO1/);
      assert.match(first.content, /adds numbers/);
      assert.match(first.content, /make test/);
      assert.doesNotMatch(first.content, /"status":"completed"/);
    });
  });

  test("a recorded passing replay lets completion proceed", { timeout: 90_000 }, async () => {
    await withAgent({ Makefile: MAKEFILE, [TEST_PATH]: TEST_BODY }, [call("run_tests", {}), done], ledgerWithObligation(), async (agent) => {
      await agent.runTurn("continue");
      const ob = agent.getObjective()!.obligations![0];
      assert.equal(ob.replays.at(-1)?.outcome, "pass", "the run_tests verifier replayed the exact named test");
      assert.match(completions(agent).at(-1).content, /"status":"completed"/);
    });
  });

  test("a green suite that does not report the obligated test cannot complete", { timeout: 90_000 }, async () => {
    const unrelated = ".PHONY: test\ntest:\n\t@echo 'ok 1 - unrelated test'\n\t@echo 'ℹ tests 1'\n";
    await withAgent({ Makefile: unrelated, [TEST_PATH]: TEST_BODY }, [call("run_tests", {}), done], ledgerWithObligation(), async (agent) => {
      await agent.runTurn("continue");
      const obligation = agent.getObjective()!.obligations![0];
      assert.equal(obligation.replays.at(-1)?.outcome, "unobserved");
      assert.match(completions(agent).at(-1).content, /did not show this test executing/);
      assert.doesNotMatch(completions(agent).at(-1).content, /"status":"completed"/);
    });
  });

  test("a run with no obligations completes exactly as before", { timeout: 90_000 }, async () => {
    await withAgent({ Makefile: MAKEFILE }, [call("write_file", { path: "a.txt", content: "a\n" }), done], undefined, async (agent) => {
      await agent.runTurn("Do it.");
      assert.match(completions(agent).at(-1).content, /"status":"completed"/);
      assert.equal(agent.getObjective()?.obligations, undefined);
    });
  });
});

describe("DV-3 weakening edits are recorded by the dispatch hook", () => {
  test("a file-tool edit that removes the obligated test is recorded", { timeout: 90_000 }, async () => {
    await withAgent({ Makefile: MAKEFILE, [TEST_PATH]: TEST_BODY }, [call("write_file", { path: TEST_PATH, content: "// emptied\n", overwrite: true })], ledgerWithObligation(), async (agent) => {
      await agent.runTurn("continue");
      const w = agent.getObjective()!.obligations![0].weakenings;
      assert.equal(w.length, 1);
      assert.equal(w[0].kind, "removed");
      assert.equal(w[0].path, TEST_PATH);
    });
  });

  test("an edit that keeps the obligated test records nothing", { timeout: 90_000 }, async () => {
    await withAgent({ Makefile: MAKEFILE, [TEST_PATH]: TEST_BODY }, [call("write_file", { path: TEST_PATH, content: `${TEST_BODY}// more\n`, overwrite: true })], ledgerWithObligation(), async (agent) => {
      await agent.runTurn("continue");
      assert.deepEqual(agent.getObjective()!.obligations![0].weakenings, []);
    });
  });

  test("a shell command that deletes the obligated test is recorded", { timeout: 90_000 }, async () => {
    await withAgent({ Makefile: MAKEFILE, [TEST_PATH]: TEST_BODY }, [call("run_command", { command: `rm ${TEST_PATH}` })], ledgerWithObligation(), async (agent, repo) => {
      await agent.runTurn("continue");
      assert.equal(fs.existsSync(path.join(repo, TEST_PATH)), false, "the shell command ran");
      const w = agent.getObjective()!.obligations![0].weakenings;
      assert.equal(w.length, 1);
      assert.equal(w[0].kind, "removed");
      assert.equal(w[0].path, TEST_PATH);
    });
  });

  test("a shell command that skips the obligated test is recorded", { timeout: 90_000 }, async () => {
    await withAgent({ Makefile: MAKEFILE, [TEST_PATH]: TEST_BODY }, [call("run_command", { command: `sed -i 's/^t(/t.skip(/' ${TEST_PATH}` })], ledgerWithObligation(), async (agent) => {
      await agent.runTurn("continue");
      const w = agent.getObjective()!.obligations![0].weakenings;
      assert.equal(w.length, 1);
      assert.equal(w[0].kind, "skipped");
    });
  });

  test("a shell command that changes nothing the obligation names records nothing", { timeout: 90_000 }, async () => {
    await withAgent({ Makefile: MAKEFILE, [TEST_PATH]: TEST_BODY }, [call("run_command", { command: "echo hi > note.txt" })], ledgerWithObligation(), async (agent, repo) => {
      await agent.runTurn("continue");
      assert.equal(fs.existsSync(path.join(repo, "note.txt")), true);
      assert.deepEqual(agent.getObjective()!.obligations![0].weakenings, []);
    });
  });
});
