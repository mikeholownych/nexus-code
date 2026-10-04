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
