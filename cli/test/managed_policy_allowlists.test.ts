/**
 * GV-5 allowlists: `mcp.allow`, `mcp.disable_workspace`, `plugins.allow` and `plugins.disable_workspace` where MCP
 * servers are started and plugin files are imported. Every policy is injected (an in-memory policy host); HOME and the
 * workspace are temporary directories. A server "started" is a real child process that writes a marker file; a plugin
 * "imported" is a real module that writes one, so "not started" and "not imported" are observed, not inferred.
 */
import "./helpers/leak_guard.js";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpClientManager, McpConnection } from "../src/mcp.js";
import { PluginManager } from "../src/plugins.js";
import { closeLoadedPluginManagersAfterTests } from "./helpers/plugin_manager_cleanup.js";

closeLoadedPluginManagersAfterTests();
import { isWorkspaceFile } from "../src/workspace_trust.js";
import type { EffectivePolicy } from "../src/core/managed_policy.js";
import { FAKE_SYSTEM, FAKE_USER, policyWorld, sha256, toml } from "./helpers/policy_enforcement.js";

const SYSTEM_TAG = (key: string): string => `[policy: system ${FAKE_SYSTEM} ${key}]`;
const USER_TAG = (key: string): string => `[policy: user ${FAKE_USER} ${key}]`;

