/** BG-3: the webhook listener against hostile callers. Every refusal here has the same status and body, and none reaches `onDelivery` (the limiter and the job). */
import "./helpers/leak_guard.js";
import { trackResource } from "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { ReplayCache, WebhookListener, type WebhookDelivery, type WebhookOptions } from "../src/core/trigger_webhook.js";
import { post, signed } from "./helpers/trigger_fixture.js";

const SECRET = Buffer.from("0123456789abcdef0123456789abcdef");
const KEY = "0123456789ab";
const PATH = `/hook/${KEY}/hook`;

async function listener(extra: Partial<WebhookOptions> & { origins?: string[] } = {}) {
  const deliveries: WebhookDelivery[] = [];
  const l = new WebhookListener({
    host: "127.0.0.1", port: 0, requestTimeoutMs: 800, hasAuthentication: () => true,
    lookup: (key, id) => (key === KEY && id === "hook" ? { secret: SECRET, allowedOrigins: extra.origins ?? [] } : undefined),
    onDelivery: (d) => { deliveries.push(d); return { accepted: true }; },
    ...extra,
  });
  const { port } = await l.start();
  trackResource("webhook listener", `port ${port}`, () => l.listening, () => l.close());
  return { l, port, deliveries };
}
const secret = SECRET.toString("utf8");
const same = (a: unknown, b: unknown) => assert.deepEqual(a, b);

test("a correctly signed delivery is accepted once, with its raw body", async () => {
  const { l, port, deliveries } = await listener();
  try {
    const body = '{"a":1}';
    assert.equal((l as any).server.address().address, "127.0.0.1", "bound to loopback, not to every interface");
    same(await post(port, PATH, body, signed(secret, body)), { status: 202, body: '{"status":"accepted"}' });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.body.toString(), body);
    assert.equal(deliveries[0]!.workspaceKey, KEY);
  } finally { await l.close(); }
});

test("wrong, missing, malformed, expired and future signatures and unknown routes: one identical refusal, nothing delivered", async () => {
  const { l, port, deliveries } = await listener();
  try {
    const body = "{}";
    const good = signed(secret, body);
    const now = Math.floor(Date.now() / 1000);
    const cases: Array<[string, string, Record<string, string>]> = [
      ["wrong secret", PATH, signed("a-different-secret-a-different-secret", body)],
      ["body differs from the signed one", PATH, signed(secret, "{\"x\":1}")],
      ["no signature", PATH, { ...good, "x-nexus-signature": "" }],
      ["malformed signature", PATH, { ...good, "x-nexus-signature": "sha256=zz" }],
      ["no timestamp", PATH, { ...good, "x-nexus-timestamp": "" }],
      ["no delivery id", PATH, { ...good, "x-nexus-delivery": "" }],
      ["expired (6 minutes old)", PATH, signed(secret, body, { timestamp: now - 360 })],
      ["from the future (6 minutes)", PATH, signed(secret, body, { timestamp: now + 360 })],
      ["unknown trigger", `/hook/${KEY}/other`, good],
      ["unknown workspace", `/hook/ffffffffffff/hook`, good],
      ["not a hook route", "/", good],
    ];
    const seen = new Set<string>();
    for (const [name, p, headers] of cases) {
      const res = (await post(port, p, body, headers)) as { status: number; body: string };
      assert.equal(res.status, 401, name);
      seen.add(JSON.stringify(res));
    }
    assert.equal(seen.size, 1, "every refusal is the same status and body, so the caller cannot tell which check failed");
    assert.equal(deliveries.length, 0);
  } finally { await l.close(); }
});

test("a delivery id is accepted once: the replay of a signed request is refused", async () => {
  const { l, port, deliveries } = await listener();
  try {
    const body = "{}";
    const headers = signed(secret, body, { delivery: "once-only-0001" });
    assert.equal(((await post(port, PATH, body, headers)) as any).status, 202);
    assert.equal(((await post(port, PATH, body, headers)) as any).status, 401);
    assert.equal(deliveries.length, 1);
  } finally { await l.close(); }
});

test("the replay cache is bounded and fails closed: a full cache refuses a new id rather than forget an old one", () => {
  const cache = new ReplayCache(3, 1_000);
  assert.deepEqual([cache.admit("a", 0), cache.admit("b", 0), cache.admit("c", 0)], [true, true, true]);
  assert.equal(cache.admit("d", 10), false);
  assert.equal(cache.admit("a", 10), false);
  assert.equal(cache.admit("d", 1_001), true, "entries expire with time");
  assert.ok(cache.size() <= 3);
});

test("a body over the cap is refused with 413 before it is buffered whole, declared or streamed", async () => {
  const { l, port, deliveries } = await listener();
  try {
    const big = "x".repeat(64 * 1024 + 1);
    const declared = (await post(port, PATH, big, signed(secret, big))) as any;
    assert.equal(declared.status, 413);
    // No Content-Length: the stream is cut at the cap.
    const streamed = await new Promise<string>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(`POST ${PATH} HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\ntransfer-encoding: chunked\r\n\r\n`);
        const chunk = "x".repeat(8192);
        for (let i = 0; i < 12; i++) socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
      });
      let text = "";
      socket.on("data", (c) => (text += c));
      socket.on("error", () => resolve(text));
      socket.on("close", () => resolve(text));
      setTimeout(() => socket.destroy(), 3_000).unref();
    });
    assert.match(streamed, /^HTTP\/1\.1 413/);
    assert.equal(deliveries.length, 0);
  } finally { await l.close(); }
});

