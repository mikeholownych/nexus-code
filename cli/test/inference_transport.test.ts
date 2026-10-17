import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { InferenceError, LocalLlmClient } from "../src/client.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;
interface Seen { id?: string; stream: boolean; remotePort?: number }

async function withServer<T>(handler: Handler, fn: (base: string, seen: Seen[]) => Promise<T>): Promise<T> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ id: req.headers["x-request-id"] as string, stream: !!JSON.parse(body || "{}").stream, remotePort: req.socket.remotePort });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

const client = (base: string, extra: Record<string, unknown> = {}) => new LocalLlmClient({ model: "m", endpoint: base, apiKey: "k", ...extra } as any);
const msgs = [{ role: "user" as const, content: "x" }];
const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const text = (s: string) => frame({ choices: [{ index: 0, delta: { content: s } }] });
const finish = (r = "stop") => frame({ choices: [{ index: 0, delta: {}, finish_reason: r }] });
const sseHead = (res: http.ServerResponse) => res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });

async function writeSlowly(res: http.ServerResponse, parts: (string | Buffer)[], gapMs: number): Promise<void> {
  for (const p of parts) {
    res.write(p);
    if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
  }
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe("inference transport: success paths", () => {
  test("non-streaming completion", async () => {
    await withServer(
      (_q, res) => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }] })),
      async (base) => assert.equal((await client(base).chatCompletion(msgs, [])).content, "hello"),
    );
  });

  test("SSE split at arbitrary byte boundaries (mid-prefix, mid-JSON, mid-UTF-8, CRLF, heartbeats, event lines) assembles exactly", async () => {
    const wire = Buffer.from(
      ": keepalive\r\n\r\n" +
        "event: message\r\n" + text("héllo ").replace(/\n/g, "\r\n") +
        text("wörld ✓ 日本") +
        ": ping\n\n" +
        finish() +
        "data: [DONE]\n\n",
      "utf8",
    );
    const pieces: Buffer[] = [];
    for (let i = 0; i < wire.length; i += 3) pieces.push(wire.subarray(i, i + 3));
    await withServer(
      (_q, res) => {
        sseHead(res);
        void writeSlowly(res, pieces, 1).then(() => res.end());
      },
      async (base) => {
        const tokens: string[] = [];
        const m = await client(base).chatCompletionStream(msgs, [], (t) => tokens.push(t));
        assert.equal(m.content, "héllo wörld ✓ 日本");
        assert.equal(tokens.join(""), "héllo wörld ✓ 日本");
      },
    );
  });

  test("tool-call argument deltas fragmented across frames and writes assemble into one call", async () => {
    const wire =
      frame({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read_file", arguments: "" } }] } }] }) +
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] }) +
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"AGENTS.md"}' } }] } }] }) +
      finish("tool_calls") + "data: [DONE]\n\n";
    await withServer(
      (_q, res) => {
        sseHead(res);
        void writeSlowly(res, wire.match(/[\s\S]{1,7}/g)!, 0).then(() => res.end());
      },
      async (base) => {
        const m = await client(base).chatCompletionStream(msgs, [], () => {});
        assert.deepEqual(m.tool_calls?.map((t) => [t.id, t.function.name, t.function.arguments]), [["c1", "read_file", '{"path":"AGENTS.md"}']]);
      },
    );
  });

  test("long stream (5000 frames) is received completely", async () => {
    await withServer(
      (_q, res) => {
        sseHead(res);
        let out = "";
        for (let i = 0; i < 5000; i++) out += text("ab");
        res.end(out + finish() + "data: [DONE]\n\n");
      },
      async (base) => assert.equal((await client(base).chatCompletionStream(msgs, [], () => {})).content?.length, 10000),
    );
  });

  test("delayed chunks within the request timeout complete normally", async () => {
    await withServer(
      (_q, res) => {
        sseHead(res);
        void writeSlowly(res, [text("a"), text("b"), text("c"), finish(), "data: [DONE]\n\n"], 150).then(() => res.end());
      },
      async (base) => assert.equal((await client(base).chatCompletionStream(msgs, [], () => {})).content, "abc"),
    );
  });

  test("keep-alive connections are reused for sequential non-streaming requests", async () => {
    await withServer(
      (_q, res) => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })),
      async (base, seen) => {
        const c = client(base);
        for (let i = 0; i < 6; i++) assert.equal((await c.chatCompletion(msgs, [])).content, "ok");
        assert.equal(seen.length, 6);
        // undici may open a second socket before the first is released back to its pool; it never opens one per request.
        assert.ok(new Set(seen.map((s) => s.remotePort)).size <= 2, JSON.stringify(seen.map((s) => s.remotePort)));
      },
    );
  });

  test("server closing the socket after [DONE] is a clean completion", async () => {
    await withServer(
      (_q, res) => {
        sseHead(res);
        res.write(text("done") + finish() + "data: [DONE]\n\n");
        setTimeout(() => res.socket?.destroy(), 20);
      },
      async (base) => assert.equal((await client(base).chatCompletionStream(msgs, [], () => {})).content, "done"),
    );
  });

  test("the request timeout is per request: sequential requests each get a fresh budget", async () => {
    const prev = process.env.LOCAL_LLM_TIMEOUT_MS;
    process.env.LOCAL_LLM_TIMEOUT_MS = "500";
    try {
      await withServer(
        (_q, res) => {
          sseHead(res);
          void writeSlowly(res, [text("x"), finish(), "data: [DONE]\n\n"], 120).then(() => res.end());
        },
        async (base) => {
          const c = client(base);
          const ac = new AbortController();
          for (let i = 0; i < 4; i++) assert.equal((await c.chatCompletionStream(msgs, [], () => {}, `r${i}`, ac.signal)).content, "x");
        },
      );
    } finally {
      if (prev === undefined) delete process.env.LOCAL_LLM_TIMEOUT_MS;
      else process.env.LOCAL_LLM_TIMEOUT_MS = prev;
    }
  });
});

