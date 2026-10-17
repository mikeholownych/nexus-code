// A per-run forwarder between an agent and the model endpoint. Every agent reaches the model through it the same way,
// so the harness itself observes whether the model was reachable during a run (REQ-QUAL-106): how many requests were
// made, how many got an answer, and how many failed upstream (connection errors and 502/503/504 from the endpoint).
// Bodies are streamed through unchanged unless a fault is scheduled for a request (T4, REQ-QUAL-105); nothing is
// logged.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { timingSafeEqual } from "node:crypto";

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

/**
 * Standalone profiles (DEC-16, REQ-PRV-106): the agent sees a plain OpenAI-compatible server instead of the gateway.
 * Every gateway extension is removed (limits and capabilities in /models, /tokenize, X-AIHost-* headers). An emulated
 * profile also answers as that server would about its context (llama.cpp /props, Ollama /api/show, vLLM max_model_len)
 * and reshapes context-overflow errors into its format; the numbers are the gateway's real ones.
 */
export const PROFILES = ["plain", "llamacpp", "vllm", "ollama"];
const OWNER = { plain: "organization", llamacpp: "llamacpp", vllm: "vllm", ollama: "library" };

function profileModel(profile, entry) {
  const ctx = entry.context_length ?? entry.max_model_len ?? null;
  const base = { id: entry.id, object: "model", owned_by: OWNER[profile] };
  if (profile === "llamacpp" && ctx) return { ...base, meta: { n_ctx_train: ctx } };
  if (profile === "vllm" && ctx) return { ...base, max_model_len: ctx };
  return base;
}

