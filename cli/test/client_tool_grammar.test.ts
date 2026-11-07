import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { LocalLlmClient, normalizeNullableOptionalToolArguments } from "../src/client.js";
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
const nullableTool = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        start_line: { type: "number" },
        end_line: { type: "number" },
        include_hidden: { type: "boolean" },
        label: { type: "string" },
      },
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
    if (req.url === "/v1/models") return json(res, { data: [{ id: "model-a", owned_by: "vllm", max_model_len: 8192 }] });
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

test("transient vLLM version failure retains verified identity and strict schemas", async () => {
  let versionRequests = 0;
  let sent: any;
  await withEndpoint((req, res, body) => {
    if (req.url === "/v1/models") return json(res, { data: [{ id: "model-a", owned_by: "vllm", max_model_len: 8192 }] });
    if (req.url === "/version") {
      versionRequests++;
      if (versionRequests > 1) {
        res.statusCode = 503;
        return res.end("temporary version failure");
      }
      return json(res, { version: "0.10.0" });
    }
    if (req.url === "/v1/chat/completions") {
      sent = JSON.parse(body);
      return completion(res);
    }
    res.statusCode = 404;
    res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ endpoint: `${endpoint}/v1`, model: "model-a" } as any);
    await client.discoverAdvertisement();
    assert.equal(client.getDetectedServerKind(), "vllm");
    const refresh = await client.discoverAdvertisement();
    assert.equal(refresh.state, "supported");
    assert.equal(client.getDetectedServerKind(), "vllm", "a temporary version failure is not contradictory provider identity");
    await client.chatCompletion([{ role: "user", content: "hello" }], [readFileTool]);
    assert.equal(sent.tools[0].function.strict, true, "the previously verified vLLM strict schema remains active");
  });
});

test("positive rediscovery replaces vLLM identity with gateway identity", async () => {
  let modelReads = 0;
  let sent: any;
  let taskClassHeader: string | undefined;
  await withEndpoint((req, res, body) => {
    if (req.url === "/v1/models") {
      modelReads++;
      return json(res, { data: [modelReads === 1
        ? { id: "model-a", owned_by: "vllm", max_model_len: 8192 }
        : { id: "model-a", limits_version: "1", context_length: 4096 }] });
    }
    if (req.url === "/version") return json(res, { version: "0.10.0" });
    if (req.url === "/v1/chat/completions") {
      sent = JSON.parse(body);
      taskClassHeader = req.headers["x-task-class"] as string | undefined;
      return completion(res);
    }
    res.statusCode = 404;
    res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ endpoint: `${endpoint}/v1`, model: "model-a", taskClass: "subagent" } as any);
    await client.discoverAdvertisement();
    assert.equal(client.getDetectedServerKind(), "vllm");
    await client.discoverAdvertisement();
    assert.equal(client.getDetectedServerKind(), "gateway", "positive gateway identity replaces the cached vLLM kind");
    await client.chatCompletion([{ role: "user", content: "hello" }], [readFileTool]);
  });

  assert.equal(taskClassHeader, "subagent", "the newly verified gateway identity enables the gateway task-class header");
  assert.equal(sent.tools[0].function.strict, undefined, "the replaced vLLM identity no longer forces strict schema mode");
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
    if (req.url === "/v1/models") return json(res, { data: [{ id: "model-a", owned_by: "vllm", max_model_len: 8192 }] });
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
    if (req.url === "/v1/models") return json(res, { data: [{ id: "model-a", owned_by: "vllm", max_model_len: 8192 }] });
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

test("client returns tool-call arguments verbatim; normalisation happens once, at dispatch (WP-1303)", async () => {
  const wireArgs = { path: null, start_line: null, end_line: 0, include_hidden: false, label: "" };
  const expected = wireArgs;
  const observed: unknown[] = [];
  const run = async (stream: boolean) => withEndpoint((req, res, body) => {
    if (req.url === "/v1/models") return json(res, { data: [{ id: "model-a", owned_by: "vllm", max_model_len: 8192 }] });
    if (req.url === "/version") return json(res, { version: "0.10.0" });
    if (req.url === "/v1/chat/completions") {
      const sent = JSON.parse(body);
      assert.equal(sent.tools[0].function.strict, true);
      if (stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read_file", arguments: JSON.stringify(wireArgs) } }] } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      } else {
        json(res, { choices: [{ message: { role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: JSON.stringify(wireArgs) } }] }, finish_reason: "tool_calls" }] });
      }
      return;
    }
    res.statusCode = 404;
    res.end();
  }, async (endpoint) => {
    const client = new LocalLlmClient({ endpoint: `${endpoint}/v1`, model: "model-a" } as any);
    await client.discoverAdvertisement();
    const messages = [{ role: "user" as const, content: "read it" }];
    const message = stream
      ? await client.chatCompletionStream(messages, [nullableTool] as any)
      : await client.chatCompletion(messages, [nullableTool] as any, "request-id");
    observed.push(JSON.parse(message.tool_calls![0].function.arguments));
  });

  await run(false);
  await run(true);
  assert.deepEqual(observed, [expected, expected]);
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

