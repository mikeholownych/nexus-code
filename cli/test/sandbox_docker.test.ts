import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildCommandEnvironment } from "../src/command_env.js";
import { wrapSandboxedCommand, isDockerAvailable, setSandboxNetworkFlag, DOCKER_SANDBOX_IMAGE, DOCKER_SANDBOX_IMAGE_SETTING } from "../src/sandbox.js";

// Throwaway HOME for every test; the real ~/.config/nexus is never read.
const saved = { HOME: process.env.HOME, IMG: process.env[DOCKER_SANDBOX_IMAGE_SETTING], NET: process.env.NEXUS_SANDBOX_NETWORK, SENT: process.env.NEXUS_TEST_DOCKER_SENTINEL_TOKEN };
const cleanup: string[] = [];
afterEach(() => {
  for (const [key, value] of [["HOME", saved.HOME], [DOCKER_SANDBOX_IMAGE_SETTING, saved.IMG], ["NEXUS_SANDBOX_NETWORK", saved.NET], ["NEXUS_TEST_DOCKER_SENTINEL_TOKEN", saved.SENT]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  setSandboxNetworkFlag(false);
  while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});
function throwaway(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-s5-"));
  cleanup.push(home);
  process.env.HOME = home;
  delete process.env.NEXUS_SANDBOX_NETWORK;
  return home;
}
function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i < 0 ? undefined : argv[i + 1];
}
const forceDockerArgv = (cmd = "true", workspace = "/work/space", extra = {}) => {
  // argv construction does not need a daemon only when the docker CLI exists; skip cleanly otherwise.
  const w = wrapSandboxedCommand(cmd, workspace, { mode: "docker", ...extra });
  return w;
};
const HAVE_DOCKER = isDockerAvailable();

describe("docker sandbox argv is hardened (hardening S5)", { skip: HAVE_DOCKER ? false : "docker CLI is not installed" }, () => {
  test("every hardening flag is present and the image is digest-pinned", () => {
    throwaway();
    const w = forceDockerArgv();
    assert.equal(w.sandboxed, true, w.warning);
    const argv = w.argv!;
    assert.deepEqual(argv.slice(0, 3), ["docker", "run", "--rm"]);
    assert.equal(flagValue(argv, "--user"), `${process.getuid!()}:${process.getgid!()}`);
    assert.equal(flagValue(argv, "--cap-drop"), "ALL");
    assert.equal(flagValue(argv, "--security-opt"), "no-new-privileges");
    assert.equal(flagValue(argv, "--network"), "none");
    assert.match(flagValue(argv, "--pids-limit") ?? "", /^\d+$/);
    assert.ok(argv.includes("--read-only"));
    assert.match(flagValue(argv, "--tmpfs") ?? "", /^\/tmp(:|$)/);
    const image = argv[argv.indexOf("sh") - 1];
    assert.equal(image, DOCKER_SANDBOX_IMAGE);
    assert.match(image, /@sha256:[0-9a-f]{64}$/);
    assert.ok(!argv.some((a) => /:latest$/.test(a) || a === "alpine"), "no floating tag");
    assert.deepEqual(argv.slice(-3), ["sh", "-c", "true"]);
  });

  test("only the scrubbed environment is passed, explicitly", () => {
    throwaway();
    process.env.NEXUS_TEST_DOCKER_SENTINEL_TOKEN = "docker-sentinel-secret";
    process.env.NEXUS_TEST_DOCKER_PLAIN = "plain-ok";
    try {
      const argv = forceDockerArgv().argv!;
      assert.ok(!argv.join("\n").includes("docker-sentinel-secret"));
      const names = argv.flatMap((a, i) => (argv[i - 1] === "--env" ? [a.split("=")[0]] : []));
      assert.ok(names.includes("NEXUS_TEST_DOCKER_PLAIN"));
      assert.ok(!names.includes("NEXUS_TEST_DOCKER_SENTINEL_TOKEN"));
      // Every --env comes from buildCommandEnvironment() (HOME/PATH/TMPDIR are remapped to container paths); nothing else.
      const allowed = new Set([...Object.keys(buildCommandEnvironment()), "HOME", "PATH", "TMPDIR"]);
      assert.ok(names.every((n) => allowed.has(n)), names.join(","));
      assert.ok(!argv.includes("-e") && !argv.includes("--env-file"));
    } finally {
      delete process.env.NEXUS_TEST_DOCKER_PLAIN;
    }
  });

  test("the network opt-in (flag or NEXUS_SANDBOX_NETWORK) removes --network none; the default and network:false keep it", () => {
    throwaway();
    assert.equal(flagValue(forceDockerArgv().argv!, "--network"), "none");
    setSandboxNetworkFlag(true);
    assert.equal(forceDockerArgv().argv!.includes("--network"), false);
    assert.equal(flagValue(forceDockerArgv("true", "/work/space", { network: false }).argv!, "--network"), "none");
    setSandboxNetworkFlag(false);
    process.env.NEXUS_SANDBOX_NETWORK = "1";
    assert.equal(forceDockerArgv().argv!.includes("--network"), false);
  });

  test("operator image must be digest-pinned; an unpinned override fails closed", () => {
    throwaway();
    const good = `registry.example/img@sha256:${"a".repeat(64)}`;
    process.env[DOCKER_SANDBOX_IMAGE_SETTING] = good;
    const w = forceDockerArgv();
    assert.equal(w.argv![w.argv!.indexOf("sh") - 1], good);
    process.env[DOCKER_SANDBOX_IMAGE_SETTING] = "alpine:latest";
    const bad = forceDockerArgv();
    assert.equal(bad.sandboxed, false);
    assert.equal(bad.argv, undefined);
    assert.match(bad.warning ?? "", /sha256/);
  });

  test("no dead mountMode code remains", () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, "../src/sandbox.ts"), "utf8");
    assert.ok(!src.includes("mountMode"));
  });
});

