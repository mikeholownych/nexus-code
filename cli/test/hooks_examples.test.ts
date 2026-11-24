/**
 * HK-1, gate G-6: the hooks documentation and example are exercised, so they stay true to the product. The example
 * script runs through a shim of the real CLI; every sample in docs/HOOKS.md is fed to the code it describes.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { createDefaultRegistry } from "../src/core/capabilities.js";
import { hookEnvironment, reduceHookOutput, runHookProcess } from "../src/core/hook_runner.js";
import { HOOKS_SCHEMA_VERSION, parseHooksFile } from "../src/core/hooks.js";
import { registerHookCommands } from "../src/hooks_cli.js";
import { hooksSchemaFile } from "../scripts/gen_hooks_schema.mjs";
import { validate } from "./helpers/json_schema.js";

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(CLI_DIR, "..");
const TSX = path.join(CLI_DIR, "node_modules", ".bin", "tsx");
const EXAMPLE = path.join(ROOT, "examples", "hooks");
const DOC = fs.readFileSync(path.join(ROOT, "docs", "HOOKS.md"), "utf8");
const schema = JSON.parse(fs.readFileSync(hooksSchemaFile(HOOKS_SCHEMA_VERSION), "utf8"));

/** The fenced blocks of the document whose info string starts with `info`, with the rest of the info string. */
function blocks(info: string): Array<{ attrs: Record<string, string>; text: string }> {
  const found: Array<{ attrs: Record<string, string>; text: string }> = [];
  const fence = /```([^\n]*)\n([\s\S]*?)```/g;
  for (let match = fence.exec(DOC); match; match = fence.exec(DOC)) {
    if (!match[1].startsWith(info)) continue;
    const attrs = Object.fromEntries(match[1].slice(info.length).trim().split(/\s+/).filter(Boolean).map((pair) => pair.split("=") as [string, string]));
    found.push({ attrs, text: match[2] });
  }
  return found;
}

