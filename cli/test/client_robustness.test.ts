import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { LocalLlmClient } from "../src/client.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

async function withServer<T>(handler: Handler, fn: (base: string) => Promise<T>): Promise<T> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

const json = (res: http.ServerResponse, body: unknown) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
};

test("setModel switches the model in place and keeps the routing hint", async () => {
  const seen: { model?: string; taskClass?: string | string[] }[] = [];
  await withServer(
    (req, res, body) => {
      seen.push({ model: JSON.parse(body).model, taskClass: req.headers["x-task-class"] });
      json(res, { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
    },
    async (base) => {
      const c = new LocalLlmClient({ model: "a", endpoint: base, apiKey: "k", taskClass: "review" } as any);
      await c.chatCompletion([{ role: "user", content: "x" }], []);
      c.setModel("b");
      await c.chatCompletion([{ role: "user", content: "x" }], []);
    },
  );
  assert.deepEqual(seen, [
    { model: "a", taskClass: "review" },
    { model: "b", taskClass: "review" },
  ]);
});

test("a tool call cut off by the token limit is rejected, not executed", async () => {
  await withServer(
    (_req, res) =>
      json(res, {
        choices: [
          {
            finish_reason: "length",
            message: { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "write_file", arguments: '{"path":"a.py","content":"def f(' } }] },
          },
        ],
      }),
    async (base) => {
      const c = new LocalLlmClient({ model: "m", endpoint: base, apiKey: "k" } as any);
      await assert.rejects(() => c.chatCompletion([{ role: "user", content: "x" }], []), /truncated/);
    },
  );
});

test("a truncated plain-text answer is still returned", async () => {
  await withServer(
    (_req, res) => json(res, { choices: [{ finish_reason: "length", message: { role: "assistant", content: "partial answer" } }] }),
    async (base) => {
      const c = new LocalLlmClient({ model: "m", endpoint: base, apiKey: "k" } as any);
      const m = await c.chatCompletion([{ role: "user", content: "x" }], []);
      assert.equal(m.content, "partial answer");
    },
  );
});

test("a stalled server fails after the configured request timeout instead of hanging", async () => {
  const prev = process.env.LOCAL_LLM_TIMEOUT_MS;
  process.env.LOCAL_LLM_TIMEOUT_MS = "300";
  try {
    await withServer(
      () => {
        /* never respond */
      },
      async (base) => {
        const c = new LocalLlmClient({ model: "m", endpoint: base, apiKey: "k" } as any);
        const t0 = Date.now();
        await assert.rejects(() => c.chatCompletion([{ role: "user", content: "x" }], []));
        assert.ok(Date.now() - t0 < 5000, "should give up promptly");
      },
    );
  } finally {
    if (prev === undefined) delete process.env.LOCAL_LLM_TIMEOUT_MS;
    else process.env.LOCAL_LLM_TIMEOUT_MS = prev;
  }
});

test("streamed tool call cut off by length is rejected", async () => {
  await withServer(
    (_req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "1", function: { name: "write_file", arguments: '{"path":"a' } }] }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    },
    async (base) => {
      const c = new LocalLlmClient({ model: "m", endpoint: base, apiKey: "k" } as any);
      await assert.rejects(() => c.chatCompletionStream([{ role: "user", content: "x" }], [], () => {}), /truncated/);
    },
  );
});

const sse = (res: http.ServerResponse, chunks: unknown[]) => {
  res.setHeader("Content-Type", "text/event-stream");
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end("data: [DONE]\n\n");
};

test("parallel tool calls delivered without an index stay separate (gateway-style stream)", async () => {
  await withServer(
    (_req, res) =>
      sse(res, [
        {
          choices: [
            {
              delta: {
                role: "assistant",
                tool_calls: [
                  { id: "a", type: "function", function: { name: "find_files", arguments: '{"pattern":"*list_users*"}' } },
                  { id: "b", type: "function", function: { name: "list_dir", arguments: '{"path":"tests"}' } },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    async (base) => {
      const c = new LocalLlmClient({ model: "m", endpoint: base, apiKey: "k" } as any);
      const m = await c.chatCompletionStream([{ role: "user", content: "x" }], [], () => {});
      assert.deepEqual(
        (m.tool_calls || []).map((t) => [t.function.name, t.function.arguments]),
        [
          ["find_files", '{"pattern":"*list_users*"}'],
          ["list_dir", '{"path":"tests"}'],
        ],
      );
    },
  );
});

test("spec-style indexed fragments still assemble into the right calls", async () => {
  await withServer(
    (_req, res) =>
      sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "find_files", arguments: '{"pat' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'tern":"x"}' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "list_dir", arguments: '{"path":"t"}' } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    async (base) => {
      const c = new LocalLlmClient({ model: "m", endpoint: base, apiKey: "k" } as any);
      const m = await c.chatCompletionStream([{ role: "user", content: "x" }], [], () => {});
      assert.deepEqual(
        (m.tool_calls || []).map((t) => [t.function.name, t.function.arguments]),
        [
          ["find_files", '{"pattern":"x"}'],
          ["list_dir", '{"path":"t"}'],
        ],
      );
    },
  );
});

test("history never carries unparseable tool-call arguments to the server", async () => {
  let sent: any;
  await withServer(
    (_req, res, body) => {
      sent = JSON.parse(body);
      json(res, { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
    },
    async (base) => {
      const c = new LocalLlmClient({ model: "m", endpoint: base, apiKey: "k" } as any);
      await c.chatCompletion(
        [
          { role: "user", content: "x" },
          { role: "assistant", content: "", tool_calls: [{ id: "a", type: "function", function: { name: "t", arguments: '{"a":1}{"b":2}' } }] } as any,
          { role: "tool", tool_call_id: "a", name: "t", content: "err" } as any,
        ],
        [],
      );
    },
  );
  const args = sent.messages[1].tool_calls[0].function.arguments;
  assert.doesNotThrow(() => JSON.parse(args), "arguments must be valid JSON on the wire");
});
