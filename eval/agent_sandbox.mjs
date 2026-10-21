// Runs one evaluation candidate behind a namespace-local TCP endpoint and a host-side Unix-socket proxy.
// The candidate sees only the run-scoped local token; the upstream gateway credential stays in run.mjs.
import http from "node:http";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

// The launch payload is the first stdin line. With payload.protocol the rest of stdin is the agent's stdin (the T3
// sidecar protocol); otherwise the agent gets no stdin.
const payload = JSON.parse(await readPayloadLine());
const port = 40127; // private to this network namespace; no host listener uses this port
const server = http.createServer((req, res) => {
  const upstream = http.request({ socketPath: "/run/eval-proxy/proxy.sock", agent: new http.Agent({ keepAlive: false }), method: req.method, path: req.url, headers: { ...req.headers, host: "eval-proxy", connection: "close" } }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
    response.once("end", () => upstream.destroy());
  });
  upstream.on("error", (error) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "proxy_unavailable", message: "evaluation proxy unavailable" } }));
  });
  req.pipe(upstream);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});

const endpoint = `http://127.0.0.1:${port}/v1`;
const env = { ...payload.env };
for (const [key, value] of Object.entries(env)) {
  if (typeof value === "string") env[key] = value.replaceAll("{{EVAL_ENDPOINT}}", endpoint);
}
const argv = payload.argv.map((value) => value.replaceAll("{{EVAL_ENDPOINT}}", endpoint));
const agent = spawn(payload.command, argv, { cwd: "/workspace", env, stdio: [payload.protocol ? "pipe" : "ignore", "inherit", "inherit"] });
if (payload.protocol) {
  agent.stdin.on("error", () => {});
  process.stdin.pipe(agent.stdin);
  process.stdin.resume();
}
let stopping = false;
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  try { process.kill(-agent.pid, signal); } catch { agent.kill(signal); }
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
agent.on("error", (error) => {
  process.stderr.write(`candidate spawn failed: ${error.message}\n`);
  closeBridge(127);
});
agent.on("close", (code, signal) => {
  closeBridge(code ?? (signal ? 128 : 1));
});

/** Reads stdin up to the first newline (or its end); anything after the newline is put back for the agent. */
function readPayloadLine() {
  return new Promise((resolve, reject) => {
    let body = "";
    const decoder = new StringDecoder("utf8");
    const onData = (chunk) => {
      body += decoder.write(chunk);
      if (body.length > 1_000_000) { cleanup(); reject(new Error("sandbox launch payload too large")); return; }
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      process.stdin.pause();
      const rest = body.slice(newline + 1);
      if (rest) process.stdin.unshift(Buffer.from(rest, "utf8"));
      resolve(body.slice(0, newline));
    };
    const onEnd = () => { cleanup(); resolve(body); };
    const cleanup = () => { process.stdin.off("data", onData); process.stdin.off("end", onEnd); process.stdin.off("error", reject); };
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", reject);
  });
}

function closeBridge(exitCode) {
  process.exitCode = exitCode;
  server.closeAllConnections?.();
  server.close();
}
