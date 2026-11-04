import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { LocalLlmClient } from "../src/client.js";
import { adaptToolDefinitionsForServer } from "../src/core/tool_grammar_provider.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

async function withEndpoint<T>(handler: Handler, run: (endpoint: string) => Promise<T>): Promise<T> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

function json(res: http.ServerResponse, body: unknown): void {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

const readFileTool = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
};
const unrelatedTool = {
  type: "function",
  function: { name: "other_tool", description: "Not in the GBNF allowlist.", parameters: { type: "object", properties: {} } },
};

function completion(res: http.ServerResponse): void {
  json(res, { choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] });
}

test("client enables vLLM strict mode for allowlisted tool schemas", async () => {
  let versionRequests = 0;
  let sent: any;
  await withEndpoint((req, res, body) => {
    if (req.url === "/v1/models") return json(res, { data: [{ id: "model-a", max_model_len: 8192 }] });
    if (req.url === "/version") {
      versionRequests++;
      return json(res, { version: "0.10.0" });
    }
    if (req.url === "/v1/chat/completions") {
      sent = JSON.parse(body);
      return completion(res);
    }
    res.statusCode = 404;
    res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ model: "model-a", endpoint, apiKey: "test" } as any);
    const discovery = await client.discoverAdvertisement();
    assert.equal(discovery.state, "supported");
    assert.equal(typeof client.getDetectedServerKind, "function");
    assert.equal(client.getDetectedServerKind(), "vllm");
    await client.chatCompletion([{ role: "user", content: "read it" }], [readFileTool, unrelatedTool] as any);
  });

  assert.equal(sent.tools[0].function.strict, true);
  assert.equal(sent.tools[1].function.strict, undefined, "unregistered schemas must not be opted into strict mode");
  assert.equal("response_format" in sent, false, "tool arguments must not be constrained by response-level format");
  assert.equal(versionRequests, 1);
  assert.equal((readFileTool.function as any).strict, undefined, "provider adaptation must not mutate registered schemas");
});

test("vLLM strict adaptation makes optional flat parameters nullable and closes the object schema", () => {
  const optionalTool = {
    type: "function",
    function: {
      name: "read_file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          start_line: { type: "number", description: "Optional start line" },
        },
        required: ["path"],
      },
    },
  } as any;
  const adapted = adaptToolDefinitionsForServer("vllm", [optionalTool]) as any[];

  assert.deepEqual(adapted[0].function.parameters, {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      start_line: { type: ["number", "null"], description: "Optional start line" },
    },
    required: ["path", "start_line"],
    additionalProperties: false,
  });
  assert.deepEqual(optionalTool.function.parameters.required, ["path"], "provider adaptation must not mutate the registered schema");
});

test("client preserves vLLM strict schemas in a non-streaming completion", async () => {
  let sent: any;
  await withEndpoint((req, res, body) => {
    if (req.url === "/v1/models") return json(res, { data: [{ id: "model-a", max_model_len: 8192 }] });
    if (req.url === "/version") return json(res, { version: "0.10.0" });
    if (req.url === "/v1/chat/completions") {
      sent = JSON.parse(body);
      return completion(res);
    }
    res.statusCode = 404;
    res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ model: "model-a", endpoint, apiKey: "test" } as any);
    await client.discoverAdvertisement();
    await (client as any).chatCompletionOnce([{ role: "user", content: "read it" }], [readFileTool], "request-id");
  });

  assert.equal(sent.tools[0].function.strict, true);
  assert.equal("response_format" in sent, false);
});

