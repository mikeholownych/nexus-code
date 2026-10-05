import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
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

  return "npm test";
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
  return null;
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
