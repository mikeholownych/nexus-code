/**
 * HK-3 review of PR #808: operator plugin directories are protected from the agent's file tools; names that come from
 * a repository reach the terminal with no control characters; a plugin's tree is bounded and read once while it does
 * not change; and the approval store has one writer at a time.
 */
import "./helpers/leak_guard.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AutonomousAgent } from "../src/agent.js";
import { approveExtension, readExtensionTrust } from "../src/core/content_trust.js";
import { HookRegistry } from "../src/core/hooks.js";
import { hasUnprintable, printable } from "../src/core/printable.js";
import { inspectWorkspaceManifestPlugins, workspacePluginReads } from "../src/core/workspace_plugins.js";
import { diagnoseWorkspacePlugins } from "../src/doctor_plugins.js";
import { PluginManager, operatorDirInWorkspace, pluginFileSha256, workspacePluginTrustId } from "../src/plugins.js";
import { closeLoadedPluginManagersAfterTests } from "./helpers/plugin_manager_cleanup.js";

closeLoadedPluginManagersAfterTests();
import { trustWorkspacePlugin } from "../src/plugins_cli.js";
import { setWorkspaceTrusted } from "../src/workspace_trust.js";
import { dispatch, hookAgent } from "./helpers/hooks_fixture.js";
import { policyWorld } from "./helpers/policy_enforcement.js";

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(CLI_DIR, "node_modules", ".bin", "tsx");

let base = "", home = "", ws = "", stateDir = "", previousHome: string | undefined, previousEnvTrust: string | undefined;
let agents: AutonomousAgent[] = [];
let seq = 0;

beforeEach(() => {
  previousHome = process.env.HOME;
  previousEnvTrust = process.env.NEXUS_TRUST_WORKSPACE;
  delete process.env.NEXUS_TRUST_WORKSPACE;
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk3-review-")));
  home = path.join(base, "home");
  ws = path.join(base, "ws");
  stateDir = path.join(base, "state");
  for (const dir of [home, ws, stateDir]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(ws, "a.txt"), "hello\n");
  fs.writeFileSync(path.join(home, "a.txt"), "hello\n");
  process.env.HOME = home;
});
afterEach(() => {
  for (const agent of agents) agent.shutdown();
  agents = [];
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousEnvTrust === undefined) delete process.env.NEXUS_TRUST_WORKSPACE; else process.env.NEXUS_TRUST_WORKSPACE = previousEnvTrust;
  fs.rmSync(base, { recursive: true, force: true });
});

function agentFor(repo: string): AutonomousAgent {
  const agent = hookAgent({ repo, stateDir, mode: "auto", fullAccess: true });
  agents.push(agent);
  return agent;
}
function write(file: string, content: string, mode = 0o644): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
  return file;
}
const none = () => policyWorld({}).host.managed().effective;
const module_ = (name: string) => `export default { name: ${JSON.stringify(name)}, description: "t${++seq}" };\n`;
/** Fails unless `text` could be sent to a terminal as it is: no control or formatting character but the line feed. */
function assertPrintable(text: string, what: string): void {
  const lines = text.split("\n");
  for (const line of lines) assert.ok(!hasUnprintable(line), `${what}: a raw control character in ${JSON.stringify(line)}`);
  assert.ok(!lines.some((line) => /^nexus: APPROVED ALL/.test(line)), `${what}: a forged line`);
}

