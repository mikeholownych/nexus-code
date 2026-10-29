// Minimal Bubblewrap boundary for task setup and validators. These commands receive no host HOME,
// network namespace, task directory, or inherited environment.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { containmentProblem, spawnContained } from "./resources.mjs";

const BWRAP = "/usr/bin/bwrap";
const FIND = "/usr/bin/find";
// Mount only runtime data the isolated tools need. The broad /usr/share tree also
// contains host-only, permission-restricted application data and is not a candidate runtime dependency.
const SYSTEM_BINARIES = ["/usr/bin", "/usr/lib", "/usr/lib64", "/usr/libexec", "/usr/share/git-core/templates", "/usr/share/terminfo", "/usr/share/zoneinfo", "/lib", "/lib64", "/usr/local/lib"];
const SYSTEM_ETC_FILES = ["/etc/ld.so.cache", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/localtime"];
const SYSTEM_ETC_DIRS = ["/etc/alternatives"];
const FORBIDDEN_RUNTIME_ROOTS = ["/etc", "/root", "/proc", "/sys", "/run", "/var", "/dev", "/tmp", "/mnt", "/media", "/srv"];
const SENSITIVE_HOME_PARTS = [".ssh", ".config", ".aws", ".azure", ".gnupg", ".kube", ".nexus", ".cache"];
const TOOLCHAIN_POLICY = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "toolchain-versions.json"), "utf8"));
if (TOOLCHAIN_POLICY.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(TOOLCHAIN_POLICY.go) || !/^\d+\.\d+\.\d+$/.test(TOOLCHAIN_POLICY.rust)) {
  throw new Error("evaluator toolchain policy must pin exact Go and Rust versions");
}
const PINNED_ORACLE_TOOLCHAINS = Object.freeze([
  { root: "/usr/local/go", sourceRoots: ["/usr/local/go", "/opt/nexus-qual/go"], required: ["bin/go"] },
  { root: "/usr/local/nexus-qual/rust", sourceRoots: ["/usr/local/nexus-qual/rust", "/opt/nexus-qual/rust"], required: ["bin/rustc", "bin/cargo"] },
]);
const UNPINNED_ORACLE_COMPILER_NAME = /^(?:go(?:-?\d[A-Za-z0-9.+-]*)?|rustc(?:-\d[A-Za-z0-9.+-]*)?|cargo(?:-\d[A-Za-z0-9.+-]*)?|rustup)$/;
let sandboxPreflight;
const pinnedToolchainPreflights = new Map();

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function candidateAgentPath(configuredPath, toolchains = resolveHostToolchains()) {
  const configuredEntries = (configuredPath ?? "/usr/bin:/bin").split(path.delimiter).filter(Boolean);
  const toolchainEntries = [
    ...(toolchains.rustRoot ? ["/usr/local/nexus-qual/rust/bin"] : []),
    ...(toolchains.goRoot ? ["/usr/local/go/bin"] : []),
  ];
  return [...new Set([...toolchainEntries, ...configuredEntries])].join(path.delimiter);
}

export function oracleToolchainPathProblem(stat) {
  if (!stat || stat.isSymbolicLink?.() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    return "pinned oracle toolchain entry is not a real root-owned path without group or other write permission";
  }
  return null;
}

export function candidateToolchainRootProblem(stat, resolvedPath, expectedPath) {
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || oracleToolchainPathProblem(stat) || resolvedPath !== expectedPath) {
    return "pinned candidate toolchain root is not a safe real directory";
  }
  return null;
}

function toolchainMountArgs(toolchains, parentDirectoryAvailable = false) {
  const args = [];
  const createdDirectories = new Set(parentDirectoryAvailable ? ["/usr/local"] : []);
  const ensureDirectory = (directory) => {
    if (createdDirectories.has(directory)) return;
    args.push("--dir", directory);
    createdDirectories.add(directory);
  };
  if (toolchains.goRoot) {
    ensureDirectory("/usr/local");
    args.push("--ro-bind", toolchains.goRoot, "/usr/local/go");
  }
  if (toolchains.rustRoot) {
    ensureDirectory("/usr/local");
    ensureDirectory("/usr/local/nexus-qual");
    args.push("--ro-bind", toolchains.rustRoot, "/usr/local/nexus-qual/rust");
  }
  return args;
}

export function candidateToolchainMountArgs(toolchains, systemDirectories = []) {
  return toolchainMountArgs(toolchains, systemDirectories.includes("/usr/local/lib"));
}

export function candidateToolchainRootSources(toolchains = PINNED_ORACLE_TOOLCHAINS) {
  const roots = Object.fromEntries(toolchains.map(({ root, sourceRoots = [root], required }) => {
    for (const sourceRoot of sourceRoots) {
      let stat;
      try { stat = fs.lstatSync(sourceRoot); }
      catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (stat.isSymbolicLink()) continue;
      let resolvedRoot;
      try { resolvedRoot = fs.realpathSync(sourceRoot); }
      catch (error) {
        if (["EACCES", "ELOOP", "ENOENT", "ENOTDIR", "EPERM"].includes(error?.code)) continue;
        throw error;
      }
      const rootProblem = candidateToolchainRootProblem(stat, resolvedRoot, sourceRoot);
      if (rootProblem || pinnedToolchainProblem(sourceRoot, required)) continue;
      return [root, sourceRoot];
    }
    return [root, null];
  }));
  return roots;
}

