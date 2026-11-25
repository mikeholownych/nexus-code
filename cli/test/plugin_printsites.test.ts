/**
 * HK-3 follow-ups to the review of PR #808: one sanitiser for everything a repository can name, applied where plugin,
 * hook and doctor code prints; the operator's plugin directories protected by their real spelling; a changed plugin
 * file announced as out of force; skipped operator directories shown; and a store lock two takers cannot both win.
 */
import "./helpers/leak_guard.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { approveExtension, lockIsStale, readExtensionTrust } from "../src/core/content_trust.js";
import { hookLine } from "../src/core/hook_runner.js";
import { HookRegistry } from "../src/core/hooks.js";
import { printableRefusal } from "../src/core/policy_runtime.js";
import { hasUnprintable, printable, withoutUnprintable } from "../src/core/printable.js";
import { runDoctor } from "../src/doctor.js";
import { diagnoseHooks } from "../src/doctor_hooks.js";
import { registerHookCommands } from "../src/hooks_cli.js";
import { PluginManager, pluginFileSha256, workspacePluginTrustId } from "../src/plugins.js";
import { registerPluginPackageCommands } from "../src/plugins_cli.js";
import { SecurityManager } from "../src/security.js";
import { setWorkspaceTrusted } from "../src/workspace_trust.js";
import { policyWorld } from "./helpers/policy_enforcement.js";

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(CLI_DIR, "node_modules", ".bin", "tsx");
const INDEX = path.join(CLI_DIR, "src", "index.ts");

let base = "", home = "", ws = "", previousHome: string | undefined, previousEnvTrust: string | undefined;
let seq = 0;

beforeEach(() => {
  previousHome = process.env.HOME;
  previousEnvTrust = process.env.NEXUS_TRUST_WORKSPACE;
  delete process.env.NEXUS_TRUST_WORKSPACE;
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk3-print-")));
  home = path.join(base, "home");
  ws = path.join(base, "ws");
  fs.mkdirSync(home);
  fs.mkdirSync(ws);
  process.env.HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousEnvTrust === undefined) delete process.env.NEXUS_TRUST_WORKSPACE; else process.env.NEXUS_TRUST_WORKSPACE = previousEnvTrust;
  fs.rmSync(base, { recursive: true, force: true });
});

function write(file: string, content: string, mode = 0o644): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
  return file;
}
const module_ = (name: string) => `export default { name: ${JSON.stringify(name)}, description: "t${++seq}" };\n`;
/** A name that moves the cursor, starts a forged line and reorders what follows. */
const EVIL = "x\x1b[5A\x1b[2K\nnexus: APPROVED ALL‮";
/** Fails unless `text` could be sent to a terminal as it is. */
function assertPrintable(text: string, what: string): void {
  const lines = text.split("\n");
  for (const line of lines) assert.ok(!hasUnprintable(line), `${what}: a raw control character in ${JSON.stringify(line)}`);
  assert.ok(!lines.some((line) => /^nexus: APPROVED ALL/.test(line)), `${what}: a forged line`);
}
/** What a function prints through console.log and console.error. */
async function printed(run: () => Promise<void> | void): Promise<string> {
  const lines: string[] = [];
  const saved = { log: console.log, error: console.error, exitCode: process.exitCode };
  console.log = (...values: unknown[]) => { lines.push(values.join(" ")); };
  console.error = (...values: unknown[]) => { lines.push(values.join(" ")); };
  try {
    await run();
  } finally {
    console.log = saved.log;
    console.error = saved.error;
    process.exitCode = saved.exitCode;
  }
  return lines.join("\n");
}

