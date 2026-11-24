/**
 * GV-1 enforcement, in process: the configuration builder, the security manager, workspace trust and the approval gate
 * under policies injected through the library's explicit inputs (an in-memory file system). The machine's own system
 * policy is never the subject: every policy below lives in memory, except where a test says it uses the real project
 * file reader on a temporary workspace.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfigWithPolicy } from "../src/config.js";
import { ApprovalPolicy, type PolicyContext } from "../src/core/approval_policy.js";
import { mergePolicies, type EffectivePolicy } from "../src/core/managed_policy.js";
import { ManagedPolicyError, PROJECT_POLICY_FILE_NAME, type LoadedPolicy } from "../src/core/managed_policy_load.js";
import { approvalDecisionSource, clampApprovalSettings, createPolicyHost } from "../src/core/policy_runtime.js";
import { SecurityManager } from "../src/security.js";
import { isWorkspaceTrusted, setWorkspaceTrusted } from "../src/workspace_trust.js";
import { FAKE_STORE, FAKE_SYSTEM, FAKE_USER, policyWorld, toml, type PolicyWorld } from "./helpers/policy_enforcement.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const NO_POLICY: EffectivePolicy = mergePolicies();
const SYSTEM_TAG = (key: string): string => `[policy: system ${FAKE_SYSTEM} ${key}]`;
const BASE = { endpoint: "http://127.0.0.1:9/v1", model: "m" };

let dirs: string[] = [];
let savedEnv: Record<string, string | undefined> = {};
function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}
function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
beforeEach(() => {
  // The operator's own settings must not leak into what these tests ask the builder for.
  for (const key of ["NEXUS_APPROVAL_MODE", "NEXUS_SANDBOX_NETWORK", "NEXUS_TRUST_WORKSPACE", "NEXUS_EGRESS_POLICY"]) setEnv(key, undefined);
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv = {};
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A security manager over a real temporary workspace whose policy comes from the in-memory world. */
function manager(world: PolicyWorld, workspace: string, trust: { workspaceTrusted?: boolean; envTrustRequested?: boolean } = {}): { security: SecurityManager; notices: string[]; loaded: () => LoadedPolicy } {
  const notices: string[] = [];
  let last: LoadedPolicy | undefined;
  const security = new SecurityManager(workspace, { policyFor: (ws) => (last = world.load(ws, trust)), notify: (notice) => notices.push(notice) });
  return { security, notices, loaded: () => last! };
}

