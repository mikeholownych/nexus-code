import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { egressPolicyFromEnv, type EgressPolicy } from "./core/egress_policy.js";
import { isTestPath } from "./tester.js";
import { envTrustRequested, isWorkspaceListed, realWorkspace } from "./workspace_trust.js";
import { clampEgressInspector, decideManagedCommand, describeSource, effectiveVerificationMode, type EffectivePolicy, type PolicySource } from "./core/managed_policy.js";
import type { LoadedPolicy } from "./core/managed_policy_load.js";
import { approvalHint, emitPolicyNotice, processPolicyHost } from "./core/policy_runtime.js";
import { FILE_EDIT_TOOLS } from "./file_diff.js";
import { linkRecord, verifyChain, type ChainLink, type ChainVerdict } from "./core/hash_chain.js";
import { runnerRoot } from "./core/runner_store.js";
import { defaultTaskStateDir } from "./core/state.js";
import { extensionTrustStorePath } from "./core/content_trust.js";

/** The task-state directory as configured and as it really resolves (a symlinked HOME has two spellings). */
function taskStatePaths(): string[] {
  const dir = defaultTaskStateDir();
  try {
    const real = fs.realpathSync(dir);
    return real === dir ? [dir] : [dir, real];
  } catch {
    return [dir];
  }
}

/** (device, inode) of every file below the state directory at `at`. Rebuilt after STATE_INODE_TTL_MS; never invalidated sooner. */
let stateInodes: { dir: string; at: number; ids: Set<string> } | undefined;
const STATE_INODE_TTL_MS = 1500;

function taskStateInodes(dir: string): Set<string> {
  const now = Date.now();
  if (stateInodes && stateInodes.dir === dir && now - stateInodes.at < STATE_INODE_TTL_MS) return stateInodes.ids;
  const ids = new Set<string>();
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      try {
        const st = fs.lstatSync(full, { bigint: true });
        if (st.isFile()) ids.add(`${st.dev}:${st.ino}`);
      } catch { /* gone */ }
    }
  };
  walk(dir);
  stateInodes = { dir, at: now, ids };
  return ids;
}

/**
 * Whether `file` is a second name for a file anywhere below the task-state directory (device and inode). Only a
 * file with other links is looked up, against a snapshot at most STATE_INODE_TTL_MS old: a link made to a file that
 * appeared within that window is not seen (time-of-check gap, as for every path check here; the TTL is the only
 * invalidation).
 */
function isHardLinkToTaskState(file: string): boolean {
  try {
    const st = fs.statSync(file, { bigint: true });
    if (!st.isFile() || st.nlink < 2n) return false;
    return taskStateInodes(fs.realpathSync(defaultTaskStateDir())).has(`${st.dev}:${st.ino}`);
  } catch {
    return false;
  }
}

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
  /** Link to the attempt before this one (GV-3). Absent in sessions saved before v1.3.0. */
  chain?: ChainLink;
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
  /** A deny only because nobody is there to decide (headless, mode "approve"); a rule-based deny does not carry it. */
  needsDecision?: true;
  /** GV-1: the policy tier that set the mode this decision was made under, as `describeSource` renders it. */
  attribution?: string;
}) | null;

export const VERIFICATION_CONFIG_PROTECTED = "VERIFICATION_CONFIG_PROTECTED";
export const EGRESS_SECRET_BLOCKED = "EGRESS_SECRET_BLOCKED";

export interface EgressDecision {
  tool: string;
  hosts: string[];
  /** Names of what was found (`DB_PASSWORD`, `GITHUB_TOKEN`, `.env`): never values. */
  findings: string[];
  decision: "blocked" | "recorded";
  at: string;
}

/** CS-2 scan bounds: entries visited, bytes hashed per file, bytes kept per file so a change can be shown and reverted. */
const VERIFICATION_SNAPSHOT_MAX_ENTRIES = 20000;
const VERIFICATION_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
const VERIFICATION_SNAPSHOT_KEEP_BYTES = 64 * 1024;

