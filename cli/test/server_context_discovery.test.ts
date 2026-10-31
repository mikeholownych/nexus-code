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
import { parseServerContext, serverKindOfAdvertisement } from "../src/core/provider_capabilities.js";
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
    const key = `${req.method} ${req.url}`;
    const route = Object.hasOwn(routes, key) ? routes[key] : undefined;
    if (typeof route !== "function") {
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
  test("request paths cannot dispatch inherited route properties", async () => {
    let inheritedCalls = 0;
    const routes = Object.create({
      "GET /v1/prototype": () => {
        inheritedCalls += 1;
        return { unsafe: true };
      },
    }) as Record<string, (req: http.IncomingMessage) => unknown>;
    const srv = await server(routes);
    try {
      const response = await fetch(`${srv.url}/prototype`);
      assert.equal(response.status, 404);
      assert.equal(await response.text(), "not found");
      assert.equal(inheritedCalls, 0);
    } finally {
      await srv.close();
    }
  });

  test("a llama.cpp server's /props context is discovered when its catalog lists no limits", async () => {
    const srv = await server({
      "GET /v1/models": () => ({ data: [{ id: "m", object: "model", owned_by: "llamacpp", meta: { n_ctx_train: 131072 } }] }),
      "GET /props": () => ({ default_generation_settings: { n_ctx: 4096 } }),
    });
    try {
      const found = await new LocalLlmClient({ endpoint: srv.url, model: "m", workspace: "/tmp", maxSteps: 1 } as any).discoverAdvertisement();
      assert.equal(found.state, "supported");
      assert.equal(found.advertised?.via, "llamacpp");
      assert.equal(serverKindOfAdvertisement(found.advertised), "llamacpp");
      assert.equal(found.advertised?.contextLength, 4096);
    } finally {
      await srv.close();
    }
  });
  test("an LM Studio server's /api/v0/models context is discovered", async () => {
    const srv = await server({
      "GET /v1/models": () => ({ data: [{ id: "m", object: "model", owned_by: "organization_owner" }] }),
      "GET /api/v0/models": () => ({ data: [{ id: "m", loaded_context_length: 4096, max_context_length: 32768 }] }),
    });
    try {
      const found = await new LocalLlmClient({ endpoint: srv.url, model: "m", workspace: "/tmp", maxSteps: 1 } as any).discoverAdvertisement();
      assert.equal(found.state, "supported");
      assert.equal(found.advertised?.via, "lmstudio");
      assert.equal(serverKindOfAdvertisement(found.advertised), "lmstudio");
      assert.equal(found.advertised?.contextLength, 4096);
      assert.deepEqual(srv.seen.slice(1), ["GET /api/v0/models"]);
    } finally {
      await srv.close();
    }
  });
  test("an Ollama server is recognised from its catalog and asked only through its own endpoint", async () => {
    const srv = await server({
      "GET /v1/models": () => ({ data: [{ id: "m", object: "model", owned_by: "library" }] }),
      "POST /api/show": () => ({ model_info: { "qwen2.context_length": 32768 } }),
    });
    try {
      const found = await new LocalLlmClient({ endpoint: srv.url, model: "m", workspace: "/tmp", maxSteps: 1 } as any).discoverAdvertisement();
      assert.equal(found.advertised?.via, "ollama");
      assert.equal(serverKindOfAdvertisement(found.advertised), "ollama");
      assert.equal(found.advertised?.contextLength, 32768);
      assert.deepEqual(srv.seen.slice(1), ["POST /api/show"], "only the recognised server's endpoint is asked");
    } finally {
      await srv.close();
    }
  });
  test("a vLLM server advertises max_model_len directly in /v1/models", async () => {
    const srv = await server({
      "GET /v1/models": () => ({ data: [{ id: "m", object: "model", max_model_len: 16384 }] }),
    });
    try {
      const found = await new LocalLlmClient({ endpoint: srv.url, model: "m", workspace: "/tmp", maxSteps: 1 } as any).discoverAdvertisement();
      assert.equal(found.state, "supported");
      assert.equal(found.advertised?.via, "vllm");
      assert.equal(serverKindOfAdvertisement(found.advertised), "vllm");
      assert.equal(found.advertised?.contextLength, 16384);
      assert.deepEqual(srv.seen, ["GET /v1/models"]);
    } finally {
      await srv.close();
    }
  });
  test("subsequent context discovery reuses cached advertisement without hitting probe endpoint again", async () => {
    const srv = await server({
      "GET /v1/models": () => ({ data: [{ id: "m", object: "model", owned_by: "llamacpp", meta: { n_ctx_train: 131072 } }] }),
      "GET /props": () => ({ default_generation_settings: { n_ctx: 8192 } }),
    });
    try {
      const client = new LocalLlmClient({ endpoint: srv.url, model: "m", workspace: "/tmp", maxSteps: 1 } as any);
      const first = await client.discoverAdvertisement();
      assert.equal(first.advertised?.contextLength, 8192);
      const propsCallsBefore = srv.seen.filter((s) => s.startsWith("GET /props")).length;
      assert.equal(propsCallsBefore, 1);
      const second = await client.discoverAdvertisement();
      assert.equal(second.advertised?.contextLength, 8192);
      const propsCallsAfter = srv.seen.filter((s) => s.startsWith("GET /props")).length;
      assert.equal(propsCallsAfter, 1, "no second probe made to /props due to caching");
    } finally {
      await srv.close();
    }
  });
  test("an unrecognised server is not probed and stays on labelled defaults", async () => {
    const srv = await server({ "GET /v1/models": () => ({ data: [{ id: "m", object: "model" }] }) });
    try {
      const found = await new LocalLlmClient({ endpoint: srv.url, model: "m", workspace: "/tmp", maxSteps: 1 } as any).discoverAdvertisement();
      assert.equal(found.state, "unsupported");
      assert.equal(found.detail, "catalog lists no limits");
      assert.deepEqual(srv.seen, ["GET /v1/models"], "no guessed endpoints were requested");
    } finally {
      await srv.close();
    }
  });
});

