import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ApplicationCore } from "../src/core/app.js";
import { hasPendingStateRestore, restoreFromSources } from "../src/core/state_restore.js";
import { SidecarOptions, SidecarServer } from "../src/sidecar.js";
import { slashCatalog } from "../src/slash/catalog.js";
import { startGateway, makeRepo, makeHome, waitForEvent, waitUntil, Reply } from "./helpers/fixtures.js";

interface Rig {
  server: SidecarServer;
  events: any[];
  repo: string;
  app: ApplicationCore;
  send(msg: Record<string, unknown>): Promise<void>;
}

async function withSidecar(
  script: (n: number) => Reply,
  mode: "auto" | "review",
  fn: (rig: Rig) => Promise<void>,
  onShutdown?: () => void,
  setup?: (app: ApplicationCore) => Partial<SidecarOptions>,
): Promise<void> {
  const gw = await startGateway(script);
  const repo = makeRepo();
  const home = makeHome();
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash", approvalMode: mode, fullAccess: mode === "auto" } as any);
  const events: any[] = [];
  const server = new SidecarServer({ app, mode, write: (line) => events.push(JSON.parse(line)), onShutdown, ...setup?.(app) });
  server.start();
  try {
    await fn({ server, events, repo, app, send: (msg) => server.handleLine(JSON.stringify({ v: 1, ...msg })) });
  } finally {
    await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
    await server.idle();
    app.shutdown();
    await gw.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const readOnlyTurn = (n: number): Reply => n === 1
  ? { kind: "tools", calls: [{ name: "list_dir", args: { path: "." } }] }
  : { kind: "text", content: "There is one file." };

describe("SidecarServer: session and turns", () => {
  test("start announces the protocol and an idle session", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ events, repo }) => {
      assert.deepEqual(events[0], { v: 1, type: "hello", protocol: 1, pid: process.pid, commands: slashCatalog() });
      const state = events[1];
      assert.equal(state.type, "session.state");
      assert.equal(state.workspace, repo);
      assert.equal(state.workspace_name, path.basename(repo));
      assert.equal(state.model, "m");
      assert.equal(state.mode, "auto");
      assert.equal(state.busy, false);
      assert.ok(state.git && typeof state.git.branch === "string" && typeof state.git.dirty === "number");
    });
  });

  test("a read-only turn streams tool and text events, then a truthful turn.result", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "what is here?" });
      await server.idle();
      const turnEvents = events.slice(2);
      assert.deepEqual(turnEvents[0], { ...turnEvents[0], type: "session.state", busy: true });
      const start = turnEvents.find((e) => e.type === "tool.start");
      assert.equal(start.turn_id, "t1");
      assert.equal(start.tool, "list_dir");
      assert.equal(start.subject, ".");
      const end = turnEvents.find((e) => e.type === "tool.end");
      assert.equal(end.call_id, start.call_id);
      assert.equal(end.success, true);
      const text = turnEvents.filter((e) => e.type === "assistant.delta").map((e) => e.text).join("");
      assert.equal(text, "There is one file.");
      const result = turnEvents.find((e) => e.type === "turn.result");
      assert.equal(result.turn_id, "t1");
      assert.equal(result.turn.execution, "COMPLETED");
      assert.equal(result.turn.outcome, "NOT_REQUIRED");
      assert.equal(result.heading, "TURN ENDED - NO CHANGES TO VERIFY");
      assert.deepEqual(turnEvents.at(-1), { ...turnEvents.at(-1), type: "session.state", busy: false });
      const order = turnEvents.map((e) => e.type);
      assert.ok(order.indexOf("tool.end") < order.indexOf("assistant.delta"));
      assert.ok(order.indexOf("assistant.delta") < order.indexOf("turn.result"));
      for (const e of events) assert.equal(e.v, 1);
    });
  });

  test("an inference failure is projected as FAILED, not success", async () => {
    await withSidecar(() => ({ kind: "http", status: 500, body: '{"error":"boom"}' }), "auto", async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "do work" });
      await server.idle();
      const result = events.find((e) => e.type === "turn.result");
      assert.equal(result.turn.execution, "FAILED");
      assert.equal(result.turn.reason, "INFERENCE_FAILED");
      assert.equal(result.model_summary, null);
    });
  });

  test("turn.result redacts secrets inside the embedded turn object", async () => {
    const body = '{"error":"upstream rejected Bearer abcdefghijklmnopqrstuvwxyz0123"}';
    await withSidecar(() => ({ kind: "http", status: 500, body }), "auto", async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "do work" });
      await server.idle();
      const result = events.find((e) => e.type === "turn.result");
      assert.equal(result.turn.execution, "FAILED");
      assert.equal(JSON.stringify(result).includes("Bearer abcdefghijklmnopqrstuvwxyz0123"), false);
      assert.equal(JSON.stringify(result).includes("abcdefghijklmnopqrstuvwxyz0123"), false);
    });
  });

  test("an exception escaping runTurn is reported as INTERNAL and idle() still resolves", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events, send }) => {
      const app = (server as any).app;
      const getAgent = app.getAgent.bind(app);
      let calls = 0;
      app.getAgent = () => {
        calls += 1;
        if (calls === 3) {
          app.getAgent = getAgent;
          throw new Error("agent exploded token=supersecretvalue");
        }
        return getAgent();
      };
      await send({ type: "prompt.submit", id: "t1", text: "x" });
      await server.idle();
      const err = events.find((e) => e.type === "error" && e.id === "t1");
      assert.equal(err.code, "INTERNAL");
      assert.equal(err.message.includes("supersecretvalue"), false);
      assert.deepEqual(events.at(-1), { ...events.at(-1), type: "session.state", busy: false });
    });
  });

  test("a second prompt while busy is rejected with BUSY", async () => {
    await withSidecar(() => ({ kind: "text", content: "slow", delayMs: 1500 }), "auto", async ({ events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "one" });
      await send({ type: "prompt.submit", id: "t2", text: "two" });
      const busy = await waitForEvent(events, (e) => e.type === "error" && e.id === "t2");
      assert.equal(busy.code, "BUSY");
    });
  });

  test("malformed lines produce BAD_REQUEST errors", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events }) => {
      await server.handleLine("not json");
      await server.handleLine(JSON.stringify({ v: 1, type: "prompt.submit", id: "x", text: "" }));
      const errors = events.filter((e) => e.type === "error");
      assert.equal(errors.length, 2);
      assert.equal(errors[0].code, "BAD_REQUEST");
      assert.equal(errors[0].id, undefined);
      assert.equal(errors[1].code, "BAD_REQUEST");
      assert.equal(errors[1].id, "x");
    });
  });
});