test("examples/hooks/run.sh installs the hook and shows it deny a forced push, through the real CLI", { timeout: 280_000 }, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk1-example-"));
  try {
    const shim = path.join(scratch, "nexus");
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${TSX}" "${path.join(CLI_DIR, "src", "index.ts")}" "$@"\n`, { mode: 0o755 });
    // HOME is replaced by the script itself; this one only keeps anything it reads before that away from the real one.
    const run = spawnSync("bash", [path.join(EXAMPLE, "run.sh")], { encoding: "utf8", env: { ...process.env, HOME: scratch, NEXUS: shim, NO_COLOR: "1" }, timeout: 260_000 });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /operator\s+\S+\/\.config\/nexus\/hooks\.json\s+active/);
    assert.match(run.stdout, /pre-tool\s+no-force-push\s+tools: run_command\s+timeout: 10s/);
    assert.match(run.stdout, /--- an ordinary push: the hook has no objection\n\s+operator\s+no-force-push\s+none\s+exit 0\ndecision: no objection/);
    assert.match(run.stdout, /decision: DENY \(HOOK_DENIED\) \[hook no-force-push \(operator\)\] force pushes are not allowed from an agent session/);
    assert.match(run.stdout, /denied, as it should be \(exit status 2\)\n$/);
    assert.deepEqual(fs.readdirSync(scratch), ["nexus"], "the script wrote nothing into the HOME it was started with");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("the example hooks file and the one in the documentation are valid hooks files", () => {
  const example = fs.readFileSync(path.join(EXAMPLE, "hooks.json"), "utf8");
  assert.deepEqual(validate(parseHooksFile(example), schema.$defs.HooksFile, schema), []);
  assert.ok(fs.statSync(path.join(EXAMPLE, "deny-force-push.sh")).mode & 0o100, "the example hook is executable");
  const documented = blocks("json hooks-file");
  assert.equal(documented.length, 1);
  for (const { text } of documented) assert.deepEqual(validate(parseHooksFile(text), schema.$defs.HooksFile, schema), []);
});

test("the sample payloads of the documentation get the documented decision from the example hook", async () => {
  const samples = blocks("json hook-input");
  assert.deepEqual(samples.map((sample) => sample.attrs.expect).sort(), ["deny", "deny", "none"]);
  assert.ok(samples.some((sample) => sample.attrs.shape === "claude-code"), "one sample has the shape Claude Code sends");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk1-example-"));
  try {
    for (const { attrs, text } of samples) {
      const payload = JSON.parse(text);
      // A payload of another tool's shape lacks Nexus's own members; the hook must decide on it all the same.
      if (attrs.shape !== "claude-code") assert.deepEqual(validate(payload, schema.$defs.HookInput, schema), [], text);
      const result = await runHookProcess({ command: [path.join(EXAMPLE, "deny-force-push.sh")], cwd: dir, env: hookEnvironment({ event: "pre-tool", name: "no-force-push", source: "operator", workspace: dir }), stdin: JSON.stringify(payload), timeoutMs: 60_000 });
      const verdict = reduceHookOutput(result);
      assert.equal(verdict.decision, attrs.expect, `${payload.tool_input.command}: ${JSON.stringify(verdict)}`);
      if (attrs.expect === "deny") assert.match(verdict.reason ?? "", /force pushes are not allowed/);
    }
    // Further commands the example must and must not refuse.
    const decide = async (command: string) => reduceHookOutput(await runHookProcess({ command: [path.join(EXAMPLE, "deny-force-push.sh")], cwd: dir, env: hookEnvironment({ event: "pre-tool", name: "n", source: "operator", workspace: dir }), stdin: JSON.stringify({ tool_name: "run_command", tool_input: { command } }), timeoutMs: 60_000 })).decision;
    for (const command of ["git push --force", "git push origin main --force-with-lease", "cd repo && git push -f origin HEAD", 'git -C "/tmp/a b" push origin --force']) assert.equal(await decide(command), "deny", command);
    for (const command of ["git push", "git push origin feature-fix", "git status", "rm -f build.log", "git commit -m 'no force'"]) assert.equal(await decide(command), "none", command);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the sample answers of the documentation reduce to the documented decision", () => {
  const samples = blocks("json hook-output");
  assert.deepEqual(samples.map((sample) => sample.attrs.expect).sort(), ["deny", "deny", "ignored_allow"]);
  for (const { attrs, text } of samples) {
    assert.deepEqual(validate(JSON.parse(text), schema.$defs.HookOutput, schema), [], text);
    assert.equal(reduceHookOutput({ exit: 0, signal: null, stdout: text, stderr: "" }).decision, attrs.expect, text);
  }
});

test("every `nexus hooks` command line in the documentation and the manual parses", () => {
  const manual = fs.readFileSync(path.join(ROOT, "docs", "USER_MANUAL.md"), "utf8");
  const fences = [DOC, manual].flatMap((text) => [...text.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)]).filter((match) => ["", "bash", "console"].includes(match[1].trim()));
  const lines = fences.flatMap((match) => match[2].split("\n")).map((line) => line.replace(/\s+#.*$/, "").trim()).filter((line) => line.startsWith("nexus hooks "));
  assert.ok(lines.length >= 6, `found ${lines.length} command lines`);
  for (const line of lines) {
    const args = (line.match(/'[^']*'|\S+/g) ?? []).slice(1).map((word) => word.replace(/^'|'$/g, ""));
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerHookCommands(program);
    assert.throws(() => program.parse(["node", "nexus", ...args, "--help"]), (error: any) => error?.code === "commander.helpDisplayed", line);
  }
});

test("the Nexus tool names the documentation maps other tools' names to are real tools", () => {
  const row = DOC.split("\n").find((line) => line.startsWith("| Tool names in `tool_name`"));
  assert.ok(row);
  const nexusNames = [...row!.split("|")[3].matchAll(/`([a-z_]+)`/g)].map((match) => match[1]);
  assert.ok(nexusNames.length >= 9);
  const registry = createDefaultRegistry();
  for (const name of nexusNames) assert.ok(registry.getByToolName(name), `${name} is a registered tool`);
});
