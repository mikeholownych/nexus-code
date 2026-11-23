/**
 * GV-1 enforcement through the real dispatch path: managed command prefixes, the egress allowlist, the approval clamp
 * and its runtime form, each with the policy source beside the decision. The policy is injected: the agent's security
 * manager and approval gate are built over an in-memory policy host, never over the machine's own policy files.
 */
import "./helpers/leak_guard.js";
import { test, beforeEach, afterEach, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutonomousAgent } from "../src/agent.js";
import { ApprovalPolicy } from "../src/core/approval_policy.js";
import { DurableStateManager } from "../src/core/state.js";
import { SecurityManager } from "../src/security.js";
import { makeRepo } from "./helpers/fixtures.js";
import { FAKE_SYSTEM, policyWorld, toml } from "./helpers/policy_enforcement.js";

const TAG = (key: string): string => `[policy: system ${FAKE_SYSTEM} ${key}]`;

let home = "", previousHome: string | undefined, repo = "", stateDir = "";
let agents: AutonomousAgent[] = [];
let notices: string[] = [];

/** An agent whose security manager and approval gate see `system` as the system policy (none when undefined). */
function makeAgent(system: string | undefined, config: { mode?: "review" | "auto" | "read-only"; fullAccess?: boolean; approvalMode?: string } = {}): AutonomousAgent {
  const agent = new AutonomousAgent({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 4, temperature: 0, workspace: repo, shell: "bash", fullAccess: config.fullAccess, approvalMode: config.approvalMode } as any);
  (agent as any).stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [(agent as any).primaryWorkspacePathIdentity] });
  const world = policyWorld(system === undefined ? {} : { system });
  (agent as any).bridge.securityManager = new SecurityManager(repo, { policyFor: (workspace) => world.load(workspace), notify: (notice) => notices.push(notice) });
  agent.setApprovalPolicy(new ApprovalPolicy(() => world.host.managed().effective));
  // Only what a policy says: the fixture's own durability notices are not the subject.
  agent.setObserver({ onNotice: (notice: string) => { if (!/crash recovery degraded/.test(notice)) notices.push(notice); } } as any);
  if (config.mode) agent.setApprovalMode(config.mode);
  agents.push(agent);
  return agent;
}
let seq = 0;
type Confirm = (tool: string, args: any, signal?: unknown, options?: { requireOperatorDecision?: boolean }) => Promise<boolean>;
async function call(agent: AutonomousAgent, name: string, args: Record<string, unknown>, onConfirm?: Confirm) {
  const toolCall = { id: `c${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
  return (await (agent as any).dispatchToolCall(toolCall, 1, "agent", onConfirm)).receipt;
}
const run = (agent: AutonomousAgent, command: string, onConfirm?: Confirm) => call(agent, "run_command", { command }, onConfirm);
/** An operator that records every question (and whether the front end was told it must ask) and answers as told. */
function operator(answer: boolean) {
  const asked: string[] = [];
  const mustDecide: boolean[] = [];
  const confirm: Confirm = async (_tool, args, _signal, options) => {
    asked.push(String(args?.command ?? args?.url ?? ""));
    mustDecide.push(Boolean(options?.requireOperatorDecision));
    return answer;
  };
  return { asked, mustDecide, confirm };
}

beforeEach(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gv1-dispatch-home-"));
  process.env.HOME = home;
  repo = makeRepo({ "a.txt": "hello\n" });
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gv1-dispatch-state-"));
  notices = [];
});
afterEach(() => {
  for (const a of agents) a.shutdown();
  agents = [];
  for (const d of [home, repo, stateDir]) fs.rmSync(d, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
});

describe("managed command prefixes at dispatch", () => {
  const POLICY = toml("[commands]", 'forbid = ["touch forbidden.txt"]', 'prompt = ["touch asked.txt"]');

  test("a managed forbid refuses in every mode, full access included, and names the policy", async () => {
    const agent = makeAgent(POLICY, { mode: "auto", fullAccess: true });
    const op = operator(true);
    const receipt = await run(agent, "true && touch forbidden.txt", op.confirm);
    assert.equal(receipt.status, "DENIED");
    assert.equal(receipt.denialReason, "MANAGED_POLICY_FORBIDDEN");
    assert.equal(receipt.error, `Error: command refused: managed policy forbids 'touch forbidden.txt'. ${TAG("commands.forbid")} It is not run in any mode. Do the work another way, or report what you could not do.`);
    assert.deepEqual(op.asked, [], "a refusal is not put to the operator");
    assert.equal(fs.existsSync(path.join(repo, "forbidden.txt")), false);
  });

  test("a managed prompt asks under full access; the operator's answer decides", async () => {
    const agent = makeAgent(POLICY, { mode: "auto", fullAccess: true });
    const yes = operator(true);
    const approved = await run(agent, "touch asked.txt", yes.confirm);
    assert.equal(approved.status, "COMPLETED", JSON.stringify(approved).slice(0, 300));
    assert.deepEqual(yes.asked, ["touch asked.txt"]);
    assert.deepEqual(yes.mustDecide, [true], "a front end's own approve-everything state may not answer");
    assert.ok(fs.existsSync(path.join(repo, "asked.txt")));

    fs.rmSync(path.join(repo, "asked.txt"));
    const no = operator(false);
    const declined = await run(agent, "touch asked.txt", no.confirm);
    assert.equal(declined.status, "DENIED");
    assert.equal(fs.existsSync(path.join(repo, "asked.txt")), false);

    const other = operator(false);
    assert.equal((await run(agent, "touch other.txt", other.confirm)).status, "COMPLETED");
    assert.deepEqual(other.asked, [], "full access still skips the prompt for a command no managed rule names");
  });

  test("a managed prompt with nobody to ask refuses, with the policy source in the refusal", async () => {
    const agent = makeAgent(POLICY, { mode: "auto", fullAccess: true });
    const receipt = await run(agent, "touch asked.txt");
    assert.equal(receipt.status, "DENIED");
    assert.equal(receipt.denialReason, "DECISION_REQUIRED_NO_OPERATOR");
    assert.match(receipt.error, /requires operator approval \(exec\), but no operator is present \(headless execution\)\. approval required: managed policy asks before 'touch asked\.txt', also under full access\. \[policy: system \/fake\/etc\/nexus\/policy\.toml commands\.prompt\]/);
    assert.doesNotMatch(receipt.error, /Run with --yes/);
    assert.equal(fs.existsSync(path.join(repo, "asked.txt")), false);
  });

  test("with no policy the same commands are decided exactly as before", async () => {
    const agent = makeAgent(undefined, { mode: "auto", fullAccess: true });
    const op = operator(false);
    assert.equal((await run(agent, "touch asked.txt", op.confirm)).status, "COMPLETED");
    assert.equal((await run(agent, "touch forbidden.txt", op.confirm)).status, "COMPLETED");
    assert.deepEqual(op.asked, []);
    assert.deepEqual(notices, []);
  });

  test("commands.disable_allow_rules: the operator's allow rule no longer removes the prompt; its forbidden rule still refuses", async () => {
    fs.mkdirSync(path.join(home, ".config", "nexus"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "nexus", "command_rules.json"), JSON.stringify({ version: 1, rules: [
      { prefix: ["git", "status"], decision: "allow", match: ["git status"] },
      { prefix: ["rm", "-rf"], decision: "forbidden", match: ["rm -rf build"] },
    ] }));
    const plain = makeAgent(undefined, { mode: "review" });
    const before = operator(false);
    assert.equal((await run(plain, "git status", before.confirm)).status, "COMPLETED");
    assert.deepEqual(before.asked, []);

    const agent = makeAgent(toml("[commands]", "disable_allow_rules = true"), { mode: "review" });
    const op = operator(false);
    assert.equal((await run(agent, "git status", op.confirm)).status, "DENIED");
    assert.deepEqual(op.asked, ["git status"]);
    assert.deepEqual(agent.commandRuleDecisions, [], "an allow rule that is not used decides nothing");
    assert.equal((await run(agent, "rm -rf build", op.confirm)).denialReason, "COMMAND_RULE_FORBIDDEN");
  });

  test("an operator rules file that does not load says its forbidden and prompt rules are not enforced", async () => {
    fs.mkdirSync(path.join(home, ".config", "nexus"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "nexus", "command_rules.json"), "{ not json");
    const agent = makeAgent(undefined, { mode: "review" });
    await run(agent, "echo hi", operator(false).confirm);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /^\[nexus\] command_rules: .*is not valid JSON\. The rules file was ignored; the normal approval policy applies\. Its forbidden and prompt rules are NOT enforced until the file is fixed\.$/);
  });
});

describe("the approval clamp at dispatch", () => {
  test("approval.strict: an agent configured for auto and full access still asks, and the front end must put the question", async () => {
    const agent = makeAgent(toml("[approval]", "strict = true"), { approvalMode: "auto", fullAccess: true });
    const op = operator(false);
    const receipt = await run(agent, "touch x.txt", op.confirm);
    assert.equal(receipt.status, "DENIED");
    assert.deepEqual(op.asked, ["touch x.txt"]);
    assert.deepEqual(op.mustDecide, [true]);
    assert.equal(fs.existsSync(path.join(repo, "x.txt")), false);

    const headless = await run(agent, "touch x.txt");
    assert.equal(headless.denialReason, "DECISION_REQUIRED_NO_OPERATOR");
    assert.match(headless.error, /no operator is present \(headless execution\)\. Managed policy disables automatic approvals here\. \[policy: system \/fake\/etc\/nexus\/policy\.toml approval\.strict\]/);
  });

  test("a runtime switch to auto is ignored with a notice naming the source; the mode stays and the next call asks", async () => {
    const agent = makeAgent(toml("[approval]", "disable_auto = true"), { mode: "review" });
    agent.setApprovalMode("auto");
    assert.equal(agent.getApprovalMode(), "review");
    assert.deepEqual(notices, [`[nexus] A request for approval mode 'auto' is ignored: managed policy disables approval mode 'auto'; the mode stays 'review'. ${TAG("approval.disable_auto")}`]);
    const op = operator(true);
    assert.equal((await run(agent, "touch y.txt", op.confirm)).status, "COMPLETED", "the one call the operator approved runs");
    assert.equal((await run(agent, "touch z.txt", op.confirm)).status, "COMPLETED");
    assert.deepEqual(op.asked, ["touch y.txt", "touch z.txt"], "every call is asked again");
    assert.deepEqual(op.mustDecide, [true, true]);

    agent.setApprovalMode("read-only");
    assert.equal(agent.getApprovalMode(), "read-only", "a stricter mode is always available");
    agent.setApprovalMode("review");
    assert.equal(agent.getApprovalMode(), "review");
  });

  test("with no policy a runtime switch to auto works as before", async () => {
    const agent = makeAgent(undefined, { mode: "review" });
    agent.setApprovalMode("auto");
    assert.equal(agent.getApprovalMode(), "auto");
    const op = operator(false);
    assert.equal((await run(agent, "touch y.txt", op.confirm)).status, "COMPLETED");
    assert.deepEqual(op.asked, []);
    assert.deepEqual(notices, []);
  });

  test("a refusal decided by the default approval mode says so", async () => {
    const agent = makeAgent(undefined, { mode: "review" });
    const receipt = await run(agent, "touch y.txt");
    assert.match(receipt.error, /Run with --yes or --mode auto to explicitly select automatic approvals\. \[policy: default\]/);
  });

  test("approval.require_human: the named effect asks under full access", async () => {
    const agent = makeAgent(toml("[approval]", 'require_human = ["write_workspace"]'), { mode: "auto", fullAccess: true });
    const op = operator(false);
    const receipt = await call(agent, "write_file", { path: "n.txt", content: "x" }, op.confirm);
    assert.equal(receipt.status, "DENIED");
    assert.equal(op.asked.length, 1);
    assert.equal((await run(agent, "touch free.txt", op.confirm)).status, "COMPLETED", "an effect the policy does not name is not asked");
    assert.equal(op.asked.length, 1);
  });
});

describe("the managed egress allowlist at dispatch", () => {
  const POLICY = toml("[egress]", 'allowed_domains = ["example.com", "*.example.org"]');

  test("a destination that is not on the list is refused before anything is sent, with the policy source", async () => {
    const agent = makeAgent(POLICY, { mode: "auto", fullAccess: true });
    const receipt = await call(agent, "fetch_web", { url: "http://127.0.0.1:9/x" });
    assert.equal(receipt.status, "DENIED");
    assert.equal(receipt.denialReason, "MANAGED_POLICY_EGRESS");
    assert.equal(receipt.error, `Error: '127.0.0.1' is not reachable: it is not in the managed allowlist (egress.allowed_domains). ${TAG("egress.allowed_domains")}`);
    const unreadable = await call(agent, "fetch_web", { url: "example.com/path" });
    assert.equal(unreadable.denialReason, "MANAGED_POLICY_EGRESS");
    assert.match(unreadable.error, /is not a URL whose host can be checked against the managed allowlist/);
  });

  test("a listed destination passes the policy and reaches the ordinary approval", async () => {
    const agent = makeAgent(POLICY, { mode: "review" });
    const op = operator(false);
    for (const url of ["https://example.com/a", "https://api.example.org/b"]) {
      const receipt = await call(agent, "fetch_web", { url }, op.confirm);
      assert.equal(receipt.status, "DENIED");
      assert.notEqual(receipt.denialReason, "MANAGED_POLICY_EGRESS");
    }
    assert.deepEqual(op.asked, ["https://example.com/a", "https://api.example.org/b"]);
  });

  test("with no managed list a destination is decided as before", async () => {
    const agent = makeAgent(undefined, { mode: "review" });
    const op = operator(false);
    const receipt = await call(agent, "fetch_web", { url: "http://127.0.0.1:9/x" }, op.confirm);
    assert.notEqual(receipt.denialReason, "MANAGED_POLICY_EGRESS");
    assert.deepEqual(op.asked, ["http://127.0.0.1:9/x"]);
  });
});
