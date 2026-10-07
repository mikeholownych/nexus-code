/**
 * Regression tests for the "truthful, interruptible turns" slice.
 *
 * Every scenario here was first reproduced against the pre-change code (see
 * docs/reviews/NEXUS_TRUTHFUL_INTERRUPTIBLE_TURNS_2026-10-03.md) using a deterministic local gateway.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AutonomousAgent } from "../src/agent.js";
import { LocalLlmClient, InferenceError } from "../src/client.js";
import { discoverVerifier } from "../src/tester.js";
import {
  assertTurnResultInvariants,
  exitCodeForTurn,
  TurnResult,
  TurnResultInvariantError,
} from "../src/core/turn.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcIndex = path.resolve(here, "../src/index.ts");
const cliRoot = path.resolve(here, "..");

type Reply =
  | { kind: "tools"; calls: Array<{ name: string; args: any }>; content?: string; delayMs?: number }
  | { kind: "text"; content: string; delayMs?: number }
  | { kind: "http"; status: number; body?: string }
  | { kind: "raw"; chunks: string[]; hang?: boolean; resetAfter?: boolean };

interface Gateway {
  url: string;
  requests: Array<{ body: any; id: string | undefined; attempt?: string; previous?: string }>;
  close(): Promise<void>;
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function streamBody(r: Reply & { kind: "tools" | "text" }): string {
  let out = "";
  if (r.kind === "text") out += sse({ choices: [{ index: 0, delta: { content: r.content } }] });
  else {
    if (r.content) out += sse({ choices: [{ index: 0, delta: { content: r.content } }] });
    r.calls.forEach((c, i) => {
      out += sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${i}_${Math.random().toString(36).slice(2, 7)}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] });
    });
  }
  out += sse({ choices: [{ index: 0, delta: {}, finish_reason: r.kind === "tools" ? "tool_calls" : "stop" }] });
  return out + "data: [DONE]\n\n";
}

async function startGateway(script: (n: number, body: any) => Reply): Promise<Gateway> {
  const requests: Gateway["requests"] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "m" }] }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = {};
      try { body = JSON.parse(raw); } catch {}
      requests.push({
        body,
        id: req.headers["x-request-id"] as string | undefined,
        attempt: req.headers["x-aihost-attempt"] as string | undefined,
        previous: req.headers["x-aihost-previous-request"] as string | undefined,
      });
      const r = script(requests.length, body);
      const respond = () => {
        if (r.kind === "http") {
          res.statusCode = r.status;
          res.end(r.body ?? "{}");
        } else if (r.kind === "raw") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          for (const c of r.chunks) res.write(c);
          if (r.resetAfter) res.destroy();
          else if (!r.hang) res.end();
        } else {
          if (body.stream) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(streamBody(r));
          } else {
            res.setHeader("content-type", "application/json");
            const message = r.kind === "text"
              ? { role: "assistant", content: r.content }
              : { role: "assistant", content: r.content ?? null, tool_calls: r.calls.map((c, i) => ({ id: `call_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
            res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: "stop" }] }));
          }
        }
      };
      const delay = (r as any).delayMs as number | undefined;
      if (delay) setTimeout(respond, delay); else respond();
    });
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function makeRepo(files: Record<string, string> = {}): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-turn-"));
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), content);
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: repo, stdio: "ignore" });
  return repo;
}

function newAgent(gw: Gateway, repo: string, extra: Record<string, unknown> = {}): AutonomousAgent {
  return new AutonomousAgent({
    endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash", ...extra,
  } as any);
}

async function withTurn<T>(
  script: (n: number, body: any) => Reply,
  files: Record<string, string>,
  fn: (gw: Gateway, repo: string, agent: AutonomousAgent) => Promise<T>,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const gw = await startGateway(script);
  const repo = makeRepo(files);
  const agent = newAgent(gw, repo, extra);
  try {
    return await fn(gw, repo, agent);
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => fn();

describe("A-1 outcome truth: structured TurnResult", () => {
  test("HTTP 500 is a structured inference failure, not a success", async () => {
    await withTurn(() => ({ kind: "http", status: 500, body: '{"error":"boom"}' }), {}, async (_gw, _repo, agent) => {
      const r = await quiet(() => agent.runTurn("do work"));
      assert.equal(r.execution, "FAILED");
      assert.equal(r.outcome, "NOT_ESTABLISHED");
      assert.equal(r.reason, "INFERENCE_FAILED");
      assert.equal(r.inferenceFailure?.kind, "http_error");
      assert.equal(r.inferenceFailure?.origin, "provider");
      assert.equal(r.inferenceFailure?.httpStatus, 500);
      assert.equal(r.finalOutputComplete, false);
      assert.notEqual(exitCodeForTurn(r), 0);
    });
  });

  test("step-limit exhaustion is LIMIT_REACHED, never completion", async () => {
    await withTurn(() => ({ kind: "tools", calls: [{ name: "list_dir", args: { path: "." } }] }), {}, async (_gw, _repo, agent) => {
      (agent as any).config.maxSteps = 3;
      const r = await quiet(() => agent.runTurn("loop"));
      assert.equal(r.execution, "LIMIT_REACHED");
      assert.equal(r.outcome, "NOT_ESTABLISHED");
      assert.equal(r.steps.limitReached, true);
      assert.equal(r.steps.used, 3);
      assert.equal(exitCodeForTurn(r), 1);
    });
  });

  test("model giving up with prose is distinguishable from verified completion", async () => {
    await withTurn((n) => n === 1
      ? { kind: "tools", calls: [{ name: "write_file", args: { path: "x.txt", content: "draft" } }] }
      : { kind: "text", content: "I could not verify this; stopping." }, { Makefile: "test:\n\t@true\n" }, async (_gw, _repo, agent) => {
      const r = await quiet(() => agent.runTurn("make x"));
      assert.equal(r.execution, "COMPLETED");
      assert.equal(r.modelStop, "FINAL_TEXT");
      assert.equal(r.outcome, "UNVERIFIED");
      assert.equal(r.reason, "VERIFICATION_NOT_RUN");
      assert.equal(r.unverifiedChangesPending, true);
      assert.equal(r.verification, null);
      assert.equal(exitCodeForTurn(r), 2);
    });
  });

  test("a read-only turn that ends with prose needs no verification and is not fabricated as VERIFIED", async () => {
    await withTurn((n) => n === 1
      ? { kind: "tools", calls: [{ name: "list_dir", args: { path: "." } }] }
      : { kind: "text", content: "There is one file." }, {}, async (_gw, _repo, agent) => {
      const r = await quiet(() => agent.runTurn("what is here?"));
      assert.equal(r.execution, "COMPLETED");
      assert.equal(r.outcome, "NOT_REQUIRED");
      assert.equal(r.verification, null);
      assert.equal(r.acceptance, "NOT_REQUESTED");
      assert.equal(exitCodeForTurn(r), 0);
    });
  });

  test("a caller cannot self-assert VERIFIED without passing verifier evidence", () => {
    const forged = {
      execution: "COMPLETED", outcome: "VERIFIED", acceptance: "NOT_REQUESTED", modelStop: "TASK_COMPLETED_TOOL",
      finalOutputComplete: true, verification: null, interruption: null, inferenceFailure: null,
      steps: { used: 1, max: 5, limitReached: false }, unverifiedChangesPending: false, finishedAt: new Date().toISOString(),
    } as TurnResult;
    assert.throws(() => assertTurnResultInvariants(forged), TurnResultInvariantError);
    assert.throws(() => assertTurnResultInvariants({ ...forged, verification: { status: "FAILED", command: "x", exitSuccess: false, at: "t" } }), TurnResultInvariantError);
    assert.throws(() => assertTurnResultInvariants({ ...forged, execution: "INTERRUPTED", verification: { status: "PASSED", command: "x", exitSuccess: true, at: "t" } }), TurnResultInvariantError);
  });
});

describe("A-3 verifier-backed completion", () => {
  const falseVerifierScript = (n: number): Reply =>
    n === 1 ? { kind: "tools", calls: [{ name: "write_file", args: { path: "x.txt", content: "BROKEN" } }] }
    : n === 2 ? { kind: "tools", calls: [{ name: "run_command", args: { command: "echo checking tests" } }] }
    : n === 3 ? { kind: "tools", calls: [{ name: "task_completed", args: { summary: "all tests pass" } }] }
    : { kind: "text", content: "done" };

  test("a command whose TEXT resembles validation does not clear the obligation (failing verifier still runs)", async () => {
    await withTurn(falseVerifierScript, { Makefile: "test:\n\t@false\n" }, async (gw, _repo, agent) => {
      const r = await quiet(() => agent.runTurn("implement"));
      // The oracle ran the real verifier, it failed, task_completed was refused and the model then stopped.
      const toolMsgs = agent.getMessages().filter((m) => m.role === "tool" && m.name === "task_completed");
      assert.equal(toolMsgs.length, 1);
      assert.match(String(toolMsgs[0].content), /Verification Oracle: The selected verifier did not pass/);
      assert.equal(r.outcome, "NOT_ESTABLISHED");
      assert.equal(r.reason, "VERIFIER_FAILED");
      assert.equal(r.verification?.status, "FAILED");
      assert.equal(r.verification?.command, "make test");
      assert.equal(exitCodeForTurn(r), 1);
      assert.equal(gw.requests.length, 4);
    });
  });

  test("the same trajectory with a passing verifier is VERIFIED only through the verifier run", async () => {
    await withTurn(falseVerifierScript, { Makefile: "test:\n\t@true\n" }, async (_gw, _repo, agent) => {
      const r = await quiet(() => agent.runTurn("implement"));
      assert.equal(r.execution, "COMPLETED");
      assert.equal(r.outcome, "VERIFIED");
      assert.equal(r.modelStop, "TASK_COMPLETED_TOOL");
      assert.equal(r.verification?.status, "PASSED");
      assert.equal(r.verification?.source, "discovered");
      assert.equal(r.verification?.command, "make test");
      assert.match(r.verification?.outputSha256 ?? "", /^[0-9a-f]{64}$/);
      assert.equal(r.unverifiedChangesPending, false);
      assert.equal(exitCodeForTurn(r), 0);
    });
  });

  test("a mutation after a passing verification invalidates it", async () => {
    await withTurn((n) =>
      n === 1 ? { kind: "tools", calls: [{ name: "write_file", args: { path: "a.txt", content: "1" } }] }
      : n === 2 ? { kind: "tools", calls: [{ name: "task_completed", args: { summary: "first" } }] }
      : { kind: "text", content: "x" }, { Makefile: "test:\n\t@true\n" }, async (_gw, repo, agent) => {
      const r1 = await quiet(() => agent.runTurn("one"));
      assert.equal(r1.outcome, "VERIFIED");
      // Direct mutation through the agent's spine path: next turn edits a file and stops without re-verifying.
      (agent as any).hasPendingModifications = true;
      (agent as any).verificationEvidence = undefined;
      const r2 = await quiet(() => agent.runTurn("two"));
      assert.equal(r2.outcome, "UNVERIFIED");
      assert.equal(r2.unverifiedChangesPending, true);
    });
  });

  test("no applicable verifier: completion is honestly UNVERIFIED with an explicit reason", async () => {
    await withTurn((n) =>
      n === 1 ? { kind: "tools", calls: [{ name: "write_file", args: { path: "x.txt", content: "hi" } }] }
      : n === 2 ? { kind: "tools", calls: [{ name: "task_completed", args: { summary: "wrote it" } }] }
      : { kind: "text", content: "unexpected extra request" }, {}, async (gw, _repo, agent) => {
      assert.equal(discoverVerifier((agent as any).config.workspace), null);
      const r = await quiet(() => agent.runTurn("make x"));
      assert.equal(r.execution, "COMPLETED");
      assert.equal(r.outcome, "UNVERIFIED");
      assert.equal(r.reason, "NO_APPLICABLE_VERIFIER");
      assert.equal(r.verification?.status, "NO_APPLICABLE_VERIFIER");
      assert.equal(r.verification?.command, undefined);
      assert.equal(r.modelStop, "TASK_COMPLETED_TOOL");
      assert.equal(exitCodeForTurn(r), 2);
      assert.equal(gw.requests.length, 2, "no guessed `npm test` loop: the turn ends once the model completes");
      const tc = agent.getMessages().filter((m) => m.role === "tool" && m.name === "task_completed");
      assert.doesNotMatch(String(tc[0].content), /npm|Verification Oracle/);
    });
  });

  test("discoverVerifier does not guess: bare package.json without a test script has none", () => {
    const repo = makeRepo({ "package.json": JSON.stringify({ name: "x", scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
    try {
      assert.equal(discoverVerifier(repo), null);
      fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node --test" } }));
      assert.equal(discoverVerifier(repo)?.command, "npm test");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("A-4 stream integrity", () => {
  const client = (gw: Gateway) => new LocalLlmClient({ model: "m", endpoint: gw.url, apiKey: "k" } as any);
  const msgs = [{ role: "user" as const, content: "x" }];

  test("clean complete stream (finish_reason + [DONE]) is accepted", async () => {
    const gw = await startGateway(() => ({ kind: "text", content: "all good" }));
    try {
      const m = await client(gw).chatCompletionStream(msgs, [], undefined, "rid-1");
      assert.equal(m.content, "all good");
    } finally { await gw.close(); }
  });

  test("[DONE] alone (no finish_reason) is accepted as terminal evidence", async () => {
    const gw = await startGateway(() => ({ kind: "raw", chunks: [sse({ choices: [{ delta: { content: "ok" } }] }), "data: [DONE]\n\n"] }));
    try {
      assert.equal((await client(gw).chatCompletionStream(msgs, [], undefined, "rid-2")).content, "ok");
    } finally { await gw.close(); }
  });

  test("stream that ends early without a terminal event is stream_incomplete, partial text preserved but not returned", async () => {
    const gw = await startGateway(() => ({ kind: "raw", chunks: [sse({ choices: [{ delta: { content: "I refactored the mod" } }] })] }));
    try {
      await assert.rejects(() => client(gw).chatCompletionStream(msgs, [], undefined, "rid-3"), (e: any) => {
        assert.ok(e instanceof InferenceError);
        assert.equal(e.kind, "stream_incomplete");
        assert.equal(e.partialText, "I refactored the mod");
        assert.equal(e.requestId, "rid-3");
        return true;
      });
    } finally { await gw.close(); }
  });

  test("connection reset mid-stream is stream_interrupted", async () => {
    const gw = await startGateway(() => ({ kind: "raw", chunks: [sse({ choices: [{ delta: { content: "partial" } }] })], resetAfter: true }));
    try {
      await assert.rejects(() => client(gw).chatCompletionStream(msgs, [], undefined, "rid-4"), (e: any) => {
        assert.ok(e instanceof InferenceError);
        assert.ok(["stream_interrupted", "stream_incomplete", "network_error"].includes(e.kind), e.kind);
        return true;
      });
    } finally { await gw.close(); }
  });

  test("provider error frame mid-stream is a structured failure, not silently ignored", async () => {
    const gw = await startGateway(() => ({
      kind: "raw",
      chunks: [sse({ choices: [{ delta: { content: "Partial answer" } }] }), sse({ error: { message: "worker crashed", type: "server_error" } })],
    }));
    try {
      await assert.rejects(() => client(gw).chatCompletionStream(msgs, [], undefined, "rid-5"), (e: any) => {
        assert.ok(e instanceof InferenceError);
        assert.equal(e.kind, "provider_error_frame");
        assert.equal(e.origin, "provider");
        assert.match(e.message, /worker crashed/);
        assert.equal(e.partialText, "Partial answer");
        return true;
      });
    } finally { await gw.close(); }
  });

  test("malformed event is a client-visible protocol failure and is not retried on another endpoint", async () => {
    const primary = await startGateway(() => ({ kind: "raw", chunks: ["data: {not json\n\n", "data: [DONE]\n\n"] }));
    const backup = await startGateway(() => ({ kind: "text", content: "backup answer" }));
    try {
      const c = new LocalLlmClient({ model: "m", endpoint: primary.url, apiKey: "k", fallbackEndpoints: [backup.url] } as any);
      await assert.rejects(() => c.chatCompletionStream(msgs, [], undefined, "rid-6"), (e: any) => e.kind === "malformed_event");
      assert.equal(backup.requests.length, 0, "client-originated protocol errors must not fail over");
    } finally { await primary.close(); await backup.close(); }
  });

  test("timeout mid-stream is a timeout failure; partial text is not promoted", async () => {
    const prev = process.env.LOCAL_LLM_TIMEOUT_MS;
    process.env.LOCAL_LLM_TIMEOUT_MS = "400";
    const gw = await startGateway(() => ({ kind: "raw", chunks: [sse({ choices: [{ delta: { content: "half an ans" } }] })], hang: true }));
    try {
      await assert.rejects(() => client(gw).chatCompletionStream(msgs, [], undefined, "rid-7"), (e: any) => {
        assert.ok(e instanceof InferenceError);
        assert.equal(e.kind, "timeout");
        assert.equal(e.partialText, "half an ans");
        return true;
      });
    } finally {
      if (prev === undefined) delete process.env.LOCAL_LLM_TIMEOUT_MS; else process.env.LOCAL_LLM_TIMEOUT_MS = prev;
      await gw.close();
    }
  });

  test("operator abort is 'aborted', is not failed over, and is distinct from timeout", async () => {
    const primary = await startGateway(() => ({ kind: "raw", chunks: [sse({ choices: [{ delta: { content: "x" } }] })], hang: true }));
    const backup = await startGateway(() => ({ kind: "text", content: "backup" }));
    try {
      const c = new LocalLlmClient({ model: "m", endpoint: primary.url, apiKey: "k", fallbackEndpoints: [backup.url] } as any);
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 150);
      await assert.rejects(() => c.chatCompletionStream(msgs, [], undefined, "rid-8", ac.signal), (e: any) => {
        assert.equal(e.kind, "aborted");
        assert.equal(e.origin, "operator");
        return true;
      });
      assert.equal(backup.requests.length, 0);
    } finally { await primary.close(); await backup.close(); }
  });

  test("non-streaming fallback for an empty stream is a new request with its own X-Request-ID", async () => {
    const gw = await startGateway((n, body) => body.stream
      ? { kind: "raw", chunks: [sse({ choices: [{ delta: {}, finish_reason: "stop" }] }), "data: [DONE]\n\n"] }
      : { kind: "text", content: "from fallback" });
    try {
      const m = await client(gw).chatCompletionStream(msgs, [], undefined, "rid-9");
      assert.equal(m.content, "from fallback");
      assert.equal(gw.requests.length, 2);
      const [first, second] = gw.requests;
      assert.equal(first.id, "rid-9");
      assert.equal(first.attempt, undefined);
      assert.ok(second.id && second.id !== "rid-9", "the re-request carries its own X-Request-ID");
      assert.equal(second.attempt, undefined, "no task-retry header: it would change gateway routing");
      assert.equal(second.previous, undefined);
    } finally { await gw.close(); }
  });

  test("agent turn: truncated stream is an INFERENCE_FAILED turn, partial text is not accepted as the answer", async () => {
    await withTurn(() => ({ kind: "raw", chunks: [sse({ choices: [{ delta: { content: "I have refactored the module and all tests pa" } }] })] }), {}, async (_gw, _repo, agent) => {
      const r = await quiet(() => agent.runTurn("refactor"));
      assert.equal(r.execution, "FAILED");
      assert.equal(r.inferenceFailure?.kind, "stream_incomplete");
      assert.equal(r.finalOutputComplete, false);
      assert.equal(r.modelStop, "NONE");
      assert.equal(agent.getMessages().filter((m) => m.role === "assistant").length, 0, "partial text must not enter history as an assistant answer");
    });
  });

  test("agent turn: mid-stream provider error frame is a FAILED turn", async () => {
    await withTurn(() => ({ kind: "raw", chunks: [sse({ choices: [{ delta: { content: "Partial" } }] }), sse({ error: { message: "worker crashed" } })] }), {}, async (_gw, _repo, agent) => {
      const r = await quiet(() => agent.runTurn("refactor"));
      assert.equal(r.execution, "FAILED");
      assert.equal(r.inferenceFailure?.kind, "provider_error_frame");
      assert.equal(r.inferenceFailure?.origin, "provider");
    });
  });
});

describe("A-2 cancellation", () => {
  async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error("timed out waiting for condition");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  test("delayed mutating loop: one cancel admits no new mutation and records INTERRUPTED", async () => {
    let seq = 0;
    await withTurn(() => {
      seq++;
      return { kind: "tools", calls: [{ name: "write_file", args: { path: `loop_${seq}.txt`, content: String(seq) } }], delayMs: 500 };
    }, {}, async (gw, repo, agent) => {
      (agent as any).config.maxSteps = 20;
      const files = () => fs.readdirSync(repo).filter((f) => f.startsWith("loop_"));
      const turn = quiet(() => agent.runTurn("write files forever"));
      await waitFor(() => files().length >= 1);
      const requestsAtCancel = gw.requests.length;
      assert.equal(agent.requestCancel("test"), true);
      assert.equal(agent.requestCancel("test again"), false, "second request is not a new cancellation");
      const t0 = Date.now();
      const r = await turn;
      assert.ok(Date.now() - t0 < 3000, "turn returns promptly after cancellation");
      assert.equal(r.execution, "INTERRUPTED");
      assert.equal(r.outcome, "NOT_ESTABLISHED");
      assert.equal(r.reason, "OPERATOR_INTERRUPT");
      assert.ok(r.interruption);
      assert.equal(exitCodeForTurn(r), 130);
      const atReturn = files();
      await new Promise((res) => setTimeout(res, 1500));
      assert.deepEqual(files(), atReturn, "no mutation occurs after the turn was interrupted");
      // At most the one request that was already in flight when the stop arrived (it is aborted, never answered into history).
      assert.ok(gw.requests.length <= requestsAtCancel + 1, `no new inference request after cancellation (at cancel ${requestsAtCancel}, later ${gw.requests.length})`);
      assert.equal(agent.getTurnLifecycle(), undefined, "agent is idle again");
      // History stays valid for the next turn: every assistant tool_call has a tool result.
      const hist = agent.getMessages();
      for (const [i, m] of hist.entries()) {
        if (m.role === "assistant" && m.tool_calls) {
          for (const tc of m.tool_calls) assert.ok(hist.slice(i + 1).some((x) => x.role === "tool" && x.tool_call_id === tc.id), "tool result present");
        }
      }
      assert.equal(agent.getLastTurnResult()?.execution, "INTERRUPTED");
    });
  });

  test("cancel while a tool is executing: tool is awaited (settling), no further step is admitted", async () => {
    await withTurn((n) => n === 1
      ? { kind: "tools", calls: [{ name: "run_command", args: { command: "sleep 1; touch settled.txt" } }, { name: "write_file", args: { path: "never.txt", content: "no" } }] }
      : { kind: "text", content: "should not be requested" }, {}, async (gw, repo, agent) => {
      const turn = quiet(() => agent.runTurn("slow tool"));
      await waitFor(() => agent.getTurnLifecycle()?.phase === "tool");
      assert.equal(agent.requestCancel("test"), true);
      const r = await turn;
      assert.equal(r.execution, "INTERRUPTED");
      assert.equal(r.interruption?.phase, "tool_settling");
      assert.equal(r.interruption?.outstandingTool, "run_command");
      assert.equal(r.interruption?.outstandingToolSettled, true);
      assert.equal(r.interruption?.undispatchedToolCalls, 1);
      assert.equal(fs.existsSync(path.join(repo, "settled.txt")), true, "in-flight command was allowed to settle");
      assert.equal(fs.existsSync(path.join(repo, "never.txt")), false, "queued tool call was never dispatched");
      assert.equal(gw.requests.length, 1);
    });
  });

  test("an external AbortSignal is honoured as the cancellation authority", async () => {
    await withTurn(() => ({ kind: "text", content: "slow answer", delayMs: 3000 }), {}, async (_gw, _repo, agent) => {
      const ac = new AbortController();
      const turn = quiet(() => agent.runTurn("x", undefined, { signal: ac.signal }));
      setTimeout(() => ac.abort(), 200);
      const t0 = Date.now();
      const r = await turn;
      assert.ok(Date.now() - t0 < 2000);
      assert.equal(r.execution, "INTERRUPTED");
      assert.equal(r.interruption?.phase, "inference");
    });
  });

  test("an agent can run a normal turn after an interrupted one", async () => {
    let n = 0;
    await withTurn(() => {
      n++;
      return n === 1 ? ({ kind: "text", content: "slow", delayMs: 2000 } as Reply) : { kind: "text", content: "second turn answer" };
    }, {}, async (_gw, _repo, agent) => {
      const first = quiet(() => agent.runTurn("one"));
      await waitFor(() => agent.getTurnLifecycle()?.phase === "inference");
      agent.requestCancel("test");
      assert.equal((await first).execution, "INTERRUPTED");
      const second = await quiet(() => agent.runTurn("two"));
      assert.equal(second.execution, "COMPLETED");
      assert.equal(second.modelStop, "FINAL_TEXT");
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Process-level contract: `harness run` exit codes and interactive REPL Ctrl-C behaviour.
// ---------------------------------------------------------------------------------------------------------------

function runCli(gw: Gateway, repo: string, home: string, prompt: string, extraArgs: string[] = []): Promise<{ code: number | null; json: any; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", srcIndex, "run", "-w", repo, "-e", gw.url, "-m", "m", "-j", "-s", "5", ...extraArgs, prompt], {
      cwd: cliRoot, env: { ...process.env, HOME: home },
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", () => {});
    const killer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("close", (code) => {
      clearTimeout(killer);
      let json: any;
      try { json = JSON.parse(stdout); } catch { json = undefined; }
      resolve({ code, json, stdout });
    });
  });
}

describe("process exit contract (harness run)", () => {
  const cases: Array<{ name: string; script: (n: number) => Reply; files: Record<string, string>; code: number; outcome: string; execution: string; success: boolean }> = [
    { name: "HTTP 500", script: () => ({ kind: "http", status: 500 }), files: {}, code: 1, outcome: "NOT_ESTABLISHED", execution: "FAILED", success: false },
    { name: "step limit", script: () => ({ kind: "tools", calls: [{ name: "list_dir", args: { path: "." } }] }), files: {}, code: 1, outcome: "NOT_ESTABLISHED", execution: "LIMIT_REACHED", success: false },
    { name: "read-only prose answer", script: (n) => n === 1 ? { kind: "tools", calls: [{ name: "list_dir", args: { path: "." } }] } : { kind: "text", content: "one file" }, files: {}, code: 0, outcome: "NOT_REQUIRED", execution: "COMPLETED", success: true },
    { name: "verified completion", script: (n) => n === 1 ? { kind: "tools", calls: [{ name: "write_file", args: { path: "a.txt", content: "1" } }] } : n === 2 ? { kind: "tools", calls: [{ name: "task_completed", args: { summary: "ok" } }] } : { kind: "text", content: "x" }, files: { Makefile: "test:\n\t@true\n" }, code: 0, outcome: "VERIFIED", execution: "COMPLETED", success: true },
    { name: "completed without applicable verifier", script: (n) => n === 1 ? { kind: "tools", calls: [{ name: "write_file", args: { path: "a.txt", content: "1" } }] } : n === 2 ? { kind: "tools", calls: [{ name: "task_completed", args: { summary: "ok" } }] } : { kind: "text", content: "x" }, files: {}, code: 2, outcome: "UNVERIFIED", execution: "COMPLETED", success: false },
  ];
  for (const c of cases) {
    test(`${c.name} -> exit ${c.code}`, async () => {
      const gw = await startGateway((n) => c.script(n));
      const repo = makeRepo(c.files);
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-home-"));
      try {
        const r = await runCli(gw, repo, home, "do the task");
        assert.ok(r.json, `JSON output expected, got: ${r.stdout.slice(0, 300)}`);
        assert.equal(r.code, c.code);
        assert.equal(r.json.exitCode, c.code);
        assert.equal(r.json.turn.execution, c.execution);
        assert.equal(r.json.turn.outcome, c.outcome);
        assert.equal(r.json.success, c.success);
      } finally {
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

const hasScript = spawnSync("script", ["--version"], { encoding: "utf-8" }).status === 0;

describe("interactive REPL (pty)", { skip: hasScript ? false : "util-linux `script` not available" }, () => {
  async function session(gw: Gateway, repo: string, home: string) {
    const cmd = `${JSON.stringify(process.execPath)} --import tsx ${JSON.stringify(srcIndex)} repl -w ${JSON.stringify(repo)} -e ${JSON.stringify(gw.url)} -m m`;
    const child = spawn("script", ["-qfec", cmd, "/dev/null"], { cwd: cliRoot, env: { ...process.env, HOME: home, TERM: "xterm", COLUMNS: "120", LINES: "40" } });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    const strip = () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    const waitFor = async (re: RegExp, from: number, ms = 30000): Promise<number> => {
      const t0 = Date.now();
      for (;;) {
        const s = strip();
        const m = re.exec(s.slice(from));
        if (m) return from + m.index + m[0].length;
        if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${re}; output tail: ${s.slice(-800)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    return { child, strip, waitFor, send: (s: string) => child.stdin.write(s), mark: () => strip().length };
  }

  test("Ctrl-C during a delayed mutating trajectory: one interrupt, no new mutation, prompt returns, next turn works", async () => {
    let seq = 0;
    const gw = await startGateway((n) => {
      if (n >= 100) return { kind: "text", content: "second prompt answer" };
      seq++;
      return { kind: "tools", calls: [{ name: "write_file", args: { path: `loop_${seq}.txt`, content: String(seq) } }], delayMs: 700 };
    });
    const repo = makeRepo();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-home-"));
    const s = await session(gw, repo, home);
    try {
      let pos = await s.waitFor(/❯ /, 0);
      s.send("write files forever\n");
      const t0 = Date.now();
      while (!fs.readdirSync(repo).some((f) => f.startsWith("loop_"))) {
        if (Date.now() - t0 > 20000) throw new Error("no mutation observed");
        await new Promise((r) => setTimeout(r, 30));
      }
      s.send("\x03"); // exactly one Ctrl-C
      pos = await s.waitFor(/TURN INTERRUPTED/, pos, 15000);
      pos = await s.waitFor(/❯ /, pos, 15000);
      await new Promise((r) => setTimeout(r, 500));
      const atPrompt = fs.readdirSync(repo).filter((f) => f.startsWith("loop_"));
      const reqAtPrompt = gw.requests.length;
      await new Promise((r) => setTimeout(r, 2000));
      assert.deepEqual(fs.readdirSync(repo).filter((f) => f.startsWith("loop_")), atPrompt, "no mutation after the interrupt was accepted");
      assert.equal(gw.requests.length, reqAtPrompt);
      assert.ok(s.child.exitCode === null, "REPL process is still alive (usable prompt)");
      assert.doesNotMatch(s.strip(), /TASK COMPLETED/);
      // The session is still usable: positive normal turn after the interrupt.
      while (gw.requests.length < 99) gw.requests.push({ body: {}, id: undefined });
      s.send("second prompt\n");
      pos = await s.waitFor(/NO CHANGES TO VERIFY|TURN ENDED/, pos, 20000);
      await s.waitFor(/❯ /, pos, 15000);
      // Persisted session records the interruption of the first turn? (last turn is the second one)
      s.send("/exit\n");
      await new Promise<void>((resolve) => s.child.on("exit", () => resolve()));
    } finally {
      if (s.child.exitCode === null) s.child.kill("SIGKILL");
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("multiple prompts in one session keep working; Ctrl-C at idle still exits deliberately", async () => {
    // Each prompt: one read-only tool call, then prose. Tool use starts the Rust RPC daemon, which idle Ctrl-C must also stop.
    const gw = await startGateway((n) => n % 2 === 1
      ? { kind: "tools", calls: [{ name: "list_dir", args: { path: "." } }] }
      : { kind: "text", content: `answer ${n}` });
    const repo = makeRepo();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-home-"));
    const s = await session(gw, repo, home);
    try {
      let pos = await s.waitFor(/❯ /, 0);
      for (const p of ["first", "second", "third"]) {
        s.send(`${p}\n`);
        pos = await s.waitFor(/TURN ENDED - NO CHANGES TO VERIFY/, pos, 20000);
        pos = await s.waitFor(/❯ /, pos, 15000);
      }
      assert.equal(gw.requests.length, 6);
      const exited = new Promise<number | null>((resolve) => s.child.on("exit", (c) => resolve(c)));
      s.send("\x03");
      await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error("idle Ctrl-C did not exit")), 10000))]);
    } finally {
      if (s.child.exitCode === null) s.child.kill("SIGKILL");
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