test("vLLM adaptation requires owned_by vllm and a version handshake", async () => {
  const observe = async (entry: Record<string, unknown>, versionBody: unknown) => {
    let sent: any;
    let versionRequests = 0;
    let detectedKind = "unknown";
    let advertisedVia: string | undefined;
    await withEndpoint((req, res, body) => {
      if (req.url === "/v1/models") return json(res, { data: [entry] });
      if (req.url === "/version") { versionRequests++; return json(res, versionBody); }
      if (req.url === "/props") { res.statusCode = 404; res.end(); return; }
      if (req.url === "/v1/chat/completions") {
        sent = JSON.parse(body);
        return completion(res);
      }
      res.statusCode = 404;
      res.end();
    }, async (endpoint) => {
      const client = new LocalLlmClient({ model: "model-a", endpoint, apiKey: "test" } as any);
      const discovery = await client.discoverAdvertisement();
      advertisedVia = discovery.advertised?.via;
      detectedKind = client.getDetectedServerKind();
      await client.chatCompletion([{ role: "user", content: "read it" }], [readFileTool] as any);
    });
    return { sent, versionRequests, detectedKind, advertisedVia };
  };

  const generic = await observe({ id: "model-a", context_length: 8192 }, { version: "0.10.0" });
  assert.equal(generic.versionRequests, 0, "generic capacity metadata must not trigger a vLLM identity probe");
  assert.equal(generic.detectedKind, "unknown");
  assert.equal(generic.advertisedVia, "catalog");
  assert.equal(generic.sent.tools[0].function.strict, undefined);

  const missingVersion = await observe({ id: "model-a", owned_by: "vllm" }, { version: "  " });
  assert.equal(missingVersion.versionRequests, 1);
  assert.equal(missingVersion.detectedKind, "unknown");
  assert.equal(missingVersion.sent.tools[0].function.strict, undefined);

  const identified = await observe({ id: "model-a", owned_by: "VLLM" }, { version: "0.10.0" });
  assert.equal(identified.versionRequests, 1);
  assert.equal(identified.detectedKind, "vllm");
  assert.equal(identified.advertisedVia, "vllm");
  assert.equal(identified.sent.tools[0].function.strict, true);
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

test("normalizer keeps an explicit null where the declared schema allows null (WP-1303)", () => {
  const tool = { type: "function", function: { name: "t", parameters: { type: "object", required: ["a"], properties: {
    a: { type: "string" },
    typeList: { type: ["string", "null"] },
    anyOfNull: { anyOf: [{ type: "string" }, { type: "null" }] },
    oneOfNull: { oneOf: [{ type: "number" }, { type: "null" }] },
    nullableFlag: { type: "string", nullable: true },
    enumNull: { enum: ["x", null] },
    plain: { type: "number" },
  } } } } as any;
  const out = normalizeNullableOptionalToolArguments("t", { a: "v", typeList: null, anyOfNull: null, oneOfNull: null, nullableFlag: null, enumNull: null, plain: null }, [tool]);
  assert.deepEqual(out, { a: "v", typeList: null, anyOfNull: null, oneOfNull: null, nullableFlag: null, enumNull: null });
  assert.deepEqual(normalizeNullableOptionalToolArguments("t", { a: null, plain: null }, [tool]), { a: null }, "a required argument stays null so validation rejects it");
});

test("normalizer fails safe on $ref and honours allOf when deciding whether null is allowed (WP-1303)", () => {
  const tool = { type: "function", function: { name: "t", parameters: { type: "object", required: [], properties: {
    ref: { $ref: "#/$defs/Maybe" },
    allBoth: { allOf: [{ type: ["string", "null"] }, { nullable: true }] },
    allOne: { allOf: [{ type: ["string", "null"] }, { type: "string" }] },
  } } } } as any;
  assert.deepEqual(
    normalizeNullableOptionalToolArguments("t", { ref: null, allBoth: null, allOne: null }, [tool]),
    { ref: null, allBoth: null },
    "an unresolvable $ref keeps the null; allOf allows null only when every branch does",
  );
});
