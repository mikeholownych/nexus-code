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
      "rustc -v",
    ]) {
      assert.equal(isSafeReadOnlyCommand(command, undefined, ws), true, command);
    }
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
