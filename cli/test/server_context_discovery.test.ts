/**
 * Standalone context sizing (REQ-PRV-101, REQ-PRV-102 classification, PRV-06/07): servers whose OpenAI-style catalog
 * lists no limits (llama.cpp server, LM Studio, Ollama) are asked for the context they loaded, instead of Nexus
 * assuming 65536; their context-overflow errors are classified as capacity rejections.
 * Response shapes follow each server's documented API: llama.cpp `GET /props`, LM Studio `GET /api/v0/models`, Ollama
 * `POST /api/show`.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { LocalLlmClient } from "../src/client.js";
import { parseServerContext } from "../src/core/provider_capabilities.js";
import { classifyHttpFailure, providerHints } from "../src/core/provider_recovery.js";

describe("server context shapes", () => {
  test("llama.cpp /props: the runtime n_ctx, not the training size", () => {
    assert.deepEqual(parseServerContext("llamacpp", { default_generation_settings: { n_ctx: 8192 }, model_path: "x.gguf" }, "m"), { via: "llamacpp", contextLength: 8192, tokenize: false });
  });
  test("LM Studio /api/v0/models: the loaded context of the selected model", () => {
    const body = { data: [{ id: "other", loaded_context_length: 2048 }, { id: "qwen", max_context_length: 32768, loaded_context_length: 4096 }] };
    assert.equal(parseServerContext("lmstudio", body, "qwen")?.contextLength, 4096);
    assert.equal(parseServerContext("lmstudio", { data: [{ id: "qwen", max_context_length: 32768 }] }, "qwen")?.contextLength, 32768);
    assert.equal(parseServerContext("lmstudio", body, "missing"), undefined);
  });
  test("Ollama /api/show: num_ctx when set, else the model's context length", () => {
    assert.equal(parseServerContext("ollama", { parameters: "stop \"<|im_end|>\"\nnum_ctx 16384\n", model_info: { "qwen2.context_length": 32768 } }, "m")?.contextLength, 16384);
    assert.equal(parseServerContext("ollama", { model_info: { "llama.context_length": 131072 } }, "m")?.contextLength, 131072);
  });
  test("unknown shapes advertise nothing", () => {
    assert.equal(parseServerContext("llamacpp", { hello: 1 }, "m"), undefined);
    assert.equal(parseServerContext("ollama", null, "m"), undefined);
  });
});

async function server(routes: Record<string, (req: http.IncomingMessage) => unknown>): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const s = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const route = routes[`${req.method} ${req.url}`];
    if (!route) {
      res.writeHead(404);
      return void res.end("not found");
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(route(req)));
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(s.address() as any).port}/v1`, seen, close: () => new Promise((r) => s.close(() => r())) };
}

describe("discovery against a local server", () => {
  test("a llama.cpp server's /props context is discovered when its catalog lists no limits", async () => {
    const srv = await server({
      "GET /v1/models": () => ({ data: [{ id: "m", object: "model" }] }),
      "GET /props": () => ({ default_generation_settings: { n_ctx: 4096 } }),
    });
    try {
      const found = await new LocalLlmClient({ endpoint: srv.url, model: "m", workspace: "/tmp", maxSteps: 1 } as any).discoverAdvertisement();
      assert.equal(found.state, "supported");
      assert.equal(found.advertised?.via, "llamacpp");
      assert.equal(found.advertised?.contextLength, 4096);
    } finally {
      await srv.close();
    }
  });
  test("an Ollama server is found after the earlier probes 404", async () => {
    const srv = await server({
      "GET /v1/models": () => ({ data: [{ id: "m", object: "model" }] }),
      "POST /api/show": () => ({ model_info: { "qwen2.context_length": 32768 } }),
    });
    try {
      const found = await new LocalLlmClient({ endpoint: srv.url, model: "m", workspace: "/tmp", maxSteps: 1 } as any).discoverAdvertisement();
      assert.equal(found.advertised?.via, "ollama");
      assert.equal(found.advertised?.contextLength, 32768);
      assert.deepEqual(srv.seen.slice(1), ["GET /props", "GET /api/v0/models", "POST /api/show"]);
    } finally {
      await srv.close();
    }
  });
  test("a server with none of these endpoints stays on labelled defaults", async () => {
    const srv = await server({ "GET /v1/models": () => ({ data: [{ id: "m", object: "model" }] }) });
    try {
      const found = await new LocalLlmClient({ endpoint: srv.url, model: "m", workspace: "/tmp", maxSteps: 1 } as any).discoverAdvertisement();
      assert.equal(found.state, "unsupported");
      assert.equal(found.detail, "catalog lists no limits");
    } finally {
      await srv.close();
    }
  });
});

describe("context-overflow classification", () => {
  const classify = (status: number, body: string) => classifyHttpFailure(status, providerHints(new Headers(), body), body).condition;
  test("llama.cpp's exceed_context_size_error is a capacity rejection", () => {
    const body = JSON.stringify({ error: { code: 400, message: "the request exceeds the available context size, try increasing it", type: "exceed_context_size_error", n_prompt_tokens: 9000, n_ctx: 8192 } });
    assert.equal(classify(400, body), "CAPACITY_REJECTED");
  });
  test("vLLM's maximum context length message is a capacity rejection", () => {
    const body = JSON.stringify({ object: "error", message: "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens", type: "BadRequestError", code: 400 });
    assert.equal(classify(400, body), "CAPACITY_REJECTED");
  });
  test("an ordinary bad request is still a rejection, not capacity", () => {
    assert.equal(classify(400, JSON.stringify({ error: { message: "invalid tool schema", type: "invalid_request_error" } })), "REQUEST_REJECTED");
  });
});
