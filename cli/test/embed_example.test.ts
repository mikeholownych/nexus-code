/**
 * PF-4 acceptance: "an example script runs a verified task through the entry point in CI". examples/embed/embed.mjs is
 * run as a user would run it, against the built entry point (cli/dist/lib.js, which spawns cli/dist/sidecar.js) and a
 * scripted gateway; nothing contacts a live service. CI builds cli/dist before the suite; without it these tests fail
 * and say so (a missing build is host state, not something to skip over).
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startGateway, type Reply } from "./helpers/fixtures.js";

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(CLI_DIR, "..");
const LIB = path.join(CLI_DIR, "dist", "lib.js");
const EXAMPLE = path.join(ROOT, "examples", "embed", "embed.mjs");

function requireBuild(): void {
  for (const file of ["lib.js", "sidecar_client.js", "sidecar.js", path.join("types", "lib.d.ts")]) {
    assert.ok(fs.existsSync(path.join(CLI_DIR, "dist", file)), `cli/dist/${file} is missing: run \`npm --prefix cli run build\``);
  }
}

interface Run { code: number | null; out: string; err: string }

/** Runs node with a throwaway HOME and none of the host's product settings; killed by its own pid on timeout. */
async function runNode(args: string[], cwd: string, env: Record<string, string>): Promise<Run> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-embed-home-"));
  const clean: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(clean)) if (/^(LOCAL_LLM_|LOCAL_HARNESS_|NEXUS_)/.test(key)) delete clean[key];
  // Under `node --test` this variable turns a nested `node --test` (the example's verifier) into a run of zero tests.
  delete clean.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, args, {
    cwd,
    env: {
      ...clean,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_STATE_HOME: path.join(home, ".local", "state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
  try {
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    return { code, out, err };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function runExample(replies: Reply[]): Promise<Run & { gatewayRequests: number; requests: unknown[] }> {
  const gateway = await startGateway((n) => replies[Math.min(n, replies.length) - 1]);
  try {
    const run = await runNode([EXAMPLE], ROOT, { NEXUS_LIB: LIB, NEXUS_ARGS: `-e ${gateway.url} -m m --no-continuation -s 8` });
    return { ...run, gatewayRequests: gateway.requests.length, requests: gateway.requests };
  } finally {
    await gateway.close();
  }
}

const fixAndComplete: Reply[] = [
  { kind: "tools", calls: [{ name: "run_command", args: { command: "printf 'exports.add = (a, b) => a + b;\\n' > add.js" } }] },
  { kind: "tools", calls: [{ name: "run_command", args: { command: "node --test" } }] },
  { kind: "tools", calls: [{ name: "task_completed", args: { summary: "Fixed add()" } }] },
  { kind: "text", content: "Done." },
];
const claimWithoutFixing: Reply[] = [
  { kind: "tools", calls: [{ name: "task_completed", args: { summary: "Fixed add() (it was not)" } }] },
  { kind: "text", content: "Done." },
];

test("examples/embed: a real fix through the library entry point is VERIFIED and exits 0", { timeout: 280_000 }, async () => {
  requireBuild();
  const run = await runExample(fixAndComplete);
  assert.equal(run.code, 0, `${run.out}\n${run.err}`.slice(-1500));
  assert.equal(run.out, "outcome: VERIFIED\n", "the example prints the outcome and nothing else");
  assert.ok(run.gatewayRequests >= 3, "the sidecar the example spawned did the work");
});

test("examples/embed: a completion claim the verifier rejects is not VERIFIED and exits non-zero", { timeout: 280_000 }, async () => {
  requireBuild();
  const run = await runExample(claimWithoutFixing);
  assert.notEqual(run.code, 0, "the verifier is the gate: claiming completion is not completing");
  assert.match(run.out, /^outcome: (?!VERIFIED)\w+\n$/, `${run.out}\n${run.err}`.slice(-1500));
});

test("examples/embed: a model-declared verifier is denied while the configured verifier remains usable", { timeout: 280_000 }, async () => {
  requireBuild();
  const marker = "NEXUS_MODEL_DECLARED_VERIFIER_MUST_NOT_RUN";
  const run = await runExample([
    { kind: "tools", calls: [{ name: "verifier", args: { command: `printf ${marker}`, detail: "model-declared" } }] },
    ...fixAndComplete,
  ]);
  assert.equal(run.code, 0, `${run.out}\n${run.err}`.slice(-1500));
  assert.equal(run.out, "outcome: VERIFIED\n");
  const messages = run.requests.flatMap((request: any) => request.messages ?? []);
  const attempted = messages.flatMap((message: any) => message.tool_calls ?? []).find((call: any) => {
    if (call.function?.name !== "verifier") return false;
    try { return JSON.parse(call.function.arguments).command.includes(marker); } catch { return false; }
  });
  assert.ok(attempted, "the model-declared verifier request reached the sidecar");
  const result = messages.find((message: any) => message.role === "tool" && message.tool_call_id === attempted.id);
  assert.ok(result, "the model-declared verifier call received a tool result");
  assert.ok(!String(result.content ?? "").includes(marker), "the denied model-declared verifier did not execute");
});

test("the package resolves by name to the library entry only: the CLI and the agent are not importable through it", { timeout: 120_000 }, async () => {
  requireBuild();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-embed-pkg-"));
  try {
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.symlinkSync(CLI_DIR, path.join(dir, "node_modules", "local-code-harness"), "dir");
    const script = `
const lib = await import("local-code-harness");
if (lib.NEXUS_LIB_API_VERSION !== 1 || typeof lib.spawnSidecar !== "function" || "ApplicationCore" in lib) process.exit(3);
for (const inner of ["local-code-harness/dist/index.js", "local-code-harness/dist/core/app.js", "local-code-harness/dist/sidecar.js"]) {
  const code = await import(inner).then(() => "imported", (error) => error.code);
  if (code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") { console.log(inner, code); process.exit(4); }
}`;
    const run = await runNode(["--input-type=module", "-e", script], dir, {});
    assert.deepEqual(run, { code: 0, out: "", err: "" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
