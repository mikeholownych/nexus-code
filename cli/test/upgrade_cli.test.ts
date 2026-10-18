import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { execFile } from "node:child_process";
import { PublishedRelease } from "../src/upgrade.js";

const CLI_ENTRY = path.resolve("dist/index.js");

function runCliAsync(
  args: string[],
  options?: { env?: Record<string, string>; timeout?: number }
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI_ENTRY, ...args],
      {
        env: options?.env ?? process.env,
        timeout: options?.timeout ?? 10000,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (error.code as any) ?? 1 : 0,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        });
      }
    );
  });
}

describe("CLI nexus upgrade command execution and exit codes", () => {
  let server: http.Server;
  let port: number;

  const mockReleases: PublishedRelease[] = [
    {
      tag_name: "v0.1.0-alpha.2",
      name: "v0.1.0-alpha.2",
      draft: false,
      prerelease: true,
      published_at: "2026-10-14T08:00:00Z",
      html_url: "https://github.com/mock/nexus/releases/v0.1.0-alpha.2",
      assets: [],
    },
    {
      tag_name: "v1.0.0",
      name: "v1.0.0",
      draft: false,
      prerelease: false,
      published_at: "2026-10-18T10:00:00Z",
      html_url: "https://github.com/mock/nexus/releases/v1.0.0",
      assets: [],
    },
  ];

  before(async () => {
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
        port = (server.address() as any).port;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("prints help and documented exit codes with --help", async () => {
    const res = await runCliAsync(["upgrade", "--help"]);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /Compare installed version with a published release and safely upgrade/);
    assert.match(res.stdout, /--check/);
    assert.match(res.stdout, /--version <version>/);
    assert.match(res.stdout, /--yes/);
    assert.match(res.stdout, /--json/);
    assert.match(res.stdout, /Exit codes:/);
    assert.match(res.stdout, /0: Success/);
    assert.match(res.stdout, /1: Update available/);
    assert.match(res.stdout, /2: Operational error/);
  });

  it("returns exit code 1 when update is available in --check mode", async () => {
    // Under test, current version is v0.1.0-alpha.2; target stable is v1.0.0
    const res = await runCliAsync(["upgrade", "--check"], {
      env: {
        ...process.env,
        NEXUS_RELEASES_API: `http://127.0.0.1:${port}/api/releases`,
        NEXUS_RELEASE_BASE_URL: `http://127.0.0.1:${port}/download`,
      },
    });
    assert.equal(res.code, 1);
    assert.match(res.stdout, /An update is available/);
    assert.match(res.stdout, /v1\.0\.0/);
  });

  it("returns exit code 0 when already current in --check mode with pinned version", async () => {
    // Current is v0.1.0-alpha.2; target pinned to v0.1.0-alpha.2
    const res = await runCliAsync(["upgrade", "--check", "--version", "v0.1.0-alpha.2"], {
      env: {
        ...process.env,
        NEXUS_RELEASES_API: `http://127.0.0.1:${port}/api/releases`,
        NEXUS_RELEASE_BASE_URL: `http://127.0.0.1:${port}/download`,
      },
    });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /Nexus is already up to date/);
  });

  it("returns structured JSON with --check --json", async () => {
    const res = await runCliAsync(["upgrade", "--check", "--json"], {
      env: {
        ...process.env,
        NEXUS_RELEASES_API: `http://127.0.0.1:${port}/api/releases`,
        NEXUS_RELEASE_BASE_URL: `http://127.0.0.1:${port}/download`,
      },
    });
    assert.equal(res.code, 1); // update available
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.tool, "nexus upgrade");
    assert.equal(parsed.status, "update_available");
    assert.equal(parsed.targetVersion, "v1.0.0");
    assert.equal(parsed.action, "upgrade");
    assert.ok(parsed.release);
    assert.equal(parsed.release.tag, "v1.0.0");
  });

  it("returns exit code 2 on operational error (release not found)", async () => {
    const res = await runCliAsync(["upgrade", "--check", "--version", "v9.9.9"], {
      env: {
        ...process.env,
        NEXUS_RELEASES_API: `http://127.0.0.1:${port}/api/releases`,
        NEXUS_RELEASE_BASE_URL: `http://127.0.0.1:${port}/download`,
      },
    });
    assert.equal(res.code, 2);
    assert.match(res.stderr, /could not find release v9\.9\.9/);
  });

  it("returns exit code 2 on operational error when offline or host unreachable", async () => {
    // Port 1 is not listening
    const res = await runCliAsync(["upgrade", "--check"], {
      env: {
        ...process.env,
        NEXUS_RELEASES_API: "http://127.0.0.1:1/api/releases",
        NEXUS_RELEASE_BASE_URL: "http://127.0.0.1:1/download",
      },
    });
    assert.equal(res.code, 2);
    assert.match(res.stderr, /could not query GitHub releases API/);
  });

  it("refuses to overwrite a development checkout in modify mode and exits with code 2", async () => {
    // When running inside the repository checkout without NEXUS_HOME:
    const res = await runCliAsync(["upgrade", "--yes"], {
      env: {
        ...process.env,
        NEXUS_HOME: "", // clear packaged home
        NEXUS_RELEASES_API: `http://127.0.0.1:${port}/api/releases`,
        NEXUS_RELEASE_BASE_URL: `http://127.0.0.1:${port}/download`,
      },
    });
    assert.equal(res.code, 2);
    assert.match(res.stderr, /running from a source development checkout/);
    assert.match(res.stderr, /git pull && make build/);
  });

  it("refuses non-interactive modification when --yes is omitted", async () => {
    // Mock a packaged installation to test the non-interactive refusal
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pkg-mock-"));
    try {
      const verDir = path.join(tmp, "lib", "nexus", "v0.1.0-alpha.2");
      fs.mkdirSync(verDir, { recursive: true });
      fs.writeFileSync(path.join(verDir, "VERSION"), "v0.1.0-alpha.2\n");

      const res = await runCliAsync(["upgrade"], {
        env: {
          ...process.env,
          NEXUS_HOME: verDir,
          NEXUS_RELEASES_API: `http://127.0.0.1:${port}/api/releases`,
          NEXUS_RELEASE_BASE_URL: `http://127.0.0.1:${port}/download`,
        },
      });
      // In non-interactive mode without --yes, it must not hang, and must exit 1 requiring --yes
      assert.equal(res.code, 1);
      assert.match(res.stderr, /requires confirmation\. Re-run with --yes in non-interactive scripts/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
