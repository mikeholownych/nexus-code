/**
 * TUI audit D-20 (a spurious "provider temporarily unavailable" notice on a healthy server). The cause: undici reuses
 * a keep-alive connection, the server closes it as the request is written (an idle timeout racing the request), and
 * the request fails with `UND_ERR_SOCKET: other side closed`, which classified as `network_error`, a temporary outage
 * with an unknown execution, so the turn waited and printed the notice. The client now resends (up to three times, on
 * another connection) when an endpoint that has answered before resets a request within moments of it being sent.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import type { AddressInfo, Socket } from "node:net";
import { AutonomousAgent } from "../src/agent.js";
import { DurableStateManager } from "../src/core/state.js";
import { LocalLlmClient } from "../src/client.js";
import { DEFAULT_RECOVERY_POLICY } from "../src/core/provider_recovery.js";
import { fakeClock } from "./helpers/provider_fixture.js";

interface Race {
  url: string;
  /** Requests the server answered. */
  answered: number;
  /** Requests it killed: the first request on every reused connection (the idle-timeout race). */
  killed: number;
  /** Set to kill every request from now on. */
  killAll: boolean;
  /** Chat requests it saw, killed or not. */
  chats: number;
  /** When set every request is answered with HTTP 503 (a gateway that is up but unhealthy), never killed. */
  status503?: boolean;
  close(): Promise<void>;
}

/**
 * A healthy OpenAI-compatible server that closes any connection the moment a second request arrives on it, the way an
 * idle keep-alive timeout does when it fires while the request is in flight. `always` kills every request instead.
 * `script(n)` gives the chat reply for the nth chat request that was answered.
 */
async function raceServer(script: (n: number) => { content?: string; tool?: { name: string; args: unknown } }, opts: { always?: boolean } = {}): Promise<Race> {
  const used = new WeakMap<Socket, number>();
  let chatsAnswered = 0;
  const sockets = new Set<Socket>();
  const race: Race = { url: "", answered: 0, killed: 0, killAll: false, chats: 0, close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); } };
  const server = http.createServer((req, res) => {
    const nth = (used.get(req.socket) ?? 0) + 1;
    used.set(req.socket, nth);
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const isChat = !req.url?.endsWith("/models");
      if (isChat) race.chats++;
      if (race.status503) {
        res.statusCode = 503;
        res.setHeader("content-type", "application/json");
        res.end('{"error":"unavailable"}');
        return;
      }
      if (opts.always || race.killAll || nth > 1) {
        race.killed++;
        req.socket.destroy();
        return;
      }
      race.answered++;
      if (!isChat) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "m" }] }));
        return;
      }
      const body = JSON.parse(raw || "{}");
      chatsAnswered++;
      const reply = script(chatsAnswered);
      const message = reply.tool
        ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] }
        : { role: "assistant", content: reply.content ?? "ok" };
      const finish = reply.tool ? "tool_calls" : "stop";
      if (!body.stream) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: finish }] }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const delta = reply.tool ? { tool_calls: [{ index: 0, ...message.tool_calls![0] }] } : { content: reply.content ?? "ok" };
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  race.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return race;
}

const user = [{ role: "user" as const, content: "x" }];

