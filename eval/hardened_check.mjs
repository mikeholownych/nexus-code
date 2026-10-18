// Hardened legacy hidden tests (owner decision 2026-10-18; eval/README.md "Hardened legacy hidden tests"). Legacy hidden
// tests run candidate code in the same process as the oracle, so the agent's workspace is never tested directly: the
// task is staged again (same pin or fixture, same setup) and only the agent's source changes are copied in.
//
// The agent's workspace is untrusted data. Nothing here runs git (or any program) against it: an agent-written
// .git/config or .gitattributes could otherwise run commands as the harness user. Changes are found by walking both
// trees and comparing bytes and modes; only an allowlist of source files crosses over.
import fs from "node:fs";
import path from "node:path";

/** Directories never carried across: VCS metadata, dependency trees, build outputs and caches. */
const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "site-packages", "__pycache__", ".tox", ".nox",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", "vendor", "target", ".yarn", ".pnpm-store", ".cargo", ".github",
]);

/** Paths whose content steers test discovery, tool behaviour or module resolution: never carried across. */
const BLOCKED = [
  // tests and test configuration
  /(^|\/)tests?\//, /(^|\/)__tests__\//, /(^|\/)spec\//, /(^|\/)test_[^/]*\.py$/, /_test\.py$/, /_test\.go$/, /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)conftest\.py$/, /(^|\/)(pytest|tox)\.ini$/, /(^|\/)setup\.(cfg|py)$/, /(^|\/)noxfile\.py$/, /(^|\/)\.coveragerc$/,
  /(^|\/)(jest|vitest|vite|karma|ava|playwright|babel|webpack|rollup|esbuild)\.config\.[^/]+$/, /(^|\/)\.mocharc(\.[^/]+)?$/,
  /(^|\/)\.nycrc(\.[^/]+)?$/, /(^|\/)\.babelrc(\.[^/]+)?$/, /(^|\/)tsconfig[^/]*\.json$/, /(^|\/)jsconfig[^/]*\.json$/,
  // interpreter and package-manager hooks
  /(^|\/)(sitecustomize|usercustomize)\.py$/, /\.pth$/, /(^|\/)\.npmrc$/, /(^|\/)\.yarnrc[^/]*$/, /(^|\/)\.pnpmfile\.c?js$/,
  /(^|\/)\.pnp\.[^/]+$/, /(^|\/)bunfig\.toml$/, /(^|\/)go\.work(\.sum)?$/, /(^|\/)rust-toolchain[^/]*$/, /(^|\/)build\.rs$/,
  /(^|\/)\.cargo\//, /(^|\/)Makefile$/, /(^|\/)\.env[^/]*$/, /(^|\/)\.gitattributes$/, /(^|\/)\.gitignore$/, /(^|\/)\.gitmodules$/,
  /(^|\/)\.python-version$/, /(^|\/)\.node-version$/, /(^|\/)\.nvmrc$/, /(^|\/)\.tool-versions$/,
];

/** New files with these extensions may cross over (T2 languages: JS/TS, Python, Rust, Go). */
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".py", ".pyi", ".go", ".rs"]);

/**
 * Python module names a new .py file (or a directory holding one) may not take: on sys.path the workspace root comes
 * before the standard library and the test runner. JS bare imports resolve through node_modules and Go/Rust do not
 * resolve modules by file name, so the rule is Python-only.
 */
const SHADOWED = new Set([
  "pytest", "_pytest", "pluggy", "py", "unittest", "doctest", "sitecustomize", "usercustomize", "conftest", "site",
  "os", "sys", "io", "re", "json", "typing", "types", "collections", "functools", "itertools", "importlib", "inspect",
  "builtins", "abc", "asyncio", "subprocess", "pathlib", "random", "time", "math", "string", "copy", "warnings",
  "logging", "contextlib", "dataclasses", "enum", "tempfile", "shutil", "signal", "threading", "traceback", "mock",
]);

export function isTestInfraPath(relative) {
  if (relative.split("/").some((part) => SKIP_DIRS.has(part))) return true;
  return BLOCKED.some((pattern) => pattern.test(relative));
}

function shadows(relative) {
  if (!/\.pyi?$/.test(relative)) return false;
  return relative.split("/").some((part) => SHADOWED.has(part.replace(/\.pyi?$/, "")));
}

function sections(text, header = /^\[([^\]]+)\]\s*$/) {
  const result = new Map();
  let current = "";
  for (const line of (text ?? "").split("\n")) {
    const match = header.exec(line.trim());
    if (match) current = match[1].trim();
    result.set(current, `${result.get(current) ?? ""}${line}\n`);
  }
  return result;
}

