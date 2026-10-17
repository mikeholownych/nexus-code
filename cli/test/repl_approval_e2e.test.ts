/**
 * ACC-SAFE-03 & ACC-SAFE-08: REPL approval hardening e2e in a real pseudo-terminal (PTY).
 *
 * Verifies:
 * 1. Lone Enter at approval prompt -> DENIED (returns false, file not written)
 * 2. Keystrokes typed ahead before approval prompt -> cleared with Ctrl-U and line buffer reset, DENIED
 * 3. Paste within the 400ms grace window -> discarded, not approved
 * 4. Deliberate 'y' after 500ms -> APPROVED (action executed)
 * 5. 'a' (always allow session) requires explicit confirmation typing 'all';
 *    unconfirmed cancels and reprompts, confirmed switches session to auto-approve.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startGateway, makeRepo, makeHome, Reply, ptyTest } from "./helpers/fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const INDEX = path.join(ROOT, "dist/index.js");
const DRIVER = path.join(here, "helpers/repl_approval_driver.py");

function script(_n: number, body: any): Reply {
  const messages: any[] = body?.messages ?? [];
  let lastUserIdx = -1;
  let filename = "target.txt";

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      const text = typeof messages[i].content === "string" ? messages[i].content : "";
      const m = text.match(/create\s+([a-zA-Z0-9_\-\.]+)/i);
      if (m) filename = m[1];
      break;
    }
  }

  const toolsSinceUser = lastUserIdx >= 0
    ? messages.slice(lastUserIdx).filter((m) => m.role === "tool").length
    : 0;

  if (toolsSinceUser === 0) {
    return {
      kind: "tools",
      calls: [{ name: "write_file", args: { path: filename, content: `content for ${filename}\n` } }],
      delayMs: 500, // delay allows typed-ahead input to land mid-turn
    };
  }
  return { kind: "text", content: `Finished handling ${filename}.` };
}

async function runScenario(scenario: string): Promise<any> {
  const repo = makeRepo();
  const home = makeHome();
  const gw = await startGateway(script);
  const plan = {
    node: process.execPath,
    index: INDEX,
    args: ["repl", "--approve", "-w", repo, "-e", gw.url, "-m", "m"],
    ws: repo,
    home,
    scenario,
    env: {
      HOME: home,
      NEXUS_DEBUG: "0",
    },
  };
  const planFile = path.join(home, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan));

  try {
    const { code, out, err } = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn("python3", [DRIVER, planFile], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (c) => resolve({ code: c, out, err }));
    });
    assert.equal(code, 0, `driver failed for scenario '${scenario}':\n${err}\n${out}`);
    const lastLine = out.trim().split("\n").pop() || "{}";
    return JSON.parse(lastLine);
  } finally {
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

ptyTest("REPL approval hardening (ACC-SAFE-03): lone Enter, typed-ahead, paste, deliberate approval, and session confirmation", { timeout: 180_000 }, async () => {
  assert.ok(fs.existsSync(INDEX), `missing ${INDEX} (run npm run build)`);
  assert.ok(fs.existsSync(DRIVER), `missing ${DRIVER}`);

  // 1. Lone Enter -> DENIED
  const r1 = await runScenario("lone_enter");
  assert.equal(r1.file_created, false, "lone Enter must NOT approve the action");
  assert.equal(r1.passed, true);

  // 2. Typed ahead mid-turn -> DISCARDED & DENIED
  const r2 = await runScenario("typed_ahead");
  assert.equal(r2.file_created, false, "typed-ahead input must be discarded and NOT approve");
  assert.equal(r2.passed, true);

  // 3. Paste during grace window -> DISCARDED & NOT APPROVED
  const r3 = await runScenario("paste");
  assert.equal(r3.created_during_grace, false, "burst/paste during grace window must NOT approve");
  assert.equal(r3.created_after_deny, false);
  assert.equal(r3.passed, true);

  // 4. Deliberate 'y' after grace window -> APPROVED
  const r4 = await runScenario("deliberate");
  assert.equal(r4.file_created, true, "deliberate 'y' after grace window MUST approve");
  assert.equal(r4.passed, true);

  // 5. 'a' confirmation: unconfirmed cancels, 'all' enables auto-mode
  const r5 = await runScenario("confirm_a");
  assert.equal(r5.auto1_cancelled, true, "unconfirmed 'a' must cancel auto-approval");
  assert.equal(r5.auto1_created, true, "confirmed 'a' with 'all' must approve initial action");
  assert.equal(r5.auto2_created, true, "subsequent actions must run in auto mode without prompt");
  assert.equal(r5.passed, true);
});
