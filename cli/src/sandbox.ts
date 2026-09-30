import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

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

export function isSandboxAvailable(mode: SandboxMode = "auto"): boolean {
  if (mode === "bwrap") return probeBwrapSandbox();
  if (mode === "docker") return probeDockerSandbox();
  if (mode === "none") return false;
  return probeBwrapSandbox() || probeDockerSandbox();
}

/** Exercise the actual mount boundary, not just the presence of a binary. */
function probeBwrapSandbox(): boolean {
  if (!isBwrapAvailable()) return false;
  const root = fs.mkdtempSync(path.join(os.homedir(), ".nexus-bwrap-probe-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside.txt");
  try {
    fs.mkdirSync(workspace);
    fs.writeFileSync(outside, "protected");
    const probe = wrapSandboxedCommand(`printf escaped > ${JSON.stringify(outside)}; printf writable > probe.txt`, workspace, { mode: "bwrap" });
    if (!probe.sandboxed) return false;
    execSync(probe.command, { stdio: "ignore", timeout: 5000 });
    return fs.readFileSync(outside, "utf8") === "protected"
      && fs.readFileSync(path.join(workspace, "probe.txt"), "utf8") === "writable";
  } catch {
    return false;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Verify Docker can actually launch the configured image and mount boundary. */
function probeDockerSandbox(): boolean {
  if (!isDockerAvailable()) return false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-docker-probe-"));
  const workspace = path.join(root, "workspace");
  try {
    fs.mkdirSync(workspace);
    const probe = wrapSandboxedCommand("printf writable > probe.txt", workspace, { mode: "docker" });
    if (!probe.sandboxed) return false;
    execSync(probe.command, { stdio: "ignore", timeout: 15000 });
    return fs.readFileSync(path.join(workspace, "probe.txt"), "utf8") === "writable";
  } catch {
    return false;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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
      // A self-bind of / is not reliably remounted read-only on all kernels.
      // Explicitly remount the sandbox root before selectively adding its one
      // writable worktree mount below.
      "--remount-ro", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
      options.readOnlyHost
        ? "--ro-bind"
        : "--bind", absWorkspace, absWorkspace,
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
    const mountMode = options.readOnlyHost ? ":ro" : "";
    const networkMode = options.network === false ? "--network none " : "";
    const dockerCmd = `docker run --rm ${networkMode}-v "${absWorkspace}:${absWorkspace}${mountMode}" -w "${absWorkspace}" alpine:latest sh -c '${safeEscaped}'`;

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
