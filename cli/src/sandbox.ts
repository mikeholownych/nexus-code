import { execFileSync } from "node:child_process";
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
  argv?: string[];
  sandboxed: boolean;
  engine: "bwrap" | "docker" | "none";
  warning?: string;
}

export function quoteForShell(arg: string): string {
  if (/^[a-zA-Z0-9_\.\-\/=]+$/.test(arg)) {
    return arg;
  }
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Check if bubblewrap (bwrap) sandbox utility is installed
 */
export function isBwrapAvailable(): boolean {
  try {
    execFileSync("bwrap", ["--version"], { stdio: ["ignore", "ignore", "ignore"], timeout: 2000 });
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
    execFileSync("docker", ["--version"], { stdio: ["ignore", "ignore", "ignore"], timeout: 2000 });
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

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function appendDirectoryTree(args: string[], target: string, known: Set<string>): void {
  const absolute = path.resolve(target);
  const parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!known.has(current)) {
      args.push("--dir", current);
      known.add(current);
    }
  }
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
    if (!probe.argv?.length) return false;
    execFileSync(probe.argv[0], probe.argv.slice(1), { stdio: "ignore", timeout: 5000 });
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
    if (!probe.argv?.length) return false;
    execFileSync(probe.argv[0], probe.argv.slice(1), { stdio: "ignore", timeout: 15000 });
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

    const userHome = path.resolve(process.env.HOME || os.homedir());
    const bwrapArgs: string[] = ["bwrap"];

    if (options.readOnlyHost) {
      // Do not expose the host root to read-only commands. A path admitted by the
      // authority check can be replaced before the shell opens it; a read-only
      // bind of / still lets that race disclose unrelated host files.
      if (options.customBwrapArgs?.length) {
        return {
          command: cmd,
          sandboxed: false,
          engine: "none",
          warning: "Custom Bubblewrap mounts are incompatible with read-only host confinement.",
        };
      }

      bwrapArgs.push("--tmpfs", "/");
      const knownDirectories = new Set<string>(["/"]);
      const systemRoots: string[] = [];
      for (const source of ["/usr", "/bin", "/sbin", "/lib", "/lib64"]) {
        try {
          if (!fs.statSync(source).isDirectory()) continue;
          appendDirectoryTree(bwrapArgs, source, knownDirectories);
          systemRoots.push(source);
        } catch {
          // A platform may not have every conventional system directory.
        }
      }
      for (const mountpoint of ["/dev", "/proc", "/tmp", "/etc"]) {
        appendDirectoryTree(bwrapArgs, mountpoint, knownDirectories);
      }

      const homeIsUsable = userHome !== "/";
      if (homeIsUsable && !systemRoots.some((root) => isPathWithin(userHome, root))) {
        appendDirectoryTree(bwrapArgs, userHome, knownDirectories);
      }
      const workspaceNeedsLaterCreation =
        isPathWithin(absWorkspace, "/tmp") ||
        (homeIsUsable && isPathWithin(absWorkspace, userHome));
      if (!workspaceNeedsLaterCreation && !systemRoots.some((root) => isPathWithin(absWorkspace, root))) {
        appendDirectoryTree(bwrapArgs, absWorkspace, knownDirectories);
      }

      // Make the synthetic root read-only before adding its explicitly scoped mounts.
      bwrapArgs.push("--remount-ro", "/");
      for (const source of ["/usr", "/bin", "/sbin", "/lib", "/lib64"]) {
        try {
          if (fs.statSync(source).isDirectory()) {
            bwrapArgs.push("--ro-bind", fs.realpathSync(source), source);
          }
        } catch {
          // Keep absent optional runtime directories absent in the synthetic root.
        }
      }
      bwrapArgs.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");

      if (homeIsUsable && userHome !== "/tmp" && !systemRoots.some((root) => isPathWithin(userHome, root))) {
        if (isPathWithin(userHome, "/tmp")) {
          appendDirectoryTree(bwrapArgs, userHome, new Set(["/", "/tmp"]));
        }
        bwrapArgs.push("--tmpfs", userHome);
      }

      if (workspaceNeedsLaterCreation) {
        const containingMount = homeIsUsable && isPathWithin(absWorkspace, userHome) ? userHome : "/tmp";
        appendDirectoryTree(bwrapArgs, absWorkspace, new Set(["/", ...systemRoots, containingMount]));
      }
      bwrapArgs.push("--ro-bind", absWorkspace, absWorkspace);
      bwrapArgs.push("--setenv", "PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
      bwrapArgs.push("--setenv", "HOME", userHome);
    } else {
      // General worktree sandbox retains the host runtime read-only while allowing
      // writes only through its dedicated workspace bind.
      bwrapArgs.push(
        "--ro-bind", "/", "/",
        "--remount-ro", "/",
        "--dev", "/dev",
        "--proc", "/proc",
        "--tmpfs", "/tmp",
      );
      bwrapArgs.push("--bind", absWorkspace, absWorkspace);
    }

    bwrapArgs.push("--chdir", absWorkspace, "--unshare-pid");

    if (options.network === false) {
      bwrapArgs.push("--unshare-net");
    }

    if (!options.readOnlyHost && options.customBwrapArgs && options.customBwrapArgs.length > 0) {
      bwrapArgs.push(...options.customBwrapArgs);
    }

    // Format final execution - for argv array, raw strings are used without extra quotes
    bwrapArgs.push(shell, "-c", cmd);

    return {
      command: bwrapArgs.map(quoteForShell).join(" "),
      argv: [...bwrapArgs],
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

    const mountMode = options.readOnlyHost ? ":ro" : "";
    const dockerArgs = [
      "docker",
      "run",
      "--rm",
      ...(options.network === false ? ["--network", "none"] : []),
      "-v",
      `${absWorkspace}:${absWorkspace}${mountMode}`,
      "-w",
      absWorkspace,
      "alpine:latest",
      "sh",
      "-c",
      cmd,
    ];

    return {
      command: dockerArgs.map(quoteForShell).join(" "),
      argv: dockerArgs,
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
