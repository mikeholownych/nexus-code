import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { uninstallManagedInstall } from "../src/uninstall.js";

function fixture(): { root: string; home: string; install: string; workspace: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-uninstall-"));
  const home = path.join(root, "home");
  const prefix = path.join(root, "prefix");
  const install = path.join(prefix, "lib", "nexus", "v1.2.1");
  const workspace = path.join(home, "workspace");
  fs.mkdirSync(path.join(install, "bin"), { recursive: true });
  fs.mkdirSync(path.join(install, "lib", "cli"), { recursive: true });
  fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
  fs.mkdirSync(path.join(home, ".config", "nexus"), { recursive: true });
  fs.mkdirSync(path.join(home, ".nexus", "tasks"), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(install, "VERSION"), "v1.2.1\n");
  fs.writeFileSync(path.join(install, "bin", "nexus"), "launcher\n");
  fs.writeFileSync(path.join(install, "lib", "cli", "index.js"), "runtime\n");
  fs.writeFileSync(path.join(install, ".provenance.json"), `${JSON.stringify({
    formatVersion: 1,
    method: "installer",
    product: "nexus-code",
    version: "v1.2.1",
    prefix,
    installedPath: install,
    binPath: path.join(prefix, "bin", "nexus"),
    managed: true,
  })}\n`);
  const rows = ["VERSION", "bin/nexus", "lib/cli/index.js"].map((rel) => {
    const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(install, rel))).digest("hex");
    return `${digest}  ./${rel}`;
  });
  fs.writeFileSync(path.join(install, "MANIFEST.sha256"), `${rows.join("\n")}\n`);
  fs.symlinkSync(path.join(install, "bin", "nexus"), path.join(prefix, "bin", "nexus"));
  fs.writeFileSync(path.join(home, ".config", "nexus", "config.env"), "NEXUS_TEST=1\n");
  fs.writeFileSync(path.join(home, ".nexus", "tasks", "task.json"), "{}\n");
  fs.writeFileSync(path.join(workspace, "source.ts"), "preserve\n");
  return { root, home, install, workspace };
}

function addOlderInstall(install: string): string {
  const old = path.join(path.dirname(install), "v1.2.0");
  fs.cpSync(install, old, { recursive: true });
  fs.writeFileSync(path.join(old, "VERSION"), "v1.2.0\n");
  const provenancePath = path.join(old, ".provenance.json");
  const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
  provenance.version = "v1.2.0";
  provenance.installedPath = old;
  fs.writeFileSync(provenancePath, `${JSON.stringify(provenance)}\n`);
  const rows = ["VERSION", "bin/nexus", "lib/cli/index.js"].map((rel) => {
    const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(old, rel))).digest("hex");
    return `${digest}  ./${rel}`;
  });
  fs.writeFileSync(path.join(old, "MANIFEST.sha256"), `${rows.join("\n")}\n`);
  return old;
}

