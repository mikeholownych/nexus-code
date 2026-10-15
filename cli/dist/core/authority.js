/**
 * Authority Admission & Resource Confinement Engine
 * Nexus Issue #12 — WP-02 (INC-03, AUTH-001..012, ACT-001..004, RES-001..004)
 */
import * as path from "node:path";
import { extractTargetResources, } from "./spine.js";
import { defaultRegistry } from "./capabilities.js";
/**
 * Standard safe commands allowed under --read-only mode.
 */
export const DEFAULT_SAFE_READONLY_COMMAND_REGEX = /^\s*(ls|dir|pwd|echo|cat|head|tail|grep|rg|find|diff|wc|which|where|git\s+(status|log|diff|branch|show)|npm\s+list|node\s+-v|rustc\s+-v)(\s+.*)?$/i;
/**
 * Validates whether a shell command is safe to execute under read-only mode.
 * Enforces AUTH-009 and AUTH-010:
 * 1. Rejects shell composition, pipelines, command substitutions, redirections, and separators.
 * 2. Validates base executable against safe command allowlist.
 * 3. Inspects executable arguments to prevent subcommands or options that perform mutation.
 */
export function isSafeReadOnlyCommand(command, customRegex, workspace) {
    if (!command || typeof command !== "string")
        return false;
    const trimmed = command.trim();
    if (trimmed.length === 0)
        return false;
    // 1. Strict rejection of shell control, chaining, substitution, and redirection metacharacters:
    // ;      - command separator
    // &      - background operator or logical AND (&&)
    // |      - pipeline or logical OR (||)
    // >      - output redirection (truncate or append)
    // <      - input redirection or process substitution
    // $      - variable / command / arithmetic substitution ($(cmd), $VAR, $((expr)))
    // ~      - home directory expansion (~/...)
    // `      - backtick command substitution (`cmd`)
    // \n, \r - newline command separators
    // (, )   - subshell execution / grouping
    // {, }   - command block grouping
    // \      - escape character
    if (/[><&;|`$~\n\r(){}\\]/.test(trimmed)) {
        return false;
    }
    // 2. Validate against the safe read-only command allowlist
    const regex = customRegex || DEFAULT_SAFE_READONLY_COMMAND_REGEX;
    if (!regex.test(trimmed)) {
        return false;
    }
    // 2b. Path confinement: reject arguments with absolute paths escaping workspace or escaping traversal (..):
    const rawTokens = trimmed.split(/\s+/);
    const resolvedWs = workspace ? path.resolve(workspace) : undefined;
    for (let i = 1; i < rawTokens.length; i++) {
        const raw = rawTokens[i];
        // Strip leading/trailing quotes if present
        const t = raw.replace(/^['"]|['"]$/g, "");
        const candidatePath = t.includes("=") && t.startsWith("-") ? t.split("=")[1] : t;
        if (candidatePath.startsWith("/")) {
            if (!resolvedWs || !path.resolve(candidatePath).startsWith(resolvedWs)) {
                return false;
            }
        }
        if (candidatePath.includes("..")) {
            const target = resolvedWs ? path.resolve(resolvedWs, candidatePath) : path.resolve(candidatePath);
            if (!resolvedWs || !target.startsWith(resolvedWs)) {
                return false;
            }
        }
    }
    // 3. Inspect command-specific argument escapes for allowed executables:
    // 3a. 'find' command: reject mutating or execution arguments (-delete, -exec, -ok, -fprint, etc.)
    if (/^\s*find\b/i.test(trimmed)) {
        if (/\s-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b/i.test(trimmed)) {
            return false;
        }
    }
    // 3b. 'git' command: reject output redirection flags (--output, -o)
    if (/^\s*git\b/i.test(trimmed)) {
        if (/\s(--output\b|-o\s)/i.test(trimmed) || /\s--output=/i.test(trimmed)) {
            return false;
        }
        // 3c. 'git branch': only allow inspection/listing; reject creation, deletion, renaming
        if (/^\s*git\s+branch\b/i.test(trimmed)) {
            // Reject deletion (-d, -D, --delete), renaming (-m, -M, --move), copying (-c, -C, --copy), upstream setting (-u)
            if (/\s(-[dDmMceCu]|--delete|--move|--copy|--set-upstream|--edit-description)\b/i.test(trimmed)) {
                return false;
            }
            // Inspect remaining tokens after 'git branch': any non-flag token not preceded by -l or --list is branch creation/mutation
            const afterBranch = trimmed.replace(/^\s*git\s+branch\s*/i, "").trim();
            if (afterBranch.length > 0) {
                const tokens = afterBranch.split(/\s+/);
                let expectsPattern = false;
                for (const token of tokens) {
                    if (token === "-l" || token === "--list") {
                        expectsPattern = true;
                    }
                    else if (token.startsWith("-")) {
                        // Safe flag, e.g. -a, -r, -v, -vv, --remotes, --all, --show-current
                        expectsPattern = false;
                    }
                    else if (expectsPattern) {
                        // Allowed pattern argument for --list (e.g. "feat/*")
                        expectsPattern = false;
                    }
                    else {
                        // Positional argument without --list means branch creation/mutation: reject
                        return false;
                    }
                }
            }
        }
    }
    // 3d. 'rg' / 'grep' command: reject flags that execute programs (--pre, --pre-glob, --hostname-bin)
    if (/^\s*(rg|grep)\b/i.test(trimmed)) {
        if (/\s(--pre\b|--pre-glob\b|--pre=|--hostname-bin\b)/i.test(trimmed)) {
            return false;
        }
    }
    return true;
}
/**
 * Authority Admission & Resource Confinement Engine
 */
export class AuthorityAdmissionEngine {
    fullAccess = false;
    readOnly = false;
    grants = [];
    allowedDomains = null;
    safeCommandRegex = DEFAULT_SAFE_READONLY_COMMAND_REGEX;
    registry;
    constructor(config = {}) {
        this.registry = config.registry ?? defaultRegistry;
        this.fullAccess = Boolean(config.fullAccess);
        this.readOnly = Boolean(config.readOnly);
        this.grants = config.grants ? [...config.grants] : [];
        if (config.allowedDomains && config.allowedDomains.length > 0) {
            this.allowedDomains = new Set(config.allowedDomains);
        }
        if (config.safeReadOnlyCommandRegex) {
            this.safeCommandRegex = config.safeReadOnlyCommandRegex;
        }
    }
    setFullAccess(enabled) {
        this.fullAccess = enabled;
    }
    isFullAccess() {
        return this.fullAccess;
    }
    setReadOnly(enabled) {
        this.readOnly = enabled;
    }
    isReadOnly() {
        return this.readOnly;
    }
    addGrant(grant) {
        this.grants.push(grant);
    }
    clearGrants() {
        this.grants = [];
    }
    getGrants() {
        return [...this.grants];
    }
    /**
     * Authority Admission Gate (Stage 3A)
     * Evaluates capability authority, domain isolation, and read-only enforcement.
     */
    async admit(request, context) {
        const actor = request.actor || "agent";
        const domain = request.executionDomain || "agent_orchestration";
        const toolName = request.toolName;
        // Check domain allowlist if configured
        if (this.allowedDomains && !this.allowedDomains.has(domain) && !this.allowedDomains.has("*")) {
            return {
                admitted: false,
                reason: `AUTH-012: Execution domain '${domain}' is not permitted by domain policy.`,
            };
        }
        // Resolve canonical capability
        const capability = this.registry.getByToolName(toolName);
        if (!capability) {
            return {
                admitted: false,
                reason: `AUTH-003: Unrecognized tool name '${toolName}' cannot be mapped to canonical capability.`,
            };
        }
        const effectiveReadOnly = this.readOnly || Boolean(context.readOnly);
        // Read-only gating (AUTH-009, AUTH-010)
        if (effectiveReadOnly) {
            if (capability.id === "proc_exec" || capability.id === "command_execution" || toolName === "run_command") {
                const cmd = request.args?.command;
                if (!isSafeReadOnlyCommand(cmd, this.safeCommandRegex)) {
                    return {
                        admitted: false,
                        reason: `AUTH-010: Read-only mode violation: Command '${cmd}' is not permitted in read-only mode. Only safe inspection commands are permitted.`,
                    };
                }
            }
            else if (capability.mutating) {
                return {
                    admitted: false,
                    reason: `AUTH-009: Read-only mode violation: Capability '${capability.id}' mutates candidate state and is denied in read-only mode.`,
                };
            }
        }
        // Full-access bypass of further grant checks (AUTH-007, AUTH-008)
        if (this.fullAccess) {
            return {
                admitted: true,
                effectiveScope: "full_access",
            };
        }
        // If explicit grants are defined, evaluate matching grant (AUTH-001, AUTH-006)
        if (this.grants.length > 0) {
            const matchingGrant = this.findMatchingGrant(actor, domain, capability.id, toolName);
            if (!matchingGrant) {
                return {
                    admitted: false,
                    reason: `AUTH-006: Fail-closed: No authority grant authorizes capability '${capability.id}' for actor '${actor}' in domain '${domain}'.`,
                };
            }
            return {
                admitted: true,
                effectiveScope: matchingGrant.scope,
            };
        }
        // Default workspace authority grant if no explicit grants defined
        return {
            admitted: true,
            effectiveScope: "workspace",
        };
    }
    /**
     * Resource Confinement Gate (Stage 3B)
     * Enforces workspace boundary containment, cwd confinement, and exact/subtree scopes.
     */
    async confine(request, context) {
        const wsRoot = path.resolve(context.workspaceRoot || process.cwd());
        const actor = request.actor || "agent";
        const domain = request.executionDomain || "agent_orchestration";
        const capability = this.registry.getByToolName(request.toolName);
        const capId = capability ? capability.id : request.toolName;
        // In full-access mode, resource confinement is broad (AUTH-007, AUTH-008)
        if (this.fullAccess) {
            return { confined: true };
        }
        // Determine effective scope from matching grant
        let effectiveScope = "workspace";
        let allowedResources = undefined;
        if (this.grants.length > 0) {
            const grant = this.findMatchingGrant(actor, domain, capId, request.toolName);
            if (grant) {
                effectiveScope = grant.scope;
                allowedResources = grant.resources;
                if (effectiveScope === "full_access") {
                    return { confined: true };
                }
            }
        }
        // 1. Verify subprocess cwd confinement (RES-002, AUTH-011)
        if ((capId === "proc_exec" || capId === "command_execution" || request.toolName === "run_command") && request.args?.cwd) {
            const cwdStr = String(request.args.cwd).trim();
            const targetCwd = path.isAbsolute(cwdStr) ? path.normalize(cwdStr) : path.resolve(wsRoot, cwdStr);
            const rel = path.relative(wsRoot, targetCwd);
            if (rel.startsWith("..") || path.isAbsolute(rel)) {
                return {
                    confined: false,
                    reason: `RES-002: Security Violation: Working directory '${cwdStr}' escapes workspace jail.`,
                };
            }
        }
        // 2. Extract and verify all target resource paths (RES-001, RES-004, AUTH-004, AUTH-005)
        const targets = extractTargetResources(request.toolName, request.args);
        for (const target of targets) {
            const cleanPath = target.trim();
            if (!cleanPath)
                continue;
            const absTarget = path.isAbsolute(cleanPath)
                ? path.normalize(cleanPath)
                : path.resolve(wsRoot, cleanPath);
            // Verify path stays within workspaceRoot (RES-004)
            const relToWs = path.relative(wsRoot, absTarget);
            if (relToWs.startsWith("..") || path.isAbsolute(relToWs)) {
                return {
                    confined: false,
                    reason: `RES-004: Security Violation: Path '${cleanPath}' escapes workspace jail.`,
                };
            }
            // Check scope-specific constraints (AUTH-004, AUTH-005)
            if (effectiveScope === "exact") {
                if (!allowedResources || allowedResources.length === 0) {
                    return {
                        confined: false,
                        reason: `AUTH-004: Exact scope grant requires specific resources list.`,
                    };
                }
                const matchesExact = allowedResources.some((r) => {
                    const absAllowed = path.isAbsolute(r) ? path.normalize(r) : path.resolve(wsRoot, r);
                    return absAllowed === absTarget;
                });
                if (!matchesExact) {
                    return {
                        confined: false,
                        reason: `AUTH-005: Security Violation: Path '${cleanPath}' does not match any exact authorized resource (no sibling inheritance).`,
                    };
                }
            }
            else if (effectiveScope === "subtree") {
                if (!allowedResources || allowedResources.length === 0) {
                    return {
                        confined: false,
                        reason: `AUTH-004: Subtree scope grant requires specific resources list.`,
                    };
                }
                const matchesSubtree = allowedResources.some((r) => {
                    const absAllowed = path.isAbsolute(r) ? path.normalize(r) : path.resolve(wsRoot, r);
                    const rel = path.relative(absAllowed, absTarget);
                    return !rel.startsWith("..") && !path.isAbsolute(rel);
                });
                if (!matchesSubtree) {
                    return {
                        confined: false,
                        reason: `AUTH-005: Security Violation: Path '${cleanPath}' is outside authorized subtree scope (no sibling inheritance).`,
                    };
                }
            }
        }
        return { confined: true };
    }
    /**
     * Creates an AuthorityAdmissionHook for ExecutionSpine.
     */
    createAdmissionHook() {
        return (request, context) => this.admit(request, context);
    }
    /**
     * Creates a ResourceConfinementHook for ExecutionSpine.
     */
    createConfinementHook() {
        return (request, context) => this.confine(request, context);
    }
    findMatchingGrant(actor, domain, capabilityId, toolName) {
        for (const grant of this.grants) {
            // Check actor match
            if (grant.actor) {
                const actors = Array.isArray(grant.actor) ? grant.actor : [grant.actor];
                if (!actors.includes("*") && !actors.includes(actor)) {
                    continue;
                }
            }
            // Check domain match
            if (grant.executionDomain) {
                const domains = Array.isArray(grant.executionDomain)
                    ? grant.executionDomain
                    : [grant.executionDomain];
                if (!domains.includes("*") && !domains.includes(domain)) {
                    continue;
                }
            }
            // Check capability match
            const allowedCaps = grant.capabilities;
            const matchesCap = allowedCaps.includes("*") ||
                allowedCaps.includes(capabilityId) ||
                (toolName ? allowedCaps.includes(toolName) : false) ||
                (capabilityId === "fs_read" && allowedCaps.includes("file_read")) ||
                (capabilityId === "fs_write" && allowedCaps.includes("file_write")) ||
                (capabilityId === "proc_exec" && (allowedCaps.includes("command_execution") || allowedCaps.includes("run_command")));
            if (!matchesCap) {
                continue;
            }
            return grant;
        }
        return null;
    }
}
