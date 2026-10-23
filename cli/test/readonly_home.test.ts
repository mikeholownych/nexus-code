import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RustCoreBridge } from "../src/tools.js";
import { wrapSandboxedCommand, isBwrapAvailable } from "../src/sandbox.js";

async function withFixtureHome(
  run: (fixtureHome: string, workspace: string) => Promise<void>
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-readonly-home-test-"));
  const fixtureHome = path.join(root, "fixture_home");
  const sshDir = path.join(fixtureHome, ".ssh");
  const workspace = path.join(root, "workspace");

  fs.mkdirSync(sshDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });

  const secretKey = "SUPER_SECRET_PRIVATE_KEY_DATA_DO_NOT_LEAK";
  fs.writeFileSync(path.join(sshDir, "id_rsa"), secretKey, { mode: 0o600 });
  fs.writeFileSync(path.join(workspace, "README.md"), "Safe workspace file\n");

  const prevHome = process.env.HOME;
  try {
    process.env.HOME = fixtureHome;
    await run(fixtureHome, workspace);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("ACC-SAFE-04 & REQ-SEC-104: Read-only HOME masking and workspace path confinement", () => {
  test("--read-only + run_command 'cat ~/.ssh/id_rsa' refuses or fails with No such file", async () => {
    await withFixtureHome(async (fixtureHome, workspace) => {
      const bridge = new RustCoreBridge(workspace, "bash", undefined, false, true);
      try {
        // 1. Tilde path (~/.ssh/id_rsa) must be blocked or fail without leaking secret
        const resTilde = await bridge.executeTool("run_command", {
          command: "cat ~/.ssh/id_rsa",
        });

        assert.equal(
          resTilde.success,
          false,
          "run_command 'cat ~/.ssh/id_rsa' must fail in read-only mode"
        );
        assert.ok(
          !resTilde.output.includes("SUPER_SECRET_PRIVATE_KEY_DATA_DO_NOT_LEAK"),
          "Secret key data must not leak in output"
        );
        // Error must indicate read-only violation or file not found
        assert.ok(
          resTilde.error?.includes("Read-only mode violation") ||
            resTilde.error?.includes("No such file") ||
            resTilde.output?.includes("No such file"),
          `Expected read-only violation or file not found, got error: ${resTilde.error}, output: ${resTilde.output}`
        );

        // 2. Absolute path outside workspace pointing to the key must also be blocked or masked
        const absKeyPath = path.join(fixtureHome, ".ssh", "id_rsa");
        const resAbs = await bridge.executeTool("run_command", {
          command: `cat ${absKeyPath}`,
        });

        assert.equal(
          resAbs.success,
          false,
          "run_command with absolute path outside workspace must fail in read-only mode"
        );
        assert.ok(
          !resAbs.output.includes("SUPER_SECRET_PRIVATE_KEY_DATA_DO_NOT_LEAK"),
          "Secret key data must not leak via absolute path"
        );

        // 3. Legitimate in-workspace read must succeed
        const resSafe = await bridge.executeTool("run_command", {
          command: "cat README.md",
        });
        assert.equal(resSafe.success, true, "in-workspace read should succeed");
        assert.ok(resSafe.output.includes("Safe workspace file"));
      } finally {
        bridge.shutdown();
      }
    });
  });

  test("read-only bridge rejects a workspace pathname replaced after bridge admission", async () => {
    await withFixtureHome(async (_fixtureHome, workspace) => {
      const originalWorkspace = `${workspace}-original`;
      const replacementWorkspace = `${workspace}-replacement`;
      fs.mkdirSync(replacementWorkspace);
      fs.writeFileSync(path.join(replacementWorkspace, "README.md"), "REPLACEMENT_WORKSPACE_SECRET");
      const bridge = new RustCoreBridge(workspace, "bash", undefined, false, true);

      try {
        fs.renameSync(workspace, originalWorkspace);
        fs.symlinkSync(replacementWorkspace, workspace);
        const result = await bridge.executeTool("run_command", { command: "cat README.md" });
        assert.equal(result.success, false);
        assert.match(result.error || "", /workspace identity changed/);
        assert.doesNotMatch(result.output, /REPLACEMENT_WORKSPACE_SECRET/);
      } finally {
        bridge.shutdown();
        try {
          fs.unlinkSync(workspace);
        } catch {
          // The workspace path may still be the original directory if setup failed.
        }
        if (fs.existsSync(originalWorkspace)) fs.renameSync(originalWorkspace, workspace);
      }
    });
  });

  test("bwrap wraps with --tmpfs $HOME when readOnlyHost is true", async () => {
    if (!isBwrapAvailable()) {
      return;
    }

    await withFixtureHome(async (fixtureHome, workspace) => {
      const workspaceFd = fs.openSync(workspace, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
      let sandboxed: ReturnType<typeof wrapSandboxedCommand>;
      try {
        sandboxed = wrapSandboxedCommand("ls -la $HOME", workspace, {
          mode: "bwrap",
          readOnlyHost: true,
          workspaceFd,
        });
      } finally {
        fs.closeSync(workspaceFd);
      }

      assert.equal(sandboxed.sandboxed, true);
      assert.equal(sandboxed.engine, "bwrap");
      assert.ok(sandboxed.argv, "sandboxed result must contain argv array");

      // Verify --tmpfs fixtureHome is in argv
      const tmpfsIdx = sandboxed.argv!.indexOf("--tmpfs");
      assert.ok(tmpfsIdx !== -1, "argv must include --tmpfs");
      assert.ok(
        sandboxed.argv!.includes(fixtureHome),
        `argv must include tmpfs over fixtureHome ${fixtureHome}`
      );
    });
  });
});
