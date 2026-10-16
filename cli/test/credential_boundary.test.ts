/**
 * Provider credential boundary: a credential is sent only to the provider origin it belongs to. The stored gateway
 * token never reaches another provider, whether that provider is the configured endpoint, a failover endpoint, a
 * planner/coder endpoint, or the target of a 401 reload.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutonomousAgent } from "../src/agent.js";
import { buildConfig } from "../src/config.js";
import { LocalLlmClient } from "../src/client.js";
import type { HarnessConfig } from "../src/types.js";
import { startGateway, type Reply } from "./helpers/provider_fixture.js";

const TOKEN = "tok-AIHOST-secret-0001";
const FOREIGN_KEY = "k-FOREIGN-secret-0002";
const ok: Reply = { kind: "http", status: 200, body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }) };
const unauthorized: Reply = { kind: "http", status: 401, body: '{"error":{"message":"invalid api key"}}' };

/** HOME configured like a real install: config.env names the gateway, the token file holds its credential. */
async function withStoredCredential<T>(gatewayUrl: string, fn: () => Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cred-home-"));
  const keys = ["HOME", "LOCAL_LLM_ENDPOINT", "LOCAL_LLM_API_KEY", "LOCAL_LLM_CREDENTIAL_ORIGINS"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, ".config/nexus"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/nexus/config.env"), `LOCAL_LLM_ENDPOINT=${gatewayUrl}\nLOCAL_LLM_MODEL=engineering/lead\n`);
  fs.writeFileSync(path.join(home, ".config/nexus/gateway-token"), `${TOKEN}\n`, { mode: 0o600 });
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const cfg = (endpoint: string, o: Partial<HarnessConfig> = {}): HarnessConfig => ({ endpoint, model: "m", maxSteps: 2, temperature: 0, workspace: os.tmpdir(), shell: "bash", ...o });
const chat = (client: LocalLlmClient, id: string) => client.chatCompletion([{ role: "user", content: "hi" }], [], id);

describe("provider credential boundary", () => {
  test("the stored gateway credential is still sent to its gateway", async () => {
    const aihost = await startGateway(() => ok);
    try {
      await withStoredCredential(aihost.url, async () => {
        await chat(new LocalLlmClient(buildConfig({ endpoint: aihost.url })), "r1");
        await new LocalLlmClient(cfg(aihost.url, { apiKey: "local" })).listModels();
        assert.deepEqual(aihost.authorizations, [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
      });
    } finally {
      await aihost.close();
    }
  });

  test("a foreign provider configured as the endpoint receives no stored credential, even after a 401", async () => {
    const aihost = await startGateway(() => ok);
    const foreign = await startGateway(() => unauthorized);
    try {
      await withStoredCredential(aihost.url, async () => {
        const config = buildConfig({ endpoint: foreign.url });
        assert.equal(config.apiKey, "local", "the stored credential is not baked into a config for another endpoint");
        const client = new LocalLlmClient(config);
        await assert.rejects(chat(client, "r2"), /HTTP 401/);
        assert.equal(client.reloadAuthToken(foreign.url), false, "a 401 does not borrow another provider's credential");
        assert.equal(foreign.requests.length, 1, "no retry with a borrowed credential");
        assert.ok(foreign.authorizations.every((h) => h === "Bearer not-needed"), `foreign saw: ${foreign.authorizations.join(", ")}`);
      });
    } finally {
      await aihost.close();
      await foreign.close();
    }
  });

  test("a planner on a foreign provider does not inherit the primary gateway's key", async () => {
    const aihost = await startGateway(() => ok);
    const foreign = await startGateway(() => ok);
    try {
      await withStoredCredential(aihost.url, async () => {
        const implicit = new AutonomousAgent({ ...buildConfig({ endpoint: aihost.url }), plannerModel: "p", plannerEndpoint: foreign.url, maxSteps: 2 });
        const explicit = new AutonomousAgent(cfg(aihost.url, { plannerModel: "p", plannerEndpoint: foreign.url, apiKey: TOKEN, credentialOrigin: new URL(aihost.url).origin }));
        try {
          await chat((implicit as any).plannerClient, "r3");
          await (explicit as any).plannerClient.listModels();
        } finally {
          implicit.shutdown();
          explicit.shutdown();
        }
        assert.ok(foreign.authorizations.length >= 2);
        assert.ok(foreign.authorizations.every((h) => h === "Bearer not-needed"), `foreign saw: ${foreign.authorizations.join(", ")}`);
      });
    } finally {
      await aihost.close();
      await foreign.close();
    }
  });

  test("an explicit foreign credential is used only for its own provider; the gateway keeps its own", async () => {
    const aihost = await startGateway(() => ok);
    const foreign = await startGateway(() => ok);
    try {
      await withStoredCredential(aihost.url, async () => {
        const client = new LocalLlmClient(cfg(foreign.url, { apiKey: FOREIGN_KEY, fallbackEndpoints: [aihost.url] }));
        await client.probeAvailability(undefined, {});
        await client.probeAvailability(undefined, { preferAlternate: true });
        assert.deepEqual(foreign.authorizations, [`Bearer ${FOREIGN_KEY}`]);
        assert.deepEqual(aihost.authorizations, [`Bearer ${TOKEN}`], "the gateway gets its own credential, never the foreign key");
      });
    } finally {
      await aihost.close();
      await foreign.close();
    }
  });
});
