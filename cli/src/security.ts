import * as fs from "node:fs";
import * as path from "node:path";

export interface SecurityPolicy {
  version?: string;
  blockedCommands?: string[];
  protectedPaths?: string[];
  allowedDomains?: string[];
  allowExternalSymlinks?: boolean;
}

const DEFAULT_BLOCKED_COMMANDS = [
  "rm -rf /",
  "rm -rf /*",
  "mkfs",
  "dd if=",
  ":(){ :|:& };:",
  "> /dev/sd",
  "shutdown",
  "reboot",
  "chmod -R 777 /",
  "chown -R root /",
];

const DEFAULT_PROTECTED_PATHS = [
  ".git",
  ".env",
  "id_rsa",
  "id_ed25519",
];

export class SecurityManager {
  private policy: SecurityPolicy;
  private workspace: string;

  constructor(workspace: string) {
    this.workspace = path.resolve(workspace);
    this.policy = this.loadPolicy();
  }

  public reload(): void {
    this.policy = this.loadPolicy();
  }

  private loadPolicy(): SecurityPolicy {
    const policyPath = path.join(this.workspace, ".nexus-security.json");
    if (fs.existsSync(policyPath)) {
      try {
        const raw = fs.readFileSync(policyPath, "utf-8");
        const parsed = JSON.parse(raw);
        return {
          blockedCommands: [
            ...DEFAULT_BLOCKED_COMMANDS,
            ...(Array.isArray(parsed.blockedCommands) ? parsed.blockedCommands : []),
          ],
          protectedPaths: [
            ...DEFAULT_PROTECTED_PATHS,
            ...(Array.isArray(parsed.protectedPaths) ? parsed.protectedPaths : []),
          ],
          allowedDomains: Array.isArray(parsed.allowedDomains) ? parsed.allowedDomains : undefined,
          allowExternalSymlinks: Boolean(parsed.allowExternalSymlinks),
        };
      } catch {
        // Fallback to defaults
      }
    }

    return {
      blockedCommands: [...DEFAULT_BLOCKED_COMMANDS],
      protectedPaths: [...DEFAULT_PROTECTED_PATHS],
      allowedDomains: undefined,
      allowExternalSymlinks: false,
    };
  }

  public isCommandBlocked(command: string): { blocked: boolean; reason?: string } {
    const trimmed = command.trim();
    for (const pattern of this.policy.blockedCommands || []) {
      if (pattern && trimmed.includes(pattern)) {
        return {
          blocked: true,
          reason: `Security Policy Violation: Command matches blocked pattern '${pattern}'`,
        };
      }
    }
    return { blocked: false };
  }

  public isPathProtected(targetPath: string): { protected: boolean; reason?: string } {
    const clean = targetPath.replace(/\\/g, "/");
    for (const pattern of this.policy.protectedPaths || []) {
      if (
        clean === pattern ||
        clean.startsWith(pattern + "/") ||
        clean.includes("/" + pattern) ||
        clean.endsWith("/" + pattern) ||
        clean.endsWith(pattern)
      ) {
        return {
          protected: true,
          reason: `Security Policy Violation: Path '${targetPath}' is protected under security policy`,
        };
      }
    }
    return { protected: false };
  }

  public getPolicy(): SecurityPolicy {
    return this.policy;
  }
}
