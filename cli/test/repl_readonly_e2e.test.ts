import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startGateway, makeRepo, makeHome, trustWorkspace, ptyTest } from "./helpers/fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const INDEX = path.join(ROOT, "dist/index.js");
const DRIVER = path.join(here, "helpers/repl_approval_driver.py");

async function runScenario(scenario: string, extraArgs: string[]): Promise<any> {
  const repo = makeRepo();
  const home = makeHome();
  trustWorkspace(home, repo);
  const gw = await startGateway(() => ({ kind: "text", content: "unused" }));
  const planFile = path.join(home, "readonly-plan.json");
  fs.writeFileSync(planFile, JSON.stringify({
    node: process.execPath,
    index: INDEX,
    args: ["repl", ...extraArgs, "-w", repo, "-e", gw.url, "-m", "m"],
    ws: repo,
    home,
    scenario,
    env: { HOME: home, NEXUS_DEBUG: "0" },
  }));
  let driverShutdownConfirmed = false;
  try {
    const { code, out, err } = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn("python3", [DRIVER, planFile], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("close", (code) => resolve({ code, out, err }));
    });
    driverShutdownConfirmed = code === 0;
    assert.equal(code, 0, `driver failed:\n${err}\n${out}`);
    return JSON.parse(out.trim().split("\n").pop() || "{}");
  } finally {
    await gw.close();
    if (driverShutdownConfirmed) {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
}

ptyTest("an explicit --read-only REPL refuses mutating slash scaffolding", { timeout: 120_000 }, async () => {
  assert.ok(fs.existsSync(INDEX), `missing ${INDEX} (run npm run build)`);
  assert.ok(fs.existsSync(DRIVER), `missing ${DRIVER}`);
  const result = await runScenario("readonly_slash", ["--read-only"]);
  assert.equal(result.skill_created, false, "read-only REPL must not scaffold a skill");
  assert.equal(result.agents_created, false, "read-only REPL must not scaffold project instructions");
  assert.equal(result.passed, true);
});

ptyTest("mode-selected read-only refuses mutating slash scaffolding too", { timeout: 120_000 }, async () => {
  assert.ok(fs.existsSync(INDEX), `missing ${INDEX} (run npm run build)`);
  assert.ok(fs.existsSync(DRIVER), `missing ${DRIVER}`);
  const result = await runScenario("readonly_mode_slash", []);
  assert.equal(result.agents_created, false, "a /mode read-only session must not scaffold project instructions");
  assert.equal(result.passed, true);
});
