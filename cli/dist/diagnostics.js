/**
 * Nexus Code Automated Compiler & Test Diagnostic Recovery Engine
 * Parses stderr/stdout from cargo, tsc, pytest, gcc, go, and test frameworks
 * to provide structured error locations and actionable diagnostic hints.
 */
/**
 * Extracts compiler and test diagnostics from raw command output.
 */
export function extractCompilerDiagnostics(output) {
    if (!output || typeof output !== "string") {
        return [];
    }
    const diagnostics = [];
    const seen = new Set();
    const addDiag = (d) => {
        const key = `${d.file}:${d.line || 0}:${d.message}`;
        if (!seen.has(key)) {
            seen.add(key);
            diagnostics.push(d);
        }
    };
    // 1. Rust / cargo error parsing:
    // error[E0308]: mismatched types
    //  --> src/main.rs:12:5
    const rustRegex = /error(?:\[(E\d+)\])?: ([^\n]+)\n\s+--> ([^\s:]+):(\d+):(\d+)/g;
    let match;
    while ((match = rustRegex.exec(output)) !== null) {
        addDiag({
            code: match[1],
            message: match[2].trim(),
            file: match[3],
            line: parseInt(match[4], 10),
            column: parseInt(match[5], 10),
            severity: "error",
        });
    }
    // 2. TypeScript / tsc error parsing:
    // src/index.ts:14:5 - error TS2322: Type 'number' is not assignable to type 'string'.
    // or src/index.ts(14,5): error TS2322: ...
    const tsRegex1 = /([^\s()]+\.(?:ts|tsx|js|jsx)):(\d+):(\d+) - (error|warning) (TS\d+): ([^\n]+)/g;
    while ((match = tsRegex1.exec(output)) !== null) {
        addDiag({
            file: match[1],
            line: parseInt(match[2], 10),
            column: parseInt(match[3], 10),
            severity: match[4],
            code: match[5],
            message: match[6].trim(),
        });
    }
    const tsRegex2 = /([^\s()]+\.(?:ts|tsx|js|jsx))\(([0-9]+),([0-9]+)\): (error|warning) (TS[0-9]+): ([^\n]+)/g;
    while ((match = tsRegex2.exec(output)) !== null) {
        addDiag({
            file: match[1],
            line: parseInt(match[2], 10),
            column: parseInt(match[3], 10),
            severity: match[4],
            code: match[5],
            message: match[6].trim(),
        });
    }
    // 3. Python / pytest traceback & test failures:
    // FAILED tests/test_foo.py::test_bar - AssertionError: ...
    const pytestRegex = /(?:FAILED|ERROR)\s+([^\s:]+\.py)(?:::(\S+))?\s*(?:-\s*([^\n]+))?/g;
    while ((match = pytestRegex.exec(output)) !== null) {
        addDiag({
            file: match[1],
            message: match[3] ? `${match[2] || "test"}: ${match[3].trim()}` : `Test failure in ${match[2] || match[1]}`,
            severity: "error",
        });
    }
    // Python Traceback line: File "foo.py", line 42, in ...
    const pyTracebackRegex = /File "([^"]+\.py)", line (\d+)(?:, in [^\n]+)?\n\s*([^\n]+)\n\s*([A-Za-z]+Error: [^\n]+)/g;
    while ((match = pyTracebackRegex.exec(output)) !== null) {
        addDiag({
            file: match[1],
            line: parseInt(match[2], 10),
            message: match[4].trim(),
            severity: "error",
        });
    }
    // 4. Standard GCC / Clang / Go error format:
    // file.c:12:5: error: expected ';'
    // file.go:12:5: undefined: foo
    const genericRegex = /([^\s:]+\.[a-zA-Z0-9_]+):(\d+):(\d+):\s*(?:(error|warning):\s*)?([^\n]+)/g;
    while ((match = genericRegex.exec(output)) !== null) {
        // Avoid double-matching rust or ts lines
        if (!match[1].endsWith(".rs") && !match[1].endsWith(".ts") && !match[1].endsWith(".tsx")) {
            addDiag({
                file: match[1],
                line: parseInt(match[2], 10),
                column: parseInt(match[3], 10),
                severity: (match[4] === "warning" ? "warning" : "error"),
                message: match[5].trim(),
            });
        }
    }
    // 5. Node.js AssertionError with stack trace
    const nodeAssertRegex = /AssertionError(?: \[[^\]]+\])?: ([^\n]+)[\s\S]*?at [^\n]+ \(([^:]+\.(?:test|spec)\.[a-zA-Z0-9_]+):(\d+):(\d+)\)/;
    const nodeMatch = nodeAssertRegex.exec(output);
    if (nodeMatch) {
        addDiag({
            file: nodeMatch[2],
            line: parseInt(nodeMatch[3], 10),
            column: parseInt(nodeMatch[4], 10),
            severity: "error",
            message: `Assertion failure: ${nodeMatch[1].trim()}`,
        });
    }
    return diagnostics;
}
/**
 * Formats extracted diagnostics into clear, actionable hints for the agent context.
 */
export function formatDiagnosticHints(diagnostics) {
    if (!diagnostics || diagnostics.length === 0) {
        return "";
    }
    const lines = [
        "\n\n[Automated Diagnostic Hints & Error Locations]:",
        ...diagnostics.slice(0, 10).map((d) => {
            const loc = d.line ? `:${d.line}${d.column ? `:${d.column}` : ""}` : "";
            const code = d.code ? ` [${d.code}]` : "";
            return `- ${d.file}${loc}${code}: ${d.message}`;
        }),
        "Tip: Use `read_file` or `edit_file` to inspect and fix the listed error locations.",
    ];
    return lines.join("\n");
}
