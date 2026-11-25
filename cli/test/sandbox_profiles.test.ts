/**
 * SB-1: named permission profiles. The grammar of `--sandbox [engine]:profile`, what each profile expands to, how the
 * expansion composes with the managed-policy clamps, and the posture describer. Policies live in memory
 * (helpers/policy_enforcement.ts); the machine's own policy files are never read.
 */
import "./helpers/leak_guard.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildConfigWithPolicy, isProjectEnvKey } from "../src/config.js";
import { ApplicationCore } from "../src/core/app.js";
import { InteractiveRepl } from "../src/repl.js";
import { SidecarServer } from "../src/sidecar.js";
import { runDoctor } from "../src/doctor.js";
import { DEFAULT_CONTINUATION, type HarnessConfig } from "../src/types.js";
import { makeHome, makeRepo } from "./helpers/fixtures.js";
import { sandboxNetworkEnabled, setSandboxNetworkFlag } from "../src/sandbox.js";
import { setSandboxNetworkProfile } from "../src/sandbox_network.js";
import { clampSandbox, clampSandboxNetwork, mergePolicies, type EffectivePolicy } from "../src/core/managed_policy.js";
import {
  PROFILE_SPECS,
  SANDBOX_PROFILE_NAMES,
  SandboxProfileError,
  describeSandboxPosture,
  expandSandboxProfile,
  parseSandboxValue,
  profileRank,
  sandboxPostureText,
  type ProfileLabel,
  type SandboxProfileName,
} from "../src/sandbox_profile.js";
import { FAKE_SYSTEM, policyWorld, toml } from "./helpers/policy_enforcement.js";

const ENGINES = [undefined, "auto", "bwrap", "docker"] as const;
const TAG = (key: string): string => `[policy: system ${FAKE_SYSTEM} ${key}]`;
const systemPolicy = (...lines: string[]): EffectivePolicy => policyWorld({ system: toml("[sandbox]", ...lines) }).host.managed().effective;
const POLICIES: Array<{ name: string; policy: EffectivePolicy; required: boolean; forbidNetwork: boolean }> = [
  { name: "no policy", policy: mergePolicies(), required: false, forbidNetwork: false },
  { name: "sandbox.required", policy: systemPolicy("required = true"), required: true, forbidNetwork: false },
  { name: "sandbox.forbid_network", policy: systemPolicy("forbid_network = true"), required: false, forbidNetwork: true },
  { name: "required + forbid_network", policy: systemPolicy("required = true", "forbid_network = true"), required: true, forbidNetwork: true },
];

describe("grammar of --sandbox [engine]:profile", () => {
  test("every valid form parses to its engine and profile; legacy values set no profile", () => {
    assert.deepEqual(parseSandboxValue(undefined), {});
    assert.deepEqual(parseSandboxValue(true), { engine: "auto" });
    assert.deepEqual(parseSandboxValue("none"), { engine: "none" });
    for (const engine of ["auto", "bwrap", "docker"] as const) assert.deepEqual(parseSandboxValue(engine), { engine });
    for (const profile of SANDBOX_PROFILE_NAMES) {
      assert.deepEqual(parseSandboxValue(profile), { profile });
      for (const engine of ["auto", "bwrap", "docker"] as const) {
        if (engine === "docker" && profile === ":read-only") continue;
        assert.deepEqual(parseSandboxValue(`${engine}${profile}`), { engine, profile });
      }
    }
  });

  test("hostile and malformed values are refused, never read as an engine or as unconfined", () => {
    const hostile = [
      "", " ", ":", ":full-access", ":danger-full-access", ":none", "none:workspace", ":unconfined", ":WORKSPACE", ":Workspace", "BWRAP:workspace",
      " :workspace", ":workspace ", ":workspace\n", "\t:network", ":workspace,auto", ":workspace:network", ":network:workspace", "workspace", "read-only", "network",
      "：workspace", "꞉network", ":work​space", "../x", ":../x", ":workspace/../network", ":network;rm -rf /", ":network --yes", `:${"a".repeat(4096)}`,
      `${":workspace".padEnd(33, " ")}`, "bwrap:", "auto:", "docker:read-only", "podman:workspace", ":read_only", ":readonly", ":net", "NONE", " none ", "on", "off", "true", "1",
    ];
    for (const value of hostile) {
      assert.throws(() => parseSandboxValue(value), SandboxProfileError, `accepted ${JSON.stringify(value.slice(0, 40))}`);
    }
    for (const value of [1, {}, [":network"], null, false] as unknown[]) {
      assert.throws(() => parseSandboxValue(value as any), SandboxProfileError, `accepted ${JSON.stringify(value)}`);
    }
    // The refusal lists what is valid and never echoes an oversized value in full.
    const message = (() => { try { parseSandboxValue(`:${"a".repeat(4096)}`); return ""; } catch (error) { return (error as Error).message; } })();
    assert.match(message, /Valid values: auto, bwrap, docker, none, or /);
    assert.ok(message.length < 400, `message is ${message.length} chars`);
    assert.match((() => { try { parseSandboxValue("docker:read-only"); return ""; } catch (error) { return (error as Error).message; } })(), /read-only confinement needs Bubblewrap/);
  });
});

