/**
 * VR-1 slice 3: `nexus verify --sandbox`. Three layers, so the rules hold on a host without an engine too:
 *  1. the command line that is built (stand-in engines on PATH; nothing is confined, the arguments are read back);
 *  2. the refusal when the requested engine is not usable (stand-ins that refuse, on any host);
 *  3. the real box, with Bubblewrap and with Docker, each skipped with its reason where the engine cannot run.
 * Core: src/core/verify.ts (sandboxedVerifierCommand, usableSandboxEngine); the wrapper itself is src/sandbox.ts.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DOCKER_SANDBOX_IMAGE, isSandboxAvailable } from "../src/sandbox.js";
import { runVerifierShell } from "../src/tester.js";
import { renderVerifyText, sandboxedVerifierCommand, type VerifySandboxBox } from "../src/core/verify.js";
import { BASE_FILES, GOOD, MATH_FIXED, commit, consume, consumeResult, fakeEngines, head, runCli, verifyInProcess, withRepos, writeFiles } from "./helpers/verify_fixture.js";

/** Runs `check` with PATH replaced, and puts it back. */
function withPath<T>(PATH: string, check: () => T): T {
  const saved = process.env.PATH;
  process.env.PATH = PATH;
  try { return check(); } finally { process.env.PATH = saved; }
}

/** Each occurrence of `flag` in `argv` with the `count` arguments that follow it. */
function flagged(argv: readonly string[], flag: string, count: number): string[][] {
  const found: string[][] = [];
  argv.forEach((arg, index) => { if (arg === flag) found.push(argv.slice(index + 1, index + 1 + count)); });
  return found;
}

/** Names in a path that a shell would act on if one were ever left unquoted. */
const HOSTILE_NAME = "dep dir; $(touch INJECTED) `touch INJECTED` 'q' \"d\"\nline";

// ---- 1. The command line ----

