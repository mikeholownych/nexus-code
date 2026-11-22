/**
 * Capability negotiation (PF-1): what `hello` announces, how `initialize` is answered, and the gate experimental
 * features sit behind. A client that never sends `initialize` is the subject of every other sidecar test file.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import "./helpers/leak_guard.js";
import { ApplicationCore } from "../src/core/app.js";
import { SidecarOptions, SidecarServer } from "../src/sidecar.js";
import { EXPERIMENTAL_FEATURES, PROTOCOL_MAX, PROTOCOL_MIN, PROTOCOL_VERSION, SIDECAR_CAPABILITIES } from "../src/protocol.js";
import { slashCatalog } from "../src/slash/catalog.js";
import { startGateway, makeRepo, makeHome, waitForEvent, Reply } from "./helpers/fixtures.js";

interface Rig {
  server: SidecarServer;
  events: any[];
  send(msg: Record<string, unknown>): Promise<void>;
}

const CLIENT = { name: "test-client", version: "0.0.1" };

async function withSidecar(fn: (rig: Rig) => Promise<void>, options: Partial<SidecarOptions> = {}, script: (n: number) => Reply = () => ({ kind: "text", content: "Done." })): Promise<void> {
  const gw = await startGateway(script);
  const repo = makeRepo();
  const home = makeHome();
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash", approvalMode: "auto", fullAccess: true } as any);
  const events: any[] = [];
  const server = new SidecarServer({ app, mode: "auto", write: (line) => events.push(JSON.parse(line)), ...options });
  server.start();
  try {
    await fn({ server, events, send: (msg) => server.handleLine(JSON.stringify({ v: 1, ...msg })) });
  } finally {
    await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
    await server.idle();
    app.shutdown();
    await gw.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("SidecarServer: capability negotiation", () => {
  test("hello announces the version range, the stable capabilities and the experimental features on offer", async () => {
    await withSidecar(async ({ events }) => {
      assert.deepEqual(events[0], {
        v: 1, type: "hello", protocol: PROTOCOL_VERSION, pid: process.pid, commands: slashCatalog(),
        protocol_min: PROTOCOL_MIN, protocol_max: PROTOCOL_MAX, capabilities: [...SIDECAR_CAPABILITIES], experimental: [],
      });
      assert.deepEqual(events[0].capabilities, [...events[0].capabilities].sort(), "capabilities are sorted");
      assert.deepEqual([PROTOCOL_MIN, PROTOCOL_MAX], [1, 1]);
      assert.deepEqual(EXPERIMENTAL_FEATURES, []);
    });
    await withSidecar(async ({ events }) => {
      assert.deepEqual(events[0].experimental, ["a.test", "x.test"], "an injected list is announced sorted, without duplicates");
    }, { experimentalFeatures: ["x.test", "a.test", "x.test"] });
  });

  test("initialize with an overlapping range is answered with the highest common version", async () => {
    await withSidecar(async ({ events, send }) => {
      await send({ type: "initialize", id: "i1", client: CLIENT, protocol_min: 1, protocol_max: 4 });
      assert.deepEqual(events.at(-1), { v: 1, type: "initialized", id: "i1", protocol: PROTOCOL_MAX, capabilities: [...SIDECAR_CAPABILITIES], experimental: [] });
    });
    // No range: the version of the message itself.
    await withSidecar(async ({ events, send }) => {
      await send({ type: "initialize", id: "i2", client: CLIENT });
      assert.deepEqual(events.at(-1), { v: 1, type: "initialized", id: "i2", protocol: 1, capabilities: [...SIDECAR_CAPABILITIES], experimental: [] });
    });
  });

  test("a range with no common version is UNSUPPORTED_PROTOCOL naming both ranges, and the sidecar keeps serving", async () => {
    await withSidecar(async ({ server, events, send }) => {
      await send({ type: "initialize", id: "i1", client: CLIENT, protocol_min: 2, protocol_max: 3 });
      assert.deepEqual(events.at(-1), {
        v: 1, type: "error", id: "i1", code: "UNSUPPORTED_PROTOCOL",
        message: `No common protocol version: the client speaks 2 to 3, this sidecar speaks ${PROTOCOL_MIN} to ${PROTOCOL_MAX}.`,
      });
      assert.equal(events.some((e) => e.type === "initialized"), false);
      // Later commands are served: a request with an answer, then a whole turn.
      await send({ type: "receipt", id: "r1" });
      assert.deepEqual(events.at(-1).type, "receipt");
      await send({ type: "prompt.submit", id: "t1", text: "say done" });
      await server.idle();
      assert.equal(events.find((e) => e.type === "turn.result")?.turn_id, "t1");
      // Nothing was settled, so the client may negotiate again with a range the sidecar can serve.
      await send({ type: "initialize", id: "i2", client: CLIENT, protocol_min: 1, protocol_max: 3 });
      assert.deepEqual(events.at(-1), { v: 1, type: "initialized", id: "i2", protocol: 1, capabilities: [...SIDECAR_CAPABILITIES], experimental: [] });
    });
  });

  test("a second initialize is BAD_REQUEST and leaves the first negotiation in force", async () => {
    await withSidecar(async ({ server, events, send }) => {
      await send({ type: "initialize", id: "i1", client: CLIENT });
      await send({ type: "initialize", id: "i2", client: CLIENT, experimental: true });
      const refusal = events.at(-1);
      assert.deepEqual({ type: refusal.type, id: refusal.id, code: refusal.code }, { type: "error", id: "i2", code: "BAD_REQUEST" });
      assert.match(refusal.message, /already answered on this connection \(protocol 1\)/);
      assert.equal(events.filter((e) => e.type === "initialized").length, 1);
      assert.equal(server.requireExperimental("x.test", "g1"), false, "the refused initialize enabled nothing");
    }, { experimentalFeatures: ["x.test"] });
  });

  test("a malformed initialize is BAD_REQUEST and does not use up the connection's one negotiation", async () => {
    await withSidecar(async ({ events, send }) => {
      await send({ type: "initialize", id: "i1", client: { name: "c" } });
      assert.deepEqual(events.at(-1), { v: 1, type: "error", id: "i1", code: "BAD_REQUEST", message: "initialize requires client.version: a non-empty string" });
      await send({ type: "initialize", id: "i2", client: CLIENT, protocol_min: 3, protocol_max: 2 });
      assert.equal(events.at(-1).code, "BAD_REQUEST");
      await send({ type: "initialize", id: "i3", client: CLIENT });
      assert.equal(events.at(-1).type, "initialized");
    });
  });

  test("initialize is answered while a turn is running and does not disturb it", async () => {
    await withSidecar(async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "work" });
      await waitForEvent(events, (e) => e.type === "session.state" && e.busy === true);
      await send({ type: "initialize", id: "i1", client: CLIENT });
      assert.equal(events.at(-1).type, "initialized");
      assert.equal(events.some((e) => e.type === "turn.result"), false, "the turn is still running");
      await server.idle();
      assert.equal(events.find((e) => e.type === "turn.result")?.turn.execution, "COMPLETED");
    }, {}, () => ({ kind: "text", content: "Done.", delayMs: 1500 }));
  });

  test("an old client that never sends initialize gets a turn exactly as before, and no negotiation event", async () => {
    await withSidecar(async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "say done" });
      await server.idle();
      assert.equal(events.find((e) => e.type === "turn.result")?.turn.execution, "COMPLETED");
      assert.equal(events.some((e) => e.type === "initialized" || e.type === "error"), false);
      for (const e of events) assert.equal(e.v, 1);
    }, { experimentalFeatures: ["x.test"] });
  });
});

describe("SidecarServer: the experimental gate", () => {
  // "x.test" is registered through the test-only option; no product feature is experimental yet.
  const offered = { experimentalFeatures: ["x.test"] };

  test("an experimental feature is refused with EXPERIMENTAL_DISABLED until initialize asks for experimental", async () => {
    await withSidecar(async ({ server, events, send }) => {
      assert.equal(server.requireExperimental("x.test", "g1"), false);
      assert.deepEqual(events.at(-1), { v: 1, type: "error", id: "g1", code: "EXPERIMENTAL_DISABLED", message: "x.test is experimental: send initialize with experimental: true before using it." });
      await send({ type: "initialize", id: "i1", client: CLIENT, experimental: true });
      assert.deepEqual(events.at(-1), { v: 1, type: "initialized", id: "i1", protocol: 1, capabilities: [...SIDECAR_CAPABILITIES], experimental: ["x.test"] });
      const before = events.length;
      assert.equal(server.requireExperimental("x.test", "g2"), true);
      assert.equal(events.length, before, "an enabled feature passes the gate silently");
      // A name this sidecar does not offer stays refused, enabled connection or not; without an id the error carries none.
      assert.equal(server.requireExperimental("y.test"), false);
      assert.deepEqual(events.at(-1), { v: 1, type: "error", code: "EXPERIMENTAL_DISABLED", message: "y.test is not an experimental feature this sidecar offers." });
    }, offered);
  });

  test("initialize without experimental: true enables nothing", async () => {
    for (const experimental of [undefined, false]) {
      await withSidecar(async ({ server, events, send }) => {
        await send({ type: "initialize", id: "i1", client: CLIENT, ...(experimental === undefined ? {} : { experimental }) });
        assert.deepEqual(events.at(-1).experimental, []);
        assert.equal(server.requireExperimental("x.test", "g1"), false);
        assert.equal(events.at(-1).code, "EXPERIMENTAL_DISABLED");
      }, offered);
    }
  });
});
