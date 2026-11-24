/**
 * GV-1 visibility: `nexus policy show|check` and the policy findings of `nexus doctor`. In process the policy is
 * injected (an in-memory host); the real CLI runs in a child whose file system is interposed for exactly the system
 * policy path (helpers/policy_enforcement.ts), under a throwaway HOME. The machine's own policy is never read.
 */
import "./helpers/leak_guard.js";
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { POLICY_KEYS } from "../src/core/managed_policy.js";
import { SYSTEM_POLICY_PATH } from "../src/core/managed_policy_load.js";
import { proposedRepairs, type DoctorReport } from "../src/doctor.js";
import { checkPolicyFile, effectivePolicyRows, policyFindings, policyReport, renderPolicyFileCheck, renderPolicyReport } from "../src/policy_cli.js";
import { FAKE_SYSTEM, FAKE_USER, policyHome, policyWorld, runUnderPolicy, toml } from "./helpers/policy_enforcement.js";

const dirs: string[] = [];
const temp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const WS = "/fake/work/app";
const UNTRUSTED = { workspaceTrusted: false, envTrustRequested: false };
const BROKEN = "schema_version = 1\n\n[approval]\nstrict = true\n\ndisable_yess = true\n";

describe("the policy report", () => {
  test("names each tier's state and, for every key of the schema, the value and the tier that decides it", () => {
    const world = policyWorld({
      system: toml("[approval]", "strict = true", "[commands]", 'forbid = ["git push"]', "[mcp]", 'allow = ["files", "wiki"]'),
      user: toml("[commands]", 'forbid = ["npm publish"]', "[mcp]", 'allow = ["files"]', "[sandbox]", "required = true"),
    });
    world.project(WS, { protectedPaths: ["secrets"] });
    const report = policyReport(world.host, WS, UNTRUSTED);
    assert.equal(report.valid, true);
    assert.deepEqual(report.tiers, [
      { tier: "system", file: FAKE_SYSTEM, state: "valid", schemaVersion: 1 },
      { tier: "user", file: FAKE_USER, state: "valid", schemaVersion: 1 },
      { tier: "project", file: `${WS}/.nexus-security.json`, status: "NEW", state: "valid" },
    ]);
    const rows = new Map(report.effective!.map((row) => [row.key, row]));
    for (const [table, keys] of Object.entries(POLICY_KEYS)) for (const key of Object.keys(keys)) assert.ok(rows.has(`${table}.${key}`), `${table}.${key} is reported`);
    assert.deepEqual(rows.get("approval.strict"), { key: "approval.strict", value: "true", source: `[policy: system ${FAKE_SYSTEM} approval.strict]` });
    assert.deepEqual(rows.get("approval.disable_yes"), { key: "approval.disable_yes", value: "true", source: `[policy: system ${FAKE_SYSTEM} approval.strict]` });
    assert.deepEqual(rows.get("sandbox.required"), { key: "sandbox.required", value: "true", source: `[policy: user ${FAKE_USER} sandbox.required]` });
    assert.deepEqual(rows.get("mcp.allow")!.value, '["files"]', "the intersection, not either list");
    assert.equal(rows.get("plugins.allow")!.value, "unrestricted");
    assert.equal(rows.get("plugins.allow")!.source, "[policy: default]");
    assert.deepEqual(rows.get("commands.forbid"), {
      key: "commands.forbid",
      value: '["git push","npm publish"]',
      source: "(per item)",
      items: [
        { value: "git push", source: `[policy: system ${FAKE_SYSTEM} commands.forbid]` },
        { value: "npm publish", source: `[policy: user ${FAKE_USER} commands.forbid]` },
      ],
    });
    assert.equal(rows.get("paths.protected")!.source, `[policy: project ${WS}/.nexus-security.json paths.protected]`);
    assert.equal(rows.get("verification.mode")!.value, "not set");

    const text = renderPolicyReport(report);
    assert.match(text, new RegExp(`^system  ${FAKE_SYSTEM}: valid \\(schema_version 1\\)$`, "m"));
    assert.match(text, /^ {2}approval\.strict +true {2}\[policy: system \/fake\/etc\/nexus\/policy\.toml approval\.strict\]$/m);
    assert.match(text, /^ +"npm publish" {2}\[policy: user /m);
    assert.match(text, /^VALID: this policy can be used\.$/m);
  });

  test("no policy at all is valid, and every value is the default", () => {
    const report = policyReport(policyWorld().host, WS, UNTRUSTED);
    assert.equal(report.valid, true);
    assert.deepEqual(report.tiers.map((tier) => tier.state), ["absent", "absent", "absent"]);
    assert.ok(report.effective!.every((row) => row.source === "[policy: default]"));
    assert.deepEqual(policyFindings(report).map((finding) => [finding.id, finding.status]), [["policy.system", "skip"], ["policy.user", "skip"], ["policy.project", "skip"], ["policy.effective", "skip"]]);
  });

  test("both managed files are reported when both are broken, and there is no effective policy", () => {
    const world = policyWorld({ system: BROKEN, user: "schema_version = 1\n[sandbox]\nrequired = yes\n" });
    const report = policyReport(world.host, WS, UNTRUSTED);
    assert.equal(report.valid, false);
    assert.equal(report.effective, undefined);
    assert.deepEqual(report.tiers.map((tier) => [tier.tier, tier.state]), [["system", "invalid"], ["user", "invalid"]]);
    assert.match(report.tiers[0].error!, /^nexus: managed policy error \(system tier\): \/fake\/etc\/nexus\/policy\.toml: line 6: unknown key 'approval\.disable_yess'\.\n/);
    assert.match(report.tiers[1].error!, /\(user tier\).*line 3: unsupported value 'yes'/);
    const text = renderPolicyReport(report);
    assert.match(text, /^system  \/fake\/etc\/nexus\/policy\.toml: INVALID$/m);
    assert.match(text, /^INVALID: Nexus does not start with this policy \(exit code 2\)\./m);
    assert.doesNotMatch(text, /^VALID/m);

    const findings = policyFindings(report);
    assert.deepEqual(findings.map((finding) => [finding.id, finding.status]), [["policy.system", "fail"], ["policy.user", "fail"], ["policy.effective", "skip"]]);
    assert.match(findings[0].action!, /as root/);
    assert.ok(findings[0].evidence.some((line) => line.includes("line 6: unknown key")));
  });

  test("a broken user file alone is invalid; a valid system file beside it is still shown as valid", () => {
    const report = policyReport(policyWorld({ system: toml("[approval]", "strict = true"), user: BROKEN }).host, WS, UNTRUSTED);
    assert.equal(report.valid, false);
    assert.deepEqual(report.tiers.map((tier) => tier.state), ["valid", "invalid"]);
  });

  test("doctor findings: a valid tier passes, the settings in force are listed with their sources, a project file that is not fully applied warns", () => {
    const world = policyWorld({ system: toml("[approval]", "strict = true", "[mcp]", "allow = []") });
    world.project(WS, { verificationPaths: { mode: "off" } });
    const findings = policyFindings(policyReport(world.host, WS, { workspaceTrusted: true, envTrustRequested: false }));
    const byId = new Map(findings.map((finding) => [finding.id, finding]));
    assert.equal(byId.get("policy.system")!.status, "pass");
    assert.equal(byId.get("policy.user")!.status, "skip");
    assert.equal(byId.get("policy.project")!.status, "warn", "its relaxation is not approved");
    assert.equal(byId.get("policy.effective")!.status, "pass");
    assert.ok(byId.get("policy.effective")!.evidence.includes(`approval.strict = true [policy: system ${FAKE_SYSTEM} approval.strict]`));
    assert.ok(byId.get("policy.effective")!.evidence.includes(`mcp.allow = [] [policy: system ${FAKE_SYSTEM} mcp.allow]`), "an empty allowlist is a restriction");

    world.project(WS, "{ not json");
    const broken = policyFindings(policyReport(world.host, WS, UNTRUSTED)).find((finding) => finding.id === "policy.project")!;
    assert.equal(broken.status, "warn");
    assert.match(broken.explanation, /cannot be used; none of it is applied/);
  });

  test("nothing a file or a path says reaches the terminal as a control character", () => {
    const world = policyWorld();
    const hostile = "/fake/work/\u001b[2Jevil\u0007";
    world.project(hostile, "{ \u001b]0;title\u0007");
    assert.doesNotMatch(renderPolicyReport(policyReport(world.host, hostile, UNTRUSTED)).replace(/\n/g, ""), /[\u0000-\u001f\u007f-\u009f]/);
  });

  test("every row covers a key the effective policy has (a new key cannot go unreported)", () => {
    const effective = policyWorld().host.managed().effective;
    const reported = new Set(effectivePolicyRows(effective).map((row) => row.key));
    for (const [table, members] of Object.entries(effective)) {
      if (table === "tiers") continue;
      for (const [name, member] of Object.entries(members as Record<string, unknown>)) {
        if (member && typeof member === "object" && ("value" in member || "values" in member)) assert.ok(reported.has(`${table}.${name}`), `${table}.${name}`);
      }
    }
  });
});

describe("checking a policy file before it is rolled out", () => {
  const candidate = (content: string | Buffer, mode = 0o644): string => {
    const file = path.join(temp("nexus-policy-candidate-"), "policy.toml");
    fs.writeFileSync(file, content, { mode });
    return file;
  };

  test("a valid file is valid whatever its owner and mode: those are checked where it is installed", () => {
    const file = candidate(toml("[approval]", "strict = true"), 0o666);
    fs.chmodSync(file, 0o666);
    assert.deepEqual(checkPolicyFile(file), { schemaVersion: 1, file, valid: true });
    assert.match(renderPolicyFileCheck(checkPolicyFile(file)), /^VALID: /);
  });

  const rejected: [string, string | Buffer, string, RegExp, number | undefined][] = [
    ["an unknown key", BROKEN, "unknown_key", /^line 6: unknown key 'approval\.disable_yess'$/, 6],
    ["a grant-shaped key", toml("[commands]", 'allow = ["rm"]'), "unknown_key", /^line 3: unknown key 'commands\.allow'$/, 3],
    ["a lowered floor", toml("[verification]", 'mode = "off"'), "bad_value", /a policy can only raise this, never lower it$/, 3],
    ["a duplicate key", toml("[approval]", "strict = true", "strict = false"), "duplicate_key", /^line 4: duplicate key/, 4],
    ["no schema_version", "[approval]\nstrict = true\n", "schema_version_missing", /schema_version is missing/, undefined],
    ["a newer schema_version", "schema_version = 2\n", "schema_version_unsupported", /schema_version 2 is not supported/, 1],
    ["an empty file", "", "empty", /the file is empty/, undefined],
    ["a byte-order mark", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(toml())]), "bom", /byte-order mark/, undefined],
    ["a file over 64 KiB", `${toml()}${"# padding\n".repeat(7000)}`, "too_large", /larger than 64 KiB/, undefined],
  ];
  for (const [name, content, code, error, line] of rejected) {
    test(`${name} is invalid, with the line`, () => {
      const result = checkPolicyFile(candidate(content));
      assert.equal(result.valid, false);
      assert.equal(result.code, code);
      assert.match(result.error!, error);
      assert.equal(result.line, line);
      assert.match(renderPolicyFileCheck(result), /^INVALID: .*\nNexus would refuse to start with this file installed as a managed policy\.\n$/);
    });
  }

  test("a missing file, a directory and a symbolic link are invalid, never 'no policy'", () => {
    const dir = temp("nexus-policy-candidate-");
    assert.deepEqual([checkPolicyFile(path.join(dir, "none.toml")).valid, checkPolicyFile(path.join(dir, "none.toml")).code], [false, "absent"]);
    assert.equal(checkPolicyFile(dir).code, "not_regular");
    fs.symlinkSync(candidate(toml()), path.join(dir, "link.toml"));
    assert.equal(checkPolicyFile(path.join(dir, "link.toml")).code, "symlink");
  });
});

