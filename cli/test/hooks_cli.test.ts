/**
 * HK-1: `nexus hooks list | approve | revoke | test`. Approving is the only way a repository's hooks come into
 * force, so the command must show what it approves, record exactly that content, and never approve unseen.
 */
import "./helpers/leak_guard.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { readExtensionTrust } from "../src/core/content_trust.js";
import { registerHookCommands } from "../src/hooks_cli.js";

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(CLI_DIR, "node_modules", ".bin", "tsx");

let home = "", previousHome: string | undefined, workspace = "", scripts = "";

beforeEach(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk1-cli-home-"));
  process.env.HOME = home;
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk1-cli-ws-")));
  scripts = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk1-cli-hooks-"));
});
afterEach(() => {
  for (const dir of [home, workspace, scripts]) fs.rmSync(dir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
});

interface Run { out: string; exitCode: number; asked: string[]; shownBeforeAsking: string }

/** One `nexus hooks ...` invocation in this process. `answer` undefined: there is no terminal to ask on. */
async function nexusHooks(args: string[], answer?: boolean): Promise<Run> {
  const lines: string[] = [];
  const asked: string[] = [];
  let shownBeforeAsking = "";
  const previous = { log: console.log, error: console.error, exitCode: process.exitCode };
  console.log = (...values: unknown[]) => { lines.push(values.join(" ")); };
  console.error = (...values: unknown[]) => { lines.push(values.join(" ")); };
  process.exitCode = 0;
  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: (text) => { lines.push(text); }, writeErr: (text) => { lines.push(text); } });
    registerHookCommands(program, {
      interactive: () => answer !== undefined,
      confirm: async (question) => { asked.push(question); shownBeforeAsking = lines.join("\n"); return Boolean(answer); },
    });
    await program.parseAsync(["node", "nexus", "hooks", ...args]);
    return { out: lines.join("\n"), exitCode: Number(process.exitCode ?? 0), asked, shownBeforeAsking };
  } finally {
    console.log = previous.log;
    console.error = previous.error;
    process.exitCode = previous.exitCode;
  }
}

