/**
 * Diff output in the real active TUI (`nexus-tui --live` + the real sidecar) through a pseudo-terminal. The agent
 * (a mock gateway) makes every kind of edit the transcript must render: mixed additions and deletions in several
 * hunks, a repeated edit, a failed edit, a new file, a deletion, a long path with a long line, tabs and wide
 * characters, a file without a final newline, a large change, and terminal escapes inside file content — against a
 * repository whose file already had an uncommitted operator change. The driver resizes while edits arrive, steers
 * while busy, reviews the complete diffs with a draft in the composer, runs `/diff`, and repeats an edit at lower
 * colour depths. The recording and screens are kept as evidence on an evidence run (NEXUS_E2E_EVIDENCE=1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startGateway, makeRepo, makeHome, Reply, ptyTest } from "./helpers/fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const TUI = path.join(ROOT, "core/target/release/nexus-tui");
const SIDECAR = path.join(ROOT, "cli/dist/sidecar.js");
const RECORDER = path.join(here, "helpers/sidecar_recorder.mjs");
const DRIVER = path.join(here, "helpers/tui_diff_driver.py");
const EVIDENCE = process.env.NEXUS_E2E_EVIDENCE === "1" ? path.join(ROOT, "docs/reviews/evidence/tui_diff") : fs.mkdtempSync(path.join(os.tmpdir(), "nexus-diff-evidence-"));
const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const LONG_PATH = "a/very/long/path/to/some/deeply/nested/module/configuration_loader.rs";
const OPERATOR_LINE = "// Operator note: reviewed by hand before the agent ran.";
const FILLER = Array.from({ length: 24 }, (_, i) => `export const LIMIT_${i} = ${i * 10};`).join("\n");
const APP = `import { readFile } from "node:fs/promises";

// Configuration loader — handles ✓ unicode, tabs and blank lines.
export interface Config {
\tname: string;
\tretries: number;
}

export async function load(path: string): Promise<Config> {
\tconst text = await readFile(path, "utf8");
\tconst raw = JSON.parse(text);
\treturn { name: raw.name ?? "default", retries: raw.retries ?? 3 };
}

${FILLER}

export function describe(config: Config): string {
\treturn \`\${config.name} (\${config.retries} retries)\`;
}
`;
const LONG_FILE = `pub struct Loader {
    pub name: String,
}

pub fn banner() -> &'static str {
    "short"
}
`;
const BIG = Array.from({ length: 120 }, (_, i) => `entry ${i}: value`).join("\n") + "\n";

function script(repo: string) {
  const read = (p: string) => fs.readFileSync(path.join(repo, p), "utf8");
  return (n: number): Reply => {
    const pace = { delayMs: 700 };
    switch (n) {
      case 1: {
        const next = read("src/app.ts")
          .replace("\tretries: number;\n}", "\tretries: number;\n\ttimeoutMs: number;\n}")
          .replace('retries: raw.retries ?? 3 };', "retries: raw.retries ?? 3, timeoutMs: raw.timeoutMs ?? 5000 };")
          .replace("\treturn `${config.name} (${config.retries} retries)`;", "\tconst tries = config.retries === 1 ? \"retry\" : \"retries\";\n\treturn `${config.name} (${config.retries} ${tries}, ${config.timeoutMs} ms)`;");
        return { kind: "tools", calls: [{ name: "write_file", args: { path: "src/app.ts", content: next, overwrite: true } }], ...pace };
      }
      case 2:
        return { kind: "tools", calls: [{ name: "edit_file", args: { path: "src/app.ts", old_content: "\tconst raw = JSON.parse(text);\n", new_content: "\tconst raw = JSON.parse(text) as Partial<Config>;\n" } }], ...pace };
      case 3:
        return { kind: "tools", calls: [{ name: "edit_file", args: { path: "src/app.ts", old_content: "this text is not in the file", new_content: "x" } }], ...pace };
      case 4:
        return { kind: "tools", calls: [{ name: "write_file", args: { path: "src/new_module.py", content: 'def greet(name: str) -> str:\n    """Say hello."""\n    return f"hello {name}"\n' } }], ...pace };
      case 5:
        return { kind: "tools", calls: [{ name: "delete_file", args: { path: "legacy.txt" } }], ...pace };
      case 6: {
        const next = read(LONG_PATH).replace('    "short"', `    "${"long banner text ".repeat(9)}— 設定ローダー ✓\tEND_OF_LONG_LINE"`);
        return { kind: "tools", calls: [{ name: "write_file", args: { path: LONG_PATH, content: next, overwrite: true } }], ...pace };
      }
      case 7:
        return { kind: "tools", calls: [{ name: "write_file", args: { path: "nofinal.txt", content: "alpha\nbeta\ngamma", overwrite: true } }], ...pace };
      case 8:
        return { kind: "tools", calls: [{ name: "write_file", args: { path: "big.txt", content: BIG.replace(/value/g, "updated value"), overwrite: true } }], ...pace };
      case 9:
        return { kind: "tools", calls: [{ name: "write_file", args: { path: "esc.txt", content: "title\n\u001b]52;c;SGVsbG8=\u0007copied\u001b[2J\r\nend\n" } }], ...pace };
      case 10:
        return { kind: "text", content: "All review fixes are applied." };
      default:
        if (n % 2 === 1) {
          const small = read("small.txt");
          const next = small.includes("blue") ? small.replace("blue", "green") : small.replace("green", "blue");
          return { kind: "tools", calls: [{ name: "write_file", args: { path: "small.txt", content: next, overwrite: true } }] };
        }
        return { kind: "text", content: "Done." };
    }
  };
}

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const squeeze = (text: string) => text.replace(/\s/g, "");
const shows = (screen: string[], text: string) => screen.some((line) => squeeze(line).includes(squeeze(text)));

ptyTest("diff output in the real TUI: every edit kind, resizing, review, workspace diff and colour depths", { timeout: 300_000 }, async () => {
  for (const p of [TUI, SIDECAR]) assert.ok(fs.existsSync(p), `missing ${p} (run make build)`);
  const repo = makeRepo({ "legacy.txt": "old one\nold two\nold three\n", "nofinal.txt": "alpha\nbeta", "big.txt": BIG, "small.txt": "colour: blue\n" });
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src/app.ts"), APP);
  fs.mkdirSync(path.join(repo, path.dirname(LONG_PATH)), { recursive: true });
  fs.writeFileSync(path.join(repo, LONG_PATH), LONG_FILE);
  execSync("git add -A && git commit -qm fixtures", { cwd: repo, stdio: "ignore" });
  // An uncommitted operator change made before the agent runs: it must never be shown as the agent's change.
  fs.writeFileSync(path.join(repo, "src/app.ts"), APP.replace("export const LIMIT_12 = 120;", `export const LIMIT_12 = 120;\n${OPERATOR_LINE}`));
  const gw = await startGateway(script(repo));
  const home = makeHome();
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tui-diff-"));
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const plan = {
    tui: TUI,
    recorder: RECORDER,
    node: process.execPath,
    sidecar_args: ["-w", repo, "-e", gw.url, "-m", "m"],
    cast: path.join(EVIDENCE, "tui_diff.cast"),
    screens: path.join(EVIDENCE, "tui_diff_screens.json"),
    env: {
      HOME: home,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      NEXUS_DEBUG: "0",
      NEXUS_RECORD_SIDECAR: SIDECAR,
      NEXUS_RECORD_COMMANDS: path.join(logs, "commands.ndjson"),
      NEXUS_RECORD_EVENTS: path.join(logs, "events.ndjson"),
    },
    depth_sessions: [
      ["256", { TERM: "xterm-256color" }],
      ["16", { NEXUS_COLOR: "16" }],
      ["mono", { NO_COLOR: "1" }],
    ],
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
    const metrics = path.join(EVIDENCE, "tui_diff.metrics.json");
    let head = "unknown";
    try {
      head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    } catch {}
    const summary = { ...r, scrollback_pages: undefined, depths: Object.fromEntries(Object.entries(r.depths).map(([k, v]: [string, any]) => [k, v.lines])) };
    fs.writeFileSync(metrics, JSON.stringify({ run: { id: randomUUID(), generatedAt: new Date().toISOString(), gitHead: head, tuiSha256: sha256(TUI), sidecarSha256: sha256(SIDECAR) }, ...summary }, null, 2) + "\n");
    fs.writeFileSync(path.join(EVIDENCE, "tui_diff.manifest.json"), JSON.stringify({ files: Object.fromEntries([plan.cast, plan.screens, metrics].map((f) => [path.basename(f), sha256(f)])) }, null, 2) + "\n");

    assert.ok(r.recording.monotonic, "recording timestamps never go backwards");
    // The main session's edits (the colour-depth sessions each edit small.txt afterwards).
    const diffs = events.filter((e) => e.type === "file.diff" && e.path !== "small.txt");
    assert.equal(events.filter((e) => e.type === "file.diff" && e.path === "small.txt").length, 3);
    // 1. Each successful edit produced exactly one diff; the failed edit produced none and is shown as failed.
    assert.deepEqual(diffs.map((d) => d.path), ["src/app.ts", "src/app.ts", "src/new_module.py", "legacy.txt", LONG_PATH, "nofinal.txt", "big.txt", "esc.txt"]);
    assert.deepEqual(diffs.map((d) => d.kind), ["modified", "modified", "added", "deleted", "modified", "modified", "modified", "added"]);
    const ends = events.filter((e) => e.type === "tool.end" && ["edit_file", "write_file", "delete_file"].includes(e.tool));
    assert.equal(ends.filter((e) => !e.success).length, 1);
    const failedCall = ends.find((e) => !e.success).call_id;
    assert.ok(!diffs.some((d) => d.call_id === failedCall), "no diff for the failed edit");
    // 2. The operator's earlier change is never presented as the agent's.
    for (const d of diffs) assert.ok(!/^[-+].*Operator note/m.test(d.preview), `operator change attributed in ${d.path}`);
    assert.equal(diffs[0].hunks, 2, "two separated changes are two hunks");
    // 3. The transcript at the end of the turn (seen by scrolling back): one card per diff, never duplicated.
    const pages: string[][] = [r.main_screens["03-turn-complete-wide"], ...r.scrollback_pages];
    const seen = new Set(pages.flat().filter((l) => /^\s+[✓•] (Edited|Created|Deleted) /.test(l)).map((l) => l.trim()));
    const verbs: Record<string, string> = { added: "Created", modified: "Edited", deleted: "Deleted" };
    for (const d of diffs) {
      const label = `${path.basename(d.path)}  +${d.added} −${d.removed}`;
      const matching = [...seen].filter((l) => l.includes(`${verbs[d.kind]} `) && l.endsWith(label));
      assert.ok(matching.length >= 1, `missing card for ${d.path} (${label}): ${[...seen].join(" | ")}`);
    }
    // Two edits of src/app.ts are two cards; nothing else is repeated.
    assert.equal(seen.size, diffs.length, [...seen].join(" | "));
    assert.ok(pages.flat().some((l) => l.includes("× Edit src/app.ts")), "the failed edit is marked failed");
    const big = diffs.find((d) => d.path === "big.txt");
    assert.ok(pages.flat().some((l) => l.includes(`… ${big.diff_lines - 14} more lines`)), `exact omission count for ${big.diff_lines} lines`);
    // 4. Terminal escapes in file content are shown, never executed.
    assert.equal(r.raw_has_file_osc52, false, "the OSC 52 clipboard sequence from the file never reached the terminal");
    assert.ok(r.screen_shows_file_escapes, "the escape sequence is visible as text");
    // 5. Narrow layout during editing; the turn kept running through resizes; idle draws nothing.
    assert.ok(r.narrow_rows_within_width && r.busy_after_resize, JSON.stringify({ narrow: r.narrow_rows_within_width, busy: r.busy_after_resize }));
    assert.equal(r.idle_bytes, 0, "no redraw while idle");
    assert.ok(shows(r.main_screens["02-narrow-during-editing"], "Edited"), "cards render at 72 columns");
    // Steering while diffs arrived: sent once, applied.
    assert.equal(commands.filter((c) => c.type === "steer").length, 1);
    assert.deepEqual(events.filter((e) => e.type === "steer.ack").map((e) => e.status), ["queued", "applied"]);
    // 6. Review: newest edit opened, navigation reached the multi-hunk edit, next hunk, pan and wrap, return intact.
    assert.ok(shows(r.review_newest, "Edit diff · this operation only") && shows(r.review_newest, "esc.txt"), r.review_newest.join("\n"));
    assert.ok(shows(r.review_first_edit, "edit 1 of 8") && shows(r.review_first_edit, "@@ −4,12 +4,13 @@"), r.review_first_edit.join("\n"));
    assert.ok(shows(r.review_after_n, "unchanged lines · @@"), r.review_after_n.join("\n"));
    assert.ok(r.review_long_clipped.some((l: string) => l.includes("›")), "clipped long line is marked");
    assert.ok(r.review_long_panned.some((l: string) => l.includes("‹")), "panned long line is marked");
    assert.ok(shows(r.review_long_wrapped, "END_OF_LONG_LINE"), "wrapping shows the whole long line");
    assert.deepEqual(r.after_review, { draft_kept: true, transcript_restored: true, panel_closed: true });
    // 7. The cumulative workspace diff is labelled as such and includes the operator's change.
    assert.ok(shows(r.workspace_transcript, "Workspace diff (git diff: unstaged changes to tracked files)"), r.workspace_transcript.join("\n"));
    assert.ok(shows(r.workspace_review, "includes changes not made in this session"), r.workspace_review.join("\n"));
    // 8. Lower colour depths: markers everywhere; no 24-bit colour at 256/16; no colour at all in monochrome.
    for (const [name, depth] of Object.entries(r.depths) as Array<[string, { lines: string[]; cells: any[][] }]>) {
      assert.ok(shows(depth.lines, "Edited small.txt  +1 −1"), `${name}: ${depth.lines.join("\n")}`);
      assert.ok(depth.lines.some((l) => /[+−] colour: /.test(l)), `${name}: markers present`);
      const colours = depth.cells.flat().flatMap((c) => [c[1], c[2]]).filter(Boolean);
      assert.ok(!colours.some((c) => c[0] === "rgb"), `${name}: no 24-bit colour`);
      if (name === "mono") assert.equal(colours.length, 0, "monochrome sends no colour");
      // crossterm writes the 16 standard colours as palette entries 0–15 (`38;5;n`): only those may appear.
      if (name === "16") assert.ok(colours.every((c) => c[0] === "idx" && c[1] < 16), `16 colours: only entries 0–15 (${JSON.stringify(colours.find((c) => !(c[0] === "idx" && c[1] < 16)))})`);
      const diffRows = depth.cells.filter((row) => row.some((c) => c[0] === "▎"));
      assert.ok(diffRows.length >= 2, `${name}: diff rows found`);
      if (name === "16" || name === "mono") assert.ok(!diffRows.flat().some((c) => c[2]), `${name}: diff rows have no backgrounds`);
      if (name === "256") assert.ok(diffRows.flat().some((c) => c[2] && c[2][0] === "idx" && [22, 52].includes(c[2][1])), "256 colours: tinted diff rows");
    }
  } finally {
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
