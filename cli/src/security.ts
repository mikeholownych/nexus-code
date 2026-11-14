import * as fs from "node:fs";
import * as path from "node:path";
import { isTestPath } from "./tester.js";
import { FILE_EDIT_TOOLS } from "./file_diff.js";

export type VerificationMode = "off" | "record" | "approve" | "block";
export type VerificationClass = "ci" | "build" | "test_config" | "verifier_script" | "test_file" | "package_scripts" | "policy";
export type VerificationDecisionLabel = "blocked" | "operator-approved" | "auto-recorded" | "role-allowed";

export interface VerificationPathsPolicy {
  mode: VerificationMode;
  extra?: string[];
  allow?: string[];
}

export interface VerificationClassification {
  class: VerificationClass;
  rule: string;
  source: "default" | "policy" | "test_path";
}

export interface VerificationConfigAttempt {
  path: string;
  class: VerificationClass;
  tool: string;
  decision: VerificationDecisionLabel;
  role: string | null;
  timestamp: string;
}

/** Who is editing and what has been decided for this one call; nothing is kept between calls. Absent means headless and unapproved. */
export interface VerificationEditContext {
  role?: string;
  fullAccess?: boolean;
  /** An operator is present to decide. */
  operator?: boolean;
  /** The operator approved this call, for this path only. */
  approved?: { path: string };
}

export type VerificationEditDecision = (VerificationClassification & {
  path: string;
  action: "allow" | "ask" | "deny";
  label?: VerificationDecisionLabel;
}) | null;

export const VERIFICATION_CONFIG_PROTECTED = "VERIFICATION_CONFIG_PROTECTED";

export interface SecurityPolicy {
  version?: string;
  blockedCommands?: string[];
  protectedPaths?: string[];
  allowedDomains?: string[];
  allowExternalSymlinks?: boolean;
  verificationPaths?: VerificationPathsPolicy;
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
  // The operator's list of trusted workspaces: the agent must not trust a workspace for itself.
  "trusted_workspaces.json",
  ".env*",
  "id_rsa*",
  "id_ed25519*",
];

const SCRIPT_NAMES = ["test", "verify", "ci", "check", "lint"];
/** [class, globs]; a glob matches a workspace-relative path, case-insensitively, `**\/` meaning any depth (zero or more directories). */
const DEFAULT_VERIFICATION_PATHS: Array<[VerificationClass, string[]]> = [
  ["ci", [".github/workflows/**", "**/.gitlab-ci.yml", ".circleci/**", "**/Jenkinsfile", "**/azure-pipelines.yml", "**/.husky/**", "**/.pre-commit-config.yaml"]],
  ["build", ["**/Makefile", "**/GNUmakefile", "**/justfile", "**/tox.ini", "**/noxfile.py", "**/Taskfile.yml"]],
  ["test_config", ["**/pyproject.toml", "**/setup.cfg", "**/jest.config.*", "**/vitest.config.*", "**/pytest.ini", "**/conftest.py", "**/.mocharc*", "**/playwright.config.*", "**/.coveragerc"]],
  ["verifier_script", SCRIPT_NAMES.flatMap((n) => [`**/scripts/**/${n}*`, `**/scripts/${n}*/**`])],
  ["package_scripts", ["**/package.json"]],
  ["policy", [".nexus-security.json"]],
];
export const DEFAULT_VERIFICATION_PATH_GLOBS: readonly string[] = DEFAULT_VERIFICATION_PATHS.flatMap(([, globs]) => globs);

