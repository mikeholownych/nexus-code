import { CURRENT_STATE_SCHEMA_VERSION } from "../src/core/state_schema.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import * as zlib from "node:zlib";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  validateDownloadUrl,
  downloadFile,
  detectPathShadowing,
  rollbackBinary,
  detectInstallation,
  writeProvenance,
  compareInstallationWithRelease,
  performUpgrade,
  ProvenanceRecord,
  InstalledProductInfo,
  PublishedRelease,
} from "../src/upgrade.js";
import {
  isPathSafe,
  isSymlinkSafe,
  validateTarArchive,
  safeExtractTar,
  MAX_DOWNLOAD_BYTES,
  MAX_EXTRACT_BYTES,
} from "../src/tar_safety.js";
import {
  generateCompatibilityMetadata,
  validateCompatibilityMetadata,
  checkReleaseCompatibility,
  ReleaseCompatibilityMetadata,
} from "../src/compatibility.js";
import {
  getJournalPath,
  readJournal,
  writeJournal,
  clearJournal,
  createPreMigrationBackup,
  restoreConfigBackup,
  recoverUpgrade,
  UpgradeJournalEntry,
} from "../src/upgrade_journal.js";

function completeRuntimeFixture(directory: string, version: string): void {
  for (const sub of ["bin", "lib/core", "lib/cli/dist"]) fs.mkdirSync(path.join(directory, sub), { recursive:true });
  fs.writeFileSync(path.join(directory, "VERSION"), version);
  fs.writeFileSync(path.join(directory, "lib/cli/dist/index.js"), "// fixture CLI payload\n");
  fs.writeFileSync(path.join(directory, "bin/nexus"), `#!/bin/sh\necho ${version}\n`, { mode:0o755 });
  fs.writeFileSync(path.join(directory, "lib/core/harness-core"), `#!/bin/sh\necho ${version}\n`, { mode:0o755 });
  fs.writeFileSync(path.join(directory, "lib/core/nexus-tui"), `#!/bin/sh\nif [ "$1" = --version ]; then echo ${version}; else echo NEXUS; fi\n`, { mode:0o755 });
}

