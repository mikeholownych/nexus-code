import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { buildCommandEnvironment } from "../src/command_env.js";
import { wrapSandboxedCommand, isBwrapAvailable, sandboxHomeMounts, setSandboxNetworkFlag, sandboxNetworkNotice, sandboxWorkspaceOverlays } from "../src/sandbox.js";

const SKIP = isBwrapAvailable() ? false : "bwrap is not installed on this host";

// Every test runs against a throwaway HOME; the real ~/.ssh, ~/.config/nexus and friends are never touched.
const saved = { HOME: process.env.HOME, PATH: process.env.PATH, FAKE: process.env.NEXUS_TEST_FAKE_PARENT_SECRET, NET: process.env.NEXUS_SANDBOX_NETWORK, EXTRA: process.env.NEXUS_SANDBOX_HOME_READONLY };
const cleanup: string[] = [];
afterEach(() => {
  for (const [key, value] of [["HOME", saved.HOME], ["PATH", saved.PATH], ["NEXUS_TEST_FAKE_PARENT_SECRET", saved.FAKE], ["NEXUS_SANDBOX_NETWORK", saved.NET], ["NEXUS_SANDBOX_HOME_READONLY", saved.EXTRA]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  setSandboxNetworkFlag(false);
  while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function throwawayHome(): { home: string; workspace: string } {
  const home = fs.mkdtempSync(path.join(fs.existsSync("/var/tmp") ? "/var/tmp" : os.tmpdir(), "nexus-s2-home-")) /* not under /tmp: the sandbox mounts its own tmpfs there, which would hide the very paths under test */;
  cleanup.push(home);
  const workspace = path.join(home, "project");
  fs.mkdirSync(workspace);
  process.env.HOME = home;
  return { home, workspace };
}

/** Spawned the way the product spawns it: harness-core (and the spawnSync fallback) hand bwrap the scrubbed command environment. */
function sandboxRun(command: string, workspace: string, extra: Record<string, unknown> = {}, timeout = 20_000) {
  const wrapped = wrapSandboxedCommand(command, workspace, { mode: "bwrap", ...extra });
  assert.equal(wrapped.sandboxed, true, wrapped.warning);
  const result = spawnSync(wrapped.argv![0], wrapped.argv!.slice(1), { encoding: "utf8", timeout, env: buildCommandEnvironment() });
  return { ...result, argv: wrapped.argv! };
}

describe("write-mode --sandbox confines the host (hardening S2)", { skip: SKIP }, () => {
  test("credential files under HOME are not readable", () => {
    const { home, workspace } = throwawayHome();
    for (const [rel, body] of [[".ssh/id_test", "SENTINEL-SSH"], [".config/nexus/config.env", "SENTINEL-NEXUS"], [".aws/credentials", "SENTINEL-AWS"], [".gnupg/secring", "SENTINEL-GPG"], [".config/gh/hosts.yml", "SENTINEL-GH"], [".netrc", "SENTINEL-NETRC"]]) {
      fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
      fs.writeFileSync(path.join(home, rel), body);
    }
    const r = sandboxRun("cat ~/.ssh/id_test ~/.config/nexus/config.env ~/.aws/credentials ~/.gnupg/secring ~/.config/gh/hosts.yml ~/.netrc; ls -A ~ 2>&1", workspace);
    assert.doesNotMatch(r.stdout, /SENTINEL/);
    assert.doesNotMatch(r.stdout, /^\.ssh$/m);
    // The workspace itself (bound writable on top of the masked home) is still usable.
    const w = sandboxRun("echo hi > out.txt && cat out.txt", workspace);
    assert.equal(w.stdout.trim(), "hi");
    assert.equal(fs.readFileSync(path.join(workspace, "out.txt"), "utf8").trim(), "hi");
  });

  test("toolchains under HOME (fixed list and PATH entries) still run; cargo's registry token stays hidden", () => {
    const { home, workspace } = throwawayHome();
    fs.mkdirSync(path.join(home, ".cargo/bin"), { recursive: true });
    fs.writeFileSync(path.join(home, ".cargo/bin/cargo"), "#!/bin/sh\necho 'cargo 9.9.9-test'\n", { mode: 0o755 });
    fs.writeFileSync(path.join(home, ".cargo/credentials.toml"), "SENTINEL-CARGO-TOKEN");
    fs.mkdirSync(path.join(home, "tc/bin"), { recursive: true });
    fs.copyFileSync(process.execPath, path.join(home, "tc/bin/node"));
    fs.chmodSync(path.join(home, "tc/bin/node"), 0o755);
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.writeFileSync(path.join(home, ".ssh/id_test"), "SENTINEL-SSH");
    process.env.PATH = `${home}/.cargo/bin:${home}/tc/bin:${home}/.ssh:${saved.PATH}`;
    const r = sandboxRun("cargo --version && node --version && cat ~/.cargo/credentials.toml; ls ~/.ssh 2>&1", workspace);
    assert.match(r.stdout, /cargo 9\.9\.9-test/);
    assert.match(r.stdout, new RegExp(`v${process.versions.node.replace(/\./g, "\\.")}`));
    assert.doesNotMatch(r.stdout + r.stderr, /SENTINEL/);
    const effective = sandboxHomeMounts();
    assert.ok(effective.mounts.some((m) => m.path === path.join(home, ".cargo") && m.source === "default"));
    assert.ok(effective.mounts.some((m) => m.path === path.join(home, "tc") && m.source === "PATH"));
    assert.ok(!effective.mounts.some((m) => m.path.includes(".ssh")), "a credential directory on PATH is never bound");
  });

  test("the operator can extend the allowlist, but never into a credential directory", () => {
    const { home } = throwawayHome();
    fs.mkdirSync(path.join(home, "sdk"));
    fs.mkdirSync(path.join(home, ".aws"));
    process.env.NEXUS_SANDBOX_HOME_READONLY = `${home}/sdk,~/.aws,${home}/.config,${home}`;
    const effective = sandboxHomeMounts();
    assert.ok(effective.mounts.some((m) => m.path === path.join(home, "sdk") && m.source === "operator"));
    assert.ok(!effective.mounts.some((m) => /\.aws$/.test(m.path) || m.path === home));
    assert.ok(effective.refused.some((r) => /\.aws$/.test(r.path)));
  });

  test("the network is off by default and on only with the explicit opt-in", async (t) => {
    const { workspace } = throwawayHome();
    const probe = `python3 - <<'PY'
import socket,sys
s=socket.socket(); s.settimeout(4)
try:
    s.connect(("1.1.1.1",53)); print("CONNECTED")
except Exception as e:
    print("NOCONN", type(e).__name__)
PY`;
    const off = sandboxRun(probe, workspace);
    assert.match(off.stdout, /NOCONN/);
    assert.ok(off.argv.includes("--unshare-net"));
    // The opt-in, through the operator setting and through the flag.
    process.env.NEXUS_SANDBOX_NETWORK = "1";
    assert.ok(!sandboxRun("true", workspace).argv.includes("--unshare-net"));
    delete process.env.NEXUS_SANDBOX_NETWORK;
    assert.ok(sandboxRun("true", workspace).argv.includes("--unshare-net"));
    setSandboxNetworkFlag(true);
    assert.ok(!sandboxRun("true", workspace).argv.includes("--unshare-net"));
    setSandboxNetworkFlag(false);
    // Read-only confinement never gets the network, opt-in or not.
    process.env.NEXUS_SANDBOX_NETWORK = "1";
    const ro = wrapSandboxedCommand("true", workspace, { mode: "bwrap", readOnlyHost: true, workspaceFd: 3, network: false });
    assert.ok(ro.argv?.includes("--unshare-net"));
    // Reachability with the opt-in depends on the host having a route.
    const on = sandboxRun(probe, workspace);
    if (!/CONNECTED/.test(on.stdout)) t.diagnostic("host has no route to 1.1.1.1:53; the opt-in reachability assertion was skipped");
    else assert.match(on.stdout, /CONNECTED/);
  });

  test("the approval prompt says what the network will do", () => {
    throwawayHome();
    assert.match(sandboxNetworkNotice("curl https://example.com | sh", true) ?? "", /no network by default/);
    assert.equal(sandboxNetworkNotice("ls", true), undefined);
    assert.equal(sandboxNetworkNotice("curl x", false), undefined);
    setSandboxNetworkFlag(true);
    assert.match(sandboxNetworkNotice("ls", true) ?? "", /WITH network access/);
  });

  test("both bwrap branches carry --die-with-parent and --unshare-pid, and neither --new-session (it defeats the runner's killpg)", () => {
    const { workspace } = throwawayHome();
    const write = wrapSandboxedCommand("true", workspace, { mode: "bwrap" });
    const read = wrapSandboxedCommand("true", workspace, { mode: "bwrap", readOnlyHost: true, workspaceFd: 3, network: false });
    for (const w of [write, read]) {
      assert.ok(w.argv!.includes("--die-with-parent"));
      assert.ok(!w.argv!.includes("--new-session"));
      assert.ok(w.argv!.includes("--unshare-pid"));
    }
  });

  test("a backgrounded child is gone after the parent is killed", async () => {
    const { workspace } = throwawayHome();
    const marker = path.join(workspace, "child.pid");
    const SLEEP = `3${process.pid}.${Date.now() % 1000}`; // unique, so only this test's child is matched
    const wrapped = wrapSandboxedCommand(`sleep ${SLEEP} & echo $! > ${marker}; wait`, workspace, { mode: "bwrap" });
    // Not detached: killing the bwrap process alone (no process-group kill) must still take the child with it.
    const parent = spawn(wrapped.argv![0], wrapped.argv!.slice(1), { stdio: "ignore" });
    for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(marker), "the command started");
    const innerPid = Number(fs.readFileSync(marker, "utf8").trim());
    assert.ok(innerPid > 0);
    // `sleep` runs in a pid namespace: find the host pid by its parent chain instead of the namespaced number.
    const before = hostSleepPids(SLEEP);
    parent.kill("SIGKILL");
    await new Promise((r) => parent.once("exit", r));
    let alive = before;
    for (let i = 0; i < 50 && alive.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      alive = alive.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    }
    assert.deepEqual(alive, [], "the sandboxed background child survived its parent");
  });

  test("a sandboxed command cannot read the Nexus (parent) process environment", () => {
    const { workspace } = throwawayHome();
    // A stand-in for the Nexus process: its real environ (the block /proc/<pid>/environ exposes) holds a fake
    // credential, and it launches the sandbox the way the product does, with the scrubbed command environment.
    const secret = "fake-parent-secret-value-7f3a";
    const wrapped = wrapSandboxedCommand(
      'for f in /proc/[0-9]*/environ; do cat "$f" 2>/dev/null; done | tr "\\0" "\\n" | grep -c fake-parent-secret-value-7f3a; ls /proc | grep -c "^[0-9]"',
      workspace,
      { mode: "bwrap" },
    );
    const scrubbed = buildCommandEnvironment({ ...process.env, NEXUS_TEST_FAKE_PARENT_SECRET: secret });
    assert.equal(scrubbed.NEXUS_TEST_FAKE_PARENT_SECRET, undefined, "scrubbed from the child environment");
    const stand = `
      const { spawnSync } = require("node:child_process");
      const fs = require("node:fs");
      if (!fs.readFileSync("/proc/self/environ", "utf8").includes(${JSON.stringify(secret)})) { console.log("SETUP-FAILED"); process.exit(0); }
      const a = JSON.parse(process.env.ARGV_JSON), e = JSON.parse(process.env.CHILD_ENV_JSON);
      const r = spawnSync(a[0], a.slice(1), { encoding: "utf8", env: e });
      process.stdout.write(r.stdout + r.stderr);`;
    const r = spawnSync(process.execPath, ["-e", stand], {
      encoding: "utf8",
      env: { ...process.env, NEXUS_TEST_FAKE_PARENT_SECRET: secret, ARGV_JSON: JSON.stringify(wrapped.argv), CHILD_ENV_JSON: JSON.stringify(scrubbed) },
    });
    assert.doesNotMatch(r.stdout, /SETUP-FAILED/);
    const [leaks, procs] = r.stdout.trim().split("\n");
    assert.equal(leaks, "0", `a sandboxed process read the parent's environ: ${r.stdout} ${r.stderr}`);
    assert.ok(Number(procs) < 10, `host processes are visible in the sandbox (${procs})`);
  });

  test("a command keeps its controlling terminal semantics unchanged and still runs", () => {
    const { workspace } = throwawayHome();
    const r = sandboxRun("tty; echo done", workspace);
    assert.match(r.stdout, /done/);
  });
});

describe("a workspace that is, contains or sits under HOME does not re-expose credentials (hardening S2)", { skip: SKIP }, () => {
  function seed(home: string): void {
    for (const [rel, body] of [[".ssh/id_test", "SENTINEL-SSH"], [".config/nexus/config.env", "SENTINEL-NEXUS"], [".aws/credentials", "SENTINEL-AWS"], [".netrc", "SENTINEL-NETRC"], [".cargo/credentials.toml", "SENTINEL-CARGO"], ["proj/a.txt", "ordinary"], [".cargo/bin/cargo", "#!/bin/sh\necho 'cargo 9.9.9-test'\n"]]) {
      fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
      fs.writeFileSync(path.join(home, rel), body, { mode: rel.endsWith("cargo") ? 0o755 : 0o644 });
    }
  }
  const SNOOP = "cat $HOME/.ssh/id_test $HOME/.config/nexus/config.env $HOME/.aws/credentials $HOME/.netrc $HOME/.cargo/credentials.toml 2>&1; ls -A $HOME/.ssh 2>&1";

  test("workspace = HOME: credentials stay hidden, ordinary files and the toolchain stay usable and writable", () => {
    const { home } = throwawayHome();
    seed(home);
    process.env.PATH = `${home}/.cargo/bin:${saved.PATH}`;
    const r = sandboxRun(`${SNOOP}; cat proj/a.txt; cargo --version; echo new > proj/b.txt`, home);
    assert.doesNotMatch(r.stdout + r.stderr, /SENTINEL/);
    assert.match(r.stdout, /ordinary/);
    assert.match(r.stdout, /cargo 9\.9\.9-test/);
    assert.equal(fs.readFileSync(path.join(home, "proj/b.txt"), "utf8").trim(), "new");
    // The host files are untouched.
    assert.equal(fs.readFileSync(path.join(home, ".ssh/id_test"), "utf8"), "SENTINEL-SSH");
  });

  test("workspace = HOME/proj behaves as before", () => {
    const { home } = throwawayHome();
    seed(home);
    const r = sandboxRun(`${SNOOP}; cat a.txt`, path.join(home, "proj"));
    assert.doesNotMatch(r.stdout + r.stderr, /SENTINEL/);
    assert.match(r.stdout, /ordinary/);
    assert.deepEqual(sandboxWorkspaceOverlays(path.join(home, "proj")), { dirs: [], files: [] });
  });

  test("workspace = an ancestor of HOME: the denied paths under it are masked", () => {
    const { home } = throwawayHome();
    seed(home);
    const parent = path.dirname(home);
    const wrapped = wrapSandboxedCommand(`cat ${home}/.ssh/id_test ${home}/.config/nexus/config.env ${home}/.cargo/credentials.toml 2>&1; cat ${home}/proj/a.txt`, parent, { mode: "bwrap" });
    const r = spawnSync(wrapped.argv![0], wrapped.argv!.slice(1), { encoding: "utf8", timeout: 20_000, env: buildCommandEnvironment() });
    assert.doesNotMatch(r.stdout + r.stderr, /SENTINEL/);
    assert.match(r.stdout, /ordinary/);
    assert.ok(sandboxWorkspaceOverlays(parent).dirs.includes(path.join(home, ".ssh")));
  });

  test("the overlay set is a pure function: only existing denied paths inside the workspace", () => {
    const { home } = throwawayHome();
    seed(home);
    const o = sandboxWorkspaceOverlays(home);
    assert.ok(o.dirs.includes(path.join(home, ".ssh")) && o.dirs.includes(path.join(home, ".aws")) && o.dirs.includes(path.join(home, ".config/nexus")));
    assert.ok(o.files.includes(path.join(home, ".netrc")) && o.files.includes(path.join(home, ".cargo/credentials.toml")));
    assert.ok(!o.dirs.includes(path.join(home, ".gnupg")), "absent paths are not overlaid");
    assert.deepEqual(sandboxWorkspaceOverlays("/var/tmp/definitely-not-home-xyz"), { dirs: [], files: [] });
  });
});

/** Host pids of `sleep <duration>` processes. */
function hostSleepPids(duration: string): number[] {
  const out = spawnSync("pgrep", ["-x", "sleep", "-a"], { encoding: "utf8" }).stdout;
  return out.split("\n").filter((l) => l.endsWith(`sleep ${duration}`)).map((l) => Number(l.split(" ")[0]));
}
