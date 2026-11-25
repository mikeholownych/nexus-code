import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { buildCommandEnvironment } from "../src/command_env.js";
import { wrapSandboxedCommand, isBwrapAvailable, isDockerAvailable, sandboxHomeMounts, setSandboxNetworkFlag, sandboxNetworkNotice, sandboxWorkspaceOverlays, hideDirectoryFromSandbox, isPathWithin, wrapSandboxedWorker } from "../src/sandbox.js";
import { defaultTaskStateDir } from "../src/core/state.js";

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
    assert.ok(r.stdout.includes(`v${process.versions.node}`), r.stdout);
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

describe("the control socket's directory is hidden from sandboxed commands (PF-3)", () => {
  /** A directory that holds a token descriptor, next to (not under) the home and the workspace. */
  function socketDirectory(parent: string): string {
    const dir = fs.mkdtempSync(path.join(parent, "nexus-sock-"));
    fs.writeFileSync(path.join(dir, "s-0123456789abcdef.json"), "SENTINEL-TOKEN");
    cleanup.push(dir);
    return dir;
  }
  const masks = (argv: readonly string[], dir: string): boolean => argv.some((arg, i) => arg === "--tmpfs" && argv[i + 1] === dir);

  test("the write-mode profile masks the directory wherever it is: /var/tmp, under $HOME, inside the workspace", () => {
    const { home, workspace } = throwawayHome();
    const elsewhere = socketDirectory("/var/tmp");
    const underHome = fs.mkdtempSync(path.join(home, "run-"));
    const insideWorkspace = fs.mkdtempSync(path.join(workspace, "run-"));
    for (const dir of [elsewhere, underHome, insideWorkspace]) {
      const wrapped = wrapSandboxedCommand("true", workspace, { mode: "bwrap", hideDirectories: [dir] });
      assert.ok(masks(wrapped.argv!, fs.realpathSync(dir)), `--tmpfs ${dir}`);
    }
    assert.ok(!masks(wrapSandboxedCommand("true", workspace, { mode: "bwrap" }).argv!, elsewhere), "no mask without a request");
  });

  test("the read-only profile masks it where its synthetic root could show it: under $HOME or inside the workspace", () => {
    const { home, workspace } = throwawayHome();
    const underHome = fs.mkdtempSync(path.join(home, "run-"));
    const insideWorkspace = fs.mkdtempSync(path.join(workspace, "run-"));
    for (const dir of [underHome, insideWorkspace]) {
      const wrapped = wrapSandboxedCommand("true", workspace, { mode: "bwrap", readOnlyHost: true, workspaceFd: 3, network: false, hideDirectories: [dir] });
      assert.ok(masks(wrapped.argv!, fs.realpathSync(dir)), `--tmpfs ${dir}`);
    }
  });

  test("a directory whose first segment merely starts with two dots is inside the workspace (..hid), not outside it", () => {
    const { workspace } = throwawayHome();
    assert.equal(isPathWithin(path.join(workspace, "..hid"), workspace), true);
    assert.equal(isPathWithin(path.join(workspace, "..hid", "nexus", "x"), workspace), true);
    assert.equal(isPathWithin(workspace, workspace), true);
    assert.equal(isPathWithin(path.dirname(workspace), workspace), false);
    assert.equal(isPathWithin(path.join(workspace, "..", "other"), workspace), false);
    assert.equal(isPathWithin(`${workspace}-sibling`, workspace), false);
    const dir = path.join(workspace, "..hid");
    fs.mkdirSync(dir);
    for (const readOnly of [false, true]) {
      const wrapped = wrapSandboxedCommand("true", workspace, { mode: "bwrap", hideDirectories: [dir], ...(readOnly ? { readOnlyHost: true, workspaceFd: 3, network: false } : {}) });
      assert.ok(masks(wrapped.argv!, fs.realpathSync(dir)), `${readOnly ? "read-only" : "write"} profile masks ..hid`);
    }
  });

  test("a directory registered for the process is masked in commands and in the sandboxed worker's launch", () => {
    const { workspace } = throwawayHome();
    const dir = socketDirectory("/var/tmp");
    hideDirectoryFromSandbox(dir);
    assert.ok(masks(wrapSandboxedCommand("true", workspace, { mode: "bwrap" }).argv!, fs.realpathSync(dir)));
    const worker = wrapSandboxedWorker(process.execPath, [], workspace, { engines: ["bwrap"] });
    if (worker.sandboxed) assert.ok(masks(worker.args, fs.realpathSync(dir)), "the worker box hides it too");
  });

  test("a sandboxed command cannot read the descriptor; the same command can without the mask", { skip: SKIP }, () => {
    const { workspace } = throwawayHome();
    const dir = socketDirectory("/var/tmp");
    const file = path.join(dir, "s-0123456789abcdef.json");
    const open = sandboxRun(`cat ${file} 2>&1; ls ${dir} 2>&1`, workspace);
    assert.match(open.stdout, /SENTINEL-TOKEN/, "control: with no mask the sandbox shows a /var/tmp file");
    const hidden = sandboxRun(`cat ${file} 2>&1; ls ${dir} 2>&1`, workspace, { hideDirectories: [dir] });
    assert.doesNotMatch(hidden.stdout, /SENTINEL-TOKEN/);
    assert.match(hidden.stdout, /No such file/, "the file is absent, not merely unreadable");
    assert.doesNotMatch(hidden.stdout.replace(/cat: .*\n/, ""), /s-0123456789abcdef/, "the directory lists empty");
  });

  test("a directory inside the workspace is masked too, and the workspace stays usable", { skip: SKIP }, () => {
    const { workspace } = throwawayHome();
    const dir = socketDirectory(workspace);
    const hidden = sandboxRun(`cat ${path.join(dir, "s-0123456789abcdef.json")} 2>&1; echo ok > out.txt && cat out.txt`, workspace, { hideDirectories: [dir] });
    assert.doesNotMatch(hidden.stdout, /SENTINEL-TOKEN/);
    assert.match(hidden.stdout, /ok/);
  });
});

