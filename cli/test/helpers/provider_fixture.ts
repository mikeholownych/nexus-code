/**
 * Shared fakes for provider recovery tests: a virtual clock whose sleep advances time (and lets a test change
 * provider availability between attempts), and a local OpenAI-compatible gateway that can go down and come back.
 */
import http from "node:http";
import { RecoveryCancelled, type RecoveryClock } from "../../src/core/provider_recovery.js";

export interface FakeClock extends RecoveryClock {
  sleeps: number[];
  elapsed(): number;
  /** Time passing without a sleep: a provider taking this long to answer. */
  advance(ms: number): void;
}

export function fakeClock(onSleep?: (ms: number, n: number) => void | Promise<void>, random = 0.5): FakeClock {
  const start = 1_800_000_000_000;
  let t = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    elapsed: () => t - start,
    advance: (ms) => {
      t += ms;
    },
    now: () => t,
    random: () => random,
    async sleep(ms, signal) {
      if (signal?.aborted) throw new RecoveryCancelled();
      sleeps.push(ms);
      t += ms;
      await onSleep?.(ms, sleeps.length);
      if (signal?.aborted) throw new RecoveryCancelled();
    },
  };
}


export type Reply =
  | { kind: "text"; content: string }
  | { kind: "tools"; calls: Array<{ name: string; args: any }> }
  | { kind: "http"; status: number; body?: string; headers?: Record<string, string> }
  | { kind: "reset" }
  | { kind: "empty_stream" }
  /** A streamed response the provider ends with an error frame, as a gateway does at its response time limit. */
  | { kind: "error_frame"; message: string };

export interface Gateway {
  url: string;
  requests: Array<{ id?: string; attempt?: string; previous?: string; authorization?: string; body: any }>;
  probes: number;
  /** Authorization header of every request, chat and /models alike, in arrival order. */
  authorizations: Array<string | undefined>;
  script: (n: number, body: any) => Reply;
  down(): Promise<void>;
  up(): Promise<void>;
  close(): Promise<void>;
}

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

export async function startGateway(script: (n: number, body: any) => Reply, opts: { startDown?: boolean } = {}): Promise<Gateway> {
  const sockets = new Set<import("node:net").Socket>();
  const gw: Gateway = {
    url: "",
    requests: [],
    probes: 0,
    authorizations: [],
    script,
    down: async () => {
      for (const s of sockets) s.destroy();
      if (server.listening) await new Promise<void>((r) => server.close(() => r()));
    },
    up: async () => {
      if (!server.listening) await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
    },
    close: async () => gw.down(),
  };
  const server = http.createServer((req, res) => {
    gw.authorizations.push(req.headers.authorization);
    if (req.url?.endsWith("/models")) {
      // Capability discovery also reads /models; only availability probes count as probes.
      if (req.headers["x-nexus-purpose"] !== "capabilities") gw.probes++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "m" }] }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = {};
      try { body = JSON.parse(raw); } catch {}
      gw.requests.push({
        body,
        id: req.headers["x-request-id"] as string | undefined,
        attempt: req.headers["x-aihost-attempt"] as string | undefined,
        previous: req.headers["x-aihost-previous-request"] as string | undefined,
        authorization: req.headers.authorization,
      });
      const r = gw.script(gw.requests.length, body);
      if (r.kind === "reset") return void req.socket.destroy();
      if (r.kind === "http") {
        res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
        return void res.end(r.body ?? "{}");
      }
      if (r.kind === "error_frame") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return void res.end(sse({ error: { message: r.message } }));
      }
      if (r.kind === "empty_stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return void res.end(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
      }
      if (!body.stream) {
        res.setHeader("content-type", "application/json");
        const message = r.kind === "text" ? { role: "assistant", content: r.content } : { role: "assistant", content: null };
        return void res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: "stop" }] }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      let out = "";
      if (r.kind === "text") out += sse({ choices: [{ index: 0, delta: { content: r.content } }] });
      else r.calls.forEach((c, i) => {
        out += sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] });
      });
      out += sse({ choices: [{ index: 0, delta: {}, finish_reason: r.kind === "tools" ? "tool_calls" : "stop" }] });
      res.end(out + "data: [DONE]\n\n");
    });
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port as number;
  gw.url = `http://127.0.0.1:${port}/v1`;
  if (opts.startDown) await gw.down();
  return gw;
}
