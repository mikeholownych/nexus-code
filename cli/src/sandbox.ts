import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

export type SandboxMode = "auto" | "bwrap" | "docker" | "none";

export interface SandboxOptions {
  mode?: SandboxMode;
  readOnlyHost?: boolean;
  network?: boolean;
  shell?: string;
  customBwrapArgs?: string[];
}

export interface SandboxedCommandResult {
  command: string;
  sandboxed: boolean;
  engine: "bwrap" | "docker" | "none";
  warning?: string;
}

/**
 * Check if bubblewrap (bwrap) sandbox utility is installed
 */
export function isBwrapAvailable(): boolean {
  try {
    execSync("bwrap --version", { stdio: ["ignore", "ignore", "ignore"], timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if docker daemon is available
 */
export function isDockerAvailable(): boolean {
  try {
    execSync("docker --version", { stdio: ["ignore", "ignore", "ignore"], timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wrap a shell command in Linux container / namespace sandboxing (Candidate #33)
 * Restricts mutating filesystem access to the target workspace directory.
 */
export function wrapSandboxedCommand(
  cmd: string,
  workspace: string,
  options: SandboxOptions = {}
): SandboxedCommandResult {
  const mode = options.mode || "auto";
  const absWorkspace = path.resolve(workspace);
  const shell = options.shell || "bash";

  if (mode === "none") {
    return {
      command: cmd,
      sandboxed: false,
      engine: "none",
    };
  }

  // 1. Try Bubblewrap (bwrap)
  if (mode === "bwrap" || (mode === "auto" && isBwrapAvailable())) {
    if (!isBwrapAvailable() && mode === "bwrap") {
      return {
        command: cmd,
        sandboxed: false,
        engine: "none",
        warning: "Bubblewrap (bwrap) is requested but not found in PATH.",
      };
    }

    // Build bwrap flags:
    // - Read-only host filesystem: --ro-bind / /
    // - Mount /dev and /proc
    // - Read-write bind exclusively for the workspace
    // - Unshare PID namespace
    // - Isolate /tmp
    const bwrapArgs: string[] = [
      "bwrap",
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
      "--bind", absWorkspace, absWorkspace,
      "--chdir", absWorkspace,
      "--unshare-pid",
    ];

    if (options.network === false) {
      bwrapArgs.push("--unshare-net");
    }

    if (options.customBwrapArgs && options.customBwrapArgs.length > 0) {
      bwrapArgs.push(...options.customBwrapArgs);
    }

    // Format final execution
    const safeEscaped = cmd.replace(/'/g, "'\\''");
    bwrapArgs.push(shell, "-c", `'${safeEscaped}'`);

    return {
      command: bwrapArgs.join(" "),
      sandboxed: true,
      engine: "bwrap",
    };
  }

  // 2. Try Docker container isolation
  if (mode === "docker" || (mode === "auto" && isDockerAvailable())) {
    if (!isDockerAvailable() && mode === "docker") {
      return {
        command: cmd,
        sandboxed: false,
        engine: "none",
        warning: "Docker is requested but not available or daemon is not running.",
      };
    }

    const safeEscaped = cmd.replace(/'/g, "'\\''");
    const dockerCmd = `docker run --rm -v "${absWorkspace}:${absWorkspace}" -w "${absWorkspace}" alpine:latest sh -c '${safeEscaped}'`;

    return {
      command: dockerCmd,
      sandboxed: true,
      engine: "docker",
    };
  }

  return {
    command: cmd,
    sandboxed: false,
    engine: "none",
    warning: "No sandboxing engine (bwrap or docker) available. Running directly on host.",
  };
}
