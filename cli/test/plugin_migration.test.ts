/**
 * HK-3 migration and precedence: what an operator who upgrades sees, and what stands above an approval. Workspace
 * plugins that loaded before per-plugin trust stop loading; that must be said once, clearly, with the command for each
 * file, and `nexus doctor` must warn. A policy refusal beats an approval; the operator's plugin beats a workspace
 * plugin of the same name; an approvals file shipped by the repository is never read.
 */
import "./helpers/leak_guard.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { approveExtension } from "../src/core/content_trust.js";
import type { EffectivePolicy } from "../src/core/managed_policy.js";
import { runDoctor } from "../src/doctor.js";
import { diagnoseWorkspacePlugins } from "../src/doctor_plugins.js";
import { PluginManager, pluginFileSha256, workspacePluginTrustId } from "../src/plugins.js";
import { setWorkspaceTrusted } from "../src/workspace_trust.js";
import { FAKE_SYSTEM, policyWorld, toml } from "./helpers/policy_enforcement.js";
import { closeLoadedPluginManagersAfterTests } from "./helpers/plugin_manager_cleanup.js";

closeLoadedPluginManagersAfterTests();

let base = "", home = "", ws = "", marker = "", previousHome: string | undefined, previousEnvTrust: string | undefined;
let seq = 0;

beforeEach(() => {
  previousHome = process.env.HOME;
  previousEnvTrust = process.env.NEXUS_TRUST_WORKSPACE;
  delete process.env.NEXUS_TRUST_WORKSPACE;
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk3-migration-")));
  home = path.join(base, "home");
  ws = path.join(base, "ws");
  marker = path.join(base, "marker");
  fs.mkdirSync(home);
  fs.mkdirSync(ws);
  process.env.HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousEnvTrust === undefined) delete process.env.NEXUS_TRUST_WORKSPACE; else process.env.NEXUS_TRUST_WORKSPACE = previousEnvTrust;
  fs.rmSync(base, { recursive: true, force: true });
});

/** A plugin that records its import in the marker file. */
function plugin(file: string, name: string, extra = ""): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${name}\n`)});\nexport default { name: ${JSON.stringify(name)}, description: ${JSON.stringify(`${path.basename(file)} ${++seq}`)}${extra} };\n`);
  return file;
}
function approve(file: string): void {
  const id = workspacePluginTrustId(ws, file);
  approveExtension({ kind: "workspace-plugin", scope: id.scope, key: id.key, sha256: pluginFileSha256(file), approvedAt: new Date().toISOString(), summary: path.basename(file) });
}
const imported = (): string[] => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n") : []);
function manager(options: { policy?: () => EffectivePolicy } = {}): { pm: PluginManager; notices: string[] } {
  const notices: string[] = [];
  // No `trusted` option: the manager asks the real workspace trust store, as a session does.
  return { pm: new PluginManager(ws, { notify: (notice) => notices.push(notice), ...options }), notices };
}
const effective = (system: string): EffectivePolicy => policyWorld({ system }).host.managed().effective;
const names = (pm: PluginManager) => pm.listPlugins().map((entry) => entry.name).sort();
const status = (pm: PluginManager, file: string) => pm.getPluginTrustRecords().find((record) => record.path === file)?.status;

