import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AcpStdioServer, acpStartupRefusal } from "../src/acp_stdio.js";
import { encodeMessage } from "../src/acp/jsonrpc.js";
import { encodeEvent } from "../src/protocol.js";

// The four defects the review of the adapter found by running it: auto approval was served, a signal did not end the
// process, a checkpoint choice was never answered, and a cancelled prompt left its permission behind.

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = [path.join(cli, "node_modules/tsx/dist/cli.mjs"), path.join(cli, "src/index.ts")];
const SESSION = "session_20261123_020000_abcdefgh";

function messages(output: string[]): any[] { return output.flatMap((line) => line.trim() ? [JSON.parse(line)] : []); }

async function until<T>(read: () => T | undefined | false, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function scratchHome(): { home: string; env: NodeJS.ProcessEnv } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-acp-fix-"));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
  delete env.NEXUS_APPROVAL_MODE;
  return { home, env };
}

/** A sidecar that asks for one approval per prompt and ends the turn when told to cancel. */
function fakeAdapter(onPrompt: (write: (line: string) => void, n: number) => void) {
  const output: string[] = [];
  const commands: any[] = [];
  let prompts = 0;
  const server = new AcpStdioServer({
    config: { endpoint: "http://127.0.0.1:1/v1", model: "m", workspace: "/tmp", shell: "bash" } as any,
    version: "test", write: (line) => output.push(line),
    createSidecar: (_config, _resume, write) => ({
      start() { write(encodeEvent({ type: "session.state", session: SESSION, workspace: "/tmp", workspace_name: "tmp", model: "m", mode: "review", git: null, busy: false } as any)); },
      async handleLine(line) {
        const command = JSON.parse(line); commands.push(command);
        if (command.type === "prompt.submit") onPrompt(write, ++prompts);
      },
    }),
  });
  const send = (message: object) => server.push(Buffer.from(encodeMessage(message)));
  const sidecarEvent = (event: object) => (server as any).onSidecarLine((server as any).sessions.get(SESSION), encodeEvent(event as any));
  const open = async () => {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "fixture", version: "1" }, clientCapabilities: {} } });
    await until(() => messages(output).some((item) => item.id === 1), "initialize");
    send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    await until(() => messages(output).some((item) => item.id === 2 && item.result?.sessionId), "session/new");
  };
  return { server, output, commands, send, sidecarEvent, open };
}

const approval = (n: number) => ({ type: "approval.request", id: `approval-${n}`, turn_id: `turn-${n}`, tool: "write_file", subject: "x", preview: "x", review: { kind: "args", text: "x", truncated: false } });
const interrupted = (n: number) => ({ type: "turn.result", turn_id: `turn-${n}`, heading: "Interrupted", line: "", turn: { execution: "INTERRUPTED" }, model_summary: null, saved: false });

