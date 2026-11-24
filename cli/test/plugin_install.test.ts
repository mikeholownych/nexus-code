import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  installPluginFromLocal,
  listInstalledPlugins,
  PluginInstallError,
  removeInstalledPlugin,
  verifyInstalledPlugin,
} from "../src/core/plugin_install.js";
import { InvalidPluginManifestError, parsePluginManifest } from "../src/core/plugin_manifest.js";

function packageDir(home: string, name: string, body: Record<string, unknown> = {}): string {
  const dir = path.join(home, "pkg", name);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    version: 1,
    name,
    pluginVersion: "0.1.0",
    permissions: ["skills"],
    ...body,
  };
  fs.writeFileSync(path.join(dir, "nexus-plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "README.md"), "demo plugin\n");
  return dir;
}

test("parsePluginManifest refuses unknown keys and empty permissions", () => {
  assert.throws(() => parsePluginManifest({ version: 1, name: "x", pluginVersion: "1", permissions: [], extra: true }), InvalidPluginManifestError);
  assert.throws(() => parsePluginManifest({ version: 1, name: "x", pluginVersion: "1", permissions: [] }), /permissions must be a non-empty array/);
  const ok = parsePluginManifest({ version: 1, name: "demo", pluginVersion: "1.0.0", permissions: ["hooks", "skills"] });
  assert.equal(ok.name, "demo");
});

test("install, verify, tamper detection, and remove", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk2-"));
  const src = packageDir(home, "demo-plugin");
  const { receipt, installDir } = installPluginFromLocal(src, { home });
  assert.equal(receipt.name, "demo-plugin");
  assert.equal(receipt.sourceKind, "local");
  assert.ok(fs.existsSync(path.join(installDir, "nexus-plugin.json")));

  const listed = listInstalledPlugins(home);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "demo-plugin");

  assert.deepEqual(verifyInstalledPlugin("demo-plugin", home), { ok: true, name: "demo-plugin", treeDigest: receipt.treeDigest });

  fs.writeFileSync(path.join(installDir, "README.md"), "tampered\n");
  const bad = verifyInstalledPlugin("demo-plugin", home);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.reason, /tree digest mismatch/);

  removeInstalledPlugin("demo-plugin", home);
  assert.equal(listInstalledPlugins(home).length, 0);
  assert.throws(() => removeInstalledPlugin("demo-plugin", home), PluginInstallError);
});

test("remove refuses path traversal without deleting outside the install root", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk2-remove-boundary-"));
  const outside = path.join(home, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.txt"), "keep\n");

  assert.throws(() => removeInstalledPlugin("../../../outside", home), PluginInstallError);
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep\n");
});

test("install refuses a second copy of the same name", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk2-"));
  const src = packageDir(home, "once");
  installPluginFromLocal(src, { home });
  assert.throws(() => installPluginFromLocal(src, { home }), /already installed/);
});

test("permissionGate can refuse an install", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk2-"));
  const src = packageDir(home, "blocked", { permissions: ["mcp"] });
  assert.throws(
    () => installPluginFromLocal(src, { home, permissionGate: () => "permissions exceed policy" }),
    /permissions exceed policy/,
  );
});