describe("launch: what managed policy disables is refused, and the message names the policy source", () => {
  const refusals: { name: string; system: string; options: Record<string, unknown>; env?: [string, string]; message: string }[] = [
    { name: "--yes under approval.strict", system: toml("[approval]", "strict = true"), options: { yes: true }, message: `--yes is refused: managed policy disables it. ${SYSTEM_TAG("approval.strict")}` },
    { name: "--yes under approval.disable_yes", system: toml("[approval]", "disable_yes = true"), options: { yes: true }, message: `--yes is refused: managed policy disables it. ${SYSTEM_TAG("approval.disable_yes")}` },
    { name: "--yes under approval.disable_auto", system: toml("[approval]", "disable_auto = true"), options: { yes: true }, message: `--yes is refused: it selects approval mode 'auto', which managed policy disables. ${SYSTEM_TAG("approval.disable_auto")}` },
    { name: "--yes with --read-only is still an explicit --yes", system: toml("[approval]", "strict = true"), options: { yes: true, readOnly: true }, message: `--yes is refused: managed policy disables it. ${SYSTEM_TAG("approval.strict")}` },
    { name: "--mode auto under approval.disable_auto", system: toml("[approval]", "disable_auto = true"), options: { mode: "auto" }, message: `--mode auto is refused: managed policy disables approval mode 'auto'. ${SYSTEM_TAG("approval.disable_auto")}` },
    { name: "--mode auto under approval.strict", system: toml("[approval]", "strict = true"), options: { mode: "auto" }, message: `--mode auto is refused: managed policy disables approval mode 'auto'. ${SYSTEM_TAG("approval.strict")}` },
    { name: "NEXUS_APPROVAL_MODE=auto under approval.disable_auto", system: toml("[approval]", "disable_auto = true"), options: {}, env: ["NEXUS_APPROVAL_MODE", "auto"], message: `NEXUS_APPROVAL_MODE=auto is refused: managed policy disables approval mode 'auto'. ${SYSTEM_TAG("approval.disable_auto")}` },
    { name: "NEXUS_APPROVAL_MODE=auto under approval.disable_full_access", system: toml("[approval]", "disable_full_access = true"), options: {}, env: ["NEXUS_APPROVAL_MODE", "auto"], message: `NEXUS_APPROVAL_MODE=auto is refused: managed policy disables full access. ${SYSTEM_TAG("approval.disable_full_access")}` },
    { name: "a programmatic full-access setting under approval.disable_full_access", system: toml("[approval]", "disable_full_access = true"), options: { fullAccess: true, approve: true }, message: `the full-access setting is refused: managed policy disables full access. ${SYSTEM_TAG("approval.disable_full_access")}` },
    { name: "--sandbox none under sandbox.required", system: toml("[sandbox]", "required = true"), options: { sandbox: "none" }, message: `--sandbox none is refused: managed policy requires the sandbox. ${SYSTEM_TAG("sandbox.required")}` },
    { name: "--sandbox NONE under sandbox.required", system: toml("[sandbox]", "required = true"), options: { sandbox: " NONE " }, message: `--sandbox  NONE  is refused: managed policy requires the sandbox. ${SYSTEM_TAG("sandbox.required")}` },
    { name: "--sandbox-network under sandbox.forbid_network", system: toml("[sandbox]", "forbid_network = true"), options: { sandbox: "auto", sandboxNetwork: true }, message: `--sandbox-network is refused: managed policy forbids network access in the sandbox. ${SYSTEM_TAG("sandbox.forbid_network")}` },
    { name: "NEXUS_SANDBOX_NETWORK under sandbox.forbid_network", system: toml("[sandbox]", "forbid_network = true"), options: {}, env: ["NEXUS_SANDBOX_NETWORK", "On"], message: `NEXUS_SANDBOX_NETWORK is refused: managed policy forbids network access in the sandbox. ${SYSTEM_TAG("sandbox.forbid_network")}` },
  ];
  for (const row of refusals) {
    test(row.name, () => {
      if (row.env) setEnv(row.env[0], row.env[1]);
      const policy = policyWorld({ system: row.system }).host.managed().effective;
      assert.throws(() => buildConfigWithPolicy({ ...BASE, ...row.options }, policy), (error: Error) => {
        assert.equal(error.message, row.message);
        return true;
      });
      // The same request with no policy is what it always was: nothing is refused.
      assert.doesNotThrow(() => buildConfigWithPolicy({ ...BASE, ...row.options }, NO_POLICY));
    });
  }

  test("sandbox.required switches the sandbox on when none was asked for, and leaves an asked-for engine alone", () => {
    const policy = policyWorld({ system: toml("[sandbox]", "required = true") }).host.managed().effective;
    assert.equal(buildConfigWithPolicy({ ...BASE }, policy).sandbox, "auto");
    assert.equal(buildConfigWithPolicy({ ...BASE, sandbox: "bwrap" }, policy).sandbox, "bwrap");
    assert.equal(buildConfigWithPolicy({ ...BASE, sandbox: true }, policy).sandbox, true);
    assert.equal(buildConfigWithPolicy({ ...BASE }, NO_POLICY).sandbox, undefined);
  });

  test("what the policy does not disable is configured exactly as with no policy", () => {
    const policy = policyWorld({ system: toml("[approval]", "strict = true", "[sandbox]", "forbid_network = true") }).host.managed().effective;
    for (const options of [{}, { approve: true }, { mode: "review" }, { readOnly: true }, { mode: "read-only" }, { sandbox: "auto" }]) {
      assert.deepEqual(buildConfigWithPolicy({ ...BASE, ...options }, policy), buildConfigWithPolicy({ ...BASE, ...options }, NO_POLICY), JSON.stringify(options));
    }
    setEnv("NEXUS_APPROVAL_MODE", "review");
    assert.equal(buildConfigWithPolicy({ ...BASE }, policy).approvalMode, "review");
  });

  test("with no policy every approval request resolves as before", () => {
    const resolved = (options: Record<string, unknown>) => {
      const config = buildConfigWithPolicy({ ...BASE, ...options }, NO_POLICY);
      return [config.approvalMode, Boolean(config.fullAccess)];
    };
    assert.deepEqual(resolved({}), ["review", false]);
    assert.deepEqual(resolved({ yes: true }), ["auto", true]);
    assert.deepEqual(resolved({ mode: "auto" }), ["auto", false]);
    assert.deepEqual(resolved({ yes: true, readOnly: true }), ["read-only", false]);
    assert.deepEqual(resolved({ fullAccess: true }), ["auto", true]);
    setEnv("NEXUS_APPROVAL_MODE", "auto");
    assert.deepEqual(resolved({}), ["auto", true]);
    assert.deepEqual(resolved({ approve: true }), ["review", false]);
  });
});

