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
import * as fs from "node:fs";
import { approveExtension, readExtensionTrust, revokeExtension } from "./core/content_trust.js";
import { HOOK_EVENTS } from "./core/hooks.js";
import { managedPolicy } from "./core/policy_runtime.js";
import { inspectWorkspaceManifestPlugins, type WorkspaceManifestPlugin } from "./core/workspace_plugins.js";
import type { EffectivePolicy } from "./core/managed_policy.js";
import { readPluginFile, workspacePluginTrustId } from "./plugins.js";
import { printable } from "./core/printable.js";
import { isWorkspaceFile, isWorkspaceTrusted } from "./workspace_trust.js";

export interface PluginTrustDeps {
  /** Whether a person can be asked: standard input and standard output are both a terminal. */
  interactive: () => boolean;
  /** Asks the question and returns the answer. */
  confirm: (question: string) => Promise<boolean>;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** The managed policy a manifest plugin is held to. Default: the process's. */
  policy?: () => EffectivePolicy;
}

function realDir(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** The workspace's manifest plugins as `nexus plugins list` and `trust` see them: gates applied, nothing run. */
export function workspaceManifestPlugins(workspace: string, policy: () => EffectivePolicy = managedPolicy): WorkspaceManifestPlugin[] {
  const ws = realDir(workspace);
  return inspectWorkspaceManifestPlugins({ workspace: ws, readOnly: false, trusted: isWorkspaceTrusted(ws), policy, approvals: readExtensionTrust().entries });
}

/** Withdraws the approval of a workspace plugin file or of a workspace manifest plugin's directory. */
export function revokeWorkspacePlugin(workspace: string, pluginPath: string): boolean {
  const ws = path.resolve(workspace);
  const abs = path.resolve(ws, pluginPath);
  const key = path.relative(ws, abs).split(path.sep).join("/");
  const file = revokeExtension(workspacePluginTrustId(ws, abs));
  const tree = revokeExtension({ kind: "workspace-manifest", scope: realDir(workspace), key });
  return file || tree;
}

/**
 * `nexus plugins trust <dir>`: approves a workspace manifest plugin by the digest of its whole tree. What is shown is
 * everything the approval covers: the hooks with their commands, the skills, and every file. As for a plugin file,
 * only a person at a terminal approves, and the tree is read again after the answer.
 */
async function trustWorkspaceManifestPlugin(ws: string, abs: string, options: { sha256?: string }, deps: PluginTrustDeps, log: (line: string) => void, fail: (line: string, code: number) => number): Promise<number> {
  const find = () => workspaceManifestPlugins(ws, deps.policy).find((plugin) => plugin.dir === abs);
  const shown = find();
  if (!shown) return fail(`Not a workspace plugin: ${printable(abs)} (a manifest plugin is a directory in .nexus/plugins/ with a nexus-plugin.json)`, 1);
  if (shown.status === "invalid" || !shown.digest) return fail(`${printable(abs)} is not a workspace plugin that can be approved: ${printable(shown.problem)}`, 1);
  if (shown.status === "policy_refused") return fail(`Not approved: ${printable(shown.problem)}`, 2);
  log(`${printable(abs)}\ntree sha256 ${shown.digest}\nWorkspace plugin '${printable(shown.name, 80)}'. Its hooks would run with your authority, outside the sandbox, on the tool calls they name:`);
  for (const file of shown.hooks) {
    for (const event of HOOK_EVENTS) {
      for (const hook of file.hooks[event] ?? []) log(`  ${event}  ${printable(hook.name, 200)}  tools: ${printable(hook.tools.join(", "))}\n    ${printable((hook.command as string[]).map((part) => JSON.stringify(part)).join(" "), 1000)}`);
    }
  }
  if (!shown.hooks.length) log("  (no hooks)");
  if (shown.skills.length) log(`It names these skills (recorded and covered by the approval; not loaded into requests in this version): ${printable(shown.skills.join(", "))}`);
  log("The approval covers every file of its directory, as it is now (a change to one needs a new approval):");
  for (const file of shown.files) log(`  ${printable(file.path)}  sha256 ${file.sha256}`);
  if (shown.status === "untrusted_workspace") log("Note: the workspace is not trusted (`nexus trust`), so the plugin stays unused until it is.");
  if (!deps.interactive()) return fail("Not approved: approving a workspace plugin needs a person at a terminal. Review it, then run `nexus plugins trust` yourself in a terminal.", 2);
  const pinned = options.sha256?.trim().toLowerCase();
  if (pinned !== undefined && pinned !== shown.digest) return fail(`Not approved: --sha256 does not match the plugin, whose tree SHA-256 is ${shown.digest}.`, 2);
  if (!(await deps.confirm("Approve this workspace plugin for this workspace? [y/N] "))) return fail("Not approved.", 1);
  // Read again after the answer: what is recorded is a tree that is still the tree that was shown.
  const confirmed = find();
  if (!confirmed?.digest || confirmed.status === "invalid") return fail(`Not approved: the plugin could not be read again: ${printable(confirmed?.problem ?? "it is gone")}`, 2);
  if (confirmed.digest !== shown.digest) return fail(`Not approved: the plugin changed while you were asked (was ${shown.digest}, now ${confirmed.digest}). Review it and run \`nexus plugins trust\` again.`, 2);
  approveExtension({ kind: "workspace-manifest", scope: confirmed.id.scope, key: confirmed.id.key, sha256: confirmed.digest, approvedAt: new Date().toISOString(), summary: `${confirmed.name}: ${confirmed.hooks.reduce((sum, file) => sum + HOOK_EVENTS.reduce((n, event) => n + (file.hooks[event]?.length ?? 0), 0), 0)} hook(s)`, files: confirmed.files });
  log(`Approved workspace plugin '${printable(confirmed.name, 80)}': ${printable(abs)}\ntree sha256 ${confirmed.digest}\nUndo with \`nexus plugins revoke ${printable(confirmed.id.key)}\`.`);
  return 0;
}

/**
 * `nexus plugins trust <file>`: approves one workspace plugin file by the SHA-256 of its bytes. Approving is the act of
 * a person at a terminal; `--sha256` only says which content is meant. The file is read again after the answer, and
 * what is recorded is that second reading, which must equal the content that was shown: a file swapped while the
 * question was open is not approved. Returns the process exit code.
 */
export async function trustWorkspacePlugin(workspace: string, pluginPath: string, options: { sha256?: string }, deps: PluginTrustDeps): Promise<number> {
  // Everything shown here names repository content (paths, hook names, commands): each line is made printable, so
  // that a name cannot move the cursor over, or add a line to, what the operator is asked to approve.
  const clean = (text: string) => text.split("\n").map((line) => printable(line, 2000)).join("\n");
  const log = (line: string) => (deps.log ?? ((text: string) => console.log(text)))(clean(line));
  const fail = (line: string, code: number) => {
    (deps.error ?? ((text: string) => console.error(pc.red(text))))(clean(line));
    return code;
  };
  // A plugin file is approved for the workspace path as the loader names it; a manifest plugin for its real path, as
  // the hook registry does.
  const ws = path.resolve(workspace);
  const abs = path.resolve(ws, pluginPath);
  const real = realDir(workspace);
  const dir = path.resolve(real, path.relative(ws, abs));
  let isDirectory = false;
  try {
    isDirectory = fs.lstatSync(dir).isDirectory();
  } catch {
    // not there: the file reader below says so
  }
  if (isDirectory) return trustWorkspaceManifestPlugin(real, dir, options, deps, log, fail);
  if (!isWorkspaceFile(ws, abs)) return fail(`Plugin must be a real file inside the workspace: ${printable(abs)}`, 1);
  const shown = readPluginFile(abs);
  if ("problem" in shown) return fail(`Not a plugin file that can be approved: ${printable(abs)}: ${printable(shown.problem)}`, 1);
  const id = workspacePluginTrustId(ws, abs);
  log(`${printable(abs)}\nsha256 ${shown.sha256}\nThis workspace plugin would run with full process authority (HK-3/D18: in-process, deprecated).`);
  if (!deps.interactive()) return fail("Not approved: approving a workspace plugin needs a person at a terminal. Review the file, then run `nexus plugins trust` yourself in a terminal.", 2);
  const pinned = options.sha256?.trim().toLowerCase();
  if (pinned !== undefined && pinned !== shown.sha256) return fail(`Not approved: --sha256 does not match the file, whose SHA-256 is ${shown.sha256}.`, 2);
  if (!(await deps.confirm("Approve this workspace plugin for this workspace? [y/N] "))) return fail("Not approved.", 1);
  // Read again after the answer: the bytes may have been replaced while the question was open.
  const confirmed = readPluginFile(abs);
  if ("problem" in confirmed) return fail(`Not approved: could not re-read ${printable(abs)}: ${confirmed.problem}`, 2);
  if (confirmed.sha256 !== shown.sha256) return fail(`Not approved: the file changed while you were asked (was ${shown.sha256}, now ${confirmed.sha256}). Review it and run \`nexus plugins trust\` again.`, 2);
  approveExtension({ kind: "workspace-plugin", scope: id.scope, key: id.key, sha256: confirmed.sha256, approvedAt: new Date().toISOString(), summary: path.basename(abs) });
  log(`Approved workspace plugin: ${printable(abs)}\nsha256 ${confirmed.sha256}\nUndo with \`nexus plugins revoke ${pluginPath}\`.`);
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