const PACKAGE_VERIFICATION_KEYS = ["scripts", "jest", "vitest", "mocha", "ava", "nyc", "c8", "workspaces"];
const VERIFICATION_MODES: readonly VerificationMode[] = ["off", "record", "approve", "block"];
const RUNNABLE_TEST_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".rb"]);
const HEAVY_DIRECTORIES = new Set(["node_modules", ".git", "target", "dist", "build", ".venv", "venv", "vendor", ".next", "coverage"]);
const NON_TEST_DIRECTORIES = new Set(["fixtures", "__fixtures__", "__snapshots__", "testdata"]);
/** Constructs that switch a test off or end its run early; a heuristic over appended text, not a proof. */
const NEUTERING_TEXT = /\.(?:skip|only|todo)\b|(?:^|[;{}])\s*(?:fit|fdescribe|xit|xtest|xdescribe)\s*\(|process\.exit|\bsys\.exit|\bos\._exit|\bos\.Exit|System\.exit|process::exit|\bexit\s*\(|SystemExit|pytest\.exit|\bTestMain\b|\bt\.Skip|pytest\.(?:skip|mark\.(?:skip|xfail))|unittest\.skip|@Disabled|#\[ignore\]|^\s*return\s*;?\s*$|if\s*\(\s*(?:false|0)\s*\)|if\s*\(\s*true\s*\)\s*return|^throw\b/m;
const neutersTests = (text: string): boolean => NEUTERING_TEXT.test(text) || (text.match(/\/\*/g)?.length ?? 0) > (text.match(/\*\//g)?.length ?? 0);

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i++;
        }
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

const CONDITIONAL_CONFIG_FILES = new Set(["package.json", "pyproject.toml", "setup.cfg"]);
const isConditionalConfig = (rel: string): boolean => CONDITIONAL_CONFIG_FILES.has(path.posix.basename(rel).toLowerCase());
const VERIFICATION_SECTION = /^(?:tool\.(?:pytest|coverage|tox|poe|taskipy|pdm\.scripts|poetry\.scripts|hatch\.envs)(?:\..*)?|tool:pytest|pytest|coverage:.*|tox:.*|testenv.*)$/i;

/** The body of each section of a TOML or INI file that decides how tests run, by section name. */
function verificationSections(text: string): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    const header = line.match(/^\s*\[+\s*([^\]]+?)\s*\]+\s*$/);
    if (header) {
      current = VERIFICATION_SECTION.test(header[1]) ? (found[header[1]] ??= []) : null;
    } else if (current && line.trim()) current.push(line.trim());
  }
  return found;
}

function parseVerificationPolicy(raw: unknown): VerificationPathsPolicy {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : undefined);
  return {
    mode: VERIFICATION_MODES.includes(value.mode as VerificationMode) ? (value.mode as VerificationMode) : "approve",
    extra: strings(value.extra),
    allow: strings(value.allow),
  };
}

export function splitShellWords(cmd: string): string[] {
  const words: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && /\s/.test(ch)) {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) {
    words.push(current);
  }
  return words;
}

