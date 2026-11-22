/**
 * GV-1 and GV-5: managed policy as a pure library. Nothing here reads a file, the environment or the clock, and
 * nothing in Nexus calls it yet: this module only defines what a policy document is, how the tiers combine, and what
 * a combined policy says about a request. The loader is managed_policy_load.ts; the text format is
 * managed_policy_toml.ts; the administrator's description is docs/MANAGED_POLICY.md.
 *
 * Restrict-only, in two places:
 *   - the types: no member of `PolicyDocument` can express a grant. A boolean switches something off or makes
 *     something mandatory; a list adds things to refuse, ask about or protect; an allowlist narrows what is admitted;
 *     an enumeration is a floor. There is no "allow this command", "trust this workspace" or "mode = off".
 *   - the merge: the tiers are combined with a meet (OR, union, intersection, maximum), so adding a tier can only make
 *     the result stricter and an absent tier changes nothing. The order system > user > project therefore never
 *     changes a value: it only names the tier a decision is attributed to.
 *
 * The project tier is the existing `.nexus-security.json`. Its tightening settings become a `PolicyDocument` like any
 * other; the two settings that weaken verification protection (`mode: off | record` and `allow`) are kept apart as
 * `ProjectRelaxations` and take effect only when the caller says the workspace is trusted and its file is the approved
 * one, and no managed tier sets anything under `[verification]`.
 */
import type { PolicyTomlDocument, PolicyTomlEntry } from "./managed_policy_toml.js";

/**
 * Version of the policy document. Every added, removed or changed key bumps it, and a reader refuses a version it does
 * not list, so a newer policy is never half-understood: upgrade Nexus first, then roll out the policy. Each version is
 * recorded in docs/protocol/POLICY_VERSIONS.json.
 */
export const POLICY_SCHEMA_VERSION = 1;
export const SUPPORTED_POLICY_SCHEMA_VERSIONS: readonly number[] = [POLICY_SCHEMA_VERSION];

/** The effects a policy can require a human decision for. */
export type HumanEffect = "exec" | "write_workspace" | "egress";
/** A floor for verification-path protection. `off` and `record` are not members: a policy cannot ask for less. */
export type VerificationFloor = "approve" | "block";
/** A floor for the egress inspector. */
export type EgressInspectorFloor = "record" | "block";

/** `[approval]`: what the operator may not switch on. */
export interface ApprovalPolicy {
  /** Shorthand for `disable_auto`, `disable_yes` and `disable_full_access` together. */
  strict?: boolean;
  /** Approval mode `auto` is unavailable, whatever asks for it. */
  disable_auto?: boolean;
  /** `-y` / `--yes` is unavailable. */
  disable_yes?: boolean;
  /** Full access is unavailable, whatever asks for it. */
  disable_full_access?: boolean;
  /** Effects that always need a human decision, also under full access. */
  require_human?: HumanEffect[];
}

/** `[verification]`: protection of the files that decide whether work is verified. */
export interface VerificationPolicy {
  /** The least protection mode. */
  mode?: VerificationFloor;
  /** More protected verification paths (globs, workspace-relative). */
  protected?: string[];
}

/** `[commands]`: command prefixes. There is no allow key. */
export interface CommandsPolicy {
  /** Command prefixes that are refused, such as "git push". */
  forbid?: string[];
  /** Command prefixes that always ask, also under full access. */
  prompt?: string[];
  /** The operator's own `allow` command rules are not used. */
  disable_allow_rules?: boolean;
}

/** `[paths]`. */
export interface PathsPolicy {
  /** More protected path patterns. */
  protected?: string[];
}

/** `[egress]`. A list here is an allowlist: absent means unrestricted, present (even empty) means only these. */
export interface EgressPolicyTable {
  /** The least egress-inspector mode. */
  inspector?: EgressInspectorFloor;
  /** The only hosts that may be reached: `example.com`, or `*.example.com` for its subdomains. */
  allowed_domains?: string[];
  /** The only origins a credential may be sent to, such as `https://api.example.com`. */
  secret_destinations?: string[];
}

/** `[sandbox]`. */
export interface SandboxPolicy {
  /** Commands run only inside the sandbox. */
  required?: boolean;
  /** Sandboxed commands get no network. */
  forbid_network?: boolean;
}

/** `[mcp]`. `allow` is an allowlist: absent means unrestricted, present (even empty) means only these. */
export interface McpPolicy {
  /** The only MCP servers that may start: a server name, `command:/absolute/path` or `url:https://origin`. */
  allow?: string[];
  /** MCP servers configured by the workspace are not started. */
  disable_workspace?: boolean;
}

/** `[plugins]`. `allow` is an allowlist: absent means unrestricted, present (even empty) means only these. */
export interface PluginsPolicy {
  /** The only plugin files that may be imported: `sha256:<64 hex digits>` or `file:/absolute/path`. */
  allow?: string[];
  /** Plugins from the workspace are not imported. */
  disable_workspace?: boolean;
}

/** `[workspace]`. */
export interface WorkspacePolicy {
  /** `NEXUS_TRUST_WORKSPACE` is ignored. */
  disable_env_trust?: boolean;
}

/** The normalized content of one policy tier. Every member restricts; none grants. */
export interface PolicyDocument {
  approval?: ApprovalPolicy;
  verification?: VerificationPolicy;
  commands?: CommandsPolicy;
  paths?: PathsPolicy;
  egress?: EgressPolicyTable;
  sandbox?: SandboxPolicy;
  mcp?: McpPolicy;
  plugins?: PluginsPolicy;
  workspace?: WorkspacePolicy;
}

/** A managed policy file as data: the tables of `PolicyDocument` and the required `schema_version`. The published schema is generated from this type. */
export type ManagedPolicyFile = PolicyDocument & {
  /** The version of this document; required. */
  schema_version: typeof POLICY_SCHEMA_VERSION;
};

