/**
 * CS-9 through the real dispatch path: the operator's rules file in the (throwaway) home decides a run_command's approval,
 * the other controls still apply, and the deciding rule reaches the saved session and its export.
 */
import "./helpers/leak_guard.js";
import { test, beforeEach, afterEach, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutonomousAgent } from "../src/agent.js";
import { DurableStateManager } from "../src/core/state.js";
import { buildSessionExport } from "../src/session_export.js";
import { makeRepo } from "./helpers/fixtures.js";

const RULES = {
  version: 1,
  rules: [
    { prefix: ["git", ["status", "log"]], decision: "allow", justification: "read-only git", match: ["git status", "git log -n 3"], notMatch: ["git push"] },
    { prefix: ["git", "push"], decision: "prompt", justification: "pushes need a human", match: ["git push origin main"] },
    { prefix: ["rm", "-rf"], decision: "forbidden", justification: "never recursive-delete", match: ["rm -rf build"] },
    { prefix: ["touch"], decision: "allow", match: ["touch marker.txt"] },
  ],
};

let home = "", previousHome: string | undefined, repo = "", stateDir = "";
let agents: AutonomousAgent[] = [];

function writeRules(doc: unknown): void {
  fs.mkdirSync(path.join(home, ".config", "nexus"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "nexus", "command_rules.json"), typeof doc === "string" ? doc : JSON.stringify(doc));
}
function makeAgent(opts: { mode?: "review" | "auto" | "read-only"; fullAccess?: boolean } = {}): AutonomousAgent {
  const agent = new AutonomousAgent({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 4, temperature: 0, workspace: repo, shell: "bash", fullAccess: opts.fullAccess } as any);
  (agent as any).stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [(agent as any).primaryWorkspacePathIdentity] });
  if (opts.mode) agent.setApprovalMode(opts.mode);
  agents.push(agent);
  return agent;
}
let seq = 0;
async function run(agent: AutonomousAgent, command: string, onConfirm?: (tool: string, a: any) => Promise<boolean>) {
  const toolCall = { id: `c${++seq}`, type: "function", function: { name: "run_command", arguments: JSON.stringify({ command }) } };
  return (await (agent as any).dispatchToolCall(toolCall, 1, "agent", onConfirm)).receipt;
}
/** An operator that records every question and answers as told. */
function operator(answer: boolean) {
  const asked: string[] = [];
  return { asked, confirm: async (_tool: string, args: any) => { asked.push(String(args?.command ?? "")); return answer; } };
}

