/**
 * TI-1: what the model is actually sent. Every scenario runs the real agent against a scripted gateway and captures the
 * chat/completions bodies. Each body is reduced to a deterministic shape (roles, message kinds, tool names, tool_choice,
 * key presence; no ids, paths, hashes or prompt text) and compared with test/fixtures/request_shape/*.json.
 * NEXUS_UPDATE_SNAPSHOTS=1 rewrites the files. The invariants that matter are also asserted directly, so a blind
 * snapshot update cannot hide them.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { SessionManager } from "../src/session.js";
import { PINNED_LEDGER_PREFIX } from "../src/core/objective.js";
import { CONTENT_CALL_NOTE } from "../src/core/content_tool_call.js";
import { startGateway, makeRepo, Reply } from "./helpers/fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const snapshotDir = path.join(here, "fixtures", "request_shape");

let home = "";
let previousHome: string | undefined;
before(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-rs-home-"));
  process.env.HOME = home;
});
after(() => {
  process.env.HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const quiet = (agent: AutonomousAgent) => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (endpoint: string, workspace: string): HarnessConfig => ({
  endpoint,
  model: "m",
  maxSteps: 30,
  temperature: 0,
  workspace,
  shell: "bash",
  approvalMode: "auto",
  fullAccess: true,
  continuation: { ...DEFAULT_CONTINUATION },
});
const write = (name: string): Reply => ({ kind: "tools", calls: [{ name: "write_file", args: { path: name, content: `${name}\n` } }] });
const text = (content: string): Reply => ({ kind: "text", content });
const contentCall: Reply = text('{"name":"write_file","arguments":{"path":"a.txt","content":"a\\n"}}');

const textOf = (m: any): string => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""));

type Kind = "system-prompt" | "pinned-ledger" | "context-memory" | "retry-note" | "continuation-nudge" | "user" | "assistant-text" | "assistant-tool-calls" | "tool-result";

function kindOf(m: any, index: number): Kind {
  const body = textOf(m);
  if (m.role === "system") return body.startsWith(PINNED_LEDGER_PREFIX) ? "pinned-ledger" : body.startsWith("[Structured Context Memory") ? "context-memory" : "system-prompt";
  if (m.role === "tool") return "tool-result";
  if (m.role === "assistant") return Array.isArray(m.tool_calls) && m.tool_calls.length ? "assistant-tool-calls" : "assistant-text";
  if (body === CONTENT_CALL_NOTE) return "retry-note";
  if (body.startsWith("[Nexus continuation")) return "continuation-nudge";
  assert.ok(m.role === "user", `unexpected role ${m.role} at ${index}`);
  return "user";
}

/** Structure only: ids become ordinals and prompt text is dropped. */
function shapeOf(body: any): unknown {
  const ids = new Map<string, string>();
  const ordinal = (id: unknown) => {
    const key = String(id);
    if (!ids.has(key)) ids.set(key, `call#${ids.size + 1}`);
    return ids.get(key)!;
  };
  return {
    keys: Object.keys(body).sort(),
    stream: body.stream ?? null,
    tool_choice: body.tool_choice ?? null,
    tools: (body.tools ?? []).map((t: any) => t.function.name).sort(),
    messages: (body.messages as any[]).map((m, i) => ({
      role: m.role,
      kind: kindOf(m, i),
      keys: Object.keys(m).sort(),
      ...(m.tool_calls ? { tool_calls: m.tool_calls.map((c: any) => ({ id: ordinal(c.id), type: c.type, name: c.function.name })) } : {}),
      ...(m.tool_call_id ? { tool_call_id: ordinal(m.tool_call_id), name: m.name } : {}),
    })),
  };
}

function expectSnapshot(name: string, actual: unknown): void {
  const file = path.join(snapshotDir, `${name}.json`);
  const json = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env.NEXUS_UPDATE_SNAPSHOTS === "1") {
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(file, json);
    return;
  }
  assert.ok(fs.existsSync(file), `missing snapshot ${file}; run with NEXUS_UPDATE_SNAPSHOTS=1`);
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(fs.readFileSync(file, "utf8")), `request shape ${name} changed; review and rerun with NEXUS_UPDATE_SNAPSHOTS=1 if intended`);
}

/** Nothing Nexus keeps for itself may reach the provider: no internal field on any message or the body. */
function assertNoInternalFields(bodies: any[]): void {
  for (const body of bodies) {
    assert.ok(!JSON.stringify(Object.keys(body)).match(/toolCallSource/), "toolCallSource is not a body key");
    for (const m of body.messages) {
      assert.deepEqual(Object.keys(m).filter((k) => !["role", "content", "tool_calls", "tool_call_id", "name"].includes(k)), [], `unexpected message key on ${m.role}`);
      assert.ok(!("toolCallSource" in m));
    }
    assert.doesNotMatch(JSON.stringify(body.messages), /toolCallSource/);
  }
}