describe("D-20: a healthy server that closes a reused connection is not an outage", () => {
  test("six requests in a row all succeed on a server that kills every reused connection", async () => {
    const race = await raceServer(() => ({ content: "hi" }));
    try {
      const client = new LocalLlmClient({ model: "m", endpoint: race.url, apiKey: "k" } as any);
      for (let i = 0; i < 6; i++) assert.equal((await client.chatCompletion(user, [])).content, "hi", `request ${i}`);
      assert.ok(race.killed > 0, "connections were reused and killed (otherwise this test proves nothing)");
    } finally {
      await race.close();
    }
  });

  test("a start-up probe that meets the same race is not a failed probe", async () => {
    const race = await raceServer(() => ({ content: "hi" }));
    try {
      const client = new LocalLlmClient({ model: "m", endpoint: race.url, apiKey: "k" } as any);
      await client.chatCompletion(user, []);
      for (let i = 0; i < 6; i++) {
        const probe = await client.probeAvailability(undefined, { timeoutMs: 3_000 });
        assert.equal(probe.available, true, `probe ${i}: ${probe.detail}`);
      }
      assert.ok(race.killed > 0);
    } finally {
      await race.close();
    }
  });

  test("a server that resets its first request is an outage at once: no hidden resend before it ever answered", async () => {
    const race = await raceServer(() => ({ content: "hi" }), { always: true });
    try {
      const client = new LocalLlmClient({ model: "m", endpoint: race.url, apiKey: "k" } as any);
      await assert.rejects(client.chatCompletion(user, []), (e: any) => e.kind === "network_error" && e.condition === "TEMPORARILY_UNAVAILABLE");
      assert.equal(race.chats, 1);
    } finally {
      await race.close();
    }
  });

  test("a server that answered once and now resets everything is still an outage: bounded resends, then the ordinary failure", async () => {
    const race = await raceServer(() => ({ content: "hi" }), { always: false });
    try {
      const client = new LocalLlmClient({ model: "m", endpoint: race.url, apiKey: "k" } as any);
      await client.chatCompletion(user, []);
      const before = race.chats;
      race.killAll = true;
      await assert.rejects(client.chatCompletion(user, []), (e: any) => e.kind === "network_error" && e.condition === "TEMPORARILY_UNAVAILABLE");
      assert.equal(race.chats - before, 4, "the request and three resends, no more");
    } finally {
      await race.close();
    }
  });

  test("a server that reads every request and then resets it is sent a bounded number of resends across requests", async () => {
    const race = await raceServer(() => ({ content: "hi" }));
    try {
      const client = new LocalLlmClient({ model: "m", endpoint: race.url, apiKey: "k" } as any);
      let now = 1_000_000;
      client.resendClock = () => now;
      await client.chatCompletion(user, []);
      const before = race.chats;
      race.killAll = true;
      for (let i = 0; i < 5; i++) {
        await assert.rejects(client.chatCompletion(user, []), (e: any) => e.kind === "network_error");
        now += 1_000;
      }
      assert.equal(race.chats - before, 5 + 3, "five requests plus the three resends the endpoint is allowed per minute");
      // A new window restores the budget.
      now += 61_000;
      const again = race.chats;
      await assert.rejects(client.chatCompletion(user, []), (e: any) => e.kind === "network_error");
      assert.equal(race.chats - again, 4);
    } finally {
      await race.close();
    }
  });

  test("a 5xx answer is not health: it does not clear the resend budget a server that keeps resetting has spent", async () => {
    const race = await raceServer(() => ({ content: "hi" }));
    try {
      const client = new LocalLlmClient({ model: "m", endpoint: race.url, apiKey: "k" } as any);
      let now = 1_000_000;
      client.resendClock = () => now;
      await client.chatCompletion(user, []);
      race.killAll = true;
      // Spend the budget: five rejected requests charge their resends (3 per minute).
      for (let i = 0; i < 5; i++) {
        await assert.rejects(client.chatCompletion(user, []), (e: any) => e.kind === "network_error");
        now += 1_000;
      }
      // The gateway answers one request with a 503 (reached, not healthy): it must NOT hand the budget back.
      race.killAll = false;
      race.status503 = true;
      await assert.rejects(client.chatCompletion(user, []));
      race.status503 = false;
      race.killAll = true;
      const before = race.chats;
      await assert.rejects(client.chatCompletion(user, []), (e: any) => e.kind === "network_error");
      assert.equal(race.chats - before, 1, "the budget is still spent: no resend after a reset that follows a 503");
    } finally {
      await race.close();
    }
  });

  test("concurrent requests that all meet stale connections each get their resend", async () => {
    const race = await raceServer(() => ({ content: "hi" }));
    try {
      const client = new LocalLlmClient({ model: "m", endpoint: race.url, apiKey: "k" } as any);
      for (let round = 0; round < 4; round++) {
        await Promise.all(Array.from({ length: 6 }, () => client.chatCompletion(user, [])));
      }
      assert.ok(race.killed > 0, "connections were reused and killed (otherwise this test proves nothing)");
    } finally {
      await race.close();
    }
  });

  test("a probe that succeeds does not clear the chat budget of a server that kills chat requests", async () => {
    const race = await raceServer(() => ({ content: "hi" }));
    try {
      const client = new LocalLlmClient({ model: "m", endpoint: race.url, apiKey: "k" } as any);
      client.resendClock = () => 1_000_000;
      await client.chatCompletion(user, []);
      race.killAll = true;
      await assert.rejects(client.chatCompletion(user, []), (e: any) => e.kind === "network_error");
      race.killAll = false;
      await client.probeAvailability(undefined, { timeoutMs: 3_000 });
      race.killAll = true;
      const before = race.chats;
      await assert.rejects(client.chatCompletion(user, []), (e: any) => e.kind === "network_error");
      assert.equal(race.chats - before, 1, "the chat budget is still spent");
    } finally {
      await race.close();
    }
  });

  test("a write_file turn in auto mode on that server completes with no provider recovery and writes the file", async () => {
    const race = await raceServer((n) => (n % 2 === 1 ? { tool: { name: "write_file", args: { path: `out-${n}.txt`, content: "hello\n" } } } : { content: "wrote it" }));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-d20-"));
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: repo, stdio: "ignore" });
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-d20-state-"));
    const agent = new AutonomousAgent({ endpoint: race.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash", approvalMode: "auto", fullAccess: true } as any);
    const a = agent as any;
    a.recoveryClock = fakeClock();
    a.recoveryPolicy = { ...DEFAULT_RECOVERY_POLICY };
    a.stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [a.primaryWorkspacePathIdentity] });
    const notices: unknown[] = [];
    agent.setObserver?.({ onProviderRecovery: (e: unknown) => notices.push(e) } as any);
    try {
      for (let turn = 0; turn < 3; turn++) {
        const r = await agent.runTurn(`write the file, round ${turn}`);
        assert.equal(r.execution, "COMPLETED", `round ${turn}`);
        assert.equal(r.providerRecovery?.length ?? 0, 0, `round ${turn}: no provider recovery on a healthy server: ${JSON.stringify(r.providerRecovery?.[0]?.submissions)}`);
      }
      assert.deepEqual(notices, [], "no provider-recovery notice reached the observer");
      assert.equal(fs.readFileSync(path.join(repo, "out-1.txt"), "utf8"), "hello\n");
      assert.ok(race.killed > 0, "connections were reused and killed during the turns");
    } finally {
      agent.shutdown();
      await race.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
