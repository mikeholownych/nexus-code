/**
 * Shared by the language-server tests that drive the product against the scripted fake (fixtures/fake_lsp_scripted.mjs):
 * a throwaway workspace, a manager whose server table points at the fake, the real tool handler, the fake's log, and a
 * close that proves every process the fake logged is gone.
 */
import "./leak_guard.js";
import assert from "node:assert/strict";
import fsModule from "node:fs";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LspBridgeManager, type LspClient } from "../../src/lsp.js";
import { RustCoreBridge } from "../../src/tools.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake_lsp_scripted.mjs");

export type Entry = { event: string; method?: string; id?: unknown; params?: any; docs?: Record<string, any>; to?: string; result?: unknown; error?: unknown; pid?: number; signal?: string };

export const diag = (severity: number | undefined, message: string) => ({
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  ...(severity === undefined ? {} : { severity }),
  message,
  source: "fake",
});
export const publish = (diagnostics: unknown[], uri = "$uri", extra: Record<string, unknown> = {}) => ({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics, ...extra } });
export const progress = (kind: "begin" | "end", token = "analysis") => ({ method: "$/progress", params: { token, value: { kind } } });

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Waits (bounded) for something that is expected to happen; false if it did not. */
export async function eventually(check: () => boolean, withinMs = 10_000): Promise<boolean> {
  for (const end = performance.now() + withinMs; performance.now() < end; await sleep(20)) if (check()) return true;
  return check();
}

export interface Opened {
  /** The temp directory that holds the workspace (and anything a test puts beside it); removed by `close`. */
  root: string;
  ws: string;
  mgr: LspBridgeManager;
  uri: (name: string) => string;
  tool: (name: string, args: Record<string, unknown>) => Promise<{ success: boolean; output: string; error?: string }>;
  client: () => Promise<LspClient>;
  /**
   * The barrier: one request round trip to every server that is running. When it returns, the fake has logged everything
   * the client wrote before it. It starts no server, and does nothing once the servers are shut down.
   */
  sync: () => Promise<void>;
  /**
   * The fake's log, read after the barrier: a query answered without a round trip (a cached list, a refusal, a timeout)
   * leaves the notifications it sent (didOpen, didChange, didClose) unlogged for a moment, so every reader waits for them.
   */
  log: () => Promise<Entry[]>;
  received: (method: string) => Promise<Entry[]>;
  /**
   * The log as it is on disk now, without the barrier. Only for a server that cannot answer it (never initialised,
   * deliberately unresponsive, already stopped), or inside a polling check.
   */
  rawLog: () => Entry[];
  /** Shuts everything down, asserts every process the fake logged (server, grandchild) is gone, removes the temp tree. */
  close: () => Promise<void>;
}

export function open(scenario: Record<string, unknown>, files: Record<string, string>, opts: { awaitProgress?: boolean; cmd?: string; viaSymlink?: boolean; wsName?: string } = {}): Opened {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lsp-char-")));
  const real = path.join(root, opts.wsName ?? "ws");
  fs.mkdirSync(real);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(real, name)), { recursive: true });
    fs.writeFileSync(path.join(real, name), text);
  }
  let ws = real;
  if (opts.viaSymlink) {
    ws = path.join(root, "link");
    fs.symlinkSync(real, ws);
  }
  const logFile = path.join(root, "fake.log.jsonl");
  const scenarioFile = path.join(root, "scenario.json");
  fs.writeFileSync(scenarioFile, JSON.stringify({ ...scenario, log: logFile }));
  const mgr = new LspBridgeManager(ws, {
    servers: { ".ts": { cmd: opts.cmd ?? process.execPath, args: opts.cmd ? [] : [FAKE, scenarioFile], languageId: "typescript", awaitProgress: opts.awaitProgress === true } },
  });
  const bridge = new RustCoreBridge(ws);
  (bridge as any).lsp = mgr;
  const rawLog = (): Entry[] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const client = async () => {
    const c = await mgr.getClientForFile("a.ts");
    assert.ok(c, "the fake server started");
    return c;
  };
  const sync = async () => {
    const running = [...((mgr as any).clients as Map<string, LspClient>).values()].filter((c) => c.initialized);
    for (const c of running) await c.sendRequest("test/sync", {}).catch(() => {}); // a server that just died has nothing more to log
  };
  const log = async () => {
    await sync();
    return rawLog();
  };
  return {
    root,
    ws,
    mgr,
    uri: (name) => pathToFileURL(path.join(ws, name)).href,
    tool: (name, args) => bridge.executeTool(name, args),
    client,
    sync,
    log,
    received: async (method) => (await log()).filter((e) => e.event === "recv" && e.method === method),
    rawLog,
    close: async () => {
      bridge.shutdown();
      mgr.shutdownAll();
      const pids = rawLog().filter((e) => e.event === "start" || e.event === "grandchild").map((e) => e.pid!);
      const gone = await eventually(() => pids.every((pid) => !alive(pid)));
      fs.rmSync(root, { recursive: true, force: true });
      assert.ok(gone, `a process started for this test is still running: ${pids.filter(alive).join(", ")}`);
    },
  };
}

/** The records inside a fenced lsp_diagnostics result. */
export function records(output: string): Array<Record<string, unknown>> {
  const lines = output.split("\n");
  assert.match(lines[0], /^\(untrusted tool output: lsp diagnostics for /);
  assert.equal(lines.at(-1), "(end untrusted tool output)");
  return JSON.parse(lines.slice(1, -1).join("\n"));
}

const COUNTED = ["realpathSync", "statSync", "lstatSync", "openSync", "fstatSync", "readFileSync", "readSync", "closeSync", "existsSync", "accessSync", "readdirSync", "readlinkSync"] as const;

/**
 * Runs `run` with the synchronous file-system functions a language-server client could use wrapped, and returns each call
 * made meanwhile as [function, first argument]. It counts calls to `node:fs` (one `realpathSync` is one call, although it
 * examines every component of the path), from any code in this process: wrap only the product call being measured.
 */
export async function countingFs<T>(run: () => Promise<T>): Promise<{ result: T; calls: Array<[string, string]> }> {
  const calls: Array<[string, string]> = [];
  const target = fsModule as unknown as Record<string, any>;
  const saved = COUNTED.map((name) => [name, target[name]] as const);
  for (const [name, original] of saved) {
    target[name] = Object.assign(function (this: unknown, ...args: unknown[]) {
      calls.push([name, String(args[0])]);
      return original.apply(this, args);
    }, original);
  }
  syncBuiltinESMExports();
  try {
    return { result: await run(), calls };
  } finally {
    for (const [name, original] of saved) target[name] = original;
    syncBuiltinESMExports();
  }
}
