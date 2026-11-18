import "./helpers/leak_guard.js";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AutonomousAgent } from "../src/agent.js";
import { DurableStateManager } from "../src/core/state.js";
import { RustCoreBridge } from "../src/tools.js";
import { buildNeedsInput, needsInputId, parseAnswers, answerNote } from "../src/core/needs_input.js";
import { assertTurnResultInvariants, exitCodeForTurn } from "../src/core/turn.js";
import { startGateway, Reply } from "./helpers/fixtures.js";

// VC-9: a headless run that needs a decision ends BLOCKED / NEEDS_INPUT with a machine-readable question and resumes with an answer.

let repo: string;
let stateDir: string;
let home: string;
let previousHome: string | undefined;
const agents: AutonomousAgent[] = [];
const bridges: RustCoreBridge[] = [];

function makeAgent(endpoint = "http://127.0.0.1:9/v1", mode: "review" | "auto" = "review"): AutonomousAgent {
  const agent = new AutonomousAgent({ endpoint, model: "m", maxSteps: 8, temperature: 0, workspace: repo, shell: "bash" } as any);
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  const a = agent as any;
  a.stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [a.primaryWorkspacePathIdentity] });
  agent.setApprovalMode(mode);
  agents.push(agent);
  return agent;
}
let seq = 0;
const call = async (agent: AutonomousAgent, name: string, args: Record<string, unknown>) =>
  (await (agent as any).dispatchToolCall({ id: `c${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } }, 1, "agent")).receipt;
const pending = (agent: AutonomousAgent) => (agent as any).pendingNeedsInput;

beforeEach(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vc9-home-"));
  process.env.HOME = home;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vc9-repo-"));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vc9-state-"));
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  fs.writeFileSync(path.join(repo, "Makefile"), "test:\n\ttrue\n");
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: repo, stdio: "ignore" });
});
afterEach(() => {
  for (const a of agents.splice(0)) a.shutdown();
  for (const b of bridges.splice(0)) b.shutdown();
  for (const d of [repo, stateDir, home]) fs.rmSync(d, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

describe("VC-9: the question and its answers", () => {
  test("the id binds the decision; answers parse strictly", () => {
    const a = buildNeedsInput("tool_approval", "p", { tool: "write_file" }, "write_file", '{"path":"a"}');
    assert.match(a.id, /^[0-9a-f]{12}$/);
    assert.equal(a.id, needsInputId("tool_approval", "write_file", '{"path":"a"}'));
    assert.notEqual(a.id, needsInputId("tool_approval", "write_file", '{"path":"b"}'));
    assert.notEqual(a.id, needsInputId("verification_edit", "write_file", '{"path":"a"}'));
    assert.deepEqual(a.options.map((o) => o.id), ["approve", "decline"]);
    assert.deepEqual([...parseAnswers([`${a.id}=approve`, "0123456789ab=decline"])], [[a.id, "approve"], ["0123456789ab", "decline"]]);
    for (const bad of ["nope", `${a.id}=maybe`, "short=approve", `${a.id}`]) assert.throws(() => parseAnswers([bad]), /--answer expects/);
    assert.match(answerNote(parseAnswers([`${a.id}=approve`])), /APPROVED/);
    assert.match(answerNote(parseAnswers([`${a.id}=decline`])), /DECLINED/);
  });

  test("a NEEDS_INPUT turn must be BLOCKED, NOT_ESTABLISHED and carry the question", () => {
    const q = buildNeedsInput("tool_approval", "p", {}, "x");
    const base: any = { acceptance: "NOT_REQUESTED", modelStop: "NONE", finalOutputComplete: false, verification: null, interruption: null, inferenceFailure: null, steps: { used: 1, max: 8, limitReached: false }, unverifiedChangesPending: false, finishedAt: "t" };
    assert.throws(() => assertTurnResultInvariants({ ...base, execution: "BLOCKED", outcome: "NOT_ESTABLISHED", reason: "NEEDS_INPUT" }), /NEEDS_INPUT/);
    assert.throws(() => assertTurnResultInvariants({ ...base, execution: "COMPLETED", outcome: "NOT_REQUIRED", reason: "NEEDS_INPUT", needsInput: q }), /NEEDS_INPUT/);
    const ok = assertTurnResultInvariants({ ...base, execution: "BLOCKED", outcome: "NOT_ESTABLISHED", reason: "NEEDS_INPUT", needsInput: q });
    assert.equal(exitCodeForTurn(ok), 1);
  });
});

describe("VC-9: headless approvals end BLOCKED and resume with an answer", () => {
  test("a tool that needs approval records a question, with the call and its effect; nothing runs", async () => {
    const agent = makeAgent();
    const receipt = await call(agent, "write_file", { path: "a.txt", content: "x" });
    assert.equal(receipt.status, "DENIED");
    assert.equal(receipt.denialReason, "DECISION_REQUIRED_NO_OPERATOR");
    const q = pending(agent);
    assert.equal(q.kind, "tool_approval");
    assert.equal(q.subject.tool, "write_file");
    assert.equal(q.subject.effect, "write_workspace");
    assert.match(receipt.error, new RegExp(`needs_input ${q.id}`));
    assert.equal(fs.existsSync(path.join(repo, "a.txt")), false);
  });

  test("approve covers that exact call only; a different argument asks again with another id", async () => {
    const agent = makeAgent();
    await call(agent, "write_file", { path: "a.txt", content: "x" });
    const first = pending(agent);
    (agent as any).pendingNeedsInput = undefined;
    agent.setOperatorAnswers(parseAnswers([`${first.id}=approve`]));
    const other = await call(agent, "write_file", { path: "a.txt", content: "DIFFERENT" });
    assert.equal(other.denialReason, "DECISION_REQUIRED_NO_OPERATOR");
    assert.notEqual(pending(agent).id, first.id);
    (agent as any).pendingNeedsInput = undefined;
    const approved = await call(agent, "write_file", { path: "a.txt", content: "x" });
    assert.notEqual(approved.status, "DENIED", "the approved call passes the approval gate");
    assert.equal(pending(agent), undefined);
  });

  test("decline refuses without asking again and records no question", async () => {
    const agent = makeAgent();
    await call(agent, "write_file", { path: "a.txt", content: "x" });
    const q = pending(agent);
    (agent as any).pendingNeedsInput = undefined;
    agent.setOperatorAnswers(parseAnswers([`${q.id}=decline`]));
    const receipt = await call(agent, "write_file", { path: "a.txt", content: "x" });
    assert.equal(receipt.status, "DENIED");
    assert.match(receipt.error, /declined/);
    assert.equal(pending(agent), undefined);
    assert.equal(fs.existsSync(path.join(repo, "a.txt")), false);
  });

  test("an egress decision is a question too", async () => {
    const agent = makeAgent();
    const receipt = await call(agent, "fetch_web", { url: "https://example.invalid" });
    assert.equal(receipt.denialReason, "DECISION_REQUIRED_NO_OPERATOR");
    assert.equal(pending(agent).kind, "tool_approval");
    assert.equal(pending(agent).subject.effect, "egress");
  });

  test("a verification-file edit that needs a decision records a question; approval is for that path; policy mode block is not a question", async () => {
    const agent = makeAgent(undefined, "auto");
    const receipt = await call(agent, "write_file", { path: "Makefile", content: "test:\n\tfalse\n" });
    assert.equal(receipt.denialReason, "VERIFICATION_CONFIG_PROTECTED");
    const q = pending(agent);
    assert.equal(q.kind, "verification_edit");
    assert.equal(q.subject.path, "Makefile");
    assert.equal(fs.readFileSync(path.join(repo, "Makefile"), "utf8"), "test:\n\ttrue\n");
    (agent as any).pendingNeedsInput = undefined;
    agent.setOperatorAnswers(parseAnswers([`${q.id}=approve`]));
    const again = await call(agent, "write_file", { path: "Makefile", content: "test:\n\tfalse\n" });
    assert.notEqual(again.denialReason, "VERIFICATION_CONFIG_PROTECTED");
    assert.equal(pending(agent), undefined);

    fs.writeFileSync(path.join(repo, ".nexus-security.json"), JSON.stringify({ verificationPaths: { mode: "block" } }));
    const blocked = makeAgent(undefined, "auto");
    const refused = await call(blocked, "write_file", { path: "Makefile", content: "x" });
    assert.equal(refused.denialReason, "VERIFICATION_CONFIG_PROTECTED");
    assert.equal(pending(blocked), undefined, "a rule is not a decision");
  });

  test("verifier approval without an operator records a question bound to the command; approve admits it, decline refuses it", async () => {
    const agent = makeAgent();
    assert.equal(await (agent as any).ensureVerifierApproved("npm test"), false);
    const q = pending(agent);
    assert.equal(q.kind, "verifier_approval");
    assert.equal(q.subject.command, "npm test");
    (agent as any).pendingNeedsInput = undefined;
    agent.setOperatorAnswers(parseAnswers([`${q.id}=approve`]));
    assert.equal(await (agent as any).ensureVerifierApproved("npm test"), true);
    assert.equal(await (agent as any).ensureVerifierApproved("npm run other"), false, "another command is not approved");
    assert.notEqual(pending(agent).id, q.id);
    const decliner = makeAgent();
    await (decliner as any).ensureVerifierApproved("npm test");
    const dq = pending(decliner);
    (decliner as any).pendingNeedsInput = undefined;
    decliner.setOperatorAnswers(parseAnswers([`${dq.id}=decline`]));
    assert.equal(await (decliner as any).ensureVerifierApproved("npm test"), false);
    assert.equal(pending(decliner), undefined);
  });

  test("the verifier question id changes with the verifier script, so an answer cannot carry over to a rewritten one", async () => {
    const idFor = async (script: string) => {
      fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "x", scripts: { test: script } }));
      const agent = makeAgent();
      await (agent as any).ensureVerifierApproved("npm test");
      return pending(agent).id;
    };
    assert.notEqual(await idFor("node --test"), await idFor("true"));
  });

  test("the type-check approval is a question only when it is enforced; record-only is just not run", async () => {
    fs.writeFileSync(path.join(repo, "tsconfig.json"), "{}");
    fs.mkdirSync(path.join(repo, "node_modules/.bin"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules/.bin/tsc"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const recordOnly = makeAgent();
    const record = await (recordOnly as any).runTypecheckOracle({ budgetSecs: 30, configured: true });
    assert.equal(record.block, undefined);
    assert.equal(pending(recordOnly), undefined);
    const enforcing = makeAgent();
    const enforced = await (enforcing as any).runTypecheckOracle({ budgetSecs: 30, configured: false });
    assert.match(enforced.block, /not approved/);
    assert.equal(pending(enforcing).kind, "verifier_approval");
    assert.match(pending(enforcing).prompt, /tsc --noEmit/);
  });

  test("with an operator present nothing is recorded", async () => {
    const agent = makeAgent();
    assert.equal(await (agent as any).ensureVerifierApproved("npm test", async () => true), true);
    assert.equal(pending(agent), undefined);
  });
});

describe("VC-9: the turn", () => {
  const write = (content: string): Reply => ({ kind: "tools", calls: [{ name: "write_file", args: { path: "a.txt", content } }] });
  const done: Reply = { kind: "text", content: "finished" };

  test("the first needed decision ends the turn BLOCKED with the question; the resumed turn with the answer completes the action", { timeout: 60_000 }, async () => {
    const replies: Reply[] = [write("x"), write("x"), done];
    const gw = await startGateway((n) => replies[Math.min(n, replies.length) - 1]);
    try {
      const agent = makeAgent(gw.url);
      const blocked = await agent.runTurn("write a.txt");
      assert.equal(blocked.execution, "BLOCKED");
      assert.equal(blocked.reason, "NEEDS_INPUT");
      assert.equal(blocked.outcome, "NOT_ESTABLISHED");
      assert.equal(blocked.needsInput?.kind, "tool_approval");
      assert.equal(blocked.needsInput?.subject.tool, "write_file");
      assert.deepEqual(blocked.needsInput?.options.map((o) => o.id), ["approve", "decline"]);
      assert.equal(gw.requests.length, 1, "the run stopped at the question instead of letting the model route around it");
      assert.equal(fs.existsSync(path.join(repo, "a.txt")), false);
      assert.equal(exitCodeForTurn(blocked), 1);

      agent.setOperatorAnswers(parseAnswers([`${blocked.needsInput!.id}=approve`]));
      const resumed = await agent.runTurn("continue");
      assert.notEqual(resumed.reason, "NEEDS_INPUT");
      assert.equal(resumed.needsInput, undefined);
      assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "x");
    } finally {
      await gw.close();
    }
  });
});

describe("VC-9: a batch stops at the call that needed the decision", () => {
  test("a later call in the same batch is not executed", { timeout: 60_000 }, async () => {
    const replies: Reply[] = [{ kind: "tools", calls: [{ name: "write_file", args: { path: "a.txt", content: "x" } }, { name: "read_file", args: { path: "base.txt" } }] }, { kind: "text", content: "done" }];
    const gw = await startGateway((n) => replies[Math.min(n, replies.length) - 1]);
    try {
      const agent = makeAgent(gw.url);
      const turn = await agent.runTurn("write then read");
      assert.equal(turn.reason, "NEEDS_INPUT");
      const tools = (agent as any).messages.filter((m: any) => m.role === "tool");
      assert.equal(tools.length, 2);
      assert.match(String(tools[1].content), /the turn stopped before this call/);
      assert.doesNotMatch(String(tools[1].content), /^base/);
    } finally {
      await gw.close();
    }
  });
});

describe("VC-9: the --answer option", () => {
  const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
  const skip = fs.existsSync(CLI) ? false : "cli/dist is not built";
  const nexus = (...args: string[]) => spawnSync(process.execPath, [CLI, "run", ...args], { encoding: "utf8", cwd: repo, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") }, timeout: 30_000 });

  test("an answer without --resume, or a malformed one, is refused before anything runs", { skip }, () => {
    const noResume = nexus("--answer", "0123456789ab=approve", "do it");
    assert.equal(noResume.status, 2, noResume.stderr);
    assert.match(noResume.stderr, /--answer needs --resume/);
    const bad = nexus("--resume", "--answer", "nonsense", "do it");
    assert.equal(bad.status, 2, bad.stderr);
    assert.match(bad.stderr, /--answer expects <question id>=approve\|decline/);
  });
});