function overflowBody(profile, ctx) {
  if (profile === "llamacpp") return { error: { code: 400, message: "the request exceeds the available context size, try increasing it", type: "exceed_context_size_error", n_ctx: ctx } };
  if (profile === "vllm") return { object: "error", message: `This model's maximum context length is ${ctx ?? "unknown"} tokens. However, you requested more tokens.`, type: "BadRequestError", code: 400 };
  return { error: { message: "This request exceeds the model's maximum context length.", type: "invalid_request_error", code: "context_length_exceeded" } };
}

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
export async function startModelProxy({ upstream, caFile, faults = [], profile, authToken, clientToken, socketPath, maxRequests = 1_000, maxConcurrentRequests = 1, maxRequestBytes = 1_000_000, maxCompletionTokens, maxTotalCompletionTokens }) {
  if (profile !== undefined && !PROFILES.includes(profile)) throw new Error(`unknown profile ${profile}; one of ${PROFILES.join(", ")}`);
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || !Number.isSafeInteger(maxConcurrentRequests) || maxConcurrentRequests < 1 || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) throw new Error("invalid evaluation proxy request limits");
  if (maxCompletionTokens !== undefined && (!Number.isSafeInteger(maxCompletionTokens) || maxCompletionTokens < 1)) throw new Error("invalid per-request completion-token limit");
  if (maxTotalCompletionTokens !== undefined && (!Number.isSafeInteger(maxTotalCompletionTokens) || maxTotalCompletionTokens < 1)) throw new Error("invalid aggregate completion-token limit");
  for (const f of faults) {
    if (!FAULT_KINDS.includes(f.kind) || !Number.isInteger(f.atRequest) || f.atRequest < 1) throw new Error(`invalid fault ${JSON.stringify(f)}`);
  }
  const target = new URL(upstream);
  const basePath = target.pathname.replace(/\/$/, "");
  const allowedRoutes = new Map([
    ["GET /models", "catalog"],
    ["POST /chat/completions", "inference"],
    ["POST /responses", "inference"],
    ["POST /messages", "inference"],
  ]);
  const client = target.protocol === "https:" ? https : http;
  const ca = caFile ? fs.readFileSync(caFile) : undefined;
  const stats = { requests: 0, chatRequests: 0, activeInferenceRequests: 0, cancelledRequests: 0, requestedCompletionTokens: 0, answered: 0, upstreamFailures: 0, faultsInjected: [], firstRequestAt: null, firstAnswerAt: null };

  /** The upstream /models entries (for an emulated profile's context answers). */
  const upstreamModels = () => new Promise((resolve) => {
    const r = client.request({ protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === "https:" ? 443 : 80), method: "GET", path: `${target.pathname.replace(/\/$/, "")}/models`, headers: { host: target.host, ...(authToken ? { authorization: `Bearer ${authToken}` } : {}) }, ca }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve(JSON.parse(body).data ?? []); } catch { resolve([]); } });
    });
    r.on("error", () => resolve([]));
    r.end();
  });
  const firstContext = async () => { const m = (await upstreamModels())[0]; return m?.context_length ?? m?.max_model_len ?? null; };
  const sendJson = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

  const server = http.createServer(async (req, res) => {
    stats.requests++;
    if (clientToken) {
      const supplied = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
      const expected = Buffer.from(clientToken);
      const actual = Buffer.from(supplied);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        req.resume();
        return void sendJson(res, 401, { error: { type: "authentication_error", message: "evaluation proxy authentication failed" } });
      }
    }
    const urlPath = (req.url ?? "").split("?")[0];
    const relativePath = urlPath.startsWith(`${basePath}/`) ? urlPath.slice(basePath.length) : null;
    const routeKind = relativePath === null ? null : allowedRoutes.get(`${req.method} ${relativePath}`);
    const localProfileRoute = Boolean(profile && ((profile === "llamacpp" && req.method === "GET" && urlPath === "/props") || (profile === "ollama" && req.method === "POST" && urlPath === "/api/show") || urlPath.endsWith("/tokenize")));
    if (!routeKind && !localProfileRoute) {
      req.resume();
      return void sendJson(res, 404, { error: { type: "not_found", message: "evaluation proxy route is not permitted" } });
    }
    if (stats.requests > maxRequests) {
      req.resume();
      return void sendJson(res, 429, { error: { type: "request_limit", message: "evaluation proxy request limit exceeded" } });
    }
    let releaseInferenceSlot = () => {};
    if (routeKind === "inference") {
      if (stats.activeInferenceRequests >= maxConcurrentRequests) {
        req.resume();
        return void sendJson(res, 429, { error: { type: "concurrency_limit", message: "evaluation proxy concurrent inference limit exceeded" } });
      }
      stats.activeInferenceRequests++;
      let slotReleased = false;
      releaseInferenceSlot = () => {
        if (slotReleased) return;
        slotReleased = true;
        stats.activeInferenceRequests--;
      };
      req.once("aborted", releaseInferenceSlot);
      res.once("finish", releaseInferenceSlot);
      res.once("close", releaseInferenceSlot);
    }
    if (profile) {
      // The server's own endpoints for its loaded context, answered here with the gateway's real numbers.
      if (profile === "llamacpp" && req.method === "GET" && urlPath === "/props") {
        req.resume();
        return void sendJson(res, 200, { default_generation_settings: { n_ctx: await firstContext() } });
      }
      if (profile === "ollama" && req.method === "POST" && urlPath === "/api/show") {
        req.resume();
        const ctx = await firstContext();
        return void sendJson(res, 200, { parameters: `num_ctx ${ctx}`, model_info: { "general.context_length": ctx } });
      }
      if (urlPath.endsWith("/tokenize")) {
        req.resume();
        return void sendJson(res, 404, { error: { message: "not found" } });
      }
    }
    const requestChunks = [];
    let requestBytes = 0;
    try {
      for await (const chunk of req) {
        requestBytes += chunk.length;
        if (requestBytes > maxRequestBytes) {
          sendJson(res, 413, { error: { type: "request_too_large", message: "evaluation proxy request body limit exceeded" } });
          req.destroy();
          return;
        }
        requestChunks.push(chunk);
      }
    } catch {
      return;
    }
    const requestBody = Buffer.concat(requestChunks);
    let requestedTokens = 0;
    if (routeKind === "inference" && (maxCompletionTokens !== undefined || maxTotalCompletionTokens !== undefined)) {
      let payload;
      try { payload = JSON.parse(requestBody.toString("utf8")); }
      catch { return void sendJson(res, 400, { error: { type: "invalid_request", message: "evaluation proxy requires a valid JSON inference request" } }); }
      const suppliedLimits = [payload.max_tokens, payload.max_completion_tokens].filter((value) => value !== undefined);
      if (!suppliedLimits.length || suppliedLimits.some((value) => !Number.isSafeInteger(value) || value < 1) || new Set(suppliedLimits).size !== 1) {
        return void sendJson(res, 400, { error: { type: "invalid_request", message: "evaluation proxy requires one unambiguous positive completion-token limit" } });
      }
      requestedTokens = suppliedLimits[0];
      if (maxCompletionTokens !== undefined && requestedTokens > maxCompletionTokens) {
        return void sendJson(res, 400, { error: { type: "completion_limit", message: "evaluation proxy per-request completion-token limit exceeded" } });
      }
      if (maxTotalCompletionTokens !== undefined && stats.requestedCompletionTokens + requestedTokens > maxTotalCompletionTokens) {
        return void sendJson(res, 400, { error: { type: "aggregate_completion_limit", message: "evaluation proxy aggregate requested completion-token limit exceeded" } });
      }
      stats.requestedCompletionTokens += requestedTokens;
    }
    stats.firstRequestAt ??= new Date().toISOString();
    const chatIndex = routeKind === "inference" ? ++stats.chatRequests : 0;
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

    const upstreamHeaders = { host: target.host, connection: "close" };
    for (const header of ["accept", "accept-encoding", "content-type", "user-agent"]) {
      const value = req.headers[header];
      if (typeof value === "string") upstreamHeaders[header] = value;
    }
    if (requestBody.length > 0) upstreamHeaders["content-length"] = String(requestBody.length);
    if (authToken) upstreamHeaders.authorization = `Bearer ${authToken}`;
    let upstreamResponse;
    let cancelled = false;
    const out = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        method: req.method,
        // The agent was given the proxy's URL with the upstream's path, so the request path is already the upstream's.
        path: req.url,
        headers: upstreamHeaders,
        ca,
      },
      (upstreamRes) => {
        upstreamResponse = upstreamRes;
        if (UPSTREAM_DOWN.has(upstreamRes.statusCode ?? 0)) stats.upstreamFailures++;
        else {
          stats.answered++;
          stats.firstAnswerAt ??= new Date().toISOString();
        }
        if (profile) {
          for (const key of Object.keys(upstreamRes.headers)) if (key.startsWith("x-aihost-")) delete upstreamRes.headers[key];
          const isModels = req.method === "GET" && urlPath.endsWith("/models");
          const failed = (upstreamRes.statusCode ?? 200) >= 400;
          if (isModels || failed) {
            // Buffered: the catalog is rewritten to the profile's shape; error bodies may be reshaped.
            let body = "";
            upstreamRes.setEncoding("utf8");
            upstreamRes.on("data", (c) => (body += c));
            upstreamRes.on("end", async () => {
              if (isModels && !failed) {
                let data = [];
                try { data = JSON.parse(body).data ?? []; } catch {}
                return void sendJson(res, 200, { object: "list", data: data.map((e) => profileModel(profile, e)) });
              }
              if ([400, 413].includes(upstreamRes.statusCode) && /context|too many tokens|token limit/i.test(body)) {
                return void sendJson(res, 400, overflowBody(profile, await firstContext()));
              }
              res.writeHead(upstreamRes.statusCode ?? 502, { "content-type": upstreamRes.headers["content-type"] ?? "application/json" });
              res.end(body);
            });
            return;
          }
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
    const cancelUpstream = () => {
      if (cancelled || res.writableFinished) return;
      cancelled = true;
      stats.cancelledRequests++;
      upstreamResponse?.destroy();
      out.destroy();
    };
    req.once("aborted", cancelUpstream);
    res.once("close", cancelUpstream);
    out.on("error", (err) => {
      if (cancelled) return;
      stats.upstreamFailures++;
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `model proxy: upstream unreachable (${err.code ?? err.message})` } }));
    });
    out.end(requestBody);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    if (socketPath) server.listen(socketPath, resolve);
    else server.listen(0, "127.0.0.1", resolve);
  });
  const address = socketPath ? null : server.address();
  const url = address ? `http://127.0.0.1:${address.port}${target.pathname.replace(/\/$/, "")}` : null;
  return {
    url,
    socketPath: socketPath ?? null,
    stats: () => ({ ...stats, faultsInjected: [...stats.faultsInjected] }),
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => {
        if (socketPath) fs.rmSync(socketPath, { force: true });
        resolve();
      });
    }),
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