describe("Download Origin, Redirect & Bounds Safety (REQ-REL-116, ACC-UPG-08)", () => {
  it("validates allowed release download origins", () => {
    // Official GitHub releases
    assert.equal(
      validateDownloadUrl("https://github.com/mikeholownych/nexus-code/releases/download/v1.0.0/nexus-linux-x86_64-v1.0.0.tar.gz"),
      true
    );
    // GitHub release CDN redirect host
    assert.equal(
      validateDownloadUrl("https://objects.githubusercontent.com/github-production-release-asset-2e65be/12345/nexus.tar.gz"),
      true
    );
    // Newer GitHub releases redirect to a signed, release-specific asset host.
    assert.equal(
      validateDownloadUrl("https://release-assets.githubusercontent.com/github-production-release-asset/12345/a1111111-1111-4111-8111-111111111111"),
      true
    );
    assert.equal(
      validateDownloadUrl("https://release-assets.githubusercontent.com/other-content/payload.tar.gz"),
      false
    );
    assert.equal(
      validateDownloadUrl("http://release-assets.githubusercontent.com/github-production-release-asset/12345/asset"),
      false
    );
    // Localhost allowed for mock test servers
    assert.equal(validateDownloadUrl("http://127.0.0.1:4567/download/v1.0.0/nexus.tar.gz"), true);
    assert.equal(validateDownloadUrl("http://localhost:4567/download/v1.0.0/nexus.tar.gz"), true);

    // Disallowed origins
    assert.equal(validateDownloadUrl("https://evil.com/releases/download/nexus.tar.gz"), false);
    assert.equal(validateDownloadUrl("https://github.com/attacker/nexus-code/releases/download/nexus.tar.gz"), false);
    // Reject plain HTTP for remote github.com
    assert.equal(validateDownloadUrl("http://github.com/mikeholownych/nexus-code/releases/download/v1.0.0/nexus.tar.gz"), false);
    // Reject embedded credentials
    assert.equal(validateDownloadUrl("https://user:pass@github.com/mikeholownych/nexus-code/releases/download/v1.0.0/nexus.tar.gz"), false);
  });

  it("rejects downloads redirecting to disallowed hosts or exceeding hop limits", async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-dl-test-"));
    let server: http.Server | null = null;

    try {
      // 1. Server redirecting to evil.com
      const evilPort = await new Promise<number>((resolve) => {
        server = http.createServer((req, res) => {
          if (req.url === "/redirect-evil") {
            res.writeHead(302, { Location: "https://evil-untrusted-site.com/payload.tar.gz" });
            res.end();
          } else if (req.url === "/redirect-evil-signed") {
            res.writeHead(302, { Location: "https://evil-untrusted-site.com/payload.tar.gz?token=must-not-appear" });
            res.end();
          } else if (req.url?.startsWith("/loop-")) {
            const count = parseInt(req.url.replace("/loop-", ""), 10);
            res.writeHead(302, { Location: `http://127.0.0.1:${evilPort}/loop-${count + 1}` });
            res.end();
          } else {
            res.writeHead(404);
            res.end();
          }
        });
        server.listen(0, "127.0.0.1", () => {
          const addr = server!.address() as any;
          resolve(addr.port);
        });
      });

      const dest1 = path.join(testDir, "test1.tar.gz");
      await assert.rejects(
        downloadFile(`http://127.0.0.1:${evilPort}/redirect-evil`, dest1, undefined, 5000),
        /Disallowed download origin or invalid URL/
      );

      const secretUrl = `http://127.0.0.1:${evilPort}/redirect-evil-signed`;
      await assert.rejects(downloadFile(secretUrl, path.join(testDir, "signed.tar.gz"), undefined, 5000), (error: Error) => {
        assert.match(error.message, /Disallowed download origin or invalid URL \(https:\/\/evil-untrusted-site\.com\)/);
        assert.doesNotMatch(error.message, /must-not-appear/);
        return true;
      });

      // 2. Too many redirects
      const dest2 = path.join(testDir, "test2.tar.gz");
      await assert.rejects(
        downloadFile(`http://127.0.0.1:${evilPort}/loop-0`, dest2, undefined, 5000, 3),
        /Too many redirects/
      );
    } finally {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("follows the allowlisted signed GitHub release-asset redirect without forwarding credentials", async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-dl-release-asset-"));
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    const requests: Array<{ url: string; authorization: string | null; redirect: string | undefined }> = [];
    const downloadUrl = "https://github.com/mikeholownych/nexus-code/releases/download/v1.0.0-rc.8/nexus.tar.gz";
    const signedAssetUrl = "https://release-assets.githubusercontent.com/github-production-release-asset/1416386345/11111111-2222-4333-8444-555555555555?token=synthetic-signature";

    try {
      process.env.GITHUB_TOKEN = "synthetic-github-token";
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get("authorization"),
          redirect: init?.redirect,
        });
        if (url === downloadUrl) {
          return new Response(null, { status: 302, headers: { location: signedAssetUrl } });
        }
        if (url === signedAssetUrl) {
          return new Response(new Uint8Array([0x4e, 0x58, 0x53]), { status: 200 });
        }
        throw new Error(`Unexpected mocked download URL: ${new URL(url).origin}`);
      }) as typeof globalThis.fetch;

      const destination = path.join(testDir, "release.tar.gz");
      await downloadFile(
        downloadUrl,
        destination,
      );

      assert.deepEqual(requests, [
        {
          url: downloadUrl,
          authorization: "Bearer synthetic-github-token",
          redirect: "manual",
        },
        { url: signedAssetUrl, authorization: null, redirect: "manual" },
      ]);
      assert.deepEqual(fs.readFileSync(destination), Buffer.from([0x4e, 0x58, 0x53]));
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalToken;
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe("Tar Archive Structural Safety Engine (REQ-REL-116, ACC-UPG-08)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tar-safety-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Helper to write a simple ustar archive with raw entries
   */
  function createTestTar(entries: Array<{ name: string; typeflag?: string; linkname?: string; content?: string; declaredSize?: number }>): Buffer {
    const blocks: Buffer[] = [];

    for (const ent of entries) {
      const header = Buffer.alloc(512);
      // name (100)
      header.write(ent.name, 0, 100, "utf8");
      // mode (8)
      header.write("0000755\0", 100, 8, "utf8");
      // uid (8), gid (8)
      header.write("0001750\0", 108, 8, "utf8");
      header.write("0001750\0", 116, 8, "utf8");
      // size (12)
      const data = Buffer.from(ent.content || "");
      const sizeOctal = (ent.declaredSize ?? data.length).toString(8).padStart(11, "0") + "\0";
      header.write(sizeOctal, 124, 12, "utf8");
      // mtime (12)
      header.write("14000000000\0", 136, 12, "utf8");
      // typeflag (1)
      const type = ent.typeflag ?? (ent.linkname ? "2" : ent.name.endsWith("/") ? "5" : "0");
      header.write(type, 156, 1, "utf8");
      // linkname (100)
      if (ent.linkname) {
        header.write(ent.linkname, 157, 100, "utf8");
      }
      // magic (6) + version (2)
      header.write("ustar\0", 257, 6, "utf8");
      header.write("00", 263, 2, "utf8");

      // Compute checksum
      header.fill(0x20, 148, 156);
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += header[i];
      const sumOctal = sum.toString(8).padStart(6, "0") + "\0 ";
      header.write(sumOctal, 148, 8, "utf8");

      blocks.push(header);

      if (data.length > 0) {
        blocks.push(data);
        const pad = (512 - (data.length % 512)) % 512;
        if (pad > 0) {
          blocks.push(Buffer.alloc(pad));
        }
      }
    }

    // End-of-archive 1024 zero bytes
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
  }

  function paxRecord(key: string, value: string): string {
    const body = `${key}=${value}\n`;
    let length = Buffer.byteLength(body) + 3;
    while (length !== Buffer.byteLength(String(length)) + 1 + Buffer.byteLength(body)) {
      length = Buffer.byteLength(String(length)) + 1 + Buffer.byteLength(body);
    }
    return `${length} ${body}`;
  }

  it("verifies path safety checks: rejects traversal and absolute paths", () => {
    assert.equal(isPathSafe("nexus/bin/nexus").safe, true);
    assert.equal(isPathSafe("nexus/lib/core/harness-core").safe, true);

    // Traversal attempts
    assert.equal(isPathSafe("nexus/../evil").safe, false);
    assert.equal(isPathSafe("../escape").safe, false);
    assert.equal(isPathSafe("nexus/subdir/../../etc/passwd").safe, false);

    // Absolute paths
    assert.equal(isPathSafe("/etc/passwd").safe, false);
    assert.equal(isPathSafe("/nexus/bin/nexus").safe, false);

    // Outside expected root
    assert.equal(isPathSafe("other/bin/nexus").safe, false);
  });

  it("verifies symlink safety: rejects symlinks escaping package root", () => {
    // Valid relative symlinks inside nexus/
    assert.equal(isSymlinkSafe("core/harness", "nexus/bin/harness-link").safe, true);
    assert.equal(isSymlinkSafe("../lib/core/harness", "nexus/bin/harness").safe, true);

    // Escaping symlinks
    assert.equal(isSymlinkSafe("../../etc/passwd", "nexus/bin/nexus").safe, false);
    assert.equal(isSymlinkSafe("/etc/shadow", "nexus/bin/nexus").safe, false);
    assert.equal(isSymlinkSafe("../../../../../../tmp/foo", "nexus/lib/file").safe, false);
  });

  it("rejects malicious tar archive with path traversal", async () => {
    const maliciousTar = path.join(tmpRoot, "traversal.tar.gz");
    const tarGz = createTestTar([
      { name: "nexus/", typeflag: "5" },
      { name: "nexus/bin/nexus", content: "#!/bin/sh\n" },
      { name: "nexus/../../etc/cron.d/pwn", content: "* * * * * root reboot\n" },
    ]);
    fs.writeFileSync(maliciousTar, tarGz);

    const validation = await validateTarArchive(maliciousTar);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((e) => e.includes("forbidden") || e.includes("not contained")));

    const dest = path.join(tmpRoot, "unpack-dest");
    await assert.rejects(
      safeExtractTar(maliciousTar, dest),
      /failed structural safety inspection/
    );
  });

  it("rejects oversized PAX metadata before retaining or parsing it", async () => {
    const archive = path.join(tmpRoot, "oversized-pax.tar.gz");
    fs.writeFileSync(archive, createTestTar([
      // The payload is intentionally absent. The validator must reject its
      // oversized declaration from the header without waiting for allocation.
      { name: "PaxHeader", typeflag: "x", declaredSize: 1024 * 1024 * 1024 },
    ]));
    const result = await validateTarArchive(archive);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes("PAX metadata exceeds safety limit")));
  });

  it("keeps global PAX link overrides active across later entries", async () => {
    const archive = path.join(tmpRoot, "global-pax.tar.gz");
    fs.writeFileSync(archive, createTestTar([
      { name: "GlobalHead", typeflag: "g", content: paxRecord("linkpath", "../../safe") },
      // The same global target resolves inside nexus for this deep link.
      { name: "nexus/a/b/deep-link", typeflag: "2", linkname: "raw-safe" },
      // It escapes nexus for this shallow link and must still be applied.
      { name: "nexus/shallow-link", typeflag: "2", linkname: "raw-safe" },
    ]));
    const result = await validateTarArchive(archive);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes("escapes")));
  });

  it("rejects local and global PAX size overrides that diverge from extraction accounting", async () => {
    for (const typeflag of ["x", "g"]) {
      const archive = path.join(tmpRoot, `pax-size-override-${typeflag}.tar.gz`);
      fs.writeFileSync(archive, createTestTar([
        { name: "PaxHeader", typeflag, content: paxRecord("size", "0") },
        { name: "nexus/VERSION", content: "1.0.0\n" },
      ]));
      const result = await validateTarArchive(archive);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((error) => error.includes("unsupported extraction-affecting key 'size'")));
    }
  });

  it("rejects malicious tar archive with escaping symlink", async () => {
    const symlinkTar = path.join(tmpRoot, "symlink-escape.tar.gz");
    const tarGz = createTestTar([
      { name: "nexus/", typeflag: "5" },
      { name: "nexus/bin/", typeflag: "5" },
      { name: "nexus/bin/evil-link", typeflag: "2", linkname: "../../../../../etc/passwd" },
    ]);
    fs.writeFileSync(symlinkTar, tarGz);

    const validation = await validateTarArchive(symlinkTar);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((e) => e.includes("escapes")));
  });

  it("rejects archive containing disallowed entry types (FIFOs, devices, hardlinks)", async () => {
    const fifoTar = path.join(tmpRoot, "fifo.tar.gz");
    const tarGz = createTestTar([
      { name: "nexus/", typeflag: "5" },
      { name: "nexus/dev-pipe", typeflag: "6" }, // FIFO
    ]);
    fs.writeFileSync(fifoTar, tarGz);

    const validation = await validateTarArchive(fifoTar);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((e) => e.includes("Disallowed archive entry type")));
  });

  it("rejects archive with duplicate entries", async () => {
    const dupTar = path.join(tmpRoot, "dup.tar.gz");
    const tarGz = createTestTar([
      { name: "nexus/", typeflag: "5" },
      { name: "nexus/VERSION", content: "1.0.0\n" },
      { name: "nexus/VERSION", content: "2.0.0\n" },
    ]);
    fs.writeFileSync(dupTar, tarGz);

    const validation = await validateTarArchive(dupTar);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((e) => e.includes("Duplicate archive entry")));
  });

  it("safely extracts valid archive and validates containment walk", async () => {
    const validTar = path.join(tmpRoot, "valid.tar.gz");
    const tarGz = createTestTar([
      { name: "nexus/", typeflag: "5" },
      { name: "nexus/VERSION", content: "1.0.0\n" },
      { name: "nexus/bin/", typeflag: "5" },
      { name: "nexus/bin/nexus", content: "#!/bin/sh\necho ok\n" },
      { name: "nexus/bin/nexus-link", typeflag: "2", linkname: "nexus" },
      { name: "nexus/lib/", typeflag: "5" },
      { name: "nexus/lib/core/", typeflag: "5" },
      { name: "nexus/lib/core/harness-core", content: "#!/bin/sh\nexit 0\n" },
      { name: "nexus/lib/core/nexus-tui", content: "#!/bin/sh\nexit 0\n" },
    ]);
    fs.writeFileSync(validTar, tarGz);

    const dest = path.join(tmpRoot, "unpack-valid");
    const result = await safeExtractTar(validTar, dest);
    assert.ok(fs.existsSync(path.join(result.extractedDir, "VERSION")));
    assert.ok(fs.existsSync(path.join(result.extractedDir, "bin", "nexus")));
    assert.ok(fs.existsSync(path.join(result.extractedDir, "bin", "nexus-link")));
    assert.ok(fs.existsSync(path.join(result.extractedDir, "lib", "core", "harness-core")));
    assert.ok(fs.existsSync(path.join(result.extractedDir, "lib", "core", "nexus-tui")));
  });
});

