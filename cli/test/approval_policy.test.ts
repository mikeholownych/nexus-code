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