beforeEach(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cmdrules-home-"));
  process.env.HOME = home;
  repo = makeRepo({ "a.txt": "hello\n" });
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cmdrules-state-"));
});
afterEach(() => {
  for (const a of agents) a.shutdown();
  agents = [];
  for (const d of [home, repo, stateDir]) fs.rmSync(d, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
});

describe("operator command rules at dispatch", () => {
  test("review mode: `git status` runs without a prompt and `git push` still asks (the CS-9 acceptance)", async () => {
    writeRules(RULES);
    const agent = makeAgent({ mode: "review" });
    const op = operator(false);
    const status = await run(agent, "git status", op.confirm);
    assert.equal(status.status, "COMPLETED", JSON.stringify(status).slice(0, 300));
    assert.deepEqual(op.asked, [], "an allowed command is not put to the operator");
    const push = await run(agent, "git push origin main", op.confirm);
    assert.equal(push.status, "DENIED", "the operator declined");
    assert.deepEqual(op.asked, ["git push origin main"]);
    const other = await run(agent, "echo hi", op.confirm);
    assert.equal(other.status, "DENIED");
    assert.deepEqual(op.asked, ["git push origin main", "echo hi"], "a command no rule covers asks exactly as before");
  });

  test("a rule-allowed chain is allowed only when every part is, and a shell-active one asks as before", async () => {
    writeRules(RULES);
    const agent = makeAgent({ mode: "review" });
    const op = operator(false);
    assert.equal((await run(agent, "git status && git log -n 1", op.confirm)).status, "COMPLETED");
    assert.deepEqual(op.asked, []);
    await run(agent, "git status && echo $(id)", op.confirm);
    await run(agent, "git status; touch marker.txt `id`", op.confirm);
    assert.equal(op.asked.length, 2, "both were put to the operator");
  });

  test("forbidden refuses in every mode, including --yes, and the command never runs", async () => {
    writeRules(RULES);
    fs.mkdirSync(path.join(repo, "build"));
    for (const opts of [{ mode: "review" as const }, { mode: "auto" as const }, { mode: "auto" as const, fullAccess: true }]) {
      const agent = makeAgent(opts);
      const receipt = await run(agent, "rm -rf build", async () => true);
      assert.equal(receipt.status, "DENIED", JSON.stringify(opts));
      assert.equal(receipt.denialReason, "COMMAND_RULE_FORBIDDEN");
      assert.match(receipt.error, /command rule 3 \(forbidden: rm -rf\): never recursive-delete/);
      assert.equal(fs.existsSync(path.join(repo, "build")), true, "build/ is untouched");
    }
  });

  test("a prompt rule asks even in auto mode, but not under --yes", async () => {
    writeRules(RULES);
    const auto = makeAgent({ mode: "auto" });
    const op = operator(false);
    assert.equal((await run(auto, "git push origin main", op.confirm)).status, "DENIED");
    assert.deepEqual(op.asked, ["git push origin main"]);
    const yes = makeAgent({ mode: "auto", fullAccess: true });
    const op2 = operator(false);
    const receipt = await run(yes, "git push origin main", op2.confirm);
    assert.deepEqual(op2.asked, [], "--yes means the operator already accepted prompts");
    assert.notEqual(receipt.denialReason, "COMMAND_RULE_FORBIDDEN");
  });

  test("headless (nobody to ask): an allowed command runs, a prompt-rule command is refused with the usual reason", async () => {
    writeRules(RULES);
    const agent = makeAgent({ mode: "review" });
    assert.equal((await run(agent, "git status")).status, "COMPLETED");
    const push = await run(agent, "git push origin main");
    assert.equal(push.status, "DENIED");
    assert.equal(push.denialReason, "DECISION_REQUIRED_NO_OPERATOR");
  });

  test("an allow rule never overrides read-only mode", async () => {
    writeRules(RULES);
    const agent = makeAgent({ mode: "read-only" });
    const receipt = await run(agent, "touch marker.txt", async () => true);
    assert.equal(receipt.status, "DENIED");
    assert.equal(fs.existsSync(path.join(repo, "marker.txt")), false);
  });

  test("the deciding rule is recorded, saved with the session, and shown in the export (json and markdown)", async () => {
    writeRules(RULES);
    const agent = makeAgent({ mode: "review" });
    const op = operator(true);
    await run(agent, "git status", op.confirm);
    await run(agent, "rm -rf build", op.confirm);
    await run(agent, "echo hi", op.confirm);
    assert.deepEqual(agent.commandRuleDecisions.map((d) => [d.effect, d.rule, d.decision]), [["allowed without prompt", 1, "allow"], ["refused", 3, "forbidden"]],
      "only commands a rule actually changed the outcome for are recorded");
    const state = agent.checkpointDurableState();
    assert.equal(state.commandRuleDecisions?.length, 2);
    const exported = buildSessionExport({} as any, { ...state, id: "s", workspace: repo, model: "m" } as any);
    const recorded = (exported.json.export as any).taskState.commandRuleDecisions;
    assert.equal(recorded[0].prefix, "git (status|log)");
    assert.equal(recorded[0].justification, "read-only git");
    assert.equal(recorded[1].command, "rm -rf build");
    assert.match(exported.markdown, /Operator command rules/);
    assert.match(exported.markdown, /refused: `rm -rf build` by rule 3 \(forbidden `rm -rf`: never recursive-delete\)/);
    assert.match(exported.markdown, /allowed without prompt: `git status` by rule 1/);
  });

  test("a secret in a recorded command is redacted", async () => {
    writeRules({ version: 1, rules: [{ prefix: ["curl"], decision: "forbidden", match: ["curl https://x"] }] });
    const agent = makeAgent({ mode: "auto" });
    await run(agent, "curl -H 'Authorization: Bearer abcdefghij0123456789abcdefghij.klmnopqrst0123456789' https://x");
    assert.equal(agent.commandRuleDecisions.length, 1);
    assert.doesNotMatch(agent.commandRuleDecisions[0].command, /abcdefghij0123456789/);
  });

  test("a rules file that fails to load is ignored whole and the normal policy applies, with one notice", async () => {
    writeRules({ version: 1, rules: [{ prefix: ["git", "status"], decision: "allow", match: ["git push"] }] });
    const notices: string[] = [];
    const agent = makeAgent({ mode: "review" });
    agent.setObserver({ onNotice: (n: string) => notices.push(n) } as any);
    const op = operator(false);
    await run(agent, "git status", op.confirm);
    assert.deepEqual(op.asked, ["git status"], "no rule applied: review mode asked as usual");
    await run(agent, "git log", op.confirm);
    assert.equal(notices.filter((n) => /command_rules/.test(n)).length, 1, "reported once");
    assert.match(notices[0], /rules\[1\]\.match\[0\]: "git push" is decided by no rule/);
    assert.match(notices[0], /rules file was ignored/);
  });

  test("a project file is never read: rules come from the operator home only", async () => {
    fs.mkdirSync(path.join(repo, ".nexus"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".nexus", "command_rules.json"), JSON.stringify({ version: 1, rules: [{ prefix: ["echo"], decision: "allow", match: ["echo hi"] }] }));
    fs.writeFileSync(path.join(repo, "command_rules.json"), JSON.stringify({ version: 1, rules: [{ prefix: ["echo"], decision: "allow", match: ["echo hi"] }] }));
    const agent = makeAgent({ mode: "review" });
    const op = operator(false);
    await run(agent, "echo hi", op.confirm);
    assert.deepEqual(op.asked, ["echo hi"]);
  });

  test("no rules file: behaviour is exactly as before and nothing is recorded", async () => {
    const agent = makeAgent({ mode: "review" });
    const op = operator(false);
    await run(agent, "git status", op.confirm);
    assert.deepEqual(op.asked, ["git status"]);
    assert.deepEqual(agent.commandRuleDecisions, []);
  });
});
