/**
 * Standalone qualification without a second inference host (DEC-16, REQ-PRV-106): the harness's proxy shows Nexus the
 * gateway as a plain OpenAI-compatible server (no limits, no /tokenize, no X-AIHost-* headers), or shaped like
 * llama.cpp, vLLM or Ollama. Nexus's own discovery must then find the context the way it would on that server.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalLlmClient } from "../src/client.js";
import { classifyHttpFailure, providerHints } from "../src/core/provider_recovery.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("standalone profiles of the model proxy", () => {
  let gateway: http.Server;
  let url = "";
  const seenAuth: Array<string | undefined> = [];
  before(async () => {
    gateway = http.createServer((req, res) => {
      seenAuth.push(req.headers.authorization);
      req.resume();
      res.setHeader("x-aihost-route", "worker=w1;pool=p");
      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        return void res.end(JSON.stringify({ data: [{ id: "m", object: "model", context_length: 8192, max_completion_tokens: 2048, limits_version: "lv1", serving: [{ worker_id: "w1" }] }] }));
      }
      if (req.url === "/v1/tokenize") {
        res.setHeader("content-type", "application/json");
        return void res.end(JSON.stringify({ prompt_tokens: 10, source: "exact" }));
      }
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "prompt is too long for the context window", type: "context_length_exceeded" } }));
    });
    await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(gateway.address() as any).port}/v1`;
  });
  after(() => gateway.close());

  const withProxy = async (profile: string, fn: (proxyUrl: string) => Promise<void>) => {
    const { startModelProxy } = await import(path.join(ROOT, "eval/model_proxy.mjs"));
    const proxy = await startModelProxy({ upstream: url, profile, authToken: "gateway-token" });
    try {
      await fn(proxy.url);
    } finally {
      await proxy.close();
    }
  };
  const discover = (proxyUrl: string) => new LocalLlmClient({ endpoint: proxyUrl, model: "m", workspace: "/tmp", maxSteps: 1, apiKey: "local" } as any).discoverAdvertisement();

  test("plain: no limits, no request counting, no gateway headers; the gateway token is added by the proxy", async () => {
    await withProxy("plain", async (p) => {
      const found = await discover(p);
      assert.equal(found.state, "unsupported");
      assert.equal(found.detail, "catalog lists no limits");
      assert.equal((await fetch(`${p}/tokenize`, { method: "POST", body: "{}" })).status, 404);
      const models = await fetch(`${p}/models`);
      assert.equal(models.headers.get("x-aihost-route"), null);
      assert.deepEqual((await models.json()).data, [{ id: "m", object: "model", owned_by: "organization" }]);
      assert.ok(seenAuth.length && seenAuth.every((a) => a === "Bearer gateway-token"), "the gateway saw only the proxy's token");
    });
  });

  for (const [profile, via] of [["llamacpp", "llamacpp"], ["vllm", "vllm"], ["ollama", "ollama"]] as const) {
    test(`${profile}: Nexus finds the gateway's real context the way that server reports it`, async () => {
      await withProxy(profile, async (p) => {
        const found = await discover(p);
        assert.equal(found.state, "supported", JSON.stringify(found));
        assert.equal(found.advertised?.via, via);
        assert.equal(found.advertised?.contextLength, 8192);
        assert.equal(found.advertised?.tokenize, false);
      });
    });
  }

  test("context-overflow errors take the profile's shape and stay capacity rejections", async () => {
    for (const profile of ["llamacpp", "vllm", "ollama"]) {
      await withProxy(profile, async (p) => {
        const res = await fetch(`${p}/chat/completions`, { method: "POST", body: "{}" });
        const body = await res.text();
        assert.equal(res.status, 400);
        assert.equal(classifyHttpFailure(400, providerHints(res.headers, body), body).condition, "CAPACITY_REJECTED", `${profile}: ${body}`);
        if (profile === "llamacpp") assert.match(body, /exceed_context_size_error/);
        if (profile === "vllm") assert.match(body, /maximum context length is 8192/);
      });
    }
  });
});
