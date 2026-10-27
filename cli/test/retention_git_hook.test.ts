import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { executeRetention, planRetention } from "../src/core/retention.js";
import { envWithoutConfiguredHooks } from "../src/core/git_hook_guard.js";

test("configured hook guard forces event-wide disable after inherited enable", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hook-config-override-"));
  const previous = process.env.GIT_CONFIG_PARAMETERS;
  try {
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    process.env.GIT_CONFIG_PARAMETERS = "'hook.reference-transaction.enabled'='true'";
    const versionOutput = execFileSync("git", ["--version"], { encoding: "utf8" });
    const version = versionOutput.match(/git version (\d+)\.(\d+)/);
    assert.ok(version, `could not parse Git version: ${versionOutput}`);
    if (Number(version[1]) === 2 && Number(version[2]) === 54) {
      assert.throws(
        () => envWithoutConfiguredHooks(workspace, ["reference-transaction"]),
        /Git 2\.54 cannot safely disable all configured hooks/,
      );
      return;
    }
    const env = envWithoutConfiguredHooks(workspace, ["reference-transaction"]);
    const effective = execFileSync("git", ["config", "--type=bool", "--get", "hook.reference-transaction.enabled"], {
      cwd: workspace,
      env,
      encoding: "utf8",
    }).trim();
    assert.equal(effective, "false");
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_PARAMETERS;
    else process.env.GIT_CONFIG_PARAMETERS = previous;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("configured hook guard fails closed on Git 2.54", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hook-git-254-"));
  const wrapperDir = path.join(root, "bin");
  const previousPath = process.env.PATH;
  fs.mkdirSync(wrapperDir, { recursive: true });
  fs.writeFileSync(path.join(wrapperDir, "git"), "#!/bin/sh\nprintf 'git version 2.54.0\\n'\n", { mode: 0o755 });
  try {
    process.env.PATH = `${wrapperDir}${path.delimiter}${previousPath ?? ""}`;
    assert.throws(
      () => envWithoutConfiguredHooks(root, ["reference-transaction"]),
      /Git 2\.54 cannot safely disable all configured hooks/,
    );
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint gc disables repository hooks and deletes the checkpoint ref", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-retention-hook-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const partition = path.join(home, ".nexus", "checkpoints", "partition");
  fs.mkdirSync(partition, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const previousGitConfigParameters = process.env.GIT_CONFIG_PARAMETERS;
  try {
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "t@t.invalid"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, "file.txt"), "x\n");
    execFileSync("git", ["add", "file.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: workspace });
    const ref = "refs/nexus/checkpoints/checkpoint";
    execFileSync("git", ["update-ref", ref, "HEAD"], { cwd: workspace });
    const marker = path.join(root, "hook-ran");
    const hook = path.join(workspace, ".git", "hooks", "reference-transaction");
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    fs.chmodSync(hook, 0o755);
    const includedHookConfig = path.join(root, "configured-hooks.inc");
    fs.writeFileSync(
      includedHookConfig,
      '[hook "retention=extra"]\n\tevent = reference-transaction\n\tcommand = touch configured-hook-ran\n',
    );
    execFileSync("git", ["config", "--local", "include.path", includedHookConfig], { cwd: workspace });
    // A parent Git process can pass config through this internal environment variable; it outranks
    // GIT_CONFIG_COUNT, so an inherited value must not be able to re-enable the configured hook.
    process.env.GIT_CONFIG_PARAMETERS = "'hook.retention=extra.enabled'='true'";
    const gitVersion = execFileSync("git", ["--version"], { cwd: workspace, encoding: "utf8" });
    const version = gitVersion.match(/git version (\d+)\.(\d+)/);
    assert.ok(version, `could not parse Git version: ${gitVersion}`);
    const hasConfiguredHooks = Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 55);
    if (hasConfiguredHooks) {
      const probeRef = "refs/nexus/checkpoints/config-hook-probe";
      execFileSync("git", ["update-ref", probeRef, "HEAD"], { cwd: workspace });
      assert.equal(fs.existsSync(path.join(workspace, "configured-hook-ran")), true, "configured hook precondition did not run");
      assert.equal(fs.existsSync(marker), true, "traditional hook precondition did not run");
      fs.rmSync(path.join(workspace, "configured-hook-ran"));
      fs.rmSync(marker);
      execFileSync("git", ["update-ref", "-d", probeRef], { cwd: workspace });
      fs.rmSync(path.join(workspace, "configured-hook-ran"));
      fs.rmSync(marker);
    }

    const record = path.join(partition, "checkpoint.json");
    fs.writeFileSync(record, JSON.stringify({ workspace, gitRef: "refs/nexus/checkpoints/checkpoint" }));
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    fs.utimesSync(record, old, old);

    const plan = planRetention({ home, maxAgeDays: 1 });
    assert.ok(plan.reclaimableItems.some((item) => item.kind === "checkpoint"));
    executeRetention(plan);
    assert.equal(fs.existsSync(marker), false, "gc executed a workspace git hook");
    assert.equal(fs.existsSync(path.join(workspace, "configured-hook-ran")), false, "gc executed a configured Git hook");
    const refLookup = spawnSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd: workspace });
    assert.equal(
      refLookup.status,
      1,
      `git show-ref did not confirm ref deletion: ${refLookup.error?.message ?? refLookup.stderr?.toString()}`,
    );
  } finally {
    if (previousGitConfigParameters === undefined) delete process.env.GIT_CONFIG_PARAMETERS;
    else process.env.GIT_CONFIG_PARAMETERS = previousGitConfigParameters;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint gc disables configured hooks added immediately before ref deletion", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-retention-hook-race-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const partition = path.join(home, ".nexus", "checkpoints", "partition");
  const includePath = path.join(root, "hooks.inc");
  const wrapperDir = path.join(root, "bin");
  const marker = path.join(root, "late-hook-ran");
  const configAdded = path.join(root, "hook-config-added");
  const previousPath = process.env.PATH;
  const previousRealGit = process.env.REAL_GIT;
  fs.mkdirSync(partition, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(wrapperDir, { recursive: true });
  try {
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "t@t.invalid"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, "file.txt"), "x\n");
    execFileSync("git", ["add", "file.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: workspace });
    const ref = "refs/nexus/checkpoints/checkpoint-race";
    execFileSync("git", ["update-ref", ref, "HEAD"], { cwd: workspace });
    fs.writeFileSync(includePath, "");
    execFileSync("git", ["config", "--local", "include.path", includePath], { cwd: workspace });

    const version = execFileSync("git", ["--version"], { cwd: workspace, encoding: "utf8" }).match(/git version (\d+)\.(\d+)/);
    assert.ok(version, "could not parse Git version");
    if (Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 55)) {
      t.skip("event-wide repository hook suppression requires Git 2.55 or later");
      return;
    }

    const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    fs.writeFileSync(
      path.join(wrapperDir, "git"),
      `#!/bin/sh\n` +
        `add_hook() {\n` +
        `  if [ ! -e '${configAdded}' ]; then\n` +
        `    printf '[hook "late-added"]\\n\\tevent = reference-transaction\\n\\tcommand = touch \\\"${marker}\\\"\\n' >> '${includePath}'\n` +
        `    : > '${configAdded}'\n` +
        `  fi\n` +
        `}\n` +
        `if [ "$1" = config ]; then\n` +
        `  "$REAL_GIT" "$@"; status=$?; add_hook; exit $status\n` +
        `fi\n` +
        `if [ "$3" = update-ref ] && [ "$4" = -d ]; then add_hook; fi\n` +
        `exec "$REAL_GIT" "$@"\n`,
      { mode: 0o755 },
    );
    fs.chmodSync(path.join(wrapperDir, "git"), 0o755);

    const record = path.join(partition, "checkpoint-race.json");
    fs.writeFileSync(record, JSON.stringify({ workspace, gitRef: ref }));
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    fs.utimesSync(record, old, old);
    const plan = planRetention({ home, maxAgeDays: 1 });
    assert.ok(plan.reclaimableItems.some((item) => item.kind === "checkpoint"));

    process.env.PATH = `${wrapperDir}${path.delimiter}${previousPath ?? ""}`;
    process.env.REAL_GIT = gitPath;
    const result = executeRetention(plan);
    assert.equal(fs.existsSync(configAdded), true, "fixture did not add the hook immediately before ref deletion");
    assert.equal(fs.existsSync(marker), false, "gc executed a configured hook added immediately before ref deletion");
    assert.equal(result.deletedCount, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(fs.existsSync(record), false);
  } finally {
    process.env.PATH = previousPath;
    if (previousRealGit === undefined) delete process.env.REAL_GIT;
    else process.env.REAL_GIT = previousRealGit;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint gc preserves a ref when its record changes after planning", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-retention-record-race-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const partition = path.join(home, ".nexus", "checkpoints", "partition");
  fs.mkdirSync(partition, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  try {
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "t@t.invalid"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, "file.txt"), "x\n");
    execFileSync("git", ["add", "file.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: workspace });
    const ref = "refs/nexus/checkpoints/checkpoint-record-race";
    execFileSync("git", ["update-ref", ref, "HEAD"], { cwd: workspace });
    const record = path.join(partition, "checkpoint-record-race.json");
    fs.writeFileSync(record, JSON.stringify({ workspace, gitRef: ref }));
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    fs.utimesSync(record, old, old);
    const plan = planRetention({ home, maxAgeDays: 1 });
    assert.ok(plan.reclaimableItems.some((item) => item.kind === "checkpoint"));

    const replacement = `${record}.replacement`;
    fs.writeFileSync(replacement, JSON.stringify({ workspace, gitRef: ref, changedAfterPlanning: true }));
    fs.renameSync(replacement, record);

    const result = executeRetention(plan);
    assert.equal(result.deletedCount, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /changed since planning/);
    assert.equal(fs.existsSync(record), true, "gc removed the replaced checkpoint record");
    assert.equal(
      spawnSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd: workspace }).status,
      0,
      "gc deleted the ref for a record that changed after planning",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint gc restores the ref if the record changes during ref deletion", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-retention-ref-rollback-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const partition = path.join(home, ".nexus", "checkpoints", "partition");
  const wrapperDir = path.join(root, "bin");
  const recordChanged = path.join(root, "record-changed");
  const previousPath = process.env.PATH;
  const previousRealGit = process.env.REAL_GIT;
  fs.mkdirSync(partition, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(wrapperDir, { recursive: true });
  try {
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "t@t.invalid"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, "file.txt"), "x\n");
    execFileSync("git", ["add", "file.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: workspace });
    const ref = "refs/nexus/checkpoints/checkpoint-ref-rollback";
    execFileSync("git", ["update-ref", ref, "HEAD"], { cwd: workspace });
    const record = path.join(partition, "checkpoint-ref-rollback.json");
    fs.writeFileSync(record, JSON.stringify({ workspace, gitRef: ref }));
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    fs.utimesSync(record, old, old);
    const plan = planRetention({ home, maxAgeDays: 1 });
    assert.ok(plan.reclaimableItems.some((item) => item.kind === "checkpoint"));

    const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const replacement = `${record}.replacement`;
    fs.writeFileSync(
      path.join(wrapperDir, "git"),
      `#!/bin/sh\n` +
        `if [ "$3" = update-ref ] && [ "$4" = -d ] && [ ! -e '${recordChanged}' ]; then\n` +
        `  printf '%s' '{"workspace":"${workspace}","gitRef":"${ref}","replacedDuringDelete":true}' > '${replacement}'\n` +
        `  mv '${replacement}' '${record}'\n` +
        `  : > '${recordChanged}'\n` +
        `fi\n` +
        `exec "$REAL_GIT" "$@"\n`,
      { mode: 0o755 },
    );
    fs.chmodSync(path.join(wrapperDir, "git"), 0o755);

    process.env.PATH = `${wrapperDir}${path.delimiter}${previousPath ?? ""}`;
    process.env.REAL_GIT = gitPath;
    const result = executeRetention(plan);
    assert.equal(fs.existsSync(recordChanged), true, "fixture did not replace the record during ref deletion");
    assert.equal(result.deletedCount, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /changed since planning/);
    assert.equal(fs.existsSync(record), true, "gc removed the replacement checkpoint record");
    assert.equal(
      spawnSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd: workspace }).status,
      0,
      "gc did not restore the checkpoint ref after rejecting changed metadata",
    );
  } finally {
    process.env.PATH = previousPath;
    if (previousRealGit === undefined) delete process.env.REAL_GIT;
    else process.env.REAL_GIT = previousRealGit;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint gc preserves the record and reports failure when ref deletion fails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-retention-ref-failure-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const partition = path.join(home, ".nexus", "checkpoints", "partition");
  const wrapperDir = path.join(root, "bin");
  const previousPath = process.env.PATH;
  fs.mkdirSync(partition, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(wrapperDir, { recursive: true });
  try {
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "t@t.invalid"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, "file.txt"), "x\n");
    execFileSync("git", ["add", "file.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: workspace });
    const ref = "refs/nexus/checkpoints/checkpoint-failure";
    execFileSync("git", ["update-ref", ref, "HEAD"], { cwd: workspace });

    const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    fs.writeFileSync(
      path.join(wrapperDir, "git"),
      `#!/bin/sh\n` +
        `if [ "$3" = update-ref ] && [ "$4" = -d ] && [ "$5" = '${ref}' ]; then\n` +
        `  echo 'simulated ref deletion failure' >&2; exit 1\n` +
        `fi\n` +
        `exec '${gitPath}' "$@"\n`,
      { mode: 0o755 },
    );
    fs.chmodSync(path.join(wrapperDir, "git"), 0o755);

    const record = path.join(partition, "checkpoint-failure.json");
    fs.writeFileSync(record, JSON.stringify({ workspace, gitRef: ref }));
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    fs.utimesSync(record, old, old);
    const plan = planRetention({ home, maxAgeDays: 1 });
    assert.ok(plan.reclaimableItems.some((item) => item.kind === "checkpoint"));

    process.env.PATH = `${wrapperDir}${path.delimiter}${previousPath ?? ""}`;
    const result = executeRetention(plan);
    assert.equal(result.deletedCount, 0, "gc counted a checkpoint deleted after ref deletion failed");
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].path, record);
    assert.match(result.errors[0].error, /update-ref -d/);
    assert.equal(fs.existsSync(record), true, "gc removed the checkpoint record after ref deletion failed");
    assert.equal(
      spawnSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd: workspace }).status,
      0,
      "the checkpoint ref should remain available for a retry",
    );
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
