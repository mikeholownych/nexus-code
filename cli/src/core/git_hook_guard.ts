import { execFileSync } from "node:child_process";

/** Quote one value for Git's GIT_CONFIG_PARAMETERS shell-like list. */
function quoteConfigValue(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Environment for a Git command that must not run hooks declared in repository config
 * (`hook.<friendly-name>.event` / `.command`, Git 2.54+). Such hooks are not disabled by
 * `core.hooksPath`. Git 2.55+ supports an event-wide `hook.<event>.enabled=false` override,
 * which is appended to `GIT_CONFIG_PARAMETERS`, Git's own command-line channel.
 *
 * Disable every configured hook for each requested event. Looking up the current friendly
 * hook names first would leave a race where workspace-controlled config could add a new hook
 * between discovery and the protected Git operation. Git's event-level switch closes that gap.
 */
export function envWithoutConfiguredHooks(_workspace: string, events: readonly string[]): NodeJS.ProcessEnv {
  const disabledEvents = [...new Set(events)];
  if (disabledEvents.length === 0) return { ...process.env };
  if (disabledEvents.some((event) => !/^[a-z][a-z0-9-]*$/.test(event))) {
    throw new Error("Invalid Git hook event name");
  }
  const versionOutput = execFileSync("git", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const version = versionOutput.match(/\bgit version (\d+)\.(\d+)(?:\.(\d+))?/);
  if (!version) throw new Error(`Unable to determine Git version for hook suppression: ${versionOutput.trim()}`);
  const major = Number(version[1]);
  const minor = Number(version[2]);
  // Named hooks first became available in Git 2.54, but Git only gained an event-wide
  // disable switch in 2.55. On 2.54, suppressing only hooks discovered by name has a
  // configuration race, so protected operations must fail closed.
  if (major === 2 && minor === 54) {
    throw new Error("Git 2.54 cannot safely disable all configured hooks; upgrade Git to 2.55 or later");
  }
  const assignments = disabledEvents.map((event) =>
    `${quoteConfigValue(`hook.${event}.enabled`)}=${quoteConfigValue("false")}`
  );
  const existingParameters = (process.env.GIT_CONFIG_PARAMETERS ?? "").trim();
  return {
    ...process.env,
    GIT_CONFIG_PARAMETERS: existingParameters
      ? `${existingParameters} ${assignments.join(" ")}`
      : assignments.join(" "),
  };
}
