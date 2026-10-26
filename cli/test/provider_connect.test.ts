/**
 * Connecting providers: credential precedence (env > Nexus store > other clients), reading Codex CLI / opencode /
 * crush / Copilot sign-ins in place without modifying them, the OpenRouter, ChatGPT and Copilot sign-in flows,
 * token refresh rules, key verification, the model catalog, and the sidecar protocol behind /model and ctrl+p.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { InferenceError, LocalLlmClient, mayBindCredential, setCredentialAuthority, storedCredentialFor } from "../src/client.js";
import { credentialsPath, localEndpointCredential, removeCredential, resolveCredential, saveCredential, saveLocalEndpointCredential } from "../src/credentials.js";
import { setOAuthEndpoints, startAuthFlow } from "../src/oauth.js";
import { connectLocalEndpoint, connectWithKey, disconnect, prepareLocalEndpoint } from "../src/provider_connect.js";
import { buildCatalog } from "../src/model_catalog.js";
import { buildConfig, resetApplianceEndpointOverride } from "../src/config.js";
import { ApplicationCore } from "../src/core/app.js";
import { SidecarServer } from "../src/sidecar.js";
import { UsageLedger } from "../src/usage.js";
import { makeRepo } from "./helpers/fixtures.js";
import type { HarnessConfig } from "../src/types.js";

interface Seen { method: string; path: string; headers: http.IncomingHttpHeaders; body: any }
interface Mock { url: string; seen: Seen[]; close(): Promise<void> }
async function mock(respond: (s: Seen, res: http.ServerResponse, n: number) => void): Promise<Mock> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = raw;
      try { body = raw ? JSON.parse(raw) : undefined; } catch {}
      const s = { method: req.method!, path: req.url!, headers: req.headers, body };
      seen.push(s);
      respond(s, res, seen.length);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const sse = (res: http.ServerResponse, events: unknown[]) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
};
const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const responsesDone = (text: string) => [
  { type: "response.output_text.delta", output_index: 0, delta: text },
  { type: "response.completed", response: { id: "r", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 3, output_tokens: 1 } } },
];
const chatDone = (text: string) => [{ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] }, "[DONE]"];

const ENV = ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NEXUS_PROVIDER", "LOCAL_LLM_ENDPOINT", "LOCAL_LLM_API_KEY", "NEXUS_NO_BROWSER"];
let home: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  resetApplianceEndpointOverride();
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.NEXUS_NO_BROWSER = "1";
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-connect-home-"));
  setCredentialAuthority({}, home);
  UsageLedger.resetGlobal();
  UsageLedger.global().limits = {};
});
afterEach(() => {
  resetApplianceEndpointOverride();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setOAuthEndpoints(null);
  fs.rmSync(home, { recursive: true, force: true });
});
/** Operator settings (credential authority) for this test's home. */
const operator = (settings: Record<string, string>) => {
  setCredentialAuthority(settings, home);
  Object.assign(process.env, settings);
};
const write = (rel: string, data: unknown) => {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data), { mode: 0o600 });
  return file;
};
const cfg = (o: Partial<HarnessConfig> = {}): HarnessConfig => ({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 2, temperature: 0, workspace: home, shell: "bash", ...o }) as HarnessConfig;

// ---------------------------------------------------------------- credentials

