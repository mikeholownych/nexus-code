import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recordMiddlewareAudit, rotateAuditLogIfNeeded } from "../src/core/persistence_protection.js";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function modeOf(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

describe("PLAN-08 PR-8c: Audit log rotation (REQ-PER-102, ACC-PER-06)", () => {
  test("ACC-PER-06: audit.log rotates at size limit, keeping 5 backups with 0600 permissions", () => {
    const testHome = tmp("audit-rot-home-");
    const origHome = process.env.HOME;
    const origMaxBytes = process.env.NEXUS_AUDIT_MAX_BYTES;

    try {
      process.env.HOME = testHome;
      // Set small rotation limit for testing (150 bytes)
      process.env.NEXUS_AUDIT_MAX_BYTES = "150";

      const nexusDir = path.join(testHome, ".nexus");
      const auditLog = path.join(nexusDir, "audit.log");

      // Write 8 audit records that will trigger multiple rotations
      for (let i = 1; i <= 8; i++) {
        recordMiddlewareAudit({
          kind: "middleware_rewrite",
          plugin: `plugin-${i}`,
          tool: "write_file",
          phase: "pre",
          before_digest: `digest-before-${i}`,
          after_digest: `digest-after-${i}`,
        });
      }

      assert.ok(fs.existsSync(auditLog), "audit.log must exist");
      assert.equal(modeOf(auditLog), 0o600, "audit.log must be mode 0600");

      // Check rotated backups: audit.log.1 through audit.log.5
      for (let i = 1; i <= 5; i++) {
        const backup = path.join(nexusDir, `audit.log.${i}`);
        assert.ok(fs.existsSync(backup), `audit.log.${i} must exist`);
        assert.equal(modeOf(backup), 0o600, `audit.log.${i} must be mode 0600`);
      }

      // Check that audit.log.6 does NOT exist (max 5 kept)
      assert.equal(fs.existsSync(path.join(nexusDir, "audit.log.6")), false, "audit.log.6 must not exist");

      // Test explicit rotateAuditLogIfNeeded function
      const customAudit = path.join(nexusDir, "custom_audit.log");
      fs.writeFileSync(customAudit, "A".repeat(500), { mode: 0o600 });
      const rotated = rotateAuditLogIfNeeded(customAudit, 100, 3);
      assert.equal(rotated, true, "rotateAuditLogIfNeeded must return true on rotation");
      assert.ok(fs.existsSync(`${customAudit}.1`), "custom_audit.log.1 must exist");
      assert.equal(modeOf(`${customAudit}.1`), 0o600, "custom_audit.log.1 must be 0600");
    } finally {
      process.env.HOME = origHome;
      if (origMaxBytes !== undefined) {
        process.env.NEXUS_AUDIT_MAX_BYTES = origMaxBytes;
      } else {
        delete process.env.NEXUS_AUDIT_MAX_BYTES;
      }
      fs.rmSync(testHome, { recursive: true, force: true });
    }
  });
});
