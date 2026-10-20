import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Command } from "commander";
import { credentialStorageHome, operatorSetting, setCredentialAuthority } from "../src/client.js";
import type { HarnessConfig } from "../src/types.js";
import { describeTarget, registerProviderCommands, verificationSummary } from "../src/provider_cli.js";

test("provider destination display omits endpoint credentials and unsafe model ids", () => {
  const display = describeTarget({
    provider: "compatible",
    endpoint: "https://user:sk-test-secret@inference.example/v1/private?token=query-secret",
    model: "invalid model-secret-value",
    cloudRoutedOrigins: [],
  } as HarnessConfig);

  assert.match(display, /https:\/\/inference\.example/);
  assert.match(display, /\(unprintable model id\)/);
  assert.doesNotMatch(display, /sk-test-secret|query-secret|private|model-secret-value|user/);
});

test("provider destination display never falls back to a raw invalid endpoint", () => {
  const display = describeTarget({
    endpoint: "malformed-endpoint-secret",
    model: "model-secret-value",
    cloudRoutedOrigins: [],
  } as HarnessConfig);

  assert.match(display, /endpoint unavailable/);
  assert.match(display, /model-secret-value/);
  assert.doesNotMatch(display, /malformed-endpoint-secret/);
});

test("provider destination display redacts credential-shaped hostname labels and keeps origin attribution", () => {
  const display = describeTarget({
    provider: "compatible",
    endpoint: "https://sk-test-secret-label.inference.example:8443/v1/private?token=query-secret",
    model: "safe-model",
    cloudRoutedOrigins: [],
  } as HarnessConfig);

  assert.match(display, /https:\/\/\(redacted\)\.inference\.example:8443/);
  assert.match(display, /safe-model/);
  assert.doesNotMatch(display, /sk-test-secret-label|query-secret|private/);
});

test("provider destination display redacts URL-normalized AWS, Google and JWT hostname credentials", () => {
  const credentialHosts = [
    "AKIA1234567890ABCDEF.inference.example",
    "AIza12345678901234567890123456789012345.inference.example",
    "ya29.123456789012345678901234.inference.example",
    "eyJabcdefghij.eyJabcdefghij.eyJabcdefghij.inference.example",
  ];
  for (const hostname of credentialHosts) {
    const display = describeTarget({
      provider: "compatible",
      endpoint: `https://${hostname}:8443/v1`,
      model: "safe-model",
      cloudRoutedOrigins: [],
    } as HarnessConfig);
    assert.match(display, /https:\/\//);
    assert.match(display, /safe-model/);
    assert.doesNotMatch(display, /AKIA1234567890ABCDEF|AIza12345678901234567890123456789012345|ya29\.123456789012345678901234|eyJabcdefghij/i);
  }
});

test("providers list captures redacted endpoint and authorized origins on stdout and stderr", async () => {
  const secretOrigin = "https://sk-test-secret-label.inference.example:8443";
  const previousExitCode = process.exitCode;
  const previousLog = console.log;
  const previousError = console.error;
  const previousCompatibleAuth = operatorSetting("NEXUS_COMPATIBLE_AUTH");
  const previousCredentialHome = credentialStorageHome();
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    setCredentialAuthority({
      NEXUS_COMPATIBLE_BASE_URL: `${secretOrigin}/v1/private?token=query-secret`,
      NEXUS_CLOUD_DISCLOSURE_ORIGINS: secretOrigin,
    });
    console.log = (...values: unknown[]) => stdout.push(values.join(" "));
    console.error = (...values: unknown[]) => stderr.push(values.join(" "));
    const program = new Command();
    program.exitOverride();
    registerProviderCommands(program);
    await program.parseAsync(["node", "nexus", "providers"]);

    assert.match(stdout.join("\n"), /https:\/\/\(redacted\)\.inference\.example:8443/);
    assert.match(stdout.join("\n"), /Authorized cloud destinations/);
    assert.doesNotMatch(stdout.join("\n"), /sk-test-secret-label|query-secret|private/);
    assert.doesNotMatch(stderr.join("\n"), /sk-test-secret-label|query-secret|private/);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.exitCode = previousExitCode;
    setCredentialAuthority({ NEXUS_COMPATIBLE_AUTH: previousCompatibleAuth }, previousCredentialHome);
  }
});

