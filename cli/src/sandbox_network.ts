/**
 * The `--sandbox-network` choice, kept in a module with no imports so config.ts can record it without importing
 * sandbox.ts (config -> sandbox -> command_env -> config would be an import cycle).
 */
let sandboxNetworkFlag = false;
let sandboxNetworkProfile: boolean | undefined;

/** `--sandbox-network` (an operator's command-line choice). */
export function setSandboxNetworkFlag(value: boolean): void {
  sandboxNetworkFlag = value;
}

export function sandboxNetworkFlagSet(): boolean {
  return sandboxNetworkFlag;
}

/** A named profile's network posture overrides both CLI/environment opt-ins for this configured run. */
export function setSandboxNetworkProfile(value: boolean | undefined): void {
  sandboxNetworkProfile = value;
}

export function sandboxNetworkProfileValue(): boolean | undefined {
  return sandboxNetworkProfile;
}
