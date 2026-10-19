/**
 * Stable promotion (ACCEPTANCE §1.1 stage 5, REQ-REL-103): scripts/check-version-only-diff.mjs accepts a stable commit
 * only when it is a single commit on the accepted RC that changes nothing but the synchronized version metadata.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("stable promotion accepts only RC + synchronized version change", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "version-only-"));
  const env = { ...process.env, HOME: base, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const repo = path.join(base, "repo");
  const git = (...argv: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...argv], { cwd: repo, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const check = (rc: string, stable: string) => spawnSync(process.execPath, [path.join(repo, "scripts/check-version-only-diff.mjs"), rc, stable], { cwd: repo, env, encoding: "utf8" });
  const setVersion = (version: string) => {
    const file = path.join(repo, "package.json");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/("version":\s*)"[^"]*"/, `$1"${version}"`));
    const sync = spawnSync(process.execPath, [path.join(repo, "scripts/sync-version.mjs")], { cwd: repo, env, encoding: "utf8" });
    assert.equal(sync.status, 0, sync.stderr);
  };
  try {
    assert.equal(spawnSync("git", ["clone", "-q", "--no-local", ROOT, repo], { env }).status, 0);
    // The checkout under test may carry uncommitted changes to the script itself: test that version.
    fs.copyFileSync(path.join(ROOT, "scripts/check-version-only-diff.mjs"), path.join(repo, "scripts/check-version-only-diff.mjs"));
    setVersion("9.9.9-rc.1");
    git("add", "-A");
    git("commit", "-qm", "rc", "--allow-empty");
    const rc = git("rev-parse", "HEAD");

    setVersion("9.9.9");
    git("commit", "-qam", "release: v9.9.9");
    const good = check(rc, "HEAD");
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /version-only: .* \+ v9\.9\.9/);
    const validStable = git("rev-parse", "HEAD");

    git("reset", "-q", "--hard", rc);
    setVersion("9.9.10");
    git("commit", "-qam", "stable version does not match accepted RC");
    const mismatchedPromotion = check(rc, "HEAD");
    assert.notEqual(mismatchedPromotion.status, 0, "stable promotion must retain the accepted RC's major.minor.patch");
    assert.match(mismatchedPromotion.stderr, /stable version 9\.9\.10 does not match RC 9\.9\.9-rc\.1/);

    git("reset", "-q", "--hard", validStable);
    fs.appendFileSync(path.join(repo, "README.md"), "\nextra\n");
    git("commit", "-qam", "sneaky");
    assert.match(check(rc, "HEAD").stderr, /not a single commit directly on RC/);

    git("reset", "-q", "--hard", rc);
    setVersion("9.9.9");
    fs.appendFileSync(path.join(repo, "README.md"), "\nextra\n");
    git("commit", "-qam", "version plus a source edit");
    assert.match(check(rc, "HEAD").stderr, /differs from RC \+ sync-version 9\.9\.9 in: README\.md/);

    git("reset", "-q", "--hard", rc);
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ ...pkg, version: "9.9.9", private: !pkg.private }, null, 2) + "\n");
    git("commit", "-qam", "version plus a package.json edit");
    assert.match(check(rc, "HEAD").stderr, /root package.json changes more than its version/);

    git("reset", "-q", "--hard", rc);
    fs.writeFileSync(path.join(repo, "package.json"), fs.readFileSync(path.join(repo, "package.json"), "utf8").replace(/("version":\s*)"[^"]*"/, '$1"9.9.9"'));
    git("commit", "-qam", "root version only, components not synchronized");
    assert.match(check(rc, "HEAD").stderr, /differs from RC \+ sync-version 9\.9\.9/);

    git("reset", "-q", "--hard", rc);
    setVersion("9.9.9");
    fs.writeFileSync(path.join(repo, "added.txt"), "new\n");
    git("add", "added.txt");
    git("commit", "-qam", "version plus a new file");
    assert.match(check(rc, "HEAD").stderr, /in: added\.txt/);

    git("reset", "-q", "--hard", rc);
    setVersion("9.9.9");
    fs.chmodSync(path.join(repo, "README.md"), 0o755);
    git("commit", "-qam", "version plus a mode change");
    assert.match(check(rc, "HEAD").stderr, /in: README\.md/);

    git("reset", "-q", "--hard", rc);
    setVersion("9.9.9");
    const synced = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify(synced) + "\n");
    git("commit", "-qam", "version plus reformatted package.json");
    assert.match(check(rc, "HEAD").stderr, /text changes more than its version string/);

    // release.yml runs the RC's copy of the checker from outside the checkout.
    git("reset", "-q", "--hard", rc);
    setVersion("9.9.9");
    git("commit", "-qam", "release: v9.9.9");
    const outside = path.join(base, "check-version-only-diff.mjs");
    fs.copyFileSync(path.join(repo, "scripts/check-version-only-diff.mjs"), outside);
    const copied = spawnSync(process.execPath, [outside, rc, "HEAD"], { cwd: repo, env, encoding: "utf8" });
    assert.equal(copied.status, 0, copied.stderr);

    assert.match(check(rc, rc).stderr, /not a single commit directly on RC/);
    assert.equal(git("worktree", "list").split("\n").length, 1, "the checker removes its temporary worktree");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
