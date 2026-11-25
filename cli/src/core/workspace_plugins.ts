/**
 * HK-3.2: workspace manifest plugins. A directory `<workspace>/.nexus/plugins/<name>/` with a `nexus-plugin.json`
 * contributes command hooks (and names skills); it carries no in-process code. It is repository content, so it is in
 * force only while its whole tree is the one the operator approved (kind `workspace-manifest`, by tree digest), the
 * workspace is trusted, the session may write, and managed policy does not refuse it. Its hooks are project hooks in
 * every respect: the same command allowlist, the same execution from verified copies, the same deny-only answers.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { extensionTrustEntry, type ExtensionTrustEntry, type ExtensionTrustFile, type ExtensionTrustId } from "./content_trust.js";
import { HOOK_EVENTS, parseHooksFile, planProjectCommand, readRegularFile, type HooksFile } from "./hooks.js";
import { permitsPlugin, type EffectivePolicy } from "./managed_policy.js";
import { PLUGIN_MANIFEST_NAME, loadPluginManifest, type PluginManifest } from "./plugin_manifest.js";
import { decodeStrictUtf8 } from "./strict_json.js";

/** Where workspace manifest plugins live, relative to the workspace. */
export const WORKSPACE_MANIFEST_PLUGINS_DIR = path.join(".nexus", "plugins");
const TREE_FILES_LIMIT = 64;
const TREE_DIRECTORIES_LIMIT = 256;
const TREE_DEPTH_LIMIT = 8;
const TREE_FILE_BYTES = 1024 * 1024;
const TREE_TOTAL_BYTES = 8 * 1024 * 1024;
const PLUGINS_LIMIT = 32;
/** How many entries of `.nexus/plugins` are looked at for plugin directories. */
const ROOT_ENTRIES_LIMIT = 256;

/** `active`: its hooks run. Every other status: nothing of it is used. */
export type WorkspaceManifestStatus = "active" | "not_approved" | "changed" | "invalid" | "policy_refused" | "untrusted_workspace" | "read_only";

export interface WorkspaceManifestPlugin {
  name: string;
  /** Absolute path of the plugin's directory. */
  dir: string;
  id: ExtensionTrustId;
  status: WorkspaceManifestStatus;
  /** Why an `invalid` or `policy_refused` plugin is not used. */
  problem?: string;
  /** For `changed`: what differs from the approval. */
  changed?: string[];
  /** SHA-256 over the tree (the format of HK-2's `hashPackageTree`); absent when the tree could not be read. */
  digest?: string;
  /** Every file of the tree, by workspace-relative path, with the SHA-256 of its bytes now. */
  files: ExtensionTrustFile[];
  /** The plugin's hooks, each named `<plugin>/<hook>`, ready for the hook registry. */
  hooks: HooksFile[];
  /** The skill directories the manifest names, relative to the plugin's directory. */
  skills: string[];
}

export interface WorkspaceManifestInput {
  /** The workspace's real path. */
  workspace: string;
  readOnly: boolean;
  /** Whether the operator trusts the workspace. */
  trusted: boolean;
  policy: () => EffectivePolicy;
  approvals: readonly ExtensionTrustEntry[];
}

const inside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

/** A plugin's tree as a walk found it: its files, and a stamp that changes whenever anything in it does. */
interface Tree {
  files: string[];
  /**
   * The identity of the tree's content as stats show it: every directory's listing and, for every file and
   * directory, device, inode, size, modification time and change time (which a writer cannot set back), to the
   * precision the file system keeps them.
   */
  stamp: string;
}

/**
 * Every file below `dir`, relative to it, sorted. Only names and stats are read. A symbolic link or a special file
 * anywhere refuses the tree, and so does a tree past any bound (files, directories, depth, total size): what is too
 * large to hash on every tool call is not a plugin.
 */