export function splitSubcommands(cmd: string): string[][] {
  const tokens = splitShellWords(cmd);
  const subcommands: string[][] = [];
  let current: string[] = [];

  for (const token of tokens) {
    if (token === ";" || token === "&&" || token === "||" || token === "|" || token === "&") {
      if (current.length > 0) {
        subcommands.push(current);
        current = [];
      }
    } else if (token.includes(";") || token.includes("&") || token.includes("|")) {
      let buf = "";
      for (const ch of token) {
        if (ch === ";" || ch === "&" || ch === "|") {
          if (buf.length > 0) {
            current.push(buf);
            buf = "";
          }
          if (current.length > 0) {
            subcommands.push(current);
            current = [];
          }
        } else {
          buf += ch;
        }
      }
      if (buf.length > 0) {
        current.push(buf);
      }
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) {
    subcommands.push(current);
  }
  return subcommands;
}

export function verificationDeniedMessage(decision: NonNullable<VerificationEditDecision>): string {
  return `${VERIFICATION_CONFIG_PROTECTED}: '${decision.path}' is verification configuration (${decision.class}, rule '${decision.rule}'). An edit needs an operator decision; none was given. Report it to the operator instead of changing how the work is verified. A headless project that must create or change such files needs fullAccess (--yes) or verificationPaths.mode \"record\" in .nexus-security.json.`;
}

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
          verificationPaths: parseVerificationPolicy(parsed.verificationPaths),
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
      verificationPaths: parseVerificationPolicy(undefined),
    };
  }

  public isCommandBlocked(command: string): { blocked: boolean; reason?: string } {
    if (!command || typeof command !== "string") {
      return { blocked: false };
    }
    const trimmed = command.trim();
    if (trimmed.length === 0) {
      return { blocked: false };
    }

    // 1. Custom blocked commands from policy (outside the default tripwire set)
    const customPatterns = (this.policy.blockedCommands || []).filter(
      (p) => !DEFAULT_BLOCKED_COMMANDS.includes(p)
    );
    for (const pattern of customPatterns) {
      if (pattern && trimmed.includes(pattern)) {
        return {
          blocked: true,
          reason: `Destructive-command tripwire: Command matches blocked pattern '${pattern}'`,
        };
      }
    }

    // 2. Fork bomb denial of service
    if (
      trimmed.includes(":(){ :|:& };:") ||
      trimmed.includes(":(){:|:&};:") ||
      (trimmed.includes(":(){") && trimmed.includes(":|:"))
    ) {
      return {
        blocked: true,
        reason: "Destructive-command tripwire: Command blocked by safety guard (Fork bomb denial-of-service)",
      };
    }

    // 3. Raw disk block redirection
    if (/>\s*\/dev\/(sd|nvme|vd)/.test(trimmed)) {
      return {
        blocked: true,
        reason: "Destructive-command tripwire: Command blocked by safety guard (Raw disk device redirection)",
      };
    }

    // 4. Tokenized subcommand inspection
    const subcommands = splitSubcommands(trimmed);
    for (const sub of subcommands) {
      if (sub.length === 0) continue;

      // Strip wrapper commands: sudo, doas, nohup, env
      let idx = 0;
      while (idx < sub.length) {
        const word = sub[idx];
        if (word === "sudo" || word === "doas" || word === "nohup") {
          idx++;
          while (idx < sub.length && sub[idx].startsWith("-")) {
            if ((sub[idx] === "-u" || sub[idx] === "-g") && idx + 1 < sub.length) {
              idx += 2;
            } else {
              idx++;
            }
          }
        } else if (word === "env") {
          idx++;
          while (idx < sub.length && (sub[idx].startsWith("-") || sub[idx].includes("="))) {
            idx++;
          }
        } else {
          break;
        }
      }
      if (idx >= sub.length) continue;

      const exe = sub[idx];
      const args = sub.slice(idx + 1);

      // System shutdown or reboot
      if (["shutdown", "reboot", "poweroff", "halt"].includes(exe)) {
        return {
          blocked: true,
          reason: "Destructive-command tripwire: Command blocked by safety guard (System shutdown or reboot command)",
        };
      }
      if (exe === "init" && args.some((a) => a === "0" || a === "6")) {
        return {
          blocked: true,
          reason: "Destructive-command tripwire: Command blocked by safety guard (System shutdown or reboot command (init 0/6))",
        };
      }

      // Filesystem destruction (mkfs)
      if (exe === "mkfs" || exe.startsWith("mkfs.")) {
        return {
          blocked: true,
          reason: "Destructive-command tripwire: Command blocked by safety guard (Filesystem destruction command (mkfs))",
        };
      }

      // Raw disk write via dd
      if (exe === "dd") {
        const hasDangerousOf = args.some((a) => {
          if (!a.startsWith("of=")) return false;
          const target = a.slice(3).replace(/^['"]|['"]$/g, "");
          return (
            target.startsWith("/dev/sd") ||
            target.startsWith("/dev/nvme") ||
            target.startsWith("/dev/vd") ||
            (target.startsWith("/dev/") &&
              !["/dev/null", "/dev/zero", "/dev/urandom", "/dev/random"].includes(target))
          );
        });
        if (hasDangerousOf) {
          return {
            blocked: true,
            reason: "Destructive-command tripwire: Command blocked by safety guard (Raw disk block overwrite (dd of=/dev/...))",
          };
        }
      }

      // Destructive root permissions or ownership
      if (exe === "chmod" || exe === "chown") {
        const isRecursive = args.some(
          (a) => a === "-R" || a === "-r" || a === "--recursive" || /^-[a-zA-Z]*[rR]/.test(a)
        );
        if (isRecursive) {
          const targetsRoot = args.some((a) => a === "/" || a === "/*");
          if (targetsRoot) {
            if (exe === "chmod") {
              if (args.some((a) => a === "777" || a === "0777")) {
                return {
                  blocked: true,
                  reason: "Destructive-command tripwire: Command blocked by safety guard (Recursive root permission alteration)",
                };
              }
            } else {
              return {
                blocked: true,
                reason: "Destructive-command tripwire: Command blocked by safety guard (Recursive root permission alteration)",
              };
            }
          }
        }
      }

      // Destructive recursive deletion (rm -rf /)
      if (exe === "rm") {
        const hasRf = args.some((a) => a === "-rf" || a === "-fr");
        const hasDashDash = args.includes("--");
        if (hasRf && !hasDashDash) {
          for (const a of args) {
            if (a.startsWith("-")) continue;
            const norm = a.toLowerCase();
            if (
              norm === "/" ||
              norm === "/*" ||
              norm === "." ||
              norm === ".." ||
              norm === "~" ||
              norm === "$home" ||
              norm === "${home}"
            ) {
              return {
                blocked: true,
                reason:
                  "Destructive-command tripwire: Command blocked by safety guard (Destructive recursive deletion of root, home, or current directory (rm -rf))",
              };
            }
          }
        }
      }
    }

    return { blocked: false };
  }

  /**
   * Check whether a path matches any protected pattern (REQ-SEC-118, ACC-TRUST-09).
   * Matches `.env*` and case-insensitive variants, and inspects the canonical target.
   * Path protection is enforced on all file read/write/edit tools; for `run_command` it is advisory.
   */
  public isPathProtected(targetPath: string): { protected: boolean; reason?: string } {
    if (!targetPath || typeof targetPath !== "string") {
      return { protected: false };
    }

    const checkCandidate = (cand: string): { protected: boolean; reason?: string } => {
      const clean = cand.replace(/\\/g, "/");
      const segments = clean.split("/").filter(Boolean);
      const base = path.posix.basename(clean).toLowerCase();

      for (const pattern of this.policy.protectedPaths || []) {
        const patLower = pattern.toLowerCase();
        if (patLower === ".env*" || patLower === ".env") {
          if (segments.some((seg) => seg.toLowerCase().startsWith(".env"))) {
            return {
              protected: true,
              reason: `Security Policy Violation: Path '${targetPath}' matches protected pattern '${pattern}'`,
            };
          }
        } else if (patLower.endsWith("*")) {
          const prefix = patLower.slice(0, -1);
          if (segments.some((seg) => seg.toLowerCase().startsWith(prefix))) {
            return {
              protected: true,
              reason: `Security Policy Violation: Path '${targetPath}' matches protected pattern '${pattern}'`,
            };
          }
        } else {
          if (
            segments.some((seg) => seg.toLowerCase() === patLower) ||
            base === patLower ||
            clean.toLowerCase() === patLower ||
            clean.toLowerCase().endsWith("/" + patLower)
          ) {
            return {
              protected: true,
              reason: `Security Policy Violation: Path '${targetPath}' is protected under security policy`,
            };
          }
        }
      }
      return { protected: false };
    };

    // 1. Raw given path
    const rawCheck = checkCandidate(targetPath);
    if (rawCheck.protected) return rawCheck;

    // 2. Absolute path in workspace
    const absPath = path.isAbsolute(targetPath) ? targetPath : path.resolve(this.workspace, targetPath);
    const absCheck = checkCandidate(absPath);
    if (absCheck.protected) return absCheck;

    // 3. Canonical target (resolves symlinks)
    try {
      if (fs.existsSync(absPath)) {
        const real = fs.realpathSync(absPath);
        const realCheck = checkCandidate(real);
        if (realCheck.protected) {
          return {
            protected: true,
            reason: `Security Policy Violation: Path '${targetPath}' resolves to protected target '${real}'`,
          };
        }
      } else {
        const dir = path.dirname(absPath);
        if (fs.existsSync(dir)) {
          const realDir = fs.realpathSync(dir);
          const canonicalTarget = path.join(realDir, path.basename(absPath));
          const canonCheck = checkCandidate(canonicalTarget);
          if (canonCheck.protected) return canonCheck;
        }
      }
    } catch {}

    return { protected: false };
  }

  private verificationAttempts: VerificationConfigAttempt[] = [];

  public getVerificationAttempts(): VerificationConfigAttempt[] {
    return this.verificationAttempts.map((a) => ({ ...a }));
  }

  public restoreVerificationAttempts(attempts: VerificationConfigAttempt[] | undefined): void {
    this.verificationAttempts = Array.isArray(attempts) ? attempts.map((a) => ({ ...a })) : [];
  }

  public recordVerificationAttempt(rel: string, cls: VerificationClass, tool: string, decision: VerificationDecisionLabel, role?: string): void {
    this.verificationAttempts.push({ path: rel, class: cls, tool, decision, role: role ?? null, timestamp: new Date().toISOString() });
  }

  /** The verification-config rule `rel` (workspace-relative) falls under: the default list, operator `extra`, or a runnable test file. `allow` exempts. */
  public classifyVerificationPath(rel: string): VerificationClassification | null {
    const clean = path.posix.normalize(rel.replace(/\\/g, "/"));
    if (!clean || clean === "." || clean.startsWith("../") || path.isAbsolute(clean)) return null;
    const segments = clean.split("/");
    if (segments.includes("node_modules") || segments.includes(".git")) return null;
    const policy = this.policy.verificationPaths ?? parseVerificationPolicy(undefined);
    if ((policy.allow ?? []).some((g) => globToRegExp(g).test(clean))) return null;
    for (const [cls, globs] of DEFAULT_VERIFICATION_PATHS) {
      const rule = globs.find((g) => globToRegExp(g).test(clean));
      if (rule) return { class: cls, rule, source: "default" };
    }
    const extra = (policy.extra ?? []).find((g) => globToRegExp(g).test(clean));
    if (extra) return { class: "test_config", rule: extra, source: "policy" };
    if (this.isRunnableTestFile(clean)) return { class: "test_file", rule: "test path", source: "test_path" };
    return null;
  }

  private isRunnableTestFile(rel: string): boolean {
    if (!isTestPath(rel)) return false;
    if (rel.split("/").slice(0, -1).some((seg) => NON_TEST_DIRECTORIES.has(seg.toLowerCase()))) return false;
    return RUNNABLE_TEST_EXTENSIONS.has(path.posix.extname(rel).toLowerCase());
  }

  private verificationCandidates(targetPath: string): { rels: string[]; abs: string; exists: boolean; directory: boolean } {
    const abs = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(this.workspace, targetPath);
    const roots = [this.workspace];
    try { roots.push(fs.realpathSync(this.workspace)); } catch {}
    const absolutes = [abs];
    let exists = false;
    let directory = false;
    try {
      if (fs.existsSync(abs)) {
        exists = true;
        directory = fs.statSync(abs).isDirectory();
        absolutes.push(fs.realpathSync(abs));
      } else {
        let ancestor = path.dirname(abs);
        while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
        absolutes.push(path.join(fs.realpathSync(ancestor), path.relative(ancestor, abs)));
      }
    } catch {}
    const rels: string[] = [];
    for (const a of absolutes) {
      for (const root of roots) {
        const rel = path.relative(root, a).replace(/\\/g, "/");
        if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && !rels.includes(rel)) rels.push(rel);
      }
    }
    return { rels, abs, exists, directory };
  }

  /** The first verification file under a directory (bounded walk, heavy directories skipped); "unknown" when the bound is hit, so the caller fails closed. */
  private classifiedFileUnder(dirAbs: string): { rel: string; found: VerificationClassification } | "unknown" | null {
    const roots = [this.workspace];
    try { roots.push(fs.realpathSync(this.workspace)); } catch {}
    let visited = 0;
    const walk = (dir: string): { rel: string; found: VerificationClassification } | "unknown" | null => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return "unknown"; }
      for (const entry of entries) {
        if (++visited > 5000) return "unknown";
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (HEAVY_DIRECTORIES.has(entry.name)) continue;
          const nested = walk(child);
          if (nested) return nested;
        } else {
          for (const root of roots) {
            const rel = path.relative(root, child).replace(/\\/g, "/");
            const found = rel && !rel.startsWith("..") ? this.classifyVerificationPath(rel) : null;
            if (found && !isConditionalConfig(rel)) return { rel, found };
          }
        }
      }
      return null;
    };
    return walk(dirAbs);
  }

  /** Whether an edit to package.json, pyproject.toml or setup.cfg changes what tests run (the keys or sections that decide it); other edits are free. */
  private touchesConditionalConfig(toolName: string, args: Record<string, any>, abs: string, exists: boolean): boolean {
    try {
      const beforeText = exists ? fs.readFileSync(abs, "utf-8") : "";
      let afterText: string;
      if (toolName === "write_file") afterText = String(args.content ?? "");
      else if (toolName === "edit_file" && exists) {
        const from = String(args.old_content ?? "");
        const to = String(args.new_content ?? "");
        afterText = args.replace_all ? beforeText.split(from).join(to) : beforeText.replace(from, () => to);
      } else return true;
      if (path.basename(abs).toLowerCase() === "package.json") {
        const before = exists ? JSON.parse(beforeText) : {};
        const after = JSON.parse(afterText);
        return PACKAGE_VERIFICATION_KEYS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      }
      return JSON.stringify(verificationSections(beforeText)) !== JSON.stringify(verificationSections(afterText));
    } catch {
      return true;
    }
  }

  /** Whether a tester's edit only adds to an existing test: the old text survives untouched and the addition cannot switch tests off. */
  private appendsToExistingTest(toolName: string, args: Record<string, any>, abs: string): boolean {
    try {
      const current = fs.readFileSync(abs, "utf-8");
      const appended = (from: string, to: string): boolean => {
        if (!to.startsWith(from)) return false;
        const extra = to.slice(from.length);
        return (from.endsWith("\n") || extra.startsWith("\n")) && !neutersTests(extra);
      };
      if (toolName === "write_file") return appended(current, String(args.content ?? ""));
      if (toolName === "edit_file") {
        const from = String(args.old_content ?? "");
        const to = String(args.new_content ?? "");
        if (!from || args.replace_all) return false;
        const atEnd = current === from || (current.endsWith(from) && current[current.length - from.length - 1] === "\n");
        return atEnd && appended(from, to);
      }
    } catch {}
    return false;
  }

  /**
   * What an agent file edit needs: nothing (null), an operator decision, or a refusal. Only new runnable test files
   * are free to create; a new config, CI, verifier or policy file is gated like an edit. `ctx` is the call's own
   * authority; absent, the call is headless and unapproved.
   */
  public verificationEditDecision(toolName: string, args: Record<string, any>, ctx: VerificationEditContext = {}): VerificationEditDecision {
    if (!FILE_EDIT_TOOLS.has(toolName)) return null;
    const target = String(args.path || args.target_file || args.file_path || "");
    if (!target) return null;
    const configured = this.policy.verificationPaths ?? parseVerificationPolicy(undefined);
    const { rels, abs, exists, directory } = this.verificationCandidates(target);
    if (!exists && toolName !== "write_file") return null;
    let hit: { rel: string; found: VerificationClassification } | null = null;
    for (const rel of rels) {
      const found = this.classifyVerificationPath(rel);
      if (found && (!hit || found.class === "policy")) hit = { rel, found };
    }
    if (!hit && directory && toolName === "delete_file" && configured.mode !== "off" && !HEAVY_DIRECTORIES.has(path.basename(abs))) {
      const inside = this.classifiedFileUnder(abs);
      const at = rels[0] ?? target;
      if (inside === "unknown") {
        if (configured.mode !== "record") hit = { rel: at, found: { class: "verifier_script", rule: "directory too large to scan", source: "default" } };
      } else if (inside) hit = { rel: at, found: inside.found };
    }
    if (!hit) return null;
    const { rel, found } = hit;
    if (!exists && found.class === "test_file") return null;
    const mode: VerificationMode = found.class === "policy" && configured.mode !== "block" ? "approve" : configured.mode;
    if (mode === "off") return null;
    if (isConditionalConfig(rel) && !this.touchesConditionalConfig(toolName, args, abs, exists)) return null;
    const base = { ...found, path: rel };
    if (mode === "approve" && ctx.role === "tester" && found.class === "test_file" && !directory && this.appendsToExistingTest(toolName, args, abs)) {
      return { ...base, action: "allow", label: "role-allowed" };
    }
    if (mode === "record") return { ...base, action: "allow", label: "auto-recorded" };
    if (mode === "block") return { ...base, action: "deny" };
    if (ctx.approved?.path === rel) return { ...base, action: "allow", label: "operator-approved" };
    if (ctx.fullAccess && found.class !== "policy") return { ...base, action: "allow", label: "auto-recorded" };
    return { ...base, action: ctx.operator ? "ask" : "deny" };
  }

  /** The gate in front of a file edit: records the attempt and says whether it may run. */
  public authorizeVerificationEdit(toolName: string, args: Record<string, any>, ctx: VerificationEditContext = {}): { allowed: true } | { allowed: false; error: string } {
    const decision = this.verificationEditDecision(toolName, args, ctx);
    if (!decision) return { allowed: true };
    if (decision.action === "allow") {
      this.recordVerificationAttempt(decision.path, decision.class, toolName, decision.label!, ctx.role);
      return { allowed: true };
    }
    return this.refuseVerificationEdit(decision, toolName, ctx.role);
  }

  /** Records a refused edit as blocked and gives the refusal; the one path for a denial by policy and for a declined prompt. */
  public refuseVerificationEdit(decision: NonNullable<VerificationEditDecision>, toolName: string, role?: string): { allowed: false; error: string } {
    this.recordVerificationAttempt(decision.path, decision.class, toolName, "blocked", role);
    return { allowed: false, error: verificationDeniedMessage(decision) };
  }

  /**
   * Best-effort and record-only: a shell command that appears to write a verification-config file (sed -i, tee,
   * redirection, mv, cp, rm...) is noted, never blocked. SI-2 therefore does not stop a shell-capable agent from
   * changing how work is verified; it makes edits through the file tools a decision and the rest visible.
   */
  public recordVerificationCommand(command: string, role?: string): void {
    const mode = this.policy.verificationPaths?.mode ?? "approve";
    if (mode === "off") return;
    const seen = new Set<string>();
    const note = (token: string): void => {
      if (!token || token.startsWith("-")) return;
      const { rels, exists } = this.verificationCandidates(token);
      if (!exists) return;
      for (const rel of rels) {
        const found = this.classifyVerificationPath(rel);
        if (found && !isConditionalConfig(rel) && !seen.has(rel)) {
          seen.add(rel);
          this.recordVerificationAttempt(rel, found.class, "run_command", "auto-recorded", role);
        }
      }
    };
    for (const words of splitSubcommands(command.replace(/(>>?)(?=[^\s>])/g, "$1 ").replace(/(?<=[^\s>])(>>?)/g, " $1"))) {
      const redirected = words.flatMap((w, i) => (w === ">" || w === ">>") && words[i + 1] ? [words[i + 1]] : []);
      redirected.forEach(note);
      const [head, ...rest] = words;
      if (head === "sed" && rest.some((w) => /^-[a-zA-Z]*i/.test(w) || w.startsWith("--in-place"))) rest.forEach(note);
      else if (["tee", "mv", "cp", "rm", "truncate", "install", "ln"].includes(head ?? "")) rest.forEach(note);
    }
  }

  public getPolicy(): SecurityPolicy {
    return this.policy;
  }

  private vault = new SecretsVault();
  public getVault(): SecretsVault {
    return this.vault;
  }
}

