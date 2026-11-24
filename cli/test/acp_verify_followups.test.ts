import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ACP_MAX_PINNED_WORKSPACES, AcpStdioServer } from "../src/acp_stdio.js";
import { encodeMessage } from "../src/acp/jsonrpc.js";
import { encodeEvent } from "../src/protocol.js";
import { mergePolicies } from "../src/core/managed_policy.js";
import { VERIFY_KILL_GRACE_MS, type VerifyRunner, type VerifyWorkerJob } from "../src/core/verify_service.js";
import { makeRepo } from "./helpers/fixtures.js";

// VR-2 review follow-ups: the base is pinned per workspace, the result names what it covered, a request without a
// receipt id serves turn receipts only, and the interlocks between a verification and a turn hold.

const VERDICT = { result: { schema_version: 3, verdict: "VERIFIED", outcome: "VERIFIED" } as any };
const sessionName = (n: number) => `session_20261124_0300${String(n).padStart(2, "0")}_abcdefgh`;
const turnResult = { type: "turn.result", turn_id: "turn-1", heading: "Interrupted", line: "", turn: { execution: "INTERRUPTED" }, model_summary: null, saved: false };
const head = (repo: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

function commit(repo: string, file: string): void {
  fs.writeFileSync(path.join(repo, file), "committed after the first session\n");
  execFileSync("git", ["add", file], { cwd: repo });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", file], { cwd: repo, stdio: "ignore" });
}

/** An adapter over fake sidecars (one per session, named in order) and a fake verification runner. */
function adapter(options: { readOnly?: boolean; run?: VerifyRunner; loadFails?: boolean; shutdownGraceMs?: number; killGraceMs?: number } = {}) {
  const output: string[] = [];
  const commands: Array<{ session: string; type: string }> = [];
  const jobs: VerifyWorkerJob[] = [];
  const writers = new Map<string, (line: string) => void>();
  let created = 0;
  let nextId = 100;
  const server = new AcpStdioServer({
    config: { endpoint: "http://127.0.0.1:1/v1", model: "m", workspace: "/tmp", shell: "bash", approvalMode: options.readOnly ? "read-only" : "review", readOnly: Boolean(options.readOnly), authoritativeVerifierCommand: "npm test" } as any,
    version: "test", write: (line) => output.push(line), shutdownGraceMs: options.shutdownGraceMs,
    verifyDeps: { policy: () => mergePolicies(), killGraceMs: options.killGraceMs, run: async (job, signal) => { jobs.push(job); return options.run ? options.run(job, signal) : VERDICT; } },
    createSidecar: (config, resume, write) => {
      // A load that answers with another session's id is one the adapter refuses.
      const session = resume && !options.loadFails ? resume : sessionName(++created);
      writers.set(session, write);
      return {
        start() {
          write(encodeEvent({ type: "session.state", session, workspace: config.workspace, workspace_name: "fixture", model: "m", mode: "review", git: null, busy: false } as any));
          if (resume) write(encodeEvent({ type: "history", session, total: 0, page: 0, pages: 1, messages: [] } as any));
        },
        async handleLine(line) {
          const command = JSON.parse(line);
          commands.push({ session, type: command.type });
          if (command.type === "receipt") write(encodeEvent({ type: "receipt", id: command.id, sections: [] } as any));
        },
      };
    },
  });
  const messages = (): any[] => output.flatMap((line) => line.trim() ? [JSON.parse(line)] : []);
  const send = (message: object) => server.push(Buffer.from(encodeMessage(message)));
  const until = async <T>(read: () => T | undefined | false, what: string): Promise<T> => {
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
      const value = read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`timed out waiting for ${what}; got ${JSON.stringify(messages())}`);
  };
  const answer = (id: number) => until(() => messages().find((item) => item.id === id && (item.result !== undefined || item.error !== undefined)), `the answer to request ${id}`);
  /** Send a request and wait for its answer. */
  const call = (method: string, params: object) => { const id = nextId++; send({ jsonrpc: "2.0", id, method, params }); return answer(id); };
  const open = async (cwd: string): Promise<string> => (await call("session/new", { cwd, mcpServers: [] })).result.sessionId;
  const initialize = () => call("initialize", { protocolVersion: 1, clientInfo: { name: "fixture", version: "1" }, clientCapabilities: {} });
  const sidecarEvent = (session: string, event: object) => writers.get(session)!(encodeEvent(event as any));
  /** A prompt that has reached its sidecar and is still running. Returns its request id. */
  const startPrompt = async (sessionId: string): Promise<number> => {
    const id = nextId++;
    const before = commands.filter((command) => command.type === "prompt.submit").length;
    send({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "do it" }] } });
    await until(() => commands.filter((command) => command.type === "prompt.submit").length > before, "the prompt reaching the sidecar");
    return id;
  };
  return { server, commands, jobs, send, until, answer, call, open, initialize, sidecarEvent, startPrompt, messages };
}