/**
 * Dependency manifests: a change is kept only where it is a plain dependency or package-metadata change; anything
 * else (test-runner configuration, build hooks, path or source redirects) refuses the checks.
 */
export function testConfigChange(relative, before, after) {
  const base = path.basename(relative);
  if (base === "package.json") {
    const parse = (text) => { try { return JSON.parse(text ?? "{}"); } catch { return null; } };
    const a = parse(before) ?? {};
    const b = parse(after);
    if (!b) return "package.json no longer parses";
    const allowed = new Set(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "version", "description", "keywords", "author", "license"]);
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!allowed.has(key) && JSON.stringify(a[key]) !== JSON.stringify(b[key])) return `package.json "${key}" changed`;
    }
    for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const spec of Object.values(b[key] ?? {})) if (/^(file|link|portal|workspace|git|github|https?):|^\.{0,2}\//.test(String(spec))) return `package.json ${key} points at a local or remote source`;
    }
    return null;
  }
  if (base === "pyproject.toml") {
    const a = sections(before), b = sections(after);
    for (const name of new Set([...a.keys(), ...b.keys()])) {
      if (a.get(name) === b.get(name)) continue;
      if (name !== "project" && name !== "project.optional-dependencies") return `pyproject.toml [${name || "top level"}] changed`;
    }
    return null;
  }
  if (base === "Cargo.toml") {
    const a = sections(before), b = sections(after);
    for (const name of new Set([...a.keys(), ...b.keys()])) {
      if (a.get(name) === b.get(name)) continue;
      if (!["package", "features", "dependencies"].includes(name) && !/^dependencies\.[\w-]+$/.test(name)) return `Cargo.toml [${name || "top level"}] changed`;
      if (/\bpath\s*=|\bgit\s*=/.test(b.get(name) ?? "")) return `Cargo.toml [${name}] points at a local or git source`;
    }
    return null;
  }
  if (base === "go.mod") {
    const directives = (text) => (text ?? "").split("\n").filter((line) => /^\s*(replace|exclude|retract|toolchain|godebug)\b/.test(line)).join("\n");
    return directives(before) === directives(after) ? null : "go.mod replace/exclude/toolchain directives changed";
  }
  return null;
}

/** Regular files under `root` (relative "/" paths → absolute), skipping SKIP_DIRS; symlinks are reported separately. */
function walk(root) {
  const files = new Map();
  const links = [];
  const visit = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) visit(path.join(dir, entry.name), relative); }
      else if (entry.isFile()) files.set(relative, path.join(dir, entry.name));
      else links.push(relative);
    }
  };
  visit(root, "");
  return { files, links };
}

const same = (a, b) => {
  const sa = fs.statSync(a), sb = fs.statSync(b);
  return sa.size === sb.size && (sa.mode & 0o111) === (sb.mode & 0o111) && fs.readFileSync(a).equals(fs.readFileSync(b));
};

/**
 * Copies the agent's source changes from `agentWs` into `freshWs`, a fresh staging of the same baseline (setup
 * included). Modified and deleted baseline files cross over unless blocked; new files cross over only with a source
 * extension and no shadowing name. Returns what was applied and discarded, and any manifest change that refuses checks.
 */
export function applyAgentChanges(agentWs, freshWs) {
  const agent = walk(agentWs);
  const fresh = walk(freshWs);
  const applied = [];
  const discarded = [...agent.links];
  const configChanges = [];
  for (const [relative, source] of agent.files) {
    const target = fresh.files.get(relative);
    if (target && same(source, target)) continue;
    if (isTestInfraPath(relative)) { discarded.push(relative); continue; }
    if (!target && (!SOURCE_EXTENSIONS.has(path.extname(relative)) || shadows(relative))) { discarded.push(relative); continue; }
    const destination = path.join(freshWs, relative);
    const reason = testConfigChange(relative, target ? fs.readFileSync(target, "utf8") : null, fs.readFileSync(source, "utf8"));
    if (reason) configChanges.push(reason);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, fs.readFileSync(source));
    fs.chmodSync(destination, fs.statSync(source).mode & 0o755);
    applied.push(relative);
  }
  for (const [relative, target] of fresh.files) {
    if (agent.files.has(relative) || agent.links.includes(relative)) continue;
    if (isTestInfraPath(relative)) { discarded.push(relative); continue; }
    fs.rmSync(target, { force: true });
    applied.push(relative);
  }
  return { applied, discarded: discarded.sort(), configChanges };
}

/** A byte-identical copy of a prepared workspace (tmpfs-local, so cheap), for a second, independent check. */
export function cloneWorkspace(source, destination) {
  fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
}