test("uninstall removes only the verified install and launcher by default", () => {
  const f = fixture();
  try {
    const old = addOlderInstall(f.install);
    const result = uninstallManagedInstall({ installRoot: f.install, home: f.home });
    assert.equal(result.removedLauncher, true);
    assert.deepEqual(result.purgedState, []);
    assert.equal(fs.existsSync(f.install), false);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(path.dirname(f.install)), false);
    assert.equal(fs.existsSync(path.join(path.dirname(path.dirname(path.dirname(f.install))), "bin", "nexus")), false);
    assert.equal(fs.existsSync(path.join(f.home, ".config", "nexus", "config.env")), true);
    assert.equal(fs.existsSync(path.join(f.home, ".nexus", "tasks", "task.json")), true);
    assert.equal(fs.existsSync(path.join(f.workspace, "source.ts")), true);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("uninstall refuses an upgrade lock before changing packages, launcher, state, or workspace", () => {
  const f = fixture();
  const libNexus = path.dirname(f.install);
  const launcher = path.join(path.dirname(path.dirname(path.dirname(f.install))), "bin", "nexus");
  try {
    fs.writeFileSync(path.join(libNexus, ".upgrade.lock"), JSON.stringify({ pid: process.pid, token: "upgrade-in-progress" }));
    assert.throws(() => uninstallManagedInstall({ installRoot: f.install, home: f.home }), /upgrade is active or its lock needs recovery/);
    assert.equal(fs.existsSync(f.install), true);
    assert.equal(fs.existsSync(launcher), true);
    assert.equal(fs.existsSync(path.join(f.home, ".nexus", "tasks", "task.json")), true);
    assert.equal(fs.existsSync(path.join(f.workspace, "source.ts")), true);
    assert.equal(fs.existsSync(path.join(libNexus, ".upgrade.lock")), true);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("uninstall refuses modified, extra, or escaping files before changing anything", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => fs.writeFileSync(path.join(f.install, "VERSION"), "tampered\n"),
    (f: ReturnType<typeof fixture>) => fs.writeFileSync(path.join(f.install, "unlisted.txt"), "extra\n"),
    (f: ReturnType<typeof fixture>) => fs.mkdirSync(path.join(f.install, "empty-unlisted-directory")),
    (f: ReturnType<typeof fixture>) => fs.writeFileSync(path.join(f.install, "MANIFEST.sha256"), `${"0".repeat(64)}  ../outside\n`),
    (f: ReturnType<typeof fixture>) => fs.writeFileSync(path.join(path.dirname(f.install), ".upgrade-journal.json"), "{broken\n"),
    (f: ReturnType<typeof fixture>) => fs.mkdirSync(path.join(path.dirname(f.install), ".tmp-upgrade-incomplete")),
  ]) {
    const f = fixture();
    try {
      mutate(f);
      assert.throws(() => uninstallManagedInstall({ installRoot: f.install, home: f.home }));
      assert.equal(fs.existsSync(f.install), true);
      assert.equal(fs.existsSync(path.join(f.install, "VERSION")), true);
      assert.equal(fs.existsSync(path.join(f.home, ".nexus", "tasks", "task.json")), true);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("uninstall rejects symlinks and a launcher that points outside the selected install", () => {
  const f = fixture();
  try {
    fs.unlinkSync(path.join(f.install, "lib", "cli", "index.js"));
    fs.symlinkSync(path.join(f.root, "outside"), path.join(f.install, "lib", "cli", "index.js"));
    assert.throws(() => uninstallManagedInstall({ installRoot: f.install, home: f.home }), /symbolic link/);
    fs.unlinkSync(path.join(f.install, "lib", "cli", "index.js"));
    fs.writeFileSync(path.join(f.install, "lib", "cli", "index.js"), "runtime\n");
    fs.unlinkSync(path.join(path.dirname(path.dirname(path.dirname(f.install))), "bin", "nexus"));
    fs.symlinkSync(path.join(f.root, "outside"), path.join(path.dirname(path.dirname(path.dirname(f.install))), "bin", "nexus"));
    assert.throws(() => uninstallManagedInstall({ installRoot: f.install, home: f.home }), /different install/);
    assert.equal(fs.existsSync(f.install), true);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("--purge removes only operator state and configuration, preserving workspaces", () => {
  const f = fixture();
  try {
    const result = uninstallManagedInstall({ installRoot: f.install, home: f.home, purge: true });
    assert.equal(result.purgedState.length, 2);
    assert.equal(fs.existsSync(path.join(f.home, ".nexus")), false);
    assert.equal(fs.existsSync(path.join(f.home, ".config", "nexus")), false);
    assert.equal(fs.existsSync(path.join(f.workspace, "source.ts")), true);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("nexus uninstall --purge dispatches through the CLI and preserves workspace files", async () => {
  const f = fixture();
  const cli = path.resolve("dist/index.js");
  try {
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [cli, "uninstall", "--purge"], {
        env: { ...process.env, HOME: f.home, XDG_CONFIG_HOME: path.join(f.home, ".config"), NEXUS_HOME: f.install },
        timeout: 10000,
      }, (error, stdout, stderr) => resolve({ code: error ? (error.code as number) ?? 1 : 0, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Removed Nexus install/);
    assert.equal(fs.existsSync(f.install), false);
    assert.equal(fs.existsSync(path.join(f.home, ".nexus")), false);
    assert.equal(fs.existsSync(path.join(f.home, ".config", "nexus")), false);
    assert.equal(fs.existsSync(path.join(f.workspace, "source.ts")), true);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
