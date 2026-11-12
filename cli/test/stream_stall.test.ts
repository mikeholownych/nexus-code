import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { LocalLlmClient, StreamWatchdog, type StallScheduler, type StreamStallEvent } from "../src/client.js";

/** A clock the test drives: timers fire only when `advance` passes their time. */
function fakeClock(): StallScheduler & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    set(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clear(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && timers.delete(id)) t.fn();
      }
    },
    now: () => now,
    pending: () => timers.size,
  };
}

test("D-08: a stream with no chunk for the stall interval is reported once, with the silence, and resumes on the next chunk", () => {
  const clock = fakeClock();
  const events: StreamStallEvent[] = [];
  const dog = new StreamWatchdog(0, 0, 0, undefined, { ms: 30_000, notify: (e) => events.push(e), scheduler: clock });
  clock.advance(29_999);
  assert.deepEqual(events, [], "nothing before the interval");
  clock.advance(1);
  assert.deepEqual(events, [{ stalled: true, silentSecs: 30 }]);
  clock.advance(500_000);
  assert.equal(events.length, 1, "reported once per silence, not every tick");
  dog.onChunk();
  assert.deepEqual(events.at(-1), { stalled: false, silentSecs: 530 });
  // The next silence is measured from the chunk.
  clock.advance(30_000);
  assert.deepEqual(events.at(-1), { stalled: true, silentSecs: 30 });
  dog.done();
  assert.deepEqual(events.at(-1), { stalled: false, silentSecs: 30 }, "a request that ends while silent clears the notice");
  assert.equal(clock.pending(), 0, "no timer outlives the request");
  clock.advance(10_000_000);
  assert.equal(events.length, 4);
});

test("D-08: a chunk before the interval keeps the stream quiet, and a finished request reports nothing", () => {
  const clock = fakeClock();
  const events: StreamStallEvent[] = [];
  const dog = new StreamWatchdog(0, 0, 0, undefined, { ms: 30_000, notify: (e) => events.push(e), scheduler: clock });
  for (let i = 0; i < 5; i++) {
    clock.advance(29_000);
    dog.onChunk();
  }
  assert.deepEqual(events, []);
  dog.done();
  clock.advance(60_000);
  assert.deepEqual(events, []);
});

test("D-08: a provider that sends one chunk and goes silent is reported by the client, then the answer completes", async () => {
  const clock = fakeClock();
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "starting... " } }] })}\n\n`);
      await hold;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = new LocalLlmClient({ model: "m", endpoint: base, apiKey: "k" } as any);
    const events: StreamStallEvent[] = [];
    client.onStreamStall = (e) => events.push(e);
    client.stallScheduler = clock;
    const tokens: string[] = [];
    const answer = client.chatCompletionStream([{ role: "user", content: "x" }], [], (t) => tokens.push(t));
    // Wait for the first chunk to be consumed (no sleep: poll the callback's own output).
    while (tokens.length === 0) await new Promise((r) => setImmediate(r));
    clock.advance(30_000);
    assert.deepEqual(events, [{ stalled: true, silentSecs: 30 }]);
    release();
    const message = await answer;
    assert.equal(message.content, "starting... done");
    assert.equal(events.at(-1)?.stalled, false, "the resumed chunk clears the notice");
    assert.equal(clock.pending(), 0);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("D-08: a non-streaming request on the same client never reports a stall", async () => {
  const clock = fakeClock();
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const client = new LocalLlmClient({ model: "m", endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "k" } as any);
    client.onStreamStall = () => assert.fail("no stall notice for a request without chunks");
    client.stallScheduler = clock;
    await client.chatCompletion([{ role: "user", content: "x" }], []);
    assert.equal(clock.pending(), 0);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
