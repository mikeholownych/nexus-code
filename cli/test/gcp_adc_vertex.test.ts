/**
 * PR-8: Google Vertex (Gemini protocol, `gcp-adc` auth). Fixtures and a local mock only, no live call: the service-account
 * JWT assertion, the token cache with an injected clock, the gcloud fallback, URL validation, and one conversation through
 * the client to a mock that serves both the token endpoint and the Vertex path.
 */
import "./helpers/leak_guard.js";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { LocalLlmClient, setCredentialAuthority } from "../src/client.js";
import { GcpAuthError, GcpTokenSource, resolveVertexTarget, setGcpAdcOverrides, vertexOrigin, vertexPath } from "../src/protocols/gcp_adc.js";
import { parseProvidersDocument } from "../src/provider_file.js";
import { setOperatorProviders } from "../src/providers.js";
import { providerBaseUrl } from "../src/config.js";
import { runDoctor } from "../src/doctor.js";
import { UsageLedger } from "../src/usage.js";
import type { HarnessConfig, ToolDefinition } from "../src/types.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const PEM_BODY = privateKey.split("\n").filter((l) => l && !l.startsWith("-----"))[1]!;
const EMAIL = "svc@my-project-1.iam.gserviceaccount.com";
const KEY_JSON = JSON.stringify({ type: "service_account", project_id: "my-project-1", client_email: EMAIL, private_key: privateKey });
const TOKEN = "ya29.fixture-access-token-0123456789";
const TOOLS: ToolDefinition[] = [{ type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];

function tmpFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gcp-"));
  const file = path.join(dir, "key.json");
  fs.writeFileSync(file, content);
  return file;
}
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const form = (init: any) => new URLSearchParams(String(init.body));
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("gcp-adc: service-account assertion", () => {
  test("RS256 JWT with the cloud-platform scope, verifiable with the public key, sent as a jwt-bearer grant", async () => {
    let call: { url: string; init: any } | undefined;
    const src = new GcpTokenSource({
      env: { GOOGLE_APPLICATION_CREDENTIALS: tmpFile(KEY_JSON) },
      now: () => 1_700_000_000_000,
      fetchFn: (async (url: any, init: any) => { call = { url: String(url), init }; return jsonRes(200, { access_token: TOKEN, expires_in: 3600 }); }) as any,
    });
    assert.equal(await src.token(), TOKEN);
    assert.equal(call!.url, "https://oauth2.googleapis.com/token");
    assert.equal(call!.init.method, "POST");
    assert.equal(call!.init.redirect, "error");
    const body = form(call!.init);
    assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, c, s] = body.get("assertion")!.split(".");
    assert.deepEqual(decode(h!), { alg: "RS256", typ: "JWT" });
    assert.deepEqual(decode(c!), { iss: EMAIL, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: 1_700_000_000, exp: 1_700_003_600 });
    assert.equal(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(createPublicKey(publicKey), Buffer.from(s!, "base64url")), true);
  });

  test("an unreadable file, a non-service-account file and a key that cannot sign are errors that never print the key", async () => {
    const env = (file: string) => ({ GOOGLE_APPLICATION_CREDENTIALS: file });
    await assert.rejects(new GcpTokenSource({ env: env("/nonexistent/key.json"), runGcloud: async () => { throw new Error("must not fall back"); } }).token(), (e: Error) => e instanceof GcpAuthError && /cannot read GOOGLE_APPLICATION_CREDENTIALS/.test(e.message));
    await assert.rejects(new GcpTokenSource({ env: env(tmpFile(JSON.stringify({ type: "authorized_user", refresh_token: "r-secret-token" }))) }).token(), (e: Error) => /not a service-account key/.test(e.message) && !e.message.includes("r-secret-token"));
    const bad = JSON.stringify({ type: "service_account", client_email: EMAIL, private_key: "-----BEGIN PRIVATE KEY-----\nQUJDREVGR0hJSktMTU5PUA==\n-----END PRIVATE KEY-----\n" });
    await assert.rejects(new GcpTokenSource({ env: env(tmpFile(bad)), fetchFn: (async () => { throw new Error("unreachable"); }) as any }).token(), (e: Error) => /cannot sign/.test(e.message) && !e.message.includes("QUJDREVGR0hJSktMTU5PUA"));
  });
});

