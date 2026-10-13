/**
 * Rarely used tools are offered only when a task needs them (each offered schema is sent with every request), and are
 * never out of reach: the operator's request, enable_tools, or a direct call turns their group on for the conversation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION } from "../src/types.js";
import { startGateway, Reply } from "./helpers/fixtures.js";
import { groupsTriggeredBy } from "../src/core/tool_groups.js";

const names = (agent: any): string[] => agent.getEffectiveTools().map((t: any) => t.function.name);

test("by default the browser, LSP, web, extra-search and knowledge tools are not offered; enable_tools is", () => {
  const agent: any = new AutonomousAgent({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 1, workspace: os.tmpdir(), shell: "bash" } as any);
  try {
    const offered = names(agent);
    for (const hidden of ["browser_navigate", "lsp_hover", "search_web", "fetch_web", "hybrid_search", "manage_knowledge"]) assert.ok(!offered.includes(hidden), hidden);
    for (const core of ["read_file", "edit_file", "run_command", "run_tests", "search_code", "task_completed", "enable_tools"]) assert.ok(offered.includes(core), core);
  } finally {
    agent.shutdown();
  }
});

test("the operator's request turns groups on", () => {
  assert.deepEqual(groupsTriggeredBy("Take a screenshot of the page at localhost:3000"), ["browser"]);
  assert.deepEqual(groupsTriggeredBy("Read https://example.com/spec and implement it"), ["web"]);
  assert.deepEqual(groupsTriggeredBy("Fix the off-by-one in slugify.js"), []);
});

test("enable_tools and a direct call to a hidden tool both offer its group from the next step", { timeout: 60_000 }, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-groups-"));
  const steps: Reply[] = [
    { kind: "tools", calls: [{ name: "enable_tools", args: { groups: ["lsp"] } }] },
    { kind: "tools", calls: [{ name: "cst_symbols", args: { path: "." } }] },
    { kind: "text", content: "done" },
  ];
  const gw = await startGateway((n) => steps[n - 1] ?? { kind: "text", content: "done" });
  const agent: any = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 5, temperature: 0, workspace: repo, shell: "bash", continuation: { ...DEFAULT_CONTINUATION, maxCompletionNudges: 0 } } as any);
  agent.ui = new Proxy({}, { get: () => () => {} });
  try {
    await agent.runTurn("Look around.");
    const toolsAt = (i: number) => ((gw.requests[i] as any).tools ?? []).map((t: any) => t.function.name);
    assert.ok(!toolsAt(0).includes("lsp_hover"), "not offered at first");
    assert.ok(toolsAt(1).includes("lsp_hover"), "offered after enable_tools");
    assert.ok(!toolsAt(1).includes("cst_symbols"));
    assert.ok(toolsAt(2).includes("cst_symbols"), "offered after a direct call");
    const result = (gw.requests[1] as any).messages.filter((m: any) => m.role === "tool").at(-1);
    assert.match(result.content, /Enabled lsp: lsp_definition, lsp_hover, lsp_diagnostics/);
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
