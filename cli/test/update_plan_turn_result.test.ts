import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ApplicationCore } from "../src/core/app.js";
import { SidecarServer } from "../src/sidecar.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, makeHome, Reply } from "./helpers/fixtures.js";

test("a plan-only turn completes with no verification obligation", async () => {
  const replies: Reply[] = [
    { kind: "tools", calls: [{ name: "update_plan", args: { phases: [{ name: "phase one", status: "in_progress" }] } }] },
    { kind: "text", content: "Plan updated." },
  ];
  const gw = await startGateway((n) => replies[Math.min(n - 1, replies.length - 1)]);
  const repo = makeRepo();
  const home = makeHome();
  const previousHome = process.env.HOME;
  const previousContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  process.env.HOME = home;
  const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 4, temperature: 0, workspace: repo, shell: "bash", approvalMode: "auto", fullAccess: true, continuation: { ...DEFAULT_CONTINUATION } } as HarnessConfig);
  const events: any[] = [];
  const server = new SidecarServer({ app, mode: "auto", write: (line) => events.push(JSON.parse(line)), historyFile: path.join(home, "h") });
  server.start();
  try {
    await server.handleLine(JSON.stringify({ v: 1, type: "prompt.submit", id: "t1", text: "Update the plan only; do not change workspace files." }));
    await server.idle();
    const result = events.find((event) => event.type === "turn.result");
    assert.ok(result, "turn.result must be emitted");
    assert.equal(result.turn.execution, "COMPLETED");
    assert.equal(result.turn.outcome, "NOT_REQUIRED");
    assert.equal(result.turn.unverifiedChangesPending, false);
  } finally {
    await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
    await server.idle();
    app.shutdown();
    await gw.close();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousContext === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = previousContext;
  }
});
