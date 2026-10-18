import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginManager, pluginDirs } from "../src/plugins.js";

async function withHome(run: (home: string, ws: string) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-plugin-dirs-home-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-plugin-dirs-ws-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await run(home, ws);
  } finally {
    process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

describe("ACC-TRUST-06: plugin directories (REQ-SEC-115)", () => {
  test("a sentinel plugin in ~/.config/opencode/plugins is not imported (sentinel file not written)", async () => {
    await withHome(async (home, ws) => {
      const sentinelFile = path.join(ws, "sentinel-executed.txt");

      // Place a sentinel plugin in ~/.config/opencode/plugins
      const opencodeDir = path.join(home, ".config", "opencode", "plugins");
      fs.mkdirSync(opencodeDir, { recursive: true });
      fs.writeFileSync(
        path.join(opencodeDir, "sentinel.mjs"),
        `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(sentinelFile)}, "sentinel-executed");
export default { name: "sentinel-opencode-plugin", description: "should not load" };
`
      );

      // Place valid plugins in ~/.nexus/plugins and ~/.config/nexus/plugins
      const nexusDir = path.join(home, ".nexus", "plugins");
      fs.mkdirSync(nexusDir, { recursive: true });
      fs.writeFileSync(
        path.join(nexusDir, "nexus_plugin.mjs"),
        `export default { name: "nexus-plugin", description: "nexus home plugin" };\n`
      );

      const nexusConfigDir = path.join(home, ".config", "nexus", "plugins");
      fs.mkdirSync(nexusConfigDir, { recursive: true });
      fs.writeFileSync(
        path.join(nexusConfigDir, "nexus_config_plugin.mjs"),
        `export default { name: "nexus-config-plugin", description: "nexus config plugin" };\n`
      );

      // Verify pluginDirs does NOT include opencode directory
      const dirs = pluginDirs(ws, true);
      assert.ok(!dirs.some((d) => d.includes("opencode")), "opencode directory is not in pluginDirs");
      assert.ok(dirs.some((d) => d === nexusDir), "~/.nexus/plugins is in pluginDirs");
      assert.ok(dirs.some((d) => d === nexusConfigDir), "~/.config/nexus/plugins is in pluginDirs");

      // Load plugins
      const pm = new PluginManager(ws, { trusted: true });
      await pm.loadPlugins();

      // Verify sentinel was never imported
      assert.equal(fs.existsSync(sentinelFile), false, "sentinel file was not written (opencode plugin was not imported)");

      const loadedNames = pm.listPlugins().map((p) => p.name);
      assert.ok(!loadedNames.includes("sentinel-opencode-plugin"), "opencode plugin is not loaded");
      assert.ok(loadedNames.includes("nexus-plugin"), "nexus home plugin is loaded");
      assert.ok(loadedNames.includes("nexus-config-plugin"), "nexus config plugin is loaded");
    });
  });
});