describe("gcp-adc: token cache with an injected clock", () => {
  const mk = () => {
    let t = 1_700_000_000_000;
    let calls = 0;
    let n = 0;
    const src = new GcpTokenSource({
      env: { GOOGLE_APPLICATION_CREDENTIALS: tmpFile(KEY_JSON) },
      now: () => t,
      fetchFn: (async () => { calls++; return jsonRes(200, { access_token: `${TOKEN}-${++n}`, expires_in: 3600 }); }) as any,
    });
    return { src, advance: (ms: number) => { t += ms; }, calls: () => calls };
  };

  test("reused until 60 s before expiry, refreshed after", async () => {
    const { src, advance, calls } = mk();
    assert.equal(await src.token(), `${TOKEN}-1`);
    advance(3_539_000); // 61 s left
    assert.equal(await src.token(), `${TOKEN}-1`);
    assert.equal(calls(), 1);
    advance(2_000); // 59 s left
    assert.equal(await src.token(), `${TOKEN}-2`);
    assert.equal(calls(), 2);
    assert.equal(await src.token(), `${TOKEN}-2`);
    assert.equal(calls(), 2);
  });

  test("concurrent callers share one refresh", async () => {
    const { src, calls } = mk();
    const all = await Promise.all([src.token(), src.token(), src.token(), src.token()]);
    assert.deepEqual(new Set(all), new Set([`${TOKEN}-1`]));
    assert.equal(calls(), 1);
  });

  test("a failed refresh surfaces an error without key material, is not cached, and the next call retries", async () => {
    let fail = true;
    let calls = 0;
    const src = new GcpTokenSource({
      env: { GOOGLE_APPLICATION_CREDENTIALS: tmpFile(KEY_JSON) },
      fetchFn: (async (_u: any, init: any) => {
        calls++;
        if (fail) return jsonRes(400, { error: "invalid_grant", error_description: `bad assertion ${form(init).get("assertion")} ${PEM_BODY}` });
        return jsonRes(200, { access_token: TOKEN, expires_in: 3600 });
      }) as any,
    });
    const results = await Promise.allSettled([src.token(), src.token()]);
    assert.equal(calls, 1, "concurrent callers share the failing refresh too");
    for (const r of results) {
      assert.equal(r.status, "rejected");
      const msg = (r as PromiseRejectedResult).reason.message as string;
      assert.match(msg, /HTTP 400 \(invalid_grant\)/);
      for (const secret of [PEM_BODY, "BEGIN PRIVATE KEY", "eyJ", EMAIL, privateKey]) assert.equal(msg.includes(secret), false, `error must not contain ${secret.slice(0, 12)}`);
    }
    fail = false;
    assert.equal(await src.token(), TOKEN);
    assert.equal(calls, 2);
  });

  test("a network failure and a response without a token are errors", async () => {
    const env = { GOOGLE_APPLICATION_CREDENTIALS: tmpFile(KEY_JSON) };
    await assert.rejects(new GcpTokenSource({ env, fetchFn: (async () => { throw new Error(`connect ${PEM_BODY}`); }) as any }).token(), (e: Error) => /could not be reached/.test(e.message) && !e.message.includes(PEM_BODY));
    await assert.rejects(new GcpTokenSource({ env, fetchFn: (async () => jsonRes(200, { access_token: "short", expires_in: 3600 })) as any }).token(), /no usable access token/);
    await assert.rejects(new GcpTokenSource({ env, fetchFn: (async () => jsonRes(200, { access_token: TOKEN })) as any }).token(), /no usable access token/);
  });
});

