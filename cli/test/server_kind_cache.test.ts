import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { LocalLlmClient } from "../src/client.js";
import { ServerKindCache } from "../src/core/server_kind_cache.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;
async function withEndpoint<T>(handler: Handler, run: (endpoint: string) => Promise<T>): Promise<T> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try { return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { server.closeAllConnections?.(); server.close(); }
}
const json = (res: http.ServerResponse, body: unknown) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); };
const ok = (res: http.ServerResponse) => json(res, { choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] });
const gatewayEntry = { id: "model-a", limits_version: "1", context_length: 4096 };
const msg = [{ role: "user" as const, content: "hi" }];

test("ServerKindCache entries expire after the TTL and can be deleted", () => {
  let t = 0;
  const cache = new ServerKindCache(1000, () => t);
  cache.set("k", "gateway");
  assert.equal(cache.get("k"), "gateway");
  t = 999; assert.equal(cache.get("k"), "gateway");
  t = 1000; assert.equal(cache.get("k"), undefined);
  cache.set("k", "vllm"); cache.delete("k"); assert.equal(cache.get("k"), undefined);
});

test("a gateway identity is not carried onto a replaced server whose catalog returns 404 (REQ-PRV-109)", async () => {
  let phase: "gateway" | "replaced" = "gateway";
  const headers: Array<string | undefined> = [];
  await withEndpoint((req, res) => {
    if (req.url === "/v1/models") { if (phase === "gateway") return json(res, { data: [gatewayEntry] }); res.statusCode = 404; return res.end(); }
    if (req.url === "/v1/chat/completions") { headers.push(req.headers["x-task-class"] as string | undefined); return ok(res); }
    res.statusCode = 404; res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ endpoint: `${endpoint}/v1`, model: "model-a", taskClass: "subagent" } as any);
    await client.discoverAdvertisement();
    assert.equal(client.getDetectedServerKind(), "gateway");
    await client.chatCompletion(msg, []);
    phase = "replaced";
    await client.discoverAdvertisement();
    await client.chatCompletion(msg, []);
  });
  assert.deepEqual(headers, ["subagent", undefined]);
});

test("a gateway identity is not carried when the replaced server no longer lists the model", async () => {
  let phase = 0;
  await withEndpoint((req, res) => {
    if (req.url === "/v1/models") return json(res, { data: [phase === 0 ? gatewayEntry : { id: "other" }] });
    res.statusCode = 404; res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ endpoint: `${endpoint}/v1`, model: "model-a" } as any);
    await client.discoverAdvertisement();
    assert.equal(client.getDetectedServerKind(), "gateway");
    phase = 1;
    await client.discoverAdvertisement();
    assert.equal(client.getDetectedServerKind(), "unknown");
  });
});

test("a verified vLLM kind survives a 404 catalog and a thrown catalog read", async () => {
  let mode: "ok" | "404" | "drop" = "ok";
  await withEndpoint((req, res) => {
    if (req.url === "/v1/models") {
      if (mode === "404") { res.statusCode = 404; return res.end(); }
      if (mode === "drop") return res.destroy();
      return json(res, { data: [{ id: "model-a", owned_by: "vllm", max_model_len: 8192 }] });
    }
    if (req.url === "/version") return json(res, { version: "0.10.0" });
    res.statusCode = 404; res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ endpoint: `${endpoint}/v1`, model: "model-a" } as any);
    await client.discoverAdvertisement();
    assert.equal(client.getDetectedServerKind(), "vllm");
    mode = "404"; assert.equal((await client.discoverAdvertisement()).state, "unsupported");
    assert.equal(client.getDetectedServerKind(), "vllm");
    mode = "drop"; assert.equal((await client.discoverAdvertisement()).state, "unavailable");
    assert.equal(client.getDetectedServerKind(), "vllm");
  });
});

test("a retained vLLM kind keeps advertised.via so request counting stays on", async () => {
  let versionOk = true;
  await withEndpoint((req, res) => {
    if (req.url === "/v1/models") return json(res, { data: [{ id: "model-a", owned_by: "vllm", max_model_len: 8192 }] });
    if (req.url === "/version") { if (versionOk) return json(res, { version: "0.10.0" }); res.statusCode = 503; return res.end(); }
    res.statusCode = 404; res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ endpoint: `${endpoint}/v1`, model: "model-a" } as any);
    assert.equal((await client.discoverAdvertisement()).advertised?.via, "vllm");
    versionOk = false;
    const again = await client.discoverAdvertisement();
    assert.equal(client.getDetectedServerKind(), "vllm");
    assert.equal(again.advertised?.via, "vllm");
  });
});

