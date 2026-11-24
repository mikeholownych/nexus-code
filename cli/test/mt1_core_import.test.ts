import "./helpers/leak_guard.js";
/**
 * MT-1 acceptance ("AC-1 and BG-1 can drive a turn without `commander` side effects"): importing the application core
 * is not running the CLI. A front end that imports `src/core/app.ts` in a process whose own arguments look like CLI
 * arguments (`--help run`) gets a module: nothing is parsed, nothing is printed, the process is not ended for it, and
 * nothing is written under the home directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("importing core/app.ts with CLI-looking arguments parses nothing, prints nothing and writes nothing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-mt1-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-mt1-cwd-"));
  try {
    const script = [
      `const core = await import(${JSON.stringify(pathToFileURL(path.join(CLI_DIR, "src", "core", "app.ts")).href)});`,
      `if (typeof core.ApplicationCore !== "function") throw new Error("ApplicationCore is not exported");`,
      `process.stderr.write("imported:" + JSON.stringify(process.argv.slice(1)));`,
    ].join("\n");
    const child = spawnSync(process.execPath, ["--import", pathToFileURL(path.join(CLI_DIR, "node_modules", "tsx", "dist", "loader.mjs")).href, "--input-type=module", "-e", script, "--", "--help", "run"], {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache"), NEXUS_STATE_DIR: path.join(home, ".nexus") },
    });
    assert.equal(child.status, 0, `exit ${child.status} signal ${child.signal}\n${child.stderr}`);
    assert.equal(child.stdout, "", "nothing is printed (no commander help, no banner)");
    assert.equal(child.stderr, 'imported:["--help","run"]', "the import ran to its end with the arguments untouched, and nothing else was written to stderr");
    assert.deepEqual(fs.readdirSync(home), [], "nothing was created under the home directory");
    assert.deepEqual(fs.readdirSync(cwd), [], "nothing was created in the working directory");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
