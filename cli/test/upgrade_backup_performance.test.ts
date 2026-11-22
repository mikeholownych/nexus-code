import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { createPreMigrationBackup, restoreConfigBackup } from "../src/upgrade_journal.js";

function makeHome(label: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `nexus-backup-${label}-`));
  for (const dir of [path.join(home, ".nexus", "tasks"), path.join(home, ".config", "nexus")]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(path.join(home, ".nexus"), 0o700);
  fs.chmodSync(path.join(home, ".config"), 0o700);
  return home;
}

describe("fast pre-migration backups", () => {
  it("uses copy-on-write cloning, enforces private modes and records a manifest", () => {
    const home = makeHome("clone");
    const originalCopyFileSync = fsDefault.copyFileSync;
    const flags: number[] = [];
    try {
      const payload = Buffer.alloc(16 * 1024, 0x61);
      fs.writeFileSync(path.join(home, ".nexus", "tasks", "task.json"), payload, { mode: 0o600 });
      fs.writeFileSync(path.join(home, ".config", "nexus", "config.env"), "MODEL=test\n", { mode: 0o600 });
      // Nested backup directories must be excluded just like the roots are.
      fs.mkdirSync(path.join(home, ".nexus", "tasks", "backups"), { mode: 0o700 });
      fs.writeFileSync(path.join(home, ".nexus", "tasks", "backups", "stale.json"), "stale", { mode: 0o600 });

      fsDefault.copyFileSync = ((source: any, destination: any, flag: any) => {
        flags.push(flag);
        return originalCopyFileSync(source, destination, flag);
      }) as typeof fsDefault.copyFileSync;
      syncBuiltinESMExports();

      const backup = createPreMigrationBackup(home);
      assert.ok(backup.stateBackupDir);
      assert.ok(flags.length >= 3, "config and both state trees use the clone fast path");
      assert.ok(flags.every(flag => (flag & fs.constants.COPYFILE_FICLONE) !== 0 && (flag & fs.constants.COPYFILE_EXCL) !== 0));

      const cloned = path.join(backup.stateBackupDir!, "state", "tasks", "task.json");
      assert.deepEqual(fs.readFileSync(cloned), payload);
      assert.equal(fs.statSync(cloned).mode & 0o777, 0o600);
      assert.equal(fs.existsSync(path.join(backup.stateBackupDir!, "state", "tasks", "backups")), false);

      const manifest = JSON.parse(fs.readFileSync(path.join(backup.stateBackupDir!, "backup.json"), "utf8"));
      assert.equal(manifest.formatVersion, 1);
      assert.equal(manifest.files, flags.length);
      assert.equal(manifest.bytes, payload.length + Buffer.byteLength("MODEL=test\n") * 2);
      assert.deepEqual(manifest.entries.find((entry: any) => entry.path === "tasks/task.json"), { store: "state", path: "tasks/task.json", bytes: payload.length });
      assert.ok(manifest.entries.some((entry: any) => entry.store === "config" && entry.path === "config.env"));
    } finally {
      fsDefault.copyFileSync = originalCopyFileSync;
      syncBuiltinESMExports();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back to a durable chunked copy when cloning is unsupported", () => {
    const home = makeHome("fallback");
    const originalCopyFileSync = fsDefault.copyFileSync;
    const originalWriteSync = fsDefault.writeSync;
    const originalNow = Date.now;
    const progress: Array<{ filesCopied: number; bytesCopied: number }> = [];
    let fakeNow = 0;
    try {
      const payload = Buffer.alloc(160 * 1024, 0x62);
      fs.writeFileSync(path.join(home, ".nexus", "tasks", "task.json"), payload, { mode: 0o600 });
      fsDefault.copyFileSync = (() => {
        throw Object.assign(new Error("clones unsupported"), { code: "EOPNOTSUPP" });
      }) as typeof fsDefault.copyFileSync;
      Date.now = () => fakeNow;
      fsDefault.writeSync = ((...args: Parameters<typeof originalWriteSync>) => {
        const written = originalWriteSync(...args);
        fakeNow += 5_000;
        return written;
      }) as typeof fsDefault.writeSync;
      syncBuiltinESMExports();

      const backup = createPreMigrationBackup(home, item => progress.push(item));
      assert.ok(backup.stateBackupDir);
      const copied = path.join(backup.stateBackupDir!, "state", "tasks", "task.json");
      assert.deepEqual(fs.readFileSync(copied), payload);
      assert.equal(fs.statSync(copied).mode & 0o777, 0o600);
      assert.ok(progress.some(item => item.filesCopied === 0 && item.bytesCopied >= 64 * 1024), "fallback keeps chunked byte progress");
    } finally {
      Date.now = originalNow;
      fsDefault.writeSync = originalWriteSync;
      fsDefault.copyFileSync = originalCopyFileSync;
      syncBuiltinESMExports();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("restores a cloned state backup into the live tree", () => {
    const home = makeHome("restore");
    try {
      const live = path.join(home, ".nexus", "sessions", "index.json");
      fs.mkdirSync(path.dirname(live), { mode: 0o700 });
      fs.writeFileSync(live, '{"sessions":["kept"]}', { mode: 0o600 });

      const backup = createPreMigrationBackup(home);
      assert.ok(backup.stateBackupDir);
      fs.writeFileSync(live, '{"sessions":["tampered"]}', { mode: 0o600 });

      assert.equal(restoreConfigBackup(backup.stateBackupDir!, home), true);
      assert.equal(fs.readFileSync(live, "utf8"), '{"sessions":["kept"]}');
      assert.equal(fs.statSync(live).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
