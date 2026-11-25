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
import * as path from "node:path";
import { approveExtension } from "./core/content_trust.js";
import { readPluginFile, workspacePluginTrustId } from "./plugins.js";
import { isWorkspaceFile } from "./workspace_trust.js";

export interface PluginTrustDeps {
  /** Whether a person can be asked: standard input and standard output are both a terminal. */
  interactive: () => boolean;
  /** Asks the question and returns the answer. */
  confirm: (question: string) => Promise<boolean>;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/**
 * `nexus plugins trust <file>`: approves one workspace plugin file by the SHA-256 of its bytes. Approving is the act of
 * a person at a terminal; `--sha256` only says which content is meant. The file is read again after the answer, and
 * what is recorded is that second reading, which must equal the content that was shown: a file swapped while the
 * question was open is not approved. Returns the process exit code.
 */
export async function trustWorkspacePlugin(workspace: string, pluginPath: string, options: { sha256?: string }, deps: PluginTrustDeps): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const fail = (line: string, code: number) => {
    (deps.error ?? ((text: string) => console.error(pc.red(text))))(line);
    return code;
  };
  const ws = path.resolve(workspace);
  const abs = path.resolve(ws, pluginPath);
  if (!isWorkspaceFile(ws, abs)) return fail(`Plugin must be a real file inside the workspace: ${abs}`, 1);
  const shown = readPluginFile(abs);
  if ("problem" in shown) return fail(`Not a plugin file that can be approved: ${abs}: ${shown.problem}`, 1);
  const id = workspacePluginTrustId(ws, abs);
  log(`${abs}\nsha256 ${shown.sha256}\nThis workspace plugin would run with full process authority (HK-3/D18: in-process, deprecated).`);
  if (!deps.interactive()) return fail("Not approved: approving a workspace plugin needs a person at a terminal. Review the file, then run `nexus plugins trust` yourself in a terminal.", 2);
  const pinned = options.sha256?.trim().toLowerCase();
  if (pinned !== undefined && pinned !== shown.sha256) return fail(`Not approved: --sha256 does not match the file, whose SHA-256 is ${shown.sha256}.`, 2);
  if (!(await deps.confirm("Approve this workspace plugin for this workspace? [y/N] "))) return fail("Not approved.", 1);
  // Read again after the answer: the bytes may have been replaced while the question was open.
  const confirmed = readPluginFile(abs);
  if ("problem" in confirmed) return fail(`Not approved: could not re-read ${abs}: ${confirmed.problem}`, 2);
  if (confirmed.sha256 !== shown.sha256) return fail(`Not approved: the file changed while you were asked (was ${shown.sha256}, now ${confirmed.sha256}). Review it and run \`nexus plugins trust\` again.`, 2);
  approveExtension({ kind: "workspace-plugin", scope: id.scope, key: id.key, sha256: confirmed.sha256, approvedAt: new Date().toISOString(), summary: path.basename(abs) });
  log(`Approved workspace plugin: ${abs}\nsha256 ${confirmed.sha256}\nUndo with \`nexus plugins revoke ${pluginPath}\`.`);
  return 0;
}

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
