import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ApplicationCore } from "../src/core/app.js";
import { SidecarServer } from "../src/sidecar.js";
import { startGateway, makeRepo, waitForEvent, Reply } from "./helpers/fixtures.js";

interface Rig {
  server: SidecarServer;
  events: any[];
  repo: string;
  send(msg: Record<string, unknown>): Promise<void>;
}

async function withSidecar(script: (n: number) => Reply, mode: "auto" | "review", fn: (rig: Rig) => Promise<void>, onShutdown?: () => void): Promise<void> {
  const gw = await startGateway(script);
  const repo = makeRepo();
  const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash" } as any);
  const events: any[] = [];
  const server = new SidecarServer({ app, mode, write: (line) => events.push(JSON.parse(line)), onShutdown });
  server.start();
  try {
    await fn({ server, events, repo, send: (msg) => server.handleLine(JSON.stringify({ v: 1, ...msg })) });
  } finally {
    await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
    await server.idle();
    app.shutdown();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

const readOnlyTurn = (n: number): Reply => n === 1
  ? { kind: "tools", calls: [{ name: "list_dir", args: { path: "." } }] }
  : { kind: "text", content: "There is one file." };

describe("SidecarServer: session and turns", () => {
  test("start announces the protocol and an idle session", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ events, repo }) => {
      assert.deepEqual(events[0], { v: 1, type: "hello", protocol: 1, pid: process.pid });
      const state = events[1];
      assert.equal(state.type, "session.state");
      assert.equal(state.workspace, repo);
      assert.equal(state.workspace_name, path.basename(repo));
      assert.equal(state.model, "m");
      assert.equal(state.mode, "auto");
      assert.equal(state.busy, false);
      assert.ok(state.git && typeof state.git.branch === "string" && typeof state.git.dirty === "number");
    });
  });

  test("a read-only turn streams tool and text events, then a truthful turn.result", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "what is here?" });
      await server.idle();
      const turnEvents = events.slice(2);
      assert.deepEqual(turnEvents[0], { ...turnEvents[0], type: "session.state", busy: true });
      const start = turnEvents.find((e) => e.type === "tool.start");
      assert.equal(start.turn_id, "t1");
      assert.equal(start.tool, "list_dir");
      assert.equal(start.subject, ".");
      const end = turnEvents.find((e) => e.type === "tool.end");
      assert.equal(end.call_id, start.call_id);
      assert.equal(end.success, true);
      const text = turnEvents.filter((e) => e.type === "assistant.delta").map((e) => e.text).join("");
      assert.equal(text, "There is one file.");
      const result = turnEvents.find((e) => e.type === "turn.result");
      assert.equal(result.turn_id, "t1");
      assert.equal(result.turn.execution, "COMPLETED");
      assert.equal(result.turn.outcome, "NOT_REQUIRED");
      assert.equal(result.heading, "TURN ENDED - NO CHANGES TO VERIFY");
      assert.deepEqual(turnEvents.at(-1), { ...turnEvents.at(-1), type: "session.state", busy: false });
      const order = turnEvents.map((e) => e.type);
      assert.ok(order.indexOf("tool.end") < order.indexOf("assistant.delta"));
      assert.ok(order.indexOf("assistant.delta") < order.indexOf("turn.result"));
      for (const e of events) assert.equal(e.v, 1);
    });
  });

  test("an inference failure is projected as FAILED, not success", async () => {
    await withSidecar(() => ({ kind: "http", status: 500, body: '{"error":"boom"}' }), "auto", async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "do work" });
      await server.idle();
      const result = events.find((e) => e.type === "turn.result");
      assert.equal(result.turn.execution, "FAILED");
      assert.equal(result.turn.reason, "INFERENCE_FAILED");
      assert.equal(result.model_summary, null);
    });
  });

  test("a second prompt while busy is rejected with BUSY", async () => {
    await withSidecar(() => ({ kind: "text", content: "slow", delayMs: 1500 }), "auto", async ({ events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "one" });
      await send({ type: "prompt.submit", id: "t2", text: "two" });
      const busy = await waitForEvent(events, (e) => e.type === "error" && e.id === "t2");
      assert.equal(busy.code, "BUSY");
    });
  });

  test("malformed lines produce BAD_REQUEST errors", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events }) => {
      await server.handleLine("not json");
      await server.handleLine(JSON.stringify({ v: 1, type: "prompt.submit", id: "x", text: "" }));
      const errors = events.filter((e) => e.type === "error");
      assert.equal(errors.length, 2);
      assert.equal(errors[0].code, "BAD_REQUEST");
      assert.equal(errors[0].id, undefined);
      assert.equal(errors[1].code, "BAD_REQUEST");
      assert.equal(errors[1].id, "x");
    });
  });
});

const writeTurn = (n: number): Reply => n === 1
  ? { kind: "tools", calls: [{ name: "write_file", args: { path: "x.txt", content: "hi" } }] }
  : { kind: "text", content: "ok" };

