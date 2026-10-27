import { execFileSync } from "node:child_process";

const CONFIGURED_HOOK_QUERY = "^hook\\..*\\.event$";

/** Quote one value for Git's GIT_CONFIG_PARAMETERS shell-like list. */
function quoteConfigValue(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Environment for a Git command that must not run hooks declared in repository config
 * (`hook.<name>.event` / `.command`, Git 2.54+). Such hooks are not disabled by
 * `core.hooksPath` and outrank `GIT_CONFIG_COUNT`, so their `hook.<name>.enabled=false`
 * overrides are appended to `GIT_CONFIG_PARAMETERS`, Git's own command-line channel.
 *
 * The workspace's effective config is read with `git config --includes`; if no configured
 * hook matches `events`, the environment is returned unchanged. A config read failure other
 * than "no matches" is rethrown so the caller can fail closed instead of running hooks.
 */
export function envWithoutConfiguredHooks(workspace: string, events: readonly string[]): NodeJS.ProcessEnv {
  let configured: string;
  try {
    configured = execFileSync(
      "git",
      ["config", "--null", "--includes", "--get-regexp", CONFIGURED_HOOK_QUERY],
      { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch (error: any) {
    if (error?.status === 1) return { ...process.env };
    throw error;
  }

  const wanted = new Set(events);
  const disabledKeys = new Set<string>();
  for (const entry of configured.split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("\n");
    if (separator < 0) throw new Error("Unexpected Git hook configuration output");
    const key = entry.slice(0, separator);
    const event = entry.slice(separator + 1);
    if (!wanted.has(event)) continue;
    if (!key.startsWith("hook.") || !key.endsWith(".event")) continue;
    const friendlyName = key.slice("hook.".length, -".event".length);
    disabledKeys.add(`hook.${friendlyName}.enabled`);
  }

  if (disabledKeys.size === 0) return { ...process.env };
  const assignments = [...disabledKeys].map((key) => `${quoteConfigValue(key)}=${quoteConfigValue("false")}`);
  const existingParameters = (process.env.GIT_CONFIG_PARAMETERS ?? "").trim();
  return {
    ...process.env,
    GIT_CONFIG_PARAMETERS: existingParameters
      ? `${existingParameters} ${assignments.join(" ")}`
      : assignments.join(" "),
  };
}
