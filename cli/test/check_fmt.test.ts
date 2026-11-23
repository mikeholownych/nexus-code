import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/check_fmt.sh", import.meta.url));

function tempRepo(): { dir: string; home: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-fmt-repo-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-fmt-home-"));
  const run = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: home } });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  };
  run(["init", "-q"]);
  run(["config", "user.name", "Test"]);
  run(["config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(dir, "README"), "initial\n");
  run(["add", "README"]);
  run(["commit", "-qm", "initial"]);
  return { dir, home };
}

test("check_fmt.sh fails closed when no formatting base can be resolved", () => {
  const { dir, home } = tempRepo();
  const env = { ...process.env, HOME: home };
  delete env.NEXUS_FMT_BASE;
  try {
    const result = spawnSync("bash", [script], { cwd: dir, env, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot resolve a formatting base/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("check_fmt.sh accepts an explicitly resolved base with no changed Rust files", () => {
  const { dir, home } = tempRepo();
  try {
    fs.writeFileSync(path.join(dir, "README"), "changed\n");
    const result = spawnSync("bash", [script], {
      cwd: dir,
      env: { ...process.env, HOME: home, NEXUS_FMT_BASE: "HEAD" },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no changed Rust files/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
