// Hardened legacy hidden tests (owner decision 2026-10-18; eval/README.md "Hardened checks"). Legacy hidden tests run
// candidate code in the same process as the oracle, so the agent's workspace is never tested directly: a fresh copy of
// the staged baseline receives only the agent's source changes, with test infrastructure discarded, and the hidden and
// regression commands run in separate copies of that, the hidden directory mounted read-only.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Paths whose content steers test discovery or execution: the agent's changes to them are discarded. */
const TEST_INFRA = [
  /(^|\/)conftest\.py$/, /(^|\/)(pytest|tox)\.ini$/, /(^|\/)setup\.cfg$/, /(^|\/)noxfile\.py$/,
  /(^|\/)(sitecustomize|usercustomize)\.py$/, /\.pth$/,
  /(^|\/)tests?\//, /(^|\/)__tests__\//, /(^|\/)spec\//,
  /(^|\/)test_[^/]*\.py$/, /_test\.py$/, /_test\.go$/, /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)(jest|vitest|vite|karma|ava|playwright)\.config\.[^/]+$/, /(^|\/)\.mocharc(\.[^/]+)?$/, /(^|\/)\.nycrc(\.[^/]+)?$/,
  /(^|\/)babel\.config\.[^/]+$/, /(^|\/)\.babelrc(\.[^/]+)?$/,
  /(^|\/)build\.rs$/, /(^|\/)\.cargo\//, /(^|\/)\.github\//, /(^|\/)Makefile$/, /(^|\/)\.env[^/]*$/,
];

export function isTestInfraPath(relative) {
  return TEST_INFRA.some((pattern) => pattern.test(relative));
}

/** Manifests that also carry dependencies: a change is kept unless it touches their test-runner configuration. */
export function testConfigChange(relative, before, after) {
  const base = path.basename(relative);
  if (base === "package.json") {
    const parse = (text) => { try { return JSON.parse(text ?? "{}"); } catch { return null; } };
    const a = parse(before), b = parse(after);
    if (!b) return "package.json no longer parses";
    const keys = ["jest", "mocha", "ava", "vitest", "c8", "nyc", "babel"];
    for (const key of keys) if (JSON.stringify(a?.[key]) !== JSON.stringify(b[key])) return `package.json "${key}" changed`;
    for (const [name, value] of Object.entries({ ...(a?.scripts ?? {}), ...(b.scripts ?? {}) })) {
      if (/test|pretest|posttest|prepare|preinstall|postinstall|install/.test(name) && a?.scripts?.[name] !== b.scripts?.[name]) return `package.json script "${name}" changed`;
      void value;
    }
    return null;
  }
  if (base === "pyproject.toml") {
    const sections = (text) => (text ?? "").split(/^(?=\[)/m).filter((s) => /^\[tool\.(pytest|coverage|tox|hatch\.envs)/.test(s)).join("");
    return sections(before) === sections(after) ? null : "pyproject.toml test-runner sections changed";
  }
  if (base === "Cargo.toml") {
    const sections = (text) => (text ?? "").split(/^(?=\[)/m).filter((s) => /^\[(\[test\]|\[bench\]|profile\.test|build-dependencies|dev-dependencies|lib\])/.test(s) || /^build\s*=/m.test(s)).join("");
    return sections(before) === sections(after) ? null : "Cargo.toml test, build or dev sections changed";
  }
  return null;
}

function git(ws, argv) {
  const result = spawnSync("git", ["-c", "core.quotePath=false", ...argv], {
    cwd: ws, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "none" },
  });
  if (result.status !== 0) throw new Error(`git ${argv[0]} failed (${result.status ?? "signal"}): ${(result.stderr || "").slice(-1000)}`);
  return result.stdout;
}

/** The agent's changes against the staged baseline commit: [{ path, status: "A"|"M"|"D"|"T" }]. */
export function agentChanges(ws, baseline) {
  git(ws, ["add", "-A"]);
  const out = git(ws, ["diff", "--cached", "--no-renames", "--name-status", "-z", baseline]);
  const fields = out.split("\0").filter(Boolean);
  const changes = [];
  for (let i = 0; i < fields.length; i += 2) changes.push({ status: fields[i][0], path: fields[i + 1] });
  return changes;
}

/**
 * Copies the agent's non-test-infrastructure changes from `agentWs` into `freshWs` (a fresh staging of the same
 * baseline). Returns what was applied, what was discarded, and any test-configuration change that fails the checks.
 */
export function applyAgentChanges(agentWs, freshWs, baseline) {
  const applied = [];
  const discarded = [];
  const configChanges = [];
  for (const change of agentChanges(agentWs, baseline)) {
    const relative = change.path;
    if (relative.split("/").some((part) => part === ".." || part === ".git") || path.isAbsolute(relative)) { discarded.push(relative); continue; }
    if (isTestInfraPath(relative)) { discarded.push(relative); continue; }
    const target = path.join(freshWs, relative);
    if (change.status === "D") {
      fs.rmSync(target, { force: true });
      applied.push(relative);
      continue;
    }
    const source = path.join(agentWs, relative);
    const stat = fs.lstatSync(source);
    if (!stat.isFile()) { discarded.push(relative); continue; } // symlinks and special files are never carried over
    const before = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
    const after = fs.readFileSync(source);
    const reason = testConfigChange(relative, before, after.toString("utf8"));
    if (reason) configChanges.push(reason);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, after);
    fs.chmodSync(target, stat.mode & 0o755);
    applied.push(relative);
  }
  return { applied, discarded, configChanges };
}

/** A byte-identical copy of a prepared workspace (tmpfs-local, so cheap), for a second, independent check. */
export function cloneWorkspace(source, destination) {
  fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
}
