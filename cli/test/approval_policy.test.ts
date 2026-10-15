/**
 * SPEC-01 effect classes: every capability declares what it can affect, and review mode asks before writes, commands
 * and network egress (HIST-05: network tools used to run unasked even under --approve). ACC-SAFE-02.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { DurableStateManager } from "../src/core/state.js";
import { CapabilityRegistry, EFFECT_CLASSES, needsOperatorDecision, type EffectClass } from "../src/core/capabilities.js";
import { ApprovalPolicy } from "../src/core/approval_policy.js";
import { runDoctor, renderDoctorText } from "../src/doctor.js";
import { ApplicationCore } from "../src/core/app.js";
import { SidecarServer } from "../src/sidecar.js";
import { startGateway } from "./helpers/provider_fixture.js";

const EXPECTED: Record<string, EffectClass> = {
  read_file: "read_workspace", list_dir: "read_workspace", search_code: "read_workspace", find_files: "read_workspace",
  search_symbols: "read_workspace", file_info: "read_workspace", batch_read: "read_workspace", file_tree: "read_workspace",
  git_status: "read_workspace", git_diff: "read_workspace", git_log: "read_workspace", cst_symbols: "read_workspace",
  outline_file: "read_workspace", trigram_search: "read_workspace", hybrid_search: "read_workspace",
  write_file: "write_workspace", edit_file: "write_workspace", patch_file: "write_workspace", delete_file: "write_workspace",
  manage_knowledge: "write_workspace",
  run_command: "exec", run_tests: "exec", lsp_hover: "exec", lsp_definition: "exec", lsp_diagnostics: "exec",
  fetch_web: "egress", search_web: "egress", browser_navigate: "egress", browser_screenshot: "egress",
  browser_click: "egress", browser_type: "egress", browser_console_logs: "egress",
  spawn_subagent: "delegate", activate_skill: "context_inject",
  task_completed: "internal", update_plan: "internal", update_requirements: "internal", read_objective: "internal",
  read_findings: "internal", read_archive: "internal", enable_tools: "internal",
};

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-approval-"));
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: repo, stdio: "ignore" });
  return repo;
}

function agentFor(url: string, repo: string, stateDir: string): AutonomousAgent {
  const agent = new AutonomousAgent({ endpoint: url, model: "m", maxSteps: 8, temperature: 0, workspace: repo, shell: "bash" } as any);
  const a = agent as any;
  a.stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [a.primaryWorkspacePathIdentity] });
  return agent;
}

describe("effect classes", () => {
  test("every registered capability declares the expected effect class", () => {
    const repo = makeRepo();
    const agent = agentFor("http://127.0.0.1:9/v1", repo, fs.mkdtempSync(path.join(os.tmpdir(), "nexus-approval-state-")));
    try {
      const caps = agent.capabilityRegistry.listCapabilities();
      const seen = new Set<string>();
      for (const cap of caps) {
        seen.add(cap.modelToolName);
        assert.ok(EFFECT_CLASSES.includes(cap.effect), `${cap.modelToolName} has no valid effect class`);
        assert.equal(cap.effect, EXPECTED[cap.modelToolName], `${cap.modelToolName} effect`);
      }
      for (const name of Object.keys(EXPECTED)) assert.ok(seen.has(name), `${name} is not registered`);
    } finally {
      agent.shutdown();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("review mode asks before writes, commands and egress; never before reads, delegation or bookkeeping", () => {
    const asked = EFFECT_CLASSES.filter(needsOperatorDecision);
    assert.deepEqual([...asked].sort(), ["egress", "exec", "write_workspace"]);
  });

  test("a capability without an effect class cannot be registered", () => {
    const registry = new CapabilityRegistry();
    assert.throws(
      () => registry.register({ id: "x", modelToolName: "x", category: "fs", mutating: false, sideEffectContract: "", backend: "ts_native", toolDefinition: { type: "function", function: { name: "x", description: "", parameters: {} } } } as any),
      /effect must be one of/,
    );
  });
});

describe("review-mode gate in the agent loop", () => {
  test("egress asks once per origin; reads never ask", async () => {
    const replies = [
      { kind: "tools" as const, calls: [{ name: "fetch_web", args: { url: "https://example.invalid/a" } }] },
      { kind: "tools" as const, calls: [{ name: "fetch_web", args: { url: "https://example.invalid/b" } }] },
      { kind: "tools" as const, calls: [{ name: "fetch_web", args: { url: "https://other.invalid/c" } }] },
      { kind: "tools" as const, calls: [{ name: "read_file", args: { path: "base.txt" } }] },
      { kind: "text" as const, content: "done" },
    ];
    const gw = await startGateway((n) => replies[Math.min(n, replies.length) - 1]);
    const repo = makeRepo();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-approval-state-"));
    const agent = agentFor(gw.url, repo, stateDir);
    const asked: string[] = [];
    try {
      await agent.runTurn("look things up", async (tool, args) => {
        asked.push(`${tool} ${args.url ?? args.path ?? ""}`);
        return true;
      });
      assert.deepEqual(asked, ["fetch_web https://example.invalid/a", "fetch_web https://other.invalid/c"]);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("a denied egress call does not run and is not remembered as approved", async () => {
    const replies = [
      { kind: "tools" as const, calls: [{ name: "fetch_web", args: { url: "https://example.invalid/a" } }] },
      { kind: "tools" as const, calls: [{ name: "fetch_web", args: { url: "https://example.invalid/a" } }] },
      { kind: "text" as const, content: "gave up" },
    ];
    const gw = await startGateway((n) => replies[Math.min(n, replies.length) - 1]);
    const repo = makeRepo();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-approval-state-"));
    const agent = agentFor(gw.url, repo, stateDir);
    let asks = 0;
    try {
      await agent.runTurn("look it up", async () => {
        asks++;
        return false;
      });
      assert.equal(asks, 2, "a denial is asked again next time, never silently allowed");
      const toolResults = gw.requests.at(-1)!.body.messages.filter((m: any) => m.role === "tool");
      assert.ok(toolResults.every((m: any) => /rejected by the user/.test(String(m.content))), "denied calls report the rejection");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("ApprovalPolicy DEC-01 option C decision matrix", () => {
  const policy = new ApprovalPolicy();

  test("read_workspace and delegate never require operator decision", () => {
    for (const mode of ["auto", "review", "read-only"] as const) {
      for (const trusted of [true, false]) {
        assert.equal(policy.requiresDecision("read_workspace", { mode, trusted }), false);
        assert.equal(policy.requiresDecision("delegate", { mode, trusted }), false);
        assert.equal(policy.requiresDecision("internal", { mode, trusted }), false);
      }
    }
  });

  test("write_workspace requires decision in review mode, not in auto or read-only", () => {
    assert.equal(policy.requiresDecision("write_workspace", { mode: "review", trusted: true }), true);
    assert.equal(policy.requiresDecision("write_workspace", { mode: "review", trusted: false }), true);
    assert.equal(policy.requiresDecision("write_workspace", { mode: "auto", trusted: true }), false);
    assert.equal(policy.requiresDecision("write_workspace", { mode: "auto", trusted: false }), false);
    assert.equal(policy.requiresDecision("write_workspace", { mode: "read-only", trusted: true }), false);
    assert.equal(policy.requiresDecision("write_workspace", { mode: "auto", trusted: false, fullAccess: true }), false);
  });

  test("exec requires decision in review mode and in auto mode when untrusted", () => {
    // Review mode: always asks
    assert.equal(policy.requiresDecision("exec", { mode: "review", trusted: true }), true);
    assert.equal(policy.requiresDecision("exec", { mode: "review", trusted: false }), true);
    // Auto mode: asks only when untrusted
    assert.equal(policy.requiresDecision("exec", { mode: "auto", trusted: false }), true);
    assert.equal(policy.requiresDecision("exec", { mode: "auto", trusted: true }), false);
    // fullAccess (--yes): never asks
    assert.equal(policy.requiresDecision("exec", { mode: "auto", trusted: false, fullAccess: true }), false);
    assert.equal(policy.requiresDecision("exec", { mode: "review", trusted: false, fullAccess: true }), false);
  });

  test("egress asks once per origin, then allows for that origin", () => {
    const approved = new Set<string>(["https://example.com"]);
    // Unapproved origin asks in review and auto mode
    assert.equal(policy.requiresDecision("egress", { mode: "review", trusted: true, egressOrigin: "https://other.com", approvedEgressOrigins: approved }), true);
    assert.equal(policy.requiresDecision("egress", { mode: "auto", trusted: true, egressOrigin: "https://other.com", approvedEgressOrigins: approved }), true);
    // Approved origin does not ask
    assert.equal(policy.requiresDecision("egress", { mode: "review", trusted: true, egressOrigin: "https://example.com", approvedEgressOrigins: approved }), false);
    assert.equal(policy.requiresDecision("egress", { mode: "auto", trusted: true, egressOrigin: "https://example.com", approvedEgressOrigins: approved }), false);
  });

  test("context_inject asks when source is untrusted or workspace is untrusted", () => {
    assert.equal(policy.requiresDecision("context_inject", { mode: "review", trusted: false }), true);
    assert.equal(policy.requiresDecision("context_inject", { mode: "auto", trusted: false }), true);
    assert.equal(policy.requiresDecision("context_inject", { mode: "auto", trusted: true, isUntrustedSource: true }), true);
    assert.equal(policy.requiresDecision("context_inject", { mode: "auto", trusted: true, isUntrustedSource: false }), false);
  });
});

describe("headless execution (no onConfirm handler)", () => {
  test("fails closed with DECISION_REQUIRED_NO_OPERATOR when tool requires decision", async () => {
    const replies = [
      { kind: "tools" as const, calls: [{ name: "write_file", args: { path: "test.txt", content: "hello" } }] },
      { kind: "text" as const, content: "finished" },
    ];
    const gw = await startGateway((n) => replies[Math.min(n, replies.length) - 1]);
    const repo = makeRepo();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-headless-state-"));
    const agent = agentFor(gw.url, repo, stateDir);
    agent.setApprovalMode("review"); // review mode gates write_workspace
    try {
      // Call runTurn WITHOUT an onConfirm handler
      await agent.runTurn("write a file");
      const toolResults = gw.requests.at(-1)!.body.messages.filter((m: any) => m.role === "tool");
      assert.ok(toolResults.length > 0, "tool result returned to model");
      assert.match(toolResults[0].content, /Tool 'write_file' requires operator approval \(write_workspace\), but no operator is present/);
      assert.match(toolResults[0].content, /--yes/);

      const call = { id: "c1", type: "function", function: { name: "write_file", arguments: '{"path":"a.txt","content":"b"}' } };
      const dispatchRes = await (agent as any).dispatchToolCall(call, 1, "agent");
      assert.equal(dispatchRes.receipt.status, "DENIED");
      assert.equal(dispatchRes.receipt.denialReason, "DECISION_REQUIRED_NO_OPERATOR");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("posture reporting in doctor and sidecar", () => {
  test("doctor reports posture in json and formatted text", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-posture-doc-"));
    try {
      const report = await runDoctor({
        config: {
          workspace: ws,
          model: "test-model",
          endpoint: "http://127.0.0.1:9",
          shell: "bash",
          approvalMode: "review",
          readOnly: false,
        } as any,
      });
      assert.ok(report.posture, "doctor report contains posture");
      assert.equal(report.posture.mode, "review");
      assert.equal(report.posture.trusted, false);
      const text = renderDoctorText(report);
      assert.ok(text.includes("mode: review"), `doctor text contains posture: ${text}`);
      assert.ok(text.includes("workspace: untrusted"), `doctor text contains trust: ${text}`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test("sidecar emits posture in session.state", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sidecar-posture-"));
    try {
      const app = new ApplicationCore({
        workspace: ws,
        model: "m",
        endpoint: "http://127.0.0.1:9",
        shell: "bash",
        approvalMode: "review",
      } as any);
      const events: any[] = [];
      const server = new SidecarServer({
        app,
        mode: "review",
        write: (line) => {
          events.push(JSON.parse(line));
        },
      });
      server.start();
      const stateEvt = events.find((e) => e.type === "session.state");
      assert.ok(stateEvt, "session.state event emitted");
      assert.ok(stateEvt.posture, "session.state contains posture");
      assert.equal(stateEvt.posture.mode, "review");
      assert.equal(stateEvt.posture.trusted, false);
      assert.equal(stateEvt.posture.sandbox, "off");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
