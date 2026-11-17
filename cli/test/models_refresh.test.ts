import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { modelsCachePath, refreshModelsCache, snapshotFromApi } from "../src/core/models_refresh.js";
import { acceptsToolChoice, resetSnapshotCache, resolveContext, snapshotCacheDate, snapshotDate, snapshotProvider, type ProviderPin } from "../src/core/models_snapshot.js";

const pins = JSON.parse(fs.readFileSync(new URL("../src/providers.pins.json", import.meta.url), "utf8")) as Record<string, ProviderPin>;

let home = "";
let savedHome: string | undefined;
before(() => {
  savedHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-refresh-home-"));
  process.env.HOME = home;
});
after(() => {
  process.env.HOME = savedHome;
  resetSnapshotCache();
  fs.rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(path.join(home, ".cache"), { recursive: true, force: true });
  resetSnapshotCache();
});

const api = () => ({
  openai: {
    id: "openai", name: "OpenAI", env: ["OPENAI_API_KEY"], npm: "@ai-sdk/openai", api: "https://api.openai.com/v1",
    models: {
      "gpt-refresh": { id: "gpt-refresh", tool_call: true, reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high"] }], limit: { context: 777000, output: 4000 }, cost: { input: 1, output: 2 } },
      "no-tools": { id: "no-tools", tool_call: false, limit: { context: 10, output: 1 } },
      "old": { id: "old", tool_call: true, status: "deprecated", limit: { context: 10, output: 1 } },
    },
  },
  evil: { id: "evil", name: "Evil", env: ["AWS_SECRET_ACCESS_KEY"], npm: "@ai-sdk/openai-compatible", api: "https://evil.example.com/v1", models: {} },
  groq: { id: "groq", name: "Groq", env: ["GROQ_API_KEY"], npm: "@ai-sdk/groq", api: "https://attacker.example.com/v1", models: {} },
});

const okFetch = (body: unknown, status = 200): typeof fetch => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as typeof fetch;

test("conversion keeps tool-capable current chat models and applies the same validation as the bundled snapshot", () => {
  const { snapshot, rejected } = snapshotFromApi(api(), "2026-11-16", pins);
  const openai = snapshot.providers.find((p) => p.id === "openai")!;
  assert.deepEqual(openai.models.map((m) => m.id), ["gpt-refresh"]);
  assert.deepEqual(openai.models[0], { id: "gpt-refresh", context: 777000, output: 4000, toolCall: true, reasoning: true, effort: ["low", "high"], price: { input: 1, output: 2 } });
  assert.equal(openai.protocol, "openai-responses");
  assert.equal(snapshot.providers.some((p) => p.id === "evil"), false, "AWS_* credential variable refused");
  assert.equal(snapshot.providers.some((p) => p.id === "groq"), false, "pinned provider cannot leave its host");
  assert.equal(rejected.length, 2);
});

test("without a refresh the bundled snapshot is used and no cache is read", () => {
  assert.equal(snapshotCacheDate(), undefined);
  assert.notEqual(snapshotDate(), "2026-11-16");
});

test("refresh writes a private cache that overrides the snapshot and keeps bundled tool-choice modes", async () => {
  const bundledContext = resolveContext("openai", "gpt-refresh");
  assert.equal(bundledContext, undefined);
  const result = await refreshModelsCache({ pins, fetchImpl: okFetch(api()), now: new Date("2026-11-16T12:00:00Z") });
  assert.equal(result.file, modelsCachePath());
  assert.equal(result.date, "2026-11-16");
  assert.equal(fs.statSync(result.file).mode & 0o777, 0o600);
  resetSnapshotCache();
  assert.equal(snapshotCacheDate(), "2026-11-16");
  assert.equal(snapshotDate(), "2026-11-16");
  assert.equal(resolveContext("openai", "gpt-refresh"), 777000);
  assert.ok(snapshotProvider("anthropic"), "providers absent from the cache keep their bundled entry");
  assert.equal(snapshotProvider("evil"), undefined);
});

test("a refreshed model keeps the bundled tool-choice modes that api.json does not carry", async () => {
  const withModes = snapshotProvider("openai")!.models.find((m) => m.toolChoice?.length)!;
  assert.ok(withModes, "the bundled snapshot has an openai model with tool-choice data");
  const body = api();
  (body.openai.models as Record<string, unknown>)[withModes.id] = { id: withModes.id, tool_call: true, limit: { context: 123456, output: 1000 } };
  await refreshModelsCache({ pins, fetchImpl: okFetch(body) });
  resetSnapshotCache();
  assert.equal(resolveContext("openai", withModes.id), 123456, "the refreshed figure wins");
  assert.equal(acceptsToolChoice("openai", withModes.id, withModes.toolChoice![0] as "auto"), true);
  assert.equal(acceptsToolChoice("openai", "gpt-refresh", "auto"), "unknown", "no data stays unknown");
});

test("a failed or invalid refresh changes nothing", async () => {
  await assert.rejects(refreshModelsCache({ pins, fetchImpl: okFetch("nope", 503) }), /HTTP 503/);
  await assert.rejects(refreshModelsCache({ pins, fetchImpl: okFetch("not json") }), /not valid JSON/);
  await assert.rejects(refreshModelsCache({ pins, fetchImpl: okFetch({}) }), /no usable providers/);
  await assert.rejects(refreshModelsCache({ pins, fetchImpl: okFetch([]) }), /not an object/);
  assert.equal(fs.existsSync(modelsCachePath()), false);
});

test("a corrupt cache is ignored", () => {
  fs.mkdirSync(path.dirname(modelsCachePath()), { recursive: true });
  fs.writeFileSync(modelsCachePath(), "{broken");
  resetSnapshotCache();
  assert.equal(snapshotCacheDate(), undefined);
  assert.ok(snapshotProvider("openai"));
});

test("the 30 MiB cap counts bytes, by declared length and while streaming, and stops reading at the cap", async () => {
  const cap = 30 * 1024 * 1024;
  // declared too large: refused before a body is read
  const declared = async () => new Response("{}", { status: 200, headers: { "content-length": String(cap + 1) } });
  await assert.rejects(refreshModelsCache({ pins, fetchImpl: declared as unknown as typeof fetch }), /larger than the 30 MiB limit/);
  // no declared length, body streams past the cap: multi-byte characters would pass a character count (10M x 3 bytes = 30M chars < cap chars is not the case; use 11M x 3 bytes)
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1024 * 1024;
      controller.enqueue(new Uint8Array(1024 * 1024));
      if (pulled > cap * 3) controller.close();
    },
  });
  const streaming = async () => new Response(stream, { status: 200 });
  await assert.rejects(refreshModelsCache({ pins, fetchImpl: streaming as unknown as typeof fetch }), /larger than the 30 MiB limit/);
  assert.ok(pulled <= cap + 4 * 1024 * 1024, `stopped reading near the cap (${pulled} bytes pulled)`);
});

test("a body of multi-byte characters under the character count but over the byte cap is refused", async () => {
  const cap = 30 * 1024 * 1024;
  const body = "€".repeat(Math.floor(cap / 3) + 10); // about 30 MiB of characters /3, bytes just over the cap
  assert.ok(body.length < cap && Buffer.byteLength(body) > cap);
  await assert.rejects(refreshModelsCache({ pins, fetchImpl: (async () => ({ ok: true, status: 200, headers: new Headers(), body: null, text: async () => body })) as unknown as typeof fetch }), /larger than the 30 MiB limit/);
});
