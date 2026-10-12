/**
 * The whole live TUI (`nexus-tui --live` + the real sidecar) through a pseudo-terminal, beyond diffs: startup,
 * streamed Markdown, slow inference, tool success/failure, large command output, an edit, steering, a multi-line
 * paste, an approval with buffered keys, cancellation, compaction, a verification failure, incomplete requirements,
 * scroll preservation, completion, help, detail panels, narrow/short windows and resizing during work, a sidecar
 * crash and restart, and resume. Evidence is kept on an evidence run (NEXUS_E2E_EVIDENCE=1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startGateway, makeRepo, makeHome, Reply, ptyTest } from "./helpers/fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const TUI = path.join(ROOT, "core/target/release/nexus-tui");
const SIDECAR = path.join(ROOT, "cli/dist/sidecar.js");
const RECORDER = path.join(here, "helpers/sidecar_recorder.mjs");
const DRIVER = path.join(here, "helpers/tui_surface_driver.py");
const EVIDENCE = process.env.NEXUS_E2E_EVIDENCE === "1" ? path.join(ROOT, "docs/reviews/evidence/tui_surface") : fs.mkdtempSync(path.join(os.tmpdir(), "nexus-surface-evidence-"));
const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export const MARKDOWN = [
  "## Cache layer plan\n\n",
  "The cache sits **between** the loader and the store, so reads stay fast while writes remain ",
  "authoritative. It keeps the existing `Loader` interface.\n\n",
  "### Steps\n\n",
  "1. Add `src/cache.ts` with an LRU map.\n",
  "2. Route `load()` through it.\n",
  "3. Invalidate on write.\n\n",
  "- Reads: O(1)\n- Writes: unchanged\n  - nested detail\n\n",
  "```ts\nexport class Cache<K, V> {\n\tprivate map = new Map<K, V>();\n\tget(key: K): V | undefined {\n\t\treturn this.map.get(key); // a long trailing comment that runs well past the width of a narrow terminal window\n\t}\n}\n```\n\n",
  "| Option | Default | Note |\n|---|---|---|\n| size | 512 | entries |\n| ttl | 60 s | per entry |\n\n",
  "Emoji and marks: ✅ café naïve 字符 — done.",
];

/** The prompt of the current turn: the newest user message that is one of the scenario's prompts. */
function currentPrompt(body: any): { key: string; toolsSince: number } {
  const messages: any[] = body?.messages ?? [];
  const keys = ["Explain the plan", "Inspect the repository", "line one of the note", "Write the config file", "Take a long time", "Fix the parser bug", "Do these", "Stream another answer"];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    if (m.role !== "user") continue;
    const key = keys.find((k) => text.includes(k));
    if (key) return { key, toolsSince: messages.slice(i).filter((x) => x.role === "tool").length };
  }
  return { key: "", toolsSince: 0 };
}

function script(_n: number, body: any): Reply {
  const { key, toolsSince } = currentPrompt(body);
  const tools = (name: string, args: unknown, delayMs = 300): Reply => ({ kind: "tools", calls: [{ name, args }], delayMs });
  switch (key) {
    case "Explain the plan":
    case "Stream another answer":
      return { kind: "text", content: MARKDOWN.join(""), chunks: MARKDOWN, gapMs: 180 };
    case "Inspect the repository":
      return [
        tools("read_file", { path: "README.md" }, 2500),
        tools("read_file", { path: "missing.txt" }),
        tools("run_command", { command: "seq 1 120; printf 'esc:\\033]52;c;SGk=\\007 end\\n'" }),
        tools("write_file", { path: "src/cache.ts", content: "export class Cache<K, V> {\n\tprivate map = new Map<K, V>();\n}\n" }),
        { kind: "text", content: "Added `src/cache.ts`. The read of `missing.txt` failed because the file does not exist." } as Reply,
      ][Math.min(toolsSince, 4)];
    case "line one of the note":
      return { kind: "text", content: "Noted the three lines." };
    case "Write the config file":
      return toolsSince === 0 ? tools("write_file", { path: "config.json", content: '{ "cache": true }\n' }) : { kind: "text", content: "Config written." };
    case "Take a long time":
      return { kind: "text", content: "too late", delayMs: 8000 };
    case "Fix the parser bug":
      // Finishing through task_completed runs the workspace verifier, which fails once parser.js exists.
      if (toolsSince === 0) return tools("write_file", { path: "parser.js", content: "module.exports = (s) => s.trim();\n" });
      if (toolsSince === 1) return tools("task_completed", { summary: "Fixed the parser." });
      return { kind: "text", content: "The parser test still fails; it needs a tokenizer change I have not made." };
    case "Do these":
      return { kind: "text", content: "Both items are handled." };
    default:
      return { kind: "text", content: "Yes." };
  }
}

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const squeeze = (text: string) => text.replace(/\s/g, "");
const shows = (screen: string[], text: string) => screen.some((line) => squeeze(line).includes(squeeze(text)));

