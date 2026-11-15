import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { buildCommandEnvironment } from "./command_env.js";
import { operatorSetting } from "./client.js";
import { sandboxNetworkFlagSet, setSandboxNetworkFlag } from "./sandbox_network.js";

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

/**
 * Write-mode `--sandbox` masks $HOME with an empty tmpfs and binds back, read-only, only the toolchain directories a
 * build needs. Credential locations are never bound, whatever the PATH or the operator's list says.
 */
const HOME_TOOLCHAIN_DEFAULTS = [
  ".cargo", ".rustup", ".nvm", ".local/bin", ".npm", ".cache/pip", "go/pkg",
];
/** Under HOME. A candidate that is one of these, inside one, or the parent of one is refused. */
const HOME_DENIED = [
  ".ssh", ".gnupg", ".aws", ".config/nexus", ".config/gh", ".netrc", ".docker", ".kube", ".azure", ".npmrc",
  ".pypirc", ".gitconfig", ".git-credentials", ".config/gcloud", ".config/google-chrome", ".config/chromium",
  ".config/BraveSoftware", ".config/microsoft-edge", ".mozilla", ".config/mozilla",
  ".config", ".local/share", ".local", ".cache",
];
/** Allowed roots may contain these files (cargo keeps its registry token in ~/.cargo); they are masked. */
const HOME_MASKED_FILES = [".cargo/credentials", ".cargo/credentials.toml"];
/** Broad directories: refused as a whole (or as a parent), while a specific safe child such as ~/.cache/pip is allowed. */
const BROAD_DENIED = new Set([".config", ".local/share", ".local", ".cache"]);
export const SANDBOX_HOME_READONLY_SETTING = "NEXUS_SANDBOX_HOME_READONLY";
export const SANDBOX_NETWORK_SETTING = "NEXUS_SANDBOX_NETWORK";

/**
 * The Docker sandbox image. The pin lives here and nowhere else: a floating tag (`alpine:latest`) lets whoever controls
 * the registry change what runs the agent's commands. This is the multi-arch index digest of alpine 3.23, resolved
 * from the registry (`docker buildx imagetools inspect alpine:3.23`) on 2026-11-15. Refresh it deliberately, never to
 * a tag. The operator may substitute their own image with NEXUS_SANDBOX_DOCKER_IMAGE (operator environment or
 * config.env, never a project .env); it must also be pinned by digest or no container is started.
 */
export const DOCKER_SANDBOX_IMAGE = "alpine:3.23@sha256:469c9ea410b9215eaee7976ba6c0639039b444be8e5d638f7abbada189971eb2";
export const DOCKER_SANDBOX_IMAGE_SETTING = "NEXUS_SANDBOX_DOCKER_IMAGE";
const PINNED_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;
const DOCKER_PIDS_LIMIT = "512";

/** The image to run, or undefined when the operator's override is not digest-pinned (fail closed). */
export function dockerSandboxImage(): string | undefined {
  const configured = operatorSetting(DOCKER_SANDBOX_IMAGE_SETTING)?.trim();
  if (!configured) return DOCKER_SANDBOX_IMAGE;
  return PINNED_IMAGE.test(configured) ? configured : undefined;
}

export interface SandboxHomeMount {
  path: string;
  source: "default" | "PATH" | "operator";
}
export interface SandboxHomeMounts {
  home: string;
  mounts: SandboxHomeMount[];
  masked: string[];
  refused: Array<{ path: string; reason: string }>;
}

function deniedReason(candidate: string, home: string): string | undefined {
  for (const entry of HOME_DENIED) {
    const denied = path.join(home, entry);
    if (BROAD_DENIED.has(entry)) {
      // A broad directory is refused only as a whole (or a parent); its safe children are allowed.
      if (candidate === denied || isPathWithin(denied, candidate)) return `covers ${entry}`;
      continue;
    }
    if (isPathWithin(candidate, denied)) return `inside ${entry}`;
    if (isPathWithin(denied, candidate)) return `contains ${entry}`;
  }
  return undefined;
}