function resolveHostToolchains() {
  const roots = candidateToolchainRootSources();
  return {
    goRoot: roots["/usr/local/go"],
    rustRoot: roots["/usr/local/nexus-qual/rust"],
  };
}

/** Python black-box oracles may invoke only these root-owned, pinned compiler runtimes. */
export function oracleToolchainVersionProblem({ goVersion, rustcVersion, cargoVersion }) {
  const actualGo = /^go version (go\S+)/.exec(goVersion ?? "")?.[1];
  const actualRustc = /^rustc (\S+)/.exec(rustcVersion ?? "")?.[1];
  const actualCargo = /^cargo (\S+)/.exec(cargoVersion ?? "")?.[1];
  if (actualGo !== `go${TOOLCHAIN_POLICY.go}` || actualRustc !== TOOLCHAIN_POLICY.rust || actualCargo !== TOOLCHAIN_POLICY.rust) {
    return `pinned oracle toolchain versions do not match policy (expected Go ${TOOLCHAIN_POLICY.go} and Rust ${TOOLCHAIN_POLICY.rust})`;
  }
  return null;
}

function isInsideAnyRoot(candidate, roots) {
  return roots.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
}

function mountedSpellingsForTarget(target, roots) {
  const spellings = new Set();
  for (const root of roots) {
    let canonicalRoot;
    try { canonicalRoot = fs.realpathSync(root); }
    catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!isInsideAnyRoot(target, [canonicalRoot])) continue;
    spellings.add(path.resolve(root, path.relative(canonicalRoot, target)));
  }
  return [...spellings];
}

