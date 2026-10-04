import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ApplicationCore } from "../src/core/app.js";
import { CheckpointManager } from "../src/checkpoint.js";
import { BANG, SLASH_COMMANDS, SlashHost, SlashOutcome, SlashReply, findSlash } from "../src/slash/catalog.js";
import { hasHandler, routeSlash } from "../src/slash/router.js";
import { makeHome, makeRepo } from "./helpers/fixtures.js";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface Rig {
  app: ApplicationCore;
  host: SlashHost;
  repo: string;
  prompts: string[];
  saved: string[];
  mode(): string;
  run(command: string, args?: string): Promise<SlashOutcome>;
  reply(command: string, args?: string): Promise<SlashReply>;
}

/** A real ApplicationCore over a temporary git repo, with HOME pointed at a temporary directory. */
async function withRig(fn: (rig: Rig) => Promise<void>): Promise<void> {
  const home = makeHome();
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const repo = makeRepo();
  const app = new ApplicationCore({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 4, temperature: 0, workspace: repo, shell: "bash" } as any);
  let mode: "auto" | "review" = "auto";
  let sessionId = "session-1";
  let checkpoints = new CheckpointManager(repo);
  const prompts: string[] = [];
  const saved: string[] = [];
  const host: SlashHost = {
    app,
    mode: () => mode,
    setMode: (next) => {
      mode = next;
    },
    sessionId: () => sessionId,
    setSessionId: (id) => {
      sessionId = id;
    },
    checkpoints: () => checkpoints,
    setWorkspace: (dir) => {
      app.getConfig().workspace = dir;
      app.getAgent().setWorkspace(dir);
      checkpoints = new CheckpointManager(dir);
    },
    saveSession: (title) => {
      saved.push(title ?? "");
    },
    resumeSession: (id) => ({ ok: false, message: `Session not found: ${id ?? "latest"}` }),
    history: () => prompts,
    confirm: () => undefined,
  };
  const run = (command: string, args = "") => routeSlash(host, command, args, new AbortController().signal);
  const reply = async (command: string, args = "") => {
    const outcome = await run(command, args);
    assert.equal(outcome.kind, "reply", `/${command} should reply`);
    return outcome as SlashReply;
  };
  try {
    await fn({ app, host, repo, prompts, saved, mode: () => mode, run, reply });
  } finally {
    app.shutdown();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** Two messages beyond the system prompt, so the session counts as non-empty. */
function converse(app: ApplicationCore): void {
  const agent = app.getAgent();
  agent.setMessages([...agent.getMessages(), { role: "user", content: "hi" } as any, { role: "assistant", content: "hello" } as any]);
}

describe("slash router: session commands", () => {
  test("help lists every command with its usage", async () => {
    await withRig(async ({ reply }) => {
      const out = await reply("help");
      assert.equal(out.success, true);
      for (const spec of SLASH_COMMANDS) assert.ok(out.output.includes(spec.usage), spec.usage);
    });
  });

  test("unknown commands fail and point at /help", async () => {
    await withRig(async ({ reply }) => {
      const out = await reply("frobnicate");
      assert.equal(out.success, false);
      assert.equal(out.command, "frobnicate");
      assert.equal(out.output, "Unknown command: /frobnicate. Type /help for the list.");
    });
  });

  test("aliases resolve to the canonical command", async () => {
    await withRig(async ({ reply }) => {
      assert.equal((await reply("?")).command, "help");
      assert.equal((await reply("reset")).command, "clear");
      assert.equal((await reply("cost")).command, "tokens");
      assert.equal((await reply("/STATUS")).command, "status");
    });
  });

  test("status reports workspace, model, mode and session", async () => {
    await withRig(async ({ reply, repo }) => {
      const out = await reply("status");
      assert.match(out.output, /^model\s+m$/m);
      assert.match(out.output, /^mode\s+auto$/m);
      assert.match(out.output, /^session\s+session-1$/m);
      assert.ok(out.output.includes(repo));
    });
  });

  test("mode switches between auto and review and rejects other values", async () => {
    await withRig(async ({ reply, mode }) => {
      assert.equal((await reply("mode", "review")).success, true);
      assert.equal(mode(), "review");
      assert.equal((await reply("mode", "auto")).success, true);
      assert.equal(mode(), "auto");
      const bad = await reply("mode", "sideways");
      assert.equal(bad.success, false);
      assert.equal(bad.output, "Current mode: auto. Use /mode auto or /mode review.");
      assert.equal((await reply("mode")).success, true);
    });
  });

  test("clear resets the conversation", async () => {
    await withRig(async ({ app, reply }) => {
      converse(app);
      const before = app.getAgent().getMessages().length;
      assert.equal((await reply("clear")).output, "Conversation context reset.");
      assert.ok(app.getAgent().getMessages().length < before);
    });
  });

  test("model, shell and cd change the session", async () => {
    await withRig(async ({ app, reply, repo }) => {
      assert.equal((await reply("model", "other-model")).output, "Model: other-model");
      assert.equal(app.getConfig().model, "other-model");
      assert.equal((await reply("shell", "sh")).output, "Shell: sh");
      assert.equal(app.getConfig().shell, "sh");
      assert.equal((await reply("shell")).output, "Active shell: sh");
      fs.mkdirSync(path.join(repo, "sub"));
      assert.equal((await reply("cd", "sub")).success, true);
      assert.equal(app.getConfig().workspace, path.join(repo, "sub"));
      assert.equal((await reply("cd", "missing")).success, false);
      assert.equal((await reply("cd")).output, `Workspace: ${path.join(repo, "sub")}`);
    });
  });

  test("tokens shows the context gauge without terminal escapes", async () => {
    await withRig(async ({ reply }) => {
      const out = await reply("tokens");
      assert.match(out.output, /Context Window/);
      assert.equal(out.output.includes("\x1b"), false);
    });
  });

  test("history lists, searches and reruns earlier prompts", async () => {
    await withRig(async ({ prompts, reply, run }) => {
      assert.equal((await reply("history")).output, "No prompt history yet.");
      prompts.push("fix the parser", "add tests", "fix the lexer");
      const all = await reply("history");
      assert.match(all.output, /^\[1\] fix the parser$/m);
      assert.match(all.output, /^\[3\] fix the lexer$/m);
      assert.equal((await reply("history", "LEXER")).output, "[3] fix the lexer");
      assert.deepEqual(await run("history", "run 2"), {
        kind: "turn",
        command: "history",
        prompt: "add tests",
        label: "add tests",
        checkpoint: "Turn: add tests",
      });
      assert.equal((await run("history", "2")).kind, "turn");
      assert.equal((await reply("history", "run 9")).output, "History index out of range: 9");
    });
  });

  test("save, sessions, resume and export report an empty session plainly", async () => {
    await withRig(async ({ reply, saved }) => {
      const save = await reply("save");
      assert.equal(save.success, false);
      assert.equal(save.output, "Nothing to save yet: the conversation is empty.");
      assert.deepEqual(saved, []);
      assert.equal((await reply("sessions")).output, "No saved sessions yet.");
      const resume = await reply("resume", "nope");
      assert.equal(resume.success, false);
      assert.equal(resume.output, "Session not found: nope");
      assert.equal((await reply("export")).success, false);
    });
  });

  test("save names the session and asks the host to persist it", async () => {
    await withRig(async ({ app, host, reply, saved }) => {
      converse(app);
      assert.equal((await reply("save", "my-session")).output, "Session saved as my-session.");
      assert.equal(host.sessionId(), "my-session");
      assert.deepEqual(saved, ["Snapshot"]);
    });
  });

  test("init and onboard write project rules into the workspace", async () => {
    await withRig(async ({ reply }) => {
      const init = await reply("init");
      const file = init.output.replace("Project instructions file ready at: ", "");
      assert.ok(fs.existsSync(file), init.output);
      assert.match((await reply("onboard")).output, /^Onboarded /);
    });
  });

  test("theme, tui, exit and compact answer plainly", async () => {
    await withRig(async ({ reply }) => {
      assert.match((await reply("theme")).output, /Save one with \/theme <name>\./);
      assert.equal((await reply("theme", "no-such-theme")).success, false);
      assert.equal((await reply("tui")).output, "You are already in the live view.");
      assert.equal((await reply("quit")).output, "Press q, or ctrl+c with an empty composer, to quit.");
      assert.equal((await reply("compact")).success, true);
    });
  });
});