/**
 * The two things a project's `.nexus-security.json` may ask for that weaken verification protection. They are not part
 * of `PolicyDocument` and never take part in the meet.
 */
export interface ProjectRelaxations {
  /** `verificationPaths.mode` when it is below the default `approve`. */
  verification_mode?: "off" | "record";
  /** `verificationPaths.allow`: globs exempted from verification-path protection. */
  verification_allow?: string[];
}

// ---------------------------------------------------------------------------------------------------------------------
// The schema as data: which tables and keys exist, their type, and how tiers combine. The validator and the document
// meet are driven by it; docs and tests read it.

type ItemCheck = (item: string) => string | undefined;

export type PolicyKeySpec =
  | { kind: "bool"; merge: "or" }
  /** `values` in increasing order of restriction. */
  | { kind: "enum"; merge: "max"; values: readonly string[] }
  | { kind: "list"; merge: "union" | "intersection"; check: ItemCheck; describe: string };

const BOOL: PolicyKeySpec = { kind: "bool", merge: "or" };
const HUMAN_EFFECTS: readonly HumanEffect[] = ["exec", "write_workspace", "egress"];
const HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const nonEmpty: ItemCheck = (item) => (item.trim() === "" ? "must not be empty" : item !== item.trim() ? "must not start or end with a space" : undefined);
const commandPrefix: ItemCheck = (item) => {
  if (!/^\S+(?: \S+)*$/.test(item)) return "must be command words separated by single spaces, such as \"git push\"";
  return item.split(" ").length > 16 ? "must have at most 16 words" : undefined;
};
const host: ItemCheck = (item) => (HOST.test(item) && item.length <= 253 ? undefined : "must be a lowercase host name such as \"example.com\", or \"*.example.com\" for its subdomains");
/** The origin of `text` when `text` is exactly an http(s) origin in its canonical form; otherwise undefined. */
function canonicalOrigin(text: string): string | undefined {
  try {
    const url = new URL(text);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === text ? text : undefined;
  } catch {
    return undefined;
  }
}
const origin: ItemCheck = (item) => (canonicalOrigin(item) ? undefined : "must be an origin in canonical form, such as \"https://api.example.com\" (scheme and lowercase host, optional port, no path)");
const absolutePath = (text: string): boolean => text.startsWith("/") && !text.split("/").some((part) => part === "." || part === "..") && !text.includes("//") && (text === "/" || !text.endsWith("/"));
const mcpEntry: ItemCheck = (item) => {
  if (item.startsWith("command:")) return absolutePath(item.slice(8)) ? undefined : "a command: entry needs an absolute, normalized path, such as \"command:/usr/local/bin/server\"";
  if (item.startsWith("url:")) return canonicalOrigin(item.slice(4)) ? undefined : "a url: entry needs an origin in canonical form, such as \"url:https://mcp.example.com\"";
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item) ? undefined : "must be a server name (letters, digits, '.', '_', '-'), \"command:/absolute/path\" or \"url:https://origin\"";
};
const pluginEntry: ItemCheck = (item) => {
  if (item.startsWith("sha256:")) return /^[0-9a-f]{64}$/.test(item.slice(7)) ? undefined : "a sha256: entry needs 64 lowercase hexadecimal digits";
  if (item.startsWith("file:")) return absolutePath(item.slice(5)) ? undefined : "a file: entry needs an absolute, normalized path, such as \"file:/opt/nexus/plugins/audit.mjs\"";
  return "must be \"sha256:<64 hex digits>\" or \"file:/absolute/path\"";
};
const oneOf = (values: readonly string[]): ItemCheck => (item) => (values.includes(item) ? undefined : `must be one of ${values.map((v) => `"${v}"`).join(", ")}`);

const union = (check: ItemCheck, describe: string): PolicyKeySpec => ({ kind: "list", merge: "union", check, describe });
const allowlist = (check: ItemCheck, describe: string): PolicyKeySpec => ({ kind: "list", merge: "intersection", check, describe });

/** Every table and key of a policy document. A table or key that is not here is an error in a managed file. */
export const POLICY_KEYS = {
  approval: {
    strict: BOOL,
    disable_auto: BOOL,
    disable_yes: BOOL,
    disable_full_access: BOOL,
    require_human: union(oneOf(HUMAN_EFFECTS), "effects"),
  },
  verification: {
    mode: { kind: "enum", merge: "max", values: ["approve", "block"] },
    protected: union(nonEmpty, "globs"),
  },
  commands: {
    forbid: union(commandPrefix, "command prefixes"),
    prompt: union(commandPrefix, "command prefixes"),
    disable_allow_rules: BOOL,
  },
  paths: {
    protected: union(nonEmpty, "path patterns"),
  },
  egress: {
    inspector: { kind: "enum", merge: "max", values: ["record", "block"] },
    allowed_domains: allowlist(host, "host names"),
    secret_destinations: allowlist(origin, "origins"),
  },
  sandbox: {
    required: BOOL,
    forbid_network: BOOL,
  },
  mcp: {
    allow: allowlist(mcpEntry, "MCP server entries"),
    disable_workspace: BOOL,
  },
  plugins: {
    allow: allowlist(pluginEntry, "plugin entries"),
    disable_workspace: BOOL,
  },
  workspace: {
    disable_env_trust: BOOL,
  },
} as const satisfies { [T in keyof PolicyDocument]-?: { [K in keyof NonNullable<PolicyDocument[T]>]-?: PolicyKeySpec } };

type Tables = Record<string, Record<string, PolicyKeySpec>>;
type LooseDocument = Record<string, Record<string, unknown> | undefined>;
const SPEC: Tables = POLICY_KEYS;