import { InformationFlowBoundary, ClassifiedSecret } from "./core/egress.js";

/**
 * SecretsVault: Reversible token placeholder secrets quarantine.
 * Replaces live API keys and credentials with cryptographically unguessable scoped placeholders
 * before outbound transmission, and restores original values for local tool execution.
 * (DATA-001..004, REHYD-001..005, DISC-001..005)
 */
export class SecretsVault {
  private boundary: InformationFlowBoundary;
  private refMap: Map<string, string> = new Map(); // placeholder -> secret
  private secretMap: Map<string, string> = new Map(); // secret -> placeholder
  private nextId: number = 1;

  public static SECRET_PATTERNS = [
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

  constructor(boundary?: InformationFlowBoundary) {
    this.boundary = boundary || InformationFlowBoundary.getGlobalInstance();
  }

  /**
   * Quarantines detected credentials by replacing them with cryptographically unguessable scoped references (REHYD-001).
   */
  public quarantine(
    text: string,
    options?: { taskId?: string; sessionId?: string; destination?: string; legacy?: boolean }
  ): { sanitized: string; quarantinedCount: number } {
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
        sanitized = sanitized.replace(pattern, (...args: any[]) => {
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

    // Populate local refMap for synchronous local restore compatibility: only values that were replaced (a value inside
    // a longer classified value is classified too, but its token is never used).
    for (const item of result.quarantinedSecrets ?? result.classifiedSecrets) {
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
  public restore(
    sanitizedText: string,
    context?: { taskId?: string; sessionId?: string; isAuthorizedSink?: boolean }
  ): string {
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

  public getMappingCount(): number {
    return this.refMap.size || this.boundary.getVaultSize();
  }

  public clear(): void {
    this.refMap.clear();
    this.secretMap.clear();
    this.nextId = 1;
    this.boundary.clear();
  }
}
