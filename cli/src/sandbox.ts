import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { buildCommandEnvironment } from "./command_env.js";
import { operatorSetting } from "./client.js";
import { sandboxNetworkFlagSet, sandboxNetworkProfileValue, setSandboxNetworkFlag } from "./sandbox_network.js";

export type SandboxMode = "auto" | "bwrap" | "docker" | "none";

export interface SandboxOptions {
  mode?: SandboxMode;
  readOnlyHost?: boolean;
  /** Open workspace directory inherited by Bubblewrap as child fd 3. */
  workspaceFd?: number;
  network?: boolean;
  shell?: string;
  customBwrapArgs?: string[];
  /** Directories to hide from the command in addition to those registered with `hideDirectoryFromSandbox`. */
  hideDirectories?: readonly string[];
}

const hiddenDirectories = new Set<string>();

/**
 * Hides `dir` (resolved through symlinks) from every Bubblewrap command and worker this process builds from now on.
 * The sidecar's control socket directory is registered here: its descriptor holds the attach token, so no sandboxed
 * command may read it, wherever `XDG_RUNTIME_DIR` points. Docker mounts only the workspace, so it needs no mask.
 */
export function hideDirectoryFromSandbox(dir: string): void {
  hiddenDirectories.add(fs.realpathSync(dir));
}

/** The masks for one bwrap command: those registered and those passed, each resolved. One that no longer exists hides nothing, and bwrap cannot mount over it. */
function directoriesToHide(extra: readonly string[] = []): string[] {
  const resolved = new Set<string>();
  for (const dir of [...hiddenDirectories, ...extra]) {
    try { resolved.add(fs.realpathSync(dir)); } catch { /* gone */ }
  }
  return [...resolved];
}

/** Structured reason a sandbox refused to confine a command. Evidence only; never an approval or verdict. */
export interface SandboxDenialReason {
  kind: "denied" | "unavailable" | "violation";
  category: "filesystem" | "network" | "engine" | "policy";
  reason: string;
}