describe("named profile network enforcement", () => {
  test("buildConfig applies profiles to runtime network access and managed policy", () => {
    const previous = process.env.NEXUS_SANDBOX_NETWORK;
    process.env.NEXUS_SANDBOX_NETWORK = "1";
    try {
      buildConfigWithPolicy({ endpoint: "http://127.0.0.1:1/v1", model: "fixture", sandbox: ":workspace" }, mergePolicies());
      assert.equal(sandboxNetworkEnabled(), false, ":workspace must override NEXUS_SANDBOX_NETWORK=1");

      buildConfigWithPolicy({ endpoint: "http://127.0.0.1:1/v1", model: "fixture", sandbox: ":network" }, mergePolicies());
      assert.equal(sandboxNetworkEnabled(), true, ":network must set the runtime network permission");

      assert.throws(
        () => buildConfigWithPolicy({ endpoint: "http://127.0.0.1:1/v1", model: "fixture", sandbox: ":network" }, systemPolicy("forbid_network = true")),
        /--sandbox :network is refused: managed policy forbids network access in the sandbox/,
      );
    } finally {
      if (previous === undefined) delete process.env.NEXUS_SANDBOX_NETWORK;
      else process.env.NEXUS_SANDBOX_NETWORK = previous;
      setSandboxNetworkProfile(undefined);
      setSandboxNetworkFlag(false);
    }
  });

  test("a build refused by managed policy leaves no network permission from the build before it (#795)", () => {
    try {
      buildConfigWithPolicy({ endpoint: "http://127.0.0.1:1/v1", model: "fixture", sandbox: ":network" }, mergePolicies());
      assert.equal(sandboxNetworkEnabled(), true);
      assert.throws(
        () => buildConfigWithPolicy({ endpoint: "http://127.0.0.1:1/v1", model: "fixture", sandbox: ":network" }, systemPolicy("forbid_network = true")),
        /is refused/,
      );
      assert.equal(sandboxNetworkEnabled(), false, "the earlier :network must not outlive the refused build");
      buildConfigWithPolicy({ endpoint: "http://127.0.0.1:1/v1", model: "fixture", sandbox: ":network", sandboxNetwork: true }, mergePolicies());
      assert.throws(() => buildConfigWithPolicy({ endpoint: "http://127.0.0.1:1/v1", model: "fixture", sandbox: "nonsense:profile" }, mergePolicies()));
      assert.equal(sandboxNetworkEnabled(), false, "a refused profile expansion resets the state too");
    } finally {
      setSandboxNetworkProfile(undefined);
      setSandboxNetworkFlag(false);
    }
  });

  test("a profile overrides CLI and environment opt-ins, then legacy behavior returns without a profile", () => {
    try {
      setSandboxNetworkFlag(true);
      setSandboxNetworkProfile(false);
      assert.equal(sandboxNetworkEnabled(), false, ":workspace must stay offline despite --sandbox-network");
      setSandboxNetworkProfile(true);
      assert.equal(sandboxNetworkEnabled(), true, ":network must enable network access");
      setSandboxNetworkProfile(undefined);
      assert.equal(sandboxNetworkEnabled(), true, "legacy CLI opt-in remains effective without a profile");
    } finally {
      setSandboxNetworkProfile(undefined);
      setSandboxNetworkFlag(false);
    }
  });
});

