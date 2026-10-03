import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { LocalLlmClient } from "../src/client.js";

async function captureHeaders(configure: (c: LocalLlmClient) => void, taskClass?: string) {
  let seen: http.IncomingHttpHeaders = {};
  const server = http.createServer((req, res) => {
    seen = req.headers;
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: {} }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address() as AddressInfo;
    const client = new LocalLlmClient({ model: "m", endpoint: `http://127.0.0.1:${port}`, apiKey: "k", taskClass } as any);
    configure(client);
    await client.chatCompletion([{ role: "user", content: "hello" }], []);
    return seen;
  } finally {
    server.close();
  }
}

test("X-Task-Class is sent when configured", async () => {
  const h = await captureHeaders(() => {}, "review");
  assert.equal(h["x-task-class"], "review");
});

test("X-Task-Class is absent by default and can be set at runtime", async () => {
  assert.equal((await captureHeaders(() => {}))["x-task-class"], undefined);
  assert.equal((await captureHeaders((c) => c.setTaskClass("architecture")))["x-task-class"], "architecture");
});

test("an invalid task class is never sent (no header injection)", async () => {
  const h = await captureHeaders((c) => c.setTaskClass("bad value\r\nX-Evil: 1"));
  assert.equal(h["x-task-class"], undefined);
  assert.equal(h["x-evil"], undefined);
});