// ---------------------------------------------------------------------------------------------------------------------
// Validation: parser output -> PolicyDocument.

export type PolicyValidationCode =
  | "empty"
  | "schema_version_missing"
  | "schema_version_unsupported"
  | "unknown_table"
  | "unknown_key"
  | "wrong_type"
  | "bad_value";

/** A parsed file that is not a policy document. `message` is `line N: <detail>` (or the detail alone); no trailing period. */
export class PolicyValidationError extends Error {
  constructor(
    public readonly code: PolicyValidationCode,
    public readonly detail: string,
    public readonly line?: number,
  ) {
    super(line === undefined ? detail : `line ${line}: ${detail}`);
    this.name = "PolicyValidationError";
  }
}

export interface ValidatedPolicy {
  schemaVersion: number;
  document: PolicyDocument;
  /** The line of each key that is set, by `table.key`. */
  lines: ReadonlyMap<string, number>;
}

function validateValue(name: string, spec: PolicyKeySpec, entry: PolicyTomlEntry): unknown {
  const { value, line } = entry;
  if (spec.kind === "bool") {
    if (typeof value !== "boolean") throw new PolicyValidationError("wrong_type", `key '${name}' must be true or false`, line);
    return value;
  }
  if (spec.kind === "enum") {
    const allowed = spec.values.map((v) => `"${v}"`).join(" or ");
    if (typeof value !== "string") throw new PolicyValidationError("wrong_type", `key '${name}' must be ${allowed}`, line);
    if (!spec.values.includes(value)) throw new PolicyValidationError("bad_value", `key '${name}' must be ${allowed} (found "${value}"); a policy can only raise this, never lower it`, line);
    return value;
  }
  if (!Array.isArray(value)) throw new PolicyValidationError("wrong_type", `key '${name}' must be an array of strings (${spec.describe})`, line);
  const items: string[] = [];
  value.forEach((item, i) => {
    const problem = spec.check(item);
    if (problem) throw new PolicyValidationError("bad_value", `key '${name}', item ${i + 1} ("${item.length > 60 ? `${item.slice(0, 60)}...` : item}") ${problem}`, entry.itemLines?.[i] ?? line);
    if (!items.includes(item)) items.push(item);
  });
  return items;
}

/**
 * Turns the parser's output into a policy document, or throws `PolicyValidationError`. Strict: an unknown table or key,
 * a wrong type, a value outside an enumeration, a missing `schema_version` and a version this build does not support
 * are all errors naming the table, the key and the line.
 */
export function validatePolicyDocument(toml: PolicyTomlDocument): ValidatedPolicy {
  if (toml.root.size === 0 && toml.tables.size === 0) {
    throw new PolicyValidationError("empty", "the file is empty; a policy file needs at least the line `schema_version = 1`");
  }
  const version = toml.root.get("schema_version");
  if (!version) throw new PolicyValidationError("schema_version_missing", "schema_version is missing; add `schema_version = 1` as the first line");
  if (typeof version.value !== "number") throw new PolicyValidationError("wrong_type", "key 'schema_version' must be a whole number", version.line);
  if (!SUPPORTED_POLICY_SCHEMA_VERSIONS.includes(version.value)) {
    throw new PolicyValidationError(
      "schema_version_unsupported",
      `schema_version ${version.value} is not supported by this Nexus (supported: ${SUPPORTED_POLICY_SCHEMA_VERSIONS.join(", ")}); upgrade Nexus before rolling out this policy`,
      version.line,
    );
  }
  for (const [key, entry] of toml.root) {
    if (key !== "schema_version") throw new PolicyValidationError("unknown_key", `unknown key '${key}'${Object.hasOwn(SPEC, key) ? ` ('${key}' is a table: write [${key}])` : ""}`, entry.line);
  }
  const document: LooseDocument = {};
  const lines = new Map<string, number>();
  for (const [tableName, table] of toml.tables) {
    if (!Object.hasOwn(SPEC, tableName)) throw new PolicyValidationError("unknown_table", `unknown table '[${tableName}]'`, table.line);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of table.entries) {
      const name = `${tableName}.${key}`;
      if (!Object.hasOwn(SPEC[tableName], key)) throw new PolicyValidationError("unknown_key", `unknown key '${name}'`, entry.line);
      out[key] = validateValue(name, SPEC[tableName][key], entry);
      lines.set(name, entry.line);
    }
    document[tableName] = out;
  }
  return { schemaVersion: version.value, document: document as PolicyDocument, lines };
}

// ---------------------------------------------------------------------------------------------------------------------
// The project adapter: a parsed `.nexus-security.json` -> restrictive document + relaxations.

export interface ProjectPolicyParts {
  /** What the file tightens. Applies in every workspace, trusted or not. */
  restrictive: PolicyDocument;
  /** What the file would weaken. Never applied by this function; see `mergePolicies`. */
  relaxations: ProjectRelaxations;
  /**
   * `blockedCommands`, unchanged. They are substring patterns for the destructive-command tripwire, not command
   * prefixes, so they are not turned into `commands.forbid` rules (a prefix rule would match differently). They only
   * ever block.
   */
  blockedCommandPatterns: string[];
  /** Settings that were ignored, each with the reason. Never silent. */
  notices: string[];
}

export function hasRelaxations(relaxations: ProjectRelaxations | undefined): boolean {
  return Boolean(relaxations && (relaxations.verification_mode !== undefined || (relaxations.verification_allow?.length ?? 0) > 0));
}

/**
 * Maps the object read from `.nexus-security.json`. Throws `PolicyValidationError` when the value is not an object;
 * a member of the wrong shape is ignored with a notice, and ignoring a member never widens anything: a dropped
 * tightening leaves the other tiers and the built-in defaults in force, and a dropped allowlist entry narrows the list.
 */