const writeTurn = (n: number): Reply => n === 1
  ? { kind: "tools", calls: [{ name: "write_file", args: { path: "x.txt", content: "hi" } }] }
  : { kind: "text", content: "ok" };

describe("SidecarServer: approvals", () => {
  test("deny keeps the file unwritten and reports the tool as failed", async () => {
    await withSidecar(writeTurn, "review", async ({ server, events, repo, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "make x" });
      const req = await waitForEvent(events, (e) => e.type === "approval.request");
      assert.equal(req.turn_id, "t1");
      assert.equal(req.tool, "write_file");
      assert.equal(req.subject, "x.txt");
      assert.ok(req.preview.includes("x.txt"));
      assert.deepEqual(req.review, { kind: "change", path: "x.txt", before: null, after: "hi", created: true, truncated: false });
      await send({ type: "deny", id: req.id });
      await server.idle();
      assert.equal(fs.existsSync(path.join(repo, "x.txt")), false);
      const end = events.find((e) => e.type === "tool.end" && e.tool === "write_file");
      assert.equal(end.success, false);
      assert.ok(events.some((e) => e.type === "turn.result"));
    });
  });

  test("approve lets the write happen", async () => {
    await withSidecar(writeTurn, "review", async ({ server, events, repo, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "make x" });
      const req = await waitForEvent(events, (e) => e.type === "approval.request");
      await send({ type: "approve", id: req.id });
      await server.idle();
      assert.equal(fs.readFileSync(path.join(repo, "x.txt"), "utf-8"), "hi");
    });
  });

  test("approve with always=true stops asking for the rest of the session", async () => {
    const script = (n: number): Reply => n === 1
      ? { kind: "tools", calls: [{ name: "write_file", args: { path: "a.txt", content: "a" } }] }
      : n === 2
        ? { kind: "tools", calls: [{ name: "write_file", args: { path: "b.txt", content: "b" } }] }
        : { kind: "text", content: "done" };
    await withSidecar(script, "review", async ({ server, events, repo, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "make files" });
      const req = await waitForEvent(events, (e) => e.type === "approval.request");
      await send({ type: "approve", id: req.id, always: true });
      await server.idle();
      assert.equal(events.filter((e) => e.type === "approval.request").length, 1);
      assert.ok(fs.existsSync(path.join(repo, "a.txt")));
      assert.ok(fs.existsSync(path.join(repo, "b.txt")));
    });
  });

  test("approve with always=true switches the reported mode to auto", async () => {
    const script = (n: number): Reply => n === 1
      ? { kind: "tools", calls: [{ name: "write_file", args: { path: "a.txt", content: "a" } }] }
      : { kind: "text", content: "done" };
    await withSidecar(script, "review", async ({ server, events, send }) => {
      assert.equal(events[1].mode, "review");
      await send({ type: "prompt.submit", id: "t1", text: "make files" });
      const req = await waitForEvent(events, (e) => e.type === "approval.request");
      const approvedAt = events.length;
      await send({ type: "approve", id: req.id, always: true });
      const switched = events.slice(approvedAt).find((e) => e.type === "session.state");
      assert.ok(switched, "session.state emitted right after approve-always");
      assert.equal(switched.mode, "auto");
      await server.idle();
      const states = events.filter((e) => e.type === "session.state");
      assert.equal(states.at(-1).mode, "auto");
    });
  });

  test("the approval preview redacts quoted secrets in arguments", async () => {
    const envTurn = (n: number): Reply => n === 1
      ? { kind: "tools", calls: [{ name: "write_file", args: { path: ".env", content: 'API_KEY="abcdef1234567890"\n' } }] }
      : { kind: "text", content: "ok" };
    await withSidecar(envTurn, "review", async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "write env" });
      const req = await waitForEvent(events, (e) => e.type === "approval.request");
      assert.ok(req.preview.includes(".env"));
      assert.doesNotMatch(req.preview, /abcdef1234567890/);
      await send({ type: "deny", id: req.id });
      await server.idle();
    });
  });

  test("an unknown approval id is reported, not ignored", async () => {
    await withSidecar(writeTurn, "review", async ({ events, send }) => {
      await send({ type: "approve", id: "approval-999" });
      const err = events.find((e) => e.type === "error");
      assert.equal(err.code, "NO_PENDING_APPROVAL");
      assert.equal(err.id, "approval-999");
    });
  });
});