describe("doctor --fix and policy files", () => {
  test("no repair is planned for a policy file, whatever finding names it", () => {
    const finding = (target: string) => ({ id: "config.env", category: "config", status: "warn", explanation: "", evidence: [target], repairAvailable: true, repair: { id: "config.permissions", description: `chmod ${target}` }, durationMs: 0 });
    const report = { findings: [finding("/home/op/.config/nexus/policy.toml"), finding(SYSTEM_POLICY_PATH), finding("/home/op/.config/nexus/config.env")] } as unknown as DoctorReport;
    assert.deepEqual(proposedRepairs(report).map((repair) => repair.description), ["chmod /home/op/.config/nexus/config.env"]);
  });
});

describe("the real CLI", { concurrency: 4 }, () => {
  const home = (userPolicy?: string): string => {
    const dir = policyHome(userPolicy);
    dirs.push(dir);
    return dir;
  };

  test("policy check with a broken system file: exit 2, both tiers shown, and the file is diagnosed rather than fatal", async () => {
    const result = await runUnderPolicy({ system: BROKEN, home: home(toml("[sandbox]", "required = true")), cwd: temp("nexus-policy-ws-"), args: ["policy", "check"] });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, new RegExp(`^system  ${SYSTEM_POLICY_PATH}: INVALID$`, "m"));
    assert.match(result.stdout, /line 6: unknown key 'approval\.disable_yess'/);
    assert.match(result.stdout, /^user .*policy\.toml: valid \(schema_version 1\)$/m);
    assert.match(result.stdout, /^INVALID: Nexus does not start with this policy/m);
  });

  test("policy show --json with a valid policy: exit 0, the sources in the document; a workspace file cannot change a managed value", async () => {
    const ws = temp("nexus-policy-ws-");
    fs.writeFileSync(path.join(ws, ".nexus-security.json"), JSON.stringify({ approval: { strict: false }, mcp: { allow: ["shell"] }, protectedPaths: ["secrets"] }));
    const result = await runUnderPolicy({ system: toml("[approval]", "strict = true", "[mcp]", "allow = []"), home: home(), cwd: ws, args: ["policy", "show", "--json"] });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.valid, true);
    const row = (key: string) => report.effective.find((r: { key: string }) => r.key === key);
    assert.deepEqual(row("approval.strict"), { key: "approval.strict", value: "true", source: `[policy: system ${SYSTEM_POLICY_PATH} approval.strict]` });
    assert.equal(row("mcp.allow").value, "[]");
    assert.equal(row("paths.protected").value, '["secrets"]');
  });

  test("policy check <file> validates a candidate while the installed policy is broken", async () => {
    const dir = temp("nexus-policy-candidate-");
    fs.writeFileSync(path.join(dir, "good.toml"), toml("[approval]", "strict = true"));
    fs.writeFileSync(path.join(dir, "bad.toml"), BROKEN);
    const good = await runUnderPolicy({ system: BROKEN, home: home(), cwd: dir, args: ["policy", "check", "good.toml"] });
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /^VALID: .*good\.toml$/m);
    const bad = await runUnderPolicy({ home: home(), cwd: dir, args: ["policy", "check", "bad.toml", "--json"] });
    assert.equal(bad.status, 2);
    assert.deepEqual({ ...JSON.parse(bad.stdout), file: "" }, { schemaVersion: 1, file: "", valid: false, code: "unknown_key", error: "line 6: unknown key 'approval.disable_yess'", line: 6 });
  });

  test("doctor reports a broken user policy as a failed policy finding, and --fix --yes leaves the file as it was", async () => {
    const userHome = home(BROKEN);
    const file = path.join(userHome, ".config", "nexus", "policy.toml");
    fs.chmodSync(file, 0o644);
    const before = { bytes: fs.readFileSync(file, "utf8"), mode: fs.statSync(file).mode, mtimeMs: fs.statSync(file).mtimeMs };
    const result = await runUnderPolicy({ home: userHome, cwd: temp("nexus-policy-ws-"), args: ["doctor", "--json", "--fix", "--yes", "--timeout", "50"] });
    const report = JSON.parse(result.stdout);
    const finding = report.findings.find((f: { id: string }) => f.id === "policy.user");
    assert.equal(finding.status, "fail");
    assert.equal(finding.repairAvailable, false);
    assert.ok(finding.evidence.some((line: string) => line.includes("line 6: unknown key 'approval.disable_yess'")));
    assert.equal(report.findings.find((f: { id: string }) => f.id === "policy.system").status, "skip");
    assert.equal(result.status, 2, "a failure finding");
    assert.deepEqual({ bytes: fs.readFileSync(file, "utf8"), mode: fs.statSync(file).mode, mtimeMs: fs.statSync(file).mtimeMs }, before);
  });
});