test("nexus acp is refused under automatic approval, whichever way it was selected", () => {
  assert.equal(acpStartupRefusal({ approvalMode: "review" }), undefined);
  assert.equal(acpStartupRefusal({ approvalMode: "read-only" }), undefined);
  assert.equal(acpStartupRefusal({}), undefined);
  assert.match(acpStartupRefusal({ approvalMode: "auto" })!, /does not run with automatic approval/);
  assert.match(acpStartupRefusal({ approvalMode: "review", fullAccess: true })!, /does not run with automatic approval/);

  const { home, env } = scratchHome();
  try {
    const cases: Array<[string, string[], NodeJS.ProcessEnv]> = [
      ["--yes", ["--yes", "acp"], env],
      ["--mode auto", ["--mode", "auto", "acp"], env],
      ["NEXUS_APPROVAL_MODE=auto", ["acp"], { ...env, NEXUS_APPROVAL_MODE: "auto" }],
    ];
    for (const [name, args, childEnv] of cases) {
      // stdin is closed at once: a process that did start would read end-of-input and exit 0.
      const run = spawnSync(process.execPath, [...entry, ...args], { cwd: home, env: childEnv, encoding: "utf8", input: "", timeout: 60_000 });
      assert.equal(run.status, 2, `${name}: exit status (stderr: ${run.stderr.slice(0, 400)})`);
      assert.match(run.stderr, /nexus acp does not run with automatic approval/, name);
      assert.equal(run.stdout, "", `${name}: nothing is written to the protocol stream`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

for (const [signal, status] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
  test(`${signal} ends nexus acp with status ${status} while it waits for input`, async () => {
    const { home, env } = scratchHome();
    const child = spawn(process.execPath, [...entry, "acp"], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    try {
      child.stdin.write(encodeMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "fixture", version: "1" }, clientCapabilities: {} } }));
      await until(() => out.includes('"id":1'), "the initialize reply", 60_000);
      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      child.kill(signal);
      // stdin stays open: before the fix only closing it ended the process.
      let timer: NodeJS.Timeout | undefined;
      const code = await Promise.race([exited, new Promise<string>((resolve) => { timer = setTimeout(() => resolve("still running"), 10_000); })]);
      clearTimeout(timer);
      assert.equal(code, status);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test("a prompt cancelled while it waits for a permission leaves nothing behind: the next prompt asks again", async () => {
  const adapter = fakeAdapter((write, n) => write(encodeEvent(approval(n) as any)));
  try {
    await adapter.open();
    adapter.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: SESSION, prompt: [{ type: "text", text: "write a file" }] } });
    const first = await until(() => messages(adapter.output).find((item) => item.method === "session/request_permission"), "the first permission request");
    adapter.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 3 } });
    await until(() => messages(adapter.output).some((item) => item.id === 3 && item.error?.code === -32800), "the cancelled prompt's error");
    assert.ok(adapter.commands.some((command) => command.type === "deny" && command.id === "approval-1"), "the abandoned approval is denied in the sidecar");
    assert.ok(adapter.commands.some((command) => command.type === "cancel"));

    // Until the cancelled turn has ended, its result must not be able to answer a new prompt.
    adapter.send({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: SESSION, prompt: [{ type: "text", text: "too early" }] } });
    const early = await until(() => messages(adapter.output).find((item) => item.id === 4), "the early prompt's refusal");
    assert.equal(early.error?.code, -32603);
    assert.match(early.error.message, /still stopping/);
    assert.equal(adapter.commands.filter((command) => command.type === "prompt.submit").length, 1);

    adapter.sidecarEvent(interrupted(1));
    adapter.send({ jsonrpc: "2.0", id: 5, method: "session/prompt", params: { sessionId: SESSION, prompt: [{ type: "text", text: "write a file" }] } });
    const requests = await until(() => {
      const all = messages(adapter.output).filter((item) => item.method === "session/request_permission");
      return all.length === 2 ? all : undefined;
    }, "a second permission request");
    assert.notEqual(requests[1].id, first.id);
    assert.equal(adapter.commands.some((command) => command.type === "deny" && command.id === "approval-2"), false, "the new approval is not denied on the old one's account");

    // A late answer to the first request approves nothing.
    adapter.send({ jsonrpc: "2.0", id: first.id, result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(adapter.commands.some((command) => command.type === "approve"), false);
    adapter.send({ jsonrpc: "2.0", id: requests[1].id, result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
    const approve = await until(() => adapter.commands.find((command) => command.type === "approve"), "the approval of the second request");
    assert.deepEqual({ id: approve.id, always: approve.always }, { id: "approval-2", always: false });
  } finally {
    await adapter.server.close();
  }
});

test("a checkpoint choice is answered with cancel and fails the prompt; no client reply can pick another choice", async () => {
  const adapter = fakeAdapter((write, n) => {
    if (n === 1) write(encodeEvent({ type: "checkpoint.choice.request", id: "checkpoint-choice-1", turn_id: "turn-1", message: "Sensitive content blocked the checkpoint. Choose 1 read-only, 2 continue without a rollback checkpoint." } as any));
    else write(encodeEvent(approval(n) as any));
  });
  try {
    await adapter.open();
    adapter.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: SESSION, prompt: [{ type: "text", text: "change something" }] } });
    const failed = await until(() => messages(adapter.output).find((item) => item.id === 3), "the prompt's answer");
    assert.equal(failed.error?.code, -32603);
    assert.match(failed.error.message, /Sensitive content blocked the checkpoint/);
    const choices = adapter.commands.filter((command) => command.type === "checkpoint.choice");
    assert.deepEqual(choices.map((command) => [command.id, command.choice]), [["checkpoint-choice-1", "cancel"]]);
    assert.equal(messages(adapter.output).some((item) => item.method === "session/request_permission"), false, "the client is not asked to choose");

    // The refused turn is still winding down: its result must not be able to answer a new prompt.
    adapter.send({ jsonrpc: "2.0", id: 9, method: "session/prompt", params: { sessionId: SESSION, prompt: [{ type: "text", text: "too early" }] } });
    const early = await until(() => messages(adapter.output).find((item) => item.id === 9), "the early prompt's refusal");
    assert.match(early.error?.message ?? "", /still stopping/);

    // The real sidecar's checkpoint-cancel path emits a terminal error and then an idle session.state; it does not
    // emit turn.result because agent.runTurn never started. The adapter must release its stop latch on that sequence.
    adapter.sidecarEvent({ type: "error", id: "acp-3", code: "INTERNAL", message: "This turn was cancelled before it started." });
    adapter.sidecarEvent({ type: "session.state", session: SESSION, workspace: "/tmp", workspace_name: "tmp", model: "m", mode: "review", git: null, busy: false });
    assert.equal(messages(adapter.output).filter((item) => item.id === 3).length, 1, "a terminal sidecar error does not answer the failed prompt a second time");
    adapter.send({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: SESSION, prompt: [{ type: "text", text: "again" }] } });
    await until(() => messages(adapter.output).some((item) => item.method === "session/request_permission"), "the next prompt running normally");
  } finally {
    await adapter.server.close();
  }
});

