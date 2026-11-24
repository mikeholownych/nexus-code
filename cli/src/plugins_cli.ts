/**
 * HK-2 subcommands on `nexus plugins`: install, list-installed, remove, verify.
 *
 * Install from a local path that contains `nexus-plugin.json`. Capabilities are printed at install. There is no
 * marketplace and no auto-update. A git URL pinned to a full commit hash is a follow-up slice.
 */
import type { Command } from "commander";
import pc from "picocolors";
import {
  installPluginFromLocal,
  listInstalledPlugins,
  PluginInstallError,
  removeInstalledPlugin,
  verifyInstalledPlugin,
} from "./core/plugin_install.js";
import { InvalidPluginManifestError } from "./core/plugin_manifest.js";

/** Attach install/list-installed/remove/verify under an existing `plugins` command. */
export function registerPluginPackageCommands(plugins: Command): void {
  plugins
    .command("install")
    .description("Install a plugin package from a local directory that contains nexus-plugin.json")
    .argument("<source>", "Local path to a plugin package directory")
    .action((source: string) => {
      try {
        const { receipt, installDir, manifest } = installPluginFromLocal(source);
        console.log(pc.green(`Installed ${manifest.name}@${manifest.pluginVersion}`));
        console.log(`  path: ${installDir}`);
        console.log(`  permissions: ${receipt.permissions.join(", ")}`);
        if (manifest.contributions) {
          const parts = Object.entries(manifest.contributions)
            .filter(([, v]) => Array.isArray(v) && v.length)
            .map(([k, v]) => `${k}=${(v as string[]).length}`);
          if (parts.length) console.log(`  contributions: ${parts.join(", ")}`);
        }
        console.log(`  tree: ${receipt.treeDigest}`);
      } catch (error) {
        const msg = error instanceof PluginInstallError || error instanceof InvalidPluginManifestError ? error.message : String(error);
        console.error(pc.red(`install failed: ${msg}`));
        process.exitCode = 1;
      }
    });

  plugins
    .command("list-installed")
    .description("List plugin packages installed under ~/.config/nexus/installed-plugins")
    .option("--json", "Print JSON")
    .action((options: { json?: boolean }) => {
      const installed = listInstalledPlugins();
      if (options.json) {
        console.log(JSON.stringify(installed.map(({ receipt, installDir }) => ({ ...receipt, installDir })), null, 2));
        return;
      }
      if (installed.length === 0) {
        console.log(pc.dim("No installed plugin packages."));
        return;
      }
      for (const { receipt, installDir } of installed) {
        console.log(`${pc.bold(receipt.name)}@${receipt.pluginVersion}  ${pc.dim(installDir)}`);
        console.log(`  permissions: ${receipt.permissions.join(", ")}  tree: ${receipt.treeDigest.slice(0, 12)}…`);
      }
    });

  plugins
    .command("remove")
    .description("Remove an installed plugin package by name")
    .argument("<name>", "Installed plugin name")
    .action((name: string) => {
      try {
        const dir = removeInstalledPlugin(name);
        console.log(pc.green(`Removed ${name} (${dir})`));
      } catch (error) {
        console.error(pc.red(error instanceof PluginInstallError ? error.message : String(error)));
        process.exitCode = 1;
      }
    });

  plugins
    .command("verify")
    .description("Verify an installed plugin package matches its install receipt")
    .argument("[name]", "Plugin name (all installed when omitted)")
    .action((name?: string) => {
      const names = name ? [name] : listInstalledPlugins().map((p) => p.name);
      if (names.length === 0) {
        console.log(pc.dim("No installed plugin packages."));
        return;
      }
      let failed = 0;
      for (const n of names) {
        const result = verifyInstalledPlugin(n);
        if (result.ok) console.log(pc.green(`ok  ${result.name}  tree ${result.treeDigest.slice(0, 12)}…`));
        else {
          failed += 1;
          console.log(pc.red(`fail  ${result.name}  ${result.reason}`));
        }
      }
      if (failed) process.exitCode = 1;
    });
}