export function scanOracleCompilerExposure(systemDirectories = SYSTEM_BINARIES, systemEtcDirectories = SYSTEM_ETC_DIRS, additionalMountedPaths = [], approvedToolchainRoots = []) {
  const roots = [...new Set([...systemDirectories, ...systemEtcDirectories, ...additionalMountedPaths])].sort();

  const exposed = new Set();
  const visited = new Set();
  const approvedRoots = approvedToolchainRoots.map((root) => fs.realpathSync(root));
  const inspectExecutable = (item, isSymbolicLink) => {
    if (visited.has(item)) return;
    visited.add(item);
    const entryName = path.basename(item);
    if (!UNPINNED_ORACLE_COMPILER_NAME.test(entryName) && !isSymbolicLink) return;
    let stat;
    let target;
    try {
      stat = fs.statSync(item);
      target = fs.realpathSync(item);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (!stat.isFile()
      || (stat.mode & 0o111) === 0
      || (!UNPINNED_ORACLE_COMPILER_NAME.test(entryName) && !UNPINNED_ORACLE_COMPILER_NAME.test(path.basename(target)))
      || isInsideAnyRoot(target, approvedRoots)) return;
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let header;
    try {
      header = Buffer.alloc(2);
      fs.readSync(descriptor, header, 0, header.length, 0);
    } finally {
      fs.closeSync(descriptor);
    }
    // Names such as `go-225` also occur in executable-mode terminfo records. Exclude only
    // positively identified compiled terminfo data; keep no-shebang and binfmt executables.
    const terminfoMagic = header.equals(Buffer.from([0x1a, 0x01])) || header.equals(Buffer.from([0x1e, 0x02]));
    if (terminfoMagic && /(?:^|\/)terminfo\//.test(item)) return;
    // The candidate's explicit runtime mounts may expose compiler targets outside the
    // standard system roots. Mask each visible spelling after all runtime mounts are added.
    for (const mountedPath of mountedSpellingsForTarget(target, roots)) exposed.add(mountedPath);
  };
  try {
    const directoryRoots = new Set();
    for (const root of roots) {
      let stat;
      try { stat = fs.statSync(root); }
      catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (stat.isDirectory()) directoryRoots.add(fs.realpathSync(root));
      else if (stat.isFile()) inspectExecutable(root, fs.lstatSync(root).isSymbolicLink());
    }

    if (directoryRoots.size) {
      // `readdirSync` in JavaScript made every task recursively enumerate the complete
      // mounted system tree. Use GNU find's native directory traversal to keep this
      // fail-closed inventory fast enough for repeated evaluator launches. Do not follow
      // symlinked directories; inspect file symlinks (to catch compiler aliases) and
      // regular files whose names could identify a compiler, then retain the same
      // stat/realpath checks below.
      const findStat = fs.lstatSync(FIND);
      if (!findStat.isFile() || findStat.uid !== 0 || (findStat.mode & 0o022) !== 0
        || (findStat.mode & 0o111) === 0 || fs.realpathSync(FIND) !== FIND) {
        throw new Error("trusted compiler inventory tool is unavailable");
      }
      // Broad system roots can contain millions of entries. Traverse independent,
      // canonical roots concurrently, while keeping one fail-closed deadline and
      // retaining per-process output buffers so NUL-delimited paths cannot interleave.
      const inventory = path.join(path.dirname(fileURLToPath(import.meta.url)), "scan-compiler-exposure.mjs");
      const inventoryStat = fs.lstatSync(inventory);
      if (!inventoryStat.isFile() || inventoryStat.isSymbolicLink() || (inventoryStat.mode & 0o022) !== 0
        || fs.realpathSync(inventory) !== inventory) {
        throw new Error("trusted compiler inventory helper is unavailable");
      }
      const result = spawnSync(process.execPath, [inventory, ...[...directoryRoots].sort()], {
        encoding: null,
        // Keep the parent deadline outside the helper's own bounded scan deadline so
        // it can terminate and reap its find children before spawnSync is interrupted.
        timeout: 70_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { HOME: "/nonexistent", LANG: "C", PATH: "/usr/bin:/bin" },
      });
      if (result.error || result.status !== 0 || result.stderr?.length) {
        throw new Error("trusted compiler inventory could not complete");
      }
      for (const item of (result.stdout ?? Buffer.alloc(0)).toString("utf8").split("\0")) {
        if (item) inspectExecutable(item, fs.lstatSync(item).isSymbolicLink());
      }
    }
  } catch {
    return { paths: [], problem: "compiler exposure could not be checked; refusing qualification" };
  }

  return { paths: [...exposed].sort(), problem: null };
}

export function compilerExposureMaskArgs(scan) {
  if (scan.problem) throw new Error(scan.problem);
  const targets = [...new Set(scan.paths)];
  for (const target of targets) {
    let stat;
    try { stat = fs.lstatSync(target); }
    catch { throw new Error("compiler exposure target is unavailable; refusing qualification"); }
    if (!stat.isFile()) throw new Error("compiler exposure target is not a regular file; refusing qualification");
  }
  return targets.flatMap((target) => ["--ro-bind", "/dev/null", target]);
}

function executableVersion(command, argv) {
  const result = spawnSync(command, argv, {
    encoding: "utf8",
    timeout: 5000,
    env: { HOME: "/nonexistent", LANG: "C", PATH: "/usr/bin:/bin" },
  });
  return !result.error && result.status === 0 ? result.stdout.trim() : null;
}

export function oracleToolchainsProblem({ systemDirectories = SYSTEM_BINARIES, systemEtcDirectories = SYSTEM_ETC_DIRS, additionalMountedPaths = [] } = {}) {
  const exposureScan = scanOracleCompilerExposure(systemDirectories, systemEtcDirectories, additionalMountedPaths);
  if (exposureScan.problem) return exposureScan.problem;
  return pinnedOracleToolchainsProblem();
}

function pinnedOracleToolchainsProblem(sources = candidateToolchainRootSources()) {
  for (const { root, required } of PINNED_ORACLE_TOOLCHAINS) {
    const sourceRoot = sources[root];
    if (!sourceRoot) return "pinned oracle toolchains are unavailable; refusing execution";
    const problem = pinnedToolchainProblem(sourceRoot, required);
    if (problem) return problem;
  }
  const goRoot = sources["/usr/local/go"];
  const rustRoot = sources["/usr/local/nexus-qual/rust"];
  return oracleToolchainVersionProblem({
    goVersion: executableVersion(path.join(goRoot, "bin/go"), ["version"]),
    rustcVersion: executableVersion(path.join(rustRoot, "bin/rustc"), ["--version"]),
    cargoVersion: executableVersion(path.join(rustRoot, "bin/cargo"), ["--version"]),
  });
}

function pinnedToolchainProblem(root, required) {
  const ancestors = [];
  let parent = path.dirname(root);
  while (parent !== path.dirname(parent)) {
    ancestors.push(parent);
    parent = path.dirname(parent);
  }
  ancestors.push("/");
  const directories = [...ancestors.reverse(), root];
  const fingerprintPaths = ["/", ...directories, ...required.map((relative) => path.join(root, relative))];
  const now = Date.now();
  const cached = pinnedToolchainPreflights.get(root);
  if (cached && cached.expiresAt > now) {
    const current = oracleToolchainsFingerprint(cached.paths);
    if (current && JSON.stringify(current) === JSON.stringify(cached.fingerprint)) return null;
    pinnedToolchainPreflights.delete(root);
  }
  try {
    for (const directory of directories) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || oracleToolchainPathProblem(stat) || fs.realpathSync(directory) !== directory) {
        return "pinned oracle toolchain path is unavailable or replaceable";
      }
    }
    const verifyTree = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const item = path.join(directory, entry.name);
        const stat = fs.lstatSync(item);
        if ((!stat.isDirectory() && !stat.isFile()) || oracleToolchainPathProblem(stat)) return false;
        if (entry.isDirectory() && !verifyTree(item)) return false;
      }
      return true;
    };
    if (!verifyTree(root)) return "pinned oracle toolchain contents are not safely installed";
    for (const relative of required) {
      const executable = path.join(root, relative);
      const stat = fs.lstatSync(executable);
      if (!stat.isFile() || oracleToolchainPathProblem(stat) || (stat.mode & 0o111) === 0 || fs.realpathSync(executable) !== executable) {
        return "pinned oracle toolchain executable is unavailable or not safely installed";
      }
    }
  } catch {
    return "pinned oracle toolchains are unavailable; refusing execution";
  }
  const fingerprint = oracleToolchainsFingerprint(fingerprintPaths);
  if (!fingerprint) return "pinned oracle toolchain state could not be recorded";
  pinnedToolchainPreflights.set(root, { expiresAt: Date.now() + 30_000, fingerprint, paths: fingerprintPaths });
  return null;
}

function oracleToolchainsFingerprint(paths) {
  try {
    return paths.map((item) => {
      const stat = fs.lstatSync(item);
      return [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs];
    });
  } catch {
    return null;
  }
}

