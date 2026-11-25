/**
 * HK-3: the workspace plugin loader under hostile and broken input. A workspace plugin runs in-process, so the loader
 * must classify it by where it was found (never by how its path looks), read it safely, import only bytes the operator
 * approved, and say so when an approved plugin cannot be loaded. "Imported" is observed by a marker file the plugin
 * writes, never inferred.
 */
import "./helpers/leak_guard.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { approveExtension, readExtensionTrust } from "../src/core/content_trust.js";
import { PLUGIN_FILE_LIMIT, PluginManager, inspectWorkspacePlugins, pluginDirSources, pluginFileSha256, readPluginFile, workspacePluginTrustId } from "../src/plugins.js";
import { trustWorkspacePlugin } from "../src/plugins_cli.js";

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(CLI_DIR, "node_modules", ".bin", "tsx");

let base = "", home = "", ws = "", previousHome: string | undefined;
let seq = 0;

beforeEach(() => {
  previousHome = process.env.HOME;
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk3-loader-")));
  home = path.join(base, "home");
  ws = path.join(base, "ws");
  fs.mkdirSync(home);
  fs.mkdirSync(ws);
  process.env.HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  fs.rmSync(base, { recursive: true, force: true });
});

/** A plugin module that appends where it ran from to a marker file when it is imported. */
function pluginSource(name: string, marker: string, extra = ""): string {
  // A fresh name per module keeps Node's module cache from answering for an earlier test.
  return `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(marker)}, import.meta.url + "\\n");\n${extra}\nexport default { name: ${JSON.stringify(name)}, description: "t${++seq}" };\n`;
}
function write(file: string, content: string | Buffer): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
function approve(workspace: string, file: string): void {
  const id = workspacePluginTrustId(workspace, file);
  approveExtension({ kind: "workspace-plugin", scope: id.scope, key: id.key, sha256: pluginFileSha256(file), approvedAt: new Date().toISOString(), summary: path.basename(file) });
}
async function load(workspace: string): Promise<{ manager: PluginManager; notices: string[]; names: string[] }> {
  const notices: string[] = [];
  const manager = new PluginManager(workspace, { trusted: true, notify: (notice) => notices.push(notice) });
  await manager.loadPlugins();
  return { manager, notices, names: manager.listPlugins().map((plugin) => plugin.name).sort() };
}
const marks = (marker: string): string[] => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n") : []);
const statusOf = (manager: PluginManager, file: string) => manager.getPluginTrustRecords().find((record) => record.path === file);

test("a directory's kind travels with it: with the home directory as the workspace the operator's plugins still load as the operator's", async () => {
  const marker = path.join(base, "marker");
  const mine = write(path.join(home, ".nexus", "plugins", "mine.mjs"), pluginSource("mine", marker));
  const config = write(path.join(home, ".config", "nexus", "plugins", "config.mjs"), pluginSource("config", marker));
  const repo = write(path.join(home, "plugins", "repo.mjs"), pluginSource("repo", marker));

  assert.deepEqual(pluginDirSources(home, true), [
    { dir: path.join(home, ".nexus", "plugins"), source: "global" },
    { dir: path.join(home, ".config", "nexus", "plugins"), source: "global" },
    // `<workspace>/.nexus/plugins` is the operator's own directory here: it is listed once, as theirs.
    { dir: path.join(home, "plugins"), source: "workspace" },
  ]);
  const { manager, names } = await load(home);
  assert.deepEqual(names, ["config", "mine"], "the operator's plugins load without any approval");
  assert.equal(statusOf(manager, mine)?.status, "global");
  assert.equal(statusOf(manager, config)?.status, "global");
  assert.equal(statusOf(manager, repo)?.status, "untrusted", "the workspace's own directory still needs an approval per file");
  assert.equal(marks(marker).length, 2);
});

test("a directory whose name only begins like the workspace's is not the workspace", async () => {
  // HOME is `<workspace>2`: a prefix test on the path would take the operator's directories for the workspace's.
  const sibling = `${ws}2`;
  fs.mkdirSync(sibling);
  process.env.HOME = sibling;
  const marker = path.join(base, "marker");
  const mine = write(path.join(sibling, ".nexus", "plugins", "mine.mjs"), pluginSource("mine-sibling", marker));
  const repo = write(path.join(ws, ".nexus", "plugins", "repo.mjs"), pluginSource("repo-sibling", marker));
  const { manager, names } = await load(ws);
  assert.deepEqual(names, ["mine-sibling"]);
  assert.equal(statusOf(manager, mine)?.status, "global");
  assert.equal(statusOf(manager, repo)?.status, "untrusted");
  assert.deepEqual(pluginDirSources(ws, true).map((entry) => entry.source), ["global", "global", "workspace", "workspace"]);
});

