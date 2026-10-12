/**
 * Sidecar paths for the dogfooding fixes: steering while a turn runs (queued/applied/duplicate/rejected/deferred/
 * cancelled), per-operation file diffs, activity events, read-only /doctor beside a turn, and the saved/exported
 * task state. Real ApplicationCore and agent loop against a deterministic gateway.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { ApplicationCore } from "../src/core/app.js";
import { SidecarServer } from "../src/sidecar.js";
import { EvidenceLedger } from "../src/evidence.js";
import { countDiffLines, unifiedDiff, visibleControls } from "../src/file_diff.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, makeHome, waitForEvent, waitUntil, Reply } from "./helpers/fixtures.js";

interface Rig {
  server: SidecarServer;
  events: any[];
  repo: string;
  app: ApplicationCore;
  gw: Awaited<ReturnType<typeof startGateway>>;
  home: string;
  send(msg: Record<string, unknown>): Promise<void>;
}

async function withSidecar(script: (n: number) => Reply, fn: (rig: Rig) => Promise<void>, o: Partial<HarnessConfig> = {}, files: Record<string, string> = {}): Promise<void> {
  const gw = await startGateway(script);
  const repo = makeRepo(files);
  const home = makeHome();
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 30, temperature: 0, workspace: repo, shell: "bash", continuation: { ...DEFAULT_CONTINUATION }, ...o } as HarnessConfig);
  const events: any[] = [];
  const server = new SidecarServer({ app, mode: "auto", write: (line) => events.push(JSON.parse(line)), historyFile: path.join(home, "history") });
  server.start();
  try {
    await fn({ server, events, repo, app, gw, home, send: (msg) => server.handleLine(JSON.stringify({ v: 1, ...msg })) });
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

const acks = (events: any[], id: string) => events.filter((e) => e.type === "steer.ack" && e.id === id).map((e) => e.status);
const read = (p: string): Reply => ({ kind: "tools", calls: [{ name: "read_file", args: { path: p } }] });
const inference = (events: any[]) => waitForEvent(events, (e) => e.type === "activity" && e.phase === "inference", 20_000);

describe("steering through the sidecar", () => {
  test("steering during inference is queued, applied once at the next step, and acknowledged both times", async () => {
    await withSidecar((n) => (n === 1 ? { ...read("base.txt"), delayMs: 400 } : { kind: "text", content: "done" }), async ({ server, events, send, gw }) => {
      await send({ type: "prompt.submit", id: "t1", text: "look at base.txt" });
      await inference(events);
      await send({ type: "steer", id: "g1", text: "Also check the README." });
      await send({ type: "steer", id: "g1", text: "Also check the README." });
      await server.idle();
      assert.deepEqual(acks(events, "g1"), ["queued", "duplicate", "applied"]);
      const second = (gw.requests[1] as any).messages.filter((m: any) => m.role === "user" && String(m.content).includes("Also check the README."));
      assert.equal(second.length, 1);
      assert.equal(events.filter((e) => e.type === "turn.result").length, 1, "steering did not start a second turn");
    });
  });

  test("steering when nothing runs starts a turn; during a command it is rejected with the text returned", async () => {
    await withSidecar(() => ({ kind: "text", content: "ok" }), async ({ server, events, send }) => {
      await send({ type: "steer", id: "g1", text: "summarise the repo" });
      await server.idle();
      assert.deepEqual(acks(events, "g1"), ["applied"]);
      assert.ok(events.some((e) => e.type === "turn.result" && e.turn_id === "g1"));
      await send({ type: "slash", id: "s1", command: "!", args: "sleep 1" });
      await send({ type: "steer", id: "g2", text: "faster please" });
      const rejected = events.find((e) => e.type === "steer.ack" && e.id === "g2");
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.text, "faster please");
      await server.idle();
    });
  });

  test("steering that arrives as the turn finishes starts one follow-up turn with no idle gap", async () => {
    await withSidecar((n) => (n === 1 ? { kind: "text", content: "first", delayMs: 200 } : { kind: "text", content: "follow-up" }), async ({ server, events, send, app }) => {
      // The agent has closed its turn loop: what it would report for steering in that window.
      app.getAgent().queueSteering = () => ({ status: "no_active_turn" });
      await send({ type: "prompt.submit", id: "t1", text: "go" });
      await inference(events);
      await send({ type: "steer", id: "g1", text: "then update the changelog" });
      await waitUntil(() => events.filter((e) => e.type === "turn.result").length === 2, 20_000);
      await server.idle();
      assert.deepEqual(acks(events, "g1"), ["deferred", "applied"]);
      const firstResult = events.findIndex((e) => e.type === "turn.result" && e.turn_id === "t1");
      const between = events.slice(firstResult + 1, events.findIndex((e) => e.type === "turn.result" && e.turn_id === "g1"));
      assert.ok(!between.some((e) => e.type === "session.state" && e.busy === false), "no idle state between the turns");
    });
  });

  test("steering pending at cancel is returned to the client", async () => {
    await withSidecar(() => ({ ...read("base.txt"), delayMs: 500 }), async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "look" });
      await inference(events);
      await send({ type: "steer", id: "g1", text: "never mind, stop" });
      await send({ type: "cancel" });
      await server.idle();
      const cancelled = events.find((e) => e.type === "steer.ack" && e.id === "g1" && e.status === "cancelled");
      assert.ok(cancelled, JSON.stringify(events.filter((e) => e.type === "steer.ack")));
      assert.equal(cancelled.text, "never mind, stop");
    });
  });
});

describe("exactly once across a restart, and operator scope authority", () => {
  test("steering applied before a restart is saved once and a resend after resume is a duplicate", async () => {
    const gw = await startGateway((n) => (n === 1 ? { ...read("base.txt"), delayMs: 400 } : { kind: "text", content: "done" }));
    const repo = makeRepo();
    const home = makeHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const config = { endpoint: gw.url, model: "m", maxSteps: 30, temperature: 0, workspace: repo, shell: "bash", continuation: { ...DEFAULT_CONTINUATION } } as HarnessConfig;
    try {
      const appA = new ApplicationCore(config);
      const eventsA: any[] = [];
      const a = new SidecarServer({ app: appA, mode: "auto", write: (l) => eventsA.push(JSON.parse(l)), historyFile: path.join(home, "h") });
      a.start();
      const sendA = (m: Record<string, unknown>) => a.handleLine(JSON.stringify({ v: 1, ...m }));
      await sendA({ type: "prompt.submit", id: "t1", text: "look at base.txt" });
      await inference(eventsA);
      await sendA({ type: "steer", id: "g-old-1", text: "Mention the line count." });
      await a.idle();
      appA.shutdown(); // the process ends after saving

      const appB = new ApplicationCore(config);
      const eventsB: any[] = [];
      const b = new SidecarServer({ app: appB, mode: "auto", resume: "latest", write: (l) => eventsB.push(JSON.parse(l)), historyFile: path.join(home, "h") });
      b.start();
      assert.ok(eventsB.some((e) => e.type === "notice" && /Resumed session/.test(e.text)));
      const restored = appB.getAgent().getObjective()!;
      assert.deepEqual(restored.steering.map((st) => [st.id, st.status]), [["g-old-1", "applied"]]);
      assert.equal(appB.getAgent().getMessages().filter((m) => m.role === "user" && String(m.content).includes("Mention the line count.")).length, 1);
      // The client resends the same id after the restart (e.g. it never saw the ack): nothing new runs.
      await b.handleLine(JSON.stringify({ v: 1, type: "steer", id: "g-old-1", text: "Mention the line count." }));
      await b.idle();
      assert.deepEqual(eventsB.filter((e) => e.type === "steer.ack").map((e) => e.status), ["duplicate"]);
      assert.equal(eventsB.filter((e) => e.type === "turn.result").length, 0);
      appB.shutdown();
    } finally {
      await gw.close();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("/requirements accept is the operator's way to let a descoped requirement count", async () => {
    const objective = "Fix the importer.\n1. Reject empty names.\n2. Reject negatives.";
    const script = (n: number): Reply =>
      n === 1
        ? { kind: "tools", calls: [{ name: "update_requirements", args: { requirements: [{ id: "R1", status: "implemented", evidence: ["a.ts"] }, { id: "R2", status: "descoped", note: "out of scope" }] } }] }
        : { kind: "text", content: "R2 needs the operator." };
    await withSidecar(script, async ({ server, events, send, app }) => {
      await send({ type: "prompt.submit", id: "t1", text: objective });
      await server.idle();
      assert.equal(events.find((e) => e.type === "turn.result").turn.objective.status, "blocked");
      await send({ type: "slash", id: "s1", command: "requirements", args: "" });
      await server.idle();
      assert.match(events.find((e) => e.id === "s1" && e.type === "slash.result").output, /R2\s+DESCOPED \(needs operator acceptance\)/);
      await send({ type: "slash", id: "s2", command: "requirements", args: "accept R2" });
      await server.idle();
      const accepted = events.find((e) => e.id === "s2" && e.type === "slash.result");
      assert.match(accepted.output, /Accepted the descoping of R2\./);
      assert.match(accepted.output, /R2\s+DESCOPED \(accepted\)/);
      const saved = app.getSessionManager().getLatestSession()!;
      assert.equal(saved.objective?.requirements.find((r) => r.id === "R2")?.operatorAccepted, true, "the acceptance is saved");
    });
  });
});

describe("objective replacement is explicit", () => {
  test("a follow-up after an incomplete turn is announced as continuing the objective; /requirements clear starts a new one", async () => {
    const objective = "Fix the importer.\n1. Reject empty names.\n2. Reject negatives.";
    await withSidecar(() => ({ kind: "text", content: "stopping" }), async ({ server, events, send, app }) => {
      await send({ type: "prompt.submit", id: "t1", text: objective });
      await server.idle();
      await send({ type: "prompt.submit", id: "t2", text: `Also:\n1. Trim names.\n2. Log rejects.\n${"detail ".repeat(100)}` });
      await server.idle();
      const notice = events.find((e) => e.type === "notice" && /continues the unfinished objective \(2 unresolved requirements\)/.test(e.text));
      assert.ok(notice, events.filter((e) => e.type === "notice").map((e) => e.text).join("\n"));
      assert.deepEqual(app.getAgent().getObjective()!.requirements.map((r) => r.id), ["R1", "R2", "R3", "R4"]);
      await send({ type: "slash", id: "s1", command: "requirements", args: "clear" });
      await server.idle();
      assert.match(events.find((e) => e.id === "s1" && e.type === "slash.result").output, /The objective is cleared \(unresolved when cleared: R1, R2, R3, R4\)/);
      const before = events.length;
      await send({ type: "prompt.submit", id: "t3", text: "Something else entirely." });
      await server.idle();
      assert.ok(!events.slice(before).some((e) => e.type === "notice" && /continues the unfinished objective/.test(e.text)));
      assert.equal(app.getAgent().getObjective()!.objective, "Something else entirely.");
    });
  });
});

describe("per-operation file diffs", () => {
  test("diffs show only the agent's own change, failed edits show none, deletions are reported", async () => {
    const script = (n: number): Reply =>
      n === 1
        ? { kind: "tools", calls: [{ name: "edit_file", args: { path: "notes.txt", old_content: "line 2\n", new_content: "line two\n" } }] }
        : n === 2
          ? { kind: "tools", calls: [{ name: "edit_file", args: { path: "notes.txt", old_content: "no such text", new_content: "x" } }] }
          : n === 3
            ? { kind: "tools", calls: [{ name: "write_file", args: { path: "new.txt", content: "fresh\n" } }] }
            : n === 4
              ? { kind: "tools", calls: [{ name: "delete_file", args: { path: "gone.txt" } }] }
              : { kind: "text", content: "done" };
    await withSidecar(script, async ({ server, events, send, repo }) => {
      // A change already in the working tree before the turn: it must not be attributed to the agent.
      fs.writeFileSync(path.join(repo, "notes.txt"), "line 1 (edited by the operator)\nline 2\nline 3\n");
      await send({ type: "prompt.submit", id: "t1", text: "tidy notes" });
      await server.idle();
      const diffs = events.filter((e) => e.type === "file.diff");
      assert.deepEqual(diffs.map((d) => [d.path, d.kind, d.added, d.removed]), [["notes.txt", "modified", 1, 1], ["new.txt", "added", 1, 0], ["gone.txt", "deleted", 0, 1]]);
      assert.match(diffs[0].preview, /-line 2\n\+line two/);
      assert.ok(!/^[-+]line 1/m.test(diffs[0].preview), "the operator's earlier edit is context, not a change");
      const failedEnd = events.filter((e) => e.type === "tool.end" && e.tool === "edit_file")[1];
      assert.equal(failedEnd.success, false);
      await send({ type: "tool.detail", id: "d1", evidence: diffs[0].evidence });
      const detail = await waitForEvent(events, (e) => e.type === "tool.detail" && e.id === "d1");
      assert.match(detail.diff, /^--- a\/notes\.txt\n\+\+\+ b\/notes\.txt\n@@/);
    }, {}, { "notes.txt": "line 1\nline 2\nline 3\n", "gone.txt": "bye\n" });
  });

  test("a large change is previewed boundedly and kept whole in the detail record", async () => {
    const big = Array.from({ length: 400 }, (_, i) => `row ${i}`).join("\n") + "\n";
    await withSidecar((n) => (n === 1 ? { kind: "tools", calls: [{ name: "write_file", args: { path: "big.txt", content: big } }] } : { kind: "text", content: "ok" }), async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "write" });
      await server.idle();
      const diff = events.find((e) => e.type === "file.diff");
      assert.equal(diff.truncated, true);
      assert.ok(diff.preview.split("\n").length <= 40);
      assert.equal(diff.total_lines, 403);
      assert.equal(diff.diff_lines, 400, "what an omission line counts: changed and context lines only");
      assert.equal(diff.hunks, 1);
      await send({ type: "tool.detail", id: "d1", evidence: diff.evidence });
      const detail = await waitForEvent(events, (e) => e.type === "tool.detail");
      assert.equal(detail.diff.split("\n").length, 403);
      assert.equal(detail.diff_chars, detail.diff.length);
      // The complete diff is also kept on disk beside the saved session, private to the operator.
      assert.equal(detail.diff_path, diff.full_path);
      assert.ok(diff.full_path.includes(`${path.sep}.nexus${path.sep}sessions${path.sep}`), diff.full_path);
      assert.equal(fs.statSync(diff.full_path).mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(diff.full_path, "utf8"), `${detail.diff}\n`);
    });
  });

  test("file content keeps its meaning: control characters are shown, never stripped or sent raw", async () => {
    const content = "plain\n\u001b[31mred\u001b[0m and a bell\u0007\r\n";
    await withSidecar((n) => (n === 1 ? { kind: "tools", calls: [{ name: "write_file", args: { path: "esc.txt", content } }] } : { kind: "text", content: "ok" }), async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "write" });
      await server.idle();
      const diff = events.find((e) => e.type === "file.diff");
      assert.match(diff.preview, /\+␛\[31mred␛\[0m and a bell␇␍/);
      assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(diff.preview), "no raw control character leaves the sidecar");
    });
  });

  test("a record dropped from memory still yields its complete diff from disk", async () => {
    const script = (n: number): Reply =>
      n === 1
        ? { kind: "tools", calls: [{ name: "write_file", args: { path: "one.txt", content: "first\n" } }] }
        : n === 2
          ? { kind: "tools", calls: [{ name: "write_file", args: { path: "two.txt", content: "second\n" } }] }
          : { kind: "text", content: "ok" };
    await withSidecar(script, async ({ server, events, send }) => {
      // Keep only the newest record in memory, so the first edit's record is dropped.
      (server as any).evidence = new EvidenceLedger(1);
      await send({ type: "prompt.submit", id: "t1", text: "write two files" });
      await server.idle();
      const first = events.find((e) => e.type === "file.diff" && e.path === "one.txt");
      await send({ type: "tool.detail", id: "d1", evidence: first.evidence });
      const detail = await waitForEvent(events, (e) => e.id === "d1");
      assert.equal(detail.type, "tool.detail", JSON.stringify(detail));
      assert.match(detail.diff, /\+first/);
      assert.equal(detail.diff_path, first.full_path);
    });
  });
});

describe("diff text", () => {
  test("adding or removing only the final newline is a change, marked on the line it belongs to", () => {
    const removed = unifiedDiff("n.txt", "a\nlast\n", "a\nlast");
    assert.equal(removed.diff, "--- a/n.txt\n+++ b/n.txt\n@@ -1,2 +1,2 @@\n a\n-last\n+last\n\\ No newline at end of file");
    const added = unifiedDiff("n.txt", "last", "last\n");
    assert.equal(added.diff, "--- a/n.txt\n+++ b/n.txt\n@@ -1,1 +1,1 @@\n-last\n\\ No newline at end of file\n+last");
    const both = unifiedDiff("n.txt", "a\nend", "b\nend");
    assert.ok(both.diff.endsWith(" end\n\\ No newline at end of file"), both.diff);
    assert.equal(both.hunks, 1);
  });

  test("hunks are counted and separated, and omission counts exclude headers and markers", () => {
    const before = Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n") + "\n";
    const after = before.replace("l2\n", "L2\n").replace("l30\n", "L30\n");
    const change = unifiedDiff("f.txt", before, after);
    assert.equal(change.hunks, 2);
    assert.equal(countDiffLines(change.diff), 2 * 7 + 2 - 1 + 0, change.diff);
  });

  test("controls become visible stand-ins; tabs, newlines and text are untouched", () => {
    assert.equal(visibleControls("a\tb\nc\u001b[0m\u007f\u009b\u202e"), "a\tb\nc␛[0m␡<U+009B><U+202E>");
  });
});

describe("activity, read-only doctor while busy, and saved state", () => {
  test("activity events report phases; /doctor runs beside a turn, /doctor --fix waits", async () => {
    await withSidecar((n) => (n === 1 ? { ...read("base.txt"), delayMs: 600 } : { kind: "text", content: "done" }), async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "look" });
      await inference(events);
      await send({ type: "slash", id: "s1", command: "doctor", args: "--timeout 1000" });
      await send({ type: "slash", id: "s2", command: "doctor", args: "--fix" });
      const busy = await waitForEvent(events, (e) => e.id === "s2");
      assert.equal(busy.code, "BUSY");
      const doctor = await waitForEvent(events, (e) => e.type === "slash.result" && e.id === "s1", 20_000);
      assert.match(doctor.output, /active session configuration/);
      await server.idle();
      const phases = events.filter((e) => e.type === "activity").map((e) => e.phase);
      assert.ok(phases.includes("inference") && phases.includes("tool"), phases.join(","));
      const tool = events.find((e) => e.type === "activity" && e.phase === "tool");
      assert.equal(tool.tool, "read_file");
      assert.equal(tool.subject, "base.txt");
    });
  });

  test("the saved session carries plan, objective and history; export says whether it is complete", async () => {
    const objective = "Fix the importer.\n1. Reject empty names.\n2. Reject negatives.";
    const script = (n: number): Reply =>
      n === 1
        ? { kind: "tools", calls: [{ name: "update_plan", args: { phases: [{ name: "Validate", status: "completed" }] } }, { name: "update_requirements", args: { requirements: [{ id: "R1", status: "implemented", evidence: ["importer.ts"] }] } }] }
        : { kind: "text", content: "stopping" };
    await withSidecar(script, async ({ server, events, send, repo, app }) => {
      await send({ type: "prompt.submit", id: "t1", text: objective });
      await server.idle();
      const result = events.find((e) => e.type === "turn.result");
      assert.equal(result.turn.reason, "REQUIREMENTS_INCOMPLETE");
      assert.deepEqual(result.turn.objective.remaining, ["R2 [open] Reject negatives."]);
      await send({ type: "slash", id: "x1", command: "export", args: "json" });
      await server.idle();
      const file = fs.readdirSync(repo).find((f) => f.startsWith("nexus-session-") && f.endsWith(".json"))!;
      const exported = JSON.parse(fs.readFileSync(path.join(repo, file), "utf8"));
      assert.deepEqual(exported.activePlan, [{ name: "Validate", status: "completed" }]);
      assert.equal(exported.objective.requirements[0].status, "implemented");
      assert.deepEqual(exported.export.taskState.unresolvedRequirements.map((r: any) => r.id), ["R2"]);
      assert.equal(exported.export.taskState.outcome.reason, "REQUIREMENTS_INCOMPLETE");
      assert.equal(exported.export.history.complete, true);
      assert.match(exported.export.history.note, /full history/);
      assert.ok(exported.lastTurn, "the last turn is part of the saved record");
      const receipt = (await (async () => {
        await send({ type: "receipt", id: "r1" });
        return waitForEvent(events, (e) => e.type === "receipt");
      })()).sections.find((s: any) => s.title === "Requirements");
      assert.ok(receipt.rows.some(([id, v]: [string, string]) => id === "R2" && v.startsWith("OPEN")));
      void app;
      execSync("true");
    });
  });
});
