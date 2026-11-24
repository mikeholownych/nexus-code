/**
 * HK-2: `nexus-plugin.json` — the installable plugin package manifest.
 *
 * A plugin package declares its name, version, contributions (hooks, skills, verifiers, MCP servers) and the
 * permissions it requires. Install refuses a package whose permissions exceed the managed policy allowlist.
 * The types here are the source of truth for docs; a generated schema may follow in a later slice.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { decodeStrictUtf8, parseStrictJson, readHardenedFile } from "./strict_json.js";

export const PLUGIN_MANIFEST_VERSION = 1;
export const PLUGIN_MANIFEST_NAME = "nexus-plugin.json";
export const PLUGIN_MANIFEST_LIMIT = 64 * 1024;

const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PERMISSIONS = ["hooks", "skills", "verifiers", "mcp", "tools"] as const;
export type PluginPermission = (typeof PERMISSIONS)[number];

export interface PluginContributions {
  hooks?: string[];
  skills?: string[];
  verifiers?: string[];
  mcp?: string[];
}

/** A `nexus-plugin.json` at the root of an installable package. */
export interface PluginManifest {
  version: 1;
  name: string;
  pluginVersion: string;
  description?: string;
  contributions?: PluginContributions;
  /** Capabilities the package needs. Install refuses any not permitted by managed policy. */
  permissions: PluginPermission[];
}

export class InvalidPluginManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPluginManifestError";
  }
}

export function isPluginName(value: string): boolean {
  return PLUGIN_NAME_RE.test(value);
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function stringList(field: string, value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) throw new InvalidPluginManifestError(`${field} must be an array of strings`);
  if (value.length > limit) throw new InvalidPluginManifestError(`${field} has too many entries (max ${limit})`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item || item.length > 256) throw new InvalidPluginManifestError(`${field} entries must be non-empty strings up to 256 characters`);
    out.push(item);
  }
  return out;
}

/** Validates and returns a PluginManifest. Unknown keys are refused. */
export function parsePluginManifest(raw: unknown): PluginManifest {
  if (!isRecord(raw)) throw new InvalidPluginManifestError("manifest is not an object");
  const keys = Object.keys(raw);
  const allowed = new Set(["version", "name", "pluginVersion", "description", "contributions", "permissions"]);
  for (const key of keys) {
    if (!allowed.has(key)) throw new InvalidPluginManifestError(`unknown key '${key}'`);
  }
  if (raw.version !== 1) throw new InvalidPluginManifestError(`version must be 1 (got ${String(raw.version)})`);
  if (typeof raw.name !== "string" || !isPluginName(raw.name)) throw new InvalidPluginManifestError("name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}");
  if (typeof raw.pluginVersion !== "string" || !raw.pluginVersion || raw.pluginVersion.length > 64) {
    throw new InvalidPluginManifestError("pluginVersion must be a non-empty string up to 64 characters");
  }
  if (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.length > 512)) {
    throw new InvalidPluginManifestError("description must be a string up to 512 characters");
  }
  if (!Array.isArray(raw.permissions) || raw.permissions.length === 0 || raw.permissions.length > 16) {
    throw new InvalidPluginManifestError("permissions must be a non-empty array (max 16)");
  }
  const permissions: PluginPermission[] = [];
  for (const p of raw.permissions) {
    if (typeof p !== "string" || !(PERMISSIONS as readonly string[]).includes(p)) {
      throw new InvalidPluginManifestError(`permissions entry '${String(p)}' is not one of ${PERMISSIONS.join(", ")}`);
    }
    if (permissions.includes(p as PluginPermission)) throw new InvalidPluginManifestError(`duplicate permission '${p}'`);
    permissions.push(p as PluginPermission);
  }

  let contributions: PluginContributions | undefined;
  if (raw.contributions !== undefined) {
    if (!isRecord(raw.contributions)) throw new InvalidPluginManifestError("contributions must be an object");
    const cKeys = Object.keys(raw.contributions);
    const cAllowed = new Set(["hooks", "skills", "verifiers", "mcp"]);
    for (const key of cKeys) {
      if (!cAllowed.has(key)) throw new InvalidPluginManifestError(`unknown contributions key '${key}'`);
    }
    contributions = {};
    if (raw.contributions.hooks !== undefined) contributions.hooks = stringList("contributions.hooks", raw.contributions.hooks, 64);
    if (raw.contributions.skills !== undefined) contributions.skills = stringList("contributions.skills", raw.contributions.skills, 64);
    if (raw.contributions.verifiers !== undefined) contributions.verifiers = stringList("contributions.verifiers", raw.contributions.verifiers, 64);
    if (raw.contributions.mcp !== undefined) contributions.mcp = stringList("contributions.mcp", raw.contributions.mcp, 64);
  }

  const manifest: PluginManifest = {
    version: 1,
    name: raw.name,
    pluginVersion: raw.pluginVersion,
    permissions,
  };
  if (typeof raw.description === "string") manifest.description = raw.description;
  if (contributions) manifest.contributions = contributions;
  return manifest;
}

/** Reads and validates `nexus-plugin.json` from a package directory. */
export function loadPluginManifest(packageDir: string): { manifest: PluginManifest; sha256: string; bytes: Buffer } {
  const file = path.join(packageDir, PLUGIN_MANIFEST_NAME);
  const read = readHardenedFile(file, { maxBytes: PLUGIN_MANIFEST_LIMIT });
  if (!read) throw new InvalidPluginManifestError(`missing ${PLUGIN_MANIFEST_NAME} in ${packageDir}`);
  const text = decodeStrictUtf8(read.bytes);
  const raw = parseStrictJson(text);
  const manifest = parsePluginManifest(raw);
  return { manifest, sha256: read.sha256, bytes: Buffer.from(read.bytes) };
}

/** SHA-256 of every regular file under dir (relative paths, sorted). Used for install receipts and verify. */
export function hashPackageTree(root: string): { files: Array<{ path: string; sha256: string }>; digest: string } {
  const files: Array<{ path: string; sha256: string }> = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".nexus-install.json") continue;
      const abs = path.join(dir, entry.name);
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, child);
      else if (entry.isFile()) {
        const data = fs.readFileSync(abs);
        files.push({ path: child, sha256: createHash("sha256").update(data).digest("hex") });
      }
    }
  };
  walk(root, "");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = createHash("sha256")
    .update(files.map((f) => `${f.path}:${f.sha256}`).join("\n"))
    .digest("hex");
  return { files, digest };
}
