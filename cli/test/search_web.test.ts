import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as http from "node:http";
import { executeWebSearch, resetSearchWebAnnouncements } from "../src/search_web.js";

describe("ACC-TRUST-08 / REQ-PRV-108: Web Search Integrity and Destination Disclosure", () => {
  let server: http.Server | undefined;
  let serverPort: number;
  let mockHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  const originalEnv = { ...process.env };
  const consoleErrors: string[] = [];
  const originalConsoleError = console.error;

  beforeEach(() => {
    resetSearchWebAnnouncements();
    consoleErrors.length = 0;
    console.error = (...args: any[]) => {
      consoleErrors.push(args.map(String).join(" "));
      originalConsoleError(...args);
    };
  });

  afterEach(async () => {
    console.error = originalConsoleError;
    process.env = { ...originalEnv };
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  async function startMockServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<string> {
    mockHandler = handler;
    server = http.createServer((req, res) => mockHandler(req, res));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    serverPort = (server.address() as any).port;
    return `http://127.0.0.1:${serverPort}`;
  }

  test("ACC-TRUST-08: search_web with mock returning no results returns success:false without fabricated results", async () => {
    // Point SearXNG to mock returning empty results
    const baseUrl = await startMockServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    });
    process.env.SEARXNG_URL = baseUrl;

    const res = await executeWebSearch("test query with zero results");
    assert.strictEqual(res.success, false, "search with no results must have success: false");
    assert.deepStrictEqual(res.results, [], "search with no results must return empty results array");
    assert.ok(res.error, "must contain error explanation");
    // Ensure no fabricated items
    assert.strictEqual(
      res.results.some((r) => r.title.includes("Search Query:") || r.snippet.includes("No live web results")),
      false,
      "must never fabricate placeholder results"
    );
  });

  test("ACC-TRUST-08: search_web with mock returning valid results returns success:true", async () => {
    const baseUrl = await startMockServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          results: [
            { title: "Nexus Code Doc", url: "https://example.com/doc", content: "Nexus Code documentation" },
            { title: "Rust Tooling", url: "https://example.com/rust", content: "Rust core engine bridge" },
          ],
        })
      );
    });
    process.env.SEARXNG_URL = baseUrl;

    const res = await executeWebSearch("nexus documentation", 5);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.results.length, 2);
    assert.strictEqual(res.results[0].title, "Nexus Code Doc");
    assert.strictEqual(res.results[0].url, "https://example.com/doc");
    assert.strictEqual(res.results[0].snippet, "Nexus Code documentation");
  });

  test("Destination disclosure: destination is disclosed on first use", async () => {
    const baseUrl = await startMockServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    });
    process.env.SEARXNG_URL = baseUrl;

    await executeWebSearch("query 1");
    assert.ok(
      consoleErrors.some((line) => line.includes("[nexus] Web search: sending query to") && line.includes(baseUrl)),
      "destination must be announced on first use"
    );

    const prevCount = consoleErrors.length;
    await executeWebSearch("query 2");
    // Should not announce again
    assert.strictEqual(
      consoleErrors.filter((line) => line.includes("[nexus] Web search: sending query to")).length,
      1,
      "destination must only be announced once per process"
    );
  });

  test("Disclosure gate: NEXUS_DISABLE_WEB_SEARCH=1 refuses search", async () => {
    process.env.NEXUS_DISABLE_WEB_SEARCH = "1";
    const res = await executeWebSearch("some query");
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.results.length, 0);
    assert.ok(res.error?.includes("disabled by policy"));
  });
});
