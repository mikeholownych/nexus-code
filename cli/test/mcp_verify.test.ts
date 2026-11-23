/**
 * VR-2: `nexus_verify` on `nexus serve-mcp`, driven as an untrusted MCP client drives it: JSON-RPC lines over the real
 * server's stdio. The client gets a verdict and a receipt id and reads the receipt back; nothing it can put in a
 * request raises the verdict, creates a receipt or runs anything the operator did not name.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cliEntry } from "./helpers/audit_fixture.js";
import { makeHome, makeRepo, processGone, waitUntil } from "./helpers/fixtures.js";
import { renderPolicyToml } from "./helpers/policy_fixture.js";
import { assertVerifyResult, BAD, BASE_FILES, CLI_DIR, GOOD, MATH_BROKEN, MATH_BUGGY, TEST_FILE, TEST_FULL, writeFiles } from "./helpers/verify_fixture.js";

const TOOL = "nexus_verify";
const OPERATOR = ["--authoritative-verifier", "npm test", "--deliverable-file", "src/math.js"];
const STATIC_RESOURCES = ["nexus://workspace-info", "nexus://agents-rules"];
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const processes = () => spawnSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8" }).stdout.split("\n").map((line) => {
  const [, pid, ppid, args] = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line) ?? [];
  return { pid: Number(pid), ppid: Number(ppid), args: args ?? "" };
}).filter((entry) => entry.pid > 0);

interface Client {
  pid: number;
  stderr: () => string;
  /** Every response received so far. */
  responses: any[];
  request: (method: string, params?: unknown) => Promise<any>;
  /** Writes text as it is, for several messages in one chunk. */
  write: (text: string) => void;
  response: (id: number) => Promise<any>;
  call: (args?: unknown, extra?: Record<string, unknown>) => Promise<any>;
  resources: () => Promise<string[]>;
  close: () => Promise<number | null>;
}

/**
 * `nexus <globals> serve-mcp -w <repo>` (the build when it is current, as CI has it, else the source: see `cliEntry`),
 * with a throwaway HOME and temp directory and no operator environment. The worker is forked the same way as the
 * server was started. Every stdout line must be one JSON-RPC message: anything else fails `close`.
 */
function startServer(repo: string, globals: string[] = [], prepareHome?: (home: string) => void, extraEnv: Record<string, string> = {}): Client {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(LOCAL_LLM_|LOCAL_HARNESS_|NEXUS_|GIT_)/.test(key) || key === "NODE_TEST_CONTEXT") delete env[key];
  const home = makeHome();
  prepareHome?.(home);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-verify-tmp-"));
  const child: ChildProcess = spawn(process.execPath, [...cliEntry(), ...globals, "serve-mcp", "-w", repo], {
    cwd: CLI_DIR,
    env: { ...env, HOME: home, TMPDIR: tmp, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache"), ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let buffer = "";
  let nextId = 1;
  let exitCode: number | null | undefined;
  const responses: any[] = [];
  const notJsonRpc: string[] = [];
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const message = JSON.parse(line);
        if (message?.jsonrpc !== "2.0") throw new Error("not JSON-RPC");
        responses.push(message);
      } catch {
        notJsonRpc.push(line.slice(0, 200));
      }
    }
  });
  const closed = new Promise<number | null>((resolve) => child.on("close", (code) => resolve((exitCode = code))));
  const write = (text: string) => void child.stdin!.write(text);
  const response = async (id: number) => {
    await waitUntil(() => exitCode !== undefined || responses.some((message) => message.id === id), 150_000).catch(() => {});
    const found = responses.find((message) => message.id === id);
    assert.ok(found, `no response to request ${id}; stderr: ${stderr.slice(-600)}`);
    return found;
  };
  const request = (method: string, params?: unknown) => {
    const id = nextId++;
    write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
    return response(id);
  };
  return {
    pid: child.pid!,
    stderr: () => stderr,
    responses,
    request,
    write,
    response,
    call: (args, extra = {}) => request("tools/call", { name: TOOL, ...(args === undefined ? {} : { arguments: args }), ...extra }),
    resources: async () => (await request("resources/list")).result.resources.map((resource: any) => resource.uri),
    close: async () => {
      child.stdin!.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      const code = await closed;
      clearTimeout(timer);
      const leftovers = fs.readdirSync(tmp).filter((name) => name.startsWith("nexus-"));
      for (const dir of [tmp, home]) fs.rmSync(dir, { recursive: true, force: true });
      assert.deepEqual(notJsonRpc, [], "every stdout line is a JSON-RPC message");
      assert.equal(buffer, "", "no partial line is left on stdout");
      assert.deepEqual(leftovers, [], "no scratch directory is left behind");
      return code;
    },
  };
}