test("no import before approval; an approved plugin runs from a private copy of the approved bytes, not from the workspace", async () => {
  const marker = path.join(base, "marker");
  const file = write(path.join(ws, ".nexus", "plugins", "p.mjs"), pluginSource("pinned", marker));

  const before = await load(ws);
  assert.deepEqual(before.names, []);
  assert.deepEqual(marks(marker), [], "the module was not imported: its top-level code did not run");

  approve(ws, file);
  const after = await load(ws);
  assert.deepEqual(after.names, ["pinned"]);
  const [ranFrom] = marks(marker);
  assert.match(ranFrom, /^file:\/\/.*\/nexus-plugin-[^/]+\/p\.mjs$/, "it ran from a copy in a private directory");
  assert.ok(!fileURLToPath(ranFrom).startsWith(`${ws}${path.sep}`), `not from the workspace path: ${ranFrom}`);
  assert.equal(fs.existsSync(path.dirname(fileURLToPath(ranFrom))), false, "the copy is removed after the import");

  // One byte changed: not imported again.
  fs.appendFileSync(file, "\n");
  const changed = await load(ws);
  assert.deepEqual(changed.names, []);
  assert.equal(statusOf(changed.manager, file)?.status, "changed");
  assert.equal(marks(marker).length, 1);
});

