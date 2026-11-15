import { operatorSetting } from "./client.js";
import { userConfigEnvKeys } from "./config.js";

/**
 * The environment a `run_command` child starts with. The Nexus process holds the operator's credentials in
 * `process.env` (config.env is loaded into it with override), so a command that inherited it could print them
 * (`env`, `printenv`, `cat /proc/self/environ`) into the model's context and the transcript. This is the one place
 * that decides what a command may see; the persistent engine, its spawnSync fallback and the write-mode sandbox all
 * use it so the paths cannot drift. core/src/runner.rs applies the same name rules again as a second layer
 * (`is_credential_name`): keep the two in step.
 *
 * Unlike the MCP/LSP/verifier builders this is a deny list, because an agent's commands need an ordinary toolchain
 * environment (compilers, git, package managers, display and locale settings). Removed:
 *   - every name that came from config.env, except the essentials a shell cannot run without;
 *   - names that look like credentials, and names that point at a credential file or an agent holding credentials;
 *   - proxy URLs that embed a user name or password.
 * Files under HOME (config.env, .ssh, .aws, .npmrc, .netrc) are not protected by this; only inherited variables are.
 *
 * `NEXUS_COMMAND_ENV_PASSTHROUGH` (comma-separated names, trailing `*` for a prefix) is the operator's way to pass a
 * specific variable through. It is read as an operator setting (operator environment and config.env), never from a
 * project .env, so a repository cannot opt itself in.
 */
export const COMMAND_ENV_PASSTHROUGH_SETTING = "NEXUS_COMMAND_ENV_PASSTHROUGH";

/** Variables a shell and ordinary tools need; config.env cannot remove these (a credential-looking name still can). */
const ESSENTIAL = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "TMPDIR", "PWD"]);

/** Names (exact, upper-case) that hold a credential or locate one although they do not look like a secret. */
const CREDENTIAL_NAMES = new Set([
  "GOOGLE_APPLICATION_CREDENTIALS", "KUBECONFIG", "NETRC", "SSH_AUTH_SOCK", "DOCKER_CONFIG", "NPM_CONFIG_USERCONFIG",
  "GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "CARGO_REGISTRY_TOKEN", "PGPASSFILE", "PGPASSWORD",
]);
const CREDENTIAL_PREFIXES = ["AWS_", "AZURE_", "NEXUS_GATEWAY_TOKEN"];
/** `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, ... optionally followed by `_FILE`/`_PATH`/`_ID` (a pointer to one). */
const CREDENTIAL_SUFFIX = /(^|_)(API_?KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(_FILE|_PATH|_ID)?$/;

/** True when a variable name looks like a credential, or points at a credential file. Case-insensitive. */
export function isCredentialName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    CREDENTIAL_NAMES.has(upper) ||
    CREDENTIAL_PREFIXES.some((p) => upper.startsWith(p)) ||
    CREDENTIAL_SUFFIX.test(upper)
  );
}

function passthroughNames(): string[] {
  return (operatorSetting(COMMAND_ENV_PASSTHROUGH_SETTING) ?? "").split(",").map((n) => n.trim()).filter(Boolean);
}

function passes(name: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
}

export function buildCommandEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const optIn = passthroughNames();
  const fromConfigFile = new Set(userConfigEnvKeys());
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    // Whatever the process environment holds under this name may have come from a project .env; the operator's
    // value is set below.
    if (name === COMMAND_ENV_PASSTHROUGH_SETTING) continue;
    if (passes(name, optIn)) {
      env[name] = value;
      continue;
    }
    if (isCredentialName(name)) continue;
    if (fromConfigFile.has(name) && !ESSENTIAL.has(name) && !name.startsWith("LC_")) continue;
    if (/^(https?|all)_proxy$/i.test(name) && /\/\/[^/]*@/.test(value)) continue;
    env[name] = value;
  }
  // The passthrough list itself is not secret and the engine needs it to honour the same opt-in.
  if (optIn.length) env[COMMAND_ENV_PASSTHROUGH_SETTING] = optIn.join(",");
  return env;
}
