import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { generateCompatibilityMetadata, validateCompatibilityMetadata, checkReleaseCompatibility, validateCompatibilityAssetBinding } from "../src/compatibility.js";

const validator = fileURLToPath(new URL("../../scripts/validate_compatibility.mjs", import.meta.url));
for (const version of ["1.0.0", "1.0.0-rc.1", "1.0.0+build.1"]) {
  test(`coherent ${version} metadata passes updater and publisher validation`, () => {
    const metadata = generateCompatibilityMetadata(version, "abcdef0123456789");
    assert.equal(validateCompatibilityMetadata(metadata).valid, true);
    assert.equal(checkReleaseCompatibility("1.0.0", 1, metadata).compatible, true);
    const dir = mkdtempSync(join(tmpdir(), "nexus-component-test-"));
    try {
      const file = join(dir, "compatibility.json");
      writeFileSync(file, JSON.stringify(metadata));
      const result = spawnSync(process.execPath, [validator, file], { encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
for (const component of ["cli", "core", "tui", "harness"] as const) {
  for (const mismatch of ["9.9.9", "1.0.0-rc.1", "1.0.0+other"]) {
    test(`reject mixed ${component}=${mismatch} throughout validation`, () => {
      const metadata = generateCompatibilityMetadata("1.0.0", "abcdef0123456789");
      metadata.components[component] = mismatch;
      const validation = validateCompatibilityMetadata(metadata);
      assert.equal(validation.valid, false);
      assert.ok(validation.errors.some(error => error.includes(component) && error.includes("must match")));
      assert.equal(checkReleaseCompatibility("1.0.0", 1, metadata).compatible, false);
      const external = structuredClone(metadata);
      const digest = "a".repeat(64);
      external.platforms["linux-x86_64"].sha256 = digest;
      assert.equal(validateCompatibilityAssetBinding(external, metadata, "1.0.0", metadata.platforms["linux-x86_64"].archive, digest).valid, false);
      const dir = mkdtempSync(join(tmpdir(), "nexus-component-test-"));
      try {
        const file = join(dir, "compatibility.json");
        writeFileSync(file, JSON.stringify(metadata));
        const result = spawnSync(process.execPath, [validator, file], { encoding: "utf8", timeout: 10000 });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /must match release version/);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
}
