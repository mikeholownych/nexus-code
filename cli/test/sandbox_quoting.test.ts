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

  test("Docker sandbox keeps shell syntax in workspace paths literal through the core bridge", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sandbox-docker-argv-"));
    const payload = "$(touch${IFS}$NEXUS_SANDBOX_CANARY)";
    const ws = path.join(base, payload);
    const fakeBin = path.join(base, "bin");
    const canary = path.join(base, "host-command-executed");
    const argvLog = path.join(base, "docker-argv.txt");
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(fakeBin);
    const fakeDocker = path.join(fakeBin, "docker");
    fs.writeFileSync(fakeDocker, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$NEXUS_DOCKER_ARGV_LOG\"\n", { mode: 0o700 });
    fs.chmodSync(fakeDocker, 0o700);

    const priorPath = process.env.PATH;
    const priorCanary = process.env.NEXUS_SANDBOX_CANARY;
    const priorArgvLog = process.env.NEXUS_DOCKER_ARGV_LOG;
    process.env.PATH = `${fakeBin}${path.delimiter}${priorPath ?? ""}`;
    process.env.NEXUS_SANDBOX_CANARY = canary;
    process.env.NEXUS_DOCKER_ARGV_LOG = argvLog;

    try {
      const sandboxed = wrapSandboxedCommand("true", ws, { mode: "docker" });
      assert.equal(sandboxed.sandboxed, true);
      assert.equal(sandboxed.engine, "docker");
      assert.ok(sandboxed.argv, "Docker commands must be executed with argv, not shell parsing");
      assert.ok(sandboxed.argv.includes(`${ws}:${ws}`), "mount path must remain one literal argument");

      const bridge = new RustCoreBridge(ws, "bash", undefined, false, false, "docker");
      try {
        const res = await bridge.executeTool("run_command", { command: "true" });
        assert.equal(res.success, true, res.error);
      } finally {
        bridge.shutdown();
      }

      assert.equal(fs.existsSync(canary), false, "workspace path must not execute as host shell syntax");
      const received = fs.readFileSync(argvLog, "utf8").split("\n");
      assert.ok(received.includes(`${ws}:${ws}`), "the Docker process must receive the literal bind path");
      assert.ok(received.includes(ws), "the Docker process must receive the literal workdir path");
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
      if (priorCanary === undefined) delete process.env.NEXUS_SANDBOX_CANARY;
      else process.env.NEXUS_SANDBOX_CANARY = priorCanary;
      if (priorArgvLog === undefined) delete process.env.NEXUS_DOCKER_ARGV_LOG;
      else process.env.NEXUS_DOCKER_ARGV_LOG = priorArgvLog;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