export interface VerificationFileState {
  hash: string;
  /** The file as it was, kept when small enough to show a diff and restore it. */
  raw?: Buffer;
}
export interface VerificationSnapshot {
  files: Map<string, VerificationFileState>;
  /** False when the scan limit was reached: files beyond it were not covered. */
  complete: boolean;
}
export interface VerificationShellGuard {
  before: VerificationSnapshot;
  refusal?: string;
}
export interface VerificationShellChange {
  path: string;
  class: VerificationClass;
  kind: "modified" | "removed" | "added";
  /** A short line summary of what changed (removed lines with `-`, added with `+`), empty when the file is not small text. */
  diff: string[];
  /** The file's text before and after, when both were small enough to keep (`after` is "" for a removed file); absent otherwise. */
  beforeText?: string;
  afterText?: string;
}

const DIFF_LINES_SHOWN = 12;

/** Removed and added lines of a small text change, bounded. A summary, not a patch. */
function compactDiff(before: Buffer | undefined, after: Buffer | undefined): string[] {
  if (!before && !after) return [];
  const lines = (b: Buffer | undefined) => (b ? b.toString("utf8").split("\n") : []);
  const was = lines(before);
  const now = lines(after);
  const nowSet = new Set(now);
  const wasSet = new Set(was);
  const removed = was.filter((l) => !nowSet.has(l)).map((l) => `- ${l}`);
  const added = now.filter((l) => !wasSet.has(l)).map((l) => `+ ${l}`);
  const all = [...removed, ...added];
  return all.length > DIFF_LINES_SHOWN * 2 ? [...removed.slice(0, DIFF_LINES_SHOWN), ...added.slice(0, DIFF_LINES_SHOWN), `... (${all.length - DIFF_LINES_SHOWN * 2} more lines)`] : all;
}

/** Verification files that differ between two snapshots. A new runnable test file is free to create, as it is for the file tools. */
export function diffVerificationSnapshots(
  before: Map<string, VerificationFileState>,
  after: Map<string, VerificationFileState>,
  classOf: (rel: string) => VerificationClass | undefined,
): VerificationShellChange[] {
  const out: VerificationShellChange[] = [];
  for (const rel of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const was = before.get(rel);
    const now = after.get(rel);
    const cls = classOf(rel);
    if (!cls || (was && now && was.hash === now.hash)) continue;
    if (!was && cls === "test_file") continue;
    const known = was?.raw && (now ? now.raw : true);
    out.push({
      path: rel, class: cls, kind: !was ? "added" : !now ? "removed" : "modified", diff: compactDiff(was?.raw, now?.raw),
      ...(known ? { beforeText: was!.raw!.toString("utf8"), afterText: now?.raw ? now.raw.toString("utf8") : "" } : {}),
    });
  }
  return out;
}

export interface SecurityPolicy {
  version?: string;
  blockedCommands?: string[];
  protectedPaths?: string[];
  allowedDomains?: string[];
  verificationPaths?: VerificationPathsPolicy;
  /** CS-8: the egress inspector's mode and allowed destinations, from the operator's environment (NEXUS_EGRESS_POLICY), never from this file. */
  egressInspector?: EgressPolicy;
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
  // GV-1: the operator's approvals of project policy files: the agent must not approve a project policy for itself.
  "policy_trust.json",
  // HK-1: the operator's approvals of project hooks: the agent must not approve hooks for itself.
  "extension_trust.json",
  // HK-1: the operator's own hooks file (~/.config/nexus/hooks.json): the agent must not write the operator's hooks.
  "nexus/hooks.json",
  // BG-3: the operator's approvals of event triggers (~/.config/nexus/trigger_trust.json): the agent must not approve a trigger for itself.
  "trigger_trust.json",
  // BG-2: the operator's schedules (runner/nexus-schedules/ and its lock): the agent a schedule starts must not create or edit a schedule.
  "nexus-schedules*",
  // BG-3: the trigger firer's state and rate-limiter snapshot (runner/nexus-triggers/): an agent that can rewrite them can reset the limits and quarantines.
  "nexus-triggers*",
  ".env*",
  "id_rsa*",
  "id_ed25519*",
];

/**
 * HK-1: the operator's hooks file and the store of hook approvals, by absolute path. The names above match them from
 * outside; these match them when the workspace is their own directory, where the relative name is just `hooks.json`.
 */
function hookTrustFiles(): string[] {
  const store = extensionTrustStorePath();
  return [store, path.join(path.dirname(store), "hooks.json")];
}

/**
 * HK-3: the operator's own plugin directories, by absolute path (and real path): a module there is imported into
 * Nexus with no approval, so the agent's file tools must not be able to put one there, in any workspace.
 */
