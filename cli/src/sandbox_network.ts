/**
 * The `--sandbox-network` choice, kept in a module with no imports so config.ts can record it without importing
 * sandbox.ts (config -> sandbox -> command_env -> config would be an import cycle).
 */
let sandboxNetworkFlag = false;

/** `--sandbox-network` (an operator's command-line choice). */
export function setSandboxNetworkFlag(value: boolean): void {
  sandboxNetworkFlag = value;
}

export function sandboxNetworkFlagSet(): boolean {
  return sandboxNetworkFlag;
}
