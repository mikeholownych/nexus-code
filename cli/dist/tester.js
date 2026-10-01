import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { extractCompilerDiagnostics } from "./diagnostics.js";
/**
 * Auto-detect project test command (Candidate #47)
 */
export function detectTestCommand(workspace, filterPattern) {
    const root = path.resolve(workspace);
    // 1. Makefile with test target
    const makefile = path.join(root, "Makefile");
    if (fs.existsSync(makefile)) {
        try {
            const content = fs.readFileSync(makefile, "utf-8");
            if (content.includes("test:")) {
                return filterPattern ? `make test FILTER="${filterPattern}"` : "make test";
            }
        }
        catch { }
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
export function runTestSuite(workspace, filterPattern) {
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
    }
    catch (err) {
        rawOutput = (err.stdout || "") + "\n" + (err.stderr || err.message || "");
        success = false;
    }
    return summarizeTestRun(command, success, rawOutput);
}
/** Execute test discovery or an explicit verifier through the caller's mutation boundary. */
export async function runTestSuiteWithExecutor(workspace, execute, commandOverride) {
    const command = commandOverride?.trim() || detectTestCommand(workspace);
    if (command === "none")
        return summarizeTestRun(command, false, "No verification command is configured.");
    try {
        const result = await execute(command);
        let commandSucceeded = false;
        let rawOutput = [result.output, result.error].filter(Boolean).join("\n");
        if (result.success) {
            try {
                const execution = JSON.parse(result.output);
                if (execution && typeof execution === "object" && typeof execution.exit_code === "number") {
                    commandSucceeded = execution.exit_code === 0 && execution.timed_out !== true;
                    rawOutput = [execution.stdout, execution.stderr, result.error].filter(Boolean).join("\n");
                }
            }
            catch {
                // Unknown executor output is not proof that the command exited successfully.
            }
        }
        return summarizeTestRun(command, commandSucceeded, rawOutput);
    }
    catch (error) {
        return summarizeTestRun(command, false, error?.message || "Verification command execution failed.");
    }
}
function summarizeTestRun(command, success, rawOutput) {
    // Extract failing test line summaries
    const failures = [];
    const lines = rawOutput.split("\n");
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("FAIL") ||
            trimmed.startsWith("✖") ||
            (trimmed.includes("FAILED") && !trimmed.includes("0 failed")) ||
            trimmed.startsWith("test result: FAILED")) {
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
