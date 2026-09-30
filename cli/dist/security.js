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
    vault = new SecretsVault();
    getVault() {
        return this.vault;
    }
}
/**
 * SecretsVault: Reversible token placeholder secrets quarantine.
 * Replaces live API keys and credentials with `[SECRET_REF_N]` placeholders
 * before outbound transmission, and restores original values for local tool execution.
 */
export class SecretsVault {
    refMap = new Map(); // placeholder -> secret
    secretMap = new Map(); // secret -> placeholder
    nextId = 1;
    static SECRET_PATTERNS = [
        // OpenAI / Anthropic / GitHub / Slack / AWS Tokens
        /(?:sk-[a-zA-Z0-9_\-]{20,64})/g,
        /(?:ghp_[a-zA-Z0-9]{36})/g,
        /(?:github_pat_[a-zA-Z0-9_]{50,90})/g,
        /(?:AKIA[0-9A-Z]{16})/g,
        /(?:xox[baprs]-[0-9a-zA-Z]{10,48})/g,
        // Bearer / Authorization headers
        /(?:Bearer\s+[a-zA-Z0-9_\-\.]{16,128})/g,
        // Generic passwords or secrets in key=value / json format
        /(?:(?:password|secret|api_key|apiKey|token)["']?\s*[:=]\s*["'])([^"' \t\r\n]{8,64})(?:["'])/gi,
    ];
    /**
     * Quarantines detected credentials by replacing them with deterministic `[SECRET_REF_N]` references.
     */
    quarantine(text) {
        let sanitized = text;
        let quarantinedCount = 0;
        for (const pattern of SecretsVault.SECRET_PATTERNS) {
            sanitized = sanitized.replace(pattern, (...args) => {
                const match = String(args[0]);
                const captured = (args.length > 3 && typeof args[1] === "string") ? args[1] : match;
                const rawSecret = String(captured || match);
                // Avoid quarantining short words or common code terms
                if (rawSecret.length < 8 || rawSecret.includes("[SECRET_REF_")) {
                    return match;
                }
                let placeholder = this.secretMap.get(rawSecret);
                if (!placeholder) {
                    placeholder = `[SECRET_REF_${this.nextId++}]`;
                    this.secretMap.set(rawSecret, placeholder);
                    this.refMap.set(placeholder, rawSecret);
                    quarantinedCount++;
                }
                return match.replace(rawSecret, placeholder);
            });
        }
        return { sanitized, quarantinedCount };
    }
    /**
     * Restores sanitized placeholder tokens back to real secrets for local command execution.
     */
    restore(sanitizedText) {
        let restored = sanitizedText;
        for (const [placeholder, secret] of this.refMap.entries()) {
            restored = restored.replaceAll(placeholder, secret);
        }
        return restored;
    }
    getMappingCount() {
        return this.refMap.size;
    }
    clear() {
        this.refMap.clear();
        this.secretMap.clear();
        this.nextId = 1;
    }
}
