// ACC-VER-09: can a wrong deliverable with an unrelated passing suite end VERIFIED? Must be REGRESSION_FREE.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ApplicationCore } from "../src/core/app.js";
import { SidecarServer } from "../src/sidecar.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, makeHome, Reply } from "./helpers/fixtures.js";

test("ACC-VER-09: wrong implementation with unrecognized test script ends NOT_ESTABLISHED (never VERIFIED)", async () => {
  const replies: Reply[] = [
    { kind: "tools", calls: [{ name: "write_file", args: { path: "math.js", content: "exports.add = (a, b) => a - b;\n" } }] },
    { kind: "tools", calls: [{ name: "run_tests", args: {} }] },
    { kind: "tools", calls: [{ name: "update_requirements", args: { requirements: [{ id: "R1", status: "verified", evidence: ["npm test passed"] }] } }] },
    { kind: "tools", calls: [{ name: "task_completed", args: { summary: "Added add(a, b) returning a + b." } }] },
    { kind: "text", content: "Done." },
  ];
  const gw = await startGateway((n) => replies[Math.min(n - 1, replies.length - 1)]);
  // The suite has no recognizable test runner output (zero executed tests)
  const repo = makeRepo({ "package.json": JSON.stringify({ name: "x", scripts: { test: "node -e \"require('assert').equal(1 + 1, 2)\"" } }) });
  const home = makeHome();
  const prev = process.env.HOME;
  const prevContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  process.env.HOME = home;
  const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 30, temperature: 0, workspace: repo, shell: "bash", approvalMode: "auto", fullAccess: true, continuation: { ...DEFAULT_CONTINUATION } } as HarnessConfig);
  const events: any[] = [];
  const server = new SidecarServer({ app, mode: "auto", write: (l) => events.push(JSON.parse(l)), historyFile: path.join(home, "h") });
  server.start();
  try {
    await server.handleLine(JSON.stringify({ v: 1, type: "prompt.submit", id: "t1", text: "Implement this:\n1. add math.js exporting add(a, b) that returns a + b" }));
    await server.idle();
    const result = events.find((e) => e.type === "turn.result");
    assert.ok(result, "turn.result must be emitted");
    assert.equal(result.turn.execution, "COMPLETED");
    assert.notEqual(result.turn.outcome, "VERIFIED", "unrelated test script must NEVER yield VERIFIED (ACC-VER-09)");
    assert.equal(result.turn.outcome, "NOT_ESTABLISHED");
  } finally {
    await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
    await server.idle();
    app.shutdown();
    await gw.close();
    if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
    if (prevContext === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = prevContext;
  }
});

test("ACC-VER-09: wrong implementation with unrelated passing tests ends REGRESSION_FREE (never VERIFIED)", async () => {
  const replies: Reply[] = [
    { kind: "tools", calls: [{ name: "write_file", args: { path: "math.js", content: "exports.add = (a, b) => a - b;\n" } }] },
    { kind: "tools", calls: [{ name: "run_tests", args: {} }] },
    { kind: "tools", calls: [{ name: "task_completed", args: { summary: "Added add(a, b) returning a + b." } }] },
    { kind: "text", content: "Done." },
  ];
  const gw = await startGateway((n) => replies[Math.min(n - 1, replies.length - 1)]);
  // The suite runs node:test on an unrelated test, producing real executed test output that does not mention math.js
  const repo = makeRepo({
    "package.json": JSON.stringify({
      name: "x",
      scripts: {
        test: "node --test",
      },
    }),
    "test/unrelated.test.mjs": "import test from 'node:test'; test('unrelated', () => {});\n",
  });
  const home = makeHome();
  const prev = process.env.HOME;
  const prevContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  process.env.HOME = home;
  const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 30, temperature: 0, workspace: repo, shell: "bash", approvalMode: "auto", fullAccess: true, continuation: { ...DEFAULT_CONTINUATION } } as HarnessConfig);
  const events: any[] = [];
  const server = new SidecarServer({ app, mode: "auto", write: (l) => events.push(JSON.parse(l)), historyFile: path.join(home, "h") });
  server.start();
  try {
    await server.handleLine(JSON.stringify({ v: 1, type: "prompt.submit", id: "t1", text: "Implement this:\n1. add math.js exporting add(a, b) that returns a + b" }));
    await server.idle();
    const result = events.find((e) => e.type === "turn.result");
    assert.ok(result, "turn.result must be emitted");
    assert.equal(result.turn.execution, "COMPLETED");
    assert.notEqual(result.turn.outcome, "VERIFIED", "unrelated passing test suite must NEVER yield VERIFIED (ACC-VER-09)");
    assert.equal(result.turn.outcome, "REGRESSION_FREE");
  } finally {
    await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
    await server.idle();
    app.shutdown();
    await gw.close();
    if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
    if (prevContext === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = prevContext;
  }
});
