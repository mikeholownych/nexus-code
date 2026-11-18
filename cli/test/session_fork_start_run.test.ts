import "./helpers/leak_guard.js";
/**
 * RD-6 (start flag), end to end: `nexus run --fork-session <id> --fork-at <n>` forks a task into a new id, runs the
 * prompt in the fork (the model sees only the copied part), prints the new id, and never touches the source.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SessionManager } from "../src/session.js";
import type { ChatMessage } from "../src/types.js";
import { WorkspacePath } from "../src/core/workspace_path.js";
import { startGateway } from "./helpers/fixtures.js";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const skip = fs.existsSync(CLI) ? false : "cli/dist is not built";

let dir = "";
let ws = "";
before(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-forkrun-")));
  ws = path.join(dir, "ws");
  fs.mkdirSync(ws);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws, stdio: "ignore" });
});
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const m = (role: ChatMessage["role"], content: string): ChatMessage => ({ role, content } as ChatMessage);

describe("nexus run --fork-session (end to end)", () => {
  test("runs in the fork from the chosen point, prints its id and leaves the source untouched", { skip, timeout: 120_000 }, async () => {
    const state = path.join(dir, "state");
    const tasks = new SessionManager(path.join(state, "tasks"), () => WorkspacePath.fromSelectedWorkspace(ws));
    tasks.saveSession({ id: "src", title: "Original", workspace: ws, model: "m", messages: [m("system", "sys"), m("user", "first question"), m("assistant", "first answer"), m("user", "second question"), m("assistant", "second answer")] } as any);
    const file = path.join(tasks.getSessionsDir(), "src.json");
    const sourceBefore = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const gw = await startGateway(() => ({ kind: "text", content: "fork answer" }));
    try {
      const child = spawn(process.execPath, [CLI, "run", "--fork-session", "src", "--fork-at", "3", "-w", ws, "-e", gw.url, "-m", "m", "-y", "branch here"], {
        env: { ...process.env, HOME: state, XDG_CONFIG_HOME: path.join(state, ".config"), NEXUS_STATE_DIR: state },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (out += c));
      const code: number = await new Promise((resolve) => child.on("close", (c) => resolve(c ?? -1)));
      const id = /Forked src at message 3 into (session_\w+)/.exec(out)?.[1];
      assert.ok(id, out);
      // Exit 2 is the harness's "completed, unverified" (no verifier applies to a plain answer); the run itself finished.
      assert.match(out, /Assistant: fork answer/, `exit ${code}\n${out}`);
      const sent = JSON.stringify(gw.requests);
      assert.match(sent, /first answer/, "the fork carried the copied conversation");
      assert.match(sent, /branch here/);
      assert.doesNotMatch(sent, /second question|second answer/, "nothing past the fork point reached the model");
      const fork = tasks.loadSession(id!)!;
      assert.notEqual(fork.id, "src");
      assert.ok(fork.messages.some((x) => String(x.content).includes("fork answer")), "the run continued in the fork");
      assert.equal(createHash("sha256").update(fs.readFileSync(file)).digest("hex"), sourceBefore, "the source is byte for byte unchanged");
    } finally {
      await gw.close();
    }
  });
});
