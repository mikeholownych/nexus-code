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
import { commitLocalEndpointSetup, credentialsPath, localEndpointCredential, removeCredential, resolveCredential, saveCredential, saveLocalEndpointCredential } from "../src/credentials.js";
import { setOAuthEndpoints, startAuthFlow } from "../src/oauth.js";
import { connectLocalEndpoint, connectWithKey, disconnect, prepareLocalEndpoint } from "../src/provider_connect.js";
import { buildCatalog } from "../src/model_catalog.js";
import { buildConfig, resetApplianceEndpointOverride, saveLocalEndpointSettings } from "../src/config.js";
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

const ENV = ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NEXUS_PROVIDER", "LOCAL_LLM_ENDPOINT", "LOCAL_LLM_MODEL", "LOCAL_LLM_API_KEY", "LOCAL_LLM_CREDENTIAL_ORIGIN", "NEXUS_NO_BROWSER"];
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

  test("local setup rejects unsupported store versions and malformed endpoint entries before mutation", () => {
    const endpoint = "http://127.0.0.1:4321/v1";
    const id = `nexus-local-endpoint:${new URL(endpoint).origin}`;
    const cases = [
      ["unsupported version", { version: 2, providers: {} }],
      ["null endpoint credential", { version: 1, providers: { [id]: null } }],
      ["invalid endpoint credential", { version: 1, providers: { [id]: { type: "api", key: 7, savedAt: "fixed" } } }],
    ] as const;
    for (const [label, store] of cases) {
      fs.mkdirSync(path.dirname(credentialsPath()), { recursive: true });
      const original = `${JSON.stringify(store)}\n`;
      fs.writeFileSync(credentialsPath(), original, { mode: 0o640 });
      fs.chmodSync(credentialsPath(), 0o640);
      const mode = fs.statSync(credentialsPath()).mode & 0o777;
      let settingsCommitted = false;
      assert.throws(
        () => commitLocalEndpointSetup(endpoint, "new-secret", () => { settingsCommitted = true; throw new Error("settings write failed"); }),
        /safely update its credential store/,
        label,
      );
      assert.equal(settingsCommitted, false, `${label}: settings callback must not run`);
      assert.equal(fs.readFileSync(credentialsPath(), "utf8"), original, `${label}: original bytes must remain exact`);
      assert.equal(fs.statSync(credentialsPath()).mode & 0o777, mode, `${label}: original mode must remain exact`);
    }
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

  test("local setup result does not echo a credential-bearing endpoint path or API key", async () => {
    const key = "endpoint-path-key";
    const local = await mock((s, res) => json(res, s.headers.authorization === `Bearer ${key}` ? 200 : 401, { data: [{ id: "safe-model" }] }));
    const endpoint = `${local.url}/tenant/endpoint-path-secret/v1`;
    try {
      const result = await connectLocalEndpoint(cfg(), endpoint, "safe-model", key);
      assert.equal(result.ok, true, result.message);
      assert.doesNotMatch(result.message, /endpoint-path-secret|endpoint-path-key|127\.0\.0\.1/);
      assert.ok(local.seen.length >= 1, "the endpoint was actually verified");
    } finally {
      await local.close();
    }
  });

  test("CLI local setup catches persistence failure and leaves prior config and credentials unchanged", async () => {
    const local = await mock((s, res) => json(res, s.headers.authorization === "Bearer cli-pending-key" ? 200 : 401, { data: [{ id: "safe-model" }] }));
    const configDir = path.join(home, ".config/nexus");
    fs.mkdirSync(configDir, { recursive: true });
    const target = path.join(home, "prior-config.env");
    const previous = 'LOCAL_LLM_ENDPOINT="http://127.0.0.1:9/v1"\nLOCAL_LLM_MODEL="prior-model"\n';
    fs.writeFileSync(target, previous, { mode: 0o600 });
    fs.symlinkSync(target, path.join(configDir, "config.env"));
    try {
      const result = await connectLocalEndpoint(cfg(), `${local.url}/v1`, "safe-model", "cli-pending-key");
      assert.equal(result.ok, false, "the CLI flow returns a safe failure instead of throwing");
      assert.doesNotMatch(result.message, /cli-pending-key|127\.0\.0\.1/);
      assert.equal(fs.readFileSync(target, "utf8"), previous);
      assert.equal(fs.existsSync(credentialsPath()), false, "the uncommitted key is rolled back");
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

  test("local setup rejects an invalid replacement key without retrying the prior saved key", async () => {
    const endpoint = await mock((s, res) => json(res, s.headers.authorization === "Bearer existing-valid-key" ? 200 : 401, { data: [{ id: "model-a" }] }));
    const url = `${endpoint.url}/v1`;
    operator({ LOCAL_LLM_ENDPOINT: url });
    assert.equal(saveLocalEndpointCredential(url, "existing-valid-key"), true);
    try {
      const result = await prepareLocalEndpoint(cfg(), url, "invalid-replacement-key", "invalid-replacement");
      assert.equal(result.ok, false, "verification must reject the newly supplied key, not accept an old key after 401");
      assert.deepEqual(endpoint.seen.map((request) => request.headers.authorization), ["Bearer invalid-replacement-key"]);
      assert.equal(localEndpointCredential(url)?.key, "existing-valid-key", "failed verification must preserve the prior credential");
    } finally {
      await endpoint.close();
    }
  });

  test("changing the local endpoint does not rebind a config.env key to the new origin", () => {
    const oldEndpoint = "http://127.0.0.1:4321/v1";
    const newEndpoint = "http://127.0.0.1:5432/v1";
    const configFile = write(".config/nexus/config.env", `LOCAL_LLM_ENDPOINT=${JSON.stringify(oldEndpoint)}\nLOCAL_LLM_API_KEY=legacy-old-origin-key\n`);
    setCredentialAuthority({ LOCAL_LLM_ENDPOINT: oldEndpoint, LOCAL_LLM_API_KEY: "legacy-old-origin-key" }, home);
    assert.equal(storedCredentialFor(oldEndpoint), "legacy-old-origin-key");

    saveLocalEndpointSettings(newEndpoint, "new-model");
    setCredentialAuthority({
      LOCAL_LLM_ENDPOINT: newEndpoint,
      LOCAL_LLM_API_KEY: "legacy-old-origin-key",
      LOCAL_LLM_CREDENTIAL_ORIGIN: "http://127.0.0.1:4321",
    }, home);

    assert.equal(storedCredentialFor(newEndpoint), null, "the legacy key must not follow the changed endpoint");
    assert.equal(storedCredentialFor(oldEndpoint), "legacy-old-origin-key", "the legacy key remains usable only at its original origin");
    assert.match(fs.readFileSync(configFile, "utf8"), /LOCAL_LLM_CREDENTIAL_ORIGIN="http:\/\/127\.0\.0\.1:4321"/);
  });

  test("settings permission failure leaves the prior config.env untouched", () => {
    const configFile = write(".config/nexus/config.env", 'LOCAL_LLM_ENDPOINT="http://127.0.0.1:1234/v1"\nLOCAL_LLM_MODEL="prior-model"\n');
    const before = fs.readFileSync(configFile, "utf8");
    const chmod = fs.chmodSync;
    (fs as any).chmodSync = () => { throw new Error("synthetic chmod failure"); };
    try {
      assert.throws(() => saveLocalEndpointSettings("http://127.0.0.1:4321/v1", "new-model"), /synthetic chmod failure/);
      assert.equal(fs.readFileSync(configFile, "utf8"), before, "a failure before final rename cannot replace existing settings");
      assert.equal(fs.readdirSync(path.dirname(configFile)).some((name) => name.endsWith(".tmp")), false, "failed temporary files are cleaned up");
    } finally {
      (fs as any).chmodSync = chmod;
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

  test("the appliance model cache is isolated by endpoint origin", async () => {
    const endpoint = await mock((s, res) => {
      if (s.path === "/tenant-a/v1/models") return json(res, 200, { data: [{ id: "first-origin-model" }] });
      return json(res, 503, {});
    });
    try {
      operator({ LOCAL_LLM_ENDPOINT: `${endpoint.url}/tenant-a/v1` });
      const first = await buildCatalog(cfg(), { timeoutMs: 500 });
      assert.ok(first.models.some((model) => model.id === "first-origin-model"));

      operator({ LOCAL_LLM_ENDPOINT: `${endpoint.url}/tenant-b/v1` });
      const second = await buildCatalog(cfg(), { timeoutMs: 500 });
      const appliance = second.providers.find((provider) => provider.id === "appliance")!;
      assert.equal(appliance.status, "error");
      assert.equal(second.models.some((model) => model.id === "first-origin-model"), false, "an offline new endpoint cannot inherit another endpoint's model cache");
    } finally {
      await endpoint.close();
    }
  });

  test("the catalog discloses when a configured appliance endpoint is cloud-routed", async () => {
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ data: [{ id: "cloud-model" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const endpoint = "https://api.openai.com/v1";
      const prepared = await prepareLocalEndpoint(cfg(), endpoint, undefined, "cloud-appliance-setup");
      assert.equal(prepared.ok, true, prepared.message);
      assert.match(prepared.message, /Cloud endpoint verified.*send task content/);
      const catalog = await buildCatalog(cfg());
      const appliance = catalog.providers.find((provider) => provider.id === "appliance")!;
      assert.equal(appliance.disclosure, "cloud");
      assert.ok(requested.some((url) => url === `${endpoint}/models`));
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  test("sidecar: failed local settings persistence restores the exact credential state", async () => {
    const noPrior = await mock((s, res) => json(res, s.headers.authorization === "Bearer pending-no-prior" ? 200 : 401, { data: [{ id: "model-a" }] }));
    const prior = await mock((s, res) => json(res, s.headers.authorization === "Bearer pending-with-prior" ? 200 : 401, { data: [{ id: "model-b" }] }));
    const repo = makeRepo();
    const configDir = path.join(home, ".config/nexus");
    fs.mkdirSync(configDir, { recursive: true });
    const configTarget = path.join(home, "previous-config.env");
    const previousConfig = 'LOCAL_LLM_ENDPOINT="http://127.0.0.1:9/v1"\nLOCAL_LLM_MODEL="previous-model"\n';
    fs.writeFileSync(configTarget, previousConfig, { mode: 0o600 });
    const configFile = path.join(configDir, "config.env");
    fs.symlinkSync(configTarget, configFile);
    const app = new ApplicationCore({ endpoint: "http://127.0.0.1:9/v1", model: "previous-model", maxSteps: 3, temperature: 0, workspace: repo, shell: "bash" } as any);
    const lines: string[] = [];
    const server = new SidecarServer({ app, mode: "auto", write: (line) => lines.push(line) });
    server.start();
    const events = () => lines.map((line) => JSON.parse(line));
    const send = (message: Record<string, unknown>) => server.handleLine(JSON.stringify({ v: 1, ...message }));
    let sequence = 0;
    const waitFor = async (predicate: (event: any) => boolean) => {
      for (let i = 0; i < 200; i++) {
        const found = events().find(predicate);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.fail("event not seen");
    };
    const choosePendingModel = async (endpoint: string, key: string, model: string) => {
      const n = ++sequence;
      await send({ type: "provider.connect", id: `connect-${n}`, provider: "appliance", method: "local-endpoint", endpoint, key });
      assert.equal((await waitFor((event) => event.type === "provider.result" && event.id === `connect-${n}`)).success, true);
      await send({ type: "models.list", id: `models-${n}` });
      const catalog = await waitFor((event) => event.type === "models.catalog" && event.id === `models-${n}`);
      assert.ok(catalog.models.some((entry: any) => entry.provider === "appliance" && entry.id === model));
      await send({ type: "model.select", id: `select-${n}`, provider: "appliance", model });
      const result = await waitFor((event) => event.type === "model.result" && event.id === `select-${n}`);
      assert.equal(result.success, false, "the config.env symlink must reject persistence");
    };
    try {
      assert.equal(fs.existsSync(credentialsPath()), false);
      await choosePendingModel(`${noPrior.url}/v1`, "pending-no-prior", "model-a");
      assert.equal(fs.existsSync(credentialsPath()), false, "a new credential store is removed after failed settings persistence");
      assert.equal(localEndpointCredential(`${noPrior.url}/v1`), undefined);

      const priorEndpoint = `${prior.url}/v1`;
      assert.equal(saveLocalEndpointCredential(priorEndpoint, "pre-existing-secret"), true);
      const priorStore = fs.readFileSync(credentialsPath(), "utf8");
      const priorEntry = JSON.parse(priorStore).providers[`nexus-local-endpoint:${prior.url}`];
      await choosePendingModel(priorEndpoint, "pending-with-prior", "model-b");
      assert.equal(fs.readlinkSync(configFile), configTarget);
      assert.equal(fs.readFileSync(configTarget, "utf8"), previousConfig);
      assert.equal(fs.readFileSync(credentialsPath(), "utf8"), priorStore, "rollback preserves the pre-existing credential store byte-for-byte");
      assert.deepEqual(JSON.parse(fs.readFileSync(credentialsPath(), "utf8")).providers[`nexus-local-endpoint:${prior.url}`], priorEntry);
    } finally {
      await server.shutdown();
      await noPrior.close();
      await prior.close();
    }
  });

  test("sidecar: unrelated provider cancellation preserves setup and explicit local-picker clear removes it", async () => {
    const previous = await mock((_s, res) => json(res, 200, { data: [{ id: "previous-model" }] }));
    const pending = await mock((s, res) => json(res, s.headers.authorization === "Bearer provisional-key" ? 200 : 401, { data: [{ id: "provisional-model" }] }));
    const repo = makeRepo();
    operator({ LOCAL_LLM_ENDPOINT: `${previous.url}/v1`, LOCAL_LLM_MODEL: "previous-model" });
    const app = new ApplicationCore({ endpoint: `${previous.url}/v1`, model: "previous-model", maxSteps: 3, temperature: 0, workspace: repo, shell: "bash" } as any);
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
    const listApplianceModels = async (id: string) => {
      await send({ type: "models.list", id });
      const catalog = await waitFor((event) => event.type === "models.catalog" && event.id === id);
      return catalog.models.filter((entry: any) => entry.provider === "appliance").map((entry: any) => entry.id);
    };
    try {
      await send({ type: "provider.connect", id: "local-setup-owner", provider: "appliance", method: "local-endpoint", endpoint: `${pending.url}/v1`, key: "provisional-key" });
      assert.equal((await waitFor((event) => event.type === "provider.result" && event.id === "local-setup-owner")).success, true);

      await send({ type: "provider.cancel", id: "unrelated-request" });
      assert.deepEqual(await listApplianceModels("after-unrelated-cancel"), ["provisional-model"], "an unrelated cancel cannot clear the active setup");
      await send({ type: "provider.local-cancel", id: "wrong-setup-owner" });
      assert.deepEqual(await listApplianceModels("after-wrong-local-clear"), ["provisional-model"], "the explicit clear is also owner-correlated");

      await send({ type: "provider.local-cancel", id: "local-setup-owner" });
      assert.deepEqual(await listApplianceModels("after-local-picker-close"), ["previous-model"], "closing the owning picker restores prior routing");
      assert.ok(previous.seen.length > 0);
      assert.ok(pending.seen.every((request) => request.headers.authorization === "Bearer provisional-key"));
      assert.equal(fs.existsSync(credentialsPath()), false);
    } finally {
      await server.shutdown();
      await previous.close();
      await pending.close();
    }
  });

  test("sidecar: cancelling local endpoint discovery prevents a late response from activating setup", async () => {
    const previous = await mock((_s, res) => json(res, 200, { data: [{ id: "previous-model" }] }));
    const delayed = await mock((_s, res) => { setTimeout(() => json(res, 200, { data: [{ id: "late-model" }] }), 120); });
    const repo = makeRepo();
    operator({ LOCAL_LLM_ENDPOINT: `${previous.url}/v1` });
    const app = new ApplicationCore({ endpoint: `${previous.url}/v1`, model: "previous-model", maxSteps: 3, temperature: 0, workspace: repo, shell: "bash" } as any);
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
      await send({ type: "provider.connect", id: "delayed-connect", provider: "appliance", method: "local-endpoint", endpoint: `${delayed.url}/v1`, key: "late-secret" });
      for (let i = 0; i < 200 && delayed.seen.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(delayed.seen.length > 0, "the delayed endpoint request must be in flight before cancellation");
      await send({ type: "provider.cancel", id: "delayed-connect" });
      await new Promise((resolve) => setTimeout(resolve, 180));
      assert.equal(events().some((event) => event.type === "provider.result" && event.id === "delayed-connect"), false, "a cancelled request must not publish a late result");
      assert.equal(fs.existsSync(credentialsPath()), false, "a cancelled request must not persist its key");
      assert.equal(localEndpointCredential(`${delayed.url}/v1`), undefined);

      await send({ type: "models.list", id: "after-delayed-cancel" });
      const catalog = await waitFor((event) => event.type === "models.catalog" && event.id === "after-delayed-cancel");
      assert.deepEqual(catalog.models.filter((entry: any) => entry.provider === "appliance").map((entry: any) => entry.id), ["previous-model"]);
      assert.ok(previous.seen.length > 0, "subsequent model discovery remains routed to the prior endpoint");
    } finally {
      await server.shutdown();
      await previous.close();
      await delayed.close();
    }
  });

  test("sidecar: malformed credential store is preserved when local selection cannot persist", async () => {
    const local = await mock((s, res) => json(res, s.headers.authorization === "Bearer pending-secret" ? 200 : 401, { data: [{ id: "pending-model" }] }));
    const repo = makeRepo();
    const configDir = path.join(home, ".config/nexus");
    fs.mkdirSync(configDir, { recursive: true });
    const configTarget = path.join(home, "previous-config.env");
    const previousConfig = 'LOCAL_LLM_ENDPOINT="http://127.0.0.1:9/v1"\nLOCAL_LLM_MODEL="previous-model"\n';
    fs.writeFileSync(configTarget, previousConfig, { mode: 0o600 });
    const configFile = path.join(configDir, "config.env");
    fs.symlinkSync(configTarget, configFile);
    const malformedStore = '{"version":1,"providers": [malformed';
    fs.writeFileSync(credentialsPath(), malformedStore, { mode: 0o640 });
    fs.chmodSync(credentialsPath(), 0o640);
    const credentialMode = fs.statSync(credentialsPath()).mode & 0o777;
    const app = new ApplicationCore({ endpoint: "http://127.0.0.1:9/v1", model: "previous-model", maxSteps: 3, temperature: 0, workspace: repo, shell: "bash" } as any);
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
      await send({ type: "provider.connect", id: "malformed-connect", provider: "appliance", method: "local-endpoint", endpoint: `${local.url}/v1`, key: "pending-secret" });
      assert.equal((await waitFor((event) => event.type === "provider.result" && event.id === "malformed-connect")).success, true);
      await send({ type: "models.list", id: "malformed-models" });
      const catalog = await waitFor((event) => event.type === "models.catalog" && event.id === "malformed-models");
      assert.ok(catalog.models.some((entry: any) => entry.provider === "appliance" && entry.id === "pending-model"));
      await send({ type: "model.select", id: "malformed-select", provider: "appliance", model: "pending-model" });
      const selected = await waitFor((event) => event.type === "model.result" && event.id === "malformed-select");
      assert.equal(selected.success, false, "the credential store must fail closed before either file is changed");
      assert.equal(fs.readFileSync(credentialsPath(), "utf8"), malformedStore);
      assert.equal(fs.statSync(credentialsPath()).mode & 0o777, credentialMode);
      assert.equal(fs.readlinkSync(configFile), configTarget);
      assert.equal(fs.readFileSync(configTarget, "utf8"), previousConfig);
      assert.equal(localEndpointCredential(`${local.url}/v1`), undefined);
    } finally {
      await server.shutdown();
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

      await send({ type: "provider.local-cancel", id: "pending-connect" });
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