test("client preserves vLLM strict schemas in a streaming completion", async () => {
  let sent: any;
  await withEndpoint((req, res, body) => {
    if (req.url === "/v1/models") return json(res, { data: [{ id: "model-a", max_model_len: 8192 }] });
    if (req.url === "/version") return json(res, { version: "0.10.0" });
    if (req.url === "/v1/chat/completions") {
      sent = JSON.parse(body);
      res.setHeader("Content-Type", "text/event-stream");
      res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      return;
    }
    res.statusCode = 404;
    res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ model: "model-a", endpoint, apiKey: "test" } as any);
    await client.discoverAdvertisement();
    const message = await client.chatCompletionStream([{ role: "user", content: "read it" }], [readFileTool] as any);
    assert.equal(message.content, "ok");
  });

  assert.equal(sent.stream, true);
  assert.equal(sent.tools[0].function.strict, true);
  assert.equal("response_format" in sent, false);
});

test("unsupported vLLM discovery does not enable strict tool adaptation", async () => {
  let sent: any;
  let versionRequests = 0;
  await withEndpoint((req, res, body) => {
    if (req.url === "/v1/models") return json(res, { data: [{ id: "model-a" }] });
    if (req.url === "/version") { versionRequests++; return json(res, { version: "0.10.0" }); }
    if (req.url === "/props") { res.statusCode = 404; res.end(); return; }
    if (req.url === "/v1/chat/completions") {
      sent = JSON.parse(body);
      return completion(res);
    }
    res.statusCode = 404;
    res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ model: "model-a", endpoint, apiKey: "test" } as any);
    assert.equal((await client.discoverAdvertisement()).state, "unsupported");
    assert.equal(client.getDetectedServerKind(), "unknown");
    await client.chatCompletion([{ role: "user", content: "read it" }], [readFileTool] as any);
  });

  assert.equal(sent.tools[0].function.strict, undefined);
  assert.equal("additionalProperties" in sent.tools[0].function.parameters, false);
  assert.equal(versionRequests, 0, "generic catalogs must not receive vLLM-specific probes");
});

test("vLLM model marker without catalog limits still needs a successful context handshake before adaptation", async () => {
  let sent: any;
  let versionRequests = 0;
  await withEndpoint((req, res, body) => {
    if (req.url === "/v1/models") return json(res, { data: [{ id: "model-a", owned_by: "vllm" }] });
    if (req.url === "/version") { versionRequests++; return json(res, { version: "0.10.0" }); }
    if (req.url === "/props") { res.statusCode = 404; res.end(); return; }
    if (req.url === "/v1/chat/completions") {
      sent = JSON.parse(body);
      return completion(res);
    }
    res.statusCode = 404;
    res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ model: "model-a", endpoint, apiKey: "test" } as any);
    assert.equal((await client.discoverAdvertisement()).state, "unsupported");
    assert.equal(client.getDetectedServerKind(), "unknown");
    await client.chatCompletion([{ role: "user", content: "read it" }], [readFileTool] as any);
  });

  assert.equal(versionRequests, 1);
  assert.equal(sent.tools[0].function.strict, undefined);
  assert.equal("additionalProperties" in sent.tools[0].function.parameters, false);
});

test("client preserves llama.cpp native tool schemas without incompatible grammar field", async () => {
  let sent: any;
  await withEndpoint((req, res, body) => {
    if (req.url === "/v1/models") return json(res, { data: [{ id: "llama-model", owned_by: "llamacpp" }] });
    if (req.url === "/props") return json(res, { default_generation_settings: { n_ctx: 8192 } });
    if (req.url === "/v1/chat/completions") {
      sent = JSON.parse(body);
      return completion(res);
    }
    res.statusCode = 404;
    res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ model: "llama-model", endpoint, apiKey: "test" } as any);
    assert.equal((await client.discoverAdvertisement()).state, "supported");
    assert.equal(typeof client.getDetectedServerKind, "function");
    assert.equal(client.getDetectedServerKind(), "llamacpp");
    await client.chatCompletion([{ role: "user", content: "read it" }], [readFileTool] as any);
  });

  assert.deepEqual(sent.tools, [readFileTool]);
  assert.equal("grammar" in sent, false);
});

