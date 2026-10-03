// Deterministic fake OpenAI-compatible gateway for Nexus client-behaviour probes.
// usage: node fakegw.mjs <port> <scenario> <logfile>
import http from "node:http";
import fs from "node:fs";
const [, , port, scenario, logfile] = process.argv;
let n = 0;
const log = (o) => fs.appendFileSync(logfile, JSON.stringify(o) + "\n");
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
function toolCall(name, args, id = "call_" + n) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}
http.createServer((req, res) => {
  if (req.url.endsWith("/models")) {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ data: [{ id: "engineering/b0" }] }));
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    n++;
    let j = {};
    try { j = JSON.parse(body); } catch {}
    const stream = !!j.stream;
    log({ n, bytes: body.length, ntools: (j.tools||[]).length, t: Date.now(), stream, msgs: (j.messages || []).length, hdr: { tc: req.headers["x-task-class"], rid: req.headers["x-request-id"] }, last: (j.messages || []).slice(-1)[0]?.role });
    const lastUser = [...(j.messages || [])].reverse().find((m) => m.role === "user")?.content || "";
    const reply = (msg, finish = "stop") => {
      if (!stream) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ id: "x", choices: [{ index: 0, message: msg, finish_reason: finish }] })); }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (msg.content) sse(res, { choices: [{ index: 0, delta: { content: msg.content } }] });
      (msg.tool_calls || []).forEach((tc, i) => sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: tc.function }] } }] }));
      sse(res, { choices: [{ index: 0, delta: {}, finish_reason: finish }] });
      res.write("data: [DONE]\n\n"); res.end();
    };
    if (scenario === "http500") { res.statusCode = 500; return res.end('{"error":"boom"}'); }
    if (scenario === "loop") return reply({ role: "assistant", content: null, tool_calls: [toolCall("list_dir", { path: "." })] });
    if (scenario === "echo") {
      // step 1 of every user prompt -> one read tool call; after tool result -> plain text final answer
      const lastRole = (j.messages || []).slice(-1)[0]?.role;
      if (lastRole === "tool") return reply({ role: "assistant", content: "FINAL for: " + String(lastUser).slice(0, 40) });
      return reply({ role: "assistant", content: null, tool_calls: [toolCall("list_dir", { path: "." })] });
    }
    if (scenario === "slow") {
      // 6s before answering; used to probe input handling / Ctrl-C during a run
      setTimeout(() => reply({ role: "assistant", content: "SLOW-DONE for: " + String(lastUser).slice(0, 30) }), 6000);
      return;
    }
    if (scenario === "slowloop") {
      // every step: wait 2s then write a distinct file; never finishes
      setTimeout(() => reply({ role: "assistant", content: null, tool_calls: [toolCall("write_file", { path: "loop_" + n + ".txt", content: "step " + n })] }), 2000);
      return;
    }
    if (scenario === "falseclear") {
      const calls = (j.messages || []).filter((m) => m.role === "assistant").length;
      if (calls === 0) return reply({ role: "assistant", content: null, tool_calls: [toolCall("write_file", { path: "x.txt", content: "BROKEN CODE" })] });
      if (calls === 1) return reply({ role: "assistant", content: null, tool_calls: [toolCall("run_command", { command: "echo checking tests" })] });
      if (calls === 2) return reply({ role: "assistant", content: null, tool_calls: [toolCall("task_completed", { summary: "all done, tests pass" }, "call_tc9")] });
      return reply({ role: "assistant", content: "bye" });
    }
    if (scenario === "truncstream") {
      // stream a partial answer, then stall forever (client timeout set small by env)
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, { choices: [{ index: 0, delta: { content: "I have refactored the module and all tests pa" } }] });
      return; // never ends
    }
    if (scenario === "midstreamerror") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, { choices: [{ index: 0, delta: { content: "Partial answer before provider error" } }] });
      res.write(`data: ${JSON.stringify({ error: { message: "worker crashed", type: "server_error" } })}\n\n`);
      return res.end();
    }
    if (scenario === "noverify") {
      // write a file then claim completion with task_completed (no tests exist in workspace)
      const lastRole = (j.messages || []).slice(-1)[0]?.role;
      const calls = (j.messages || []).filter((m) => m.role === "assistant").length;
      if (calls === 0) return reply({ role: "assistant", content: null, tool_calls: [toolCall("write_file", { path: "x.txt", content: "hello" })] });
      if (calls === 1) return reply({ role: "assistant", content: null, tool_calls: [toolCall("task_completed", { summary: "done" }, "call_tc1")] });
      return reply({ role: "assistant", content: "I could not verify; stopping." });
    }
    reply({ role: "assistant", content: "ok" });
  });
}).listen(+port, "127.0.0.1", () => console.log("fakegw up", port, scenario));
