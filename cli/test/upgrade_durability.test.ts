/**
 * Power-loss durability: the extracted package must be fsynced before the CLI
 * renames it into place and switches the launcher. A rename makes the directory
 * entry durable, not the file contents, so without this flush a power loss can
 * leave a live launcher pointing at zero-length binaries and the recovery
 * command itself unavailable.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fsyncTree, type DurabilityIo } from "../src/durable_tree.js";
import { safeExtractTar } from "../src/tar_safety.js";

const SYSTEM_TAR = ["/usr/bin/tar", "/bin/tar"].find((candidate) => fs.existsSync(candidate));

function recorder() {
  const flushed: string[] = [];
  const opened = new Map<number, string>();
  let nextFd = 100;
  const io: DurabilityIo = {
    openSync(file, flags) {
      assert.equal(flags, "r");
      opened.set(nextFd, path.resolve(file));
      return nextFd++;
    },
    fsyncSync(fd) {
      const file = opened.get(fd);
      assert.ok(file, `fsync of unknown fd ${fd}`);
      flushed.push(file);
    },
    closeSync(fd) { opened.delete(fd); },
  };
  return { io, flushed, pending: () => opened.size };
}

describe("fsyncTree", () => {
  test("flushes every regular file and directory, children before parents", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-fsync-tree-"));
    try {
      fs.mkdirSync(path.join(root, "bin"));
      fs.mkdirSync(path.join(root, "lib", "core"), { recursive: true });
      fs.writeFileSync(path.join(root, "VERSION"), "v1.0.0-rc.10\n");
      fs.writeFileSync(path.join(root, "bin", "nexus"), "#!/bin/sh\n");
      fs.writeFileSync(path.join(root, "lib", "core", "harness-core"), "bin");
      fs.symlinkSync("../VERSION", path.join(root, "bin", "VERSION-link"));

      const { io, flushed, pending } = recorder();
      fsyncTree(root, io);

      const resolved = (p: string) => path.resolve(root, p);
      for (const expected of ["VERSION", "bin/nexus", "lib/core/harness-core", "bin", "lib/core", "lib", ""]) {
        assert.ok(flushed.includes(resolved(expected)), `missing fsync for ${expected || "."}`);
      }
      // Symlinks have no data of their own.
      assert.equal(flushed.includes(resolved("bin/VERSION-link")), false);
      // Parent directories are flushed after their children.
      assert.ok(flushed.indexOf(resolved("lib/core")) < flushed.indexOf(resolved("lib")));
      assert.ok(flushed.indexOf(resolved("lib")) < flushed.indexOf(resolved(".")));
      assert.equal(pending(), 0, "every descriptor must be closed");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a symlink or file as the tree root", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-fsync-bad-"));
    try {
      const file = path.join(dir, "file");
      fs.writeFileSync(file, "x");
      fs.symlinkSync(file, path.join(dir, "link"));
      assert.throws(() => fsyncTree(file), /real directory/);
      assert.throws(() => fsyncTree(path.join(dir, "link")), /real directory/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fsyncTree failure", () => {
  test("names the file whose flush failed and closes the descriptor", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-fsync-fail-"));
    try {
      fs.mkdirSync(path.join(root, "bin"));
      const target = path.join(root, "bin", "nexus");
      fs.writeFileSync(target, "#!/bin/sh\n");
      const opened = new Set<number>();
      let nextFd = 50;
      const io = {
        openSync(_file: string, _flags: string) { opened.add(nextFd); return nextFd++; },
        fsyncSync() { throw new Error("EIO: i/o error"); },
        closeSync(fd: number) { opened.delete(fd); },
      };
      assert.throws(() => fsyncTree(root, io), new RegExp(`durability flush failed for ${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: EIO`));
      assert.equal(opened.size, 0, "the failing descriptor must still be closed");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("safeExtractTar durability", () => {
  test("fsyncs every extracted file and directory before returning", async () => {
    assert.ok(SYSTEM_TAR, "system tar is required");
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-extract-durable-"));
    try {
      const source = path.join(work, "source");
      fs.mkdirSync(path.join(source, "nexus", "bin"), { recursive: true });
      fs.mkdirSync(path.join(source, "nexus", "lib", "core"), { recursive: true });
      fs.writeFileSync(path.join(source, "nexus", "VERSION"), "v1.0.0-rc.10\n");
      fs.writeFileSync(path.join(source, "nexus", "bin", "nexus"), "#!/bin/sh\n");
      fs.writeFileSync(path.join(source, "nexus", "lib", "core", "harness-core"), "bin");
      fs.writeFileSync(path.join(source, "nexus", "lib", "core", "nexus-tui"), "bin");
      const archive = path.join(work, "pkg.tar.gz");
      const tar = spawnSync(SYSTEM_TAR, ["-czf", archive, "-C", source, "nexus"], { encoding: "utf8" });
      assert.equal(tar.status, 0, tar.stderr);

      const { io, flushed } = recorder();
      const destination = path.join(work, "unpack");
      const result = await safeExtractTar(archive, destination, "nexus", { io });

      const pkg = result.extractedDir;
      for (const relative of ["VERSION", "bin/nexus", "lib/core/harness-core", "lib/core/nexus-tui", "bin", "lib/core", "lib", ""]) {
        const expected = path.resolve(pkg, relative);
        assert.ok(flushed.includes(expected), `extracted ${relative || "."} was not fsynced`);
      }
      assert.ok(flushed.indexOf(path.resolve(pkg, "lib/core")) < flushed.indexOf(path.resolve(pkg, "lib")));
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