/** Runs `check` against a server on a fresh fixture repository and stops the server and removes the repository after. */
async function withServer(files: Record<string, string>, globals: string[], check: (client: Client, repo: string) => Promise<void>, prepareHome?: (home: string) => void, extraEnv?: Record<string, string>): Promise<void> {
  const repo = makeRepo(files);
  const client = startServer(repo, globals, prepareHome, extraEnv);
  let failure: unknown;
  try {
    await check(client, repo);
  } catch (error) {
    failure = error;
  }
  const closing = await client.close().then(() => undefined, (error) => error);
  fs.rmSync(repo, { recursive: true, force: true });
  if (failure ?? closing) throw failure ?? closing;
}

/** The summary of a call that reached a verdict. */
function verdictOf(response: any): any {
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  assert.equal(response.result.isError, false, response.result.content?.[0]?.text);
  const summary = JSON.parse(response.result.content[0].text);
  assert.equal(summary.service_version, 1);
  assert.equal(summary.verify_schema_version, 3);
  assert.match(summary.receipt_id, /^vr-[0-9a-f]{32}$/);
  assert.equal(summary.receipt_uri, `nexus://verify-receipt/${summary.receipt_id}`);
  return summary;
}

/** The error document of a call that reached no verdict. */
function refusalOf(response: any): any {
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  assert.equal(response.result.isError, true, response.result.content?.[0]?.text);
  const doc = JSON.parse(response.result.content[0].text);
  assert.deepEqual(Object.keys(doc), ["schema_version", "error", "exitCode"]);
  assert.equal(doc.verdict, undefined);
  return doc;
}

async function readReceipt(client: Client, summary: any): Promise<any> {
  const read = await client.request("resources/read", { uri: summary.receipt_uri });
  const text = read.result.contents[0].text;
  const receipt = JSON.parse(text);
  assertVerifyResult(receipt.result);
  assert.equal(receipt.receipt_id, summary.receipt_id);
  assert.equal(receipt.receipt_sha256, summary.receipt_sha256);
  assert.equal(receipt.receipt_sha256, sha256(JSON.stringify(receipt.result)), "the hash is of the result as served");
  assert.equal(receipt.result.verdict, summary.verdict);
  assert.equal(receipt.surface, "mcp");
  return { receipt, text };
}

