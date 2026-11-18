/**
 * MQ-3: the real-project smoke is green on the clean repositories and red on a seeded regression. The script drives the
 * built CLI (cli/dist) against a scripted local gateway; the fake-CLI tests prove each failure mode turns the job red
 * without needing the real defect: an every-completion error (the v1.1.4 shape), an error outcome, and a hang.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "real_project_smoke.mjs");

interface Report { seedRegression: boolean; results: Array<{ name: string; ok: boolean; skipped?: boolean; outcome: string | null; problems: string[] }> }

function smoke(args: string[], env: Record<string, string> = {}) {
  const clean: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete clean.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, [SCRIPT, ...args, "--json"], { encoding: "utf8", env: clean, timeout: 280_000 });
  let report: Report | null = null;
  try { report = JSON.parse(run.stdout); } catch { /* usage error: no report */ }
  return { code: run.status, report, stderr: run.stderr };
}

/** A stand-in for cli/dist/index.js that prints a fixed `--json` result and exits with a fixed code. */
function fakeCli(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-smoke-fake-"));
  const file = path.join(dir, "index.js");
  fs.writeFileSync(file, body);
  return file;
}
const result = (turn: object, code: number) =>
  `console.log(JSON.stringify({ success: false, turn: ${JSON.stringify(turn)}, exitCode: ${code} }, null, 2)); process.exit(${code});\n`;

test("clean repositories: every one completes REGRESSION_FREE (or VERIFIED), never an error", { timeout: 290_000 }, () => {
  const { code, report, stderr } = smoke(["--only", "js-node_modules,makefile-large-graph,deeply-nested", "--require-all"]);
  assert.ok(report, stderr);
  assert.equal(report.results.length, 3);
  for (const r of report.results) {
    assert.equal(r.ok, true, `${r.name}: ${r.problems.join("; ")}`);
    assert.ok(r.outcome === "REGRESSION_FREE" || r.outcome === "VERIFIED", `${r.name}: ${r.outcome}`);
  }
  // The two shapes that were unbindable in v1.1.4 must still complete as regression evidence only.
  const byName = new Map(report.results.map((r) => [r.name, r.outcome]));
  assert.equal(byName.get("js-node_modules"), "REGRESSION_FREE");
  assert.equal(byName.get("makefile-large-graph"), "REGRESSION_FREE");
  assert.equal(code, 0);
});

test("seeded regression: a fix the verifier rejects turns the job red", { timeout: 290_000 }, () => {
  const { code, report } = smoke(["--seed-regression", "--only", "js-node_modules,makefile-large-graph"]);
  assert.ok(report);
  assert.equal(report.seedRegression, true);
  assert.equal(code, 1);
  assert.equal(report.results.every((r) => !r.ok), true);
  assert.ok(report.results.every((r) => r.outcome !== "REGRESSION_FREE" && r.outcome !== "VERIFIED"));
});

test("the v1.1.4 shape (completion blocked, NOT_ESTABLISHED) is red; REGRESSION_FREE with exit 2 is green", { timeout: 120_000 }, () => {
  const blocked = fakeCli(result({ execution: "COMPLETED", outcome: "NOT_ESTABLISHED", detail: "verifier definition could not be bound" }, 1));
  const red = smoke(["--cli", blocked, "--only", "js-node_modules"]);
  assert.equal(red.code, 1);
  assert.match(red.report!.results[0].problems.join(" "), /NOT_ESTABLISHED is not REGRESSION_FREE or VERIFIED/);

  const good = fakeCli(result({ execution: "COMPLETED", outcome: "REGRESSION_FREE" }, 2));
  const green = smoke(["--cli", good, "--only", "js-node_modules"]);
  assert.equal(green.code, 0);
  assert.equal(green.report!.results[0].ok, true);
});

test("an UNVERIFIED completion, an execution error and a wrong exit code are each red", { timeout: 120_000 }, () => {
  const cases: Array<[string, string, RegExp]> = [
    [result({ execution: "COMPLETED", outcome: "UNVERIFIED" }, 2), "unverified", /UNVERIFIED is not/],
    [result({ execution: "FAILED", outcome: "REGRESSION_FREE" }, 1), "execution error", /execution FAILED, not COMPLETED/],
    [result({ execution: "COMPLETED", outcome: "REGRESSION_FREE" }, 0), "exit code", /exit code 0/],
    ["console.log('not json'); process.exit(1);\n", "no result", /no JSON result/],
  ];
  for (const [body, label, expected] of cases) {
    const { code, report } = smoke(["--cli", fakeCli(body), "--only", "js-node_modules"]);
    assert.equal(code, 1, label);
    assert.match(report!.results[0].problems.join(" "), expected, label);
  }
});

test("a hung CLI is killed and reported, not waited on", { timeout: 60_000 }, () => {
  const { code, report } = smoke(["--cli", fakeCli("setInterval(() => {}, 1000);\n"), "--only", "js-node_modules"], { NEXUS_SMOKE_TIMEOUT_MS: "1500" });
  assert.equal(code, 1);
  assert.match(report!.results[0].problems.join(" "), /hung: killed after/);
});

test("usage errors exit 2: a missing CLI build and an unknown argument", () => {
  assert.equal(smoke(["--cli", path.join(os.tmpdir(), "nexus-smoke-no-such-cli.js")]).code, 2);
  assert.equal(smoke(["--bogus"]).code, 2);
});

test("the pytest probe sees what the isolated run sees: a pytest visible only from the real HOME is reported unavailable", async () => {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-smoke-fakepy-"));
  const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-smoke-realhome-"));
  fs.writeFileSync(path.join(fake, "python3"), `#!/bin/sh\n[ "$HOME" = "${realHome}" ] && exit 0\nexit 1\n`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
  try {
    process.env.PATH = `${fake}${path.delimiter}${saved.PATH}`;
    process.env.HOME = realHome;
    const mod = await import(`${path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/real_project_smoke.mjs")}?probe`);
    assert.equal(mod.pytestAvailable(), false, "a pytest importable only under the real HOME is not available to the isolated run");
    fs.writeFileSync(path.join(fake, "python3"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    assert.equal(mod.pytestAvailable(), true, "a system-wide pytest is available");
  } finally {
    process.env.PATH = saved.PATH;
    process.env.HOME = saved.HOME;
    fs.rmSync(fake, { recursive: true, force: true });
    fs.rmSync(realHome, { recursive: true, force: true });
  }
});
