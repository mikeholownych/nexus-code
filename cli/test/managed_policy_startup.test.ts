/**
 * GV-1 enforcement through the real CLI entry and the real modules, in child processes. The child's file system is
 * interposed for exactly the system policy directory and file (see helpers/policy_enforcement.ts): the machine's own
 * system policy is never read, and production has no setting that would let a test move it. Every child gets a
 * throwaway HOME. Each case costs one process start, so the cases are few and run four at a time.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SYSTEM_POLICY_PATH } from "../src/core/managed_policy_load.js";
import { policyHome, runUnderPolicy, toml } from "./helpers/policy_enforcement.js";

const dirs: string[] = [];
const keep = (dir: string): string => (dirs.push(dir), dir);
const home = (userPolicy?: string): string => keep(policyHome(userPolicy));
const workspace = (projectPolicy?: unknown): string => {
  const dir = keep(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-policy-ws-"))));
  if (projectPolicy !== undefined) fs.writeFileSync(path.join(dir, ".nexus-security.json"), JSON.stringify(projectPolicy));
  return dir;
};
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const SYSTEM_TAG = (key: string): string => `[policy: system ${SYSTEM_POLICY_PATH} ${key}]`;
const RUN = ["run", "say hello", "--endpoint", "http://127.0.0.1:9/v1", "--model", "m"];
const BROKEN = "schema_version = 1\n\n[approval]\nstrict = true\n\ndisable_yess = true\n";
const BROKEN_SYSTEM_MESSAGE =
  `nexus: managed policy error (system tier): ${SYSTEM_POLICY_PATH}: line 6: unknown key 'approval.disable_yess'.\n` +
  "Nexus will not start without this policy. Fix the file (root-owned; ask your administrator) and run `nexus doctor`. No setting or environment variable bypasses it.\n";

/** What the real modules decide in `process.cwd()`, as JSON on stdout. */
const PROBE = `
  const { SecurityManager } = await load("security");
  const { isWorkspaceTrusted } = await load("workspace_trust");
  const { buildConfig } = await load("config");
  const ws = process.cwd();
  const security = new SecurityManager(ws);
  new SecurityManager(ws);
  const refusal = (options) => { try { buildConfig({ endpoint: "http://127.0.0.1:9/v1", model: "m", ...options }); return null; } catch (error) { return error.message; } };
  process.stdout.write(JSON.stringify({
    tiers: security.getEffectivePolicy().tiers,
    verification: security.getPolicy().verificationPaths,
    makefile: security.authorizeVerificationEdit("write_file", { path: "Makefile", content: "x" }, { fullAccess: true, operator: true }),
    secrets: security.isPathProtected("secrets/key"),
    notes: security.isPathProtected("notes/a").protected,
    trusted: isWorkspaceTrusted(ws),
    yes: refusal({ yes: true }),
    auto: refusal({ mode: "auto" }),
    plain: refusal({}),
  }));
`;
const SYSTEM = toml("[approval]", "disable_auto = true", "[verification]", 'mode = "block"', "[paths]", 'protected = ["secrets"]', "[workspace]", "disable_env_trust = true");
const LOOSENING = { verificationPaths: { mode: "off", allow: ["**"] }, protectedPaths: [], approval: { disable_auto: false }, workspace: { disable_env_trust: false } };