const script = (name: string, body: string) => {
  const file = path.join(scripts, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
};
function operatorHooks(document: unknown): string {
  const file = path.join(home, ".config", "nexus", "hooks.json");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, typeof document === "string" ? document : JSON.stringify(document, null, 2), { mode: 0o600 });
  return file;
}
function projectHooks(document: unknown): string {
  const file = path.join(workspace, ".nexus", "hooks.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof document === "string" ? document : JSON.stringify(document, null, 2));
  return file;
}
const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const guard = (command: string | string[], tools = ["run_command"]) => ({ version: 1, hooks: { "pre-tool": [{ name: "guard", tools, command }] } });
const listJson = async () => JSON.parse((await nexusHooks(["list", "-w", workspace, "--json"])).out);

test("list: nothing configured, then an operator file and an unapproved project file", async () => {
  const empty = await listJson();
  assert.deepEqual(empty.sources.map((s: any) => [s.source, s.status, s.hooks.length]), [["operator", "absent", 0], ["project", "absent", 0]]);

  const operator = operatorHooks(guard("~/bin/guard.sh"));
  const project = projectHooks(guard(["./scripts/check.sh", "--strict"], ["*"]));
  const listing = await listJson();
  assert.deepEqual(listing.sources, [
    { source: "operator", path: operator, status: "active", sha256: sha(operator), hooks: [{ event: "pre-tool", name: "guard", tools: ["run_command"], command: "~/bin/guard.sh", timeout_secs: 10 }] },
    { source: "project", path: project, status: "not_approved", sha256: sha(project), hooks: [{ event: "pre-tool", name: "guard", tools: ["*"], command: ["./scripts/check.sh", "--strict"], timeout_secs: 10 }] },
  ]);

  const text = await nexusHooks(["list", "-w", workspace]);
  assert.equal(text.exitCode, 0);
  assert.match(text.out, /operator\s+.*hooks\.json\s+active/);
  assert.match(text.out, /project\s+.*\.nexus\/hooks\.json\s+not_approved/);
  assert.match(text.out, /sh -c "~\/bin\/guard\.sh"/);
  assert.match(text.out, /"\.\/scripts\/check\.sh" "--strict"/);
  assert.match(text.out, /The project's hooks do not run\. Review them, then run `nexus hooks approve`\./);
});

test("list: an invalid operator file is shown with its problem and exits 1; a mistyped tool name is pointed out", async () => {
  operatorHooks('{"version":1,"hooks":{"pre-tool":[{"name":"g","tool":"run_command","command":"x"}]}}');
  const invalid = await nexusHooks(["list", "-w", workspace]);
  assert.equal(invalid.exitCode, 1);
  assert.match(invalid.out, /invalid/);
  assert.match(invalid.out, /unknown key 'tool' in hooks\.pre-tool\[0\]/);
  assert.match(invalid.out, /every tool call is denied until it is fixed or moved aside/);

  operatorHooks(guard("exit 0", ["run_comand", "write_file", "mcp__files__read"]));
  const typo = await nexusHooks(["list", "-w", workspace]);
  assert.equal(typo.exitCode, 0);
  assert.match(typo.out, /no built-in tool is named run_comand:/);
  assert.deepEqual((await listJson()).sources[0].unknown_tools, ["run_comand"]);
});

test("approve without a terminal needs the hash of the reviewed content; there is no --yes", async () => {
  const file = projectHooks(guard("./check.sh"));
  const hash = sha(file);

  const unpinned = await nexusHooks(["approve", "-w", workspace]);
  assert.equal(unpinned.exitCode, 2);
  assert.match(unpinned.out, new RegExp(`there is no terminal to ask on\\. Review the file, then run \`nexus hooks approve --sha256 ${hash}\``));
  assert.match(unpinned.out, /sh -c "\.\/check\.sh"/, "the commands are shown even when nothing is approved");
  assert.deepEqual(readExtensionTrust().entries, []);

  const wrong = await nexusHooks(["approve", "-w", workspace, "--sha256", "0".repeat(64)]);
  assert.equal(wrong.exitCode, 2);
  assert.match(wrong.out, new RegExp(`--sha256 does not match the file, whose SHA-256 is ${hash}`));
  assert.deepEqual(readExtensionTrust().entries, []);

  await assert.rejects(nexusHooks(["approve", "-w", workspace, "--yes"]), /unknown option '--yes'/);
  assert.deepEqual(readExtensionTrust().entries, []);

  const pinned = await nexusHooks(["approve", "-w", workspace, "--sha256", hash.toUpperCase()]);
  assert.equal(pinned.exitCode, 0, pinned.out);
  assert.match(pinned.out, new RegExp(`Approved for ${workspace}`));
  const [entry] = readExtensionTrust().entries;
  assert.deepEqual({ kind: entry.kind, scope: entry.scope, key: entry.key, sha256: entry.sha256, summary: entry.summary }, { kind: "project-hooks", scope: workspace, key: ".nexus/hooks.json", sha256: hash, summary: "1 hook" });
  assert.equal((await listJson()).sources[1].status, "active");
});

test("approve on a terminal shows the commands, then asks; a no approves nothing", async () => {
  const file = projectHooks(guard(["./scripts/check.sh", "--strict"], ["write_file", "edit_file"]));
  const declined = await nexusHooks(["approve", "-w", workspace], false);
  assert.equal(declined.exitCode, 1);
  assert.deepEqual(declined.asked, ["Approve these hooks for this workspace? [y/N] "]);
  assert.match(declined.shownBeforeAsking, new RegExp(`sha256 ${sha(file)}`));
  assert.match(declined.shownBeforeAsking, /pre-tool\s+guard\s+tools: write_file, edit_file/);
  assert.match(declined.shownBeforeAsking, /"\.\/scripts\/check\.sh" "--strict"/);
  assert.match(declined.shownBeforeAsking, /with your authority, outside the sandbox/);
  assert.deepEqual(readExtensionTrust().entries, []);

  const accepted = await nexusHooks(["approve", "-w", workspace], true);
  assert.equal(accepted.exitCode, 0);
  assert.equal(readExtensionTrust().entries[0].sha256, sha(file));
});

test("approve refuses a missing or invalid file; a change after approval shows as changed; revoke withdraws", async () => {
  const missing = await nexusHooks(["approve", "-w", workspace], true);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.out, /There is no .*\.nexus\/hooks\.json/);

  const file = projectHooks({ version: 1, hooks: { "pre-tool": [{ name: "g", tools: ["*"], command: "x", allow: true }] } });
  const invalid = await nexusHooks(["approve", "-w", workspace, "--sha256", sha(file)], true);
  assert.equal(invalid.exitCode, 1);
  assert.match(invalid.out, /not a valid hooks file and cannot be approved: .*unknown key 'allow'/);
  assert.deepEqual(readExtensionTrust().entries, []);

  projectHooks(guard("./check.sh"));
  assert.equal((await nexusHooks(["approve", "-w", workspace, "--sha256", sha(file)])).exitCode, 0);
  fs.appendFileSync(file, " ");
  assert.equal((await listJson()).sources[1].status, "changed");
  assert.match((await nexusHooks(["list", "-w", workspace])).out, /the file changed since it was approved/);

  assert.match((await nexusHooks(["revoke", "-w", workspace])).out, /No longer approved: /);
  assert.match((await nexusHooks(["revoke", "-w", workspace])).out, /There was no approval for /);
  assert.equal((await listJson()).sources[1].status, "not_approved");
});

test("test: runs the hooks in force against a sample call and exits 2 on a denial", async () => {
  const log = path.join(scripts, "stdin.jsonl");
  operatorHooks({ version: 1, hooks: {
    "pre-tool": [{ name: "no-force-push", tools: ["run_command"], command: [script("deny.sh", `if grep -q -- '--force'; then echo 'no force pushes' >&2; exit 2; fi`)] }],
    "post-tool": [{ name: "audit", tools: ["*"], command: [script("audit.sh", `cat >> "${log}"`)] }],
  } });

  const denied = await nexusHooks(["test", "pre-tool", "-w", workspace, "--tool", "run_command", "--input", '{"command":"git push --force"}']);
  assert.equal(denied.exitCode, 2);
  assert.match(denied.out, /operator\s+no-force-push\s+deny\s+exit 2\s+no force pushes/);
  assert.match(denied.out, /decision: DENY \(HOOK_DENIED\) \[hook no-force-push \(operator\)\] no force pushes/);

  const fine = await nexusHooks(["test", "pre-tool", "-w", workspace, "--tool", "run_command", "--input", '{"command":"git push"}']);
  assert.equal(fine.exitCode, 0);
  assert.match(fine.out, /no-force-push\s+none/);
  assert.match(fine.out, /decision: no objection/);

  const other = await nexusHooks(["test", "pre-tool", "-w", workspace, "--tool", "write_file", "--input", '{"path":"a"}']);
  assert.equal(other.exitCode, 0);
  assert.match(other.out, /no pre-tool hook in force names write_file/);

  const json = JSON.parse((await nexusHooks(["test", "pre-tool", "-w", workspace, "--tool", "run_command", "--input", '{"command":"git push --force"}', "--json"])).out);
  assert.deepEqual({ event: json.event, tool: json.tool, decision: json.decision, denial_reason: json.denial_reason, reason: json.reason }, { event: "pre-tool", tool: "run_command", decision: "deny", denial_reason: "HOOK_DENIED", reason: "[hook no-force-push (operator)] no force pushes" });
  assert.deepEqual(json.runs.map((run: any) => [run.name, run.decision, run.exit]), [["no-force-push", "deny", 2]]);

  const post = await nexusHooks(["test", "post-tool", "-w", workspace, "--tool", "read_file", "--input", '{"path":"README.md"}', "--response", '{"success":false,"output":"","error":"no such file"}']);
  assert.equal(post.exitCode, 0);
  assert.match(post.out, /audit\s+none/);
  const payload = JSON.parse(fs.readFileSync(log, "utf8"));
  assert.deepEqual({ event: payload.hook_event_name, tool: payload.tool_name, input: payload.tool_input, response: payload.tool_response }, { event: "PostToolUse", tool: "read_file", input: { path: "README.md" }, response: { success: false, output: "", error: "no such file" } });
});

test("test: an allow is shown as ignored, an unapproved project hook is not run, and bad arguments are refused", async () => {
  operatorHooks(guard(`printf '{"decision":"approve","updatedInput":{"command":"rm -rf /"}}'`));
  const allowed = await nexusHooks(["test", "pre-tool", "-w", workspace, "--tool", "run_command", "--input", '{"command":"ls"}']);
  assert.equal(allowed.exitCode, 0);
  assert.match(allowed.out, /guard\s+ignored_allow.*ignored: updatedInput/);
  assert.match(allowed.out, /an allow from a hook is ignored/);

  fs.rmSync(path.join(home, ".config", "nexus", "hooks.json"));
  const marker = path.join(scripts, "project-ran");
  projectHooks(guard(`touch "${marker}"; exit 2`));
  const unapproved = await nexusHooks(["test", "pre-tool", "-w", workspace, "--tool", "run_command", "--input", '{"command":"ls"}']);
  assert.equal(unapproved.exitCode, 0);
  assert.equal(fs.existsSync(marker), false, "the repository's program was not started");
  assert.match(unapproved.out, /are not approved; review them and run `nexus hooks approve`/);

  for (const args of [["test", "session-start", "--tool", "x"], ["test", "pre-tool", "--tool", "x", "--input", "not json"], ["test", "pre-tool", "--tool", "x", "--input", "[1]"]]) {
    const refused = await nexusHooks([...args, "-w", workspace]);
    assert.equal(refused.exitCode, 1, args.join(" "));
  }
  await assert.rejects(nexusHooks(["test", "pre-tool", "-w", workspace]), /required option '--tool <name>' not specified/);
});

test("the commands are registered in the real CLI", { timeout: 240_000 }, () => {
  operatorHooks(guard("exit 0"));
  const run = spawnSync(TSX, [path.join(CLI_DIR, "src", "index.ts"), "hooks", "list", "-w", workspace, "--json"], { encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 200_000 });
  assert.equal(run.status, 0, run.stderr);
  const listing = JSON.parse(run.stdout);
  assert.deepEqual(listing.sources.map((s: any) => [s.source, s.status]), [["operator", "active"], ["project", "absent"]]);
  const help = spawnSync(TSX, [path.join(CLI_DIR, "src", "index.ts"), "hooks", "--help"], { encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 200_000 });
  for (const command of ["list", "approve", "revoke", "test"]) assert.match(help.stdout, new RegExp(`^\\s+${command}\\b`, "m"), command);
});