test("a transient Ollama /api/version failure does not downgrade a known Ollama kind", async () => {
  let versionOk = true;
  await withEndpoint((req, res) => {
    if (req.url === "/v1/models") return json(res, { data: [{ id: "model-a", owned_by: "library" }] });
    if (req.url === "/api/version") { if (versionOk) return json(res, { version: "0.5.0" }); res.statusCode = 503; return res.end(); }
    if (req.url === "/api/show") return json(res, { model: "model-a", model_info: { "llama.context_length": 4096 } });
    res.statusCode = 404; res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ endpoint: `${endpoint}/v1`, model: "model-a" } as any);
    await client.discoverAdvertisement();
    assert.equal(client.getDetectedServerKind(), "ollama", "the mock must be detected as Ollama or this test proves nothing");
    versionOk = false;
    await client.discoverAdvertisement();
    assert.equal(client.getDetectedServerKind(), "ollama");
  });
});

test("a switch of endpoint, provider or credential does not inherit another server's identity", async () => {
  await withEndpoint((req, res) => {
    if (req.url === "/v1/models") return json(res, { data: [gatewayEntry] });
    res.statusCode = 404; res.end();
  }, async (endpoint) => {
    const a = new LocalLlmClient({ endpoint: `${endpoint}/v1`, model: "model-a" } as any);
    a.setApiKey("account-one");
    await a.discoverAdvertisement();
    assert.equal(a.getDetectedServerKind(), "gateway");
    const b = new LocalLlmClient({ endpoint: `${endpoint}/v1`, model: "model-a" } as any);
    b.setApiKey("account-two");
    assert.equal(b.getDetectedServerKind(), "unknown", "another account has not verified this server");
    a.setApiKey("account-two");
    assert.equal(a.getDetectedServerKind(), "unknown", "a credential switch invalidates the identity");
    a.setApiKey("account-one");
    assert.equal(a.getDetectedServerKind(), "gateway");
  });
});

test("the cache sweeps expired entries on write and stays bounded", () => {
  let t = 0;
  const cache = new ServerKindCache(100, () => t, 3);
  cache.set("a", "vllm"); cache.set("b", "vllm");
  t = 100; cache.set("c", "gateway");
  assert.equal(cache.size, 1, "a and b expired and were swept by the write of c");
  cache.set("d", "vllm"); cache.set("e", "vllm"); cache.set("f", "vllm");
  assert.equal(cache.size, 3);
  assert.equal(cache.get("c"), undefined, "the oldest entry was evicted");
});

test("an identity expires through the client after the TTL", async () => {
  await withEndpoint((req, res) => {
    if (req.url === "/v1/models") return json(res, { data: [gatewayEntry] });
    res.statusCode = 404; res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ endpoint: `${endpoint}/v1`, model: "model-a" } as any);
    await client.discoverAdvertisement();
    assert.equal(client.getDetectedServerKind(), "gateway");
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60_000;
    try { assert.equal(client.getDetectedServerKind(), "unknown"); } finally { Date.now = realNow; }
  });
});

test("a gateway identity is kept through a 5xx or dropped catalog read until the TTL (documented policy)", async () => {
  let mode: "ok" | "503" | "drop" = "ok";
  await withEndpoint((req, res) => {
    if (req.url === "/v1/models") {
      if (mode === "503") { res.statusCode = 503; return res.end(); }
      if (mode === "drop") return res.destroy();
      return json(res, { data: [gatewayEntry] });
    }
    res.statusCode = 404; res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ endpoint: `${endpoint}/v1`, model: "model-a" } as any);
    await client.discoverAdvertisement();
    mode = "503"; assert.equal((await client.discoverAdvertisement()).state, "unavailable");
    assert.equal(client.getDetectedServerKind(), "gateway");
    mode = "drop"; assert.equal((await client.discoverAdvertisement()).state, "unavailable");
    assert.equal(client.getDetectedServerKind(), "gateway");
  });
});

for (const stream of [false, true]) {
  test(`X-Task-Class follows the endpoint a request is sent to, not the active one, on failover (${stream ? "streaming" : "non-streaming"})`, async () => {
    const seen: Array<{ who: string; header: string | undefined }> = [];
    const sse = (res: http.ServerResponse) => { res.setHeader("Content-Type", "text/event-stream"); res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); };
    const handler = (who: string, healthy: boolean): Handler => (req, res) => {
      if (req.url === "/v1/models") return json(res, { data: [who === "gw" ? gatewayEntry : { id: "model-a" }] });
      if (req.url === "/v1/chat/completions") {
        seen.push({ who, header: req.headers["x-task-class"] as string | undefined });
        if (!healthy) { res.statusCode = 503; return res.end("down"); }
        return stream ? sse(res) : ok(res);
      }
      res.statusCode = 404; res.end();
    };
    await withEndpoint(handler("gw", false), async (gw) => withEndpoint(handler("plain", true), async (plain) => {
      const client = new LocalLlmClient({ endpoint: `${gw}/v1`, model: "model-a", taskClass: "subagent" } as any);
      client.addFallbackEndpoint(plain);
      await client.discoverAdvertisement();
      assert.equal(client.getDetectedServerKind(), "gateway");
      if (stream) await client.chatCompletionStream(msg, []); else await client.chatCompletion(msg, []);
    }));
    const plainHits = seen.filter((s) => s.who === "plain");
    assert.ok(plainHits.length >= 1, "the request must have failed over to the plain server");
    assert.ok(plainHits.every((s) => s.header === undefined), "the plain fallback must not receive X-Task-Class");
    assert.equal(seen.find((s) => s.who === "gw")?.header, "subagent");
  });
}

