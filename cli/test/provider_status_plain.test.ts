/**
 * TUI audit D-06 and D-07 (sidecar side): a provider wait is one status line that updates in place (stable `key`,
 * a counter, the next attempt, the bound and the way out) in plain words, with the raw cause kept apart in `detail`;
 * a first run with no usable provider says what is missing and what to do, and refuses a prompt that could only fail.
 * No sleeps: the records are fixed values and the clock is the record's own timestamps.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ApplicationCore } from "../src/core/app.js";
import { SidecarServer } from "../src/sidecar.js";
import { encodeEvent, noProviderNotice, noProviderRefusal, providerRecoveryStatus } from "../src/protocol.js";
import { startupEndpointProblem } from "../src/core/provider_recovery.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import http from "node:http";
import net from "node:net";
import { scrubUrls } from "../src/core/endpoint_identity.js";
import { makeHome, makeRepo, startGateway } from "./helpers/fixtures.js";
import type { ProviderRecoveryRecord, RecoverySubmissionRecord } from "../src/core/turn.js";

const T0 = Date.parse("2026-11-12T10:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const SECRET = "sk-live-abcdefghijklmnopqrstuvwxyz0123";

function submission(n: number, over: Partial<RecoverySubmissionRecord> = {}): RecoverySubmissionRecord {
  return {
    requestId: `req-${n}`, attempt: n, failedAt: iso(0), kind: "http_error", condition: "RATE_LIMITED", execution: "NOT_EXECUTED",
    httpStatus: 429, message: `{"error":{"message":"slow down for ${SECRET}"}}`, ...over,
  };
}

function record(failures: number, over: Partial<ProviderRecoveryRecord> = {}, last: Partial<RecoverySubmissionRecord> = {}): ProviderRecoveryRecord {
  return {
    state: "WAITING", step: 2, startedAt: iso(0), updatedAt: iso(0), nextAttemptAt: iso(2_000), condition: "RATE_LIMITED",
    probes: 0, waitedMs: 4_000, unknownReplays: 0, endpoint: "http://127.0.0.1:18080/v1",
    submissions: Array.from({ length: failures }, (_, i) => submission(i + 1, i === failures - 1 ? last : {})),
    policy: { deadlineMs: 20 * 60_000, maxDelayMs: 15_000, maxUnknownReplays: 1 },
    ...over,
  };
}

async function until(done: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
}

const JARGON = /HTTP \d|execution|replay|PROBING|condition|NOT_EXECUTED|UNKNOWN|_/;

describe("D-06: one updating status line, plain words", () => {
  test("repeated waits share one key and differ only in the counter and the countdown", () => {
    const first = providerRecoveryStatus(record(1), false)!;
    const third = providerRecoveryStatus(record(3), false)!;
    assert.equal(first.key, third.key, "the TUI replaces the line that has this key");
    assert.notEqual(first.text, third.text);
    assert.match(first.text, /retry 1\b/i);
    assert.match(third.text, /retry 3\b/i);
    assert.match(third.text, /next attempt in 2s/);
  });

  test("it says what is retried, the bound, and how to cancel", () => {
    const { text } = providerRecoveryStatus(record(3, { waitedMs: 5 * 60_000 }), false)!;
    assert.match(text, /rate limit/i);
    assert.match(text, /http:\/\/127\.0\.0\.1:18080\/v1/);
    assert.match(text, /gives up in about 15 min/);
    assert.match(text, /esc cancels/);
  });

  test("known failure classes read as plain language, never as protocol terms", () => {
    const cases: Array<[Partial<ProviderRecoveryRecord>, Partial<RecoverySubmissionRecord>, RegExp]> = [
      [{ condition: "AUTH_FAILURE" }, { condition: "AUTH_FAILURE", httpStatus: 401 }, /credentials/i],
      [{ condition: "RATE_LIMITED" }, {}, /rate limit/i],
      [{ condition: "OVERLOADED" }, { condition: "OVERLOADED", httpStatus: 503 }, /overloaded/i],
      [{ condition: "TEMPORARILY_UNAVAILABLE" }, { condition: "TEMPORARILY_UNAVAILABLE", kind: "network_error", httpStatus: undefined }, /cannot be reached/i],
      [{ condition: "TEMPORARILY_UNAVAILABLE" }, { condition: "TEMPORARILY_UNAVAILABLE", kind: "timeout", httpStatus: undefined }, /did not answer in time/i],
    ];
    for (const [rec, last, expected] of cases) {
      const { text } = providerRecoveryStatus(record(2, rec, last), false)!;
      assert.match(text, expected, text);
      assert.doesNotMatch(text, JARGON, text);
    }
  });

  test("the raw cause stays inspectable in detail, with credentials redacted everywhere", () => {
    const status = providerRecoveryStatus(record(2), true)!;
    assert.match(status.detail!, /429/);
    assert.match(status.detail!, /slow down/);
    assert.equal(status.text.includes(SECRET), false);
    assert.equal(status.detail!.includes(SECRET), false, status.detail);
    assert.match(status.text, /partial response was discarded/);
  });

  test("the countdown is never negative and the bound never reads as negative time", () => {
    const late = providerRecoveryStatus(record(9, { updatedAt: iso(5_000), nextAttemptAt: iso(1_000), waitedMs: 40 * 60_000 }), false)!;
    assert.match(late.text, /next attempt in 0s/);
    assert.match(late.text, /gives up in under a minute/);
  });

  test("probes are silent, recovery replaces the line, and a final failure is plain and keeps the raw reason apart", () => {
    assert.equal(providerRecoveryStatus(record(2, { state: "PROBING" }), false), undefined);
    const resumed = providerRecoveryStatus(record(2, { state: "RESUMED", waitedMs: 7_000 }), false)!;
    assert.equal(resumed.key, providerRecoveryStatus(record(2), false)!.key);
    assert.match(resumed.text, /recovered after 7s/);
    const final = providerRecoveryStatus(
      record(1, { state: "EXHAUSTED", reason: "execution status unknown and the replay budget (1) is spent" }, { condition: "TEMPORARILY_UNAVAILABLE", kind: "http_error", httpStatus: 500, message: `{"error":{"message":"upstream exploded"}}` }),
      false,
    )!;
    assert.equal(final.key, resumed.key);
    assert.match(final.text, /stopped retrying/i);
    assert.doesNotMatch(final.text, JARGON, final.text);
    assert.match(final.detail!, /replay budget/);
    assert.match(final.detail!, /upstream exploded/);
  });

  test("the notice event carries key and detail as optional fields; an old reader sees plain text", () => {
    const status = providerRecoveryStatus(record(2), false)!;
    const line = JSON.parse(encodeEvent({ type: "notice", text: status.text, key: status.key, detail: status.detail }));
    assert.equal(line.type, "notice");
    assert.equal(typeof line.text, "string");
    assert.deepEqual(JSON.parse(encodeEvent({ type: "notice", text: "plain" })), { v: 1, type: "notice", text: "plain" });
  });
});

describe("D-07: first run without a provider", () => {
  const refused = startupEndpointProblem("http://localhost:1234/v1", {
    available: false, condition: "TEMPORARILY_UNAVAILABLE",
    detail: "fetch failed (cause: ECONNREFUSED <- ECONNREFUSED: connect ECONNREFUSED ::1:1234 <- ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:1234)",
    codes: ["ECONNREFUSED"],
  } as any)!;

  test("the notice says what is missing and the next steps, and keeps the raw cause out of the text", () => {
    const n = noProviderNotice(refused);
    assert.match(n.text, /No model is connected/);
    assert.match(n.text, /http:\/\/localhost:1234\/v1/);
    assert.match(n.text, /\/connect/);
    assert.match(n.text, /local model/i);
    assert.match(n.text, /docs\/CLOUD_PROVIDERS\.md/);
    assert.doesNotMatch(n.text, /ECONNREFUSED|fetch failed/);
    assert.match(n.detail!, /ECONNREFUSED/);
  });

  test("rejected credentials get their own wording, and say the messages are still tried", () => {
    const n = noProviderNotice(startupEndpointProblem("https://api.example.test/v1", { available: true, condition: "AVAILABLE", httpStatus: 401 } as any)!);
    assert.match(n.text, /rejected the credentials/i);
    assert.match(n.text, /\/connect/);
    assert.match(n.text, /still try/i);
    assert.doesNotMatch(n.text, /No model is connected/);
  });

  async function rig(endpoint: string, fn: (r: { events: any[]; send: (m: object) => Promise<void>; server: SidecarServer }) => Promise<void>) {
    const repo = makeRepo();
    const home = makeHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const app = new ApplicationCore({ endpoint, model: "local-model", maxSteps: 5, temperature: 0, workspace: repo, shell: "bash", continuation: { ...DEFAULT_CONTINUATION }, approvalMode: "auto", fullAccess: true } as HarnessConfig);
    const events: any[] = [];
    const server = new SidecarServer({ app, mode: "auto", write: (line) => events.push(JSON.parse(line)), historyFile: path.join(home, "history") });
    server.start();
    try {
      await fn({ events, server, send: (m) => server.handleLine(JSON.stringify({ v: 1, ...m })) });
    } finally {
      await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
      await server.idle();
      app.shutdown();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }

  test("a dead endpoint: the start-up notice is guidance, and a prompt is refused with the reason instead of retried", async () => {
    await rig("http://127.0.0.1:1/v1", async ({ events, send, server }) => {
      await until(() => events.some((e) => e.type === "notice" && /No model is connected/.test(e.text)));
      const start = events.find((e) => e.type === "notice" && /No model is connected/.test(e.text));
      assert.ok(start, JSON.stringify(events.map((e) => e.type)));
      assert.equal(start.key, "provider.startup");
      assert.match(start.detail, /ECONNREFUSED|fetch failed/);
      assert.doesNotMatch(start.text, /ECONNREFUSED|fetch failed/);
      await send({ type: "prompt.submit", id: "t1", text: "hello" });
      await server.idle();
      const refusal = events.find((e) => e.type === "error" && e.id === "t1");
      assert.equal(refusal?.code, "NO_PROVIDER");
      assert.match(refusal.message, /\/connect/);
      assert.equal(events.some((e) => e.type === "activity" || e.type === "turn.result"), false, "no turn was started");
      assert.equal(events.some((e) => e.type === "notice" && /retry/.test(e.text)), false, "no retry loop");
    });
  });

  test("a prompt goes through once the provider answers, even though start-up found it down", async () => {
    const gw = await startGateway(() => ({ kind: "text", content: "hi there" }));
    try {
      await rig(gw.url, async ({ events, send, server }) => {
        (server as any).providerProblem = refused;
        await send({ type: "prompt.submit", id: "t1", text: "hello" });
        await server.idle();
        assert.ok(events.some((e) => e.type === "turn.result"), JSON.stringify(events.map((e) => [e.type, e.code])));
        assert.equal(events.some((e) => e.type === "error"), false);
      });
    } finally {
      await gw.close();
    }
  });
});

/** A gateway whose /models answers `status` while chat works, so only the start-up probe sees a rejection. */
async function rejectingModelsGateway(status: number) {
  const gw = await startGateway(() => ({ kind: "text", content: "hi there" }));
  const target = new URL(gw.url);
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad token" } }));
      return;
    }
    const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    req.pipe(up);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}/v1`, close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await gw.close(); } };
}

describe("D-07 review round 2", () => {
  async function sidecar(endpoint: string, fn: (r: { events: any[]; server: SidecarServer; repo: string; send: (m: object) => Promise<void> }) => Promise<void>) {
    const repo = makeRepo();
    const home = makeHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const app = new ApplicationCore({ endpoint, model: "local-model", maxSteps: 5, temperature: 0, workspace: repo, shell: "bash", continuation: { ...DEFAULT_CONTINUATION }, approvalMode: "auto", fullAccess: true } as HarnessConfig);
    const events: any[] = [];
    const server = new SidecarServer({ app, mode: "auto", write: (l) => events.push(JSON.parse(l)), historyFile: path.join(home, "history") });
    server.start();
    try {
      await fn({ events, server, repo, send: (m) => server.handleLine(JSON.stringify({ v: 1, ...m })) });
    } finally {
      await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
      await server.idle();
      app.shutdown();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }

  for (const status of [401, 403]) {
    test(`/models answers ${status} but chat works: the prompt runs, the start-up notice only warns`, async () => {
      const gw = await rejectingModelsGateway(status);
      try {
        await sidecar(gw.url, async ({ events, send, server }) => {
          await until(() => events.some((e) => e.type === "notice" && e.key === "provider.startup"));
          assert.match(events.find((e) => e.key === "provider.startup").text, /rejected the credentials/);
          await send({ type: "prompt.submit", id: "t1", text: "hello" });
          await server.idle();
          assert.equal(events.some((e) => e.type === "error"), false, JSON.stringify(events.filter((e) => e.type === "error")));
          assert.ok(events.some((e) => e.type === "turn.result"));
        });
      } finally {
        await gw.close();
      }
    });
  }

  test("a steer that would start a turn on a dead provider is refused, not retried, and its text returns", async () => {
    await sidecar("http://127.0.0.1:1/v1", async ({ events, send, server }) => {
      await send({ type: "steer", id: "g1", text: "also do this" });
      await server.idle();
      const ack = events.filter((e) => e.type === "steer.ack" && e.id === "g1");
      assert.deepEqual(ack.map((a) => a.status), ["cancelled"], JSON.stringify(ack));
      assert.equal(ack[0].text, "also do this");
      assert.match(ack[0].message, /no model is connected/i);
      assert.equal(events.some((e) => e.type === "activity" || e.type === "turn.result"), false);
    });
  });

  test("a follow-up deferred while the gate is mid-probe is refused too, never run ungated", async () => {
    await sidecar("http://127.0.0.1:1/v1", async ({ events, send, server }) => {
      const first = send({ type: "prompt.submit", id: "t1", text: "hello" });
      await send({ type: "steer", id: "g2", text: "and this" });
      await first;
      await server.idle();
      assert.equal(events.find((e) => e.type === "error" && e.id === "t1")?.code, "NO_PROVIDER");
      const ack = events.filter((e) => e.type === "steer.ack" && e.id === "g2").map((a) => a.status);
      assert.deepEqual(ack, ["deferred", "cancelled"]);
      assert.equal(events.some((e) => e.type === "activity" || e.type === "turn.result"), false, "no turn ran");
    });
  });

  test("a slash command that starts a turn (/image) is gated like a prompt", async () => {
    await sidecar("http://127.0.0.1:1/v1", async ({ events, send, server, repo }) => {
      fs.writeFileSync(path.join(repo, "pic.png"), Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
      await send({ type: "slash", id: "s1", command: "image", args: "pic.png describe" });
      await server.idle();
      assert.equal(events.find((e) => e.type === "error" && e.id === "s1")?.code, "NO_PROVIDER", JSON.stringify(events.map((e) => [e.type, e.code, e.output])));
      assert.equal(events.some((e) => e.type === "slash.result" && e.prompt), false, "no turn was announced");
      assert.equal(events.some((e) => e.type === "activity" || e.type === "turn.result"), false);
    });
  });

  test("/models answering 503 (a model still loading) or timing out does not block prompts", async () => {
    const gw = await rejectingModelsGateway(503);
    try {
      await sidecar(gw.url, async ({ events, send, server }) => {
        await until(() => events.some((e) => e.key === "provider.startup"));
        const notice = events.find((e) => e.key === "provider.startup");
        assert.match(notice.text, /did not answer the start-up check/);
        assert.doesNotMatch(notice.text, /No model is connected/);
        await send({ type: "prompt.submit", id: "t1", text: "hello" });
        await server.idle();
        assert.equal(events.some((e) => e.type === "error"), false);
        assert.ok(events.some((e) => e.type === "turn.result"));
      });
    } finally {
      await gw.close();
    }
    const timeout = startupEndpointProblem("http://localhost:1234/v1", { available: false, condition: "TEMPORARILY_UNAVAILABLE", detail: "The operation was aborted due to timeout", timedOut: true } as any)!;
    assert.equal(timeout.blocking, false);
    assert.equal(startupEndpointProblem("http://localhost:1234/v1", { available: false, condition: "TEMPORARILY_UNAVAILABLE", httpStatus: 429, detail: "HTTP 429" } as any)!.blocking, false);
  });

  test("a real fetch timeout is not a refusal; a host named like a timeout still is one", async () => {
    // A server that accepts the connection and never answers: the probe's own timeout fires.
    const sockets = new Set<net.Socket>();
    const hang = net.createServer((sock) => { sockets.add(sock); });
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
    const port = (hang.address() as net.AddressInfo).port;
    try {
      await sidecar(`http://127.0.0.1:${port}/v1`, async ({ server }) => {
        const agent = (server as any).app.getAgent();
        const problem = await agent.probeEndpointProblem(undefined, 150);
        assert.ok(problem, "the timeout is reported");
        assert.equal(problem.blocking, false, "a timeout does not gate prompts");
      });
    } finally {
      for (const sock of sockets) sock.destroy();
      await new Promise((r) => hang.close(r));
    }
    const named = startupEndpointProblem("http://api.timeout-llm.com/v1", { available: false, condition: "TEMPORARILY_UNAVAILABLE", detail: "fetch failed (cause: ECONNREFUSED: connect ECONNREFUSED api.timeout-llm.com)", codes: ["ECONNREFUSED"] } as any)!;
    assert.equal(named.blocking, true);
  });

  test("the refusal does not claim nothing answers when the connection failed some other way", () => {
    const tls = startupEndpointProblem("https://h.example/v1", { available: false, condition: "TEMPORARILY_UNAVAILABLE", detail: "fetch failed (cause: UNABLE_TO_VERIFY_LEAF_SIGNATURE)" } as any)!;
    const reset = startupEndpointProblem("https://h.example/v1", { available: false, condition: "TEMPORARILY_UNAVAILABLE", detail: "fetch failed (cause: ECONNRESET)" } as any)!;
    for (const p of [tls, reset]) {
      assert.doesNotMatch(noProviderRefusal(p), /nothing answers/);
      assert.match(noProviderRefusal(p), /could not connect/);
      assert.doesNotMatch(noProviderNotice(p).text, /nothing answers/);
      assert.match(noProviderNotice(p).text, /could not connect/);
    }
    const refused = startupEndpointProblem("http://localhost:1234/v1", { available: false, condition: "TEMPORARILY_UNAVAILABLE", detail: "fetch failed (cause: ECONNREFUSED)", codes: ["ECONNREFUSED"] } as any)!;
    assert.match(noProviderRefusal(refused), /nothing answers/);
    // A host whose NAME looks like an error code is not a refusal: only the structured code counts.
    const named = startupEndpointProblem("https://econnrefused.example/v1", { available: false, condition: "TEMPORARILY_UNAVAILABLE", detail: "fetch failed (cause: UNABLE_TO_VERIFY_LEAF_SIGNATURE for econnrefused.example enotfound)", codes: ["UNABLE_TO_VERIFY_LEAF_SIGNATURE"] } as any)!;
    assert.equal(named.nothingThere, false);
    assert.match(noProviderRefusal(named), /could not connect/);
  });

  test("a real refused connection yields the ECONNREFUSED code and the 'nothing answers' wording", async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise((r) => probe.close(r));
    await sidecar(`http://127.0.0.1:${port}/v1`, async ({ server }) => {
      const problem = await (server as any).app.getAgent().probeEndpointProblem(undefined, 1_000);
      assert.equal(problem?.nothingThere, true, JSON.stringify(problem));
      assert.equal(problem?.blocking, true);
      assert.match(noProviderRefusal(problem), /nothing answers/);
    });
  });

  test("a cancel that lands mid-probe returns the message, keeps the gate and sends nothing", async () => {
    const sockets = new Set<net.Socket>();
    const hang = net.createServer((sock) => { sockets.add(sock); });
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
    const port = (hang.address() as net.AddressInfo).port;
    try {
      await sidecar(`http://127.0.0.1:${port}/v1`, async ({ events, send, server }) => {
        await (server as any).startupProbe;
        const known = startupEndpointProblem(`http://127.0.0.1:${port}/v1`, { available: false, condition: "TEMPORARILY_UNAVAILABLE", detail: "fetch failed (cause: ECONNREFUSED)", codes: ["ECONNREFUSED"] } as any)!;
        (server as any).providerProblem = known;
        const before = sockets.size;
        const submitted = send({ type: "prompt.submit", id: "t1", text: "hello" });
        await until(() => sockets.size > before);
        assert.ok(sockets.size > before, "the re-probe is in flight, held by the silent server");
        await send({ type: "cancel" });
        await submitted;
        await server.idle();
        const errors = events.filter((e) => e.type === "error" && e.id === "t1");
        assert.equal(errors.length, 1, JSON.stringify(events.map((e) => [e.type, e.code])));
        assert.equal(errors[0].code, "NO_PROVIDER");
        assert.equal(errors[0].message, "Cancelled before it was sent.");
        assert.equal(events.some((e) => e.type === "activity" || e.type === "turn.result"), false, "nothing was sent");
        assert.equal((server as any).providerProblem, known, "the gate is kept");
      });
    } finally {
      for (const sock of sockets) sock.destroy();
      await new Promise((r) => hang.close(r));
    }
  });

  test("a refused prompt is not recorded in the prompt history", async () => {
    await sidecar("http://127.0.0.1:1/v1", async ({ events, send, server }) => {
      await send({ type: "prompt.submit", id: "t1", text: "never-sent-text" });
      await server.idle();
      assert.equal(events.find((e) => e.type === "error")?.code, "NO_PROVIDER");
      assert.equal(((server as any).history as string[]).includes("never-sent-text"), false);
    });
  });

  test("scrubUrls cuts every userinfo form and leaves other text alone", () => {
    const cut: Array<[string, string]> = [
      ["http://u:p'w@h/x", "http://h/x"],
      ["http://u:pa ss@h/x", "http://h/x"],
      ["//user:pass@host/x", "//host/x"],
      ["connect user:pass@db:5432/x failed", "connect db:5432/x failed"],
      ["https://TOKENVALUE@host.example/v1?key=SECRETVALUE", "https://host.example/v1"],
    ];
    for (const [input, expected] of cut) assert.equal(scrubUrls(input), expected, input);
    for (const same of ["mail a@b.example now", "mailto:a@b.example", "/home/a@b/file", "C:\\x\\y", "file:///x/y", "see // a comment about a@b", "http://host.example/v1"]) {
      assert.equal(scrubUrls(same), same, same);
    }
  });

  test("scrubUrls cuts a password that holds a raw slash, and leaves look-alikes alone", () => {
    const cut: Array<[string, string]> = [
      ["https://u:abc/def@host/v1", "https://host/v1"],
      ["https://u:abc/def/ghi@host/v1", "https://host/v1"],
      ["https://u:abc/def@host/v1?key=SECRETVALUE", "https://host/v1"],
      ["Request cannot be constructed from a URL that includes credentials: https://u:abc/def@host/v1 (retry)", "Request cannot be constructed from a URL that includes credentials: https://host/v1 (retry)"],
    ];
    for (const [input, expected] of cut) assert.equal(scrubUrls(input), expected, input);
    for (const same of ["https://host/path@x", "https://host:8080/a@b", "write to a@b.example about it", "file:///x", "https://h:99999/x@y"]) assert.equal(scrubUrls(same), same, same);
    const problem = startupEndpointProblem("https://u:abc/def@host/v1", { available: false, condition: "TEMPORARILY_UNAVAILABLE", detail: "Request cannot be constructed from a URL that includes credentials: https://u:abc/def@host/v1", codes: [] } as any)!;
    for (const out of [problem.detail, problem.endpoint, noProviderNotice(problem).detail!, noProviderNotice(problem).text, noProviderRefusal(problem)]) {
      assert.doesNotMatch(out, /abc|def/, out);
    }
  });

  test("no credential in a URL survives into detail or text, on the start-up and the recovery paths", () => {
    const urls = ["http://u:pa)ss@127.0.0.1:1/v1", "ws://user:pass@127.0.0.1:1/v1", "http://user:pass@[::1]:1/v1", "http://user:pass@127.0.0.1:1/v1", "https://TOKENVALUE@host.example/v1?key=SECRETVALUE#frag"];
    for (const url of urls) {
      const probeDetail = `fetch failed (cause: Request cannot be constructed from a URL that includes credentials: ${url}/models)`;
      const problem = startupEndpointProblem(url, { available: false, condition: "TEMPORARILY_UNAVAILABLE", detail: probeDetail } as any)!;
      const n = noProviderNotice(problem);
      const refusal = noProviderRefusal(problem);
      const rec = record(2, { endpoint: url }, { message: `connect failed for ${url}/chat/completions` });
      const status = providerRecoveryStatus(rec, false)!;
      for (const out of [n.text, n.detail!, refusal, status.text, status.detail!, problem.endpoint, problem.detail]) {
        assert.doesNotMatch(out, /user:pass|u:pa|pa\)ss|TOKENVALUE|SECRETVALUE|frag/, out);
      }
    }
  });
});

