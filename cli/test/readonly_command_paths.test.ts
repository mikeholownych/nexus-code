/**
 * Read-only command confinement (REQ-SEC-104): path arguments must resolve inside the workspace.
 * A lexical check alone lets an in-workspace symlink read host files, which the read-only sandbox
 * exposes read-only.
 */
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { isSafeReadOnlyCommand } from "../src/core/authority.js";
import { isBwrapAvailable, wrapSandboxedCommand } from "../src/sandbox.js";

function openWorkspaceFd(workspace: string): number {
  return fs.openSync(workspace, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
}

function runPinnedSandbox(wrapped: ReturnType<typeof wrapSandboxedCommand>, workspaceFd: number) {
  assert.ok(wrapped.argv);
  return spawnSync(wrapped.argv[0], wrapped.argv.slice(1), {
    cwd: "/",
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe", workspaceFd],
  });
}

describe("read-only command path confinement", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ro-paths-"));
  const ws = path.join(root, "ws");
  const sibling = path.join(root, "ws-evil");

  fs.mkdirSync(ws);
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(ws, "inside.txt"), "workspace content\n");
  fs.writeFileSync(path.join(root, "secret.txt"), "OUTSIDE SECRET\n");
  fs.writeFileSync(path.join(sibling, "secret.txt"), "SIBLING SECRET\n");
  fs.mkdirSync(path.join(root, "outside-dir"));
  fs.writeFileSync(path.join(root, "outside-dir", "secret.txt"), "OUTSIDE DIR SECRET\n");
  fs.symlinkSync(path.join(root, "secret.txt"), path.join(ws, "link"));
  fs.symlinkSync("../secret.txt", path.join(ws, "rel-link"));
  fs.symlinkSync(path.join(root, "secret.txt"), path.join(ws, "a b"));
  fs.symlinkSync(path.join(root, "secret.txt"), path.join(ws, "--link"));
  fs.symlinkSync(path.join(ws, "inside.txt"), path.join(ws, "alias"));
  fs.symlinkSync(path.join(root, "outside-dir"), path.join(ws, "outdir"));
  fs.mkdirSync(path.join(ws, "A"));
  fs.mkdirSync(path.join(ws, "B"));
  fs.writeFileSync(path.join(ws, "B", "plink"), "other\n");
  fs.symlinkSync(path.join(root, "secret.txt"), path.join(ws, "A", "plink"));
  // A repository may legitimately have a directory symlink with this name; a pattern that merely
  // mentions it must not be mistaken for a path argument.
  fs.symlinkSync(path.join(root, "outside-dir"), path.join(ws, "node_modules"));

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const command of [
    "cat link",
    "cat ./link",
    "cat rel-link",
    "grep SECRET link",
    "head -1 link",
    "cat outdir/secret.txt",
    `cat ${path.join(root, "secret.txt")}`,
    `cat ${path.join(sibling, "secret.txt")}`,
  ]) {
    test(`denies an escaping argument: ${command}`, () => {
      assert.equal(isSafeReadOnlyCommand(command, undefined, ws), false, command);
    });
  }

  for (const command of [
    "cat inside.txt",
    "cat alias",
    "cat ./inside.txt",
    `cat ${path.join(ws, "inside.txt")}`,
    "grep needle inside.txt",
    "head -1 inside.txt",
    "find . -name '*.txt'",
    "ls -la",
  ]) {
    test(`allows an in-workspace argument: ${command}`, () => {
      assert.equal(isSafeReadOnlyCommand(command, undefined, ws), true, command);
    });
  }

  test("an option value that names an escaping path is denied", () => {
    assert.equal(isSafeReadOnlyCommand("cat --file=link", undefined, ws), false);
  });

  test("an unquoted glob cannot select an escaping symlink after the check", () => {
    assert.equal(isSafeReadOnlyCommand("cat *", undefined, ws), false);
    assert.equal(isSafeReadOnlyCommand("head *", undefined, ws), false);
    assert.equal(isSafeReadOnlyCommand("grep SECRET *", undefined, ws), false);
    assert.equal(isSafeReadOnlyCommand("cat li*", undefined, ws), false);
    assert.equal(isSafeReadOnlyCommand("cat '*.txt'", undefined, ws), true);
    assert.equal(isSafeReadOnlyCommand("ls *.txt", undefined, ws), true);
  });

  test("quoting and concatenation cannot hide an escaping path from the shell words", () => {
    assert.equal(isSafeReadOnlyCommand("cat 'a b'", undefined, ws), false);
    assert.equal(isSafeReadOnlyCommand('cat l"ink"', undefined, ws), false);
    assert.equal(isSafeReadOnlyCommand("cat li'nk'", undefined, ws), false);
    assert.equal(isSafeReadOnlyCommand(`cat "inside.txt"`, undefined, ws), true);
  });

  test("recursive symlink-following and pattern-file options are refused", () => {
    for (const command of [
      "grep -R SECRET .",
      "grep --dereference-recursive SECRET .",
      "grep -Rn SECRET .",
      "rg --follow SECRET .",
      "rg -L SECRET .",
      "find . -follow",
      "find -L .",
      "find . -files0-from outside.list",
      "diff -r . outdir",
      "diff --recursive . outdir",
      "diff --recursive=unified . outdir",
      "diff --from-file=link inside.txt",
      "diff --to-file=link inside.txt",
      "diff --exclude-from=link x",
      "rustc -v link",
      "node -v link",
      "grep -f/etc/shadow x",
      "grep -flink x",
      "grep -f link x",
      "grep --exclude-from=/etc/shadow x",
      "grep - link",
      "rg - link",
      "grep -i - link",
      "wc --files0-from outside.list",
    ]) {
      assert.equal(isSafeReadOnlyCommand(command, undefined, ws), false, command);
    }
  });

  test("a pattern that names an escaping directory symlink is not treated as a path", () => {
    assert.equal(isSafeReadOnlyCommand("grep node_modules inside.txt", undefined, ws), true);
    assert.equal(isSafeReadOnlyCommand("rg node_modules inside.txt", undefined, ws), true);
    assert.equal(isSafeReadOnlyCommand("grep -e 'foo bar' inside.txt", undefined, ws), true);
  });

  test("non-reading commands and option values keep working", () => {
    for (const command of [
      "git log --since=2024/01/01",
      "rg --glob='src/*.ts' TODO",
      "grep --exclude=node_modules -r x .",
      "echo node_modules",
      "which link",
      "ls node_modules",
      "node -v",
    ]) {
      assert.equal(isSafeReadOnlyCommand(command, undefined, ws), true, command);
    }
    assert.equal(isSafeReadOnlyCommand("rustc -v", undefined, ws), false, "the host Rust toolchain is not exposed inside the read-only sandbox");
  });

  test("an unresolvable workspace fails closed", () => {
    assert.equal(isSafeReadOnlyCommand("cat link", undefined, "/nonexistent/nexus-workspace"), false);
  });

  test("read-only bwrap cannot follow an in-workspace symlink swapped after admission", { skip: !isBwrapAvailable() }, () => {
    const outsideRoot = fs.mkdtempSync(path.join("/var/tmp", "nexus-ro-outside-"));
    const outside = path.join(outsideRoot, "outside-canary.txt");
    const link = path.join(ws, "race-link");
    fs.writeFileSync(outside, "OUTSIDE_CANARY_DO_NOT_READ");
    fs.symlinkSync(path.join(ws, "inside.txt"), link);

    const workspaceFd = openWorkspaceFd(ws);
    try {
      assert.equal(isSafeReadOnlyCommand("cat race-link", undefined, ws), true, "initial in-workspace target is admitted");
      const wrapped = wrapSandboxedCommand("cat race-link", ws, {
        mode: "bwrap",
        readOnlyHost: true,
        workspaceFd,
        network: false,
      });
      assert.equal(wrapped.sandboxed, true);
      assert.ok(wrapped.argv);

      const beforeSwap = runPinnedSandbox(wrapped, workspaceFd);
      assert.equal(beforeSwap.status, 0, beforeSwap.stderr);
      assert.match(beforeSwap.stdout, /workspace content/);

      fs.unlinkSync(link);
      fs.symlinkSync(outside, link);
      const afterSwap = runPinnedSandbox(wrapped, workspaceFd);
      assert.notEqual(afterSwap.status, 0, "the swapped outside target must not be readable");
      assert.doesNotMatch(afterSwap.stdout, /OUTSIDE_CANARY_DO_NOT_READ/);
      assert.doesNotMatch(afterSwap.stderr, /OUTSIDE_CANARY_DO_NOT_READ/);
    } finally {
      fs.closeSync(workspaceFd);
      fs.rmSync(link, { force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  test("read-only bwrap cannot follow a path created as an escaping symlink after admission", { skip: !isBwrapAvailable() }, () => {
    const outsideRoot = fs.mkdtempSync(path.join("/var/tmp", "nexus-ro-outside-"));
    const outside = path.join(outsideRoot, "outside-canary.txt");
    const link = path.join(ws, "created-after-admission");
    fs.writeFileSync(outside, "OUTSIDE_CANARY_DO_NOT_READ");

    const workspaceFd = openWorkspaceFd(ws);
    try {
      assert.equal(isSafeReadOnlyCommand("cat created-after-admission", undefined, ws), true, "missing operands are currently admitted");
      const wrapped = wrapSandboxedCommand("cat created-after-admission", ws, {
        mode: "bwrap",
        readOnlyHost: true,
        workspaceFd,
        network: false,
      });
      assert.equal(wrapped.sandboxed, true);
      assert.ok(wrapped.argv);

      fs.symlinkSync(outside, link);
      const result = runPinnedSandbox(wrapped, workspaceFd);
      assert.notEqual(result.status, 0, "a path created after admission must not expose the outside target");
      assert.doesNotMatch(result.stdout, /OUTSIDE_CANARY_DO_NOT_READ/);
      assert.doesNotMatch(result.stderr, /OUTSIDE_CANARY_DO_NOT_READ/);
    } finally {
      fs.closeSync(workspaceFd);
      fs.rmSync(link, { force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  test("read-only bwrap remounts only the workspace when it is nested under HOME", { skip: !isBwrapAvailable() }, () => {
    const home = fs.mkdtempSync(path.join("/var/tmp", "nexus-ro-home-"));
    const nestedWorkspace = path.join(home, "project");
    const outside = path.join(home, "private-canary.txt");
    const link = path.join(nestedWorkspace, "home-race-link");
    fs.mkdirSync(nestedWorkspace);
    fs.writeFileSync(path.join(nestedWorkspace, "inside.txt"), "NESTED_WORKSPACE_CANARY");
    fs.writeFileSync(outside, "HOME_CANARY_DO_NOT_READ");
    fs.symlinkSync(path.join(nestedWorkspace, "inside.txt"), link);

    const workspaceFd = openWorkspaceFd(nestedWorkspace);
    const priorHome = process.env.HOME;
    let wrapped: ReturnType<typeof wrapSandboxedCommand> | undefined;
    try {
      process.env.HOME = home;
      assert.equal(isSafeReadOnlyCommand("cat home-race-link", undefined, nestedWorkspace), true);
      wrapped = wrapSandboxedCommand("cat home-race-link", nestedWorkspace, {
        mode: "bwrap",
        readOnlyHost: true,
        workspaceFd,
        network: false,
      });
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }

    try {
      assert.ok(wrapped);
      assert.equal(wrapped.sandboxed, true);
      assert.ok(wrapped.argv);
      const beforeSwap = runPinnedSandbox(wrapped, workspaceFd);
      assert.equal(beforeSwap.status, 0, beforeSwap.stderr);
      assert.match(beforeSwap.stdout, /NESTED_WORKSPACE_CANARY/);

      fs.unlinkSync(link);
      fs.symlinkSync(outside, link);
      const afterSwap = runPinnedSandbox(wrapped, workspaceFd);
      assert.notEqual(afterSwap.status, 0, "the masked home sibling must not be readable");
      assert.doesNotMatch(afterSwap.stdout, /HOME_CANARY_DO_NOT_READ/);
      assert.doesNotMatch(afterSwap.stderr, /HOME_CANARY_DO_NOT_READ/);
    } finally {
      fs.closeSync(workspaceFd);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("read-only bwrap mounts the pinned workspace if its source pathname is replaced", { skip: !isBwrapAvailable() }, () => {
    const rootPath = fs.mkdtempSync(path.join("/var/tmp", "nexus-ro-workspace-race-"));
    const workspacePath = path.join(rootPath, "workspace");
    const originalPath = path.join(rootPath, "workspace-original");
    const outsidePath = path.join(rootPath, "outside");
    fs.mkdirSync(workspacePath);
    fs.mkdirSync(outsidePath);
    fs.writeFileSync(path.join(workspacePath, "inside.txt"), "PINNED_WORKSPACE_CANARY");
    fs.writeFileSync(path.join(outsidePath, "outside.txt"), "REPLACED_WORKSPACE_CANARY_DO_NOT_READ");
    const workspaceFd = openWorkspaceFd(workspacePath);

    try {
      const pinnedWorkspace = `/proc/${process.pid}/fd/${workspaceFd}`;
      assert.equal(isSafeReadOnlyCommand("cat inside.txt", undefined, pinnedWorkspace), true);
      fs.renameSync(workspacePath, originalPath);
      fs.symlinkSync(outsidePath, workspacePath);

      const wrapped = wrapSandboxedCommand("cat inside.txt", workspacePath, {
        mode: "bwrap",
        readOnlyHost: true,
        workspaceFd,
        network: false,
      });
      assert.equal(wrapped.sandboxed, true);
      const result = runPinnedSandbox(wrapped, workspaceFd);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /PINNED_WORKSPACE_CANARY/);
      assert.doesNotMatch(result.stdout, /REPLACED_WORKSPACE_CANARY_DO_NOT_READ/);
    } finally {
      fs.closeSync(workspaceFd);
      try {
        fs.unlinkSync(workspacePath);
      } catch {
        // The workspace pathname may still be the original directory if setup failed.
      }
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  test("read-only bwrap cannot reach unrelated files under an explicitly mounted runtime directory", { skip: !isBwrapAvailable() }, (t) => {
    const hostFile = "/usr/share/doc/bash/copyright";
    if (!fs.existsSync(hostFile)) {
      t.skip("host runtime canary fixture is unavailable");
      return;
    }
    const link = path.join(ws, "runtime-tree-canary");
    fs.symlinkSync(path.join(ws, "inside.txt"), link);
    const workspaceFd = openWorkspaceFd(ws);

    try {
      const pinnedWorkspace = `/proc/${process.pid}/fd/${workspaceFd}`;
      assert.equal(isSafeReadOnlyCommand("cat runtime-tree-canary", undefined, pinnedWorkspace), true);
      const wrapped = wrapSandboxedCommand("cat runtime-tree-canary", ws, {
        mode: "bwrap",
        readOnlyHost: true,
        workspaceFd,
        network: false,
      });
      assert.equal(wrapped.sandboxed, true);

      fs.unlinkSync(link);
      fs.symlinkSync(hostFile, link);
      const result = runPinnedSandbox(wrapped, workspaceFd);
      assert.notEqual(result.status, 0, "an unlisted host file beneath /usr/share must remain inaccessible");
      assert.doesNotMatch(result.stdout, /GNU Bash/);
      assert.doesNotMatch(result.stderr, /GNU Bash/);
    } finally {
      fs.closeSync(workspaceFd);
      fs.rmSync(link, { force: true });
    }
  });

  test("read-only bwrap cannot reach host configuration through a workspace symlink race", { skip: !isBwrapAvailable() }, (t) => {
    const hostFile = "/etc/hostname";
    if (!fs.existsSync(hostFile)) {
      t.skip("host configuration canary fixture is unavailable");
      return;
    }
    const link = path.join(ws, "etc-tree-canary");
    fs.symlinkSync(path.join(ws, "inside.txt"), link);
    const workspaceFd = openWorkspaceFd(ws);

    try {
      const pinnedWorkspace = `/proc/${process.pid}/fd/${workspaceFd}`;
      assert.equal(isSafeReadOnlyCommand("cat etc-tree-canary", undefined, pinnedWorkspace), true);
      const wrapped = wrapSandboxedCommand("cat etc-tree-canary", ws, {
        mode: "bwrap",
        readOnlyHost: true,
        workspaceFd,
        network: false,
      });
      assert.equal(wrapped.sandboxed, true);

      fs.unlinkSync(link);
      fs.symlinkSync(hostFile, link);
      const result = runPinnedSandbox(wrapped, workspaceFd);
      assert.notEqual(result.status, 0, "an unlisted host configuration file must remain inaccessible");
      assert.doesNotMatch(result.stdout, /hostname|[a-f0-9-]{12,}/i);
      assert.doesNotMatch(result.stderr, /hostname|[a-f0-9-]{12,}/i);
    } finally {
      fs.closeSync(workspaceFd);
      fs.rmSync(link, { force: true });
    }
  });

  test("read-only bwrap clears inherited environment before exposing procfs", { skip: !isBwrapAvailable() }, (t) => {
    const link = path.join(ws, "proc-environ-canary");
    const sentinelName = "NEXUS_SYNTHETIC_READONLY_ENV_CANARY";
    const sentinelValue = "synthetic-test-value-not-a-credential";
    const previousValue = process.env[sentinelName];
    process.env[sentinelName] = sentinelValue;
    fs.symlinkSync(path.join(ws, "inside.txt"), link);
    const workspaceFd = openWorkspaceFd(ws);

    try {
      const pinnedWorkspace = `/proc/${process.pid}/fd/${workspaceFd}`;
      assert.equal(isSafeReadOnlyCommand("cat proc-environ-canary", undefined, pinnedWorkspace), true);
      const wrapped = wrapSandboxedCommand("cat proc-environ-canary", ws, {
        mode: "bwrap",
        readOnlyHost: true,
        workspaceFd,
        network: false,
      });
      assert.equal(wrapped.sandboxed, true);

      fs.unlinkSync(link);
      fs.symlinkSync("/proc/self/environ", link);
      const result = runPinnedSandbox(wrapped, workspaceFd);
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, new RegExp(`${sentinelName}=${sentinelValue}`));
    } finally {
      fs.closeSync(workspaceFd);
      fs.rmSync(link, { force: true });
      if (previousValue === undefined) delete process.env[sentinelName];
      else process.env[sentinelName] = previousValue;
    }
  });

  test("read-only bwrap cannot address the host PID namespace through a workspace symlink race", { skip: !isBwrapAvailable() }, (t) => {
    const link = path.join(ws, "host-pid-canary");
    const sentinelName = "NEXUS_SYNTHETIC_HOST_PID_ENV_CANARY";
    const sentinelValue = "synthetic-host-pid-test-value";
    const previousValue = process.env[sentinelName];
    process.env[sentinelName] = sentinelValue;
    fs.symlinkSync(path.join(ws, "inside.txt"), link);
    const workspaceFd = openWorkspaceFd(ws);

    try {
      const pinnedWorkspace = `/proc/${process.pid}/fd/${workspaceFd}`;
      assert.equal(isSafeReadOnlyCommand("cat host-pid-canary", undefined, pinnedWorkspace), true);
      const wrapped = wrapSandboxedCommand("cat host-pid-canary", ws, {
        mode: "bwrap",
        readOnlyHost: true,
        workspaceFd,
        network: false,
      });
      assert.equal(wrapped.sandboxed, true);

      fs.unlinkSync(link);
      fs.symlinkSync(`/proc/${process.pid}/environ`, link);
      const result = runPinnedSandbox(wrapped, workspaceFd);
      assert.notEqual(result.status, 0, "the host PID must not be visible in the sandbox procfs");
      assert.doesNotMatch(result.stdout, new RegExp(`${sentinelName}=${sentinelValue}`));
      assert.doesNotMatch(result.stderr, new RegExp(`${sentinelName}=${sentinelValue}`));
    } finally {
      fs.closeSync(workspaceFd);
      fs.rmSync(link, { force: true });
      if (previousValue === undefined) delete process.env[sentinelName];
      else process.env[sentinelName] = previousValue;
    }
  });

  test("read-only bwrap retains the explicitly mounted inspection runtime", { skip: !isBwrapAvailable() }, () => {
    const workspaceFd = openWorkspaceFd(ws);
    try {
      const wrapped = wrapSandboxedCommand(
        "ls -1; grep workspace inside.txt; find . -maxdepth 1 -name inside.txt; node -v; which cat",
        ws,
        { mode: "bwrap", readOnlyHost: true, workspaceFd, network: false },
      );
      assert.equal(wrapped.sandboxed, true);
      const result = runPinnedSandbox(wrapped, workspaceFd);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /inside\.txt/);
      assert.match(result.stdout, /workspace content/);
      assert.match(result.stdout, /v\d+\./);
      assert.match(result.stdout, /\/usr\/bin\/cat/);
    } finally {
      fs.closeSync(workspaceFd);
    }
  });

  test("read-only bwrap mounts the advertised zsh runtime", { skip: !isBwrapAvailable() || !fs.existsSync("/usr/bin/zsh") }, () => {
    const workspaceFd = openWorkspaceFd(ws);
    try {
      const wrapped = wrapSandboxedCommand("printf 'zsh runtime\\n'", ws, {
        mode: "bwrap",
        readOnlyHost: true,
        workspaceFd,
        network: false,
        shell: "zsh",
      });
      assert.equal(wrapped.sandboxed, true);
      const result = runPinnedSandbox(wrapped, workspaceFd);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "zsh runtime\n");
    } finally {
      fs.closeSync(workspaceFd);
    }
  });

  test("read-only bwrap retains the installed npm inspection runtime", { skip: !isBwrapAvailable() || !fs.existsSync("/usr/bin/npm") }, () => {
    const npmWorkspace = path.join(root, "npm-workspace");
    fs.mkdirSync(npmWorkspace);
    fs.writeFileSync(path.join(npmWorkspace, "package.json"), JSON.stringify({ name: "sandbox-inspection-fixture", version: "1.0.0" }));
    const workspaceFd = openWorkspaceFd(npmWorkspace);
    try {
      const wrapped = wrapSandboxedCommand("npm list --depth=0", npmWorkspace, {
        mode: "bwrap",
        readOnlyHost: true,
        workspaceFd,
        network: false,
      });
      assert.equal(wrapped.sandboxed, true);
      const result = runPinnedSandbox(wrapped, workspaceFd);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /sandbox-inspection-fixture@1\.0\.0/);
    } finally {
      fs.closeSync(workspaceFd);
      fs.rmSync(npmWorkspace, { recursive: true, force: true });
    }
  });

  test("words after -- are operands, including a dash-prefixed symlink name", () => {
    for (const command of [
      "cat -- --link",
      "head -1 -- --link",
      "grep -e root -- --link",
      "rg -e root -- --link",
      "grep -- -e --link",
      "diff -- --link inside.txt",
      "diff -I -- -r A B",
      "grep -e -- -R .",
      "rg -e -- -L .",
      "diff A B",
      "diff --from-f=link inside.txt",
      "grep --dereference-recursiv ABBR .",
      "rg --follo ABBR .",
      "wc --files0-fro outside.list",
      "git diff --ext-diff",
      "cat --fil=link",
      "grep -ieroot link",
      "rg -ieroot link",
      "grep -nieroot link",
      "grep -ihello link",
      "grep -nf/etc/passwd x",
      "rg SECRET -rXe link",
      "rg SECRET -gx.e x.e",
    ]) {
      assert.equal(isSafeReadOnlyCommand(command, undefined, ws), false, command);
    }
    assert.equal(isSafeReadOnlyCommand("cat -- inside.txt", undefined, ws), true);
    assert.equal(isSafeReadOnlyCommand("grep -e root inside.txt", undefined, ws), true);
    assert.equal(isSafeReadOnlyCommand("grep -eroot inside.txt", undefined, ws), true);
    assert.equal(isSafeReadOnlyCommand("grep -i -e root inside.txt", undefined, ws), true);
    assert.equal(isSafeReadOnlyCommand("rg -e root inside.txt", undefined, ws), true);
    assert.equal(isSafeReadOnlyCommand("git diff", undefined, ws), true);
  });
});