test("a prompt whose turn has ended is answered once, even when its cancellation arrives while the receipt is fetched", async () => {
  // The fake sidecar never answers the receipt command, so the adapter waits its 2 s for it: the window under test.
  const adapter = fakeAdapter(() => {});
  try {
    await adapter.open();
    adapter.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: SESSION, prompt: [{ type: "text", text: "do it" }] } });
    await until(() => adapter.commands.some((command) => command.type === "prompt.submit"), "the prompt reaching the sidecar");
    adapter.sidecarEvent(interrupted(1));
    await until(() => adapter.commands.some((command) => command.type === "receipt"), "the receipt being fetched");
    adapter.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 3 } });
    await until(() => messages(adapter.output).some((item) => item.id === 3), "the prompt's answer", 10_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const answers = messages(adapter.output).filter((item) => item.id === 3);
    assert.equal(answers.length, 1, JSON.stringify(answers));
    assert.equal(answers[0].result?.stopReason, "cancelled");
    assert.equal(adapter.commands.some((command) => command.type === "cancel"), false, "no cancel is sent for a turn that has ended");

    // The session is still usable: nothing is left waiting for a turn result that will never come.
    adapter.send({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: SESSION, prompt: [{ type: "text", text: "again" }] } });
    await until(() => adapter.commands.filter((command) => command.type === "prompt.submit").length === 2, "the next prompt reaching the sidecar");
    assert.equal(messages(adapter.output).some((item) => item.id === 4 && item.error), false);
  } finally {
    await adapter.server.close();
  }
});

test("a signalled adapter exits within its grace period although a session never finishes stopping", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-acp-hang-"));
  const script = path.join(dir, "hang.mts");
  // A sidecar whose shutdown never resolves stands for a session stuck while stopping.
  fs.writeFileSync(script, `
import { runAcpStdio } from ${JSON.stringify(path.join(cli, "src/acp_stdio.ts"))};
import { encodeEvent } from ${JSON.stringify(path.join(cli, "src/protocol.ts"))};
runAcpStdio({
  config: { endpoint: "http://127.0.0.1:1/v1", model: "m", workspace: "/tmp", shell: "bash" },
  version: "test", shutdownGraceMs: 500,
  createSidecar: (_config, _resume, write) => ({
    start() { write(encodeEvent({ type: "session.state", session: ${JSON.stringify(SESSION)}, workspace: "/tmp", workspace_name: "tmp", model: "m", mode: "review", git: null, busy: false })); },
    handleLine(line) { return JSON.parse(line).type === "shutdown" ? new Promise(() => {}) : Promise.resolve(); },
  }),
});
`);
  const { home, env } = scratchHome();
  const child = spawn(process.execPath, [entry[0], script], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  try {
    child.stdin.write(encodeMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "fixture", version: "1" }, clientCapabilities: {} } }));
    child.stdin.write(encodeMessage({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } }));
    await until(() => out.includes('"id":2'), "the session", 60_000);
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    child.kill("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    const code = await Promise.race([exited, new Promise<string>((resolve) => { timer = setTimeout(() => resolve("still running"), 10_000); })]);
    clearTimeout(timer);
    assert.equal(code, 143);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the shutdown grace timer keeps the signal exit alive after stdio handles are unreferenced", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-acp-unref-shutdown-"));
  const script = path.join(dir, "unref.mts");
  fs.writeFileSync(script, `
import { runAcpStdio } from ${JSON.stringify(path.join(cli, "src/acp_stdio.ts"))};
import { encodeEvent } from ${JSON.stringify(path.join(cli, "src/protocol.ts"))};
runAcpStdio({
  config: { endpoint: "http://127.0.0.1:1/v1", model: "m", workspace: "/tmp", shell: "bash" },
  version: "test", shutdownGraceMs: 500,
  createSidecar: (_config, _resume, write) => ({
    start() { write(encodeEvent({ type: "session.state", session: ${JSON.stringify(SESSION)}, workspace: "/tmp", workspace_name: "tmp", model: "m", mode: "review", git: null, busy: false })); },
    handleLine(line) { return JSON.parse(line).type === "shutdown" ? new Promise(() => {}) : Promise.resolve(); },
  }),
});
// runAcpStdio's signal handler runs first; remove these otherwise-live handles after it schedules its deadline.
process.once("SIGTERM", () => {
  process.stdin.unref();
  process.stdout.unref();
  process.stderr.unref();
});
`);
  const { home, env } = scratchHome();
  const child = spawn(process.execPath, [entry[0], script], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  try {
    child.stdin.write(encodeMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "fixture", version: "1" }, clientCapabilities: {} } }));
    child.stdin.write(encodeMessage({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } }));
    await until(() => out.includes('"id":2'), "the session", 60_000);
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    child.kill("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    const code = await Promise.race([exited, new Promise<string>((resolve) => { timer = setTimeout(() => resolve("still running"), 10_000); })]);
    clearTimeout(timer);
    assert.equal(code, 143);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
