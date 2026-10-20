import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function writePeerResults(root: string, agent: string, task: string, budget: { steps: number; minutes: number }): string {
  const dir = path.join(root, agent);
  fs.mkdirSync(dir, { recursive: true });
  const sampling = { temperature: 0, seed: 17 };
  const packageSha256 = "d".repeat(64);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    config: {
      name: `${agent}@engineering/deep`,
      agent,
      model: "engineering/deep",
      qualification: true,
      limits: { context: 65536, output: 8192, requests: 200, totalOutput: 100_000 },
      resources: { cpuPercent: 800, memoryBytes: 17179869184, tasks: 4096, storageBytes: 21474836480, workspaceRoot: "/srv/nexus-qual/ws" },
      sampling,
      ...(agent === "nexus" ? { nexusPackageSha256: packageSha256 } : {}),
    },
    fingerprint: { alias: "engineering/deep", listed: true, ownedBy: "fixture", contextLength: 65536, weightsSha256: "a".repeat(64), serverBuild: "llama.cpp b123", sampling },
    agentVersion: { agent, version: `${agent} 1.2.3`, executablePath: `/usr/bin/${agent}`, executableSha256: "c".repeat(64), ...(agent === "nexus" ? { packageSha256 } : {}) },
    runs: 5,
  }));
  const results = path.join(dir, "results.jsonl");
  fs.writeFileSync(results, `${JSON.stringify({
    config: `${agent}@engineering/deep`,
    agent,
    agentVersion: { agent, version: `${agent} 1.2.3` },
    task,
    run: 1,
    budget,
    hiddenPass: true,
    claimedComplete: true,
    falseVerified: false,
    regressionPass: true,
    wallMs: 1000,
  })}\n`);
  return results;
}

test("--pairs escapes control characters in task IDs in mismatch diagnostics", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-score-diagnostics-"));
  try {
    const task = "fixture\tname\nnext-line";
    const files = [
      writePeerResults(out, "nexus", task, { steps: 40, minutes: 15 }),
      writePeerResults(out, "goose", task, { steps: 41, minutes: 15 }),
      writePeerResults(out, "opencode", task, { steps: 40, minutes: 15 }),
    ];
    const home = path.join(out, "home");
    fs.mkdirSync(home);
    const scored = spawnSync(process.execPath, [path.join(ROOT, "eval/score.mjs"), "--pairs", ...files, "--json"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
    });
    assert.equal(scored.status, 2, scored.stdout);
    assert.match(scored.stderr, /peer conditions do not match for fixture\\tname\\nnext-line run 1: effective budgets differ/);
    assert.equal(scored.stderr.includes("fixture\tname\nnext-line"), false, "diagnostics must not contain raw task control characters");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("--pairs escapes control characters in task IDs in missing-budget and missing-run diagnostics", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-score-diagnostic-edges-"));
  try {
    const task = "fixture\tname\nnext-line";
    const files = [
      writePeerResults(out, "nexus", task, { steps: 40, minutes: 15 }),
      writePeerResults(out, "goose", task, { steps: 40, minutes: 15 }),
      writePeerResults(out, "opencode", task, { steps: 40, minutes: 15 }),
    ];
    const home = path.join(out, "home");
    fs.mkdirSync(home);
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
    const runScore = () => spawnSync(process.execPath, [path.join(ROOT, "eval/score.mjs"), "--pairs", ...files, "--json"], { encoding: "utf8", env });

    fs.writeFileSync(files[1], `${JSON.stringify({ config: "goose@engineering/deep", agent: "goose", agentVersion: { agent: "goose", version: "goose 1.2.3" }, task, run: 1 })}\n`);
    const missingBudget = runScore();
    assert.equal(missingBudget.status, 2, missingBudget.stdout);
    assert.match(missingBudget.stderr, /goose fixture\\tname\\nnext-line run 1 is missing its effective step\/minute budget/);
    assert.equal(missingBudget.stderr.includes("fixture\tname\nnext-line"), false);

    for (const agent of ["nexus", "goose", "opencode"]) {
      fs.writeFileSync(path.join(out, agent, "results.jsonl"), `${JSON.stringify({
        config: `${agent}@engineering/deep`, agent,
        agentVersion: { agent, version: `${agent} 1.2.3` },
        task, run: 1, budget: { steps: 40, minutes: 15 },
      })}\n`);
    }
    const missingRuns = runScore();
    assert.equal(missingRuns.status, 2, missingRuns.stdout);
    assert.match(missingRuns.stderr, /fixture\\tname\\nnext-line must have matched runs 1–5/);
    assert.equal(missingRuns.stderr.includes("fixture\tname\nnext-line"), false);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("--pairs escapes control characters in successful human-readable task tables", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-score-diagnostic-success-"));
  try {
    const task = "fixture\tname\nnext-line";
    const files = [
      writePeerResults(out, "nexus", task, { steps: 40, minutes: 15 }),
      writePeerResults(out, "goose", task, { steps: 40, minutes: 15 }),
      writePeerResults(out, "opencode", task, { steps: 40, minutes: 15 }),
    ];
    for (const file of files) {
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, Array.from({ length: 5 }, (_, index) => JSON.stringify({ ...record, run: index + 1 })).join("\n") + "\n");
    }
    const home = path.join(out, "home");
    fs.mkdirSync(home);
    const scored = spawnSync(process.execPath, [path.join(ROOT, "eval/score.mjs"), "--pairs", ...files], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
    });
    assert.equal(scored.status, 0, scored.stderr);
    assert.match(scored.stdout, /\| fixture\\tname\\nnext-line \| 5 \|/);
    assert.equal(scored.stdout.includes("fixture\tname\nnext-line"), false, "human-readable tables must not contain raw task control characters");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