describe("SidecarServer: approvals", () => {
  test("deny keeps the file unwritten and reports the tool as failed", async () => {
    await withSidecar(writeTurn, "review", async ({ server, events, repo, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "make x" });
      const req = await waitForEvent(events, (e) => e.type === "approval.request");
      assert.equal(req.turn_id, "t1");
      assert.equal(req.tool, "write_file");
      assert.equal(req.subject, "x.txt");
      assert.ok(req.preview.includes("x.txt"));
      await send({ type: "deny", id: req.id });
      await server.idle();
      assert.equal(fs.existsSync(path.join(repo, "x.txt")), false);
      const end = events.find((e) => e.type === "tool.end" && e.tool === "write_file");
      assert.equal(end.success, false);
      assert.ok(events.some((e) => e.type === "turn.result"));
    });
  });

  test("approve lets the write happen", async () => {
    await withSidecar(writeTurn, "review", async ({ server, events, repo, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "make x" });
      const req = await waitForEvent(events, (e) => e.type === "approval.request");
      await send({ type: "approve", id: req.id });
      await server.idle();
      assert.equal(fs.readFileSync(path.join(repo, "x.txt"), "utf-8"), "hi");
    });
  });

  test("approve with always=true stops asking for the rest of the session", async () => {
    const script = (n: number): Reply => n === 1
      ? { kind: "tools", calls: [{ name: "write_file", args: { path: "a.txt", content: "a" } }] }
      : n === 2
        ? { kind: "tools", calls: [{ name: "write_file", args: { path: "b.txt", content: "b" } }] }
        : { kind: "text", content: "done" };
    await withSidecar(script, "review", async ({ server, events, repo, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "make files" });
      const req = await waitForEvent(events, (e) => e.type === "approval.request");
      await send({ type: "approve", id: req.id, always: true });
      await server.idle();
      assert.equal(events.filter((e) => e.type === "approval.request").length, 1);
      assert.ok(fs.existsSync(path.join(repo, "a.txt")));
      assert.ok(fs.existsSync(path.join(repo, "b.txt")));
    });
  });

  test("an unknown approval id is reported, not ignored", async () => {
    await withSidecar(writeTurn, "review", async ({ events, send }) => {
      await send({ type: "approve", id: "approval-999" });
      const err = events.find((e) => e.type === "error");
      assert.equal(err.code, "NO_PENDING_APPROVAL");
      assert.equal(err.id, "approval-999");
    });
  });
});

describe("SidecarServer: cancellation", () => {
  test("cancel during inference ends the turn INTERRUPTED promptly", async () => {
    await withSidecar(() => ({ kind: "text", content: "slow answer", delayMs: 3000 }), "auto", async ({ server, events, send }) => {
      const started = Date.now();
      await send({ type: "prompt.submit", id: "t1", text: "x" });
      await new Promise((r) => setTimeout(r, 200));
      await send({ type: "cancel" });
      await server.idle();
      assert.ok(Date.now() - started < 2500, "turn ended well before the gateway replied");
      const result = events.find((e) => e.type === "turn.result");
      assert.equal(result.turn.execution, "INTERRUPTED");
      assert.equal(result.turn.outcome, "NOT_ESTABLISHED");
    });
  });

  test("cancel sent immediately after submit is not lost", async () => {
    await withSidecar(() => ({ kind: "text", content: "slow answer", delayMs: 3000 }), "auto", async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "x" });
      await send({ type: "cancel" });
      await server.idle();
      assert.equal(events.find((e) => e.type === "turn.result").turn.execution, "INTERRUPTED");
    });
  });

  test("cancel while an approval is pending denies it and interrupts the turn", async () => {
    await withSidecar(writeTurn, "review", async ({ server, events, repo, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "make x" });
      await waitForEvent(events, (e) => e.type === "approval.request");
      await send({ type: "cancel" });
      await server.idle();
      assert.equal(fs.existsSync(path.join(repo, "x.txt")), false);
      assert.equal(events.find((e) => e.type === "turn.result").turn.execution, "INTERRUPTED");
    });
  });
});

describe("SidecarServer: slash and shutdown", () => {
  test("slash status replies with slash.result", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ events, send }) => {
      await send({ type: "slash", id: "s1", command: "status" });
      const reply = events.find((e) => e.type === "slash.result");
      assert.equal(reply.id, "s1");
      assert.equal(reply.command, "status");
      assert.equal(reply.success, true);
      assert.equal(JSON.parse(reply.output).model, "m");
    });
  });

  test("shutdown calls onShutdown", async () => {
    let shutdowns = 0;
    await withSidecar(readOnlyTurn, "auto", async ({ send }) => {
      await send({ type: "shutdown" });
      assert.equal(shutdowns, 1);
    }, () => shutdowns++);
  });
});
