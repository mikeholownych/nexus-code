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

test("an endpoint given before the subcommand is the endpoint used", async () => {
  const r = await requestTemperature((e) => ["-e", e, "run", "--json", "-m", "m", "hello"]);
  assert.equal(r.temperature, 0.2, r.out);
});

test("an option after the subcommand wins over the one before it", async () => {
  const r = await requestTemperature((e) => ["-t", "0.9", "-e", e, "run", "--json", "-m", "m", "-t", "0.4", "hello"]);
  assert.equal(r.temperature, 0.4, r.out);
});

test("the subcommand default applies when the option is given nowhere", async () => {
  const r = await requestTemperature((e) => ["-e", e, "run", "--json", "-m", "m", "hello"]);
  assert.equal(r.temperature, 0.2, r.out);
});