test("one helper writes out every character that could mislead a terminal, byte for byte", () => {
  const cases: Array<[string, string]> = [
    ["\x00\x07\x1b\x1f", "\\u0000\\u0007\\u001b\\u001f"],
    ["\n\r\t", "\\u000a\\u000d\\u0009"],
    ["\x7f", "\\u007f"],
    ["\x80\x85\x9b\x9f", "\\u0080\\u0085\\u009b\\u009f"],
    ["­", "\\u00ad"],
    ["؜‎‏", "\\u061c\\u200e\\u200f"],
    ["‪‫‬‭‮", "\\u202a\\u202b\\u202c\\u202d\\u202e"],
    ["⁦⁧⁨⁩", "\\u2066\\u2067\\u2068\\u2069"],
    ["​‌‍⁠﻿", "\\u200b\\u200c\\u200d\\u2060\\ufeff"],
    ["  ", "\\u2028\\u2029"],
    ["￹￺￻", "\\ufff9\\ufffa\\ufffb"],
    ["\u{e0000}\u{e0001}\u{e0041}\u{e007f}", "\\u{e0000}\\u{e0001}\\u{e0041}\\u{e007f}"],
    // A surrogate that is not half of a pair, either half.
    ["a\ud800b", "a\\ud800b"],
    ["a\udc00b", "a\\udc00b"],
    ["\ud83d", "\\ud83d"],
  ];
  for (const [raw, shown] of cases) {
    assert.equal(printable(raw), shown, JSON.stringify(raw));
    assert.equal(Buffer.from(printable(raw), "utf8").toString("latin1"), shown, "only ASCII bytes are written");
    assert.equal(hasUnprintable(raw), true, JSON.stringify(raw));
    // The other two sanitisers are this one.
    assert.equal(printableRefusal(`plugin '${raw}' refused`), `plugin '${shown}' refused`);
    assert.equal(hasUnprintable(hookLine(`a${raw}b`)), false, JSON.stringify(raw));
    assert.equal(hasUnprintable(withoutUnprintable(raw)), false);
  }
  // What is left alone: ordinary text in any script, a real surrogate pair, the characters just outside the ranges.
  for (const plain of ["plain ASCII ~!@#", "café 中文 عربي", "😀 emoji", "¬®", " ‐", "￸￼�", "\u{dffff}\u{e0080}\u{e0100}"]) {
    assert.equal(printable(plain), plain, JSON.stringify(plain));
    assert.equal(hasUnprintable(plain), false, JSON.stringify(plain));
  }
  assert.equal(printable("x".repeat(400)).length, 300);
  assert.equal(printable(`${"y".repeat(10)}\n`, 12), "y".repeat(10) + "\\…", "the cut counts the written-out form");
  assert.equal(hookLine("line one\nline two‮ \u{e0041}x"), "line one line two x");
});