/** `target` with its deepest existing ancestor replaced by that ancestor's real path. */
function realSpelling(target: string): string {
  const missing: string[] = [];
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    try {
      return path.join(fs.realpathSync(current), ...missing);
    } catch {
      if (path.dirname(current) === current) return path.resolve(target);
      missing.unshift(path.basename(current));
    }
  }
}

function operatorPluginPaths(): string[] {
  const config = path.dirname(extensionTrustStorePath());
  // The home directory as the store's own path gives it (`~/.config/nexus`).
  const dirs = [path.join(path.resolve(config, "..", ".."), ".nexus", "plugins"), path.join(config, "plugins")];
  // The same directories as the file system really spells them, also when they do not exist yet (a home directory
  // reached through a link): the real path of the deepest part that exists, with the rest appended.
  const real = dirs.flatMap((dir) => {
    const spelled = realSpelling(dir);
    return spelled === dir ? [] : [spelled];
  });
  return [...dirs, ...real];
}

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
export const neutersTests = (text: string): boolean => NEUTERING_TEXT.test(text) || (text.match(/\/\*/g)?.length ?? 0) > (text.match(/\*\//g)?.length ?? 0);

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
export const isConditionalConfig = (rel: string): boolean => CONDITIONAL_CONFIG_FILES.has(path.posix.basename(rel).toLowerCase());
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

/**
 * Whether new text for package.json, pyproject.toml or setup.cfg changes what tests run (the keys or sections that
 * decide it). `before` is null when the file did not exist. Throws when a package.json is not JSON.
 */
export function conditionalConfigChanged(file: string, before: string | null, after: string): boolean {
  if (path.basename(file).toLowerCase() === "package.json") {
    const was = before === null ? {} : JSON.parse(before);
    const now = JSON.parse(after);
    return PACKAGE_VERIFICATION_KEYS.some((k) => JSON.stringify(was[k]) !== JSON.stringify(now[k]));
  }
  return JSON.stringify(verificationSections(before ?? "")) !== JSON.stringify(verificationSections(after));
}

/**
 * Repository policy may tighten verification protection in any workspace. Only an operator-trusted workspace may
 * use `off`, `record`, or `allow`, since those settings can weaken protection over the repository's own verifier.
 */
function parseVerificationPolicy(raw: unknown, trusted = true): VerificationPathsPolicy {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : undefined);
  return {
    mode:
      VERIFICATION_MODES.includes(value.mode as VerificationMode) &&
      (trusted || value.mode === "approve" || value.mode === "block")
        ? (value.mode as VerificationMode)
        : "approve",
    extra: strings(value.extra),
    allow: trusted ? strings(value.allow) : undefined,
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
  return `${VERIFICATION_CONFIG_PROTECTED}: '${decision.path}' is verification configuration (${decision.class}, rule '${decision.rule}'). An edit needs an operator decision; none was given. Report it to the operator instead of changing how the work is verified. A headless project that must create or change such files needs fullAccess (--yes) or verificationPaths.mode \"record\" in .nexus-security.json.${decision.attribution ? ` ${decision.attribution}` : ""}`;
}

/** A host name no URL can have: it keeps an allowlist that admits nothing from reading as "no allowlist" to a consumer that treats an empty list that way. */
const NO_HOST = " ";
const DEFAULT_SOURCE: PolicySource = { tier: "default", key: "paths.protected" };

export interface SecurityManagerOptions {
  /** The policy in force in a workspace (its real path). Omitted: the process's managed policy with the workspace's project file. */
  policyFor?: (workspace: string) => LoadedPolicy;
  /** Where the policy's notices go. Omitted: stderr, each notice once per process. */
  notify?: (notice: string) => void;
}

export class SecurityManager {
  private policy: SecurityPolicy;
  private workspace: string;
  private loaded!: LoadedPolicy;

  constructor(workspace: string, private readonly options: SecurityManagerOptions = {}) {
    this.workspace = path.resolve(workspace);
    this.policy = this.loadPolicy();
  }

  public reload(): void {
    this.policy = this.loadPolicy();
  }

  /**
   * GV-1: the settings in force are the merge of the managed tiers and the project's `.nexus-security.json`, as the
   * policy library computes it. The project file is read without following a link and within a size bound; what it
   * tightens always applies, what it relaxes applies only when the workspace is trusted and the file is the approved
   * one. A file that cannot be read or parsed leaves the built-in defaults and the managed tiers, and says so: every
   * notice of the load reaches the operator.
   */
  private loadPolicy(): SecurityPolicy {
    const workspace = realWorkspace(this.workspace);
    const loaded = this.options.policyFor
      ? this.options.policyFor(workspace)
      : processPolicyHost().forWorkspace(workspace, { workspaceTrusted: isWorkspaceListed(workspace), envTrustRequested: envTrustRequested() });
    this.loaded = loaded;
    const notify = this.options.notify ?? emitPolicyNotice;
    const say = (notice: string): void => notify(notice.startsWith("nexus: ") ? notice : `nexus: ${notice}`);
    for (const notice of loaded.notices) say(notice);
    const hint = approvalHint(loaded);
    if (hint) say(hint);

    const effective = loaded.effective;
    const relaxation = effective.verification.relaxation;
    const extra = effective.verification.protected.values;
    // The project's own host list keeps its existing matching in the fetch tool; a list that is set and empty admits nothing.
    const projectDomains = loaded.project.tier?.document.egress?.allowed_domains;
    const egress = egressPolicyFromEnv();
    const inspector = clampEgressInspector(effective, egress.mode);
    if (inspector.notice) say(inspector.notice);
    return {
      blockedCommands: [...DEFAULT_BLOCKED_COMMANDS, ...loaded.project.blockedCommandPatterns],
      // PA-3: the task-state directory holds goal state, caps and stall counts; the agent must not edit its own limits.
      protectedPaths: [...DEFAULT_PROTECTED_PATHS, runnerRoot(), ...taskStatePaths(), ...hookTrustFiles(), ...operatorPluginPaths(), ...effective.paths.protected.values],
      allowedDomains: projectDomains ? (projectDomains.length > 0 ? [...projectDomains] : [NO_HOST]) : undefined,
      verificationPaths: {
        mode: effectiveVerificationMode(effective).value,
        extra: extra.length > 0 ? [...extra] : undefined,
        allow: relaxation && relaxation.allow.length > 0 ? [...relaxation.allow] : undefined,
      },
      egressInspector: { ...egress, mode: inspector.mode },
    };
  }

  /** GV-1: the effective policy in this workspace (managed tiers and the project file), frozen. */
  public getEffectivePolicy(): EffectivePolicy {
    return this.loaded.effective;
  }

  /** The tier a protected-path pattern comes from, as shown beside a refusal. */
  private protectedPathSource(pattern: string): string {
    return describeSource(this.loaded.effective.paths.protected.items.find((item) => item.value === pattern)?.source ?? DEFAULT_SOURCE);
  }

  public isCommandBlocked(command: string): { blocked: boolean; reason?: string } {
    if (!command || typeof command !== "string") {
      return { blocked: false };
    }
    const trimmed = command.trim();
    if (trimmed.length === 0) {
      return { blocked: false };
    }

    // 0. GV-1: a managed `forbid` prefix refuses the command wherever it is run from, in every mode.
    const managed = decideManagedCommand(this.loaded.effective, splitSubcommands(trimmed));
    if (managed.decision === "forbidden") {
      return { blocked: true, reason: `Security Policy Violation: ${managed.message}` };
    }

    // 1. Custom blocked commands from policy (outside the default tripwire set)
    const customPatterns = (this.policy.blockedCommands || []).filter(
      (p) => !DEFAULT_BLOCKED_COMMANDS.includes(p)
    );
    for (const pattern of customPatterns) {
      if (pattern && trimmed.includes(pattern)) {
        return {
          blocked: true,
          reason: `Destructive-command tripwire: Command matches blocked pattern '${pattern}' ${describeSource({ tier: "project", file: this.loaded.project.file, key: "blockedCommands" })}`,
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

    // Patterns match a path relative to the workspace root, so a workspace that lives under a
    // directory such as `~/.env-tools/` or `~/id_rsa-backup/` is not blocked wholesale. Absolute
    // patterns (and targets outside the root) still match the absolute path.
    const checkCandidate = (cand: string, absolutePatternsOnly = false): { protected: boolean; reason?: string } => {
      const clean = cand.replace(/\\/g, "/");
      const segments = clean.split("/").filter(Boolean);
      const base = path.posix.basename(clean).toLowerCase();

      for (const pattern of this.policy.protectedPaths || []) {
        if (absolutePatternsOnly && !path.isAbsolute(pattern)) continue;
        const patLower = pattern.toLowerCase();
        // An absolute pattern also protects everything below it (BG-1/BG-2: the runner's state directory).
        if (path.isAbsolute(pattern) && clean.toLowerCase().startsWith(`${patLower.replace(/\/+$/, "")}/`)) {
          return { protected: true, reason: `Security Policy Violation: Path '${targetPath}' is inside protected directory '${pattern}' ${this.protectedPathSource(pattern)}` };
        }
        if (patLower === ".env*" || patLower === ".env") {
          if (segments.some((seg) => seg.toLowerCase().startsWith(".env"))) {
            return {
              protected: true,
              reason: `Security Policy Violation: Path '${targetPath}' matches protected pattern '${pattern}' ${this.protectedPathSource(pattern)}`,
            };
          }
        } else if (patLower.endsWith("*")) {
          const prefix = patLower.slice(0, -1);
          if (segments.some((seg) => seg.toLowerCase().startsWith(prefix))) {
            return {
              protected: true,
              reason: `Security Policy Violation: Path '${targetPath}' matches protected pattern '${pattern}' ${this.protectedPathSource(pattern)}`,
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
              reason: `Security Policy Violation: Path '${targetPath}' is protected under security policy ${this.protectedPathSource(pattern)}`,
            };
          }
        }
      }
      return { protected: false };
    };

    // The path relative to `root` when it is inside it; otherwise null (the caller matches the
    // absolute path, which keeps a symlink that leaves the workspace for a protected target refused).
    const relativeInside = (root: string, abs: string): string | null => {
      const rel = path.relative(root, abs);
      if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return null;
      return rel;
    };
    const checkAgainstRoot = (root: string, abs: string, altRoot?: string): { protected: boolean; reason?: string } => {
      const rel = relativeInside(root, abs) ?? (altRoot ? relativeInside(altRoot, abs) : null);
      if (rel === null) return checkCandidate(abs);
      const relCheck = checkCandidate(rel);
      return relCheck.protected ? relCheck : checkCandidate(abs, true);
    };

    let realRoot = this.workspace;
    try {
      realRoot = fs.realpathSync(this.workspace);
    } catch {}

    // 1. Raw given path (relative paths are already workspace-relative)
    const rawCheck = path.isAbsolute(targetPath)
      ? checkAgainstRoot(this.workspace, path.resolve(targetPath), realRoot)
      : checkCandidate(targetPath);
    if (rawCheck.protected) return rawCheck;

    // 2. Absolute path in workspace
    const absPath = path.isAbsolute(targetPath) ? targetPath : path.resolve(this.workspace, targetPath);
    const absCheck = checkAgainstRoot(this.workspace, path.resolve(absPath), realRoot);
    if (absCheck.protected) return absCheck;

    // 3. Canonical target (resolves symlinks), relative to the resolved workspace root
    try {
      if (fs.existsSync(absPath)) {
        const real = fs.realpathSync(absPath);
        const realCheck = checkAgainstRoot(realRoot, real, this.workspace);
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
          const canonCheck = checkAgainstRoot(realRoot, canonicalTarget, this.workspace);
          if (canonCheck.protected) return canonCheck;
        }
      }
    } catch {}

    // 4. A hard link to a goal-state file is the same file under another name: compare device and inode.
    if (isHardLinkToTaskState(absPath)) {
      return { protected: true, reason: `Security Policy Violation: Path '${targetPath}' is a hard link to protected goal state` };
    }

    return { protected: false };
  }

  private verificationAttempts: VerificationConfigAttempt[] = [];
  /** Link of the last attempt; undefined before the first, and when the restored log cannot be continued. */
  private lastAttemptLink: ChainLink | undefined;
  /** False once a restored log was unchained or broken: later attempts are appended without links, so its state stays visible. */
  private attemptsChained = true;

  public getVerificationAttempts(): VerificationConfigAttempt[] {
    return this.verificationAttempts.map((a) => ({ ...a }));
  }

  /**
   * Take over the attempts of a saved session. They are kept exactly as read, including a log that no longer
   * verifies: this class reports the damage (verificationAttemptsIntegrity) and never repairs or drops records.
   */
  public restoreVerificationAttempts(attempts: VerificationConfigAttempt[] | undefined): void {
    this.verificationAttempts = Array.isArray(attempts) ? attempts.map((a) => ({ ...a })) : [];
    const verdict = verifyChain(this.verificationAttempts);
    this.attemptsChained = verdict.status === "intact";
    this.lastAttemptLink = verdict.status === "intact" ? verdict.head : undefined;
  }

  /** Whether the verification-configuration attempt log reads as it was written (core/hash_chain.ts). */
  public verificationAttemptsIntegrity(): ChainVerdict {
    return verifyChain(this.verificationAttempts);
  }

  public recordVerificationAttempt(rel: string, cls: VerificationClass, tool: string, decision: VerificationDecisionLabel, role?: string): void {
    const attempt: VerificationConfigAttempt = { path: rel, class: cls, tool, decision, role: role ?? null, timestamp: new Date().toISOString() };
    if (!this.attemptsChained) {
      this.verificationAttempts.push(attempt);
      return;
    }
    const linked = linkRecord(attempt, this.lastAttemptLink);
    this.lastAttemptLink = linked.chain;
    this.verificationAttempts.push(linked);
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
      return conditionalConfigChanged(abs, exists ? beforeText : null, afterText);
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
    // The protection of the policy file itself is built in; every other mode is the effective policy's.
    const decidedBy = found.class === "policy" && configured.mode !== "block" ? { tier: "default" as const, key: "verification.mode" } : effectiveVerificationMode(this.loaded.effective).source;
    const base = { ...found, path: rel, attribution: describeSource(decidedBy) };
    if (mode === "approve" && ctx.role === "tester" && found.class === "test_file" && !directory && this.appendsToExistingTest(toolName, args, abs)) {
      return { ...base, action: "allow", label: "role-allowed" };
    }
    if (mode === "record") return { ...base, action: "allow", label: "auto-recorded" };
    if (mode === "block") return { ...base, action: "deny" };
    if (ctx.approved?.path === rel) return { ...base, action: "allow", label: "operator-approved" };
    if (ctx.fullAccess && found.class !== "policy") return { ...base, action: "allow", label: "auto-recorded" };
    return ctx.operator ? { ...base, action: "ask" } : { ...base, action: "deny", needsDecision: true };
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

  /**
   * CS-2, opt-in (`verificationPaths.mode: "block"`): a shell command may not change the files that decide how work is
   * verified. Detection compares file contents before and after the command, so it does not depend on recognising the
   * command (`sed -i`, `python -c`, `perl -pi`, a build script...). Other modes keep the record-only behaviour of
   * `recordVerificationCommand` and cost nothing here.
   */
  public beginVerificationShellGuard(): VerificationShellGuard | undefined {
    if ((this.policy.verificationPaths?.mode ?? "approve") !== "block" && !this.shellChangeObserver) return undefined;
    const before = this.snapshotVerificationFiles();
    const refusal = (this.policy.verificationPaths?.mode ?? "approve") === "block" && !before.complete
      ? `${VERIFICATION_CONFIG_PROTECTED}: the bounded verification snapshot is incomplete, so shell execution is refused until the workspace can be scanned completely.`
      : undefined;
    return { before, ...(refusal ? { refusal } : {}) };
  }

  /**
   * DV-3: told, after every guarded shell command, which verification files it changed (any mode, nothing reverted or
   * refused). The agent sets it while an operator-authorised regression obligation exists, so a test edited through the
   * shell is recorded from the same snapshot and diff the block mode uses.
   */
  public setShellChangeObserver(observer: ((changes: VerificationShellChange[], scan: { complete: boolean }) => void) | undefined): void {
    this.shellChangeObserver = observer;
  }
  private shellChangeObserver?: (changes: VerificationShellChange[], scan: { complete: boolean }) => void;

  /** What changed in the verification files since `guard` began. In block mode each change is reverted, recorded as blocked and returned as the refusal. */
  public finishVerificationShellGuard(guard: VerificationShellGuard, role?: string): { error?: string; note?: string } {
    const after = this.snapshotVerificationFiles();
    const block = (this.policy.verificationPaths?.mode ?? "approve") === "block";
    const complete = guard.before.complete && after.complete;
    const changes = diffVerificationSnapshots(guard.before.files, after.files, (rel) => this.classifyVerificationPath(rel)?.class);
    if (changes.length || !complete) this.shellChangeObserver?.(changes, { complete });
    if (!block) {
      return {};
    }
    const note = !guard.before.complete || !after.complete
      ? `[nexus] Shell-write guard: the workspace is larger than the ${VERIFICATION_SNAPSHOT_MAX_ENTRIES}-entry scan limit, so verification files beyond it were not checked.`
      : undefined;
    if (!changes.length) return note ? { note } : {};
    const lines: string[] = [];
    for (const change of changes) {
      this.recordVerificationAttempt(change.path, change.class, "run_command", "blocked", role);
      const restored = this.restoreVerificationFile(change, guard.before.files.get(change.path));
      lines.push(`- ${change.path} (${change.class}) ${change.kind}${restored ? ", restored" : ", could not be restored"}`, ...change.diff.map((d) => `    ${d}`));
    }
    return {
      error: `${VERIFICATION_CONFIG_PROTECTED}: the command changed verification configuration, which the policy (verificationPaths.mode "block") does not allow a shell command to do:\n${lines.join("\n")}`,
      ...(note ? { note } : {}),
    };
  }

  private restoreVerificationFile(change: VerificationShellChange, before: VerificationFileState | undefined): boolean {
    const abs = path.resolve(this.workspace, change.path);
    if (path.relative(this.workspace, abs).startsWith("..")) return false;
    try {
      if (change.kind === "added") {
        fs.rmSync(abs, { force: true });
        return true;
      }
      if (!before?.raw) return false;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, before.raw);
      return true;
    } catch {
      return false;
    }
  }

  /** The fingerprint of every verification file in the workspace (bounded walk, heavy directories skipped). Conditional configs fingerprint only the keys and sections that decide how tests run, so a dependency bump is not a change. */
  private snapshotVerificationFiles(): VerificationSnapshot {
    const files = new Map<string, VerificationFileState>();
    let visited = 0;
    let complete = true;
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (++visited > VERIFICATION_SNAPSHOT_MAX_ENTRIES) { complete = false; return; }
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!HEAVY_DIRECTORIES.has(entry.name)) walk(child);
          if (!complete) return;
        } else if (entry.isFile()) {
          const rel = path.relative(this.workspace, child).replace(/\\/g, "/");
          if (this.classifyVerificationPath(rel)) {
            const state = this.fingerprintVerificationFile(child, rel);
            if (state) files.set(rel, state);
            else complete = false;
          }
        }
      }
    };
    walk(this.workspace);
    return { files, complete };
  }

  private fingerprintVerificationFile(abs: string, rel: string): VerificationFileState | undefined {
    try {
      const stat = fs.statSync(abs);
      if (stat.size > VERIFICATION_SNAPSHOT_MAX_BYTES) return undefined;
      const raw = fs.readFileSync(abs);
      let subject: Buffer | string = raw;
      if (isConditionalConfig(rel)) {
        const text = raw.toString("utf8");
        try {
          subject = path.basename(rel).toLowerCase() === "package.json"
            ? JSON.stringify(PACKAGE_VERIFICATION_KEYS.map((k) => (JSON.parse(text) as Record<string, unknown>)[k] ?? null))
            : JSON.stringify(verificationSections(text));
        } catch {
          subject = raw; // unparseable: any change counts
        }
      }
      return { hash: createHash("sha256").update(subject).digest("hex"), raw: raw.length <= VERIFICATION_SNAPSHOT_KEEP_BYTES ? raw : undefined };
    } catch {
      return undefined;
    }
  }

  public getPolicy(): SecurityPolicy {
    return this.policy;
  }

  private egressDecisions: EgressDecision[] = [];

  /** CS-8: what the egress inspector found in a tool call and what it did (names only, never values). */
  public recordEgressDecision(decision: Omit<EgressDecision, "at">): void {
    this.egressDecisions.push({ ...decision, at: new Date().toISOString() });
    if (this.egressDecisions.length > 200) this.egressDecisions.splice(0, this.egressDecisions.length - 200);
  }

  public getEgressDecisions(): EgressDecision[] {
    return this.egressDecisions.map((d) => ({ ...d, findings: [...d.findings], hosts: [...d.hosts] }));
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
