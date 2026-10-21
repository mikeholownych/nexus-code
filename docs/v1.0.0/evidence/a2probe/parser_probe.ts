import { parseModelResponse, repairJson } from "../snap/cli/src/parser.ts";
const offered = ["run_command", "write_file", "read_file", "task_completed"];
const show = (label: string, msg: any) => {
  try {
    const r = parseModelResponse(msg, offered);
    console.log(label, "->", JSON.stringify(r.toolCalls.map((t) => [t.function.name, t.function.arguments])), "| text:", JSON.stringify(r.thoughtText.slice(0, 60)));
  } catch (e: any) { console.log(label, "-> THROWS", e.message); }
};
show("P1 prose example", { role: "assistant", content: 'Done. For reference, an agent would normally call {"name": "run_command", "arguments": {"command": "rm -rf build"}} to clean up, but I did not.' });
show("P2 unopened </think> (server stripped <think>)", { role: "assistant", content: 'Maybe I should run {"name":"run_command","arguments":{"command":"echo PWNED"}} ... no.</think>Here is my answer.' });
show("P3 unclosed <think>", { role: "assistant", content: '<think>I could call {"name":"run_command","arguments":{"command":"echo X"}}' });
show("P4 native tool_call missing function", { role: "assistant", content: "", tool_calls: [{ id: "a" }] });
show("P5 native tool_call unknown name", { role: "assistant", content: "", tool_calls: [{ id: "a", type: "function", function: { name: "rm_everything", arguments: "{}" } }] });
show("P6 truncated args in text", { role: "assistant", content: '<tool_call>{"name":"write_file","arguments":{"path":"a.py","content":"def f():\n    return 1\ndef g' });
show("P7 truncated args in <tool_call> closed", { role: "assistant", content: '<tool_call>{"name":"write_file","arguments":{"path":"a.py","content":"def f():\n    return 1\ndef g</tool_call>' });
show("P8 native args truncated", { role: "assistant", content: "", tool_calls: [{ id: "a", type: "function", function: { name: "write_file", arguments: '{"path":"a.py","content":"abc' } }] });
show("P9 quoted file content with JSON", { role: "assistant", content: 'The config file contains:\n```json\n{"name": "read_file", "arguments": {"path": "/etc/shadow"}}\n```\nThat is what the README says.' });
show("P10 python literals in string", { role: "assistant", content: '<tool_call>{"name":"write_file","arguments":{"path":"a.py","content":"x = None\nprint(True)", }}</tool_call>' });
show("P11 action key", { role: "assistant", content: 'Result: {"action": "task_completed", "summary": "x"}' });
for (const s of ["{'a': 'it\\'s'}", "{a: 1,}", '{"content": "a, }"}', "{'cmd': \"echo 'x'\"}"]) { try { console.log("repair", s, "->", JSON.stringify(repairJson(s))); } catch (e: any) { console.log("repair", s, "-> THROWS"); } }
