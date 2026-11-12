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
import { encodeEvent, noProviderNotice, providerRecoveryStatus } from "../src/protocol.js";
import { startupEndpointProblem } from "../src/core/provider_recovery.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
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

  test("rejected credentials get their own wording", () => {
    const n = noProviderNotice(startupEndpointProblem("https://api.example.test/v1", { available: true, condition: "AVAILABLE", httpStatus: 401 } as any)!);
    assert.match(n.text, /rejected the credentials/i);
    assert.match(n.text, /\/connect/);
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
      for (let i = 0; i < 200 && !events.some((e) => e.type === "notice" && /No model is connected/.test(e.text)); i++) await new Promise((r) => setImmediate(r));
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
