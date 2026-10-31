/**
 * Option scope on the command line (REQ-REL-102): options after a subcommand are that subcommand's. The top-level
 * launch options (--provider, -m, …, for `nexus` opening the TUI) used to swallow them, so the documented
 * `nexus providers verify --provider <id> -m <model>` reported --provider as missing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const nexus = (...args: string[]) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-optscope-"));
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") }, timeout: 30_000 });
};

test("a subcommand receives its own --provider and -m", { skip: fs.existsSync(CLI) ? false : "cli/dist is not built" }, () => {
  const r = nexus("providers", "verify", "--provider", "no-such-provider", "-m", "m");
  const out = `${r.stdout}${r.stderr}`;
  assert.doesNotMatch(out, /required option '--provider <id>' not specified/);
  assert.match(out, /Unknown provider '\(unrecognized provider\)'/, out);
  assert.doesNotMatch(out, /no-such-provider/);
});

test("top-level options before a subcommand are still accepted", { skip: fs.existsSync(CLI) ? false : "cli/dist is not built" }, () => {
  const r = nexus("--provider", "openrouter", "providers", "--help");
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /verify/);
});