describe("credentials: precedence and other clients' sign-ins", () => {
  test("Nexus's store is owner-only; env outranks it; removing it leaves other clients' connections", () => {
    write(".local/share/opencode/auth.json", { openrouter: { type: "api", key: "sk-or-OPENCODE" } });
    assert.equal(resolveCredential("openrouter", "OPENROUTER_API_KEY")?.source, "opencode");
    saveCredential("openrouter", { type: "api", key: "sk-or-NEXUS", savedAt: "t" });
    assert.equal(fs.statSync(credentialsPath()).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(credentialsPath())).mode & 0o777, 0o700);
    assert.equal(resolveCredential("openrouter", "OPENROUTER_API_KEY")?.source, "Nexus");
    process.env.OPENROUTER_API_KEY = "sk-or-ENV";
    assert.equal(resolveCredential("openrouter", "OPENROUTER_API_KEY")?.source, "$OPENROUTER_API_KEY");
    delete process.env.OPENROUTER_API_KEY;
    assert.equal(removeCredential("openrouter"), true);
    assert.equal(resolveCredential("openrouter", "OPENROUTER_API_KEY")?.source, "opencode");
  });

  test("reads Codex CLI, opencode, crush and Copilot plugin sign-ins in place and never changes those files", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const files = [
      write(".codex/auth.json", { auth_mode: "chatgpt", tokens: { id_token: jwt({ chatgpt_account_id: "acct-codex" }), access_token: jwt({ exp }), refresh_token: "rt-codex", account_id: "acct-codex" } }),
      write(".local/share/opencode/auth.json", { openai: { type: "oauth", access: jwt({ exp }), refresh: "rt-oc", expires: exp * 1000, accountId: "acct-oc" }, anthropic: { type: "api", key: "sk-ant-OC" } }),
      write(".local/share/crush/crush.json", { providers: { openrouter: { api_key: "sk-or-CRUSH" }, openai: { api_key: "$OPENAI_API_KEY" } } }),
      write(".config/github-copilot/apps.json", { "github.com:Iv1.b507a08c87ecfe98": { user: "me", oauth_token: "gho_PLUGIN" } }),
    ];
    const before = files.map((f) => fs.readFileSync(f, "utf-8"));
    const chatgpt = resolveCredential("chatgpt");
    assert.equal(chatgpt?.source, "Codex CLI");
    assert.equal(chatgpt?.refreshable, false, "another client's token is never refreshed by Nexus");
    assert.equal(chatgpt?.credential.type === "oauth" && chatgpt.credential.accountId, "acct-codex");
    assert.equal(chatgpt?.credential.type === "oauth" && chatgpt.credential.expiresAt, exp * 1000);
    assert.equal(resolveCredential("anthropic", "ANTHROPIC_API_KEY")?.source, "opencode");
    assert.equal(resolveCredential("openrouter", "OPENROUTER_API_KEY")?.source, "crush");
    assert.equal(resolveCredential("openai", "OPENAI_API_KEY"), undefined, "a crush $VAR reference is not a key");
    const copilot = resolveCredential("copilot");
    assert.equal(copilot?.source, "GitHub Copilot plugin");
    assert.equal(copilot?.credential.type === "oauth" && copilot.credential.refresh, "gho_PLUGIN");
    assert.deepEqual(files.map((f) => fs.readFileSync(f, "utf-8")), before);
    assert.equal(fs.existsSync(credentialsPath()), false, "discovery writes nothing");
  });
});

// ---------------------------------------------------------------- sign-in flows

