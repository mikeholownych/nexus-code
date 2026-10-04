import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ApplicationCore } from "../src/core/app.js";
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
  const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash" } as any);
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
      (server as any).app.getAgent = () => {
        throw new Error("agent exploded token=supersecretvalue");
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
      assert.equal(events[2].type, "notice");
      assert.equal(events[2].text, "Resumed session old-session (2 messages).");
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
});

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidecarSrc = path.join(cliRoot, "src", "sidecar.ts");

function spawnSidecar(gwUrl: string, repo: string, home: string, entry: string = sidecarSrc) {
  const child = spawn(process.execPath, ["--import", "tsx", entry, "-w", repo, "-e", gwUrl, "-m", "m"], {
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