export function projectPolicyFromSecurityJson(raw: unknown): ProjectPolicyParts {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PolicyValidationError("wrong_type", "the file must contain a JSON object");
  const source = raw as Record<string, unknown>;
  const notices: string[] = [];
  const strings = (value: unknown, name: string, check?: ItemCheck): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      notices.push(`${name} is not an array and was ignored`);
      return undefined;
    }
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || item.length === 0 || item.length > 1024 || (check && check(item) !== undefined)) notices.push(`${name}: an entry that is not ${check ? "valid" : "a non-empty string"} was ignored`);
      else if (!out.includes(item)) out.push(item);
    }
    if (out.length > 500) {
      notices.push(`${name}: only the first 500 entries are used`);
      return out.slice(0, 500);
    }
    return out;
  };
  const restrictive: PolicyDocument = {};
  const relaxations: ProjectRelaxations = {};

  const blockedCommandPatterns = strings(source.blockedCommands, "blockedCommands") ?? [];
  const protectedPaths = strings(source.protectedPaths, "protectedPaths");
  if (protectedPaths?.length) restrictive.paths = { protected: protectedPaths };
  // An allowlist stays present when entries are dropped, and when it is empty: only the listed hosts, so none.
  const domains = strings(source.allowedDomains, "allowedDomains", host);
  if (domains) restrictive.egress = { allowed_domains: domains };

  const verification = source.verificationPaths;
  if (verification !== undefined) {
    if (!verification || typeof verification !== "object" || Array.isArray(verification)) {
      notices.push("verificationPaths is not an object and was ignored");
    } else {
      const v = verification as Record<string, unknown>;
      const table: VerificationPolicy = {};
      if (v.mode === "approve" || v.mode === "block") table.mode = v.mode;
      else if (v.mode === "off" || v.mode === "record") relaxations.verification_mode = v.mode;
      else if (v.mode !== undefined) notices.push("verificationPaths.mode is not one of off, record, approve, block and was ignored");
      const extra = strings(v.extra, "verificationPaths.extra");
      if (extra?.length) table.protected = extra;
      const allow = strings(v.allow, "verificationPaths.allow");
      if (allow?.length) relaxations.verification_allow = allow;
      if (table.mode !== undefined || table.protected) restrictive.verification = table;
    }
  }
  if (source.egressInspector !== undefined) notices.push("egressInspector is ignored: a repository cannot change the egress inspector");
  return { restrictive, relaxations, blockedCommandPatterns, notices };
}

// ---------------------------------------------------------------------------------------------------------------------
// The meet of two documents (values only).

function meetValues(spec: PolicyKeySpec, a: unknown, b: unknown): unknown {
  if (a === undefined) return Array.isArray(b) ? [...b] : b;
  if (b === undefined) return Array.isArray(a) ? [...a] : a;
  if (spec.kind === "bool") return a === true || b === true;
  if (spec.kind === "enum") return spec.values.indexOf(a as string) >= spec.values.indexOf(b as string) ? a : b;
  const left = a as string[];
  const right = b as string[];
  if (spec.merge === "union") return [...left, ...right.filter((item) => !left.includes(item))];
  return left.filter((item) => right.includes(item));
}

/**
 * The meet of two policy documents: for every key the more restrictive of the two (OR, union, intersection, maximum).
 * An absent key is the identity. Idempotent, commutative and associative up to the order of list items.
 */
export function meetDocuments(a: PolicyDocument, b: PolicyDocument): PolicyDocument {
  const left = a as LooseDocument;
  const right = b as LooseDocument;
  const out: LooseDocument = {};
  for (const [tableName, keys] of Object.entries(SPEC)) {
    const table: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(keys)) {
      const value = meetValues(spec, left[tableName]?.[key], right[tableName]?.[key]);
      if (value !== undefined) table[key] = value;
    }
    if (Object.keys(table).length > 0) out[tableName] = table;
  }
  return out as PolicyDocument;
}

// ---------------------------------------------------------------------------------------------------------------------
// The effective policy and its attribution.

export type PolicyTierName = "system" | "user" | "project";

/** Where a decision comes from. `operator-rules` is the operator's own command rules file, named by later callers. */
export interface PolicySource {
  tier: PolicyTierName | "operator-rules" | "default";
  file?: string;
  /** `table.key`. */
  key: string;
  line?: number;
}

/** One tier as the merge takes it: the document, and where it was read from (for attribution). */
export interface PolicyTier {
  document: PolicyDocument;
  file?: string;
  lines?: ReadonlyMap<string, number>;
}

/** The project tier: its restrictive document, plus the relaxations and whether the caller found them approved. */
export interface ProjectPolicyTier extends PolicyTier {
  relaxations?: ProjectRelaxations;
  /** True only when the workspace is trusted and the file is the approved one (see `policyIntegrity` in the loader). */
  relaxationsApply?: boolean;
}

export interface Decided<T> {
  value: T;
  source: PolicySource;
}

export interface SourcedItem {
  value: string;
  /** The highest tier that lists the item. */
  source: PolicySource;
}

/** A union list: everything any tier lists. */
export interface EffectiveList {
  values: readonly string[];
  items: readonly SourcedItem[];
}

/** An allowlist: unrestricted when no tier sets it; otherwise only the items every setting tier lists. */
export interface EffectiveAllowlist {
  restricted: boolean;
  values: readonly string[];
  items: readonly SourcedItem[];
  /** The highest tier that sets the list, or the default. */
  source: PolicySource;
  /** Each tier that sets the list with its own items, highest first: who to name when something is refused. */
  tiers: readonly { source: PolicySource; values: readonly string[] }[];
}

export type RelaxationStatus =
  /** The project asks for none. */
  | "none"
  | "applied"
  /** The caller did not find the project file trusted and approved. */
  | "not_approved"
  /** A managed tier sets something under `[verification]`. */
  | "void_managed";