function assertToolIdsPaired(body: any): void {
  const offered = new Set<string>();
  for (const m of body.messages) {
    if (m.role === "assistant") for (const c of m.tool_calls ?? []) offered.add(c.id);
    if (m.role === "tool") assert.ok(offered.has(m.tool_call_id), `tool result ${m.tool_call_id} answers a call that was sent earlier`);
  }
}

async function withAgent<T>(script: (n: number, body: any) => Reply, run: (agent: AutonomousAgent, requests: any[], repo: string) => Promise<T>): Promise<T> {
  const repo = makeRepo();
  const gw = await startGateway(script);
  const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
  try {
    return await run(agent, gw.requests as any[], repo);
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

describe("TI-1 request shape", () => {
  test("first turn and after a tool call: system prompt, pinned ledger, user turn, tools, tool_choice auto, paired tool ids", { timeout: 60_000 }, async () => {
    await withAgent((n) => (n === 1 ? write("a.txt") : text("done")), async (agent, requests) => {
      await agent.runTurn("1. Write a.txt\n2. Keep it short");
      assert.ok(requests.length >= 2);
      const [first, second] = requests;
      assert.deepEqual(first.messages.map((m: any) => m.role), ["system", "system", "user"]);
      assert.equal(kindOf(first.messages[0], 0), "system-prompt");
      assert.equal(kindOf(first.messages[1], 1), "pinned-ledger", "the pinned ledger follows the system prompt");
      assert.equal(first.tool_choice, "auto");
      for (const name of ["write_file", "read_file", "run_command", "task_completed"]) assert.ok(first.tools.some((t: any) => t.function.name === name), name);
      const tools = first.tools.map((t: any) => t.function.name);
      assert.deepEqual(second.tools.map((t: any) => t.function.name), tools);
      assert.deepEqual([second.messages[0], second.messages[2]], [first.messages[0], first.messages[2]], "system prompt and user turn are resent unchanged");
      const tail = second.messages.slice(3, 5);
      assert.deepEqual(tail.map((m: any) => m.role), ["assistant", "tool"]);
      assert.equal(tail[1].tool_call_id, tail[0].tool_calls[0].id, "the tool result names the call it answers");
      assert.equal(tail[1].name, "write_file");
      for (const r of requests) assertToolIdsPaired(r);
      assertNoInternalFields(requests);
      expectSnapshot("first_turn", shapeOf(first));
      expectSnapshot("after_tool_call", shapeOf(second));
    });
  });

  test("a call written as text: the re-ask carries the note with tool_choice unchanged, then required; retry turns and toolCallSource never reach the history or the wire", { timeout: 60_000 }, async () => {
    await withAgent(
      (n, body) => {
        if (body.tool_choice === "required") return write("a.txt");
        return JSON.stringify(body.messages).includes("plain text is never executed") || n === 1 ? contentCall : text("done");
      },
      async (agent, requests) => {
        await agent.runTurn("write a.txt");
        const first = requests[0];
        const note = requests[1];
        const forced = requests[2];
        assert.equal(first.tool_choice, "auto");
        assert.equal(note.tool_choice, "auto", "the first re-ask leaves tool_choice unchanged");
        assert.equal(forced.tool_choice, "required", "only the second re-ask forces a call");
        for (const r of [note, forced]) {
          const last = r.messages.at(-1);
          assert.equal(last.role, "user");
          assert.equal(last.content, CONTENT_CALL_NOTE);
          assert.deepEqual(r.messages.at(-2), { role: "assistant", content: (contentCall as { content: string }).content }, "the model's own text reply precedes the note");
        }
        const noted = (r: any) => r.messages.filter((m: any) => m.content === CONTENT_CALL_NOTE).length;
        assert.deepEqual(requests.map(noted).slice(0, 3), [0, 1, 1]);
        for (const later of requests.slice(3)) {
          assert.equal(noted(later), 0, "the retry turns exist only in the retry requests");
          assert.equal(later.tool_choice, "auto", "tool_choice goes back to auto");
        }
        assert.ok(requests.length > 3, "the forced native call ran and the loop continued");
        assert.ok(requests[3].messages.some((m: any) => m.role === "tool" && m.name === "write_file"));
        assertNoInternalFields(requests);
        expectSnapshot("retry_note", { first: shapeOf(first), note: shapeOf(note), forced: shapeOf(forced), after: shapeOf(requests[3]) });
      },
    );
  });

  test("compaction: fewer messages, every gating requirement still in the pinned ledger, a marked summary, no internal fields", { timeout: 120_000 }, async () => {
    await withAgent((n) => (n <= 4 ? write(`w${n}.txt`) : text("paused")), async (agent, requests) => {
      await agent.runTurn("1. Write w1..w4\n2. Keep every file under 10 bytes");
      const beforeCount = requests.length;
      const lastBefore = requests.at(-1);
      const result = await agent.compactNow(false);
      assert.equal(result.ok, true, result.message);
      await agent.runTurn("go on");
      const after = requests[beforeCount];
      assert.ok(after, "a request follows the compaction");
      assert.ok(after.messages.length < lastBefore.messages.length + 2, "the compacted conversation is shorter than it would have been");
      const ledger = after.messages.find((m: any) => kindOf(m, 0) === "pinned-ledger");
      assert.ok(ledger, "the pinned ledger survives compaction");
      assert.match(ledger.content, /- R1 \[[a-z_]+\] Write w1\.\.w4/);
      assert.match(ledger.content, /- R2 \[[a-z_]+\] Keep every file under 10 bytes/);
      assert.equal(after.messages.filter((m: any) => kindOf(m, 0) === "pinned-ledger").length, 1, "one ledger, not one per generation");
      const summaries = after.messages.filter((m: any) => kindOf(m, 0) === "context-memory");
      assert.equal(summaries.length, 1, "exactly one compaction summary, marked as such");
      assert.equal(summaries[0].role, "system");
      assert.ok(!lastBefore.messages.some((m: any) => kindOf(m, 0) === "context-memory"), "no summary before compaction");
      const toolResults = (r: any) => r.messages.filter((m: any) => m.role === "tool").length;
      assert.ok(toolResults(after) < toolResults(lastBefore), "compaction removed tool results from the request");
      assert.equal(after.tool_choice, "auto");
      assertNoInternalFields([lastBefore, after]);
      expectSnapshot("before_compaction", shapeOf(lastBefore));
      expectSnapshot("after_compaction", shapeOf(after));
    });
  });

  test("resume: the restored conversation is sent as the same messages (ledger intact) followed by the new user turn", { timeout: 120_000 }, async () => {
    const repo = makeRepo();
    let reply: (n: number) => Reply = (n) => (n <= 2 ? write(`r${n}.txt`) : text("paused"));
    const gw = await startGateway((n) => reply(n));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    let restored: AutonomousAgent | undefined;
    try {
      const sessions = new SessionManager(path.join(home, "sessions-shape"), () => agent.getWorkspacePathIdentity());
      const sessionId = sessions.generateSessionId();
      await agent.runTurn("1. Write r1 and r2\n2. Keep files tiny");
      const requests = gw.requests as any[];
      const preCount = requests.length;
      const pre = requests.at(-1);
      sessions.saveSession({ id: sessionId, workspace: repo, model: "m", messages: agent.getMessages(), objective: agent.getObjective() ?? null, findings: agent.getFindings(), history: agent.getHistoryCompleteness() }, agent.getWorkspacePathIdentity());
      const saved = sessions.loadSession(sessionId)!;
      restored = quiet(new AutonomousAgent(cfg(gw.url, repo)));
      assert.equal(restored.restoreConversation(saved, (committed) => sessions.readArchivedHistory(sessionId, committed)), undefined);
      reply = () => text("resumed");
      await restored.runTurn("continue please");
      const post = requests[preCount];
      assert.ok(post, "the resumed turn sent a request");
      // A random temp workspace path is sometimes redacted as a high-entropy token on its way through the saved session.
      const comparable = (m: any) => (m.role === "system" ? { ...m, content: textOf(m).replace(/^- Workspace directory: .*$/m, "- Workspace directory: <ws>") } : m);
      const stable = (m: any) => kindOf(m, 0) !== "pinned-ledger";
      const preStable = pre.messages.filter(stable).map(comparable);
      const postStable = post.messages.filter(stable).map(comparable);
      assert.deepEqual(postStable.slice(0, preStable.length), preStable, "every pre-resume message is sent unchanged, in order");
      const extra = postStable.slice(preStable.length);
      assert.ok(extra.some((m: any) => m.role === "user" && String(m.content).startsWith("continue please")), "the new user message follows the old conversation");
      const ledger = post.messages.filter((m: any) => kindOf(m, 0) === "pinned-ledger");
      assert.equal(ledger.length, 1);
      assert.equal(post.messages.indexOf(ledger[0]), pre.messages.findIndex((m: any) => kindOf(m, 0) === "pinned-ledger"), "the ledger keeps its position");
      assert.match(ledger[0].content, /- R1 \[[a-z_]+\] Write r1 and r2/);
      assert.match(ledger[0].content, /- R2 \[[a-z_]+\] Keep files tiny/);
      assert.equal(post.tool_choice, "auto");
      assertNoInternalFields([pre, post]);
      expectSnapshot("before_resume", shapeOf(pre));
      expectSnapshot("after_resume", shapeOf(post));
    } finally {
      agent.shutdown();
      restored?.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