describe("a profile expands to flags that already exist", () => {
  test("no profile: the options object is returned untouched, for every legacy value", () => {
    for (const sandbox of [undefined, false, true, null, "auto", "bwrap", "docker", "none", " NONE ", "Auto"]) {
      for (const extra of [{}, { readOnly: true }, { sandboxNetwork: true }, { yes: true, mode: "auto" }]) {
        const options = { sandbox, ...extra };
        const result = expandSandboxProfile(options, true);
        assert.equal(result.options, options, `options were rewritten for ${JSON.stringify(sandbox)}`);
        assert.equal(result.profile, undefined);
        assert.deepEqual(result.notices, []);
      }
    }
  });

  test("every profile × engine expands to exactly the legacy flag bundle and touches nothing else", () => {
    for (const profile of SANDBOX_PROFILE_NAMES) {
      for (const engine of ENGINES) {
        const value = `${engine ?? ""}${profile}`;
        const options = { sandbox: value, yes: true, approve: true, mode: "auto", fullAccess: true, workspace: "/w" };
        if (engine === "docker" && profile === ":read-only") {
          assert.throws(() => expandSandboxProfile(options, false), /docker:read-only is refused/);
          continue;
        }
        const result = expandSandboxProfile(options, false);
        assert.equal(result.profile, profile);
        assert.deepEqual(result.notices, []);
        const expected = profile === ":read-only"
          ? { ...options, sandbox: engine, readOnly: true }
          : { ...options, sandbox: engine ?? true };
        assert.deepEqual(result.options, expected, value);
        // The source options are not mutated, and no approval setting is added, removed or changed.
        assert.equal(options.sandbox, value);
        for (const key of ["yes", "approve", "mode", "fullAccess", "workspace"] as const) assert.equal((result.options as any)[key], options[key]);
        assert.equal("sandboxNetwork" in result.options, false, "a profile never sets --sandbox-network");
      }
    }
  });

  test("only :network has network; --sandbox-network with another profile is a conflict; the env opt-in is ignored with a notice", () => {
    assert.deepEqual(SANDBOX_PROFILE_NAMES.filter((name) => PROFILE_SPECS[name].network), [":network"]);
    assert.deepEqual(SANDBOX_PROFILE_NAMES.filter((name) => PROFILE_SPECS[name].readOnly), [":read-only"]);
    for (const profile of [":workspace", ":read-only"] as const) {
      assert.throws(() => expandSandboxProfile({ sandbox: profile, sandboxNetwork: true }, false), /--sandbox-network conflicts with --sandbox/);
      const result = expandSandboxProfile({ sandbox: profile }, true);
      assert.equal(result.notices.length, 1);
      assert.match(result.notices[0], new RegExp(`NEXUS_SANDBOX_NETWORK is ignored under --sandbox ${profile}`));
    }
    assert.deepEqual(expandSandboxProfile({ sandbox: ":network", sandboxNetwork: true }, true).notices, []);
    assert.equal(expandSandboxProfile({ sandbox: ":network", sandboxNetwork: true }, false).profile, ":network");
  });

  test("invalid values are refused at expansion: nothing falls through to a run without a sandbox", () => {
    for (const value of ["", ":full-access", ":none", "none:workspace", ":WORKSPACE", "workspace", "：workspace", ":workspace\n", "foo", 7, {}, [":network"]]) {
      assert.throws(() => expandSandboxProfile({ sandbox: value }, false), SandboxProfileError, `accepted ${JSON.stringify(value)}`);
    }
  });

  test("only the operator's --sandbox value selects a profile: other option keys and project settings do not", () => {
    // Keys a project file or a tool argument might carry are not read.
    const result = expandSandboxProfile({ sandbox: ":read-only", profile: ":network", sandboxProfile: ":network", sandbox_profile: ":network" } as any, false);
    assert.equal(result.profile, ":read-only");
    assert.equal((result.options as any).readOnly, true);
    assert.equal(expandSandboxProfile({ profile: ":network", sandboxProfile: ":network" } as any, false).profile, undefined);
    // No sandbox setting is a per-project setting: a workspace .env cannot name a profile or switch network on.
    for (const key of ["NEXUS_SANDBOX", "NEXUS_SANDBOX_PROFILE", "NEXUS_SANDBOX_NETWORK", "NEXUS_SANDBOX_HOME_READONLY", "NEXUS_APPROVAL_MODE"]) {
      assert.equal(isProjectEnvKey(key), false, key);
    }
  });
});

