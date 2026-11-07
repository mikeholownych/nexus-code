import { test } from "node:test";
import assert from "node:assert/strict";
import { HARNESS_TOOLS } from "../src/core/capabilities.js";
import { GBNF_TOOL_ALLOWLIST } from "../src/core/tool_grammar.js";

test("every strict-schema allow-listed tool is a registered tool", () => {
  const registered = new Set(HARNESS_TOOLS.map((tool) => tool.function.name));
  for (const name of GBNF_TOOL_ALLOWLIST) assert.ok(registered.has(name), `${name} must be a registered tool`);
});