describe("the state root is hidden from --sandbox commands and workers (PA-3)", () => {
  const taskFile = (root: string) => {
    fs.mkdirSync(path.join(root, "tasks"), { recursive: true });
    fs.writeFileSync(path.join(root, "tasks", "g.json"), "SENTINEL-GOAL-STATE");
    return path.join(root, "tasks", "g.json");
  };

  test("workspace = $HOME: a command can neither read, rewrite nor rename ~/.nexus", { skip: SKIP }, () => {
    const { home } = throwawayHome();
    const file = taskFile(path.join(home, ".nexus"));
    const r = sandboxRun(`cat ${file} 2>&1; echo pwned > ${file} 2>&1; ls ~/.nexus/tasks 2>&1; mv ~/.nexus ~/.nexus.old 2>&1; mkdir -p ~/.nexus/tasks 2>&1; echo forged > ~/.nexus/tasks/goal-forged.json 2>&1`, home);
    assert.doesNotMatch(r.stdout, /SENTINEL/);
    assert.match(r.stdout, /busy|denied|not permitted|Read-only/i, "the rename is refused");
    assert.equal(fs.readFileSync(file, "utf8"), "SENTINEL-GOAL-STATE", "the host file is untouched");
    assert.equal(fs.existsSync(path.join(home, ".nexus.old")), false, "the root was not renamed");
    assert.equal(fs.existsSync(path.join(home, ".nexus", "tasks", "goal-forged.json")), false, "nothing forged on the host");
    const readOnly = sandboxRun(`cat ${file} 2>&1`, home, { readOnlyHost: true, network: false, workspaceFd: fs.openSync(home, "r") });
    assert.doesNotMatch(readOnly.stdout, /SENTINEL/);
  });

  test("an absent state root is created 0700 before wrapping, so a command cannot plant one on the host", { skip: SKIP }, () => {
    const { home } = throwawayHome();
    assert.equal(fs.existsSync(path.join(home, ".nexus")), false, "setup: absent");
    sandboxRun("mkdir -p ~/.nexus/tasks && echo X > ~/.nexus/tasks/goal-planted.json; ls -A ~/.nexus 2>&1", home);
    assert.equal(fs.existsSync(path.join(home, ".nexus", "tasks", "goal-planted.json")), false, "nothing planted on the host");
    assert.equal(fs.statSync(path.join(home, ".nexus")).mode & 0o777, 0o700);
  });

  test("workspace elsewhere and NEXUS_STATE_DIR outside HOME: still hidden and untouched", { skip: SKIP }, () => {
    const { workspace } = throwawayHome();
    const state = fs.mkdtempSync(path.join("/var/tmp", "nexus-s2-state-"));
    cleanup.push(state);
    const saved = process.env.NEXUS_STATE_DIR;
    process.env.NEXUS_STATE_DIR = state;
    try {
      const file = taskFile(state);
      const r = sandboxRun(`cat ${file} 2>&1; echo pwned > ${file} 2>&1`, workspace);
      assert.doesNotMatch(r.stdout, /SENTINEL/);
      assert.equal(fs.readFileSync(file, "utf8"), "SENTINEL-GOAL-STATE");
      const worker = wrapSandboxedWorker(process.execPath, [], workspace, { engines: ["bwrap"] });
      if (worker.sandboxed) assert.ok(worker.args.includes(fs.realpathSync(state)), "the worker box masks the root too");
    } finally {
      if (saved === undefined) delete process.env.NEXUS_STATE_DIR; else process.env.NEXUS_STATE_DIR = saved;
    }
  });
});

