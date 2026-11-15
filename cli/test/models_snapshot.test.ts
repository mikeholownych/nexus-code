import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODELS_SNAPSHOT } from "../src/providers.generated.js";
import {
  acceptsToolChoice,
  resolveContext,
  snapshotDate,
  snapshotModel,
  snapshotProvider,
  snapshotProviders,
} from "../src/core/models_snapshot.js";
// @ts-expect-error plain ESM script without type declarations
import * as gen from "../../scripts/gen_models_snapshot.mjs";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/gen_models_snapshot.mjs");

const fixtureApi = {
  zeta: {
    id: "zeta", name: "Zeta", env: ["ZETA_KEY"], npm: "@ai-sdk/openai-compatible", api: "https://${ZETA_HOST}/v1",
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
  const p = MODELS_SNAPSHOT.providers.find((x) => x.models.some((m) => m.toolChoice))!;
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
  const noChoice = MODELS_SNAPSHOT.providers.flatMap((x) => x.models.map((y) => [x.id, y] as const)).find(([, y]) => !y.toolChoice)!;
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
  const a = run(path.join(dir, "a.ts"));
  const b = run(path.join(dir, "b.ts"));
  assert.ok(a.equals(b));
  assert.match(a.toString(), /Snapshot date: 2026-01-02/);
  assert.match(a.toString(), /MIT licence/);
  const missingDate = spawnSync(process.execPath, [script, api], { encoding: "utf8" });
  assert.equal(missingDate.status, 2);
});