describe("a project file cannot loosen a system value (through the enforcing code, per key)", () => {
  /** Everything a project file could write to try: the legacy relaxations, and keys it has no right to set. */
  const LOOSENING = {
    verificationPaths: { mode: "off", allow: ["**"] },
    protectedPaths: [],
    allowedDomains: ["evil.example", "example.com"],
    blockedCommands: [],
    egressInspector: { mode: "off" },
    approval: { strict: false, disable_auto: false, disable_yes: false, disable_full_access: false, require_human: [] },
    sandbox: { required: false, forbid_network: false },
    commands: { forbid: [], prompt: [], disable_allow_rules: false },
    workspace: { disable_env_trust: false },
    egress: { inspector: "record", allowed_domains: ["evil.example"] },
  };
  const projects: { name: string; write: (world: PolicyWorld, workspace: string) => { workspaceTrusted?: boolean; envTrustRequested?: boolean } }[] = [
    { name: "no project file", write: () => ({}) },
    { name: "an untrusted project file", write: (world, ws) => (world.project(ws, LOOSENING), {}) },
    { name: "a trusted and approved project file", write: (world, ws) => (world.project(ws, LOOSENING), world.approve(ws), { workspaceTrusted: true }) },
    { name: "an environment-trusted project file", write: (world, ws) => (world.project(ws, LOOSENING), { envTrustRequested: true }) },
    { name: "a malformed project file", write: (world, ws) => (world.project(ws, "{ not json"), { workspaceTrusted: true }) },
  ];
  const keys: { key: string; system: string; holds: (ctx: { effective: EffectivePolicy; security: SecurityManager; workspace: string }) => void }[] = [
    { key: "approval.strict", system: toml("[approval]", "strict = true"), holds: ({ effective }) => assert.throws(() => buildConfigWithPolicy({ ...BASE, yes: true }, effective), /--yes is refused.*\[policy: system .* approval\.strict\]/) },
    { key: "approval.disable_auto", system: toml("[approval]", "disable_auto = true"), holds: ({ effective }) => assert.throws(() => buildConfigWithPolicy({ ...BASE, mode: "auto" }, effective), /--mode auto is refused.*approval\.disable_auto\]/) },
    { key: "approval.disable_yes", system: toml("[approval]", "disable_yes = true"), holds: ({ effective }) => assert.throws(() => buildConfigWithPolicy({ ...BASE, yes: true }, effective), /--yes is refused.*approval\.disable_yes\]/) },
    { key: "approval.disable_full_access", system: toml("[approval]", "disable_full_access = true"), holds: ({ effective }) => assert.throws(() => buildConfigWithPolicy({ ...BASE, fullAccess: true }, effective), /is refused: managed policy disables full access.*approval\.disable_full_access\]/) },
    { key: "approval.require_human", system: toml("[approval]", 'require_human = ["exec"]'), holds: ({ effective }) => assert.equal(new ApprovalPolicy(() => effective).requiresDecision("exec", { mode: "auto", trusted: true, fullAccess: true }), true) },
    { key: "sandbox.required", system: toml("[sandbox]", "required = true"), holds: ({ effective }) => {
      assert.throws(() => buildConfigWithPolicy({ ...BASE, sandbox: "none" }, effective), /--sandbox none is refused.*sandbox\.required\]/);
      assert.equal(buildConfigWithPolicy({ ...BASE }, effective).sandbox, "auto");
    } },
    { key: "sandbox.forbid_network", system: toml("[sandbox]", "forbid_network = true"), holds: ({ effective }) => assert.throws(() => buildConfigWithPolicy({ ...BASE, sandbox: "auto", sandboxNetwork: true }, effective), /--sandbox-network is refused.*sandbox\.forbid_network\]/) },
    { key: "verification.mode", system: toml("[verification]", 'mode = "block"'), holds: ({ security, workspace }) => {
      assert.equal(security.getPolicy().verificationPaths?.mode, "block");
      assert.equal(security.getPolicy().verificationPaths?.allow, undefined, "the project's exemptions are void where a managed tier speaks");
      fs.writeFileSync(path.join(workspace, "Makefile"), "test:\n");
      const decision = security.verificationEditDecision("write_file", { path: "Makefile", content: "x" }, { fullAccess: true, operator: true });
      assert.equal(decision?.action, "deny");
      assert.equal(decision?.attribution, SYSTEM_TAG("verification.mode"));
    } },
    { key: "verification.protected", system: toml("[verification]", 'protected = ["release/**"]'), holds: ({ security }) => {
      assert.deepEqual(security.classifyVerificationPath("release/notes.txt"), { class: "test_config", rule: "release/**", source: "policy" });
      assert.equal(security.getPolicy().verificationPaths?.mode, "approve", "a project 'off' does not apply where a managed tier speaks about verification");
    } },
    { key: "paths.protected", system: toml("[paths]", 'protected = ["secrets"]'), holds: ({ security }) => {
      const check = security.isPathProtected("secrets/key.pem");
      assert.equal(check.protected, true);
      assert.match(check.reason!, /\[policy: system \/fake\/etc\/nexus\/policy\.toml paths\.protected\]$/);
      assert.equal(security.isPathProtected(".env").protected, true, "the built-in patterns stay");
    } },
    { key: "commands.forbid", system: toml("[commands]", 'forbid = ["git push"]'), holds: ({ security }) => {
      const check = security.isCommandBlocked("cd repo && git push origin main");
      assert.equal(check.blocked, true);
      assert.equal(check.reason, `Security Policy Violation: command refused: managed policy forbids 'git push'. ${SYSTEM_TAG("commands.forbid")}`);
      assert.equal(security.isCommandBlocked("git status").blocked, false);
    } },
    { key: "egress.allowed_domains", system: toml("[egress]", 'allowed_domains = ["example.com"]'), holds: ({ effective }) => {
      assert.deepEqual(effective.egress.allowed_domains.values.filter((host) => host !== "example.com"), [], "nothing the system does not list is reachable");
      assert.equal(effective.egress.allowed_domains.restricted, true);
      assert.equal(effective.egress.allowed_domains.source.tier, "system");
    } },
    { key: "egress.inspector", system: toml("[egress]", 'inspector = "block"'), holds: ({ security }) => assert.equal(security.getPolicy().egressInspector?.mode, "block") },
    { key: "workspace.disable_env_trust", system: toml("[workspace]", "disable_env_trust = true"), holds: ({ effective, workspace }) => {
      setEnv("NEXUS_TRUST_WORKSPACE", "1");
      assert.equal(isWorkspaceTrusted(workspace, false, effective), false);
    } },
  ];
  for (const row of keys) {
    for (const project of projects) {
      test(`${row.key}: ${project.name}`, () => {
        const world = policyWorld({ system: row.system });
        const workspace = tempDir("nexus-gv1-ws-");
        const trust = project.write(world, workspace);
        // The operator's own inspector setting asks for the least: the floor must still hold.
        setEnv("NEXUS_EGRESS_POLICY", JSON.stringify({ mode: "off" }));
        const { security, loaded } = manager(world, workspace, trust);
        row.holds({ effective: loaded().effective, security, workspace });
      });
    }
  }

  test("deleting the user file never goes below the system tier, and the user tier can only add", () => {
    const system = toml("[approval]", "disable_auto = true", "[paths]", 'protected = ["secrets"]', "[verification]", 'mode = "approve"');
    const user = toml("[approval]", "disable_yes = true", "[paths]", 'protected = ["notes"]', "[verification]", 'mode = "block"');
    const both = policyWorld({ system, user }).host.managed().effective;
    const systemOnly = policyWorld({ system }).host.managed().effective;
    assert.deepEqual(both.tiers, ["system", "user"]);
    assert.equal(both.verification.mode.value, "block");
    assert.deepEqual([...both.paths.protected.values], ["secrets", "notes"]);
    assert.equal(systemOnly.approval.disable_auto.value, true);
    assert.equal(systemOnly.verification.mode.value, "approve");
    assert.deepEqual([...systemOnly.paths.protected.values], ["secrets"]);
    assert.throws(() => buildConfigWithPolicy({ ...BASE, mode: "auto" }, systemOnly), /approval\.disable_auto\]/);
  });
});