describe("the state root cannot be renamed away through an ancestor, a symlink or a workspace inside it (PA-3)", () => {
  const BUSY = /busy|cannot move|denied|not permitted/i;
  const scratch = () => {
    const parent = fs.mkdtempSync(path.join(fs.existsSync("/var/tmp") ? "/var/tmp" : os.tmpdir(), "nexus-s2-anc-"));
    cleanup.push(parent);
    return parent;
  };
  const withState = <T>(dir: string | undefined, run: () => T): T => {
    const saved = process.env.NEXUS_STATE_DIR;
    if (dir === undefined) delete process.env.NEXUS_STATE_DIR; else process.env.NEXUS_STATE_DIR = dir;
    try { return run(); } finally { if (saved === undefined) delete process.env.NEXUS_STATE_DIR; else process.env.NEXUS_STATE_DIR = saved; }
  };
  const seed = (root: string) => {
    fs.mkdirSync(path.join(root, "tasks"), { recursive: true });
    fs.writeFileSync(path.join(root, "tasks", "g.json"), "SENTINEL-GOAL-STATE");
  };
  const forge = (home: string, root = path.join(home, ".nexus")) => `mkdir -p ${root}/tasks 2>&1; echo FORGED > ${root}/tasks/goal-forged.json 2>&1`;
  const untouched = (root: string) => {
    assert.equal(fs.readFileSync(path.join(root, "tasks", "g.json"), "utf8"), "SENTINEL-GOAL-STATE");
    assert.equal(fs.existsSync(path.join(root, "tasks", "goal-forged.json")), false, "nothing forged on the host");
  };

  test("workspace = parent of HOME: HOME cannot be renamed and a forged goal file never reaches the host", { skip: SKIP }, () => {
    const parent = scratch();
    const home = path.join(parent, "home");
    fs.mkdirSync(home);
    process.env.HOME = home;
    seed(path.join(home, ".nexus"));
    const r = sandboxRun(`mv ${home} ${home}-x 2>&1; ${forge(home)}`, parent);
    assert.match(r.stdout, BUSY);
    assert.equal(fs.existsSync(`${home}-x`), false, "HOME was not renamed");
    untouched(path.join(home, ".nexus"));
  });

  test("workspace = HOME, root = $HOME/a/b/st: every ancestor is un-renamable, the root is hidden, the workspace works", { skip: SKIP }, () => {
    const parent = scratch();
    const home = path.join(parent, "home");
    const root = path.join(home, "a", "b", "st");
    fs.mkdirSync(root, { recursive: true });
    process.env.HOME = home;
    seed(root);
    withState(root, () => {
      const r = sandboxRun(`mv ${home}/a/b ${home}/a/b.old 2>&1; mv ${home}/a ${home}/a.old 2>&1; mv ${root} ${root}.old 2>&1; ${forge(home, root)}; echo ok > ${home}/plain.txt && rm ${home}/plain.txt && mkdir ${home}/d && touch ${home}/d/f && echo WORKS`, home);
      assert.equal((r.stdout.match(/busy/gi) ?? []).length, 3, r.stdout);
      assert.match(r.stdout, /WORKS/);
      for (const moved of ["a.old", "a/b.old", "a/b/st.old"]) assert.equal(fs.existsSync(path.join(home, moved)), false, moved);
      untouched(root);
    });
  });

  test("a git repository in the workspace still works beside the pinned ancestors", { skip: SKIP }, () => {
    const parent = scratch();
    const home = path.join(parent, "home");
    const root = path.join(home, "a", "st");
    fs.mkdirSync(root, { recursive: true });
    process.env.HOME = home;
    withState(root, () => {
      const r = sandboxRun(`cd ${home} && git init -q . 2>&1 && echo hi > f.txt && git status --short 2>&1`, home);
      assert.match(r.stdout, /\?\? f\.txt/);
    });
  });

  test("a symlinked state directory inside the workspace is refused with a clear error; outside it, the real path is masked", { skip: SKIP }, () => {
    const parent = scratch();
    const home = path.join(parent, "home");
    fs.mkdirSync(path.join(home, "real"), { recursive: true });
    fs.symlinkSync(path.join(home, "real"), path.join(home, "lnk"));
    process.env.HOME = home;
    withState(path.join(home, "lnk"), () => {
      const w = wrapSandboxedCommand("true", home, { mode: "bwrap" });
      assert.equal(w.sandboxed, false);
      assert.match(w.warning ?? "", /through a symlink inside the workspace.*real path/);
    });
    const outside = scratch();
    fs.mkdirSync(path.join(outside, "real"));
    fs.symlinkSync(path.join(outside, "real"), path.join(outside, "lnk"));
    seed(path.join(outside, "real"));
    withState(path.join(outside, "lnk"), () => {
      const r = sandboxRun(`cat ${outside}/real/tasks/g.json 2>&1`, home);
      assert.doesNotMatch(r.stdout, /SENTINEL/);
    });
  });

  test("a workspace that is the state directory, or inside its tasks, is refused explicitly", { skip: SKIP }, () => {
    const parent = scratch();
    const home = path.join(parent, "home");
    const root = path.join(home, ".nexus");
    fs.mkdirSync(path.join(root, "tasks"), { recursive: true });
    process.env.HOME = home;
    for (const workspace of [root, path.join(root, "tasks")]) {
      const w = wrapSandboxedCommand("true", workspace, { mode: "bwrap" });
      assert.equal(w.sandboxed, false, workspace);
      assert.match(w.warning ?? "", /Start Nexus outside the state directory/);
    }
  });

  test("BG-1: an unattended job worktree under <repo>/.nexus/worktrees works when the repository is HOME", { skip: SKIP }, () => {
    const parent = scratch();
    const home = path.join(parent, "home");
    const worktree = path.join(home, ".nexus", "worktrees", "job-1");
    fs.mkdirSync(worktree, { recursive: true });
    fs.mkdirSync(path.join(home, ".nexus", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(home, ".nexus", "tasks", "g.json"), "SENTINEL-GOAL-STATE");
    process.env.HOME = home;
    const r = sandboxRun(`echo built > out.txt && cat out.txt; cat ${home}/.nexus/tasks/g.json 2>&1; mv ${home}/.nexus ${home}/.nexus.old 2>&1`, worktree);
    assert.match(r.stdout, /built/);
    assert.doesNotMatch(r.stdout, /SENTINEL/);
    assert.equal(fs.existsSync(path.join(home, ".nexus", "tasks", "g.json")), true, "host state intact");
    assert.equal(fs.existsSync(`${home}/.nexus.old`), false);
  });
});