describe("docker sandbox in a real container (hardening S5)", { skip: HAVE_DOCKER && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0 ? false : "docker daemon is not usable" }, () => {
  test("a write outside workspace and /tmp fails, the workspace write works, and no secret is visible", () => {
    const home = throwaway();
    const workspace = path.join(home, "ws");
    fs.mkdirSync(workspace);
    process.env.NEXUS_TEST_DOCKER_SENTINEL_TOKEN = "docker-sentinel-secret";
    const w = wrapSandboxedCommand(
      'printf ok > inside.txt; printf x > /outside.txt 2> /dev/null && echo ROOT_WRITABLE; printf t > /tmp/t.txt && echo TMP_OK; id -u; grep -c "^CapEff:.0000000000000000" /proc/self/status; env | grep -c SENTINEL; cat /proc/self/environ | tr "\\0" "\\n" | grep -c docker-sentinel',
      workspace,
      { mode: "docker" },
    );
    assert.equal(w.sandboxed, true, w.warning);
    const r = spawnSync(w.argv![0], w.argv!.slice(1), { encoding: "utf8", timeout: 120_000, env: buildCommandEnvironment() });
    assert.ok(!r.stdout.includes("ROOT_WRITABLE"), r.stdout + r.stderr);
    assert.ok(r.stdout.includes("TMP_OK"), r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(workspace, "inside.txt"), "utf8"), "ok");
    assert.ok(r.stdout.split("\n").includes(String(process.getuid!())), r.stdout);
    assert.ok(!r.stdout.includes("docker-sentinel"));
    const lines = r.stdout.trim().split("\n");
    assert.deepEqual(lines.slice(-3), ["1", "0", "0"], r.stdout); // caps empty, no SENTINEL in env, none in /proc/self/environ
  });

  test("network is unreachable by default", () => {
    const home = throwaway();
    const workspace = path.join(home, "ws");
    fs.mkdirSync(workspace);
    const w = wrapSandboxedCommand("wget -q -T 3 -O- http://1.1.1.1/ >/dev/null 2>&1 && echo NET_UP || echo NET_DOWN", workspace, { mode: "docker" });
    const r = spawnSync(w.argv![0], w.argv!.slice(1), { encoding: "utf8", timeout: 120_000, env: buildCommandEnvironment() });
    assert.equal(r.stdout.trim(), "NET_DOWN", r.stdout + r.stderr);
  });
});

