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
    // The operator's list of trusted workspaces: the agent must not trust a workspace for itself.
    "trusted_workspaces.json",
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
import { InformationFlowBoundary } from "./core/egress.js";
/**
 * SecretsVault: Reversible token placeholder secrets quarantine.
 * Replaces live API keys and credentials with cryptographically unguessable scoped placeholders
 * before outbound transmission, and restores original values for local tool execution.
 * (DATA-001..004, REHYD-001..005, DISC-001..005)
 */
export class SecretsVault {
    boundary;
    refMap = new Map(); // placeholder -> secret
    secretMap = new Map(); // secret -> placeholder
    nextId = 1;
    static SECRET_PATTERNS = [
        // OpenAI / Anthropic / GitHub / Slack / AWS Tokens
        /(?:sk-[a-zA-Z0-9_\-]{20,64})/g,
        /(?:sk-ant-[a-zA-Z0-9_\-]{20,64})/g,
        /(?:ghp_[a-zA-Z0-9]{36})/g,
        /(?:github_pat_[a-zA-Z0-9_]{50,90})/g,
        /(?:gho_[a-zA-Z0-9]{36})/g,
        /(?:AKIA[0-9A-Z]{16})/g,
        /(?:xox[baprs]-[0-9a-zA-Z]{10,48})/g,
        // Bearer / Authorization headers
        /(?:Bearer\s+[a-zA-Z0-9_\-\.]{16,128})/g,
        // PEM format private keys (RSA, EC, DSA, OPENSSH)
        /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
        // Generic passwords or secrets in key=value / json format
        /(?:(?:password|passwd|secret|api_key|apiKey|token|access_key)["']?\s*[:=]\s*["'])([^"' \t\r\n]{8,96})(?:["'])/gi,
    ];
    constructor(boundary) {
        this.boundary = boundary || InformationFlowBoundary.getGlobalInstance();
    }
    /**
     * Quarantines detected credentials by replacing them with cryptographically unguessable scoped references (REHYD-001).
     */
    quarantine(text, options) {
        if (!text || typeof text !== "string") {
            return { sanitized: text, quarantinedCount: 0 };
        }
        const taskId = options?.taskId || "default_task";
        const sessionId = options?.sessionId || "default_session";
        const dest = options?.destination || "EXTERNAL_PUBLIC";
        // If explicit legacy requested, use predictable format for backward compatibility
        if (options?.legacy === true) {
            let sanitized = text;
            let quarantinedCount = 0;
            for (const pattern of SecretsVault.SECRET_PATTERNS) {
                sanitized = sanitized.replace(pattern, (...args) => {
                    const match = String(args[0]);
                    const captured = (args.length > 3 && typeof args[1] === "string") ? args[1] : match;
                    const rawSecret = String(captured || match);
                    if (rawSecret.length < 8 || rawSecret.includes("[SECRET_REF_") || rawSecret.includes("[NEXUS_SEC_REF_")) {
                        return match;
                    }
                    let placeholder = this.secretMap.get(rawSecret);
                    if (!placeholder) {
                        placeholder = `[SECRET_REF_${this.nextId++}]`;
                        this.secretMap.set(rawSecret, placeholder);
                        this.refMap.set(placeholder, rawSecret);
                        this.boundary.registerToken({
                            token: placeholder,
                            secret: rawSecret,
                            taskId,
                            sessionId,
                            sourceBoundary: "HOST_LOCAL",
                            targetBoundary: "EXTERNAL_PUBLIC",
                            createdAt: Date.now(),
                            rehydratedCount: 0,
                        });
                        quarantinedCount++;
                    }
                    return match.replace(rawSecret, placeholder);
                });
            }
            return { sanitized, quarantinedCount };
        }
        // Default: Cryptographically unguessable scoped tokenization (REHYD-001, REHYD-002)
        const result = this.boundary.evaluateEgress(text, dest, {
            taskId,
            sessionId,
            preferredProtectionMode: "REVERSIBLE_TOKENIZATION",
        });
        // Populate local refMap for synchronous local restore compatibility
        for (const item of result.classifiedSecrets) {
            const token = this.boundary.generateToken(item.secret, taskId, sessionId, "HOST_LOCAL", "EXTERNAL_PUBLIC");
            this.refMap.set(token, item.secret);
            this.secretMap.set(item.secret, token);
        }
        return {
            sanitized: result.sanitizedText || text,
            quarantinedCount: result.quarantinedCount,
        };
    }
    /**
     * Restores sanitized placeholder tokens back to real secrets for authorized local command execution (REHYD-004, DISC-004).
     */
    restore(sanitizedText, context) {
        if (!sanitizedText || typeof sanitizedText !== "string") {
            return sanitizedText;
        }
        // Fail closed: secrets are restored only for a sink the caller explicitly declares authorized.
        if (context?.isAuthorizedSink !== true) {
            return sanitizedText;
        }
        // Attempt authoritative rehydration through InformationFlowBoundary
        const rehydrated = this.boundary.rehydrate(sanitizedText, {
            taskId: context?.taskId || "default_task",
            sessionId: context?.sessionId || "default_session",
            isAuthorizedSink: true,
        });
        let restored = rehydrated.rehydrated;
        // Fallback for any legacy refMap entries (only for authorized sink)
        for (const [placeholder, secret] of this.refMap.entries()) {
            if (typeof restored === "string" && restored.includes(placeholder)) {
                restored = restored.replaceAll(placeholder, secret);
            }
        }
        return typeof restored === "string" ? restored : JSON.stringify(restored);
    }
    getMappingCount() {
        return this.refMap.size || this.boundary.getVaultSize();
    }
    clear() {
        this.refMap.clear();
        this.secretMap.clear();
        this.nextId = 1;
        this.boundary.clear();
    }
}
