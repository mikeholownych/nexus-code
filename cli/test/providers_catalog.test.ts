import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { allProviders, providerDefinition, providerSource, setOperatorProviders } from "../src/providers.js";
import { snapshotProvider, type ProviderPin } from "../src/core/models_snapshot.js";

const pins = JSON.parse(fs.readFileSync(new URL("../src/providers.pins.json", import.meta.url), "utf8")) as Record<string, ProviderPin>;
const catalog = () => allProviders().filter((d) => providerSource(d.id) === "catalog");

test("the shipped catalog covers the OpenAI-compatible long tail, all key-authenticated", () => {
  assert.deepEqual(catalog().map((d) => d.id), ["mistral", "groq", "togetherai", "deepseek", "xai", "fireworks-ai", "cerebras", "perplexity", "gemini", "cloudflare-workers-ai", "azure-openai", "bedrock-openai"]);
  for (const d of catalog()) {
    assert.equal(d.protocol, "openai-chat", d.id);
    assert.ok(d.credentialEnv, `${d.id} names its key variable`);
    assert.notEqual(d.auth, "oauth");
  }
});

test("catalog entries agree with the models.dev snapshot where it has the provider (base URL and key variable)", () => {
  for (const d of catalog()) {
    const snap = snapshotProvider(d.id);
    if (!snap || !snap.baseUrl || snap.hostFromEnv || snap.baseUrl.includes("${")) continue; // templated URLs are the operator's to fill
    assert.equal(d.baseUrl, snap.baseUrl.replace(/\/+$/, ""), `${d.id} base URL`);
    assert.ok(snap.env.includes(d.credentialEnv!), `${d.id} key variable ${d.credentialEnv} is among the snapshot's ${snap.env.join(", ")}`);
  }
});

test("pinned providers stay on their pinned host suffixes", () => {
  for (const d of catalog()) {
    const pin = Object.hasOwn(pins, d.id) ? pins[d.id] : undefined;
    if (!pin || !d.baseUrl) continue;
    const host = new URL(d.baseUrl).hostname;
    assert.ok(pin.suffixes.some((s) => host === s || host.endsWith(`.${s}`)), `${d.id} (${host}) leaves its pinned hosts`);
  }
});

test("account- or region-specific providers carry no URL: the operator supplies it", () => {
  for (const id of ["cloudflare-workers-ai", "azure-openai", "bedrock-openai"]) assert.equal(providerDefinition(id)?.baseUrl, undefined, id);
  assert.equal(providerDefinition("azure-openai")?.authHeader, "api-key");
  assert.deepEqual(providerDefinition("azure-openai")?.query, { "api-version": "2024-10-21" });
});

test("an operator definition of a catalog id replaces it; the catalog still never replaces a built-in", () => {
  assert.equal(providerSource("groq"), "catalog");
  setOperatorProviders([{ id: "groq", label: "My Groq", protocol: "openai-chat", auth: "bearer", credentialEnv: "MY_GROQ_KEY", usage: "stream-options", methods: [] }]);
  try {
    assert.equal(providerSource("groq"), "providers.json");
    assert.equal(allProviders().filter((d) => d.id === "groq").length, 1);
    assert.equal(providerDefinition("groq")?.label, "My Groq");
  } finally {
    setOperatorProviders([]);
  }
  assert.equal(providerSource("openai"), "built-in");
});