export interface SandboxedCommandResult {
  command: string;
  argv?: string[];
  sandboxed: boolean;
  engine: "bwrap" | "docker" | "none";
  warning?: string;
  /** Set when sandboxed is false because confinement was refused or unavailable. */
  denial?: SandboxDenialReason;
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
  const profile = sandboxNetworkProfileValue();
  if (profile !== undefined) return profile;
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

/** `candidate` is `root` or below it. A first segment that merely starts with two dots (`..hid`) is inside. */
export function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || !(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
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
export interface SandboxedWorkerLaunch {
  /** The program and arguments to spawn: `bwrap ...` or `docker run ...` ending in the worker command. */
  command?: string;
  args?: string[];
  sandboxed: boolean;
  engine: SandboxedCommandResult["engine"];
  warning?: string;
  denial?: SandboxDenialReason;
}

export interface SandboxedWorkerOptions extends Pick<SandboxOptions, "network"> {
  /** Engines to try, in order. Default: Bubblewrap only. */
  engines?: readonly ("bwrap" | "docker")[];
}

/**
 * CS-10: launches a long-lived worker (the native core) inside the sandbox a command would get: a read-only root, the
 * workspace the only writable path, $HOME masked, a scrubbed environment, no network unless the operator allowed it, and
 * the worker ends with its parent. The worker's commands then run in the same box, so the per-command wrap is not
 * applied a second time.
 *
 * The first engine in `options.engines` that can build the box is used; with none, the result is unsandboxed with the
 * reasons, and the caller decides whether that is a refusal.
 */
export function wrapSandboxedWorker(
  workerPath: string,
  workerArgs: readonly string[],
  workspace: string,
  options: SandboxedWorkerOptions = {},
): SandboxedWorkerLaunch {
  const warnings: string[] = [];
  for (const engine of options.engines ?? ["bwrap"]) {
    const launch = engine === "bwrap"
      ? wrapBwrapWorker(workerPath, workerArgs, workspace, options)
      : wrapDockerWorker(workerPath, workerArgs, workspace, options);
    if (launch.sandboxed) return launch;
    if (launch.warning) warnings.push(launch.warning);
  }
  const warning = warnings.join(" ") || "No sandbox engine was requested for the worker.";
  return { sandboxed: false, engine: "none", warning, denial: { kind: "unavailable", category: "engine", reason: warning } };
}

/** The worker's own directory is bound read-only because it may live under the masked $HOME (a checkout or a per-user install). */
function wrapBwrapWorker(workerPath: string, workerArgs: readonly string[], workspace: string, options: SandboxedWorkerOptions): SandboxedWorkerLaunch {
  if (!isBwrapAvailable()) {
    const warning = "Bubblewrap (bwrap) is not available, so the worker cannot be isolated.";
    return { sandboxed: false, engine: "none", warning, denial: { kind: "unavailable", category: "engine", reason: warning } };
  }
  const exec = `exec ${[workerPath, ...workerArgs].map(quoteForShell).join(" ")}`;
  const wrapped = wrapSandboxedCommand(exec, workspace, {
    mode: "bwrap",
    shell: "bash",
    network: options.network,
    customBwrapArgs: ["--ro-bind", path.dirname(workerPath), path.dirname(workerPath)],
  });
  if (!wrapped.sandboxed || wrapped.engine !== "bwrap" || !wrapped.argv?.length) {
    const warning = wrapped.warning ?? "The Bubblewrap profile could not be built for the worker.";
    return { sandboxed: false, engine: wrapped.engine, warning, denial: wrapped.denial ?? { kind: "unavailable", category: "engine", reason: warning } };
  }
  return { command: wrapped.argv[0], args: wrapped.argv.slice(1), sandboxed: true, engine: "bwrap" };
}

/** Where the worker and the libraries it was linked against are mounted in the container; nothing in the image is replaced. */
const DOCKER_WORKER_RUNTIME = "/nexus-worker";
export const DOCKER_WORKER_LABEL = "io.nexus-code.worker-of";

type ElfRuntimeInfo = { interpreter?: string; machine: string; needed: string[]; soname?: string; searchPaths: string[] };

/** Resolve only root-owned system inspection tools; PATH may contain workspace-controlled entries. */
function trustedSystemTool(name: string): string | undefined {
  for (const directory of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    const candidate = path.join(directory, name);
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Try the next standard system directory.
    }
  }
  return undefined;
}

function readElfRuntimeInfo(readelf: string, file: string): ElfRuntimeInfo | { error: string } {
  let output: string;
  try {
    output = execFileSync(readelf, ["-hW", "-lW", "-dW", file], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
  } catch (err: any) {
    const detail = String(err?.stderr ?? err?.message ?? err).split("\n")[0];
    return { error: `ELF metadata could not be read for ${file}: ${detail}` };
  }
  if (/Not an ELF file|Failed to read file header/i.test(output)) return { error: `${file} is not a readable ELF file.` };
  const machine = output.match(/^\s*Machine:\s*(.+)$/m)?.[1].trim();
  if (!machine) return { error: `the ELF machine type could not be read for ${file}.` };
  const interpreter = output.match(/\[Requesting program interpreter:\s*([^\]]+)\]/)?.[1];
  const needed = [...output.matchAll(/\(NEEDED\).*?Shared library:\s*\[([^\]]+)\]/g)].map((match) => match[1]);
  const soname = output.match(/\(SONAME\).*?Library soname:\s*\[([^\]]+)\]/)?.[1];
  const rawSearchPaths = [...output.matchAll(/\((?:RPATH|RUNPATH)\).*?\[([^\]]*)\]/g)].flatMap((match) => match[1].split(":"));
  const origin = path.dirname(file);
  const searchPaths = rawSearchPaths.flatMap((entry) => {
    const expanded = entry.replace(/\$\{ORIGIN\}|\$ORIGIN/g, origin);
    if (!expanded || expanded.includes("$") || !path.isAbsolute(expanded)) return [];
    return [expanded];
  });
  return { interpreter, machine, needed, soname, searchPaths };
}

