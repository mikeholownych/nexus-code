/**
 * Symlink targets in release archives must not escape the expected package root, whichever separator
 * the archive uses. `isSymlinkSafe` normalizes before checking, so a Windows-style `..\..` cannot slip
 * past while the equivalent `../../` is rejected.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isSymlinkSafe } from "../src/tar_safety.js";

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

  test("rejects a target that traverses above the root and returns", () => {
    for (const link of [
      "../../../nexus/file",
      "..\\..\\..\\nexus\\file",
      "../../nexus/file",
    ]) {
      assert.equal(isSymlinkSafe(link, "nexus/link").safe, false, link);
    }
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
