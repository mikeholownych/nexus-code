import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startGateway, makeRepo, makeHome, waitUntil, ptyTest } from "./helpers/fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TUI = path.resolve(here, "../../core/target/release/nexus-tui");
const SIDECAR = path.resolve(here, "../dist/sidecar.js");
const RECORDER = path.resolve(here, "helpers/sidecar_recorder.mjs");

// The objective as pasted, before the in-composer edits.
const OBJECTIVE_LINES = [
  "Fix the flaky retry logic in the payment webhook handler.",
  "",
  "Context:",
  "The handler in src/webhooks/payment.ts retries failed deliveries, but",
  "retries sometimes fire twice when the upstream returns 502 & then times out.",
  "",
  "Requirements:",
  "  1. Keep the public API unchanged; callers rely on `handle(event, opts)`.",
  "  2. Cap retries at 3, with exponential backoff (250ms, 500ms, 1s).",
  "     - Jitter must stay within +/-10%.",
  "     - Do not retry 4xx responses, except 429.",
  '  3. Log each attempt as: "attempt=<n> status=<code> delay=<ms>".',
  "",
  "\tTab-indented note: the queue lives in src/queue/index.ts.",
  "",
  "Notes from the incident channel, pasted verbatim:",
  "/exit",
  "> that line above was someone trying to leave the chat, ignore it.",
  "    // keep this code-looking comment exactly as written",
  "",
  "Acceptance: all tests in test/webhooks pass; no new dependencies.",
  "Deadline: Friday?! Questions -> ask in #payments. Owner: TBD",
];

const EXPECTED = `Fix the flaky retry logic in the payment webhook handler.

Context:
The handler in src/webhooks/payment.ts retries failed deliveries, but
retries sometimes fire twice when the upstream returns 502 & then times out.

Requirements:
  1. Keep the public API unchanged; callers rely on \`handle(event, opts)\`.
  2. Cap retries at 3, with exponential backoff (250ms, 500ms, 1s).
     - Jitter must stay within +/-10%.
     - Do not retry 4xx responses, except 429.
  3. Log each attempt as: "attempt=<n> status=<code> delay=<ms>".

\tTab-indented note: the queue lives in src/queue/index.ts.

Notes from the incident channel, pasted verbatim:
/exit
> that line above was someone trying to leave the chat, ignore it.
    // keep this code-looking comment exactly as written

Acceptance: all tests in test/webhooks pass; no new dependencies. Run the suite twice.
Deadline: Friday?! Questions -> ask in #payments. Owner: mike`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const stripCsi = (s: string) => s.replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]/g, "");
const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

/** The bracketed paste: CRLF line breaks, one lone CR, no trailing break. */
function pasteBytes(): string {
  const loneCr = OBJECTIVE_LINES.findIndex((l) => l.startsWith("> that line above"));
  let body = "";
  OBJECTIVE_LINES.forEach((line, i) => {
    body += line;
    if (i < OBJECTIVE_LINES.length - 1) body += i === loneCr ? "\r" : "\r\n";
  });
  return `\x1b[200~${body}\x1b[201~`;
}

