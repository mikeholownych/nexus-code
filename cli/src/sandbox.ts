import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

export type SandboxMode = "auto" | "bwrap" | "docker" | "none";

export interface SandboxOptions {
  mode?: SandboxMode;
  readOnlyHost?: boolean;
  /** Open workspace directory inherited by Bubblewrap as child fd 3. */
  workspaceFd?: number;
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

/** Add one trusted runtime file and its dynamic loader dependencies to a synthetic root. */
function appendRuntimeFile(
  args: string[],
  source: string,
  knownDirectories: Set<string>,
  mountedFiles: Set<string>,
  depth = 0,
): void {
  if (depth > 4) return;
  let resolved: string;
  try {
    resolved = fs.realpathSync(source);
    if (!fs.statSync(resolved).isFile() || mountedFiles.has(source)) return;
  } catch {
    return;
  }

  appendDirectoryTree(args, path.dirname(source), knownDirectories);
  args.push("--ro-bind", resolved, source);
  mountedFiles.add(source);

  // Runtime commands in the read-only allowlist are fixed platform binaries. Mount their
  // individual ELF dependencies, never the containing host directories.
  try {
    const output = execFileSync("ldd", [resolved], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });
    for (const line of output.split("\n")) {
      const match = line.match(/(?:=>\s*)?(\/[^\s]+)\s+\(/);
      if (match?.[1]) appendRuntimeFile(args, match[1], knownDirectories, mountedFiles, depth + 1);
    }
  } catch {
    // Static binaries and scripts do not have ldd dependencies.
  }

  // The only runtime script admitted here is an installed command with a fixed shebang.
  let fd: number | undefined;
  try {
    fd = fs.openSync(resolved, "r");
    const prefix = Buffer.alloc(256);
    const count = fs.readSync(fd, prefix, 0, prefix.length, 0);
    const firstLine = prefix.subarray(0, count).toString("utf8").split("\n", 1)[0];
    const shebang = firstLine.match(/^#!\s*(\/[^\s]+)/)?.[1];
    if (shebang) appendRuntimeFile(args, shebang, knownDirectories, mountedFiles, depth + 1);
  } catch {
    // Binary files are not UTF-8 scripts.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function appendReadOnlyRuntime(args: string[], knownDirectories: Set<string>): void {
  const mountedFiles = new Set<string>();
  for (const command of [
    "/usr/bin/bash", "/bin/bash", "/usr/bin/sh", "/bin/sh",
    "/usr/bin/ls", "/usr/bin/dir", "/usr/bin/pwd", "/usr/bin/cat", "/usr/bin/head",
    "/usr/bin/tail", "/usr/bin/grep", "/usr/bin/rg", "/usr/bin/find", "/usr/bin/wc",
    "/usr/bin/which", "/usr/bin/git", "/usr/bin/node", "/usr/bin/env",
  ]) {
    appendRuntimeFile(args, command, knownDirectories, mountedFiles);
  }

  // npm is a script with package-local modules and data files, not a single ELF
  // binary. Mount only its installed runtime package when the conventional npm
  // entrypoint is present; do not expose the containing global node_modules tree.
  try {
    const npmEntry = fs.realpathSync("/usr/bin/npm");
    let directory = path.dirname(npmEntry);
    while (directory !== path.dirname(directory)) {
      const packageJson = path.join(directory, "package.json");
      try {
        const metadata = JSON.parse(fs.readFileSync(packageJson, "utf8"));
        if (metadata.name === "npm") {
          appendDirectoryTree(args, path.dirname(directory), knownDirectories);
          args.push("--ro-bind", directory, directory);
          const npmLink = fs.readlinkSync("/usr/bin/npm");
          appendDirectoryTree(args, path.dirname("/usr/bin/npm"), knownDirectories);
          args.push("--symlink", npmLink, "/usr/bin/npm");
          break;
        }
      } catch {
        // Keep looking up from the npm entrypoint to its package root.
      }
      directory = path.dirname(directory);
    }
  } catch {
    // npm is optional on minimal hosts.
  }

  // The dynamic loader can use this cache, but mounting all of /etc would expose
  // unrelated host configuration through a workspace symlink race.
  appendRuntimeFile(args, "/etc/ld.so.cache", knownDirectories, mountedFiles);
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
      if (!Number.isInteger(options.workspaceFd) || options.workspaceFd! < 3) {
        return {
          command: cmd,
          sandboxed: false,
          engine: "none",
          warning: "Read-only Bubblewrap requires a pinned workspace directory descriptor.",
        };
      }
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
      for (const mountpoint of ["/dev", "/proc", "/tmp"]) {
        appendDirectoryTree(bwrapArgs, mountpoint, knownDirectories);
      }

      const homeIsUsable = userHome !== "/";
      if (homeIsUsable) {
        appendDirectoryTree(bwrapArgs, userHome, knownDirectories);
      }
      const workspaceNeedsLaterCreation =
        isPathWithin(absWorkspace, "/tmp") ||
        (homeIsUsable && isPathWithin(absWorkspace, userHome));
      if (!workspaceNeedsLaterCreation) {
        appendDirectoryTree(bwrapArgs, absWorkspace, knownDirectories);
      }

      appendReadOnlyRuntime(bwrapArgs, knownDirectories);
      // Make the completed synthetic root read-only after creating its exact runtime mounts.
      bwrapArgs.push("--remount-ro", "/");
      bwrapArgs.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");

      if (homeIsUsable && userHome !== "/tmp") {
        if (isPathWithin(userHome, "/tmp")) {
          appendDirectoryTree(bwrapArgs, userHome, new Set(["/", "/tmp"]));
        }
        bwrapArgs.push("--tmpfs", userHome);
      }

      if (workspaceNeedsLaterCreation) {
        const containingMount = homeIsUsable && isPathWithin(absWorkspace, userHome) ? userHome : "/tmp";
        appendDirectoryTree(bwrapArgs, absWorkspace, new Set(["/", containingMount]));
      }
      // Bind through inherited fd 3 so a rename or replacement of the source
      // pathname cannot redirect Bubblewrap to a different directory.
      bwrapArgs.push("--ro-bind", "/proc/self/fd/3", absWorkspace);
      bwrapArgs.push("--clearenv");
      bwrapArgs.push("--setenv", "PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
      bwrapArgs.push("--setenv", "HOME", "/tmp");
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