test("bwrap composition: only the run's own tree is writable, the scratch directory is covered, dependency directories are bound read-only, the environment is the verifier's, and the network is off unless asked", () => {
  const engines = fakeEngines({ bwrap: "records" });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-box-"));
  try {
    const scratch = path.join(root, "scratch");
    const directory = path.join(scratch, "head");
    const dependency = path.join(root, "checkout", HOSTILE_NAME, "node_modules");
    fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(dependency, { recursive: true });
    const box: VerifySandboxBox = { engine: "bwrap", network: false, scratch, readOnlyDirs: [dependency] };
    const environment = { PATH: "/usr/bin:/bin", HOME: "/home/someone", LANG: "C" };
    const command = "npm test && echo 'a b' \"$HOME\"";
    const built = withPath(engines.PATH, () => sandboxedVerifierCommand(command, directory, box, { environment }));
    assert.ok("argv" in built, JSON.stringify(built));
    const argv = built.argv;
    assert.equal(argv[0], "bwrap");
    assert.deepEqual(argv.slice(-3), ["bash", "-c", command], "the command is one argument of the shell inside the box");

    // The wrapper's profile: a read-only host, a private /tmp, no host processes.
    assert.deepEqual(argv.slice(1, 4), ["--ro-bind", "/", "/"]);
    assert.ok(argv.includes("--unshare-pid") && argv.includes("--die-with-parent"));
    assert.ok(flagged(argv, "--tmpfs", 1).some(([target]) => target === "/tmp"));

    // Writable: the run's own tree and nothing else. The scratch directory is covered AFTER the wrapper's bind and the tree bound back.
    const binds = flagged(argv, "--bind", 2);
    assert.deepEqual([...new Set(binds.map((bind) => bind.join(" -> ")))], [`${directory} -> ${directory}`], "the only writable bind is the run's own tree");
    const cover = argv.findIndex((arg, index) => arg === "--tmpfs" && argv[index + 1] === scratch);
    assert.ok(cover > argv.indexOf("--bind"), "the scratch directory is covered after the wrapper bound the tree");
    assert.deepEqual(argv.slice(cover + 2, cover + 5), ["--bind", directory, directory], "and only the run's own tree is bound back into it");

    // Read-only: every dependency directory, at its own path, after the cover.
    const readOnly = flagged(argv, "--ro-bind", 2);
    assert.ok(readOnly.some(([from, to]) => from === dependency && to === dependency), "the dependency directory is bound read-only");
    assert.ok(argv.lastIndexOf(dependency) > cover);
    assert.equal(binds.some(([from]) => from === dependency), false);

    // The environment: cleared last by us, then exactly the verifier's variables and a TMPDIR that exists in the box.
    const cleared = argv.lastIndexOf("--clearenv");
    assert.ok(cleared > cover);
    assert.deepEqual(flagged(argv.slice(cleared), "--setenv", 2), [["PATH", "/usr/bin:/bin"], ["HOME", "/home/someone"], ["LANG", "C"], ["TMPDIR", "/tmp"]]);

    // The network: off by default, on only when the box says so.
    assert.ok(argv.includes("--unshare-net"));
    const open = withPath(engines.PATH, () => sandboxedVerifierCommand(command, directory, { ...box, network: true }, { environment }));
    assert.ok("argv" in open && !open.argv.includes("--unshare-net"));

    // The shell line is those arguments, each quoted: run through a real shell, the stand-in engine receives them unchanged
    // and nothing named in a path is executed.
    const ran = spawnSync("bash", ["-c", built.command], { cwd: root, env: { ...process.env, PATH: engines.PATH }, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(engines.argvOf("bwrap"), argv.slice(1));
    assert.equal(fs.existsSync(path.join(root, "INJECTED")), false, "a path was interpreted by the shell");
  } finally {
    for (const dir of [root, engines.dir]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bwrap composition: the caller's checkout and Git common dir are covered before dependencies are bound back, even outside HOME and /tmp", () => {
  const engines = fakeEngines({ bwrap: "records" });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-box-"));
  try {
    const scratch = path.join(root, "scratch");
    const directory = path.join(scratch, "head");
    const checkout = path.join(root, "builds", "checkout"); // deliberately outside HOME and /tmp
    const commonDir = path.join(checkout, ".git");
    const dependency = path.join(checkout, "node_modules");
    fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(dependency, { recursive: true });
    const box: VerifySandboxBox = { engine: "bwrap", network: false, scratch, readOnlyDirs: [dependency], maskDirs: [checkout, commonDir] };
    const built = withPath(engines.PATH, () => sandboxedVerifierCommand("npm test", directory, box, { environment: { PATH: "/usr/bin:/bin" } }));
    assert.ok("argv" in built, JSON.stringify(built));
    const argv = built.argv;
    const checkoutCover = argv.findIndex((arg, index) => arg === "--tmpfs" && argv[index + 1] === checkout);
    const commonCover = argv.findIndex((arg, index) => arg === "--tmpfs" && argv[index + 1] === commonDir);
    const last = (flag: string, target: string) => argv.map((arg, index) => arg === flag && argv[index + 1] === target).lastIndexOf(true);
    const directoryBind = last("--bind", directory);
    const dependencyBind = last("--ro-bind", dependency);
    assert.ok(checkoutCover >= 0 && commonCover >= 0, "both caller-owned directories are covered");
    assert.ok(checkoutCover < commonCover && commonCover < directoryBind && commonCover < dependencyBind, "covering comes before binding anything back");
    assert.deepEqual(flagged(argv, "--tmpfs", 1).map(([target]) => target).filter((target) => target === checkout || target === commonDir), [checkout, commonDir]);
  } finally {
    for (const dir of [root, engines.dir]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("docker composition: the wrapper's hardened profile with only the run's own tree mounted, dependency directories mounted read-only, the verifier's environment in place of the wrapper's, and a name to remove the container by", () => {
  const engines = fakeEngines({ docker: "records" });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-box-"));
  try {
    const scratch = path.join(root, "scratch");
    const directory = path.join(scratch, "base");
    const dependency = path.join(root, "checkout", "dep dir; $(touch INJECTED) 'q'", "vendor");
    fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(dependency, { recursive: true });
    const box: VerifySandboxBox = { engine: "docker", network: false, scratch, readOnlyDirs: [dependency] };
    const environment = { PATH: "/host/bin", HOME: "/home/someone", LANG: "C" };
    const built = withPath(engines.PATH, () => sandboxedVerifierCommand("make test", directory, box, { environment, containerName: "nexus-verify-test" }));
    assert.ok("argv" in built, JSON.stringify(built));
    const argv = built.argv;
    assert.deepEqual(argv.slice(0, 2), ["docker", "run"]);
    assert.deepEqual(argv.slice(-6, -4), ["-w", directory]);
    assert.deepEqual(argv.slice(-3), ["sh", "-c", "make test"]);
    for (const hardening of [["--cap-drop", "ALL"], ["--security-opt", "no-new-privileges"], ["--network", "none"]]) {
      assert.ok(flagged(argv, hardening[0], 1).some(([value]) => value === hardening[1]), hardening.join(" "));
    }
    assert.ok(argv.includes("--read-only") && argv.includes("--rm"));
    assert.deepEqual(flagged(argv, "--name", 1), [["nexus-verify-test"]]);
    // Mounted from the host: the run's own tree, writable, and each dependency directory, read-only. Nothing else, so the
    // other scratch trees do not exist in the container.
    assert.deepEqual(flagged(argv, "-v", 1).map(([mount]) => mount), [`${directory}:${directory}`, `${dependency}:${dependency}:ro`]);
    // The environment: only the verifier's names, with the container's HOME, PATH and TMPDIR.
    const env = Object.fromEntries(flagged(argv, "--env", 1).map(([pair]) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
    assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH", "TMPDIR"]);
    assert.equal(env.HOME, "/tmp");
    assert.equal(env.TMPDIR, "/tmp");
    assert.doesNotMatch(env.PATH, /host/);

    const open = withPath(engines.PATH, () => sandboxedVerifierCommand("make test", directory, { ...box, network: true }, { environment }));
    assert.ok("argv" in open && !open.argv.includes("--network"));

    const ran = spawnSync("bash", ["-c", built.command], { cwd: root, env: { ...process.env, PATH: engines.PATH }, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(engines.argvOf("docker"), argv.slice(1));
    assert.equal(fs.existsSync(path.join(root, "INJECTED")), false, "a path was interpreted by the shell");

    // A path Docker would read as a different mount is refused, never mounted as something else.
    const colon = withPath(engines.PATH, () => sandboxedVerifierCommand("make test", directory, { ...box, readOnlyDirs: [path.join(root, "a:b")] }, { environment }));
    assert.ok("unavailable" in colon && /colon/.test(colon.unavailable));
  } finally {
    for (const dir of [root, engines.dir]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("composition without the engine: no command line is returned, so there is nothing to run outside a sandbox", () => {
  const engines = fakeEngines({ bwrap: "refuses", docker: "refuses" });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-box-"));
  try {
    for (const engine of ["bwrap", "docker"] as const) {
      const built = withPath(engines.PATH, () => sandboxedVerifierCommand("npm test", directory, { engine, network: false, scratch: directory, readOnlyDirs: [] }, { environment: {} }));
      assert.ok("unavailable" in built && built.unavailable.length > 0, `${engine}: ${JSON.stringify(built)}`);
      assert.equal("command" in built, false);
    }
  } finally {
    for (const dir of [directory, engines.dir]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 2. The refusal ----

test("--sandbox with an engine that is not usable is BLOCKED (SANDBOX_UNAVAILABLE, exit 3): nothing is run, with or without the sandbox", { timeout: 120_000 }, async () => {
  await withRepos([BASE_FILES], async (repo) => {
    const base = head(repo);
    const fixed = commit(repo, GOOD);
    const marker = path.join(repo, "..", `${path.basename(repo)}-ran`);
    const engines = fakeEngines({ bwrap: "refuses", docker: "refuses" });
    try {
      for (const engine of ["bwrap", "docker", "auto"] as const) {
        const run = await verifyInProcess(
          { worktree: repo, base, head: fixed },
          { verifierCommand: `touch '${marker}'; node --test`, deliverables: ["src/math.js"], sandbox: { engine } },
          { env: { PATH: engines.PATH } },
        );
        assert.equal(run.result.verdict, "BLOCKED", `${engine}: ${run.result.detail}`);
        assert.equal(run.result.reason, "SANDBOX_UNAVAILABLE");
        assert.equal(run.result.exitCode, 3);
        assert.deepEqual(run.result.runs, [], "no verifier process was started");
        assert.deepEqual(run.result.sandbox, { requested: true, engine: "none", network: false });
        // VR-3: the refusal is a typed receipt event, not just a string in `detail`.
        assert.equal(run.result.sandboxEvents?.length, 1, `${engine}: ${JSON.stringify(run.result.sandboxEvents)}`);
        const event = run.result.sandboxEvents![0];
        assert.equal(event.kind, "unavailable");
        assert.equal(event.engine, engine);
        assert.equal(event.profile, "default");
        assert.equal(event.operation, "verify");
        assert.equal(event.category, "engine");
        assert.match(event.reason, new RegExp(`--sandbox ${engine} was requested`));
        assert.ok(!("verdict" in event), "a denial event cannot carry a verdict");
        assert.match(run.result.detail ?? "", new RegExp(`--sandbox ${engine} was requested`));
        assert.equal(fs.existsSync(marker), false, "the verifier ran although the sandbox it was to run in is unavailable");
        assert.deepEqual(run.leftovers, []);
        assert.match(renderVerifyText(run.result), /^nexus verify: BLOCKED \(SANDBOX_UNAVAILABLE\)\n/);
        assert.match(renderVerifyText(run.result), /\n  sandbox +requested, and nothing was run\n/);
        assert.match(renderVerifyText(run.result), new RegExp(`\\n  sandbox denial ?unavailable \\(${engine}/default, engine\\) while verify:`));
      }
      // The explicit trusted-input opt-out runs unconfined and says so in its receipt.
      const plain = await verifyInProcess({ worktree: repo, base, head: fixed }, { verifierCommand: `touch '${marker}'; node --test`, deliverables: ["src/math.js"], sandbox: { engine: "none" } }, { env: { PATH: engines.PATH } });
      assert.equal(plain.result.verdict, "REGRESSION_FREE", plain.result.detail); // a compound command cannot be bound, so it never shows more than this
      assert.deepEqual(plain.result.sandbox, { requested: false, engine: "none", network: false });
      assert.equal(plain.result.sandboxEvents, undefined, "no refusal means no denial events");
      assert.deepEqual(plain.result.runs.map((ran) => ran.sandboxed), [false, false]);
      assert.equal(fs.existsSync(marker), true);
      assert.match(renderVerifyText(plain.result), /\n  sandbox +none: repository code ran with your privileges/);
    } finally {
      fs.rmSync(marker, { force: true });
      fs.rmSync(engines.dir, { recursive: true, force: true });
    }
  });
});

test("CLI: sandbox defaults to auto, --sandbox takes auto, bwrap, docker or none, and unavailable confinement blocks", { timeout: 180_000 }, async () => {
  await withRepos([BASE_FILES], async (repo) => {
    const base = head(repo);
    const fixed = commit(repo, GOOD);
    const engines = fakeEngines({ bwrap: "refuses", docker: "refuses" });
    try {
      const common = ["-w", repo, "--base", base, "--head", fixed, "--verifier", "node --test", "--deliverable-file", "src/math.js", "--json"];
      const [unknown, defaultRefused, refused, none, networkNone] = await Promise.all([
        runCli([...common, "--sandbox", "chroot"]),
        runCli(common, { PATH: engines.PATH }),
        runCli([...common, "--sandbox", "bwrap", "--sandbox-network"], { PATH: engines.PATH }),
        runCli([...common, "--sandbox", "none"], { PATH: engines.PATH }),
        runCli([...common, "--sandbox", "none", "--sandbox-network"]),
      ]);
      assert.equal(unknown.code, 2);
      assert.match(consume(unknown).error, /--sandbox takes auto, bwrap, docker or none/);
      const defaultBlocked = consumeResult(defaultRefused);
      assert.equal(defaultRefused.code, 3);
      assert.equal(defaultBlocked.reason, "SANDBOX_UNAVAILABLE", "the default must not run verifier code without a sandbox");
      assert.deepEqual(defaultBlocked.sandbox, { requested: false, engine: "none", network: false }, "the result distinguishes implicit default confinement from an explicit flag");
      assert.match(defaultBlocked.detail, /default --sandbox auto was requested/);
      assert.equal(defaultBlocked.sandboxEvents?.length, 1);
      assert.equal(defaultBlocked.sandboxEvents![0].engine, "auto");
      assert.match(defaultBlocked.sandboxEvents![0].reason, /default --sandbox auto was requested/);
      assert.deepEqual(defaultBlocked.runs, []);
      const blocked = consumeResult(refused);
      assert.equal(refused.code, 3);
      assert.equal(blocked.reason, "SANDBOX_UNAVAILABLE");
      assert.deepEqual(blocked.runs, []);
      const plain = consumeResult(none);
      assert.equal(plain.verdict, "VERIFIED", plain.detail);
      assert.deepEqual(plain.sandbox, { requested: false, engine: "none", network: false });
      assert.equal(networkNone.code, 2);
      assert.match(consume(networkNone).error, /--sandbox-network cannot be used with --sandbox none/);
    } finally {
      fs.rmSync(engines.dir, { recursive: true, force: true });
    }
  });
});

// ---- 3. The real box ----

/** What a hostile test does once it runs: tries every write the box must refuse, and says what happened. */
const attackScript = (targets: Record<string, string>) => Object.entries(targets)
  .map(([label, file]) => `if (echo pwned > '${file}') 2>/dev/null; then echo "WROTE ${label}"; else echo "DENIED ${label}"; fi`)
  .join("\n");

const BWRAP_SKIP = isSandboxAvailable("bwrap") ? false : "Bubblewrap cannot confine a command on this host (bwrap is missing, or user namespaces are not permitted)";

describe("the real Bubblewrap box", { skip: BWRAP_SKIP }, () => {
  test("a confined process can write its own tree and /tmp, and cannot write or see the other scratch trees, cannot write the caller's checkout, its dependency directory or HOME, and has no network", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-box-home-"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-box-"));
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const scratch = path.join(root, "scratch");
      const own = path.join(scratch, "head");
      const checkout = path.join(root, "checkout");
      const dependency = path.join(checkout, "node_modules");
      for (const dir of [own, path.join(scratch, "base"), path.join(scratch, "head-pristine"), path.join(scratch, "objects"), path.join(dependency, "dep")]) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dependency, "dep", "index.js"), "module.exports = 1;\n");
      fs.writeFileSync(path.join(scratch, "base", "secret.txt"), "base tree\n");
      fs.writeFileSync(path.join(checkout, "file.txt"), "caller\n");
      fs.writeFileSync(path.join(home, "rc"), "home\n");
      fs.symlinkSync(dependency, path.join(own, "node_modules"), "dir");
      // Under /tmp, as a scratch directory and a test checkout are, the box has an empty file system of its own: a write
      // there succeeds inside the box and never reaches the host, so what counts for those paths is the host afterwards.
      const script = [
        `[ -e '${path.join(scratch, "base", "secret.txt")}' ] && echo "SEES other tree" || echo "BLIND other tree"`,
        `[ -e '${path.join(checkout, "file.txt")}' ] && echo "SEES caller checkout" || echo "BLIND caller checkout"`,
        `[ -e '${path.join(home, "rc")}' ] && echo "SEES home file" || echo "BLIND home file"`,
        attackScript({
          "own tree": path.join(own, "written.txt"),
          "private tmp": "/tmp/written.txt",
          "other tree": path.join(scratch, "base", "written.txt"),
          "pristine copy": path.join(scratch, "head-pristine", "written.txt"),
          "scratch objects": path.join(scratch, "objects", "written.txt"),
          "caller checkout": path.join(checkout, "written.txt"),
          "dependency through the link": "node_modules/dep/index.js",
          "dependency directly": path.join(dependency, "dep", "written.txt"),
          "home": path.join(home, "rc"),
        }),
        `cat node_modules/dep/index.js`,
        `tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ' | tr '\\n' ' '; echo "<- interfaces"`,
      ].join("\n");
      const built = sandboxedVerifierCommand(script, own, { engine: "bwrap", network: false, scratch, readOnlyDirs: [dependency], maskDirs: [checkout] });
      assert.ok("command" in built, JSON.stringify(built));
      const ran = runVerifierShell(built.command, own, 60_000);
      assert.equal(ran.exitCode, 0, ran.output);
      const said = (line: string) => assert.ok(ran.output.split("\n").includes(line), `expected "${line}" in:\n${ran.output}`);
      said("WROTE own tree");
      said("WROTE private tmp");
      for (const denied of ["other tree", "pristine copy", "scratch objects", "dependency through the link", "dependency directly"]) said(`DENIED ${denied}`);
      said("module.exports = 1;");
      said("BLIND other tree");
      said("BLIND caller checkout");
      said("BLIND home file");
      said("lo <- interfaces");
      // On the host: only the run's own tree changed. (The masked HOME took the write to a file of its own, which is gone.)
      assert.equal(fs.readFileSync(path.join(own, "written.txt"), "utf8"), "pwned\n");
      assert.equal(fs.readFileSync(path.join(dependency, "dep", "index.js"), "utf8"), "module.exports = 1;\n");
      assert.equal(fs.readFileSync(path.join(home, "rc"), "utf8"), "home\n");
      assert.deepEqual(fs.readdirSync(path.join(scratch, "base")), ["secret.txt"]);
      assert.deepEqual(fs.readdirSync(path.join(scratch, "head-pristine")), []);
      assert.deepEqual(fs.readdirSync(path.join(scratch, "objects")), []);
      assert.deepEqual(fs.readdirSync(checkout).sort(), ["file.txt", "node_modules"]);
      assert.deepEqual(fs.readdirSync(path.join(dependency, "dep")), ["index.js"]);
      assert.equal(fs.existsSync("/tmp/written.txt") && fs.readFileSync("/tmp/written.txt", "utf8") === "pwned\n", false, "the box's /tmp is the host's");
    } finally {
      process.env.HOME = savedHome;
      for (const dir of [root, home]) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("verify --sandbox bwrap: a real fix is VERIFIED with every run recorded as sandboxed, and the verdict rules are the ones without a sandbox", { timeout: 180_000 }, async () => {
    await withRepos([BASE_FILES], async (repo) => {
      const base = head(repo);
      const fixed = commit(repo, GOOD);
      const good = await verifyInProcess({ worktree: repo, base, head: fixed }, { approveDiscoveredVerifier: true, deliverables: ["src/math.js"], sandbox: { engine: "bwrap" } });
      assert.equal(good.result.verdict, "VERIFIED", `${good.result.detail}\n${JSON.stringify(good.result.runs)}`);
      assert.deepEqual(good.result.sandbox, { requested: true, engine: "bwrap", network: false });
      assert.deepEqual(good.result.runs.map((ran) => [ran.phase, ran.sandboxed, ran.passed]), [["base", true, false], ["head", true, true]]);
      assert.deepEqual(good.leftovers, []);
      assert.match(renderVerifyText(good.result), /\n  sandbox +bwrap: every run confined to its own scratch tree, no network\n/);
      // The rules are the ones without a sandbox: the same request, confined and not, gets the same verdict and reason.
      const auto = await verifyInProcess({ worktree: repo, base, head: fixed }, { approveDiscoveredVerifier: true, sandbox: { engine: "auto", network: true } });
      const plain = await verifyInProcess({ worktree: repo, base, head: fixed }, { approveDiscoveredVerifier: true, sandbox: { engine: "none" } });
      assert.notEqual(auto.result.verdict, "VERIFIED", "no declared deliverable");
      assert.deepEqual([auto.result.verdict, auto.result.outcome, auto.result.reason], [plain.result.verdict, plain.result.outcome, plain.result.reason]);
      assert.deepEqual(auto.result.sandbox, { requested: true, engine: "bwrap", network: true });
    });
  });

test("verify --sandbox bwrap: a hostile test cannot write the caller's checkout or its linked dependency directory; explicit --sandbox none can", { timeout: 180_000 }, async () => {
    const files = {
      ...BASE_FILES,
      ".gitignore": "node_modules/\n",
      "test/dep.test.mjs": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { createRequire } from "node:module";\ntest("the dependency is readable", () => assert.equal(createRequire(import.meta.url)("dep"), 1));\n',
    };
    for (const sandboxed of [true, false]) {
      await withRepos([files], async (repo) => {
        writeFiles(repo, { "node_modules/dep/index.js": "module.exports = 1;\n", "node_modules/dep/package.json": '{"name":"dep","version":"1.0.0","main":"index.js"}\n' });
        const base = head(repo);
        const outside = path.join(repo, "PWNED");
        // Read the outside path from a sibling data file (CodeQL js/bad-code-sanitization): do not splice JSON into code.
        const attackBody = [
          'import test from "node:test";',
          'import fs from "node:fs";',
          'import path from "node:path";',
          'import { fileURLToPath } from "node:url";',
          'const outside = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "outside-path.txt"), "utf8");',
          'test("attack", () => { for (const file of ["node_modules/dep/PWNED", outside]) { try { fs.writeFileSync(file, "pwned"); } catch {} } });',
          "",
        ].join("\n");
        const hostile = commit(repo, {
          "src/math.js": MATH_FIXED,
          "test/attack.test.mjs": attackBody,
          "test/outside-path.txt": outside,
        });
        const run = await verifyInProcess({ worktree: repo, base, head: hostile }, { verifierCommand: "node --test", deliverables: ["src/math.js"], sandbox: { engine: sandboxed ? "bwrap" : "none" } });
        assert.deepEqual(run.result.linkedDependencyDirs, ["node_modules"]);
        assert.equal(run.result.runs.find((ran) => ran.phase === "head")?.passed, true, JSON.stringify(run.result.runs));
        assert.notEqual(run.result.verdict, "VERIFIED");
        assert.equal(fs.existsSync(path.join(repo, "node_modules", "dep", "PWNED")), !sandboxed, sandboxed ? "the sandboxed test wrote the caller's dependency directory" : "documented limit: without --sandbox the linked dependency directory is the caller's and is writable");
        assert.equal(fs.existsSync(outside), !sandboxed, sandboxed ? "the sandboxed test wrote the caller's checkout" : "documented limit: without --sandbox the test runs with the caller's privileges");
      });
    }
  });
});

function dockerSkip(): string | false {
  if (spawnSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 }).status !== 0) return "the Docker daemon is not usable";
  // Never pulled by a test: the pinned image must already be here.
  if (spawnSync("docker", ["image", "inspect", DOCKER_SANDBOX_IMAGE.replace(/:[^@:]+@/, "@")], { stdio: "ignore", timeout: 20_000 }).status !== 0) {
    return "the pinned sandbox image is not present locally (a test never pulls it)";
  }
  return process.env.NEXUS_SANDBOX_DOCKER_IMAGE ? "NEXUS_SANDBOX_DOCKER_IMAGE is set; this test runs the pinned default image only" : false;
}

// One container only: starting one can take many seconds. That `verify` records the engine and wraps every run is the
// same code for both engines and is covered by the Bubblewrap tests above.
describe("the real Docker box", { skip: dockerSkip() }, () => {
  test("a confined process can write its own tree, sees no other scratch tree, cannot write a dependency directory and has no network", { timeout: 180_000 }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-box-"));
    try {
      const scratch = path.join(root, "scratch");
      const own = path.join(scratch, "head");
      const dependency = path.join(root, "checkout", "vendor");
      for (const dir of [own, path.join(scratch, "base"), dependency]) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dependency, "lib.txt"), "lib\n");
      const script = [
        attackScript({ "own tree": path.join(own, "written.txt"), "dependency": path.join(dependency, "written.txt"), "root": "/written.txt" }),
        `cat '${path.join(dependency, "lib.txt")}'`,
        `[ -e '${path.join(scratch, "base")}' ] && echo "SEES other tree" || echo "BLIND other tree"`,
        `tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ' | tr '\\n' ' '; echo "<- interfaces"`,
      ].join("\n");
      const built = sandboxedVerifierCommand(script, own, { engine: "docker", network: false, scratch, readOnlyDirs: [dependency] });
      assert.ok("command" in built, JSON.stringify(built));
      const ran = runVerifierShell(built.command, own, 120_000);
      assert.equal(ran.exitCode, 0, ran.output);
      const lines = ran.output.split("\n");
      for (const line of ["WROTE own tree", "DENIED dependency", "DENIED root", "lib", "BLIND other tree", "lo <- interfaces"]) assert.ok(lines.includes(line), `expected "${line}" in:\n${ran.output}`);
      assert.deepEqual(fs.readdirSync(dependency), ["lib.txt"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test("NEXUS_SANDBOX_NETWORK never opens the network of a verifier whose box says it is off (#778 follow-up)", () => {
  const engines = fakeEngines({ bwrap: "records" });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-box-env-"));
  const saved = process.env.NEXUS_SANDBOX_NETWORK;
  process.env.NEXUS_SANDBOX_NETWORK = "1";
  try {
    const directory = path.join(root, "scratch", "head");
    fs.mkdirSync(directory, { recursive: true });
    const box: VerifySandboxBox = { engine: "bwrap", network: false, scratch: path.join(root, "scratch"), readOnlyDirs: [] };
    const built = withPath(engines.PATH, () => sandboxedVerifierCommand("npm test", directory, box, { environment: { PATH: "/usr/bin:/bin" } }));
    assert.ok("argv" in built && built.argv.includes("--unshare-net"), "the operator environment setting does not reach nexus verify");
  } finally {
    if (saved === undefined) delete process.env.NEXUS_SANDBOX_NETWORK; else process.env.NEXUS_SANDBOX_NETWORK = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