/** Return the host paths that the candidate sandbox mounts, grouped by the bind logic. */
export function candidateSandboxHostMountSources({ cwd, home, proxyDirectory, readOnlyPaths = [], nodeRuntime, supervisorPath } = {}) {
  if (!Array.isArray(readOnlyPaths)) throw new Error("candidate sandbox readOnlyPaths must be an array");
  const toolchainRoots = resolveHostToolchains();
  const existing = (paths, kind) => paths.filter((source) => {
    try {
      const stat = fs.statSync(source);
      return kind === "directory" ? stat.isDirectory() : stat.isFile();
    } catch { return false; }
  });
  const optional = (source, resolve = true) => source === undefined ? null : resolve ? fs.realpathSync(source) : source;
  return {
    systemDirectories: existing(SYSTEM_BINARIES, "directory"),
    systemFiles: existing(SYSTEM_ETC_FILES, "file"),
    systemEtcDirectories: existing(SYSTEM_ETC_DIRS, "directory"),
    toolchainRoots,
    toolchainDirectories: Object.values(toolchainRoots).filter(Boolean),
    runtimeSources: {
      cwd: optional(cwd),
      home: optional(home),
      proxyDirectory: optional(proxyDirectory),
      nodeRuntime: optional(nodeRuntime),
      supervisorPath: optional(supervisorPath),
      readOnlyPaths: readOnlyPaths.map((source) => fs.realpathSync(source)),
    },
  };
}

function pathOverlaps(left, right) {
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}