describe("sign-in flows", () => {
  test("OpenRouter PKCE: callback code + verifier are exchanged for a user key", async () => {
    const m = await mock((s, res) => {
      const ok = s.body?.code === "code-1" && s.body?.code_challenge_method === "S256";
      json(res, ok ? 200 : 400, ok ? { key: "sk-or-ISSUED", verifier: s.body.code_verifier } : { error: "bad" });
    });
    try {
      setOAuthEndpoints({ openrouterAuth: `${m.url}/auth`, openrouterKeys: `${m.url}/api/v1/auth/keys` });
      const flow = await startAuthFlow("openrouter-oauth", new AbortController().signal);
      const auth = new URL(flow.prompt.url);
      const challenge = auth.searchParams.get("code_challenge")!;
      await fetch(`${auth.searchParams.get("callback_url")}?code=code-1`);
      const cred = await flow.result;
      assert.deepEqual({ type: cred.type, key: cred.type === "api" && cred.key }, { type: "api", key: "sk-or-ISSUED" });
      const verifier = m.seen[0].body.code_verifier;
      assert.equal(createHash("sha256").update(verifier).digest("base64url"), challenge, "PKCE S256 holds");
    } finally { await m.close(); }
  });

  test("ChatGPT (unofficial): state is checked, tokens exchanged with the Codex client id, account id read", async () => {
    const m = await mock((s, res) => json(res, 200, { access_token: jwt({ exp: 9999999999 }), refresh_token: "rt-1", id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-9" } }), expires_in: 3600 }));
    try {
      setOAuthEndpoints({ chatgptIssuer: m.url, chatgptPorts: [0] });
      const bad = await startAuthFlow("chatgpt-oauth", new AbortController().signal);
      const rejected = assert.rejects(bad.result, /mismatched state/);
      await fetch(`${new URL(bad.prompt.url).searchParams.get("redirect_uri")}?code=c&state=forged`);
      await rejected;
      assert.equal(m.seen.length, 0, "no exchange after a forged callback");
      const flow = await startAuthFlow("chatgpt-oauth", new AbortController().signal);
      const u = new URL(flow.prompt.url);
      assert.equal(u.searchParams.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
      await fetch(`${u.searchParams.get("redirect_uri")}?code=good&state=${u.searchParams.get("state")}`);
      const cred = await flow.result;
      assert.equal(cred.type === "oauth" && cred.accountId, "acct-9");
      assert.equal(cred.type === "oauth" && cred.refresh, "rt-1");
      assert.match(m.seen[0].body, /grant_type=authorization_code/);
      assert.match(m.seen[0].body, /code_verifier=/);
    } finally { await m.close(); }
  });

  test("GitHub Copilot (unofficial): device code, pending poll, then a Copilot token exchange", async () => {
    const m = await mock((s, res, n) => {
      if (s.path === "/device") return json(res, 200, { device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 0, expires_in: 60 });
      if (s.path === "/token") return json(res, 200, n === 2 ? { error: "authorization_pending" } : { access_token: "gho_NEW" });
      return json(res, s.headers.authorization === "Bearer gho_NEW" ? 200 : 401, { token: "cop-TOKEN", expires_at: Math.floor(Date.now() / 1000) + 1500 });
    });
    try {
      setOAuthEndpoints({ githubDeviceCode: `${m.url}/device`, githubAccessToken: `${m.url}/token`, copilotToken: `${m.url}/copilot`, minPollMs: 5 });
      const flow = await startAuthFlow("copilot-device", new AbortController().signal);
      assert.equal(flow.prompt.userCode, "ABCD-1234");
      const cred = await flow.result;
      assert.equal(cred.type === "oauth" && cred.access, "cop-TOKEN");
      assert.equal(cred.type === "oauth" && cred.refresh, "gho_NEW");
      assert.equal(m.seen.find((s) => s.path === "/copilot")?.headers["editor-version"], "vscode/1.105.1");
    } finally { await m.close(); }
  });
});

// ---------------------------------------------------------------- client use of sign-ins

describe("signed-in providers in the client", () => {
  test("ChatGPT: Nexus-owned token refreshed before use and saved; Codex backend headers; no max_output_tokens; always streamed", async () => {
    const tokens = await mock((_s, res) => json(res, 200, { access_token: "at-FRESH", refresh_token: "rt-2", expires_in: 3600 }));
    const backend = await mock((_s, res) => sse(res, responsesDone("hi")));
    try {
      setOAuthEndpoints({ chatgptIssuer: tokens.url });
      saveCredential("chatgpt", { type: "oauth", access: "at-OLD", refresh: "rt-1", expiresAt: Date.now() - 1000, accountId: "acct-1", savedAt: "t" });
      const client = new LocalLlmClient(cfg({ provider: "chatgpt", endpoint: backend.url, model: "gpt-5-codex" }));
      const out = await client.chatCompletion([{ role: "user", content: "x" }], []);
      assert.equal(out.content, "hi");
      const req = backend.seen[0];
      assert.equal(req.path, "/responses");
      assert.equal(req.headers.authorization, "Bearer at-FRESH");
      assert.equal(req.headers["chatgpt-account-id"], "acct-1");
      assert.equal(req.headers.originator, "nexus");
      assert.equal(req.body.stream, true, "the Codex backend only streams");
      assert.equal("max_output_tokens" in req.body, false);
      const stored = JSON.parse(fs.readFileSync(credentialsPath(), "utf-8")).providers.chatgpt;
      assert.equal(stored.access, "at-FRESH");
      assert.equal(stored.refresh, "rt-2");
    } finally { await tokens.close(); await backend.close(); }
  });

  test("ChatGPT via Codex CLI: an expired token is never refreshed by Nexus and nothing is sent", async () => {
    const tokens = await mock((_s, res) => json(res, 200, {}));
    const backend = await mock((_s, res) => sse(res, responsesDone("x")));
    const codex = write(".codex/auth.json", { tokens: { access_token: jwt({ exp: 1000 }), refresh_token: "rt-codex", account_id: "a" } });
    const before = fs.readFileSync(codex, "utf-8");
    try {
      setOAuthEndpoints({ chatgptIssuer: tokens.url });
      const err = await new LocalLlmClient(cfg({ provider: "chatgpt", endpoint: backend.url, model: "gpt-5" }))
        .chatCompletionStream([{ role: "user", content: "x" }], []).catch((e) => e);
      assert.ok(err instanceof InferenceError);
      assert.equal(err.kind, "configuration_error");
      assert.match(err.message, /Codex CLI/);
      assert.equal(tokens.seen.length, 0, "no refresh with another client's refresh token");
      assert.equal(backend.seen.length, 0);
      assert.equal(fs.readFileSync(codex, "utf-8"), before);
    } finally { await tokens.close(); await backend.close(); }
  });

  test("Copilot via the editor plugin: GitHub token exchanged in memory; editor headers and X-Initiator sent", async () => {
    const exchange = await mock((s, res) => json(res, 200, { token: "cop-1", expires_at: Math.floor(Date.now() / 1000) + 1500 }));
    const api = await mock((s, res) => sse(res, chatDone("ok")));
    const apps = write(".config/github-copilot/apps.json", { "github.com:Iv1.b507a08c87ecfe98": { oauth_token: "gho_PLUGIN" } });
    const before = fs.readFileSync(apps, "utf-8");
    try {
      setOAuthEndpoints({ copilotToken: `${exchange.url}/token` });
      const client = new LocalLlmClient(cfg({ provider: "copilot", endpoint: api.url, model: "claude-sonnet-4" }));
      await client.chatCompletionStream([{ role: "user", content: "x" }], []);
      await client.chatCompletionStream([{ role: "user", content: "x" }, { role: "assistant", content: "y" }, { role: "user", content: "z" }], []);
      assert.equal(exchange.seen.length, 1, "the exchanged token is reused while valid");
      assert.equal(exchange.seen[0].headers.authorization, "Bearer gho_PLUGIN");
      assert.equal(api.seen[0].path, "/chat/completions");
      assert.equal(api.seen[0].headers.authorization, "Bearer cop-1");
      assert.equal(api.seen[0].headers["copilot-integration-id"], "vscode-chat");
      assert.deepEqual(api.seen.map((s) => s.headers["x-initiator"]), ["user", "agent"]);
      assert.equal(fs.readFileSync(apps, "utf-8"), before);
      assert.equal(fs.existsSync(credentialsPath()), false, "nothing copied into Nexus's store");
    } finally { await exchange.close(); await api.close(); }
  });

  test("Copilot credential discovery matches the exact GitHub host key", () => {
    const apps = write(".config/github-copilot/apps.json", {
      "github.com.attacker:session": { oauth_token: "gho_UNTRUSTED" },
    });
    assert.equal(resolveCredential("copilot"), undefined, "a lookalike host must not supply the GitHub exchange token");

    fs.writeFileSync(apps, JSON.stringify({
      "github.com:session": { oauth_token: "gho_TRUSTED" },
      "github.com.attacker:session": { oauth_token: "gho_UNTRUSTED" },
    }));
    const credential = resolveCredential("copilot");
    assert.equal(credential?.credential.type, "oauth");
    assert.equal(credential?.credential.type === "oauth" ? credential.credential.refresh : undefined, "gho_TRUSTED");
  });

  test("a 401 from a signed-in provider forces one refresh and one retry", async () => {
    let issued = 0;
    const tokens = await mock((_s, res) => json(res, 200, { access_token: `at-${++issued}`, refresh_token: "rt", expires_in: 3600 }));
    const backend = await mock((s, res, n) => (n === 1 ? json(res, 401, { error: { message: "expired" } }) : sse(res, responsesDone("ok"))));
    try {
      setOAuthEndpoints({ chatgptIssuer: tokens.url });
      saveCredential("chatgpt", { type: "oauth", access: "at-0", refresh: "rt", expiresAt: Date.now() + 3_600_000, savedAt: "t" });
      const out = await new LocalLlmClient(cfg({ provider: "chatgpt", endpoint: backend.url, model: "gpt-5" })).chatCompletionStream([{ role: "user", content: "x" }], []);
      assert.equal(out.content, "ok");
      assert.deepEqual(backend.seen.map((s) => s.headers.authorization), ["Bearer at-0", "Bearer at-1"]);
      assert.equal(tokens.seen.length, 1);
    } finally { await tokens.close(); await backend.close(); }
  });
});

// ---------------------------------------------------------------- connect, catalog, sidecar

describe("connecting from the picker", () => {
  test("local endpoint setup discovers a selected model and saves an optional key scoped to its origin", async () => {
    const local = await mock((s, res) => {
      if (s.path.endsWith("/models")) return json(res, s.headers.authorization === "Bearer local-secret" ? 200 : 401, { data: [{ id: "engineering/lead" }, { id: "small-model" }] });
      return json(res, 200, {});
    });
    const other = await mock((_s, res) => json(res, 200, { data: [{ id: "other-model" }] }));
    try {
      const endpoint = `${local.url}/v1`;
      const configured = await connectLocalEndpoint(cfg(), endpoint, "engineering/lead", " local-secret ");
      assert.equal(configured.ok, true, configured.message);
      assert.deepEqual(configured.models, ["engineering/lead", "small-model"]);
      assert.doesNotMatch(configured.message, /local-secret/);
      assert.equal(fs.statSync(credentialsPath()).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(home, ".config/nexus/config.env")).mode & 0o777, 0o600);
      const persisted = fs.readFileSync(path.join(home, ".config/nexus/config.env"), "utf8");
      assert.match(persisted, /LOCAL_LLM_ENDPOINT=/);
      assert.match(persisted, /LOCAL_LLM_MODEL="engineering\/lead"/);
      assert.doesNotMatch(persisted, /local-secret/);
      assert.deepEqual(localEndpointCredential(endpoint)?.origin, new URL(endpoint).origin);
      assert.equal(storedCredentialFor(endpoint), "local-secret");
      assert.equal(mayBindCredential("local-secret", endpoint), true);
      assert.equal(mayBindCredential("local-secret", other.url), false);

      setCredentialAuthority({ LOCAL_LLM_ENDPOINT: endpoint }, home);
      const client = new LocalLlmClient(cfg({ endpoint, apiKey: undefined }));
      assert.deepEqual(await client.listModels(), ["engineering/lead", "small-model"]);
      assert.ok(local.seen.every((request) => request.headers.authorization === "Bearer local-secret"));
      assert.ok(!other.seen.some((request) => request.headers.authorization === "Bearer local-secret"));
    } finally {
      await local.close();
      await other.close();
    }
  });

  test("local endpoint setup rejects unsafe URLs and unlisted model ids without persisting anything", async () => {
    const local = await mock((_s, res) => json(res, 200, { data: [{ id: "safe-model" }, { id: "model\u001b[31m" }] }));
    try {
      const invalidUrl = await connectLocalEndpoint(cfg(), `http://user:secret@127.0.0.1:${new URL(local.url).port}/v1`, "safe-model", "key");
      assert.equal(invalidUrl.ok, false);
      const invalidModel = await connectLocalEndpoint(cfg(), `${local.url}/v1`, "not-listed", "key");
      assert.equal(invalidModel.ok, false);
      assert.deepEqual(invalidModel.models, ["safe-model"]);
      assert.equal(fs.existsSync(credentialsPath()), false);
      assert.equal(fs.existsSync(path.join(home, ".config/nexus/config.env")), false);
    } finally {
      await local.close();
    }
  });

  test("local endpoint credentials are never forwarded through redirects", async () => {
    const target = await mock((_s, res) => json(res, 200, { data: [{ id: "redirect-target-model" }] }));
    const source = await mock((_s, res) => {
      res.writeHead(302, { location: `${target.url}/v1/models` });
      res.end();
    });
    try {
      const endpoint = `${source.url}/v1`;
      operator({ LOCAL_LLM_ENDPOINT: endpoint });
      assert.equal(saveLocalEndpointCredential(endpoint, "redirect-secret"), true);
      const client = new LocalLlmClient(cfg({ endpoint, apiKey: undefined }));
      await assert.rejects(client.listModels());
      assert.equal(source.seen.length, 1);
      assert.equal(source.seen[0].headers.authorization, "Bearer redirect-secret");
      assert.equal(target.seen.length, 0, "the redirect destination must never receive the saved key");
    } finally {
      await source.close();
      await target.close();
    }
  });

  test("provisional local endpoint discovery authenticates in memory without persisting selection or key", async () => {
    const local = await mock((s, res) => json(res, s.headers.authorization === "Bearer provisional-secret" ? 200 : 401, { data: [{ id: "candidate-model" }] }));
    const previous = 'LOCAL_LLM_ENDPOINT="http://127.0.0.1:9/v1"\nLOCAL_LLM_MODEL="previous-model"\n';
    try {
      fs.mkdirSync(path.join(home, ".config/nexus"), { recursive: true });
      fs.writeFileSync(path.join(home, ".config/nexus/config.env"), previous, { mode: 0o600 });
      const result = await prepareLocalEndpoint(cfg(), `${local.url}/v1`, "provisional-secret");
      assert.equal(result.ok, true, result.message);
      const pendingClient = new LocalLlmClient(buildConfig({ appliance: true }));
      assert.deepEqual(await pendingClient.listModels(), ["candidate-model"]);
      assert.equal(local.seen.length, 2, "verification and picker discovery both authenticate to the selected endpoint");
      assert.ok(local.seen.every((request) => request.headers.authorization === "Bearer provisional-secret"));
      assert.equal(fs.readFileSync(path.join(home, ".config/nexus/config.env"), "utf8"), previous);
      assert.equal(fs.existsSync(credentialsPath()), false, "the pending key is not written before model selection");
    } finally {
      resetApplianceEndpointOverride();
      await local.close();
    }
  });

  test("a key is verified before it is saved; a rejected key is not saved and never echoed", async () => {
    const m = await mock((s, res) => json(res, s.headers["x-api-key"] === "sk-ant-GOOD" ? 200 : 401, { data: [{ id: "claude-a" }, { id: "claude-b" }] }));
    try {
      operator({ NEXUS_ANTHROPIC_BASE_URL: `${m.url}/v1` });
      const bad = await connectWithKey(cfg(), "anthropic", "sk-ant-BAD");
      assert.equal(bad.ok, false);
      assert.doesNotMatch(bad.message, /sk-ant/);
      assert.equal(fs.existsSync(credentialsPath()), false);
      const good = await connectWithKey(cfg(), "anthropic", "  sk-ant-GOOD\n");
      assert.equal(good.ok, true);
      assert.match(good.message, /2 models/);
      assert.equal(fs.statSync(credentialsPath()).mode & 0o777, 0o600);
      assert.equal(resolveCredential("anthropic", "ANTHROPIC_API_KEY")?.source, "Nexus");
      process.env.ANTHROPIC_API_KEY = "sk-env";
      assert.match(disconnect("anthropic").message, /still connected via \$ANTHROPIC_API_KEY/);
    } finally { await m.close(); }
  });

  test("the catalog lists the appliance first, connected providers with their source, and falls back to a cached list", async () => {
    const appliance = await mock((_s, res) => json(res, 200, { data: [{ id: "engineering/b0" }] }));
    let up = true;
    const or = await mock((_s, res) => (up ? json(res, 200, { data: [{ id: "anthropic/claude-x" }, { id: "text-embedding-3" }] }) : json(res, 503, {})));
    try {
      operator({ LOCAL_LLM_ENDPOINT: `${appliance.url}/v1`, NEXUS_OPENROUTER_BASE_URL: `${or.url}/api/v1` });
      write(".local/share/crush/crush.json", { providers: { openrouter: { api_key: "sk-or-CRUSH-secret" } } });
      const first = await buildCatalog(cfg({ endpoint: `${appliance.url}/v1`, model: "engineering/b0" }));
      assert.deepEqual(first.providers.map((p) => [p.id, p.connected, p.source ?? null]).slice(0, 2), [["appliance", true, null], ["openrouter", true, "crush"]]);
      assert.ok(first.providers.some((p) => p.id === "chatgpt" && !p.connected && p.methods[0].unofficial));
      assert.deepEqual(first.models.map((m) => `${m.provider}:${m.id}`), ["appliance:engineering/b0", "openrouter:anthropic/claude-x"]);
      assert.deepEqual(first.current, { provider: "appliance", model: "engineering/b0" });
      assert.doesNotMatch(JSON.stringify(first), /sk-or-CRUSH/, "the catalog never carries a credential");
      up = false;
      const second = await buildCatalog(cfg({ endpoint: `${appliance.url}/v1`, model: "engineering/b0" }));
      const orEntry = second.providers.find((p) => p.id === "openrouter")!;
      assert.equal(orEntry.status, "cached");
      assert.ok(second.models.some((m) => m.id === "anthropic/claude-x"), "offline: last good list");
    } finally { await appliance.close(); await or.close(); }
  });

  test("sidecar: models.list, provider.connect with a key, model.select switches the session to the provider", async () => {
    const appliance = await mock((s, res) => (s.path.endsWith("/models") ? json(res, 200, { data: [{ id: "m" }] }) : sse(res, chatDone("local"))));
    const anth = await mock((s, res) => {
      if (s.path.includes("/models")) return json(res, s.headers["x-api-key"] === "sk-ant-OK" ? 200 : 401, { data: [{ id: "claude-x" }] });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end([
        { type: "message_start", message: { id: "msg", usage: { input_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "from claude" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
    });
    const repo = makeRepo();
    operator({ LOCAL_LLM_ENDPOINT: `${appliance.url}/v1`, NEXUS_ANTHROPIC_BASE_URL: `${anth.url}/v1` });
    const app = new ApplicationCore({ endpoint: `${appliance.url}/v1`, model: "m", maxSteps: 3, temperature: 0, workspace: repo, shell: "bash" } as any);
    const lines: string[] = [];
    const server = new SidecarServer({ app, mode: "auto", write: (l) => lines.push(l) });
    server.start();
    const events = () => lines.map((l) => JSON.parse(l));
    const send = (msg: Record<string, unknown>) => server.handleLine(JSON.stringify({ v: 1, ...msg }));
    const waitFor = async (pred: (e: any) => boolean) => {
      for (let i = 0; i < 200; i++) {
        const hit = events().find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.fail("event not seen");
    };
    try {
      await send({ type: "models.list", id: "m1" });
      const catalog = await waitFor((e) => e.type === "models.catalog" && e.id === "m1");
      assert.equal(catalog.providers.find((p: any) => p.id === "anthropic").connected, false);
      await send({ type: "provider.connect", id: "c1", provider: "anthropic", method: "api-key", key: "sk-ant-OK" });
      const result = await waitFor((e) => e.type === "provider.result" && e.id === "c1");
      assert.equal(result.success, true, result.message);
      await send({ type: "model.select", id: "x1", provider: "anthropic", model: "claude-x" });
      const selected = await waitFor((e) => e.type === "model.result" && e.id === "x1");
      assert.equal(selected.success, true, selected.message);
      assert.ok(events().some((e) => e.type === "session.state" && e.model === "anthropic · claude-x"));
      await send({ type: "prompt.submit", id: "t1", text: "hello" });
      await waitFor((e) => e.type === "turn.result" && e.turn_id === "t1");
      const chat = anth.seen.find((s) => s.path === "/v1/messages");
      assert.equal(chat?.headers["x-api-key"], "sk-ant-OK");
      assert.ok(!lines.join("\n").includes("sk-ant-OK"), "the key never appears in sidecar output");
    } finally {
      await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
      await server.idle();
      app.shutdown();
      await appliance.close();
      await anth.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("sidecar: local endpoint setup verifies and scopes a key, then exposes its models for selection", async () => {
    const appliance = await mock((_s, res) => json(res, 200, { data: [{ id: "old-model" }] }));
    const local = await mock((s, res) => {
      if (s.path.endsWith("/models")) return json(res, s.headers.authorization === "Bearer local-sidecar-key" ? 200 : 401, { data: [{ id: "local/selected-model" }] });
      return json(res, 200, {});
    });
    const repo = makeRepo();
    operator({ LOCAL_LLM_ENDPOINT: `${appliance.url}/v1` });
    const app = new ApplicationCore({ endpoint: `${appliance.url}/v1`, model: "old-model", maxSteps: 3, temperature: 0, workspace: repo, shell: "bash" } as any);
    const lines: string[] = [];
    const server = new SidecarServer({ app, mode: "auto", write: (line) => lines.push(line) });
    server.start();
    const events = () => lines.map((line) => JSON.parse(line));
    const send = (message: Record<string, unknown>) => server.handleLine(JSON.stringify({ v: 1, ...message }));
    const waitFor = async (predicate: (event: any) => boolean) => {
      for (let i = 0; i < 200; i++) {
        const found = events().find(predicate);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.fail("event not seen");
    };
    try {
      await send({ type: "provider.connect", id: "local-connect", provider: "appliance", method: "local-endpoint", endpoint: `${local.url}/v1`, key: "local-sidecar-key" });
      const result = await waitFor((event) => event.type === "provider.result" && event.id === "local-connect");
      assert.equal(result.success, true, result.message);
      assert.doesNotMatch(lines.join("\n"), /local-sidecar-key/);
      await send({ type: "models.list", id: "local-models" });
      const catalog = await waitFor((event) => event.type === "models.catalog" && event.id === "local-models");
      assert.deepEqual(catalog.models.filter((model: any) => model.provider === "appliance").map((model: any) => model.id), ["local/selected-model"]);
      await send({ type: "model.select", id: "local-select", provider: "appliance", model: "local/selected-model" });
      const selected = await waitFor((event) => event.type === "model.result" && event.id === "local-select");
      assert.equal(selected.success, true, selected.message);
      assert.equal(fs.readFileSync(path.join(home, ".config/nexus/config.env"), "utf8").includes("LOCAL_LLM_MODEL=\"local/selected-model\""), true);
      assert.ok(local.seen.every((request) => request.headers.authorization === "Bearer local-sidecar-key"));
    } finally {
      await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
      await server.shutdown();
      await appliance.close();
      await local.close();
    }
  });

  test("sidecar: cancelling provisional local setup preserves prior selection and does not store its key", async () => {
    const oldEndpoint = await mock((_s, res) => json(res, 200, { data: [{ id: "old-model" }] }));
    const local = await mock((s, res) => json(res, s.headers.authorization === "Bearer pending-secret" ? 200 : 401, { data: [{ id: "pending-model" }] }));
    const repo = makeRepo();
    operator({ LOCAL_LLM_ENDPOINT: `${oldEndpoint.url}/v1` });
    const configFile = path.join(home, ".config/nexus/config.env");
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const previous = `LOCAL_LLM_ENDPOINT=${JSON.stringify(`${oldEndpoint.url}/v1`)}\nLOCAL_LLM_MODEL="old-model"\n`;
    fs.writeFileSync(configFile, previous, { mode: 0o600 });
    const app = new ApplicationCore({ endpoint: `${oldEndpoint.url}/v1`, model: "old-model", maxSteps: 3, temperature: 0, workspace: repo, shell: "bash" } as any);
    const lines: string[] = [];
    const server = new SidecarServer({ app, mode: "auto", write: (line) => lines.push(line) });
    server.start();
    const events = () => lines.map((line) => JSON.parse(line));
    const send = (message: Record<string, unknown>) => server.handleLine(JSON.stringify({ v: 1, ...message }));
    const waitFor = async (predicate: (event: any) => boolean) => {
      for (let i = 0; i < 200; i++) {
        const found = events().find(predicate);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.fail("event not seen");
    };
    try {
      await send({ type: "provider.connect", id: "pending-connect", provider: "appliance", method: "local-endpoint", endpoint: `${local.url}/v1`, key: "pending-secret" });
      assert.equal((await waitFor((event) => event.type === "provider.result" && event.id === "pending-connect")).success, true);
      await send({ type: "models.list", id: "pending-models" });
      const catalog = await waitFor((event) => event.type === "models.catalog" && event.id === "pending-models");
      assert.deepEqual(catalog.models.filter((model: any) => model.provider === "appliance").map((model: any) => model.id), ["pending-model"]);
      assert.ok(local.seen.every((request) => request.headers.authorization === "Bearer pending-secret"));
      assert.equal(fs.readFileSync(configFile, "utf8"), previous);
      assert.equal(fs.existsSync(credentialsPath()), false);

      await send({ type: "provider.cancel", id: "pending-models" });
      await send({ type: "models.list", id: "after-cancel" });
      const restored = await waitFor((event) => event.type === "models.catalog" && event.id === "after-cancel");
      assert.deepEqual(restored.models.filter((model: any) => model.provider === "appliance").map((model: any) => model.id), ["old-model"]);
      assert.ok(oldEndpoint.seen.length >= 1);
      assert.equal(oldEndpoint.seen.at(-1)?.headers.authorization, "Bearer not-needed");
      assert.equal(fs.readFileSync(configFile, "utf8"), previous);
      assert.equal(fs.existsSync(credentialsPath()), false);
    } finally {
      await server.shutdown();
      await oldEndpoint.close();
      await local.close();
    }
  });
});
