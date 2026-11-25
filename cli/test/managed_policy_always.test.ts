/**
 * GV-1 slice 3: an "always" answer and `/mode auto` under `approval.disable_auto`, in the sidecar (what the terminal UI
 * and every other client talks to) and in the line-mode REPL. The policy is injected into the agent's security manager
 * and approval gate (an in-memory host); the model is a scripted local gateway. The enforcement is on this side of the
 * protocol: a client that keeps sending `always: true` gets one call approved each time and nothing more.
 */
import "./helpers/leak_guard.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ApplicationCore } from "../src/core/app.js";
import { ApprovalPolicy } from "../src/core/approval_policy.js";
import { InteractiveRepl } from "../src/repl.js";
import { SecurityManager } from "../src/security.js";
import { SidecarServer } from "../src/sidecar.js";
import { startGateway, makeRepo, makeHome, waitForEvent, waitUntil, type Reply } from "./helpers/fixtures.js";
import { FAKE_SYSTEM, policyWorld, toml } from "./helpers/policy_enforcement.js";

const TAG = `[policy: system ${FAKE_SYSTEM} approval.disable_auto]`;
const NOT_REMEMBERED = `'always' is not remembered: managed policy disables approval mode 'auto'; this one call is approved. ${TAG}`;
const twoWrites = (n: number): Reply =>
  n <= 2 ? { kind: "tools", calls: [{ name: "write_file", args: { path: `${"ab"[n - 1]}.txt`, content: "x" } }] } : { kind: "text", content: "done" };
// A step takes seconds on a loaded host (the existing sidecar suite shows the same), so waits are generous.
const WAIT_MS = 90_000;

interface Rig {
  app: ApplicationCore;
  repo: string;
  events: any[];
  server: SidecarServer;
  send(msg: Record<string, unknown>): Promise<void>;
}

/** An application over a scripted gateway whose agent sees `system` as the system policy (none when undefined). */
async function withApp(system: string | undefined, script: (n: number) => Reply, fn: (app: ApplicationCore, repo: string) => Promise<void>): Promise<void> {
  const gw = await startGateway(script);
  const repo = makeRepo();
  const home = makeHome();
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 8, temperature: 0, workspace: repo, shell: "bash", approvalMode: "review" } as any);
  const world = policyWorld(system === undefined ? {} : { system });
  const agent = app.getAgent();
  (agent as any).bridge.securityManager = new SecurityManager(repo, { policyFor: (workspace) => world.load(workspace), notify: () => {} });
  agent.setApprovalPolicy(new ApprovalPolicy(() => world.host.managed().effective));
  try {
    await fn(app, repo);
  } finally {
    app.shutdown();
    await gw.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function withSidecar(system: string | undefined, script: (n: number) => Reply, fn: (rig: Rig) => Promise<void>): Promise<void> {
  await withApp(system, script, async (app, repo) => {
    const events: any[] = [];
    const server = new SidecarServer({ app, mode: "review", write: (line) => events.push(JSON.parse(line)) });
    server.start();
    try {
      await fn({ app, repo, events, server, send: (msg) => server.handleLine(JSON.stringify({ v: 1, ...msg })) });
    } finally {
      await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
      await server.idle();
    }
  });
}

const approvals = (events: any[]): any[] => events.filter((e) => e.type === "approval.request");
const modes = (events: any[]): string[] => events.filter((e) => e.type === "session.state").map((e) => e.mode);

// With no policy an "always" answer still stops the prompts and reports mode auto: sidecar.test.ts keeps those tests.
describe("the sidecar under approval.disable_auto", () => {
  const POLICY = toml("[approval]", "disable_auto = true");

  test("an always answer approves that one call, is not remembered, and the notice names the policy", async () => {
    await withSidecar(POLICY, twoWrites, async ({ app, repo, events, server, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "make files" });
      // A client that answers "always" to everything, as a hostile or merely stale one would.
      for (let i = 1; i <= 2; i++) {
        await waitUntil(() => approvals(events).length === i, WAIT_MS);
        await send({ type: "approve", id: approvals(events)[i - 1].id, always: true });
      }
      await server.idle();
      assert.equal(approvals(events).length, 2, "every write was put to the operator");
      for (const name of ["a.txt", "b.txt"]) assert.ok(fs.existsSync(path.join(repo, name)), `${name}: the approved call ran`);
      assert.deepEqual(events.filter((e) => e.type === "notice" && e.text.startsWith("'always'")).map((e) => e.text), [NOT_REMEMBERED, NOT_REMEMBERED]);
      assert.equal(app.getAgent().getApprovalMode(), "review");
      assert.ok(!modes(events).includes("auto"), "the client is never told the session is in auto mode");
    });
  });

  test("a denied call stays denied when the answer also says always", async () => {
    await withSidecar(POLICY, twoWrites, async ({ repo, events, server, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "make files" });
      const first = await waitForEvent(events, (e) => e.type === "approval.request", WAIT_MS);
      await send({ type: "deny", id: first.id, always: true });
      await waitUntil(() => approvals(events).length === 2, WAIT_MS);
      assert.equal(fs.existsSync(path.join(repo, "a.txt")), false);
      await send({ type: "cancel" });
      await server.idle();
    });
  });

  test("/mode auto is refused with the policy source, and the next call still asks", async () => {
    await withSidecar(POLICY, twoWrites, async ({ app, events, server, send }) => {
      await send({ type: "slash", id: "s1", command: "mode", args: "auto" });
      await server.idle();
      const reply = events.find((e) => e.type === "slash.result");
      assert.equal(reply.output, `/mode auto is ignored: managed policy disables approval mode 'auto'; the mode stays 'review'. ${TAG}`, JSON.stringify(reply));
      assert.equal(app.getAgent().getApprovalMode(), "review");
      await send({ type: "prompt.submit", id: "t1", text: "make files" });
      await waitForEvent(events, (e) => e.type === "approval.request", WAIT_MS);
      assert.ok(!modes(events).includes("auto"));
    });
  });
});

