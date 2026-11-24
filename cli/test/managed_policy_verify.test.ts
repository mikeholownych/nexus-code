/**
 * GV-1 slice 3: managed policy reaches `nexus verify`, which builds no session configuration: `--yes` under
 * `approval.disable_yes`, `--sandbox none` under `sandbox.required`, `--sandbox-network` under `sandbox.forbid_network`.
 * The decision is tested in process over injected policies; the real command runs in a child whose file system is
 * interposed for exactly the system policy path, under a throwaway HOME, in a directory that is not a Git tree (so a
 * request the policy lets through ends at the next check, before anything is verified).
 */
import "./helpers/leak_guard.js";
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SYSTEM_POLICY_PATH } from "../src/core/managed_policy_load.js";
import { verifyFlagRefusal } from "../src/core/policy_runtime.js";
import { FAKE_SYSTEM, FAKE_USER, policyHome, policyWorld, runUnderPolicy, toml } from "./helpers/policy_enforcement.js";

const dirs: string[] = [];
const keep = (dir: string): string => (dirs.push(dir), dir);
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const NONE = { yes: false, sandboxNone: false, sandboxNetwork: false };
const policy = (tiers: { system?: string; user?: string }) => policyWorld(tiers).host.managed().effective;

describe("verify flags against the policy", () => {
  const rows: [string, string, Partial<typeof NONE>, string][] = [
    ["--yes under approval.disable_yes", toml("[approval]", "disable_yes = true"), { yes: true }, `--yes is refused: managed policy disables it. [policy: system ${FAKE_SYSTEM} approval.disable_yes]`],
    ["--yes under approval.strict", toml("[approval]", "strict = true"), { yes: true }, `--yes is refused: managed policy disables it. [policy: system ${FAKE_SYSTEM} approval.strict]`],
    ["--sandbox none under sandbox.required", toml("[sandbox]", "required = true"), { sandboxNone: true }, `--sandbox none is refused: managed policy requires the sandbox. [policy: system ${FAKE_SYSTEM} sandbox.required]`],
    ["--sandbox-network under sandbox.forbid_network", toml("[sandbox]", "forbid_network = true"), { sandboxNetwork: true }, `--sandbox-network is refused: managed policy forbids network access in the sandbox. [policy: system ${FAKE_SYSTEM} sandbox.forbid_network]`],
  ];
  for (const [name, system, flags, message] of rows) {
    test(name, () => {
      assert.equal(verifyFlagRefusal(policy({ system }), { ...NONE, ...flags }), message);
      assert.equal(verifyFlagRefusal(policy({ system }), NONE), undefined, "the default request is not refused");
      assert.equal(verifyFlagRefusal(policy({}), { ...NONE, ...flags }), undefined, "with no policy nothing is refused");
    });
  }

  test("a user file cannot switch a system restriction off, and adds its own", () => {
    const effective = policy({ system: toml("[sandbox]", "required = true"), user: toml("[sandbox]", "required = false", "forbid_network = true", "[approval]", "disable_yes = false") });
    assert.match(verifyFlagRefusal(effective, { ...NONE, sandboxNone: true })!, /sandbox\.required\]$/);
    assert.equal(verifyFlagRefusal(effective, { ...NONE, sandboxNetwork: true }), `--sandbox-network is refused: managed policy forbids network access in the sandbox. [policy: user ${FAKE_USER} sandbox.forbid_network]`);
    assert.equal(verifyFlagRefusal(effective, { ...NONE, yes: true }), undefined);
  });

  test("approval.disable_auto alone does not refuse verify --yes: it approves a verifier, it selects no mode", () => {
    assert.equal(verifyFlagRefusal(policy({ system: toml("[approval]", "disable_auto = true", "disable_full_access = true") }), { ...NONE, yes: true }), undefined);
  });
});

describe("the real nexus verify under a managed policy", { concurrency: 4 }, () => {
  const SYSTEM = toml("[approval]", "strict = true", "[sandbox]", "required = true", "forbid_network = true");
  const notGit = (): string => keep(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-policy-verify-"))));
  const run = (system: string | undefined, args: string[]) => runUnderPolicy({ system, home: keep(policyHome()), cwd: notGit(), args: ["verify", ...args] });
  const TAG = (key: string): string => `[policy: system ${SYSTEM_POLICY_PATH} ${key}]`;

  const refused: [string[], string][] = [
    [["--yes"], `error: --yes is refused: managed policy disables it. ${TAG("approval.strict")}`],
    [["--sandbox", "none"], `error: --sandbox none is refused: managed policy requires the sandbox. ${TAG("sandbox.required")}`],
    [["--sandbox-network"], `error: --sandbox-network is refused: managed policy forbids network access in the sandbox. ${TAG("sandbox.forbid_network")}`],
    [["--sandbox", "bwrap", "--sandbox-network"], `error: --sandbox-network is refused: managed policy forbids network access in the sandbox. ${TAG("sandbox.forbid_network")}`],
  ];
  for (const [args, message] of refused) {
    test(`verify ${args.join(" ")} is refused: exit 2, the source named, nothing verified`, async () => {
      const result = await run(SYSTEM, args);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stderr.trim(), message);
      assert.equal(result.stdout, "");
    });
  }

  test("--json carries the refusal as the error document", async () => {
    const result = await run(SYSTEM, ["--sandbox", "none", "--json"]);
    assert.equal(result.status, 2);
    const document = JSON.parse(result.stdout);
    assert.equal(document.exitCode, 2);
    assert.match(document.error, /^--sandbox none is refused: managed policy requires the sandbox\. \[policy: system /);
  });

  test("with no policy the same flags are not refused by policy (the run ends at the next check: not a Git tree)", async () => {
    const result = await run(undefined, ["--sandbox", "none", "--yes"]);
    assert.doesNotMatch(result.stderr, /managed policy/);
    assert.equal(result.status, 2, "a usage error of verify's own");
  });
});
