import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { LocalLlmClient } from "../src/client.js";
import { parseProvidersDocument, readProvidersFile } from "../src/provider_file.js";
import { allProviders, baseUrlSetting, providerDefinition, setOperatorProviders } from "../src/providers.js";
import type { HarnessConfig } from "../src/types.js";

afterEach(() => setOperatorProviders([]));

const azure = (over: Record<string, unknown> = {}) => ({
  providers: {
    "azure-openai": {
      label: "Azure OpenAI",
      baseUrl: "https://{resource}.openai.azure.com/openai/deployments/{deployment}",
      variables: { resource: "acme", deployment: "gpt-4o" },
      query: { "api-version": "2024-10-21" },
      auth: "header",
      authHeader: "api-key",
      credentialEnv: "AZURE_OPENAI_API_KEY",
      ...over,
    },
  },
});

test("a valid file defines a provider with expanded URL, query, header auth and a safe settings name", () => {
  const [def] = parseProvidersDocument(azure());
  assert.equal(def.baseUrl, "https://acme.openai.azure.com/openai/deployments/gpt-4o");
  assert.deepEqual(def.query, { "api-version": "2024-10-21" });
  assert.equal(def.auth, "header");
  assert.equal(def.authHeader, "api-key");
  assert.equal(baseUrlSetting("azure-openai"), "NEXUS_AZURE_OPENAI_BASE_URL");
});

test("schema errors name the field", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ protocol: "grpc" }, /providers\.azure-openai\.protocol: must be one of/],
    [{ baseUrl: "http://evil.example.com/v1", variables: {} }, /providers\.azure-openai\.baseUrl: http is allowed only for local/],
    [{ baseUrl: "https://{region}.example.com" }, /providers\.azure-openai\.baseUrl: variable \{region\} has no value/],
    [{ variables: { resource: "evil.com/x", deployment: "d" } }, /\{resource\}/],
    [{ authHeader: undefined }, /providers\.azure-openai\.authHeader: required when auth is "header"/],
    [{ authHeader: "Authorization" }, /authHeader: use auth "bearer"/],
    [{ credentialEnv: "lower" }, /providers\.azure-openai\.credentialEnv/],
    [{ headers: { Host: "x" } }, /providers\.azure-openai\.headers\.Host/],
    [{ query: { v: "a b" } }, /providers\.azure-openai\.query\.v/],
    [{ surprise: 1 }, /providers\.azure-openai\.surprise: unknown field/],
    [{ label: "" }, /providers\.azure-openai\.label/],
  ];
  for (const [over, re] of cases) assert.throws(() => parseProvidersDocument(azure(over)), re);
  assert.throws(() => parseProvidersDocument({ providers: { Bad_Id: { label: "x" } } }), /providers\.Bad_Id/);
  assert.throws(() => parseProvidersDocument({ extra: 1, providers: {} }), /unknown field "extra"/);
});

test("built-in ids cannot be redefined; operator providers join the registry", () => {
  const defs = parseProvidersDocument(azure());
  setOperatorProviders(defs);
  assert.equal(providerDefinition("azure-openai")?.label, "Azure OpenAI");
  assert.ok(allProviders().some((d) => d.id === "azure-openai"));
  assert.equal(providerDefinition("constructor"), undefined);
  const clash = parseProvidersDocument({ providers: { openai: azure().providers["azure-openai"] } });
  assert.throws(() => setOperatorProviders(clash), /built-in provider id cannot be redefined/);
});

test("a missing file declares no providers; malformed JSON is an error naming the file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-providers-"));
  assert.deepEqual(readProvidersFile(path.join(dir, "providers.json")), []);
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{nope");
  assert.throws(() => readProvidersFile(bad), /bad\.json is not valid JSON/);
});

test("Azure OpenAI against a mock: deployment path, api-version query, api-key header, no Authorization", async () => {
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ url: req.url!, headers: req.headers });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "c1", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const [def] = parseProvidersDocument(azure({ baseUrl: `http://127.0.0.1:${port}/openai/deployments/{deployment}`, variables: { deployment: "gpt-4o" } }));
    setOperatorProviders([def]);
    const config = { provider: "azure-openai", endpoint: def.baseUrl, model: "gpt-4o", apiKey: "azure-key-0001", maxSteps: 2, temperature: 0.2, workspace: os.tmpdir(), shell: "bash" } as HarnessConfig;
    await new LocalLlmClient(config).chatCompletion([{ role: "user", content: "hi" }], []);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21");
    assert.equal(seen[0].headers["api-key"], "azure-key-0001");
    assert.equal(seen[0].headers.authorization, undefined);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
