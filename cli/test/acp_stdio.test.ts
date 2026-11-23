import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { AcpStdioServer } from "../src/acp_stdio.js";
import { encodeMessage } from "../src/acp/jsonrpc.js";
import { encodeEvent } from "../src/protocol.js";
import { startGateway, makeRepo, makeHome } from "./helpers/fixtures.js";

function messages(output: string[]): any[] { return output.flatMap((line) => line.trim() ? [JSON.parse(line)] : []); }

async function until(output: string[], predicate: (items: any[]) => boolean): Promise<any[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = messages(output);
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ACP output; got ${JSON.stringify(messages(output))}`);
}

test("ACP stdio completes a sidecar turn and exposes its receipt", async () => {
  const gateway = await startGateway(() => ({ kind: "text", content: "No files need changing." }));
  const repo = makeRepo();
  const home = makeHome();
  const oldHome = process.env.HOME;
  const oldXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = `${home}/.config`;
  const output: string[] = [];
  const server = new AcpStdioServer({
    config: { endpoint: gateway.url, model: "m", maxSteps: 4, temperature: 0, workspace: repo, shell: "bash", approvalMode: "read-only", readOnly: true } as any,
    version: "test",
    write: (line) => output.push(line),
  });
  const send = (message: object) => server.push(Buffer.from(encodeMessage(message)));
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "fixture", version: "1" }, clientCapabilities: {} } });
    await until(output, (items) => items.some((item) => item.id === 1 && item.result?.protocolVersion === 1));
    send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: repo, mcpServers: [] } });
    const created = await until(output, (items) => items.some((item) => item.id === 2 && item.result?.sessionId));
    const sessionId = created.find((item) => item.id === 2).result.sessionId;
    send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "Inspect this workspace and report whether files need changes." }] } });
    const completed = await until(output, (items) => items.some((item) => item.id === 3 && item.result?.stopReason));
    const response = completed.find((item) => item.id === 3);
    assert.equal(response.result.stopReason, "end_turn");
    assert.equal(response.result._meta["nexus/verification"].execution, "COMPLETED");
    const receiptId = response.result._meta["nexus/verification"].receipt_id;
    send({ jsonrpc: "2.0", id: 4, method: "_nexus/receipt/get", params: { sessionId, receiptId } });
    const withReceipt = await until(output, (items) => items.some((item) => item.id === 4 && item.result?.receipt_id));
    assert.equal(withReceipt.find((item) => item.id === 4).result.receipt_id, receiptId);
    assert.ok(withReceipt.some((item) => item.method === "session/update" && item.params.update.sessionUpdate === "session_info_update"));
  } finally {
    await server.close();
    await gateway.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
  }
});

test("read-only gate refusal stays final even if the client sends a forged allow reply", async () => {
  const gateway = await startGateway((n) => n === 1
    ? { kind: "tools", calls: [{ name: "write_file", args: { path: "forbidden.txt", content: "must not be written" } }] }
    : { kind: "text", content: "The workspace is read-only, so I could not write the file." });
  const repo = makeRepo();
  const home = makeHome();
  const oldHome = process.env.HOME;
  const oldXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = `${home}/.config`;
  const output: string[] = [];
  const server = new AcpStdioServer({
    config: { endpoint: gateway.url, model: "m", maxSteps: 4, temperature: 0, workspace: repo, shell: "bash", approvalMode: "read-only", readOnly: true } as any,
    version: "test", write: (line) => output.push(line),
  });
  const send = (message: object) => server.push(Buffer.from(encodeMessage(message)));
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "fixture", version: "1" }, clientCapabilities: {} } });
    await until(output, (items) => items.some((item) => item.id === 1));
    send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: repo, mcpServers: [] } });
    const created = await until(output, (items) => items.some((item) => item.id === 2 && item.result?.sessionId));
    const sessionId = created.find((item) => item.id === 2).result.sessionId;
    send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "Write forbidden.txt with the requested content." }] } });
    const completed = await until(output, (items) => items.some((item) => item.id === 3 && item.result?.stopReason));
    send({ jsonrpc: "2.0", id: 900, result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(fs.existsSync(`${repo}/forbidden.txt`), false);
    assert.equal(completed.some((item) => item.method === "session/request_permission"), false);
    assert.ok(completed.some((item) => item.method === "session/update" && item.params.update.sessionUpdate === "tool_call_update" && item.params.update.status === "failed"));
  } finally {
    await server.close();
    await gateway.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
  }
});

test("ACP permission replies cannot widen allow-once to an allow-always decision", async () => {
  const output: string[] = [];
  const commands: any[] = [];
  const sessionId = "session_20261123_010000_abcdefgh";
  const server = new AcpStdioServer({
    config: { endpoint: "http://127.0.0.1:1/v1", model: "m", workspace: "/tmp", shell: "bash" } as any,
    version: "test", write: (line) => output.push(line),
    createSidecar: (_config, _resume, write) => ({
      start() {
        write(encodeEvent({ type: "hello", protocol: 1, pid: 1, commands: [] } as any));
        write(encodeEvent({ type: "session.state", session: sessionId, workspace: "/tmp", workspace_name: "tmp", model: "m", mode: "review", git: null, busy: false } as any));
      },
      async handleLine(line) {
        const command = JSON.parse(line); commands.push(command);
        if (command.type === "prompt.submit") write(encodeEvent({ type: "approval.request", id: "approval-1", turn_id: "turn-1", tool: "write_file", subject: "x", preview: "x", review: { kind: "args", text: "x", truncated: false } } as any));
      },
    }),
  });
  const send = (message: object) => server.push(Buffer.from(encodeMessage(message)));
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "fixture", version: "1" }, clientCapabilities: {} } });
    await until(output, (items) => items.some((item) => item.id === 1));
    send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    await until(output, (items) => items.some((item) => item.id === 2 && item.result?.sessionId));
    send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "make a change" }] } });
    const permission = await until(output, (items) => items.some((item) => item.method === "session/request_permission"));
    const request = permission.find((item) => item.method === "session/request_permission");
    assert.deepEqual(request.params.options.map((option: any) => option.optionId), ["allow_once", "reject_once"]);
    send({ jsonrpc: "2.0", id: request.id, result: { outcome: { outcome: "selected", optionId: "allow_always" } } });
    await until(output, () => commands.some((command) => command.type === "deny"));
    assert.equal(commands.some((command) => command.type === "approve"), false);
  } finally {
    await server.close();
  }
});

test("loading a missing session fails closed instead of silently creating a fresh session", async () => {
  const output: string[] = [];
  const commands: any[] = [];
  const requested = "session_20261123_010000_abcdefgh";
  const server = new AcpStdioServer({
    config: { endpoint: "http://127.0.0.1:1/v1", model: "m", workspace: "/tmp", shell: "bash" } as any,
    version: "test", write: (line) => output.push(line),
    createSidecar: (_config, _resume, write) => ({
      start() { write(encodeEvent({ type: "session.state", session: "session_20261123_010001_abcdefgh", workspace: "/tmp", workspace_name: "tmp", model: "m", mode: "review", git: null, busy: false } as any)); },
      async handleLine(line) { commands.push(JSON.parse(line)); },
    }),
  });
  const send = (message: object) => server.push(Buffer.from(encodeMessage(message)));
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "fixture", version: "1" }, clientCapabilities: {} } });
    await until(output, (items) => items.some((item) => item.id === 1));
    send({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: requested, cwd: "/tmp", mcpServers: [] } });
    const failed = await until(output, (items) => items.some((item) => item.id === 2 && item.error));
    assert.equal(failed.find((item) => item.id === 2).error.code, -32603);
    assert.ok(commands.some((command) => command.type === "shutdown"));
    assert.equal(failed.some((item) => item.id === 2 && item.result), false);
  } finally {
    await server.close();
  }
});

test("session/load validates all history pages before replay and reports the complete extent", async () => {
  const output: string[] = [];
  const shutdowns: string[] = [];
  const sessionId = "session_20261123_010000_abcdefgh";
  const server = new AcpStdioServer({
    config: { endpoint: "http://127.0.0.1:1/v1", model: "m", workspace: "/tmp", shell: "bash" } as any,
    version: "test", write: (line) => output.push(line),
    createSidecar: (_config, _resume, write) => ({
      start() {
        write(encodeEvent({ type: "session.state", session: sessionId, workspace: "/tmp", workspace_name: "tmp", model: "m", mode: "review", git: null, busy: false } as any));
        write(encodeEvent({ type: "history", session: sessionId, total: 2, page: 0, pages: 2, messages: [{ role: "user", text: "first" }] } as any));
        write(encodeEvent({ type: "history", session: sessionId, total: 2, page: 1, pages: 2, messages: [{ role: "assistant", text: "second" }] } as any));
      },
      async handleLine(line) { shutdowns.push(JSON.parse(line).type); },
    }),
  });
  const send = (message: object) => server.push(Buffer.from(encodeMessage(message)));
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "fixture", version: "1" }, clientCapabilities: {} } });
    await until(output, (items) => items.some((item) => item.id === 1));
    send({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId, cwd: "/tmp", mcpServers: [] } });
    const loaded = await until(output, (items) => items.some((item) => item.id === 2 && item.result));
    const updates = loaded.filter((item) => item.method === "session/update").map((item) => item.params.update);
    assert.deepEqual(updates.map((update: any) => update.content.text), ["first", "second"]);
    assert.deepEqual(loaded.find((item) => item.id === 2).result._meta["nexus/history"], { sent: 2, total: 2 });
    assert.deepEqual(shutdowns, []);
  } finally {
    await server.close();
  }
});

test("session/load rejects a missing page without emitting partial history", async () => {
  const output: string[] = [];
  const shutdowns: string[] = [];
  const sessionId = "session_20261123_010000_abcdefgh";
  const server = new AcpStdioServer({
    config: { endpoint: "http://127.0.0.1:1/v1", model: "m", workspace: "/tmp", shell: "bash" } as any,
    version: "test", write: (line) => output.push(line),
    createSidecar: (_config, _resume, write) => ({
      start() {
        write(encodeEvent({ type: "session.state", session: sessionId, workspace: "/tmp", workspace_name: "tmp", model: "m", mode: "review", git: null, busy: false } as any));
        write(encodeEvent({ type: "history", session: sessionId, total: 2, page: 0, pages: 2, messages: [{ role: "user", text: "first" }] } as any));
      },
      async handleLine(line) { shutdowns.push(JSON.parse(line).type); },
    }),
  });
  const send = (message: object) => server.push(Buffer.from(encodeMessage(message)));
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "fixture", version: "1" }, clientCapabilities: {} } });
    await until(output, (items) => items.some((item) => item.id === 1));
    send({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId, cwd: "/tmp", mcpServers: [] } });
    const failed = await until(output, (items) => items.some((item) => item.id === 2 && item.error));
    assert.equal(failed.find((item) => item.id === 2).error.code, -32603);
    assert.equal(failed.filter((item) => item.method === "session/update").length, 0);
    assert.deepEqual(shutdowns, ["shutdown"]);
  } finally {
    await server.close();
  }
});

test("concurrent session creation cannot exceed the per-connection session limit", async () => {
  const output: string[] = [];
  let created = 0;
  const server = new AcpStdioServer({
    config: { endpoint: "http://127.0.0.1:1/v1", model: "m", workspace: "/tmp", shell: "bash" } as any,
    version: "test", write: (line) => output.push(line),
    createSidecar: (_config, _resume, write) => {
      const index = ++created;
      return {
        start() { write(encodeEvent({ type: "session.state", session: `session_20261123_01000${index}_abcdefgh`, workspace: "/tmp", workspace_name: "tmp", model: "m", mode: "review", git: null, busy: false } as any)); },
        async handleLine() {},
      };
    },
  });
  const send = (message: object) => server.push(Buffer.from(encodeMessage(message)));
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "fixture", version: "1" }, clientCapabilities: {} } });
    await until(output, (items) => items.some((item) => item.id === 1));
    for (let id = 2; id <= 6; id++) send({ jsonrpc: "2.0", id, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    const settled = await until(output, (items) => [2, 3, 4, 5, 6].every((id) => items.some((item) => item.id === id && (item.result || item.error))));
    assert.equal(settled.filter((item) => [2, 3, 4, 5, 6].includes(item.id) && item.result?.sessionId).length, 4);
    assert.equal(settled.find((item) => [2, 3, 4, 5, 6].includes(item.id) && item.error)?.error.code, -32603);
    assert.equal(created, 4);
  } finally {
    await server.close();
  }
});
