/**
 * PF-4: the sidecar client behind the library entry point. Most cases drive the client over in-memory streams; the last
 * ones use real processes: a child that ignores `shutdown`, and a real sidecar that completes a VERIFIED task against the
 * scripted gateway. The rule under test throughout: an approval the embedder did not grant is denied, and nothing the
 * client writes carries `"always":true`.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { SidecarClient, SidecarClientError, spawnSidecar, type SidecarChild, type SidecarExit } from "../src/lib.js";
import type { SidecarEvent } from "../src/protocol.js";
import { ACP_MAX_CHILD_LINE_BYTES } from "../src/acp/types.js";
import { startGateway, makeRepo, makeHome, processGone, waitUntil, type Reply } from "./helpers/fixtures.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A sidecar made of streams: what the client wrote, and a way to say things to it. */
function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const process_ = new EventEmitter();
  let written = "";
  stdin.on("data", (chunk) => (written += chunk));
  const signals: string[] = [];
  const child = {
    pid: 4242,
    stdin,
    stdout,
    stderr,
    kill: (signal?: NodeJS.Signals) => { signals.push(signal ?? "SIGTERM"); return true; },
    once: (event: string, listener: (...args: any[]) => void) => process_.once(event, listener),
  } as unknown as SidecarChild;
  return {
    child,
    signals,
    stdout,
    stderr,
    raw: () => written,
    commands: () => written.split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    say: async (event: Record<string, unknown>) => { stdout.write(`${JSON.stringify({ v: 1, ...event })}\n`); await tick(); },
    exit: async (code: number | null, signal: NodeJS.Signals | null = null) => { process_.emit("exit", code, signal); await tick(); },
  };
}

const turnResult = (id: string, outcome = "VERIFIED") => ({ type: "turn.result", turn_id: id, heading: outcome, line: "", turn: { outcome }, model_summary: null, saved: true });
const approvalRequest = (id: string, turn: string, tool = "run_command") => ({ type: "approval.request", id, turn_id: turn, tool, subject: "x", preview: "{}", review: {} });
const isClientError = (code: string) => (error: unknown) => error instanceof SidecarClientError && error.code === code;

test("framing: split chunks and CRLF parse; a non-JSON, non-event or other-version line is a protocol-error and later lines still parse", async () => {
  const fake = fakeChild();
  const client = new SidecarClient(fake.child);
  const events: SidecarEvent[] = [];
  const problems: string[] = [];
  client.on("event", (event) => events.push(event)).on("protocol-error", (message) => problems.push(message));

  const hello = JSON.stringify({ v: 1, type: "hello", protocol: 1, pid: 7, commands: [] });
  fake.stdout.write(hello.slice(0, 9));
  await tick();
  assert.equal(client.hello, undefined, "half a line is not a message");
  fake.stdout.write(`${hello.slice(9)}\r\n\r\n`);
  await tick();
  assert.equal(client.hello?.pid, 7);

  fake.stdout.write("not json\n[1,2]\n{\"v\":1}\n{\"v\":2,\"type\":\"notice\",\"text\":\"future\"}\n");
  await fake.say({ type: "notice", text: "after" });
  assert.equal(problems.length, 4, problems.join(" | "));
  assert.deepEqual(events.map((event) => event.type), ["hello", "notice"]);
  assert.equal((events[1] as any).text, "after");
});

test("framing: a line over the 16 MiB cap is discarded as a protocol-error and the next line parses", async () => {
  const fake = fakeChild();
  const client = new SidecarClient(fake.child);
  const events: SidecarEvent[] = [];
  const problems: string[] = [];
  client.on("event", (event) => events.push(event)).on("protocol-error", (message) => problems.push(message));
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  for (let sent = 0; sent <= ACP_MAX_CHILD_LINE_BYTES; sent += chunk.length) fake.stdout.write(chunk);
  fake.stdout.write("\n");
  await fake.say({ type: "notice", text: "still here" });
  await waitUntil(() => events.length === 1, 30_000);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /longer than 16777216 bytes/);
});

test("stderr is kept (last 64 KiB) for the embedder and never written anywhere", async () => {
  const fake = fakeChild();
  const client = new SidecarClient(fake.child);
  fake.stderr.write("first ");
  fake.stderr.write(Buffer.alloc(70_000, 0x62));
  fake.stderr.write(" last");
  await tick();
  assert.equal(Buffer.byteLength(client.stderrTail), 64 * 1024);
  assert.ok(client.stderrTail.endsWith("b last"));
  assert.equal(client.stderrTail.includes("first"), false);
});

