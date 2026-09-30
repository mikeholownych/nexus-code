import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { extractCompilerDiagnostics, Diagnostic } from "./diagnostics.js";

export interface TestRunResult {
  command: string;
  success: boolean;
  rawOutput: string;
  failures: string[];
  diagnostics: Diagnostic[];
}

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
