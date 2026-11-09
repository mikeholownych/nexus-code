/**
 * Approval input through the real TUI and sidecar in a pseudo-terminal (review mode): keys queued while the panel was
 * not yet on screen, a delayed burst, and a bracketed paste never decide an approval; one deliberate key does, at once
 * (WP-1317 D-01). See helpers/tui_approval_driver.py and helpers/tui_approval_single_key_driver.py for the sequences.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startGateway, makeRepo, makeHome, Reply, ptyTest } from "./helpers/fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const TUI = path.join(ROOT, "core/target/release/nexus-tui");
const SIDECAR = path.join(ROOT, "cli/dist/sidecar.js");

function script(_n: number, body: any): Reply {
  const tools = (body?.messages ?? []).filter((m: any) => m.role === "tool").length;
  if (tools === 0) return { kind: "tools", calls: [{ name: "write_file", args: { path: "first.txt", content: "one\n" } }], delayMs: 800 };
  if (tools === 1) return { kind: "tools", calls: [{ name: "write_file", args: { path: "second.txt", content: "two\n" } }] };
  // The third approval appears while the operator is still typing.
  if (tools === 2) return { kind: "tools", calls: [{ name: "write_file", args: { path: "third.txt", content: "three\n" } }], delayMs: 1200 };
  return { kind: "text", content: "Done." };
}

ptyTest("queued keys, bursts and pastes never answer an approval; one deliberate key does, and typed text goes to the draft", { timeout: 120_000 }, async () => {
  for (const p of [TUI, SIDECAR]) assert.ok(fs.existsSync(p), `missing ${p} (run make build)`);
  const gw = await startGateway(script);
  const repo = makeRepo();
  const home = makeHome();
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tui-approval-"));
  const plan = {
    tui: TUI,
    recorder: path.join(here, "helpers/sidecar_recorder.mjs"),
    node: process.execPath,
    sidecar_args: ["-w", repo, "-e", gw.url, "-m", "m", "--approve"],
    env: {
      HOME: home,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      NEXUS_DEBUG: "0",
      NEXUS_RECORD_SIDECAR: SIDECAR,
      NEXUS_RECORD_COMMANDS: path.join(logs, "commands.ndjson"),
      NEXUS_RECORD_EVENTS: path.join(logs, "events.ndjson"),
    },
  };
  const planFile = path.join(logs, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan));
  try {
    const { code, out, err } = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn("python3", [path.join(here, "helpers/tui_approval_driver.py"), planFile], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (c) => resolve({ code: c, out, err }));
    });
    assert.equal(code, 0, `driver failed:\n${err}\n${out.slice(-2000)}`);
    const r = JSON.parse(out.trim().split("\n").pop()!);
    assert.ok(r.approval_arrived_while_frozen, "the approval arrived while the TUI was frozen");
    assert.deepEqual(r.after_queued_keys, { decisions: [], panel_open: true }, "keys queued before the panel was on screen did not decide");
    assert.deepEqual(r.after_burst, { decisions: [], panel_open: true }, "a burst did not decide");
    assert.deepEqual(r.after_paste, { decisions: [], panel_open: true }, "a paste did not decide");
    assert.deepEqual(r.after_deny, ["deny"], "after a burst and a paste into the panel, one `n` still denies");
    assert.deepEqual(r.after_approve, ["deny", "approve"], "one `y` right after the next panel appeared approved");
    assert.deepEqual(r.after_typing_across, { decisions: ["deny", "approve"], panel_open: true }, "text without an approval key, typed across the panel's appearance, decided nothing");
    assert.ok(r.draft_kept, "that text is kept in the draft");
    assert.deepEqual(r.after_typing_then_deny, ["deny", "approve", "deny"], "`n` then denies");
    assert.ok(!fs.existsSync(path.join(repo, "third.txt")), "the write proposed during typing did not happen");
    // Input typed into the frozen terminal is either discarded (the approval event reached the TUI first) or, when it
    // is read before the event (the sidecar reader thread was frozen too), goes where typing goes while the agent
    // works: steering, shown in the transcript. Either way it never decides.
    const commands = fs.readFileSync(plan.env.NEXUS_RECORD_COMMANDS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(commands.filter((c) => c.type === "steer").every((c) => c.text === "y"), JSON.stringify(commands));
    assert.deepEqual(commands.filter((c) => c.type === "approve" || c.type === "deny").map((c) => c.id), ["approval-1", "approval-2", "approval-3"]);
    assert.ok(!fs.existsSync(path.join(repo, "first.txt")), "the denied write did not happen");
    assert.equal(fs.readFileSync(path.join(repo, "second.txt"), "utf8"), "two\n", "the approved write happened");
  } finally {
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function twoWrites(_n: number, body: any): Reply {
  const tools = (body?.messages ?? []).filter((m: any) => m.role === "tool").length;
  if (tools === 0) return { kind: "tools", calls: [{ name: "write_file", args: { path: "first.txt", content: "one\n" } }] };
  if (tools === 1) return { kind: "tools", calls: [{ name: "write_file", args: { path: "second.txt", content: "two\n" } }] };
  return { kind: "text", content: "Done." };
}

ptyTest("a single y approves a write, and the next approval takes a single y with no lock-out (D-01)", { timeout: 120_000 }, async () => {
  const gw = await startGateway(twoWrites);
  const repo = makeRepo();
  const home = makeHome();
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tui-approval-single-"));
  const plan = {
    tui: TUI,
    recorder: path.join(here, "helpers/sidecar_recorder.mjs"),
    node: process.execPath,
    sidecar_args: ["-w", repo, "-e", gw.url, "-m", "m", "--approve"],
    env: {
      HOME: home,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      NEXUS_DEBUG: "0",
      NEXUS_RECORD_SIDECAR: SIDECAR,
      NEXUS_RECORD_COMMANDS: path.join(logs, "commands.ndjson"),
      NEXUS_RECORD_EVENTS: path.join(logs, "events.ndjson"),
    },
  };
  const planFile = path.join(logs, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan));
  try {
    const { code, out, err } = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn("python3", [path.join(here, "helpers/tui_approval_single_key_driver.py"), planFile], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (c) => resolve({ code: c, out, err }));
    });
    assert.equal(code, 0, `driver failed:\n${err}\n${out.slice(-2000)}`);
    const r = JSON.parse(out.trim().split("\n").pop()!);
    const panel = r.panel.join("\n");
    assert.match(panel, /▸y Approve/, `the panel opens with Approve focused:\n${panel}`);
    assert.match(panel, /a Approve all later actions/, panel);
    assert.match(panel, /n Deny/, panel);
    assert.match(panel, /y approve · n deny/, `the panel says which keys answer it:\n${panel}`);
    assert.doesNotMatch(panel, /typing ignored/, panel);
    assert.deepEqual(r.after_first_y, ["approve"], "one `y` approved the first write");
    assert.deepEqual(r.after_second_y, ["approve", "approve"], "one `y` approved the second write right after the first");
    const commands = fs.readFileSync(plan.env.NEXUS_RECORD_COMMANDS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(commands.filter((c) => c.type === "approve").map((c) => c.always), [false, false], "approved once each, review mode kept");
    assert.equal(fs.readFileSync(path.join(repo, "first.txt"), "utf8"), "one\n");
    assert.equal(fs.readFileSync(path.join(repo, "second.txt"), "utf8"), "two\n");
  } finally {
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
