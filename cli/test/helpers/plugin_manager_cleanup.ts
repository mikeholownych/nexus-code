import test from "node:test";
import { PluginManager } from "../../src/plugins.js";

/** File-level cleanup for fixtures that load real plugin workers and predate the worker process lifecycle. */
export function closeLoadedPluginManagersAfterTests(): void {
  const managers = new Set<PluginManager>();
  const original = PluginManager.prototype.loadPlugins;
  PluginManager.prototype.loadPlugins = async function (...args: Parameters<typeof original>) {
    managers.add(this);
    return original.apply(this, args);
  };
  test.after(() => {
    PluginManager.prototype.loadPlugins = original;
    for (const manager of managers) manager.shutdown();
  });
}
