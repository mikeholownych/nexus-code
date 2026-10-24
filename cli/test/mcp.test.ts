/**
 * Persisting an MCP server definition: a server's `env` may carry its own token, so the file is owner-only, and an
 * unparseable existing config is never replaced (that would silently discard every other server).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpClientManager } from "../src/mcp.js";

const FAKE_SERVER = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  const result = msg.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
    : msg.method === "tools/list" ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
});
rl.on("close", () => process.exit(0));
`;

async function withHome(run: (home: string, server: string) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-home-"));
  const server = path.join(home, "fake-mcp-server.cjs");
  fs.writeFileSync(server, FAKE_SERVER);
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const umask = process.umask(0o022);
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  try {
    await run(home, server);
  } finally {
    process.env.HOME = saved.HOME;
    if (saved.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME;
    process.umask(umask);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function configPaths(home: string): { dir: string; file: string } {
  const dir = path.join(home, ".config", "nexus");
  return { dir, file: path.join(dir, "mcp.json") };
}

function connectFake(manager: McpClientManager, server: string) {
  return manager.addServer("fake", {
    command: process.execPath,
    args: [server],
    env: { FAKE_TOKEN: "s3cr3t-value" },
  });
}

describe("MCP server configuration persistence", () => {
  test("writes a server with a token owner-only, keeping other servers", async () => {
    await withHome(async (home, server) => {
      const { dir, file } = configPaths(home);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { keep: { command: "keep-me" } } }, null, 2));

      const manager = new McpClientManager(home);
      try {
        const result = await connectFake(manager, server);
        assert.equal(result.success, true);

        const mode = fs.statSync(file).mode & 0o777;
        assert.equal(mode, 0o600, `config mode ${mode.toString(8)} leaks a server token to other users`);
        const dirMode = fs.statSync(dir).mode & 0o777;
        assert.equal(dirMode, 0o700, `config directory mode ${dirMode.toString(8)} is not owner-only`);

        const saved = JSON.parse(fs.readFileSync(file, "utf8"));
        assert.equal(saved.mcpServers.keep.command, "keep-me", "an existing server was dropped");
        assert.equal(saved.mcpServers.fake.env.FAKE_TOKEN, "s3cr3t-value");
        assert.equal(result.persisted, true, `persist result: ${JSON.stringify(result)}`);
      } finally {
        manager.shutdownAll();
      }
    });
  });

  test("refuses to replace an unparseable config instead of dropping its servers", async () => {
    await withHome(async (home, server) => {
      const { dir, file } = configPaths(home);
      fs.mkdirSync(dir, { recursive: true });
      const broken = '{ "mcpServers": { "keep": { "command": "keep-me" } }, }';
      fs.writeFileSync(file, broken);

      const manager = new McpClientManager(home);
      try {
        const result = await connectFake(manager, server);
        assert.equal(result.success, true, "the connection itself still succeeded");
        assert.equal(result.persisted, false);
        assert.match(result.persistError || "", /JSON|object|parse/i);
        assert.equal(fs.readFileSync(file, "utf8"), broken, "the unparseable config was overwritten");
      } finally {
        manager.shutdownAll();
      }
    });
  });
});