describe("Pre-Migration Backups & Migration/Downgrade Safety (REQ-REL-116, ACC-UPG-09)", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-home-test-"));
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("creates protected config and state backups with 0600 file and 0700 dir permissions", () => {
    // Setup existing config.env
    const configDir = path.join(homeDir, ".config", "nexus");
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const configEnv = path.join(configDir, "config.env");
    fs.writeFileSync(configEnv, "SECRET_KEY=supersecret123\nNEXUS_MODEL=test-model\n", { mode: 0o600 });

    // Setup existing session state
    const stateDir = path.join(homeDir, ".nexus", "sessions");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, "index.json"), JSON.stringify({ sessions: ["s1", "s2"] }), { mode: 0o600 });

    const backup = createPreMigrationBackup(homeDir);
    assert.ok(backup.configBackupPath);
    assert.ok(fs.existsSync(backup.configBackupPath));

    // Verify backup file mode is 0600
    const fileStat = fs.statSync(backup.configBackupPath);
    assert.equal(fileStat.mode & 0o777, 0o600);

    // Verify backup dir mode is 0700
    const dirStat = fs.statSync(path.dirname(backup.configBackupPath));
    assert.equal(dirStat.mode & 0o777, 0o700);

    // Verify content preserved exactly
    const content = fs.readFileSync(backup.configBackupPath, "utf8");
    assert.ok(content.includes("SECRET_KEY=supersecret123"));

    // Verify state backup
    assert.ok(backup.stateBackupDir);
    const stateIndex = path.join(backup.stateBackupDir, "state", "sessions", "index.json");
    assert.ok(fs.existsSync(stateIndex));
    assert.equal(fs.statSync(stateIndex).mode & 0o777, 0o600);
  });

  it("restores configuration cleanly from backup with strict 0600 permissions", () => {
    const configDir = path.join(homeDir, ".config", "nexus");
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const configEnv = path.join(configDir, "config.env");
    fs.writeFileSync(configEnv, "OLD_CONFIG=yes\n", { mode: 0o600 });

    const backupFile = path.join(homeDir, ".config", "nexus", "backups", "config.env.bak.fixture");
    fs.mkdirSync(path.dirname(backupFile), { recursive:true });
    fs.writeFileSync(backupFile, "RESTORED_CONFIG=success\n", { mode: 0o600 });

    const restored = restoreConfigBackup(backupFile, homeDir);
    assert.equal(restored, true);

    const content = fs.readFileSync(configEnv, "utf8");
    assert.equal(content, "RESTORED_CONFIG=success\n");
    assert.equal(fs.statSync(configEnv).mode & 0o777, 0o600);
  });
});

