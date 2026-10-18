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
  // tests, test data and test configuration
  /(^|\/)(testdata|fixtures?|__snapshots__|snapshots?|golden|__mocks__|mocks?|e2e|testing|testutils?|test_?utils?|test_helpers?|testhelpers?|testenv|testlib)\//,
  /(^|\/)_?testing\.py$/, /(^|\/)(test[-_]?(setup|helpers?|utils?|env|lib|fixtures?)|setup[-_]tests?)\.[^/]+$/,
  /(^|\/)(karma\.conf|jest[-.]preset|vitest\.workspace|global[-_]?setup|global[-_]?teardown)[^/]*$/i,
  /\.(golden|snap)$/, /(^|\/)setupTests\.[^/]+$/, /\.setup\.[cm]?[jt]sx?$/,
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

/** Only files with these extensions may be added, changed or deleted (T2 languages: JS/TS, Python, Rust, Go)... */
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".py", ".pyi", ".go", ".rs"]);
/** ...plus these manifests, whose changes testConfigChange checks section by section (deleting one refuses the checks). */
const MANIFESTS = new Set(["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "go.sum"]);
/** Files larger than this are never carried (an agent-made multi-GiB file must not exhaust the harness). */
const MAX_CARRIED_BYTES = 2 * 1024 * 1024;

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

/**
 * TOML split into sections keyed by the exact header line. Every line whose first non-blank character is "[" starts a
 * section, whatever follows ("[[test]]", "[a] # comment", a bracket line inside a multi-line string): a header this
 * reader does not recognise can never be folded into an allowed section; at worst it fails closed.
 */
function tomlSections(text) {
  const result = new Map();
  let current = "";
  for (const line of (text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) current = trimmed;
    result.set(current, `${result.get(current) ?? ""}${line}\n`);
  }
  return result;
}

/** The first changed TOML section whose exact header is not allowed, or null. */
function changedTomlSection(before, after, allowed) {
  const a = tomlSections(before), b = tomlSections(after);
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(key) !== b.get(key) && !allowed(key)) return key || "top level";
  }
  return null;
}

/**
 * Dependency manifests: a change is kept only where it is a plain dependency or package-metadata change; anything
 * else (test-runner configuration, build hooks, path or source redirects) refuses the checks.
 */
export function testConfigChange(relative, before, after) {
  const base = path.basename(relative);
  if (relative.endsWith(".rs") || relative.endsWith(".go")) {
    const existing = new Set((before ?? "").split("\n"));
    const added = (after ?? "").split("\n").filter((line) => !existing.has(line));
    if (relative.endsWith(".rs") && added.some((line) => /\binclude_(?:str|bytes)!\s*\(|\binclude!\s*\(|#\s*\[\s*path\s*=/.test(line))) {
      return `${relative} adds compile-time file inclusion`;
    }
    if (relative.endsWith(".go") && added.some((line) => /^\s*\/\/go:embed\b/.test(line))) {
      return `${relative} adds //go:embed directive`;
    }
  }
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
    const key = changedTomlSection(before, after, (k) => k === "[project]" || k === "[project.optional-dependencies]");
    return key ? `pyproject.toml ${key} changed` : null;
  }
  if (base === "Cargo.toml") {
    // [package] and [features] can switch test discovery off (autotests, build, a changed default feature set); [[test]],
    // [lib], [profile.*] and [patch] can drop or redirect targets. Only dependency tables may change.
    const key = changedTomlSection(before, after, (k) => k === "[dependencies]" || /^\[dependencies\.[A-Za-z0-9_-]+\]$/.test(k));
    if (key) return `Cargo.toml ${key} changed`;
    // Only lines the agent added are scanned, so a baseline path dependency does not refuse unrelated edits.
    const kept = new Set((before ?? "").split("\n"));
    const added = (after ?? "").split("\n").filter((line) => !kept.has(line)).join("\n");
    return /\b(path|git|registry)\s*=/.test(added) ? "Cargo.toml dependencies point at a local, git or alternate-registry source" : null;
  }
  if (base === "go.mod") {
    // Everything but the require lines and blocks must stay byte-identical (replace/exclude entries inside blocks too).
    const rest = (text) => (text ?? "").replace(/^\s*require\s*\([\s\S]*?^\s*\)\s*$/gm, "").replace(/^\s*require\s+\S.*$/gm, "").split("\n").map((l) => l.trimEnd()).filter(Boolean).join("\n");
    return rest(before) === rest(after) ? null : "go.mod changed outside its require directives";
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

/** True when `relative` can be written under `root` without following a symlink at any existing component. */
function safeDestination(root, relative) {
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch { return true; } // the rest does not exist yet
    if (stat.isSymbolicLink()) return false;
  }
  return true;
}

const carriable = (relative) => SOURCE_EXTENSIONS.has(path.extname(relative)) || MANIFESTS.has(path.basename(relative));

/**
 * Copies the agent's source changes from `agentWs` into `freshWs`, a fresh staging of the same baseline (setup
 * included). Only source files and the checked manifests may be added, changed or deleted; blocked paths, other file
 * types, Python files that would shadow modules or sit outside existing package directories, oversized files and any
 * path through a symlink are discarded. A manifest change outside dependencies, or a deleted manifest, refuses checks.
 */
export function applyAgentChanges(agentWs, freshWs) {
  const agent = walk(agentWs);
  const fresh = walk(freshWs);
  const freshLinks = new Set(fresh.links);
  const applied = [];
  const discarded = [...agent.links];
  const configChanges = [];
  const allowed = (relative) => !isTestInfraPath(relative) && carriable(relative) && !freshLinks.has(relative) && safeDestination(freshWs, relative);
  for (const [relative, source] of agent.files) {
    const target = fresh.files.get(relative);
    if (target && same(source, target)) continue;
    if (!allowed(relative) || fs.statSync(source).size > MAX_CARRIED_BYTES) { discarded.push(relative); continue; }
    if (!target && MANIFESTS.has(path.basename(relative))) { configChanges.push(`${relative} added`); continue; } // a new manifest moves module or root boundaries
    if (!target && /\.pyi?$/.test(relative)) {
      // A new Python file may join an existing regular package (one with __init__.py in the baseline), never create a
      // top-level module or package, nor land beside a src/ layout's importable root.
      const dir = path.posix.dirname(relative);
      if (dir === "." || shadows(relative) || !fs.existsSync(path.join(freshWs, dir, "__init__.py"))) { discarded.push(relative); continue; }
    }
    const destination = path.join(freshWs, relative);
    const reason = testConfigChange(relative, target ? fs.readFileSync(target, "utf8") : null, fs.readFileSync(source, "utf8"));
    if (reason) configChanges.push(reason);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (!safeDestination(freshWs, relative)) { discarded.push(relative); continue; } // re-check after mkdir
    fs.writeFileSync(destination, fs.readFileSync(source));
    fs.chmodSync(destination, fs.statSync(source).mode & 0o755);
    applied.push(relative);
  }
  for (const [relative, target] of fresh.files) {
    if (agent.files.has(relative) || agent.links.includes(relative)) continue;
    if (MANIFESTS.has(path.basename(relative)) && !isTestInfraPath(relative)) { configChanges.push(`${relative} deleted`); continue; }
    if (!allowed(relative)) { discarded.push(relative); continue; }
    fs.rmSync(target, { force: true });
    applied.push(relative);
  }
  return { applied, discarded: discarded.sort(), configChanges };
}

/** A byte-identical copy of a prepared workspace (tmpfs-local, so cheap), for a second, independent check. */
export function cloneWorkspace(source, destination) {
  fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
}