describe("gcp-adc: gcloud fallback", () => {
  test("used only when no key file is configured; cached for 30 minutes on the injected clock", async () => {
    let t = 0;
    let runs = 0;
    const src = new GcpTokenSource({ env: {}, now: () => t, runGcloud: async () => { runs++; return `${TOKEN}-${runs}\n`; } });
    assert.equal(await src.token(), `${TOKEN}-1`);
    t = 28 * 60_000;
    assert.equal(await src.token(), `${TOKEN}-1`);
    t = 29.5 * 60_000; // inside the 60 s skew of the 30 minute trust window
    assert.equal(await src.token(), `${TOKEN}-2`);
  });

  test("failure and unusable output give a message without the child's output", async () => {
    await assert.rejects(new GcpTokenSource({ env: {}, runGcloud: async () => { throw new Error("ERROR: secret-detail"); } }).token(), (e: Error) => /gcloud auth login/.test(e.message) && !e.message.includes("secret-detail"));
    await assert.rejects(new GcpTokenSource({ env: {}, runGcloud: async () => "not a token\n" }).token(), /no usable access token/);
    await assert.rejects(new GcpTokenSource({ env: {}, runGcloud: async () => "" }).token(), /no usable access token/);
  });

  describe("the real child process", () => {
    let dir: string;
    let savedPath: string | undefined;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gcloud-"));
      savedPath = process.env.PATH;
      process.env.PATH = `${dir}:${savedPath}`;
    });
    afterEach(() => { process.env.PATH = savedPath; });
    const fake = (script: string) => { const f = path.join(dir, "gcloud"); fs.writeFileSync(f, `#!/bin/sh\n${script}\n`, { mode: 0o755 }); };

    test("spawned without a shell with the fixed arguments", async () => {
      fake(`[ "$1 $2" = "auth print-access-token" ] && [ "$#" = 2 ] && echo ${TOKEN}-child`);
      assert.equal(await new GcpTokenSource({ env: {} }).token(), `${TOKEN}-child`);
    });

    test("a child that outlives the time bound is killed and reported", async () => {
      fake("sleep 30");
      const started = Date.now();
      await assert.rejects(new GcpTokenSource({ env: {}, gcloudTimeoutMs: 300 }).token(), /gcloud auth login/);
      assert.ok(Date.now() - started < 10_000);
    });
  });
});

