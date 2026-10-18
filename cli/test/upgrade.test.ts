import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import {
  parseSemver,
  compareSemver,
  normalizeTag,
  isValidTag,
  detectInstallation,
  resolveTargetRelease,
  compareInstallationWithRelease,
  verifyChecksum,
  performUpgrade,
  computeSha256,
  PublishedRelease,
  InstalledProductInfo,
} from "../src/upgrade.js";

describe("SemVer 2.0.0 parser and comparator", () => {
  it("normalizes and validates release tags", () => {
    assert.equal(normalizeTag("1.0.0"), "v1.0.0");
    assert.equal(normalizeTag("v1.0.0"), "v1.0.0");
    assert.equal(normalizeTag("v0.1.0-alpha.2"), "v0.1.0-alpha.2");
    assert.equal(normalizeTag("0.1.0-alpha.2"), "v0.1.0-alpha.2");

    assert.equal(isValidTag("v1.0.0"), true);
    assert.equal(isValidTag("v0.1.0-alpha.2"), true);
    assert.equal(isValidTag("v1.2.3-rc.1"), true);
    assert.equal(isValidTag("v1.2.3/../x"), false);
    assert.equal(isValidTag("1.0.0"), false); // must start with v per tag convention
    assert.equal(isValidTag("latest"), false);
    assert.equal(isValidTag("invalid-tag"), false);
  });

  it("parses valid SemVer strings with and without prerelease or build tags", () => {
    const s1 = parseSemver("1.0.0");
    assert.ok(s1);
    assert.equal(s1.major, 1);
    assert.equal(s1.minor, 0);
    assert.equal(s1.patch, 0);
    assert.deepEqual(s1.prerelease, []);

    const s2 = parseSemver("v0.1.0-alpha.2");
    assert.ok(s2);
    assert.equal(s2.major, 0);
    assert.equal(s2.minor, 1);
    assert.equal(s2.patch, 0);
    assert.deepEqual(s2.prerelease, ["alpha", 2]);

    const s3 = parseSemver("v1.0.0-rc.1+build.123");
    assert.ok(s3);
    assert.equal(s3.major, 1);
    assert.equal(s3.minor, 0);
    assert.equal(s3.patch, 0);
    assert.deepEqual(s3.prerelease, ["rc", 1]);
    assert.equal(s3.build, "build.123");

    assert.equal(parseSemver("not-semver"), null);
    assert.equal(parseSemver(""), null);
  });

  it("correctly orders semantic versions according to SemVer 2.0.0 rules", () => {
    const v010a1 = parseSemver("0.1.0-alpha.1")!;
    const v010a2 = parseSemver("0.1.0-alpha.2")!;
    const v010b = parseSemver("0.1.0-beta.1")!;
    const v010 = parseSemver("0.1.0")!;
    const v020 = parseSemver("0.2.0")!;
    const v100rc1 = parseSemver("1.0.0-rc.1")!;
    const v100 = parseSemver("1.0.0")!;
    const v200 = parseSemver("2.0.0")!;

    // Major / Minor / Patch differences
    assert.equal(compareSemver(v100, v200), -1);
    assert.equal(compareSemver(v200, v100), 1);
    assert.equal(compareSemver(v010, v020), -1);
    assert.equal(compareSemver(v020, v010), 1);
    assert.equal(compareSemver(v100, v100), 0);

    // Prerelease vs release: normal release always has higher precedence than prerelease
    assert.equal(compareSemver(v010, v010a2), 1);
    assert.equal(compareSemver(v010a2, v010), -1);
    assert.equal(compareSemver(v100rc1, v100), -1);
    assert.equal(compareSemver(v100, v100rc1), 1);

    // Prerelease identifier comparison
    assert.equal(compareSemver(v010a1, v010a2), -1);
    assert.equal(compareSemver(v010a2, v010a1), 1);
    assert.equal(compareSemver(v010a2, v010b), -1);
  });
});

