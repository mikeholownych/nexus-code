/**
 * GV-1: integrity of the project policy file (`.nexus-security.json`): the status of the file against the approval
 * recorded in `policy_trust.json`, and what follows from it. The file's restrictions apply in every status; its
 * relaxations only for a trusted workspace whose file is the approved one, or under an environment trust that no
 * policy disables. The loader never asks, so every run here is a headless run.
 *
 * Real files, in a temporary directory: never the operator's own configuration.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { effectiveVerificationMode } from "../src/core/managed_policy.js";
import {
  loadManagedPolicy,
  policyIntegrity,
  readPolicyTrustStore,
  recordProjectPolicyApproval,
  type LoadedPolicy,
  type PolicyIntegrityStatus,
  type PolicyTrustInput,
} from "../src/core/managed_policy_load.js";
import { FakeFs } from "./helpers/policy_fixture.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

test("the status table: every combination of stored approval, current file, trust, environment trust and its policy switch (48 rows)", () => {
  let rows = 0;
  for (const stored of [undefined, HASH_A, HASH_B]) {
    for (const current of [undefined, HASH_A]) {
      for (const workspaceTrusted of [false, true]) {
        for (const envTrustRequested of [false, true]) {
          for (const disableEnvTrust of [false, true]) {
            rows++;
            // The expectation, stated as the rules of the plan rather than as code that mirrors the function.
            let status: PolicyIntegrityStatus;
            let apply = false;
            const envCounts = envTrustRequested && !disableEnvTrust;
            if (current === undefined) status = stored === undefined ? "ABSENT" : "REMOVED";
            else if (stored === current && workspaceTrusted) [status, apply] = ["MATCH", true];
            else if (envCounts) [status, apply] = ["ENV_TRUSTED", true];
            else status = stored === undefined ? "NEW" : stored === current ? "MATCH" : "MISMATCH";
            const got = policyIntegrity({ stored: stored ? { sha256: stored, approvedAt: "2026-11-22T00:00:00.000Z" } : undefined, currentSha256: current, workspaceTrusted, envTrustRequested, disableEnvTrust });
            assert.deepEqual(got, { status, relaxationsApply: apply }, JSON.stringify({ stored, current, workspaceTrusted, envTrustRequested, disableEnvTrust }));
            // The invariants, whatever the row.
            if (got.relaxationsApply) assert.ok((workspaceTrusted && stored === current && current !== undefined) || envCounts);
            if (disableEnvTrust && !workspaceTrusted) assert.equal(got.relaxationsApply, false, "the environment alone never counts when policy disables it");
            if (current === undefined) assert.equal(got.relaxationsApply, false);
          }
        }
      }
    }
  }
  assert.equal(rows, 48);
});

interface Sandbox {
  workspace: string;
  projectFile: string;
  userPath: string;
  storePath: string;
  load: (trust?: Partial<PolicyTrustInput>) => LoadedPolicy;
  approve: (sha256: string) => void;
}

function sandbox(t: TestContext): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-policy-integrity-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "ws");
  const config = path.join(root, "home", ".config", "nexus");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  const storePath = path.join(config, "policy_trust.json");
  const userPath = path.join(config, "policy.toml");
  return {
    workspace,
    projectFile: path.join(workspace, ".nexus-security.json"),
    userPath,
    storePath,
    // No system tier in these tests; the user tier is a file in the temporary directory.
    load: (trust = {}) => loadManagedPolicy({ systemPath: null, systemOwnerUid: 0, userPath, userUid: null, workspace, trust: { workspaceTrusted: true, envTrustRequested: false, storePath, ...trust }, fs }),
    approve: (sha256) => recordProjectPolicyApproval({ fs, storePath, workspace, sha256, approvedAt: "2026-11-22T10:00:00.000Z" }),
  };
}

const RELAXING = JSON.stringify({ protectedPaths: ["dist/**"], verificationPaths: { mode: "off", extra: ["tools/check.sh"], allow: ["ci/**"] } }, null, 2);
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

test("ABSENT: no project file, no approval, no notice", (t) => {
  const box = sandbox(t);
  const loaded = box.load();
  assert.deepEqual([loaded.project.status, loaded.project.sha256, loaded.project.tier, loaded.project.approvalPending, loaded.notices], ["ABSENT", undefined, undefined, false, []]);
  assert.ok(!fs.existsSync(box.storePath), "loading writes nothing");
});

test("NEW: an unapproved file's restrictions apply, its relaxations do not, and a notice says so", (t) => {
  const box = sandbox(t);
  fs.writeFileSync(box.projectFile, RELAXING);
  const loaded = box.load();
  assert.equal(loaded.project.status, "NEW");
  assert.equal(loaded.project.sha256, sha256(RELAXING));
  assert.deepEqual(loaded.project.relaxations, { verification_mode: "off", verification_allow: ["ci/**"] });
  assert.deepEqual([loaded.project.relaxationsApply, loaded.project.approvalPending], [false, true]);
  // Restrictive part: applied.
  assert.deepEqual(loaded.effective.paths.protected.values, ["dist/**"]);
  assert.deepEqual(loaded.effective.verification.protected.values, ["tools/check.sh"]);
  assert.equal(loaded.effective.paths.protected.items[0].source.tier, "project");
  // Relaxations: dropped.
  assert.equal(loaded.effective.verification.relaxation, undefined);
  assert.equal(loaded.effective.verification.relaxationStatus, "not_approved");
  assert.equal(effectiveVerificationMode(loaded.effective).value, "approve");
  assert.deepEqual(loaded.notices, [`nexus: project policy ${box.projectFile} asks to relax verification protection; not applied (NEW: the file was never approved). Its restrictions still apply.`]);
  assert.ok(!fs.existsSync(box.storePath), "a headless run records no approval");
});

test("MATCH: after the approval is recorded, the relaxations apply; the store is private", (t) => {
  const box = sandbox(t);
  fs.writeFileSync(box.projectFile, RELAXING);
  box.approve(sha256(RELAXING));
  const loaded = box.load();
  assert.deepEqual([loaded.project.status, loaded.project.relaxationsApply, loaded.project.approvalPending, loaded.notices], ["MATCH", true, false, []]);
  assert.deepEqual(loaded.effective.verification.relaxation, { mode: "off", allow: ["ci/**"], source: { tier: "project", file: box.projectFile, key: "verificationPaths.mode" } });
  assert.deepEqual(effectiveVerificationMode(loaded.effective), { value: "off", source: { tier: "project", file: box.projectFile, key: "verificationPaths.mode" } });
  assert.deepEqual(loaded.effective.paths.protected.values, ["dist/**"]);

  assert.deepEqual(JSON.parse(fs.readFileSync(box.storePath, "utf8")), { version: 1, workspaces: { [box.workspace]: { sha256: sha256(RELAXING), approvedAt: "2026-11-22T10:00:00.000Z" } } });
  if (process.platform !== "win32") assert.equal(fs.statSync(box.storePath).mode & 0o777, 0o600);
});

test("MATCH needs the workspace to be trusted as well: an approved hash in an untrusted workspace relaxes nothing", (t) => {
  const box = sandbox(t);
  fs.writeFileSync(box.projectFile, RELAXING);
  box.approve(sha256(RELAXING));
  const loaded = box.load({ workspaceTrusted: false });
  assert.deepEqual([loaded.project.status, loaded.project.relaxationsApply, loaded.project.approvalPending], ["MATCH", false, false]);
  assert.equal(effectiveVerificationMode(loaded.effective).value, "approve");
  assert.match(loaded.notices[0], /not applied \(MATCH: the workspace is not trusted\)/);
});

test("MISMATCH: a changed file loses its relaxations at once and keeps its restrictions (headless: tighter, not stopped)", (t) => {
  const box = sandbox(t);
  fs.writeFileSync(box.projectFile, RELAXING);
  box.approve(sha256(RELAXING));
  assert.equal(box.load().project.relaxationsApply, true);
  // One byte of whitespace is a different file.
  for (const changed of [`${RELAXING}\n`, RELAXING.replace('"ci/**"', '"**"'), RELAXING.replace("dist/**", "dist/*")]) {
    fs.writeFileSync(box.projectFile, changed);
    const loaded = box.load();
    assert.deepEqual([loaded.project.status, loaded.project.relaxationsApply, loaded.project.approvalPending], ["MISMATCH", false, true], changed);
    assert.equal(loaded.effective.verification.relaxation, undefined);
    assert.equal(effectiveVerificationMode(loaded.effective).value, "approve");
    assert.equal(loaded.effective.paths.protected.values.length, 1, "the restrictive part still applies");
    assert.deepEqual(loaded.notices, [`nexus: project policy ${box.projectFile} asks to relax verification protection; not applied (MISMATCH: the file changed since it was approved). Its restrictions still apply.`]);
  }
  // The stored approval is untouched by loading, and restoring the approved bytes restores MATCH.
  assert.equal(readPolicyTrustStore(fs, box.storePath).records.get(box.workspace)?.sha256, sha256(RELAXING));
  fs.writeFileSync(box.projectFile, RELAXING);
  assert.equal(box.load().project.status, "MATCH");
});

test("MISMATCH without relaxations: nothing is pending and nothing is said", (t) => {
  const box = sandbox(t);
  const tightening = JSON.stringify({ verificationPaths: { mode: "block" } });
  fs.writeFileSync(box.projectFile, tightening);
  box.approve(HASH_A);
  const loaded = box.load();
  assert.deepEqual([loaded.project.status, loaded.project.approvalPending, loaded.notices], ["MISMATCH", false, []]);
  assert.equal(effectiveVerificationMode(loaded.effective).value, "block");
  // An untrusted, unapproved workspace gets the tightening too.
  assert.equal(effectiveVerificationMode(box.load({ workspaceTrusted: false }).effective).value, "block");
});

test("REMOVED: an approved file that is gone is reported", (t) => {
  const box = sandbox(t);
  box.approve(HASH_A);
  const loaded = box.load();
  assert.deepEqual([loaded.project.status, loaded.project.tier, loaded.project.relaxationsApply], ["REMOVED", undefined, false]);
  assert.deepEqual(loaded.notices, [`nexus: project policy ${box.projectFile} was approved earlier and is now missing; its restrictions no longer apply.`]);
});

test("ENV_TRUSTED: the environment trust applies the relaxations of an unapproved file", (t) => {
  const box = sandbox(t);
  fs.writeFileSync(box.projectFile, RELAXING);
  for (const workspaceTrusted of [false, true]) {
    const loaded = box.load({ workspaceTrusted, envTrustRequested: true });
    assert.deepEqual([loaded.project.status, loaded.project.relaxationsApply, loaded.project.approvalPending, loaded.notices], ["ENV_TRUSTED", true, false, []]);
    assert.equal(effectiveVerificationMode(loaded.effective).value, "off");
  }
});

test("workspace.disable_env_trust in a managed tier: the environment trust counts for nothing, with a notice naming the source", (t) => {
  const box = sandbox(t);
  fs.writeFileSync(box.projectFile, RELAXING);
  fs.writeFileSync(box.userPath, "schema_version = 1\n[workspace]\ndisable_env_trust = true\n", { mode: 0o600 });
  const loaded = box.load({ workspaceTrusted: false, envTrustRequested: true });
  assert.deepEqual([loaded.project.status, loaded.project.relaxationsApply], ["NEW", false]);
  assert.equal(effectiveVerificationMode(loaded.effective).value, "approve");
  assert.deepEqual(loaded.notices, [
    `NEXUS_TRUST_WORKSPACE is ignored: managed policy disables it. [policy: user ${box.userPath} workspace.disable_env_trust]`,
    `nexus: project policy ${box.projectFile} asks to relax verification protection; not applied (NEW: the file was never approved). Its restrictions still apply.`,
  ]);
  // An approval the operator recorded still counts: the switch is about the environment variable only.
  box.approve(sha256(RELAXING));
  assert.deepEqual([box.load({ envTrustRequested: true }).project.status, box.load({ envTrustRequested: true }).project.relaxationsApply], ["MATCH", true]);
});

test("a managed [verification] setting voids the relaxations of an approved file, in every trust state", (t) => {
  const box = sandbox(t);
  fs.writeFileSync(box.projectFile, RELAXING);
  box.approve(sha256(RELAXING));
  for (const managed of ['mode = "approve"', 'mode = "block"', 'protected = ["ci/**"]', "protected = []"]) {
    fs.writeFileSync(box.userPath, `schema_version = 1\n[verification]\n${managed}\n`, { mode: 0o600 });
    for (const trust of [{}, { envTrustRequested: true }, { workspaceTrusted: false, envTrustRequested: true }]) {
      const loaded = box.load(trust);
      assert.equal(loaded.effective.verification.relaxation, undefined, managed);
      assert.deepEqual([loaded.project.relaxationsApply, loaded.project.approvalPending], [false, false], managed);
      assert.equal(effectiveVerificationMode(loaded.effective).value, managed.includes("block") ? "block" : "approve", managed);
      const key = managed.startsWith("mode") ? "verification.mode" : "verification.protected";
      assert.deepEqual(loaded.notices, [`nexus: project policy ${box.projectFile} asks to relax verification protection; ignored, because managed policy sets it. [policy: user ${box.userPath} ${key}]`]);
    }
  }
});

test("a project file that cannot be parsed is not fatal and not silent; it is hashed before it is parsed", (t) => {
  const box = sandbox(t);
  const cases: [string | Buffer, string][] = [
    ['{ "verificationPaths": { "mode": "off" }', "the file is not valid JSON"],
    ["", "the file is not valid JSON"],
    ["[]", "the file must contain a JSON object"],
    ['"off"', "the file must contain a JSON object"],
    [Buffer.from([0x7b, 0xff, 0x7d]), "the file is not valid UTF-8"],
    [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]), "the file starts with a byte-order mark; save it as UTF-8 without a BOM"],
  ];
  for (const [content, reason] of cases) {
    fs.writeFileSync(box.projectFile, content);
    for (const trust of [{}, { envTrustRequested: true }]) {
      const loaded = box.load(trust);
      assert.equal(loaded.project.sha256, createHash("sha256").update(content).digest("hex"));
      assert.deepEqual([loaded.project.error, loaded.project.tier, loaded.project.relaxationsApply], [reason, undefined, false]);
      assert.deepEqual(loaded.effective.tiers, []);
      assert.deepEqual(loaded.notices, [`nexus: project policy ${box.projectFile} could not be used (${reason}); its restrictions and relaxations are NOT applied. Managed policy and the built-in defaults still apply.`]);
    }
  }
});

test("a project file that is a symbolic link, a directory or too large is not read: UNREADABLE, with a notice", (t) => {
  if (process.platform === "win32") return t.skip("symbolic links need privileges on Windows");
  const box = sandbox(t);
  const elsewhere = path.join(path.dirname(box.workspace), "elsewhere.json");
  fs.writeFileSync(elsewhere, RELAXING);
  fs.symlinkSync(elsewhere, box.projectFile);
  box.approve(sha256(RELAXING));
  let loaded = box.load({ envTrustRequested: true });
  assert.deepEqual([loaded.project.status, loaded.project.sha256, loaded.project.tier, loaded.project.relaxationsApply], ["UNREADABLE", undefined, undefined, false]);
  assert.match(loaded.notices[0], /could not be used \(the file is a symbolic link; it must be a regular file\); its restrictions and relaxations are NOT applied/);
  assert.equal(effectiveVerificationMode(loaded.effective).value, "approve");

  fs.rmSync(box.projectFile);
  fs.mkdirSync(box.projectFile);
  assert.equal(box.load().project.status, "UNREADABLE");
  fs.rmdirSync(box.projectFile);
  fs.writeFileSync(box.projectFile, JSON.stringify({ protectedPaths: ["x".repeat(70_000)] }));
  loaded = box.load();
  assert.deepEqual([loaded.project.status, loaded.project.error], ["UNREADABLE", "the file is larger than 64 KiB"]);
});

test("the legacy settings a project file may carry are reported, never dropped quietly", (t) => {
  const box = sandbox(t);
  fs.writeFileSync(box.projectFile, JSON.stringify({ blockedCommands: ["curl | sh"], protectedPaths: "all", egressInspector: { mode: "off" } }));
  const loaded = box.load();
  assert.deepEqual(loaded.project.blockedCommandPatterns, ["curl | sh"]);
  assert.deepEqual(loaded.notices, [
    `nexus: project policy ${box.projectFile}: protectedPaths is not an array and was ignored.`,
    `nexus: project policy ${box.projectFile}: egressInspector is ignored: a repository cannot change the egress inspector.`,
  ]);
});

test("the approval store: other workspaces are kept, a broken store approves nothing and is reported, a bad hash is refused", (t) => {
  const box = sandbox(t);
  fs.writeFileSync(box.projectFile, RELAXING);
  recordProjectPolicyApproval({ fs, storePath: box.storePath, workspace: "/another/workspace", sha256: HASH_B, approvedAt: "2026-11-01T00:00:00.000Z" });
  box.approve(sha256(RELAXING));
  box.approve(sha256(RELAXING));
  const store = readPolicyTrustStore(fs, box.storePath);
  assert.deepEqual([...store.records.keys()].sort(), ["/another/workspace", box.workspace].sort());
  assert.equal(store.problem, undefined);
  // An approval is per workspace: the other workspace's hash does nothing here.
  assert.equal(policyIntegrity({ stored: store.records.get("/another/workspace"), currentSha256: sha256(RELAXING), workspaceTrusted: true, envTrustRequested: false, disableEnvTrust: false }).status, "MISMATCH");

  assert.throws(() => recordProjectPolicyApproval({ fs, storePath: box.storePath, workspace: box.workspace, sha256: "nope", approvedAt: "x" }), /64 lowercase hexadecimal digits/);

  for (const [broken, problem] of [
    ["{ not json", "the file is not valid JSON"],
    ['{"version": 2, "workspaces": {}}', "the file is not a version 1 policy trust store"],
    ["[]", "the file is not a version 1 policy trust store"],
  ]) {
    fs.writeFileSync(box.storePath, broken);
    const loaded = box.load();
    assert.deepEqual([loaded.project.status, loaded.project.relaxationsApply], ["NEW", false], broken);
    assert.equal(loaded.notices[0], `nexus: ${box.storePath} could not be used (${problem}); no project policy counts as approved.`);
  }
  // A record of the wrong shape is no record.
  fs.writeFileSync(box.storePath, JSON.stringify({ version: 1, workspaces: { [box.workspace]: { sha256: "ABC", approvedAt: 5 }, x: null } }));
  assert.equal(readPolicyTrustStore(fs, box.storePath).records.size, 0);
  assert.equal(box.load().project.status, "NEW");
  // Recording over a broken store replaces it with a sound one.
  fs.writeFileSync(box.storePath, "{ not json");
  box.approve(sha256(RELAXING));
  assert.equal(box.load().project.status, "MATCH");
});

test("a store that is a symbolic link is not followed", (t) => {
  if (process.platform === "win32") return t.skip("symbolic links need privileges on Windows");
  const box = sandbox(t);
  fs.writeFileSync(box.projectFile, RELAXING);
  const planted = path.join(box.workspace, "planted.json");
  fs.writeFileSync(planted, JSON.stringify({ version: 1, workspaces: { [box.workspace]: { sha256: sha256(RELAXING), approvedAt: "2026-11-22T10:00:00.000Z" } } }));
  fs.symlinkSync(planted, box.storePath);
  const loaded = box.load();
  assert.deepEqual([loaded.project.status, loaded.project.relaxationsApply], ["NEW", false]);
  assert.match(loaded.notices[0], /could not be used \(the file is a symbolic link; it must be a regular file\); no project policy counts as approved/);
});

test("end to end, in memory: a system floor holds against a relaxing project file under every trust input", () => {
  const SYSTEM = "/fake/etc/nexus/policy.toml";
  const relaxing = '{"verificationPaths":{"mode":"off","allow":["**"]},"allowedDomains":["attacker.example"]}';
  const store = JSON.stringify({ version: 1, workspaces: { "/fake/ws": { sha256: sha256(relaxing), approvedAt: "2026-11-22T10:00:00.000Z" } } });
  for (const workspaceTrusted of [false, true]) {
    for (const envTrustRequested of [false, true]) {
      for (const approved of [false, true]) {
        const fake = new FakeFs()
          .dir("/fake/etc/nexus")
          .put(SYSTEM, 'schema_version = 1\n[verification]\nmode = "block"\n[egress]\nallowed_domains = ["example.com"]\n[approval]\nstrict = true\n')
          .put("/fake/ws/.nexus-security.json", relaxing, { uid: 1000 });
        if (approved) fake.put("/fake/store.json", store, { uid: 1000 });
        const loaded = loadManagedPolicy({ systemPath: SYSTEM, systemOwnerUid: 0, userPath: "/fake/user.toml", userUid: 1000, workspace: "/fake/ws", trust: { workspaceTrusted, envTrustRequested, storePath: "/fake/store.json" }, fs: fake });
        const label = JSON.stringify({ workspaceTrusted, envTrustRequested, approved });
        assert.deepEqual(effectiveVerificationMode(loaded.effective), { value: "block", source: { tier: "system", file: SYSTEM, key: "verification.mode", line: 3 } }, label);
        assert.equal(loaded.effective.verification.relaxation, undefined, label);
        // The project's allowlist can only narrow the system's: here, to nothing.
        assert.deepEqual([loaded.effective.egress.allowed_domains.restricted, loaded.effective.egress.allowed_domains.values], [true, []], label);
        assert.equal(loaded.effective.approval.disable_yes.value, true, label);
        assert.equal(fake.openCount, 0);
      }
    }
  }
});
