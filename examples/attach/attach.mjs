#!/usr/bin/env node
// Attaching a second client to a running Nexus session over its private unix socket (docs/PROTOCOL.md, "Socket transport").
// The example starts a sidecar with --listen, attaches a controller and an observer, shows that a wrong token is
// refused, runs one prompt through the controller, and exits 0 only if the observer saw the same turn finish.
//   NEXUS_SIDECAR       absolute path of the sidecar (<nexus home>/lib/cli/dist/sidecar.js, or cli/dist/sidecar.js in a checkout)
//   NEXUS_ARGS          further sidecar options, for example "-e http://127.0.0.1:8000/v1 -m my-model"
//   NEXUS_NODE_ARGS     options for node before the sidecar path (the repository's tests use "--import tsx" with the TypeScript source)
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const sidecar = process.env.NEXUS_SIDECAR;
if (!sidecar) { console.error("set NEXUS_SIDECAR to the absolute path of sidecar.js"); process.exit(2); }
const words = (text) => (text ?? "").split(/\s+/).filter(Boolean);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-attach-"));
fs.writeFileSync(path.join(work, "README.md"), "hello\n");
const git = (...args) => execFileSync("git", ["-c", "user.name=example", "-c", "user.email=example@example.invalid", ...args], { cwd: work, stdio: "ignore" });
git("init", "-q");
git("add", "-A");
git("commit", "-q", "-m", "start");

// The sidecar stays up while its stdin is open; the program that started it is its owner.
const child = spawn(process.execPath, [...words(process.env.NEXUS_NODE_ARGS), sidecar, "-w", work, "--listen", ...words(process.env.NEXUS_ARGS)], { stdio: ["pipe", "pipe", "inherit"] });
let failed = true;
try {
  // One stdout line says where the socket is. The token is not in it: it is in the descriptor file, mode 0600.
  const listening = await new Promise((resolve, reject) => {
    let buffer = "";
    child.once("exit", () => reject(new Error("the sidecar exited before it listened")));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (const line of buffer.split("\n")) if (line.includes('"type":"listening"')) resolve(JSON.parse(line));
    });
  });
  const descriptor = JSON.parse(fs.readFileSync(listening.descriptor, "utf8"));

  // A client: connect, send the attach line first, then read newline-delimited events.
  const attach = (token, role) => new Promise((resolve) => {
    const socket = net.connect({ path: listening.socket });
    const client = { socket, events: [], waiters: [] };
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        client.events.push(JSON.parse(buffer.slice(0, at)));
        buffer = buffer.slice(at + 1);
      }
      client.waiters = client.waiters.filter((waiter) => !waiter());
    });
    client.until = (test) => new Promise((done) => { const waiter = () => (test(client.events) ? (done(), true) : false); if (!waiter()) client.waiters.push(waiter); });
    client.send = (message) => socket.write(`${JSON.stringify({ v: 1, ...message })}\n`);
    socket.on("connect", () => { client.send({ type: "attach", id: "a1", token, role }); resolve(client); });
  });

  const wrong = await attach("0".repeat(64), "control");
  await wrong.until((events) => events.length > 0);
  console.log(`wrong token: ${wrong.events[0].code}`);

  const controller = await attach(descriptor.token, "control");
  const observer = await attach(descriptor.token, "observe");
  await Promise.all([controller, observer].map((client) => client.until((events) => events.some((event) => event.type === "session.state"))));
  console.log(`attached: controller ${controller.events[0].connection}, observer ${observer.events[0].connection}`);

  // Only the controller commands the session; an observer's command is refused and changes nothing.
  observer.send({ type: "prompt.submit", id: "o1", text: "ignored" });
  await observer.until((events) => events.some((event) => event.code === "NOT_CONTROLLER"));
  console.log("observer command: NOT_CONTROLLER");

  controller.send({ type: "prompt.submit", id: "t1", text: "Say hello." });
  const isResult = (events) => events.some((event) => event.type === "turn.result");
  await Promise.all([controller.until(isResult), observer.until(isResult)]);
  const seen = observer.events.find((event) => event.type === "turn.result");
  console.log(`observer saw turn ${seen.turn_id}: ${seen.turn.execution}`);
  failed = seen.turn_id !== "t1";
} finally {
  child.stdin.end(); // closing stdin shuts the sidecar down; it removes its socket and descriptor
  await new Promise((resolve) => child.once("exit", resolve));
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
