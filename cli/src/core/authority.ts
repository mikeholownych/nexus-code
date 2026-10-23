/**
 * Authority Admission & Resource Confinement Engine
 * Nexus Issue #12 — WP-02 (INC-03, AUTH-001..012, ACT-001..004, RES-001..004)
 */

import * as path from "node:path";
import * as fs from "node:fs";
import {
  InvocationRequest,
  InvocationContext,
  AdmissionDecision,
  ResourceConfinementDecision,
  AuthorityAdmissionHook,
  ResourceConfinementHook,
  extractTargetResources,
} from "./spine.js";
import { CapabilityRegistry, defaultRegistry } from "./capabilities.js";

export type AuthorityScope = "exact" | "subtree" | "workspace" | "full_access";

export interface AuthorityGrant {
  id?: string;
  actor?: string | string[];
  executionDomain?: string | string[];
  capabilities: string[];
  scope: AuthorityScope;
  resources?: string[];
  readOnly?: boolean;
}

export interface AuthorityConfig {
  fullAccess?: boolean;
  readOnly?: boolean;
  grants?: AuthorityGrant[];
  allowedDomains?: string[];
  safeReadOnlyCommandRegex?: RegExp;
  /** Workspace used to resolve read-only command path arguments. */
  workspace?: string;
  /** Registry tool names resolve against; defaults to the shared baseline registry. */
  registry?: CapabilityRegistry;
}

/**
 * Standard safe commands allowed under --read-only mode.
 */
export const DEFAULT_SAFE_READONLY_COMMAND_REGEX =
  /^\s*(ls|dir|pwd|echo|cat|head|tail|grep|rg|find|diff|wc|which|where|git\s+(status|log|diff|branch|show)|npm\s+list|node\s+-v|rustc\s+-v)(\s+.*)?$/i;

// Keep attacker-controlled command text bounded before applying the allowlist regex.
const MAX_SAFE_READONLY_COMMAND_LENGTH = 8_192;

/** Whether the command contains an unquoted shell glob, which expands after this check. */
function hasUnquotedGlob(command: string): boolean {
  let quoteChar = "";
  for (const ch of command) {
    if (quoteChar) {
      if (ch === quoteChar) quoteChar = "";
    } else if (ch === '"' || ch === "'") {
      quoteChar = ch;
    } else if (ch === "*" || ch === "?" || ch === "[") {
      return true;
    }
  }
  return false;
}

/**
 * Split a command into the words the shell will execute. Returns null for an unterminated quote.
 * Backslash, `$`, backticks and control operators are rejected before this runs, so quotes are the
 * only shell grammar left to interpret.
 */
function splitShellWords(command: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quoteChar = "";
  for (const ch of command) {
    if (quoteChar) {
      if (ch === quoteChar) quoteChar = "";
      else current += ch;
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoteChar = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        words.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quoteChar) return null;
  if (started) words.push(current);
  return words;
}

/**
 * Commands that read file contents: a glob is expanded by the shell after the allowlist runs, so
 * `cat *` could still name an escaping symlink. Commands that only list names keep glob support.
 */
const GLOB_READING_COMMANDS = new Set(["cat", "head", "tail", "grep", "rg", "diff", "wc"]);

/** Commands whose plain words are resolved through the filesystem before execution. */
const REALPATH_COMMANDS = new Set([...GLOB_READING_COMMANDS, "find", "git"]);

/** Whether `word` is an option rather than an operand (`-` alone is an operand to grep/rg). */
function isOptionWord(word: string): boolean {
  return word !== "-" && word.startsWith("-");
}

/** Index of the standalone `--` end-of-options separator, or -1. */
function endOfOptionsIndex(words: string[]): number {
  return words.indexOf("--", 1);
}

/** An attached option value that names a file the command would read (`-f/etc/shadow`, `--file=x`). */
function isAttachedFileOption(word: string): boolean {
  return word === "-f" || word === "--file" || word.startsWith("--file=") || (word.startsWith("-f") && word.length > 2);
}

/**
 * Options that make an allowlisted command read files without naming them as a plain argument:
 * recursive symlink following, attached paths, pattern/ignore files, and path lists. They are
 * refused in read-only mode rather than parsed. Words after `--` are operands, never options.
 */
function hasUnsafeReadOnlyOption(base: string, words: string[], separator: number): boolean {
  for (let i = 1; i < words.length; i++) {
    if (i === separator || (separator >= 0 && i > separator)) continue;
    const w = words[i];
    if (GLOB_READING_COMMANDS.has(base) && isAttachedFileOption(w)) return true;
    if (base === "grep") {
      if (w === "--exclude-from" || w.startsWith("--exclude-from=")) return true;
      if (w === "--dereference-recursive" || (/^-[A-Za-z]+$/.test(w) && w.includes("R"))) return true;
    }
    if (base === "rg") {
      if (w === "--ignore-file" || w.startsWith("--ignore-file=")) return true;
      if (w === "--follow" || (/^-[A-Za-z]+$/.test(w) && w.includes("L"))) return true;
    }
    if (base === "find" && (w === "-L" || w === "-H" || w === "-follow" || w === "-files0-from" || w.startsWith("-files0-from="))) {
      return true;
    }
    if (base === "diff" && (
      w === "--recursive" ||
      w.startsWith("--recursive=") ||
      w === "--from-file" ||
      w.startsWith("--from-file=") ||
      w === "--to-file" ||
      w.startsWith("--to-file=") ||
      w === "--exclude-from" ||
      w.startsWith("--exclude-from=") ||
      /^-[A-Za-z]*r[A-Za-z]*$/.test(w)
    )) {
      return true;
    }
    if (base === "wc" && (w === "--files0-from" || w.startsWith("--files0-from="))) return true;
  }
  return false;
}

/**
 * Indices of words that name files. For grep/rg the first plain word is the pattern (or the value
 * after -e/--regexp); for find only the starting point. Everything else that is not an option is a
 * path for the remaining allowlisted commands. After `--`, every word is an operand.
 */
function pathWordIndexes(base: string, words: string[], separator: number): Set<number> {
  const indexes = new Set<number>();
  const beforeSeparator = (i: number): boolean => separator < 0 || i < separator;
  if (base === "grep" || base === "rg") {
    let patternSeen = false;
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (i === separator) continue;
      if (beforeSeparator(i)) {
        if (w === "-e" || w === "--regexp") {
          patternSeen = true;
          i++;
          continue;
        }
        if (w.startsWith("--regexp=") || (w.startsWith("-e") && w.length > 2)) {
          patternSeen = true;
          continue;
        }
        if (isOptionWord(w)) continue;
      }
      if (!patternSeen) {
        patternSeen = true;
        continue;
      }
      indexes.add(i);
    }
    return indexes;
  }
  if (base === "find") {
    for (let i = 1; i < words.length; i++) {
      if (i === separator) continue;
      if (beforeSeparator(i) && isOptionWord(words[i])) continue;
      indexes.add(i);
      break;
    }
    return indexes;
  }
  for (let i = 1; i < words.length; i++) {
    if (i === separator) continue;
    if (beforeSeparator(i) && isOptionWord(words[i])) continue;
    indexes.add(i);
  }
  return indexes;
}