describe("docker workspace bind does not re-expose credentials under HOME (hardening S5)", { skip: HAVE_DOCKER && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0 ? false : "docker daemon is not usable" }, () => {
  /** A throwaway HOME under /var/tmp (not /tmp: the container mounts its own tmpfs there) with credential sentinels. */
  function sentinelHome(): { home: string } {
    const home = fs.mkdtempSync(path.join(fs.existsSync("/var/tmp") ? "/var/tmp" : os.tmpdir(), "nexus-s5-home-"));
    cleanup.push(home);
    fs.chmodSync(home, 0o755);
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.writeFileSync(path.join(home, ".ssh", "id_test"), "SENTINEL-SSH");
    fs.mkdirSync(path.join(home, ".config", "nexus"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "nexus", "config.env"), "SENTINEL-NEXUS");
    fs.mkdirSync(path.join(home, "proj"));
    fs.writeFileSync(path.join(home, "proj", "a.txt"), "visible");
    process.env.HOME = home;
    delete process.env.NEXUS_SANDBOX_NETWORK;
    return { home };
  }
  function run(workspace: string, command: string) {
    const w = wrapSandboxedCommand(command, workspace, { mode: "docker" });
    assert.equal(w.sandboxed, true, w.warning);
    return spawnSync(w.argv![0], w.argv!.slice(1), { encoding: "utf8", timeout: 120_000, env: buildCommandEnvironment() });
  }
  const probe = (home: string) => `cat ${home}/.ssh/id_test ${home}/.config/nexus/config.env 2>&1; echo "A=$(cat ${home}/proj/a.txt)"; printf w > ${home}/proj/new.txt && echo WROTE`;
  for (const [label, pick] of [["HOME", (h: string) => h], ["the parent of HOME", (h: string) => path.dirname(h)], ["HOME/proj", (h: string) => path.join(h, "proj")]] as const) {
    test(`workspace = ${label}: credential sentinels unreadable, project files readable and writable`, () => {
      const { home } = sentinelHome();
      const r = run(pick(home), probe(home));
      assert.ok(!r.stdout.includes("SENTINEL"), r.stdout + r.stderr);
      if (label !== "HOME/proj") assert.ok(!fs.existsSync(path.join(home, ".ssh", "id_test")) || fs.readFileSync(path.join(home, ".ssh", "id_test"), "utf8") === "SENTINEL-SSH", "host file untouched");
      assert.ok(r.stdout.includes("A=visible"), r.stdout + r.stderr);
      assert.ok(r.stdout.includes("WROTE"), r.stdout + r.stderr);
      fs.rmSync(path.join(home, "proj", "new.txt"), { force: true });
    });
  }
  test("a credential symlink inside the workspace is overlaid at its target", () => {
    const { home } = sentinelHome();
    fs.symlinkSync(path.join(home, ".ssh"), path.join(home, "proj", "sshlink"));
    const r = run(home, `cat ${home}/proj/sshlink/id_test 2>&1; echo done`);
    assert.ok(!r.stdout.includes("SENTINEL"), r.stdout);
  });
  test("overlays are present in the argv as tmpfs for directories and /dev/null for files", () => {
    const { home } = sentinelHome();
    fs.writeFileSync(path.join(home, ".netrc"), "SENTINEL-NETRC");
    const argv = wrapSandboxedCommand("true", home, { mode: "docker" }).argv!;
    assert.ok(argv.some((a, i) => argv[i - 1] === "--tmpfs" && a.startsWith(`${home}/.ssh:`)));
    assert.ok(argv.some((a, i) => argv[i - 1] === "--tmpfs" && a.startsWith(`${home}/.config/nexus:`)));
    assert.ok(argv.some((a, i) => argv[i - 1] === "-v" && a === `/dev/null:${home}/.netrc:ro`));
    assert.equal(run(home, `cat ${home}/.netrc 2>&1; echo done`).stdout.includes("SENTINEL"), false);
  });
});