export interface EffectivePolicy {
  /** The tiers that were present. */
  tiers: readonly PolicyTierName[];
  approval: {
    strict: Decided<boolean>;
    /** `disable_auto`, `disable_yes` and `disable_full_access` include `strict`. */
    disable_auto: Decided<boolean>;
    disable_yes: Decided<boolean>;
    disable_full_access: Decided<boolean>;
    require_human: EffectiveList;
  };
  verification: {
    /** The floor; undefined when no tier sets one. */
    mode: Decided<VerificationFloor | undefined>;
    protected: EffectiveList;
    relaxationStatus: RelaxationStatus;
    /** The project's relaxations, present only when `relaxationStatus` is `applied`. */
    relaxation?: { mode?: "off" | "record"; allow: readonly string[]; source: PolicySource };
    /** For `void_managed`: the managed setting that voids the relaxations. */
    relaxationVoidedBy?: PolicySource;
  };
  commands: { forbid: EffectiveList; prompt: EffectiveList; disable_allow_rules: Decided<boolean> };
  paths: { protected: EffectiveList };
  egress: { inspector: Decided<EgressInspectorFloor | undefined>; allowed_domains: EffectiveAllowlist; secret_destinations: EffectiveAllowlist };
  sandbox: { required: Decided<boolean>; forbid_network: Decided<boolean> };
  mcp: { allow: EffectiveAllowlist; disable_workspace: Decided<boolean> };
  plugins: { allow: EffectiveAllowlist; disable_workspace: Decided<boolean> };
  workspace: { disable_env_trust: Decided<boolean> };
}

type NamedTier = { name: PolicyTierName; tier: PolicyTier };

const defaultSource = (key: string): PolicySource => ({ tier: "default", key });
function sourceOf({ name, tier }: NamedTier, key: string): PolicySource {
  const line = tier.lines?.get(key);
  return { tier: name, ...(tier.file !== undefined ? { file: tier.file } : {}), key, ...(line !== undefined ? { line } : {}) };
}
const own = ({ tier }: NamedTier, table: string, key: string): unknown => (tier.document as LooseDocument)[table]?.[key];

/** OR. The deciding tier is the highest one whose own value equals the result; a tier that does not set the key has no value. */
function decideBool(tiers: NamedTier[], table: string, key: string, shorthand?: string): Decided<boolean> {
  const name = `${table}.${key}`;
  const values = tiers.map((t) => {
    const direct = own(t, table, key);
    if (direct === true) return { t, value: true, key: name };
    if (shorthand && own(t, table, shorthand) === true) return { t, value: true, key: `${table}.${shorthand}` };
    return direct === false ? { t, value: false, key: name } : undefined;
  });
  const value = values.some((v) => v?.value === true);
  const decider = values.find((v) => v?.value === value);
  return { value, source: decider ? sourceOf(decider.t, decider.key) : defaultSource(name) };
}

/** Maximum over the order of `values`. */
function decideEnum<T extends string>(tiers: NamedTier[], table: string, key: string, order: readonly string[]): Decided<T | undefined> {
  const name = `${table}.${key}`;
  let value: string | undefined;
  for (const t of tiers) {
    const v = own(t, table, key) as string | undefined;
    if (v !== undefined && (value === undefined || order.indexOf(v) > order.indexOf(value))) value = v;
  }
  const decider = value === undefined ? undefined : tiers.find((t) => own(t, table, key) === value);
  return { value: value as T | undefined, source: decider ? sourceOf(decider, name) : defaultSource(name) };
}

function decideUnion(tiers: NamedTier[], table: string, key: string): EffectiveList {
  const name = `${table}.${key}`;
  const items: SourcedItem[] = [];
  for (const t of tiers) {
    for (const value of (own(t, table, key) as string[] | undefined) ?? []) {
      if (!items.some((item) => item.value === value)) items.push({ value, source: sourceOf(t, name) });
    }
  }
  return { values: items.map((item) => item.value), items };
}

function decideAllowlist(tiers: NamedTier[], table: string, key: string): EffectiveAllowlist {
  const name = `${table}.${key}`;
  const setting = tiers.filter((t) => own(t, table, key) !== undefined).map((t) => ({ source: sourceOf(t, name), values: [...(own(t, table, key) as string[])] }));
  if (setting.length === 0) return { restricted: false, values: [], items: [], source: defaultSource(name), tiers: [] };
  const values = setting[0].values.filter((value) => setting.every((s) => s.values.includes(value)));
  return { restricted: true, values, items: values.map((value) => ({ value, source: setting[0].source })), source: setting[0].source, tiers: setting };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) deepFreeze(member);
  }
  return value;
}

/**
 * Combines the tiers into the effective policy. Each argument is optional; an absent tier changes nothing. The values
 * are the meet of the documents, so the argument order decides attribution only. The result is frozen.
 */