describe("SidecarServer: cancellation", () => {
  test("cancel during inference ends the turn INTERRUPTED promptly", async () => {
    await withSidecar(() => ({ kind: "text", content: "slow answer", delayMs: 3000 }), "auto", async ({ server, events, send }) => {
      const started = Date.now();
      await send({ type: "prompt.submit", id: "t1", text: "x" });
      await new Promise((r) => setTimeout(r, 200));
      await send({ type: "cancel" });
      await server.idle();
      assert.ok(Date.now() - started < 2500, "turn ended well before the gateway replied");
      const result = events.find((e) => e.type === "turn.result");
      assert.equal(result.turn.execution, "INTERRUPTED");
      assert.equal(result.turn.outcome, "NOT_ESTABLISHED");
    });
  });

  test("cancel sent immediately after submit is not lost", async () => {
    await withSidecar(() => ({ kind: "text", content: "slow answer", delayMs: 3000 }), "auto", async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "x" });
      await send({ type: "cancel" });
      await server.idle();
      assert.equal(events.find((e) => e.type === "turn.result").turn.execution, "INTERRUPTED");
    });
  });

  test("cancel while an approval is pending denies it and interrupts the turn", async () => {
    await withSidecar(writeTurn, "review", async ({ server, events, repo, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "make x" });
      await waitForEvent(events, (e) => e.type === "approval.request");
      await send({ type: "cancel" });
      await server.idle();
      assert.equal(fs.existsSync(path.join(repo, "x.txt")), false);
      assert.equal(events.find((e) => e.type === "turn.result").turn.execution, "INTERRUPTED");
    });
  });
});

describe("SidecarServer: slash and shutdown", () => {
  test("slash status replies with slash.result", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events, send }) => {
      await send({ type: "slash", id: "s1", command: "status" });
      await server.idle();
      const reply = events.find((e) => e.type === "slash.result");
      assert.equal(reply.id, "s1");
      assert.equal(reply.command, "status");
      assert.equal(reply.success, true);
      assert.match(reply.output, /^model\s+m$/m);
      const order = events.slice(2).map((e) => (e.type === "session.state" ? `state:${e.busy}` : e.type));
      assert.deepEqual(order, ["state:true", "slash.result", "state:false"]);
    });
  });

  test("slash while a turn is running is rejected with BUSY", async () => {
    await withSidecar(() => ({ kind: "text", content: "slow", delayMs: 1500 }), "auto", async ({ events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "one" });
      await send({ type: "slash", id: "s1", command: "status" });
      const busy = events.find((e) => e.type === "error" && e.id === "s1");
      assert.ok(busy, "slash rejected synchronously");
      assert.equal(busy.code, "BUSY");
      assert.equal(events.some((e) => e.type === "slash.result"), false);
    });
  });

  test("shutdown calls onShutdown", async () => {
    let shutdowns = 0;
    await withSidecar(readOnlyTurn, "auto", async ({ send }) => {
      await send({ type: "shutdown" });
      assert.equal(shutdowns, 1);
    }, () => shutdowns++);
  });

  test("repeated shutdown runs once and later commands are rejected", async () => {
    let shutdowns = 0;
    await withSidecar(readOnlyTurn, "auto", async ({ events, send }) => {
      await Promise.all([send({ type: "shutdown" }), send({ type: "shutdown" })]);
      await send({ type: "shutdown" });
      assert.equal(shutdowns, 1);
      await send({ type: "prompt.submit", id: "t1", text: "x" });
      await send({ type: "slash", id: "s1", command: "status" });
      assert.equal(events.find((e) => e.type === "error" && e.id === "t1")?.code, "BUSY");
      assert.equal(events.find((e) => e.type === "error" && e.id === "s1")?.code, "BUSY");
      assert.equal(events.some((e) => e.type === "turn.result" || e.type === "slash.result"), false);
    }, () => shutdowns++);
  });
});

