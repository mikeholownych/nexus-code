/**
 * The evaluation harness end to end against a scripted model (Stage 8, T1 smoke): fresh workspaces, hidden tests the
 * agent never sees, separate scores. The self-test task is the assessment's A1 case: a repository whose own suite is
 * green but never exercises the deliverable. A wrong deliverable must fail the hidden test and must never be VERIFIED.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startGateway, Reply } from "./helpers/fixtures.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Async: the scripted gateway answers from this process, so the runner must not block its event loop. */
function runNode(argv: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function writer(content: string) {
  return (_n: number, body: any): Reply => {
    const tools = (body?.messages ?? []).filter((m: any) => m.role === "tool").length;
    if (tools === 0) return { kind: "tools", calls: [{ name: "write_file", args: { path: "math.js", content } }] };
    if (tools === 1) return { kind: "tools", calls: [{ name: "task_completed", args: { summary: "math.js added" } }] };
    return { kind: "text", content: "Done." };
  };
}

async function evaluate(content: string): Promise<{ records: any[]; score: any }> {
  const gw = await startGateway(writer(content));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-out-"));
  const config = path.join(out, "config.json");
  fs.writeFileSync(config, JSON.stringify({ name: "nexus@mock", agent: "nexus", endpoint: gw.url, model: "m", runs: 1, steps: 20, minutes: 5 }));
  try {
    const run = await runNode([path.join(ROOT, "eval/run.mjs"), "--config", config, "--out", out, "--only", "selftest-add"]);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const records = fs.readFileSync(path.join(out, "results.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const scored = spawnSync(process.execPath, [path.join(ROOT, "eval/score.mjs"), path.join(out, "results.jsonl"), "--json"], { encoding: "utf8" });
    assert.equal(scored.status, 0, scored.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    assert.equal(manifest.tasks.join(), "selftest-add");
    assert.match(manifest.harness.string, /^[0-9a-f]{12}/);
    return { records, score: JSON.parse(scored.stdout) };
  } finally {
    await gw.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
}

test("a correct deliverable passes the hidden test; a wrong one fails it and is never VERIFIED (A1)", { timeout: 300_000 }, async () => {
  const good = await evaluate("exports.add = (a, b) => a + b;\n");
  assert.equal(good.records.length, 1);
  assert.equal(good.records[0].hiddenPass, true, JSON.stringify(good.records[0]));
  assert.equal(good.records[0].regressionPass, true);
  assert.equal(good.records[0].falseVerified, false);

  const wrong = await evaluate("exports.add = (a, b) => a - b;\n");
  const r = wrong.records[0];
  assert.equal(r.hiddenPass, false, "the hidden test catches the wrong deliverable");
  assert.equal(r.regressionPass, true, "the repository's own suite is still green");
  assert.notEqual(r.turn?.outcome, "VERIFIED", `an unrelated green suite does not verify it: ${JSON.stringify(r.turn)}`);
  assert.equal(r.falseVerified, false);
  assert.equal(wrong.score.totals.falseVerified, 0);
  assert.equal(wrong.score.rows[0].correct, 0);
});
