import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpConnection } from "../src/mcp.js";

interface Seen {
  method: string;
  path: string;
}

type Handler = (request: Seen, body: any, req: IncomingMessage, res: ServerResponse) => void;

async function withServer<T>(handler: Handler, run: (url: string, seen: Seen[]) => Promise<T>): Promise<T> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request = { method: req.method ?? "", path: req.url ?? "" };
      seen.push(request);
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

const toolCalls = (seen: Seen[]) => seen.filter((request) => request.method === "POST");

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

test("MCP HTTP tools/call timeout reports unknown and is not sent again", async () => {
  await withServer((_request, _body, _req, _res) => {}, async (url, seen) => {
    const connection = new McpConnection("fixture", { url, transport: "http" });
    const result = await connection.callTool("write_record", { value: "one" }, 100);

    assert.deepEqual(toolCalls(seen).map((call) => call.path), ["/message"]);
    assert.equal(result.success, false);
    assert.equal(result.outcomeUnknown, true);
    assert.match(result.error ?? "", /outcome unknown/i);
  });
});