test("a workspace's base is pinned once per process: a later session on that directory, new or loaded, keeps the first pin", async () => {
  const repo = makeRepo();
  const other = makeRepo();
  const links = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-acp-pin-"));
  const a = adapter();
  try {
    await a.initialize();
    const first = await a.open(repo);
    const pinned = head(repo);
    commit(repo, "weakened.test.txt");
    assert.notEqual(head(repo), pinned);

    // The same directory under another name is the same workspace.
    fs.symlinkSync(repo, path.join(links, "alias"));
    const second = await a.open(path.join(links, "alias"));
    const loaded = sessionName(50);
    assert.deepEqual((await a.call("session/load", { sessionId: loaded, cwd: repo, mcpServers: [] })).error, undefined);
    const elsewhere = await a.open(other);

    const results = [];
    for (const sessionId of [second, loaded, first]) results.push((await a.call("_nexus/verify", { sessionId })).result);
    for (const [index, result] of results.entries()) {
      assert.equal(a.jobs[index].request.base, pinned, "the service is given the first pin, not the commit made since");
      assert.equal(a.jobs[index].request.worktree, fs.realpathSync(repo));
      assert.equal(result.base_pinned_commit, pinned);
      assert.equal(result.base_pinned_at, results[0].base_pinned_at, "one pin, made once");
      assert.equal(result.workspace, fs.realpathSync(repo));
    }
    const receipt = (await a.call("_nexus/receipt/get", { sessionId: second, receiptId: results[0].receipt_id })).result;
    assert.equal(receipt.base_pinned_at, results[0].base_pinned_at);
    assert.equal(receipt.workspace, fs.realpathSync(repo));

    // Another directory has its own pin.
    const separate = (await a.call("_nexus/verify", { sessionId: elsewhere })).result;
    assert.equal(separate.base_pinned_commit, head(other));
    assert.equal(separate.workspace, fs.realpathSync(other));
    assert.equal(a.jobs[3].request.base, head(other));
  } finally {
    await a.server.close();
    for (const dir of [repo, other, links]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the pins are bounded: past the bound a new workspace is refused verification and no earlier pin is replaced", async () => {
  const repo = makeRepo();
  const late = makeRepo();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-acp-pins-"));
  // Only a failed session start leaves a pin without a live session, so that is how a client fills the table.
  const a = adapter({ loadFails: true });
  try {
    await a.initialize();
    const first = await a.open(repo);
    const pinned = head(repo);
    for (let n = 1; n < ACP_MAX_PINNED_WORKSPACES; n++) {
      const dir = path.join(scratch, `d${n}`);
      fs.mkdirSync(dir);
      assert.equal((await a.call("session/load", { sessionId: sessionName(60), cwd: dir, mcpServers: [] })).error?.code, -32603);
    }
    commit(repo, "weakened.test.txt");

    const unpinned = await a.open(late);
    const refused = await a.call("_nexus/verify", { sessionId: unpinned });
    assert.equal(refused.error?.code, -32603);
    assert.match(refused.error.message, new RegExp(`already pinned a verification base for ${ACP_MAX_PINNED_WORKSPACES} workspaces`));
    assert.equal(a.jobs.length, 0, "nothing runs for a workspace that has no pin");
    // Asking again, or opening another session there, does not pin it after all.
    const again = await a.open(late);
    assert.equal((await a.call("_nexus/verify", { sessionId: again })).error?.code, -32603);
    assert.equal(a.jobs.length, 0);

    const kept = (await a.call("_nexus/verify", { sessionId: first })).result;
    assert.equal(kept.base_pinned_commit, pinned, "the first workspace keeps its pin");
    assert.equal(a.jobs[0].request.base, pinned);
  } finally {
    await a.server.close();
    for (const dir of [repo, late, scratch]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("_nexus/receipt/get without an id returns the last turn receipt after a verification; the verification receipt is read by id", async () => {
  const repo = makeRepo();
  const a = adapter();
  try {
    await a.initialize();
    const sessionId = await a.open(repo);
    const prompt = await a.startPrompt(sessionId);
    a.sidecarEvent(sessionId, turnResult);
    const turnReceiptId = (await a.answer(prompt)).result._meta["nexus/verification"].receipt_id;

    const summary = (await a.call("_nexus/verify", { sessionId })).result;
    assert.match(summary.receipt_id, /^vr-[0-9a-f]{32}$/);
    assert.equal(a.messages().some((item) => item.method === "session/update" && item.params.update._meta?.["nexus/verification"]?.receipt_id === summary.receipt_id), false);

    const latest = (await a.call("_nexus/receipt/get", { sessionId })).result;
    assert.equal(latest.receipt_id, turnReceiptId, "an existing client still gets the turn receipt");
    assert.equal(latest.turn_id, "turn-1");
    assert.equal("receipt_sha256" in latest, false);

    const verification = (await a.call("_nexus/receipt/get", { sessionId, receiptId: summary.receipt_id })).result;
    assert.equal(verification.receipt_id, summary.receipt_id);
    assert.equal(verification.receipt_sha256, summary.receipt_sha256);
    assert.equal(verification.result.verdict, "VERIFIED");
    assert.equal((await a.call("_nexus/receipt/get", { sessionId, receiptId: turnReceiptId })).result.receipt_id, turnReceiptId);
  } finally {
    await a.server.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("_nexus/verify is refused while the session's prompt runs and while it is stopping, and nothing runs", async () => {
  const repo = makeRepo();
  const a = adapter();
  try {
    await a.initialize();
    const sessionId = await a.open(repo);
    const prompt = await a.startPrompt(sessionId);
    const during = await a.call("_nexus/verify", { sessionId });
    assert.equal(during.error?.code, -32603);
    assert.match(during.error.message, /while a session turn is active or stopping/);

    // The prompt is answered as cancelled, and its turn has not ended yet: the session is stopping.
    a.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: prompt } });
    assert.equal((await a.answer(prompt)).error?.code, -32800);
    const stopping = await a.call("_nexus/verify", { sessionId });
    assert.equal(stopping.error?.code, -32603);
    assert.match(stopping.error.message, /while a session turn is active or stopping/);
    assert.equal(a.jobs.length, 0, "no verification was started");
    assert.equal((await a.call("_nexus/receipt/get", { sessionId })).error?.code, -32602, "and there is no receipt");

    // Once the turn has ended the same request runs: the refusals were the interlock, nothing else.
    a.sidecarEvent(sessionId, turnResult);
    assert.equal((await a.call("_nexus/verify", { sessionId })).result?.verdict, "VERIFIED");
    assert.equal(a.jobs.length, 1);
  } finally {
    await a.server.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("session/prompt is refused while a verification of its workspace runs", async () => {
  const repo = makeRepo();
  let finish!: () => void;
  const a = adapter({ run: () => new Promise((resolve) => { finish = () => resolve(VERDICT); }) });
  try {
    await a.initialize();
    const sessionId = await a.open(repo);
    a.send({ jsonrpc: "2.0", id: 7, method: "_nexus/verify", params: { sessionId } });
    await a.until(() => a.jobs.length === 1, "the verification starting");
    const prompt = await a.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "edit the tests" }] });
    assert.equal(prompt.error?.code, -32603);
    assert.match(prompt.error.message, /a verification is running for this workspace/);
    assert.equal(a.commands.some((command) => command.type === "prompt.submit"), false, "the prompt never reached the sidecar");
    finish();
    assert.equal((await a.answer(7)).result?.verdict, "VERIFIED");
  } finally {
    finish?.();
    await a.server.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("_nexus/verify in read-only mode is refused: nothing runs and no receipt exists", async () => {
  const repo = makeRepo();
  const a = adapter({ readOnly: true });
  try {
    await a.initialize();
    const sessionId = await a.open(repo);
    const refused = await a.call("_nexus/verify", { sessionId });
    assert.equal(refused.error?.code, -32603);
    assert.equal(refused.error.data?.reason, "read_only");
    assert.equal(refused.result, undefined);
    assert.equal(a.jobs.length, 0);
    assert.deepEqual((a.server as any).verifyService.list(sessionId), []);
    assert.equal((await a.call("_nexus/receipt/get", { sessionId })).error?.code, -32602);
  } finally {
    await a.server.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a verification receipt cannot be read through another active session of the same connection", async () => {
  const repo = makeRepo();
  const a = adapter();
  try {
    await a.initialize();
    const owner = await a.open(repo);
    const other = await a.open(repo);
    assert.notEqual(owner, other);
    const receiptId = (await a.call("_nexus/verify", { sessionId: owner })).result.receipt_id;

    const crossed = await a.call("_nexus/receipt/get", { sessionId: other, receiptId });
    assert.equal(crossed.error?.code, -32602);
    assert.equal(crossed.error.message, "receipt is not available on this connection");
    assert.equal((await a.call("_nexus/receipt/get", { sessionId: other })).error?.code, -32602);
    assert.equal((await a.call("_nexus/receipt/get", { sessionId: owner, receiptId })).result.session_id, owner);
  } finally {
    await a.server.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("the signal deadline outlasts the verify kill grace only while a verification runs", async () => {
  const repo = makeRepo();
  let finish!: () => void;
  const run: VerifyRunner = () => new Promise((resolve) => { finish = () => resolve(VERDICT); });
  const servers: AcpStdioServer[] = [];
  try {
    for (const [options, idle, verifying] of [
      [{}, 10_000, VERIFY_KILL_GRACE_MS + 5_000],
      [{ shutdownGraceMs: 500 }, 500, VERIFY_KILL_GRACE_MS + 5_000],
      [{ shutdownGraceMs: 500, killGraceMs: 100 }, 500, 5_100],
      [{ shutdownGraceMs: 60_000 }, 60_000, 60_000],
    ] as Array<[{ shutdownGraceMs?: number; killGraceMs?: number }, number, number]>) {
      const a = adapter({ run, ...options });
      servers.push(a.server);
      await a.initialize();
      const sessionId = await a.open(repo);
      assert.equal(a.server.shutdownGraceMs(), idle);
      a.send({ jsonrpc: "2.0", id: 7, method: "_nexus/verify", params: { sessionId } });
      await a.until(() => a.jobs.length === 1, "the verification starting");
      assert.equal(a.server.shutdownGraceMs(), verifying);
      finish();
      await a.answer(7);
      assert.equal(a.server.shutdownGraceMs(), idle);
    }
  } finally {
    finish?.();
    for (const server of servers) await server.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
