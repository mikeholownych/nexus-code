import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { execSync } from "node:child_process";
import { routeSlash } from "../src/slash/router.js";
import { findSlash, slashCatalog, SlashHost } from "../src/slash/catalog.js";
import { computeSha256, PublishedRelease } from "../src/upgrade.js";
import { generateCompatibilityMetadata } from "../src/compatibility.js";

describe("TUI /upgrade slash command and deliberate confirmation interaction", () => {
  let server: http.Server;
  let port: number;
  let tmpRoot: string;

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
      name: "v1.0.0 Stable",
      draft: false,
      prerelease: false,
      published_at: "2026-10-18T10:00:00Z",
      html_url: "https://github.com/mock/nexus/releases/v1.0.0",
      assets: [],
    },
  ];

  before(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tui-upgrade-test-"));
    const archiveName = "nexus-linux-x86_64-v1.0.0.tar.gz";
    const archiveDir = path.join(tmpRoot, "dist");
    fs.mkdirSync(archiveDir, { recursive: true });

    // Mock package
    const pkgStage = path.join(tmpRoot, "stage", "nexus");
    fs.mkdirSync(path.join(pkgStage, "bin"), { recursive: true });
    fs.mkdirSync(path.join(pkgStage, "lib", "core"), { recursive: true });
    fs.mkdirSync(path.join(pkgStage, "lib", "cli", "dist"), { recursive: true });
    fs.writeFileSync(path.join(pkgStage, "VERSION"), "v1.0.0\n");
    const newBin = path.join(pkgStage, "bin", "nexus");
    fs.writeFileSync(newBin, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"nexus v1.0.0\"; exit 0; fi\n");
    fs.chmodSync(newBin, 0o755);
    const mockCore1 = path.join(pkgStage, "lib", "core", "harness-core");
    const mockCore2 = path.join(pkgStage, "lib", "core", "nexus-tui");
    fs.writeFileSync(mockCore1, "#!/bin/sh\nexit 0\n");
    fs.writeFileSync(mockCore2, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(mockCore1, 0o755);
    fs.chmodSync(mockCore2, 0o755);
    fs.writeFileSync(path.join(pkgStage, "lib", "core", "harness-core"), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "harness-core 1.0.0"; exit 0; fi\nexit 0\n');
    fs.writeFileSync(path.join(pkgStage, "lib", "core", "nexus-tui"), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "nexus-tui 1.0.0"; exit 0; fi\necho "NEXUS"\nexit 0\n');
    fs.chmodSync(path.join(pkgStage, "lib", "core", "harness-core"), 0o755);
    fs.chmodSync(path.join(pkgStage, "lib", "core", "nexus-tui"), 0o755);
    fs.writeFileSync(path.join(pkgStage, "lib", "cli", "package.json"), JSON.stringify({ name:"nexus-code", version:"1.0.0" }));
    fs.writeFileSync(path.join(pkgStage, "lib", "cli", "dist", "index.js"), "// dist entry\n");
    fs.writeFileSync(path.join(pkgStage,"compatibility.json"),JSON.stringify(generateCompatibilityMetadata("v1.0.0","fixture-digest")));

    execSync(`tar -C "${path.join(tmpRoot, "stage")}" -czf "${path.join(archiveDir, archiveName)}" nexus`);
    const archiveSum = computeSha256(path.join(archiveDir, archiveName));
    fs.writeFileSync(path.join(archiveDir, "SHA256SUMS"), `${archiveSum}  ${archiveName}\n`);

    server = http.createServer((req, res) => {
      const u = new URL(req.url || "", `http://${req.headers.host}`);
      if (u.pathname === "/api/releases/latest") {
        const latest = mockReleases.find((r) => !r.prerelease && !r.draft);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(latest));
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
      } else if (u.pathname.endsWith(archiveName)) {
        res.writeHead(200, { "Content-Type": "application/gzip" });
        res.end(fs.readFileSync(path.join(archiveDir, archiveName)));
      } else if (u.pathname.endsWith("SHA256SUMS")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(fs.readFileSync(path.join(archiveDir, "SHA256SUMS")));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as any).port;
        process.env.NEXUS_RELEASES_API = `http://127.0.0.1:${port}/api/releases`;
        process.env.NEXUS_RELEASE_BASE_URL = `http://127.0.0.1:${port}/download`;
        resolve();
      });
    });
  });

  after(async () => {
    delete process.env.NEXUS_RELEASES_API;
    delete process.env.NEXUS_RELEASE_BASE_URL;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("registers /upgrade in the slash catalogue with usage and summary", () => {
    const spec = findSlash("upgrade");
    assert.ok(spec);
    assert.equal(spec.name, "upgrade");
    assert.match(spec.usage, /\/upgrade/);
    assert.match(spec.summary, /safely upgrade Nexus/);

    const cat = slashCatalog();
    assert.ok(cat.some((item) => item.name === "upgrade"));
  });

  it("handles /upgrade --check via routeSlash", async () => {
    const host: SlashHost = {
      app: {} as any,
      mode: () => "auto" as any,
      setMode: () => {},
      sessionId: () => "test-session",
      setSessionId: () => {},
      checkpoints: () => ({} as any),
      setWorkspace: () => {},
      saveSession: () => {},
      resumeSession: () => ({ ok: true, message: "" }),
      history: () => [],
      confirm: () => undefined,
      receipt: () => [],
    };

    const outcome = await routeSlash(host, "upgrade", "--check", new AbortController().signal);
    assert.equal(outcome.kind, "reply");
    if (outcome.kind === "reply") {
      assert.equal(outcome.success, true);
      assert.match(outcome.output, /Target release:\s+v1\.0\.0/);
      assert.match(outcome.output, /Update available/);
    }
  });

  it("exercises deliberate approval interaction when executing /upgrade in TUI", async () => {
    // Setup mock packaged installation
    const prefix = path.join(tmpRoot, "pkg-prefix");
    const oldVersion = "v0.1.0-alpha.2";
    const verDir = path.join(prefix, "lib", "nexus", oldVersion);
    const binDir = path.join(prefix, "bin");
    fs.mkdirSync(path.join(verDir, "bin"), { recursive: true });
    fs.mkdirSync(path.join(verDir, "lib", "cli", "dist"), { recursive:true });
    fs.mkdirSync(path.join(verDir, "lib", "core"), { recursive:true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(verDir, "VERSION"), `${oldVersion}\n`);

    const oldBin = path.join(verDir, "bin", "nexus");
    fs.writeFileSync(oldBin, `#!/bin/sh\necho "nexus ${oldVersion}"\n`);
    fs.chmodSync(oldBin, 0o755);
    fs.writeFileSync(path.join(verDir,"lib/cli/package.json"), JSON.stringify({ name:"nexus-code", version:"0.1.0-alpha.2" }));
    fs.writeFileSync(path.join(verDir,"lib/cli/dist/index.js"), "// dist entry\n");
    fs.writeFileSync(path.join(verDir,"lib/core/harness-core"), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "harness-core 0.1.0-alpha.2"; exit 0; fi\nexit 0\n', {mode:0o755});
    fs.writeFileSync(path.join(verDir,"lib/core/nexus-tui"), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "nexus-tui 0.1.0-alpha.2"; exit 0; fi\necho "NEXUS"\nexit 0\n', {mode:0o755});
    fs.symlinkSync(oldBin, path.join(binDir, "nexus"));

    const prevHome = process.env.NEXUS_HOME;
    process.env.NEXUS_HOME = verDir;

    let approvalCalled = false;
    let approvalPayload: any = null;

    const host: SlashHost = {
      app: {} as any,
      mode: () => "auto" as any, // even in auto mode, upgrade must request deliberate approval!
      setMode: () => {},
      sessionId: () => "test-session",
      setSessionId: () => {},
      checkpoints: () => ({} as any),
      setWorkspace: () => {},
      saveSession: () => {},
      resumeSession: () => ({ ok: true, message: "" }),
      history: () => [],
      confirm: () => undefined,
      requestApproval: async (tool, args) => {
        approvalCalled = true;
        approvalPayload = { tool, args };
        return true; // Approve
      },
      receipt: () => [],
    };

    try {
      const outcome = await routeSlash(host, "upgrade", "", new AbortController().signal);
      assert.equal(approvalCalled, true);
      assert.equal(approvalPayload?.tool, "nexus_upgrade");
      assert.equal(approvalPayload?.args?.action, "upgrade");
      assert.equal(approvalPayload?.args?.targetVersion, "v1.0.0");
      assert.match(approvalPayload?.args?.destination, /v1\.0\.0/);

      assert.equal(outcome.kind, "reply");
      if (outcome.kind === "reply") {
        assert.equal(outcome.success, true, outcome.output);
        assert.match(outcome.output, /Nexus successfully upgraded to v1\.0\.0/);
        assert.match(outcome.output, /Restart Nexus to activate the new version/);
      }

      // Verify symlink was swapped to v1.0.0
      const activeLink = fs.readlinkSync(path.join(binDir, "nexus"));
      assert.equal(activeLink, path.join(prefix, "lib", "nexus", "v1.0.0", "bin", "nexus"));
    } finally {
      process.env.NEXUS_HOME = prevHome;
    }
  });

  it("leaves installation untouched when deliberate approval is declined in TUI", async () => {
    const prefix = path.join(tmpRoot, "pkg-declined");
    const oldVersion = "v0.1.0-alpha.2";
    const verDir = path.join(prefix, "lib", "nexus", oldVersion);
    const binDir = path.join(prefix, "bin");
    fs.mkdirSync(path.join(verDir, "bin"), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(verDir, "VERSION"), `${oldVersion}\n`);

    const oldBin = path.join(verDir, "bin", "nexus");
    fs.writeFileSync(oldBin, `#!/bin/sh\necho "nexus ${oldVersion}"\n`);
    fs.chmodSync(oldBin, 0o755);
    fs.symlinkSync(oldBin, path.join(binDir, "nexus"));

    const prevHome = process.env.NEXUS_HOME;
    process.env.NEXUS_HOME = verDir;

    const host: SlashHost = {
      app: {} as any,
      mode: () => "auto" as any,
      setMode: () => {},
      sessionId: () => "test-session",
      setSessionId: () => {},
      checkpoints: () => ({} as any),
      setWorkspace: () => {},
      saveSession: () => {},
      resumeSession: () => ({ ok: true, message: "" }),
      history: () => [],
      confirm: () => undefined,
      requestApproval: async () => false, // Operator declines!
      receipt: () => [],
    };

    try {
      const outcome = await routeSlash(host, "upgrade", "", new AbortController().signal);
      assert.equal(outcome.kind, "reply");
      if (outcome.kind === "reply") {
        assert.equal(outcome.success, false);
        assert.match(outcome.output, /Upgrade to v1\.0\.0 was declined/);
      }

      // Verify link remains old version
      const activeLink = fs.readlinkSync(path.join(binDir, "nexus"));
      assert.equal(activeLink, oldBin);
      assert.equal(fs.existsSync(path.join(prefix, "lib", "nexus", "v1.0.0")), false);
    } finally {
      process.env.NEXUS_HOME = prevHome;
    }
  });
});
