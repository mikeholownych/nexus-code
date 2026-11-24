/**
 * HK-1: the `hooks.config` finding of `nexus doctor`. A hooks file that is declared and not in force is the case an
 * operator needs to hear about: an invalid operator file stops all work, an unapproved project file guards nothing.
 */
import "./helpers/leak_guard.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { approveExtension } from "../src/core/content_trust.js";
import { runDoctor } from "../src/doctor.js";
import { diagnoseHooks } from "../src/doctor_hooks.js";

let home = "", previousHome: string | undefined, workspace = "";

beforeEach(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk1-doctor-home-"));
  process.env.HOME = home;
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk1-doctor-ws-")));
});
afterEach(() => {
  for (const dir of [home, workspace]) fs.rmSync(dir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
});

const store = () => path.join(home, ".config", "nexus", "extension_trust.json");
function operatorHooks(document: unknown): string {
  const file = path.join(home, ".config", "nexus", "hooks.json");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, typeof document === "string" ? document : JSON.stringify(document), { mode: 0o600 });
  return file;
}
function projectHooks(document: unknown): string {
  const file = path.join(workspace, ".nexus", "hooks.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(document));
  return file;
}
const approve = (file: string) => approveExtension({ kind: "project-hooks", scope: workspace, key: path.join(".nexus", "hooks.json"), sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"), approvedAt: new Date().toISOString(), summary: "t" }, store());
const guard = (tools = ["run_command"]) => ({ version: 1, hooks: { "pre-tool": [{ name: "guard", tools, command: ["/bin/true"] }] } });

test("no hooks: skipped; hooks in force: pass, with what is in force", () => {
  assert.deepEqual(diagnoseHooks(workspace, home), { status: "skip", explanation: "No command hooks are configured (optional).", evidence: [] });
  const operator = operatorHooks(guard());
  const project = projectHooks({ version: 1, hooks: { "post-tool": [{ name: "audit", tools: ["*"], command: ["/bin/true"] }] } });
  approve(project);
  const diagnosis = diagnoseHooks(workspace, home);
  assert.equal(diagnosis.status, "pass");
  assert.match(diagnosis.explanation, /^2 command hook\(s\) are in force\. Hooks were read from their files, not run\.$/);
  assert.deepEqual(diagnosis.evidence, [`${operator}: 1 hook(s) in force (pre-tool guard)`, `${project}: 1 hook(s) in force (post-tool audit)`]);
});

test("an invalid operator file is a failure that says every tool call is denied", () => {
  const operator = operatorHooks('{"version":1,"hooks":{"pre-tool":[],"pre-tool":[]}}');
  const diagnosis = diagnoseHooks(workspace, home);
  assert.equal(diagnosis.status, "fail");
  assert.match(diagnosis.explanation, /every tool call is denied until it is fixed/);
  assert.ok(diagnosis.evidence[0].startsWith(`${operator}: line 1, column `));
  assert.ok(diagnosis.evidence[0].includes('duplicate key "pre-tool"'));
  assert.match(diagnosis.action ?? "", /Fix .*hooks\.json or move it aside/);

  fs.writeFileSync(operator, JSON.stringify(guard()));
  fs.chmodSync(operator, 0o666);
  assert.equal(diagnoseHooks(workspace, home).status, "fail");
  assert.match(diagnoseHooks(workspace, home).evidence[0], /permissions are too open/);
});

test("project hooks that are declared and not in force are a warning with the command that approves them", () => {
  const project = projectHooks(guard());
  const unapproved = diagnoseHooks(workspace, home);
  assert.equal(unapproved.status, "warn");
  assert.deepEqual(unapproved.evidence, [`${project}: not approved, so its hooks do not run`]);
  assert.equal(unapproved.action, `Review ${project}, then run \`nexus hooks approve -w ${workspace}\` in a terminal.`);

  approve(project);
  assert.equal(diagnoseHooks(workspace, home).status, "pass");
  fs.appendFileSync(project, "\n");
  const changed = diagnoseHooks(workspace, home);
  assert.equal(changed.status, "warn");
  assert.match(changed.evidence[0], /\.nexus\/hooks\.json changed since the approval, so its hooks do not run/);

  fs.writeFileSync(project, '{"version":1,"hooks":{"stop":[]}}');
  const invalid = diagnoseHooks(workspace, home);
  assert.equal(invalid.status, "warn");
  assert.match(invalid.evidence[0], /not a valid hooks file, so its hooks do not run \(.*event 'stop' is not supported in this version/);
});

test("an unusable approval store and a tool name no tool has are warnings", () => {
  const project = projectHooks(guard());
  approve(project);
  fs.chmodSync(store(), 0o644);
  const diagnosis = diagnoseHooks(workspace, home);
  assert.equal(diagnosis.status, "warn");
  assert.ok(diagnosis.evidence.some((line) => /extension_trust\.json: the approval store is not used \(.*permissions are too open/.test(line)), diagnosis.evidence.join("\n"));
  fs.rmSync(store());
  fs.rmSync(project);

  operatorHooks(guard(["run_comand"]));
  const typo = diagnoseHooks(workspace, home);
  assert.equal(typo.status, "warn");
  assert.match(typo.evidence[0], /no built-in tool is named run_comand; a hook that lists only such names never runs/);
});

test("nexus doctor reports the finding", { timeout: 240_000 }, async () => {
  operatorHooks('{"version":1,"hooks":{"pre-tool":[{"name":"g","tool":"x","command":"y"}]}}');
  const report = await runDoctor({ home, timeoutMs: 1500, config: { endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 4, temperature: 0, workspace, shell: "bash" } as any });
  const finding = report.findings.find((entry) => entry.id === "hooks.config");
  assert.ok(finding, report.findings.map((entry) => entry.id).join(", "));
  assert.equal(finding.status, "fail");
  assert.equal(finding.category, "extensions");
  assert.match(finding.evidence.join("\n"), /unknown key 'tool' in hooks\.pre-tool\[0\]/);
  assert.equal(finding.repairAvailable, false);
});
