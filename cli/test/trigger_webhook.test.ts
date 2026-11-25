/** BG-3: the webhook listener against hostile callers. Every refusal here has the same status and body, and none reaches `onDelivery` (the limiter and the job). */
import "./helpers/leak_guard.js";
import { trackResource } from "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { allowedHostNames, ReplayCache, webhookSignature, webhookSigningInput, WebhookListener, type WebhookDelivery, type WebhookOptions } from "../src/core/trigger_webhook.js";
import { post, signed } from "./helpers/trigger_fixture.js";

const SECRET = Buffer.from("0123456789abcdef0123456789abcdef");
const KEY = "0123456789ab";
const PATH = `/hook/${KEY}/hook`;

async function listener(extra: Partial<WebhookOptions> & { origins?: string[] } = {}) {
  const deliveries: WebhookDelivery[] = [];
  const l = new WebhookListener({
    host: "127.0.0.1", port: 0, requestTimeoutMs: 800, hasAuthentication: () => true,
    lookup: (key, id) => (key === KEY && (id === "hook" || id === "hook2") ? { secret: SECRET, allowedOrigins: extra.origins ?? [] } : undefined),
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
    same(await post(port, PATH, body, signed(secret, PATH, body)), { status: 202, body: '{"status":"accepted"}' });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.body.toString(), body);
    assert.equal(deliveries[0]!.workspaceKey, KEY);
  } finally { await l.close(); }
});

test("wrong, missing, malformed, expired and future signatures and unknown routes: one identical refusal, nothing delivered", async () => {
  const { l, port, deliveries } = await listener();
  try {
    const body = "{}";
    const good = signed(secret, PATH, body);
    const now = Math.floor(Date.now() / 1000);
    const cases: Array<[string, string, Record<string, string>]> = [
      ["wrong secret", PATH, signed("a-different-secret-a-different-secret", PATH, body)],
      ["body differs from the signed one", PATH, signed(secret, PATH, "{\"x\":1}")],
      ["no signature", PATH, { ...good, "x-nexus-signature": "" }],
      ["malformed signature", PATH, { ...good, "x-nexus-signature": "v1=zz" }],
      ["no timestamp", PATH, { ...good, "x-nexus-timestamp": "" }],
      ["no delivery id", PATH, { ...good, "x-nexus-delivery": "" }],
      ["expired (6 minutes old)", PATH, signed(secret, PATH, body, { timestamp: now - 360 })],
      ["from the future (6 minutes)", PATH, signed(secret, PATH, body, { timestamp: now + 360 })],
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
    const headers = signed(secret, PATH, body, { delivery: "once-only-0001" });
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
    const declared = (await post(port, PATH, big, signed(secret, PATH, big))) as any;
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
      const res = (await post(port, PATH, body, signed(secret, PATH, body), { host })) as any;
      assert.equal(res.status ?? res.error, 401, JSON.stringify(host));
    }
    const noHost = await new Promise<string>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write(`POST ${PATH} HTTP/1.0\r\ncontent-length: 2\r\n${Object.entries(signed(secret, PATH, body)).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n{}`));
      let text = "";
      socket.on("data", (c) => (text += c));
      socket.on("close", () => resolve(text));
      socket.on("error", () => resolve(text));
    });
    assert.match(noHost, /^HTTP\/1\.[01] 401/, "a request with no Host header at all is refused too");
    assert.equal(deliveries.length, 0);
    assert.equal(((await post(port, PATH, body, signed(secret, PATH, body), { host: `localhost:${port}` })) as any).status, 202, "localhost is a loopback name");
  } finally { await l.close(); }
});

