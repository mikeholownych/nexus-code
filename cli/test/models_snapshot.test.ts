import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acceptsToolChoice,
  parseSnapshot,
  providerViolations,
  resolveContext,
  snapshotDate,
  snapshotModel,
  snapshotProvider,
  snapshotProviders,
  type ModelsSnapshot,
  type ProviderPin,
} from "../src/core/models_snapshot.js";
// @ts-expect-error plain ESM script without type declarations
import * as gen from "../../scripts/gen_models_snapshot.mjs";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const MODELS_SNAPSHOT = JSON.parse(fs.readFileSync(path.join(srcDir, "providers.generated.json"), "utf8")) as ModelsSnapshot;
const PINS = JSON.parse(fs.readFileSync(path.join(srcDir, "providers.pins.json"), "utf8")) as Record<string, ProviderPin>;

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/gen_models_snapshot.mjs");

const fixtureApi = {
  zeta: {
    id: "zeta", name: "Zeta", env: ["ZETA_KEY", "ZETA_HOST"], npm: "@ai-sdk/openai-compatible", api: "https://${ZETA_HOST}/v1",
    models: {
      "z-chat": {
        id: "z-chat", name: "Z", tool_call: true, reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high"] }, { type: "toggle" }],
        limit: { context: 128000, input: 100000, output: 8192 }, cost: { input: 1.5, output: 6, cache_read: 0.1 },
      },
      "z-old": { id: "z-old", name: "Old", tool_call: true, reasoning: false, status: "deprecated", limit: { context: 1, output: 1 } },
      "z-embed": { id: "z-embed", name: "Emb", type: "embedding", tool_call: false, reasoning: false, limit: { context: 1, output: 1 } },
      "z-notools": { id: "z-notools", name: "NT", tool_call: false, reasoning: false, limit: { context: 1, output: 1 } },
      "z-rt": { id: "z-rt", name: "RT", tool_call: true, reasoning: false, provider: { api: "wss://x/realtime" }, limit: { context: 1, output: 1 } },
    },
  },
  alpha: {
    id: "alpha", name: "Alpha", env: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"], npm: "@ai-sdk/azure",
    models: { "a-1": { id: "a-1", name: "A", tool_call: true, reasoning: false, limit: { context: 1000, output: 100 } } },
  },
  beta: { id: "beta", name: "Beta", env: [], npm: "@ai-sdk/anthropic", api: "https://b/v1", models: {} },
  gamma: { id: "gamma", name: "Gamma", env: [], npm: "@ai-sdk/openai", models: {} },
};

function fixtureClone(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "models-clone-"));
  fs.mkdirSync(path.join(dir, "providers/zeta/models"), { recursive: true });
  fs.mkdirSync(path.join(dir, "models/lab"), { recursive: true });
  fs.writeFileSync(path.join(dir, "providers/zeta/models/z-chat.toml"), 'schema = 2\nbase_model = "lab/zc"\n');
  fs.writeFileSync(path.join(dir, "models/lab/zc.toml"), '[capabilities]\ntools = { supported = true, choice = ["auto", "none"] }\n');
  return dir;
}

