import { test } from "node:test";
import assert from "node:assert/strict";
import { HARNESS_TOOLS } from "../src/core/capabilities.js";
import * as grammar from "../src/core/tool_grammar.js";

test("the strict-schema allow-list names registered tools and no unwired GBNF compiler ships (WP-1303)", () => {
  const registered = new Set(HARNESS_TOOLS.map((tool) => tool.function.name));
  for (const name of grammar.GBNF_TOOL_ALLOWLIST) assert.ok(registered.has(name), `${name} must be a registered tool`);
  assert.deepEqual(Object.keys(grammar).sort(), ["GBNF_TOOL_ALLOWLIST"], "the compiler had no runtime caller and was removed");
});