function walkTree(dir: string): Tree {
  const files: string[] = [];
  const parts: string[] = [];
  let directories = 0;
  let bytes = 0;
  const walk = (current: string, relative: string, depth: number) => {
    if (depth > TREE_DEPTH_LIMIT) throw new Error(`the directory is nested more than ${TREE_DEPTH_LIMIT} levels deep`);
    const names = fs.readdirSync(current);
    // Bounded before anything is sorted or looked at: a directory of tens of thousands of entries costs one listing.
    if (names.length > TREE_FILES_LIMIT + TREE_DIRECTORIES_LIMIT) throw new Error(`${relative || "the directory"} holds ${names.length} entries; a plugin holds at most ${TREE_FILES_LIMIT} files in ${TREE_DIRECTORIES_LIMIT} directories`);
    for (const name of names.sort()) {
      const child = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(`${current}/${name}`);
      parts.push(`${child}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`);
      if (stat.isDirectory()) {
        if (++directories > TREE_DIRECTORIES_LIMIT) throw new Error(`the directory holds more than ${TREE_DIRECTORIES_LIMIT} directories`);
        walk(`${current}/${name}`, child, depth + 1);
      } else if (stat.isFile()) {
        files.push(child);
        bytes += stat.size;
        if (files.length > TREE_FILES_LIMIT) throw new Error(`the directory holds more than ${TREE_FILES_LIMIT} files`);
        if (stat.size > TREE_FILE_BYTES || bytes > TREE_TOTAL_BYTES) throw new Error(`the directory holds more than ${TREE_TOTAL_BYTES / (1024 * 1024)} MiB, or a file of more than 1 MiB`);
      } else {
        throw new Error(`${child} is a symbolic link or a special file; a plugin's directory holds regular files only`);
      }
    }
  };
  const own = fs.lstatSync(dir);
  parts.push(`.\0${own.dev}:${own.ino}:${own.mtimeMs}:${own.ctimeMs}`);
  walk(dir, "", 1);
  return { files: files.sort(), stamp: parts.join("\n") };
}

type PluginRead = { manifest: PluginManifest; hooks: HooksFile[]; skills: string[]; files: ExtensionTrustFile[]; digest: string };
/**
 * What was read from a plugin's tree, by the tree's stamp: an unchanged tree is not read or hashed again, within a
 * tool call or across calls. Any change to a file or a directory changes the stamp, so nothing stale is served. The
 * interpreter lookup is part of the reading, hence PATH in the key.
 */
const reads = new Map<string, { key: string; read?: PluginRead; error?: string }>();

/**
 * Reads one plugin directory: its manifest, the hooks files and skill directories the manifest names, and every file
 * of the tree. Throws with the reason when it is not a workspace manifest plugin that could be approved.
 */
