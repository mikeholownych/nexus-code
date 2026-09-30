import * as fs from "node:fs";
import * as path from "node:path";
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
    policy;
    workspace;
    constructor(workspace) {
        this.workspace = path.resolve(workspace);
        this.policy = this.loadPolicy();
    }
    reload() {
        this.policy = this.loadPolicy();
    }
    loadPolicy() {
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
            }
            catch {
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
    isCommandBlocked(command) {
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
    isPathProtected(targetPath) {
        const clean = targetPath.replace(/\\/g, "/");
        for (const pattern of this.policy.protectedPaths || []) {
            if (clean === pattern ||
                clean.startsWith(pattern + "/") ||
                clean.includes("/" + pattern) ||
                clean.endsWith("/" + pattern) ||
                clean.endsWith(pattern)) {
                return {
                    protected: true,
                    reason: `Security Policy Violation: Path '${targetPath}' is protected under security policy`,
                };
            }
        }
        return { protected: false };
    }
    getPolicy() {
        return this.policy;
    }
}
