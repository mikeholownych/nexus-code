// Minimal Bubblewrap boundary for task setup and validators. These commands receive no host HOME,
// network namespace, task directory, or inherited environment.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { containmentProblem, spawnContained } from "./resources.mjs";

const BWRAP = "/usr/bin/bwrap";
const SYSTEM_BINARIES = ["/usr/bin", "/usr/lib", "/usr/lib64", "/usr/share", "/lib", "/lib64"];
const FORBIDDEN_RUNTIME_ROOTS = ["/etc", "/root", "/proc", "/sys", "/run", "/var", "/dev", "/tmp", "/mnt", "/media", "/srv"];
const SENSITIVE_HOME_PARTS = [".ssh", ".config", ".aws", ".azure", ".gnupg", ".kube", ".nexus", ".cache"];
let sandboxPreflight;

export function sandboxAvailable() {
  if (sandboxPreflight !== undefined) return sandboxPreflight;
  try {
    if (!fs.statSync(BWRAP).isFile() || (fs.statSync(BWRAP).mode & 0o111) === 0) return (sandboxPreflight = false);
    const args = ["--unshare-user", "--unshare-pid", "--unshare-net", "--disable-userns", "--die-with-parent", "--proc", "/proc", "--dev", "/dev"];
    for (const source of SYSTEM_BINARIES) {
      try { if (fs.statSync(source).isDirectory()) args.push("--ro-bind", source, source); } catch {}
    }
    args.push("--clearenv", "--", "/usr/bin/unshare", "-Ur", "true");
    const result = spawnSync(BWRAP, args, { encoding: "utf8", timeout: 5000, env: {} });
    // The sandbox itself must start, and nested user namespaces must be unavailable to the payload.
    return (sandboxPreflight = result.status === 1 && !result.error);
  } catch {
    return (sandboxPreflight = false);
  }
}

export function isolatedArgv({ cwd, home, command, timeoutSec = 300 }) {
  if (!sandboxAvailable()) throw new Error("Bubblewrap is unavailable; refusing to execute task-controlled commands");
  const workspace = fs.realpathSync(cwd);
  const args = [
    "--unshare-user", "--unshare-pid", "--unshare-net", "--disable-userns", "--die-with-parent",
    "--new-session", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
  ];
  for (const source of SYSTEM_BINARIES) {
    try {
      if (fs.statSync(source).isDirectory()) args.push("--ro-bind", source, source);
    } catch {}
  }
  for (const source of ["/etc/ld.so.cache", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/localtime"]) {
    try {
      if (fs.statSync(source).isFile()) args.push("--ro-bind", source, source);
    } catch {}
  }
  args.push("--bind", workspace, "/workspace", "--dir", "/home", "--dir", "/run");
  args.push("--symlink", "usr/bin", "/bin");
  args.push("--chdir", "/workspace", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin");
  args.push("--setenv", "HOME", home ? "/home/eval" : "/tmp");
  args.push("--setenv", "CI", "1", "--setenv", "LANG", "C.UTF-8");
  if (home) args.push("--tmpfs", "/home/eval");
  args.push("--", "/usr/bin/bash", "-c", command);
  return { cmd: BWRAP, argv: args, timeoutMs: timeoutSec * 1000 };
}

export function runtimeMountProblem(readOnlyPaths, allowedRoots, allowedFiles = []) {
  if (!Array.isArray(readOnlyPaths) || !Array.isArray(allowedRoots) || !Array.isArray(allowedFiles) || allowedRoots.some((item) => typeof item !== "string" || !path.isAbsolute(item)) || allowedFiles.some((item) => typeof item !== "string" || !path.isAbsolute(item))) {
    return "candidate runtime mounts require explicit absolute paths and allowed roots";
  }
  const roots = [];
  for (const item of allowedRoots) {
    const lexical = path.resolve(item);
    const lexicalProblem = protectedRuntimeRootProblem(lexical);
    if (lexicalProblem) return lexicalProblem;
    try { roots.push(fs.realpathSync(lexical)); }
    catch { return "candidate runtime allowlist root is unavailable"; }
  }
  let executableFiles;
  try { executableFiles = allowedFiles.map((item) => fs.realpathSync(item)); }
  catch { return "candidate runtime executable is unavailable"; }
  for (const root of roots) {
    const rootProblem = protectedRuntimeRootProblem(root);
    if (rootProblem) return rootProblem;
  }
  for (const item of readOnlyPaths) {
    if (typeof item !== "string" || !path.isAbsolute(item)) return "candidate runtime paths must be absolute";
    let resolved;
    try { resolved = fs.realpathSync(item); }
    catch { return `candidate runtime path is unavailable: ${item}`; }
    const stat = fs.statSync(resolved);
    if (SYSTEM_BINARIES.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) continue;
    const explicitlySelectedTempExecutable = executableFiles.includes(resolved) && stat.isFile() && resolved.startsWith(`/tmp${path.sep}`);
    if (FORBIDDEN_RUNTIME_ROOTS.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`)) && !explicitlySelectedTempExecutable) {
      return `protected candidate runtime path is forbidden: ${resolved}`;
    }
    if (resolved === os.homedir() || (resolved.startsWith(`${os.homedir()}${path.sep}`) && resolved.split(path.sep).some((part) => SENSITIVE_HOME_PARTS.includes(part)))) {
      return `sensitive candidate runtime path is forbidden: ${resolved}`;
    }
    if (!stat.isFile() && !stat.isDirectory()) return `candidate runtime path is not a regular file or directory: ${resolved}`;
    if (!roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`)) && !executableFiles.includes(resolved)) {
      return `candidate runtime path is outside its explicit allowlist: ${resolved}`;
    }
    if (executableFiles.includes(resolved) && !stat.isFile()) return `candidate runtime executable is not a regular file: ${resolved}`;
    if (stat.isDirectory()) assertNoSymlinks(resolved);
  }
  return null;
}

