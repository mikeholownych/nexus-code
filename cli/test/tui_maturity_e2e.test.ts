/**
 * The real active TUI (`nexus-tui --live` + the real sidecar) in a pseudo-terminal: slow inference with the
 * animated indicator, steering while busy, successful and failed edits with per-operation diffs, a turn longer than
 * 30 steps that continues on its own, idle CPU and redraws, resize, a multi-line paste, cancellation, and resuming
 * the saved session. The Python driver owns the terminal (resize, CPU time, asciicast); this test owns the mock
 * gateway and checks the sidecar's command and event logs. The recording and transcript are kept as evidence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startGateway, makeRepo, makeHome, Reply } from "./helpers/fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const TUI = path.join(ROOT, "core/target/release/nexus-tui");
const SIDECAR = path.join(ROOT, "cli/dist/sidecar.js");
const RECORDER = path.join(here, "helpers/sidecar_recorder.mjs");
const DRIVER = path.join(here, "helpers/tui_pty_driver.py");
// Evidence files are written only on an explicit evidence run (NEXUS_E2E_EVIDENCE=1); ordinary runs use a temp dir,
// so the published recording and metrics always come from one identified run.
const EVIDENCE = process.env.NEXUS_E2E_EVIDENCE === "1" ? path.join(ROOT, "docs/reviews/evidence") : fs.mkdtempSync(path.join(os.tmpdir(), "nexus-e2e-evidence-"));
const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const script = (n: number): Reply => {
  if (n === 1) return { kind: "tools", calls: [{ name: "read_file", args: { path: "notes.txt" } }], delayMs: 1800 };
  if (n === 2) return { kind: "tools", calls: [{ name: "edit_file", args: { path: "notes.txt", old_content: "line 2\n", new_content: "line two\n" } }] };
  if (n === 3) return { kind: "tools", calls: [{ name: "edit_file", args: { path: "notes.txt", old_content: "not in the file", new_content: "x" } }] };
  if (n >= 4 && n <= 34) return { kind: "tools", calls: [{ name: "write_file", args: { path: `f${n}.txt`, content: `${n}\n` } }] };
  if (n === 35) return { kind: "text", content: "Finished the batch." };
  if (n === 36) return { kind: "text", content: "Noted." };
  if (n === 37) return { kind: "text", content: "too late", delayMs: 6000 };
  return { kind: "text", content: "Yes, resumed." };
};

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("the active TUI end to end through a pseudo-terminal", { timeout: 240_000 }, async () => {
  for (const p of [TUI, SIDECAR]) assert.ok(fs.existsSync(p), `missing ${p} (run make build)`);
  const gw = await startGateway(script);
  const repo = makeRepo({ "notes.txt": "line 1\nline 2\nline 3\n" });
  const home = makeHome();
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tui-e2e-"));
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const plan = {
    tui: TUI,
    recorder: RECORDER,
    node: process.execPath,
    sidecar_args: ["-w", repo, "-e", gw.url, "-m", "m"],
    cast: path.join(EVIDENCE, "nexus_maturity_tui_2026-10-11.cast"),
    transcript: path.join(EVIDENCE, "nexus_maturity_tui_2026-10-11.txt"),
    env: {
      HOME: home,
      TERM: "xterm-256color",
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
      const child = spawn("python3", [DRIVER, planFile], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (c) => resolve({ code: c, out, err }));
    });
    assert.equal(code, 0, `driver failed:\n${err}\n${out}`);
    const r = JSON.parse(out.trim().split("\n").pop()!);
    const metricsFile = path.join(EVIDENCE, "nexus_maturity_tui_2026-10-11.metrics.json");
    const runId = randomUUID();
    let head = "unknown";
    try {
      head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    } catch {}
    fs.writeFileSync(metricsFile, JSON.stringify({ run: { id: runId, generatedAt: new Date().toISOString(), gitHead: head, workingTreeDirty: true, tuiSha256: sha256(TUI), sidecarSha256: sha256(SIDECAR) }, ...r }, null, 2) + "\n");
    fs.writeFileSync(
      path.join(EVIDENCE, "nexus_maturity_tui_2026-10-11.manifest.json"),
      JSON.stringify({ run: runId, files: Object.fromEntries([plan.cast, plan.transcript, metricsFile].map((f) => [path.basename(f), sha256(f)])) }, null, 2) + "\n",
    );
    assert.ok(r.recording.monotonic, "recording timestamps never go backwards");
    const commands = lines(plan.env.NEXUS_RECORD_COMMANDS);
    const events = lines(plan.env.NEXUS_RECORD_EVENTS);

    // 1. Slow inference: several spinner frames while no model output arrived; phase and elapsed time shown.
    assert.ok(r.slow_inference.spinner_frames_seen.length >= 5, JSON.stringify(r.slow_inference));
    assert.ok(r.slow_inference.thinking_shown && r.slow_inference.elapsed_shown, JSON.stringify(r.slow_inference));
    assert.ok(r.slow_inference.busy_cpu_fraction < 0.25, `animating CPU ${r.slow_inference.busy_cpu_fraction}`);

    // 2. Steering while busy: one steer command, queued then applied, seen by the model exactly once.
    const steers = commands.filter((c) => c.type === "steer");
    assert.equal(steers.length, 1);
    assert.equal(steers[0].text, "keep line 1 unchanged");
    assert.deepEqual(events.filter((e) => e.type === "steer.ack").map((e) => e.status), ["queued", "applied"]);
    assert.equal(commands.filter((c) => c.type === "prompt.submit").length, 4, "steering never became a second prompt");
    const second = (gw.requests[1] as any).messages.filter((m: any) => m.role === "user" && String(m.content).includes("keep line 1 unchanged"));
    assert.equal(second.length, 1);
    assert.ok(r.slow_inference.steering_echoed && r.long_turn.steering_applied_shown, JSON.stringify(r));

    // 3. Edits: one diff for the successful edit (the failed one has none); continuation past 30 steps.
    const diffs = events.filter((e) => e.type === "file.diff");
    assert.equal(diffs.filter((d) => d.path === "notes.txt").length, 1);
    assert.ok(r.long_turn.diff_shown && r.long_turn.diff_lines_shown && r.long_turn.failed_edit_marked, JSON.stringify(r.long_turn));
    const first = events.find((e) => e.type === "turn.result");
    assert.equal(first.turn.execution, "COMPLETED", JSON.stringify(first.turn));
    assert.equal(first.turn.steps.used, 35);
    assert.equal(first.turn.continuation.segments, 2);
    assert.ok(r.long_turn.segment_2_shown);
    assert.ok(events.some((e) => e.type === "activity" && e.segment === 2));

    // 4. Idle: no redraws, negligible CPU.
    assert.equal(r.idle.bytes_written, 0, "no redraw while idle");
    assert.ok(r.idle.cpu_fraction < 0.05, `idle CPU ${r.idle.cpu_fraction}`);

    // 5. Resize redraws and survives.
    assert.ok(r.resize.alive && r.resize.redraw_bytes.every((b: number) => b > 0), JSON.stringify(r.resize));
    assert.deepEqual(r.resize.hint_visible_after_each, [true, true], JSON.stringify(r.resize));
    assert.ok(r.resize_busy, "the activity line survives a resize while busy");

    // 6. Paste: compact label; exact text submitted; "/exit" inside did not quit.
    assert.ok(r.paste.label_shown && r.paste.alive_after, JSON.stringify(r.paste));
    const pasted = commands.filter((c) => c.type === "prompt.submit")[1];
    assert.equal(pasted.text, "first line\n/exit\n  indented ünïcødé");

    // 7. Cancellation: Esc sent cancel; the turn was interrupted; the indicator stopped (no output after settling).
    assert.ok(commands.some((c) => c.type === "cancel"));
    assert.equal(events.filter((e) => e.type === "turn.result")[2].turn.execution, "INTERRUPTED");
    assert.equal(r.cancel.bytes_after_settle, 0);
    assert.ok(r.cancel.idle_hint_back, "the idle hint replaced the activity line");

    // 8. Clean exits and a resumed session that carries the earlier conversation.
    assert.equal(r.first_exit, 0);
    assert.equal(r.second_exit, 0);
    assert.ok(r.resumed_shown);
    const resumed = gw.requests[gw.requests.length - 1] as any;
    assert.ok(resumed.messages.some((m: any) => m.role === "user" && String(m.content).includes("keep line 1 unchanged")), "the resumed conversation includes the earlier steering");
    assert.ok(fs.statSync(plan.cast).size > 0);
  } finally {
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