test("after the upgrade: plugins of a trusted workspace are not loaded, one notice names each with its command, and the doctor warns", { timeout: 240_000 }, async () => {
  // As it stood before per-plugin trust: the workspace is trusted, and that was all it took.
  setWorkspaceTrusted(ws, true);
  const audit = plugin(path.join(ws, ".nexus", "plugins", "audit.mjs"), "audit");
  const format = plugin(path.join(ws, "plugins", "format.mjs"), "format");

  const { pm, notices } = manager();
  await pm.loadPlugins();
  assert.deepEqual(names(pm), []);
  assert.deepEqual(imported(), [], "neither module was imported");
  assert.deepEqual(notices, [
    "nexus: 2 workspace plugins are not loaded. Since v1.3.0 each workspace plugin file needs its own approval; trusting the workspace no longer loads them. Review each file, then run in a terminal:\n  nexus plugins trust .nexus/plugins/audit.mjs\n  nexus plugins trust plugins/format.mjs",
  ]);
  // A reload in the same session does not repeat it.
  await pm.loadPlugins();
  await pm.loadPlugins();
  assert.equal(notices.length, 1);

  const before = diagnoseWorkspacePlugins(ws);
  assert.equal(before.status, "warn");
  assert.match(before.explanation, /^2 of 2 workspace plugin\(s\) are not active\. Since v1\.3\.0 each workspace plugin file needs its own approval\./);
  assert.deepEqual(before.evidence, [`${audit}: not approved, so it is not loaded`, `${format}: not approved, so it is not loaded`]);
  assert.match(before.action ?? "", /approve it by itself in a terminal: `nexus plugins trust \.nexus\/plugins\/audit\.mjs`, `nexus plugins trust plugins\/format\.mjs`\. Each plugin needs its own approval \(a plugin file by itself, a manifest plugin by its directory\); trusting the workspace does not load plugins\./);
  assert.doesNotMatch(before.action ?? "", /`nexus trust/, "the remedy is the per-file approval, not trusting the workspace");
  const report = await runDoctor({ home, timeoutMs: 1500, config: { endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 4, temperature: 0, workspace: ws, shell: "bash" } as any });
  const finding = report.findings.find((entry) => entry.id === "plugins.workspace");
  assert.equal(finding?.status, "warn", report.findings.map((entry) => entry.id).join(", "));
  assert.equal(finding?.category, "extensions");

  // One approved: it loads; the notice and the doctor are about the other.
  approve(audit);
  await pm.loadPlugins();
  assert.deepEqual(names(pm), ["audit"]);
  assert.equal(notices.length, 2);
  assert.match(notices[1], /^nexus: 1 workspace plugin is not loaded\..*\n  nexus plugins trust plugins\/format\.mjs$/s);
  assert.equal(diagnoseWorkspacePlugins(ws).status, "warn");

  // A change is named as one.
  approve(format);
  assert.deepEqual(diagnoseWorkspacePlugins(ws), { status: "pass", explanation: "2 workspace plugin(s) are approved. Plugin files were read and compared with your approvals; none was imported.", evidence: [`${audit}: approved`, `${format}: approved`] });
  fs.appendFileSync(format, "// edited\n");
  const again = manager();
  await again.pm.loadPlugins();
  // A plugin that was in force and no longer is gets a notice of its own, once, however often plugins are reloaded.
  await again.pm.loadPlugins();
  await again.pm.loadPlugins();
  assert.deepEqual(again.notices, ["nexus: WARNING: workspace plugin plugins/format.mjs is NO LONGER IN FORCE: plugins/format.mjs changed since it was approved. It is not loaded. Review the change, then run `nexus plugins trust plugins/format.mjs` in a terminal."]);
  // Changed again: said again.
  fs.appendFileSync(format, "// edited twice\n");
  await again.pm.loadPlugins();
  assert.equal(again.notices.length, 2);
  assert.match(diagnoseWorkspacePlugins(ws).evidence.join("\n"), /format\.mjs: changed since it was approved, so it is not loaded/);
});

test("the notice is capped, and the doctor reports a failed load and a workspace that is not trusted", async () => {
  setWorkspaceTrusted(ws, true);
  for (let i = 0; i < 13; i++) plugin(path.join(ws, "plugins", `p${String(i).padStart(2, "0")}.mjs`), `p${i}`);
  const { pm, notices } = manager();
  await pm.loadPlugins();
  const lines = notices[0].split("\n");
  assert.match(lines[0], /^nexus: 13 workspace plugins are not loaded\./);
  assert.equal(lines.length, 12, "the first line, ten commands, and one line for the rest");
  assert.equal(lines[11], "  ... and 3 more: see `nexus plugins list`");
  assert.equal(diagnoseWorkspacePlugins(ws).evidence.length, 13);

  fs.rmSync(path.join(ws, "plugins"), { recursive: true });
  assert.deepEqual(diagnoseWorkspacePlugins(ws), { status: "skip", explanation: "The workspace has no plugins of its own (optional).", evidence: [] });
  const broken = path.join(ws, "plugins", "broken.mjs");
  fs.mkdirSync(path.dirname(broken));
  fs.writeFileSync(broken, `import "./lib.mjs";\nexport default { name: "broken" };\n`);
  approve(broken);
  assert.equal(diagnoseWorkspacePlugins(ws).status, "pass", "approved, and no session has tried to load it yet");
  await manager().pm.loadPlugins();
  const failed = diagnoseWorkspacePlugins(ws);
  assert.equal(failed.status, "warn");
  assert.match(failed.evidence[0], /broken\.mjs: approved, but its last load failed, so it is not active \(.*Cannot find module/);
  assert.match(failed.action ?? "", /Fix plugins\/broken\.mjs: a workspace plugin must be one self-contained regular file/);

  fs.writeFileSync(broken, `export default { name: "mended" };\n`);
  approve(broken);
  setWorkspaceTrusted(ws, false);
  const untrusted = diagnoseWorkspacePlugins(ws);
  assert.equal(untrusted.status, "warn");
  assert.match(untrusted.explanation, /are approved, but the workspace is not trusted, so none is loaded/);
  assert.match(untrusted.action ?? "", /nexus trust /);
});

test("a policy refusal beats an approval", async () => {
  setWorkspaceTrusted(ws, true);
  const file = plugin(path.join(ws, ".nexus", "plugins", "p.mjs"), "approved-plugin");
  approve(file);
  const sha = pluginFileSha256(file);
  const mine = plugin(path.join(home, ".nexus", "plugins", "mine.mjs"), "mine");
  const mineSha = createHash("sha256").update(fs.readFileSync(mine)).digest("hex");

  const disabled = manager({ policy: () => effective(toml("[plugins]", "disable_workspace = true")) });
  await disabled.pm.loadPlugins();
  assert.deepEqual(names(disabled.pm), ["mine"]);
  assert.equal(status(disabled.pm, file), "policy-refused");
  // Literal substring (not RegExp): avoids CodeQL js/incomplete-sanitization on path escaping.
  assert.ok(disabled.notices.join("\n").includes(`managed policy disables plugins from the workspace. [policy: system ${FAKE_SYSTEM} plugins.disable_workspace]`));

  const notListed = manager({ policy: () => effective(toml("[plugins]", `allow = ["sha256:${mineSha}"]`)) });
  await notListed.pm.loadPlugins();
  assert.deepEqual(names(notListed.pm), ["mine"]);
  assert.equal(status(notListed.pm, file), "policy-refused");
  assert.ok(imported().every((name) => name === "mine"), `the approved workspace plugin was never imported: ${imported()}`);

  // Listed by the policy and approved: both hold, and it loads.
  const listed = manager({ policy: () => effective(toml("[plugins]", `allow = ["sha256:${sha}", "sha256:${mineSha}"]`)) });
  await listed.pm.loadPlugins();
  assert.deepEqual(names(listed.pm), ["approved-plugin", "mine"]);

  // Listed by the policy and not approved: the policy admits, it does not approve.
  const other = plugin(path.join(ws, ".nexus", "plugins", "q.mjs"), "unapproved-plugin");
  const otherSha = pluginFileSha256(other);
  const admitted = manager({ policy: () => effective(toml("[plugins]", `allow = ["sha256:${sha}", "sha256:${otherSha}", "sha256:${mineSha}"]`)) });
  await admitted.pm.loadPlugins();
  assert.equal(status(admitted.pm, other), "untrusted");
  assert.ok(!imported().includes("unapproved-plugin"));
});

test("a workspace plugin with the name of one of the operator's is not used", async () => {
  setWorkspaceTrusted(ws, true);
  const mine = plugin(path.join(home, ".config", "nexus", "plugins", "audit.mjs"), "audit");
  const tool = `, customTools: [{ definition: { type: "function", function: { name: "planted_tool", description: "x", parameters: { type: "object", properties: {} } } }, handler: async () => ({ success: true, output: "planted" }) }]`;
  const theirs = plugin(path.join(ws, ".nexus", "plugins", "audit.mjs"), "audit", tool);
  approve(theirs);
  const { pm, notices } = manager();
  await pm.loadPlugins();
  assert.deepEqual(pm.listPlugins(), [{ name: "audit", description: pm.listPlugins()[0].description, customToolCount: 0 }]);
  assert.match(pm.listPlugins()[0].description, /^audit\.mjs /);
  assert.equal(status(pm, mine), "global");
  assert.equal(status(pm, theirs), "shadowed");
  assert.equal(pm.isCustomTool("planted_tool"), false, "nothing of the shadowed plugin is registered");
  assert.deepEqual(pm.getCustomToolDefinitions(), []);
  assert.deepEqual(notices, [`nexus: workspace plugin ${theirs} is not used: the operator's plugin ${mine} has the same name 'audit' and is the one used`]);
});

test("an approvals file the repository ships is never read", async () => {
  setWorkspaceTrusted(ws, true);
  const file = plugin(path.join(ws, ".nexus", "plugins", "p.mjs"), "self-approved");
  const id = workspacePluginTrustId(ws, file);
  const store = JSON.stringify({ version: 1, entries: [{ kind: "workspace-plugin", scope: id.scope, key: id.key, sha256: pluginFileSha256(file), approvedAt: new Date().toISOString(), summary: "shipped" }] });
  for (const shipped of ["extension_trust.json", ".nexus/extension_trust.json", ".config/nexus/extension_trust.json", ".nexus/plugins/extension_trust.json"]) {
    fs.mkdirSync(path.dirname(path.join(ws, shipped)), { recursive: true });
    fs.writeFileSync(path.join(ws, shipped), store, { mode: 0o600 });
  }
  const { pm } = manager();
  await pm.loadPlugins();
  assert.deepEqual(names(pm), []);
  assert.equal(status(pm, file), "untrusted");
  assert.deepEqual(imported(), []);
  assert.equal(diagnoseWorkspacePlugins(ws).status, "warn");
  // The same record in the operator's own store is what counts.
  fs.mkdirSync(path.join(home, ".config", "nexus"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, ".config", "nexus", "extension_trust.json"), store, { mode: 0o600 });
  const second = manager();
  await second.pm.loadPlugins();
  assert.deepEqual(names(second.pm), ["self-approved"]);
});
