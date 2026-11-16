/**
 * Extra positional arguments are ignored, as they always were. Commander 13 made them an error by default; the CLI opts
 * back in so a dependency upgrade does not change what `nexus doctor extra` does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const skip = fs.existsSync(CLI) ? false : "cli/dist is not built";
const nexus = (...args: string[]) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-excess-"));
  try {
    return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") }, timeout: 30_000 });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
};

test("an extra argument to a command with no arguments is ignored", { skip }, () => {
  const r = nexus("doctor", "extra");
  const out = `${r.stdout}${r.stderr}`;
  assert.doesNotMatch(out, /too many arguments/, out);
  assert.match(out, /Nexus doctor/, out);
});

test("an extra argument to a command with one argument is ignored", { skip }, () => {
  const r = nexus("trust", "no-such-directory-a", "no-such-directory-b");
  const out = `${r.stdout}${r.stderr}`;
  assert.doesNotMatch(out, /too many arguments/, out);
  assert.match(out, /Not a directory: .*no-such-directory-a/, out);
});
