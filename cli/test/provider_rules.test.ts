import assert from "node:assert/strict";
import test from "node:test";
import { connectionFor, protocolFor, providerDefinition } from "../src/providers.js";

test("protocol rules are data: copilot gpt-5 uses Responses, other models and providers keep their protocol", () => {
  assert.equal(providerDefinition("copilot")?.protocolRules?.[0]?.protocol, "openai-responses");
  assert.equal(protocolFor("copilot", "gpt-5.1-codex"), "openai-responses");
  assert.equal(protocolFor("copilot", "GPT-5"), "openai-responses");
  assert.equal(protocolFor("copilot", "claude-sonnet"), undefined);
  assert.equal(protocolFor("openai", "gpt-5"), undefined);
  assert.equal(connectionFor("copilot", "gpt-5").protocol, "openai-responses");
  assert.equal(connectionFor("copilot", "gpt-4o").protocol, "openai-chat");
});

test("built-in connections carry no header-name auth", () => {
  for (const id of ["openrouter", "openai", "anthropic", "chatgpt", "copilot", "compatible"]) {
    assert.equal(connectionFor(id).authHeader, undefined);
  }
});