test("prompt resolves on its own turn.result, ignores another id, and writes one versioned prompt.submit", async () => {
  const fake = fakeChild();
  const client = new SidecarClient(fake.child);
  let settled: any;
  const pending = client.prompt("do it").then((event) => (settled = event));
  await tick();
  assert.deepEqual(fake.commands(), [{ v: 1, type: "prompt.submit", id: "lib-1", text: "do it" }]);
  await fake.say(turnResult("someone-else"));
  await fake.say({ type: "error", id: "someone-else", code: "INTERNAL", message: "not ours" });
  assert.equal(settled, undefined);
  await fake.say(turnResult("lib-1", "UNVERIFIED"));
  await pending;
  assert.equal(settled.turn.outcome, "UNVERIFIED", "the result is returned whatever the outcome");
  // The client is free again, with a new id.
  const second = client.prompt("again");
  await tick();
  await fake.say(turnResult("lib-2"));
  assert.equal((await second).turn_id, "lib-2");
});

test("an error event with the prompt's id rejects it with the sidecar's code", async () => {
  const fake = fakeChild();
  const client = new SidecarClient(fake.child);
  const failure = client.prompt("x").catch((error) => error);
  await tick();
  await fake.say({ type: "error", id: "lib-1", code: "NO_PROVIDER", message: "nothing answers" });
  const error = await failure;
  assert.ok(isClientError("NO_PROVIDER")(error), String(error));
  assert.match(error.message, /nothing answers/);
  // The client is free again after a refused prompt.
  const next = client.prompt("y");
  await tick();
  await fake.say(turnResult("lib-2"));
  await next;
});

test("a second prompt while one runs rejects BUSY and writes nothing", async () => {
  const fake = fakeChild();
  const client = new SidecarClient(fake.child);
  const first = client.prompt("one");
  await assert.rejects(client.prompt("two"), isClientError("BUSY"));
  await tick();
  assert.equal(fake.commands().length, 1);
  await fake.say(turnResult("lib-1"));
  await first;
});

test("approvals: denied without a handler; approved once, never always, only on the handler's exact \"approve\"", async () => {
  const fake = fakeChild();
  const client = new SidecarClient(fake.child);

  // No handler: deny.
  const first = client.prompt("one");
  await tick();
  await fake.say(approvalRequest("approval-1", "lib-1"));
  await tick();
  assert.deepEqual(fake.commands().at(-1), { v: 1, type: "deny", id: "approval-1" });
  await fake.say(turnResult("lib-1"));
  await first;

  // An approval request outside any prompt is denied too.
  await fake.say(approvalRequest("approval-stray", "x"));
  await tick();
  assert.deepEqual(fake.commands().at(-1), { v: 1, type: "deny", id: "approval-stray" });

  // Whatever a handler returns or does, the answer is approve-once or deny.
  const answers: unknown[] = ["approve", "deny", "always", "approve-always", "APPROVE", true, 1, null, undefined, { type: "approve", always: true }, { always: true }, ["approve"], "throw", "reject"];
  let n = 1;
  for (const answer of answers) {
    const id = `lib-${++n}`;
    const seen: string[] = [];
    const run = client.prompt("p", {
      onApproval: ((request: { id: string }) => {
        seen.push(request.id);
        if (answer === "throw") throw new Error("handler broke");
        if (answer === "reject") return Promise.reject(new Error("handler rejected"));
        return answer;
      }) as any,
    });
    await tick();
    await fake.say(approvalRequest(`a-${n}`, id));
    await tick();
    assert.deepEqual(seen, [`a-${n}`]);
    const expected = answer === "approve" ? { v: 1, type: "approve", id: `a-${n}`, always: false } : { v: 1, type: "deny", id: `a-${n}` };
    assert.deepEqual(fake.commands().at(-1), expected, `handler answer ${JSON.stringify(answer)}`);
    await fake.say(turnResult(id));
    await run;
  }
  const approvals = fake.commands().filter((command) => command.type === "approve");
  assert.equal(approvals.length, 1);
  assert.ok(approvals.every((command) => command.always === false));
  assert.equal(/"always"\s*:\s*true/.test(fake.raw()), false, "no line the client wrote carries allow-always");
});

