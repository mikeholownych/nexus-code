import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecurityManager } from "../src/security.js";
import { RustCoreBridge } from "../src/tools.js";

async function withWorkspace(run: (ws: string) => Promise<void>): Promise<void> {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-security-test-"));
  try {
    await run(ws);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

describe("ACC-TRUST-09: protected paths matching covers .env* and canonical, case-insensitive names (REQ-SEC-118)", () => {
  test("SecurityManager.isPathProtected matches .env* prefixes and case-insensitive variants", async () => {
    await withWorkspace(async (ws) => {
      const sm = new SecurityManager(ws);

      // Standard .env files
      assert.equal(sm.isPathProtected(".env").protected, true);
      assert.equal(sm.isPathProtected(".env.local").protected, true);
      assert.equal(sm.isPathProtected(".env.production").protected, true);
      assert.equal(sm.isPathProtected(".env.test").protected, true);
      assert.equal(sm.isPathProtected(".env.secrets").protected, true);

      // Case-insensitive variants
      assert.equal(sm.isPathProtected(".ENV").protected, true);
      assert.equal(sm.isPathProtected(".Env").protected, true);
      assert.equal(sm.isPathProtected(".Env.local").protected, true);
      assert.equal(sm.isPathProtected(".ENV.LOCAL").protected, true);
      assert.equal(sm.isPathProtected(".ENV.PRODUCTION").protected, true);

      // Nested directories
      assert.equal(sm.isPathProtected("sub/dir/.env").protected, true);
      assert.equal(sm.isPathProtected("sub/dir/.env.local").protected, true);
      assert.equal(sm.isPathProtected("config/.ENV").protected, true);
      assert.equal(sm.isPathProtected(path.join(ws, ".env.local")).protected, true);

      // Key files & trust store
      assert.equal(sm.isPathProtected("trusted_workspaces.json").protected, true);
      assert.equal(sm.isPathProtected("id_rsa").protected, true);
      assert.equal(sm.isPathProtected("id_rsa.pub").protected, true);
      assert.equal(sm.isPathProtected("id_ed25519").protected, true);
      assert.equal(sm.isPathProtected(".git/config").protected, true);

      // Ordinary non-protected files must not be blocked
      assert.equal(sm.isPathProtected("environment.ts").protected, false);
      assert.equal(sm.isPathProtected("env.ts").protected, false);
      assert.equal(sm.isPathProtected("src/index.ts").protected, false);
      assert.equal(sm.isPathProtected("package.json").protected, false);
      assert.equal(sm.isPathProtected("README.md").protected, false);
    });
  });

  test("SecurityManager.isPathProtected checks canonical target resolving symlinks", async () => {
    await withWorkspace(async (ws) => {
      // Create .env.local file
      const envPath = path.join(ws, ".env.local");
      fs.writeFileSync(envPath, "SECRET=123");

      // Create a symlink pointing to .env.local
      const linkPath = path.join(ws, "innocent_link.txt");
      fs.symlinkSync(envPath, linkPath);

      const sm = new SecurityManager(ws);

      // Symlink itself has innocent name, but canonical target is .env.local
      const check = sm.isPathProtected(linkPath);
      assert.equal(check.protected, true, "symlink pointing to .env.local must be protected");
      assert.ok(check.reason?.includes("resolves to protected target"));

      // Symlink with relative target
      const relLinkPath = path.join(ws, "rel_link.txt");
      fs.symlinkSync(".env.local", relLinkPath);
      assert.equal(sm.isPathProtected(relLinkPath).protected, true);
    });
  });

  test("RustCoreBridge refuses read tools on .env.local, .ENV, and symlink targets", async () => {
    await withWorkspace(async (ws) => {
      fs.writeFileSync(path.join(ws, ".env.local"), "SECRET_LOCAL=1\n");
      fs.writeFileSync(path.join(ws, ".ENV"), "SECRET_UPPER=2\n");
      fs.writeFileSync(path.join(ws, "normal.txt"), "hello world\n");
      fs.symlinkSync(path.join(ws, ".env.local"), path.join(ws, "symlink_env.txt"));

      const bridge = new RustCoreBridge(ws);
      try {
        // Normal read works
        const normalRes = await bridge.executeTool("read_file", { path: "normal.txt" });
        assert.equal(normalRes.success, true);
        assert.ok(normalRes.output.includes("hello world"));

        // read_file .env.local is refused
        const resEnvLocal = await bridge.executeTool("read_file", { path: ".env.local" });
        assert.equal(resEnvLocal.success, false);
        assert.ok(resEnvLocal.error?.includes("Security Policy Violation"));

        // read_file .ENV is refused
        const resEnvUpper = await bridge.executeTool("read_file", { path: ".ENV" });
        assert.equal(resEnvUpper.success, false);
        assert.ok(resEnvUpper.error?.includes("Security Policy Violation"));

        // read_file symlink_env.txt is refused (canonical target is .env.local)
        const resSymlink = await bridge.executeTool("read_file", { path: "symlink_env.txt" });
        assert.equal(resSymlink.success, false);
        assert.ok(resSymlink.error?.includes("Security Policy Violation"));

        // other read tools are refused on .env.local
        const resFileInfo = await bridge.executeTool("file_info", { path: ".env.local" });
        assert.equal(resFileInfo.success, false);

        const resOutline = await bridge.executeTool("outline_file", { path: ".env.local" });
        assert.equal(resOutline.success, false);

        const resBatch = await bridge.executeTool("batch_read", { paths: ["normal.txt", ".env.local"] });
        assert.equal(resBatch.success, false);

        // write_file on .env.local is refused
        const resWrite = await bridge.executeTool("write_file", { path: ".env.local", content: "EVIL" });
        assert.equal(resWrite.success, false);
      } finally {
        bridge.shutdown();
      }
    });
  });
});

describe("Slice 6: protected paths match relative to the workspace root", () => {
  function withNestedWorkspace(parentName: string, run: (ws: string, outer: string) => void): void {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-security-rel-"));
    try {
      const ws = path.join(outer, parentName, "proj");
      fs.mkdirSync(ws, { recursive: true });
      run(ws, outer);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }

  for (const parentName of [".env-tools", "id_rsa-backup", ".git"]) {
    test(`workspace under '${parentName}/' is not blocked wholesale`, () => {
      withNestedWorkspace(parentName, (ws) => {
        fs.writeFileSync(path.join(ws, "main.ts"), "x");
        fs.mkdirSync(path.join(ws, "sub"));
        fs.writeFileSync(path.join(ws, "sub", "a.ts"), "x");
        const sm = new SecurityManager(ws);
        assert.equal(sm.isPathProtected("main.ts").protected, false);
        assert.equal(sm.isPathProtected(path.join(ws, "main.ts")).protected, false);
        assert.equal(sm.isPathProtected("sub/a.ts").protected, false);
        assert.equal(sm.isPathProtected("sub/new.ts").protected, false);
        assert.equal(sm.isPathProtected(path.join(ws, "sub", "a.ts")).protected, false);
        // Still blocked inside such a workspace.
        assert.equal(sm.isPathProtected(".git/hooks/x").protected, true);
        assert.equal(sm.isPathProtected("sub/.env.local").protected, true);
        assert.equal(sm.isPathProtected(path.join(ws, "id_rsa")).protected, true);
      });
    });
  }

  test("protected names inside an ordinary workspace stay blocked", async () => {
    await withWorkspace(async (ws) => {
      const sm = new SecurityManager(ws);
      assert.equal(sm.isPathProtected(".git/hooks/x").protected, true);
      assert.equal(sm.isPathProtected("sub/.env.local").protected, true);
      assert.equal(sm.isPathProtected(path.join(ws, "a", "id_rsa.pub")).protected, true);
    });
  });

  test("a symlink to .git is refused, also inside a workspace under .env-tools/", () => {
    withNestedWorkspace(".env-tools", (ws) => {
      fs.mkdirSync(path.join(ws, ".git"));
      fs.writeFileSync(path.join(ws, ".git", "config"), "x");
      fs.symlinkSync(path.join(ws, ".git"), path.join(ws, "g"));
      const sm = new SecurityManager(ws);
      assert.equal(sm.isPathProtected("g").protected, true);
      assert.equal(sm.isPathProtected("g/config").protected, true);
      assert.equal(sm.isPathProtected("g/new").protected, true);
    });
  });

  test("a symlink resolving outside the workspace to a protected target is refused", () => {
    withNestedWorkspace("plain", (ws, outer) => {
      const outside = path.join(outer, "elsewhere");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, ".env"), "S=1");
      fs.symlinkSync(path.join(outside, ".env"), path.join(ws, "leak.txt"));
      const sm = new SecurityManager(ws);
      assert.equal(sm.isPathProtected("leak.txt").protected, true);
    });
  });

  test("a workspace-sourced policy can only add protected paths", async () => {
    await withWorkspace(async (ws) => {
      fs.writeFileSync(
        path.join(ws, ".nexus-security.json"),
        JSON.stringify({ protectedPaths: ["secrets/prod.json"], allowedPaths: [".git"], allowExternalSymlinks: true }),
      );
      const sm = new SecurityManager(ws);
      assert.equal(sm.isPathProtected("secrets/prod.json").protected, true);
      assert.equal(sm.isPathProtected(".git/config").protected, true);
      assert.equal(sm.isPathProtected(".env").protected, true);
    });
  });
});

describe("ACC-SAFE-07 & REQ-SEC-108: Destructive-command tripwire tokenization and documented bypasses", () => {
  test("Destructive commands are blocked by tripwire with Destructive-command tripwire prefix", async () => {
    await withWorkspace(async (ws) => {
      const sm = new SecurityManager(ws);

      // Destructive commands that must trigger tripwire
      const blockedCases = [
        "rm -rf /",
        "rm -rf /*",
        "rm -rf ~",
        "rm -rf $HOME",
        "rm -rf .",
        "rm -rf ..",
        "shutdown",
        "shutdown -h now",
        "reboot",
        ":(){ :|:& };:",
        "mkfs.ext4 /dev/sda1",
        "dd if=/dev/zero of=/dev/sda bs=1M",
        "> /dev/sda",
        "chmod -R 777 /",
        "chown -R root /",
      ];

      for (const cmd of blockedCases) {
        const check = sm.isCommandBlocked(cmd);
        assert.equal(check.blocked, true, `expected '${cmd}' to be blocked`);
        assert.ok(
          check.reason?.startsWith("Destructive-command tripwire"),
          `expected reason to start with Destructive-command tripwire, got: ${check.reason}`
        );
      }
    });
  });

  test("False positives are fixed and pass through tripwire (ACC-SAFE-07 / SEC-02)", async () => {
    await withWorkspace(async (ws) => {
      const sm = new SecurityManager(ws);

      // Known false positives that must pass through
      const falsePositives = [
        "rm -rf ./build",
        "rm -rf ./x",
        "rm -rf /tmp/x",
        "grep reboot",
        "grep -rn reboot src",
        "echo shutdown",
        "chown -R me /srv",
        "git status",
        "cargo test",
        "cat /etc/hosts",
        "npm run build",
      ];

      for (const cmd of falsePositives) {
        const check = sm.isCommandBlocked(cmd);
        assert.equal(check.blocked, false, `expected false positive '${cmd}' to not be blocked`);
      }
    });
  });

  test("Documented non-goals (bypasses asserted as not blocked by design per SPEC-01 §5.5 / ACC-SAFE-07)", async () => {
    await withWorkspace(async (ws) => {
      const sm = new SecurityManager(ws);

      // Bypasses from C §4 R3 that pass through the tripwire by design
      // (Safety boundary is approval/sandbox, not the tripwire)
      const bypasses = [
        "find / -delete",
        "/bin/rm -rf /",
        'python3 -c "import shutil; shutil.rmtree(\'/\')"',
        "rm -r -f /",
        "rm -rf -- /",
      ];

      for (const cmd of bypasses) {
        const check = sm.isCommandBlocked(cmd);
        assert.equal(check.blocked, false, `expected bypass '${cmd}' to pass by design (non-goal)`);
      }
    });
  });
});
