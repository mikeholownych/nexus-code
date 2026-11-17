/**
 * CS-8: the egress inspector. A tool call whose destination is outside the operator's network (a web fetch, a search, a
 * browser page, a network command in a shell) is checked for the workspace's own secrets before it runs:
 *
 *  - a value from the workspace's `.env` files whose name says it is a secret (a password, token or key),
 *    as written, URL-encoded or base64-encoded,
 *  - a reference to such a value through a variable the shell would expand (`$GITHUB_TOKEN`) when it is set,
 *  - a network command that reads a credential file (`curl -d @.env`, `scp ~/.ssh/id_rsa host:`).
 *
 * The existing InformationFlowBoundary (core/egress.ts) recognises secrets by their shape; this catches values with no
 * recognisable shape, the ones an operator keeps in a `.env`. A finding names the secret and where it was found, never
 * its value. Local, loopback and private-network destinations are not inspected. The operator's policy
 * (`egressInspector` in `.nexus-security.json`) sets the mode (`block` by default, `record`, `off`) and lists destinations
 * that may receive secrets.
 *
 * What it cannot see is stated, not hidden: a command that builds the secret at run time (`$(cat .env | base64)`,
 * a script the model wrote), a secret split across arguments, and any value the model transforms in a way other than
 * URL or base64 encoding. It is a guard against the careless and the common, not against a determined adversary
 * inside the shell; containment (`--sandbox`, no network) is the guard for that.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { classifyDestination } from "./egress.js";
import { splitSubcommands } from "../security.js";

export { DEFAULT_EGRESS_POLICY, parseEgressPolicy, type EgressMode, type EgressPolicy } from "./egress_policy.js";
import { DEFAULT_EGRESS_POLICY, type EgressMode, type EgressPolicy } from "./egress_policy.js";

// ------------------------------------------------------------------------------------------------ the workspace's secrets

export interface WorkspaceSecret {
  name: string;
  file: string;
  value: string;
}

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|PASS|CREDENTIAL|PRIVATE|AUTH|SIGNATURE|COOKIE|SESSION|DSN/i;
const TEMPLATE_FILE = /\.(?:example|sample|template|dist|tpl)$/i;
const PLACEHOLDER = /^(?:changeme|change-me|your[-_ ].*|x{3,}|\*+|<.*>|\$\{.*\}|example|placeholder|todo|null|none|true|false|redacted|secret|password)$/i;
const MIN_SECRET_LENGTH = 6;
const MAX_ENV_FILES = 20;
const MAX_ENV_BYTES = 64 * 1024;

function parseDotenv(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const eq = body.indexOf("=");
    if (eq < 1) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    const quote = value[0];
    const close = quote === '"' || quote === "'" ? value.indexOf(quote, 1) : -1;
    // A quoted value is what is between the quotes, whatever follows (an inline comment included).
    if (close > 0) value = value.slice(1, close);
    else {
      // An unquoted value ends at a ` #` or tab-`#` comment.
      const cuts = [value.indexOf(" #"), value.indexOf("\t#")].filter((i) => i >= 0);
      if (cuts.length) value = value.slice(0, Math.min(...cuts)).trimEnd();
    }
    out.push([key, value]);
  }
  return out;
}

const secretCache = new Map<string, { stamp: string; secrets: WorkspaceSecret[] }>();

/** Secret-named values in the workspace root's `.env` and `.env.*` files (templates excluded). Cached per file by size and mtime. */
export function workspaceSecrets(workspace: string): WorkspaceSecret[] {
  let names: string[];
  try {
    names = fs.readdirSync(workspace).filter((n) => (n === ".env" || n.startsWith(".env.")) && !TEMPLATE_FILE.test(n)).sort().slice(0, MAX_ENV_FILES);
  } catch {
    return [];
  }
  const secrets: WorkspaceSecret[] = [];
  for (const name of names) {
    const file = path.join(workspace, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_ENV_BYTES) continue;
      const stamp = `${stat.size}:${stat.mtimeMs}`;
      let cached = secretCache.get(file);
      if (!cached || cached.stamp !== stamp) {
        cached = {
          stamp,
          secrets: parseDotenv(fs.readFileSync(file, "utf8"))
            .filter(([key, value]) => SECRET_NAME.test(key) && value.length >= MIN_SECRET_LENGTH && !PLACEHOLDER.test(value))
            .map(([key, value]) => ({ name: key, file: name, value })),
        };
        secretCache.set(file, cached);
      }
      secrets.push(...cached.secrets);
    } catch {
      continue;
    }
  }
  return secrets;
}

// ------------------------------------------------------------------------------------------------ finding secrets in a call

export interface EgressFinding {
  kind: "workspace-secret" | "secret-variable" | "credential-file";
  /** The secret's name (`DB_PASSWORD`), the variable (`GITHUB_TOKEN`) or the file (`.env`). Never a value. */
  name: string;
  detail: string;
}

