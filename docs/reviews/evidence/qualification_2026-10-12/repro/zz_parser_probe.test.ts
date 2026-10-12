import { test } from "node:test";
import { parseModelResponse } from "../src/parser.js";
test("P1 repairJson on args with literal newlines + Python literals", () => {
  const args = '{"path": "m.py", "content": "x = None\nif True:\n    items = [1, 2,]\n"}';
  const p = parseModelResponse({ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "write_file", arguments: args } }] } as any);
  console.log("OBS P1 " + JSON.stringify(JSON.parse(p.toolCalls[0].function.arguments)));
});
