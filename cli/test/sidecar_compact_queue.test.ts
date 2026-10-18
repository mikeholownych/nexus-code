/**
 * Operator /compact through the sidecar protocol (the TUI's path): queued while a turn or command runs, acknowledged at
 * once, its outcome delivered as slash.result for the request id; cancelled with the work; truthful when a write fails.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ApplicationCore } from "../src/core/app.js";
import { SidecarServer } from "../src/sidecar.js";
import { DEFAULT_CONTINUATION } from "../src/types.js";
import { startGateway, makeRepo, makeHome, waitForEvent, Reply } from "./helpers/fixtures.js";

async function rig(script: (n: number) => Reply, fn: (r: { events: any[]; send: (m: Record<string, unknown>) => Promise<void>; app: ApplicationCore; gw: Awaited<ReturnType<typeof startGateway>> }) => Promise<void>) {
  const gw = await startGateway(script);
  const repo = makeRepo();
  const home = makeHome();
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 30, temperature: 0, workspace: repo, shell: "bash", continuation: { ...DEFAULT_CONTINUATION }, approvalMode: "auto", fullAccess: true } as any);
  const events: any[] = [];
  const server = new SidecarServer({ app, mode: "auto", write: (line) => events.push(JSON.parse(line)) });
  server.start();
  try {
    await fn({ events, send: (msg) => server.handleLine(JSON.stringify({ v: 1, ...msg })), app, gw });
  } finally {
    await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
    await server.handleLine(JSON.stringify({ v: 1, type: "shutdown" }));
    process.env.HOME = previousHome;
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const write = (name: string): Reply => ({ kind: "tools", calls: [{ name: "write_file", args: { path: name, content: `${name}\n` } }] });

describe("sidecar /compact during work", () => {
  test("queued during a turn: acknowledged, run at a step boundary, outcome for each request id; the session names it", { timeout: 60_000 }, async () => {
    await rig((n) => (n <= 4 ? { ...write(`f${n}.txt`), delayMs: n === 3 ? 700 : 0 } : { kind: "text", content: "done" }), async ({ events, send, app, gw }) => {
      await send({ type: "prompt.submit", id: "t1", text: "Write f1..f4." });
      await waitForEvent(events, () => gw.requests.length === 3);
      await send({ type: "slash", id: "c1", command: "compact", args: "" });
      await send({ type: "slash", id: "c2", command: "compact", args: "" });
      const ack = await waitForEvent(events, (e) => e.type === "notice" && /\/compact queued/.test(e.text));
      assert.ok(ack);
      assert.ok(events.some((e) => e.type === "notice" && /already queued; this request shares its outcome/.test(e.text)));
      assert.ok(!events.some((e) => e.type === "error" && (e.id === "c1" || e.id === "c2")), "never refused as BUSY");
      const r1 = await waitForEvent(events, (e) => e.type === "slash.result" && e.id === "c1", 30_000);
      const r2 = await waitForEvent(events, (e) => e.type === "slash.result" && e.id === "c2", 30_000);
      assert.equal(r1.success, true, r1.output);
      assert.match(r1.output, /archive, task state and session written/);
      assert.equal(r2.output, r1.output);
      await waitForEvent(events, (e) => e.type === "turn.result", 30_000);
      const saved = app.getSessionManager().getLatestSession()!;
      assert.equal((saved as any).history.committedCompactions.length, 1, "the session record commits the compaction");
    });
  });

  test("cancel ends a waiting /compact with its outcome", { timeout: 60_000 }, async () => {
    await rig((n) => (n === 1 ? { ...write("a.txt"), delayMs: 3000 } : { kind: "text", content: "done" }), async ({ events, send, gw }) => {
      await send({ type: "prompt.submit", id: "t1", text: "Write a.txt." });
      await waitForEvent(events, () => gw.requests.length === 1);
      await send({ type: "slash", id: "c1", command: "compact", args: "--llm" });
      await waitForEvent(events, (e) => e.type === "notice" && /\/compact --llm queued/.test(e.text));
      await send({ type: "cancel" });
      const r = await waitForEvent(events, (e) => e.type === "slash.result" && e.id === "c1", 30_000);
      assert.equal(r.success, false);
      assert.match(r.output, /not run: the turn was cancelled/);
    });
  });

  test("outside a turn /compact runs at once; a failed archive write is reported as a failure", { timeout: 60_000 }, async () => {
    await rig((n) => (n <= 3 ? write(`g${n}.txt`) : { kind: "text", content: "done" }), async ({ events, send, app }) => {
      await send({ type: "prompt.submit", id: "t1", text: "Write g1..g3." });
      await waitForEvent(events, (e) => e.type === "turn.result", 30_000);
      app.getAgent().setArchiveSink(() => {
        throw new Error("EROFS: read-only file system");
      });
      await send({ type: "slash", id: "c1", command: "compact", args: "" });
      const r = await waitForEvent(events, (e) => e.type === "slash.result" && e.id === "c1", 30_000);
      assert.equal(r.success, false);
      assert.match(r.output, /Not compacted: the originals could not be archived .*EROFS/);
    });
  });
});