test("an approved plugin that cannot be imported is reported: a notice, a load-failed record with the reason, and the list says so", { timeout: 240_000 }, async () => {
  const marker = path.join(base, "marker");
  const dir = path.join(ws, ".nexus", "plugins");
  write(path.join(dir, "lib.mjs"), `export const helper = 1;\n`);
  write(path.join(ws, "node_modules", "wspkg", "index.js"), `module.exports = { ok: true };\n`);
  write(path.join(ws, "node_modules", "wspkg", "package.json"), `{"name":"wspkg","version":"1.0.0","main":"index.js"}`);
  write(path.join(dir, "data.txt"), "data\n");
  const broken: Array<[string, string, RegExp]> = [
    ["a_rel.mjs", `import { helper } from "./lib.mjs";\nexport default { name: "a", helper };\n`, /Cannot find module|ERR_MODULE_NOT_FOUND/],
    ["b_req.js", `const pkg = require("wspkg");\nmodule.exports = { name: "b", pkg };\n`, /Cannot find module 'wspkg'|require is not defined/],
    ["c_bare.mjs", `import pkg from "wspkg";\nexport default { name: "c", pkg };\n`, /Cannot find package 'wspkg'/],
    ["d_meta.mjs", `import fs from "node:fs";\nconst data = fs.readFileSync(new URL("./data.txt", import.meta.url), "utf8");\nexport default { name: "d", data };\n`, /ENOENT/],
    ["e_throw.mjs", `throw new Error("boom at top level with key sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD\\nsecond line " + "x".repeat(1000));\n`, /Error: boom at top level/],
    ["f_noname.mjs", `export default { description: "no name" };\n`, /does not export a plugin object with a name/],
  ];
  const good = write(path.join(dir, "z_good.mjs"), pluginSource("good", marker));
  for (const [name, content] of broken) approve(ws, write(path.join(dir, name), content));
  approve(ws, good);

  const { manager, notices, names } = await load(ws);
  assert.deepEqual(names, ["good"], "the working plugin is not held back by the broken ones");
  for (const [name, , pattern] of broken) {
    const file = path.join(dir, name);
    const record = statusOf(manager, file);
    assert.equal(record?.status, "load-failed", `${name}: ${JSON.stringify(record)}`);
    assert.match(record?.reason ?? "", pattern, name);
    assert.ok((record?.reason ?? "").length <= 300 && !/\n/.test(record?.reason ?? ""), `${name}: one bounded line`);
    const told = notices.filter((notice) => notice.includes(file));
    assert.equal(told.length, 1, `${name}: one notice, ${JSON.stringify(told)}`);
    assert.match(told[0], /^nexus: plugin .* failed to load and is not active: /);
    assert.match(told[0], /runs from a private copy of its one file: imports of sibling files and of the workspace's packages do not resolve/);
  }
  assert.doesNotMatch(JSON.stringify(manager.getPluginTrustRecords()) + notices.join("\n"), /sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD/, "a secret in the error is not repeated");

  // The failure is on the approval, so a listing that does not run plugins can show it.
  const stored = readExtensionTrust().entries;
  assert.equal(stored.filter((entry) => entry.loadFailed).length, broken.length);
  assert.equal(stored.find((entry) => entry.key.endsWith("z_good.mjs"))?.loadFailed, undefined);
  const inspected = inspectWorkspacePlugins(ws);
  assert.deepEqual(inspected.filter((record) => record.status === "load-failed").map((record) => path.basename(record.path)), broken.map(([name]) => name));
  assert.equal(inspected.find((record) => record.path === good)?.status, "trusted");

  // `nexus plugins list` shows the status and the reason.
  const listed = spawnSync(TSX, [path.join(CLI_DIR, "src", "index.ts"), "plugins", "list", "-w", ws, "--json"], { encoding: "utf8", env: { ...process.env, HOME: home, NEXUS_TRUST_WORKSPACE: "1" }, timeout: 200_000 });
  assert.equal(listed.status, 0, listed.stderr);
  const records = JSON.parse(listed.stdout.slice(listed.stdout.indexOf("{"))).records as Array<{ path: string; status: string; reason?: string }>;
  const throwing = records.find((record) => record.path.endsWith("e_throw.mjs"));
  assert.equal(throwing?.status, "load-failed");
  assert.match(throwing?.reason ?? "", /boom at top level/);
  assert.match(listed.stderr, /e_throw\.mjs failed to load and is not active/);

  // Repaired and approved again, it loads, and the mark is gone.
  const repaired = write(path.join(dir, "a_rel.mjs"), pluginSource("a-repaired", marker));
  approve(ws, repaired);
  const again = await load(ws);
  assert.deepEqual(again.names, ["a-repaired", "good"]);
  assert.equal(readExtensionTrust().entries.find((entry) => entry.key.endsWith("a_rel.mjs"))?.loadFailed, undefined);
});

test("a plugin file is read safely: too large, a symbolic link, a second hard link, a FIFO and bytes that are not UTF-8 are not loaded", async () => {
  const marker = path.join(base, "marker");
  const dir = path.join(ws, ".nexus", "plugins");
  const outside = write(path.join(base, "outside.mjs"), pluginSource("outside", marker));
  const inside = write(path.join(ws, "tools", "real.mjs"), pluginSource("inside", marker));
  fs.mkdirSync(dir, { recursive: true });
  // 50 MB that would be valid JavaScript: a comment of spaces.
  const big = path.join(dir, "big.mjs");
  const fd = fs.openSync(big, "w");
  fs.writeSync(fd, "/*");
  fs.writeSync(fd, Buffer.alloc(1024 * 1024, 0x20), 0, 1024 * 1024, 50 * 1024 * 1024);
  fs.writeSync(fd, `*/\n${pluginSource("big", marker)}`);
  fs.closeSync(fd);
  fs.symlinkSync(outside, path.join(dir, "link_out.mjs"));
  fs.symlinkSync(inside, path.join(dir, "link_in.mjs"));
  fs.linkSync(inside, path.join(dir, "hard.mjs"));
  execFileSync("mkfifo", [path.join(dir, "fifo.mjs")]);
  write(path.join(dir, "latin1.mjs"), Buffer.concat([Buffer.from("// caf"), Buffer.from([0xe9]), Buffer.from(`\n${pluginSource("latin1", marker)}`)]));
  write(path.join(dir, "bom.mjs"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(pluginSource("bom", marker))]));
  write(path.join(dir, "nul.mjs"), Buffer.concat([Buffer.from("// \0\n"), Buffer.from(pluginSource("nul", marker))]));
  const exact = write(path.join(dir, "limit.mjs"), `${pluginSource("limit", marker)}//`.padEnd(PLUGIN_FILE_LIMIT, " "));

  const expected: Array<[string, RegExp]> = [
    ["big.mjs", /exceeds the 1024 KiB size limit/],
    ["link_out.mjs", /must not be a symbolic link/],
    ["link_in.mjs", /must not be a symbolic link/],
    ["hard.mjs", /more than one hard link/],
    ["fifo.mjs", /must be a regular file/],
    ["latin1.mjs", /not valid UTF-8/],
    ["bom.mjs", /byte order mark/],
    ["nul.mjs", /NUL/],
  ];
  for (const [name, pattern] of expected) {
    const file = path.join(dir, name);
    assert.match((readPluginFile(file) as { problem: string }).problem ?? "", pattern, name);
    assert.throws(() => pluginFileSha256(file), pattern, `${name}: there is no hash to approve`);
    // An approval on record for the content behind the name does not help.
    const id = workspacePluginTrustId(ws, file);
    const behind = name === "link_out.mjs" ? outside : name === "link_in.mjs" || name === "hard.mjs" ? inside : undefined;
    const sha256 = behind ? createHash("sha256").update(fs.readFileSync(behind)).digest("hex") : "0".repeat(64);
    approveExtension({ kind: "workspace-plugin", scope: id.scope, key: id.key, sha256, approvedAt: new Date().toISOString(), summary: name });
    // `nexus plugins trust` refuses it too, without asking.
    const said: string[] = [];
    const code = await trustWorkspacePlugin(ws, file, {}, { interactive: () => true, confirm: async () => { said.push("asked"); return true; }, log: (line) => said.push(line), error: (line) => said.push(line) });
    assert.equal(code, 1, name);
    assert.ok(!said.includes("asked"), `${name}: nothing is asked about a file that cannot be approved`);
  }
  approve(ws, exact);

  const started = Date.now();
  const { manager, names, notices } = await load(ws);
  assert.deepEqual(names, ["limit"], "a file of exactly the limit loads; none of the others does");
  assert.equal(marks(marker).length, 1, "no other module's code ran");
  for (const [name, pattern] of expected) {
    const record = statusOf(manager, path.join(dir, name));
    assert.equal(record?.status, "invalid", name);
    assert.match(record?.reason ?? "", pattern, name);
    assert.ok(notices.some((notice) => notice.includes(name) && /is not loaded: /.test(notice)), `${name}: told`);
  }
  assert.ok(Date.now() - started < 20_000, "the 50 MB file was not read and the FIFO was not waited on");
});

