/**
 * WP-1306 / FINDINGS section C "Commander option precedence": an option given on the command line before the
 * subcommand (`nexus -t 0.9 run ...`) must survive the subcommand's own default for the same option, and an
 * option given after the subcommand must still win. Drives the real CLI entry (tsx src/index.ts) against a
 * capturing OpenAI-compatible server and reads the temperature the model request actually carried.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(CLI_DIR, "node_modules", ".bin", "tsx");

/** The operator's own endpoint, model and credential must not stand in for a dropped command-line option. */
function hostNeutralEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(LOCAL_LLM_|LOCAL_HARNESS_|NEXUS_)/.test(key)) delete env[key];
  return env;
}

async function requestTemperature(argsFor: (endpoint: string) => string[]): Promise<{ temperature: unknown; out: string }> {
  const seen: any[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "m" }] }));
      try { seen.push(JSON.parse(body)); } catch { /* not a completion */ }
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-optprec-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-optprec-ws-"));
  try {
    const out = await new Promise<string>((resolve) => {
      const child = spawn(TSX, ["src/index.ts", ...argsFor(endpoint), "-w", ws], {
        cwd: CLI_DIR,
        env: { ...hostNeutralEnv(), HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache") },
      });
      let buf = "";
      child.stdout.on("data", (c) => (buf += c));
      child.stderr.on("data", (c) => (buf += c));
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      child.on("close", () => { clearTimeout(timer); resolve(buf); });
    });
    const completion = seen.find((b) => Array.isArray(b.messages));
    return { temperature: completion?.temperature, out };
  } finally {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test("an option before the subcommand survives the subcommand's default (nexus -t 0.9 run)", async () => {
  const r = await requestTemperature((e) => ["-t", "0.9", "-e", e, "run", "--json", "-m", "m", "hello"]);
  assert.equal(r.temperature, 0.9, r.out);
});

test("a global option survives the subcommand's default when the subcommand sets other options", async () => {
  const r = await requestTemperature((e) => ["-t", "0.9", "run", "--json", "-e", e, "-m", "m", "hello"]);
  assert.equal(r.temperature, 0.9, r.out);
});

test("an option after the subcommand wins over the one before it", async () => {
  const r = await requestTemperature((e) => ["-t", "0.9", "-e", e, "run", "--json", "-m", "m", "-t", "0.4", "hello"]);
  assert.equal(r.temperature, 0.4, r.out);
});

test("an endpoint given before the subcommand is used, and the subcommand default applies when the option is given nowhere", async () => {
  const r = await requestTemperature((e) => ["-e", e, "run", "--json", "-m", "m", "hello"]);
  assert.equal(r.temperature, 0.2, r.out);
});

/** The model asks to write a file on its first completion; returns whether the file reached the workspace. */
async function modelWriteLands(args: (endpoint: string) => string[]): Promise<{ landed: boolean; out: string }> {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.endsWith("/models")) { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ data: [{ id: "m" }] })); }
      calls++;
      res.setHeader("Content-Type", "text/event-stream");
      const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      if (calls === 1) {
        res.write(chunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "marker.txt", content: "written" }) } }] }, null));
        res.write(chunk({}, "tool_calls"));
      } else {
        res.write(chunk({ content: "done" }, null));
        res.write(chunk({}, "stop"));
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-optprec-ro-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-optprec-ro-ws-"));
  try {
    const out = await new Promise<string>((resolve) => {
      const child = spawn(TSX, ["src/index.ts", ...args(endpoint), "-w", ws], { cwd: CLI_DIR, env: { ...hostNeutralEnv(), HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache") } });
      let buf = "";
      child.stdout.on("data", (c) => (buf += c));
      child.stderr.on("data", (c) => (buf += c));
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      child.on("close", () => { clearTimeout(timer); resolve(buf); });
    });
    return { landed: fs.existsSync(path.join(ws, "marker.txt")), out };
  } finally {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test("--read-only given before the subcommand is not dropped: a model write does not land", async () => {
  const open = await modelWriteLands((e) => ["--yes", "-e", e, "run", "--json", "-m", "m", "write it"]);
  assert.equal(open.landed, true, `control run (--yes) must write the file\n${open.out}`);
  const locked = await modelWriteLands((e) => ["--read-only", "-e", e, "run", "--json", "-m", "m", "write it"]);
  assert.equal(locked.landed, false, `read-only before the subcommand must block the write\n${locked.out}`);
});

test("nexus models: an endpoint after the subcommand wins over the one before it", async () => {
  const server = http.createServer((req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: [{ id: "near-model" }] })); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const near = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-optprec-models-"));
  try {
    const out = await new Promise<string>((resolve) => {
      const child = spawn(TSX, ["src/index.ts", "-e", "http://127.0.0.1:9/v1", "models", "-e", near], { cwd: CLI_DIR, env: { ...hostNeutralEnv(), HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache") } });
      let buf = "";
      child.stdout.on("data", (c) => (buf += c));
      child.stderr.on("data", (c) => (buf += c));
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.on("close", () => { clearTimeout(timer); resolve(buf); });
    });
    assert.match(out, /near-model/, out);
  } finally {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("nexus --shell zsh repl: an option before repl overrides repl's own default", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-optprec-repl-"));
  const log = path.join(home, "repl.log");
  const shellLog = path.join(home, "shell.log");
  try {
    const run = async (args: string[]) => {
      await new Promise<void>((resolve) => {
        const child = spawn(TSX, ["src/index.ts", ...args], { cwd: CLI_DIR, env: { ...hostNeutralEnv(), NEXUS_TEST_RECORD_REPL: log, NEXUS_TEST_RECORD_REPL_SHELL: shellLog, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache") } });
        const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
        child.on("close", () => { clearTimeout(timer); resolve(); });
      });
    };
    await run(["--shell", "zsh", "repl"]);
    await run(["repl"]);
    await run(["--shell", "zsh", "repl", "--shell", "sh"]);
    assert.deepEqual(fs.readFileSync(shellLog, "utf8").trim().split("\n"), ["zsh", "bash", "sh"]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