/** The directories under HOME a write-mode sandbox binds back read-only. Pure function of HOME, PATH and the operator setting. */
export function sandboxHomeMounts(env: NodeJS.ProcessEnv = process.env): SandboxHomeMounts {
  const home = path.resolve(env.HOME || os.homedir());
  const result: SandboxHomeMounts = { home, mounts: [], masked: [], refused: [] };
  if (home === "/") return result;
  const seen = new Set<string>();
  const consider = (raw: string, source: SandboxHomeMount["source"]): void => {
    const candidate = path.resolve(raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw);
    if (!isPathWithin(candidate, home) || candidate === home || seen.has(candidate)) return;
    seen.add(candidate);
    const refusal = deniedReason(candidate, home);
    if (refusal) {
      if (source !== "default") result.refused.push({ path: candidate, reason: refusal });
      return;
    }
    let real: string;
    try {
      real = fs.realpathSync(candidate);
      if (!fs.statSync(real).isDirectory()) return;
    } catch {
      return;
    }
    // A symlink must not lead into a credential directory.
    const realHome = (() => { try { return fs.realpathSync(home); } catch { return home; } })();
    if (isPathWithin(real, realHome)) {
      const viaLink = deniedReason(real, realHome);
      if (viaLink) {
        result.refused.push({ path: candidate, reason: `resolves to a path ${viaLink}` });
        return;
      }
    }
    result.mounts.push({ path: candidate, source });
  };
  for (const entry of HOME_TOOLCHAIN_DEFAULTS) consider(path.join(home, entry), "default");
  for (const dir of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const resolved = path.resolve(dir);
    if (!isPathWithin(resolved, home)) continue;
    // `<prefix>/bin` needs its prefix for lib/ (npm, node_modules); prefix must itself be a safe directory.
    const prefix = path.basename(resolved) === "bin" ? path.dirname(resolved) : resolved;
    if (prefix !== resolved && prefix !== home && !deniedReason(prefix, home)) consider(prefix, "PATH");
    else consider(resolved, "PATH");
  }
  for (const raw of (operatorSetting(SANDBOX_HOME_READONLY_SETTING) ?? "").split(",").map((v) => v.trim()).filter(Boolean)) {
    consider(raw, "operator");
  }
  // Drop mounts nested inside another mount (the outer one already provides them).
  result.mounts = result.mounts.filter((m) => !result.mounts.some((o) => o !== m && o.path !== m.path && isPathWithin(m.path, o.path)));
  for (const rel of HOME_MASKED_FILES) {
    const file = path.join(home, rel);
    if (result.mounts.some((m) => isPathWithin(file, m.path)) && fs.existsSync(file)) result.masked.push(file);
  }
  return result;
}

export interface SandboxWorkspaceOverlays {
  dirs: string[];
  files: string[];
}

/**
 * The writable workspace bind is applied on top of the masked HOME, so when the workspace is HOME, sits above it, or
 * contains a credential directory, it would bring that directory back. These are the existing credential paths
 * (the specific HOME_DENIED entries and the masked files) that lie inside the workspace: a directory gets an empty
 * tmpfs and a file /dev/null mounted over it, after the workspace bind. Pure function of HOME, the workspace and the
 * file system.
 */