test("the approval asks a person, and records only content that is still the content that was shown", async () => {
  const marker = path.join(base, "marker");
  const file = write(path.join(ws, ".nexus", "plugins", "p.mjs"), pluginSource("asked", marker));
  const shownHash = pluginFileSha256(file);
  const run = async (answer: () => Promise<boolean> | boolean, options: { sha256?: string } = {}, interactive = true) => {
    const out: string[] = [];
    let asked = 0;
    const code = await trustWorkspacePlugin(ws, ".nexus/plugins/p.mjs", options, { interactive: () => interactive, confirm: async () => { asked++; return answer(); }, log: (line) => out.push(line), error: (line) => out.push(line) });
    return { code, out: out.join("\n"), asked };
  };

  const noTerminal = await run(() => true, { sha256: shownHash }, false);
  assert.deepEqual([noTerminal.code, noTerminal.asked], [2, 0]);
  assert.match(noTerminal.out, /needs a person at a terminal/);
  const wrongPin = await run(() => true, { sha256: "0".repeat(64) });
  assert.deepEqual([wrongPin.code, wrongPin.asked], [2, 0]);
  const declined = await run(() => false);
  assert.deepEqual([declined.code, declined.asked], [1, 1]);
  assert.deepEqual(readExtensionTrust().entries, []);

  // The bytes are replaced while the question is open: the answer "yes" was given to the content shown, not to this.
  const evil = pluginSource("evil", marker, "globalThis.__nexusHk3Evil = true;");
  const swapped = await run(() => { fs.writeFileSync(file, evil); return true; });
  assert.equal(swapped.code, 2);
  assert.match(swapped.out, new RegExp(`Not approved: the file changed while you were asked \\(was ${shownHash}, now ${pluginFileSha256(file)}\\)`));
  assert.deepEqual(readExtensionTrust().entries, [], "nothing was recorded, under either hash");
  assert.deepEqual((await load(ws)).names, []);
  assert.deepEqual(marks(marker), []);

  // Replaced by something that cannot be read as a plugin while the question is open.
  fs.writeFileSync(file, pluginSource("asked-again", marker));
  const vanished = await run(() => { fs.rmSync(file); fs.symlinkSync("/etc/hostname", file); return true; });
  assert.equal(vanished.code, 2);
  assert.match(vanished.out, /could not re-read/);
  assert.deepEqual(readExtensionTrust().entries, []);

  // Unchanged through the question: approved under the hash that was shown.
  fs.rmSync(file);
  fs.writeFileSync(file, pluginSource("asked-final", marker));
  const approved = await run(() => true, { sha256: pluginFileSha256(file).toUpperCase() });
  assert.equal(approved.code, 0, approved.out);
  assert.equal(readExtensionTrust().entries[0].sha256, pluginFileSha256(file));
  assert.deepEqual((await load(ws)).names, ["asked-final"]);
});