describe("docker masks the whole state root (PA-3)", { skip: HAVE_DOCKER ? false : "docker CLI is not installed" }, () => {
  test("the argv puts a tmpfs on the state root, creating it 0700 first", () => {
    const home = throwaway();
    assert.equal(fs.existsSync(path.join(home, ".nexus")), false);
    const argv = wrapSandboxedCommand("true", home, { mode: "docker" }).argv!;
    assert.ok(argv.some((a, i) => argv[i - 1] === "--tmpfs" && a.startsWith(`${fs.realpathSync(path.join(home, ".nexus"))}:`)), argv.join(" "));
    assert.equal(fs.statSync(path.join(home, ".nexus")).mode & 0o777, 0o700);
  });

  test("in a real container the root cannot be read, renamed or planted", { skip: spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0 ? false : "docker daemon is not usable" }, () => {
    const home = fs.mkdtempSync(path.join(fs.existsSync("/var/tmp") ? "/var/tmp" : os.tmpdir(), "nexus-s5-state-"));
    cleanup.push(home);
    fs.chmodSync(home, 0o755);
    process.env.HOME = home;
    delete process.env.NEXUS_SANDBOX_NETWORK;
    fs.mkdirSync(path.join(home, ".nexus", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(home, ".nexus", "tasks", "g.json"), "SENTINEL-GOAL-STATE");
    const w = wrapSandboxedCommand(`cat ${home}/.nexus/tasks/g.json 2>&1; mv ${home}/.nexus ${home}/.nexus.old 2>&1; echo forged > ${home}/.nexus/tasks/goal-forged.json 2>&1; echo done`, home, { mode: "docker" });
    assert.equal(w.sandboxed, true, w.warning);
    const r = spawnSync(w.argv![0], w.argv!.slice(1), { encoding: "utf8", timeout: 120_000, env: buildCommandEnvironment() });
    assert.ok(!r.stdout.includes("SENTINEL"), r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(home, ".nexus", "tasks", "g.json"), "utf8"), "SENTINEL-GOAL-STATE");
    assert.equal(fs.existsSync(path.join(home, ".nexus.old")), false);
    assert.equal(fs.existsSync(path.join(home, ".nexus", "tasks", "goal-forged.json")), false);
  });
});


describe("docker pins the state root's ancestors and refuses a symlinked root (PA-3)", { skip: HAVE_DOCKER && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0 ? false : "docker daemon is not usable" }, () => {
  const scratch = () => {
    const parent = fs.mkdtempSync(path.join(fs.existsSync("/var/tmp") ? "/var/tmp" : os.tmpdir(), "nexus-s5-anc-"));
    fs.chmodSync(parent, 0o755);
    cleanup.push(parent);
    delete process.env.NEXUS_SANDBOX_NETWORK;
    return parent;
  };
  const dockerRun = (command: string, workspace: string) => {
    const w = wrapSandboxedCommand(command, workspace, { mode: "docker" });
    assert.equal(w.sandboxed, true, w.warning);
    return spawnSync(w.argv![0], w.argv!.slice(1), { encoding: "utf8", timeout: 120_000, env: buildCommandEnvironment() });
  };
  const withState = <T>(dir: string | undefined, run: () => T): T => {
    const saved = process.env.NEXUS_STATE_DIR;
    if (dir === undefined) delete process.env.NEXUS_STATE_DIR; else process.env.NEXUS_STATE_DIR = dir;
    try { return run(); } finally { if (saved === undefined) delete process.env.NEXUS_STATE_DIR; else process.env.NEXUS_STATE_DIR = saved; }
  };
  const forge = (root: string) => `mkdir -p ${root}/tasks 2>&1; echo FORGED > ${root}/tasks/goal-forged.json 2>&1`;

  test("workspace = parent of HOME: HOME cannot be renamed, nothing is forged", () => {
    const parent = scratch();
    const home = path.join(parent, "home");
    fs.mkdirSync(path.join(home, ".nexus", "tasks"), { recursive: true });
    process.env.HOME = home;
    const r = dockerRun(`mv ${home} ${home}-x 2>&1; ${forge(path.join(home, ".nexus"))}; echo done`, parent);
    assert.match(r.stdout, /busy|cannot move|denied/i, r.stdout + r.stderr);
    assert.equal(fs.existsSync(`${home}-x`), false);
    assert.equal(fs.existsSync(path.join(home, ".nexus", "tasks", "goal-forged.json")), false);
  });

  test("workspace = HOME, root = $HOME/a/b/st: every ancestor is un-renamable", () => {
    const parent = scratch();
    const home = path.join(parent, "home");
    const root = path.join(home, "a", "b", "st");
    fs.mkdirSync(path.join(root, "tasks"), { recursive: true });
    process.env.HOME = home;
    withState(root, () => {
      const r = dockerRun(`mv ${home}/a/b ${home}/a/b.old 2>&1; mv ${home}/a ${home}/a.old 2>&1; mv ${root} ${root}.old 2>&1; ${forge(root)}; touch ${home}/plain && echo WORKS`, home);
      assert.equal((r.stdout.match(/busy/gi) ?? []).length, 3, r.stdout + r.stderr);
      assert.match(r.stdout, /WORKS/);
      for (const moved of ["a.old", "a/b.old", "a/b/st.old"]) assert.equal(fs.existsSync(path.join(home, moved)), false, moved);
      assert.equal(fs.existsSync(path.join(root, "tasks", "goal-forged.json")), false);
    });
  });

  test("a symlinked state directory inside the workspace is refused", () => {
    const parent = scratch();
    const home = path.join(parent, "home");
    fs.mkdirSync(path.join(home, "real"), { recursive: true });
    fs.symlinkSync(path.join(home, "real"), path.join(home, "lnk"));
    process.env.HOME = home;
    withState(path.join(home, "lnk"), () => {
      const w = wrapSandboxedCommand("true", home, { mode: "docker" });
      assert.equal(w.sandboxed, false);
      assert.match(w.warning ?? "", /through a symlink inside the workspace/);
    });
  });
});