describe("the real CLI under a managed policy", { concurrency: 4 }, () => {
  test("a valid strict system policy refuses --yes: exit 2, the source in the message, one read of the file", async () => {
    const result = await runUnderPolicy({ system: toml("[approval]", "strict = true"), home: home(), cwd: workspace(), args: [...RUN, "--yes"] });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, new RegExp(`^Configuration error: --yes is refused: managed policy disables it\\. ${SYSTEM_TAG("approval.strict").replace(/[.[\]]/g, "\\$&")}$`, "m"));
    assert.equal(result.stdout, "");
    assert.equal(result.systemPolicyOpens, 1);
  });

  test("NEXUS_APPROVAL_MODE=auto under disable_auto is refused at launch", async () => {
    const result = await runUnderPolicy({ system: toml("[approval]", "disable_auto = true"), home: home(), cwd: workspace(), args: RUN, env: { NEXUS_APPROVAL_MODE: "auto" } });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /^Configuration error: NEXUS_APPROVAL_MODE=auto is refused: managed policy disables approval mode 'auto'\. \[policy: system \S+ approval\.disable_auto\]$/m);
  });

  test("a broken system policy: exit 2 and exactly the two lines, whatever is in the environment", async () => {
    const result = await runUnderPolicy({ system: BROKEN, home: home(), cwd: workspace(), args: RUN, env: { NEXUS_TRUST_WORKSPACE: "1", NEXUS_APPROVAL_MODE: "review" } });
    assert.equal(result.status, 2);
    assert.equal(result.stderr, BROKEN_SYSTEM_MESSAGE);
    assert.equal(result.stdout, "");
    assert.equal(result.systemPolicyOpens, 1);
  });

  test("a broken system policy does not stop --version", async () => {
    const result = await runUnderPolicy({ system: BROKEN, home: home(), args: ["--version"] });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\d+\.\d+\.\d+/);
    assert.doesNotMatch(result.stderr, /managed policy error/);
  });

  test("a broken system policy does not stop --help", async () => {
    const result = await runUnderPolicy({ system: BROKEN, home: home(), args: ["--help"] });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.doesNotMatch(result.stderr, /managed policy error/);
  });

  test("a broken system policy does not stop doctor, which shows the error", async () => {
    const result = await runUnderPolicy({ system: BROKEN, home: home(), cwd: workspace(), args: ["doctor", "--json", "--timeout", "50"] });
    const report = JSON.parse(result.stdout);
    assert.ok(Array.isArray(report.findings) && report.findings.length > 3, "the doctor ran its checks");
    assert.ok(report.findings.some((finding: { id: string }) => finding.id === "runtime.node"));
    assert.match(JSON.stringify(report), /managed policy error \(system tier\)/);
    assert.notEqual(result.stderr, BROKEN_SYSTEM_MESSAGE, "the doctor was not ended by the startup check");
  });

  test("a broken user policy: exit 2 with the move-aside recovery", async () => {
    const userHome = home("schema_version = 1\n[approval]\nstrict = maybe\n");
    const file = path.join(userHome, ".config", "nexus", "policy.toml");
    const result = await runUnderPolicy({ home: userHome, cwd: workspace(), args: RUN });
    assert.equal(result.status, 2);
    assert.equal(result.stderr, `nexus: managed policy error (user tier): ${file}: line 3: unsupported value 'maybe': expected a \"string\", true, false, a whole number or an array of strings.\nNexus will not start without this policy. Fix it, or move it aside: mv ${file} ${file}.bad\n`);
    assert.equal(result.systemPolicyOpens, 0);
  });

  test("a project file that tries to loosen system values has no effect; NEXUS_TRUST_WORKSPACE=1 grants nothing under disable_env_trust", async () => {
    const ws = workspace(LOOSENING);
    fs.writeFileSync(path.join(ws, "Makefile"), "test:\n");
    const result = await runUnderPolicy({ system: SYSTEM, home: home(toml("[paths]", 'protected = ["notes"]')), cwd: ws, probe: PROBE, env: { NEXUS_TRUST_WORKSPACE: "1" } });
    assert.equal(result.status, 0, result.stderr);
    const seen = JSON.parse(result.stdout);
    assert.deepEqual(seen.tiers, ["system", "user", "project"]);
    assert.deepEqual(seen.verification, { mode: "block" }, "the system's mode, and none of the project's exemptions");
    assert.equal(seen.makefile.allowed, false);
    assert.match(seen.makefile.error, new RegExp(`${SYSTEM_TAG("verification.mode").replace(/[.[\]]/g, "\\$&")}$`));
    assert.equal(seen.secrets.protected, true);
    assert.match(seen.secrets.reason, /\[policy: system \S+ paths\.protected\]$/);
    assert.equal(seen.notes, true, "the user tier adds to the system tier");
    assert.equal(seen.trusted, false);
    assert.match(seen.yes, /^--yes is refused: it selects approval mode 'auto', which managed policy disables\. \[policy: system /);
    assert.match(seen.auto, /^--mode auto is refused/);
    assert.equal(seen.plain, null);
    assert.match(result.stderr, /nexus: NEXUS_TRUST_WORKSPACE is ignored: managed policy disables it\. \[policy: system \S+ workspace\.disable_env_trust\]/);
    assert.match(result.stderr, /asks to relax verification protection; ignored, because managed policy sets it\. \[policy: system \S+ verification\.mode\]/);
    assert.equal(result.systemPolicyOpens, 1, "two security managers, a trust check and three configurations: one read");
  });

  test("deleting the user file never goes below the system tier", async () => {
    const ws = workspace(LOOSENING);
    const result = await runUnderPolicy({ system: SYSTEM, home: home(), cwd: ws, probe: PROBE, env: { NEXUS_TRUST_WORKSPACE: "1" } });
    assert.equal(result.status, 0, result.stderr);
    const seen = JSON.parse(result.stdout);
    assert.deepEqual(seen.tiers, ["system", "project"]);
    assert.deepEqual(seen.verification, { mode: "block" });
    assert.equal(seen.secrets.protected, true);
    assert.equal(seen.notes, false, "only what the user tier added is gone");
    assert.equal(seen.trusted, false);
    assert.match(seen.auto, /^--mode auto is refused/);
  });

  test("with no policy files nothing is refused and nothing is said", async () => {
    const ws = workspace();
    const result = await runUnderPolicy({ home: home(), cwd: ws, probe: PROBE, env: { NEXUS_TRUST_WORKSPACE: "1" } });
    assert.equal(result.status, 0, result.stderr);
    const seen = JSON.parse(result.stdout);
    assert.deepEqual(seen.tiers, []);
    assert.deepEqual(seen.verification, { mode: "approve" });
    assert.equal(seen.secrets.protected, false);
    assert.equal(seen.trusted, true);
    assert.deepEqual([seen.yes, seen.auto, seen.plain], [null, null, null]);
    assert.equal(result.stderr, "");
    assert.equal(result.systemPolicyOpens, 0);
  });
});