ptyTest("a pasted multiline objective reaches the agent intact as exactly one prompt", { timeout: 120_000 }, async () => {
  const missing = [TUI, SIDECAR].filter((p) => !fs.existsSync(p));
  if (spawnSync("script", ["--version"]).status !== 0) missing.push("script (util-linux)");
  assert.deepEqual(missing, [], `missing prerequisites (run \`make build\`): ${missing.join(", ")}`);

  const gw = await startGateway(() => ({ kind: "text", content: "Noted." }));
  const repo = makeRepo();
  const home = makeHome();
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-record-"));
  const commandsLog = path.join(logs, "commands.ndjson");
  const eventsLog = path.join(logs, "events.ndjson");
  let child: ChildProcess | undefined;
  let pty = "";
  const diag = () =>
    `\n--- commands log ---\n${read(commandsLog)}\n--- events log ---\n${read(eventsLog)}\n--- screen (CSI stripped, tail) ---\n${stripCsi(pty).slice(-3000)}`;
  try {
    const cmd = `stty rows 40 cols 120; exec ${quote(TUI)} --live --sidecar ${quote(RECORDER)} --node ${quote(process.execPath)} -- -w ${quote(repo)} -e ${quote(gw.url)} -m m`;
    const proc = spawn("script", ["-qfec", cmd, "/dev/null"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: home,
        NEXUS_DEBUG: "0",
        NEXUS_RECORD_SIDECAR: SIDECAR,
        NEXUS_RECORD_COMMANDS: commandsLog,
        NEXUS_RECORD_EVENTS: eventsLog,
      },
    });
    child = proc;
    let answered = 0;
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      pty += chunk;
      // A terminal without the kitty keyboard protocol answers the device-attributes query only.
      const queries = pty.split("\x1b[c").length - 1;
      for (; answered < queries; answered++) proc.stdin!.write("\x1b[?62c");
    });
    proc.stderr!.on("data", () => {});
    const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)));
    const send = async (bytes: string) => {
      proc.stdin!.write(bytes);
      await sleep(150);
    };
    const commandLines = () => read(commandsLog).split("\n").slice(0, -1);
    const events = () => read(eventsLog).split("\n").filter(Boolean).map((l) => JSON.parse(l));

    await waitUntil(() => read(eventsLog).includes('"type":"session.state"') && stripCsi(pty).includes("newline"), 20_000).catch(() => {
      throw new Error(`the live TUI never became ready${diag()}`);
    });
    await sleep(300);

    await send(pasteBytes());
    // A multi-line paste is one buffer ([Pasted text #1: 22 lines]); ctrl+x turns it back into editable draft text.
    // The terminal is redrawn by changed cells only, so spaces may be cursor moves in the raw stream.
    assert.ok(stripCsi(pty).replace(/\s/g, "").includes("[Pastedtext#1:22lines]"), `no paste buffer label${diag()}`);
    await send("\x18");
    await send("\x7f");
    await send("\x7f");
    await send("\x7f");
    await send("mike");
    await send("\x1b[A");
    await send("\x1b[F");
    await send(" Run the suite twice.");
    await send("\r");

    // 1. Exactly one prompt.submit, byte-exact.
    await waitUntil(() => read(eventsLog).includes('"type":"turn.result"'), 30_000).catch(() => {
      throw new Error(`no turn.result within 30 s${diag()}`);
    });
    const commands = read(commandsLog);
    assert.ok(commands.endsWith("\n"), `commands log is not newline-terminated${diag()}`);
    assert.equal(commandLines().length, 1, `expected exactly one command${diag()}`);
    const submitLine = commandLines()[0];
    const submit = JSON.parse(submitLine);
    assert.deepEqual(Object.keys(submit).sort(), ["id", "text", "type", "v"]);
    assert.equal(submit.v, 1);
    assert.equal(submit.type, "prompt.submit");
    assert.equal(typeof submit.id, "string");
    assert.equal(submit.text, EXPECTED);
    assert.ok(!submit.text.includes("\r"));

    // 2. The literal itself.
    const lines = EXPECTED.split("\n");
    assert.equal(lines.length, 22);
    assert.equal(lines.filter((l) => l === "").length, 5);
    for (const part of ["\n/exit\n", "\n\tTab-indented", "\n    // keep", "\n     - Jitter"]) {
      assert.ok(EXPECTED.includes(part), `EXPECTED lacks ${JSON.stringify(part)}`);
    }

    // 3. One completed turn, no protocol error.
    const results = events().filter((e) => e.type === "turn.result");
    assert.equal(results.length, 1, diag());
    assert.equal(events().filter((e) => e.type === "error").length, 0, diag());
    assert.equal(results[0].turn.execution, "COMPLETED", diag());

    // 4. The agent sent it to the model unchanged, followed only by the runtime context.
    const first = gw.requests[0] as { messages: Array<{ role: string; content: unknown }> };
    const user = first.messages.find((m) => m.role === "user");
    assert.ok(user && typeof user.content === "string", "first request has no string user message");
    const content = user.content as string;
    assert.ok(content.startsWith(EXPECTED + "\n"), `user message does not start with the objective:\n${content}`);
    assert.match(content.slice(EXPECTED.length + 1), /^\n\[Git Status: [^\]\n]+ \(\d+ uncommitted dirty files\)\]$/);

    // 5. "/exit" was data, not a command.
    await sleep(1000);
    assert.equal(proc.exitCode, null, `the TUI exited after the turn${diag()}`);
    assert.equal(proc.signalCode, null);
    assert.equal(commandLines().length, 1, diag());

    // 6. Ctrl-C on an idle, empty composer quits through a graceful shutdown.
    proc.stdin!.write("\x03");
    const deadline = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 20_000).unref());
    const code = await Promise.race([exited, deadline]);
    assert.equal(code, 0, `script did not exit 0 within 20 s (got ${code})${diag()}`);
    const after = commandLines();
    assert.equal(after.length, 2, diag());
    assert.equal(after[0], submitLine);
    assert.deepEqual(JSON.parse(after[1]), { v: 1, type: "shutdown" });
    assert.ok(read(commandsLog).endsWith("\n"));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      // Killing `script` first would hang up the TUI's terminal and leave it to the 6 s stop watchdog.
      const gone = new Promise((resolve) => child!.once("exit", resolve));
      child.stdin?.write("\x03\x03\x03");
      await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 3000).unref())]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await gw.close();
    for (const dir of [repo, home, logs]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
