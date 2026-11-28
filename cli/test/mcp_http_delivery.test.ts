import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpClientManager, McpConnection } from "../src/mcp.js";

interface Seen {
  method: string;
  path: string;
  rpcMethod?: string;
}

type Handler = (request: Seen, body: any, req: IncomingMessage, res: ServerResponse) => void;

async function withServer<T>(handler: Handler, run: (url: string, seen: Seen[]) => Promise<T>): Promise<T> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request = { method: req.method ?? "", path: req.url ?? "" };
      seen.push({ ...request, rpcMethod: JSON.parse(Buffer.concat(chunks).toString("utf8"))?.method });
      handler(request, JSON.parse(Buffer.concat(chunks).toString("utf8")), req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await run(url, seen);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function json(res: ServerResponse, body: unknown): void {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

const toolCalls = (seen: Seen[]) => seen.filter((request) => request.method === "POST" && request.rpcMethod === "tools/call");

test("MCP HTTP tools/call is not resent after the server receives it and drops the connection", async () => {
  await withServer((request, _body, req) => {
    if (request.path === "/message") req.socket.destroy();
  }, async (url, seen) => {
    const connection = new McpConnection("fixture", { url, transport: "http" });
    const result = await connection.callTool("write_record", { value: "one" });

    assert.deepEqual(toolCalls(seen).map((call) => call.path), ["/message"]);
    assert.equal(result.success, false);
    assert.equal(result.outcomeUnknown, true);
    assert.match(result.error ?? "", /outcome unknown/i);
    assert.match(result.error ?? "", /check its effect before retrying/i);
  });
});

test("MCP HTTP tools/call falls back only after an explicit missing-route response", async () => {
  await withServer((request, body, _req, res) => {
    if (request.path === "/message") {
      res.statusCode = 404;
      res.end("no message route");
      return;
    }
    json(res, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "written" }] } });
  }, async (url, seen) => {
    const connection = new McpConnection("fixture", { url, transport: "http" });
    const result = await connection.callTool("write_record", { value: "one" });

    assert.deepEqual(toolCalls(seen).map((call) => call.path), ["/message", "/"]);
    assert.equal(result.success, true);
    assert.equal(result.output, "written");
  });
});

test("MCP HTTP tools/call does not retry a server error that may follow an effect", async () => {
  await withServer((request, _body, _req, res) => {
    if (request.path === "/message") {
      res.statusCode = 503;
      res.end("temporary server error");
      return;
    }
    json(res, { jsonrpc: "2.0", result: { content: [{ type: "text", text: "duplicate" }] } });
  }, async (url, seen) => {
    const connection = new McpConnection("fixture", { url, transport: "http" });
    const result = await connection.callTool("write_record", { value: "one" });

    assert.deepEqual(toolCalls(seen).map((call) => call.path), ["/message"]);
    assert.equal(result.success, false);
    assert.equal(result.outcomeUnknown, true);
    assert.match(result.error ?? "", /outcome unknown/i);
  });
});

test("MCP HTTP tools/call with an unreadable response is reported as unknown without fallback", async () => {
  await withServer((request, _body, _req, res) => {
    if (request.path === "/message") {
      res.end("not JSON");
      return;
    }
    json(res, { jsonrpc: "2.0", result: { content: [{ type: "text", text: "duplicate" }] } });
  }, async (url, seen) => {
    const connection = new McpConnection("fixture", { url, transport: "http" });
    const result = await connection.callTool("write_record", { value: "one" });

    assert.deepEqual(toolCalls(seen).map((call) => call.path), ["/message"]);
    assert.equal(result.success, false);
    assert.equal(result.outcomeUnknown, true);
    assert.match(result.error ?? "", /outcome unknown/i);
  });
});