test("providers list preserves safe unknown-provider diagnostics and redacts credential-shaped IDs", async () => {
  const previousExitCode = process.exitCode;
  const previousLog = console.log;
  const previousError = console.error;
  const previousCompatibleAuth = operatorSetting("NEXUS_COMPATIBLE_AUTH");
  const previousCredentialHome = credentialStorageHome();
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    console.log = (...values: unknown[]) => stdout.push(values.join(" "));
    console.error = (...values: unknown[]) => stderr.push(values.join(" "));
    for (const provider of ["no-such-provider", "sk-test-secret-provider"]) {
      setCredentialAuthority({ NEXUS_PROVIDER: provider });
      const program = new Command();
      program.exitOverride();
      registerProviderCommands(program);
      await program.parseAsync(["node", "nexus", "providers"]);
    }

    assert.match(stdout.join("\n"), /Unknown provider 'no-such-provider'/);
    assert.match(stdout.join("\n"), /Unknown provider '\(unrecognized provider\)'/);
    assert.doesNotMatch(stdout.join("\n"), /sk-test-secret-provider/);
    assert.doesNotMatch(stderr.join("\n"), /sk-test-secret-provider/);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.exitCode = previousExitCode;
    setCredentialAuthority({ NEXUS_COMPATIBLE_AUTH: previousCompatibleAuth }, previousCredentialHome);
  }
});

test("providers verify captures safe JSON on stdout and keeps provider diagnostics off stderr", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Bearer sk-test-secret from provider" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const previousExitCode = process.exitCode;
  const previousLog = console.log;
  const previousError = console.error;
  const previousCompatibleAuth = operatorSetting("NEXUS_COMPATIBLE_AUTH");
  const previousCredentialHome = credentialStorageHome();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const model = "sk-test-secret-model";
  try {
    setCredentialAuthority({ NEXUS_COMPATIBLE_AUTH: "none" });
    console.log = (...values: unknown[]) => stdout.push(values.join(" "));
    console.error = (...values: unknown[]) => stderr.push(values.join(" "));
    const program = new Command();
    program.exitOverride();
    registerProviderCommands(program);
    await program.parseAsync([
      "node", "nexus", "providers", "verify", "--provider", "compatible", "--model", model,
      "--base-url", `http://127.0.0.1:${address.port}/v1/private?token=query-secret`, "--json",
    ]);

    const output = JSON.parse(stdout.join("\n"));
    assert.equal(output.model, "(unprintable model id)");
    assert.equal(output.receipts[0].endpointOrigin, `http://127.0.0.1:${address.port}`);
    assert.equal(output.steps[0].detail, "Provider request failed");
    assert.doesNotMatch(stdout.join("\n"), /sk-test-secret|query-secret|private|Bearer/);
    assert.doesNotMatch(stderr.join("\n"), /sk-test-secret|query-secret|private|Bearer/);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.exitCode = previousExitCode;
    setCredentialAuthority({ NEXUS_COMPATIBLE_AUTH: previousCompatibleAuth }, previousCredentialHome);
    server.close();
  }
});

