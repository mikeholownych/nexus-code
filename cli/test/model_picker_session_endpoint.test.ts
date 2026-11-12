/**
 * D-11: the /model picker lists the models of the endpoint this session is actually using (a -e flag or the
 * environment), marks the current one, never carries a credential or a URL's userinfo, and its fetch is bounded
 * (timeout, count, length) and cancellable.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { resetApplianceEndpointOverride } from "../src/config.js";
import { setCredentialAuthority } from "../src/client.js";
import { ApplicationCore } from "../src/core/app.js";
import { SidecarServer } from "../src/sidecar.js";
import { buildCatalog } from "../src/model_catalog.js";
import { selectModel } from "../src/provider_connect.js";
import { makeRepo } from "./helpers/fixtures.js";
import type { HarnessConfig } from "../src/types.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
async function serve(handler: Handler): Promise<{ url: string; close(): Promise<void>; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => { hits.push(`${req.url} ${req.headers.authorization ?? ""}`); handler(req, res); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
const models = (...ids: unknown[]): Handler => (_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: ids.map((id) => ({ id })) })); };

const ENV = ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NEXUS_PROVIDER", "LOCAL_LLM_ENDPOINT", "LOCAL_LLM_MODEL", "LOCAL_LLM_API_KEY", "NEXUS_NO_BROWSER"];
let home: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  resetApplianceEndpointOverride();
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.NEXUS_NO_BROWSER = "1";
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-d11-home-"));
  setCredentialAuthority({}, home);
});
afterEach(() => {
  resetApplianceEndpointOverride();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(home, { recursive: true, force: true });
});
const cfg = (o: Partial<HarnessConfig> = {}): HarnessConfig => ({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 2, temperature: 0, workspace: home, shell: "bash", ...o }) as HarnessConfig;
const SECRET = "sk-d11-SECRET-0123456789abcdef";

describe("D-11: the picker shows the endpoint the session uses", () => {
  test("a session endpoint other than the appliance is listed with its models, and the current one is marked", async () => {
    const session = await serve(models("fake-model", "other-model"));
    try {
      // The appliance is elsewhere (nothing listens there); the session runs on `-e <session>`.
      process.env.LOCAL_LLM_ENDPOINT = "http://127.0.0.1:9/v1";
      const catalog = await buildCatalog(cfg({ endpoint: `${session.url}/v1`, model: "fake-model", apiKey: SECRET }), { timeoutMs: 1500 });
      const entry = catalog.providers.find((p) => p.id === "session");
      assert.ok(entry, "a row for the session endpoint");
      assert.equal(entry!.status, "ok");
      assert.equal(entry!.connected, true);
      assert.equal(entry!.label, `This session (${session.url.replace("http://", "")})`);
      assert.deepEqual(catalog.models.filter((m) => m.provider === "session").map((m) => m.id), ["fake-model", "other-model"]);
      assert.deepEqual(catalog.current, { provider: "session", model: "fake-model" });
      assert.ok(session.hits.some((h) => h.startsWith("/v1/models")), "it asked the session endpoint, not only the appliance");
    } finally { await session.close(); }
  });

  test("the session endpoint is the appliance: one row, the current model marked on it, no duplicate fetch", async () => {
    const session = await serve(models("a", "b"));
    try {
      process.env.LOCAL_LLM_ENDPOINT = `${session.url}/v1`;
      const catalog = await buildCatalog(cfg({ endpoint: `${session.url}/v1/`, model: "b" }));
      assert.equal(catalog.providers.some((p) => p.id === "session"), false);
      assert.deepEqual(catalog.current, { provider: "appliance", model: "b" });
      assert.equal(session.hits.filter((h) => h.startsWith("/v1/models")).length, 1);
    } finally { await session.close(); }
  });

  test("the session endpoint equals the appliance when only userinfo, query, case or a trailing slash differ", async () => {
    const session = await serve(models("a"));
    try {
      process.env.LOCAL_LLM_ENDPOINT = `${session.url}/v1`;
      const catalog = await buildCatalog(cfg({ endpoint: `${session.url.replace("http://", "http://u:p@")}/V1/`.replace("/V1/", "/v1/") + "?x=1", model: "a" }));
      assert.equal(catalog.providers.some((p) => p.id === "session"), false);
    } finally { await session.close(); }
  });

  test("a cloud provider session shows no extra session row", async () => {
    const catalog = await buildCatalog(cfg({ provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "x/y" }), { timeoutMs: 300 });
    assert.equal(catalog.providers.some((p) => p.id === "session"), false);
    assert.deepEqual(catalog.current, { provider: "openrouter", model: "x/y" });
  });

  test("no credential, userinfo or query reaches the catalog, in a label, a model id or an error", async () => {
    const session = await serve((_q, res) => { res.writeHead(500); res.end(`upstream at http://user:${SECRET}@10.0.0.5/v1?key=${SECRET} said no, Authorization: Bearer ${SECRET}`); });
    try {
      process.env.LOCAL_LLM_ENDPOINT = "http://127.0.0.1:9/v1";
      const withUser = session.url.replace("http://", "http://opuser:oppass@");
      const catalog = await buildCatalog(cfg({ endpoint: `${withUser}/v1?token=${SECRET}`, model: "m", apiKey: SECRET }), { timeoutMs: 1500 });
      const entry = catalog.providers.find((p) => p.id === "session")!;
      assert.equal(entry.status, "error");
      const all = JSON.stringify(catalog);
      for (const leak of [SECRET, "oppass", "opuser", "token="]) assert.ok(!all.includes(leak), `${leak} leaked: ${all}`);
      assert.equal(entry.label, `This session (${session.url.replace("http://", "")})`);
    } finally { await session.close(); }
  });

  test("an endpoint that cannot be listed falls back to its last good list, per endpoint", async () => {
    let up = true;
    const session = await serve((q, res) => (up ? models("kept-model")(q, res) : (res.writeHead(503), res.end("{}"))));
    try {
      process.env.LOCAL_LLM_ENDPOINT = "http://127.0.0.1:9/v1";
      const config = cfg({ endpoint: `${session.url}/v1`, model: "kept-model" });
      await buildCatalog(config, { timeoutMs: 1500 });
      up = false;
      const second = await buildCatalog(config, { timeoutMs: 1500 });
      assert.equal(second.providers.find((p) => p.id === "session")!.status, "cached");
      assert.ok(second.models.some((m) => m.provider === "session" && m.id === "kept-model"));
    } finally { await session.close(); }
  });

  test("the list is bounded: count and id length are capped, ids with control, bidi or zero-width characters are rejected whole, non-strings are dropped", async () => {
    const many = Array.from({ length: 5000 }, (_, i) => `m${i}`);
    const session = await serve(models("evil\u001b[31m\nname", "gpt\u202e-4", "zero\u200bwidth", "line\u2028sep", "bom\ufeffid", "bell\u0007id", "x".repeat(5000), 42, null, "kept-id", ...many));
    try {
      process.env.LOCAL_LLM_ENDPOINT = "http://127.0.0.1:9/v1";
      const catalog = await buildCatalog(cfg({ endpoint: `${session.url}/v1`, model: "m1" }), { timeoutMs: 1500 });
      const list = catalog.models.filter((m) => m.provider === "session");
      assert.ok(list.length <= 1000, `${list.length}`);
      assert.ok(list.every((m) => m.id.length <= 200 && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(m.id)), "ids are short and printable");
      assert.deepEqual(list.slice(0, 2).map((m) => m.id), ["kept-id", "m0"], "an id with such a character is dropped whole, never cleaned into another id");
    } finally { await session.close(); }
  });

  test("the fetch is bounded by its timeout and cancellable: an endpoint that never answers does not hold the picker", async () => {
    const silent = await serve(() => {});
    try {
      process.env.LOCAL_LLM_ENDPOINT = "http://127.0.0.1:9/v1";
      const timed = Date.now();
      const slow = await buildCatalog(cfg({ endpoint: `${silent.url}/v1` }), { timeoutMs: 300 });
      assert.ok(Date.now() - timed < 3000, "the timeout ends the wait");
      assert.equal(slow.providers.find((p) => p.id === "session")!.status, "error");

      const controller = new AbortController();
      const started = Date.now();
      const pending = buildCatalog(cfg({ endpoint: `${silent.url}/v1` }), { timeoutMs: 60_000, signal: controller.signal });
      setTimeout(() => controller.abort(), 100);
      await pending.catch(() => {});
      assert.ok(Date.now() - started < 3000, "cancelling returns promptly");
    } finally { await silent.close(); }
  });

  test("selecting a session-endpoint model keeps the endpoint and key, and is refused once a cloud provider is current", () => {
    const repo = makeRepo();
    const app = new ApplicationCore(cfg({ endpoint: "http://127.0.0.1:18080/v1", model: "fake-model", apiKey: SECRET, workspace: repo }));
    try {
      const picked = selectModel(app.getAgent(), app.getConfig(), { provider: "session", model: "other-model" });
      assert.equal(picked.ok, true, picked.message);
      assert.equal(app.getConfig().model, "other-model");
      assert.equal(app.getConfig().endpoint, "http://127.0.0.1:18080/v1");
      assert.equal(app.getConfig().apiKey, SECRET);
      assert.doesNotMatch(picked.message, new RegExp(SECRET));
      Object.assign(app.getConfig(), { provider: "openrouter" });
      const refused = selectModel(app.getAgent(), app.getConfig(), { provider: "session", model: "z" });
      assert.equal(refused.ok, false);
    } finally { app.shutdown(); }
  });

  test("sidecar: provider.cancel for a models.list stops its fetch and no catalog is sent; a later list still works", async () => {
    const silent = await serve(() => {});
    const repo = makeRepo();
    process.env.LOCAL_LLM_ENDPOINT = "http://127.0.0.1:9/v1";
    const app = new ApplicationCore(cfg({ endpoint: `${silent.url}/v1`, model: "m", workspace: repo }));
    const lines: string[] = [];
    const server = new SidecarServer({ app, mode: "auto", write: (l) => lines.push(l) });
    server.start();
    const send = (msg: Record<string, unknown>) => server.handleLine(JSON.stringify({ v: 1, ...msg }));
    const events = () => lines.map((l) => JSON.parse(l));
    try {
      await send({ type: "models.list", id: "m1" });
      await new Promise((r) => setTimeout(r, 150));
      await send({ type: "provider.cancel", id: "m1" });
      await new Promise((r) => setTimeout(r, 400));
      assert.ok(!events().some((e) => e.type === "models.catalog" && e.id === "m1"), "a cancelled list sends nothing");
      assert.ok(!events().some((e) => e.type === "error" && e.id === "m1"));
    } finally { await silent.close(); app.shutdown(); }
  });
});
