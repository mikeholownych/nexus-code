import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AutonomousAgent } from "../src/agent.js";

const call = (name: string, args: Record<string, unknown>) => ({
  id: `call-${name}-${Math.random().toString(16).slice(2)}`,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

test("vllm nullable optional tool arguments execute through the Rust RPC bridge", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vllm-nullable-"));
  const agent = new AutonomousAgent({
    endpoint: "http://127.0.0.1:9/v1",
    model: "test-model",
    maxSteps: 1,
    temperature: 0,
    workspace,
    shell: "bash",
    approvalMode: "auto",
    fullAccess: true,
  } as any);
  const bridge = (agent as any).bridge;
  const bridgeArgs: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const executeTool = bridge.executeTool.bind(bridge);
  bridge.executeTool = (tool: string, args: Record<string, unknown>) => {
    bridgeArgs.push({ tool, args: { ...args } });
    return executeTool(tool, args);
  };

  try {
    fs.writeFileSync(path.join(workspace, "read-me.txt"), "line one\nline two\n");
    const nullableRead = await (agent as any).dispatchToolCall(
      call("read_file", { path: "read-me.txt", start_line: null, end_line: null, offset: null, length: null }),
      1,
      "agent",
    );
    assert.equal(nullableRead.receipt.success, true, nullableRead.receipt.error);
    assert.deepEqual(bridgeArgs[0].args, { path: "read-me.txt" }, JSON.stringify(bridgeArgs));
    const requiredNull = await (agent as any).dispatchToolCall(
      call("read_file", { path: null, start_line: null }),
      2,
      "agent",
    );
    assert.equal(requiredNull.receipt.success, false);
    assert.match(requiredNull.receipt.error, /Missing required parameter 'path'|Invalid read_file arguments|invalid type/i);

    const firstWrite = await (agent as any).dispatchToolCall(
      call("write_file", { path: "nullable.txt", content: "first", overwrite: null }),
      3,
      "agent",
    );
    assert.equal("overwrite" in bridgeArgs[1].args, false, JSON.stringify(bridgeArgs));
    assert.equal(firstWrite.receipt.success, true, firstWrite.receipt.error);
    assert.equal(fs.readFileSync(path.join(workspace, "nullable.txt"), "utf8"), "first");

    const overwrite = await (agent as any).dispatchToolCall(
      call("write_file", { path: "nullable.txt", content: "second", overwrite: true }),
      4,
      "agent",
    );
    assert.equal(overwrite.receipt.success, true, overwrite.receipt.error);
    assert.equal(fs.readFileSync(path.join(workspace, "nullable.txt"), "utf8"), "second");

    const defaultedCommand = await (agent as any).dispatchToolCall(
      call("run_command", { command: "printf rpc-default-ok", background: null, timeout_secs: null, shell: null }),
      5,
      "agent",
    );
    assert.equal(defaultedCommand.receipt.success, true, defaultedCommand.receipt.error);
    assert.equal("shell" in bridgeArgs.at(-1)!.args, false, JSON.stringify(bridgeArgs.at(-1)));
    assert.match(defaultedCommand.receipt.output, /rpc-default-ok/);

    const explicitCommand = await (agent as any).dispatchToolCall(
      call("run_command", { command: "printf rpc-explicit-ok", background: false, timeout_secs: 5, shell: "bash" }),
      6,
      "agent",
    );
    assert.equal(explicitCommand.receipt.success, true, explicitCommand.receipt.error);
    assert.match(explicitCommand.receipt.output, /rpc-explicit-ok/);
    assert.equal(bridgeArgs.at(-1)!.args.shell, "bash");
  } finally {
    (agent as any).bridge.shutdown();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("unknown special-name tools do not enter nullable argument normalization", async (context) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-special-tool-name-"));
  const agent = new AutonomousAgent({
    endpoint: "http://127.0.0.1:9/v1",
    model: "test-model",
    maxSteps: 1,
    temperature: 0,
    workspace,
    shell: "bash",
    approvalMode: "auto",
    fullAccess: true,
  } as any);

  try {
    const ordinary = await (agent as any).dispatchToolCall(call("unknown_tool", {}), 1, "agent");
    assert.equal(typeof ordinary.receipt.error, "string");
    await Promise.all(["toString", "constructor"].map((name, index) => context.test(name, async () => {
      const special = await (agent as any).dispatchToolCall(call(name, {}), index + 2, "agent");
      assert.equal(typeof special.receipt.error, "string");
      assert.equal(special.receipt.success, ordinary.receipt.success);
      assert.equal(special.receipt.status, ordinary.receipt.status);
      assert.equal(
        special.receipt.error.replace(`'${name}'`, "'<tool>'"),
        ordinary.receipt.error.replace("'unknown_tool'", "'<tool>'"),
      );
      assert.match(special.receipt.error, /not registered in CapabilityRegistry/i);
    })));
  } finally {
    (agent as any).bridge.shutdown();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("nullable optional arguments are normalised for repaired and object-form calls too (WP-1303)", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-nullable-paths-"));
  const agent = new AutonomousAgent({
    endpoint: "http://127.0.0.1:9/v1", model: "test-model", maxSteps: 1, temperature: 0, workspace,
    shell: "bash", approvalMode: "auto", fullAccess: true,
  } as any);
  const bridge = (agent as any).bridge;
  const seen: Array<Record<string, unknown>> = [];
  const executeTool = bridge.executeTool.bind(bridge);
  bridge.executeTool = (tool: string, args: Record<string, unknown>) => { seen.push({ ...args }); return executeTool(tool, args); };
  try {
    fs.writeFileSync(path.join(workspace, "r.txt"), "x\n");
    const repaired = await (agent as any).dispatchToolCall(
      { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"r.txt","start_line":null,}' } }, 1, "agent");
    assert.equal(repaired.receipt.success, true, repaired.receipt.error);
    const objectForm = await (agent as any).dispatchToolCall(
      { id: "c2", type: "function", function: { name: "read_file", arguments: { path: "r.txt", end_line: null } } }, 2, "agent");
    assert.equal(objectForm.receipt.success, true, objectForm.receipt.error);
    assert.deepEqual(seen, [{ path: "r.txt" }, { path: "r.txt" }]);
  } finally {
    bridge.shutdown();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