test("verification JSON keeps outcome and usage while omitting raw diagnostics and sensitive receipt fields", () => {
  const report = verificationSummary([
    { step: "streamed completion", ok: true, detail: "streamed completion received (5 chars)", requestId: "request-1" },
    { step: "tool call", ok: false, detail: "Provider request failed", failureKind: "http_error", failureCondition: "AUTH_FAILURE", requestId: "request-2" },
  ], [
    {
      at: "2026-10-19T00:00:00.000Z",
      requestId: "request-1",
      role: "qualification",
      providerId: "openrouter",
      selectedModel: "vendor/model:release-1",
      effectiveModel: "vendor/model:release-1.2",
      endpointOrigin: "https://user:sk-test-secret@inference.example/v1/private?token=query-secret",
      protocol: "openai-chat",
      disclosure: "cloud",
      outcome: "completed",
      usage: { inputTokens: 12, outputTokens: 3 },
      usageConfidence: "provider",
      costConfidence: "unknown",
    },
  ] as any, { provider: "openrouter", model: "vendor/model:release-1" });

  const serialized = JSON.stringify(report);
  assert.equal(report.passed, false);
  assert.equal(report.provider, "openrouter");
  assert.equal(report.model, "vendor/model:release-1");
  assert.equal(report.steps[0].ok, true);
  assert.equal(report.steps[1].failureKind, "http_error");
  assert.equal(report.steps[1].condition, "AUTH_FAILURE");
  assert.equal(report.receipts[0].providerId, "openrouter");
  assert.equal(report.receipts[0].selectedModel, "vendor/model:release-1");
  assert.equal(report.receipts[0].effectiveModel, "vendor/model:release-1.2");
  assert.equal(report.receipts[0].endpointOrigin, "https://inference.example");
  assert.equal(report.receipts[0].usage?.inputTokens, 12);
  assert.doesNotMatch(serialized, /sk-test-secret|query-secret|private|user|detail.*Bearer/);
});

test("verification JSON replaces malformed provider and model identifiers", () => {
  const report = verificationSummary([], [{
    at: "2026-10-19T00:00:00.000Z",
    requestId: "request-1",
    role: "qualification",
    providerId: "provider-secret-value",
    selectedModel: "model-secret-value with whitespace",
    effectiveModel: "Bearer sk-test-secret",
    endpointOrigin: "not a URL with secret",
    protocol: "openai-chat",
    disclosure: "cloud",
    outcome: "failed",
    usageConfidence: "none",
    costConfidence: "unknown",
  } as any]);

  assert.equal(report.receipts[0].providerId, "(unrecognized provider)");
  assert.equal(report.receipts[0].selectedModel, "(unprintable model id)");
  assert.equal(report.receipts[0].effectiveModel, "(unprintable model id)");
  assert.doesNotMatch(JSON.stringify(report), /provider-secret-value|model-secret-value|sk-test-secret|not a URL/);
});

test("verification JSON redacts credential-shaped model identifiers and path segments", () => {
  const credentials = [
    "sk-test-secret",
    "ghp_123456789012345678901234567890",
    "AKIA1234567890ABCDEF",
    "vendor/sk-test-secret",
    "vendor/ghp_123456789012345678901234567890",
  ];
  for (const credential of credentials) {
    const report = verificationSummary([], [{
      at: "2026-10-19T00:00:00.000Z",
      requestId: "request-1",
      role: "qualification",
      providerId: "openrouter",
      selectedModel: "vendor/model-1",
      effectiveModel: credential,
      endpointOrigin: "https://inference.example",
      protocol: "openai-chat",
      disclosure: "cloud",
      outcome: "completed",
      failureKind: "Bearer sk-test-secret",
      usageConfidence: "none",
      costConfidence: "unknown",
    } as any]);
    assert.equal(report.receipts[0].effectiveModel, "(unprintable model id)");
    assert.equal(report.receipts[0].failureKind, undefined);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(credential));
  }

  const target = verificationSummary([], [], { provider: "openrouter", model: "vendor/sk-test-secret" });
  assert.equal(target.model, "(unprintable model id)");
  assert.doesNotMatch(JSON.stringify(target), /vendor\/sk-test-secret/);
});

test("verification JSON preserves only known failure classifications and safe detail", () => {
  const report = verificationSummary([{
    step: "tool call",
    ok: false,
    detail: "Bearer sk-test-secret",
    failureKind: "Bearer sk-test-secret",
    failureCondition: "Authorization: sk-test-secret",
    requestId: "request-1",
  }], []);

  assert.equal(report.steps[0].detail, "Verification failed");
  assert.equal(report.steps[0].failureKind, undefined);
  assert.equal(report.steps[0].condition, undefined);
  assert.doesNotMatch(JSON.stringify(report), /sk-test-secret|Bearer|Authorization/);
});