test("request token counting sends X-Task-Class only to a verified gateway", async () => {
  const seen: Array<string | undefined> = [];
  for (const gateway of [true, false]) {
    await withEndpoint((req, res) => {
      if (req.url === "/v1/models") return json(res, { data: [gateway ? gatewayEntry : { id: "model-a" }] });
      if (req.url?.endsWith("/tokenize")) { seen.push(req.headers["x-task-class"] as string | undefined); return json(res, { count: 3 }); }
      res.statusCode = 404; res.end();
    }, async (endpoint) => {
      const client = new LocalLlmClient({ endpoint: `${endpoint}/v1`, model: "model-a", taskClass: "subagent" } as any);
      await client.discoverAdvertisement();
      await client.countRequestTokens(msg, [], "req-count").catch(() => undefined);
    });
  }
  assert.deepEqual(seen, ["subagent", undefined]);
});

async function withClock<T>(run: (advance: (ms: number) => void) => Promise<T>): Promise<T> {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try { return await run((ms) => { offset += ms; }); } finally { Date.now = realNow; }
}

test("retaining a kind through a 404 catalog does not extend its TTL", async () => {
  let mode: "ok" | "404" = "ok";
  await withClock((advance) => withEndpoint((req, res) => {
    if (req.url === "/v1/models") {
      if (mode === "404") { res.statusCode = 404; return res.end(); }
      return json(res, { data: [{ id: "model-a", owned_by: "vllm", max_model_len: 8192 }] });
    }
    if (req.url === "/version") return json(res, { version: "0.10.0" });
    res.statusCode = 404; res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ endpoint: `${endpoint}/v1`, model: "model-a" } as any);
    await client.discoverAdvertisement();
    mode = "404";
    advance(6 * 60_000);
    await client.discoverAdvertisement();
    assert.equal(client.getDetectedServerKind(), "vllm", "retained while still within the original TTL");
    advance(5 * 60_000);
    assert.equal(client.getDetectedServerKind(), "unknown", "the retained identity expires with its original entry");
  }));
});

test("a failed Ollama probe retains the kind without extending its TTL", async () => {
  let versionOk = true;
  await withClock((advance) => withEndpoint((req, res) => {
    if (req.url === "/v1/models") return json(res, { data: [{ id: "model-a", owned_by: "library" }] });
    if (req.url === "/api/version") { if (versionOk) return json(res, { version: "0.5.0" }); res.statusCode = 503; return res.end(); }
    if (req.url === "/api/show") return json(res, { model: "model-a", model_info: { "llama.context_length": 4096 } });
    res.statusCode = 404; res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ endpoint: `${endpoint}/v1`, model: "model-a" } as any);
    await client.discoverAdvertisement();
    assert.equal(client.getDetectedServerKind(), "ollama");
    versionOk = false;
    advance(6 * 60_000);
    await client.discoverAdvertisement();
    assert.equal(client.getDetectedServerKind(), "ollama");
    advance(5 * 60_000);
    assert.equal(client.getDetectedServerKind(), "unknown");
  }));
});

test("an expired identity is re-verified before the next request, so the gateway hint and /tokenize fallback survive", async () => {
  const headers: Array<string | undefined> = [];
  let modelReads = 0;
  await withClock((advance) => withEndpoint((req, res) => {
    if (req.url === "/v1/models") { modelReads++; return json(res, { data: [gatewayEntry] }); }
    if (req.url === "/v1/chat/completions") { headers.push(req.headers["x-task-class"] as string | undefined); return ok(res); }
    res.statusCode = 404; res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ endpoint: `${endpoint}/v1`, model: "model-a", taskClass: "subagent" } as any);
    await client.discoverAdvertisement();
    await client.chatCompletion(msg, []);
    advance(11 * 60_000);
    await client.chatCompletion(msg, []);
    assert.equal(client.getDetectedServerKind(), "gateway");
    assert.equal(modelReads, 2, "one re-verification, not one per request");
    await client.chatCompletion(msg, []);
    assert.equal(modelReads, 2);
  }));
  assert.deepEqual(headers, ["subagent", "subagent", "subagent"]);
});

