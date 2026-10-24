/**
 * Symlink targets in release archives must not escape the expected package root, whichever separator
 * the archive uses. `isSymlinkSafe` normalizes before checking, so a Windows-style `..\..` cannot slip
 * past while the equivalent `../../` is rejected.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isSymlinkSafe, safeExtractTar } from "../src/tar_safety.js";

describe("tar symlink target confinement", () => {
  test("rejects parent traversal with forward or backslash separators", () => {
    for (const link of [
      "../../outside",
      "..\\..\\outside",
      "sub\\..\\..\\..\\outside",
    ]) {
      assert.equal(isSymlinkSafe(link, "nexus/dir/link").safe, false, link);
    }
  });

  test("checks the normalized final target after resolving parent segments", () => {
    for (const link of ["../../outside/file", "..\\..\\outside\\file"]) {
      assert.equal(isSymlinkSafe(link, "nexus/dir/link").safe, false, link);
    }

    // The normalized destination is inside the package root even though the spelling climbs
    // above the `nexus/` prefix before returning. The validator intentionally checks that final
    // destination rather than requiring every intermediate lexical prefix to stay under `nexus/`.
    assert.equal(isSymlinkSafe("../../nexus/file", "nexus/dir/link").safe, true);
  });

  test("allows targets that stay inside the package root", () => {
    assert.equal(isSymlinkSafe("../inside", "nexus/dir/link").safe, true);
    assert.equal(isSymlinkSafe("..\\inside", "nexus/dir/link").safe, true);
    assert.equal(isSymlinkSafe("nexus/file", "nexus/link").safe, true);
  });

  test("still rejects absolute targets and drive letters", () => {
    for (const link of ["/etc/passwd", "\\windows\\system32", "C:\\Windows"]) {
      assert.equal(isSymlinkSafe(link, "nexus/link").safe, false, link);
    }
  });
});

describe("tar extraction trusted tools and environment", () => {
  test("does not resolve tar from PATH", async () => {
    if (!fs.existsSync("/usr/bin/tar")) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tar-env-"));
    const pkg = path.join(root, "nexus");
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.mkdirSync(path.join(pkg, "lib", "core"), { recursive: true });
    for (const rel of ["bin/nexus", "lib/core/harness-core", "lib/core/nexus-tui", "VERSION"]) {
      fs.writeFileSync(path.join(pkg, rel), "payload\n");
    }
    const archive = path.join(root, "release.tar.gz");
    const built = spawnSync("/usr/bin/tar", ["-czf", archive, "-C", root, "nexus"], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);

    const marker = path.join(root, "tar-executed");
    const bin = path.join(root, "bin-path");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "tar"), `#!/bin/sh\ntouch '${marker}'\nexec /usr/bin/tar "$@"\n`, { mode: 0o755 });
    fs.chmodSync(path.join(bin, "tar"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath ?? ""}`;
    try {
      const destination = path.join(root, "out");
      fs.mkdirSync(destination);
      await safeExtractTar(archive, destination, "nexus");
      assert.equal(fs.existsSync(marker), false, "tar was resolved from PATH");
      assert.ok(fs.existsSync(path.join(destination, "nexus", "VERSION")), "the archive was still extracted");
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not honor ambient TAR_OPTIONS during extraction", async () => {
    if (!fs.existsSync("/usr/bin/tar")) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tar-options-"));
    const pkg = path.join(root, "nexus");
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.mkdirSync(path.join(pkg, "lib", "core"), { recursive: true });
    for (const rel of ["bin/nexus", "lib/core/harness-core", "lib/core/nexus-tui", "VERSION"]) {
      fs.writeFileSync(path.join(pkg, rel), "payload\n");
    }
    const archive = path.join(root, "release.tar.gz");
    const built = spawnSync("/usr/bin/tar", ["-czf", archive, "-C", root, "nexus"], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);

    const marker = path.join(root, "to-command-executed");
    const command = path.join(root, "evil-command");
    fs.writeFileSync(command, `#!/bin/sh\ntouch '${marker}'\ncat >/dev/null\n`, { mode: 0o755 });
    fs.chmodSync(command, 0o755);
    const saved = process.env.TAR_OPTIONS;
    process.env.TAR_OPTIONS = `--to-command=${command}`;
    const destination = path.join(root, "out");
    fs.mkdirSync(destination);
    let failure: unknown;
    try {
      await safeExtractTar(archive, destination, "nexus");
    } catch (err) {
      failure = err;
    } finally {
      if (saved === undefined) delete process.env.TAR_OPTIONS;
      else process.env.TAR_OPTIONS = saved;
    }
    try {
      assert.equal(fs.existsSync(marker), false, "ambient TAR_OPTIONS executed a command during extraction");
      if (failure) throw failure;
      assert.ok(fs.existsSync(path.join(destination, "nexus", "VERSION")), "the archive was extracted without ambient options");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
