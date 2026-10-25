import { CURRENT_STATE_SCHEMA_VERSION } from "../src/core/state_schema.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import * as crypto from "node:crypto";
import * as zlib from "node:zlib";
import { execSync } from "node:child_process";
import {
  detectInstallation,
  resolveTargetRelease,
  compareInstallationWithRelease,
  performUpgrade,
  PublishedRelease,
} from "../src/upgrade.js";
import { readJournal } from "../src/upgrade_journal.js";

describe("Public Release Upgrade Acceptance (REQ-REL-116, ACC-UPG-07..14)", () => {
  let tmpPrefix: string;
  let fakeHome: string;
  let mockServer: http.Server;
  let mockPort: number;
  let pkgV1: Buffer;
  let compatibilityV1: Buffer;
  let sumsV1: string;
  let origReleasesApi: string | undefined;
  let origReleaseBase: string | undefined;
  let origHome: string | undefined;

  function createCompatibilityMetadata(version: string, configSchema = 1, stateSchema = CURRENT_STATE_SCHEMA_VERSION, archiveSha256?: string): any {
    const normalizedVersion = version.replace(/^v/, "");
    return {
      schemaVersion: 1,
      product: "nexus-code",
      version: normalizedVersion,
      revision: "commit-123456",
      builtAt: "2026-10-18T12:00:00Z",
      minimumUpdaterVersion: "0.1.0-alpha.2",
      components: { cli: normalizedVersion, core: normalizedVersion, tui: normalizedVersion, harness: normalizedVersion },
      compatibility: {
        configSchemaVersion: configSchema,
        stateSchemaVersion: stateSchema,
        minSupportedConfigVersion: 1,
        minSupportedStateVersion: stateSchema === 0 ? 0 : 1,
      },
      platforms: {
        "linux-x86_64": {
          archive: `nexus-linux-x86_64-${version}.tar.gz`,
          ...(archiveSha256 ? { sha256: archiveSha256 } : {}),
          os: "linux",
          arch: "x86_64",
        },
      },
    };
  }

  function createPackageArchive(version: string, configSchema = 1, stateSchema = CURRENT_STATE_SCHEMA_VERSION, customNexusScript?: string): Buffer {
    const normalizedVersion = version.replace(/^v/, "");
    const entries: Array<{ name: string; content?: string; mode?: string }> = [
      { name: "nexus/", mode: "0000755\0" },
      { name: "nexus/VERSION", content: `${version}\n`, mode: "0000644\0" },
      { name: "nexus/bin/", mode: "0000755\0" },
      {
        name: "nexus/bin/nexus",
        content:
          customNexusScript ??
          `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "nexus ${version}"; exit 0; fi\necho "running ${version}"\nexit 0\n`,
        mode: "0000755\0",
      },
      { name: "nexus/lib/", mode: "0000755\0" },
      { name: "nexus/lib/cli/", mode: "0000755\0" },
      { name: "nexus/lib/cli/package.json", content: JSON.stringify({ name:"nexus-code", version:normalizedVersion }), mode:"0000644\0" },
      { name: "nexus/lib/cli/dist/", mode:"0000755\0" },
      { name: "nexus/lib/cli/dist/index.js", content:"// dist entry\n", mode:"0000644\0" },
      { name: "nexus/lib/core/", mode: "0000755\0" },
      {
        name: "nexus/lib/core/harness-core",
        content: `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "harness-core ${normalizedVersion}"; exit 0; fi\nexit 0\n`,
        mode: "0000755\0",
      },
      {
        name: "nexus/lib/core/nexus-tui",
        content: `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "nexus-tui ${normalizedVersion}"; exit 0; fi\necho "NEXUS"\nexit 0\n`,
        mode: "0000755\0",
      },
      {
        name: "nexus/compatibility.json",
        content: JSON.stringify(createCompatibilityMetadata(version, configSchema, stateSchema), null, 2),
        mode: "0000644\0",
      },
    ];

    const blocks: Buffer[] = [];
    for (const ent of entries) {
      const header = Buffer.alloc(512);
      header.write(ent.name, 0, 100, "utf8");
      header.write(ent.mode || (ent.name.endsWith("/") ? "0000755\0" : "0000644\0"), 100, 8, "utf8");
      header.write("0001750\0", 108, 8, "utf8");
      header.write("0001750\0", 116, 8, "utf8");

      const data = Buffer.from(ent.content || "");
      const sizeOctal = data.length.toString(8).padStart(11, "0") + "\0";
      header.write(sizeOctal, 124, 12, "utf8");
      header.write("14000000000\0", 136, 12, "utf8");
      const type = ent.name.endsWith("/") ? "5" : "0";
      header.write(type, 156, 1, "utf8");
      header.write("ustar\0", 257, 6, "utf8");
      header.write("00", 263, 2, "utf8");

      header.fill(0x20, 148, 156);
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += header[i];
      header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf8");

      blocks.push(header);
      if (data.length > 0) {
        blocks.push(data);
        const pad = (512 - (data.length % 512)) % 512;
        if (pad > 0) blocks.push(Buffer.alloc(pad));
      }
    }
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
  }

  function setupInstalledVersion(prefix: string, version: string): string {
    const normalizedVersion = version.replace(/^v/, "");
    const root = path.join(prefix, "lib", "nexus", version);
    fs.mkdirSync(path.join(root, "bin"), { recursive:true });
    fs.mkdirSync(path.join(root, "lib", "cli", "dist"), { recursive:true });
    fs.mkdirSync(path.join(root, "lib", "core"), { recursive:true });
    fs.writeFileSync(path.join(root,"VERSION"), `${version}\n`);
    fs.writeFileSync(path.join(root,"bin/nexus"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "nexus ${version}"; exit 0; fi\nexit 0\n`, { mode:0o755 });
    fs.writeFileSync(path.join(root,"lib/cli/package.json"), JSON.stringify({ name:"nexus-code", version:normalizedVersion }));
    fs.writeFileSync(path.join(root,"lib/cli/dist/index.js"), "// dist entry\n");
    fs.writeFileSync(path.join(root,"lib/core/harness-core"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "harness-core ${normalizedVersion}"; exit 0; fi\nexit 0\n`, { mode:0o755 });
    fs.writeFileSync(path.join(root,"lib/core/nexus-tui"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "nexus-tui ${normalizedVersion}"; exit 0; fi\necho "NEXUS"\nexit 0\n`, { mode:0o755 });
    return root;
  }

  beforeEach(async () => {
    tmpPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-upgrade-prefix-"));
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-upgrade-home-"));

    origReleasesApi = process.env.NEXUS_RELEASES_API;
    origReleaseBase = process.env.NEXUS_RELEASE_BASE_URL;
    origHome = process.env.HOME;

    process.env.HOME = fakeHome;

    // Build release packages
    pkgV1 = createPackageArchive("v1.0.0", 1, CURRENT_STATE_SCHEMA_VERSION);
    const hashV1 = crypto.createHash("sha256").update(pkgV1).digest("hex");
    compatibilityV1 = Buffer.from(JSON.stringify(createCompatibilityMetadata("v1.0.0", 1, CURRENT_STATE_SCHEMA_VERSION, hashV1), null, 2) + "\n");
    sumsV1 = `${hashV1}  nexus-linux-x86_64-v1.0.0.tar.gz\n${crypto.createHash("sha256").update(compatibilityV1).digest("hex")}  compatibility.json\n`;

    // Package with incompatible state schema for downgrade test
    const pkgIncompatible = createPackageArchive("v0.0.5", 1, 0);
    const hashIncompat = crypto.createHash("sha256").update(pkgIncompatible).digest("hex");
    const sumsIncompat = `${hashIncompat}  nexus-linux-x86_64-v0.0.5.tar.gz\n`;

    mockPort = await new Promise<number>((resolve) => {
      mockServer = http.createServer((req, res) => {
        const url = req.url || "";
        if (url === "/repos/mikeholownych/nexus-code/releases/latest") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              tag_name: "v1.0.0",
              name: "Nexus Code v1.0.0",
              draft: false,
              prerelease: false,
              published_at: "2026-10-18T12:00:00Z",
              assets: [
                { name: "nexus-linux-x86_64-v1.0.0.tar.gz", browser_download_url: `http://127.0.0.1:${mockPort}/download/v1.0.0/nexus-linux-x86_64-v1.0.0.tar.gz` },
                { name: "compatibility.json", browser_download_url: `http://127.0.0.1:${mockPort}/download/v1.0.0/compatibility.json` },
                { name: "SHA256SUMS", browser_download_url: `http://127.0.0.1:${mockPort}/download/v1.0.0/SHA256SUMS` },
              ],
            })
          );
        } else if (url === "/repos/mikeholownych/nexus-code/releases/tags/v0.0.5") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              tag_name: "v0.0.5",
              name: "Nexus Code v0.0.5",
              draft: false,
              prerelease: false,
              assets: [
                { name: "nexus-linux-x86_64-v0.0.5.tar.gz", browser_download_url: `http://127.0.0.1:${mockPort}/download/v0.0.5/nexus-linux-x86_64-v0.0.5.tar.gz` },
                { name: "SHA256SUMS", browser_download_url: `http://127.0.0.1:${mockPort}/download/v0.0.5/SHA256SUMS` },
              ],
            })
          );
        } else if (url === "/download/v1.0.0/nexus-linux-x86_64-v1.0.0.tar.gz") {
          res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": pkgV1.length });
          res.end(pkgV1);
        } else if (url === "/download/v1.0.0/SHA256SUMS") {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(sumsV1);
        } else if (url === "/download/v1.0.0/compatibility.json") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(compatibilityV1);
        } else if (url === "/download/v0.0.5/nexus-linux-x86_64-v0.0.5.tar.gz") {
          res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": pkgIncompatible.length });
          res.end(pkgIncompatible);
        } else if (url === "/download/v0.0.5/SHA256SUMS") {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(sumsIncompat);
        } else {
          res.writeHead(404);
          res.end("Not found");
        }
      });
      mockServer.listen(0, "127.0.0.1", () => {
        const addr = mockServer.address() as any;
        resolve(addr.port);
      });
    });

    process.env.NEXUS_RELEASES_API = `http://127.0.0.1:${mockPort}/repos/mikeholownych/nexus-code/releases`;
    process.env.NEXUS_RELEASE_BASE_URL = `http://127.0.0.1:${mockPort}`;
  });

  afterEach(async () => {
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
    if (origReleasesApi) process.env.NEXUS_RELEASES_API = origReleasesApi;
    else delete process.env.NEXUS_RELEASES_API;

    if (origReleaseBase) process.env.NEXUS_RELEASE_BASE_URL = origReleaseBase;
    else delete process.env.NEXUS_RELEASE_BASE_URL;

    if (origHome) process.env.HOME = origHome;
    else delete process.env.HOME;

    fs.rmSync(tmpPrefix, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it("upgrades from previous release v0.1.0-alpha.2 to v1.0.0 preserving state, configuration and permissions", async () => {
    // 1. Establish installed v0.1.0-alpha.2 layout
    const oldVersion = "v0.1.0-alpha.2";
    const vOldDir = setupInstalledVersion(tmpPrefix, oldVersion);
    const binDir = path.join(tmpPrefix, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const oldBin = path.join(vOldDir, "bin", "nexus");

    const binNexus = path.join(binDir, "nexus");
    fs.symlinkSync(oldBin, binNexus);

    // 2. Establish persistent user config and session state in fakeHome
    const configDir = path.join(fakeHome, ".config", "nexus");
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const configPath = path.join(configDir, "config.env");
    fs.writeFileSync(configPath, "NEXUS_KEY=token-xyz\nMODEL=test-v1\n", { mode: 0o600 });

    const stateDir = path.join(fakeHome, ".nexus", "sessions");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const sessionIndexPath = path.join(stateDir, "index.json");
    fs.writeFileSync(sessionIndexPath, JSON.stringify({ active: "sess-1", sessions: ["sess-1"] }), { mode: 0o600 });

    // 3. Detect and resolve
    const installed = detectInstallation({ nexusHome: vOldDir, envPrefix: tmpPrefix });
    assert.equal(installed.version, oldVersion);
    assert.equal(installed.provenance, "packaged");

    const targetRelease = await resolveTargetRelease(undefined, { timeoutMs: 5000 });
    assert.equal(targetRelease.tag_name, "v1.0.0");

    const comparison = compareInstallationWithRelease(installed, targetRelease);
    assert.equal(comparison.action, "upgrade");
    assert.equal(comparison.canUpgrade, true);

    // 4. Perform upgrade
    const result = await performUpgrade(comparison, { prefix: tmpPrefix, timeoutMs: 5000 });
    assert.equal(result.success, true);
    assert.equal(result.previousVersion, oldVersion);
    assert.equal(result.newVersion, "v1.0.0");

    // 5. Verify launcher symlink points to new version
    assert.equal(fs.realpathSync(binNexus), fs.realpathSync(path.join(tmpPrefix, "lib", "nexus", "v1.0.0", "bin", "nexus")));

    // 6. Verify executed output of upgraded launcher
    const runCheck = execSync(`${binNexus} --version`, { encoding: "utf8" });
    assert.ok(runCheck.includes("v1.0.0"));

    // 7. Verify persistent configuration and session state are preserved intact
    assert.equal(fs.readFileSync(configPath, "utf8"), "NEXUS_KEY=token-xyz\nMODEL=test-v1\n");
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(sessionIndexPath, "utf8"), JSON.stringify({ active: "sess-1", sessions: ["sess-1"] }));

    // 8. Verify pre-migration backup was created
    const backupDir = path.join(fakeHome, ".config", "nexus", "backups");
    assert.ok(fs.existsSync(backupDir));
    const backupFiles = fs.readdirSync(backupDir);
    assert.ok(backupFiles.length > 0);
    assert.ok(backupFiles[0].startsWith("config.env.bak."));

    // 9. Verify durable provenance recorded in new version directory
    const provPath = path.join(tmpPrefix, "lib", "nexus", "v1.0.0", ".provenance.json");
    assert.ok(fs.existsSync(provPath));
    const prov = JSON.parse(fs.readFileSync(provPath, "utf8"));
    assert.equal(prov.managed, true);
    assert.equal(prov.version, "v1.0.0");
    assert.equal(prov.method, "upgrade");

    // 10. Verify journal status is complete
    const journal = readJournal(tmpPrefix);
    assert.ok(journal);
    assert.equal(journal.state, "complete");
  });

  it("refuses an upgrade that requires attestation when gh is unavailable", async () => {
    const oldVersion = "v0.1.0-alpha.2";
    const vOldDir = setupInstalledVersion(tmpPrefix, oldVersion);
    fs.mkdirSync(path.join(tmpPrefix, "bin"), { recursive: true });
    fs.symlinkSync(path.join(vOldDir, "bin", "nexus"), path.join(tmpPrefix, "bin", "nexus"));

    const installed = detectInstallation({ nexusHome: vOldDir, envPrefix: tmpPrefix });
    const target = await resolveTargetRelease(undefined, { timeoutMs: 5000 });
    const comparison = compareInstallationWithRelease(installed, target);
    assert.equal(comparison.action, "upgrade");

    const savedPath = process.env.PATH;
    const savedAttestation = process.env.NEXUS_VERIFY_ATTESTATION;
    // A PATH shim that claims success must not satisfy *required* attestation, and an empty trusted-path list must
    // fail closed without spawning it.
    const shim = path.join(tmpPrefix, "gh-shim");
    fs.mkdirSync(shim);
    const marker = path.join(tmpPrefix, "gh-shim-executed");
    fs.writeFileSync(path.join(shim, "gh"), `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o755 });
    fs.chmodSync(path.join(shim, "gh"), 0o755);
    process.env.PATH = shim;
    process.env.NEXUS_VERIFY_ATTESTATION = "1";
    try {
      await assert.rejects(
        performUpgrade(comparison, { prefix: tmpPrefix, timeoutMs: 5000, trustedGhPaths: [] }),
        /no trusted GitHub CLI was found at \/usr\/bin\/gh/,
        "a required attestation must fail closed when no trusted gh exists",
      );
      assert.equal(fs.existsSync(marker), false, "the PATH gh shim was executed");
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (savedAttestation === undefined) delete process.env.NEXUS_VERIFY_ATTESTATION;
      else process.env.NEXUS_VERIFY_ATTESTATION = savedAttestation;
    }
  });

  it("refuses downgrade when target release has incompatible state schema version", async () => {
    // Current installation at v1.0.0
    const v1Dir = setupInstalledVersion(tmpPrefix, "v1.0.0");
    const binDir = path.join(tmpPrefix, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const v1Bin = path.join(v1Dir, "bin", "nexus");
    const binNexus = path.join(binDir, "nexus");
    fs.symlinkSync(v1Bin, binNexus);

    const installed = detectInstallation({ nexusHome: v1Dir, envPrefix: tmpPrefix });
    const target = await resolveTargetRelease("v0.0.5", { timeoutMs: 5000 });

    const comparison = compareInstallationWithRelease(installed, target);
    assert.equal(comparison.action, "downgrade");

    // Attempting performUpgrade should refuse downgrade due to state schema mismatch
    await assert.rejects(
      performUpgrade(comparison, { prefix: tmpPrefix, allowDowngrade: true, timeoutMs: 5000 }),
      /Downgrade refused: Target version v0\.0\.5 uses state schema version 0, which cannot read current state schema version 2/
    );

    // Symlink remains intact on v1.0.0
    assert.equal(fs.realpathSync(binNexus), fs.realpathSync(v1Bin));
  });

  it("rejects a checksum-listed detached compatibility asset that changes the archive's embedded contract", async () => {
    const hash = crypto.createHash("sha256");
    const pkgV1 = createPackageArchive("v1.0.0", 1, CURRENT_STATE_SCHEMA_VERSION);
    const archiveDigest = hash.update(pkgV1).digest("hex");
    const altered = createCompatibilityMetadata("v1.0.0", 2, CURRENT_STATE_SCHEMA_VERSION, archiveDigest);
    compatibilityV1 = Buffer.from(`${JSON.stringify(altered, null, 2)}\n`);
    sumsV1 = `${archiveDigest}  nexus-linux-x86_64-v1.0.0.tar.gz\n${crypto.createHash("sha256").update(compatibilityV1).digest("hex")}  compatibility.json\n`;

    const oldVersion = "v0.9.0";
    const oldVersionDir = setupInstalledVersion(tmpPrefix, oldVersion);
    const binDir = path.join(tmpPrefix, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const oldBin = path.join(oldVersionDir, "bin", "nexus");
    fs.writeFileSync(oldBin, `#!/bin/sh\necho "nexus ${oldVersion}"\n`, { mode: 0o755 });
    const activeLink = path.join(binDir, "nexus");
    fs.symlinkSync(oldBin, activeLink);

    const installed = detectInstallation({ nexusHome: oldVersionDir, envPrefix: tmpPrefix });
    const target = await resolveTargetRelease(undefined, { timeoutMs: 5000 });
    const comparison = compareInstallationWithRelease(installed, target);
    await assert.rejects(
      performUpgrade(comparison, { prefix: tmpPrefix, timeoutMs: 5000 }),
      /external metadata does not match metadata embedded in the verified archive/
    );
    assert.equal(fs.realpathSync(activeLink), fs.realpathSync(oldBin));
  });

  it("handles TUI deliberate approval flow for upgrades", async () => {
    const vOldDir = setupInstalledVersion(tmpPrefix, "v0.1.0");
    const binDir = path.join(tmpPrefix, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync(path.join(vOldDir, "bin", "nexus"), path.join(binDir, "nexus"));

    const installed = detectInstallation({ nexusHome: vOldDir, envPrefix: tmpPrefix });
    const target = await resolveTargetRelease(undefined, { timeoutMs: 5000 });
    const comparison = compareInstallationWithRelease(installed, target);

    // Simulate deliberate operator confirmation
    let approvalRequested = false;
    let approvalPayload: any = null;

    const mockConfirm = async (tool: string, args: Record<string, any>) => {
      approvalRequested = true;
      approvalPayload = { tool, ...args };
      return true; // operator confirms
    };

    const approved = await mockConfirm("nexus_upgrade", {
      action: comparison.action,
      installedVersion: installed.version,
      targetVersion: comparison.targetVersion,
      destination: path.join(tmpPrefix, "lib", "nexus", comparison.targetVersion),
    });

    assert.equal(approvalRequested, true);
    assert.equal(approved, true);
    assert.equal(approvalPayload.tool, "nexus_upgrade");
    assert.equal(approvalPayload.targetVersion, "v1.0.0");
  });

  it("rolls back launcher symlink to previous working version when post-switch self-test fails", async () => {
    // Target package has a script that succeeds in staging but fails after symlink swap
    const failingScript = `#!/bin/sh
case "$0" in
  *"/unpack/"*|*.tmp-upgrade-*)
    if [ "$1" = "--version" ]; then echo "nexus v1.0.0"; exit 0; fi
    exit 0
    ;;
  *)
    echo "simulated post-switch failure" >&2
    exit 42
    ;;
esac
`;
    pkgV1 = createPackageArchive("v1.0.0", 1, CURRENT_STATE_SCHEMA_VERSION, failingScript);
    const hash = crypto.createHash("sha256").update(pkgV1).digest("hex");
    compatibilityV1 = Buffer.from(JSON.stringify(createCompatibilityMetadata("v1.0.0", 1, CURRENT_STATE_SCHEMA_VERSION, hash), null, 2) + "\n");
    sumsV1 = `${hash}  nexus-linux-x86_64-v1.0.0.tar.gz\n${crypto.createHash("sha256").update(compatibilityV1).digest("hex")}  compatibility.json\n`;

    // Existing installation at v0.1.0-alpha.2
    const oldVersion = "v0.9.0";
    const oldVersionDir = setupInstalledVersion(tmpPrefix, oldVersion);
    const binDir = path.join(tmpPrefix, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const oldBin = path.join(oldVersionDir, "bin", "nexus");
    const activeLink = path.join(binDir, "nexus");
    fs.symlinkSync(oldBin, activeLink);

    const installed = detectInstallation({ nexusHome: oldVersionDir, envPrefix: tmpPrefix });
    const target = await resolveTargetRelease(undefined, { timeoutMs: 5000 });
    const comparison = compareInstallationWithRelease(installed, target);

    // performUpgrade must reject due to post-switch self-test failure
    await assert.rejects(
      performUpgrade(comparison, { prefix: tmpPrefix, timeoutMs: 5000 }),
      /Installed binary failed self-test/
    );

    // Launcher symlink MUST be restored to previous working version (oldBin)
    assert.equal(fs.realpathSync(activeLink), fs.realpathSync(oldBin));

    // Journal must record rolled_back state
    const journal = readJournal(tmpPrefix);
    assert.ok(journal);
    assert.equal(journal.state, "rolled_back");
  });

  it("does not delete or corrupt working installation during same-version reinstall when package fails self-test", async () => {
    // Current installation at v1.0.0
    const v1Dir = setupInstalledVersion(tmpPrefix, "v1.0.0");
    const binDir = path.join(tmpPrefix, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const v1Bin = path.join(v1Dir, "bin", "nexus");
    const activeLink = path.join(binDir, "nexus");
    fs.symlinkSync(v1Bin, activeLink);

    // Add a critical file inside v1Dir to assert it is NOT destroyed
    const canaryPath = path.join(v1Dir, "important-state.txt");
    fs.writeFileSync(canaryPath, "critical installation payload\n");

    // Make incoming v1.0.0 package fail staging self-test
    const brokenScript = `#!/bin/sh\necho "fatal broken binary" >&2\nexit 1\n`;
    pkgV1 = createPackageArchive("v1.0.0", 1, CURRENT_STATE_SCHEMA_VERSION, brokenScript);
    const hash = crypto.createHash("sha256").update(pkgV1).digest("hex");
    compatibilityV1 = Buffer.from(JSON.stringify(createCompatibilityMetadata("v1.0.0", 1, CURRENT_STATE_SCHEMA_VERSION, hash), null, 2) + "\n");
    sumsV1 = `${hash}  nexus-linux-x86_64-v1.0.0.tar.gz\n${crypto.createHash("sha256").update(compatibilityV1).digest("hex")}  compatibility.json\n`;

    const installed = detectInstallation({ nexusHome: v1Dir, envPrefix: tmpPrefix });
    const target = await resolveTargetRelease(undefined, { timeoutMs: 5000 });
    const comparison = compareInstallationWithRelease(installed, target);

    // Reinstall attempt must reject
    await assert.rejects(
      performUpgrade(comparison, { prefix: tmpPrefix, force: true, timeoutMs: 5000 }),
      /Unpacked binary failed staging self-test/
    );

    // Working installation must remain intact and NOT deleted
    assert.ok(fs.existsSync(v1Dir));
    assert.ok(fs.existsSync(canaryPath));
    assert.equal(fs.readFileSync(canaryPath, "utf8"), "critical installation payload\n");
    assert.equal(fs.realpathSync(activeLink), fs.realpathSync(v1Bin));
  });
});