describe("SidecarServer: sessions and slash commands", () => {
  test("a prompt turn is checkpointed first, saved after, and joins the history", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events, app, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "what is here?" });
      await server.idle();
      const checkpoints = app.getCheckpointManager().listCheckpoints();
      assert.equal(checkpoints.length, 1);
      assert.equal(checkpoints[0].name, "Turn: what is here?");
      const sessions = app.getSessionManager().listSessions();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].title, "what is here?");
      await send({ type: "slash", id: "s1", command: "history" });
      await server.idle();
      assert.match(events.find((e) => e.type === "slash.result").output, /^\[1\] what is here\?$/m);
    });
  });

  test("sensitive checkpoint rejection asks before starting a read-only review turn", async () => {
    const replies = (n: number): Reply => n === 1
      ? { kind: "tools", calls: [{ name: "list_dir", args: { path: "." } }] }
      : n === 2
        ? { kind: "tools", calls: [{ name: "write_file", args: { path: "new.txt", content: "must not be written" } }] }
        : { kind: "text", content: "The workspace contains the expected files." };
    await withSidecar(replies, "review", async ({ server, events, repo, send }) => {
      fs.writeFileSync(path.join(repo, "base.txt"), `changed ${`ghp_${"A".repeat(36)}`}\n`);

      await send({ type: "prompt.submit", id: "t-sensitive", text: "review the codebase" });
      await waitUntil(() => events.some((event) => event.type === "checkpoint.choice.request"));
      const request = events.find((event) => event.type === "checkpoint.choice.request");
      assert.match(request.message, /Sensitive content blocked the checkpoint/);
      assert.match(request.message, /may persist sensitive content/);
      await send({ type: "checkpoint.choice", id: request.id, choice: "read_only" });
      await server.idle();

      assert.ok(events.some((event) => event.type === "notice" && /Continuing this turn in read-only mode as requested/.test(event.text)));
      assert.equal(events.filter((event) => event.type === "session.state").at(-1)?.mode, "read-only");
      assert.ok(events.some((event) => event.type === "tool.end" && event.tool === "list_dir" && event.success === true));
      const deniedWrite = events.find((event) => event.type === "tool.end" && event.tool === "write_file");
      assert.ok(deniedWrite);
      assert.equal(deniedWrite.success, false);
      assert.match(deniedWrite.error, /read-only mode violation/i);
      assert.equal(fs.existsSync(path.join(repo, "new.txt")), false);
      assert.ok(events.some((event) => event.type === "turn.result" && event.turn_id === "t-sensitive"));

      await send({ type: "slash", id: "s-init", command: "init" });
      await server.idle();
      const deniedInit = events.find((event) => event.type === "slash.result" && event.id === "s-init");
      assert.equal(deniedInit.success, false);
      assert.match(deniedInit.output, /disabled while the session is in read-only mode/i);
      assert.equal(fs.existsSync(path.join(repo, "AGENTS.md")), false);

      await send({ type: "provider.connect", id: "p-connect", provider: "openai", method: "api-key", key: "synthetic-test-key" });
      const deniedProvider = events.find((event) => event.type === "provider.result" && event.id === "p-connect");
      assert.equal(deniedProvider.success, false);
      assert.match(deniedProvider.message, /disabled while the session is in read-only mode/i);
      await send({ type: "models.list", id: "models-list" });
      const deniedCatalog = events.find((event) => event.type === "error" && event.id === "models-list");
      assert.equal(deniedCatalog.code, "BUSY");
      assert.match(deniedCatalog.message, /disabled while the session is in read-only mode/i);

      await send({ type: "slash", id: "s-mode", command: "mode", args: "auto" });
      await server.idle();
      assert.equal(events.filter((event) => event.type === "session.state").at(-1)?.mode, "read-only");
      assert.match(events.find((event) => event.type === "slash.result" && event.id === "s-mode").output, /will take effect after a safe workspace checkpoint/i);

      fs.writeFileSync(path.join(repo, "base.txt"), "safe workspace content\n");
      await send({ type: "prompt.submit", id: "t-recovered", text: "continue reviewing" });
      await server.idle();
      assert.equal(events.filter((event) => event.type === "session.state").at(-1)?.mode, "auto");
      assert.ok(events.some((event) => event.type === "turn.result" && event.turn_id === "t-recovered"));
    });
  });

  test("operator can continue in the existing mode without a rollback checkpoint", async () => {
    await withSidecar(() => ({ kind: "text", content: "Review started." }), "review", async ({ server, events, repo, app, send }) => {
      fs.writeFileSync(path.join(repo, "base.txt"), `changed ${`ghp_${"B".repeat(36)}`}\n`);
      await send({ type: "prompt.submit", id: "t-no-checkpoint", text: "review the codebase" });
      await waitUntil(() => events.some((event) => event.type === "checkpoint.choice.request"));
      const request = events.find((event) => event.type === "checkpoint.choice.request");
      await send({ type: "checkpoint.choice", id: request.id, choice: "without_checkpoint" });
      await server.idle();
      assert.ok(events.some((event) => event.type === "notice" && /without a rollback checkpoint/.test(event.text)));
      assert.equal(events.filter((event) => event.type === "session.state").at(-1)?.mode, "review");
      assert.ok(events.some((event) => event.type === "turn.result" && event.turn_id === "t-no-checkpoint"));
      assert.equal(app.getCheckpointManager().listCheckpoints().length, 0);
    });
  });

  test("checkpoint choice rejects unknown actions", async () => {
    await withSidecar(() => ({ kind: "text", content: "Review started." }), "review", async ({ server, events, repo, app, send }) => {
      fs.writeFileSync(path.join(repo, "base.txt"), `changed ${`ghp_${"C".repeat(36)}`}\n`);
      await send({ type: "checkpoint.choice", id: "checkpoint-choice-invalid", choice: "persist_everything" });
      const error = events.find((event) => event.type === "error" && event.id === "checkpoint-choice-invalid");
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(app.getCheckpointManager().listCheckpoints().length, 0);
    });
  });

  test("operator can explicitly create a checkpoint that may contain sensitive workspace content", async () => {
    await withSidecar(() => ({ kind: "text", content: "Review started." }), "review", async ({ events, repo, app, send }) => {
      const sensitiveMarker = `ghp_${"E".repeat(36)}`;
      fs.writeFileSync(path.join(repo, "base.txt"), `changed ${sensitiveMarker}\n`);
      await send({ type: "prompt.submit", id: "t-sensitive-checkpoint", text: "review the codebase" });
      await waitUntil(() => events.some((event) => event.type === "checkpoint.choice.request"));
      const request = events.find((event) => event.type === "checkpoint.choice.request");
      assert.match(request.message, /1 read-only.*2 continue without a rollback checkpoint.*3 create a checkpoint anyway \(may persist sensitive content\).*4 cancel this turn.*5 re-enter the instruction/);
      await send({ type: "checkpoint.choice", id: request.id, choice: "allow_sensitive" });
      await waitUntil(() => events.some((event) => event.type === "turn.result" && event.turn_id === "t-sensitive-checkpoint"));
      const [checkpoint] = app.getCheckpointManager().listCheckpoints();
      assert.ok(checkpoint?.gitRef);
      const persisted = execFileSync("git", ["show", `${checkpoint.gitRef}:base.txt`], { cwd: repo, encoding: "utf8" });
      assert.equal(persisted.includes(sensitiveMarker), true);
      assert.ok(events.some((event) => event.type === "notice" && /may persist sensitive workspace content/.test(event.text)));
    });
  });

  test("cancel choice does not start the turn", async () => {
    await withSidecar(() => ({ kind: "text", content: "must not run" }), "review", async ({ server, events, repo, send }) => {
      fs.writeFileSync(path.join(repo, "base.txt"), `changed ${`ghp_${"D".repeat(36)}`}\n`);
      await send({ type: "prompt.submit", id: "t-cancel-checkpoint", text: "review the codebase" });
      await waitUntil(() => events.some((event) => event.type === "checkpoint.choice.request"));
      const request = events.find((event) => event.type === "checkpoint.choice.request");
      await send({ type: "checkpoint.choice", id: request.id, choice: "cancel" });
      await server.idle();
      assert.ok(events.some((event) => event.type === "error" && event.id === "t-cancel-checkpoint" && /cancelled before it started/.test(event.message)));
      assert.equal(events.some((event) => event.type === "turn.result" && event.turn_id === "t-cancel-checkpoint"), false);
    });
  });

  test("other choice cancels the turn and asks for a different instruction", async () => {
    await withSidecar(() => ({ kind: "text", content: "must not run" }), "review", async ({ server, events, repo, send }) => {
      fs.writeFileSync(path.join(repo, "base.txt"), `changed ${`ghp_${"F".repeat(36)}`}\n`);
      await send({ type: "prompt.submit", id: "t-other-checkpoint", text: "review the codebase" });
      await waitUntil(() => events.some((event) => event.type === "checkpoint.choice.request"));
      const request = events.find((event) => event.type === "checkpoint.choice.request");
      await send({ type: "checkpoint.choice", id: request.id, choice: "other" });
      await server.idle();
      assert.ok(events.some((event) => event.type === "error" && event.id === "t-other-checkpoint" && /Enter a different instruction/.test(event.message)));
      assert.equal(events.some((event) => event.type === "turn.result" && event.turn_id === "t-other-checkpoint"), false);
      assert.equal(events.some((event) => event.type === "notice" && /must not run/.test(event.text)), false);
    });
  });

  test("a diff reply is marked for diff colouring", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events, repo, send }) => {
      fs.writeFileSync(path.join(repo, "base.txt"), "changed\n");
      await send({ type: "slash", id: "s1", command: "diff" });
      await server.idle();
      const reply = events.find((e) => e.type === "slash.result");
      assert.equal(reply.format, "diff");
      assert.match(reply.output, /^\+changed$/m);
    });
  });

  test("a command that resolves to a prompt runs it as a turn under the command id", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "what is here?" });
      await server.idle();
      const before = events.length;
      await send({ type: "slash", id: "s1", command: "history", args: "run 1" });
      await server.idle();
      const later = events.slice(before);
      const reply = later.find((e) => e.type === "slash.result");
      assert.equal(reply.prompt, "what is here?");
      assert.equal(reply.output, "");
      const result = later.find((e) => e.type === "turn.result");
      assert.equal(result.turn_id, "s1");
      assert.ok(later.indexOf(reply) < later.indexOf(result));
    });
  });

  test("/mode review makes later writes wait for approval", async () => {
    await withSidecar(writeTurn, "auto", async ({ server, events, send }) => {
      await send({ type: "slash", id: "s1", command: "mode", args: "review" });
      await server.idle();
      assert.equal(events.filter((e) => e.type === "session.state").at(-1).mode, "review");
      await send({ type: "prompt.submit", id: "t1", text: "make x" });
      const req = await waitForEvent(events, (e) => e.type === "approval.request");
      await send({ type: "deny", id: req.id });
      await server.idle();
    });
  });

  test("cancelling a command that cannot stop says so and lets it finish", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events, send }) => {
      await send({ type: "slash", id: "s1", command: "!", args: "sleep 0.5; echo done-sleeping" });
      await send({ type: "cancel" });
      await server.idle();
      assert.equal(events.find((e) => e.type === "notice").text, "! cannot be cancelled; it finishes on its own.");
      const reply = events.find((e) => e.type === "slash.result");
      assert.equal(reply.success, true);
      assert.match(reply.output, /done-sleeping/);
    });
  });

  test("cancelling /tdd stops it with an honest result", async () => {
    await withSidecar(() => ({ kind: "text", content: "slow answer", delayMs: 3000 }), "auto", async ({ server, events, send }) => {
      const started = Date.now();
      await send({ type: "slash", id: "s1", command: "tdd", args: "fix the parser" });
      await new Promise((r) => setTimeout(r, 200));
      await send({ type: "cancel" });
      await server.idle();
      assert.ok(Date.now() - started < 2500, "stopped well before the gateway replied");
      const reply = events.find((e) => e.type === "slash.result");
      assert.equal(reply.success, false);
      assert.match(reply.output, /Stopped by operator\./);
    });
  });

  test("--resume restores a saved session and says so", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ events, app }) => {
      const notice = events.find((e) => e.type === "notice");
      assert.equal(notice.text, "Resumed session old-session.");
      const history = events.find((e) => e.type === "history");
      assert.deepEqual(history.messages, [{ role: "user", text: "earlier question" }], "the earlier conversation is sent before the notice");
      assert.ok(events.indexOf(history) < events.indexOf(notice));
      assert.deepEqual(app.getAgent().getMessages().map((m) => m.content), ["s", "earlier question"]);
    }, undefined, (app) => {
      const now = new Date().toISOString();
      app.getSessionManager().saveSession({
        id: "old-session",
        title: "earlier",
        createdAt: now,
        updatedAt: now,
        workspace: app.getConfig().workspace,
        model: "m",
        messages: [{ role: "system", content: "s" }, { role: "user", content: "earlier question" }] as any,
      });
      return { resume: "old-session" };
    });
  });

  test("--resume restores the findings recorded in the saved session in full, and the next one continues their ids", async () => {
    const finding = "Findings recorded from inspected output [F7; step 3; from read_file {\"path\":\"a.ts\"}; model-written, not independent proof]\na.ts:12 calls spawn on harness-core.";
    await withSidecar(readOnlyTurn, "auto", async ({ app }) => {
      assert.deepEqual(app.getAgent().getFindings(), [finding]);
      assert.equal((app.getAgent() as any).findingSeq, 7);
    }, undefined, (app) => {
      const now = new Date().toISOString();
      app.getSessionManager().saveSession({
        id: "old-session",
        title: "earlier",
        createdAt: now,
        updatedAt: now,
        workspace: app.getConfig().workspace,
        model: "m",
        messages: [{ role: "system", content: "s" }, { role: "user", content: "earlier question" }] as any,
        findings: [finding],
      });
      return { resume: "old-session" };
    });
  });

  test("a refused /cd leaves the reported workspace unchanged", async () => {
    const other = makeRepo();
    try {
      await withSidecar(readOnlyTurn, "auto", async ({ server, events, repo, app, send }) => {
        (app.getAgent() as any).activeWorktree = { branch: "nexus/x", worktreePath: repo };
        try {
          await send({ type: "slash", id: "s1", command: "cd", args: other });
          await server.idle();
        } finally {
          (app.getAgent() as any).activeWorktree = undefined;
        }
        const reply = events.find((e) => e.type === "slash.result");
        assert.equal(reply.success, false);
        assert.match(reply.output, /speculative worktree is unresolved/);
        assert.equal(app.getConfig().workspace, repo);
        assert.equal(events.filter((e) => e.type === "session.state").at(-1).workspace, repo);
      });
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  test("/resume of a session record without messages is refused and changes nothing", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events, app, send }) => {
      const now = new Date().toISOString();
      app.getSessionManager().saveSession({
        id: "broken-session",
        title: "broken",
        createdAt: now,
        updatedAt: now,
        workspace: app.getConfig().workspace,
        model: "m",
        messages: [{ role: "system", content: "s" }, { role: "user", content: "q" }] as any,
      });
      const dir = path.join(process.env.HOME!, ".nexus", "sessions");
      const file = fs.readdirSync(dir).map((f) => path.join(dir, f)).find((f) => fs.readFileSync(f, "utf-8").includes("broken-session"))!;
      const record = JSON.parse(fs.readFileSync(file, "utf-8"));
      delete record.messageLog;
      delete record.messages;
      fs.writeFileSync(file, JSON.stringify(record));
      const before = app.getAgent().getMessages();
      const sessionId = (server as any).sessionId;
      await send({ type: "slash", id: "s1", command: "resume", args: "broken-session" });
      await server.idle();
      const reply = events.find((e) => e.type === "slash.result");
      assert.equal(reply.success, false);
      assert.match(reply.output, /(?:Session broken-session is unreadable|broken-session.*(?:unreadable|corrupt))/i);
      assert.deepEqual(app.getAgent().getMessages(), before);
      assert.equal((server as any).sessionId, sessionId);
    });
  });
});