export function mergePolicies(system?: PolicyTier, user?: PolicyTier, project?: ProjectPolicyTier): EffectivePolicy {
  const tiers: NamedTier[] = [];
  if (system) tiers.push({ name: "system", tier: system });
  if (user) tiers.push({ name: "user", tier: user });
  if (project) tiers.push({ name: "project", tier: project });
  const projectNamed = tiers.find((t) => t.name === "project");

  // A project's relaxations are void wherever a managed tier speaks about verification: its `allow` could otherwise
  // exempt a path a managed `protected` list names, and its mode could undercut a managed floor.
  let relaxationStatus: RelaxationStatus = "none";
  let relaxation: EffectivePolicy["verification"]["relaxation"];
  let relaxationVoidedBy: PolicySource | undefined;
  if (project && projectNamed && hasRelaxations(project.relaxations)) {
    for (const t of tiers) {
      if (t.name === "project" || relaxationVoidedBy) continue;
      for (const key of Object.keys(SPEC.verification)) {
        if (own(t, "verification", key) !== undefined) {
          relaxationVoidedBy = sourceOf(t, `verification.${key}`);
          break;
        }
      }
    }
    if (relaxationVoidedBy) relaxationStatus = "void_managed";
    else if (project.relaxationsApply !== true) relaxationStatus = "not_approved";
    else {
      relaxationStatus = "applied";
      const mode = project.relaxations?.verification_mode;
      relaxation = {
        ...(mode !== undefined ? { mode } : {}),
        allow: [...(project.relaxations?.verification_allow ?? [])],
        source: { tier: "project", ...(project.file !== undefined ? { file: project.file } : {}), key: mode !== undefined ? "verificationPaths.mode" : "verificationPaths.allow" },
      };
    }
  }

  return deepFreeze<EffectivePolicy>({
    tiers: tiers.map((t) => t.name),
    approval: {
      strict: decideBool(tiers, "approval", "strict"),
      disable_auto: decideBool(tiers, "approval", "disable_auto", "strict"),
      disable_yes: decideBool(tiers, "approval", "disable_yes", "strict"),
      disable_full_access: decideBool(tiers, "approval", "disable_full_access", "strict"),
      require_human: decideUnion(tiers, "approval", "require_human"),
    },
    verification: {
      mode: decideEnum<VerificationFloor>(tiers, "verification", "mode", POLICY_KEYS.verification.mode.values),
      protected: decideUnion(tiers, "verification", "protected"),
      relaxationStatus,
      ...(relaxation ? { relaxation } : {}),
      ...(relaxationStatus === "void_managed" && relaxationVoidedBy ? { relaxationVoidedBy } : {}),
    },
    commands: {
      forbid: decideUnion(tiers, "commands", "forbid"),
      prompt: decideUnion(tiers, "commands", "prompt"),
      disable_allow_rules: decideBool(tiers, "commands", "disable_allow_rules"),
    },
    paths: { protected: decideUnion(tiers, "paths", "protected") },
    egress: {
      inspector: decideEnum<EgressInspectorFloor>(tiers, "egress", "inspector", POLICY_KEYS.egress.inspector.values),
      allowed_domains: decideAllowlist(tiers, "egress", "allowed_domains"),
      secret_destinations: decideAllowlist(tiers, "egress", "secret_destinations"),
    },
    sandbox: { required: decideBool(tiers, "sandbox", "required"), forbid_network: decideBool(tiers, "sandbox", "forbid_network") },
    mcp: { allow: decideAllowlist(tiers, "mcp", "allow"), disable_workspace: decideBool(tiers, "mcp", "disable_workspace") },
    plugins: { allow: decideAllowlist(tiers, "plugins", "allow"), disable_workspace: decideBool(tiers, "plugins", "disable_workspace") },
    workspace: { disable_env_trust: decideBool(tiers, "workspace", "disable_env_trust") },
  });
}