describe("inference transport: failures are classified, keep their cause, and are not resent", () => {
  test("HTTP 400 is a client http_error, not failed over", async () => {
    await withServer(
      (_q, res) => { res.writeHead(400); res.end('{"error":{"message":"bad request"}}'); },
      async (base, seen) => {
        await withServer(
          (_q, res) => res.end("{}"),
          async (backup, backupSeen) => {
            await assert.rejects(() => client(base, { fallbackEndpoints: [backup] }).chatCompletionStream(msgs, [], () => {}), (e: any) =>
              e.kind === "http_error" && e.origin === "client" && e.httpStatus === 400);
            assert.equal(seen.length, 1);
            assert.equal(backupSeen.length, 0);
          },
        );
      },
    );
  });

  test("HTTP 429 is a provider http_error with the status, sent once", async () => {
    await withServer(
      (_q, res) => { res.writeHead(429, { "Retry-After": "3" }); res.end('{"error":{"message":"busy"}}'); },
      async (base, seen) => {
        await assert.rejects(() => client(base).chatCompletionStream(msgs, [], () => {}), (e: any) =>
          e.kind === "http_error" && e.origin === "provider" && e.httpStatus === 429);
        assert.equal(seen.length, 1);
      },
    );
  });

  test("premature termination after partial output is stream_interrupted with its cause, partial text not returned", async () => {
    await withServer(
      (_q, res) => {
        // Force a detectable short body: with a close-delimited/chunked response, both Node 20 and 24
        // expose a peer reset as ordinary EOF and the client correctly reports stream_incomplete.
        res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close", "Content-Length": "1024" });
        res.write(text("partial "));
        setTimeout(() => res.socket?.resetAndDestroy(), 50);
      },
      async (base, seen) => {
        await assert.rejects(() => client(base).chatCompletionStream(msgs, [], () => {}, "rid-pt"), (e: any) => {
          assert.ok(e instanceof InferenceError);
          assert.equal(e.kind, "stream_interrupted");
          assert.equal(e.partialText, "partial ");
          assert.ok(e.transportCause.length > 0, "cause chain preserved");
          assert.deepEqual(e.toFailure().transportCause, e.transportCause);
          return true;
        });
        assert.equal(seen.length, 1);
      },
    );
  });

  test("connection refused is network_error naming ECONNREFUSED; the request is not resent as non-streaming", async () => {
    const port = await freePort();
    const calls: boolean[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((url: any, init: any) => { calls.push(!!JSON.parse(init.body).stream); return realFetch(url, init); }) as any;
    try {
      await assert.rejects(() => client(`http://127.0.0.1:${port}`).chatCompletionStream(msgs, [], () => {}, "rid-cr"), (e: any) => {
        assert.equal(e.kind, "network_error");
        assert.equal(e.origin, "transport");
        assert.equal(e.requestId, "rid-cr");
        assert.equal(e.transportCause[0].code, "ECONNREFUSED");
        assert.equal(e.transportCause[0].syscall, "connect");
        assert.match(e.message, /fetch failed \(cause: ECONNREFUSED/);
        return true;
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(calls, [true], "exactly one streaming attempt, no silent non-streaming resend");
  });

  test("connection accepted then reset before any response (gateway exiting) is network_error with ECONNRESET, sent once", async () => {
    const sockets: net.Socket[] = [];
    const server = net.createServer((s) => { sockets.push(s); s.on("error", () => {}); setTimeout(() => s.resetAndDestroy(), 100); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await assert.rejects(() => client(base).chatCompletionStream(msgs, [], () => {}, "rid-rst"), (e: any) => {
        assert.equal(e.kind, "network_error");
        assert.ok(e.transportCause.some((c: any) => c.code === "ECONNRESET" || c.code === "UND_ERR_SOCKET"), JSON.stringify(e.transportCause));
        return true;
      });
      assert.equal(sockets.length, 1, "no second connection for a resend");
    } finally {
      server.close();
    }
  });

  test("operator abort before the response is 'aborted' with no transport cause", async () => {
    await withServer(
      () => {},
      async (base) => {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 100);
        await assert.rejects(() => client(base).chatCompletionStream(msgs, [], () => {}, "rid-ab", ac.signal), (e: any) =>
          e.kind === "aborted" && e.origin === "operator" && e.transportCause.length === 0);
      },
    );
  });
});

const haveOpenssl = spawnSync("openssl", ["version"]).status === 0;

describe("inference transport: TLS with a private trust root", { skip: !haveOpenssl && "openssl not available" }, () => {
  let dir = "";
  let server: https.Server;
  let base = "";

  test("setup: private CA, server certificate for 127.0.0.1, HTTPS SSE server", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tls-"));
    const o = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
    o(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=Nexus Test Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign"]);
    o(["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=127.0.0.1"]);
    fs.writeFileSync(path.join(dir, "ext.cnf"), "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
    o(["x509", "-req", "-in", "srv.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "srv.crt", "-days", "2", "-extfile", "ext.cnf"]);
    server = https.createServer({ key: fs.readFileSync(path.join(dir, "srv.key")), cert: fs.readFileSync(path.join(dir, "srv.crt")) }, (req, res) => {
      req.resume();
      req.on("end", () => { sseHead(res); res.end(text("over tls") + finish() + "data: [DONE]\n\n"); });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  test("ACC-INF-09: certificate from an untrusted root is rejected as PERMANENT_FAILURE with NODE_EXTRA_CA_CERTS hint and is not retried", async () => {
    const { ProviderRecoveryController, DEFAULT_RECOVERY_POLICY } = await import("../src/core/provider_recovery.js");
    const { fakeClock } = await import("./helpers/provider_fixture.js");
    const clock = fakeClock();
    let attempts = 0;
    const controller = new ProviderRecoveryController(DEFAULT_RECOVERY_POLICY, clock, 1);
    await assert.rejects(
      () =>
        controller.run("rid-tls", {
          submit: async () => {
            attempts++;
            return client(base).chatCompletionStream(msgs, [], () => {});
          },
          probe: async () => ({ available: true, condition: "AVAILABLE" }),
          classify: (e: any) => (typeof e?.toFailure === "function" ? e.toFailure() : null),
          newRequestId: () => "rid-tls-2",
        }),
      (e: any) => {
        assert.equal(e.kind, "network_error");
        assert.equal(e.condition, "PERMANENT_FAILURE");
        assert.equal(e.execution, "NOT_EXECUTED");
        assert.match(e.message, /NODE_EXTRA_CA_CERTS/);
        assert.match(e.message, /config\.env/);
        assert.ok(e.transportCause.some((c: any) => /CERT|SIGNATURE|ISSUER/.test(c.code ?? "")), JSON.stringify(e.transportCause));
        return true;
      },
    );
    assert.equal(attempts, 1, "TLS verification failure must not be retried");
    assert.equal(controller.record?.state, "NOT_RECOVERABLE");
  });

  test("the same server succeeds when the root is trusted through NODE_EXTRA_CA_CERTS (how Nexus is deployed)", async () => {
    const script = `import { LocalLlmClient } from ${JSON.stringify(path.resolve("src/client.ts"))};
const c = new LocalLlmClient({ model: "m", endpoint: ${JSON.stringify(base)}, apiKey: "k" });
const m = await c.chatCompletionStream([{ role: "user", content: "x" }], [], () => {});
process.stdout.write(String(m.content));`;
    // The HTTPS server lives in this process, so the child must run without blocking our event loop.
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(dir, "ca.crt") },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const status = await new Promise<number | null>((r) => child.on("exit", r));
    assert.equal(status, 0, stderr);
    assert.equal(stdout, "over tls");
  });

  test("ACC-INF-09: doctor validates NODE_EXTRA_CA_CERTS in ~/.config/nexus/config.env", async () => {
    const { runDoctor } = await import("../src/doctor.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ca-home-"));
    try {
      const cfgDir = path.join(home, ".config/nexus");
      fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(cfgDir, "config.env"), `NODE_EXTRA_CA_CERTS=${path.join(dir, "ca.crt")}\n`, { mode: 0o600 });
      const reportOk = await runDoctor({ home });
      const findingOk = reportOk.findings.find((f) => f.id === "config.custom_ca");
      assert.ok(findingOk, "config.custom_ca finding must be present");
      assert.equal(findingOk.status, "pass", findingOk.explanation);

      // Invalid PEM content fails validation
      const badPem = path.join(dir, "bad.crt");
      fs.writeFileSync(badPem, "not a pem certificate\n");
      fs.writeFileSync(path.join(cfgDir, "config.env"), `NODE_EXTRA_CA_CERTS=${badPem}\n`, { mode: 0o600 });
      const reportBad = await runDoctor({ home });
      const findingBad = reportBad.findings.find((f) => f.id === "config.custom_ca");
      assert.ok(findingBad);
      assert.equal(findingBad.status, "fail");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("teardown", async () => {
    server?.closeAllConnections?.();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });
});