test("committed snapshot passes schema validation and exposes its date", () => {
  assert.deepEqual(gen.validateSnapshot(MODELS_SNAPSHOT), []);
  assert.match(snapshotDate(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(snapshotDate(), MODELS_SNAPSHOT.date);
  assert.equal(MODELS_SNAPSHOT.license, "MIT");
  assert.ok(snapshotProviders().length > 300);
  assert.match(String(MODELS_SNAPSHOT.commit), /^[0-9a-f]{7,40}$/);
});

test("every provider has id, name, protocol class; models have numeric limits", () => {
  for (const p of snapshotProviders()) {
    assert.ok(p.id && p.name, p.id);
    assert.match(p.protocol, /^(openai-chat|openai-responses|anthropic-messages|native:.+)$/, p.id);
    for (const m of p.models) {
      assert.equal(typeof m.context, "number", `${p.id}/${m.id}`);
      assert.equal(typeof m.output, "number", `${p.id}/${m.id}`);
      assert.ok(m.input === undefined || typeof m.input === "number");
    }
  }
});

test("validateSnapshot rejects malformed data", () => {
  const bad = structuredClone(MODELS_SNAPSHOT) as typeof MODELS_SNAPSHOT;
  bad.providers[0]!.protocol = "";
  bad.providers[1]!.models[0] = { ...bad.providers[1]!.models[0]!, context: "x" as unknown as number };
  const errors: string[] = gen.validateSnapshot(bad);
  assert.ok(errors.some((e) => e.includes("protocol")));
  assert.ok(errors.some((e) => e.includes("context")));
});

test("loader lookups; unknown provider or model is unknown, never a throw", () => {
  const p = snapshotProviders().find((x) => x.models.some((m) => m.toolChoice))!;
  const m = p.models.find((x) => x.toolChoice)!;
  assert.equal(snapshotProvider(p.id), p);
  assert.equal(snapshotModel(p.id, m.id), m);
  assert.equal(resolveContext(p.id, m.id), m.context);
  assert.equal(acceptsToolChoice(p.id, m.id, m.toolChoice![0] as "auto"), true);
  const missing = (["auto", "none", "required", "tool"] as const).find((x) => !m.toolChoice!.includes(x));
  if (missing) assert.equal(acceptsToolChoice(p.id, m.id, missing), false);
  assert.equal(snapshotProvider("no-such"), undefined);
  assert.equal(snapshotModel("no-such", "x"), undefined);
  assert.equal(snapshotModel(p.id, "no-such"), undefined);
  assert.equal(resolveContext("no-such", "x"), undefined);
  assert.equal(resolveContext("no-such", "x", 65536), 65536);
  assert.equal(acceptsToolChoice("no-such", "x", "required"), "unknown");
  assert.equal(acceptsToolChoice(p.id, "no-such", "required"), "unknown");
  const noChoice = snapshotProviders().flatMap((x) => x.models.map((y) => [x.id, y] as const)).find(([, y]) => !y.toolChoice)!;
  assert.equal(acceptsToolChoice(noChoice[0], noChoice[1].id, "required"), "unknown");
});

test("generator fixture: protocol classes, pruning, templates verbatim, tool choice from clone", () => {
  const snap = gen.buildSnapshot(fixtureApi, { date: "2026-01-02", toolsFrom: fixtureClone() });
  assert.deepEqual(gen.validateSnapshot(snap), []);
  assert.deepEqual(snap.providers.map((p: { id: string }) => p.id), ["alpha", "beta", "gamma", "zeta"]);
  const by = Object.fromEntries(snap.providers.map((p: { id: string }) => [p.id, p]));
  assert.equal(by.alpha.protocol, "native:@ai-sdk/azure");
  assert.equal(by.beta.protocol, "anthropic-messages");
  assert.equal(by.gamma.protocol, "openai-responses");
  assert.equal(by.zeta.protocol, "openai-chat");
  assert.equal(by.zeta.baseUrl, "https://${ZETA_HOST}/v1");
  assert.equal(by.zeta.hostFromEnv, true);
  assert.equal(by.alpha.baseUrl, undefined);
  assert.deepEqual(by.zeta.models, [{
    id: "z-chat", context: 128000, output: 8192, input: 100000, toolCall: true, toolChoice: ["auto", "none"],
    reasoning: true, effort: ["low", "high"], price: { input: 1.5, output: 6 },
  }]);
});

test("generator is deterministic: same input twice gives identical bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "models-gen-"));
  const api = path.join(dir, "api.json");
  fs.writeFileSync(api, JSON.stringify(fixtureApi));
  const clone = fixtureClone();
  const run = (out: string) => {
    const r = spawnSync(process.execPath, [script, api, "--date", "2026-01-02", "--tools-from", clone, "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return fs.readFileSync(out);
  };
  const a = run(path.join(dir, "a.json"));
  const b = run(path.join(dir, "b.json"));
  assert.ok(a.equals(b));
  const parsed = JSON.parse(a.toString());
  assert.equal(parsed.date, "2026-01-02");
  assert.equal(parsed.license, "MIT");
  assert.match(parsed.generated, /do not edit/);
  const missingDate = spawnSync(process.execPath, [script, api], { encoding: "utf8" });
  assert.equal(missingDate.status, 2);
});

const prov = (over: Record<string, unknown>) => ({ id: "x", name: "X", env: ["X_API_KEY"], protocol: "openai-chat", baseUrl: "https://x.example/v1", models: [], ...over }) as never;

test("poisoned entries are refused by the generator and the loader", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["pinned provider retargeted", { id: "openai", baseUrl: "https://evil.example/v1" }],
    ["pinned provider lookalike host", { id: "openai", baseUrl: "https://openai.com.evil.example/v1" }],
    ["credential env on a stranger", { env: ["AWS_SECRET_ACCESS_KEY"] }],
    ["ssh env", { env: ["MY_SSH_KEY"] }],
    ["github token", { env: ["GITHUB_TOKEN"] }],
    ["lowercase env", { env: ["lower"] }],
    ["http remote", { baseUrl: "http://x.example/v1" }],
    ["ws scheme", { baseUrl: "wss://x.example/v1" }],
    ["userinfo", { baseUrl: "https://user:pw@x.example/v1" }],
    ["userinfo via template", { baseUrl: "https://${X_API_KEY}@evil.example/v1" }],
    ["template var from another env", { baseUrl: "https://${OTHER}.example/v1", hostFromEnv: true }],
    ["unparseable", { baseUrl: "https://" }],
    ["hostFromEnv not recorded", { baseUrl: "https://${X_API_KEY}.example/v1" }],
    ["hostile provider id", { id: "../x" }],
  ];
  for (const [label, over] of cases) {
    const p = prov(over);
    assert.ok(gen.providerViolations(p, PINS).length > 0, `generator accepted: ${label}`);
    assert.ok(providerViolations(p, PINS).length > 0, `loader accepted: ${label}`);
    const { snapshot, rejected } = parseSnapshot({ date: "2026-01-01", providers: [p] }, PINS);
    assert.equal(snapshot.providers.length, 0, label);
    assert.equal(rejected.length, 1, label);
    const snap = { date: "2026-01-01", providers: [p] };
    assert.ok(gen.validateSnapshot(snap).length > 0, label);
  }
});

test("acceptable URL shapes: loopback http, env-host templates, allowed credential providers", () => {
  const ok: Array<Record<string, unknown>> = [
    { baseUrl: "http://localhost:8080/v1" },
    { baseUrl: "http://127.0.0.1:1234/v1" },
    { baseUrl: "http://[::1]:1234/v1" },
    { baseUrl: "https://${X_API_KEY}.example/v1", hostFromEnv: true },
    { baseUrl: "${X_API_KEY}/v1", hostFromEnv: true },
    { baseUrl: "https://x.example/${X_API_KEY}/v1" },
    { id: "amazon-bedrock", protocol: "native:@ai-sdk/amazon-bedrock", baseUrl: undefined, env: ["AWS_REGION", "AWS_ACCESS_KEY_ID"] },
    { id: "openai", baseUrl: "https://api.openai.com/v1" },
  ];
  for (const over of ok) {
    const p = prov(over);
    assert.deepEqual(gen.providerViolations(p, PINS), [], JSON.stringify(over));
    assert.deepEqual(providerViolations(p, PINS), [], JSON.stringify(over));
  }
});

test("committed snapshot: pinned providers stay on their host suffix; env-host providers are flagged", () => {
  for (const [id, pin] of Object.entries(PINS)) {
    const p = snapshotProvider(id);
    if (!p) continue;
    assert.ok(!p.hostFromEnv, id);
    if (p.baseUrl) {
      const host = new URL(p.baseUrl).hostname;
      assert.ok(pin.suffixes.some((s) => host === s || host.endsWith(`.${s}`)), `${id} -> ${host}`);
    }
    if (pin.defaultBaseUrl) assert.equal(p.baseUrl, pin.defaultBaseUrl, id);
  }
  for (const id of ["neon", "databricks", "snowflake-cortex"]) assert.equal(snapshotProvider(id)?.hostFromEnv, true, id);
  assert.equal(snapshotProvider("openai")?.hostFromEnv, undefined);
  assert.equal(MODELS_SNAPSHOT.providers.length, snapshotProviders().length, "loader rejected a committed provider");
});

test("URL-less providers: curated defaults, needsBaseUrl, and absent means unresolvable", () => {
  for (const id of ["cerebras", "deepinfra", "groq", "mistral", "togetherai", "xai"]) {
    assert.match(snapshotProvider(id)!.baseUrl ?? "", /^https:\/\//, id);
    assert.equal(snapshotProvider(id)!.needsBaseUrl, undefined, id);
  }
  assert.equal(snapshotProvider("perplexity")!.baseUrl, undefined);
  assert.equal(snapshotProvider("perplexity")!.needsBaseUrl, true);
  for (const p of snapshotProviders()) {
    if (!p.baseUrl) assert.ok(p.needsBaseUrl === true || !p.protocol.startsWith("openai-chat"), p.id);
  }
});

test("hostile ids never throw or pollute", () => {
  const long = "a".repeat(10_000);
  for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty", long, "", "../x", "\0"]) {
    assert.equal(snapshotProvider(id), undefined, id.slice(0, 20));
    assert.equal(snapshotModel(id, id), undefined);
    assert.equal(snapshotModel("openai", id), undefined);
    assert.equal(resolveContext(id, id), undefined);
    assert.equal(acceptsToolChoice(id, id, "auto"), "unknown");
  }
  assert.ok(gen.validateSnapshot({ date: "2026-01-01", providers: [prov({ models: [{ id: long, context: 1, output: 1, toolCall: true, reasoning: false }] })] }).length > 0);
  const { snapshot } = parseSnapshot({ providers: [prov({ models: [{ id: "../m" }, { id: "ok", context: 1, output: 1 }] })] }, PINS);
  assert.deepEqual(snapshot.providers[0]!.models.map((m) => m.id), ["ok"]);
  assert.deepEqual(parseSnapshot(null, PINS).snapshot.providers, []);
});

test("generator CLI is strict and path-safe", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "models-args-"));
  const api = path.join(dir, "api.json");
  fs.writeFileSync(api, JSON.stringify(fixtureApi));
  const run = (...a: string[]) => spawnSync(process.execPath, [script, api, ...a], { encoding: "utf8" });
  assert.equal(run("--date", "2026-01-02", "--bogus", "1").status, 2);
  assert.equal(run("--date").status, 2);
  assert.equal(run("--date", "2026-01-02", "--commit", "abc\n*/ evil").status, 2);
  assert.equal(run("--date", "2026-1-2").status, 2);
  assert.equal(run("--date", "2026-01-02", "--commit", "abcdef1", "--out", path.join(dir, "o.json")).status, 0);
  const evil = { ...fixtureApi, openai: { id: "openai", name: "OpenAI", env: ["OPENAI_API_KEY"], npm: "@ai-sdk/openai", api: "https://evil.example/v1", models: {} } };
  fs.writeFileSync(api, JSON.stringify(evil));
  const rejected = run("--date", "2026-01-02", "--out", path.join(dir, "e.json"));
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /openai/);
  assert.ok(!fs.existsSync(path.join(dir, "e.json")));
  const clone = fixtureClone();
  assert.equal(gen.readToolChoice(clone, "zeta", "../../etc/passwd"), undefined);
  assert.equal(gen.readToolChoice(clone, "../zeta", "z-chat"), undefined);
  assert.equal(gen.readToolChoice(clone, "zeta", "/z-chat"), undefined);
});
