#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const nexusBinary = process.argv[2] ? path.resolve(process.argv[2]) : "nexus";

const docFiles = [
  "README.md",
  "quickstart.md",
  "docs/USER_MANUAL.md",
  "docs/CLIENT_GUIDE.md",
  "docs/CLOUD_PROVIDERS.md",
];

function splitWords(cmd) {
  const tokens = [];
  let current = "";
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (c === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (/\s/.test(c) && !inDouble && !inSingle) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += c;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

const commandsToTest = [];

for (const relPath of docFiles) {
  const absPath = path.resolve(repoRoot, relPath);
  if (!fs.existsSync(absPath)) {
    console.warn(`Warning: doc file not found: ${relPath}`);
    continue;
  }
  const content = fs.readFileSync(absPath, "utf-8");
  const fenceRegex = /```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g;
  let match;
  while ((match = fenceRegex.exec(content)) !== null) {
    const block = match[1];
    for (const rawLine of block.split("\n")) {
      const stripped = rawLine.replace(/#.*$/, "").trim();
      if (!stripped) continue;
      // Skip interactive shell prompts
      if (stripped.startsWith("nexus (") || stripped.includes(" ❯ ")) continue;
      if (stripped === "nexus" || stripped.startsWith("nexus ") || stripped.startsWith("./nexus ")) {
        commandsToTest.push({ file: relPath, raw: stripped });
      }
    }
  }
}

if (commandsToTest.length === 0) {
  console.error("Error: No doc commands found to test.");
  process.exit(1);
}

console.log(`Extracted ${commandsToTest.length} commands across ${docFiles.length} doc files.`);

let failed = 0;

for (const item of commandsToTest) {
  const tokens = splitWords(item.raw);
  // Shift off the binary name ("nexus" or "./nexus")
  tokens.shift();

  // If command does not already contain --help or -h, append --help so it parses without side effects
  const hasHelp = tokens.includes("--help") || tokens.includes("-h");
  const testArgs = hasHelp ? tokens : [...tokens, "--help"];

  const res = spawnSync(nexusBinary, testArgs, {
    encoding: "utf-8",
    env: { ...process.env, NEXUS_TEST_PARSING_ONLY: "1" },
  });

  const combined = (res.stdout || "") + (res.stderr || "");
  const hasUnknownCommand = /unknown command/i.test(combined);
  const hasUnknownOption = /unknown option/i.test(combined);

  if (res.status !== 0 || hasUnknownCommand || hasUnknownOption) {
    console.error(`FAIL [${item.file}]: ${item.raw}`);
    console.error(`  exit code: ${res.status}`);
    if (res.stderr) console.error(`  stderr: ${res.stderr.trim()}`);
    if (res.stdout) console.error(`  stdout: ${res.stdout.trim().slice(0, 300)}`);
    failed++;
  } else {
    console.log(`PASS [${item.file}]: ${item.raw}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} command(s) failed parsing verification.`);
  process.exit(1);
}

console.log(`\nDOC_COMMANDS_PASS (${commandsToTest.length} commands verified)`);