test("MCP HTTP read requests retain legacy fallback after a connection error", async () => {
  await withServer((request, body, req, res) => {
    if (request.path === "/message") {
      req.socket.destroy();
      return;
    }
    json(res, { jsonrpc: "2.0", id: body.id, result: { tools: [] } });
  }, async (url, seen) => {
    const connection = new McpConnection("fixture", { url, transport: "http" });
    const result = await connection.sendRequest("tools/list");

    assert.deepEqual(seen.map((call) => call.path), ["/message", "/"]);
    assert.deepEqual(result, { tools: [] });
  });
});

test("MCP HTTP tools/call timeout reports unknown, sends cancellation, and is not resent", async () => {
  let cancelObserved!: () => void;
  const cancelled = new Promise<void>((resolve) => { cancelObserved = resolve; });
  await withServer((_request, body, _req, res) => {
    if (body.method === "notifications/cancelled") {
      cancelObserved();
      res.statusCode = 202;
      res.end();
    }
  }, async (url, seen) => {
    const connection = new McpConnection("fixture", { url, transport: "http" });
    const result = await connection.callTool("write_record", { value: "one" }, 100);
    await cancelled;

    assert.deepEqual(toolCalls(seen).map((call) => call.path), ["/message"]);
    assert.deepEqual(seen.filter((request) => request.rpcMethod === "notifications/cancelled").map((request) => request.path), ["/message"]);
    assert.equal(result.success, false);
    assert.equal(result.outcomeUnknown, true);
    assert.match(result.error ?? "", /outcome unknown/i);
  });
});

test("MCP HTTP tools/call is aborted on turn cancellation and keeps a dispatched effect unknown", async () => {
  let entered!: () => void;
  let disconnected!: () => void;
  let cancelObserved!: () => void;
  const requestStarted = new Promise<void>((resolve) => { entered = resolve; });
  const responseClosed = new Promise<void>((resolve) => { disconnected = resolve; });
  const cancelled = new Promise<void>((resolve) => { cancelObserved = resolve; });
  let effectStarted = false;
  await withServer((request, body, _req, res) => {
    if (request.path !== "/message") return;
    if (body.method === "tools/call") {
      effectStarted = true;
      entered();
      res.on("close", disconnected);
    } else if (body.method === "notifications/cancelled") {
      cancelObserved();
      res.statusCode = 202;
      res.end();
    }
  }, async (url, seen) => {
    const connection = new McpConnection("fixture", { url, transport: "http" });
    const controller = new AbortController();
    const pending = connection.callTool("write_record", { value: "one" }, 5000, controller.signal);
    await requestStarted;
    controller.abort(new Error("operator cancelled"));
    const result = await pending;
    await responseClosed;
    await cancelled;

    assert.equal(effectStarted, true);
    assert.deepEqual(toolCalls(seen).map((call) => call.path), ["/message"]);
    assert.deepEqual(seen.filter((request) => request.rpcMethod === "notifications/cancelled").map((request) => request.path), ["/message"]);
    assert.equal(result.success, false);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(result.cancelled, undefined);
    assert.match(result.error ?? "", /outcome unknown/i);
  });
});

test("MCP call already cancelled before dispatch is reported without an unknown effect", async () => {
  await withServer(() => {}, async (url, seen) => {
    const connection = new McpConnection("fixture", { url, transport: "http" });
    const controller = new AbortController();
    controller.abort();
    const result = await connection.callTool("write_record", { value: "one" }, 100, controller.signal);

    assert.deepEqual(toolCalls(seen), []);
    assert.equal(result.cancelled, true);
    assert.equal(result.outcomeUnknown, undefined);
  });
});