test("llama.cpp model markers do not identify a server without a valid props handshake", async () => {
  await withEndpoint((req, res) => {
    if (req.url === "/v1/models") return json(res, { data: [{ id: "llama-model", owned_by: "llamacpp" }] });
    if (req.url === "/props") {
      res.statusCode = 200;
      return json(res, { default_generation_settings: { n_ctx: "invalid" } });
    }
    res.statusCode = 404;
    res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ model: "llama-model", endpoint, apiKey: "test" } as any);
    assert.equal((await client.discoverAdvertisement()).state, "unsupported");
    assert.equal(client.getDetectedServerKind(), "unknown");
  });
});

test("client preserves Ollama native tool schemas without response format constraint", async () => {
  let sent: any;
  let versionRequests = 0;
  await withEndpoint((req, res, body) => {
    if (req.url === "/v1/models") return json(res, { data: [{ id: "ollama-model", owned_by: "library" }] });
    if (req.url === "/api/version") {
      versionRequests++;
      return json(res, { version: "0.12.3" });
    }
    if (req.url === "/api/show") return json(res, { parameters: "num_ctx 8192" });
    if (req.url === "/v1/chat/completions") {
      sent = JSON.parse(body);
      return completion(res);
    }
    res.statusCode = 404;
    res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ model: "ollama-model", endpoint, apiKey: "test" } as any);
    assert.equal((await client.discoverAdvertisement()).state, "supported");
    assert.equal(typeof client.getDetectedServerKind, "function");
    assert.equal(client.getDetectedServerKind(), "ollama");
    await client.chatCompletion([{ role: "user", content: "read it" }], [readFileTool] as any);
  });

  assert.equal(versionRequests, 1);
  assert.deepEqual(sent.tools, [readFileTool]);
  assert.equal("format" in sent, false);
});

test("Ollama catalog markers do not identify a server when its version handshake is missing or malformed", async (t) => {
  for (const sample of [{ name: "missing", status: 404 }, { name: "malformed", status: 200 }]) {
    await t.test(sample.name, async () => {
      await withEndpoint((req, res) => {
        if (req.url === "/v1/models") return json(res, { data: [{ id: "ollama-model", owned_by: "library" }] });
        if (req.url === "/api/version") {
          res.statusCode = sample.status;
          return sample.status === 200 ? json(res, { version: 12 }) : res.end();
        }
        assert.fail(`unexpected probe ${req.method} ${req.url}`);
      }, async (endpoint) => {
        const client = new LocalLlmClient({ model: "ollama-model", endpoint, apiKey: "test" } as any);
        const discovery = await client.discoverAdvertisement();
        assert.equal(discovery.state, "unsupported");
        assert.equal(client.getDetectedServerKind(), "unknown");
      });
    });
  }
});

test("client omits constrained fields for missing malformed or mismatched provider identity", async (t) => {
  const cases = [
    { name: "missing version", models: [{ id: "model-a", max_model_len: 8192 }], versionStatus: 404, version: undefined },
    { name: "malformed version", models: [{ id: "model-a", max_model_len: 8192 }], versionStatus: 200, version: { version: 7 } },
    { name: "mismatched model", models: [{ id: "other-model", context_length: 8192 }], versionStatus: 200, version: { version: "0.10.0" } },
  ];
  for (const sample of cases) {
    await t.test(sample.name, async () => {
      let sent: any;
      await withEndpoint((req, res, body) => {
        if (req.url === "/v1/models") return json(res, { data: sample.models });
        if (req.url === "/version") {
          res.statusCode = sample.versionStatus;
          return sample.versionStatus === 200 ? json(res, sample.version) : res.end();
        }
        if (req.url === "/v1/chat/completions") {
          sent = JSON.parse(body);
          return completion(res);
        }
        res.statusCode = 404;
        res.end();
      }, async (endpoint) => {
        const client = new LocalLlmClient({ model: "model-a", endpoint, apiKey: "test" } as any);
        await client.discoverAdvertisement();
        await client.chatCompletion([{ role: "user", content: "read it" }], [readFileTool] as any);
      });
      assert.equal(sent.tools[0].function.strict, undefined);
    });
  }
});