/** The expansion followed by the two managed clamps, as buildConfig applies them. */
function compose(value: string | true | undefined, policy: EffectivePolicy, flags: { sandboxNetwork?: boolean; readOnly?: boolean } = {}):
  { refused: string } | { sandbox: unknown; readOnly: boolean; network: boolean; label: ProfileLabel; profile?: SandboxProfileName } {
  let expanded;
  try {
    expanded = expandSandboxProfile({ sandbox: value, ...flags }, false);
  } catch (error) {
    return { refused: (error as Error).message };
  }
  const options = expanded.options as { sandbox?: string | true; readOnly?: boolean; sandboxNetwork?: boolean };
  const asked = typeof options.sandbox === "string" ? options.sandbox : options.sandbox ? "auto" : undefined;
  const sandbox = clampSandbox(policy, { mode: asked, origin: `--sandbox ${String(value)}` });
  if (!sandbox.allowed) return { refused: sandbox.message };
  const wantsNetwork = expanded.profile ? PROFILE_SPECS[expanded.profile].network : Boolean(options.sandboxNetwork);
  const network = clampSandboxNetwork(policy, wantsNetwork, expanded.profile ? `--sandbox ${expanded.profile}` : "--sandbox-network");
  if (!network.allowed) return { refused: network.message };
  const effective = options.sandbox ?? sandbox.value.mode;
  const posture = describeSandboxPosture({ sandbox: effective, readOnly: Boolean(options.readOnly), network: network.value && Boolean(effective), profile: expanded.profile });
  return { sandbox: effective, readOnly: posture.readOnly, network: posture.network, label: posture.profile, profile: expanded.profile };
}

describe("profile × engine × managed policy: the stricter of the two applies", () => {
  test("a profile is never looser than itself or than the policy, and a refusal names the policy source", () => {
    let cases = 0;
    for (const { name, policy, required, forbidNetwork } of POLICIES) {
      for (const profile of SANDBOX_PROFILE_NAMES) {
        for (const engine of ENGINES) {
          if (engine === "docker" && profile === ":read-only") continue;
          cases++;
          const where = `${engine ?? ""}${profile} under ${name}`;
          const result = compose(`${engine ?? ""}${profile}`, policy);
          if (profile === ":network" && forbidNetwork) {
            assert.ok("refused" in result, where);
            assert.equal(result.refused, `--sandbox :network is refused: managed policy forbids network access in the sandbox. ${TAG("sandbox.forbid_network")}`);
            continue;
          }
          assert.ok(!("refused" in result), `${where}: ${"refused" in result ? result.refused : ""}`);
          // Exactly the profile that was named: the policy had nothing stricter to add.
          assert.equal(result.label, profile, where);
          assert.equal(result.network, PROFILE_SPECS[profile].network, where);
          assert.equal(result.readOnly, PROFILE_SPECS[profile].readOnly, where);
          if (required) assert.ok(result.sandbox !== undefined && result.sandbox !== "none", `${where}: the required sandbox is off`);
          if (forbidNetwork) assert.equal(result.network, false, where);
        }
      }
    }
    assert.equal(cases, 4 * 11);
  });

  test("with no profile the policy floor still applies, and no legacy value composes into something looser", () => {
    for (const { name, policy, required, forbidNetwork } of POLICIES) {
      const unset = compose(undefined, policy);
      assert.ok(!("refused" in unset));
      assert.equal(unset.label, required ? ":workspace" : "unconfined", name);
      const none = compose("none", policy);
      assert.equal("refused" in none, required, name);
      if ("refused" in none) assert.match(none.refused, /--sandbox none is refused: managed policy requires the sandbox\. \[policy: system .* sandbox\.required\]/);
      const network = compose(true, policy, { sandboxNetwork: true });
      assert.equal("refused" in network, forbidNetwork, name);
      if (!("refused" in network)) assert.equal(network.label, ":network");
    }
  });

  test("composition is monotone: the outcome ranks at or above what the operator named", () => {
    for (const { policy } of POLICIES) {
      for (const profile of SANDBOX_PROFILE_NAMES) {
        for (const flags of [{}, { readOnly: true }]) {
          const result = compose(profile, policy, flags);
          if ("refused" in result) continue;
          assert.ok(profileRank(result.label) >= profileRank(profile), `${profile} became ${result.label}`);
        }
      }
    }
    assert.deepEqual((["unconfined", ":network", ":workspace", ":read-only"] as const).map(profileRank), [0, 1, 2, 3]);
  });
});