describe("vertex: URL validation", () => {
  test("project and location come from the environment; the key file supplies the project only when the variable is unset", () => {
    assert.deepEqual(resolveVertexTarget({ GOOGLE_CLOUD_PROJECT: "env-project-1", GOOGLE_CLOUD_LOCATION: "us-central1" }), { project: "env-project-1", location: "us-central1" });
    const file = tmpFile(KEY_JSON);
    assert.deepEqual(resolveVertexTarget({ GOOGLE_APPLICATION_CREDENTIALS: file, GOOGLE_CLOUD_LOCATION: "europe-west4" }), { project: "my-project-1", location: "europe-west4" });
    assert.equal(resolveVertexTarget({ GOOGLE_APPLICATION_CREDENTIALS: file, GOOGLE_CLOUD_PROJECT: "env-project-1", GOOGLE_CLOUD_LOCATION: "global" }).project, "env-project-1");
  });

  test("a location or project that could change the host or path is rejected", () => {
    const ok = { GOOGLE_CLOUD_PROJECT: "my-project-1", GOOGLE_CLOUD_LOCATION: "us-central1" };
    for (const loc of ["evil.com/x", "us-central1.evil.com", "a@b", "US-CENTRAL1", "us central", "a#b", "a?b", "a/b", "../x"]) {
      assert.throws(() => resolveVertexTarget({ ...ok, GOOGLE_CLOUD_LOCATION: loc }), /GOOGLE_CLOUD_LOCATION/, JSON.stringify(loc));
      assert.throws(() => vertexOrigin(loc), /GOOGLE_CLOUD_LOCATION/, JSON.stringify(loc));
    }
    assert.throws(() => vertexOrigin("us-central1\n"), /GOOGLE_CLOUD_LOCATION/, "a trailing newline");
    for (const project of ["Bad-Project", "1project", "abc", "a".repeat(31), "proj/../x", "my-project-", "my.project-1", "my-project-1/x"]) {
      assert.throws(() => resolveVertexTarget({ ...ok, GOOGLE_CLOUD_PROJECT: project }), /project id is not valid/, project);
    }
    assert.throws(() => resolveVertexTarget({ GOOGLE_CLOUD_PROJECT: "my-project-1" }), /GOOGLE_CLOUD_LOCATION/);
    assert.throws(() => resolveVertexTarget({ GOOGLE_CLOUD_LOCATION: "us-central1" }), /no Vertex project/);
  });

  test("regional and global hosts; the path carries project and location", () => {
    assert.equal(vertexOrigin("us-central1"), "https://us-central1-aiplatform.googleapis.com");
    assert.equal(vertexOrigin("global"), "https://aiplatform.googleapis.com");
    assert.equal(vertexPath("/models/gemini-2.5-pro:generateContent", { project: "my-project-1", location: "us-central1" }), "/v1/projects/my-project-1/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent");
  });

  test("providers.json: gcp-adc needs no credentialEnv and no baseUrl, but only for the Gemini protocol", () => {
    const [def] = parseProvidersDocument({ providers: { vertex: { label: "Vertex", protocol: "gemini-generate-content", auth: "gcp-adc" } } });
    assert.equal(def!.auth, "gcp-adc");
    assert.equal(def!.credentialEnv, undefined);
    assert.deepEqual(def!.methods, []);
    assert.throws(() => parseProvidersDocument({ providers: { vertex: { label: "Vertex", protocol: "openai-chat", auth: "gcp-adc" } } }), /gemini-generate-content/);
    assert.throws(() => parseProvidersDocument({ providers: { vertex: { label: "Vertex", protocol: "gemini-generate-content", auth: "bearer" } } }), /credentialEnv/);
  });
});

