import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { extractCompilerDiagnostics, Diagnostic } from "./diagnostics.js";

export interface TestRunResult {
  command: string;
  success: boolean;
  /** The verifier hit its deadline (runner `timed_out`, or the bridge got no answer). Never combined with success. */
  timedOut?: boolean;
  rawOutput: string;
  failures: string[];
  diagnostics: Diagnostic[];
}

export type TestCommandExecutor = (command: string) => Promise<{ success: boolean; output: string; error?: string; timedOut?: boolean }>;

export const DEFAULT_VERIFIER_TIMEOUT_SECS = 300;

export function verifierTimeoutSecs(configured?: number): number {
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  const envVal = Number(process.env.NEXUS_VERIFIER_TIMEOUT_SECS);
  if (Number.isFinite(envVal) && envVal > 0) {
    return Math.floor(envVal);
  }
  return DEFAULT_VERIFIER_TIMEOUT_SECS;
}

function validateFilterPattern(filterPattern?: string): string | undefined {
  if (!filterPattern) return undefined;
  // The filter is interpolated into a shell command: letters, digits and `_ : . / -` with single spaces only (no
  // newline, quote or shell metacharacter), and it may not start with `-` (it would become a runner flag).
  const trimmed = filterPattern.trim();
  if (!trimmed) return undefined;
  if (!/^[A-Za-z0-9_:./ -]+$/.test(trimmed) || trimmed.startsWith("-")) {
    throw new Error(`Invalid test filter pattern '${filterPattern}': contains unsafe characters.`);
  }
  return trimmed;
}

/**
 * Python tests with no project configuration (no pyproject.toml / setup.py): `test_*.py` files in `tests/` or at the
 * root, run with the standard library's unittest (always present, unlike pytest).
 */
function unittestLayout(root: string): DiscoveredVerifier | null {
  const testFiles = (dir: string) => {
    try {
      return fs.readdirSync(path.join(root, dir)).filter((name) => /^test_.*\.py$/.test(name));
    } catch {
      return [];
    }
  };
  if (testFiles("tests").length) return { command: "python3 -m unittest discover -s tests", evidence: `tests/${testFiles("tests")[0]}` };
  if (testFiles("test").length) return { command: "python3 -m unittest discover -s test", evidence: `test/${testFiles("test")[0]}` };
  if (testFiles(".").length) return { command: "python3 -m unittest discover", evidence: testFiles(".")[0] };
  return null;
}

export interface DiscoveredVerifier {
  command: string;
  /** Repository file that justifies selecting this verifier. */
  evidence: string;
}

/**
 * Select a verifier only when repository files justify one. There is no `npm test` fallback:
 * a workspace with no applicable verifier has none (returns null).
 */
export function discoverVerifier(workspace: string, filterPattern?: string): DiscoveredVerifier | null {
  const root = path.resolve(workspace);
  const filter = validateFilterPattern(filterPattern);
  const has = (p: string) => fs.existsSync(path.join(root, p));

  if (has("Makefile")) {
    try {
      if (/^test:/m.test(fs.readFileSync(path.join(root, "Makefile"), "utf-8"))) {
        return {
          command: filter ? `make test FILTER="${filter}"` : "make test",
          evidence: "Makefile:test",
        };
      }
    } catch {}
  }
  if (has("Cargo.toml")) {
    return {
      command: filter ? `cargo test -- ${filter}` : "cargo test",
      evidence: "Cargo.toml",
    };
  }
  if (has("core/Cargo.toml")) {
    return {
      command: filter
        ? `cargo test --manifest-path core/Cargo.toml -- ${filter}`
        : "cargo test --manifest-path core/Cargo.toml",
      evidence: "core/Cargo.toml",
    };
  }

  const npmTest = (pkgRel: string): boolean => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, pkgRel), "utf-8"));
      const script = pkg?.scripts?.test;
      return typeof script === "string" && script.trim().length > 0 && !/no test specified/i.test(script);
    } catch {
      return false;
    }
  };
  if (has("package.json") && npmTest("package.json")) {
    return {
      command: filter ? `npm test -- -t "${filter}"` : "npm test",
      evidence: "package.json:scripts.test",
    };
  }
  if (has("cli/package.json") && npmTest("cli/package.json")) {
    return {
      command: filter ? `npm --prefix cli test -- -t "${filter}"` : "npm --prefix cli test",
      evidence: "cli/package.json:scripts.test",
    };
  }

  if (has("pyproject.toml") || has("setup.py")) {
    return {
      command: filter ? `pytest -k "${filter}"` : "pytest",
      evidence: has("pyproject.toml") ? "pyproject.toml" : "setup.py",
    };
  }
  if (has("go.mod")) {
    return {
      command: filter ? `go test ./... -run "${filter}"` : "go test ./...",
      evidence: "go.mod",
    };
  }
  const unittest = unittestLayout(root);
  if (unittest) {
    return {
      command: filter ? `${unittest.command} -k "${filter}"` : unittest.command,
      evidence: unittest.evidence,
    };
  }
  return null;
}

