import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writePrivateFile } from "./core/durable_file.js";
import { clampEnvTrust, type EffectivePolicy } from "./core/managed_policy.js";
import { ManagedPolicyError } from "./core/managed_policy_load.js";
import { emitPolicyNotice, managedPolicy, processPolicyHost } from "./core/policy_runtime.js";

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
 * `NEXUS_TRUST_WORKSPACE=1` counts unless managed policy sets `workspace.disable_env_trust`; `policy` is the effective
 * policy to decide under (the process's managed policy when omitted).
 */
export function isWorkspaceTrusted(workspace: string, readOnly = false, policy?: EffectivePolicy): boolean {
  if (readOnly) return false;
  if (envTrustRequested() && envTrustCounts(policy)) return true;
  return isWorkspaceListed(workspace);
}

/** `NEXUS_TRUST_WORKSPACE=1` is set. Whether it counts is the policy's decision. */
export function envTrustRequested(): boolean {
  return process.env.NEXUS_TRUST_WORKSPACE === "1";
}

function envTrustCounts(policy: EffectivePolicy | undefined): boolean {
  let decision: ReturnType<typeof clampEnvTrust>;
  try {
    decision = clampEnvTrust(policy ?? managedPolicy(), true);
  } catch (error) {
    // A managed policy that cannot be read cannot be shown to permit the variable: it does not count.
    if (error instanceof ManagedPolicyError) return false;
    throw error;
  }
  if (decision.notice) emitPolicyNotice(`nexus: ${decision.notice}`);
  return decision.trusted;
}

/** The operator's trust store lists the workspace (by its real path). The environment is not consulted. */
export function isWorkspaceListed(workspace: string): boolean {
  try {
    const realWs = realWorkspace(workspace);
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

/** The path a workspace is recorded under: its real path, or the resolved path when it does not exist. */
export function realWorkspace(workspace: string): string {
  const resolved = path.resolve(workspace);
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
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
  const realWs = realWorkspace(workspace);
  const storePath = getTrustStorePath();
  const list = listTrustedWorkspaces().filter((p) => p !== realWs);
  if (trusted) list.push(realWs);
  writePrivateFile(storePath, JSON.stringify({ trustedPaths: list }, null, 2), { durable: true });
  // GV-1: trusting a workspace is the operator's decision about its project policy file as it is now. The file's
  // hash is recorded, so its relaxations apply until the file changes; a changed file needs this decision again.
  if (trusted) {
    try {
      processPolicyHost().approveProjectPolicy(realWs, new Date().toISOString());
    } catch (error) {
      emitPolicyNotice(`nexus: the project policy of ${realWs} was not recorded as approved (${error instanceof ManagedPolicyError ? "managed policy error" : (error as Error).message}); its relaxations stay off.`);
    }
  }
  return realWs;
}