test("a client gets a verdict and a receipt id, reads the receipt, and no request it can make raises the verdict", { timeout: 420_000 }, () => withServer(BASE_FILES, OPERATOR, async (client, repo) => {
  const init = await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "scripted", version: "0" } });
  assert.equal(init.result.serverInfo.name, "nexus-code");
  client.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const tool = (await client.request("tools/list")).result.tools.find((entry: any) => entry.name === TOOL);
  assert.deepEqual(tool.inputSchema, { type: "object", properties: {}, additionalProperties: false });
  assert.deepEqual(await client.resources(), STATIC_RESOURCES);
  const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();

  // The good change, asked for twice in one chunk: one verification runs, the other is refused and not queued.
  writeFiles(repo, GOOD);
  client.write([100, 101].map((id) => `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: TOOL, arguments: {} } })}\n`).join(""));
  assert.match(refusalOf(await client.response(101)).error, /already running/);
  const good = verdictOf(await client.response(100));
  assert.deepEqual([good.verdict, good.outcome, good.reason], ["VERIFIED", "VERIFIED", undefined], JSON.stringify(good));
  assert.deepEqual([good.base.commit, good.head.workingTree, good.verifier.command, good.verifier.approval], [base, true, "npm test", "operator_command"]);
  const { receipt, text } = await readReceipt(client, good);
  assert.equal(receipt.result.sandbox.network, false);
  assert.notEqual(receipt.result.sandbox.engine, "none", "the verifier ran confined");
  assert.deepEqual(await client.resources(), [...STATIC_RESOURCES, good.receipt_uri], "only the completed call left a receipt");

  // A receipt cannot be found by a made-up id, and a real one reads back the same bytes.
  for (const id of [`vr-${"0".repeat(32)}`, good.receipt_id.toUpperCase(), `${good.receipt_id}/../${good.receipt_id}`, `../workspace-info`, `rcpt-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`, "turn:s:1", "", "x".repeat(10_000)]) {
    const forged = await client.request("resources/read", { uri: `nexus://verify-receipt/${id}` });
    assert.equal(forged.result, undefined);
    assert.equal(forged.error.message, "Verify receipt not available", "the requested id is not echoed");
  }
  assert.equal((await client.request("resources/read", { uri: good.receipt_uri })).result.contents[0].text, text);

  // The weakened test (the fix undone, the failing test deleted) is on disk for everything hostile that follows.
  writeFiles(repo, { "src/math.js": MATH_BUGGY, ...BAD });
  const before = await client.resources();
  const hostileArguments: unknown[] = [
    { verifier: "true" }, { verifierCommand: "true" }, { base: "HEAD" }, { head: "HEAD" }, { worktree: "/" }, { path: "../x" }, { deliverables: ["src/math.js"] },
    { sandbox: "none" }, { verdict: "VERIFIED" }, { outcome: "VERIFIED" }, { receipt_id: good.receipt_id }, { approveDiscoveredVerifier: true }, { yes: true },
    { approvedVerificationEdits: [TEST_FILE] }, { timeoutSecs: 1 }, { "": "" }, { pad: "x".repeat(1024 * 1024) }, "VERIFIED", 7, true, null, [], [{ verdict: "VERIFIED" }],
  ];
  for (const args of hostileArguments) {
    const refused = await client.request("tools/call", { name: TOOL, arguments: args });
    assert.equal(refused.result, undefined, `no result for ${JSON.stringify(args).slice(0, 60)}`);
    assert.equal(refused.error.code, -32602);
    assert.match(refused.error.message, /takes no arguments/);
  }
  // A member beside `arguments` is refused as well.
  for (const extra of [{ verifier: "true" }, { verdict: "VERIFIED" }, { base: "HEAD" }, { receipt: { verdict: "VERIFIED" } }]) {
    assert.equal((await client.call({}, extra)).error.code, -32602);
    assert.equal((await client.call(undefined, extra)).error.code, -32602);
  }
  assert.deepEqual(await client.resources(), before, "a refused request creates no receipt");
  assert.ok(!processes().some((entry) => entry.ppid === client.pid && entry.args.includes("verify_worker")), "a refused request starts no worker");
  // No MCP method writes a receipt.
  for (const method of ["resources/write", "resources/create", "resources/update", "resources/subscribe"]) {
    assert.ok((await client.request(method, { uri: `nexus://verify-receipt/vr-${"1".repeat(32)}`, text: JSON.stringify({ result: { verdict: "VERIFIED" } }) })).error);
  }
  assert.equal((await client.request("resources/read", { uri: `nexus://verify-receipt/vr-${"1".repeat(32)}` })).error.message, "Verify receipt not available");

  // The weakened test, verified with no arguments: BLOCKED, with a receipt, and not an error.
  const weakened = verdictOf(await client.call({}));
  assert.deepEqual([weakened.verdict, weakened.reason], ["BLOCKED", "VERIFICATION_EDIT_BLOCKED"], JSON.stringify(weakened));
  await readReceipt(client, weakened);

  // A change that breaks the product: the operator's verifier fails on it. `arguments` may also be absent.
  writeFiles(repo, { "src/math.js": MATH_BROKEN, [TEST_FILE]: TEST_FULL });
  const broken = verdictOf(await client.call());
  assert.deepEqual([broken.verdict, broken.reason], ["UNVERIFIED", "VERIFIER_FAILED"], JSON.stringify(broken));
  await readReceipt(client, broken);

  // The first receipt is what it was: later calls and refused requests changed nothing in it.
  assert.equal((await client.request("resources/read", { uri: good.receipt_uri })).result.contents[0].text, text);
  assert.deepEqual(await client.resources(), [...STATIC_RESOURCES, good.receipt_uri, weakened.receipt_uri, broken.receipt_uri]);
  assert.equal((await client.request("ping")).result !== undefined, true);
}));