export interface VerifierDescription {
  command: string;
  evidence: string;
  script?: string;
  digest: string;
}

/**
 * Resolves the verifier command, its justifying evidence, and its script body (e.g. from
 * package.json scripts.test or Makefile test: recipe), plus a digest for approval caching.
 */
export function describeVerifier(workspace: string, commandOverride?: string): VerifierDescription | null {
  const root = path.resolve(workspace);
  const has = (p: string) => fs.existsSync(path.join(root, p));
  let command = commandOverride?.trim();
  let evidence = "configured";
  let script: string | undefined;

  if (!command) {
    const discovered = discoverVerifier(workspace);
    if (!discovered) return null;
    command = discovered.command;
    evidence = discovered.evidence;
  }

  // Look up script body based on command and workspace files
  if (command === "npm test" || command.startsWith("npm test") || command.startsWith("npm --prefix")) {
    let pkgRel = "package.json";
    if (command.includes("--prefix")) {
      const match = command.match(/--prefix\s+([^\s]+)/);
      if (match) pkgRel = path.join(match[1], "package.json");
    }
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, pkgRel), "utf-8"));
      script = pkg?.scripts?.test;
      if (evidence === "configured") evidence = `${pkgRel}:scripts.test`;
    } catch {}
  } else if (command === "make test" || command.startsWith("make test")) {
    try {
      const content = fs.readFileSync(path.join(root, "Makefile"), "utf-8");
      const match = content.match(/^test:[^\n]*\n((?:\t[^\n]*\n?)+)/m);
      if (match) {
        script = match[1].trim();
        if (evidence === "configured") evidence = "Makefile:test";
      }
    } catch {}
  } else if (command === "cargo test" || command.startsWith("cargo test")) {
    try {
      let cargoRel = "Cargo.toml";
      if (command.includes("--manifest-path")) {
        const match = command.match(/--manifest-path\s+([^\s]+)/);
        if (match) cargoRel = match[1];
      }
      if (fs.existsSync(path.join(root, cargoRel))) {
        script = fs.readFileSync(path.join(root, cargoRel), "utf-8");
        if (evidence === "configured") evidence = cargoRel;
      }
    } catch {}
  } else if (command === "pytest" || command.startsWith("pytest")) {
    for (const p of ["pytest.ini", "pyproject.toml", "setup.cfg"]) {
      if (has(p)) {
        try {
          script = fs.readFileSync(path.join(root, p), "utf-8");
          if (evidence === "configured") evidence = p;
          break;
        } catch {}
      }
    }
  }

  if (script === undefined) {
    // If command runs a local script file (e.g. node script.js or ./test.sh), try reading it
    const parts = command.split(/\s+/);
    for (const part of parts.slice(1)) {
      if (!part.startsWith("-") && has(part)) {
        try {
          const stat = fs.statSync(path.join(root, part));
          if (stat.isFile() && stat.size < 50_000) {
            script = fs.readFileSync(path.join(root, part), "utf-8");
            break;
          }
        } catch {}
      }
    }
    if (script === undefined) script = command;
  }

  const digest = createHash("sha256").update(`${command}\n${script}`).digest("hex");
  return {
    command,
    evidence,
    script,
    digest,
  };
}

/**
 * Execute automated test suite with diagnostic error parsing (Candidate #47)
 */
