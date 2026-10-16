// A per-run forwarder between an agent and the model endpoint. Every agent reaches the model through it the same way,
// so the harness itself observes whether the model was reachable during a run (REQ-QUAL-106): how many requests were
// made, how many got an answer, and how many failed upstream (connection errors and 502/503/504 from the endpoint).
// Bodies are streamed through unchanged; nothing is logged. It is also where fault injection hooks in (SPEC-10 §3).
import http from "node:http";
import https from "node:https";
import fs from "node:fs";

const UPSTREAM_DOWN = new Set([502, 503, 504]);

/**
 * Starts a forwarder on 127.0.0.1 for `upstream` (e.g. https://gateway:8443/v1). Returns its base URL (same path as
 * the upstream), live counters, and close().
 */
export async function startModelProxy({ upstream, caFile }) {
  const target = new URL(upstream);
  const client = target.protocol === "https:" ? https : http;
  const ca = caFile ? fs.readFileSync(caFile) : undefined;
  const stats = { requests: 0, answered: 0, upstreamFailures: 0, firstRequestAt: null, firstAnswerAt: null };

  const server = http.createServer((req, res) => {
    stats.requests++;
    stats.firstRequestAt ??= new Date().toISOString();
    const out = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        method: req.method,
        // The agent was given the proxy's URL with the upstream's path, so the request path is already the upstream's.
        path: req.url,
        headers: { ...req.headers, host: target.host },
        ca,
      },
      (upstreamRes) => {
        if (UPSTREAM_DOWN.has(upstreamRes.statusCode ?? 0)) stats.upstreamFailures++;
        else {
          stats.answered++;
          stats.firstAnswerAt ??= new Date().toISOString();
        }
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    out.on("error", (err) => {
      stats.upstreamFailures++;
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `model proxy: upstream unreachable (${err.code ?? err.message})` } }));
    });
    req.pipe(out);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}${target.pathname.replace(/\/$/, "")}`;
  return {
    url,
    stats: () => ({ ...stats }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Whether a run failed on infrastructure, by the same rule for every agent: the model never answered and the endpoint
 * was observed failing. A run in which the model answered is scored, whatever the agent then did (a crash counts as
 * a failure, not a rerun).
 */
export function isInfrastructureFailure(record) {
  if (record.error) return true;
  const m = record.model;
  return Boolean(m) && m.answered === 0 && m.upstreamFailures > 0;
}