describe("vertex: configuration", () => {
  const saved = process.env.GOOGLE_CLOUD_LOCATION;
  afterEach(() => { setOperatorProviders([]); if (saved === undefined) delete process.env.GOOGLE_CLOUD_LOCATION; else process.env.GOOGLE_CLOUD_LOCATION = saved; });
  const declare = () => setOperatorProviders(parseProvidersDocument({ providers: { vertex: { label: "Vertex", protocol: "gemini-generate-content", auth: "gcp-adc" } } }));

  test("the default base URL is the regional host from GOOGLE_CLOUD_LOCATION; an explicit URL wins; a bad location is refused", () => {
    declare();
    process.env.GOOGLE_CLOUD_LOCATION = "europe-west4";
    assert.equal(providerBaseUrl("vertex"), "https://europe-west4-aiplatform.googleapis.com");
    process.env.GOOGLE_CLOUD_LOCATION = "global";
    assert.equal(providerBaseUrl("vertex"), "https://aiplatform.googleapis.com");
    assert.equal(providerBaseUrl("vertex", "https://proxy.example.com"), "https://proxy.example.com");
    process.env.GOOGLE_CLOUD_LOCATION = "evil.com/x";
    assert.throws(() => providerBaseUrl("vertex"), /GOOGLE_CLOUD_LOCATION/);
    delete process.env.GOOGLE_CLOUD_LOCATION;
    assert.throws(() => providerBaseUrl("vertex"), /needs a base URL.*GOOGLE_CLOUD_LOCATION/);
  });

  test("nexus doctor does not report a gcp-adc provider as missing a credential", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vertex-doctor-"));
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      declare();
      const found = (await runDoctor({ home, timeoutMs: 1500, config: { endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 30, temperature: 0, workspace: home, shell: "bash" } as HarnessConfig })).findings.find((f) => f.id === "config.providers_file")!;
      assert.equal(found.status, "pass");
    } finally {
      process.env.HOME = savedHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("vertex: a conversation through the client", () => {
  let server: http.Server;
  let origin: string;
  let seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: any }>;
  let tokenStatus: number;
  const ENV_KEYS = ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    seen = [];
    tokenStatus = 200;
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    UsageLedger.resetGlobal();
    UsageLedger.global().limits = {};
    setCredentialAuthority({}, fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vertex-home-")));
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen.push({ url: req.url!, headers: req.headers, body: raw ? (req.url === "/token" ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw)) : undefined });
        if (req.url === "/token") {
          res.writeHead(tokenStatus, { "Content-Type": "application/json" });
          res.end(JSON.stringify(tokenStatus === 200 ? { access_token: TOKEN, expires_in: 3600 } : { error: "invalid_grant", error_description: PEM_BODY }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args: { path: "a.txt" } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } })}\r\n\r\n`);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    setGcpAdcOverrides({ tokenUrl: `${origin}/token` });
    setOperatorProviders(parseProvidersDocument({ providers: { vertex: { label: "Vertex AI", protocol: "gemini-generate-content", auth: "gcp-adc", baseUrl: origin } } }, [origin]));
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpFile(KEY_JSON);
    process.env.GOOGLE_CLOUD_PROJECT = "my-project-1";
    process.env.GOOGLE_CLOUD_LOCATION = "us-central1";
  });
  afterEach(async () => {
    setOperatorProviders([]);
    setGcpAdcOverrides({});
    for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    UsageLedger.resetGlobal();
    await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  });

  const client = () => new LocalLlmClient({ provider: "vertex", endpoint: origin, model: "gemini-2.5-pro", maxSteps: 2, workspace: os.tmpdir(), shell: "bash" } as HarnessConfig);
  const ask = (c: LocalLlmClient) => c.chatCompletionStream([{ role: "system", content: "sys" }, { role: "user", content: "read it" }], TOOLS, undefined, "req-vertex");

  test("token exchange, bearer token, Vertex publisher path with project and location, tool call returned", async () => {
    const c = client();
    const out = await ask(c);
    assert.equal(out.tool_calls?.[0]?.function.name, "read_file");
    assert.deepEqual(seen.map((s) => s.url), ["/token", "/v1/projects/my-project-1/locations/us-central1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse"]);
    const api = seen[1]!;
    assert.equal(api.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(api.headers["x-goog-api-key"], undefined);
    assert.ok(Array.isArray(api.body.contents));
    assert.equal(seen[0]!.body.grant_type, "urn:ietf:params:oauth:grant-type:jwt-bearer");
    // The key, the assertion and the token reach only the token endpoint (assertion) or the API's Authorization header (token).
    const wire = JSON.stringify(seen.slice(1).map((s) => ({ u: s.url, b: s.body, h: { ...s.headers, authorization: undefined } })));
    for (const secret of [PEM_BODY, seen[0]!.body.assertion, TOKEN]) assert.equal(wire.includes(secret), false);
    // A second request reuses the cached token.
    await ask(c);
    assert.equal(seen.filter((s) => s.url === "/token").length, 1);
  });

  test("a failed token exchange is a typed configuration error with no key material, and no request leaves for the API", async () => {
    tokenStatus = 400;
    await assert.rejects(ask(client()), (e: any) => {
      const text = `${e.message} ${JSON.stringify(e)}`;
      assert.equal(e.kind, "configuration_error");
      assert.match(e.message, /Cannot authenticate to Vertex AI: .*HTTP 400 \(invalid_grant\)/);
      for (const secret of [PEM_BODY, "BEGIN PRIVATE KEY", seen[0]!.body.assertion]) assert.equal(text.includes(secret), false);
      return true;
    });
    assert.deepEqual(seen.map((s) => s.url), ["/token"]);
  });

  test("an invalid location is refused before anything is sent", async () => {
    process.env.GOOGLE_CLOUD_LOCATION = "evil.com/x";
    await assert.rejects(ask(client()), (e: any) => e.kind === "configuration_error" && /GOOGLE_CLOUD_LOCATION/.test(e.message));
    assert.ok(seen.every((s) => s.url === "/token"), "no content request left");
  });
});