test("a checkpoint choice is never made for the embedder: the turn is cancelled", async () => {
  const fake = fakeChild();
  const client = new SidecarClient(fake.child);
  const turn = client.prompt("x", { onApproval: () => "approve" });
  await tick();
  await fake.say({ type: "checkpoint.choice.request", id: "checkpoint-choice-1", turn_id: "lib-1", message: "Sensitive content blocked the checkpoint." });
  assert.deepEqual(fake.commands().at(-1), { v: 1, type: "cancel" });
  assert.equal(fake.commands().some((command) => command.type === "checkpoint.choice"), false);
  await fake.say(turnResult("lib-1", "INTERRUPTED"));
  await turn;
});

test("the client has no raw send: its public methods are the documented ones", () => {
  const methods = Object.getOwnPropertyNames(SidecarClient.prototype).filter((name) => name !== "constructor").sort();
  const internal = ["answerApproval", "keepStderr", "nextId", "onExit", "request", "settle", "takeLine", "write"];
  assert.deepEqual(methods.filter((name) => !internal.includes(name)), ["cancel", "hello", "initialize", "off", "on", "pid", "prompt", "receipt", "shutdown", "stderrTail"]);
});

test("a closed or failed child input rejects requests instead of leaving them pending", async () => {
  const closed = fakeChild();
  const closedClient = new SidecarClient(closed.child);
  closed.child.stdin?.end();
  await assert.rejects(closedClient.prompt("closed"), isClientError("CLOSED"));

  const broken = fakeChild();
  const brokenClient = new SidecarClient(broken.child);
  const pending = brokenClient.prompt("broken");
  await tick();
  broken.child.stdin?.destroy(new Error("broken pipe"));
  await assert.rejects(pending, isClientError("CLOSED"));
  await assert.rejects(brokenClient.receipt(), isClientError("CLOSED"));
});

test("closed child output rejects pending requests instead of leaving them pending", async () => {
  const fake = fakeChild();
  const client = new SidecarClient(fake.child);
  const pending = client.prompt("no response");
  await tick();
  fake.stdout.end();
  await assert.rejects(pending, isClientError("CHILD_EXITED"));
  await assert.rejects(client.receipt(), isClientError("CHILD_EXITED"));
});

test("initialize, receipt and cancel write their commands; an aborted signal cancels the turn", async () => {
  const fake = fakeChild();
  const client = new SidecarClient(fake.child);
  const init = client.initialize({ name: "embedder", version: "0.1" });
  await tick();
  assert.deepEqual(fake.commands().at(-1), { v: 1, type: "initialize", id: "lib-1", client: { name: "embedder", version: "0.1" } });
  await fake.say({ type: "initialized", id: "lib-1", protocol: 1, capabilities: [], experimental: [] });
  assert.equal((await init).protocol, 1);

  const receipt = client.receipt();
  await tick();
  assert.deepEqual(fake.commands().at(-1), { v: 1, type: "receipt", id: "lib-2" });
  await fake.say({ type: "receipt", id: "lib-2", sections: [] });
  assert.deepEqual((await receipt).sections, []);

  const abort = new AbortController();
  const turn = client.prompt("long", { signal: abort.signal });
  await tick();
  abort.abort();
  await tick();
  assert.deepEqual(fake.commands().at(-1), { v: 1, type: "cancel" });
  await fake.say(turnResult("lib-3", "INTERRUPTED"));
  assert.equal((await turn).turn_id, "lib-3");

  const already = AbortSignal.abort();
  await assert.rejects(client.prompt("never sent", { signal: already }), isClientError("ABORTED"));
  assert.equal(fake.commands().filter((command) => command.type === "prompt.submit").length, 1);
});

test("the child exiting rejects what is pending, reports exit once, and later calls reject CLOSED", async () => {
  const fake = fakeChild();
  const client = new SidecarClient(fake.child);
  const exits: SidecarExit[] = [];
  client.on("exit", (exit) => exits.push(exit));
  const turn = client.prompt("x").catch((error) => error);
  const receipt = client.receipt().catch((error) => error);
  await tick();
  await fake.exit(1);
  assert.ok(isClientError("CHILD_EXITED")(await turn));
  assert.ok(isClientError("CHILD_EXITED")(await receipt));
  assert.deepEqual(exits, [{ code: 1, signal: null }]);
  await assert.rejects(client.prompt("after"), isClientError("CLOSED"));
  assert.deepEqual(await client.shutdown(), { code: 1, signal: null }, "shutdown after exit resolves with the exit, no timer");
});