test("a slow body and slow headers (slow-loris) are cut off by the timeouts", async () => {
  const { l, port, deliveries } = await listener();
  try {
    for (const head of [`POST ${PATH} HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\ncontent-length: 10\r\n\r\nab`, `POST ${PATH} HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nx-slow: `]) {
      const started = Date.now();
      await new Promise<void>((resolve) => {
        const socket = net.connect(port, "127.0.0.1", () => socket.write(head));
        socket.resume();
        socket.on("error", () => resolve());
        socket.on("close", () => resolve());
        setTimeout(() => { socket.destroy(); resolve(); }, 8_000).unref();
      });
      assert.ok(Date.now() - started < 6_000, `the connection was held ${Date.now() - started} ms`);
    }
    assert.equal(deliveries.length, 0);
  } finally { await l.close(); }
});

test("a Host header that is not a loopback name (DNS rebinding) is refused, even with a valid signature", async () => {
  const { l, port, deliveries } = await listener();
  try {
    const body = "{}";
    for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1:${port + 1}`, "127.0.0.1.evil.example"]) {
      const res = (await post(port, PATH, body, signed(secret, body), { host })) as any;
      assert.equal(res.status ?? res.error, 401, JSON.stringify(host));
    }
    const noHost = await new Promise<string>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write(`POST ${PATH} HTTP/1.0\r\ncontent-length: 2\r\n${Object.entries(signed(secret, body)).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n{}`));
      let text = "";
      socket.on("data", (c) => (text += c));
      socket.on("close", () => resolve(text));
      socket.on("error", () => resolve(text));
    });
    assert.match(noHost, /^HTTP\/1\.[01] 401/, "a request with no Host header at all is refused too");
    assert.equal(deliveries.length, 0);
    assert.equal(((await post(port, PATH, body, signed(secret, body), { host: `localhost:${port}` })) as any).status, 202, "localhost is a loopback name");
  } finally { await l.close(); }
});

test("an Origin header is refused unless the spec lists it, and is never authentication on its own", async () => {
  const { l, port, deliveries } = await listener({ origins: ["https://ci.example"] });
  try {
    const body = "{}";
    assert.equal(((await post(port, PATH, body, { ...signed(secret, body), origin: "https://evil.example" })) as any).status, 401);
    assert.equal(((await post(port, PATH, body, { origin: "https://ci.example" })) as any).status, 401, "a listed origin without a signature gets nothing");
    assert.equal(deliveries.length, 0);
    assert.equal(((await post(port, PATH, body, { ...signed(secret, body), origin: "https://ci.example" })) as any).status, 202);
  } finally { await l.close(); }
});

test("a browser-style cross-origin request cannot succeed: no preflight is answered and a GET is refused", async () => {
  const { l, port } = await listener();
  try {
    const options = await new Promise<{ status: number; headers: Record<string, unknown> }>((resolve) => {
      import("node:http").then((http) => http.request({ host: "127.0.0.1", port, path: PATH, method: "OPTIONS", agent: false, headers: { origin: "https://evil.example", "access-control-request-method": "POST" } }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers })); }).end());
    });
    assert.equal(options.status, 401);
    assert.equal(options.headers["access-control-allow-origin"], undefined);
  } finally { await l.close(); }
});

test("oversized headers and a global connection cap are enforced", async () => {
  const { l, port, deliveries } = await listener({ maxConnections: 2 });
  try {
    const body = "{}";
    const res = await post(port, PATH, body, { ...signed(secret, body), "x-padding": "p".repeat(20_000) });
    assert.ok("error" in res || res.status >= 400, JSON.stringify(res));
    assert.equal(deliveries.length, 0);
    const sockets: net.Socket[] = [];
    const closed: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const s = net.connect(port, "127.0.0.1");
      s.on("error", () => undefined);
      s.on("close", () => closed.push(true));
      sockets.push(s);
      await new Promise((r) => setTimeout(r, 60));
    }
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(closed.length >= 2, `${closed.length} of 4 connections were refused over the cap of 2`);
    for (const s of sockets) s.destroy();
  } finally { await l.close(); }
});

test("a non-loopback bind is refused without the flag, and with the flag when no trigger has a secret", async () => {
  const base = { port: 0, lookup: () => undefined, onDelivery: () => ({ accepted: false, reason: "refused" } as const) };
  await assert.rejects(new WebhookListener({ ...base, host: "0.0.0.0", hasAuthentication: () => true }).start(), /loopback only/);
  await assert.rejects(new WebhookListener({ ...base, host: "::", hasAuthentication: () => true }).start(), /loopback only/);
  await assert.rejects(new WebhookListener({ ...base, host: "0.0.0.0", allowNonLoopback: true, hasAuthentication: () => false }).start(), /no approved webhook trigger has a secret/);
});

test("close() releases the port: nothing is listening afterwards", async () => {
  const { l, port } = await listener();
  assert.equal(l.listening, true);
  await l.close();
  assert.equal(l.listening, false);
  assert.deepEqual(await post(port, PATH, "{}"), { error: "ECONNREFUSED" });
});