test("MCP stdio cancellation notifies the server and reports unknown after dispatch", async () => {
  const connection = new McpConnection("fixture", { command: "fixture" });
  const writes: any[] = [];
  let effectStarted = false;
  let entered!: () => void;
  const requestStarted = new Promise<void>((resolve) => { entered = resolve; });
  (connection as any).child = {
    killed: false,
    stdin: {
      write(raw: string) {
        const message = JSON.parse(raw);
        writes.push(message);
        if (message.method === "tools/call") {
          effectStarted = true;
          entered();
        }
        return true;
      },
    },
  };
  const controller = new AbortController();
  const pending = connection.callTool("write_record", { value: "one" }, 5000, controller.signal);
  await requestStarted;
  controller.abort(new Error("operator cancelled"));
  const result = await pending;
  (connection as any).child = null;

  assert.equal(effectStarted, true);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].method, "tools/call");
  assert.deepEqual(writes[1], {
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: writes[0].id, reason: "MCP request 'tools/call' was cancelled after it was sent" },
  });
  assert.equal(result.success, false);
  assert.equal(result.outcomeUnknown, true);
  assert.match(result.error ?? "", /check its effect before retrying/i);
});

test("MCP stdio timeout notifies the server before returning an unknown outcome", async () => {
  const connection = new McpConnection("fixture", { command: "fixture" });
  const writes: any[] = [];
  (connection as any).child = {
    killed: false,
    stdin: {
      write(raw: string) { writes.push(JSON.parse(raw)); return true; },
    },
  };
  const result = await connection.callTool("write_record", { value: "one" }, 20);
  (connection as any).child = null;

  assert.equal(writes.length, 2);
  assert.equal(writes[0].method, "tools/call");
  assert.equal(writes[1].method, "notifications/cancelled");
  assert.equal(writes[1].params.requestId, writes[0].id);
  assert.equal(result.outcomeUnknown, true);
});

test("MCP initialize timeout does not send a forbidden cancellation notification", async () => {
  const connection = new McpConnection("fixture", { command: "fixture" });
  const writes: any[] = [];
  (connection as any).child = {
    killed: false,
    stdin: { write(raw: string) { writes.push(JSON.parse(raw)); return true; } },
  };
  await assert.rejects(connection.sendRequest("initialize", {}, 20));
  (connection as any).child = null;

  assert.deepEqual(writes.map((message) => message.method), ["initialize"]);
});

test("MCP manager forwards turn cancellation to the selected server call", async () => {
  const manager = new McpClientManager(process.cwd(), { trusted: true });
  const connection = new McpConnection("fixture", { command: "fixture" });
  const writes: any[] = [];
  let entered!: () => void;
  const requestStarted = new Promise<void>((resolve) => { entered = resolve; });
  (connection as any).child = {
    killed: false,
    stdin: {
      write(raw: string) {
        const message = JSON.parse(raw);
        writes.push(message);
        if (message.method === "tools/call") entered();
        return true;
      },
    },
  };
  (manager as any).toolToServerMap.set("mcp__fixture__write", { server: connection, originalName: "write", serverName: "fixture" });
  const controller = new AbortController();
  const pending = manager.executeMcpTool("mcp__fixture__write", { value: "one" }, controller.signal);
  await requestStarted;
  controller.abort();
  const result = await pending;
  (connection as any).child = null;
  manager.shutdownAll();

  assert.equal(writes[1].method, "notifications/cancelled");
  assert.equal(result.outcomeUnknown, true);
});

test("MCP WebSocket cancellation notifies the server and reports unknown after dispatch", async () => {
  const connection = new McpConnection("fixture", { url: "ws://fixture", transport: "websocket" });
  const writes: any[] = [];
  let effectStarted = false;
  (connection as any).ws = {
    send(raw: string) {
      const message = JSON.parse(raw);
      writes.push(message);
      if (message.method === "tools/call") effectStarted = true;
    },
  };
  const controller = new AbortController();
  const pending = connection.callTool("write_record", { value: "one" }, 5000, controller.signal);
  for (let i = 0; i < 100 && !effectStarted; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort(new Error("operator cancelled"));
  const result = await pending;
  (connection as any).ws = null;

  assert.equal(effectStarted, true);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].method, "notifications/cancelled");
  assert.equal(writes[1].params.requestId, writes[0].id);
  assert.equal(result.success, false);
  assert.equal(result.outcomeUnknown, true);
});