test("a verifier discovered in the repository is never approved: BLOCKED, nothing executed, the caller is not asked", { timeout: 120_000 }, async () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-verify-marker-")), "ran");
  const files = { ...BASE_FILES, "package.json": JSON.stringify({ name: "verify-fixture", version: "1.0.0", private: true, type: "module", scripts: { test: `touch '${marker}'; node --test` } }) };
  try {
    await withServer(files, [], async (client, repo) => {
      await waitUntil(() => client.stderr().includes("no --authoritative-verifier was given"), 60_000);
      writeFiles(repo, GOOD);
      const summary = verdictOf(await client.call({}));
      assert.deepEqual([summary.verdict, summary.reason], ["BLOCKED", "VERIFIER_NOT_APPROVED"], JSON.stringify(summary));
      assert.match(summary.operator_hint, /operator must start the server with `nexus --authoritative-verifier <command> serve-mcp`/);
      assert.equal(summary.verifier.approval, "none");
      const { receipt } = await readReceipt(client, summary);
      assert.deepEqual(receipt.result.runs, [], "no verifier run is recorded");
      assert.equal(fs.existsSync(marker), false, "the repository's test script was not executed");
      // The digest the CLI would accept as approval has no way in.
      assert.equal((await client.call({ approvedVerifierDigest: summary.verifier.digest })).error.code, -32602);
      assert.equal((await client.call({}, { approveVerifier: summary.verifier.digest })).error.code, -32602);
      assert.equal(fs.existsSync(marker), false);
      // Only server-to-client requests could ask the caller anything: there were none.
      assert.deepEqual(client.responses.filter((message) => message.method !== undefined), []);
    });
  } finally {
    fs.rmSync(path.dirname(marker), { recursive: true, force: true });
  }
});

test("notifications/cancelled stops the worker and the verifier it runs: no response, no receipt", { timeout: 180_000 }, async () => {
  const marker = `32${process.pid}.${Date.now() % 100000}`;
  await withServer(BASE_FILES, ["--authoritative-verifier", `sleep ${marker}`], async (client, repo) => {
    writeFiles(repo, GOOD);
    client.write(`${JSON.stringify({ jsonrpc: "2.0", id: 500, method: "tools/call", params: { name: TOOL, arguments: {} } })}\n`);
    let worker = 0;
    let sleepers: number[] = [];
    // The server's own command line names the verifier too, so it is left out.
    const sleeping = () => processes().filter((entry) => entry.pid !== client.pid && entry.args.includes(`sleep ${marker}`)).map((entry) => entry.pid);
    await waitUntil(() => {
      worker ||= processes().find((entry) => entry.ppid === client.pid && entry.args.includes("verify_worker"))?.pid ?? 0;
      sleepers = sleeping();
      return worker > 0 && sleepers.length > 0;
    }, 90_000);
    // The server still answers while the verification runs, and a cancellation of another request stops nothing.
    client.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 499 } })}\n`);
    assert.deepEqual((await client.request("ping")).result, {});
    assert.ok(!processGone(worker) && sleeping().length > 0);

    client.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 500, reason: "client gave up" } })}\n`);
    await waitUntil(() => processGone(worker) && sleepers.every(processGone) && sleeping().length === 0, 60_000);
    assert.deepEqual(await client.resources(), STATIC_RESOURCES, "no receipt");
    assert.deepEqual(client.responses.filter((message) => message.id === 500 || message.id === undefined), [], "a cancelled request gets no response");
  });
});