test("the operator's plugin directories are protected paths for the agent's file tools, in any workspace", async () => {
  const statePlugins = path.join(home, ".nexus", "plugins");
  const configPlugins = path.join(home, ".config", "nexus", "plugins");
  const pwned = path.join(home, "PWNED");
  const planted = `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(pwned)}, "x");\nexport default { name: "planted" };\n`;

  // The workspace is the home directory: the reproduced case.
  const atHome = agentFor(home);
  const security = (atHome as any).bridge.getSecurityManager();
  for (const target of [".nexus/plugins/x.mjs", ".config/nexus/plugins/y.mjs", path.join(statePlugins, "x.mjs"), path.join(configPlugins, "sub", "y.js"), ".nexus/plugins", ".nexus/../.nexus/plugins/x.mjs", ".NEXUS/plugins/x.mjs".toLowerCase()]) {
    assert.equal(security.isPathProtected(target).protected, true, target);
  }
  for (const [tool, args] of [
    ["write_file", { path: ".nexus/plugins/x.mjs", content: planted }],
    ["write_file", { path: ".config/nexus/plugins/y.mjs", content: planted }],
    ["write_file", { path: path.join(statePlugins, "z.mjs"), content: planted }],
  ] as const) {
    const refused = await dispatch(atHome, tool, args);
    assert.equal(refused.success, false, `${tool} ${args.path}`);
    assert.match(refused.error ?? "", /protected/, args.path);
  }
  assert.equal(fs.existsSync(statePlugins), false);
  assert.equal(fs.existsSync(configPlugins), false);
  // An existing operator plugin can be neither edited nor deleted, nor its directory removed.
  const mine = write(path.join(statePlugins, "mine.mjs"), module_("mine"));
  const edit = await dispatch(atHome, "edit_file", { path: ".nexus/plugins/mine.mjs", old_content: "mine", new_content: "evil" });
  assert.equal(edit.success, false);
  for (const target of [".nexus/plugins/mine.mjs", ".nexus/plugins", ".nexus"]) {
    const removed = await dispatch(atHome, "delete_file", { path: target, recursive: true });
    assert.equal(removed.success, false, target);
  }
  assert.equal(fs.readFileSync(mine, "utf8").includes("mine"), true);
  // Written by another route (a shell command, say), it is still not loaded there.
  write(path.join(statePlugins, "x.mjs"), planted);
  const pm = new PluginManager(home, { trusted: true, notify: () => {} });
  await pm.loadPlugins();
  assert.deepEqual(pm.listPlugins(), []);
  assert.equal(fs.existsSync(pwned), false);

  // A project workspace: the same paths are protected by their absolute form; the workspace's own are not.
  const inProject = (agentFor(ws) as any).bridge.getSecurityManager();
  assert.equal(inProject.isPathProtected(path.join(statePlugins, "x.mjs")).protected, true);
  assert.equal(inProject.isPathProtected(path.join(configPlugins, "y.mjs")).protected, true);
  assert.equal(inProject.isPathProtected(".nexus/plugins/a.mjs").protected, false, "a repository's own plugin files stay editable (a change makes them inactive)");
  assert.equal(inProject.isPathProtected("plugins/a.mjs").protected, false);
});

test("inside the workspace is decided by real containment, not by how a path begins", () => {
  const dir = path.join(home, ".nexus", "plugins");
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(operatorDirInWorkspace(dir, home), true);
  assert.equal(operatorDirInWorkspace(dir, base), true, "a workspace that holds the home directory");
  assert.equal(operatorDirInWorkspace(dir, path.join(home, "sub", "..")), true, "`..` in the workspace path");
  assert.equal(operatorDirInWorkspace(dir, ws), false);
  // `<home>2` begins like `<home>`: it is another directory.
  fs.mkdirSync(`${home}2`);
  assert.equal(operatorDirInWorkspace(dir, `${home}2`), false);
  process.env.HOME = `${ws}2`;
  fs.mkdirSync(path.join(`${ws}2`, ".nexus", "plugins"), { recursive: true });
  assert.equal(operatorDirInWorkspace(path.join(`${ws}2`, ".nexus", "plugins"), ws), false, "/ws against /ws2");
  // Reached through a link, in either direction.
  const link = path.join(base, "link-to-home");
  fs.symlinkSync(home, link);
  assert.equal(operatorDirInWorkspace(dir, link), true);
  const linkedDir = path.join(ws, "linked-plugins");
  fs.symlinkSync(dir, linkedDir);
  assert.equal(operatorDirInWorkspace(linkedDir, home), true);
});