export function runTestSuite(workspace: string, filterPattern?: string): TestRunResult {
  const root = path.resolve(workspace);
  const discovered = discoverVerifier(root, filterPattern);
  if (!discovered) {
    return summarizeTestRun("none", false, "no verifier: no verification command is configured or discovered in this workspace.");
  }
  const command = discovered.command;

  let rawOutput = "";
  let success = false;

  try {
    rawOutput = execSync(command, {
      cwd: root,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: verifierTimeoutSecs() * 1000,
    });
    success = true;
  } catch (err: any) {
    rawOutput = (err.stdout || "") + "\n" + (err.stderr || err.message || "");
    success = false;
  }

  return summarizeTestRun(command, success, rawOutput);
}

/** Execute test discovery or an explicit verifier through the caller's mutation boundary. */
export async function runTestSuiteWithExecutor(
  workspace: string,
  execute: TestCommandExecutor,
  commandOverride?: string,
): Promise<TestRunResult> {
  const command = commandOverride?.trim() || discoverVerifier(workspace)?.command || "none";
  if (command === "none") return summarizeTestRun("none", false, "no verifier: no verification command is configured or discovered in this workspace.");
  try {
    const result = await execute(command);
    let commandSucceeded = false;
    let timedOut = result.timedOut === true;
    let rawOutput = [result.output, result.error].filter(Boolean).join("\n");
    if (result.success) {
      try {
        const execution = JSON.parse(result.output);
        // The runner's envelope is always unwrapped: a killed or timed-out command has `exit_code: null`.
        if (execution && typeof execution === "object" && "exit_code" in execution) {
          timedOut = execution.timed_out === true;
          commandSucceeded = execution.exit_code === 0 && !timedOut;
          rawOutput = [execution.stdout, execution.stderr, result.error].filter(Boolean).join("\n");
        }
      } catch {
        // Unknown executor output is not proof that the command exited successfully.
      }
    }
    const summary = summarizeTestRun(command, commandSucceeded, rawOutput);
    return timedOut ? { ...summary, success: false, timedOut: true } : summary;
  } catch (error: any) {
    return summarizeTestRun(command, false, error?.message || "Verification command execution failed.");
  }
}

function summarizeTestRun(command: string, success: boolean, rawOutput: string): TestRunResult {
  // Extract failing test line summaries
  const failures: string[] = [];
  const lines = rawOutput.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("FAIL") ||
      trimmed.startsWith("✖") ||
      (trimmed.includes("FAILED") && !trimmed.includes("0 failed")) ||
      trimmed.startsWith("test result: FAILED")
    ) {
      failures.push(trimmed);
    }
  }

  // Extract compiler/type diagnostics
  const diagnostics = extractCompilerDiagnostics(rawOutput);

  return {
    command,
    success,
    rawOutput,
    failures,
    diagnostics,
  };
}

/**
 * Whether a verifier command runs only part of the suite: a name filter (`-t`, `-k`, `--test-name-pattern`, `--grep`,
 * `-run`, `FILTER=`), a pytest node id (`file.py::test`), or a positional test name for `cargo test`. A filtered run
 * can show that a test passes, not that nothing else broke.
 */
export function isFilteredVerifierCommand(command: string): boolean {
  if (!command) return false;
  if (/(?:^|\s)(?:-t|-k|--grep|-g)(?:\s|=)\S/.test(command)) return true;
  if (/(?:^|\s)(?:--test-name-pattern|--testNamePattern|-run|--run)(?:\s|=)\S/.test(command)) return true;
  if (/(?:^|\s)FILTER=\S/.test(command)) return true;
  if (/\S\.py::\S/.test(command)) return true;
  if (/(?:^|\s)--(?:$|\s+[^-]\S*)/.test(command)) return true;
  const cargo = command.match(/\bcargo\s+test\b(.*)$/);
  if (cargo) {
    const tokens = cargo[1].trim().split(/\s+/).filter(Boolean);
    const takesValue = new Set(["--manifest-path", "-p", "--package", "--features", "-F", "--target", "--profile", "-j", "--jobs", "--bin", "--test", "--example", "--bench", "--exclude", "--target-dir", "--color", "--message-format"]);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === "--") return tokens.slice(i + 1).some((t) => !t.startsWith("-"));
      if (takesValue.has(token)) {
        i++;
        continue;
      }
      if (token.startsWith("-") || /[;&|]/.test(token)) {
        if (/[;&|]/.test(token)) break;
        continue;
      }
      return true;
    }
  }
  return false;
}