/** A stdio MCP server that leaves a marker file when it starts. */
const FAKE_SERVER = `
require("node:fs").writeFileSync(process.argv[2], "started");
const rl = require("node:readline").createInterface({ input: process.stdin });
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

let home = "", ws = "", serverScript = "", previousHome: string | undefined, previousXdg: string | undefined;
let managers: McpClientManager[] = [];

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gv5-home-")));
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gv5-ws-")));
  serverScript = path.join(home, "fake-mcp-server.cjs");
  fs.writeFileSync(serverScript, FAKE_SERVER);
  previousHome = process.env.HOME;
  previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
});
afterEach(() => {
  for (const manager of managers) manager.shutdownAll();
  managers = [];
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousXdg;
  for (const dir of [home, ws]) fs.rmSync(dir, { recursive: true, force: true });
});

const marker = (name: string): string => path.join(home, `started-${name}`);
/** A server definition that runs the fake server with `command` (the Node binary by default). */
const server = (name: string, command: string = process.execPath): Record<string, unknown> => ({ command, args: [serverScript, marker(name)] });
const writeJson = (file: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const userMcp = (servers: Record<string, unknown>): void => writeJson(path.join(home, ".config", "nexus", "mcp.json"), { mcpServers: servers });
const workspaceMcp = (servers: Record<string, unknown>): void => writeJson(path.join(ws, ".mcp.json"), { mcpServers: servers });
const effective = (tiers: { system?: string; user?: string }): EffectivePolicy => policyWorld(tiers).host.managed().effective;

/** A manager over the temporary workspace under `policy`, with what it told the operator. */
function mcp(policy: () => EffectivePolicy, trusted = false): { manager: McpClientManager; notices: string[]; started: () => string[] } {
  const notices: string[] = [];
  const manager = new McpClientManager(ws, { trusted, policy, notify: (notice) => notices.push(notice) });
  managers.push(manager);
  return { manager, notices, started: () => manager.listServers().map((s) => s.name).sort() };
}

describe("mcp.allow: only a listed server is started", () => {
  test("a listed name starts; an unlisted one is not started and the refusal names the policy source", async () => {
    userMcp({ files: server("files"), shell: server("shell") });
    const { manager, notices, started } = mcp(() => effective({ system: toml("[mcp]", 'allow = ["files"]') }));
    await manager.loadAndConnect();
    assert.deepEqual(started(), ["files"]);
    assert.ok(fs.existsSync(marker("files")));
    assert.equal(fs.existsSync(marker("shell")), false, "the refused server's program never ran");
    const refusal = `MCP server 'shell' is not started: it is not in the managed allowlist (mcp.allow). ${SYSTEM_TAG("mcp.allow")}`;
    assert.deepEqual(manager.getPolicyRefusals(), [refusal]);
    assert.deepEqual(notices, [`nexus: ${refusal}`]);
  });

  test("absent means no restriction; present and empty admits nothing", async () => {
    userMcp({ files: server("files") });
    const open = mcp(() => effective({ system: toml("[approval]", "strict = true") }));
    await open.manager.loadAndConnect();
    assert.deepEqual(open.started(), ["files"]);
    assert.deepEqual(open.manager.getPolicyRefusals(), []);
    open.manager.shutdownAll();
    fs.rmSync(marker("files"));

    const closed = mcp(() => effective({ system: toml("[mcp]", "allow = []") }));
    await closed.manager.loadAndConnect();
    assert.deepEqual(closed.started(), []);
    assert.equal(fs.existsSync(marker("files")), false);
    assert.equal(closed.manager.getPolicyRefusals().length, 1);
  });

  test("a name must match exactly: case, padding, look-alikes and prefix-shaped names are refused", async () => {
    const hostile = ["GitHub", "github ", " github", "github​", "github\n", "git\u0000hub", "githubx", "url:https://mcp.example.com", `command:${process.execPath}`];
    // The last two are server NAMES spelled like the other entry forms; their own program is another one.
    userMcp(Object.fromEntries(hostile.map((name, i) => [name, server(`hostile-${i}`, "/usr/bin/env")])));
    const { manager, notices, started } = mcp(() => effective({ system: toml("[mcp]", `allow = ["github", "url:https://mcp.example.com", "command:${process.execPath}"]`) }));
    await manager.loadAndConnect();
    assert.deepEqual(started(), []);
    assert.equal(manager.getPolicyRefusals().length, hostile.length);
    hostile.forEach((_, i) => assert.equal(fs.existsSync(marker(`hostile-${i}`)), false));
    for (const notice of notices) assert.doesNotMatch(notice, /[\u0000-\u001f\u007f-\u009f]/, "a control character in a server name is not printed");
    assert.ok(notices.some((notice) => notice.includes("'github\\u000a'")), "the newline in a name is written out, not sent");
  });

  test("command: pins the program by its exact absolute path", async () => {
    const node = process.execPath;
    userMcp({
      pinned: server("pinned"),
      bare: server("bare", "node"),
      dotted: server("dotted", `${path.dirname(node)}/../${path.basename(path.dirname(node))}/${path.basename(node)}`),
      other: server("other", "/usr/bin/env"),
    });
    const { manager, started } = mcp(() => effective({ system: toml("[mcp]", `allow = ["command:${node}"]`) }));
    await manager.loadAndConnect();
    assert.deepEqual(started(), ["pinned"], "a bare name found through PATH and an unnormalized path are not the pinned program");
    for (const name of ["bare", "dotted", "other"]) assert.equal(fs.existsSync(marker(name)), false, name);
  });

  test("url: admits a remote server only; a definition that would run a program is not admitted by its url", () => {
    const policy = effective({ system: toml("[mcp]", 'allow = ["url:https://mcp.example.com"]') });
    const { manager } = mcp(() => policy);
    const describe = (config: Record<string, unknown>) => new McpConnection("s", config as any).policyDescriptor(false);
    assert.deepEqual(describe({ url: "https://mcp.example.com/sse" }), { name: "s", url: "https://mcp.example.com/sse", fromWorkspace: false });
    // connect() runs the command for each of these, so the URL must not be what the policy sees.
    for (const transport of ["stdio", "bogus", "SSE"]) {
      assert.deepEqual(describe({ transport, url: "https://mcp.example.com/sse", command: "/bin/sh" }), { name: "s", command: "/bin/sh", fromWorkspace: false }, transport);
    }
    assert.deepEqual(describe({ transport: "sse", command: "/bin/sh" }), { name: "s", command: "/bin/sh", fromWorkspace: false });

    // Not connected (the fake URL is never contacted): addConnection only registers what the policy admits.
    manager.addConnection("remote", new McpConnection("remote", { url: "https://mcp.example.com/sse" }));
    manager.addConnection("elsewhere", new McpConnection("elsewhere", { url: "https://mcp.example.com.evil.test/sse" }));
    manager.addConnection("downgraded", new McpConnection("downgraded", { url: "http://mcp.example.com/sse" }));
    manager.addConnection("disguised", new McpConnection("disguised", { transport: "stdio", url: "https://mcp.example.com/sse", command: "/bin/sh" }));
    assert.deepEqual(manager.listServers().map((s) => s.name), ["remote"]);
    assert.equal(manager.getPolicyRefusals().length, 3);
  });

  test("a user file cannot add to the system list, and the refusal names the tier whose list excludes the server", async () => {
    userMcp({ files: server("files"), jira: server("jira"), wiki: server("wiki") });
    const { manager, started } = mcp(() => effective({ system: toml("[mcp]", 'allow = ["files", "wiki"]'), user: toml("[mcp]", 'allow = ["files", "jira"]') }));
    await manager.loadAndConnect();
    assert.deepEqual(started(), ["files"]);
    assert.deepEqual(manager.getPolicyRefusals().sort(), [
      `MCP server 'jira' is not started: it is not in the managed allowlist (mcp.allow). ${SYSTEM_TAG("mcp.allow")}`,
      `MCP server 'wiki' is not started: it is not in the managed allowlist (mcp.allow). ${USER_TAG("mcp.allow")}`,
    ]);
  });

  test("/mcp add of an unlisted server is refused before it runs, and nothing is saved", async () => {
    const { manager } = mcp(() => effective({ system: toml("[mcp]", 'allow = ["files"]') }));
    const result = await manager.addServer("shell", server("shell") as any, true);
    assert.equal(result.success, false);
    assert.equal(result.error, `MCP server 'shell' is not started: it is not in the managed allowlist (mcp.allow). ${SYSTEM_TAG("mcp.allow")}`);
    assert.equal(fs.existsSync(marker("shell")), false);
    assert.equal(fs.existsSync(path.join(home, ".config", "nexus", "mcp.json")), false);
    assert.equal((await manager.addServer("files", server("files") as any, false)).success, true);
  });

  test("a managed policy that cannot be read starts no server", async () => {
    userMcp({ files: server("files") });
    const world = policyWorld({ system: "schema_version = 1\n[mcp]\nallow = [\"files\"]\nalow = []\n" });
    const { manager, started } = mcp(() => world.host.managed().effective);
    await manager.loadAndConnect();
    assert.deepEqual(started(), []);
    assert.equal(fs.existsSync(marker("files")), false);
    assert.deepEqual(manager.getPolicyRefusals(), [`MCP server 'files' is not started: the managed policy cannot be read (system tier, ${FAKE_SYSTEM}).`]);
  });
});

describe("mcp.disable_workspace: servers the workspace configures are not started", () => {
  const POLICY = toml("[mcp]", "disable_workspace = true");

  test("a trusted workspace's server is refused with the source; the operator's own server starts", async () => {
    workspaceMcp({ repo: server("repo") });
    userMcp({ mine: server("mine") });
    const { manager, started } = mcp(() => effective({ system: POLICY }), true);
    await manager.loadAndConnect();
    assert.deepEqual(started(), ["mine"]);
    assert.equal(fs.existsSync(marker("repo")), false);
    assert.deepEqual(manager.getPolicyRefusals(), [`MCP server 'repo' is not started: managed policy disables MCP servers configured by the workspace. ${SYSTEM_TAG("mcp.disable_workspace")}`]);
  });

  test("a workspace name on the allowlist is still refused, and the operator's server of that name starts", async () => {
    workspaceMcp({ files: server("ws-files") });
    userMcp({ files: server("user-files") });
    const { manager, started } = mcp(() => effective({ system: toml("[mcp]", 'allow = ["files"]', "disable_workspace = true") }), true);
    await manager.loadAndConnect();
    assert.deepEqual(started(), ["files"]);
    assert.equal(fs.existsSync(marker("ws-files")), false);
    assert.ok(fs.existsSync(marker("user-files")));
  });

  test("a symbolic link does not relabel a configuration: workspace link out, operator link in", async () => {
    // The workspace's .mcp.json is a link to a file outside the workspace: it is still the workspace's configuration.
    const outside = path.join(home, "outside-mcp.json");
    writeJson(outside, { mcpServers: { linked_out: server("linked_out") } });
    fs.symlinkSync(outside, path.join(ws, ".mcp.json"));
    // The operator's mcp.json is a link to a file the repository controls: that content is the workspace's too.
    writeJson(path.join(ws, "config", "servers.json"), { mcpServers: { linked_in: server("linked_in") } });
    fs.mkdirSync(path.join(home, ".config", "nexus"), { recursive: true });
    fs.symlinkSync(path.join(ws, "config", "servers.json"), path.join(home, ".config", "nexus", "mcp.json"));
    writeJson(path.join(home, ".nexus", "mcp.json"), { mcpServers: { mine: server("mine") } });

    const { manager, started } = mcp(() => effective({ system: POLICY }), true);
    await manager.loadAndConnect();
    assert.deepEqual(started(), ["mine"]);
    assert.equal(fs.existsSync(marker("linked_out")), false);
    assert.equal(fs.existsSync(marker("linked_in")), false);
    assert.equal(manager.getPolicyRefusals().length, 2);
  });

  test("isWorkspaceFile: under the workspace by path or by what the path resolves to", () => {
    fs.writeFileSync(path.join(ws, "inside.json"), "{}");
    fs.writeFileSync(path.join(home, "outside.json"), "{}");
    fs.symlinkSync(path.join(ws, "inside.json"), path.join(home, "link-in.json"));
    fs.symlinkSync(path.join(home, "outside.json"), path.join(ws, "link-out.json"));
    assert.equal(isWorkspaceFile(ws, path.join(ws, "inside.json")), true);
    assert.equal(isWorkspaceFile(ws, path.join(ws, "link-out.json")), true);
    assert.equal(isWorkspaceFile(ws, path.join(home, "link-in.json")), true);
    assert.equal(isWorkspaceFile(ws, path.join(home, "outside.json")), false);
    assert.equal(isWorkspaceFile(ws, path.join(home, "missing.json")), false);
    assert.equal(isWorkspaceFile(ws, `${ws}-sibling/x.json`), false, "a sibling directory sharing the prefix is not inside");
    assert.equal(isWorkspaceFile(ws, path.join(ws, "..", path.basename(home), "outside.json")), false);
  });
});

describe("a workspace policy file cannot loosen the allowlists", () => {
  test("mcp and plugins keys in .nexus-security.json change nothing, trusted and approved or not", () => {
    const world = policyWorld({ system: toml("[mcp]", 'allow = ["files"]', "disable_workspace = true", "[plugins]", "allow = []", "disable_workspace = true") });
    const managed = world.host.managed().effective;
    world.project(ws, { mcp: { allow: ["files", "shell"], disable_workspace: false }, plugins: { allow: [`sha256:${"0".repeat(64)}`], disable_workspace: false }, "mcp.allow": ["shell"] });
    world.approve(ws);
    for (const trust of [{}, { workspaceTrusted: true }, { envTrustRequested: true }, { workspaceTrusted: true, envTrustRequested: true }]) {
      const loaded = world.load(ws, trust).effective;
      assert.deepEqual(loaded.mcp, managed.mcp);
      assert.deepEqual(loaded.plugins, managed.plugins);
    }
  });
});

describe("plugins.allow and plugins.disable_workspace: a refused file is never imported", () => {
  let seq = 0;
  /** Writes a plugin module that leaves a marker when its code runs; returns its path, marker and hash. */
  function plugin(dir: string, name: string): { file: string; ran: () => boolean; hash: string } {
    const ranFile = path.join(home, `imported-${name}-${++seq}`);
    const source = `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(ranFile)}, "ran");\nexport default { name: ${JSON.stringify(name)} };\n`;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.mjs`);
    fs.writeFileSync(file, source);
    return { file, ran: () => fs.existsSync(ranFile), hash: sha256(source) };
  }
  const userDir = (): string => path.join(home, ".nexus", "plugins");
  function plugins(policy: () => EffectivePolicy, trusted = false): { manager: PluginManager; notices: string[]; loaded: () => string[] } {
    const notices: string[] = [];
    const manager = new PluginManager(ws, { trusted, policy, notify: (notice) => notices.push(notice) });
    return { manager, notices, loaded: () => manager.listPlugins().map((p) => p.name).sort() };
  }

  test("sha256: admits exactly those bytes; a changed file and an unlisted file are refused with the source", async () => {
    const audit = plugin(userDir(), "audit");
    const other = plugin(userDir(), "other");
    const policy = effective({ system: toml("[plugins]", `allow = ["sha256:${audit.hash}"]`) });
    const first = plugins(() => policy);
    await first.manager.loadPlugins();
    assert.deepEqual(first.loaded(), ["audit"]);
    assert.equal(other.ran(), false);
    const refusal = `plugin '${other.file}' is not imported: it is not in the managed allowlist (plugins.allow). ${SYSTEM_TAG("plugins.allow")}`;
    assert.deepEqual(first.manager.getPolicyRefusals(), [refusal]);
    assert.deepEqual(first.notices, [`nexus: ${refusal}`]);

    fs.appendFileSync(audit.file, "// changed after it was pinned\n");
    const second = plugins(() => policy);
    await second.manager.loadPlugins();
    assert.deepEqual(second.loaded(), [], "the pinned content is gone, so nothing is admitted");
    assert.equal(second.manager.getPolicyRefusals().length, 2);
  });

  test("file: admits the real path only; a link to another file is not that path", async () => {
    const audit = plugin(userDir(), "audit");
    const target = plugin(path.join(home, "elsewhere"), "target");
    fs.symlinkSync(target.file, path.join(userDir(), "linked.mjs"));
    const { manager, loaded } = plugins(() => effective({ system: toml("[plugins]", `allow = ["file:${audit.file}", "file:${path.join(userDir(), "linked.mjs")}"]`) }));
    await manager.loadPlugins();
    assert.deepEqual(loaded(), ["audit"]);
    assert.equal(target.ran(), false);
    assert.deepEqual(manager.getPolicyRefusals(), [`plugin '${target.file}' is not imported: it is not in the managed allowlist (plugins.allow). ${SYSTEM_TAG("plugins.allow")}`]);
  });

  test("absent means no restriction; empty admits nothing; a user file cannot add to the system list", async () => {
    const a = plugin(userDir(), "a");
    const b = plugin(userDir(), "b");
    const open = plugins(() => effective({}));
    await open.manager.loadPlugins();
    assert.deepEqual(open.loaded(), ["a", "b"]);

    const closed = plugins(() => effective({ system: toml("[plugins]", "allow = []") }));
    await closed.manager.loadPlugins();
    assert.deepEqual(closed.loaded(), []);

    const both = plugins(() => effective({ system: toml("[plugins]", `allow = ["sha256:${a.hash}"]`), user: toml("[plugins]", `allow = ["sha256:${a.hash}", "sha256:${b.hash}"]`) }));
    await both.manager.loadPlugins();
    assert.deepEqual(both.loaded(), ["a"]);
  });

  test("disable_workspace: a trusted workspace's plugin is refused, also when listed and when linked from the operator's directory", async () => {
    const repo = plugin(path.join(ws, ".nexus", "plugins"), "repo");
    const hidden = plugin(path.join(ws, "tools"), "hidden");
    const mine = plugin(userDir(), "mine");
    fs.symlinkSync(hidden.file, path.join(userDir(), "hidden.mjs"));
    const { manager, loaded } = plugins(() => effective({ system: toml("[plugins]", `allow = ["sha256:${repo.hash}", "sha256:${hidden.hash}", "sha256:${mine.hash}"]`, "disable_workspace = true") }), true);
    await manager.loadPlugins();
    assert.deepEqual(loaded(), ["mine"]);
    assert.equal(repo.ran(), false);
    assert.equal(hidden.ran(), false);
    assert.deepEqual(manager.getPolicyRefusals().sort(), [repo.file, hidden.file].sort().map((file) => `plugin '${file}' is not imported: managed policy disables plugins from the workspace. ${SYSTEM_TAG("plugins.disable_workspace")}`));
  });

  test("a managed policy that cannot be read imports no plugin", async () => {
    const audit = plugin(userDir(), "audit");
    const world = policyWorld({ system: "schema_version = 1\n[plugins]\nallow = [\"md5:abc\"]\n" });
    const { manager, loaded } = plugins(() => world.host.managed().effective);
    await manager.loadPlugins();
    assert.deepEqual(loaded(), []);
    assert.equal(audit.ran(), false);
    assert.deepEqual(manager.getPolicyRefusals(), [`plugin '${audit.file}' is not imported: the managed policy cannot be read (system tier, ${FAKE_SYSTEM}).`]);
  });
});
