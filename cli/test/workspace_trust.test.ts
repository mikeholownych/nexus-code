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

async function withHome(run: (home: string, ws: string) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-trust-home-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-trust-ws-"));
  const saved = { HOME: process.env.HOME, TRUST: process.env.NEXUS_TRUST_WORKSPACE };
  process.env.HOME = home;
  delete process.env.NEXUS_TRUST_WORKSPACE;
  try {
    await run(home, ws);
  } finally {
    process.env.HOME = saved.HOME;
    if (saved.TRUST === undefined) delete process.env.NEXUS_TRUST_WORKSPACE;
    else process.env.NEXUS_TRUST_WORKSPACE = saved.TRUST;
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