describe("Machine-Readable Compatibility & Downgrade State Rejection (REQ-REL-116, ACC-UPG-07)", () => {
  it("validates and generates valid compatibility metadata", () => {
    const meta = generateCompatibilityMetadata("1.0.0", "abcdef1234567890");
    const check = validateCompatibilityMetadata(meta);
    assert.equal(check.valid, true);
    assert.equal(check.errors.length, 0);
    assert.equal(meta.compatibility.stateSchemaVersion, CURRENT_STATE_SCHEMA_VERSION);
    assert.equal(validateCompatibilityMetadata({ ...meta, schemaVersion: 2 }).valid, false, "future metadata schemas fail closed");
  });

  it("package validator rejects unsupported compatibility schemas", () => {
    const metadata = generateCompatibilityMetadata("1.0.0", "abcdef1234567890");
    metadata.schemaVersion = 2;
    const fixture = path.join(os.tmpdir(), `nexus-compatibility-schema-${process.pid}.json`);
    fs.writeFileSync(fixture, `${JSON.stringify(metadata)}\n`);
    try {
      const validator = fileURLToPath(new URL("../../scripts/validate_compatibility.mjs", import.meta.url));
      const result = spawnSync(process.execPath, [validator, fixture], { encoding: "utf8" });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Unsupported schemaVersion; expected 1/);
    } finally {
      fs.rmSync(fixture, { force: true });
    }
  });

  it("rejects malformed compatibility metadata", () => {
    const bad1: any = { product: "wrong-product" };
    assert.equal(validateCompatibilityMetadata(bad1).valid, false);

    const bad2: any = {
      product: "nexus-code",
      version: "1.0.0",
      compatibility: { stateSchemaVersion: "not-a-number" },
    };
    assert.equal(validateCompatibilityMetadata(bad2).valid, false);
  });

  it("refuses downgrade when target release state schema is older than current state schema", () => {
    const targetMeta: ReleaseCompatibilityMetadata = {
      schemaVersion: 1,
      product: "nexus-code",
      version: "0.0.9",
      revision: "rev1",
      builtAt: new Date().toISOString(),
      components: { cli: "0.0.9", core: "0.0.9", tui: "0.0.9", harness: "0.0.9" },
      compatibility: {
        configSchemaVersion: 1,
        stateSchemaVersion: 0, // older schema cannot read version 1 state!
        minSupportedConfigVersion: 1,
        minSupportedStateVersion: 0,
      },
      platforms: {
        "linux-x86_64": {
          archive: "nexus-linux-x86_64-v0.0.9.tar.gz",
          os: "linux",
          arch: "x86_64",
        },
      },
    };

    const currentStateSchema = 1;
    const compatResult = checkReleaseCompatibility("1.0.0", currentStateSchema, targetMeta);
    assert.equal(compatResult.compatible, false);
    assert.ok(compatResult.reasons.some((r) => r.includes("cannot read current state schema version")));
  });

  it("enforces minimum supported config and state schema versions", () => {
    const targetMeta = generateCompatibilityMetadata("1.0.0", "abcdef1234567890");
    targetMeta.compatibility.minSupportedConfigVersion = 2;
    targetMeta.compatibility.configSchemaVersion = 2;
    targetMeta.compatibility.minSupportedStateVersion = 2;
    targetMeta.compatibility.stateSchemaVersion = 2;

    const result = checkReleaseCompatibility("1.0.0", 1, targetMeta, "linux-x86_64", 1);
    assert.equal(result.compatible, false);
    assert.ok(result.reasons.some((reason) => reason.includes("requires config schema version 2")));
    assert.ok(result.reasons.some((reason) => reason.includes("requires state schema version 2")));
  });

  it("compares minimum updater versions using full SemVer prerelease ordering", () => {
    const targetMeta = generateCompatibilityMetadata("1.0.0", "abcdef1234567890");
    targetMeta.minimumUpdaterVersion = "0.1.0-alpha.2";

    const older = checkReleaseCompatibility("0.1.0-alpha.1", 1, targetMeta);
    const newerPrerelease = checkReleaseCompatibility("0.1.0-alpha.10", 1, targetMeta);
    const stable = checkReleaseCompatibility("0.1.0", 1, targetMeta);
    assert.equal(older.compatible, false);
    assert.equal(newerPrerelease.compatible, true);
    assert.equal(stable.compatible, true);

    targetMeta.minimumUpdaterVersion = "0.1.0-alpha.01";
    assert.equal(validateCompatibilityMetadata(targetMeta).valid, false, "numeric SemVer prerelease identifiers cannot have leading zeroes");

    targetMeta.minimumUpdaterVersion = "not-semver";
    assert.equal(validateCompatibilityMetadata(targetMeta).valid, false);
  });

  it("rejects a target config schema older than the current config schema", () => {
    const targetMeta = generateCompatibilityMetadata("1.0.0", "abcdef1234567890");
    const result = checkReleaseCompatibility("1.0.0", 1, targetMeta, "linux-x86_64", 2);
    assert.equal(result.compatible, false);
    assert.ok(result.reasons.some((reason) => reason.includes("cannot read current config schema version 2")));
  });

  it("applies legacy policy for releases lacking compatibility metadata", () => {
    const compatResult = checkReleaseCompatibility("1.0.0", 1, null, "linux-x86_64", 1, "v0.1.0-alpha.2");
    assert.equal(compatResult.compatible, true);
    assert.equal(compatResult.isLegacy, true);
    assert.ok(compatResult.reasons[0].includes("legacy compatibility policy"));
  });
});

