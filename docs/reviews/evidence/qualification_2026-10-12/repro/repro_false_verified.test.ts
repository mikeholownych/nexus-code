// Assessment reproduction (isolated extract only): can a wrong deliverable end VERIFIED?
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ApplicationCore } from "../src/core/app.js";
import { SidecarServer } from "../src/sidecar.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, makeHome, Reply } from "./helpers/fixtures.js";

test("a wrong implementation with an unrelated passing suite", async () => {
  const replies: Reply[] = [
    { kind: "tools", calls: [{ name: "write_file", args: { path: "math.js", content: "exports.add = (a, b) => a - b;\n" } }] },
    { kind: "tools", calls: [{ name: "run_tests", args: {} }] },
    { kind: "tools", calls: [{ name: "update_requirements", args: { requirements: [{ id: "R1", status: "verified", evidence: ["npm test passed"] }] } }] },
    { kind: "tools", calls: [{ name: "task_completed", args: { summary: "Added add(a, b) returning a + b." } }] },
    { kind: "text", content: "Done." },
  ];
  const gw = await startGateway((n) => replies[Math.min(n - 1, replies.length - 1)]);
  // The suite tests something else entirely; nothing covers math.js.
  const repo = makeRepo({ "package.json": JSON.stringify({ name: "x", scripts: { test: "node -e \"require('assert').equal(1 + 1, 2)\"" } }) });
  const home = makeHome();
  const prev = process.env.HOME;
  process.env.HOME = home;
  const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 30, temperature: 0, workspace: repo, shell: "bash", continuation: { ...DEFAULT_CONTINUATION } } as HarnessConfig);
  const events: any[] = [];
  const server = new SidecarServer({ app, mode: "auto", write: (l) => events.push(JSON.parse(l)), historyFile: path.join(home, "h") });
  server.start();
  try {
    await server.handleLine(JSON.stringify({ v: 1, type: "prompt.submit", id: "t1", text: "Implement this:\n1. add math.js exporting add(a, b) that returns a + b" }));
    await server.idle();
    const result = events.find((e) => e.type === "turn.result");
    const req = app.getAgent().getObjective()?.requirements.find((r: any) => r.id === "R1");
    console.log("RESULT", JSON.stringify({ execution: result.turn.execution, outcome: result.turn.outcome, reason: result.turn.reason ?? null, verifier: result.turn.verification?.command ?? null, R1: req?.status, file: fs.readFileSync(path.join(repo, "math.js"), "utf8").trim() }));
  } finally {
    await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
    await server.idle();
    app.shutdown();
    await gw.close();
    if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
  }
});