const forms = (value: string): string[] => [...new Set([value, encodeURIComponent(value), Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url")])].filter((f) => f.length >= MIN_SECRET_LENGTH);

/** Secrets of the workspace that `text` carries, by exact value in the forms above. */
export function secretsIn(text: string, secrets: readonly WorkspaceSecret[]): EgressFinding[] {
  const found: EgressFinding[] = [];
  const seen = new Set<string>();
  for (const secret of secrets) {
    if (seen.has(secret.name)) continue;
    if (forms(secret.value).some((f) => text.includes(f))) {
      seen.add(secret.name);
      found.push({ kind: "workspace-secret", name: secret.name, detail: `the value of ${secret.name} from ${secret.file}` });
    }
  }
  return found;
}

const NETWORK_TOOLS = new Set(["curl", "wget", "nc", "ncat", "netcat", "telnet", "ssh", "scp", "sftp", "rsync", "ftp", "http", "https", "xh"]);
const CREDENTIAL_FILE = /(?:^|\/)(?:\.env(?:\.[\w.-]+)?|id_(?:rsa|dsa|ecdsa|ed25519)|\.npmrc|\.netrc|\.pypirc|\.pgpass|credentials(?:\.json)?|\.git-credentials|\.docker\/config\.json|\.kube\/config|\.aws\/credentials)$/;

export interface CommandNetworkTarget {
  /** Network commands in the line, by name. */
  tools: string[];
  /** Hosts the line names (URLs, user@host, bare hosts after a network command). */
  hosts: string[];
  /** Credential files the line's network commands read or send. */
  credentialFiles: string[];
  /** `$NAME` / `${NAME}` references in the line. */
  variables: string[];
}

/** A word longer than this is not parsed for hosts (still searched for secret values): bounds every scan below. */
const MAX_WORD = 2048;
const SCHEME_CHAR = /[a-z0-9+.-]/i;

/** Hosts of every `scheme://...` in a word, found with `indexOf` and `new URL`, not a backtracking pattern. */
function hostsOfUrls(word: string): string[] {
  const hosts: string[] = [];
  if (word.length > MAX_WORD) return hosts;
  for (let at = word.indexOf("://"); at !== -1; at = word.indexOf("://", at + 3)) {
    let start = at;
    while (start > 0 && SCHEME_CHAR.test(word[start - 1])) start--;
    if (start === at) continue;
    try {
      const host = new URL(word.slice(start)).hostname.replace(/^\[|\]$/g, "");
      if (host) hosts.push(host);
    } catch {
      // not a URL: no host from this occurrence
    }
  }
  return hosts;
}

/** The host a bare word names (`evil.example`, `me@evil.example:/tmp`, `1.2.3.4:80/x`), checked label by label: linear, no backtracking. */
function hostOfBareWord(word: string): { host: string; hasUser: boolean } | undefined {
  if (word.length > MAX_WORD || word.startsWith("-")) return undefined;
  const slash = word.indexOf("/");
  const authority = slash === -1 ? word : word.slice(0, slash);
  const at = authority.lastIndexOf("@");
  const host = (at === -1 ? authority : authority.slice(at + 1)).split(":")[0];
  if (!host || host.length > 253) return undefined;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return { host, hasUser: at !== -1 };
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((l) => l.length === 0 || l.length > 63 || !/^[A-Za-z0-9-]+$/.test(l))) return undefined;
  return /^[A-Za-z]{2,}$/.test(labels[labels.length - 1]) ? { host, hasUser: at !== -1 } : undefined;
}

/** What the network commands in a shell line target and read. Only subcommands that start with a network tool are examined. */
export function commandNetworkTargets(command: string): CommandNetworkTarget {
  const target: CommandNetworkTarget = { tools: [], hosts: [], credentialFiles: [], variables: [] };
  for (const words of splitSubcommands(command)) {
    const head = path.posix.basename(words[0] ?? "");
    if (!NETWORK_TOOLS.has(head)) continue;
    target.tools.push(head);
    for (const word of words.slice(1)) {
      target.hosts.push(...hostsOfUrls(word));
      const bare = word.includes("://") ? undefined : hostOfBareWord(word);
      if (bare && (bare.hasUser || ["nc", "ncat", "netcat", "telnet", "curl", "wget", "http", "https", "xh"].includes(head))) target.hosts.push(bare.host);
      const file = word.replace(/^[^=]*=/, "").replace(/^[@<]/, "").replace(/^~\//, "");
      if (CREDENTIAL_FILE.test(file) && !TEMPLATE_FILE.test(file)) target.credentialFiles.push(file);
      for (const v of word.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) target.variables.push(v[1]);
    }
    // `curl ... < .env` and `cat .env | curl ...` feed a credential file to the command through the shell.
  }
  const redirected = [...command.matchAll(/<\s*(\S+)/g)].map((m) => m[1].replace(/^~\//, ""));
  if (target.tools.length) for (const f of redirected) if (CREDENTIAL_FILE.test(f) && !TEMPLATE_FILE.test(f)) target.credentialFiles.push(f);
  if (target.tools.length && /\bcat\s+\S*(?:\.env\b|id_(?:rsa|dsa|ecdsa|ed25519)\b)/.test(command)) target.credentialFiles.push((/\bcat\s+(\S*(?:\.env\S*|id_(?:rsa|dsa|ecdsa|ed25519)))/.exec(command) ?? [])[1] ?? ".env");
  target.hosts = [...new Set(target.hosts)];
  target.credentialFiles = [...new Set(target.credentialFiles)];
  target.variables = [...new Set(target.variables)];
  return target;
}

// ------------------------------------------------------------------------------------------------ the decision

export interface EgressVerdict {
  /** Whether the call may run (false only in block mode with findings). */
  allowed: boolean;
  /** What was looked for and found; empty when the call carries nothing, or goes somewhere local. */
  findings: EgressFinding[];
  /** The external hosts involved ("unknown" when a network command's host could not be read). */
  hosts: string[];
  mode: EgressMode;
  reason?: string;
}

const NETWORK_FETCH_TOOLS = new Set(["fetch_web", "browser_navigate"]);
const EXTERNAL_TOOLS = new Set(["fetch_web", "search_web", "browser_navigate", "browser_type", "run_command"]);

const hostOfUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
};

const isExternal = (host: string): boolean => {
  const boundary = classifyDestination(host.includes(":") ? `http://[${host}]/` : `https://${host}/`);
  return boundary === "EXTERNAL_PUBLIC" || boundary === "EXTERNAL_BOUNDED";
};

const hostAllowed = (host: string, allow: readonly string[]): boolean => allow.some((a) => (a.startsWith("*.") ? host === a.slice(2) || host.endsWith(a.slice(1)) : host === a));

/** Whether the tool can send data outside the operator's network at all. */
export const sendsExternally = (toolName: string): boolean => EXTERNAL_TOOLS.has(toolName);

/**
 * Inspects one tool call. `env` is the environment a shell would expand `$VAR` from (the process environment by
 * default); only a secret-named variable that is set to a real value counts.
 */
export function inspectOutbound(
  toolName: string,
  args: Record<string, unknown>,
  context: { workspace: string; policy?: EgressPolicy; env?: NodeJS.ProcessEnv },
): EgressVerdict {
  const policy = context.policy ?? DEFAULT_EGRESS_POLICY;
  const none = (hosts: string[] = []): EgressVerdict => ({ allowed: true, findings: [], hosts, mode: policy.mode });
  if (policy.mode === "off" || !EXTERNAL_TOOLS.has(toolName)) return none();

  let hosts: string[] = [];
  let text = JSON.stringify(args);
  const findings: EgressFinding[] = [];
  if (toolName === "run_command") {
    const command = String(args.command ?? "");
    const net = commandNetworkTargets(command);
    if (!net.tools.length) return none();
    hosts = net.hosts.length ? net.hosts : ["unknown"];
    text = command;
    for (const file of net.credentialFiles) findings.push({ kind: "credential-file", name: file, detail: `a network command reads the credential file ${file}` });
    const env = context.env ?? process.env;
    for (const variable of net.variables) {
      const value = env[variable];
      if (SECRET_NAME.test(variable) && typeof value === "string" && value.length >= MIN_SECRET_LENGTH && !PLACEHOLDER.test(value)) {
        findings.push({ kind: "secret-variable", name: variable, detail: `a network command expands $${variable}, which is set to a secret` });
      }
    }
  } else if (NETWORK_FETCH_TOOLS.has(toolName)) {
    const host = hostOfUrl(args.url);
    hosts = host ? [host] : ["unknown"];
  } else {
    hosts = ["unknown"]; // a web search or a browser form: it leaves for a service the call does not name
  }

  const external = hosts.filter((h) => h === "unknown" || isExternal(h));
  if (!external.length) return none(hosts);
  if (external.every((h) => h !== "unknown" && hostAllowed(h, policy.allowDestinations))) return none(external);

  findings.push(...secretsIn(text, workspaceSecrets(context.workspace)));
  if (!findings.length) return none(external);
  const named = findings.map((f) => f.detail).join("; ");
  const where = external.includes("unknown") ? "an external destination" : external.join(", ");
  return {
    allowed: policy.mode !== "block",
    findings,
    hosts: external,
    mode: policy.mode,
    reason: `EGRESS_SECRET_BLOCKED: ${toolName} would send ${named} to ${where}. Secrets stay in the workspace; if this destination is meant to receive one, the operator can list it in \`egressInspector.allowDestinations\` in .nexus-security.json.`,
  };
}