/**
 * Whether a test run's output shows that at least one test executed. Runners that report counts are read (node:test,
 * cargo, pytest, unittest, jest/vitest, mocha, go); output with no recognisable report — including no output — is not evidence.
 * Skipped tests are subtracted; a run where all tests were skipped returns false.
 */
export function hasExecutedTests(rawOutput: string): boolean {
  if (!rawOutput) return false;

  // 1. node:test
  const nodeTests = [...rawOutput.matchAll(/ℹ\s+tests\s+(\d+)/g)];
  if (nodeTests.length) {
    const totalTests = nodeTests.reduce((sum, m) => sum + Number(m[1]), 0);
    const pass = [...rawOutput.matchAll(/ℹ\s+pass\s+(\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    const fail = [...rawOutput.matchAll(/ℹ\s+fail\s+(\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    const hasPassOrFail = /ℹ\s+(?:pass|fail)\s+\d+/.test(rawOutput);
    if (hasPassOrFail) return pass + fail > 0;
    const skipped = [...rawOutput.matchAll(/ℹ\s+skipped\s+(\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    const todo = [...rawOutput.matchAll(/ℹ\s+todo\s+(\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    return totalTests - skipped - todo > 0;
  }

  // Node 20's default node:test reporter uses TAP summary lines; Node 22+ may emit the spec summary above.
  const nodeTap = rawOutput.match(
    /(?:^|\n)# tests (\d+)\r?\n# suites \d+\r?\n# pass (\d+)\r?\n# fail (\d+)\r?\n# cancelled (\d+)\r?\n# skipped (\d+)\r?\n# todo (\d+)(?:\r?\n# duration_ms [\d.]+)?(?=\r?\n|$)/
  );
  if (nodeTap) {
    const passed = Number(nodeTap[2]);
    const failed = Number(nodeTap[3]);
    return passed + failed > 0;
  }

  // 2. Cargo (Rust)
  const cargo = [...rawOutput.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)];
  if (cargo.length) return cargo.some((m) => Number(m[1]) + Number(m[2]) > 0);

  // 3. Jest
  const jest = rawOutput.match(/Tests:\s+(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+passed,?\s*)?(?:(\d+)\s+skipped,?\s*)?(\d+)\s+total/);
  if (jest) {
    const failed = Number(jest[1] || 0);
    const passed = Number(jest[2] || 0);
    return passed + failed > 0;
  }

  // 4. Vitest
  const vitestPassed = rawOutput.match(/\bTests\s+.*?(\d+)\s+passed/);
  const vitestFailed = rawOutput.match(/\bTests\s+.*?(\d+)\s+failed/);
  if (vitestPassed || vitestFailed) {
    const passed = Number(vitestPassed ? vitestPassed[1] : 0);
    const failed = Number(vitestFailed ? vitestFailed[1] : 0);
    return passed + failed > 0;
  }
  if (/\bTests\s+\d+\s+skipped\b/.test(rawOutput) && !/\bTests\s+\d+\s+passed\b/.test(rawOutput)) {
    return false;
  }

  // 5. Pytest
  if (/collected 0 items|no tests ran/i.test(rawOutput)) return false;
  const pytestPassed = rawOutput.match(/=+\s+.*?(\d+)\s+passed/);
  const pytestFailed = rawOutput.match(/=+\s+.*?(\d+)\s+failed/);
  if (pytestPassed || pytestFailed) {
    const passed = Number(pytestPassed ? pytestPassed[1] : 0);
    const failed = Number(pytestFailed ? pytestFailed[1] : 0);
    return passed + failed > 0;
  }
  if (/=+\s+\d+\s+skipped.*?=+/i.test(rawOutput)) return false;

  // 6. Python unittest: "Ran 3 tests in 0.001s" (it also prints "Ran 0 tests" when discovery finds nothing)
  const unittest = [...rawOutput.matchAll(/^Ran (\d+) tests? in /gm)];
  if (unittest.length) {
    const totalRan = unittest.reduce((sum, m) => sum + Number(m[1]), 0);
    const skippedMatch = rawOutput.match(/OK\s*\((?:.*?,\s*)?skipped=(\d+)\)/);
    const skipped = skippedMatch ? Number(skippedMatch[1]) : 0;
    return totalRan - skipped > 0;
  }

  // 7. Mocha
  const mochaPass = rawOutput.match(/^\s*(\d+)\s+passing\b/m);
  const mochaFail = rawOutput.match(/^\s*(\d+)\s+failing\b/m);
  if (mochaPass || mochaFail) {
    const passed = Number(mochaPass ? mochaPass[1] : 0);
    const failed = Number(mochaFail ? mochaFail[1] : 0);
    return passed + failed > 0;
  }

  // 8. Go test: anchored regex ^ok\s+\S+\s+(\d+\.\d+s|\(cached\))
  const goOkLines = [...rawOutput.matchAll(/^ok\s+\S+\s+(\d+\.\d+s|\(cached\))/gm)];
  if (goOkLines.some((m) => !m.input.slice(m.index).split("\n")[0].includes("[no tests to run]"))) return true;
  if (/^--- (?:PASS|FAIL): /m.test(rawOutput)) return true;

  return false;
}

const TEST_PATH = /(?:^|[\\/])(?:tests?|__tests__|spec)[\\/]|(?:^|[\\/])test_[^\\/]+\.py$|[._-](?:test|spec)\.[A-Za-z0-9]+$|_test\.(?:go|rs|py)$/i;
export const SKIP_DIRS = new Set(["node_modules", ".git", "target", "dist", "build", "vendor", ".venv", "venv", "__pycache__", ".nexus"]);
const MAX_TEST_FILES = 2000;
export const MAX_TEST_BYTES = 256 * 1024;

/** Test files of a workspace (bounded: depth 6, 2000 files, generated and dependency directories skipped). */
export function workspaceTestFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || found.length >= MAX_TEST_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_TEST_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1);
      } else if (TEST_PATH.test(path.relative(root, full))) {
        found.push(full);
      }
    }
  };
  walk(root, 0);
  return found;
}

function isSafeWorkspaceFile(root: string, relative: string): boolean {
  try {
    const rootReal = fs.realpathSync(root);
    let cursor = path.resolve(root, relative);
    const lexical = path.relative(path.resolve(root), cursor);
    if (!lexical || lexical === ".." || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical)) return false;
    const components = path.relative(root, cursor).split(path.sep);
    cursor = path.resolve(root);
    for (const component of components) {
      cursor = path.join(cursor, component);
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) return false;
      const real = fs.realpathSync(cursor);
      const fromRoot = path.relative(rootReal, real);
      if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) return false;
    }
    return fs.lstatSync(cursor).isFile();
  } catch {
    return false;
  }
}

/** Resolve a test's relative JS/TS imports to the exact scoped file (including NodeNext `.js` -> `.ts`). */
function testReferencesFile(content: string, testFile: string, targetFile: string, root: string): boolean {
  const target = path.resolve(root, targetFile);
  if (target.endsWith(".py") || testFile.endsWith(".py")) {
    return pythonTestReferencesFile(content, target, root);
  }
  const imports = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']|(?:^|[;\n])\s*import\s*["']([^"']+)["']/gm;
  const extensions = [".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx", ".json"];
  for (const match of content.matchAll(imports)) {
    const specifier = match[1] ?? match[2];
    if (!specifier.startsWith(".")) continue;
    const base = path.resolve(path.dirname(path.resolve(root, testFile)), specifier);
    const candidates = new Set([base]);
    if (/\.(?:c|m)?js$/.test(base)) {
      candidates.add(base.replace(/\.(?:c|m)?js$/, ".ts"));
      candidates.add(base.replace(/\.(?:c|m)?js$/, ".tsx"));
    } else if (!path.extname(base)) {
      for (const extension of extensions) candidates.add(base + extension);
      for (const extension of extensions) candidates.add(path.join(base, `index${extension}`));
    }
    if ([...candidates].some((candidate) => path.resolve(candidate) === target)) return true;
  }
  return false;
}

/**
 * Bind Python tests through explicit, root-qualified imports. Unknown import
 * layouts remain unbound rather than being inferred from output or basenames.
 */
function pythonTestReferencesFile(content: string, target: string, root: string): boolean {
  const source = stripPythonStringsAndComments(content);
  const moduleMatchesTarget = (name: string): boolean => {
    if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(name)) return false;
    const base = path.resolve(root, ...name.split("."));
    if (!base.startsWith(`${root}${path.sep}`)) return false;
    return [`${base}.py`, path.join(base, "__init__.py")].some(
      (candidate) => path.resolve(candidate) === target,
    );
  };

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const fromImport = line.match(/^from\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s+import\s+(.+)$/);
    if (fromImport) {
      const [, module, imported] = fromImport;
      if (moduleMatchesTarget(module)) return true;
      for (const part of imported.split(",")) {
        const name = part.trim().split(/\s+as\s+/i, 1)[0];
        if (/^[A-Za-z_]\w*$/.test(name) && moduleMatchesTarget(`${module}.${name}`)) return true;
      }
      continue;
    }

    const directImport = line.match(/^import\s+(.+)$/);
    if (!directImport) continue;
    for (const part of directImport[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/i, 1)[0];
      if (moduleMatchesTarget(name)) return true;
    }
  }
  return false;
}

/** Mask Python strings and comments so their contents cannot impersonate import statements. */
function stripPythonStringsAndComments(source: string): string {
  const chars = Array.from(source);
  for (let i = 0; i < chars.length; i++) {
    const current = chars[i];
    if (current === "#") {
      while (i < chars.length && chars[i] !== "\n" && chars[i] !== "\r") chars[i++] = " ";
      i--;
      continue;
    }
    if (current !== "'" && current !== '"') continue;

    const triple = chars[i + 1] === current && chars[i + 2] === current;
    const width = triple ? 3 : 1;
    chars[i] = " ";
    if (triple) {
      chars[i + 1] = " ";
      chars[i + 2] = " ";
    }
    i += width;
    while (i < chars.length) {
      if (chars[i] === "\\") {
        if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
        if (i + 1 < chars.length) {
          if (chars[i + 1] !== "\n" && chars[i + 1] !== "\r") chars[i + 1] = " ";
          i++;
        }
        i++;
        continue;
      }
      if (triple
        ? chars[i] === current && chars[i + 1] === current && chars[i + 2] === current
        : chars[i] === current) {
        for (let end = 0; end < width && i + end < chars.length; end++) chars[i + end] = " ";
        i += width - 1;
        break;
      }
      if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
      i++;
    }
    i--;
  }
  return chars.join("");
}

/**
 * Extract workspace-relative path tokens from command and output.
 * Tokens are split on whitespace, quotes, parentheses, brackets, and commas.
 * Line/column suffixes (e.g., `:12:3`) are stripped.
 * Only tokens containing a path separator ('/' or '\\') are treated as paths,
 * preventing coincidental matches on bare basenames like "README.md".
 */
export function extractPathTokens(workspace: string, text: string): Set<string> {
  const root = path.resolve(workspace);
  const tokens = new Set<string>();
  if (!text) return tokens;

  const parts = text.split(/[\s'"()`,]+/);
  for (let part of parts) {
    if (!part) continue;
    let end = part.length;
    while (end > 0) {
      const code = part.charCodeAt(end - 1);
      if (code === 46 || code === 44 || code === 59 || code === 58) end--;
      else break;
    }
    if (end !== part.length) part = part.slice(0, end);

    let suffixStart = part.length;
    let cursor = part.length;
    while (cursor > 0) {
      const code = part.charCodeAt(cursor - 1);
      if (code >= 48 && code <= 57) cursor--;
      else break;
    }
    if (cursor < part.length && cursor > 0 && part.charCodeAt(cursor - 1) === 58) {
      suffixStart = cursor - 1;
      let lineStart = suffixStart;
      while (lineStart > 0) {
        const code = part.charCodeAt(lineStart - 1);
        if (code >= 48 && code <= 57) lineStart--;
        else break;
      }
      if (lineStart < suffixStart && lineStart > 0 && part.charCodeAt(lineStart - 1) === 58) {
        suffixStart = lineStart - 1;
      }
    }
    if (suffixStart !== part.length) part = part.slice(0, suffixStart);
    if (!part) continue;

    const norm = part.replace(/\\/g, "/");
    const cleaned = norm.replace(/^\.\//, "");
    tokens.add(cleaned);

    if (path.isAbsolute(part)) {
      try {
        const resolved = path.resolve(part);
        if (resolved.startsWith(root)) {
          const rel = path.relative(root, resolved).replace(/\\/g, "/");
          if (rel) {
            tokens.add(rel);
          }
        }
      } catch {}
    }
  }
  return tokens;
}

/**
 * Whether a passing verifier run is evidence about the changed files (VERIFIED) rather than only a regression check
 * (REGRESSION_FREE). It must show executed tests import every changed product file
 * explicitly declared by the operator before the turn. Candidate-controlled test
 * output, changed tests, inline tests, and runtime-graph membership alone cannot
 * establish deliverable scope.
 * Verification-only work still requires an operator-declared scope and pre-turn test snapshot; an empty change list is
 * not itself a deliverable declaration.
 */
export function isVerifierDeliverableBound(
  workspace: string,
  changedFiles: string[],
  verifierCommand: string,
  testOutput: string = "",
  trustedDeliverables?: ReadonlySet<string>,
  baselineTests?: ReadonlyMap<string, string>,
): boolean {
  if (!hasExecutedTests(testOutput)) return false;
  const root = path.resolve(workspace);
  const rel = (file: string) => path.relative(root, path.resolve(root, file)).replace(/\\/g, "/");

  // An empty change list is not an operator scope. This matters for verification-only
  // work units: a generic passing suite is regression evidence, not proof of a declared
  // product deliverable. The operator-declared scope and pre-turn test snapshot are both
  // required even when the current turn made no edits.
  if (!baselineTests?.size || !trustedDeliverables?.size) return false;
  const declaredScope = [...trustedDeliverables].map((file) => rel(file));
  if (declaredScope.some((file) => !file || file.startsWith("../") || path.isAbsolute(file) || !isSafeWorkspaceFile(root, file))) return false;
  const declaredScopeSet = new Set(declaredScope);
  const changedNonTestFiles = changedFiles.filter((file) => !TEST_PATH.test(rel(file)));
  // A runtime graph cannot distinguish product code from dual-use oracle code.
  // Require a pre-turn operator declaration and reject any changed product path
  // outside that immutable task scope.
  const changedTargets = changedNonTestFiles.map((file) => rel(file));
  if (changedTargets.some((file) => !declaredScopeSet.has(file) || !isSafeWorkspaceFile(root, file))) return false;
  const tokens = extractPathTokens(root, `${verifierCommand}\n${testOutput}`);
  const isFiltered = isFilteredVerifierCommand(verifierCommand);

  const testFileExecuted = (testFileRel: string) => {
    // An unfiltered verifier run that executed tests ran the repository test suite
    if (!isFiltered) return true;
    return tokens.has(testFileRel) || verifierCommand.includes(testFileRel);
  };

  // Verifier output is candidate-influenced. Bind every operator-declared product
  // file to an actually executed, pre-existing test import instead of path text.
  return declaredScope.every((file) => [...baselineTests].some(([testRel, content]) =>
    (!isFiltered || testFileExecuted(testRel)) &&
    Boolean(content) && testReferencesFile(content, testRel, rel(file), root),
  ));
}

/** Resolve package-declared runtime entry points to the files that actually implement them. */
export function workspaceRuntimeFiles(root: string): Set<string> {
  const workspace = path.resolve(root);
  const manifests: string[] = [];
  const walk = (directory: string, depth: number) => {
    if (depth > 5 || manifests.length >= 128) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === "build") continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === "package.json") manifests.push(full);
    }
  };
  walk(workspace, 0);

  const product = new Set<string>();
  const sourceExtensions = [".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx"];
  const resolveModule = (base: string): string | null => {
    const sourceAliases = /\.(?:c|m)?js$/.test(base)
      ? [base.replace(/\.(?:c|m)?js$/, ".ts"), base.replace(/\.(?:c|m)?js$/, ".tsx")]
      : [];
    const candidates = [base, ...sourceAliases, ...sourceExtensions.map((extension) => base + extension), ...sourceExtensions.map((extension) => path.join(base, `index${extension}`))];
    for (const candidate of candidates) {
      if (!candidate.startsWith(workspace + path.sep)) continue;
      try {
        const stat = fs.lstatSync(candidate);
        const real = fs.realpathSync(candidate);
        if (!stat.isSymbolicLink() && real.startsWith(workspace + path.sep) && stat.isFile()) return candidate;
      } catch {}
    }
    return null;
  };
  const mapBuiltEntryToSource = (packageRoot: string, entry: string): string[] => {
    const candidates = [entry];
    for (const tsconfigName of ["tsconfig.json", "tsconfig.build.json"]) {
      try {
        const config = JSON.parse(fs.readFileSync(path.join(packageRoot, tsconfigName), "utf8"));
        const options = config.compilerOptions ?? {};
        const outDir = options.outDir;
        const rootDir = options.rootDir;
        if (typeof outDir !== "string" || typeof rootDir !== "string") continue;
        const out = path.resolve(packageRoot, outDir);
        const resolvedEntry = path.resolve(packageRoot, entry);
        if (resolvedEntry !== out && !resolvedEntry.startsWith(out + path.sep)) continue;
        const relative = path.relative(out, resolvedEntry).replace(/\\/g, "/").replace(/\.(?:c|m)?js$/, "");
        candidates.unshift(path.join(rootDir, relative + ".ts"), path.join(rootDir, relative + ".tsx"), path.join(rootDir, relative + ".js"));
      } catch {}
    }
    return candidates;
  };
  const collectEntries = (value: unknown, entries: Set<string>) => {
    if (typeof value === "string" && value.startsWith(".")) entries.add(value);
    else if (Array.isArray(value)) value.forEach((item) => collectEntries(item, entries));
    else if (value && typeof value === "object") Object.values(value).forEach((item) => collectEntries(item, entries));
  };
  const pending: string[] = [];
  for (const manifest of manifests) {
    let pkg: any;
    try { pkg = JSON.parse(fs.readFileSync(manifest, "utf8")); } catch { continue; }
    const packageRoot = path.dirname(manifest);
    const entries = new Set<string>();
    for (const key of ["main", "module", "source", "browser", "exports", "bin"]) collectEntries(pkg[key], entries);
    for (const key of ["start", "serve", "dev"]) {
      const script = pkg.scripts?.[key];
      if (typeof script === "string") {
        for (const match of script.matchAll(/(?:node|tsx|ts-node)\s+([^\s;&|]+)/g)) entries.add(match[1]);
      }
    }
    for (const entry of entries) {
      if (!entry.startsWith(".")) continue;
      for (const candidate of mapBuiltEntryToSource(packageRoot, entry)) {
        const resolved = resolveModule(path.resolve(packageRoot, candidate));
        if (resolved) pending.push(resolved);
      }
    }
  }

  const visited = new Set<string>();
  const importPattern = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']|(?:^|[;\n])\s*import\s*["']([^"']+)["']/gm;
  while (pending.length && visited.size < 4096) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    product.add(path.relative(workspace, file).replace(/\\/g, "/"));
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2];
      if (!specifier.startsWith(".")) continue;
      const dependency = resolveModule(path.resolve(path.dirname(file), specifier));
      if (dependency) pending.push(dependency);
    }
  }
  return product;
}

/**
 * A test import binds a changed file only when a pre-existing package runtime
 * entry point reaches that file. Directory names such as `src/` are not
 * authority: unreferenced assertion helpers under a source-looking directory
 * remain test support, while an explicitly exported root module is a product.
 */
export function isWorkspaceTestSupportFile(root: string, file: string): boolean {
  const workspace = path.resolve(root);
  const absolute = path.resolve(workspace, file);
  const relative = path.relative(workspace, absolute).replace(/\\/g, "/");
  if (!relative || relative === ".." || relative.startsWith("../")) return true;
  return !workspaceRuntimeFiles(workspace).has(relative);
}