describe("the posture describer", () => {
  test("with no profile the label is derived from the settings in force", () => {
    const rows: Array<[boolean | string | undefined, boolean, boolean, ProfileLabel, string, boolean]> = [
      // sandbox, readOnly, network → label, engine, network
      [undefined, false, false, "unconfined", "none", true],
      [false, false, true, "unconfined", "none", true],
      ["none", false, false, "unconfined", "none", true],
      [true, false, false, ":workspace", "auto", false],
      ["auto", false, false, ":workspace", "auto", false],
      ["bwrap", false, false, ":workspace", "bwrap", false],
      ["docker", false, false, ":workspace", "docker", false],
      [true, false, true, ":network", "auto", true],
      ["bwrap", false, true, ":network", "bwrap", true],
      ["docker", false, true, ":network", "docker", true],
      [undefined, true, false, ":read-only", "bwrap", false],
      [undefined, true, true, ":read-only", "bwrap", false],
      ["bwrap", true, true, ":read-only", "bwrap", false],
      ["none", true, false, ":read-only", "bwrap", false],
      ["docker", true, false, ":read-only", "docker", false],
    ];
    for (const [sandbox, readOnly, network, label, engine, effectiveNetwork] of rows) {
      const posture = describeSandboxPosture({ sandbox, readOnly, network });
      const where = JSON.stringify({ sandbox, readOnly, network });
      assert.equal(posture.profile, label, where);
      assert.equal(posture.engine, engine, where);
      assert.equal(posture.network, effectiveNetwork, where);
      assert.equal(posture.readOnly, readOnly, where);
      assert.equal(posture.explicit, false, where);
      assert.ok(posture.residual.length > 0, where);
      assert.ok(posture.source.length > 0, where);
      // The posture text is what the three surfaces printed before profiles existed.
      assert.equal(sandboxPostureText({ sandbox, readOnly, network }), sandbox ? (typeof sandbox === "string" ? sandbox : "on") : "off", where);
    }
    assert.equal(describeSandboxPosture({ sandbox: undefined, readOnly: false, network: false }).source, "default (no sandbox requested)");
    assert.equal(describeSandboxPosture({ sandbox: true, readOnly: false, network: false }).source, "--sandbox");
    assert.equal(describeSandboxPosture({ sandbox: undefined, readOnly: true, network: false }).source, "read-only mode");
  });

  test("an explicit profile is shown with its engine, network and source", () => {
    for (const profile of SANDBOX_PROFILE_NAMES) {
      for (const engine of ENGINES) {
        if (engine === "docker" && profile === ":read-only") continue;
        const spec = PROFILE_SPECS[profile];
        const input = { sandbox: spec.readOnly ? engine : engine ?? true, readOnly: spec.readOnly, network: spec.network, profile };
        const posture = describeSandboxPosture(input);
        assert.equal(posture.profile, profile);
        assert.equal(posture.explicit, true);
        assert.equal(posture.source, `--sandbox ${profile}`);
        assert.deepEqual(posture.residual, [...spec.residual]);
        const shownEngine = spec.readOnly ? "bwrap" : engine ?? "auto";
        assert.equal(sandboxPostureText(input), `${profile} (${shownEngine}, network ${spec.network ? "on" : "off"}, --sandbox ${profile})`);
      }
    }
  });

  test("a stricter setting in force replaces the named profile and says what decided", () => {
    // Read-only mode over an explicit :workspace or :network.
    for (const profile of [":workspace", ":network"] as const) {
      const posture = describeSandboxPosture({ sandbox: true, readOnly: true, network: PROFILE_SPECS[profile].network, profile });
      assert.equal(posture.profile, ":read-only");
      assert.equal(posture.explicit, false);
      assert.equal(posture.network, false);
      assert.equal(posture.source, `read-only mode (in place of --sandbox ${profile})`);
    }
    // The sandbox switched on by managed policy carries the policy source; an operator flag does not.
    const managed = describeSandboxPosture({ sandbox: "auto", readOnly: false, network: false, source: `managed policy ${TAG("sandbox.required")}` });
    assert.equal(managed.profile, ":workspace");
    assert.equal(managed.source, `managed policy ${TAG("sandbox.required")}`);
    assert.equal(describeSandboxPosture({ sandbox: "auto", readOnly: true, network: false, source: "managed policy x" }).source, "read-only mode");
    assert.equal(describeSandboxPosture({ sandbox: undefined, readOnly: false, network: false, source: "managed policy x" }).source, "default (no sandbox requested)");
    // The label never claims more than the settings give: a named profile with different settings in force is not echoed.
    const mismatch = describeSandboxPosture({ sandbox: undefined, readOnly: false, network: false, profile: ":read-only" });
    assert.equal(mismatch.profile, "unconfined");
    assert.equal(mismatch.explicit, false);
  });

  test("every profile documents its residual holes", () => {
    const all = (name: SandboxProfileName) => PROFILE_SPECS[name].residual.join("\n");
    assert.match(all(":workspace"), /broad host reads/);
    assert.match(all(":workspace"), /node_modules/);
    assert.match(all(":workspace"), /operator's own user/);
    assert.match(all(":network"), /unrestricted egress/);
    assert.match(all(":network"), /broad host reads/);
    assert.match(all(":read-only"), /operator's own user/);
    assert.doesNotMatch(all(":read-only"), /broad host reads/);
    for (const name of SANDBOX_PROFILE_NAMES) assert.match(all(name), /no seccomp/);
  });
});

describe("the profile is visible on every surface through the one describer", () => {
  const ANSI = /\u001b\[[0-9;]*m/g;

  /** One session configuration read back through the sidecar event, the REPL status line and the doctor report. */
  async function surfaces(overrides: Partial<HarnessConfig>) {
    const repo = makeRepo();
    const home = makeHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const realLog = console.log;
    const logs: string[] = [];
    try {
      const config = { endpoint: "http://127.0.0.1:1/v1", model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash", continuation: { ...DEFAULT_CONTINUATION }, ...overrides } as HarnessConfig;
      const app = new ApplicationCore(config);
      const events: any[] = [];
      const server = new SidecarServer({ app, mode: (config.approvalMode ?? "review") as any, write: (line) => events.push(JSON.parse(line)), historyFile: path.join(home, "history") });
      (server as any).emitSessionState();
      const state = events.filter((e) => e.type === "session.state").at(-1);
      const repl = new InteractiveRepl(app, (config.approvalMode ?? "review") as any);
      console.log = (...args: unknown[]) => void logs.push(args.join(" "));
      try { (repl as any).printStatus(false); } finally { console.log = realLog; }
      const line = logs.join("\n").replace(ANSI, "").split("\n").find((l) => l.startsWith("mode: ")) ?? "";
      const replSandbox = /· sandbox: (.*) · workspace:/.exec(line)?.[1];
      const report = await runDoctor({ config, home, timeoutMs: 1500 });
      app.shutdown();
      return { state, replSandbox, report, line };
    } finally {
      console.log = realLog;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }

  test("a named profile reads the same on session.state, the REPL status line and the doctor report", async () => {
    const { state, replSandbox, report, line } = await surfaces({ sandbox: "bwrap", sandboxProfile: ":workspace", approvalMode: "review" });
    const expected = sandboxPostureText({ sandbox: "bwrap", readOnly: false, network: false, profile: ":workspace" });
    assert.equal(expected, ":workspace (bwrap, network off, --sandbox :workspace)");
    assert.equal(state.posture.sandbox, expected);
    assert.equal(state.posture.profile, ":workspace");
    assert.equal(replSandbox, expected, line);
    assert.doesNotMatch(line, /managed policy/, "the REPL never invents a managed-policy source");
    assert.equal(report.posture?.sandbox, expected);
    assert.equal(report.posture?.profile, ":workspace");
    assert.equal(report.posture?.profileSource, "--sandbox :workspace");
  });

  test("without a named profile the sandbox text is what it always was, and the profile is derived", async () => {
    const plain = await surfaces({ approvalMode: "review" });
    assert.equal(plain.state.posture.sandbox, "off");
    assert.equal(plain.state.posture.profile, "unconfined");
    assert.equal(plain.replSandbox, "off");
    assert.equal(plain.report.posture?.sandbox, "off");
    const legacy = await surfaces({ sandbox: true, approvalMode: "review" });
    assert.equal(legacy.state.posture.sandbox, "on");
    assert.equal(legacy.state.posture.profile, ":workspace");
    assert.equal(legacy.replSandbox, "on");
    assert.equal(legacy.report.posture?.sandbox, "on");
    assert.equal(legacy.report.posture?.profile, ":workspace");
    const readOnly = await surfaces({ approvalMode: "read-only", readOnly: true });
    assert.equal(readOnly.state.posture.profile, ":read-only");
    assert.equal(readOnly.report.posture?.profile, ":read-only");
  });
});