test("doctor's plugins.config and hooks.config findings carry no raw name", { timeout: 240_000 }, async () => {
  // A world-writable plugin of the operator's with a hostile file name, and a plugin of an untrusted workspace.
  const mine = write(path.join(home, ".nexus", "plugins", `${EVIL}.mjs`), module_("mine"));
  fs.chmodSync(mine, 0o666);
  write(path.join(ws, ".nexus", "plugins", `w${EVIL}.mjs`), module_("theirs"));
  // An operator hooks file whose problem quotes a key the file chose, and a project hooks file likewise.
  write(path.join(home, ".config", "nexus", "hooks.json"), `{"version":1,"hooks":{},"k\\u001b[2J\\nnexus: APPROVED ALL\\u202e":1}`, 0o600);
  write(path.join(ws, ".nexus", "hooks.json"), `{"version":1,"hooks":{},"p\\u001b[2J\\nnexus: APPROVED ALL":1}`);
  const report = await runDoctor({ home, timeoutMs: 1500, config: { endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 4, temperature: 0, workspace: ws, shell: "bash" } as any });
  for (const id of ["plugins.config", "plugins.workspace", "hooks.config"]) {
    const finding = report.findings.find((entry) => entry.id === id);
    assert.ok(finding, id);
    assertPrintable([finding.explanation, ...finding.evidence, finding.action ?? ""].join("\n"), id);
  }
  const config = report.findings.find((entry) => entry.id === "plugins.config")!;
  assert.equal(config.status, "warn");
  assert.match(config.evidence.join("\n"), /x\\u001b\[5A\\u001b\[2K\\u000anexus: APPROVED ALL\\u202e\.mjs is world-writable/);
  assert.match(config.evidence.join("\n"), /w.*\\u001b\[5A.*: not loaded — this workspace is not trusted/);
  const hooks = diagnoseHooks(ws, home);
  assert.equal(hooks.status, "fail");
  assert.match(hooks.evidence[0], /unknown key 'k\\u001b\[2J\\u000anexus: APPROVED ALL\\u202e'/);
});

test("hook notices and `nexus hooks list` carry no raw name", async () => {
  write(path.join(home, ".config", "nexus", "hooks.json"), `{"version":1,"hooks":{},"k\\u001b[2J\\nnexus: APPROVED ALL\\u202e":1}`, 0o600);
  const notices: string[] = [];
  const registry = () => new HookRegistry({ workspace: () => ws, readOnly: () => false, permissionMode: () => "auto", sessionId: () => "t", notify: (text) => notices.push(text), policy: () => policyWorld({}).host.managed().effective, workspaceTrusted: () => true });
  const denied = await registry().preToolAdmission({ invocationId: "c1", toolName: "read_file", args: {} }, { workspaceRoot: ws, metadata: {} });
  assert.equal(denied.admitted, false);
  // What the model is told and what the operator is told both quote the file's own key.
  assertPrintable(denied.reason ?? "", "the denial");
  assert.match(denied.reason ?? "", /unknown key 'k\\u001b\[2J\\u000anexus: APPROVED ALL\\u202e'/);
  assertPrintable(notices.join("\n"), "the invalid-file notice");
  assert.equal(notices.length, 1);

  // The project's file, with the operator's out of the way.
  fs.rmSync(path.join(home, ".config", "nexus", "hooks.json"));
  write(path.join(ws, ".nexus", "hooks.json"), `{"version":1,"hooks":{},"p\\u001b[2J\\nnexus: APPROVED ALL":1}`);
  notices.length = 0;
  await registry().preToolAdmission({ invocationId: "c2", toolName: "read_file", args: {} }, { workspaceRoot: ws, metadata: {} });
  assert.match(notices.join("\n"), /are not run: .*unknown key 'p\\u001b\[2J\\u000anexus: APPROVED ALL'/);
  assertPrintable(notices.join("\n"), "the project-hooks notice");

  const listed = await printed(async () => {
    const program = new Command();
    program.exitOverride();
    registerHookCommands(program, { interactive: () => false, confirm: async () => false });
    await program.parseAsync(["node", "nexus", "hooks", "list", "-w", ws]);
    await program.parseAsync(["node", "nexus", "hooks", "approve", "-w", ws]);
  });
  assert.match(listed, /unknown key 'p/);
  assertPrintable(listed, "hooks list and approve");

  // A workspace and a home directory whose own names are the hostile text, and an approval store that is not read.
  const oddWs = path.join(base, `ws${EVIL}`);
  const oddHome = path.join(base, `home${EVIL}`);
  fs.mkdirSync(oddWs);
  write(path.join(oddHome, ".config", "nexus", "extension_trust.json"), "{}", 0o600);
  process.env.HOME = oddHome;
  const refused = await printed(async () => {
    const program = new Command();
    program.exitOverride();
    registerHookCommands(program, { interactive: () => false, confirm: async () => false });
    await program.parseAsync(["node", "nexus", "hooks", "approve", "-w", oddWs]);
    await program.parseAsync(["node", "nexus", "hooks", "list", "-w", oddWs]);
  });
  assert.match(refused, /There is no .*ws.*\\u001b\[5A.*hooks\.json\./);
  assert.match(refused, /The approval store .*home.*\\u001b\[5A.*extension_trust\.json is not used: it is not a version 1 extension trust store/);
  assertPrintable(refused, "hooks approve and list with hostile directory names");
  notices.length = 0;
  write(path.join(oddWs, ".nexus", "hooks.json"), `{"version":1,"hooks":{}}`);
  const odd = new HookRegistry({ workspace: () => oddWs, readOnly: () => false, permissionMode: () => "auto", sessionId: () => "t", notify: (text) => notices.push(text), policy: () => policyWorld({}).host.managed().effective, workspaceTrusted: () => true });
  await odd.preToolAdmission({ invocationId: "c4", toolName: "read_file", args: {} }, { workspaceRoot: oddWs, metadata: {} });
  assert.ok(notices.length >= 1, "the unusable store is announced");
  assertPrintable(notices.join("\n"), "the registry's notices");
});

test("the package commands and `plugins revoke` carry no raw name", { timeout: 240_000 }, async () => {
  // A package whose version string is the hostile text, installed from a directory with a hostile name.
  const source = path.join(base, `pkg${EVIL}`);
  write(path.join(source, "nexus-plugin.json"), JSON.stringify({ version: 1, name: "pkg", pluginVersion: `1.0${EVIL}`, permissions: ["hooks"] }));
  const run = (...args: string[]) => printed(async () => {
    const program = new Command();
    program.exitOverride();
    registerPluginPackageCommands(program.command("plugins"));
    await program.parseAsync(["node", "nexus", "plugins", ...args]);
  });
  const installed = await run("install", source);
  assert.match(installed, /Installed pkg@1\.0x\\u001b\[5A\\u001b\[2K\\u000anexus: APPROVED ALL\\u202e/);
  assertPrintable(installed, "install");
  const again = await run("install", source);
  assert.match(again, /install failed: /);
  assertPrintable(again, "install (refused)");
  const missing = await run("install", path.join(base, `nope${EVIL}`));
  assert.match(missing, /install failed: source is not a directory: .*nope.*\\u001b\[5A/);
  assertPrintable(missing, "install (no such directory)");
  const listed = await run("list-installed");
  assert.match(listed, /pkg@1\.0x\\u001b\[5A/);
  assertPrintable(listed, "list-installed");
  // Tampered with after install: the reason names the tree.
  fs.writeFileSync(path.join(home, ".config", "nexus", "installed-plugins", "pkg", "extra"), "x");
  const verified = [await run("verify"), await run("verify", `none${EVIL}`), await run("remove", `none${EVIL}`), await run("remove", "pkg")].join("\n");
  assert.match(verified, /fail {2}pkg/);
  assert.match(verified, /Removed pkg/);
  assertPrintable(verified, "verify and remove");

  // `nexus plugins revoke` through the real command line, with the path as the hostile text.
  const revoked = spawnSync(TSX, [INDEX, "plugins", "revoke", `.nexus/plugins/${EVIL}.mjs`, "-w", ws], { encoding: "utf8", env: { ...process.env, HOME: home, NO_COLOR: "1" }, timeout: 200_000 });
  assert.equal(revoked.status, 0, revoked.stderr);
  assert.match(revoked.stdout, /There was no approval for .*\\u001b\[5A\\u001b\[2K\\u000anexus: APPROVED ALL\\u202e\.mjs\./);
  assertPrintable(revoked.stdout, "plugins revoke");
});

test("the operator's plugin directories are protected by their real spelling too, also before they exist", () => {
  // HOME is a link; neither plugin directory exists yet.
  const realHome = path.join(base, "real-home");
  fs.mkdirSync(realHome);
  const linkHome = path.join(base, "link-home");
  fs.symlinkSync(realHome, linkHome);
  process.env.HOME = linkHome;
  const security = (workspace: string) => new SecurityManager(workspace, { policyFor: (target) => policyWorld({}).load(target), notify: () => {} });
  for (const workspace of [ws, realHome, linkHome]) {
    const manager = security(workspace);
    for (const spelled of [realHome, linkHome]) {
      for (const target of [path.join(spelled, ".nexus", "plugins", "x.mjs"), path.join(spelled, ".config", "nexus", "plugins", "y.mjs"), path.join(spelled, ".nexus", "plugins")]) {
        assert.equal(manager.isPathProtected(target).protected, true, `${target} in workspace ${workspace}`);
      }
    }
  }
  // In the workspace that is the real home directory, the relative spelling as a file tool gives it.
  assert.equal(security(realHome).isPathProtected(".nexus/plugins/x.mjs").protected, true);
  assert.equal(security(realHome).isPathProtected(".config/nexus/plugins/y.mjs").protected, true);
  // A project's own plugin files stay editable, and so does the rest of the home directory.
  assert.equal(security(ws).isPathProtected(".nexus/plugins/a.mjs").protected, false);
  assert.equal(security(realHome).isPathProtected("notes.txt").protected, false);
  // Only part of the path exists (the state directory, not its plugins directory).
  fs.mkdirSync(path.join(realHome, ".nexus"));
  assert.equal(security(ws).isPathProtected(path.join(realHome, ".nexus", "plugins", "x.mjs")).protected, true);
});

test("a changed plugin file is announced as out of force, once; skipped operator directories are shown by list and doctor", { timeout: 240_000 }, async () => {
  setWorkspaceTrusted(ws, true);
  const file = write(path.join(ws, ".nexus", "plugins", "audit.mjs"), module_("audit"));
  const never = write(path.join(ws, ".nexus", "plugins", "never.mjs"), module_("never"));
  const id = workspacePluginTrustId(ws, file);
  approveExtension({ kind: "workspace-plugin", scope: id.scope, key: id.key, sha256: pluginFileSha256(file), approvedAt: new Date().toISOString(), summary: "audit" });
  const notices: string[] = [];
  const pm = new PluginManager(ws, { notify: (notice) => notices.push(notice) });
  await pm.loadPlugins();
  assert.deepEqual(pm.listPlugins().map((plugin) => plugin.name), ["audit"]);
  notices.length = 0;
  fs.appendFileSync(file, "// edited\n");
  for (let i = 0; i < 3; i++) await pm.loadPlugins();
  const loud = notices.filter((notice) => /NO LONGER IN FORCE/.test(notice));
  assert.deepEqual(loud, ["nexus: WARNING: workspace plugin .nexus/plugins/audit.mjs is NO LONGER IN FORCE: .nexus/plugins/audit.mjs changed since it was approved. It is not loaded. Review the change, then run `nexus plugins trust .nexus/plugins/audit.mjs` in a terminal."]);
  // The file that never was approved is in the ordinary notice, and not called "no longer in force".
  assert.ok(!loud.join("\n").includes(path.basename(never)));

  // Nexus started in the home directory, where the operator keeps a plugin.
  write(path.join(home, ".nexus", "plugins", "mine.mjs"), module_("mine"));
  const listed = spawnSync(TSX, [INDEX, "plugins", "list", "-w", home, "--json"], { encoding: "utf8", env: { ...process.env, HOME: home, NO_COLOR: "1" }, timeout: 200_000 });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout.slice(listed.stdout.indexOf("{"))).skippedOperatorDirs, [path.join(home, ".nexus", "plugins")]);
  const text = spawnSync(TSX, [INDEX, "plugins", "list", "-w", home], { encoding: "utf8", env: { ...process.env, HOME: home, NO_COLOR: "1" }, timeout: 200_000 });
  assert.match(text.stdout, new RegExp(`Not loaded: your plugins in ${path.join(home, ".nexus", "plugins").replace(/[.]/g, "\\.")}\\. The directory lies inside the workspace .*Start Nexus in a project directory, not in your home directory\\.`));
  const report = await runDoctor({ home, timeoutMs: 1500, config: { endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 4, temperature: 0, workspace: home, shell: "bash" } as any });
  const finding = report.findings.find((entry) => entry.id === "plugins.config")!;
  assert.equal(finding.status, "warn");
  assert.match(finding.evidence.join("\n"), /\.nexus\/plugins: your plugins here are not loaded — the directory lies inside the workspace .*Start Nexus in a project directory/);
  // With a project directory as the workspace neither says so.
  const elsewhere = spawnSync(TSX, [INDEX, "plugins", "list", "-w", ws, "--json"], { encoding: "utf8", env: { ...process.env, HOME: home, NO_COLOR: "1" }, timeout: 200_000 });
  assert.deepEqual(JSON.parse(elsewhere.stdout.slice(elsewhere.stdout.indexOf("{"))).skippedOperatorDirs, []);
});

test("a lock whose holder cannot be identified is live while it is young; a dead holder's lock is stale", () => {
  const lock = path.join(base, "store.lock");
  const dead = JSON.stringify({ pid: 2 ** 22 - 3, started: "1" });
  fs.writeFileSync(lock, dead);
  assert.equal(lockIsStale(lock), true, "a holder that is gone");
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, started: "not this process's start time" }));
  assert.equal(lockIsStale(lock), true, "the pid was given to another process since");
  // Where no start time can be read at all (no /proc), nothing is known about any pid: only age decides.
  const blind = () => undefined;
  fs.writeFileSync(lock, dead);
  assert.equal(lockIsStale(lock, blind), false, "a young lock is live, not 'always stale'");
  const old = new Date(Date.now() - 31_000);
  fs.utimesSync(lock, old, old);
  assert.equal(lockIsStale(lock, blind), true, "after 30 s it may be taken over");
  // Content that names no holder: the same rule by age.
  fs.writeFileSync(lock, "");
  assert.equal(lockIsStale(lock), false);
  fs.utimesSync(lock, old, old);
  assert.equal(lockIsStale(lock), true);
  assert.equal(lockIsStale(path.join(base, "absent.lock")), false);
});

test("eight writers over stale locks: one taker at a time, nothing lost", { timeout: 280_000 }, async () => {
  const store = path.join(home, ".config", "nexus", "extension_trust.json");
  fs.mkdirSync(path.dirname(store), { recursive: true, mode: 0o700 });
  const worker = path.join(base, "writer.mts");
  // Each round a writer may first leave a dead holder's lock behind (when none is held), then makes its change.
  fs.writeFileSync(worker, `
import fs from "node:fs";
import { approveExtension } from ${JSON.stringify(path.join(CLI_DIR, "src", "core", "content_trust.ts"))};
const who = process.argv[2];
const lock = ${JSON.stringify(`${store}.lock`)};
for (let round = 0; round < 50; round++) {
  if (round % 2 === Number(who) % 2) {
    try { fs.writeFileSync(lock, JSON.stringify({ pid: 4194301, started: "1" }), { flag: "wx" }); } catch {}
  }
  approveExtension({ kind: "workspace-plugin", scope: "/ws/" + who, key: "p" + round + ".mjs", sha256: "0".repeat(64), approvedAt: new Date().toISOString(), summary: who });
  // Between two changes a writer lets the others in: one that took the lock again at once would starve them.
  await new Promise((resolve) => setTimeout(resolve, 5));
}
`);
  const children = Array.from({ length: 8 }, (_, who) => spawn(TSX, [worker, String(who)], { env: { ...process.env, HOME: home }, stdio: ["ignore", "ignore", "pipe"] }));
  const errors: string[] = [];
  try {
    await Promise.all(children.map((child) => new Promise<void>((resolve) => {
      child.stderr!.on("data", (chunk) => errors.push(String(chunk).slice(0, 300)));
      child.once("exit", (code) => { if (code !== 0) errors.push(`exit ${code}`); resolve(); });
    })));
  } finally {
    for (const child of children) if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) process.kill(child.pid, "SIGKILL");
  }
  assert.deepEqual(errors, []);
  const { entries, problem } = readExtensionTrust(store);
  assert.equal(problem, undefined);
  assert.equal(entries.length, 8 * 50, "every one of the 400 changes is in the store");
  for (let who = 0; who < 8; who++) assert.equal(entries.filter((entry) => entry.scope === `/ws/${who}`).length, 50, `writer ${who}`);
  const left = fs.readdirSync(path.dirname(store)).filter((name) => name !== "extension_trust.json");
  // A dead holder's lock planted in the last round may remain; nothing else does.
  assert.deepEqual(left.filter((name) => name !== "extension_trust.json.lock"), [], "no moved-aside lock and no temporary file is left");
});