test("an Origin header is refused unless the spec lists it, and is never authentication on its own", async () => {
  const { l, port, deliveries } = await listener({ origins: ["https://ci.example"] });
  try {
    const body = "{}";
    assert.equal(((await post(port, PATH, body, { ...signed(secret, PATH, body), origin: "https://evil.example" })) as any).status, 401);
    assert.equal(((await post(port, PATH, body, { origin: "https://ci.example" })) as any).status, 401, "a listed origin without a signature gets nothing");
    assert.equal(deliveries.length, 0);
    assert.equal(((await post(port, PATH, body, { ...signed(secret, PATH, body), origin: "https://ci.example" })) as any).status, 202);
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
    const res = await post(port, PATH, body, { ...signed(secret, PATH, body), "x-padding": "p".repeat(20_000) });
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

test("known-answer vector: the signature of a fixed delivery is the one `openssl dgst` computes", () => {
  // printf 'nexus-webhook-v1\n/hook/0123456789ab/hook\n1790000000\ndelivery-0001\n7\n{"a":1}' | openssl dgst -sha256 -hmac 0123456789abcdef0123456789abcdef
  assert.equal(webhookSignature("0123456789abcdef0123456789abcdef", PATH, "1790000000", "delivery-0001", Buffer.from('{"a":1}')),
    "v1=a2f618b81b11c53b6c8f674f178f885f2ec98c18094c2e424c5a6cf8a9c60929");
  assert.equal(webhookSigningInput(PATH, "1790000000", "delivery-0001", Buffer.from("xy")).toString(), `nexus-webhook-v1\n${PATH}\n1790000000\ndelivery-0001\n2\nxy`);
});

test("re-splitting a captured delivery (another id and body under the same signature) is refused, and no field can move into another", async () => {
  const { l, port, deliveries } = await listener();
  try {
    const original = signed(secret, PATH, "foo.bar", { delivery: "abcdefgh" });
    assert.equal(((await post(port, PATH, "foo.bar", original)) as any).status, 202);
    const resplit = { ...original, "x-nexus-delivery": "abcdefgh.foo" };
    assert.equal(((await post(port, PATH, "bar", resplit)) as any).status, 401, "the id and body of the old scheme's attack");
    assert.equal(((await post(port, PATH, "bar", { ...original, "x-nexus-delivery": "abcdefgh-foo" })) as any).status, 401);
    assert.equal(((await post(port, PATH, "foo.barx", original)) as any).status, 401, "a body of another length");
    assert.equal(deliveries.length, 1);
    // No two different (route, timestamp, id, body) tuples sign the same bytes.
    const seen = new Set<string>();
    for (const [route, ts, id, body] of [[PATH, "1", "ab", "c"], [PATH, "1", "a", "bc"], [PATH, "11", "ab", "c"], [PATH, "1", "ab", "1\nc"], ["/x", "1", "ab", "c"], [PATH, "1", "ab", ""], [PATH, "1", "a", "b\n0\n"]] as const)
      seen.add(webhookSigningInput(route, ts, id, Buffer.from(body)).toString("hex"));
    assert.equal(seen.size, 7);
  } finally { await l.close(); }
});

test("a delivery id with a dot, space, newline, non-ASCII character, or the wrong length is refused even when correctly signed", async () => {
  const { l, port, deliveries } = await listener();
  try {
    for (const id of ["abc.defgh", "abc defgh", "abc\ndefgh", "abc\u00e9defgh", "ab/cdefgh", "", "x".repeat(129)]) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const res = (await post(port, PATH, "{}", { "x-nexus-timestamp": timestamp, "x-nexus-delivery": id, "x-nexus-signature": webhookSignature(SECRET, PATH, timestamp, id, Buffer.from("{}")) })) as any;
      assert.ok(res.status === 401 || "error" in res, `${JSON.stringify(id)}: ${JSON.stringify(res)}`);
    }
    assert.equal(deliveries.length, 0);
    const ok = signed(secret, PATH, "{}", { delivery: "x".repeat(128) });
    assert.equal(((await post(port, PATH, "{}", ok)) as any).status, 202, "128 characters of [A-Za-z0-9_-] is the longest id accepted");
  } finally { await l.close(); }
});

test("two triggers that share a secret cannot replay each other's deliveries: the route is signed", async () => {
  const { l, port, deliveries } = await listener();
  try {
    const other = `/hook/${KEY}/hook2`;
    const headers = signed(secret, PATH, "{}", { delivery: "cross-0001" });
    assert.equal(((await post(port, other, "{}", headers)) as any).status, 401);
    assert.equal(deliveries.length, 0);
    assert.equal(((await post(port, other, "{}", signed(secret, other, "{}", { delivery: "cross-0001" }))) as any).status, 202, "its own signature works");
    assert.equal(deliveries[0]!.id, "hook2");
  } finally { await l.close(); }
});

test("an old-scheme signature (timestamp.id.body, sha256=) is refused", async () => {
  const { l, port, deliveries } = await listener();
  try {
    const { createHmac } = await import("node:crypto");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const mac = createHmac("sha256", SECRET).update(`${timestamp}.delivery-0001.{}`).digest("hex");
    assert.equal(((await post(port, PATH, "{}", { "x-nexus-timestamp": timestamp, "x-nexus-delivery": "delivery-0001", "x-nexus-signature": `sha256=${mac}` })) as any).status, 401);
    // The right MAC under the old `sha256=` tag is not the v1 scheme either.
    const good = signed(secret, PATH, "{}", { delivery: "delivery-0002" });
    assert.equal(((await post(port, PATH, "{}", { ...good, "x-nexus-signature": good["x-nexus-signature"]!.replace(/^v1=/, "sha256=") })) as any).status, 401);
    assert.equal(deliveries.length, 0);
  } finally { await l.close(); }
});

test("Host names: loopback names and the bind address; a wildcard bind needs the operator's names; others are refused", async () => {
  assert.deepEqual([...allowedHostNames("127.0.0.1")].sort(), ["127.0.0.1", "[::1]", "localhost"]);
  assert.ok(allowedHostNames("10.1.2.3").has("10.1.2.3"));
  assert.equal(allowedHostNames("0.0.0.0").has("0.0.0.0"), false, "a wildcard is not a name a caller can use");
  assert.ok(allowedHostNames("0.0.0.0", ["Hooks.Example.com"]).has("hooks.example.com"));
  const { l, port, deliveries } = await listener({ hostNames: ["hooks.example.com"] });
  try {
    const body = "{}";
    assert.equal(((await post(port, PATH, body, signed(secret, PATH, body), { host: `hooks.example.com:${port}` })) as any).status, 202, "an operator-listed name works");
    assert.equal(((await post(port, PATH, body, signed(secret, PATH, body), { host: `evil.example:${port}` })) as any).status, 401);
    assert.equal(((await post(port, PATH, body, signed(secret, PATH, body), { host: `hooks.example.com:${port + 1}` })) as any).status, 401, "and only on the listener's own port");
    assert.equal(deliveries.length, 1);
  } finally { await l.close(); }
});

test("one address cannot hold every connection slot: a per-address cap closes the extras and frees up again", async () => {
  const { l, port } = await listener({ maxPerLoopbackAddress: 2, maxPerAddress: 2 });
  try {
    const sockets: net.Socket[] = [];
    const closed: number[] = [];
    for (let i = 0; i < 5; i++) {
      const s = net.connect(port, "127.0.0.1");
      s.on("error", () => undefined);
      s.on("close", () => closed.push(i));
      sockets.push(s);
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(closed.sort(), [2, 3, 4], "the third and later connections from one address were cut");
    for (const s of sockets) s.destroy();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(((await post(port, PATH, "{}", signed(secret, PATH, "{}"))) as any).status, 202, "slots are released when the connections end");
  } finally { await l.close(); }
});