test("a catalog-less endpoint is probed once per TTL, not every minute", async () => {
  let modelReads = 0;
  await withClock((advance) => withEndpoint((req, res) => {
    if (req.url === "/v1/models") { modelReads++; res.statusCode = 404; return res.end(); }
    if (req.url === "/v1/chat/completions") return ok(res);
    res.statusCode = 404; res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ endpoint: `${endpoint}/v1`, model: "model-a" } as any);
    await client.discoverAdvertisement();
    for (let i = 0; i < 5; i++) { advance(61_000); await client.chatCompletion(msg, []); }
    assert.equal(modelReads, 1, "the negative result is remembered for the TTL");
  }));
});

test("re-verification never delays a request beyond a short bound", async () => {
  let slow = false;
  await withClock((advance) => withEndpoint((req, res) => {
    if (req.url === "/v1/models") { if (slow) return void setTimeout(() => json(res, { data: [gatewayEntry] }), 3000); return json(res, { data: [gatewayEntry] }); }
    if (req.url === "/v1/chat/completions") return ok(res);
    res.statusCode = 404; res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ endpoint: `${endpoint}/v1`, model: "model-a" } as any);
    await client.discoverAdvertisement();
    advance(11 * 60_000);
    slow = true;
    const started = performance.now();
    await client.chatCompletion(msg, []);
    assert.ok(performance.now() - started < 2000, `request took ${Math.round(performance.now() - started)} ms`);
  }));
});

test("a credential that changed after discovery is re-verified before the next request", async () => {
  let modelReads = 0;
  await withEndpoint((req, res) => {
    if (req.url === "/v1/models") { modelReads++; return json(res, { data: [gatewayEntry] }); }
    if (req.url === "/v1/chat/completions") return ok(res);
    res.statusCode = 404; res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ endpoint: `${endpoint}/v1`, model: "model-a" } as any);
    client.setApiKey("old-token");
    await client.discoverAdvertisement();
    client.setApiKey("rotated-token");
    assert.equal(client.getDetectedServerKind(), "unknown");
    await client.chatCompletion(msg, []);
    assert.equal(modelReads, 2);
    assert.equal(client.getDetectedServerKind(), "gateway");
  });
});

test("token counting is retryable (unavailable), not unsupported, while an expired identity is unresolved", async () => {
  let slow = false;
  const { TokenCountError } = await import("../src/client.js");
  await withClock((advance) => withEndpoint((req, res) => {
    if (req.url === "/v1/models") { if (slow) return void setTimeout(() => json(res, { data: [{ id: "model-a", owned_by: "llamacpp" }] }), 3000); return json(res, { data: [{ id: "model-a", owned_by: "llamacpp" }] }); }
    if (req.url === "/props") return json(res, { default_generation_settings: { n_ctx: 8192 } });
    if (req.url === "/tokenize") return json(res, { tokens: [1, 2, 3] });
    res.statusCode = 404; res.end(); // /v1/tokenize does not exist on llama.cpp: only the root route answers
  }, async (endpoint) => {
    const client = new LocalLlmClient({ endpoint: `${endpoint}/v1`, model: "model-a" } as any);
    await client.discoverAdvertisement();
    assert.equal(client.getDetectedServerKind(), "llamacpp");
    advance(11 * 60_000);
    slow = true;
    const err = await client.countRequestTokens(msg, [], "req-count").then(() => undefined, (e) => e);
    assert.ok(err instanceof TokenCountError, String(err));
    assert.equal(err.kind, "unavailable", "an unsupported answer would be latched permanently by the agent");
  }));
});

test("a rotated credential on a 401 retry is re-verified before the retried request", async () => {
  let modelReads = 0;
  let chats = 0;
  const taskClass: Array<string | undefined> = [];
  await withEndpoint((req, res) => {
    if (req.url === "/v1/models") { modelReads++; return json(res, { data: [gatewayEntry] }); }
    if (req.url === "/v1/chat/completions") { taskClass.push(req.headers["x-task-class"] as string | undefined); if (++chats === 1) { res.statusCode = 401; return res.end("expired"); } return ok(res); }
    res.statusCode = 404; res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ endpoint: `${endpoint}/v1`, model: "model-a", taskClass: "subagent" } as any);
    client.setApiKey("old-token");
    await client.discoverAdvertisement();
    (client as any).reloadAuthToken = () => { client.setApiKey("rotated-token"); return true; };
    await client.chatCompletion(msg, []);
    assert.equal(modelReads, 2, "the replacement credential's identity was read before the retry");
  });
  assert.deepEqual(taskClass, ["subagent", "subagent"]);
});