/**
 * Resolve the worker's ELF interpreter and shared libraries without executing the worker. `ldd` can run the target's
 * interpreter on some systems, so it is unsafe for a binary that an agent may have replaced inside its workspace.
 * `readelf` only parses metadata; `ldconfig -p` supplies the host's cached library paths. Unknown dependencies fail
 * closed. Static workers need no host runtime files.
 */
export function workerRuntimeFiles(workerPath: string): { loader?: string; libraries: string[]; libraryNames: Array<{ name: string; path: string }> } | { error: string } {
  if (process.platform !== "linux") return { error: "worker runtime discovery is supported only on Linux." };
  const readelf = trustedSystemTool("readelf");
  if (!readelf) return { error: "a trusted system readelf executable is unavailable." };

  let resolvedWorker: string;
  try {
    resolvedWorker = fs.realpathSync(workerPath);
    if (!fs.statSync(resolvedWorker).isFile()) return { error: "the worker path is not a regular file." };
  } catch (err: any) {
    return { error: `the worker binary is missing: ${err?.message ?? err}` };
  }

  const initial = readElfRuntimeInfo(readelf, resolvedWorker);
  if ("error" in initial) return initial;
  const machineTags = ({ x64: ["x86-64"], arm64: ["aarch64"], arm: ["arm"], ia32: ["80386"] } as Record<string, string[]>)[process.arch] ?? [];
  if (!machineTags.some((tag) => initial.machine.toLowerCase().includes(tag))) {
    return { error: `the worker architecture (${initial.machine}) does not match the host architecture (${process.arch}).` };
  }
  if (!initial.interpreter && initial.needed.length === 0) return { libraries: [], libraryNames: [] };
  if (!initial.interpreter) return { error: "the dynamically linked worker has no ELF interpreter." };

  const ldconfig = trustedSystemTool("ldconfig");
  if (!ldconfig) return { error: "a trusted system ldconfig executable is unavailable for shared-library resolution." };
  let cacheOutput: string;
  try {
    cacheOutput = execFileSync(ldconfig, ["-p"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
  } catch (err: any) {
    return { error: `system shared-library paths could not be read (ldconfig failed: ${String(err?.message ?? err).split("\n")[0]}).` };
  }

  const architecture = ({ x64: ["x86-64", "x86_64"], arm64: ["aarch64"], arm: ["arm"], ia32: ["80386"] } as Record<string, string[]>)[process.arch] ?? [];
  const cache = new Map<string, string[]>();
  for (const line of cacheOutput.split("\n")) {
    const match = line.match(/^\s*(\S+)\s+\(([^)]+)\)\s+=>\s+(\S+)\s*$/);
    if (!match || !architecture.some((tag) => match[2].toLowerCase().includes(tag))) continue;
    const paths = cache.get(match[1]) ?? [];
    paths.push(match[3]);
    cache.set(match[1], paths);
  }

  const loaderPath = initial.interpreter;
  let loader: string | undefined;
  if (loaderPath) {
    try {
      loader = fs.realpathSync(loaderPath);
      if (!fs.statSync(loader).isFile()) return { error: "the worker's ELF interpreter is not a regular file." };
    } catch (err: any) {
      return { error: `the worker's ELF interpreter is missing: ${err?.message ?? err}` };
    }
  }

  const libraries = new Set<string>();
  const libraryNames = new Map<string, string>();
  const scanned = new Set<string>([resolvedWorker]);
  const queue: Array<{ file: string; info: ElfRuntimeInfo }> = [{ file: resolvedWorker, info: initial }];
  const resolveNeeded = (name: string, searchPaths: string[]): string | undefined => {
    const candidates = name.includes("/")
      ? (path.isAbsolute(name) ? [name] : [])
      : [...searchPaths.map((directory) => path.join(directory, name)), ...(cache.get(name) ?? [])];
    for (const candidate of candidates) {
      try {
        const resolved = fs.realpathSync(candidate);
        if (fs.statSync(resolved).isFile()) return resolved;
      } catch {
        // Try the next candidate; never guess when a needed library is absent.
      }
    }
    return undefined;
  };

  while (queue.length) {
    const current = queue.shift()!;
    for (const name of current.info.needed) {
      if (name !== path.basename(name) || !/^[A-Za-z0-9_.+-]+$/.test(name)) {
        return { error: `the worker has an unsafe shared-library name: ${name}` };
      }
      const resolved = resolveNeeded(name, current.info.searchPaths);
      if (!resolved) return { error: `the worker needs a shared library that could not be resolved: ${name}` };
      const previous = libraryNames.get(name);
      if (previous && previous !== resolved) return { error: `the worker's shared-library name is ambiguous: ${name}` };
      libraryNames.set(name, resolved);
      libraries.add(resolved);
      if (libraries.size > 256) return { error: "the worker has more than 256 shared runtime files; refusing an unbounded mount set." };
      if (scanned.has(resolved)) continue;
      scanned.add(resolved);
      const info = readElfRuntimeInfo(readelf, resolved);
      if ("error" in info) return info;
      if (!machineTags.some((tag) => info.machine.toLowerCase().includes(tag))) {
        return { error: `shared library ${name} has an incompatible architecture (${info.machine}).` };
      }
      queue.push({ file: resolved, info });
    }
  }
  return { ...(loader ? { loader } : {}), libraries: [...libraries], libraryNames: [...libraryNames].map(([name, file]) => ({ name, path: file })) };
}

/**
 * CS-10 (Docker): the worker as the long-lived process of one hardened container, built from the same `docker run`
 * arguments a sandboxed command gets (unprivileged uid, no capabilities, read-only root, no network unless allowed, the
 * workspace the only host directory). `--interactive` carries the JSON-RPC stream; `--init` reaps the commands the
 * worker starts and forwards signals; the container ends when the worker does (its client closing stdin ends the worker).
 */
function wrapDockerWorker(workerPath: string, workerArgs: readonly string[], workspace: string, options: SandboxedWorkerOptions): SandboxedWorkerLaunch {
  const refuse = (warning: string, denial?: SandboxDenialReason): SandboxedWorkerLaunch => ({ sandboxed: false, engine: "none", warning, denial: denial ?? { kind: "unavailable", category: "engine", reason: warning } });
  if (process.platform !== "linux") return refuse("The worker can only run in a Docker container on a Linux host.");
  // The CLI being installed is not enough for a long-lived worker: with the daemon down the container would never start
  // and every tool would fail. Ask the daemon, so `auto` can fall back and an explicit `docker` refuses with the reason.
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: ["ignore", "ignore", "ignore"], timeout: 5000 });
  } catch {
    return refuse("The Docker daemon is not reachable, so the worker cannot run in a container.");
  }
  const placeholder = "true";
  const wrapped = wrapSandboxedCommand(placeholder, workspace, { mode: "docker", network: options.network });
  if (!wrapped.sandboxed || wrapped.engine !== "docker" || !wrapped.argv?.length) {
    return refuse(wrapped.warning ?? "The Docker sandbox could not be built for the worker.", wrapped.denial);
  }
  // The command form ends `-w <workspace> <image> sh -c <cmd>`; everything before the image is the hardened profile.
  const tail = wrapped.argv.slice(-6);
  const absWorkspace = path.resolve(workspace);
  if (tail[0] !== "-w" || tail[1] !== absWorkspace || tail[3] !== "sh" || tail[4] !== "-c" || tail[5] !== placeholder || wrapped.argv[1] !== "run") {
    return refuse("The Docker sandbox arguments have an unexpected shape; refusing to start the worker in a container built from them.");
  }
  const image = tail[2];
  const runtime = workerRuntimeFiles(workerPath);
  if ("error" in runtime) return refuse(`The worker cannot run in a Docker container: ${runtime.error}.`);
  const mounts: string[] = [];
  const names = new Set<string>();
  const mount = (host: string, name: string) => {
    if (names.has(name)) return;
    names.add(name);
    mounts.push("-v", `${host}:${DOCKER_WORKER_RUNTIME}/${name}:ro`);
  };
  let resolvedWorker: string;
  try {
    resolvedWorker = fs.realpathSync(workerPath);
  } catch (err: any) {
    return refuse(`The worker binary is missing: ${err?.message ?? err}.`);
  }
  mount(resolvedWorker, "harness-core");
  for (const library of runtime.libraries) mount(library, path.basename(library));
  for (const library of runtime.libraryNames) mount(library.path, library.name);
  const inContainer = `${DOCKER_WORKER_RUNTIME}/harness-core`;
  const start = runtime.loader
    ? (mount(runtime.loader, "ld.so"), [`${DOCKER_WORKER_RUNTIME}/ld.so`, "--library-path", DOCKER_WORKER_RUNTIME, inContainer])
    : [inContainer];
  const profile = wrapped.argv.slice(2, -6);
  return {
    command: "docker",
    // The label names the CLI process that owns the container, so a leftover can be found (`docker ps --filter label=...`).
    args: ["run", "--interactive", "--init", "--label", `${DOCKER_WORKER_LABEL}=${process.pid}`, ...profile, ...mounts, "-w", absWorkspace, image, ...start, ...workerArgs],
    sandboxed: true,
    engine: "docker",
  };
}

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
        denial: { kind: "unavailable", category: "engine", reason: "Bubblewrap (bwrap) is requested but not found in PATH." },
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
          denial: { kind: "unavailable", category: "policy", reason: "Read-only Bubblewrap requires a pinned workspace directory descriptor." },
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
          denial: { kind: "denied", category: "policy", reason: "Custom Bubblewrap mounts are incompatible with read-only host confinement." },
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
      // This synthetic root holds only /tmp (a fresh tmpfs), $HOME (masked) and the workspace, so a hidden directory
      // elsewhere is absent already. Mask it where it could be visible: under $HOME, or inside the workspace.
      for (const dir of directoriesToHide(options.hideDirectories)) {
        if (isPathWithin(dir, absWorkspace) || (homeIsUsable && isPathWithin(dir, userHome))) bwrapArgs.push("--tmpfs", dir);
      }
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
      // Directories that hold a credential for another Nexus client (the control socket's token), wherever they are.
      for (const dir of directoriesToHide(options.hideDirectories)) bwrapArgs.push("--tmpfs", dir);
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
        denial: { kind: "unavailable", category: "engine", reason: "Read-only host confinement requires Bubblewrap with a pinned workspace descriptor; Docker path mounts are not supported." },
      };
    }
    if (!isDockerAvailable() && mode === "docker") {
      return {
        command: cmd,
        sandboxed: false,
        engine: "none",
        warning: "Docker is requested but not available or daemon is not running.",
        denial: { kind: "unavailable", category: "engine", reason: "Docker is requested but not available or daemon is not running." },
      };
    }

    const image = dockerSandboxImage();
    if (!image) {
      return {
        command: cmd,
        sandboxed: false,
        engine: "none",
        warning: `${DOCKER_SANDBOX_IMAGE_SETTING} must name an image pinned by digest (name@sha256:<64 hex>); refusing to run an unpinned image.`,
        denial: { kind: "unavailable", category: "policy", reason: `${DOCKER_SANDBOX_IMAGE_SETTING} must name an image pinned by digest (name@sha256:<64 hex>); refusing to run an unpinned image.` },
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
    dockerArgs.push("-v", `${absWorkspace}:${absWorkspace}`);
    // When the workspace is HOME or above it, the bind would bring credential paths back (same hole as bwrap's
    // workspace bind, see sandboxWorkspaceOverlays). Docker mounts by destination depth, so these nested mounts sit
    // on top of the workspace mount. The docker socket and /run/user cannot lie inside a workspace bind, so they
    // need no mask here.
    const overlays = sandboxWorkspaceOverlays(absWorkspace);
    for (const dir of overlays.dirs) dockerArgs.push("--tmpfs", `${dir}:ro,nosuid,nodev,size=1m`);
    for (const file of overlays.files) dockerArgs.push("-v", `/dev/null:${file}:ro`);
    dockerArgs.push("-w", absWorkspace, image, "sh", "-c", cmd);

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
    denial: { kind: "unavailable", category: "engine", reason: "No sandboxing engine (bwrap or docker) available. Running directly on host." },
  };
}
