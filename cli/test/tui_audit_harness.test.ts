/**
 * The TUI dogfood audit harness (docs/v1.1.4/tui-audit-harness) is committed as a reproduction aid, so it must be safe
 * to run from any checkout: `setup.sh` writes fixtures and commits only inside the scratch workspace `S`, even when
 * that path contains a space, and refuses a target that is not a scratch workspace; `t.sh` finds the checkout it
 * drives from its own location and passes `start`'s optional arguments through intact. The audit document's summary
 * table counts what its entries count.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const HARNESS = path.join(ROOT, "docs/v1.1.4/tui-audit-harness");
const AUDIT = path.join(ROOT, "docs/v1.1.4/TUI-AUDIT.md");

/** A temporary directory whose path contains a space, under a throwaway HOME. */
function scratch(): { home: string; s: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tui-audit-harness-"));
  return { home, s: path.join(home, "nexus audit") };
}

/** Runs a harness script from `cwd` with a throwaway HOME, so a stray write lands in the fixture, never in a real checkout. */
function run(script: string, args: string[], cwd: string, env: Record<string, string>) {
  return spawnSync("bash", [path.join(HARNESS, script), ...args], { cwd, env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
}

function gitRepo(dir: string, files: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  for (const cmd of [["init", "-q"], ["config", "user.name", "t"], ["config", "user.email", "t@t.invalid"], ["add", "."], ["commit", "-qm", "caller"]]) {
    execFileSync("git", cmd, { cwd: dir, stdio: "ignore" });
  }
}

test("setup.sh writes and commits only inside a scratch path with a space; the caller's checkout is untouched", () => {
  const { home, s } = scratch();
  try {
    // The checkout the auditor happens to be standing in: it has the very files setup.sh writes.
    const caller = path.join(home, "caller");
    gitRepo(caller, { "README.md": "# Caller\n\nNot the demo.\n", "package.json": '{"name":"caller"}\n' });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: caller, encoding: "utf8" });

    const r = run("setup.sh", ["trust"], caller, { HOME: home, S: s });
    assert.equal(r.status, 0, `setup.sh failed:\n${r.stderr}\n${r.stdout}`);

    assert.equal(fs.readFileSync(path.join(caller, "README.md"), "utf8"), "# Caller\n\nNot the demo.\n", "the caller's README.md is untouched");
    assert.equal(fs.readFileSync(path.join(caller, "package.json"), "utf8"), '{"name":"caller"}\n', "the caller's package.json is untouched");
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: caller, encoding: "utf8" }), head, "nothing was committed in the caller's checkout");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: caller, encoding: "utf8" }), "", "the caller's working tree is clean");

    // The fixtures landed in the scratch workspace, committed there.
    assert.equal(fs.readFileSync(path.join(s, "ws", "README.md"), "utf8"), "# Demo\n\nA small repository.\n");
    assert.ok(fs.existsSync(path.join(s, "ws", "base.txt")) && fs.existsSync(path.join(s, "ws", "package.json")));
    assert.equal(execFileSync("git", ["log", "--format=%s"], { cwd: path.join(s, "ws"), encoding: "utf8" }).trim(), "base");
    const trust = JSON.parse(fs.readFileSync(path.join(s, "home", ".config", "nexus", "trusted_workspaces.json"), "utf8"));
    assert.deepEqual(trust, { trustedPaths: [fs.realpathSync(path.join(s, "ws"))] });

    // Running it again (the harness is re-run between scenarios) resets the same scratch workspace.
    fs.writeFileSync(path.join(s, "ws", "left-over.txt"), "x");
    const again = run("setup.sh", [], caller, { HOME: home, S: s });
    assert.equal(again.status, 0, again.stderr);
    assert.ok(!fs.existsSync(path.join(s, "ws", "left-over.txt")), "the scratch workspace is recreated");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("setup.sh refuses a target that is not a scratch workspace and leaves it as it was", () => {
  const { home, s } = scratch();
  try {
    // A directory with content of its own and no marker from a previous run: a real checkout, not scratch.
    gitRepo(s, { "README.md": "# Mine\n", "notes.txt": "keep\n" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: s, encoding: "utf8" });
    const r = run("setup.sh", [], home, { HOME: home, S: s });
    assert.notEqual(r.status, 0, "setup.sh refuses");
    assert.match(r.stderr, /refus/i);
    assert.equal(fs.readFileSync(path.join(s, "README.md"), "utf8"), "# Mine\n");
    assert.ok(fs.existsSync(path.join(s, "notes.txt")) && !fs.existsSync(path.join(s, "ws")));
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: s, encoding: "utf8" }), head);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: s, encoding: "utf8" }), "");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/** Sources t.sh in a bash with a throwaway HOME and a fake tmux on PATH, then runs `body`; returns stdout and the tmux calls. */
function withHarness(body: string, env: Record<string, string>): { stdout: string; status: number | null; stderr: string; tmux: string[][] } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tui-audit-t-"));
  try {
    const bin = path.join(home, "bin");
    fs.mkdirSync(bin);
    const calls = path.join(home, "tmux-calls.txt");
    // Each call: its arguments, NUL-separated, one line per call.
    fs.writeFileSync(path.join(bin, "tmux"), `#!/bin/bash\nprintf '%s\\0' "$@" >> "${calls}"; printf '\\n' >> "${calls}"\n`, { mode: 0o755 });
    const r = spawnSync("bash", ["-c", `source "${path.join(HARNESS, "t.sh")}"; ${body}`], {
      cwd: home,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, ...env },
      encoding: "utf8",
    });
    const tmux = fs.existsSync(calls)
      ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => line.split("\0").filter((_, i, a) => i < a.length - 1))
      : [];
    return { stdout: r.stdout, stderr: r.stderr, status: r.status, tmux };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** The words of the shell command `start` hands to tmux, up to the exit-code echo, as bash would split them. */
function commandWords(call: string[]): string[] {
  const command = call.at(-1)!;
  const head = command.split("; echo EXIT_CODE=")[0];
  return execFileSync("bash", ["-c", 'eval "set -- $1"; printf "%s\\n" "$@"', "_", head], { encoding: "utf8" }).split("\n").filter(Boolean);
}

test("t.sh drives the checkout it lives in unless WT is set", () => {
  const defaults = withHarness('printf "%s" "$WT"', {});
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.ok(fs.existsSync(defaults.stdout), `WT points at a checkout that exists: ${defaults.stdout}`);
  assert.equal(fs.realpathSync(defaults.stdout), fs.realpathSync(ROOT), "WT defaults to this repository, not the auditor's worktree");
  const override = withHarness('printf "%s" "$WT"', { WT: "/elsewhere/nexus" });
  assert.equal(override.stdout, "/elsewhere/nexus");
});