describe("the project file: its restrictions always apply, its relaxations only when trusted and approved", () => {
  const RELAXING = { verificationPaths: { mode: "record", extra: ["deploy/**"], allow: ["docs/**"] }, protectedPaths: ["vault"], blockedCommands: ["terraform destroy"], allowedDomains: ["example.com"] };

  function expectRestrictions(security: SecurityManager): void {
    assert.equal(security.isPathProtected("vault/a").protected, true);
    assert.equal(security.isCommandBlocked("terraform destroy -auto-approve").blocked, true);
    assert.deepEqual(security.getPolicy().allowedDomains, ["example.com"]);
    assert.deepEqual(security.getPolicy().verificationPaths?.extra, ["deploy/**"]);
  }

  test("ABSENT: the built-in defaults, and nothing to say", () => {
    const world = policyWorld();
    const workspace = tempDir("nexus-gv1-ws-");
    const { security, notices, loaded } = manager(world, workspace);
    assert.equal(loaded().project.status, "ABSENT");
    assert.deepEqual(notices, []);
    assert.deepEqual(security.getPolicy().verificationPaths, { mode: "approve", extra: undefined, allow: undefined });
    assert.equal(security.getPolicy().allowedDomains, undefined);
    assert.equal(security.isPathProtected(".env").reason, "Security Policy Violation: Path '.env' matches protected pattern '.env*' [policy: default]");
    assert.equal(security.isPathProtected(path.join(os.homedir(), ".config", "nexus", "policy_trust.json")).protected, true, "the approval store is not the agent's to write");
  });

  test("NEW in an untrusted workspace: restrictions apply, relaxations are dropped, and the notice says how to approve", () => {
    const world = policyWorld();
    const workspace = tempDir("nexus-gv1-ws-");
    const file = world.project(workspace, RELAXING);
    const { security, notices, loaded } = manager(world, workspace);
    assert.equal(loaded().project.status, "NEW");
    expectRestrictions(security);
    assert.equal(security.getPolicy().verificationPaths?.mode, "approve");
    assert.equal(security.getPolicy().verificationPaths?.allow, undefined);
    assert.deepEqual(notices, [
      `nexus: project policy ${file} asks to relax verification protection; not applied (NEW: the file was never approved). Its restrictions still apply.`,
      `nexus: to apply the relaxations of ${file}, review the file and approve it with \`nexus trust ${workspace}\`; a later change to the file needs a new approval.`,
    ]);
  });

  test("NEW in a trusted workspace: trust alone does not apply a relaxation that was never approved", () => {
    const world = policyWorld();
    const workspace = tempDir("nexus-gv1-ws-");
    world.project(workspace, RELAXING);
    const { security, notices, loaded } = manager(world, workspace, { workspaceTrusted: true });
    assert.equal(loaded().project.status, "NEW");
    assert.equal(loaded().project.approvalPending, true);
    assert.equal(security.getPolicy().verificationPaths?.mode, "approve");
    assert.equal(notices.length, 2);
  });

  test("MATCH: the approved file's relaxations apply, with its restrictions", () => {
    const world = policyWorld();
    const workspace = tempDir("nexus-gv1-ws-");
    world.project(workspace, RELAXING);
    world.approve(workspace);
    const { security, notices, loaded } = manager(world, workspace, { workspaceTrusted: true });
    assert.equal(loaded().project.status, "MATCH");
    assert.deepEqual(notices, []);
    expectRestrictions(security);
    assert.deepEqual(security.getPolicy().verificationPaths, { mode: "record", extra: ["deploy/**"], allow: ["docs/**"] });
  });

  test("MATCH without workspace trust: an approval does not outlive the trust", () => {
    const world = policyWorld();
    const workspace = tempDir("nexus-gv1-ws-");
    world.project(workspace, RELAXING);
    world.approve(workspace);
    const { security, loaded } = manager(world, workspace, { workspaceTrusted: false });
    assert.equal(loaded().project.status, "MATCH");
    assert.equal(security.getPolicy().verificationPaths?.mode, "approve");
  });

  test("MISMATCH: a file changed after approval loses its relaxations and keeps its restrictions", () => {
    const world = policyWorld();
    const workspace = tempDir("nexus-gv1-ws-");
    world.project(workspace, RELAXING);
    world.approve(workspace);
    const file = world.project(workspace, { ...RELAXING, verificationPaths: { ...RELAXING.verificationPaths, mode: "off" } });
    const { security, notices, loaded } = manager(world, workspace, { workspaceTrusted: true });
    assert.equal(loaded().project.status, "MISMATCH");
    expectRestrictions(security);
    assert.equal(security.getPolicy().verificationPaths?.mode, "approve");
    assert.equal(security.getPolicy().verificationPaths?.allow, undefined);
    assert.equal(notices[0], `nexus: project policy ${file} asks to relax verification protection; not applied (MISMATCH: the file changed since it was approved). Its restrictions still apply.`);
    assert.match(notices[1], /approve it with `nexus trust /);
  });

  test("REMOVED: an approved file that is gone is reported", () => {
    const world = policyWorld();
    const workspace = tempDir("nexus-gv1-ws-");
    const file = world.project(workspace, RELAXING);
    world.approve(workspace);
    world.fake.nodes.delete(file);
    const { security, notices, loaded } = manager(world, workspace, { workspaceTrusted: true });
    assert.equal(loaded().project.status, "REMOVED");
    assert.deepEqual(notices, [`nexus: project policy ${file} was approved earlier and is now missing; its restrictions no longer apply.`]);
    assert.equal(security.getPolicy().verificationPaths?.mode, "approve");
  });

  test("ENV_TRUSTED: NEXUS_TRUST_WORKSPACE applies the relaxations, unless managed policy disables it", () => {
    const workspace = tempDir("nexus-gv1-ws-");
    const open = policyWorld();
    open.project(workspace, RELAXING);
    const trusted = manager(open, workspace, { envTrustRequested: true });
    assert.equal(trusted.loaded().project.status, "ENV_TRUSTED");
    assert.equal(trusted.security.getPolicy().verificationPaths?.mode, "record");
    assert.deepEqual(trusted.notices, []);

    const closed = policyWorld({ system: toml("[workspace]", "disable_env_trust = true") });
    closed.project(workspace, RELAXING);
    const refused = manager(closed, workspace, { envTrustRequested: true });
    assert.equal(refused.loaded().project.status, "NEW");
    assert.equal(refused.security.getPolicy().verificationPaths?.mode, "approve");
    assert.equal(refused.notices[0], `nexus: NEXUS_TRUST_WORKSPACE is ignored: managed policy disables it. ${SYSTEM_TAG("workspace.disable_env_trust")}`);
    expectRestrictions(refused.security);
  });

  test("a file that does not parse is not fatal and not silent: defaults, no relaxations, one notice", () => {
    const world = policyWorld();
    const workspace = tempDir("nexus-gv1-ws-");
    const file = world.project(workspace, '{ "verificationPaths": { "mode": "off" }, ');
    const { security, notices } = manager(world, workspace, { workspaceTrusted: true, envTrustRequested: true });
    assert.deepEqual(notices, [`nexus: project policy ${file} could not be used (the file is not valid JSON); its restrictions and relaxations are NOT applied. Managed policy and the built-in defaults still apply.`]);
    assert.deepEqual(security.getPolicy().verificationPaths, { mode: "approve", extra: undefined, allow: undefined });
    assert.equal(security.isPathProtected(".env").protected, true);
    assert.equal(security.isCommandBlocked("mkfs /dev/sda1").blocked, true);
  });

  test("the real reader refuses a symbolic link and an oversized file, loudly, and reads an ordinary file", () => {
    setEnv("NEXUS_TRUST_WORKSPACE", "1");
    const workspace = tempDir("nexus-gv1-ws-");
    const elsewhere = tempDir("nexus-gv1-else-");
    const file = path.join(workspace, PROJECT_POLICY_FILE_NAME);
    const read = (): { security: SecurityManager; notices: string[] } => {
      const notices: string[] = [];
      return { security: new SecurityManager(workspace, { notify: (notice) => notices.push(notice) }), notices };
    };

    fs.writeFileSync(file, JSON.stringify({ verificationPaths: { mode: "off" }, protectedPaths: ["vault"] }));
    const ordinary = read();
    assert.equal(ordinary.security.getPolicy().verificationPaths?.mode, "off", "environment trust applies the relaxation, as before");
    assert.equal(ordinary.security.isPathProtected("vault/x").reason, `Security Policy Violation: Path 'vault/x' is protected under security policy [policy: project ${file} paths.protected]`);
    assert.deepEqual(ordinary.notices, []);

    fs.rmSync(file);
    fs.writeFileSync(path.join(elsewhere, "policy.json"), JSON.stringify({ verificationPaths: { mode: "off" } }));
    fs.symlinkSync(path.join(elsewhere, "policy.json"), file);
    const linked = read();
    assert.equal(linked.security.getPolicy().verificationPaths?.mode, "approve");
    assert.deepEqual(linked.notices, [`nexus: project policy ${file} could not be used (the file is a symbolic link; it must be a regular file); its restrictions and relaxations are NOT applied. Managed policy and the built-in defaults still apply.`]);

    fs.rmSync(file);
    fs.writeFileSync(file, JSON.stringify({ verificationPaths: { mode: "off" }, pad: "x".repeat(70 * 1024) }));
    const large = read();
    assert.equal(large.security.getPolicy().verificationPaths?.mode, "approve");
    assert.match(large.notices[0], /could not be used \(the file is larger than 64 KiB\)/);
  });

  test("`nexus trust` is the approval: it records the file's hash, and a later change needs it again", () => {
    setEnv("HOME", tempDir("nexus-gv1-home-"));
    const workspace = tempDir("nexus-gv1-ws-");
    const file = path.join(workspace, PROJECT_POLICY_FILE_NAME);
    fs.writeFileSync(file, JSON.stringify({ verificationPaths: { mode: "record" } }));
    const mode = (): string | undefined => new SecurityManager(workspace, { notify: () => {} }).getPolicy().verificationPaths?.mode;
    assert.equal(mode(), "approve", "never approved");
    setWorkspaceTrusted(workspace, true);
    assert.equal(mode(), "record", "trusted and approved");
    fs.writeFileSync(file, JSON.stringify({ verificationPaths: { mode: "off" } }));
    assert.equal(mode(), "approve", "changed since the approval");
    setWorkspaceTrusted(workspace, true);
    assert.equal(mode(), "off", "approved again");
    setWorkspaceTrusted(workspace, false);
    assert.equal(mode(), "approve", "trust removed");
  });

  test("an allowlist that admits nothing does not read as no allowlist", () => {
    const world = policyWorld();
    const workspace = tempDir("nexus-gv1-ws-");
    world.project(workspace, { allowedDomains: ["Not A Host", 7] });
    const { security, notices } = manager(world, workspace);
    const list = security.getPolicy().allowedDomains!;
    assert.equal(list.length, 1);
    assert.equal(["example.com", "a.example.com"].some((domain) => list.some((entry) => domain === entry.toLowerCase() || domain.endsWith(`.${entry.toLowerCase()}`))), false);
    assert.equal(notices.length, 2, "each dropped entry is reported");
  });

  test("a project's blocked command names the project file", () => {
    const world = policyWorld();
    const workspace = tempDir("nexus-gv1-ws-");
    const file = world.project(workspace, RELAXING);
    const { security } = manager(world, workspace);
    assert.equal(security.isCommandBlocked("terraform destroy").reason, `Destructive-command tripwire: Command matches blocked pattern 'terraform destroy' [policy: project ${file} blockedCommands]`);
  });

  test("a verification refusal names the tier that set the mode, the default included", () => {
    const workspace = tempDir("nexus-gv1-ws-");
    fs.writeFileSync(path.join(workspace, "Makefile"), "test:\n");
    const byDefault = manager(policyWorld(), workspace).security.authorizeVerificationEdit("write_file", { path: "Makefile", content: "x" });
    assert.equal(byDefault.allowed, false);
    assert.match((byDefault as { error: string }).error, / \[policy: default\]$/);
    const world = policyWorld({ user: toml("[verification]", 'mode = "block"') });
    const byUser = manager(world, workspace).security.authorizeVerificationEdit("write_file", { path: "Makefile", content: "x" }, { fullAccess: true, operator: true });
    assert.ok((byUser as { error: string }).error.endsWith(` [policy: user ${FAKE_USER} verification.mode]`));
  });

  test("the egress inspector runs at least at the managed floor, and says when it was raised", () => {
    setEnv("NEXUS_EGRESS_POLICY", JSON.stringify({ mode: "off", allowDestinations: ["example.com"] }));
    const workspace = tempDir("nexus-gv1-ws-");
    const raised = manager(policyWorld({ system: toml("[egress]", 'inspector = "record"') }), workspace);
    assert.deepEqual(raised.security.getPolicy().egressInspector, { mode: "record", allowDestinations: ["example.com"] });
    assert.deepEqual(raised.notices, [`nexus: the egress inspector runs in 'record' mode, not 'off': managed policy sets the floor. ${SYSTEM_TAG("egress.inspector")}`]);
    assert.equal(manager(policyWorld(), workspace).security.getPolicy().egressInspector?.mode, "off", "no floor: the operator's own setting");
  });
});

describe("workspace trust", () => {
  test("NEXUS_TRUST_WORKSPACE=1 grants trust only where no managed tier disables it", () => {
    const workspace = tempDir("nexus-gv1-ws-");
    setEnv("HOME", tempDir("nexus-gv1-home-"));
    const disabled = policyWorld({ user: toml("[workspace]", "disable_env_trust = true") }).host.managed().effective;
    assert.equal(isWorkspaceTrusted(workspace, false, NO_POLICY), false);
    setEnv("NEXUS_TRUST_WORKSPACE", "1");
    assert.equal(isWorkspaceTrusted(workspace, false, NO_POLICY), true);
    assert.equal(isWorkspaceTrusted(workspace, true, NO_POLICY), false, "read-only never trusts");
    assert.equal(isWorkspaceTrusted(workspace, false, disabled), false);
    setEnv("NEXUS_TRUST_WORKSPACE", undefined);
    setWorkspaceTrusted(workspace, true);
    assert.equal(isWorkspaceTrusted(workspace, false, disabled), true, "the operator's own trust store still counts");
  });
});

describe("the approval gate", () => {
  const ask = (policy: EffectivePolicy, effect: Parameters<ApprovalPolicy["requiresDecision"]>[0], context: Partial<PolicyContext>): boolean =>
    new ApprovalPolicy(() => policy).requiresDecision(effect, { mode: "review", trusted: true, ...context });

  test("under approval.strict no caller's context selects automatic approval or full access", () => {
    const strict = policyWorld({ system: toml("[approval]", "strict = true") }).host.managed().effective;
    for (const effect of ["exec", "write_workspace", "egress"] as const) {
      assert.equal(ask(strict, effect, { mode: "auto", fullAccess: true }), true, effect);
      assert.equal(ask(NO_POLICY, effect, { mode: "auto", fullAccess: true }), false, `${effect} with no policy`);
    }
    assert.equal(ask(strict, "read_workspace", { mode: "auto", fullAccess: true }), false);
    assert.equal(ask(strict, "exec", { mode: "read-only" }), false, "read-only is decided as before");
  });

  test("approval.require_human asks in every mode, also for an origin approved earlier", () => {
    const policy = policyWorld({ system: toml("[approval]", 'require_human = ["egress"]') }).host.managed().effective;
    const approved = { egressOrigin: "https://example.com", approvedEgressOrigins: new Set(["https://example.com"]) };
    assert.equal(ask(policy, "egress", { mode: "auto", fullAccess: true, ...approved }), true);
    assert.equal(ask(NO_POLICY, "egress", { mode: "auto", fullAccess: true, ...approved }), false);
    assert.equal(ask(policy, "exec", { mode: "auto" }), false, "an effect the policy does not name");
  });

  test("a caller's managed requirement holds under full access", () => {
    assert.equal(ask(NO_POLICY, "exec", { mode: "auto", fullAccess: true, policyRequiresHuman: true }), true);
    assert.equal(ask(NO_POLICY, "exec", { mode: "auto", fullAccess: true }), false);
  });

  test("the clamp only ever lowers, and the decision names the tier that lowered it", () => {
    const strict = policyWorld({ system: toml("[approval]", "strict = true") }).host.managed().effective;
    assert.deepEqual(clampApprovalSettings(strict, { mode: "auto", fullAccess: true }), { mode: "review", fullAccess: false });
    assert.deepEqual(clampApprovalSettings(strict, { mode: "read-only", fullAccess: false }), { mode: "read-only", fullAccess: false });
    assert.deepEqual(clampApprovalSettings(NO_POLICY, { mode: "auto", fullAccess: true }), { mode: "auto", fullAccess: true });
    assert.deepEqual(clampApprovalSettings(NO_POLICY, { mode: "review" }), { mode: "review", fullAccess: false });
    assert.deepEqual(approvalDecisionSource(strict, { mode: "auto" }), { tier: "system", file: FAKE_SYSTEM, key: "approval.strict", line: 3 });
    assert.deepEqual(approvalDecisionSource(NO_POLICY, { mode: "review" }), { tier: "default", key: "approval.mode" });
  });
});

describe("one load per process, frozen", () => {
  test("the managed files are read once, whatever changes afterwards", () => {
    const world = policyWorld({ system: toml("[approval]", "strict = true"), user: toml("[paths]", 'protected = ["notes"]') });
    const first = world.host.managed();
    const opensAfterFirst = world.fake.openFlags.length;
    assert.equal(world.fake.touched.filter((file) => file === FAKE_SYSTEM).length, 2, "one lstat and one open");

    // The files change, and are even removed: a running process keeps the policy it started with.
    world.fake.put(FAKE_SYSTEM, toml("[approval]", "strict = false"));
    world.fake.nodes.delete(FAKE_USER);
    const second = world.host.managed();
    assert.equal(second, first, "the same object");
    assert.equal(world.fake.openFlags.length, opensAfterFirst, "no file was opened again");
    assert.equal(second.effective.approval.strict.value, true);

    const workspace = "/fake/ws";
    world.project(workspace, { protectedPaths: ["vault"] });
    const loaded = world.load(workspace);
    assert.deepEqual([...loaded.effective.paths.protected.values], ["notes", "vault"], "a project file is merged under the tiers already read");
    assert.equal(loaded.effective.approval.strict.value, true);
    assert.equal(world.fake.touched.filter((file) => file === FAKE_SYSTEM || file === FAKE_USER).length, 4, "the managed files were not read for the workspace");
  });

  test("different inputs on a later call change nothing", () => {
    const strict = policyWorld({ system: toml("[approval]", "strict = true") });
    const open = policyWorld();
    let calls = 0;
    const host = createPolicyHost(() => (++calls === 1 ? strict.inputs : open.inputs));
    assert.equal(host.managed().effective.approval.strict.value, true);
    assert.equal(host.managed().effective.approval.strict.value, true);
    assert.equal(host.forWorkspace("/fake/ws", { workspaceTrusted: true, envTrustRequested: true }).effective.approval.strict.value, true);
    assert.equal(open.fake.touched.filter((file) => file === FAKE_SYSTEM || file === FAKE_USER).length, 0, "the second inputs' managed files were never looked at");
  });

  test("the result is frozen all the way down", () => {
    const state = policyWorld({ system: toml("[approval]", "strict = true", "[commands]", 'forbid = ["git push"]') }).host.managed();
    assert.ok(Object.isFrozen(state) && Object.isFrozen(state.tiers) && Object.isFrozen(state.tiers.system!.document.approval) && Object.isFrozen(state.effective.commands.forbid.items[0]));
    assert.throws(() => { (state.effective.approval.strict as { value: boolean }).value = false; }, TypeError);
    assert.throws(() => { (state.tiers.system!.document.approval as { strict?: boolean }).strict = false; }, TypeError);
    assert.throws(() => { (state.tiers as { system?: unknown }).system = undefined; }, TypeError);
    assert.throws(() => { (state.effective.commands.forbid.values as string[]).length = 0; }, TypeError);
  });

  test("a broken managed file fails every use with the same error, and is not read again", () => {
    const world = policyWorld({ system: "schema_version = 1\n[approval]\nstrict = maybe\n" });
    let first: unknown;
    assert.throws(() => world.host.managed(), (error: unknown) => (first = error) instanceof ManagedPolicyError);
    world.fake.put(FAKE_SYSTEM, toml());
    assert.throws(() => world.host.managed(), (error: unknown) => error === first);
    assert.throws(() => world.load("/fake/ws"), (error: unknown) => error === first);
    assert.throws(() => world.host.approveProjectPolicy("/fake/ws", "2026-01-01T00:00:00.000Z"), (error: unknown) => error === first);
    assert.equal(world.fake.openFlags.length, 1);
    assert.equal(world.fake.nodes.has(FAKE_STORE), false);
  });
});

describe("production has no seam", () => {
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : entry.name.endsWith(".ts") ? [path.join(dir, entry.name)] : []));
  const sources = new Map(files(SRC).map((file) => [path.relative(SRC, file), fs.readFileSync(file, "utf8")]));
  const filesWith = (pattern: RegExp): string[] => [...sources].filter(([, text]) => pattern.test(text)).map(([file]) => file).sort();

  test("no environment variable, argument or setter relocates or switches off the policy", () => {
    const policyModules = ["core/policy_runtime.ts", "core/managed_policy.ts", "core/managed_policy_load.ts", "core/managed_policy_toml.ts"];
    for (const file of policyModules) {
      assert.doesNotMatch(sources.get(file)!, /process\s*\.\s*(env|argv|execArgv)|process\s*\[/, `${file} reads the environment or the arguments`);
    }
    // The inputs module reads only the platform and the effective uid.
    assert.deepEqual((sources.get("core/managed_policy_inputs.ts")!.match(/process\.\w+/g) ?? []).sort(), ["process.geteuid", "process.geteuid", "process.platform"]);
    // No variable or flag is named after the policy or its location.
    assert.deepEqual(filesWith(/NEXUS_[A-Z_]*POLICY_(PATH|FILE|DIR|DISABLE|SKIP|OFF)|NEXUS_(NO|SKIP|DISABLE|IGNORE)_[A-Z_]*POLICY|NEXUS_MANAGED|--(no-|skip-|ignore-)?(managed-)?policy(-file|-path)?\b/), []);
    // The system path constant and the production inputs are used in exactly these places.
    assert.deepEqual(filesWith(/\bSYSTEM_POLICY_PATH\b/), ["core/managed_policy_inputs.ts", "core/managed_policy_load.ts"]);
    assert.deepEqual(filesWith(/\bresolveProductionPolicyInputs\b/), ["core/managed_policy_inputs.ts", "core/policy_runtime.ts"]);
    assert.deepEqual(filesWith(/\bcreatePolicyHost\s*\(/), ["core/policy_runtime.ts"]);
    assert.equal(sources.get("core/policy_runtime.ts")!.match(/createPolicyHost\s*\(/g)!.length, 2, "its definition, and the one process host");
    assert.match(sources.get("core/policy_runtime.ts")!, /^const processHost = createPolicyHost\(resolveProductionPolicyInputs\);$/m);
    // Nothing exported from the runtime module assigns the process host or its state.
    const exported = [...sources.get("core/policy_runtime.ts")!.matchAll(/^export (?:function|const|let|var|class|interface|type) (\w+)/gm)].map((match) => match[1]).sort();
    assert.deepEqual(exported, ["HumanRequirement", "ManagedPolicyState", "PolicyHost", "WorkspaceTrustFacts", "approvalDecisionSource", "approvalHint", "clampApprovalSettings", "createPolicyHost", "emitPolicyNotice", "humanRequirementForEffect", "managedPolicy", "printableRefusal", "processPolicyHost", "requireManagedPolicyAtStartup", "verifyFlagRefusal"]);
    assert.doesNotMatch(sources.get("core/policy_runtime.ts")!, /^(?!const processHost = ).*\bprocessHost\s*=[^=]/m, "the process host is assigned once");
  });

  test("production code never passes its own policy to the builder, the security manager, the gate or the trust check", () => {
    const calls = (pattern: RegExp): string[] => [...sources].flatMap(([file, text]) => [...text.matchAll(pattern)].map((match) => `${file}: ${match[0]}`));
    assert.deepEqual(calls(/\bbuildConfigWithPolicy\(/g).map((call) => call.split(":")[0]), ["config.ts", "config.ts"], "its definition and buildConfig's call");
    assert.deepEqual(calls(/new SecurityManager\([^()]*,[^()]*\)/g), []);
    assert.deepEqual(calls(/new ApprovalPolicy\([^)]+\)/g), []);
    assert.deepEqual(calls(/\bisWorkspaceTrusted\((?:[^(),]|\([^()]*\))*,(?:[^(),]|\([^()]*\))*,/g).filter((call) => !call.startsWith("workspace_trust.ts: isWorkspaceTrusted(workspace: string")), []);
    assert.deepEqual(calls(/\bpolicyFor\s*:/g), []);
    // GV-5: the MCP and plugin managers take the process policy; only a test hands them another one.
    assert.deepEqual(calls(/new (?:McpClientManager|PluginManager)\([^()]*\bpolicy\b[^()]*\)/g), []);
  });
});
