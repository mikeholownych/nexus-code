import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { test } from "node:test";
import { startModelProxy } from "./model_proxy.mjs";

test("request-context evidence stores only exact-body hashes and counts", async () => {
  let receivedBody;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    receivedBody = Buffer.concat(chunks);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  const proxy = await startModelProxy({ upstream: `http://127.0.0.1:${address.port}/v1` });
  try {
    const body = JSON.stringify({
      model: "test-model", messages: [{ role: "user", content: "PROMPT_PRIVATE_CANARY" }],
      tools: [{ type: "function", function: { name: "run_command", parameters: { type: "object" } } }],
      temperature: 0, max_tokens: 10,
    });
    const response = await fetch(`${proxy.url}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(response.status, 200);
    const stats = proxy.stats();
    assert.equal(receivedBody.toString("utf8"), body, "the proxy forwards the request body unchanged");
    assert.deepEqual(stats.requestContexts, [{
      requestIndex: 1,
      sha256: createHash("sha256").update(body).digest("hex"),
      serializedBytes: Buffer.byteLength(body),
      messageCount: 1,
      toolCount: 1,
    }]);
    assert.equal(JSON.stringify(stats).includes("PROMPT_PRIVATE_CANARY"), false);
    stats.requestContexts[0].sha256 = "0".repeat(64);
    assert.notEqual(proxy.stats().requestContexts[0].sha256, "0".repeat(64), "a caller cannot mutate retained evidence through stats()");
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
