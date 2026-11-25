import "./helpers/leak_guard.js";
import { trackResource } from "./helpers/leak_guard.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOCKET_ATTACH_TIMEOUT_MS, SOCKET_MAX_CONNECTIONS, SOCKET_MAX_LINE_BYTES, SOCKET_MAX_PREAUTH, SessionSocketServer, type SocketSession,
} from "../src/session_socket.js";
import { newToken, readDescriptor, realpathAllowingMissing, socketRuntimeDir, socketRuntimeDirPath, sweepStaleSockets, tokenMatches } from "../src/core/socket_files.js";

const REFUSAL = '{"v":1,"type":"error","code":"UNAUTHORIZED","message":"attach refused"}\n';
const scratch: string[] = [];
const clients = new Set<net.Socket>();
const servers: SessionSocketServer[] = [];

after(async () => {
  for (const client of clients) client.destroy();
  for (const server of servers) await server.close();
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sock-"));
  scratch.push(dir);
  return dir;
}

test("the planned socket runtime path is side-effect-free and follows the runtime directory policy", () => {
  const runtime = tmp();
  const expected = path.join(runtime, "nexus");
  assert.equal(socketRuntimeDirPath({ XDG_RUNTIME_DIR: runtime } as NodeJS.ProcessEnv), expected);
  assert.equal(fs.existsSync(expected), false, "planning the path must not create the socket directory");
  const uid = typeof process.geteuid === "function" ? process.geteuid() : -1;
  assert.equal(socketRuntimeDirPath({}, uid), path.join("/tmp", `nexus-sockets-${uid}`));
  assert.equal(socketRuntimeDirPath({ XDG_RUNTIME_DIR: "relative" } as NodeJS.ProcessEnv, uid), path.join("/tmp", `nexus-sockets-${uid}`));
});

test("a planned missing socket path resolves existing symlink parents before containment checks", () => {
  const root = tmp();
  const real = path.join(root, "real");
  fs.mkdirSync(real, { mode: 0o700 });
  const link = path.join(root, "runtime-link");
  fs.symlinkSync(real, link, "dir");
  const planned = path.join(link, "not-created", "nexus");
  assert.equal(realpathAllowingMissing(planned), path.join(real, "not-created", "nexus"));
  assert.equal(fs.existsSync(path.join(real, "not-created")), false, "resolving the planned path must not create it");
});

/** The sidecar stand-in: records what the hub forwards. */
class FakeSession implements SocketSession {
  forwarded: string[] = [];
  mayDrive = true;
  socketMayDriveTurns(): boolean { return this.mayDrive; }
  async handleLine(line: string): Promise<void> { this.forwarded.push(line); }
  attachSnapshot() {
    return {
      common: ['{"v":1,"type":"hello","protocol":1}\n', '{"v":1,"type":"session.state","busy":false}\n'],
      controller: ['{"v":1,"type":"approval.request","id":"approval-1"}\n'],
    };
  }
}

interface Rig { server: SessionSocketServer; session: FakeSession; dir: string; socket: string; token: string; descriptor: string }

async function rig(options: { attachTimeoutMs?: number; name?: string } = {}): Promise<Rig> {
  const dir = socketRuntimeDir({ XDG_RUNTIME_DIR: tmp() } as NodeJS.ProcessEnv);
  const session = new FakeSession();
  const server = new SessionSocketServer({ session, dir, ...options });
  servers.push(server);
  trackResource("session socket server", dir, () => fs.existsSync(path.join(dir)) && (server as any).server.listening, () => server.close());
  const info = await server.listen();
  return { server, session, dir, socket: info.socket, descriptor: info.descriptor, token: readDescriptor(info.descriptor).token };
}

class Client {
  lines: string[] = [];
  private buffer = "";
  ended = false;
  constructor(public readonly socket: net.Socket) {
    clients.add(socket);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let at: number;
      while ((at = this.buffer.indexOf("\n")) >= 0) { this.lines.push(this.buffer.slice(0, at + 1)); this.buffer = this.buffer.slice(at + 1); }
    });
    socket.on("close", () => { this.ended = true; });
    socket.on("error", () => { this.ended = true; });
  }
  send(text: string): void { this.socket.write(text.endsWith("\n") ? text : `${text}\n`); }
  async until(test: () => boolean, what: string, ms = 3000): Promise<void> {
    const start = Date.now();
    while (!test()) {
      if (Date.now() - start > ms) assert.fail(`timed out waiting for ${what}; got ${JSON.stringify(this.lines)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  async closed(): Promise<void> { await this.until(() => this.ended, "the connection to close"); }
  parsed(): any[] { return this.lines.map((l) => JSON.parse(l)); }
}

async function connect(socketPath: string): Promise<Client> {
  const socket = net.connect({ path: socketPath });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  return new Client(socket);
}

const attachLine = (token: string, role: "control" | "observe" = "control", extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, type: "attach", id: "a1", token, role, ...extra });

async function attached(r: Rig, role: "control" | "observe"): Promise<Client> {
  const client = await connect(r.socket);
  client.send(attachLine(r.token, role));
  await client.until(() => client.lines.length >= 3, "attached, hello and session.state");
  assert.equal(client.parsed()[0].type, "attached");
  return client;
}

/** A refused client gets exactly the one refusal line, then the connection ends, and the session saw nothing. */
async function assertRefused(r: Rig, client: Client, why: string): Promise<void> {
  await client.closed();
  assert.deepEqual(client.lines, [REFUSAL], why);
  assert.deepEqual(r.session.forwarded, [], `${why}: nothing reached the session`);
}

// ------------------------------------------------------------------ acceptance: modes

test("the socket is mode 0600, its directory 0700, the descriptor 0600 and owned by this user", async () => {
  const r = await rig();
  const socketStat = fs.lstatSync(r.socket);
  assert.ok(socketStat.isSocket());
  assert.equal(socketStat.mode & 0o777, 0o600);
  assert.equal(fs.lstatSync(r.dir).mode & 0o777, 0o700);
  const descriptorStat = fs.lstatSync(r.descriptor);
  assert.equal(descriptorStat.mode & 0o777, 0o600);
  assert.equal(descriptorStat.uid, process.geteuid!());
  assert.equal(socketStat.uid, process.geteuid!());
  const descriptor = readDescriptor(r.descriptor);
  assert.match(descriptor.token, /^[0-9a-f]{64}$/);
  assert.equal(descriptor.socket, r.socket);
});

test("every server start has its own token, and it is never in the listening info", async () => {
  const a = await rig();
  const b = await rig();
  assert.notEqual(a.token, b.token);
  assert.doesNotMatch(JSON.stringify({ socket: a.socket, descriptor: a.descriptor }), new RegExp(a.token));
});

// ------------------------------------------------------------------ acceptance: wrong token

test("a wrong token is refused with one fixed line, nothing else is sent, and the server keeps serving", async () => {
  const r = await rig();
  const bad = await connect(r.socket);
  bad.send(attachLine(newToken()));
  await assertRefused(r, bad, "wrong token");
  const good = await attached(r, "control");
  assert.equal(good.parsed()[0].role, "control");
});

test("missing, empty, short, long, upper-case, non-hex and non-string tokens are all refused alike", async () => {
  const r = await rig();
  const variants: Array<[string, unknown]> = [
    ["empty", ""], ["63 chars", r.token.slice(1)], ["63-char prefix", r.token.slice(0, 63)], ["1-char prefix", r.token.slice(0, 1)], ["65 chars", `${r.token}0`], ["upper-case", r.token.toUpperCase()],
    ["non-hex", "z".repeat(64)], ["number", 5], ["null", null], ["array", [r.token]], ["token plus padding", `${r.token} `],
  ];
  for (const [name, token] of variants) {
    const client = await connect(r.socket);
    client.send(JSON.stringify({ v: 1, type: "attach", id: "a1", token, role: "control" }));
    await assertRefused(r, client, name);
  }
  const missing = await connect(r.socket);
  missing.send(JSON.stringify({ v: 1, type: "attach", id: "a1", role: "control" }));
  await assertRefused(r, missing, "missing token");
});

test("a malformed attach is refused like a wrong token: bad role, no id, bad version, not JSON, not an object", async () => {
  const r = await rig();
  const lines = [
    JSON.stringify({ v: 1, type: "attach", id: "a1", token: r.token, role: "admin" }),
    JSON.stringify({ v: 1, type: "attach", token: r.token, role: "control" }),
    JSON.stringify({ v: 2, type: "attach", id: "a1", token: r.token, role: "control" }),
    JSON.stringify({ v: 1, type: "attach", id: "a1", token: r.token }),
    "not json", "[]", "null", "7",
  ];
  for (const line of lines) {
    const client = await connect(r.socket);
    client.send(line);
    await assertRefused(r, client, line);
  }
});

test("a token sent after a first command is refused: the first line decides, and is never run as a command", async () => {
  const r = await rig();
  const client = await connect(r.socket);
  client.send(JSON.stringify({ v: 1, type: "prompt.submit", id: "p1", text: "hi" }));
  client.send(attachLine(r.token));
  await assertRefused(r, client, "command before attach");
  const second = await connect(r.socket);
  second.send(JSON.stringify({ v: 1, type: "shutdown" }));
  await assertRefused(r, second, "shutdown before attach");
  // Even with the right token and a role inside it, a line that is not an attach is not an attach.
  const third = await connect(r.socket);
  third.send(JSON.stringify({ v: 1, type: "prompt.submit", id: "p1", text: "hi", token: r.token, role: "control" }));
  await assertRefused(r, third, "command carrying the token");
});

test("a connection that never attaches is refused after the deadline", async () => {
  const r = await rig({ attachTimeoutMs: 80 });
  const client = await connect(r.socket);
  await assertRefused(r, client, "silence");
});

test("an oversized line before attach is refused: complete, and unterminated", async () => {
  const r = await rig();
  const complete = await connect(r.socket);
  complete.send(attachLine(r.token, "control", { pad: "x".repeat(5000) }));
  await assertRefused(r, complete, "long attach line");
  const partial = await connect(r.socket);
  partial.socket.write("x".repeat(5000));
  await assertRefused(r, partial, "long unterminated line");
});

// ------------------------------------------------------------------ roles

test("a second client attaches to a running session: it gets attached, hello and state, and live events", async () => {
  const r = await rig();
  const controller = await attached(r, "control");
  const observer = await attached(r, "observe");
  assert.deepEqual(observer.parsed().map((e) => e.type), ["attached", "hello", "session.state"], "an observer is not shown the approval prompt");
  assert.deepEqual(controller.parsed().map((e) => e.type), ["attached", "hello", "session.state", "approval.request"]);
  r.server.broadcast('{"v":1,"type":"assistant.delta","text":"hi"}\n');
  await observer.until(() => observer.lines.length === 4, "the broadcast");
  await controller.until(() => controller.lines.length === 5, "the broadcast");
  assert.equal(observer.parsed()[3].type, "assistant.delta");
});

test("a second controller is refused while one is attached, and may attach after the first disconnects", async () => {
  const r = await rig();
  const first = await attached(r, "control");
  const second = await connect(r.socket);
  second.send(attachLine(r.token, "control"));
  await second.closed();
  assert.equal(second.parsed()[0].code, "BUSY");
  assert.equal(second.lines.length, 1);
  const observer = await attached(r, "observe");
  assert.ok(observer.lines.length >= 3, "an observer may attach beside the controller");
  first.socket.destroy();
  await first.closed();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const again = await attached(r, "control");
  assert.equal(again.parsed()[3].type, "approval.request", "the new controller is shown the pending approval");
});

test("an observer sending a state-changing command gets NOT_CONTROLLER and nothing is forwarded", async () => {
  const r = await rig();
  const observer = await attached(r, "observe");
  for (const line of [
    { type: "approve", id: "approval-1", always: false }, { type: "deny", id: "approval-1" },
    { type: "prompt.submit", id: "p1", text: "x" }, { type: "cancel" }, { type: "shutdown" },
    { type: "slash", id: "s1", command: "/status", args: "" },
  ]) observer.send(JSON.stringify({ v: 1, ...line }));
  await observer.until(() => observer.lines.length === 3 + 6, "six refusals");
  assert.deepEqual(observer.parsed().slice(3).map((e) => e.code), Array(6).fill("NOT_CONTROLLER"));
  assert.deepEqual(r.session.forwarded, []);
  assert.equal(observer.ended, false, "an observer that asks too much is told, not dropped");
});

test("approve once is forwarded; allow-always, auto mode and every authority-raising command are not", async () => {
  const r = await rig();
  const controller = await attached(r, "control");
  controller.send(JSON.stringify({ v: 1, type: "approve", id: "approval-1", always: false }));
  await controller.until(() => r.session.forwarded.length === 1, "approve once to be forwarded");
  const refused = [
    { type: "approve", id: "approval-1", always: true },
    { type: "slash", id: "s1", command: "/mode", args: "auto" },
    { type: "slash", id: "s2", command: "!ls", args: "" },
    { type: "slash", id: "s3", command: "/cd", args: "/" },
    { type: "provider.connect", id: "p1", provider: "x", method: "api-key", key: "sk-secret" },
    { type: "provider.disconnect", id: "p2", provider: "x" },
    { type: "answer", id: "q1", question: "0123456789ab", option: "approve" },
    { type: "checkpoint.choice", id: "k1", choice: "allow_sensitive" },
    { type: "model.select", id: "m1", provider: "x", model: "y" },
    { type: "models.list", id: "m2" },
    { type: "shutdown" },
  ];
  for (const line of refused) controller.send(JSON.stringify({ v: 1, ...line }));
  await controller.until(() => controller.lines.length === 4 + refused.length, "a refusal for each");
  assert.deepEqual(controller.parsed().slice(4).map((e) => e.code), Array(refused.length).fill("NOT_PERMITTED"));
  assert.equal(r.session.forwarded.length, 1, "nothing but the one approve was forwarded");
});

test("a controller's turn commands and read-only lookups are forwarded unchanged", async () => {
  const r = await rig();
  const controller = await attached(r, "control");
  const lines = [
    { type: "prompt.submit", id: "p1", text: "hello" }, { type: "steer", id: "st1", text: "left" }, { type: "cancel" },
    { type: "deny", id: "approval-1" }, { type: "receipt", id: "r1" }, { type: "tool.detail", id: "d1", evidence: "e1" },
  ].map((l) => JSON.stringify({ v: 1, ...l }));
  for (const line of lines) controller.send(line);
  await controller.until(() => r.session.forwarded.length === lines.length, "all forwarded");
  assert.deepEqual(r.session.forwarded, lines);
});

test("initialize is answered per connection and never forwarded; a second one is BAD_REQUEST", async () => {
  const r = await rig();
  const controller = await attached(r, "control");
  const observer = await attached(r, "observe");
  const init = JSON.stringify({ v: 1, type: "initialize", id: "i1", client: { name: "t", version: "1" } });
  controller.send(init);
  observer.send(init);
  await controller.until(() => controller.parsed().some((e) => e.type === "initialized"), "initialized");
  await observer.until(() => observer.parsed().some((e) => e.type === "initialized"), "initialized");
  controller.send(init);
  await controller.until(() => controller.parsed().some((e) => e.code === "BAD_REQUEST"), "BAD_REQUEST");
  assert.deepEqual(r.session.forwarded, []);
});

test("a bad command line gets BAD_REQUEST to its sender alone", async () => {
  const r = await rig();
  const controller = await attached(r, "control");
  const observer = await attached(r, "observe");
  controller.send("{nope");
  await controller.until(() => controller.parsed().some((e) => e.code === "BAD_REQUEST"), "BAD_REQUEST");
  assert.equal(observer.lines.length, 3);
  controller.send(attachLine(r.token, "control"));
  await controller.until(() => controller.parsed().filter((e) => e.code === "BAD_REQUEST").length === 2, "attach after attach is BAD_REQUEST");
});

// ------------------------------------------------------------------ limits

test("oversized lines after attach get BAD_REQUEST, the third closes the connection, and the server lives on", async () => {
  const r = await rig();
  const controller = await attached(r, "control");
  const big = `${"x".repeat(SOCKET_MAX_LINE_BYTES + 1)}\n`;
  controller.socket.write(big);
  await controller.until(() => controller.parsed().some((e) => e.code === "BAD_REQUEST"), "first BAD_REQUEST", 10000);
  controller.socket.write(big);
  controller.socket.write(big);
  await controller.closed();
  assert.equal(controller.parsed().filter((e) => e.code === "BAD_REQUEST").length >= 2, true);
  assert.deepEqual(r.session.forwarded, []);
  const next = await attached(r, "control");
  assert.equal(next.parsed()[0].type, "attached");
});

test("the ninth connection is told BUSY and closed", async () => {
  const r = await rig();
  for (let i = 0; i < SOCKET_MAX_CONNECTIONS; i++) await attached(r, "observe");
  const extra = await connect(r.socket);
  await extra.closed();
  assert.equal(extra.parsed()[0].code, "BUSY");
  assert.equal(r.server.connectionCount, SOCKET_MAX_CONNECTIONS);
});

test("idle unauthenticated connections cannot fill the table: past four, a connection is told BUSY, and a real attach still works", async () => {
  const r = await rig({ attachTimeoutMs: 5000 });
  const idle: Client[] = [];
  for (let i = 0; i < SOCKET_MAX_PREAUTH; i++) idle.push(await connect(r.socket));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const extra = await connect(r.socket);
  await extra.closed();
  assert.equal(extra.parsed()[0].code, "BUSY");
  // The idle ones are not drained: one of them attaching still works, and frees its pre-auth slot.
  idle[0].send(attachLine(r.token, "control"));
  await idle[0].until(() => idle[0].lines.length >= 3, "an idle connection to attach");
  assert.equal(idle[0].parsed()[0].type, "attached");
  const next = await connect(r.socket);
  next.send(attachLine(r.token, "observe"));
  await next.until(() => next.lines.length >= 3, "a new attach after a slot freed");
});

test("the default pre-attach deadline is two seconds", () => {
  assert.equal(SOCKET_ATTACH_TIMEOUT_MS, 2000);
  assert.equal(SOCKET_MAX_PREAUTH, 4);
});

test("while the session approves everything, prompt and steer are NOT_PERMITTED; cancel, deny and reads still work", async () => {
  const r = await rig();
  const controller = await attached(r, "control");
  r.session.mayDrive = false;
  controller.send(JSON.stringify({ v: 1, type: "prompt.submit", id: "p1", text: "run" }));
  controller.send(JSON.stringify({ v: 1, type: "steer", id: "s1", text: "go left" }));
  await controller.until(() => controller.lines.length === 4 + 2, "two refusals");
  assert.deepEqual(controller.parsed().slice(4).map((e) => e.code), ["NOT_PERMITTED", "NOT_PERMITTED"]);
  assert.deepEqual(r.session.forwarded, []);
  for (const line of [{ type: "cancel" }, { type: "deny", id: "approval-1" }, { type: "receipt", id: "r1" }]) controller.send(JSON.stringify({ v: 1, ...line }));
  await controller.until(() => r.session.forwarded.length === 3, "cancel, deny and receipt to be forwarded");
  r.session.mayDrive = true;
  controller.send(JSON.stringify({ v: 1, type: "prompt.submit", id: "p2", text: "run" }));
  await controller.until(() => r.session.forwarded.length === 4, "prompt forwarded again");
});

// ------------------------------------------------------------------ directories and paths

test("listen refuses a caller-supplied directory that others can enter, and binds nothing in it (bind-then-chmod window)", async () => {
  const open = tmp();
  fs.chmodSync(open, 0o755);
  const server = new SessionSocketServer({ session: new FakeSession(), dir: open });
  servers.push(server);
  await assert.rejects(() => server.listen(), /private directory/);
  assert.deepEqual(fs.readdirSync(open), [], "nothing was bound or written in the open directory");
});

test("a runtime directory that is not private to this user is refused, never repaired or replaced", () => {
  const open = tmp();
  fs.chmodSync(open, 0o755);
  assert.throws(() => socketRuntimeDir({ XDG_RUNTIME_DIR: open } as NodeJS.ProcessEnv), /private directory/);
  const parent = tmp();
  const nexus = path.join(parent, "nexus");
  fs.mkdirSync(nexus, { mode: 0o755 });
  fs.chmodSync(nexus, 0o755);
  assert.throws(() => socketRuntimeDir({ XDG_RUNTIME_DIR: parent } as NodeJS.ProcessEnv), /private directory/);
  assert.equal(fs.lstatSync(nexus).mode & 0o777, 0o755, "left as found");
  const group = tmp();
  fs.chmodSync(group, 0o770);
  assert.throws(() => socketRuntimeDir({ XDG_RUNTIME_DIR: group } as NodeJS.ProcessEnv), /private directory/);
});

test("a symlinked runtime directory is refused", () => {
  const real = tmp();
  const parent = tmp();
  fs.symlinkSync(real, path.join(parent, "nexus"));
  assert.throws(() => socketRuntimeDir({ XDG_RUNTIME_DIR: parent } as NodeJS.ProcessEnv), /private directory/);
  const link = path.join(tmp(), "runtime");
  fs.symlinkSync(real, link);
  assert.throws(() => socketRuntimeDir({ XDG_RUNTIME_DIR: link } as NodeJS.ProcessEnv), /private directory/);
});

test("a directory that another user owns is refused (the ownership check, with a stand-in uid)", () => {
  const parent = tmp();
  // We cannot chown without root: ask for a directory as if we were another uid, which must fail the same check.
  assert.throws(() => socketRuntimeDir({ XDG_RUNTIME_DIR: parent } as NodeJS.ProcessEnv, process.geteuid!() + 1), /private directory/);
});

for (const [name, make] of [
  ["a symlink", (target: string) => fs.symlinkSync("/etc/hostname", target)],
  ["a regular file", (target: string) => fs.writeFileSync(target, "precious")],
  ["a directory", (target: string) => fs.mkdirSync(target)],
] as const) {
  test(`${name} already at the socket path is refused and left alone`, async () => {
    const dir = socketRuntimeDir({ XDG_RUNTIME_DIR: tmp() } as NodeJS.ProcessEnv);
    const target = path.join(dir, "s-0123456789abcdef.sock");
    make(target);
    const before = fs.lstatSync(target);
    const server = new SessionSocketServer({ session: new FakeSession(), dir, name: "s-0123456789abcdef" });
    servers.push(server);
    await assert.rejects(server.listen(), /not a socket owned by this user/);
    const after = fs.lstatSync(target);
    assert.equal(after.ino, before.ino);
    assert.equal(after.isSymbolicLink(), before.isSymbolicLink());
    if (name === "a regular file") assert.equal(fs.readFileSync(target, "utf8"), "precious");
    assert.equal(fs.existsSync(path.join(dir, "s-0123456789abcdef.json")), false, "no descriptor was written");
  });
}

test("a stale socket is replaced, and a live listener's socket is not", async () => {
  const dir = socketRuntimeDir({ XDG_RUNTIME_DIR: tmp() } as NodeJS.ProcessEnv);
  const name = "s-aaaaaaaaaaaaaaaa";
  const target = path.join(dir, `${name}.sock`);
  // A stale socket is what a killed server leaves behind: bind in a child, kill it without cleanup.
  const child = spawn(process.execPath, ["-e", `require("net").createServer().listen({path:${JSON.stringify(target)}},()=>console.log("up"));setInterval(()=>{},1000)`], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  assert.ok(fs.lstatSync(target).isSocket(), "the dead child left its socket file");
  const server = new SessionSocketServer({ session: new FakeSession(), dir, name });
  servers.push(server);
  await server.listen();
  assert.ok(await connect(target));
  // A second server on the same live path must be refused and must not unlink it.
  const rival = new SessionSocketServer({ session: new FakeSession(), dir, name });
  servers.push(rival);
  await assert.rejects(rival.listen(), /live listener/);
  assert.ok(fs.lstatSync(target).isSocket());
  assert.ok(await connect(target), "the first server still serves");
});

test("a sweep at start removes dead sockets and leaves live ones, files and foreign names alone", async () => {
  const dir = socketRuntimeDir({ XDG_RUNTIME_DIR: tmp() } as NodeJS.ProcessEnv);
  const live = await rig();
  const deadName = path.join(dir, "s-bbbbbbbbbbbbbbbb.sock");
  const child = spawn(process.execPath, ["-e", `require("net").createServer().listen({path:${JSON.stringify(deadName)}},()=>console.log("up"));setInterval(()=>{},1000)`], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  fs.writeFileSync(path.join(dir, "s-cccccccccccccccc.sock"), "a file named like a socket");
  fs.writeFileSync(path.join(dir, "notes.txt"), "keep");
  assert.equal(await sweepStaleSockets(dir), 1);
  assert.equal(fs.existsSync(deadName), false);
  assert.equal(fs.readFileSync(path.join(dir, "s-cccccccccccccccc.sock"), "utf8"), "a file named like a socket");
  assert.equal(fs.readFileSync(path.join(dir, "notes.txt"), "utf8"), "keep");
  assert.ok(fs.existsSync(live.socket), "the live socket is not touched");
});

test("close removes the socket and descriptor, refuses new connections, and drops attached clients", async () => {
  const r = await rig();
  const controller = await attached(r, "control");
  await r.server.close();
  assert.equal(fs.existsSync(r.socket), false);
  assert.equal(fs.existsSync(r.descriptor), false);
  await controller.closed();
  await assert.rejects(connect(r.socket));
  await r.server.close(); // twice is fine
});

// ------------------------------------------------------------------ units

test("tokenMatches accepts only the exact token", () => {
  const token = newToken();
  assert.equal(tokenMatches(token, token), true);
  assert.equal(tokenMatches(token, newToken()), false);
  assert.equal(tokenMatches(token, token.toUpperCase()), false);
  assert.equal(tokenMatches(token, token.slice(1)), false);
  assert.equal(tokenMatches(token, ""), false);
  assert.equal(tokenMatches(token, undefined), false);
  assert.equal(tokenMatches(token, { toString: () => token }), false);
});

test("no network listener: the transport binds a filesystem path only", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  for (const file of ["../src/session_socket.ts", "../src/core/socket_files.ts"]) {
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    const listens = source.split("\n").filter((line) => /\.listen\(/.test(line) && !/^\s*(\/\/|\*)/.test(line));
    for (const line of listens) assert.match(line, /\{ path: /, `${file}: ${line.trim()}`);
    assert.doesNotMatch(source, /\bhost\s*:|\bport\s*:|0\.0\.0\.0|127\.0\.0\.1|localhost|node:(http|https|http2|dgram)|"ws"/, file);
  }
});
