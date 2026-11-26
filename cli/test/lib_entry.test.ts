/**
 * PF-4: the library entry point (src/lib.ts). Importing it does nothing (no command parsing, exit, output, HOME, listener
 * or timer), its runtime module graph is the sidecar client and the line reader only, and its export list is the one
 * recorded in docs/protocol/LIB_API_VERSIONS.json. The CLI entry (src/index.ts) is unchanged by it.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as lib from "../src/lib.js";
import { CLIENT_PROTOCOL_VERSION } from "../src/sidecar_client.js";
import { PROTOCOL_VERSION } from "../src/protocol.js";

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(CLI_DIR, "..");
const TSX = import.meta.resolve("tsx");
const LIB = pathToFileURL(path.join(CLI_DIR, "src", "lib.ts")).href;
const INDEX = pathToFileURL(path.join(CLI_DIR, "src", "index.ts")).href;

interface Run { code: number | null; out: string; err: string }

/** Runs node in an empty directory with a HOME that does not exist and none of the product's settings; killed by its own pid on timeout. */
async function runNode(args: string[], at: { dir: string; home: string }, env: Record<string, string> = {}): Promise<Run> {
  const clean: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(clean)) if (/^(LOCAL_LLM_|LOCAL_HARNESS_|NEXUS_)/.test(key)) delete clean[key];
  delete clean.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, args, {
    cwd: at.dir,
    env: { ...clean, HOME: at.home, XDG_CONFIG_HOME: path.join(at.home, ".config"), XDG_STATE_HOME: path.join(at.home, ".local", "state"), XDG_CACHE_HOME: path.join(at.home, ".cache"), XDG_DATA_HOME: path.join(at.home, ".local", "share"), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  try {
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    return { code, out, err };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

function sandbox(): { dir: string; home: string; base: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lib-entry-"));
  const dir = path.join(base, "cwd");
  fs.mkdirSync(dir);
  return { base, dir, home: path.join(base, "home") };
}

/**
 * The child's own check: what the process looks like before and after the import. Exit 3 names a listener, a patched
 * stdout or exit, or a pending handle the import left behind; arguments that would be a CLI command line are present.
 */
const probe = (url: string): string => `
const names = ["exit", "beforeExit", "SIGINT", "SIGTERM", "SIGHUP", "uncaughtException", "unhandledRejection", "warning"];
const counts = () => names.map((name) => process.listenerCount(name)).join(",");
const before = { counts: counts(), write: process.stdout.write, errWrite: process.stderr.write, exit: process.exit, log: console.log, env: JSON.stringify(process.env), argv: process.argv.join(" ") };
await import(${JSON.stringify(url)});
// Timers only: the loader keeps sockets of its own. A handle that held the process open would show as the timeout below.
const handles = process.getActiveResourcesInfo().filter((kind) => kind === "Timeout" || kind === "Immediate");
const same = before.counts === counts() && before.write === process.stdout.write && before.errWrite === process.stderr.write && before.exit === process.exit
  && before.log === console.log && before.env === JSON.stringify(process.env) && before.argv === process.argv.join(" ") && handles.length === 0;
if (!same) process.exitCode = 3;
`;
const CLI_ARGV = ["--", "run", "--help", "doctor"];

test("importing the lib has no side effects: no output, no exit, no HOME, no listener, no timer", { timeout: 240_000 }, async () => {
  const at = sandbox();
  try {
    const run = await runNode(["--import", TSX, "--input-type=module", "-e", probe(LIB), ...CLI_ARGV], at);
    assert.deepEqual(run, { code: 0, out: "", err: "" });
    assert.equal(fs.existsSync(at.home), false, "HOME was not created");
    assert.deepEqual(fs.readdirSync(at.dir), [], "nothing was written to the working directory");
  } finally {
    fs.rmSync(at.base, { recursive: true, force: true });
  }
});

test("the same probe fails on the CLI entry, so it does detect a module that parses a command line on import", { timeout: 240_000 }, async () => {
  const at = sandbox();
  // The CLI entry refuses a HOME that does not exist before it reaches commander; give it one.
  fs.mkdirSync(at.home);
  try {
    const run = await runNode(["--import", TSX, "--input-type=module", "-e", probe(INDEX), ...CLI_ARGV], at);
    assert.match(run.out, /Usage: /, "commander ran");
  } finally {
    fs.rmSync(at.base, { recursive: true, force: true });
  }
});

test("the lib's runtime module graph is closed: the client, the line reader and node builtins", { timeout: 240_000 }, async () => {
  const at = sandbox();
  const log = path.join(at.base, "graph.log");
  // A resolve hook in front of tsx's: every module the import reaches is resolved through it.
  const hook = `import fs from "node:fs";
export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  fs.appendFileSync(process.env.LIB_GRAPH_LOG, resolved.url + "\\n");
  return resolved;
}`;
  const register = `import { register } from "node:module"; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)});`;
  try {
    const run = await runNode(["--import", TSX, "--import", `data:text/javascript,${encodeURIComponent(register)}`, "--input-type=module", "-e", `await import(${JSON.stringify(LIB)});`], at, { LIB_GRAPH_LOG: log });
    assert.deepEqual(run, { code: 0, out: "", err: "" });
    const urls = [...new Set(fs.readFileSync(log, "utf8").split("\n").filter(Boolean))];
    const src = pathToFileURL(path.join(CLI_DIR, "src")).href + "/";
    const sources = urls.filter((url) => url.startsWith(src)).map((url) => url.slice(src.length)).sort();
    assert.deepEqual(sources, ["acp/jsonrpc.ts", "acp/types.ts", "lib.ts", "sidecar_client.ts"]);
    const others = urls.filter((url) => !url.startsWith(src) && !url.startsWith("node:"));
    assert.deepEqual(others, [], "nothing from node_modules (no commander, dotenv or ora) and nothing outside src");
  } finally {
    fs.rmSync(at.base, { recursive: true, force: true });
  }
});

test("runtime and type exports match the ledger's newest entry, and the version constants agree", () => {
  const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "protocol", "LIB_API_VERSIONS.json"), "utf8")) as Array<{ api_version: number; exports: string[]; type_exports: string[]; note: string }>;
  const newest = ledger[ledger.length - 1];
  assert.deepEqual(Object.keys(lib).sort(), [...newest.exports].sort(), "a changed export list needs a new entry in docs/protocol/LIB_API_VERSIONS.json");
  const source = fs.readFileSync(path.join(CLI_DIR, "src", "lib.ts"), "utf8");
  const typeExports = [...source.matchAll(/export type\s*\{([\s\S]*?)\}/g)]
    .flatMap((match) => match[1].split(",").map((name) => name.trim()).filter(Boolean))
    .sort();
  assert.deepEqual(typeExports, [...newest.type_exports].sort(), "a changed TypeScript API needs a new entry in docs/protocol/LIB_API_VERSIONS.json");
  assert.equal(lib.NEXUS_LIB_API_VERSION, newest.api_version);
  assert.deepEqual(ledger.map((entry) => entry.api_version), [...ledger.map((entry) => entry.api_version)].sort((a, b) => a - b), "versions never go back");
  for (const entry of ledger) assert.ok(entry.note.trim(), "every entry says what changed");
  assert.equal("ApplicationCore" in lib, false, "in-process embedding would skip the sidecar's start-up checks");
  assert.equal(CLIENT_PROTOCOL_VERSION, PROTOCOL_VERSION, "the client writes the sidecar's protocol version");
});