describe("D-07 review follow-ups", () => {
  test("a prompt sent before the start-up probe ends is gated too", async () => {
    const repo = makeRepo();
    const home = makeHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const app = new ApplicationCore({ endpoint: "http://127.0.0.1:1/v1", model: "local-model", maxSteps: 5, temperature: 0, workspace: repo, shell: "bash", continuation: { ...DEFAULT_CONTINUATION }, approvalMode: "auto", fullAccess: true } as HarnessConfig);
    const events: any[] = [];
    const server = new SidecarServer({ app, mode: "auto", write: (l) => events.push(JSON.parse(l)), historyFile: path.join(home, "history") });
    try {
      server.start();
      // Sent at once, before the start-up probe could have finished: still refused, not retried.
      await server.handleLine(JSON.stringify({ v: 1, type: "prompt.submit", id: "t1", text: "hello" }));
      await server.idle();
      assert.equal(events.find((e) => e.type === "error" && e.id === "t1")?.code, "NO_PROVIDER");
      assert.ok((server as any).providerProblem, "the gate is kept");
    } finally {
      app.shutdown();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("recovery keeps the earlier error in detail, labelled", () => {
    const resumed = providerRecoveryStatus(record(2, { state: "RESUMED", waitedMs: 3_000 }), false)!;
    assert.match(resumed.detail!, /^Recovered; the earlier error was:/);
  });
});