describe("context-overflow classification (ACC-INF-02 table)", () => {
  const classify = (status: number, body: string) => classifyHttpFailure(status, providerHints(new Headers(), body), body).condition;

  test("llama.cpp exceed_context_size_error is a capacity rejection", () => {
    const body = JSON.stringify({ error: { code: 400, message: "the request exceeds the available context size, try increasing it", type: "exceed_context_size_error", n_prompt_tokens: 9000, n_ctx: 8192 } });
    assert.equal(classify(400, body), "CAPACITY_REJECTED");
  });
  test("vLLM maximum context length message is a capacity rejection", () => {
    const body = JSON.stringify({ object: "error", message: "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens", type: "BadRequestError", code: 400 });
    assert.equal(classify(400, body), "CAPACITY_REJECTED");
  });
  test("LM Studio context window exceeded body is a capacity rejection", () => {
    const body = JSON.stringify({ error: "Context window exceeded", message: "The model's context window is 4096 tokens, but 5000 were submitted" });
    assert.equal(classify(400, body), "CAPACITY_REJECTED");
  });
  test("Ollama prompt too long body is a capacity rejection", () => {
    const body = JSON.stringify({ error: "prompt too long for context window" });
    assert.equal(classify(400, body), "CAPACITY_REJECTED");
    assert.equal(classify(500, body), "CAPACITY_REJECTED");
  });
  test("HTTP 413 Payload Too Large is a capacity rejection regardless of body", () => {
    assert.equal(classify(413, "request entity too large"), "CAPACITY_REJECTED");
  });
  test("an ordinary bad request is still a rejection, not capacity", () => {
    assert.equal(classify(400, JSON.stringify({ error: { message: "invalid tool schema", type: "invalid_request_error" } })), "REQUEST_REJECTED");
  });
});