test("package.json: the lib is the only export, with types, and the CLI binary is unchanged", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLI_DIR, "package.json"), "utf8"));
  assert.deepEqual(pkg.exports, { ".": { types: "./dist/types/lib.d.ts", import: "./dist/lib.js" }, "./package.json": "./package.json" });
  assert.equal(pkg.main, "dist/lib.js");
  assert.equal(pkg.types, "dist/types/lib.d.ts");
  assert.deepEqual(pkg.bin, { harness: "./dist/index.js" });
  assert.equal(pkg.name, "@nexus-code-ai/nexus-code");
  assert.equal(pkg.private, false, "the scoped package is intentionally publishable");
  // The package's prepublish hook builds the public library artifacts.
  assert.match(pkg.scripts.prepublishOnly, /npm run build/);
});

test("the CLI entry still works: --version, --help and a command", { timeout: 360_000 }, async () => {
  const at = sandbox();
  fs.mkdirSync(at.home);
  const cli = ["--import", TSX, path.join(CLI_DIR, "src", "index.ts")];
  try {
    const version = await runNode([...cli, "--version"], at);
    assert.equal(version.code, 0, version.err);
    assert.ok(version.out.includes(JSON.parse(fs.readFileSync(path.join(CLI_DIR, "package.json"), "utf8")).version), version.out);

    const help = await runNode([...cli, "--help"], at);
    assert.equal(help.code, 0, help.err);
    assert.match(help.out, /Usage: /);
    for (const command of ["run", "doctor", "verify"]) assert.match(help.out, new RegExp(`^\\s+${command}\\b`, "m"), `--help lists ${command}`);

    const doctor = await runNode([...cli, "doctor", "--json"], at);
    assert.ok(doctor.code !== null && doctor.code <= 2, `doctor ran (exit ${doctor.code}): ${doctor.err.slice(-400)}`);
    assert.equal(JSON.parse(doctor.out).schemaVersion, 2);
  } finally {
    fs.rmSync(at.base, { recursive: true, force: true });
  }
});
