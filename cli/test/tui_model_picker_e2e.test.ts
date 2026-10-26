/**
 * Real-binary journey through the live TUI: /model opens the picker, ctrl+p connects Anthropic with a pasted key
 * (verified by the provider, never drawn on screen), the picker returns with Anthropic's models, enter switches the
 * session, and the next prompt is answered by Anthropic with its own key.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startGateway, makeRepo, makeHome, waitUntil, ptyTest } from "./helpers/fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TUI = path.resolve(here, "../../core/target/release/nexus-tui");
const SIDECAR = path.resolve(here, "../dist/sidecar.js");
const RECORDER = path.resolve(here, "helpers/sidecar_recorder.mjs");
const KEY = "sk-ant-E2E-PASTED-0001";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const stripCsi = (s: string) => s.replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]/g, "");
const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

async function anthropicMock(): Promise<{ url: string; seen: Array<{ path: string; key?: string }>; close(): Promise<void> }> {
  const seen: Array<{ path: string; key?: string }> = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const key = req.headers["x-api-key"] as string | undefined;
      seen.push({ path: req.url!, key });
      if (key !== KEY) {
        res.writeHead(401, { "Content-Type": "application/json" }).end('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
        return;
      }
      if (req.url!.includes("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: [{ id: "claude-e2e" }] }));
        return;
      }
      const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
      res.writeHead(200, { "Content-Type": "text/event-stream" }).end(
        ev({ type: "message_start", message: { id: "msg", usage: { input_tokens: 5 } } }) +
          ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
          ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from Claude." } }) +
          ev({ type: "content_block_stop", index: 0 }) +
          ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }) +
          ev({ type: "message_stop" }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

ptyTest("/model → ctrl+p → paste a key → pick the provider's model → the next prompt goes to that provider", { timeout: 120_000 }, async () => {
  const missing = [TUI, SIDECAR].filter((p) => !fs.existsSync(p));
  if (spawnSync("script", ["--version"]).status !== 0) missing.push("script (util-linux)");
  assert.deepEqual(missing, [], `missing prerequisites (run \`make build\`): ${missing.join(", ")}`);

  const gw = await startGateway(() => ({ kind: "text", content: "Local answer." }));
  const anth = await anthropicMock();
  const repo = makeRepo();
  const home = makeHome();
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-record-"));
  const commandsLog = path.join(logs, "commands.ndjson");
  const eventsLog = path.join(logs, "events.ndjson");
  let child: ChildProcess | undefined;
  let pty = "";
  const diag = () => `\n--- commands ---\n${read(commandsLog).replaceAll(KEY, "<key>")}\n--- events ---\n${read(eventsLog)}\n--- screen ---\n${stripCsi(pty).slice(-3000)}`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NEXUS_PROVIDER"]) delete env[k];
  try {
    const cmd = `stty rows 40 cols 120; exec ${quote(TUI)} --live --sidecar ${quote(RECORDER)} --node ${quote(process.execPath)} -- -w ${quote(repo)} -e ${quote(gw.url)} -m m`;
    const proc = spawn("script", ["-qfec", cmd, "/dev/null"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...env,
        HOME: home,
        NEXUS_DEBUG: "0",
        NEXUS_NO_BROWSER: "1",
        NEXUS_ANTHROPIC_BASE_URL: `${anth.url}/v1`,
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
      const queries = pty.split("\x1b[c").length - 1;
      for (; answered < queries; answered++) proc.stdin!.write("\x1b[?62c");
    });
    proc.stderr!.on("data", () => {});
    const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)));
    const send = async (bytes: string) => {
      proc.stdin!.write(bytes);
      await sleep(200);
    };
    const events = () => read(eventsLog).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const screenSince = (mark: number) => stripCsi(pty.slice(mark));

    await waitUntil(() => read(eventsLog).includes('"type":"session.state"') && stripCsi(pty).includes("newline"), 20_000).catch(() => {
      throw new Error(`the live TUI never became ready${diag()}`);
    });
    await sleep(300);

    // 1. /model opens the picker with the appliance and a connect row for Anthropic.
    let mark = pty.length;
    await send("/model");
    await send("\r");
    await waitUntil(() => read(eventsLog).includes('"type":"models.catalog"'), 20_000).catch(() => { throw new Error(`no catalog${diag()}`); });
    await sleep(400);
    assert.ok(screenSince(mark).includes("Select model"), diag());
    assert.ok(screenSince(mark).replace(/\s+/g, "").includes("ConnectAnthropic"), diag());

    // 2. ctrl+p: the connect panel; the appliance setup row precedes OpenRouter, OpenAI, and Anthropic.
    mark = pty.length;
    await send("\x10");
    assert.ok(screenSince(mark).includes("Connect a provider"), diag());
    await send("\x1b[B");
    await send("\x1b[B");
    await send("\x1b[B");
    await send("\r");
    await send(`\x1b[200~${KEY}\x1b[201~`);
    await send("\r");
    await waitUntil(() => events().some((e) => e.type === "provider.result"), 20_000).catch(() => { throw new Error(`no provider.result${diag()}`); });
    const result = events().find((e) => e.type === "provider.result");
    assert.equal(result.success, true, diag());

    // 3. The picker returns showing Anthropic's models; enter switches the session.
    await waitUntil(() => events().filter((e) => e.type === "models.catalog").length >= 2, 20_000).catch(() => { throw new Error(`picker did not reopen${diag()}`); });
    await sleep(400);
    await send("\r");
    await waitUntil(() => events().some((e) => e.type === "model.result"), 20_000).catch(() => { throw new Error(`no model.result${diag()}`); });
    assert.equal(events().find((e) => e.type === "model.result").success, true, diag());
    await waitUntil(() => events().some((e) => e.type === "session.state" && e.model === "anthropic · claude-e2e"), 5_000).catch(() => { throw new Error(`session did not switch${diag()}`); });

    // 4. The next prompt is answered by Anthropic with its own key.
    await send("hello");
    await send("\r");
    await waitUntil(() => read(eventsLog).includes('"type":"turn.result"'), 30_000).catch(() => { throw new Error(`no turn.result${diag()}`); });
    const messages = anth.seen.filter((s) => s.path.startsWith("/v1/messages"));
    assert.equal(messages.length, 1, diag());
    assert.equal(messages[0].key, KEY);
    assert.equal(gw.requests.length, 0, "the appliance received no chat request after the switch");
    await sleep(400);
    assert.ok(stripCsi(pty).replace(/\s+/g, "").includes("HellofromClaude."), diag());

    // 5. The key is never drawn, never in sidecar output, and saved owner-only.
    assert.ok(!pty.includes(KEY), "the key appeared on screen");
    assert.ok(!read(eventsLog).includes(KEY), "the key appeared in sidecar events");
    const stored = path.join(home, ".config/nexus/credentials.json");
    assert.equal(fs.statSync(stored).mode & 0o777, 0o600);

    proc.stdin!.write("\x03");
    const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 20_000).unref())]);
    assert.equal(code, 0, `script did not exit 0 (got ${code})${diag()}`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const gone = new Promise((resolve) => child!.once("exit", resolve));
      child.stdin?.write("\x03\x03\x03");
      await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 3000).unref())]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await gw.close();
    await anth.close();
    for (const dir of [repo, home, logs]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