describe("the line-mode REPL under approval.disable_auto", () => {
  /** A REPL with a terminal stand-in whose approval questions are answered from `answers`; what it printed is in `printed`. */
  async function withRepl(system: string | undefined, launchMode: "review" | "auto", answers: string[], fn: (repl: any, printed: () => string) => Promise<void>): Promise<void> {
    await withApp(system, () => ({ kind: "text", content: "done" }), async (app) => {
      const repl: any = new InteractiveRepl(app, launchMode);
      repl.rl = {};
      repl.askDuringTurn = async () => answers.shift() ?? null;
      const lines: string[] = [];
      const log = console.log;
      console.log = (...args: unknown[]) => void lines.push(args.join(" "));
      try {
        await fn(repl, () => lines.join("\n"));
      } finally {
        console.log = log;
      }
    });
  }
  const POLICY = toml("[approval]", "disable_auto = true");
  const WRITE = ["write_file", { path: "a.txt", content: "x" }] as const;

  test("always + all approves the one call and does not stop the questions", async () => {
    await withRepl(POLICY, "review", ["a", "all", "a", "all", "n"], async (repl, printed) => {
      assert.equal(await repl.confirmAction(...WRITE), true, "this one call is approved");
      assert.equal(repl.getApprovalMode(), "review");
      assert.ok(printed().includes(NOT_REMEMBERED));
      assert.doesNotMatch(printed(), /Switched to auto-approve/);
      assert.equal(await repl.confirmAction(...WRITE), true, "asked again, answered again");
      assert.equal(await repl.confirmAction(...WRITE), false, "asked a third time; the operator says no");
    });
  });

  test("a programmatic switch and a launch in auto do not make the REPL answer for the operator", async () => {
    await withRepl(POLICY, "auto", ["n"], async (repl) => {
      assert.equal(repl.getApprovalMode(), "review", "the launch request was not entered");
      repl.setApprovalMode("auto");
      assert.equal(repl.getApprovalMode(), "review");
      assert.equal(await repl.confirmAction(...WRITE), false, "the question reached the operator, who said no");
      repl.setApprovalMode("read-only");
      assert.equal(repl.getApprovalMode(), "read-only", "a stricter mode is always available");
    });
  });

  test("with no policy always + all switches the session to auto (unchanged)", async () => {
    await withRepl(undefined, "review", ["a", "all"], async (repl, printed) => {
      assert.equal(await repl.confirmAction(...WRITE), true);
      assert.equal(repl.getApprovalMode(), "auto");
      assert.match(printed(), /Switched to auto-approve/);
      assert.equal(await repl.confirmAction(...WRITE), true, "no further question");
    });
  });
});
