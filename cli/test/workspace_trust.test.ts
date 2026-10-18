/**
 * A workspace's own MCP configuration and plugins run code from the workspace: they are loaded only when the
 * operator trusts it (`nexus trust`), never in read-only mode, and the agent's file tools cannot trust it for itself.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isWorkspaceTrusted, listTrustedWorkspaces, setWorkspaceTrusted, untrustedWorkspaceExtensions } from "../src/workspace_trust.js";
import { PluginManager } from "../src/plugins.js";
import { mcpConfigFiles } from "../src/mcp.js";
import { SecurityManager } from "../src/security.js";
import { AutonomousAgent } from "../src/agent.js";
import { KnowledgeGraph } from "../src/knowledge.js";
import { SkillManager } from "../src/skills.js";
import { startGateway } from "./helpers/fixtures.js";

async function withHome(run: (home: string, ws: string) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-trust-home-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-trust-ws-"));
  const saved = { HOME: process.env.HOME, TRUST: process.env.NEXUS_TRUST_WORKSPACE, AUTO: process.env.NEXUS_KNOWLEDGE_AUTOEXTRACT };
  process.env.HOME = home;
  delete process.env.NEXUS_TRUST_WORKSPACE;
  delete process.env.NEXUS_KNOWLEDGE_AUTOEXTRACT;
  try {
    await run(home, ws);
  } finally {
    process.env.HOME = saved.HOME;
    if (saved.TRUST === undefined) delete process.env.NEXUS_TRUST_WORKSPACE;
    else process.env.NEXUS_TRUST_WORKSPACE = saved.TRUST;
    if (saved.AUTO === undefined) delete process.env.NEXUS_KNOWLEDGE_AUTOEXTRACT;
    else process.env.NEXUS_KNOWLEDGE_AUTOEXTRACT = saved.AUTO;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

describe("workspace trust", () => {
  test("workspace plugins load only when the workspace is trusted, and never in read-only mode", async () => {
    await withHome(async (_home, ws) => {
      fs.mkdirSync(path.join(ws, ".nexus", "plugins"), { recursive: true });
      fs.writeFileSync(path.join(ws, ".nexus", "plugins", "p.mjs"), `export default { name: "ws-plugin", description: "d" };`);
      fs.writeFileSync(path.join(ws, ".mcp.json"), "{}");

      assert.equal(isWorkspaceTrusted(ws), false);
      assert.deepEqual(untrustedWorkspaceExtensions(ws).map((f) => path.basename(f)).sort(), [".mcp.json", "p.mjs"]);
      assert.ok(!mcpConfigFiles(ws, isWorkspaceTrusted(ws)).includes(path.join(ws, ".mcp.json")));
      const untrusted = new PluginManager(ws);
      await untrusted.loadPlugins();
      assert.ok(!untrusted.listPlugins().some((p) => p.name === "ws-plugin"), "not loaded while untrusted");

      const real = setWorkspaceTrusted(ws, true);
      assert.deepEqual(listTrustedWorkspaces(), [real]);
      assert.equal(isWorkspaceTrusted(ws), true);
      assert.deepEqual(untrustedWorkspaceExtensions(ws), []);
      const trusted = new PluginManager(ws);
      await trusted.loadPlugins();
      assert.ok(trusted.listPlugins().some((p) => p.name === "ws-plugin"), "loaded once trusted");

      const readOnly = new PluginManager(ws, { readOnly: true });
      await readOnly.loadPlugins();
      assert.ok(!readOnly.listPlugins().some((p) => p.name === "ws-plugin"), "never loaded in read-only mode");
      assert.equal(untrustedWorkspaceExtensions(ws, true).length, 2, "read-only reports them as not loaded");

      setWorkspaceTrusted(ws, false);
      assert.equal(isWorkspaceTrusted(ws), false);
      assert.deepEqual(listTrustedWorkspaces(), []);
    });
  });

  test("the trust store is a protected path for the agent's file tools", async () => {
    await withHome(async (home, ws) => {
      const store = path.join(home, ".config", "nexus", "trusted_workspaces.json");
      assert.equal(new SecurityManager(ws).isPathProtected(store).protected, true);
    });
  });

  test("ACC-TRUST-04: workspace skills and knowledge load only when workspace is trusted, with source annotations", async () => {
    await withHome(async (_home, ws) => {
      // Create skills/x/SKILL.md
      fs.mkdirSync(path.join(ws, "skills", "x"), { recursive: true });
      fs.writeFileSync(
        path.join(ws, "skills", "x", "SKILL.md"),
        `---
name: skill-x
description: Specialized skill X for testing
---
Instructions for skill-x`
      );

      // Create .nexus/knowledge.json
      fs.mkdirSync(path.join(ws, ".nexus"), { recursive: true });
      fs.writeFileSync(
        path.join(ws, ".nexus", "knowledge.json"),
        JSON.stringify({
          version: 1,
          updatedAt: "2026-10-15T00:00:00.000Z",
          entries: [
            {
              id: "k1",
              key: "rule-always-lint",
              value: "Always run linting before commit",
              category: "rule",
              confidence: 1.0,
              source: "manual",
              createdAt: "2026-10-15T00:00:00.000Z",
              updatedAt: "2026-10-15T00:00:00.000Z",
            },
          ],
        })
      );

      assert.equal(isWorkspaceTrusted(ws), false, "workspace starts untrusted");

      // 1. In untrusted workspace:
      const skillMgr = new SkillManager(ws);
      assert.deepEqual(skillMgr.listSkills(), [], "no trusted skills in untrusted workspace");
      assert.equal(skillMgr.listUntrustedSkills().length, 1);
      assert.equal(skillMgr.listUntrustedSkills()[0].name, "skill-x");
      assert.ok(!skillMgr.getPromptSection().includes("skill-x"));

      const knowledgeGraph = new KnowledgeGraph(ws);
      assert.equal(knowledgeGraph.exportPromptSection(), "", "knowledge returns empty prompt section when untrusted");

      // Test with mock gateway: system prompt sent to model has neither
      let requestsSeen: any[] = [];
      const gw = await startGateway((_n) => ({ kind: "text", content: "I am ready." }));
      let agentUntrusted: AutonomousAgent | undefined;
      try {
        agentUntrusted = new AutonomousAgent({
          endpoint: gw.url,
          model: "m",
          maxSteps: 1,
          temperature: 0,
          workspace: ws,
          shell: "bash",
        } as any);

        await agentUntrusted.runTurn("inspect");
        requestsSeen = gw.requests as any[];
        assert.ok(requestsSeen.length >= 1, "gateway received request");
        const sysPromptUntrusted = requestsSeen[0].messages[0].content as string;
        assert.ok(!sysPromptUntrusted.includes("skill-x"), "untrusted skill-x not in system prompt");
        assert.ok(!sysPromptUntrusted.includes("rule-always-lint"), "untrusted knowledge not in system prompt");

        // activate_skill is refused with hint
        const activateRes = await (agentUntrusted as any).dispatchToolCall(
          { id: "call_1", function: { name: "activate_skill", arguments: JSON.stringify({ name: "skill-x" }) } },
          1
        );
        assert.equal(activateRes.receipt.success, false);
        assert.ok(activateRes.receipt.error.includes("untrusted workspace"));
        assert.ok(activateRes.receipt.error.includes("nexus trust ."));
      } catch (err) {
        console.error("ACC-TRUST-04 untrusted phase failed:", err);
        throw err;
      } finally {
        agentUntrusted?.shutdown();
        await gw.close();
      }

      // 2. Trust the workspace: nexus trust .
      setWorkspaceTrusted(ws, true);
      assert.equal(isWorkspaceTrusted(ws), true);

      // Now both appear, with source annotations
      const gw2 = await startGateway((_n) => ({ kind: "text", content: "Trusted turn complete." }));
      let agentTrusted: AutonomousAgent | undefined;
      try {
        agentTrusted = new AutonomousAgent({
          endpoint: gw2.url,
          model: "m",
          maxSteps: 1,
          temperature: 0,
          workspace: ws,
          shell: "bash",
        } as any);

        await agentTrusted.runTurn("inspect trusted");
        const reqs2 = gw2.requests as any[];
        assert.ok(reqs2.length >= 1);
        const sysPromptTrusted = reqs2[0].messages[0].content as string;
        assert.ok(sysPromptTrusted.includes("skill-x"), "trusted skill-x is in system prompt");
        assert.ok(sysPromptTrusted.includes("rule-always-lint"), "trusted knowledge is in system prompt");

        // Verify source annotations
        const skillPath = path.join(ws, "skills", "x", "SKILL.md");
        const knowledgePath = path.join(ws, ".nexus", "knowledge.json");
        assert.ok(
          sysPromptTrusted.includes(`[source: ${skillPath}] [trust: trusted]`),
          "skill has source and trust annotation"
        );
        assert.ok(
          sysPromptTrusted.includes(`[source: ${knowledgePath}] [trust: trusted]`),
          "knowledge has source and trust annotation"
        );

        // activate_skill succeeds with source annotation
        const activateRes2 = await (agentTrusted as any).dispatchToolCall(
          { id: "call_2", function: { name: "activate_skill", arguments: JSON.stringify({ name: "skill-x" }) } },
          1
        );
        assert.equal(activateRes2.receipt.success, true);
        assert.ok(activateRes2.receipt.output.includes(`[source: ${skillPath}] [trust: trusted]`));
        assert.ok(activateRes2.receipt.output.includes("Instructions for skill-x"));
      } catch (err) {
        console.error("ACC-TRUST-04 trusted phase failed:", err);
        throw err;
      } finally {
        agentTrusted?.shutdown();
        await gw2.close();
      }
    });
  });

  test("ACC-TRUST-05: no implicit standing rules (autoExtract opt-in) and read-only mode creates no .nexus/", async () => {
    await withHome(async (_home, ws) => {
      setWorkspaceTrusted(ws, true);
      fs.mkdirSync(path.join(ws, ".nexus"), { recursive: true });
      const initialKnowledge = {
        version: 1,
        updatedAt: "2026-10-15T00:00:00.000Z",
        entries: [
          {
            id: "k0",
            key: "rule-initial",
            value: "Initial rule",
            category: "rule",
            confidence: 1.0,
            source: "manual",
            createdAt: "2026-10-15T00:00:00.000Z",
            updatedAt: "2026-10-15T00:00:00.000Z",
          },
        ],
      };
      const dbPath = path.join(ws, ".nexus", "knowledge.json");
      fs.writeFileSync(dbPath, JSON.stringify(initialKnowledge, null, 2));
      const beforeContent = fs.readFileSync(dbPath, "utf-8");

      // 1. Default config: NEXUS_KNOWLEDGE_AUTOEXTRACT is unset
      delete process.env.NEXUS_KNOWLEDGE_AUTOEXTRACT;
      const gw = await startGateway((_n) => ({ kind: "text", content: "Acknowledged." }));
      let agent: AutonomousAgent | undefined;
      try {
        agent = new AutonomousAgent({
          endpoint: gw.url,
          model: "m",
          maxSteps: 1,
          temperature: 0,
          workspace: ws,
          shell: "bash",
        } as any);

        await agent.runTurn("never run the tests");
      } finally {
        agent?.shutdown();
        await gw.close();
      }

      // knowledge.json must not have changed
      const afterContent = fs.readFileSync(dbPath, "utf-8");
      assert.equal(afterContent, beforeContent, "knowledge.json unchanged when autoExtract is not opted in");

      // 2. Opt-in via NEXUS_KNOWLEDGE_AUTOEXTRACT=1
      process.env.NEXUS_KNOWLEDGE_AUTOEXTRACT = "1";
      const kg = new KnowledgeGraph(ws);
      const learned = kg.autoExtract("always remember to never run the tests under root", "");
      assert.ok(learned.length > 0, "autoExtract learns when opted in");
      delete process.env.NEXUS_KNOWLEDGE_AUTOEXTRACT;

      // 3. Read-only run creates no .nexus/
      const wsReadOnly = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-readonly-ws-"));
      try {
        assert.equal(fs.existsSync(path.join(wsReadOnly, ".nexus")), false);

        // Instantiate KnowledgeGraph with readOnly: true
        const roGraph = new KnowledgeGraph(wsReadOnly, { readOnly: true });
        assert.equal(fs.existsSync(path.join(wsReadOnly, ".nexus")), false, "KnowledgeGraph constructor does not create .nexus in read-only mode");

        // save() does not create .nexus/
        roGraph.save();
        assert.equal(fs.existsSync(path.join(wsReadOnly, ".nexus")), false, "save() does not create .nexus in read-only mode");

        // Mutating methods throw
        assert.throws(() => roGraph.set("key", "val"), /Read-only mode violation/);
        assert.throws(() => roGraph.delete("key"), /Read-only mode violation/);

        // AutonomousAgent in readOnly mode does not create .nexus/
        const roAgent = new AutonomousAgent({
          endpoint: "http://127.0.0.1:9/v1",
          model: "m",
          maxSteps: 1,
          workspace: wsReadOnly,
          readOnly: true,
          shell: "bash",
        } as any);
        assert.equal(fs.existsSync(path.join(wsReadOnly, ".nexus")), false, "AutonomousAgent does not create .nexus in read-only mode");
        roAgent.shutdown();
        assert.equal(fs.existsSync(path.join(wsReadOnly, ".nexus")), false, "AutonomousAgent shutdown does not create .nexus in read-only mode");
      } finally {
        fs.rmSync(wsReadOnly, { recursive: true, force: true });
      }
    });
  });
});

describe("MCP server environment", () => {
  test("servers get process basics, proxy and CA settings and their own env, never the Nexus process's secrets", async () => {
    const { buildMcpEnvironment } = await import("../src/mcp.js");
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { HTTPS_PROXY: "http://proxy:3128", NODE_EXTRA_CA_CERTS: "/etc/ca.pem", LOCAL_LLM_API_KEY: "secret-value-123456", NODE_OPTIONS: "--require /tmp/x.js" });
      const env = buildMcpEnvironment({ GITHUB_TOKEN: "server-own-token" });
      assert.equal(env.HTTPS_PROXY, "http://proxy:3128");
      assert.equal(env.NODE_EXTRA_CA_CERTS, "/etc/ca.pem");
      assert.equal(env.GITHUB_TOKEN, "server-own-token", "the server's configured env is passed");
      assert.equal(env.LOCAL_LLM_API_KEY, undefined, "Nexus's own credentials are not");
      assert.equal(env.NODE_OPTIONS, undefined, "nor code-injecting options");
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});