/** How a source is shown beside a decision: `[policy: system <file> approval.strict]`, or `[policy: default]`. */
export function describeSource(source: PolicySource): string {
  if (source.tier === "default") return "[policy: default]";
  return `[policy: ${source.tier}${source.file ? ` ${source.file}` : ""} ${source.key}]`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Clamp helpers. Each one decides and does nothing else: no I/O, no state. The callers that will act on the answers
// do not exist yet.

/** An answer with the tier it comes from. A refusal's `message` ends with `describeSource(source)`. */
export type PolicyDecision<T> = { allowed: true; value: T; source: PolicySource; notice?: string } | { allowed: false; message: string; source: PolicySource };

const refuse = (text: string, source: PolicySource): { allowed: false; message: string; source: PolicySource } => ({ allowed: false, message: `${text} ${describeSource(source)}`, source });

export type RequestedApprovalMode = "auto" | "review" | "read-only";

export interface ApprovalRequest {
  /** The approval mode the caller resolved from its flags and environment. */
  mode: RequestedApprovalMode;
  /** What asked for that mode, as the operator wrote it: `--mode auto`, `NEXUS_APPROVAL_MODE=auto`. */
  modeOrigin: string;
  /** `-y` / `--yes` was given (it selects mode auto and full access). */
  yes?: boolean;
  /** Full access was asked for by something other than `--yes`; its origin, as the operator wrote it. */
  fullAccessOrigin?: string;
}

/** A launch request against the policy: the mode and full-access setting as asked, or the refusal that stops the launch. */
export function clampApprovalRequest(policy: EffectivePolicy, request: ApprovalRequest): PolicyDecision<{ mode: RequestedApprovalMode; fullAccess: boolean }> {
  const { disable_yes: noYes, disable_auto: noAuto, disable_full_access: noFull } = policy.approval;
  if (request.yes) {
    if (noYes.value) return refuse("--yes is refused: managed policy disables it.", noYes.source);
    if (noAuto.value) return refuse("--yes is refused: it selects approval mode 'auto', which managed policy disables.", noAuto.source);
    if (noFull.value) return refuse("--yes is refused: it grants full access, which managed policy disables.", noFull.source);
    return { allowed: true, value: { mode: "auto", fullAccess: true }, source: noYes.source };
  }
  if (request.mode === "auto" && noAuto.value) return refuse(`${request.modeOrigin} is refused: managed policy disables approval mode 'auto'.`, noAuto.source);
  if (request.fullAccessOrigin !== undefined && noFull.value) return refuse(`${request.fullAccessOrigin} is refused: managed policy disables full access.`, noFull.source);
  return { allowed: true, value: { mode: request.mode, fullAccess: request.fullAccessOrigin !== undefined }, source: request.mode === "auto" ? noAuto.source : noFull.source };
}

/** A mode change asked for during a session (`/mode auto`): the mode to use. A disabled mode leaves the current one, with a notice. */
export function clampRuntimeApprovalMode(policy: EffectivePolicy, current: RequestedApprovalMode, requested: RequestedApprovalMode, origin: string): { mode: RequestedApprovalMode; changed: boolean; notice?: string; source: PolicySource } {
  const noAuto = policy.approval.disable_auto;
  if (requested === "auto" && noAuto.value) {
    return { mode: current, changed: false, notice: `${origin} is ignored: managed policy disables approval mode 'auto'; the mode stays '${current}'. ${describeSource(noAuto.source)}`, source: noAuto.source };
  }
  return { mode: requested, changed: requested !== current, source: noAuto.source };
}

/** An "always" answer to an approval prompt: whether it may be remembered. When it may not, the one call is still approved. */
export function clampAlwaysApproval(policy: EffectivePolicy): { remember: boolean; approveThisCall: true; notice?: string; source: PolicySource } {
  const noAuto = policy.approval.disable_auto;
  if (!noAuto.value) return { remember: true, approveThisCall: true, source: noAuto.source };
  return { remember: false, approveThisCall: true, notice: `'always' is not remembered: managed policy disables approval mode 'auto'; this one call is approved. ${describeSource(noAuto.source)}`, source: noAuto.source };
}

/** Whether `effect` needs a human decision whatever the approval mode, full access included. */
export function requiresHuman(policy: EffectivePolicy, effect: HumanEffect): { required: boolean; message?: string; source: PolicySource } {
  const item = policy.approval.require_human.items.find((i) => i.value === effect);
  if (!item) return { required: false, source: defaultSource("approval.require_human") };
  return { required: true, message: `approval required: managed policy requires a human decision for ${effect}, also under full access. ${describeSource(item.source)}`, source: item.source };
}

export interface SandboxRequest {
  /** The sandbox the operator asked for: a backend name, `none`, or undefined when nothing was asked. */
  mode: string | undefined;
  /** What asked, as the operator wrote it: `--sandbox none`. */
  origin?: string;
}

/** The sandbox setting to use. Under `sandbox.required`, an explicit `none` is refused and no request becomes `auto`. */
export function clampSandbox(policy: EffectivePolicy, request: SandboxRequest): PolicyDecision<{ mode: string | undefined; requireSandbox: boolean }> {
  const required = policy.sandbox.required;
  if (!required.value) return { allowed: true, value: { mode: request.mode, requireSandbox: false }, source: required.source };
  if (request.mode === "none") return refuse(`${request.origin ?? "sandbox 'none'"} is refused: managed policy requires the sandbox.`, required.source);
  if (request.mode === undefined) {
    return { allowed: true, value: { mode: "auto", requireSandbox: true }, source: required.source, notice: `the sandbox is on (auto): managed policy requires it. ${describeSource(required.source)}` };
  }
  return { allowed: true, value: { mode: request.mode, requireSandbox: true }, source: required.source };
}

/** Whether sandboxed commands may use the network. `origin` is what asked: `--sandbox-network`, `NEXUS_SANDBOX_NETWORK=1`. */
export function clampSandboxNetwork(policy: EffectivePolicy, requested: boolean, origin: string): PolicyDecision<boolean> {
  const forbidden = policy.sandbox.forbid_network;
  if (requested && forbidden.value) return refuse(`${origin} is refused: managed policy forbids network access in the sandbox.`, forbidden.source);
  return { allowed: true, value: requested, source: forbidden.source };
}

const VERIFICATION_ORDER = ["off", "record", "approve", "block"] as const;
export type VerificationModeName = (typeof VERIFICATION_ORDER)[number];

/**
 * The verification-path mode in force: a managed or project floor when one is set; otherwise the project's approved
 * relaxation; otherwise the built-in default `approve`.
 */
export function effectiveVerificationMode(policy: EffectivePolicy): Decided<VerificationModeName> {
  const floor = policy.verification.mode;
  if (floor.value !== undefined) return { value: floor.value, source: floor.source };
  const relaxed = policy.verification.relaxation;
  if (relaxed?.mode !== undefined) return { value: relaxed.mode, source: relaxed.source };
  return { value: "approve", source: defaultSource("verification.mode") };
}

const EGRESS_ORDER = ["off", "record", "block"] as const;
export type EgressInspectorModeName = (typeof EGRESS_ORDER)[number];

/** The egress-inspector mode to use: the requested one, raised to the policy's floor. */
export function clampEgressInspector(policy: EffectivePolicy, requested: EgressInspectorModeName): { mode: EgressInspectorModeName; raised: boolean; notice?: string; source: PolicySource } {
  const floor = policy.egress.inspector;
  if (floor.value === undefined || EGRESS_ORDER.indexOf(requested) >= EGRESS_ORDER.indexOf(floor.value)) return { mode: requested, raised: false, source: floor.source };
  return { mode: floor.value, raised: true, notice: `the egress inspector runs in '${floor.value}' mode, not '${requested}': managed policy sets the floor. ${describeSource(floor.source)}`, source: floor.source };
}

/** The tier to name when `matches` finds nothing in an allowlist: the highest tier whose own list has no match. */
function allowlistRefuser(list: EffectiveAllowlist, matches: (entry: string) => boolean): PolicySource {
  return list.tiers.find((tier) => !tier.values.some(matches))?.source ?? list.source;
}

/** Whether `hostName` may be reached under `egress.allowed_domains`: an exact entry, or `*.example.com` for a subdomain. */
export function permitsEgressHost(policy: EffectivePolicy, hostName: string): PolicyDecision<string> {
  const list = policy.egress.allowed_domains;
  const name = hostName.toLowerCase();
  const matches = (entry: string): boolean => (entry.startsWith("*.") ? name.endsWith(entry.slice(1)) && name.length > entry.length - 1 : entry === name);
  if (!list.restricted || list.values.some(matches)) return { allowed: true, value: hostName, source: list.source };
  return refuse(`'${hostName}' is not reachable: it is not in the managed allowlist (egress.allowed_domains).`, allowlistRefuser(list, matches));
}

/** Whether a credential may be sent to `destination` (an origin) under `egress.secret_destinations`. A filter only: it never adds a destination. */
export function permitsSecretDestination(policy: EffectivePolicy, destination: string): PolicyDecision<string> {
  const list = policy.egress.secret_destinations;
  const matches = (entry: string): boolean => entry === destination;
  if (!list.restricted || list.values.some(matches)) return { allowed: true, value: destination, source: list.source };
  return refuse(`no credential is sent to '${destination}': it is not in the managed allowlist (egress.secret_destinations).`, allowlistRefuser(list, matches));
}

export interface McpServerDescriptor {
  name: string;
  /** The absolute path of the program a stdio server would run, when the caller resolved one. */
  command?: string;
  /** The URL of a remote server. */
  url?: string;
  /** The server is configured by a file in the workspace. */
  fromWorkspace: boolean;
}

/** Whether an MCP server may be started. A filter only: it never causes a server to be configured. */
export function permitsMcpServer(policy: EffectivePolicy, server: McpServerDescriptor): PolicyDecision<McpServerDescriptor> {
  const noWorkspace = policy.mcp.disable_workspace;
  if (server.fromWorkspace && noWorkspace.value) {
    return refuse(`MCP server '${server.name}' is not started: managed policy disables MCP servers configured by the workspace.`, noWorkspace.source);
  }
  const list = policy.mcp.allow;
  let serverOrigin: string | undefined;
  try {
    serverOrigin = server.url === undefined ? undefined : new URL(server.url).origin;
  } catch {
    serverOrigin = undefined;
  }
  const matches = (entry: string): boolean => {
    if (entry.startsWith("command:")) return server.command !== undefined && entry.slice(8) === server.command;
    if (entry.startsWith("url:")) return serverOrigin !== undefined && entry.slice(4) === serverOrigin;
    return entry === server.name;
  };
  if (!list.restricted || list.values.some(matches)) return { allowed: true, value: server, source: list.source };
  return refuse(`MCP server '${server.name}' is not started: it is not in the managed allowlist (mcp.allow).`, allowlistRefuser(list, matches));
}

export interface PluginFileDescriptor {
  /** The absolute real path of the plugin file. */
  path: string;
  /** SHA-256 of the file's bytes, lowercase hex. */
  sha256: string;
  /** The file is inside the workspace. */
  fromWorkspace: boolean;
}

/** Whether a plugin file may be imported. Keyed on the file, because a plugin's name is known only after its code ran. */
export function permitsPlugin(policy: EffectivePolicy, plugin: PluginFileDescriptor): PolicyDecision<PluginFileDescriptor> {
  const noWorkspace = policy.plugins.disable_workspace;
  if (plugin.fromWorkspace && noWorkspace.value) {
    return refuse(`plugin '${plugin.path}' is not imported: managed policy disables plugins from the workspace.`, noWorkspace.source);
  }
  const list = policy.plugins.allow;
  const matches = (entry: string): boolean => (entry.startsWith("sha256:") ? entry.slice(7) === plugin.sha256 : entry.startsWith("file:") && entry.slice(5) === plugin.path);
  if (!list.restricted || list.values.some(matches)) return { allowed: true, value: plugin, source: list.source };
  return refuse(`plugin '${plugin.path}' is not imported: it is not in the managed allowlist (plugins.allow).`, allowlistRefuser(list, matches));
}

export type ManagedCommandDecision =
  | { decision: "none" }
  | { decision: "forbidden"; rule: string; message: string; source: PolicySource }
  /** A managed `prompt` rule asks in every approval mode, full access included. */
  | { decision: "prompt"; rule: string; message: string; source: PolicySource; holdsUnderFullAccess: true };

/**
 * The managed `forbid` and `prompt` prefixes against a command. `segments` are the command's sub-commands as words (the
 * caller splits the command line; this module does not parse shell). A rule matches a segment that starts with its
 * words; any matching segment counts, and `forbid` outranks `prompt`. There is no allow outcome.
 */
export function decideManagedCommand(policy: EffectivePolicy, segments: readonly (readonly string[])[]): ManagedCommandDecision {
  const matching = (list: EffectiveList): SourcedItem | undefined =>
    list.items.find((item) => {
      const words = item.value.split(" ");
      return segments.some((segment) => segment.length >= words.length && words.every((word, i) => segment[i] === word));
    });
  const forbidden = matching(policy.commands.forbid);
  if (forbidden) {
    return { decision: "forbidden", rule: forbidden.value, message: `command refused: managed policy forbids '${forbidden.value}'. ${describeSource(forbidden.source)}`, source: forbidden.source };
  }
  const prompted = matching(policy.commands.prompt);
  if (prompted) {
    return {
      decision: "prompt",
      rule: prompted.value,
      message: `approval required: managed policy asks before '${prompted.value}', also under full access. ${describeSource(prompted.source)}`,
      source: prompted.source,
      holdsUnderFullAccess: true,
    };
  }
  return { decision: "none" };
}

/** Whether `NEXUS_TRUST_WORKSPACE` (as the caller read it) counts. */
export function clampEnvTrust(policy: EffectivePolicy, requested: boolean): { trusted: boolean; notice?: string; source: PolicySource } {
  const disabled = policy.workspace.disable_env_trust;
  if (requested && disabled.value) return { trusted: false, notice: `NEXUS_TRUST_WORKSPACE is ignored: managed policy disables it. ${describeSource(disabled.source)}`, source: disabled.source };
  return { trusted: requested, source: disabled.source };
}
