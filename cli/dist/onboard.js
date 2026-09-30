import * as fs from "node:fs";
import * as path from "node:path";
/**
 * Scan workspace to detect project structure, tech stack, and build scripts (Candidate #46)
 */
export function scanAndOnboardWorkspace(workspace, writeToFile = true) {
    const root = path.resolve(workspace);
    const languages = new Set();
    const buildCommands = [];
    const testCommands = [];
    const lintCommands = [];
    let projectName = path.basename(root);
    let projectType = "Generic Software Project";
    // 1. Cargo.toml (Rust)
    const cargoPath = path.join(root, "Cargo.toml");
    const coreCargoPath = path.join(root, "core", "Cargo.toml");
    if (fs.existsSync(cargoPath) || fs.existsSync(coreCargoPath)) {
        languages.add("Rust");
        projectType = "Rust / Multi-Language Project";
        buildCommands.push("cargo build");
        testCommands.push("cargo test");
        lintCommands.push("cargo clippy");
        const p = fs.existsSync(cargoPath) ? cargoPath : coreCargoPath;
        try {
            const content = fs.readFileSync(p, "utf-8");
            const match = content.match(/name\s*=\s*"([^"]+)"/);
            if (match && (projectName === path.basename(root) || fs.existsSync(cargoPath)))
                projectName = match[1];
        }
        catch { }
    }
    // 2. package.json (Node / TypeScript / JavaScript)
    const pkgPath = path.join(root, "package.json");
    const cliPkgPath = path.join(root, "cli", "package.json");
    if (fs.existsSync(pkgPath) || fs.existsSync(cliPkgPath)) {
        languages.add("TypeScript / JavaScript");
        const p = fs.existsSync(pkgPath) ? pkgPath : cliPkgPath;
        try {
            const raw = fs.readFileSync(p, "utf-8");
            const parsed = JSON.parse(raw);
            if (parsed.name && projectName === path.basename(root))
                projectName = parsed.name;
            if (parsed.scripts) {
                if (parsed.scripts.build)
                    buildCommands.push("npm run build");
                if (parsed.scripts.test)
                    testCommands.push("npm test");
                if (parsed.scripts.lint)
                    lintCommands.push("npm run lint");
            }
        }
        catch { }
    }
    // 3. Python (pyproject.toml, requirements.txt, setup.py)
    if (fs.existsSync(path.join(root, "pyproject.toml")) ||
        fs.existsSync(path.join(root, "requirements.txt")) ||
        fs.existsSync(path.join(root, "setup.py"))) {
        languages.add("Python");
        testCommands.push("pytest");
        lintCommands.push("ruff check .");
    }
    // 4. Go (go.mod)
    if (fs.existsSync(path.join(root, "go.mod"))) {
        languages.add("Go");
        buildCommands.push("go build ./...");
        testCommands.push("go test ./...");
    }
    // 5. Makefile
    if (fs.existsSync(path.join(root, "Makefile"))) {
        try {
            const makeContent = fs.readFileSync(path.join(root, "Makefile"), "utf-8");
            if (makeContent.includes("build:") && !buildCommands.includes("make build")) {
                buildCommands.unshift("make build");
            }
            if (makeContent.includes("test:") && !testCommands.includes("make test")) {
                testCommands.unshift("make test");
            }
            if (makeContent.includes("lint:") && !lintCommands.includes("make lint")) {
                lintCommands.unshift("make lint");
            }
        }
        catch { }
    }
    // Discover key directories
    const keyDirs = [];
    try {
        const entries = fs.readdirSync(root, { withFileTypes: true });
        for (const ent of entries) {
            if (ent.isDirectory() &&
                !ent.name.startsWith(".") &&
                !["node_modules", "target", "dist", "build", "coverage"].includes(ent.name)) {
                keyDirs.push(ent.name);
            }
        }
    }
    catch { }
    // Generate Mermaid diagram
    let diagram = "```mermaid\ngraph TD\n";
    diagram += `  Root["${projectName}"]\n`;
    for (const d of keyDirs) {
        diagram += `  Root --> ${d.replace(/[^a-zA-Z0-9]/g, "_")}["${d}/"]\n`;
    }
    diagram += "```";
    // Generate AGENTS.md content
    const agentsMd = `# Project Guidelines & Agent Instructions

## Overview
- **Project Name:** ${projectName}
- **Tech Stack:** ${Array.from(languages).join(", ") || "General"}
- **Detected Structure:** ${keyDirs.join(", ") || "Standard"}

## Commands
- Build: \`${buildCommands[0] || "make build"}\`
- Test: \`${testCommands[0] || "npm test"}\`
- Lint: \`${lintCommands[0] || "npm run lint"}\`

## Directory Layout
${keyDirs.map((d) => `- \`${d}/\`: Module component`).join("\n")}

## Architecture
${diagram}

## Code Conventions
- Maintain documentation integrity and preserve existing comments.
- Always run tests after making changes to verify correctness.
- Keep functions modular and clearly typed.
`;
    if (writeToFile) {
        const targetFile = path.join(root, "AGENTS.md");
        fs.writeFileSync(targetFile, agentsMd, "utf-8");
    }
    return {
        projectName,
        projectType,
        languages: Array.from(languages),
        buildCommands,
        testCommands,
        lintCommands,
        keyDirectories: keyDirs,
        architectureDiagram: diagram,
        agentsMdContent: agentsMd,
    };
}