test("shutdown writes shutdown, closes stdin and resolves with the exit; it is safe to call twice", async () => {
  const fake = fakeChild();
  const client = new SidecarClient(fake.child);
  const first = client.shutdown();
  const second = client.shutdown();
  assert.equal(first, second);
  await tick();
  assert.deepEqual(fake.commands(), [{ v: 1, type: "shutdown" }]);
  assert.equal((fake.child.stdin as PassThrough).writableEnded, true);
  await fake.exit(0);
  assert.deepEqual(await first, { code: 0, signal: null });
  assert.deepEqual(fake.signals, [], "a sidecar that exits in time is not signalled");
});

test("shutdown escalates to SIGTERM on a real child that ignores the shutdown command, signalling that pid only", { timeout: 120_000 }, async () => {
  // Keeps reading stdin and never acts on it; the parent of the test stays untouched because only child.pid is signalled.
  const child = spawn(process.execPath, ["-e", "process.stdin.on('data', () => {}); process.stdin.on('end', () => {}); setInterval(() => {}, 1000); process.stdout.write('up\\n');"], { stdio: ["pipe", "pipe", "pipe"] });
  const pid = child.pid as number;
  try {
    const client = new SidecarClient(child);
    const problems: string[] = [];
    client.on("protocol-error", (message) => problems.push(message));
    await waitUntil(() => problems.length === 1, 60_000);
    const exit = await client.shutdown({ graceMs: 300 });
    assert.deepEqual(exit, { code: null, signal: "SIGTERM" });
    await waitUntil(() => processGone(pid), 30_000);
  } finally {
    if (!processGone(pid)) process.kill(pid, "SIGKILL");
  }
});

test("shutdown ends with SIGKILL when the child ignores SIGTERM as well", { timeout: 120_000 }, async () => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdin.on('data', () => {}); setInterval(() => {}, 1000); process.stdout.write('up\\n');"], { stdio: ["pipe", "pipe", "pipe"] });
  const pid = child.pid as number;
  try {
    const client = new SidecarClient(child);
    const problems: string[] = [];
    client.on("protocol-error", (message) => problems.push(message));
    await waitUntil(() => problems.length === 1, 60_000);
    const exit = await client.shutdown({ graceMs: 300 });
    assert.deepEqual(exit, { code: null, signal: "SIGKILL" });
    await waitUntil(() => processGone(pid), 30_000);
  } finally {
    if (!processGone(pid)) process.kill(pid, "SIGKILL");
  }
});

test("spawnSidecar rejects, with the stderr tail, when the child exits before hello or never says it", { timeout: 120_000 }, async () => {
  const quits = await spawnSidecar({ workspace: "/nonexistent", sidecarScript: "/nonexistent/sidecar.js" }).catch((error) => error);
  assert.ok(isClientError("CHILD_EXITED")(quits), String(quits));
  assert.match(quits.stderrTail, /Cannot find module/);

  const missing = await spawnSidecar({ workspace: "/nonexistent", node: "/nonexistent/node" }).catch((error) => error);
  assert.ok(isClientError("SPAWN_FAILED")(missing), String(missing));

  const silent = makeRepo({ "silent.mjs": "setInterval(() => {}, 1000);\n" });
  try {
    const started = Date.now();
    const timedOut = await spawnSidecar({ workspace: silent, sidecarScript: `${silent}/silent.mjs`, readyTimeoutMs: 500 }).catch((error) => error);
    assert.ok(isClientError("TIMEOUT")(timedOut), String(timedOut));
    assert.ok(Date.now() - started < 60_000);
  } finally {
    fs.rmSync(silent, { recursive: true, force: true });
  }
});

// A project whose only test fails until math.js is fixed; the scripted model fixes it, runs the tests and completes
// (the recipe of run_json_contract.test.ts).
const FIXABLE_PROJECT = {
  "package.json": JSON.stringify({ name: "lib-fixture", version: "1.0.0", private: true, main: "./math.js", scripts: { test: "env -u NODE_TEST_CONTEXT node --test test/*.test.js" } }),
  "math.js": "exports.add = (a, b) => a - b;\n",
  "test/add.test.js": 'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { add } = require("../math.js");\ntest("adds", () => assert.equal(add(2, 3), 5));\n',
};
const FIX_REPLIES: Reply[] = [
  { kind: "tools", calls: [{ name: "run_command", args: { command: "printf 'exports.add = (a, b) => a + b;\\n' > math.js" } }] },
  { kind: "tools", calls: [{ name: "run_command", args: { command: "npm test" } }] },
  { kind: "tools", calls: [{ name: "task_completed", args: { summary: "Fixed addition" } }] },
  { kind: "text", content: "Done." },
];

