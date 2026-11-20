/**
 * An MCP tool the model is offered must be executable through the execution spine, with an explicit effect class
 * (docs/INVARIANTS.md I-AUTH-2). Reproduces audit finding D1: MCP tools were advertised to the model but were not in
 * the CapabilityRegistry, so the spine answered FAIL-001 ("not registered") for every call.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { startGateway } from "./helpers/fixtures.js";

test("an advertised MCP tool runs through the spine and returns the server's answer", async (t) => {
  const prevTrust = process.env.NEXUS_TRUST_WORKSPACE;
  process.env.NEXUS_TRUST_WORKSPACE = "1";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-spine-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo, stdio: "ignore" });
  const calls: string[] = [];
  const mcp = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      calls.push(body.method);
      const result =
        body.method === "tools/list" ? { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }
        : body.method === "tools/call" ? { content: [{ type: "text", text: `echo:${body.params?.arguments?.text}` }] }
        : {};
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
  await new Promise<void>((r) => mcp.listen(0, "127.0.0.1", r));
  fs.writeFileSync(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { demo: { url: `http://127.0.0.1:${(mcp.address() as AddressInfo).port}`, transport: "http" } } }));
  const gw = await startGateway((n) =>
    n === 1 ? { kind: "tools", calls: [{ name: "mcp__demo__echo", args: { text: "hi" } }] } : { kind: "text", content: "done" },
  );
  const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 4, temperature: 0, workspace: repo, shell: "bash", approvalMode: "auto", fullAccess: true });
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  t.after(async () => {
    agent.shutdown();
    await gw.close();
    mcp.closeAllConnections?.();
    await new Promise<void>((r) => mcp.close(() => r()));
    fs.rmSync(root, { recursive: true, force: true });
    if (prevTrust === undefined) delete process.env.NEXUS_TRUST_WORKSPACE;
    else process.env.NEXUS_TRUST_WORKSPACE = prevTrust;
  });
  await agent.initExtensibility();
  await agent.run("call the echo tool");
  assert.ok(calls.includes("tools/call"), `the MCP server never received tools/call (saw ${JSON.stringify(calls)})`);
  const transcript = JSON.stringify(gw.requests);
  assert.doesNotMatch(transcript, /FAIL-001/);
  assert.match(transcript, /echo:hi/);
});

import { extensionCapability } from "../src/core/extension_capabilities.js";
import { needsOperatorDecision } from "../src/core/capabilities.js";

test("extension capabilities default to conservative effect classes", () => {
  const def = { type: "function" as const, function: { name: "t", description: "d", parameters: { type: "object" as const, properties: {}, required: [] } } };
  const remote = extensionCapability(def, { kind: "mcp", serverName: "s", url: "https://x.example" });
  const local = extensionCapability(def, { kind: "mcp", serverName: "s", command: "node" });
  const plugin = extensionCapability(def, { kind: "plugin" });
  assert.deepEqual([remote.effect, remote.changesWorkspace], ["egress", false]);
  assert.deepEqual([local.effect, local.changesWorkspace], ["exec", true]);
  assert.deepEqual([plugin.effect, plugin.changesWorkspace], ["exec", true]);
  for (const c of [remote, local, plugin]) {
    assert.equal(c.mutating, true, "unknown effects are treated as mutating (read-only refuses them)");
    assert.equal(needsOperatorDecision(c.effect), true, "review mode asks before running them");
  }
});