test("names from a repository reach the terminal with no control characters", { timeout: 240_000 }, async () => {
  assert.equal(printable("a\nnexus: APPROVED ALL\x1b[5A\x1b[2K‮⁦x\x7f\u0085"), "a\\u000anexus: APPROVED ALL\\u001b[5A\\u001b[2K\\u202e\\u2066x\\u007f\\u0085");
  assert.equal(printable("x".repeat(500)).length, 300);
  setWorkspaceTrusted(ws, true);
  const hostile = ["a\nnexus: APPROVED ALL", "b\x1b[5A\x1b[2Kc", "c‮gpj.mjs⁦"];
  const dir = path.join(ws, ".nexus", "plugins");
  for (const name of hostile) write(path.join(dir, `${name}.mjs`), module_(name));
  // One that is approved and fails to load, one that is unreadable, one that takes an operator plugin's name.
  const failing = write(path.join(dir, "f\x1b[2Jail\n.mjs"), `throw new Error("boom\\u001b[2J\\nnexus: APPROVED ALL");\n`);
  const shadow = write(path.join(dir, "s\x1b[1Ahadow.mjs"), module_("taken\x1b[2K\nnexus: APPROVED ALL"));
  fs.symlinkSync("/etc/hostname", path.join(dir, "l\x1b[2Kink\n.mjs"));
  write(path.join(base, "operator-home", ".nexus", "plugins", "mine.mjs"), module_("taken\x1b[2K\nnexus: APPROVED ALL"));
  for (const file of [failing, shadow]) {
    const id = workspacePluginTrustId(ws, file);
    approveExtension({ kind: "workspace-plugin", scope: id.scope, key: id.key, sha256: pluginFileSha256(file), approvedAt: new Date().toISOString(), summary: "x" });
  }
  // The exact bytes the loader's notices put on the stream.
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (chunk: any) => { written.push(String(chunk)); return true; };
  try {
    // The operator's plugin of the same name lives in another home; switch for the load, as the loader reads it then.
    fs.cpSync(path.join(base, "operator-home", ".nexus"), path.join(home, ".nexus"), { recursive: true });
    const pm = new PluginManager(ws);
    await pm.loadPlugins();
    assert.deepEqual(pm.getPluginTrustRecords().map((record) => record.status).sort(), ["global", "invalid", "load-failed", "shadowed", "untrusted", "untrusted", "untrusted"]);
  } finally {
    (process.stderr as any).write = original;
  }
  const stream = written.join("");
  assert.match(stream, /3 workspace plugins are not loaded/);
  assert.match(stream, /failed to load and is not active/);
  assert.match(stream, /is not used: the operator's plugin/);
  assert.match(stream, /is not loaded: the file must not be a symbolic link/);
  assert.match(stream, /nexus plugins trust \.nexus\/plugins\/a\\u000anexus: APPROVED ALL\.mjs/);
  assertPrintable(stream, "loader notices");

  // The doctor's finding, and `nexus plugins list` as a terminal would get it.
  const doctor = diagnoseWorkspacePlugins(ws);
  assertPrintable([doctor.explanation, ...doctor.evidence, doctor.action ?? ""].join("\n"), "doctor");
  assert.match(doctor.evidence.join("\n"), /\\u001b\[5A\\u001b\[2K/);
  const listed = spawnSync(TSX, [path.join(CLI_DIR, "src", "index.ts"), "plugins", "list", "-w", ws], { encoding: "utf8", env: { ...process.env, HOME: home, NO_COLOR: "1" }, timeout: 200_000 });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /Plugins not active/);
  assertPrintable(listed.stdout, "plugins list (stdout)");
  assertPrintable(listed.stderr, "plugins list (stderr)");

  // `nexus plugins trust <file>` shows the path it is asked about.
  const out: string[] = [];
  await trustWorkspacePlugin(ws, path.join(".nexus", "plugins", `${hostile[1]}.mjs`), {}, { interactive: () => false, confirm: async () => true, log: (line) => out.push(line), error: (line) => out.push(line) });
  assertPrintable(out.join("\n"), "plugins trust <file>");
});

test("a manifest plugin's file names cannot rewrite what the operator is shown at approval, nor a notice", async () => {
  setWorkspaceTrusted(ws, true);
  const dir = path.join(ws, ".nexus", "plugins", "guard");
  write(path.join(dir, "nexus-plugin.json"), JSON.stringify({ version: 1, name: "guard", pluginVersion: "1", permissions: ["hooks", "skills"], contributions: { hooks: ["hooks.json"], skills: ["skills/s"] } }));
  write(path.join(dir, "hooks.json"), JSON.stringify({ version: 1, hooks: { "pre-tool": [{ name: "check", tools: ["write_file"], command: ["./check.sh"] }] } }));
  write(path.join(dir, "check.sh"), "#!/bin/sh\nexit 0\n", 0o755);
  write(path.join(dir, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nx\n");
  // A skill file whose name moves the cursor up over the hook lines and clears them, then forges a line.
  const evilName = "z\x1b[5A\x1b[2K\nnexus: APPROVED ALL‮";
  write(path.join(dir, "skills", "s", evilName), "x\n");
  const out: string[] = [];
  const code = await trustWorkspacePlugin(ws, ".nexus/plugins/guard", {}, { interactive: () => true, confirm: async () => true, log: (line) => out.push(line), error: (line) => out.push(line), policy: none });
  assert.equal(code, 0, out.join("\n"));
  const shown = out.join("\n");
  assert.match(shown, /skills\/s\/z\\u001b\[5A\\u001b\[2K\\u000anexus: APPROVED ALL\\u202e {2}sha256 [0-9a-f]{64}/);
  assertPrintable(shown, "plugins trust <dir>");

  // The file changes: the notice that names it is printable too, and says it loudly, once.
  fs.appendFileSync(path.join(dir, "skills", "s", evilName), "more\n");
  const notices: string[] = [];
  const registry = new HookRegistry({ workspace: () => ws, readOnly: () => false, permissionMode: () => "auto", sessionId: () => "t", notify: (text) => notices.push(text), policy: none, workspaceTrusted: () => true });
  for (let i = 0; i < 3; i++) await registry.preToolAdmission({ invocationId: `c${i}`, toolName: "write_file", args: {} }, { workspaceRoot: ws, metadata: {} });
  assert.equal(notices.length, 1, "once per session");
  assert.match(notices[0], /^nexus: WARNING: workspace plugin guard is NO LONGER IN FORCE: \.nexus\/plugins\/guard\/skills\/s\/z\\u001b\[5A.* changed since it was approved\. Its hooks do not run\./);
  assertPrintable(notices[0], "changed notice");
  assertPrintable(JSON.stringify(diagnoseWorkspacePlugins(ws)), "doctor");
});

test("a plugin's tree is bounded: too many directories, too deep, too large are refused without reading them", () => {
  const inspect = () => inspectWorkspaceManifestPlugins({ workspace: ws, readOnly: false, trusted: true, policy: none, approvals: [] });
  const dir = path.join(ws, ".nexus", "plugins", "big");
  const manifest = () => write(path.join(dir, "nexus-plugin.json"), JSON.stringify({ version: 1, name: "big", pluginVersion: "1", permissions: ["hooks"] }));
  const fresh = () => { fs.rmSync(dir, { recursive: true, force: true }); manifest(); };

  // 50,000 empty directories: one listing, then refused.
  fresh();
  for (let i = 0; i < 50_000; i++) fs.mkdirSync(path.join(dir, `d${i}`));
  let best = Infinity;
  for (let round = 0; round < 3; round++) {
    const started = process.hrtime.bigint();
    const [found] = inspect();
    best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
    assert.equal(found.status, "invalid");
    assert.match(found.problem ?? "", /the directory holds 50001 entries; a plugin holds at most 64 files in 256 directories/);
  }
  assert.ok(best < 200, `refused in ${best.toFixed(1)} ms`);

  // Spread over nested directories, each small.
  fresh();
  for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) fs.mkdirSync(path.join(dir, `a${i}`, `b${j}`), { recursive: true });
  assert.match(inspect()[0].problem ?? "", /holds more than 256 directories/);
  fresh();
  fs.mkdirSync(path.join(dir, ...Array.from({ length: 9 }, (_, i) => `l${i}`)), { recursive: true });
  assert.match(inspect()[0].problem ?? "", /nested more than 8 levels deep/);

  // 60 files of 1 MiB: refused by their sizes, without a byte being read.
  fresh();
  for (let i = 0; i < 60; i++) {
    const fd = fs.openSync(path.join(dir, `f${i}.bin`), "w");
    fs.ftruncateSync(fd, 1024 * 1024);
    fs.closeSync(fd);
  }
  const reads = workspacePluginReads.count;
  const started = process.hrtime.bigint();
  const [large] = inspect();
  assert.match(large.problem ?? "", /holds more than 8 MiB, or a file of more than 1 MiB/);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 200);
  assert.equal(workspacePluginReads.count, reads, "nothing was read or hashed");
  fresh();
  for (let i = 0; i < 65; i++) fs.writeFileSync(path.join(dir, `f${i}`), "");
  assert.match(inspect()[0].problem ?? "", /holds more than 64 files/);

  // Tens of thousands of entries beside the plugins: only the first few hundred names are looked at.
  fs.rmSync(dir, { recursive: true, force: true });
  for (let i = 0; i < 20_000; i++) fs.mkdirSync(path.join(ws, ".nexus", "plugins", `n${i}`));
  const before = process.hrtime.bigint();
  assert.deepEqual(inspect(), []);
  assert.ok(Number(process.hrtime.bigint() - before) / 1e6 < 500);
});

test("an unchanged tree is read once; any change, even with size and modification time put back, is read again", () => {
  const dir = path.join(ws, ".nexus", "plugins", "guard");
  write(path.join(dir, "nexus-plugin.json"), JSON.stringify({ version: 1, name: "guard", pluginVersion: "1", permissions: ["hooks", "skills"], contributions: { hooks: ["hooks.json"], skills: ["skills/s"] } }));
  write(path.join(dir, "hooks.json"), JSON.stringify({ version: 1, hooks: { "pre-tool": [{ name: "check", tools: ["write_file"], command: ["./check.sh"] }] } }));
  const script = write(path.join(dir, "check.sh"), "#!/bin/sh\nexit 0\n", 0o755);
  write(path.join(dir, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nx\n");
  // 64 files in all.
  for (let i = 0; i < 60; i++) write(path.join(dir, "skills", "s", `note${i}.md`), `note ${i}\n`.repeat(50));
  const policy = none();
  const inspect = () => inspectWorkspaceManifestPlugins({ workspace: ws, readOnly: false, trusted: true, policy: () => policy, approvals: [] })[0];
  const first = inspect();
  assert.equal(first.status, "not_approved", first.problem);
  assert.equal(first.files.length, 64);

  const reads = workspacePluginReads.count;
  let best = Infinity;
  for (let round = 0; round < 5; round++) {
    const started = process.hrtime.bigint();
    for (let i = 0; i < 100; i++) assert.equal(inspect().digest, first.digest);
    best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
  }
  assert.equal(workspacePluginReads.count, reads, "500 inspections of an unchanged tree read and hashed nothing");
  // What is left per inspection is one stat per file (64 here, the most a plugin may hold): about a millisecond on a
  // busy host, against tens of milliseconds for reading and hashing. The bound is loose so that load cannot fail it.
  assert.ok(best < 400, `100 inspections took ${best.toFixed(1)} ms`);
  console.log(`# 100 inspections of an unchanged 64-file tree: ${best.toFixed(1)} ms`);

  // One byte changed, the size the same, the modification time put back: the change time gives it away.
  const before = fs.statSync(script, { bigint: true });
  fs.utimesSync(script, 1_700_000_000, 1_700_000_000);
  const baseline = inspect();
  fs.writeFileSync(script, "#!/bin/sh\nexit 1\n");
  fs.utimesSync(script, 1_700_000_000, 1_700_000_000);
  const after = fs.statSync(script, { bigint: true });
  assert.deepEqual([after.size, after.ino], [before.size, before.ino], "the fixture: same size, same file");
  const changed = inspect();
  assert.notEqual(changed.digest, baseline.digest, "the new bytes were read: nothing stale was served");
  // A file added, a file removed, a mode changed: each is a different tree.
  const digests = new Set([first.digest, baseline.digest, changed.digest]);
  fs.rmSync(path.join(dir, "skills", "s", "note0.md"));
  digests.add(inspect().digest);
  write(path.join(dir, "skills", "s", "note0.md"), "other\n");
  digests.add(inspect().digest);
  assert.equal(digests.size, 4, "first and baseline are the same content; the other three differ");
  // An invalid tree is remembered as invalid, and becomes valid again when it is repaired.
  fs.rmSync(path.join(dir, "skills", "s", "note1.md"));
  write(path.join(dir, "stray.txt"), "x");
  const invalidReads = workspacePluginReads.count;
  for (let i = 0; i < 20; i++) assert.equal(inspect().status, "invalid");
  assert.equal(workspacePluginReads.count, invalidReads + 1);
  fs.rmSync(path.join(dir, "stray.txt"));
  assert.equal(inspect().status, "not_approved");
});

test("concurrent writers of the approval store lose nothing and leave a valid file", { timeout: 240_000 }, async () => {
  const worker = path.join(base, "writer.mts");
  fs.writeFileSync(worker, `
import { approveExtension, noteExtensionLoad, revokeExtension } from ${JSON.stringify(path.join(CLI_DIR, "src", "core", "content_trust.ts"))};
const who = process.argv[2];
for (let i = 0; i < 25; i++) {
  const id = { kind: "workspace-plugin" as const, scope: "/ws/" + who, key: "p" + i + ".mjs" };
  approveExtension({ ...id, sha256: "0".repeat(64), approvedAt: new Date().toISOString(), summary: who });
  noteExtensionLoad(id, { at: new Date().toISOString(), reason: "failed " + i });
  if (i % 5 === 4) { noteExtensionLoad(id, undefined); }
  if (i % 10 === 9) { revokeExtension(id); approveExtension({ ...id, sha256: "1".repeat(64), approvedAt: new Date().toISOString(), summary: who }); }
}
`);
  const children = ["a", "b", "c", "d"].map((who) => spawn(TSX, [worker, who], { env: { ...process.env, HOME: home }, stdio: ["ignore", "ignore", "pipe"] }));
  const errors: string[] = [];
  try {
    await Promise.all(children.map((child) => new Promise<void>((resolve) => {
      child.stderr!.on("data", (chunk) => errors.push(String(chunk)));
      child.once("exit", (code) => { if (code !== 0) errors.push(`exit ${code}`); resolve(); });
    })));
  } finally {
    for (const child of children) if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) process.kill(child.pid, "SIGKILL");
  }
  assert.deepEqual(errors, []);
  const store = path.join(home, ".config", "nexus", "extension_trust.json");
  const { entries, problem } = readExtensionTrust(store);
  assert.equal(problem, undefined);
  assert.equal(entries.length, 100, "every writer's 25 approvals are there");
  for (const who of ["a", "b", "c", "d"]) assert.equal(entries.filter((entry) => entry.scope === `/ws/${who}`).length, 25, who);
  assert.equal(entries.filter((entry) => entry.loadFailed).length, 4 * 20, "marks set and cleared as each writer left them (every fifth cleared)");
  assert.equal(fs.existsSync(`${store}.lock`), false, "no lock is left behind");
  assert.deepEqual(fs.readdirSync(path.dirname(store)).filter((name) => name.endsWith(".tmp")), []);

  // A lock whose holder is gone is taken over; the store is written.
  fs.writeFileSync(`${store}.lock`, JSON.stringify({ pid: 2 ** 22 - 3, started: "1" }));
  approveExtension({ kind: "workspace-plugin", scope: "/ws/late", key: "p.mjs", sha256: "2".repeat(64), approvedAt: new Date().toISOString(), summary: "late" }, store);
  assert.equal(readExtensionTrust(store).entries.length, 101);
  assert.equal(fs.existsSync(`${store}.lock`), false);
});
