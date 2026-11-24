/**
 * HK-2: install, list, remove and verify plugin packages under `~/.config/nexus/installed-plugins/`.
 *
 * Install from a local directory that contains `nexus-plugin.json`. A git URL pinned to a full commit hash is a
 * follow-up slice. The install receipt records the tree digest so `verify` detects modified installs. No auto-update.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writePrivateFile } from "./durable_file.js";
import {
  hashPackageTree,
  loadPluginManifest,
  PLUGIN_MANIFEST_NAME,
  type PluginManifest,
  type PluginPermission,
  InvalidPluginManifestError,
  isPluginName,
} from "./plugin_manifest.js";
import { decodeStrictUtf8, parseStrictJson, readHardenedFile } from "./strict_json.js";

export const INSTALL_RECEIPT_NAME = ".nexus-install.json";
export const INSTALL_RECEIPT_VERSION = 1;

export interface PluginInstallReceipt {
  version: 1;
  name: string;
  pluginVersion: string;
  /** Absolute path of the source at install time (local path). */
  source: string;
  sourceKind: "local";
  /** Full commit hash when sourceKind is git (reserved). */
  commit?: string;
  installedAt: string;
  /** SHA-256 of the manifest bytes at install. */
  manifestSha256: string;
  /** Digest of relative path:sha256 lines for every regular file except the receipt. */
  treeDigest: string;
  permissions: PluginPermission[];
}

export class PluginInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginInstallError";
  }
}

export function installedPluginsRoot(home = os.homedir()): string {
  return path.join(home, ".config", "nexus", "installed-plugins");
}

function receiptPath(installDir: string): string {
  return path.join(installDir, INSTALL_RECEIPT_NAME);
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === INSTALL_RECEIPT_NAME) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

/** Permissions the managed policy currently allows for plugins. Empty list means none (fail closed for install). */
export type PermissionGate = (permissions: PluginPermission[]) => string | undefined;

/**
 * Installs a local plugin package into the install root.
 * `permissionGate` returns a refusal reason when the package's permissions exceed policy.
 */
export function installPluginFromLocal(
  sourceDir: string,
  options: { home?: string; permissionGate?: PermissionGate; now?: () => string } = {},
): { receipt: PluginInstallReceipt; installDir: string; manifest: PluginManifest } {
  const abs = path.resolve(sourceDir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new PluginInstallError(`source is not a directory: ${abs}`);
  }
  const { manifest, sha256: manifestSha256 } = loadPluginManifest(abs);
  const refusal = options.permissionGate?.(manifest.permissions);
  if (refusal) throw new PluginInstallError(refusal);

  const root = installedPluginsRoot(options.home);
  fs.mkdirSync(root, { recursive: true });
  const installDir = path.join(root, manifest.name);
  if (fs.existsSync(installDir)) {
    throw new PluginInstallError(`plugin '${manifest.name}' is already installed at ${installDir}; remove it first`);
  }

  const stagingParent = fs.mkdtempSync(path.join(root, `.staging-${manifest.name}-`));
  const staged = path.join(stagingParent, manifest.name);
  try {
    copyDir(abs, staged);
    const { digest: treeDigest } = hashPackageTree(staged);
    const receipt: PluginInstallReceipt = {
      version: 1,
      name: manifest.name,
      pluginVersion: manifest.pluginVersion,
      source: abs,
      sourceKind: "local",
      installedAt: (options.now ?? (() => new Date().toISOString()))(),
      manifestSha256,
      treeDigest,
      permissions: [...manifest.permissions],
    };
    writePrivateFile(receiptPath(staged), `${JSON.stringify(receipt, null, 2)}\n`);
    fs.renameSync(staged, installDir);
    return { receipt, installDir, manifest };
  } finally {
    fs.rmSync(stagingParent, { recursive: true, force: true });
  }
}

export function readInstallReceipt(installDir: string): PluginInstallReceipt {
  const read = readHardenedFile(receiptPath(installDir), { maxBytes: 64 * 1024 });
  if (!read) throw new PluginInstallError("install receipt is missing");
  const raw = parseStrictJson(decodeStrictUtf8(read.bytes));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PluginInstallError("install receipt is not an object");
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) throw new PluginInstallError(`unsupported install receipt version ${String(r.version)}`);
  if (typeof r.name !== "string" || typeof r.pluginVersion !== "string" || typeof r.source !== "string") {
    throw new PluginInstallError("install receipt is missing required fields");
  }
  if (r.sourceKind !== "local") throw new PluginInstallError(`install receipt sourceKind '${String(r.sourceKind)}' is not supported`);
  if (typeof r.installedAt !== "string" || typeof r.manifestSha256 !== "string" || typeof r.treeDigest !== "string") {
    throw new PluginInstallError("install receipt is missing hash fields");
  }
  if (!Array.isArray(r.permissions)) throw new PluginInstallError("install receipt permissions must be an array");
  return {
    version: 1,
    name: r.name,
    pluginVersion: r.pluginVersion,
    source: r.source,
    sourceKind: "local",
    installedAt: r.installedAt,
    manifestSha256: r.manifestSha256,
    treeDigest: r.treeDigest,
    permissions: r.permissions as PluginPermission[],
    ...(typeof r.commit === "string" ? { commit: r.commit } : {}),
  };
}

export function listInstalledPlugins(home = os.homedir()): Array<{ name: string; installDir: string; receipt: PluginInstallReceipt }> {
  const root = installedPluginsRoot(home);
  if (!fs.existsSync(root)) return [];
  const out: Array<{ name: string; installDir: string; receipt: PluginInstallReceipt }> = [];
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith(".")) continue;
    const installDir = path.join(root, name);
    if (!fs.statSync(installDir).isDirectory()) continue;
    try {
      out.push({ name, installDir, receipt: readInstallReceipt(installDir) });
    } catch {
      // Skip broken installs; verify reports them when named.
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

export function removeInstalledPlugin(name: string, home = os.homedir()): string {
  if (!isPluginName(name)) throw new PluginInstallError("invalid plugin name");
  const root = path.resolve(installedPluginsRoot(home));
  const installDir = path.resolve(root, name);
  if (path.dirname(installDir) !== root) throw new PluginInstallError("plugin path escapes the installed plugins directory");
  if (!fs.existsSync(installDir)) throw new PluginInstallError(`plugin '${name}' is not installed`);
  fs.rmSync(installDir, { recursive: true, force: true });
  return installDir;
}

export type VerifyResult =
  | { ok: true; name: string; treeDigest: string }
  | { ok: false; name: string; reason: string };

/** Recomputes the tree digest and compares to the receipt. Detects modified installs. */
export function verifyInstalledPlugin(name: string, home = os.homedir()): VerifyResult {
  const installDir = path.join(installedPluginsRoot(home), name);
  if (!fs.existsSync(installDir)) return { ok: false, name, reason: "not installed" };
  let receipt: PluginInstallReceipt;
  try {
    receipt = readInstallReceipt(installDir);
  } catch (error) {
    return { ok: false, name, reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    loadPluginManifest(installDir);
  } catch (error) {
    return { ok: false, name, reason: error instanceof InvalidPluginManifestError ? error.message : String(error) };
  }
  const { digest } = hashPackageTree(installDir);
  if (digest !== receipt.treeDigest) {
    return { ok: false, name, reason: `tree digest mismatch (receipt ${receipt.treeDigest.slice(0, 12)}…, now ${digest.slice(0, 12)}…)` };
  }
  return { ok: true, name, treeDigest: digest };
}

/** Content hash helper exported for tests. */
export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