describe("SidecarServer: evidence and receipts", () => {
  test("tool events share one evidence id per call, and tool.detail returns the full record", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "what is here?" });
      await server.idle();
      const start = events.find((e) => e.type === "tool.start");
      const end = events.find((e) => e.type === "tool.end");
      assert.match(start.evidence, /^e\d+$/);
      assert.equal(end.evidence, start.evidence);
      await send({ type: "tool.detail", id: "d1", evidence: start.evidence });
      const detail = events.find((e) => e.type === "tool.detail");
      assert.equal(detail.id, "d1");
      assert.equal(detail.evidence, start.evidence);
      assert.equal(detail.tool, "list_dir");
      assert.equal(detail.subject, ".");
      assert.equal(detail.status, "succeeded");
      assert.deepEqual(JSON.parse(detail.args), { path: "." });
      assert.match(detail.output, /base\.txt/);
      assert.equal(typeof detail.duration_ms, "number");
    });
  });

  test("tool.detail redacts quoted and escape-split secrets in tool output", async () => {
    const readConf = (n: number): Reply => n === 1
      ? { kind: "tools", calls: [{ name: "read_file", args: { path: "conf.yml" } }] }
      : { kind: "text", content: "ok" };
    await withSidecar(readConf, "auto", async ({ server, events, repo, send }) => {
      fs.writeFileSync(path.join(repo, "base.txt"), 'password: "yamlsecret777"\n');
      fs.writeFileSync(path.join(repo, "conf.yml"), 'password: "yamlsecret777"\nkey: sk-ABCDEFGH\x1b[0mIJKLMNOPQRSTUVWXYZ123456\n');
      await send({ type: "prompt.submit", id: "t1", text: "read it" });
      await waitUntil(() => events.some((event) => event.type === "checkpoint.choice.request"));
      const checkpointChoice = events.find((event) => event.type === "checkpoint.choice.request");
      await send({ type: "checkpoint.choice", id: checkpointChoice.id, choice: "without_checkpoint" });
      await server.idle();
      const start = events.find((e) => e.type === "tool.start");
      await send({ type: "tool.detail", id: "d1", evidence: start.evidence });
      const detail = events.find((e) => e.type === "tool.detail");
      assert.equal(detail.status, "succeeded");
      assert.match(detail.output, /password/);
      assert.doesNotMatch(detail.output, /yamlsecret777/);
      assert.doesNotMatch(detail.output, /IJKLMNOPQRSTUVWXYZ123456/);
    });
  });

  test("parallel calls that share a model call id keep separate records", async () => {
    const sameIds = (n: number): Reply => n === 1
      ? { kind: "tools", calls: [{ name: "list_dir", args: { path: "." }, id: "dup" }, { name: "read_file", args: { path: "base.txt" }, id: "dup" }] }
      : { kind: "text", content: "ok" };
    await withSidecar(sameIds, "auto", async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "look" });
      await server.idle();
      for (const tool of ["list_dir", "read_file"]) {
        const start = events.find((e) => e.type === "tool.start" && e.tool === tool);
        const end = events.find((e) => e.type === "tool.end" && e.tool === tool);
        assert.match(start.evidence, /^e\d+$/, tool);
        assert.equal(end.evidence, start.evidence, tool);
      }
    });
  });

  test("a tool name with terminal escapes is cleaned on every event", async () => {
    const oddName = (n: number): Reply => n === 1
      ? { kind: "tools", calls: [{ name: "no_such\x1b]0;pwned\x07tool", args: {} }] }
      : { kind: "text", content: "ok" };
    await withSidecar(oddName, "auto", async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "go" });
      await server.idle();
      const start = events.find((e) => e.type === "tool.start");
      const end = events.find((e) => e.type === "tool.end");
      await send({ type: "tool.detail", id: "d1", evidence: start.evidence });
      const detail = events.find((e) => e.type === "tool.detail");
      for (const event of [start, end, detail]) assert.doesNotMatch(event.tool, /\x1b|\x07/);
    });
  });

  test("an unknown evidence id is NOT_FOUND", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ events, send }) => {
      await send({ type: "tool.detail", id: "d1", evidence: "e999" });
      const error = events.find((e) => e.type === "error");
      assert.equal(error.id, "d1");
      assert.equal(error.code, "NOT_FOUND");
      assert.equal(error.message, "No record of tool call e999; only the latest 200 are kept.");
    });
  });

  test("a running call's record is available before it finishes", async () => {
    const slowCommand = (n: number): Reply => n === 1
      ? { kind: "tools", calls: [{ name: "run_command", args: { command: "sleep 1; echo slept" } }] }
      : { kind: "text", content: "ok" };
    await withSidecar(slowCommand, "auto", async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "wait for it" });
      const start = await waitForEvent(events, (e) => e.type === "tool.start");
      await send({ type: "tool.detail", id: "d1", evidence: start.evidence });
      assert.equal(events.find((e) => e.type === "tool.detail" && e.id === "d1").status, "running");
      assert.equal(events.some((e) => e.type === "error" && e.code === "BUSY"), false);
      await server.idle();
      await send({ type: "tool.detail", id: "d2", evidence: start.evidence });
      const done = events.find((e) => e.type === "tool.detail" && e.id === "d2");
      assert.equal(done.status, "succeeded");
      assert.match(done.output, /slept/);
    });
  });

  test("the receipt describes the last turn and says when no validation receipt exists", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events, send }) => {
      await send({ type: "receipt", id: "r1" });
      assert.equal(events.find((e) => e.type === "receipt" && e.id === "r1").sections[0].note, "No turn has finished in this session yet.");
      await send({ type: "prompt.submit", id: "t1", text: "what is here?" });
      await server.idle();
      await send({ type: "receipt", id: "r2" });
      const sections = events.find((e) => e.type === "receipt" && e.id === "r2").sections;
      assert.deepEqual(sections[0].rows.slice(0, 3), [["result", "TURN ENDED - NO CHANGES TO VERIFY"], ["execution", "COMPLETED"], ["outcome", "NOT_REQUIRED"]]);
      assert.match(sections.find((s: any) => s.title === "Validation receipt").note, /^No validation receipt is active\./);
    });
  });

  test("a receipt that cannot be built fails in its panel, and /clear forgets the last turn", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "what is here?" });
      await server.idle();
      const app = (server as any).app;
      app.getActiveValidationReceipt = () => {
        throw new Error("state unreadable");
      };
      await send({ type: "receipt", id: "r1" });
      const error = events.find((e) => e.type === "error" && e.id === "r1");
      assert.equal(error?.code, "INTERNAL");
      assert.match(error.message, /state unreadable/);
      delete app.getActiveValidationReceipt;
      await send({ type: "slash", id: "s1", command: "clear" });
      await server.idle();
      await send({ type: "receipt", id: "r2" });
      const sections = events.find((e) => e.type === "receipt" && e.id === "r2").sections;
      assert.equal(sections[0].note, "No turn has finished in this session yet.");
    });
  });

  test("a receipt is answered while a turn is running", async () => {
    await withSidecar(() => ({ kind: "text", content: "slow", delayMs: 1500 }), "auto", async ({ events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "go" });
      await send({ type: "receipt", id: "r1" });
      assert.ok(events.some((e) => e.type === "receipt" && e.id === "r1"));
      assert.equal(events.some((e) => e.type === "error" && e.code === "BUSY"), false);
    });
  });
});

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidecarSrc = path.join(cliRoot, "src", "sidecar.ts");

