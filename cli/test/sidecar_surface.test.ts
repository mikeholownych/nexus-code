/**
 * Sidecar changes the live TUI's presentation rests on: command results summarised from their structured output
 * (exit code, line count, bounded preview with controls made visible), a notice whenever the loop asks the model
 * to continue on its own, and a resumed session's recent conversation without Nexus's own prompts.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ApplicationCore } from "../src/core/app.js";
import { SidecarServer } from "../src/sidecar.js";
import { TOOL_PREVIEW_LINES, toolSummary } from "../src/protocol.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, makeHome, waitForEvent, Reply } from "./helpers/fixtures.js";

describe("tool summaries", () => {
  test("a command's result becomes exit code, line count and a bounded, safe preview", () => {
    const out = JSON.stringify({ command: "x", exit_code: 2, stdout: Array.from({ length: 12 }, (_, i) => `row ${i}`).join("\n") + "\n", stderr: "bad \u001b]52;c;SGk=\u0007 thing\n", duration_ms: 1234 });
    const s = toolSummary(false, out, out);
    assert.equal(s.summary, "exit 2 · 13 lines", "a JSON error body is not a summary");
    assert.equal(s.lines, 13);
    assert.equal(s.preview!.split("\n").length, TOOL_PREVIEW_LINES);
    assert.equal(s.exit_code, 2);
    assert.equal(s.duration_ms, 1234);
    const stderrOnly = toolSummary(true, JSON.stringify({ exit_code: 0, stdout: "", stderr: "warn \u001b[31mred\u001b[0m\n" }));
    assert.equal(stderrOnly.preview, "warn ␛[31mred␛[0m", "control characters are shown, never passed on");
    assert.equal(toolSummary(true, JSON.stringify({ exit_code: 0, stdout: "", stderr: "" })).summary, "exit 0 · no output");
    assert.equal(toolSummary(false, JSON.stringify({ exit_code: 1, stdout: "", stderr: "" }), "Command exited with code 1").summary, "Command exited with code 1");
  });

  test("other tools keep their first line as the summary and carry no preview", () => {
    const s = toolSummary(true, "first line\nsecond");
    assert.deepEqual(s, { summary: "first line", lines: 2 });
  });
});

async function rig(script: (n: number, body?: any) => Reply, fn: (r: { server: SidecarServer; events: any[]; send: (m: object) => Promise<void> }) => Promise<void>, options: { resume?: string; home?: string; repo?: string } = {}) {
  const gw = await startGateway(script);
  const repo = options.repo ?? makeRepo();
  const home = options.home ?? makeHome();
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 30, temperature: 0, workspace: repo, shell: "bash", continuation: { ...DEFAULT_CONTINUATION } } as HarnessConfig);
  const events: any[] = [];
  const server = new SidecarServer({ app, mode: "auto", write: (line) => events.push(JSON.parse(line)), historyFile: path.join(home, "history"), ...(options.resume ? { resume: options.resume } : {}) });
  server.start();
  try {
    await fn({ server, events, send: (m) => server.handleLine(JSON.stringify({ v: 1, ...m })) });
  } finally {
    await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
    await server.idle();
    app.shutdown();
    await gw.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (!options.home) fs.rmSync(home, { recursive: true, force: true });
    if (!options.repo) fs.rmSync(repo, { recursive: true, force: true });
  }
}

describe("continuation and resume", () => {
  test("each time the loop asks the model to continue, the client is told why", async () => {
    await rig(() => ({ kind: "text", content: "Both items are handled." }), async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "Do these:\n1. add a README section\n2. add a changelog entry" });
      await server.idle();
      const notices = events.filter((e) => e.type === "notice" && /asked the agent to continue/.test(e.text)).map((e) => e.text);
      assert.deepEqual(notices, [
        "Requirements still open (R1, R2): Nexus asked the agent to continue (1 of 2).",
        "Requirements still open (R1, R2): Nexus asked the agent to continue (2 of 2).",
      ]);
      const result = events.find((e) => e.type === "turn.result");
      assert.equal(result.turn.reason, "REQUIREMENTS_INCOMPLETE");
    });
  });

  test("a resumed session sends its recent conversation without Nexus's own prompts, steering marked as such", async () => {
    const home = makeHome();
    const repo = makeRepo();
    try {
      const previousHome = process.env.HOME;
      process.env.HOME = home;
      const { SessionManager } = await import("../src/session.js");
      const { WorkspacePath } = await import("../src/core/workspace_path.js");
      const identity = WorkspacePath.fromSelectedWorkspace(repo);
      new SessionManager(path.join(home, ".nexus", "sessions"), () => identity).saveSession({
        id: "session_20261012_000000_test",
        workspace: repo,
        model: "m",
        messages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "Explain the plan\n\n[Git Status: main (3 uncommitted dirty files)]\n[Active Plan: 1. [in_progress] cache]" },
          { role: "assistant", content: "## Plan\n\n- first" },
          { role: "user", content: "[Nexus continuation 1/2] The operator's acceptance requirements are still open." },
          { role: "user", content: "[Operator steering g1]: prefer an LRU policy" },
          { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] } as any,
          { role: "tool", content: "file body", tool_call_id: "c1" } as any,
          { role: "assistant", content: "Done with key sk-test-0123456789abcdefghij0123" },
        ],
      } as any, identity);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rig(() => ({ kind: "text", content: "ok" }), async ({ events }) => {
        const history = await waitForEvent(events, (e) => e.type === "history");
        assert.equal(history.session, "session_20261012_000000_test");
        assert.equal(history.messages[0].text, "Explain the plan", "the appended runtime context is not the operator's text");
        assert.deepEqual(history.messages.map((m: any) => [m.role, m.text.slice(0, 24)]), [
          ["user", "Explain the plan"],
          ["assistant", "## Plan\n\n- first"],
          ["steering", "prefer an LRU policy"],
          ["assistant", "Done with key [REDACTED:"],
        ]);
        assert.equal(history.total, 4);
        const notice = events.find((e) => e.type === "notice");
        assert.ok(events.indexOf(history) < events.indexOf(notice), "the conversation comes before the resume notice");
      }, { resume: "latest", home, repo });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