function readPlugin(workspace: string, dir: string): PluginRead {
  if (!fs.lstatSync(dir).isDirectory()) throw new Error("the plugin's directory is a symbolic link or not a directory");
  const { files: tree, stamp } = walkTree(dir);
  const key = `${workspace}\n${process.env.PATH ?? ""}\n${stamp}`;
  const cached = reads.get(dir);
  if (cached?.key === key) {
    if (cached.read) return cached.read;
    throw new Error(cached.error);
  }
  try {
    const read = readPluginTree(workspace, dir, tree);
    // The tree as it was when the reading ended must be the tree that was walked.
    if (walkTree(dir).stamp !== stamp) throw new Error("the plugin's directory changed while it was read");
    if (reads.size >= 64) reads.clear();
    reads.set(dir, { key, read });
    return read;
  } catch (error) {
    reads.set(dir, { key, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** How many plugin trees were actually read and hashed (not served from the cache): for tests of the cache. */
export const workspacePluginReads = { count: 0 };

function readPluginTree(workspace: string, dir: string, tree: string[]): PluginRead {
  workspacePluginReads.count++;
  const { manifest } = loadPluginManifest(dir);
  if (manifest.name !== path.basename(dir)) throw new Error(`the manifest's name '${manifest.name}' is not the directory's name '${path.basename(dir)}'`);
  const more = manifest.permissions.filter((permission) => permission !== "hooks" && permission !== "skills");
  if (more.length) throw new Error(`a workspace plugin may ask for hooks and skills only, not ${more.join(", ")}`);
  if (manifest.contributions?.verifiers?.length || manifest.contributions?.mcp?.length) throw new Error("a workspace plugin may contribute hooks and skills only (no verifiers, no MCP servers; workspace MCP servers belong in .mcp.json)");
  const hookFiles = manifest.contributions?.hooks ?? [];
  const skills = manifest.contributions?.skills ?? [];
  if (hookFiles.length && !manifest.permissions.includes("hooks")) throw new Error("the manifest contributes hooks without the 'hooks' permission");
  if (skills.length && !manifest.permissions.includes("skills")) throw new Error("the manifest contributes skills without the 'skills' permission");

  const named = new Set<string>([PLUGIN_MANIFEST_NAME]);
  const within = (entry: string, what: string): string => {
    const target = path.resolve(dir, entry);
    if (path.isAbsolute(entry) || !inside(dir, target) || target === dir) throw new Error(`${what} '${entry}' is not a path inside the plugin's directory`);
    return path.relative(dir, target).split(path.sep).join("/");
  };
  const hooks: HooksFile[] = [];
  for (const entry of hookFiles) {
    const relative = within(entry, "the hooks file");
    if (!tree.includes(relative)) throw new Error(`the hooks file '${entry}' does not exist`);
    named.add(relative);
    const file = parseHooksFile(decodeStrictUtf8(readRegularFile(path.join(dir, relative), TREE_FILE_BYTES)));
    for (const event of HOOK_EVENTS) {
      for (const hook of file.hooks[event] ?? []) {
        // The same rule as for a project's own hooks, with the plugin's directory as the place scripts are named from
        // and must stay inside.
        const plan = planProjectCommand(hook.command, workspace, { base: dir, tree: dir });
        if ("problem" in plan) throw new Error(`${entry}: hook '${hook.name}': ${plan.problem}`);
        for (const pin of plan.pins) named.add(path.relative(dir, pin.target).split(path.sep).join("/"));
        // Shown and recorded under the plugin's name, so that two plugins' hooks cannot be taken for one another.
        hook.name = `${manifest.name}/${hook.name}`;
      }
    }
    hooks.push(file);
  }
  for (const entry of skills) {
    const relative = within(entry, "the skill");
    if (!tree.includes(`${relative}/SKILL.md`)) throw new Error(`the skill '${entry}' is not a directory with a SKILL.md`);
    for (const file of tree) if (file.startsWith(`${relative}/`)) named.add(file);
  }
  const unlisted = tree.filter((file) => !named.has(file));
  if (unlisted.length) throw new Error(`${unlisted.slice(0, 3).join(", ")}${unlisted.length > 3 ? ", ..." : ""} ${unlisted.length === 1 ? "is" : "are"} in the plugin's directory and not named by its manifest (a hooks file, a script a hook runs, or a file of a skill)`);

  const hashed = tree.map((file) => ({ file, sha256: createHash("sha256").update(readRegularFile(path.join(dir, file), TREE_FILE_BYTES)).digest("hex") }));
  // The format of `hashPackageTree` (plugin_manifest.ts), over bytes read once here.
  const digest = createHash("sha256").update(hashed.map((entry) => `${entry.file}:${entry.sha256}`).join("\n")).digest("hex");
  const files = hashed.map((entry) => ({ path: path.relative(workspace, path.join(dir, entry.file)), sha256: entry.sha256 }));
  return { manifest, hooks, skills, files, digest };
}

/** The workspace's manifest plugins as they are now, each with whether it is in force. No code of theirs is run. */
export function inspectWorkspaceManifestPlugins(input: WorkspaceManifestInput): WorkspaceManifestPlugin[] {
  const root = path.join(input.workspace, WORKSPACE_MANIFEST_PLUGINS_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(root).sort().slice(0, ROOT_ENTRIES_LIMIT);
  } catch {
    return [];
  }
  const plugins: WorkspaceManifestPlugin[] = [];
  for (const name of names) {
    const dir = path.join(root, name);
    try {
      // A directory without a manifest is not a plugin (plugin files beside it are the in-process kind).
      if (!fs.lstatSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink()) continue;
      fs.lstatSync(path.join(dir, PLUGIN_MANIFEST_NAME));
    } catch {
      continue;
    }
    if (plugins.length >= PLUGINS_LIMIT) break;
    const id: ExtensionTrustId = { kind: "workspace-manifest", scope: input.workspace, key: path.relative(input.workspace, dir).split(path.sep).join("/") };
    const base = { name, dir, id, files: [] as ExtensionTrustFile[], hooks: [] as HooksFile[], skills: [] as string[] };
    let read: ReturnType<typeof readPlugin>;
    try {
      read = readPlugin(input.workspace, dir);
    } catch (error) {
      plugins.push({ ...base, status: "invalid", problem: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const known = { ...base, digest: read.digest, files: read.files, hooks: read.hooks, skills: read.skills };
    if (input.readOnly) {
      plugins.push({ ...known, status: "read_only" });
      continue;
    }
    if (!input.trusted) {
      plugins.push({ ...known, status: "untrusted_workspace" });
      continue;
    }
    // Policy before approval: what an administrator refuses is refused whatever the operator approved.
    let refusal: string | undefined;
    try {
      const decision = permitsPlugin(input.policy(), { path: dir, sha256: read.digest, fromWorkspace: true });
      if (!decision.allowed) refusal = decision.message;
    } catch (error) {
      refusal = `the managed policy cannot be read (${error instanceof Error ? error.message : String(error)})`;
    }
    if (refusal) {
      plugins.push({ ...known, status: "policy_refused", problem: refusal });
      continue;
    }
    const approval = extensionTrustEntry(input.approvals, id);
    if (!approval) {
      plugins.push({ ...known, status: "not_approved" });
      continue;
    }
    const approved = new Map((approval.files ?? []).map((file) => [file.path, file.sha256]));
    const changed = [
      ...read.files.filter((file) => approved.get(file.path) !== file.sha256).map((file) => file.path),
      ...[...approved.keys()].filter((file) => !read.files.some((now) => now.path === file)),
    ];
    if (approval.sha256 !== read.digest || changed.length) plugins.push({ ...known, status: "changed", changed: changed.length ? changed : [id.key] });
    else plugins.push({ ...known, status: "active" });
  }
  return plugins;
}
