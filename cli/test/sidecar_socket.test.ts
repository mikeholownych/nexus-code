import "./helpers/leak_guard.js";
import { trackResource } from "./helpers/leak_guard.js";
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ApplicationCore } from "../src/core/app.js";
import { SidecarServer } from "../src/sidecar.js";
import { SessionSocketServer } from "../src/session_socket.js";
import { readDescriptor, socketRuntimeDir } from "../src/core/socket_files.js";
import { startGateway, makeRepo, makeHome, waitUntil, type Reply } from "./helpers/fixtures.js";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch: string[] = [];
const clients = new Set<net.Socket>();
const closers: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const client of clients) client.destroy();
  for (const close of closers) await close();
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});
const tmpdir = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sock-")); scratch.push(d); return d; };

class Client {
  lines: string[] = [];
  private buffer = "";
  ended = false;
  constructor(readonly socket: net.Socket) {
    clients.add(socket);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let at: number;
      while ((at = this.buffer.indexOf("\n")) >= 0) { this.lines.push(this.buffer.slice(0, at)); this.buffer = this.buffer.slice(at + 1); }
    });
    socket.on("close", () => { this.ended = true; });
    socket.on("error", () => { this.ended = true; });
  }
  get events(): any[] { return this.lines.map((l) => JSON.parse(l)); }
  send(message: Record<string, unknown>): void { this.socket.write(`${JSON.stringify({ v: 1, ...message })}\n`); }
  async until(test: (events: any[]) => boolean, what: string, ms = 20000): Promise<void> {
    const start = Date.now();
    while (!test(this.events)) {
      if (Date.now() - start > ms) assert.fail(`timed out waiting for ${what}; got ${this.lines.map((l) => l.slice(0, 120)).join("\n")}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }
}

async function attach(socketPath: string, token: string, role: "control" | "observe"): Promise<Client> {
  const socket = net.connect({ path: socketPath });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const client = new Client(socket);
  client.send({ type: "attach", id: "a1", token, role });
  await client.until((e) => e.some((x) => x.type === "session.state"), "attach to complete");
  return client;
}

// ------------------------------------------------------------------ in process: a real SidecarServer behind the hub

const writeTurn = (n: number): Reply => n === 1
  ? { kind: "tools", calls: [{ name: "write_file", args: { path: "x.txt", content: "hi" } }] }
  : { kind: "text", content: "ok" };

async function withHub(script: (n: number) => Reply, fn: (rig: { repo: string; server: SidecarServer; hub: SessionSocketServer; socket: string; token: string; stdio: any[] }) => Promise<void>): Promise<void> {
  const gw = await startGateway(script);
  const repo = makeRepo();
  const home = makeHome();
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash", approvalMode: "review" } as any);
  const stdio: any[] = [];
  let hub: SessionSocketServer | undefined;
  const server = new SidecarServer({ app, mode: "review", write: (line) => { stdio.push(JSON.parse(line)); hub?.broadcast(line); } });
  hub = new SessionSocketServer({ session: server, dir: socketRuntimeDir({ XDG_RUNTIME_DIR: tmpdir() } as NodeJS.ProcessEnv) });
  trackResource("session socket server", "sidecar_socket", () => (hub as any).server.listening, () => hub!.close());
  server.start();
  const info = await hub.listen();
  try {
    await fn({ repo, server, hub, socket: info.socket, token: readDescriptor(info.descriptor).token, stdio });
  } finally {
    await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
    await server.idle();
    await hub.close();
    app.shutdown();
    await gw.close();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("a live session behind the socket", () => {
  test("a second client attaches mid-turn and sees the same turn finish", async () => {
    await withHub((n) => n === 1 ? { kind: "text", content: "done", delayMs: 600 } : { kind: "text", content: "done" }, async ({ socket, token, server }) => {
      const controller = await attach(socket, token, "control");
      controller.send({ type: "prompt.submit", id: "t1", text: "go" });
      await controller.until((e) => e.some((x) => x.type === "session.state" && x.busy === true), "the turn to start");
      const observer = await attach(socket, token, "observe");
      const state = observer.events.filter((e) => e.type === "session.state").at(-1);
      assert.equal(state.busy, true, "the observer is told the session is busy");
      await observer.until((e) => e.some((x) => x.type === "turn.result"), "the turn result");
      assert.equal(observer.events.find((e) => e.type === "turn.result").turn_id, "t1");
      await controller.until((e) => e.some((x) => x.type === "turn.result"), "the turn result");
      await server.idle();
    });
  });

  test("an observer cannot approve; the approval stays pending and the controller's answer decides", async () => {
    await withHub(writeTurn, async ({ socket, token, repo, server }) => {
      const controller = await attach(socket, token, "control");
      const observer = await attach(socket, token, "observe");
      controller.send({ type: "prompt.submit", id: "t1", text: "make x" });
      await observer.until((e) => e.some((x) => x.type === "approval.request"), "the approval request");
      const id = observer.events.find((e) => e.type === "approval.request").id;
      observer.send({ type: "approve", id, always: false });
      await observer.until((e) => e.some((x) => x.code === "NOT_CONTROLLER"), "NOT_CONTROLLER");
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(fs.existsSync(path.join(repo, "x.txt")), false, "the write did not happen");
      controller.send({ type: "deny", id });
      await server.idle();
      assert.equal(fs.existsSync(path.join(repo, "x.txt")), false);
      await controller.until((e) => e.some((x) => x.type === "turn.result"), "the turn result");
    });
  });

  test("reattach: a pending approval survives the controller leaving and is shown again, with the same id", async () => {
    await withHub(writeTurn, async ({ socket, token, repo, server }) => {
      const first = await attach(socket, token, "control");
      first.send({ type: "prompt.submit", id: "t1", text: "make x" });
      await first.until((e) => e.some((x) => x.type === "approval.request"), "the approval request");
      const id = first.events.find((e) => e.type === "approval.request").id;
      first.socket.destroy();
      await new Promise((r) => setTimeout(r, 100));
      const second = await attach(socket, token, "control");
      await second.until((e) => e.some((x) => x.type === "approval.request" && x.id === id), "the approval request again");
      second.send({ type: "approve", id, always: false });
      await server.idle();
      assert.equal(fs.readFileSync(path.join(repo, "x.txt"), "utf8"), "hi");
    });
  });

  test("allow-always over the socket is refused: the session stays in review, the approval stays open", async () => {
    await withHub(writeTurn, async ({ socket, token, repo, server, stdio }) => {
      const controller = await attach(socket, token, "control");
      controller.send({ type: "prompt.submit", id: "t1", text: "make x" });
      await controller.until((e) => e.some((x) => x.type === "approval.request"), "the approval request");
      const id = controller.events.find((e) => e.type === "approval.request").id;
      controller.send({ type: "approve", id, always: true });
      await controller.until((e) => e.some((x) => x.code === "NOT_PERMITTED"), "NOT_PERMITTED");
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(fs.existsSync(path.join(repo, "x.txt")), false, "nothing was approved");
      assert.equal(stdio.filter((e) => e.type === "session.state").every((e) => e.mode === "review"), true);
      controller.send({ type: "slash", id: "s1", command: "/mode", args: "auto" });
      controller.send({ type: "slash", id: "s2", command: "!touch", args: "pwned" });
      await controller.until((e) => e.filter((x) => x.code === "NOT_PERMITTED").length === 3, "three refusals");
      assert.equal(stdio.filter((e) => e.type === "session.state").every((e) => e.mode === "review"), true, "no mode change");
      assert.equal(fs.existsSync(path.join(repo, "pwned")), false);
      controller.send({ type: "approve", id, always: false });
      await server.idle();
      assert.equal(fs.readFileSync(path.join(repo, "x.txt"), "utf8"), "hi", "approve once still works");
    });
  });
});

// ------------------------------------------------------------------ the sidecar process

function spawnSidecar(args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", "tsx", path.join(cliRoot, "src", "sidecar.ts"), ...args], { cwd: cliRoot, env: { ...process.env, NEXUS_DEBUG: "0", ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  closers.push(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  return { child, exited, lines: () => stdout.split("\n").filter(Boolean), stderr: () => stderr };
}

describe("sidecar --listen", () => {
  test("binds a 0600 socket, prints one machine-readable line without the token, serves a client, and cleans up", async () => {
    const gw = await startGateway((n) => ({ kind: "text", content: "hello there" }));
    const repo = makeRepo();
    const home = makeHome();
    const runtime = tmpdir();
    const proc = spawnSidecar(["-w", repo, "-e", gw.url, "-m", "m", "--listen"], { HOME: home, XDG_RUNTIME_DIR: runtime });
    try {
      await waitUntil(() => proc.lines().some((l) => l.includes('"type":"listening"')), 30000);
      const lines = proc.lines().map((l) => JSON.parse(l));
      assert.deepEqual(lines.slice(0, 2).map((e) => e.type), ["hello", "session.state"], "stdio starts as it always does");
      const listening = lines.find((e) => e.type === "listening");
      assert.deepEqual(Object.keys(listening).sort(), ["descriptor", "pid", "socket", "type", "v"]);
      assert.equal(listening.pid, proc.child.pid);
      assert.equal(fs.lstatSync(listening.socket).mode & 0o777, 0o600);
      assert.equal(fs.lstatSync(path.dirname(listening.socket)).mode & 0o777, 0o700);
      const { token } = readDescriptor(listening.descriptor);
      assert.equal(proc.lines().join("\n").includes(token), false, "the token is not on stdout");
      // A wrong token is refused; the right one attaches and drives a turn that the stdio parent also sees.
      const wrong = net.connect({ path: listening.socket });
      const wrongClient = new Client(wrong);
      wrongClient.send({ type: "attach", id: "a", token: "0".repeat(64), role: "control" });
      await waitUntil(() => wrongClient.ended);
      assert.deepEqual(wrongClient.events.map((e) => e.code), ["UNAUTHORIZED"]);
      const controller = await attach(listening.socket, token, "control");
      controller.send({ type: "prompt.submit", id: "t1", text: "hi" });
      await controller.until((e) => e.some((x) => x.type === "turn.result"), "the turn result");
      await waitUntil(() => proc.lines().some((l) => l.includes('"type":"turn.result"')));
      assert.equal(proc.stderr().includes(token), false, "the token is not on stderr");
      // The stdio parent owns the process: closing its stdin shuts the sidecar down and removes the files.
      proc.child.stdin.end();
      assert.equal(await proc.exited, 0, proc.stderr());
      assert.equal(fs.existsSync(listening.socket), false);
      assert.equal(fs.existsSync(listening.descriptor), false);
      await waitUntil(() => controller.ended);
    } finally {
      proc.child.kill("SIGKILL");
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("SIGTERM shuts down and removes the socket and descriptor", async () => {
    const gw = await startGateway(() => ({ kind: "text", content: "x" }));
    const repo = makeRepo();
    const home = makeHome();
    const runtime = tmpdir();
    const proc = spawnSidecar(["-w", repo, "-e", gw.url, "-m", "m", "--listen"], { HOME: home, XDG_RUNTIME_DIR: runtime });
    try {
      await waitUntil(() => proc.lines().some((l) => l.includes('"type":"listening"')), 30000);
      const listening = JSON.parse(proc.lines().find((l) => l.includes('"type":"listening"'))!);
      proc.child.kill("SIGTERM");
      assert.equal(await proc.exited, 0, proc.stderr());
      assert.deepEqual(fs.readdirSync(path.dirname(listening.socket)), []);
    } finally {
      proc.child.kill("SIGKILL");
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("is refused under auto approval, and binds nothing", async () => {
    const gw = await startGateway(() => ({ kind: "text", content: "x" }));
    const repo = makeRepo();
    const home = makeHome();
    const runtime = tmpdir();
    try {
      for (const extra of [["-y"], ["--mode", "auto"]]) {
        const proc = spawnSidecar(["-w", repo, "-e", gw.url, "-m", "m", "--listen", ...extra], { HOME: home, XDG_RUNTIME_DIR: runtime });
        assert.notEqual(await proc.exited, 0);
        assert.match(proc.stderr(), /--listen is refused under auto approval/);
        assert.equal(proc.lines().some((l) => l.includes('"type":"listening"')), false);
        assert.equal(fs.existsSync(path.join(runtime, "nexus")), false, "no directory, socket or descriptor was created");
      }
    } finally {
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("without --listen nothing is bound, no directory is made, and stdout is the stdio protocol alone", async () => {
    const gw = await startGateway(() => ({ kind: "text", content: "x" }));
    const repo = makeRepo();
    const home = makeHome();
    const runtime = tmpdir();
    const proc = spawnSidecar(["-w", repo, "-e", gw.url, "-m", "m"], { HOME: home, XDG_RUNTIME_DIR: runtime });
    try {
      await waitUntil(() => proc.lines().some((l) => l.includes('"type":"session.state"')), 30000);
      proc.child.stdin.write(`${JSON.stringify({ v: 1, type: "attach", id: "a", token: "0".repeat(64), role: "control" })}\n`);
      await waitUntil(() => proc.lines().some((l) => l.includes('"type":"error"')));
      const types = proc.lines().map((l) => JSON.parse(l).type);
      assert.equal(types.includes("listening"), false);
      assert.match(proc.lines().find((l) => l.includes('"type":"error"'))!, /"code":"BAD_REQUEST".*unknown message type: attach/);
      assert.equal(fs.existsSync(path.join(runtime, "nexus")), false);
      proc.child.stdin.end();
      assert.equal(await proc.exited, 0, proc.stderr());
    } finally {
      proc.child.kill("SIGKILL");
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
