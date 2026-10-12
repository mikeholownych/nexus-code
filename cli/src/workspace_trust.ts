import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/** Workspace files that configure MCP servers, and directories plugins are loaded from: used only when trusted. */
export const WORKSPACE_MCP_FILES = [".mcp.json", "mcp.json"];
export const WORKSPACE_PLUGIN_DIRS = [path.join(".nexus", "plugins"), "plugins"];

/**
 * The workspace's own MCP configuration files and plugin modules that exist but are not loaded because the workspace
 * is not trusted (or the session is read-only). Empty when there are none or the workspace is trusted.
 */
export function untrustedWorkspaceExtensions(workspace: string, readOnly = false): string[] {
  if (isWorkspaceTrusted(workspace, readOnly)) return [];
  const root = path.resolve(workspace);
  const found = WORKSPACE_MCP_FILES.map((f) => path.join(root, f)).filter((f) => fs.existsSync(f));
  for (const dir of WORKSPACE_PLUGIN_DIRS) {
    try {
      for (const name of fs.readdirSync(path.join(root, dir))) {
        if (name.endsWith(".js") || name.endsWith(".mjs")) found.push(path.join(root, dir, name));
      }
    } catch {}
  }
  return found;
}

export function getTrustStorePath(): string {
  return path.join(os.homedir(), ".config", "nexus", "trusted_workspaces.json");
}

/**
 * Check if the given workspace is explicitly trusted by the operator.
 * In --read-only mode, workspace trust never authorizes executing project plugins/MCP.
 */
export function isWorkspaceTrusted(workspace: string, readOnly = false): boolean {
  if (readOnly) return false;
  if (process.env.NEXUS_TRUST_WORKSPACE === "1") return true;

  try {
    const resolved = path.resolve(workspace);
    const realWs = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
    const storePath = getTrustStorePath();
    if (!fs.existsSync(storePath)) return false;
    const content = JSON.parse(fs.readFileSync(storePath, "utf8"));
    if (Array.isArray(content)) {
      return content.includes(realWs);
    }
    if (content && typeof content === "object" && Array.isArray(content.trustedPaths)) {
      return content.trustedPaths.includes(realWs);
    }
  } catch {}
  return false;
}

/** The trusted workspaces (real paths), as recorded in the trust store. */
export function listTrustedWorkspaces(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(getTrustStorePath(), "utf8"));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.trustedPaths) ? raw.trustedPaths : [];
    return list.filter((p: unknown): p is string => typeof p === "string");
  } catch {
    return [];
  }
}

/** Records (or removes) the operator's trust in a workspace. Returns its real path; throws when the store cannot be written. */
export function setWorkspaceTrusted(workspace: string, trusted: boolean): string {
  const resolved = path.resolve(workspace);
  const realWs = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  const storePath = getTrustStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
  const list = listTrustedWorkspaces().filter((p) => p !== realWs);
  if (trusted) list.push(realWs);
  const temp = `${storePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ trustedPaths: list }, null, 2), { mode: 0o600 });
  fs.renameSync(temp, storePath);
  return realWs;
}
