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

/**
 * Auto-detect project test command (Candidate #47)
 */
export function detectTestCommand(workspace: string, filterPattern?: string): string {
  const root = path.resolve(workspace);

  if (filterPattern) {
    // The filter is interpolated into a shell command: letters, digits and `_ : . / -` with single spaces only (no
    // newline, quote or shell metacharacter), and it may not start with `-` (it would become a runner flag).
    const trimmed = filterPattern.trim();
    if (!/^[A-Za-z0-9_:./ -]+$/.test(trimmed) || trimmed.startsWith("-")) {
      throw new Error(`Invalid test filter pattern '${filterPattern}': contains unsafe characters.`);
    }
    filterPattern = trimmed;
  }

  // 1. Makefile with test target
  const makefile = path.join(root, "Makefile");
  if (fs.existsSync(makefile)) {
    try {
      const content = fs.readFileSync(makefile, "utf-8");
      if (content.includes("test:")) {
        return filterPattern ? `make test FILTER="${filterPattern}"` : "make test";
      }
    } catch {}
  }

  // 2. Cargo.toml (Rust)
  if (fs.existsSync(path.join(root, "Cargo.toml"))) {
    return filterPattern ? `cargo test -- ${filterPattern}` : "cargo test";
  }
  if (fs.existsSync(path.join(root, "core", "Cargo.toml"))) {
    return filterPattern
      ? `cargo test --manifest-path core/Cargo.toml -- ${filterPattern}`
      : "cargo test --manifest-path core/Cargo.toml";
  }

  // 3. package.json (Node / TS)
  if (fs.existsSync(path.join(root, "package.json"))) {
    return filterPattern ? `npm test -- -t "${filterPattern}"` : "npm test";
  }
  if (fs.existsSync(path.join(root, "cli", "package.json"))) {
    return filterPattern ? `npm --prefix cli test -- -t "${filterPattern}"` : "npm --prefix cli test";
  }

  // 4. Python
  if (fs.existsSync(path.join(root, "pyproject.toml")) || fs.existsSync(path.join(root, "setup.py"))) {
    return filterPattern ? `pytest -k "${filterPattern}"` : "pytest";
  }

  // 5. Go
  if (fs.existsSync(path.join(root, "go.mod"))) {
    return filterPattern ? `go test ./... -run "${filterPattern}"` : "go test ./...";
  }

  // 6. Python test files without project configuration: the standard library's runner
  const unittest = unittestLayout(root);
  if (unittest) return filterPattern ? `${unittest.command} -k "${filterPattern}"` : unittest.command;

  return "npm test";
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
 * Select a verifier only when repository files justify one. Unlike detectTestCommand there is no
 * `npm test` fallback: a workspace with no applicable verifier has none (returns null).
 */
export function discoverVerifier(workspace: string): DiscoveredVerifier | null {
  const root = path.resolve(workspace);
  const has = (p: string) => fs.existsSync(path.join(root, p));

  if (has("Makefile")) {
    try {
      if (/^test:/m.test(fs.readFileSync(path.join(root, "Makefile"), "utf-8"))) return { command: "make test", evidence: "Makefile:test" };
    } catch {}
  }
  if (has("Cargo.toml")) return { command: "cargo test", evidence: "Cargo.toml" };
  if (has("core/Cargo.toml")) return { command: "cargo test --manifest-path core/Cargo.toml", evidence: "core/Cargo.toml" };

  const npmTest = (pkgRel: string): boolean => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, pkgRel), "utf-8"));
      const script = pkg?.scripts?.test;
      return typeof script === "string" && script.trim().length > 0 && !/no test specified/i.test(script);
    } catch {
      return false;
    }
  };
  if (has("package.json") && npmTest("package.json")) return { command: "npm test", evidence: "package.json:scripts.test" };
  if (has("cli/package.json") && npmTest("cli/package.json")) return { command: "npm --prefix cli test", evidence: "cli/package.json:scripts.test" };

  if (has("pyproject.toml") || has("setup.py")) return { command: "pytest", evidence: has("pyproject.toml") ? "pyproject.toml" : "setup.py" };
  if (has("go.mod")) return { command: "go test ./...", evidence: "go.mod" };
  const unittest = unittestLayout(root);
  if (unittest) return unittest;
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
  const command = detectTestCommand(root, filterPattern);

  let rawOutput = "";
  let success = false;

  try {
    rawOutput = execSync(command, {
      cwd: root,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120000,
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
  const command = commandOverride?.trim() || detectTestCommand(workspace);
  if (command === "none") return summarizeTestRun(command, false, "No verification command is configured.");
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
 * cargo, pytest, unittest, jest/vitest, go); output with no recognisable report — including no output — is not evidence.
 */
export function hasExecutedTests(rawOutput: string): boolean {
  if (!rawOutput) return false;
  const count = (re: RegExp) => [...rawOutput.matchAll(re)].reduce((sum, m) => sum + Number(m[1]), 0);
  const node = [...rawOutput.matchAll(/ℹ\s+tests\s+(\d+)/g)];
  if (node.length) return count(/ℹ\s+tests\s+(\d+)/g) > 0;
  const cargo = [...rawOutput.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)];
  if (cargo.length) return cargo.some((m) => Number(m[1]) + Number(m[2]) > 0);
  const jest = rawOutput.match(/Tests:\s+(?:.*?(\d+) passed)?.*?(\d+) total/);
  if (jest) return Number(jest[2]) > 0;
  const pytest = rawOutput.match(/=+ .*?(\d+) passed/);
  if (pytest) return Number(pytest[1]) > 0;
  // unittest: "Ran 3 tests in 0.001s" (it also prints "Ran 0 tests" when discovery finds nothing)
  const unittest = [...rawOutput.matchAll(/^Ran (\d+) tests? in /gm)];
  if (unittest.length) return unittest.some((m) => Number(m[1]) > 0);
  if (/collected 0 items|no tests ran/i.test(rawOutput)) return false;
  // go test: an `ok <package>` line that ran tests (not `[no tests to run]`), or verbose `--- PASS` lines.
  if ([...rawOutput.matchAll(/^ok\s+\S+.*$/gm)].some((m) => !m[0].includes("[no tests to run]"))) return true;
  if (/^--- PASS: /m.test(rawOutput)) return true;
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

/** Whether `content` (a test file) imports the module `file`: an import specifier ending in its name, not a substring. */
function importsModule(content: string, file: string): boolean {
  const stem = path.basename(file).replace(/\.[^.]+$/, "");
  if (!stem || stem === "index" || stem === "mod" || stem === "__init__") {
    // Imported through its directory: match the directory name instead.
    const dir = path.basename(path.dirname(file));
    return dir ? importsName(content, dir) : false;
  }
  return importsName(content, stem);
}

function importsName(content: string, name: string): boolean {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // JS/TS: from "…/name(.ext)" / require("…/name") / import("…/name")
  if (new RegExp(`(?:from|require\\(|import\\()\\s*["'][^"']*(?:^|/)${n}(?:\\.[cm]?[jt]sx?)?["']`).test(content)) return true;
  // Python: from pkg.name import … / import pkg.name / from . import name
  if (new RegExp(`^\\s*(?:from\\s+[\\w.]*\\b${n}\\b\\s+import|import\\s+[\\w.]*\\b${n}\\b|from\\s+[\\w.]+\\s+import\\s+.*\\b${n}\\b)`, "m").test(content)) return true;
  // Rust: use crate::name / use super::name / mod name
  if (new RegExp(`\\buse\\s+(?:crate|super|self|\\w+)::(?:[\\w:]*::)?${n}\\b|\\bmod\\s+${n}\\b`).test(content)) return true;
  return false;
}

/**
 * Whether a passing verifier run is evidence about the changed files (VERIFIED) rather than only a regression check
 * (REGRESSION_FREE). It must show that tests executed, and then one of:
 * - a changed file is a test file (the change brings its own test);
 * - the command or the run's output names a changed file;
 * - the change has inline tests the run executes (a Rust file with `#[cfg(test)]` under `cargo test`; a Go package
 *   with `_test.go` files under `go test`);
 * - a workspace test file imports a changed module (by import specifier, not by substring).
 * With no changed files recorded (e.g. changes carried over from a resumed session), executed tests are the evidence.
 */
export function isVerifierDeliverableBound(
  workspace: string,
  changedFiles: string[],
  verifierCommand: string,
  testOutput: string = ""
): boolean {
  if (!hasExecutedTests(testOutput)) return false;
  if (!changedFiles || changedFiles.length === 0) return true;
  const root = path.resolve(workspace);
  const rel = (file: string) => path.relative(root, path.resolve(root, file));
  if (changedFiles.some((file) => TEST_PATH.test(rel(file)))) return true;
  for (const file of changedFiles) {
    const r = rel(file);
    const base = path.basename(file);
    if (verifierCommand.includes(r) || testOutput.includes(r) || (base.includes(".") && (verifierCommand.includes(base) || testOutput.includes(base)))) return true;
  }
  const read = (file: string) => {
    try {
      const stat = fs.statSync(file);
      return stat.size <= MAX_TEST_BYTES ? fs.readFileSync(file, "utf8") : "";
    } catch {
      return "";
    }
  };
  for (const file of changedFiles) {
    const full = path.resolve(root, file);
    if (/\bcargo\s+test\b/.test(verifierCommand) && full.endsWith(".rs") && /#\[cfg\(test\)\]/.test(read(full))) return true;
    if (/\bgo\s+test\b/.test(verifierCommand) && full.endsWith(".go")) {
      try {
        if (fs.readdirSync(path.dirname(full)).some((name) => name.endsWith("_test.go"))) return true;
      } catch {}
    }
  }
  const tests = workspaceTestFiles(root);
  for (const test of tests) {
    const content = read(test);
    if (content && changedFiles.some((file) => importsModule(content, path.resolve(root, file)))) return true;
  }
  return false;
}