function spawnSidecar(gwUrl: string, repo: string, home: string, entry: string = sidecarSrc, args: string[] = ["-w", repo, "-e", gwUrl, "-m", "m"]) {
  const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
    cwd: cliRoot,
    env: { ...process.env, HOME: home, NEXUS_DEBUG: "0" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, exited, lines: () => stdout.split("\n").filter(Boolean), stderr: () => stderr };
}

describe("sidecar process", () => {
  test("holds its shared client lease for the complete sidecar lifetime", async () => {
    const gw = await startGateway(readOnlyTurn);
    const repo = makeRepo();
    const home = makeHome();
    const proc = spawnSidecar(gw.url, repo, home);
    try {
      await waitUntil(() => proc.lines().some((line) => line.includes('"type":"hello"')), 20000);
      const source = path.join(home, "restore.env");
      fs.writeFileSync(source, "MODEL=replacement\n", { mode: 0o600 });
      let restoreError: unknown;
      assert.equal(restoreFromSources(home, [{ store: "config", source, mode: "file" }], (error) => { restoreError = error; }), false);
      assert.match(String(restoreError), /Close all other Nexus clients before restoring/i);
      assert.equal(hasPendingStateRestore(home), false, "lease contention must reject before publishing restore intent");
      proc.child.stdin.write(JSON.stringify({ v: 1, type: "shutdown" }) + "\n");
      assert.equal(await proc.exited, 0, proc.stderr());
    } finally {
      proc.child.kill("SIGKILL");
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("explicit help stays read-only when a restore is pending", async () => {
    const gw = await startGateway(readOnlyTurn);
    const repo = makeRepo();
    const home = makeHome();
    const control = path.join(home, ".nexus", "restore-control");
    fs.mkdirSync(control, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(home, ".nexus"), 0o700);
    fs.chmodSync(control, 0o700);
    const activeMarker = path.join(control, "active.json");
    fs.writeFileSync(activeMarker, JSON.stringify({
      formatVersion: 1,
      id: "6b9c1f71-137e-4ee9-b81e-9457c0e5812b",
      homeSha256: createHash("sha256").update(fs.realpathSync(home)).digest("hex"),
      manifestSha256: "a".repeat(64),
      phase: "prepared",
      stores: { state: "tree", config: null },
    }), { mode: 0o600 });
    const markerBefore = fs.readFileSync(activeMarker);
    const proc = spawnSidecar(gw.url, repo, home, sidecarSrc, ["--help"]);
    try {
      assert.equal(await proc.exited, 0, proc.stderr());
      assert.match(proc.lines().join("\n"), /Usage: nexus-sidecar/);
      assert.deepEqual(fs.readFileSync(activeMarker), markerBefore);
    } finally {
      proc.child.kill("SIGKILL");
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses to load config when a pending restore cannot be replayed", async () => {
    const gw = await startGateway(readOnlyTurn);
    const repo = makeRepo();
    const home = makeHome();
    const control = path.join(home, ".nexus", "restore-control");
    fs.mkdirSync(control, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(home, ".nexus"), 0o700);
    fs.chmodSync(control, 0o700);
    fs.writeFileSync(path.join(control, "active.json"), JSON.stringify({
      formatVersion: 1,
      id: "6b9c1f71-137e-4ee9-b81e-9457c0e5812b",
      homeSha256: createHash("sha256").update(fs.realpathSync(home)).digest("hex"),
      manifestSha256: "a".repeat(64),
      phase: "prepared",
      stores: { state: "tree", config: null },
    }), { mode: 0o600 });
    const proc = spawnSidecar(gw.url, repo, home);
    try {
      assert.equal(await proc.exited, 1, proc.stderr());
      assert.match(proc.stderr(), /Pending state restore could not be recovered/);
      assert.equal(proc.lines().some((line) => line.includes('"type":"hello"')), false);
    } finally {
      proc.child.kill("SIGKILL");
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("stdout carries only NDJSON protocol lines across a full turn", async () => {
    const gw = await startGateway(readOnlyTurn);
    const repo = makeRepo();
    const home = makeHome();
    const proc = spawnSidecar(gw.url, repo, home);
    try {
      await waitUntil(() => proc.lines().some((l) => l.includes('"type":"hello"')), 20000);
      proc.child.stdin.write(JSON.stringify({ v: 1, type: "prompt.submit", id: "t1", text: "what is here?" }) + "\n");
      await waitUntil(() => proc.lines().some((l) => l.includes('"type":"turn.result"')), 30000);
      proc.child.stdin.write(JSON.stringify({ v: 1, type: "shutdown" }) + "\n");
      assert.equal(await proc.exited, 0, proc.stderr());
      const messages = proc.lines().map((l) => JSON.parse(l));
      for (const m of messages) {
        assert.equal(m.v, 1);
        assert.equal(typeof m.type, "string");
      }
      assert.equal(messages.find((m) => m.type === "turn.result").turn.outcome, "NOT_REQUIRED");
    } finally {
      proc.child.kill("SIGKILL");
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("closing stdin shuts the sidecar down cleanly", async () => {
    const gw = await startGateway(readOnlyTurn);
    const repo = makeRepo();
    const home = makeHome();
    const proc = spawnSidecar(gw.url, repo, home);
    try {
      await waitUntil(() => proc.lines().some((l) => l.includes('"type":"hello"')), 20000);
      proc.child.stdin.end();
      assert.equal(await proc.exited, 0, proc.stderr());
    } finally {
      proc.child.kill("SIGKILL");
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("starts when launched through a symlinked path", async () => {
    const gw = await startGateway(readOnlyTurn);
    const repo = makeRepo();
    const home = makeHome();
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sidecar-link-"));
    const cliLink = path.join(linkDir, "cli-link");
    fs.symlinkSync(cliRoot, cliLink, "dir");
    const proc = spawnSidecar(gw.url, repo, home, path.join(cliLink, "src", "sidecar.ts"));
    try {
      await waitUntil(() => proc.lines().some((l) => l.includes('"type":"hello"')), 20000);
      proc.child.stdin.write(JSON.stringify({ v: 1, type: "shutdown" }) + "\n");
      assert.equal(await proc.exited, 0, proc.stderr());
    } finally {
      proc.child.kill("SIGKILL");
      await gw.close();
      fs.unlinkSync(cliLink);
      fs.rmdirSync(linkDir);
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