describe("Durable Provenance & Package-Manager Protection (REQ-REL-116, ACC-UPG-10)", () => {
  let tmpPrefix: string;

  beforeEach(() => {
    tmpPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-prov-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpPrefix, { recursive: true, force: true });
  });

  it("writes and reads durable installation provenance record", () => {
    const versionDir = path.join(tmpPrefix, "lib", "nexus", "1.0.0");
    fs.mkdirSync(path.join(versionDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(versionDir, "VERSION"), "1.0.0\n");

    const record: ProvenanceRecord = {
      formatVersion: 1,
      method: "upgrade",
      product: "nexus-code",
      version: "1.0.0",
      revision: "abc1234",
      builtAt: "2026-10-18T12:00:00Z",
      prefix: tmpPrefix,
      installedPath: versionDir,
      binPath: path.join(tmpPrefix, "bin", "nexus"),
      managed: true,
    };

    writeProvenance(versionDir, record);
    const provFile = path.join(versionDir, ".provenance.json");
    assert.ok(fs.existsSync(provFile));
    assert.equal(fs.statSync(provFile).mode & 0o777, 0o644);

    const detected = detectInstallation({ nexusHome: versionDir });
    assert.equal(detected.provenance, "packaged");
    assert.ok(detected.detail?.includes("verified provenance"));
  });

  it("detects package-manager installations and blocks self-upgrade", () => {
    const versionDir = path.join(tmpPrefix, "lib", "nexus", "1.0.0");
    fs.mkdirSync(path.join(versionDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(versionDir, "VERSION"), "1.0.0\n");

    const record: ProvenanceRecord = {
      formatVersion: 1,
      method: "packaged",
      product: "nexus-code",
      version: "1.0.0",
      prefix: tmpPrefix,
      installedPath: versionDir,
      binPath: path.join(tmpPrefix, "bin", "nexus"),
      managed: false,
      packageManager: "apt",
    };
    writeProvenance(versionDir, record);

    const detected = detectInstallation({ nexusHome: versionDir });
    assert.equal(detected.provenance, "package-manager");
    assert.ok(detected.detail?.includes("Installed via package manager (apt)"));

    const comparison = compareInstallationWithRelease(detected, {
      tag_name: "v1.1.0",
      draft: false,
      prerelease: false,
      assets: [],
    });

    assert.equal(comparison.canUpgrade, false);
    assert.ok(comparison.reasons.some((r) => r.includes("package manager")));
  });
});

describe("Upgrade Journal, Crash Recovery & PATH Shadowing (REQ-REL-116, ACC-UPG-11, ACC-UPG-12)", () => {
  let tmpPrefix: string;

  beforeEach(() => {
    tmpPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-journal-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpPrefix, { recursive: true, force: true });
  });

  it("recovers an interrupted upgrade that crashed during downloading or staging", () => {
    const libNexus = path.join(tmpPrefix, "lib", "nexus");
    const binDir = path.join(tmpPrefix, "bin");
    fs.mkdirSync(libNexus, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    const v1Dir = path.join(libNexus, "v1.0.0");
    fs.mkdirSync(path.join(v1Dir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(v1Dir, "VERSION"), "1.0.0\n");
    const v1Bin = path.join(v1Dir, "bin", "nexus");
    fs.writeFileSync(v1Bin, "#!/bin/sh\necho v1.0.0\n", { mode: 0o755 });

    const binNexus = path.join(binDir, "nexus");
    fs.symlinkSync(v1Bin, binNexus);

    // Simulated abandoned staging dir
    const stagingDir = path.join(libNexus, ".tmp-upgrade-12345");
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, "partial.bin"), "corrupt");

    // Write journal indicating crash at "downloading"
    const entry: UpgradeJournalEntry = {
      formatVersion: 1,
      id: "test-crash-1",
      state: "downloading",
      sourceVersion: "v1.0.0",
      sourceInstallDir: v1Dir,
      sourceSymlinkTarget: v1Bin,
      targetVersion: "v1.1.0",
      targetInstallDir: path.join(libNexus, "v1.1.0"),
      stagingDir,
      prefix: tmpPrefix,
      binPath: binNexus,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    completeRuntimeFixture(v1Dir, "v1.0.0");
    writeJournal(tmpPrefix, entry);

    const outcome = recoverUpgrade(tmpPrefix);
    assert.equal(outcome.recovered, true);
    assert.equal(outcome.action, "cleaned_up");
    assert.equal(fs.existsSync(stagingDir), false); // cleaned up
    assert.equal(fs.realpathSync(binNexus), fs.realpathSync(v1Bin)); // symlink retained
  });

  it("fails closed without deleting paths named by a malicious journal", () => {
    const outside = path.join(tmpPrefix, "outside-canary");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "must survive");
    const entry: UpgradeJournalEntry = {
      formatVersion: 1,
      id: "hostile-path",
      state: "downloading",
      sourceVersion: "v1.0.0",
      sourceInstallDir: outside,
      sourceSymlinkTarget: path.join(outside, "bin", "nexus"),
      targetVersion: "v1.1.0",
      targetInstallDir: path.join(tmpPrefix, "lib", "nexus", "v1.1.0"),
      stagingDir: outside,
      prefix: tmpPrefix,
      binPath: path.join(tmpPrefix, "bin", "nexus"),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeJournal(tmpPrefix, entry);
    const outcome = recoverUpgrade(tmpPrefix);
    assert.equal(outcome.recovered, false);
    assert.match(outcome.details, /validation/);
    assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "must survive");
  });

  it("rejects a staging path whose apparent parent is redirected by a symlink", () => {
    const outsideRoot = path.join(tmpPrefix, "external");
    const outsideLib = path.join(outsideRoot, "nexus");
    const outsideStage = path.join(outsideLib, ".tmp-upgrade-escape");
    fs.mkdirSync(outsideStage, { recursive: true });
    fs.writeFileSync(path.join(outsideStage, "canary"), "must survive");
    fs.mkdirSync(path.join(tmpPrefix, "lib"), { recursive: true });
    fs.symlinkSync(outsideLib, path.join(tmpPrefix, "lib", "nexus"));
    const entry: UpgradeJournalEntry = {
      formatVersion: 1,
      id: "symlink-parent",
      state: "downloading",
      sourceVersion: "v1.0.0",
      sourceInstallDir: path.join(tmpPrefix, "lib", "nexus", "v1.0.0"),
      sourceSymlinkTarget: path.join(tmpPrefix, "lib", "nexus", "v1.0.0", "bin", "nexus"),
      targetVersion: "v1.1.0",
      targetInstallDir: path.join(tmpPrefix, "lib", "nexus", "v1.1.0"),
      stagingDir: path.join(tmpPrefix, "lib", "nexus", ".tmp-upgrade-escape"),
      prefix: tmpPrefix,
      binPath: path.join(tmpPrefix, "bin", "nexus"),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeJournal(tmpPrefix, entry);
    const outcome = recoverUpgrade(tmpPrefix);
    assert.equal(outcome.recovered, false);
    assert.match(outcome.details, /validation|real contained directories/);
    assert.equal(fs.readFileSync(path.join(outsideStage, "canary"), "utf8"), "must survive");
  });

  it("accepts backup paths under HOME with a custom installation prefix", () => {
    const previousHome = process.env.HOME;
    const home = path.join(tmpPrefix, "custom-home");
    process.env.HOME = home;
    try {
      const entry: UpgradeJournalEntry = {
        formatVersion: 1,
        id: "custom-prefix-backups",
        state: "downloading",
        sourceVersion: "v1.0.0",
        sourceInstallDir: path.join(tmpPrefix, "lib", "nexus", "v1.0.0"),
        sourceSymlinkTarget: path.join(tmpPrefix, "lib", "nexus", "v1.0.0", "bin", "nexus"),
        targetVersion: "v1.1.0",
        targetInstallDir: path.join(tmpPrefix, "lib", "nexus", "v1.1.0"),
        prefix: tmpPrefix,
        binPath: path.join(tmpPrefix, "bin", "nexus"),
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        configBackupPath: path.join(home, ".config", "nexus", "backups", "config.env.bak.2026-10-18T00-00-00-000Z"),
        stateBackupDir: path.join(home, ".nexus", "backups", "state-backup-2026-10-18T00-00-00-000Z"),
      };
      writeJournal(tmpPrefix, entry);
      assert.equal(readJournal(tmpPrefix)?.id, entry.id);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("never executes a target binary redirected outside its version directory", () => {
    const libNexus = path.join(tmpPrefix, "lib", "nexus");
    const binDir = path.join(tmpPrefix, "bin");
    const sourceDir = path.join(libNexus, "v1.0.0");
    const targetDir = path.join(libNexus, "v1.1.0");
    const outside = path.join(tmpPrefix, "outside-executable");
    const canary = path.join(tmpPrefix, "executed-canary");
    fs.mkdirSync(path.join(sourceDir, "bin"), { recursive: true });
    fs.mkdirSync(path.join(targetDir, "bin"), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    const sourceExecutable = path.join(sourceDir, "bin", "nexus");
    completeRuntimeFixture(sourceDir, "v1.0.0");
    fs.writeFileSync(outside, `#!/bin/sh\nprintf executed > '${canary}'\nexit 0\n`, { mode: 0o755 });
    fs.symlinkSync(outside, path.join(targetDir, "bin", "nexus"));
    const binPath = path.join(binDir, "nexus");
    fs.symlinkSync(path.join(targetDir, "bin", "nexus"), binPath);
    writeJournal(tmpPrefix, {
      formatVersion: 1,
      id: "external-target-binary",
      state: "switched",
      sourceVersion: "v1.0.0",
      sourceInstallDir: sourceDir,
      sourceSymlinkTarget: sourceExecutable,
      targetVersion: "v1.1.0",
      targetInstallDir: targetDir,
      prefix: tmpPrefix,
      binPath,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const outcome = recoverUpgrade(tmpPrefix);
    assert.equal(outcome.action, "rolled_back");
    assert.equal(fs.existsSync(canary), false);
    assert.equal(fs.realpathSync(binPath), fs.realpathSync(sourceExecutable));
  });

  it("does not repoint the launcher to an external source symlink during early recovery", () => {
    const libNexus = path.join(tmpPrefix, "lib", "nexus");
    const sourceDir = path.join(libNexus, "v1.0.0");
    const binDir = path.join(tmpPrefix, "bin");
    const outside = path.join(tmpPrefix, "outside-source");
    const current = path.join(tmpPrefix, "current-launcher");
    fs.mkdirSync(path.join(sourceDir, "bin"), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(outside, "outside executable", { mode: 0o755 });
    fs.writeFileSync(current, "current launcher", { mode: 0o755 });
    const sourceExecutable = path.join(sourceDir, "bin", "nexus");
    fs.symlinkSync(outside, sourceExecutable);
    const binPath = path.join(binDir, "nexus");
    fs.symlinkSync(current, binPath);
    writeJournal(tmpPrefix, {
      formatVersion: 1,
      id: "early-external-source",
      state: "downloading",
      sourceVersion: "v1.0.0",
      sourceInstallDir: sourceDir,
      sourceSymlinkTarget: sourceExecutable,
      targetVersion: "v1.1.0",
      targetInstallDir: path.join(libNexus, "v1.1.0"),
      prefix: tmpPrefix,
      binPath,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const outcome = recoverUpgrade(tmpPrefix);
    assert.equal(outcome.recovered, false);
    assert.match(outcome.details, /source launcher/);
    assert.equal(fs.readlinkSync(binPath), current);
  });

  it("rolls back when a contained target launcher exits unsuccessfully", () => {
    const libNexus = path.join(tmpPrefix, "lib", "nexus");
    const binDir = path.join(tmpPrefix, "bin");
    const sourceDir = path.join(libNexus, "v1.0.0");
    const targetDir = path.join(libNexus, "v1.1.0");
    fs.mkdirSync(path.join(sourceDir, "bin"), { recursive: true });
    fs.mkdirSync(path.join(targetDir, "bin"), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    const sourceExecutable = path.join(sourceDir, "bin", "nexus");
    const targetExecutable = path.join(targetDir, "bin", "nexus");
    completeRuntimeFixture(sourceDir, "v1.0.0");
    fs.writeFileSync(targetExecutable, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const binPath = path.join(binDir, "nexus");
    fs.symlinkSync(targetExecutable, binPath);
    writeJournal(tmpPrefix, {
      formatVersion: 1,
      id: "failed-target-launcher",
      state: "switched",
      sourceVersion: "v1.0.0",
      sourceInstallDir: sourceDir,
      sourceSymlinkTarget: sourceExecutable,
      targetVersion: "v1.1.0",
      targetInstallDir: targetDir,
      prefix: tmpPrefix,
      binPath,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const outcome = recoverUpgrade(tmpPrefix);
    assert.equal(outcome.action, "rolled_back");
    assert.equal(fs.realpathSync(binPath), fs.realpathSync(sourceExecutable));
  });

  it("recovers a crash during switching by reverting symlink to source installation", () => {
    const libNexus = path.join(tmpPrefix, "lib", "nexus");
    const binDir = path.join(tmpPrefix, "bin");
    fs.mkdirSync(libNexus, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    const v1Dir = path.join(libNexus, "v1.0.0");
    fs.mkdirSync(path.join(v1Dir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(v1Dir, "VERSION"), "1.0.0\n");
    const v1Bin = path.join(v1Dir, "bin", "nexus");
    fs.writeFileSync(v1Bin, "#!/bin/sh\necho v1.0.0\n", { mode: 0o755 });

    // Incomplete target directory (e.g. missing executable or failed test)
    const v2Dir = path.join(libNexus, "v2.0.0");
    fs.mkdirSync(v2Dir, { recursive: true });

    const binNexus = path.join(binDir, "nexus");
    // Broken link
    fs.symlinkSync(path.join(v2Dir, "bin", "nexus"), binNexus);

    const entry: UpgradeJournalEntry = {
      formatVersion: 1,
      id: "test-crash-2",
      state: "switching",
      sourceVersion: "v1.0.0",
      sourceInstallDir: v1Dir,
      sourceSymlinkTarget: v1Bin,
      targetVersion: "v2.0.0",
      targetInstallDir: v2Dir,
      prefix: tmpPrefix,
      binPath: binNexus,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    completeRuntimeFixture(v1Dir, "v1.0.0");
    writeJournal(tmpPrefix, entry);

    const outcome = recoverUpgrade(tmpPrefix);
    assert.equal(outcome.recovered, true);
    assert.equal(outcome.action, "rolled_back");
    assert.equal(fs.realpathSync(binNexus), fs.realpathSync(v1Bin));
  });

  it("reverts launcher symlink to previous release with rollbackBinary", () => {
    const libNexus = path.join(tmpPrefix, "lib", "nexus");
    const binDir = path.join(tmpPrefix, "bin");
    fs.mkdirSync(libNexus, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    // Older version v1.0.0
    const v1Dir = path.join(libNexus, "v1.0.0");
    fs.mkdirSync(path.join(v1Dir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(v1Dir, "bin", "nexus"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    // Current version v1.1.0
    const v2Dir = path.join(libNexus, "v1.1.0");
    fs.mkdirSync(path.join(v2Dir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(v2Dir, "bin", "nexus"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const binNexus = path.join(binDir, "nexus");
    fs.symlinkSync(path.join(v2Dir, "bin", "nexus"), binNexus);

    completeRuntimeFixture(v1Dir, "v1.0.0");
    completeRuntimeFixture(v2Dir, "v1.1.0");
    const res = rollbackBinary(tmpPrefix);
    assert.equal(res.success, true);
    assert.equal(res.revertedTo, "v1.0.0");
    assert.equal(fs.realpathSync(binNexus), fs.realpathSync(path.join(v1Dir, "bin", "nexus")));
  });

  it("detects PATH shadowing when another nexus executable precedes prefix bin in PATH", () => {
    const fakeSysBin = path.join(tmpPrefix, "fake-usr-bin");
    const ourBin = path.join(tmpPrefix, "our-bin");
    fs.mkdirSync(fakeSysBin, { recursive: true });
    fs.mkdirSync(ourBin, { recursive: true });

    // Put a shadowing executable in fakeSysBin
    const shadowBin = path.join(fakeSysBin, "nexus");
    fs.writeFileSync(shadowBin, "#!/bin/sh\necho old\n", { mode: 0o755 });

    const oldPath = process.env.PATH;
    try {
      process.env.PATH = `${fakeSysBin}:${ourBin}:/usr/bin:/bin`;
      const check = detectPathShadowing(ourBin);
      assert.equal(check.shadowed, true);
      assert.equal(check.precedingPaths[0], shadowBin);

      // Now test when ourBin is first:
      process.env.PATH = `${ourBin}:${fakeSysBin}:/usr/bin:/bin`;
      const check2 = detectPathShadowing(ourBin);
      assert.equal(check2.shadowed, false);
    } finally {
      process.env.PATH = oldPath;
    }
  });
});