function protectedRuntimeRootProblem(root) {
  if (root.startsWith(`${os.homedir()}${path.sep}`) && root.split(path.sep).some((part) => SENSITIVE_HOME_PARTS.includes(part))) return `sensitive candidate runtime root is forbidden: ${root}`;
  if (root === "/" || root === "/home" || root === os.homedir() || FORBIDDEN_RUNTIME_ROOTS.some((item) => root === item || root.startsWith(`${item}${path.sep}`))) return `protected candidate runtime root is forbidden: ${root}`;
  return null;
}

export function agentSandboxArgv({ cwd, home, proxyDirectory, readOnlyPaths = [], allowedRuntimeRoots = [], runtimeExecutablePaths = [], supervisorPath }) {
  if (!sandboxAvailable()) throw new Error("Bubblewrap is unavailable; refusing candidate execution");
  const mountProblem = runtimeMountProblem(readOnlyPaths, allowedRuntimeRoots, runtimeExecutablePaths);
  if (mountProblem) throw new Error(mountProblem);
  const nodeRuntime = fs.realpathSync(process.execPath);
  if (!fs.statSync(nodeRuntime).isFile() || (fs.statSync(nodeRuntime).mode & 0o111) === 0) {
    throw new Error("trusted evaluator Node.js runtime is unavailable");
  }
  const workspace = fs.realpathSync(cwd);
  const args = ["--unshare-user", "--unshare-pid", "--unshare-net", "--disable-userns", "--die-with-parent", "--new-session", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
  for (const source of SYSTEM_BINARIES) {
    try { if (fs.statSync(source).isDirectory()) args.push("--ro-bind", source, source); } catch {}
  }
  for (const source of ["/etc/ld.so.cache", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/localtime"]) {
    try { if (fs.statSync(source).isFile()) args.push("--ro-bind", source, source); } catch {}
  }
  const isolatedHome = fs.realpathSync(home);
  args.push("--symlink", "usr/bin", "/bin", "--bind", workspace, "/workspace", "--tmpfs", "/home", "--dir", "/home/eval", "--bind", isolatedHome, "/home/eval", "--tmpfs", "/run");
  args.push("--dir", "/run/eval-proxy", "--ro-bind", proxyDirectory, "/run/eval-proxy");
  const madeDirs = new Set(["/", "/usr", "/usr/bin", "/usr/lib", "/usr/lib64", "/usr/share", "/lib", "/lib64", "/bin", "/etc", "/workspace", "/home", "/run", "/run/eval-proxy"]);
  const addTargetParents = (target) => {
    const parts = target.split(path.sep).filter(Boolean);
    let current = "";
    for (const part of parts.slice(0, -1)) {
      current += `/${part}`;
      if (!madeDirs.has(current)) { args.push("--dir", current); madeDirs.add(current); }
    }
  };
  for (const item of readOnlyPaths) {
    const resolved = fs.realpathSync(item);
    if (SYSTEM_BINARIES.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) continue;
    if (fs.statSync(resolved).isDirectory()) assertNoSymlinks(resolved);
    addTargetParents(resolved);
    args.push("--ro-bind", resolved, resolved);
  }
  addTargetParents("/runner/agent_sandbox.mjs");
  args.push("--ro-bind", nodeRuntime, "/runner/node");
  args.push("--ro-bind", fs.realpathSync(supervisorPath), "/runner/agent_sandbox.mjs");
  args.push("--chdir", "/workspace", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/home/eval", "--setenv", "CI", "1", "--");
  args.push("/runner/node", "/runner/agent_sandbox.mjs");
  return { cmd: BWRAP, argv: args };
}

/** Run a fixed executable probe without exposing the host filesystem, environment, or network. */
export function isolatedProcessArgv({ cwd, command, argv = [], readOnlyPaths = [], allowedRoots = [], allowedFiles = [], timeoutMs = 5000, workspaceReadOnly = false }) {
  if (!sandboxAvailable()) throw new Error("Bubblewrap is unavailable; refusing executable probe");
  const mountProblem = runtimeMountProblem(readOnlyPaths, allowedRoots, allowedFiles);
  if (mountProblem) throw new Error(mountProblem);
  const workspace = fs.realpathSync(cwd);
  const args = ["--unshare-user", "--unshare-pid", "--unshare-net", "--disable-userns", "--die-with-parent", "--new-session", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
  for (const source of SYSTEM_BINARIES) {
    try { if (fs.statSync(source).isDirectory()) args.push("--ro-bind", source, source); } catch {}
  }
  for (const source of ["/etc/ld.so.cache", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/localtime"]) {
    try { if (fs.statSync(source).isFile()) args.push("--ro-bind", source, source); } catch {}
  }
  args.push(workspaceReadOnly ? "--ro-bind" : "--bind", workspace, "/workspace", "--tmpfs", "/home", "--dir", "/home/eval", "--tmpfs", "/run", "--symlink", "usr/bin", "/bin");
  const madeDirs = new Set(["/", "/usr", "/usr/bin", "/usr/lib", "/usr/lib64", "/usr/share", "/lib", "/lib64", "/bin", "/etc", "/workspace", "/home", "/home/eval", "/run"]);
  const addParents = (target) => {
    let current = "";
    for (const part of target.split(path.sep).filter(Boolean).slice(0, -1)) {
      current += `/${part}`;
      if (!madeDirs.has(current)) { args.push("--dir", current); madeDirs.add(current); }
    }
  };
  for (const item of readOnlyPaths) {
    const resolved = fs.realpathSync(item);
    if (SYSTEM_BINARIES.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) continue;
    if (fs.statSync(resolved).isDirectory()) assertNoSymlinks(resolved);
    addParents(resolved);
    args.push("--ro-bind", resolved, resolved);
  }
  const resolvedCommand = fs.realpathSync(command);
  if (!SYSTEM_BINARIES.some((root) => resolvedCommand === root || resolvedCommand.startsWith(`${root}${path.sep}`)) && !readOnlyPaths.some((item) => fs.realpathSync(item) === resolvedCommand)) {
    throw new Error("isolated executable must be included in the explicit read-only runtime paths");
  }
  args.push("--chdir", "/workspace", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/home/eval", "--setenv", "LANG", "C.UTF-8", "--");
  args.push(resolvedCommand, ...argv);
  return { cmd: BWRAP, argv: args, timeoutMs };
}

export function runIsolatedProcess(spec, { outputLimit = 16_384, input = "", resources = null } = {}) {
  const { child, containment } = spawnContained(spec, resources, { cwd: "/", env: {}, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;
    // Contained runs are stopped through their cgroup, so the supervisor survives to prove cleanup.
    const killGroup = (signal) => { if (containment) containment.kill(); else { try { process.kill(-child.pid, signal); } catch {} } };
    const collect = (target, chunk) => {
      bytes += chunk.length;
      if (bytes > outputLimit) { overflow = true; killGroup("SIGKILL"); return; }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.stdin.on("error", () => {}); // A timed-out or rejecting child may close stdin before the bounded input is sent.
    child.stdin.end(input);
    const timer = setTimeout(() => { timedOut = true; killGroup("SIGTERM"); setTimeout(() => killGroup("SIGKILL"), 250).unref(); }, spec.timeoutMs);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error: error.message, timedOut, overflow });
    });
    child.on("close", async (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup("SIGKILL");
      resolve({ status, signal, stdout, stderr, timedOut, overflow, ...(await containmentResult(containment)) });
    });
  });
}

/** Grant only the dedicated evaluator uid access to disposable paths; never make them world-writable. */
export function grantRunAsAccess(user, targets) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error("invalid evaluator account");
  const setfacl = "/usr/bin/setfacl";
  if (!fs.existsSync(setfacl)) throw new Error("setfacl is unavailable; refusing unsafe workspace permission changes");
  for (const target of targets) {
    const resolved = fs.realpathSync(target);
    const result = spawnSync(setfacl, ["-R", "-m", `u:${user}:rwX`, resolved], { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin" } });
    if (result.status !== 0) throw new Error(`could not grant scoped evaluator access to disposable path (${result.status ?? "signal"})`);
    if (fs.statSync(resolved).isDirectory()) {
      const defaults = spawnSync(setfacl, ["-m", `d:u:${user}:rwx`, resolved], { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin" } });
      if (defaults.status !== 0) throw new Error(`could not set scoped evaluator default ACL (${defaults.status ?? "signal"})`);
    }
  }
}

/** Execute a task-controlled shell command in a no-network, clear-environment namespace. */
export function runIsolated(command, { cwd, home = false, timeoutSec = 300, outputLimit = 1_000_000, resources = null } = {}) {
  const spec = isolatedArgv({ cwd, home, command, timeoutSec });
  return new Promise((resolve) => {
    const { child, containment } = spawnContained(spec, resources, { cwd: "/", env: {}, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;
    const killTree = (signal) => {
      if (containment) { containment.kill(); return; }
      try { process.kill(-child.pid, signal); } catch {}
    };
    const append = (target, chunk) => {
      bytes += chunk.length;
      if (bytes > outputLimit) {
        overflow = true;
        killTree("SIGKILL");
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 250).unref();
    }, spec.timeoutMs);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error: error.message, timedOut, overflow });
    });
    child.on("close", async (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree("SIGKILL");
      resolve({ status, signal, stdout, stderr, timedOut, overflow, ...(await containmentResult(containment)) });
    });
  });
}

/** `{ resources, containmentProblem }` for a contained execution; nothing for an uncontained one. */
async function containmentResult(containment) {
  if (!containment) return {};
  const final = await containment.final;
  return { resources: final, containmentProblem: containmentProblem(final) };
}

/** Resolve task-controlled paths without permitting traversal or symlink redirection. */
export function confinedPath(root, relative, { allowMissingLeaf = false } = {}) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.includes("\0")) {
    throw new Error("task path must be a non-empty relative path");
  }
  const parts = relative.split(/[\\/]+/);
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`unsafe task path: ${relative}`);
  const base = fs.realpathSync(root);
  let current = base;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (allowMissingLeaf && i === parts.length - 1 && error.code === "ENOENT") return current;
      throw new Error(`task path does not exist: ${relative}`);
    }
    if (stat.isSymbolicLink()) throw new Error(`task path contains a symlink: ${relative}`);
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`task path parent is not a directory: ${relative}`);
  }
  const resolved = fs.realpathSync(current);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new Error(`task path escapes its root: ${relative}`);
  return resolved;
}

export function assertNoSymlinks(root) {
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const item = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`task tree contains a symlink: ${path.relative(root, item)}`);
      if (entry.isDirectory()) visit(item);
    }
  };
  visit(root);
}