/** The environment of a sidecar under test: a throwaway HOME and none of the host's product settings. */
function sidecarEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: `${home}/.config`, XDG_DATA_HOME: `${home}/.local/share`, XDG_STATE_HOME: `${home}/.local/state`, XDG_CACHE_HOME: `${home}/.cache`, GIT_CONFIG_GLOBAL: `${home}/gitconfig` };
  for (const key of Object.keys(env)) if (/^(LOCAL_LLM_|LOCAL_HARNESS_|NEXUS_)/.test(key)) delete env[key];
  delete env.NODE_TEST_CONTEXT;
  return env;
}

async function realTurn(replies: Reply[], onApproval: "approve" | undefined): Promise<{ outcome: string; execution: string; approvals: string[]; written: any[]; math: string; hello: any; receipt: any; exit: SidecarExit }> {
  const gateway = await startGateway((n) => replies[Math.min(n, replies.length) - 1]);
  const repo = makeRepo(FIXABLE_PROJECT);
  const home = makeHome();
  let pid: number | undefined;
  try {
    const client = await spawnSidecar({ workspace: repo, endpoint: gateway.url, model: "m", deliverableFiles: ["math.js"], extraArgs: ["-s", "8", "--no-continuation"], env: sidecarEnv(home), readyTimeoutMs: 120_000 });
    pid = client.pid;
    const written: any[] = [];
    // What actually reached the sidecar's stdin, read from the child's own pipe.
    const stdin = (client as any).child.stdin;
    const write = stdin.write.bind(stdin);
    stdin.write = (chunk: any, ...rest: any[]) => { written.push(...String(chunk).split("\n").filter(Boolean).map((line) => JSON.parse(line))); return write(chunk, ...rest); };
    const approvals: string[] = [];
    const result = await client.prompt("Fix the failing addition test, then complete the task.", {
      onApproval: onApproval ? (request) => { approvals.push(request.tool); return onApproval; } : undefined,
    });
    const receipt = await client.receipt();
    const exit = await client.shutdown({ graceMs: 60_000 });
    return { outcome: result.turn.outcome, execution: result.turn.execution, approvals, written, math: fs.readFileSync(`${repo}/math.js`, "utf8"), hello: client.hello, receipt, exit };
  } finally {
    if (pid !== undefined && !processGone(pid)) process.kill(pid, "SIGKILL");
    await gateway.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("a real sidecar through the lib completes a VERIFIED task, each request approved once and none always", { timeout: 280_000 }, async () => {
  const run = await realTurn(FIX_REPLIES, "approve");
  assert.equal(run.hello.type, "hello");
  assert.equal(run.outcome, "VERIFIED");
  assert.equal(run.math, "exports.add = (a, b) => a + b;\n");
  const approves = run.written.filter((command) => command.type === "approve");
  // The model's two commands, and the verifier the sidecar found (npm test), which it runs before the first change.
  assert.deepEqual(run.approvals, ["run_command", "verifier", "run_command"], "one request per call: an approval never carried over to the next");
  assert.equal(approves.length, 3);
  assert.ok(approves.every((command) => command.always === false), "approve-once only");
  assert.equal(run.written.some((command) => command.always === true), false);
  assert.equal(run.receipt.type, "receipt");
  assert.deepEqual(run.exit, { code: 0, signal: null });
});

test("the same project with no approval handler: the command is denied, nothing is changed and the turn is not VERIFIED", { timeout: 280_000 }, async () => {
  const run = await realTurn([FIX_REPLIES[0], { kind: "text", content: "The command was not allowed." }], undefined);
  assert.notEqual(run.outcome, "VERIFIED");
  assert.equal(run.math, "exports.add = (a, b) => a - b;\n", "the denied command did not run");
  assert.ok(run.written.some((command) => command.type === "deny"));
  assert.equal(run.written.some((command) => command.type === "approve"), false);
  assert.deepEqual(run.exit, { code: 0, signal: null });
});
