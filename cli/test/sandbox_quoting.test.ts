import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { RustCoreBridge } from "../src/tools.js";
import { wrapSandboxedCommand, isBwrapAvailable } from "../src/sandbox.js";

describe("ACC-SAFE-05 & REQ-SEC-108: Sandbox execution with complex workspace paths containing spaces and quotes", () => {
  test("Sandbox with workspace path containing spaces and quotes prints path via pwd", async () => {
    if (!isBwrapAvailable()) {
      return;
    }

    const base = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sandbox-quote-"));
    const ws = path.join(base, "a b", "'q");
    fs.mkdirSync(ws, { recursive: true });

    try {
      // 1. Direct wrapSandboxedCommand verification
      const sandboxed = wrapSandboxedCommand("pwd", ws, { mode: "bwrap" });
      assert.equal(sandboxed.sandboxed, true);
      assert.equal(sandboxed.engine, "bwrap");
      assert.ok(sandboxed.argv, "argv must be present for direct execution without shell parsing");

      // Verify that argv elements keep the unescaped path verbatim
      assert.ok(
        sandboxed.argv!.includes(ws),
        `argv must include workspace path '${ws}' without corruption`
      );

      // Verify shell string fallback properly escaped quotes
      const stdoutShell = execSync(sandboxed.command, { encoding: "utf8" }).trim();
      assert.ok(
        stdoutShell.endsWith("'q") && stdoutShell.includes("a b"),
        `Expected shell execution to print path ending in 'q with a b, got: ${stdoutShell}`
      );

      // 2. Full RustCoreBridge integration execution
      const bridge = new RustCoreBridge(ws, "bash", undefined, false, false, "bwrap");
      try {
        const res = await bridge.executeTool("run_command", { command: "pwd" });
        const parsed = JSON.parse(res.output);
        const stdout = (parsed.stdout || "").trim();
        assert.ok(
          stdout.endsWith("'q") && stdout.includes("a b"),
          `Expected bridge run_command to output path ending in 'q with a b, got stdout: ${stdout}`
        );
      } finally {
        bridge.shutdown();
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
