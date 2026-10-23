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

  test("SearXNG result text fields are extracted like untrusted HTML", async () => {
    const baseUrl = await startMockServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          results: [
            {
              title: "<b>Doc</b><script>alert(1)</script> &amp; more",
              url: "https://example.com/doc\r\n\t",
              content: "<style>p{}</style>plain <i>text</i> &quot;quoted&quot;",
            },
          ],
        })
      );
    });
    process.env.SEARXNG_URL = baseUrl;

    const res = await executeWebSearch("markup extraction", 5);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.results[0].title, "Doc & more");
    assert.strictEqual(res.results[0].url, "https://example.com/doc");
    assert.strictEqual(res.results[0].snippet, 'plain text "quoted"');
  });

  test("DuckDuckGo HTML result URLs are stripped of terminal controls", async () => {
    delete process.env.SEARXNG_URL;
    delete process.env.SEARX_URL;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.startsWith("https://api.duckduckgo.com/")) return new Response("", { status: 404 });
      if (url.startsWith("https://html.duckduckgo.com/")) {
        return new Response(
          '<div class="result results_links"><a class="result__url" href="https://example.com/a\r\n\tb">example</a><a class="result__snippet">snippet</a></div>',
          { status: 200 }
        );
      }
      return new Response("", { status: 404 });
    }) as any;
    try {
      const res = await executeWebSearch("control test", 5);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.results[0].url, "https://example.com/ab");
      assert.strictEqual(/[\u0000-\u001f\u007f-\u009f]/.test(res.results[0].url), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("DuckDuckGo JSON result fields are stripped of terminal controls", async () => {
    delete process.env.SEARXNG_URL;
    delete process.env.SEARX_URL;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      if (String(input).startsWith("https://api.duckduckgo.com/")) {
        return new Response(JSON.stringify({
          Heading: "Title\u001b]0;PWNED\u0007",
          AbstractText: "snippet\u009b2J",
          AbstractURL: "https://example.com/\u001b]52;c;x\u0007\r\n\t",
          RelatedTopics: [{ Text: "topic\u001b[31mred", FirstURL: "https://example.com/t\u009b" }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("", { status: 404 });
    }) as any;
    try {
      const res = await executeWebSearch("control test", 5);
      assert.strictEqual(res.success, true);
      assert.ok(res.results.length >= 2);
      const hasControl = (s: string) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(s);
      for (const r of res.results) {
        assert.strictEqual(hasControl(r.title), false, `title: ${JSON.stringify(r.title)}`);
        assert.strictEqual(hasControl(r.url), false, `url: ${JSON.stringify(r.url)}`);
        assert.strictEqual(hasControl(r.snippet), false, `snippet: ${JSON.stringify(r.snippet)}`);
      }
      assert.strictEqual(res.results[0].snippet, "snippet2J");
      assert.strictEqual(res.results[0].url, "https://example.com/]52;c;x");
    } finally {
      globalThis.fetch = originalFetch;
    }
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