ptyTest("the whole live TUI through a pseudo-terminal", { timeout: 420_000 }, async () => {
  for (const p of [TUI, SIDECAR]) assert.ok(fs.existsSync(p), `missing ${p} (run make build)`);
  const repo = makeRepo({
    "README.md": "# Demo\n\nA small repository.\n",
    // The verifier the agent discovers: fails only once parser.js exists, so earlier edits verify.
    "package.json": JSON.stringify({ name: "demo", version: "1.0.0", scripts: { test: "node -e \"if (require('fs').existsSync('parser.js')) { console.error('parser test failed: expected 3 tokens, got 2'); process.exit(1) }\"" } }, null, 2) + "\n",
  });
  const gw = await startGateway(script);
  const home = makeHome();
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tui-surface-"));
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const plan = {
    tui: TUI,
    recorder: RECORDER,
    node: process.execPath,
    sidecar_args: ["-w", repo, "-e", gw.url, "-m", "m"],
    cast: path.join(EVIDENCE, "tui_surface.cast"),
    screens: path.join(EVIDENCE, "tui_surface_screens.json"),
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
      const child = spawn("python3", [DRIVER, planFile], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (c) => resolve({ code: c, out, err }));
    });
    assert.equal(code, 0, `driver failed:\n${err}\n${out.slice(-3000)}`);
    const r = JSON.parse(out.trim().split("\n").pop()!);
    const events = lines(plan.env.NEXUS_RECORD_EVENTS);
    const commands = lines(plan.env.NEXUS_RECORD_COMMANDS);
    let head = "unknown";
    try {
      head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    } catch {}
    const metrics = path.join(EVIDENCE, "tui_surface.metrics.json");
    fs.writeFileSync(metrics, JSON.stringify({ run: { id: randomUUID(), generatedAt: new Date().toISOString(), gitHead: head, tuiSha256: sha256(TUI), sidecarSha256: sha256(SIDECAR) }, ...r }, null, 2) + "\n");
    fs.writeFileSync(path.join(EVIDENCE, "tui_surface.manifest.json"), JSON.stringify({ files: Object.fromEntries([plan.cast, plan.screens, metrics].map((f) => [path.basename(f), sha256(f)])) }, null, 2) + "\n");
    fs.writeFileSync(path.join(EVIDENCE, "events.ndjson"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    fs.writeFileSync(path.join(EVIDENCE, "commands.ndjson"), commands.map((e) => JSON.stringify(e)).join("\n") + "\n");
    assert.ok(r.recording.monotonic, "recording timestamps never go backwards");
    const outcomes = events.filter((e) => e.type === "turn.result").map((e) => [e.turn.execution, e.turn.outcome, e.turn.reason ?? null]);
    assert.ok(outcomes.length >= 8, JSON.stringify(outcomes));
    assert.deepEqual(outcomes.map((o) => o[2]).slice(0, 7), [null, "VERIFICATION_NOT_RUN", "VERIFICATION_NOT_RUN", "VERIFICATION_NOT_RUN", "OPERATOR_INTERRUPT", "REQUIREMENTS_INCOMPLETE", "VERIFIER_FAILED"]);
    if (process.env.NEXUS_SURFACE_AUDIT === "1") return; // audit runs only capture
    // Assertions are added with the acceptance matrix (see docs/reviews/NEXUS_TUI_SURFACE_2026-10-12.md).
    assertSurface(r, events, commands, shows);
  } finally {
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function assertSurface(r: any, events: any[], commands: any[], shows: (screen: string[], text: string) => boolean): void {
  const screens: Record<string, string[]> = r.screens;
  const all = Object.values(screens).flat();
  // Outcomes in words, never raw fields; each outcome kind appears.
  assert.ok(!all.some((l) => l.includes("execution=") || l.includes("TURN ENDED") || l.includes("0 tool call")), "raw outcome fields stay in the receipt");
  for (const title of ["✓ Done", "! Done · not verified", "◌ Cancelled", "× Verification failed", "! Requirements still open"]) {
    assert.ok(all.some((l) => l.includes(title)), `outcome ${title} shown`);
  }
  // Markdown rendered, no markers left.
  const md = screens["03-markdown-final"];
  for (const marker of ["**", "```", "## ", "|---"]) assert.ok(!md.some((l) => l.includes(marker)), `markdown marker ${marker} left`);
  assert.ok(shows(md, "Cache layer plan") && md.some((l) => l.includes("Option │ Default")) && md.some((l) => l.includes("↪")), md.join("\n"));
  // Streaming showed no raw markers either.
  assert.ok(!screens["02-streaming"].some((l) => l.includes("**") || l.includes("## ")), screens["02-streaming"].join("\n"));
  // Tools: bounded command output with an exact count; a failed read stays failed.
  const tools = screens["07-tools-final"];
  assert.ok(tools.some((l) => l.includes("exit 0 · 121 lines")) && tools.some((l) => l.includes("… 115 earlier lines")), tools.join("\n"));
  assert.ok(tools.some((l) => l.includes("esc:") && l.includes("end")), `the output's last line is shown: ${tools.join("\n")}`);
  assert.ok(tools.some((l) => l.includes("× Read missing.txt")), tools.join("\n"));
  assert.equal(r.raw_has_file_escape, false, "the OSC 52 sequence printed by the command never reached the terminal");
  // One activity indicator: the status bar never animates.
  const spinner = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
  for (const [name, rows] of Object.entries(screens)) assert.ok(!spinner.test(rows[0]), `${name}: status bar shows no spinner`);
  assert.ok(spinner.test(screens["04-slow-inference"].at(-2)!) && shows(screens["04-slow-inference"], "thinking"), screens["04-slow-inference"].join("\n"));
  // Scrolling: position kept, new output announced.
  assert.ok(r.scroll_kept, "the reading position is kept while output arrives");
  assert.ok(shows(screens["06-scrolled-back-new-output"], "↓ new output"), screens["06-scrolled-back-new-output"].join("\n"));
  // Steering: one steer command, queued then applied.
  assert.equal(commands.filter((c) => c.type === "steer").length, 1);
  assert.deepEqual(events.filter((e) => e.type === "steer.ack").map((e) => e.status), ["queued", "applied"]);
  // Paste: the sent text is visible under its label.
  assert.ok(shows(screens["07-tools-final"].concat(all), "line one of the note"), "pasted text shown");
  // Approval: target and decisions with focus; buffered keys did not decide.
  const approval = screens["10-approval"];
  assert.ok(shows(approval, "Approval needed") && shows(approval, "Proposed: create config.json") && shows(approval, "y Approve"), approval.join("\n"));
  assert.ok(r.approval_survived_buffered_keys);
  assert.ok(r.letters_disarmed_hint, "keys typed just before the panel disarm its letters, and the panel says so");
  // Requirements: listed once, and the repeated replies are explained.
  const req = screens["14-requirements-incomplete"];
  assert.ok(shows(req, "R1 [open] add a README section") && shows(req, "asked the agent to continue"), req.join("\n"));
  assert.ok(!req.some((l) => l.includes("handled.Both")), "replies are not run together");
  // Verification failure names the command.
  assert.ok(shows(screens["13-verification-failed"], "npm test failed"), screens["13-verification-failed"].join("\n"));
  // Narrow and short windows: nothing wider than the terminal; the composer line is kept.
  for (const [name, width] of [["19-narrow", 60], ["21-resize-during-stream", 64], ["20-short", 80]] as const) {
    assert.ok(screens[name].every((l) => [...l].length <= width), `${name} fits ${width} columns`);
    assert.ok(screens[name].at(-1)!.startsWith("›"), `${name} keeps the composer`);
  }
  assert.equal(r.idle_bytes, 0, "nothing is redrawn while idle");
  // Crash: signal named, chatter dropped, draft kept; restart then /resume restores the conversation.
  const crash = screens["22-crashed"];
  assert.ok(shows(crash, "signal 9 (SIGKILL)") && !shows(crash, "considering the next step") && shows(crash, "a draft before the crash"), crash.join("\n"));
  const restarted = screens["23b-restart-then-resume"];
  assert.ok(shows(restarted, "Resumed session") && shows(restarted, "Emoji and marks"), restarted.join("\n"));
  // Resume in a new TUI: the earlier conversation, without Nexus's own prompts.
  const resumed = screens["24-resumed"];
  assert.ok(shows(resumed, "Resumed session") && shows(resumed, "Emoji and marks") && !shows(resumed, "[Nexus continuation") && !shows(resumed, "[Git Status"), resumed.join("\n"));
  // No duplicated outcome for a turn.
  const results = events.filter((e) => e.type === "turn.result").map((e) => e.turn_id);
  assert.equal(new Set(results).size, results.length, "one result per turn");
}