function pathVariants(source) {
  if (typeof source !== "string" || !path.isAbsolute(source)) return [];
  const lexical = path.resolve(source);
  let current = lexical;
  const suffix = [];
  while (true) {
    try {
      const canonical = path.resolve(fs.realpathSync(current), ...suffix);
      return [...new Set([lexical, canonical])];
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return [lexical];
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function candidateMountOverlapProblem(mountSources, protectedCorpusPaths) {
  return mountSourceOverlapProblem([
    ...mountSources.systemDirectories,
    ...mountSources.systemFiles,
    ...mountSources.systemEtcDirectories,
    ...mountSources.toolchainDirectories,
    ...Object.values(mountSources.runtimeSources).flatMap((value) => Array.isArray(value) ? value : value === null ? [] : [value]),
  ], protectedCorpusPaths);
}

function mountSourceOverlapProblem(sources, protectedCorpusPaths) {
  if (!Array.isArray(protectedCorpusPaths)) return "candidate sandbox protectedCorpusPaths must be an array";
  for (const protectedPath of protectedCorpusPaths) {
    const protectedVariants = pathVariants(protectedPath);
    if (!protectedVariants.length) return "candidate sandbox protected corpus paths must be absolute";
    for (const source of sources) {
      const sourceVariants = pathVariants(source);
      if (sourceVariants.some((left) => protectedVariants.some((right) => pathOverlaps(left, right)))) {
        return `candidate sandbox host mount overlaps protected corpus material: ${source}`;
      }
    }
  }
  return null;
}

export function sandboxAvailable() {
  if (sandboxPreflight !== undefined) return sandboxPreflight;
  try {
    if (!fs.statSync(BWRAP).isFile() || (fs.statSync(BWRAP).mode & 0o111) === 0) return (sandboxPreflight = false);
    const args = ["--unshare-user", "--unshare-pid", "--unshare-net", "--disable-userns", "--die-with-parent", "--proc", "/proc", "--dev", "/dev"];
    for (const source of SYSTEM_BINARIES) {
      try {
        if (fs.statSync(source).isDirectory()) {
          if (source === "/usr/local/lib") args.push("--dir", "/usr/local");
          args.push("--ro-bind", source, source);
        }
      } catch {}
    }
    args.push("--clearenv", "--", "/usr/bin/unshare", "-Ur", "true");
    const result = spawnSync(BWRAP, args, { encoding: "utf8", timeout: 5000, env: {} });
    // The sandbox itself must start, and nested user namespaces must be unavailable to the payload.
    return (sandboxPreflight = result.status === 1 && !result.error);
  } catch {
    return (sandboxPreflight = false);
  }
}

export function isolatedArgv({ cwd, home, command, timeoutSec = 300, readOnlySubpaths = [], hiddenSubpaths = [], protectedCorpusPaths = [] }) {
  const workspace = fs.realpathSync(cwd);
  const hiddenSources = hiddenSubpaths.map((relative) => confinedPath(workspace, relative));
  const readOnlySources = readOnlySubpaths.map((relative) => confinedPath(workspace, relative));
  const mountSources = candidateSandboxHostMountSources({ cwd: workspace, readOnlyPaths: [...readOnlySources, ...hiddenSources] });
  const protectedOverlap = candidateMountOverlapProblem(mountSources, protectedCorpusPaths);
  if (protectedOverlap) throw new Error(protectedOverlap);
  const compilerExposure = scanOracleCompilerExposure(mountSources.systemDirectories, mountSources.systemEtcDirectories, [], mountSources.toolchainDirectories);
  if (compilerExposure.problem) throw new Error(compilerExposure.problem);
  if (!sandboxAvailable()) throw new Error("Bubblewrap is unavailable; refusing to execute task-controlled commands");
  const hiddenGuestPaths = hiddenSources.map((source) => path.posix.join("/workspace", path.relative(workspace, source).split(path.sep).join("/")));
  let executionCommand = command;
  const args = [
    "--unshare-user", "--unshare-pid", "--unshare-net", "--disable-userns", "--die-with-parent",
    "--new-session", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
  ];
  let localPrefixCreated = false;
  for (const source of SYSTEM_BINARIES) {
    try {
      if (fs.statSync(source).isDirectory()) {
        if (source === "/usr/local/lib") {
          args.push("--dir", "/usr/local");
          localPrefixCreated = true;
        }
        args.push("--ro-bind", source, source);
      }
    } catch {}
  }
  const { goRoot, rustRoot } = mountSources.toolchainRoots;
  args.push(...toolchainMountArgs({ goRoot, rustRoot }, localPrefixCreated));
  for (const source of ["/etc/ld.so.cache", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/localtime"]) {
    try {
      if (fs.statSync(source).isFile()) args.push("--ro-bind", source, source);
    } catch {}
  }
  try { if (fs.statSync("/etc/alternatives").isDirectory()) args.push("--ro-bind", "/etc/alternatives", "/etc/alternatives"); } catch {}
  args.push(...compilerExposureMaskArgs(compilerExposure));
  args.push("--bind", workspace, "/workspace", "--dir", "/home", "--dir", "/run");
  if (hiddenSubpaths.length) {
    const helperDir = path.dirname(fileURLToPath(import.meta.url));
    args.push("--dir", "/runner", "--ro-bind", path.join(helperDir, "hide_oracle.cjs"), "/runner/hide_oracle.cjs");
    args.push("--ro-bind", path.join(helperDir, "hide_oracle.py"), "/runner/sitecustomize.py");
    args.push("--ro-bind", path.join(helperDir, "unlink_then_exec.sh"), "/runner/unlink_then_exec.sh");
  }
  // Workspace subpaths the command may read but not change (hardened hidden tests: the oracle's own files).
  for (const relative of hiddenSubpaths.length ? [] : readOnlySubpaths) {
    const source = confinedPath(workspace, relative);
    args.push("--ro-bind", source, path.posix.join("/workspace", path.relative(workspace, source).split(path.sep).join("/")));
  }
  args.push("--symlink", "usr/bin", "/bin");
  args.push("--chdir", "/workspace", "--clearenv", "--setenv", "PATH", "/usr/local/nexus-qual/rust/bin:/usr/local/go/bin:/usr/bin:/bin");
  args.push("--setenv", "HOME", home ? "/home/eval" : "/tmp");
  args.push("--setenv", "CI", "1", "--setenv", "LANG", "C.UTF-8");
  if (hiddenSubpaths.length) {
    args.push("--setenv", "NEXUS_HIDDEN_FILES", JSON.stringify(hiddenGuestPaths));
    args.push("--setenv", "NODE_OPTIONS", "--require /runner/hide_oracle.cjs");
    args.push("--setenv", "PYTHONPATH", "/runner");
    if (/\bgo\s+test\b/.test(command)) {
      executionCommand = command.replace(/\bgo\s+test\b/g, "go test -exec /runner/unlink_then_exec.sh");
    } else if (/\bcargo\s+test\b/.test(command)) {
      args.push("--setenv", "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER", "/runner/unlink_then_exec.sh");
      executionCommand = command;
    } else if (/^(python(?:\d+(?:\.\d+)?)?)\s+(\S+\.py)\s*$/.test(command.trim())) {
      const [, python, script] = command.trim().match(/^(python(?:\d+(?:\.\d+)?)?)\s+(\S+\.py)\s*$/);
      executionCommand = `${python} -c 'import runpy,sys; runpy.run_path(sys.argv[1], run_name="__main__")' ${shellQuote(script)}`;
    }
    executionCommand = executionCommand.replace(/\bPYTHONPATH=/g, "PYTHONPATH=/runner:");
    executionCommand = executionCommand.replace(/\bpytest\b/g, "pytest --assert=plain --noconftest");
    args.push("--setenv", "PYTHONDONTWRITEBYTECODE", "1");
  }
  if (home) args.push("--tmpfs", "/home/eval");
  args.push("--", "/usr/bin/bash", "-c", executionCommand);
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

export function agentSandboxArgv({ cwd, home, proxyDirectory, readOnlyPaths = [], allowedRuntimeRoots = [], runtimeExecutablePaths = [], supervisorPath, protectedCorpusPaths = [] }) {
  const mountSources = candidateSandboxHostMountSources({ cwd, home, proxyDirectory, readOnlyPaths, nodeRuntime: process.execPath, supervisorPath });
  const protectedOverlap = candidateMountOverlapProblem(mountSources, protectedCorpusPaths);
  if (protectedOverlap) throw new Error(protectedOverlap);
  const compilerExposure = scanOracleCompilerExposure(
    mountSources.systemDirectories,
    mountSources.systemEtcDirectories,
    mountSources.runtimeSources.readOnlyPaths,
    mountSources.toolchainDirectories,
  );
  if (compilerExposure.problem) throw new Error(compilerExposure.problem);
  if (!sandboxAvailable()) throw new Error("Bubblewrap is unavailable; refusing candidate execution");
  const mountProblem = runtimeMountProblem(readOnlyPaths, allowedRuntimeRoots, runtimeExecutablePaths);
  if (mountProblem) throw new Error(mountProblem);
  if (!mountSources.runtimeSources.cwd || !mountSources.runtimeSources.home || !mountSources.runtimeSources.proxyDirectory || !mountSources.runtimeSources.supervisorPath) {
    throw new Error("candidate sandbox cwd, home, proxyDirectory, and supervisorPath are required mount sources");
  }
  const nodeRuntime = mountSources.runtimeSources.nodeRuntime;
  if (!fs.statSync(nodeRuntime).isFile() || (fs.statSync(nodeRuntime).mode & 0o111) === 0) {
    throw new Error("trusted evaluator Node.js runtime is unavailable");
  }
  const workspace = mountSources.runtimeSources.cwd;
  const args = ["--unshare-user", "--unshare-pid", "--unshare-net", "--disable-userns", "--die-with-parent", "--new-session", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
  for (const source of mountSources.systemDirectories) {
    if (source === "/usr/local/lib") args.push("--dir", "/usr/local");
    args.push("--ro-bind", source, source);
  }
  args.push(...candidateToolchainMountArgs(mountSources.toolchainRoots, mountSources.systemDirectories));
  for (const source of mountSources.systemFiles) args.push("--ro-bind", source, source);
  for (const source of mountSources.systemEtcDirectories) args.push("--ro-bind", source, source);
  const isolatedHome = mountSources.runtimeSources.home;
  args.push("--symlink", "usr/bin", "/bin", "--bind", workspace, "/workspace", "--tmpfs", "/home", "--dir", "/home/eval", "--bind", isolatedHome, "/home/eval", "--tmpfs", "/run");
  args.push("--dir", "/run/eval-proxy", "--ro-bind", mountSources.runtimeSources.proxyDirectory, "/run/eval-proxy");
  const madeDirs = new Set(["/", "/usr", "/usr/bin", "/usr/lib", "/usr/lib64", "/usr/libexec", "/usr/share", "/usr/local", "/usr/local/lib", "/lib", "/lib64", "/bin", "/etc", "/workspace", "/home", "/run", "/run/eval-proxy"]);
  const addTargetParents = (target) => {
    const parts = target.split(path.sep).filter(Boolean);
    let current = "";
    for (const part of parts.slice(0, -1)) {
      current += `/${part}`;
      if (!madeDirs.has(current)) { args.push("--dir", current); madeDirs.add(current); }
    }
  };
  for (const resolved of mountSources.runtimeSources.readOnlyPaths) {
    if (SYSTEM_BINARIES.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) continue;
    if (fs.statSync(resolved).isDirectory()) assertNoSymlinks(resolved);
    addTargetParents(resolved);
    args.push("--ro-bind", resolved, resolved);
  }
  args.push(...compilerExposureMaskArgs(compilerExposure));
  addTargetParents("/runner/agent_sandbox.mjs");
  args.push("--ro-bind", nodeRuntime, "/runner/node");
  args.push("--ro-bind", mountSources.runtimeSources.supervisorPath, "/runner/agent_sandbox.mjs");
  args.push("--chdir", "/workspace", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/home/eval", "--setenv", "CI", "1", "--");
  args.push("/runner/node", "/runner/agent_sandbox.mjs");
  return { cmd: BWRAP, argv: args };
}

/** Run a fixed executable probe without exposing the host filesystem, environment, or network. */
export function isolatedProcessArgv({ cwd, command, argv = [], readOnlyPaths = [], allowedRoots = [], allowedFiles = [], timeoutMs = 5000, workspaceReadOnly = false, protectedCorpusPaths = [], oracleToolchains = false, systemDirectories = SYSTEM_BINARIES, systemEtcDirectories = SYSTEM_ETC_DIRS }) {
  if (!sandboxAvailable()) throw new Error("Bubblewrap is unavailable; refusing executable probe");
  let compilerExposure = null;
  let oracleToolchainSources = null;
  if (oracleToolchains) {
    const additionalMountedPaths = readOnlyPaths.map((item) => fs.realpathSync(item));
    oracleToolchainSources = candidateToolchainRootSources();
    compilerExposure = scanOracleCompilerExposure(systemDirectories, systemEtcDirectories, additionalMountedPaths, Object.values(oracleToolchainSources).filter(Boolean));
    if (compilerExposure.problem) throw new Error(compilerExposure.problem);
    const problem = pinnedOracleToolchainsProblem(oracleToolchainSources);
    if (problem) throw new Error(problem);
  }
  const mountProblem = runtimeMountProblem(readOnlyPaths, allowedRoots, allowedFiles);
  if (mountProblem) throw new Error(mountProblem);
  const workspace = fs.realpathSync(cwd);
  const args = ["--unshare-user", "--unshare-pid", "--unshare-net", "--disable-userns", "--die-with-parent", "--new-session", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
  for (const source of systemDirectories) {
    try {
      if (fs.statSync(source).isDirectory()) {
        if (source === "/usr/local/lib") args.push("--dir", "/usr/local");
        args.push("--ro-bind", source, source);
      }
    } catch {}
  }
  if (oracleToolchains) {
    for (const { root } of PINNED_ORACLE_TOOLCHAINS) {
      const parent = path.dirname(root);
      addOracleMountParent(args, parent);
      args.push("--ro-bind", oracleToolchainSources[root], root);
    }
  }
  for (const source of ["/etc/ld.so.cache", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/localtime"]) {
    try { if (fs.statSync(source).isFile()) args.push("--ro-bind", source, source); } catch {}
  }
  for (const source of systemEtcDirectories) {
    try { if (fs.statSync(source).isDirectory()) args.push("--ro-bind", source, source); } catch {}
  }
  args.push(workspaceReadOnly ? "--ro-bind" : "--bind", workspace, "/workspace", "--tmpfs", "/home", "--dir", "/home/eval", "--tmpfs", "/run", "--symlink", "usr/bin", "/bin");
  const madeDirs = new Set(["/", "/usr", "/usr/bin", "/usr/lib", "/usr/lib64", "/usr/libexec", "/usr/share", "/usr/local", "/usr/local/lib", "/lib", "/lib64", "/bin", "/etc", "/workspace", "/home", "/home/eval", "/run"]);
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
  if (compilerExposure) args.push(...compilerExposureMaskArgs(compilerExposure));
  const resolvedCommand = fs.realpathSync(command);
  if (!SYSTEM_BINARIES.some((root) => resolvedCommand === root || resolvedCommand.startsWith(`${root}${path.sep}`)) && !readOnlyPaths.some((item) => fs.realpathSync(item) === resolvedCommand)) {
    throw new Error("isolated executable must be included in the explicit read-only runtime paths");
  }
  const bindSources = args.flatMap((arg, i) => (arg === "--bind" || arg === "--ro-bind") ? [args[i + 1]] : []);
  const protectedOverlap = mountSourceOverlapProblem(bindSources, protectedCorpusPaths);
  if (protectedOverlap) throw new Error(protectedOverlap);
  args.push("--chdir", "/workspace", "--clearenv", "--setenv", "PATH", oracleToolchains ? "/usr/local/go/bin:/usr/local/nexus-qual/rust/bin:/usr/bin:/bin" : "/usr/bin:/bin", "--setenv", "HOME", "/home/eval", "--setenv", "LANG", "C.UTF-8");
  if (oracleToolchains) {
    args.push("--setenv", "GOROOT", "/usr/local/go", "--setenv", "GOTOOLCHAIN", "local", "--setenv", "GOPROXY", "off", "--setenv", "GOCACHE", "/tmp/go-cache", "--setenv", "GOMODCACHE", "/tmp/go-mod-cache", "--setenv", "GOPATH", "/tmp/go-path", "--setenv", "CARGO_HOME", "/tmp/cargo-home", "--setenv", "CARGO_TARGET_DIR", "/tmp/cargo-target", "--setenv", "CARGO_NET_OFFLINE", "true", "--setenv", "TMPDIR", "/tmp");
  }
  args.push("--");
  args.push(resolvedCommand, ...argv);
  return { cmd: BWRAP, argv: args, timeoutMs };
}

function addOracleMountParent(args, parent) {
  const parts = parent.split(path.sep).filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    if (!args.some((value, index) => value === "--dir" && args[index + 1] === current)) args.push("--dir", current);
  }
}

export function runIsolatedProcess(spec, { outputLimit = 16_384, input = "", resources = null } = {}) {
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) throw new Error("isolated process spec has no timeoutMs");
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

/** Build ACL arguments for the evaluator and operator on one disposable path. */
export function runAsAclArgs(user, operatorUid, resolved, directory) {
  return {
    access: ["-R", "-m", `u:${user}:rwX,u:${operatorUid}:rwX`, resolved],
    defaults: directory ? ["-m", `d:u:${user}:rwx,d:u:${operatorUid}:rwx,d:m::rwx`, resolved] : null,
  };
}

/** Grant the evaluator and harness operator access to disposable paths; never make them world-writable. */
export function grantRunAsAccess(user, targets) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error("invalid evaluator account");
  const setfacl = "/usr/bin/setfacl";
  const opUid = process.getuid();
  if (!fs.existsSync(setfacl)) throw new Error("setfacl is unavailable; refusing unsafe workspace permission changes");
  for (const target of targets) {
    const resolved = fs.realpathSync(target);
    const { access, defaults } = runAsAclArgs(user, opUid, resolved, fs.statSync(resolved).isDirectory());
    const result = spawnSync(setfacl, access, { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin" } });
    if (result.status !== 0) throw new Error(`could not grant scoped evaluator access to disposable path (${result.status ?? "signal"})`);
    if (defaults) {
      const defaultResult = spawnSync(setfacl, defaults, { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin" } });
      if (defaultResult.status !== 0) throw new Error(`could not set scoped evaluator default ACL (${defaultResult.status ?? "signal"})`);
    }
  }
}

/** Make evaluator-owned workspace files readable to the operator through the scoped ACL mask. */
export async function normalizeRunAsPermissions(user, dir, wrapSpec) {
  const spec = isolatedProcessArgv({ cwd: dir, command: "/usr/bin/chmod", argv: ["-R", "u+rwX,g+rwX,o-rwx", "/workspace"], timeoutMs: 60_000 });
  const result = await runIsolatedProcess(wrapSpec(user, spec), { outputLimit: 1_000_000 });
  if (result.timedOut || result.error) throw new Error(`could not normalise evaluator file permissions (${result.error ?? "timeout"})`);
  return result;
}

export function stageHiddenFiles(source, ws, relativeTarget, { readOnlyHidden = false } = {}) {
  assertNoSymlinks(source);
  const relFiles = [];
  const walk = (dir, prefix = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) relFiles.push(rel);
    }
  };
  walk(source);
  const readOnlySubpaths = [];
  for (const relFile of relFiles) {
    const relTargetFile = (!relativeTarget || relativeTarget === ".") ? relFile : path.posix.join(relativeTarget, relFile);
    const segments = relTargetFile.split("/");
    if (path.posix.isAbsolute(relTargetFile) || segments.some((segment) => !segment || segment === "..")) {
      throw new Error(`invalid hidden test target path: ${relTargetFile}`);
    }
    let cur = fs.realpathSync(ws);
    const dirParts = path.posix.dirname(relTargetFile).split("/").filter((part) => part && part !== ".");
    for (const part of dirParts) {
      cur = path.join(cur, part);
      const st = fs.lstatSync(cur, { throwIfNoEntry: false });
      if (st) {
        if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`unsafe hidden test parent directory: ${relTargetFile}`);
      } else {
        fs.mkdirSync(cur);
      }
    }
    const leafPath = path.join(cur, path.posix.basename(relTargetFile));
    const leafStat = fs.lstatSync(leafPath, { throwIfNoEntry: false });
    if (leafStat?.isSymbolicLink() && !readOnlyHidden) throw new Error(`unsafe hidden test destination: ${relTargetFile}`);
    if (leafStat && readOnlyHidden) fs.rmSync(leafPath, { recursive: true, force: true });
    const destFile = confinedPath(ws, relTargetFile, { allowMissingLeaf: true });
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.cpSync(path.join(source, relFile), destFile, { verbatimSymlinks: true });
    if (readOnlyHidden) readOnlySubpaths.push(relTargetFile);
  }
  return readOnlySubpaths;
}

export function hiddenOutputHasTests(output) {
  if (typeof output !== "string" || !output.trim()) return false;
  const hasGoOk = /^ok\s+\S+/m.test(output);
  const hasPassedCount = /\b[1-9]\d*\s+passed\b/i.test(output);
  const hasPyUnittestOk = /^Ran\s+[1-9]\d*\s+tests?\b[\s\S]*?\bOK\b/m.test(output);
  const hasNodeTestPass = /(?:ℹ|✔|#)\s*pass\s+[1-9]\d*|^ok\s+[1-9]\d*\s+-/m.test(output);
  const hasValidatorSummary = /\b(?:all|hidden)\b[^\n]*\b(?:passed|ok|identical)\b/i.test(output);
  return hasGoOk || hasPassedCount || hasPyUnittestOk || hasNodeTestPass || hasValidatorSummary;
}

/** Execute a task-controlled shell command in a no-network, clear-environment namespace. */
export async function runIsolated(command, options = {}) {
  const { cwd, hiddenSubpaths = [] } = options;
  if (hiddenSubpaths.length && /\b(?:go|cargo)\s+test\b/.test(command)) {
    const workspace = fs.realpathSync(cwd);
    const saved = new Map();
    const restore = () => {
      for (const [relative, contents] of saved) {
        const parts = relative.split(/[\\/]/);
        if (path.isAbsolute(relative) || parts.some((part) => !part || part === "." || part === "..")) throw new Error(`unsafe hidden source path during restore: ${relative}`);
        let parent = workspace;
        for (const part of parts.slice(0, -1)) {
          parent = path.join(parent, part);
          const stat = fs.lstatSync(parent, { throwIfNoEntry: false });
          if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) throw new Error(`unsafe hidden source parent during restore: ${relative}`);
          if (!stat) fs.mkdirSync(parent);
        }
        const destination = confinedPath(workspace, relative, { allowMissingLeaf: true });
        const leafStat = fs.lstatSync(destination, { throwIfNoEntry: false });
        if (leafStat?.isSymbolicLink() || (leafStat && !leafStat.isFile())) throw new Error(`unsafe hidden source destination during restore: ${relative}`);
        fs.writeFileSync(destination, contents);
      }
    };
    try {
      for (const relative of hiddenSubpaths) {
        const source = confinedPath(workspace, relative);
        saved.set(relative, fs.readFileSync(source));
        fs.unlinkSync(source);
      }
      const rust = /\bcargo\s+test\b/.test(command);
      if (rust) {
        const pending = [workspace];
        while (pending.length) {
          const dir = pending.pop();
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            if (ent.isSymbolicLink() || ent.name === ".git") continue;
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) pending.push(full);
            else if (ent.name === "build.rs") throw new Error("Rust hidden checks refuse build.rs while hiding oracle sources");
            else if (ent.name === "Cargo.toml" && /\bproc-macro\s*=\s*true\b/.test(fs.readFileSync(full, "utf8"))) throw new Error("Rust hidden checks refuse proc-macro crates while hiding oracle sources");
          }
        }
      }
      const subcommands = command.split(/\s*&&\s*/);
      for (const subcommand of subcommands) {
        const isGo = /\bgo\s+test\b/.test(subcommand);
        const isCargo = /\bcargo\s+test\b/.test(subcommand);
        if (!isGo && !isCargo) continue;
        const preflight = isGo ? "go build ./..." : cargoPreflight(subcommand);
        const preflightResult = await runIsolatedRaw(preflight, { ...options, hiddenSubpaths: [] });
        if (preflightResult.status !== 0) return preflightResult;
      }
      let result = { status: 0, stdout: "", stderr: "", timedOut: false, overflow: false };
      for (const subcommand of subcommands) {
        restore();
        result = await runIsolatedRaw(subcommand, { ...options, hiddenSubpaths });
        if (result.status !== 0) return result;
      }
      return result;
    } finally {
      restore();
    }
  }
  return runIsolatedRaw(command, options);
}

function cargoPreflight(command) {
  const flags = [];
  const matches = command.matchAll(/--(?:features\s+(?:"[^"]*"|'[^']*'|\S+)|all-features|no-default-features|offline)\b/g);
  for (const match of matches) flags.push(match[0]);
  return `cargo check --lib --bins ${flags.join(" ")}`.trim();
}

function runIsolatedRaw(command, { cwd, home = false, timeoutSec = 300, outputLimit = 1_000_000, resources = null, readOnlySubpaths = [], hiddenSubpaths = [], protectedCorpusPaths = [] } = {}) {
  const spec = isolatedArgv({ cwd, home, command, timeoutSec, readOnlySubpaths, hiddenSubpaths, protectedCorpusPaths });
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