describe("Installation provenance detection", () => {
  it("detects packaged installation from NEXUS_HOME layout", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-test-pkg-"));
    try {
      const prefix = path.join(tmp, "prefix");
      const verDir = path.join(prefix, "lib", "nexus", "v0.1.0-alpha.2");
      fs.mkdirSync(verDir, { recursive: true });
      fs.writeFileSync(path.join(verDir, "VERSION"), "v0.1.0-alpha.2\n");
      const info = detectInstallation({ nexusHome: verDir });
      assert.equal(info.provenance, "packaged");
      assert.equal(info.version, "v0.1.0-alpha.2");
      assert.equal(info.normalizedVersion, "v0.1.0-alpha.2");
      assert.equal(info.prefix, prefix);
      assert.equal(info.binLink, path.join(prefix, "bin", "nexus"));
      assert.equal(info.writable, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("detects development checkout when executed inside source tree", () => {
    const info = detectInstallation({
      nexusHome: undefined,
      hereDir: path.resolve("src"),
    });
    // In our worktree checkout, it should detect development
    assert.equal(info.provenance, "development");
    assert.ok(info.installRoot);
    assert.match(info.detail || "", /Source development checkout/);
  });
});

describe("Release resolution and comparison", () => {
  let server: http.Server;
  let port: number;
  let releasesApi: string;
  let releaseBaseUrl: string;

  const mockReleases: PublishedRelease[] = [
    {
      tag_name: "v0.1.0-alpha.2",
      name: "v0.1.0-alpha.2",
      draft: false,
      prerelease: true,
      published_at: "2026-10-14T08:00:00Z",
      html_url: "https://github.com/mock/nexus/releases/v0.1.0-alpha.2",
      assets: [
        {
          name: "nexus-linux-x86_64-v0.1.0-alpha.2.tar.gz",
          browser_download_url: "http://127.0.0.1/download/v0.1.0-alpha.2/nexus-linux-x86_64-v0.1.0-alpha.2.tar.gz",
        },
      ],
    },
    {
      tag_name: "v1.0.0-rc.1",
      name: "v1.0.0-rc.1",
      draft: false,
      prerelease: true,
      published_at: "2026-10-17T12:00:00Z",
      html_url: "https://github.com/mock/nexus/releases/v1.0.0-rc.1",
      assets: [],
    },
    {
      tag_name: "v1.0.0",
      name: "v1.0.0 Stable",
      draft: false,
      prerelease: false,
      published_at: "2026-10-18T10:00:00Z",
      html_url: "https://github.com/mock/nexus/releases/v1.0.0",
      assets: [],
    },
    {
      tag_name: "v1.1.0-draft",
      name: "Unpublished Draft",
      draft: true,
      prerelease: false,
      published_at: "2026-10-18T11:00:00Z",
      assets: [],
    },
  ];

  it("starts mock HTTP server for GitHub release endpoints", async () => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url || "", `http://${req.headers.host}`);
      if (u.pathname === "/api/releases/latest") {
        const latest = mockReleases.find((r) => !r.prerelease && !r.draft);
        if (latest) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(latest));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "Not Found" }));
        }
      } else if (u.pathname.startsWith("/api/releases/tags/")) {
        const tag = u.pathname.replace("/api/releases/tags/", "");
        const match = mockReleases.find((r) => r.tag_name === tag);
        if (match) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(match));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "Not Found" }));
        }
      } else if (u.pathname === "/api/releases") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(mockReleases));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        port = addr.port;
        releasesApi = `http://127.0.0.1:${port}/api/releases`;
        releaseBaseUrl = `http://127.0.0.1:${port}/download`;
        process.env.NEXUS_RELEASES_API = releasesApi;
        process.env.NEXUS_RELEASE_BASE_URL = releaseBaseUrl;
        resolve();
      });
    });
  });

  it("resolves latest stable release excluding drafts and prereleases", async () => {
    const rel = await resolveTargetRelease(undefined);
    assert.equal(rel.tag_name, "v1.0.0");
    assert.equal(rel.prerelease, false);
    assert.equal(rel.draft, false);
  });

  it("resolves pinned exact release, allowing explicit prerelease", async () => {
    const rel = await resolveTargetRelease("v0.1.0-alpha.2");
    assert.equal(rel.tag_name, "v0.1.0-alpha.2");
    assert.equal(rel.prerelease, true);
  });

  it("refuses to resolve an unpublished draft", async () => {
    await assert.rejects(
      resolveTargetRelease("v1.1.0-draft"),
      /unpublished draft and cannot be installed/
    );
  });

  it("fails with clear error when pinned release does not exist", async () => {
    await assert.rejects(
      resolveTargetRelease("v9.9.9"),
      /could not find release v9.9.9/
    );
  });

  it("identifies upgrade, downgrade, and reinstall actions correctly", () => {
    const targetStable: PublishedRelease = {
      tag_name: "v1.0.0",
      draft: false,
      prerelease: false,
      assets: [],
    };

    // Installed: v0.1.0-alpha.2 -> target v1.0.0 is an upgrade
    const installedAlpha: InstalledProductInfo = {
      version: "v0.1.0-alpha.2",
      normalizedVersion: "v0.1.0-alpha.2",
      semver: parseSemver("v0.1.0-alpha.2"),
      isPrerelease: true,
      provenance: "packaged",
      installRoot: "/fake/lib/nexus/v0.1.0-alpha.2",
      prefix: "/fake",
      binLink: "/fake/bin/nexus",
      writable: true,
    };
    const cmpUpgrade = compareInstallationWithRelease(installedAlpha, targetStable);
    assert.equal(cmpUpgrade.action, "upgrade");
    assert.equal(cmpUpgrade.targetVersion, "v1.0.0");

    // Installed: v1.0.0 -> target v1.0.0 is none (or reinstall if force)
    const installed100: InstalledProductInfo = {
      ...installedAlpha,
      version: "v1.0.0",
      normalizedVersion: "v1.0.0",
      semver: parseSemver("v1.0.0"),
      isPrerelease: false,
    };
    const cmpNone = compareInstallationWithRelease(installed100, targetStable);
    assert.equal(cmpNone.action, "none");

    const cmpForce = compareInstallationWithRelease(installed100, targetStable, { force: true });
    assert.equal(cmpForce.action, "reinstall");

    // Installed: v2.0.0 -> target v1.0.0 is a downgrade
    const installed200: InstalledProductInfo = {
      ...installedAlpha,
      version: "v2.0.0",
      normalizedVersion: "v2.0.0",
      semver: parseSemver("v2.0.0"),
      isPrerelease: false,
    };
    const cmpDowngrade = compareInstallationWithRelease(installed200, targetStable);
    assert.equal(cmpDowngrade.action, "downgrade");
  });

  it("closes mock HTTP server", async () => {
    delete process.env.NEXUS_RELEASES_API;
    delete process.env.NEXUS_RELEASE_BASE_URL;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe("Installation safety, checksum verification, and recovery", () => {
  let tmpRoot: string;
  let server: http.Server;
  let port: number;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-upgrade-test-"));
  });

  afterEach(() => {
    if (server) {
      server.close();
    }
    delete process.env.NEXUS_RELEASES_API;
    delete process.env.NEXUS_RELEASE_BASE_URL;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("successfully performs an end-to-end upgrade with atomic symlink swap and verification", async () => {
    const prefix = path.join(tmpRoot, "prefix");
    const oldVersion = "v0.1.0-alpha.2";
    const newVersion = "v1.0.0";
    const oldVersionDir = path.join(prefix, "lib", "nexus", oldVersion);
    const binDir = path.join(prefix, "bin");
    fs.mkdirSync(path.join(oldVersionDir, "bin"), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(oldVersionDir, "VERSION"), `${oldVersion}\n`);

    // Create a dummy nexus script in old version
    const oldBin = path.join(oldVersionDir, "bin", "nexus");
    fs.writeFileSync(oldBin, `#!/bin/sh\necho "nexus ${oldVersion}"\n`);
    fs.chmodSync(oldBin, 0o755);
    fs.symlinkSync(oldBin, path.join(binDir, "nexus"));

    // Build a mock package for newVersion
    const pkgStage = path.join(tmpRoot, "pkg-stage", "nexus");
    fs.mkdirSync(path.join(pkgStage, "bin"), { recursive: true });
    fs.mkdirSync(path.join(pkgStage, "lib", "core"), { recursive: true });
    fs.writeFileSync(path.join(pkgStage, "VERSION"), `${newVersion}\n`);
    const newBin = path.join(pkgStage, "bin", "nexus");
    fs.writeFileSync(newBin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "nexus ${newVersion}"; exit 0; fi\n`);
    fs.chmodSync(newBin, 0o755);
    const mockCore1 = path.join(pkgStage, "lib", "core", "harness-core");
    const mockCore2 = path.join(pkgStage, "lib", "core", "nexus-tui");
    fs.writeFileSync(mockCore1, "#!/bin/sh\nexit 0\n");
    fs.writeFileSync(mockCore2, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(mockCore1, 0o755);
    fs.chmodSync(mockCore2, 0o755);

    // Compute MANIFEST.sha256
    const binSum = computeSha256(newBin);
    const vSum = computeSha256(path.join(pkgStage, "VERSION"));
    const c1Sum = computeSha256(mockCore1);
    const c2Sum = computeSha256(mockCore2);
    const manifestContent = `${binSum}  bin/nexus\n${vSum}  VERSION\n${c1Sum}  lib/core/harness-core\n${c2Sum}  lib/core/nexus-tui\n`;
    fs.writeFileSync(path.join(pkgStage, "MANIFEST.sha256"), manifestContent);

    // Create tar.gz archive
    const archiveName = `nexus-linux-x86_64-${newVersion}.tar.gz`;
    const archiveDir = path.join(tmpRoot, "dist");
    fs.mkdirSync(archiveDir, { recursive: true });
    execSync(`tar -C "${path.join(tmpRoot, "pkg-stage")}" -czf "${path.join(archiveDir, archiveName)}" nexus`);

    // Create SHA256SUMS
    const archiveSum = computeSha256(path.join(archiveDir, archiveName));
    const sumsContent = `${archiveSum}  ${archiveName}\n`;
    fs.writeFileSync(path.join(archiveDir, "SHA256SUMS"), sumsContent);

    // Serve archiveDir via local HTTP server
    server = http.createServer((req, res) => {
      const u = new URL(req.url || "", `http://${req.headers.host}`);
      if (u.pathname.endsWith(archiveName)) {
        res.writeHead(200, { "Content-Type": "application/gzip" });
        res.end(fs.readFileSync(path.join(archiveDir, archiveName)));
      } else if (u.pathname.endsWith("SHA256SUMS")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(sumsContent);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as any).port;
        process.env.NEXUS_RELEASE_BASE_URL = `http://127.0.0.1:${port}/download`;
        resolve();
      });
    });

    const installedInfo: InstalledProductInfo = {
      version: oldVersion,
      normalizedVersion: oldVersion,
      semver: parseSemver(oldVersion),
      isPrerelease: true,
      provenance: "packaged",
      installRoot: oldVersionDir,
      prefix,
      binLink: path.join(binDir, "nexus"),
      writable: true,
    };

    const targetRelease: PublishedRelease = {
      tag_name: newVersion,
      draft: false,
      prerelease: false,
      assets: [],
    };

    const comparison = compareInstallationWithRelease(installedInfo, targetRelease);
    assert.equal(comparison.action, "upgrade");
    assert.equal(comparison.canUpgrade, true);

    const result = await performUpgrade(comparison, { prefix });
    assert.equal(result.success, true);
    assert.equal(result.previousVersion, oldVersion);
    assert.equal(result.newVersion, newVersion);

    // Verify symlink was swapped to new version
    const activeLink = fs.readlinkSync(path.join(binDir, "nexus"));
    assert.equal(activeLink, path.join(prefix, "lib", "nexus", newVersion, "bin", "nexus"));

    // Verify old version remains untouched for running sessions!
    assert.ok(fs.existsSync(oldVersionDir));
    assert.ok(fs.existsSync(path.join(oldVersionDir, "VERSION")));

    // Verify new version exists and runs
    const testExec = execSync(`"${path.join(binDir, "nexus")}" --version`).toString();
    assert.match(testExec, /v1\.0\.0/);
  });

  it("fails closed on checksum mismatch and leaves the previous installation untouched", async () => {
    const prefix = path.join(tmpRoot, "prefix");
    const oldVersion = "v0.1.0-alpha.2";
    const newVersion = "v1.0.0";
    const oldVersionDir = path.join(prefix, "lib", "nexus", oldVersion);
    const binDir = path.join(prefix, "bin");
    fs.mkdirSync(path.join(oldVersionDir, "bin"), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(oldVersionDir, "VERSION"), `${oldVersion}\n`);

    const oldBin = path.join(oldVersionDir, "bin", "nexus");
    fs.writeFileSync(oldBin, `#!/bin/sh\necho "nexus ${oldVersion}"\n`);
    fs.chmodSync(oldBin, 0o755);
    fs.symlinkSync(oldBin, path.join(binDir, "nexus"));

    // Provide a corrupted SHA256SUMS
    const archiveName = `nexus-linux-x86_64-${newVersion}.tar.gz`;
    const corruptedSums = `0000000000000000000000000000000000000000000000000000000000000000  ${archiveName}\n`;

    server = http.createServer((req, res) => {
      const u = new URL(req.url || "", `http://${req.headers.host}`);
      if (u.pathname.endsWith(archiveName)) {
        res.writeHead(200, { "Content-Type": "application/gzip" });
        res.end(Buffer.from("corrupted payload"));
      } else if (u.pathname.endsWith("SHA256SUMS")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(corruptedSums);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as any).port;
        process.env.NEXUS_RELEASE_BASE_URL = `http://127.0.0.1:${port}/download`;
        resolve();
      });
    });

    const installedInfo: InstalledProductInfo = {
      version: oldVersion,
      normalizedVersion: oldVersion,
      semver: parseSemver(oldVersion),
      isPrerelease: true,
      provenance: "packaged",
      installRoot: oldVersionDir,
      prefix,
      binLink: path.join(binDir, "nexus"),
      writable: true,
    };

    const targetRelease: PublishedRelease = {
      tag_name: newVersion,
      draft: false,
      prerelease: false,
      assets: [],
    };

    const comparison = compareInstallationWithRelease(installedInfo, targetRelease);
    await assert.rejects(
      performUpgrade(comparison, { prefix }),
      /SHA-256 verification failed/
    );

    // Verify existing installation was NOT changed
    const activeLink = fs.readlinkSync(path.join(binDir, "nexus"));
    assert.equal(activeLink, oldBin);
    assert.equal(fs.existsSync(path.join(prefix, "lib", "nexus", newVersion)), false);
  });
});
