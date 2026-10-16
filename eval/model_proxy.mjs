// A per-run forwarder between an agent and the model endpoint. Every agent reaches the model through it the same way,
// so the harness itself observes whether the model was reachable during a run (REQ-QUAL-106): how many requests were
// made, how many got an answer, and how many failed upstream (connection errors and 502/503/504 from the endpoint).
// Bodies are streamed through unchanged unless a fault is scheduled for a request (T4, REQ-QUAL-105); nothing is
// logged.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";

const UPSTREAM_DOWN = new Set([502, 503, 504]);

/**
 * Faults the proxy can inject into the Nth chat request of a run (SPEC-10 T4 classes it can produce itself):
 * - refuse: the connection is dropped without an answer (the endpoint went away mid-turn);
 * - overloaded: 503 with Retry-After: 1 (the endpoint is busy);
 * - stream_cut: the stream is cut after its first tool-call fragment (a transport drop inside a tool call);
 * - truncate: the reply is marked cut at the output limit (finish_reason "length");
 * - context_overflow: llama.cpp's context-overflow error (HTTP 400, exceed_context_size_error);
 * - malformed_tool_json: the first tool call's arguments are made invalid JSON.
 * The other T4 classes (a hanging test command, a full disk, SIGTERM then resume) come from task fixtures and the runner.
 */
export const FAULT_KINDS = ["refuse", "overloaded", "stream_cut", "truncate", "context_overflow", "malformed_tool_json"];

const isChat = (req) => req.method === "POST" && /\/(chat\/completions|responses|messages)$/.test((req.url ?? "").split("?")[0]);

/** Rewrites an SSE body as it passes, chunk by chunk; `edit` returns the text to forward (or null to cut the stream). */
function rewriteStream(upstreamRes, res, edit) {
  let pending = "";
  upstreamRes.setEncoding("utf8");
  upstreamRes.on("data", (chunk) => {
    pending += chunk;
    const events = pending.split("\n\n");
    pending = events.pop() ?? "";
    for (const event of events) {
      const out = edit(event);
      if (out === null) {
        res.socket?.destroy();
        upstreamRes.destroy();
        return;
      }
      res.write(`${out}\n\n`);
    }
  });
  upstreamRes.on("end", () => {
    if (pending) res.write(edit(pending) ?? "");
    res.end();
  });
}

/**
 * Starts a forwarder on 127.0.0.1 for `upstream` (e.g. https://gateway:8443/v1). `faults`: [{ kind, atRequest }] where
 * atRequest counts chat requests from 1. Returns its base URL (same path as the upstream), live counters, and close().
 */
export async function startModelProxy({ upstream, caFile, faults = [] }) {
  for (const f of faults) {
    if (!FAULT_KINDS.includes(f.kind) || !Number.isInteger(f.atRequest) || f.atRequest < 1) throw new Error(`invalid fault ${JSON.stringify(f)}`);
  }
  const target = new URL(upstream);
  const client = target.protocol === "https:" ? https : http;
  const ca = caFile ? fs.readFileSync(caFile) : undefined;
  const stats = { requests: 0, chatRequests: 0, answered: 0, upstreamFailures: 0, faultsInjected: [], firstRequestAt: null, firstAnswerAt: null };

  const server = http.createServer((req, res) => {
    stats.requests++;
    stats.firstRequestAt ??= new Date().toISOString();
    const chatIndex = isChat(req) ? ++stats.chatRequests : 0;
    const fault = chatIndex ? faults.find((f) => f.atRequest === chatIndex) : undefined;
    if (fault) stats.faultsInjected.push({ kind: fault.kind, atRequest: chatIndex });

    if (fault?.kind === "refuse") {
      req.resume();
      return void req.socket.destroy();
    }
    if (fault?.kind === "overloaded") {
      req.resume();
      res.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
      return void res.end(JSON.stringify({ error: { message: "overloaded (injected)", type: "overloaded" } }));
    }
    if (fault?.kind === "context_overflow") {
      req.resume();
      res.writeHead(400, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: { code: 400, message: "the request exceeds the available context size, try increasing it", type: "exceed_context_size_error" } }));
    }

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
        const streamed = /text\/event-stream/.test(String(upstreamRes.headers["content-type"] ?? ""));
        if (!fault || !streamed) {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          return void upstreamRes.pipe(res);
        }
        const headers = { ...upstreamRes.headers };
        delete headers["content-length"];
        res.writeHead(upstreamRes.statusCode ?? 200, headers);
        let done = false;
        rewriteStream(upstreamRes, res, (event) => {
          if (fault.kind === "stream_cut" && !done && event.includes('"tool_calls"')) {
            done = true;
            res.write(`${event}\n\n`);
            return null;
          }
          if (fault.kind === "truncate") return event.replace(/"finish_reason":\s*"(stop|tool_calls)"/g, '"finish_reason":"length"');
          if (fault.kind === "malformed_tool_json" && !done && /"arguments":\s*"/.test(event)) {
            done = true;
            return event.replace(/"arguments":\s*"/, '"arguments":"{\\"broken');
          }
          return event;
        });
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
    stats: () => ({ ...stats, faultsInjected: [...stats.faultsInjected] }),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/**
 * Whether a run failed on infrastructure, by the same rule for every agent: the model never answered and the endpoint
 * was observed failing. A run in which the model answered is scored, whatever the agent then did (a crash counts as
 * a failure, not a rerun). Faults the harness injected on purpose are never infrastructure.
 */
export function isInfrastructureFailure(record) {
  if (record.error) return true;
  const m = record.model;
  if (!m || (m.faultsInjected?.length ?? 0) > 0) return false;
  return m.answered === 0 && m.upstreamFailures > 0;
}
