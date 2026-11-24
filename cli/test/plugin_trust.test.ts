import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginManager, workspacePluginTrustId, pluginFileSha256 } from "../src/plugins.js";
import { approveExtension, revokeExtension } from "../src/core/content_trust.js";
import { setWorkspaceTrusted } from "../src/workspace_trust.js";

function mkWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-plugin-trust-"));
}

function writePlugin(ws: string, rel: string, body: string): string {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
  return abs;
}

test("HK-3: unapproved workspace plugin is not loaded", async () => {
  const ws = mkWorkspace();
  const home = mkWorkspace();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    setWorkspaceTrusted(ws, true);
    writePlugin(ws, ".nexus/plugins/p.js", "export default { name:'p', description:'p' };");
    const pm = new PluginManager(ws);
    await pm.loadPlugins();
    assert.equal(pm.listPlugins().length, 0);
    const rec = pm.getPluginTrustRecords().find(r => r.path.endsWith("p.js"));
    assert.ok(rec);
    assert.equal(rec?.status, "untrusted");
  } finally {
    process.env.HOME = oldHome;
  }
});

test("HK-3: approved workspace plugin loads, changed bytes require new approval", async () => {
  const ws = mkWorkspace();
  const home = mkWorkspace();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    setWorkspaceTrusted(ws, true);
    const pluginPath = writePlugin(ws, ".nexus/plugins/p.js", "export default { name:'p', description:'p' };");
    const id = workspacePluginTrustId(ws, pluginPath);
    approveExtension({ kind: "workspace-plugin", scope: id.scope, key: id.key, sha256: pluginFileSha256(pluginPath), approvedAt: new Date().toISOString(), summary: "p" });

    const pm = new PluginManager(ws);
    await pm.loadPlugins();
    assert.equal(pm.listPlugins().length, 1);

    fs.writeFileSync(pluginPath, "export default { name:'p', description:'changed' };", "utf8");
    const pm2 = new PluginManager(ws);
    await pm2.loadPlugins();
    assert.equal(pm2.listPlugins().length, 0);
    const rec = pm2.getPluginTrustRecords().find(r => r.path.endsWith("p.js"));
    assert.equal(rec?.status, "changed");
  } finally {
    process.env.HOME = oldHome;
  }
});

test("HK-3: revoke removes approval", async () => {
  const ws = mkWorkspace();
  const home = mkWorkspace();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    setWorkspaceTrusted(ws, true);
    const pluginPath = writePlugin(ws, ".nexus/plugins/p.js", "export default { name:'p', description:'p' };");
    const id = workspacePluginTrustId(ws, pluginPath);
    approveExtension({ kind: "workspace-plugin", scope: id.scope, key: id.key, sha256: pluginFileSha256(pluginPath), approvedAt: new Date().toISOString(), summary: "p" });
    assert.equal(revokeExtension(id), true);
    const pm = new PluginManager(ws);
    await pm.loadPlugins();
    assert.equal(pm.listPlugins().length, 0);
  } finally {
    process.env.HOME = oldHome;
  }
});