/**
 * Validates whether a shell command is safe to execute under read-only mode.
 * Enforces AUTH-009 and AUTH-010:
 * 1. Rejects shell composition, pipelines, command substitutions, redirections, and separators.
 * 2. Validates base executable against safe command allowlist.
 * 3. Inspects executable arguments to prevent subcommands or options that perform mutation.
 */
export function isSafeReadOnlyCommand(
  command: string,
  customRegex?: RegExp,
  workspace?: string
): boolean {
  if (!command || typeof command !== "string") return false;
  if (command.length > MAX_SAFE_READONLY_COMMAND_LENGTH) return false;
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;

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

  // A glob expands after this check, so the arguments below never see the real file names.
  // Commands that read contents must not rely on it: `cat *` can select an escaping symlink.
  const words = splitShellWords(trimmed);
  if (!words || words.length === 0) return false;
  const baseCommand = words[0].toLowerCase();
  const separator = endOfOptionsIndex(words);
  if (GLOB_READING_COMMANDS.has(baseCommand) && hasUnquotedGlob(trimmed)) {
    return false;
  }

  // 2. Validate against the safe read-only command allowlist
  const regex = customRegex || DEFAULT_SAFE_READONLY_COMMAND_REGEX;
  if (!regex.test(trimmed)) {
    return false;
  }

  if (hasUnsafeReadOnlyOption(baseCommand, words, separator)) {
    return false;
  }

  // `-v` is a version query only. A trailing operand made `rustc -v <file>` echo the file's source
  // line in its diagnostic, so these commands accept no arguments at all.
  if ((baseCommand === "node" || baseCommand === "rustc") && !(words.length === 2 && words[1] === "-v")) {
    return false;
  }

  // 2b. Path confinement: reject arguments with absolute paths escaping workspace or escaping traversal (..).
  // The words are the shell's words, so a quoted or concatenated symlink name is resolved as written.
  //
  // A standalone `--` is only an end-of-options marker when no preceding option could have consumed it
  // as a value (`diff -I -- -r A B`). Modelling every command's value-taking option table is not
  // worthwhile: for a content-reading command, refuse a `--` that follows any option instead.
  if (separator > 1 && REALPATH_COMMANDS.has(baseCommand) && words.slice(1, separator).some(isOptionWord)) {
    return false;
  }
  const resolvedWs = workspace ? path.resolve(workspace) : undefined;
  let realWs: string | undefined;
  if (resolvedWs) {
    try {
      realWs = fs.realpathSync(resolvedWs);
    } catch {
      // A workspace was supplied but cannot be resolved: fail closed rather than skip confinement.
      return false;
    }
  }
  const withinWorkspace = (target: string): boolean =>
    Boolean(resolvedWs) && (target === resolvedWs || target.startsWith(resolvedWs + path.sep));
  const pathIndexes = pathWordIndexes(baseCommand, words, separator);
  const resolveWords = REALPATH_COMMANDS.has(baseCommand);
  for (let i = 1; i < words.length; i++) {
    if (i === separator) continue;
    // Before `--`, option words are not operands. After it every word is an operand, including a
    // dash-prefixed file name such as `--link`.
    if ((separator < 0 || i < separator) && isOptionWord(words[i])) continue;
    if (!pathIndexes.has(i)) continue;
    const candidatePath = words[i];
    if (!candidatePath) continue;
    if (candidatePath.startsWith("/") && !withinWorkspace(path.resolve(candidatePath))) {
      return false;
    }
    if (candidatePath.includes("..")) {
      const target = resolvedWs ? path.resolve(resolvedWs, candidatePath) : path.resolve(candidatePath);
      if (!withinWorkspace(target)) {
        return false;
      }
    }
    // A lexical check is not enough for a read-only workspace: an in-workspace symlink can point
    // outside it, and the sandbox still exposes host paths read-only. Resolve operands of commands
    // that read contents or traverse the tree; listing/text commands keep working.
    if (realWs && resolveWords) {
      try {
        const realTarget = fs.realpathSync(path.resolve(resolvedWs!, candidatePath));
        if (realTarget !== realWs && !realTarget.startsWith(realWs + path.sep)) {
          return false;
        }
        // `diff` dereferences symlinks inside a directory operand even without -r; allow only files.
        if (baseCommand === "diff" && fs.statSync(realTarget).isDirectory()) {
          return false;
        }
      } catch {
        // Not an existing path (a pattern, option value or missing file), so there is nothing to resolve.
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
          } else if (token.startsWith("-")) {
            // Safe flag, e.g. -a, -r, -v, -vv, --remotes, --all, --show-current
            expectsPattern = false;
          } else if (expectsPattern) {
            // Allowed pattern argument for --list (e.g. "feat/*")
            expectsPattern = false;
          } else {
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
  private fullAccess: boolean = false;
  private readOnly: boolean = false;
  private grants: AuthorityGrant[] = [];
  private allowedDomains: Set<string> | null = null;
  private safeCommandRegex: RegExp = DEFAULT_SAFE_READONLY_COMMAND_REGEX;
  private workspace?: string;
  private readonly registry: CapabilityRegistry;

  constructor(config: AuthorityConfig = {}) {
    this.registry = config.registry ?? defaultRegistry;
    this.fullAccess = Boolean(config.fullAccess);
    this.readOnly = Boolean(config.readOnly);
    this.workspace = config.workspace;
    this.grants = config.grants ? [...config.grants] : [];
    if (config.allowedDomains && config.allowedDomains.length > 0) {
      this.allowedDomains = new Set(config.allowedDomains);
    }
    if (config.safeReadOnlyCommandRegex) {
      this.safeCommandRegex = config.safeReadOnlyCommandRegex;
    }
  }

  public setFullAccess(enabled: boolean): void {
    this.fullAccess = enabled;
  }

  public isFullAccess(): boolean {
    return this.fullAccess;
  }

  public setReadOnly(enabled: boolean): void {
    this.readOnly = enabled;
  }

  public isReadOnly(): boolean {
    return this.readOnly;
  }

  public addGrant(grant: AuthorityGrant): void {
    this.grants.push(grant);
  }

  public clearGrants(): void {
    this.grants = [];
  }

  public getGrants(): AuthorityGrant[] {
    return [...this.grants];
  }

  /**
   * Authority Admission Gate (Stage 3A)
   * Evaluates capability authority, domain isolation, and read-only enforcement.
   */
  public async admit(
    request: InvocationRequest,
    context: InvocationContext
  ): Promise<AdmissionDecision> {
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
        if (!isSafeReadOnlyCommand(cmd, this.safeCommandRegex, this.workspace)) {
          return {
            admitted: false,
            reason: `AUTH-010: Read-only mode violation: Command '${cmd}' is not permitted in read-only mode. Only safe inspection commands are permitted.`,
          };
        }
      } else if (capability.mutating) {
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
  public async confine(
    request: InvocationRequest,
    context: InvocationContext
  ): Promise<ResourceConfinementDecision> {
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
    let effectiveScope: AuthorityScope = "workspace";
    let allowedResources: string[] | undefined = undefined;

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
      if (!cleanPath) continue;

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
      } else if (effectiveScope === "subtree") {
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
  public createAdmissionHook(): AuthorityAdmissionHook {
    return (request, context) => this.admit(request, context);
  }

  /**
   * Creates a ResourceConfinementHook for ExecutionSpine.
   */
  public createConfinementHook(): ResourceConfinementHook {
    return (request, context) => this.confine(request, context);
  }

  private findMatchingGrant(
    actor: string,
    domain: string,
    capabilityId: string,
    toolName?: string
  ): AuthorityGrant | null {
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
      const matchesCap =
        allowedCaps.includes("*") ||
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
