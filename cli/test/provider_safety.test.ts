import assert from "node:assert/strict";
import test from "node:test";
import { expandUrlTemplate, redactableHeaderNames, validateBaseUrl, validateExtraHeaders, validateProviderId } from "../src/provider_safety.js";

test("provider ids follow a strict grammar", () => {
  assert.equal(validateProviderId("azure-openai"), "azure-openai");
  for (const bad of ["", "Azure", "1abc", "a_b", "a b", "a".repeat(33), "../x", "a\nb", 5, undefined]) {
    assert.throws(() => validateProviderId(bad), /id: must be/);
  }
});

test("base URLs: https required for public hosts, no userinfo or fragment, local http allowed", () => {
  assert.equal(validateBaseUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
  assert.equal(validateBaseUrl("http://127.0.0.1:8080/v1"), "http://127.0.0.1:8080/v1");
  assert.throws(() => validateBaseUrl("http://api.example.com/v1"), /baseUrl: http is allowed only for local/);
  assert.throws(() => validateBaseUrl("https://user:pw@api.example.com"), /credentials in the URL/);
  assert.throws(() => validateBaseUrl("https://api.example.com/#x"), /fragment/);
  assert.throws(() => validateBaseUrl("ftp://api.example.com"), /only http and https/);
  assert.throws(() => validateBaseUrl("not a url"), /not a valid absolute URL/);
  assert.throws(() => validateBaseUrl("", "providers.x.baseUrl"), /providers\.x\.baseUrl: a URL is required/);
});

test("template variables cannot redirect the host, path or query", () => {
  const t = "https://{resource}.openai.azure.com/openai/deployments/{deployment}";
  assert.equal(expandUrlTemplate(t, { resource: "acme", deployment: "gpt-4o" }), "https://acme.openai.azure.com/openai/deployments/gpt-4o");
  for (const bad of ["evil.com/x", "a@b", "a/b", "a?b=1", "a#b", "a b", "", "..", "-x"]) {
    assert.throws(() => expandUrlTemplate(t, { resource: bad, deployment: "d" }), /\{resource\}/);
  }
  assert.throws(() => expandUrlTemplate(t, { resource: "acme" }), /\{deployment\} has no value/);
});

test("extra headers cannot override routing, framing or credentials, and reject injection", () => {
  assert.deepEqual(validateExtraHeaders({ "X-Title": "Nexus" }), { "X-Title": "Nexus" });
  for (const h of ["Host", "content-length", "Authorization", "X-API-Key", "api-key", "Cookie", "X-Forwarded-For"]) {
    assert.throws(() => validateExtraHeaders({ [h]: "v" }), /headers\./);
  }
  assert.throws(() => validateExtraHeaders({ "X-A": "v\r\nHost: evil" }), /without line breaks/);
  assert.throws(() => validateExtraHeaders({ "bad name": "v" }), /not a valid header name/);
  assert.throws(() => validateExtraHeaders([]), /must be an object/);
});

test("operator-declared header names join the redaction list lowercased", () => {
  assert.deepEqual(redactableHeaderNames("API-Key", { "X-Title": "n" }).sort(), ["api-key", "x-title"]);
});

test("a configured provider base URL with embedded credentials is refused", async () => {
  const { providerBaseUrl } = await import("../src/config.js");
  assert.throws(() => providerBaseUrl("compatible", "https://user:secret@api.example.com/v1"), /must not contain credentials/);
  assert.equal(providerBaseUrl("compatible", "https://api.example.com/v1/"), "https://api.example.com/v1");
});