test("SIGTERM to the server stops a verifier that ignores SIGTERM and removes the scratch trees before the server exits", { timeout: 180_000 }, async () => {
  const marker = `33${process.pid}.${Date.now() % 100000}`;
  const repo = makeRepo(BASE_FILES);
  const client = startServer(repo, ["--authoritative-verifier", `trap '' TERM; sleep ${marker}`]);
  // Everything that carries the verifier's command line but the server: timeout, bash, the sandbox and the sleep.
  const running = () => processes().filter((entry) => entry.pid !== client.pid && entry.args.includes(`sleep ${marker}`)).map((entry) => entry.pid);
  let exited: number | null | undefined;
  try {
    writeFiles(repo, GOOD);
    client.write(`${JSON.stringify({ jsonrpc: "2.0", id: 700, method: "tools/call", params: { name: TOOL, arguments: {} } })}\n`);
    let worker = 0;
    await waitUntil(() => {
      worker ||= processes().find((entry) => entry.ppid === client.pid && entry.args.includes("verify_worker"))?.pid ?? 0;
      return worker > 0 && processes().some((entry) => entry.pid !== client.pid && /(^|\/)sleep /.test(entry.args) && entry.args.includes(marker));
    }, 90_000);
    const verifier = running();
    const signalled = Date.now();
    process.kill(client.pid, "SIGTERM");
    // close() also fails when a scratch directory is left in the server's temp directory.
    exited = await client.close();
    assert.equal(exited, 143);
    assert.ok(Date.now() - signalled < 25_000, "the server exits within its kill grace and a few seconds");
    assert.ok(processGone(worker), "the worker is gone when the server exits");
    assert.ok(verifier.every(processGone) && running().length === 0, "the verifier and its sandbox are gone when the server exits");
    assert.deepEqual(client.responses.filter((message) => message.id === 700), [], "no verdict was made up for the stopped call");
  } finally {
    if (exited === undefined) await client.close().catch(() => {});
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("read-only mode, a managed policy that requires a person, and a workspace with no commit refuse with an error and no receipt", { timeout: 180_000 }, async () => {
  const refused = async (client: Client, pattern: RegExp) => {
    const doc = refusalOf(await client.call({}));
    assert.deepEqual([doc.schema_version, doc.exitCode], [3, 2]);
    assert.match(doc.error, pattern);
    assert.deepEqual(await client.resources(), STATIC_RESOURCES);
    assert.ok(!processes().some((entry) => entry.ppid === client.pid && entry.args.includes("verify_worker")));
  };
  for (const globals of [["--read-only"], ["--mode", "read-only"]]) {
    await withServer(BASE_FILES, [...globals, ...OPERATOR], (client) => refused(client, /read-only mode does not allow/));
  }
  // Read-only selected by the environment, not a flag, is the same mode.
  await withServer(BASE_FILES, OPERATOR, (client) => refused(client, /read-only mode does not allow/), undefined, { NEXUS_APPROVAL_MODE: "read-only" });
  await withServer(BASE_FILES, OPERATOR, (client) => refused(client, /managed policy requires a person/), (home) => {
    const dir = path.join(home, ".config", "nexus");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, "policy.toml"), renderPolicyToml({ approval: { require_human: ["exec"] } }), { mode: 0o600 });
  });

  // Not a Git working tree: there is no base to pin, so there is nothing to compare the tree with.
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-verify-plain-"));
  const client = startServer(plain, OPERATOR);
  try {
    await refused(client, /no commit to verify against|could not be read as a Git working tree/);
  } finally {
    await client.close();
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test("McpServer built the old way, with a workspace only, lists nexus_verify beside the workspace tools", async () => {
  const { McpServer } = await import("../src/mcp.js");
  const server = new McpServer(CLI_DIR);
  try {
    const names = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.map((tool: any) => tool.name);
    assert.ok(names.includes("file_info") && names.includes(TOOL));
    assert.equal(names.filter((name: string) => name === TOOL).length, 1);
    assert.equal((await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: TOOL, arguments: { verdict: "VERIFIED" } } })).error.code, -32602);
  } finally {
    server.shutdown();
  }
});

test("serve-mcp refuses to start with operator settings it cannot use", { timeout: 120_000 }, async () => {
  for (const [globals, pattern] of [
    [["--authoritative-verifier", "npm test", "--deliverable-file", "../outside.js"], /Invalid --deliverable-file/],
    [["--authoritative-verifier", "npm test", "--deliverable-file", TEST_FILE], /cannot be declared as product deliverables/],
    [["--authoritative-verifier", "  "], /--authoritative-verifier needs a command/],
  ] as Array<[string[], RegExp]>) {
    const repo = makeRepo(BASE_FILES);
    const client = startServer(repo, globals);
    try {
      assert.equal(await client.close(), 2, client.stderr());
      assert.match(client.stderr(), pattern);
      assert.deepEqual(client.responses, []);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }
});
