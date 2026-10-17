// Runs one evaluation candidate behind a namespace-local TCP endpoint and a host-side Unix-socket proxy.
// The candidate sees only the run-scoped local token; the upstream gateway credential stays in run.mjs.
import http from "node:http";
import { spawn } from "node:child_process";

const payload = JSON.parse(await readStdin());
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
const agent = spawn(payload.command, argv, { cwd: "/workspace", env, stdio: ["ignore", "inherit", "inherit"] });
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

function readStdin() {
  return new Promise((resolve, reject) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("sandbox launch payload too large"));
    });
    process.stdin.on("end", () => resolve(body));
    process.stdin.on("error", reject);
  });
}

function closeBridge(exitCode) {
  process.exitCode = exitCode;
  server.closeAllConnections?.();
  server.close();
}