export function sandboxWorkspaceOverlays(workspace: string, env: NodeJS.ProcessEnv = process.env): SandboxWorkspaceOverlays {
  const home = path.resolve(env.HOME || os.homedir());
  const root = path.resolve(workspace);
  const out: SandboxWorkspaceOverlays = { dirs: [], files: [] };
  if (home === "/") return out;
  const candidates = [...HOME_DENIED.filter((entry) => !BROAD_DENIED.has(entry)), ...HOME_MASKED_FILES].map((rel) => path.join(home, rel));
  for (const candidate of candidates) {
    if (!isPathWithin(candidate, root)) continue;
    // A symlink is overlaid at its target when that lies inside the workspace; the link then reads the overlay.
    let target = candidate;
    try {
      if (fs.lstatSync(candidate).isSymbolicLink()) target = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    if (!isPathWithin(target, root)) continue;
    try {
      const stat = fs.statSync(target);
      const list = stat.isDirectory() ? out.dirs : stat.isFile() ? out.files : undefined;
      if (list && !list.includes(target)) list.push(target);
    } catch {
      // Dangling link or vanished path: nothing to hide.
    }
  }
  return out;
}

export { setSandboxNetworkFlag };
/** Whether write-mode sandboxed commands may use the network: only on an explicit operator opt-in. */
export function sandboxNetworkEnabled(): boolean {
  if (sandboxNetworkFlagSet()) return true;
  return /^(1|true|yes|on)$/i.test((operatorSetting(SANDBOX_NETWORK_SETTING) ?? "").trim());
}

const NETWORK_COMMAND = /(^|[\s;&|(`])(curl|wget|nc|ncat|ssh|scp|sftp|rsync|ftp|telnet|ping|dig|nslookup|git\s+(clone|fetch|pull|push|ls-remote|submodule)|npm\s+(install|i|ci|publish|view|update)|npx|pnpm\s+(install|add|i)|yarn(\s+(install|add))?|pip3?\s+(install|download)|uv\s+(pip|sync|add)|cargo\s+(install|fetch|publish|update)|go\s+(get|mod\s+download)|apt(-get)?\s+(install|update)|docker\s+(pull|push))(\s|$)/;

/** Approval-prompt text about the network for a sandboxed run_command, or undefined when there is nothing to say. */
export function sandboxNetworkNotice(command: string, sandboxed: boolean): string | undefined {
  if (!sandboxed) return undefined;
  if (sandboxNetworkEnabled()) return "this command runs in the sandbox WITH network access (--sandbox-network / NEXUS_SANDBOX_NETWORK).";
  if (NETWORK_COMMAND.test(command)) {
    return "this command looks like it needs the network, but the sandbox has no network by default; it will fail unless the operator restarts with --sandbox-network.";
  }
  return undefined;
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
    "/usr/bin/bash", "/bin/bash", "/usr/bin/zsh", "/bin/zsh", "/usr/bin/sh", "/bin/sh",
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
    execFileSync(probe.argv[0], probe.argv.slice(1), { stdio: "ignore", timeout: 60000 }); // first run may pull the pinned image
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
    const networkAllowed = !options.readOnlyHost && options.network !== false && (options.network === true || sandboxNetworkEnabled());

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
      bwrapArgs.push("--unshare-pid");
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
      // Mask $HOME (~/.ssh, ~/.aws, ~/.gnupg, ~/.config/nexus, browser profiles ...) the way the read-only branch does,
      // then bind back only the toolchain directories builds need. The tmpfs comes before the workspace bind, so a
      // workspace under $HOME is still bound writable on top of it.
      const home = sandboxHomeMounts();
      if (home.home !== "/" && home.home !== "/tmp") {
        bwrapArgs.push("--tmpfs", home.home);
        for (const mount of home.mounts) bwrapArgs.push("--ro-bind", mount.path, mount.path);
        for (const file of home.masked) bwrapArgs.push("--ro-bind", "/dev/null", file);
      }
      // Credential-bearing sockets (ssh/gpg agents, the user bus) and the container engine's control socket.
      if (typeof process.getuid === "function" && fs.existsSync(`/run/user/${process.getuid()}`)) {
        bwrapArgs.push("--tmpfs", `/run/user/${process.getuid()}`);
      }
      for (const socket of ["/run/docker.sock", "/var/run/docker.sock"]) {
        try {
          if (fs.lstatSync(socket).isSocket()) bwrapArgs.push("--ro-bind", "/dev/null", socket);
        } catch {
          // Not present.
        }
      }
      bwrapArgs.push("--bind", absWorkspace, absWorkspace);
      // The workspace bind above would re-expose credential paths when the workspace is, or contains, $HOME.
      const overlays = sandboxWorkspaceOverlays(absWorkspace);
      for (const dir of overlays.dirs) bwrapArgs.push("--tmpfs", dir);
      for (const file of overlays.files) bwrapArgs.push("--ro-bind", "/dev/null", file);
      // bwrap passes its own environment to the command. Start empty and set back only the scrubbed command
      // environment, so a sandboxed command cannot see the operator's credentials either (read-only branch above
      // already starts from --clearenv with a fixed PATH/HOME).
      bwrapArgs.push("--clearenv");
      for (const [name, value] of Object.entries(buildCommandEnvironment())) {
        bwrapArgs.push("--setenv", name, value);
      }
    }

    // --die-with-parent: every descendant dies with the runner. --unshare-pid plus the fresh /proc mounted above
    // keep host processes, and their /proc/<pid>/environ, out of sight.
    // Deliberately NOT --new-session: it makes bwrap its own session leader (pgid = sid = pid), so the runner's
    // killpg on cancel or deadline (REQ-AGT-109, REQ-SEC-106) no longer reaches the sandboxed command, which then
    // survives cancellation. What it would add, blocking TIOCSTI keystroke injection, is already closed by the
    // kernel default since 6.2 (dev.tty.legacy_tiocsti=0). The command keeps its controlling terminal, so
    // /dev/tty works as before.
    bwrapArgs.push("--chdir", absWorkspace, "--unshare-pid", "--die-with-parent");

    // No network unless the operator opted in explicitly (read-only mode always passes network: false).
    if (!networkAllowed) {
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
    if (options.readOnlyHost) {
      return {
        command: cmd,
        sandboxed: false,
        engine: "none",
        warning: "Read-only host confinement requires Bubblewrap with a pinned workspace descriptor; Docker path mounts are not supported.",
      };
    }
    if (!isDockerAvailable() && mode === "docker") {
      return {
        command: cmd,
        sandboxed: false,
        engine: "none",
        warning: "Docker is requested but not available or daemon is not running.",
      };
    }

    const image = dockerSandboxImage();
    if (!image) {
      return {
        command: cmd,
        sandboxed: false,
        engine: "none",
        warning: `${DOCKER_SANDBOX_IMAGE_SETTING} must name an image pinned by digest (name@sha256:<64 hex>); refusing to run an unpinned image.`,
      };
    }

    // Hardened `docker run`: unprivileged host uid, no capabilities, no setuid escalation, read-only root with a
    // writable /tmp tmpfs, bounded process count, no network unless the operator opted in (same switch as bwrap).
    const networkAllowed = options.network !== false && (options.network === true || sandboxNetworkEnabled());
    const dockerArgs = [
      "docker",
      "run",
      "--rm",
      "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      ...(networkAllowed ? [] : ["--network", "none"]),
      "--pids-limit", DOCKER_PIDS_LIMIT,
      "--read-only",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
    ];
    // Nothing is inherited: the container starts with the scrubbed command environment only. HOME, PATH and TMPDIR
    // name host paths, so they are replaced with container paths.
    const containerEnv = { ...buildCommandEnvironment(), HOME: "/tmp", PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: "/tmp" };
    for (const [name, value] of Object.entries(containerEnv)) dockerArgs.push("--env", `${name}=${value}`);
    dockerArgs.push("-v", `${absWorkspace}:${absWorkspace}`, "-w", absWorkspace, image, "sh", "-c", cmd);

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