describe("docker with a workspace inside the state root (PA-3)", { skip: HAVE_DOCKER && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0 ? false : "docker daemon is not usable" }, () => {
  const scratch = () => {
    const dir = fs.mkdtempSync(path.join(fs.existsSync("/var/tmp") ? "/var/tmp" : os.tmpdir(), "nexus-s5-in-"));
    fs.chmodSync(dir, 0o755);
    cleanup.push(dir);
    delete process.env.NEXUS_SANDBOX_NETWORK;
    process.env.HOME = dir;
    return dir;
  };
  const withState = <T>(dir: string, run: () => T): T => {
    const saved = process.env.NEXUS_STATE_DIR;
    process.env.NEXUS_STATE_DIR = dir;
    try { return run(); } finally { if (saved === undefined) delete process.env.NEXUS_STATE_DIR; else process.env.NEXUS_STATE_DIR = saved; }
  };

  test("a workspace that is the state root, or inside its tasks/, is refused", () => {
    const dir = scratch();
    const root = path.join(dir, "st");
    fs.mkdirSync(path.join(root, "tasks"), { recursive: true });
    withState(root, () => {
      for (const workspace of [root, path.join(root, "tasks")]) {
        const w = wrapSandboxedCommand("true", workspace, { mode: "docker" });
        assert.equal(w.sandboxed, false, workspace);
        assert.match(w.warning ?? "", /Start Nexus outside the state directory/);
      }
    });
  });

  test("a workspace below the root: tasks/ is unreadable, unwritable and cannot be renamed; the workspace works", () => {
    const dir = scratch();
    const root = path.join(dir, "st");
    const workspace = path.join(root, "worktrees", "j");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.join(root, "tasks"));
    fs.writeFileSync(path.join(root, "tasks", "g.json"), "SENTINEL-GOAL-STATE");
    withState(root, () => {
      const w = wrapSandboxedCommand(`cat ${root}/tasks/g.json 2>&1; echo pwned > ${root}/tasks/g.json 2>&1; mv ${root}/tasks ${root}/tasks.old 2>&1; echo built > out.txt && cat out.txt`, workspace, { mode: "docker" });
      assert.equal(w.sandboxed, true, w.warning);
      const r = spawnSync(w.argv![0], w.argv!.slice(1), { encoding: "utf8", timeout: 120_000, env: buildCommandEnvironment() });
      assert.doesNotMatch(r.stdout, /SENTINEL/, r.stdout + r.stderr);
      assert.match(r.stdout, /built/);
      assert.equal(fs.readFileSync(path.join(root, "tasks", "g.json"), "utf8"), "SENTINEL-GOAL-STATE");
      assert.equal(fs.existsSync(path.join(root, "tasks.old")), false);
    });
  });
});
