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
import { receiptSections } from "../src/evidence.js";
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
    receipt: () => receiptSections(null, null),
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

  test("a rejected save name keeps the previous session id", async () => {
    await withRig(async ({ app, host, reply }) => {
      host.saveSession = (title) => {
        app.getSessionManager().saveSession({ id: host.sessionId(), title, workspace: app.getConfig().workspace, messages: app.getAgent().getMessages() });
      };
      converse(app);
      assert.equal((await reply("save", "my session")).success, false);
      assert.equal(host.sessionId(), "session-1");
      assert.equal((await reply("save")).output, "Session saved as session-1.");
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

  test("receipt reports that no turn has finished yet", async () => {
    await withRig(async ({ reply }) => {
      assert.match((await reply("receipt")).output, /^Last turn\n  No turn has finished in this session yet\.$/m);
    });
  });
});

describe("slash router: workspace commands", () => {
  test("diff reports a clean tree, then the change as a diff", async () => {
    await withRig(async ({ reply, repo }) => {
      assert.equal((await reply("diff")).output, "Working tree clean: no uncommitted changes.");
      fs.writeFileSync(path.join(repo, "base.txt"), "changed\n");
      const out = await reply("diff");
      assert.equal(out.format, "diff");
      assert.match(out.output, /^-base$/m);
      assert.match(out.output, /^\+changed$/m);
    });
  });

  test("git shows the short status", async () => {
    await withRig(async ({ reply, repo }) => {
      assert.equal((await reply("git")).output, "Working tree clean.");
      fs.writeFileSync(path.join(repo, "base.txt"), "changed\n");
      assert.match((await reply("git")).output, / M base\.txt/);
    });
  });

  test("stage lists hunks and reset unstages", async () => {
    await withRig(async ({ reply, repo }) => {
      assert.equal((await reply("stage")).output, "No unstaged hunks in the working tree.");
      fs.writeFileSync(path.join(repo, "base.txt"), "changed\n");
      const out = await reply("stage");
      assert.match(out.output, /base\.txt \(1 hunks\)/);
      assert.match(out.output, /\+changed/);
      assert.equal((await reply("stage", "reset")).output, "Unstaged all changes.");
    });
  });

  test("commit suggests a message into the composer, then commits", async () => {
    await withRig(async ({ reply, repo }) => {
      assert.equal((await reply("commit")).output, "Working tree clean: nothing to commit.");
      fs.writeFileSync(path.join(repo, "base.txt"), "changed\n");
      const suggestion = await reply("commit");
      assert.ok(suggestion.composer?.startsWith("/commit "), suggestion.composer);
      const done = await reply("commit", "fix: change base");
      assert.equal(done.success, true, done.output);
      assert.equal(execSync("git log -1 --format=%s", { cwd: repo, encoding: "utf-8" }).trim(), "fix: change base");
    });
  });

  test("checkpoint, checkpoints, checkpoint diff and undo", async () => {
    await withRig(async ({ reply, repo }) => {
      assert.equal((await reply("checkpoints")).output, "No saved checkpoints.");
      const saved = await reply("checkpoint", "before change");
      const id = /\((cp_[^)]+)\)$/.exec(saved.output)?.[1];
      assert.ok(id, saved.output);
      assert.match((await reply("checkpoints")).output, /before change/);
      fs.writeFileSync(path.join(repo, "base.txt"), "changed\n");
      const diff = await reply("checkpoint", `diff ${id}`);
      assert.equal(diff.format, "diff");
      assert.match(diff.output, /\+changed/);
      assert.equal((await reply("checkpoint", "diff")).success, false);
      assert.equal((await reply("undo")).success, true);
      assert.equal(fs.readFileSync(path.join(repo, "base.txt"), "utf-8"), "base\n");
    });
  });

  test("worktree and audit describe an empty state", async () => {
    await withRig(async ({ reply }) => {
      assert.match((await reply("worktree")).output, /^No speculative worktrees/);
      assert.equal((await reply("worktree", "merge")).output, "No active speculative worktree to merge.");
      assert.equal((await reply("audit")).output, "No audit records yet.");
    });
  });

  test("git commands outside a repository say so", async () => {
    await withRig(async ({ reply }) => {
      const plain = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-plain-"));
      try {
        assert.equal((await reply("cd", plain)).success, true);
        for (const command of ["diff", "git", "stage", "commit"]) {
          const out = await reply(command);
          assert.equal(out.success, false, command);
          assert.equal(out.output, "This workspace is not inside a git repository.");
        }
      } finally {
        fs.rmSync(plain, { recursive: true, force: true });
      }
    });
  });

  test("copy needs a reply; paste fills the composer or reports the clipboard error", async () => {
    await withRig(async ({ reply }) => {
      const copy = await reply("copy");
      assert.equal(copy.success, false);
      assert.equal(copy.output, "No assistant reply to copy yet.");
      // An empty PATH keeps the clipboard tools out of reach, so the real system clipboard is never read.
      const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-nobin-"));
      const previousPath = process.env.PATH;
      process.env.PATH = emptyBin;
      let paste: SlashReply;
      try {
        paste = await reply("paste");
      } finally {
        process.env.PATH = previousPath;
        fs.rmSync(emptyBin, { recursive: true, force: true });
      }
      if (paste.success) assert.equal(typeof paste.composer, "string");
      else assert.match(paste.output, /^Clipboard error: /);
    });
  });

  test("paste refuses a clipboard too large for one protocol line", async () => {
    await withRig(async ({ reply }) => {
      const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-fakeclip-"));
      const content = path.join(fakeBin, "content.txt");
      fs.writeFileSync(content, "a".repeat(100_001));
      fs.writeFileSync(path.join(fakeBin, "wl-paste"), `#!/bin/sh\nexec /bin/cat "${content}"\n`, { mode: 0o755 });
      const previousPath = process.env.PATH;
      process.env.PATH = fakeBin;
      let paste: SlashReply;
      try {
        paste = await reply("paste");
      } finally {
        process.env.PATH = previousPath;
        fs.rmSync(fakeBin, { recursive: true, force: true });
      }
      assert.equal(paste.success, false);
      assert.equal(paste.output, "The clipboard holds 100001 characters; /paste takes at most 100000.");
      assert.equal(paste.composer, undefined);
    });
  });
});

describe("slash router: extensions and turns", () => {
  test("plan adds, starts, completes and clears phases", async () => {
    await withRig(async ({ reply }) => {
      assert.equal((await reply("plan")).output, "No active plan. Add a phase with /plan add <description>.");
      await reply("plan", "add write the parser");
      await reply("plan", "add test it");
      assert.equal((await reply("plan", "start 1")).output, "Phase 1 in progress.\n1. [~] write the parser\n2. [ ] test it");
      assert.equal((await reply("plan", "done 1")).output, "Phase 1 completed.\n1. [x] write the parser\n2. [ ] test it");
      assert.equal((await reply("plan", "done 7")).success, false);
      assert.equal((await reply("plan", "clear")).output, "Plan cleared.");
    });
  });

  test("knowledge sets, lists and deletes entries", async () => {
    await withRig(async ({ reply }) => {
      assert.equal((await reply("knowledge", "set style use tabs")).output, "Saved [rule] style");
      assert.match((await reply("knowledge")).output, /• \[rule\] style: use tabs/);
      assert.equal((await reply("knowledge", "delete style")).output, "Deleted style");
      assert.equal((await reply("knowledge", "delete style")).success, false);
    });
  });

  test("skills, skill lookup and skill scaffolding", async () => {
    await withRig(async ({ reply }) => {
      assert.equal((await reply("skills")).success, true);
      assert.equal((await reply("skill", "no-such-skill")).success, false);
      assert.match((await reply("skill", "init lint-fixer")).output, /^Scaffolded lint-fixer at /);
    });
  });

  test("image validates its file and resolves to a vision turn", async () => {
    await withRig(async ({ reply, run, repo }) => {
      assert.equal((await reply("image")).output, "Usage: /image <path> [prompt]");
      assert.match((await reply("image", "missing.png")).output, /^Could not load the image: /);
      fs.writeFileSync(path.join(repo, "dot.png"), Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex"));
      const turn = await run("image", "dot.png what is this");
      assert.equal(turn.kind, "turn");
      if (turn.kind !== "turn") return;
      assert.equal(turn.label, "what is this [image dot.png]");
      assert.equal(turn.checkpoint, "Vision: what is this");
      assert.ok(Array.isArray(turn.prompt));
      const multiline = await run("image", "dot.png what is this\nand why");
      assert.equal(multiline.kind === "turn" && multiline.label, "what is this\nand why [image dot.png]");
    });
  });

  test("commands that need arguments explain their usage", async () => {
    await withRig(async ({ reply }) => {
      const usages: Array<[string, string]> = [
        ["tdd", "Usage: /tdd <issue description>"],
        ["team", "Usage: /team <researcher|architect|implementer|tester|full> <objective>"],
        ["browse", "Usage: /browse <url>"],
        ["skill", "Usage: /skill <name> or /skill init <name>"],
      ];
      for (const [command, usage] of usages) {
        const out = await reply(command);
        assert.equal(out.success, false, command);
        assert.equal(out.output, usage);
      }
      assert.match((await reply("mcp", "add only-a-name")).output, /^Usage: \/mcp add/);
      assert.equal((await reply("team", "juggler do it")).output, "Unknown role juggler. Roles: researcher, architect, implementer, tester, full");
    });
  });

  test("mcp and plugins describe what is configured", async () => {
    await withRig(async ({ reply }) => {
      assert.match((await reply("mcp")).output, /^No MCP servers configured/);
      assert.equal((await reply("plugins")).success, true);
    });
  });

  test("! runs a shell command directly and !<n> reruns a prompt", async () => {
    await withRig(async ({ reply, run, prompts }) => {
      const out = await reply("!", "echo hello-from-bang");
      assert.equal(out.success, true, out.output);
      assert.match(out.output, /hello-from-bang/);
      assert.equal((await reply("!", "")).output, "Usage: !<shell command> or !<history number>");
      prompts.push("first prompt");
      assert.deepEqual(await run("!", "1"), { kind: "turn", command: "!", prompt: "first prompt", label: "first prompt", checkpoint: "Turn: first prompt" });
    });
  });

  test("a cancelled TDD cycle stops after the running phase", async () => {
    await withRig(async ({ app }) => {
      const controller = new AbortController();
      let runs = 0;
      const agent = {
        run: async () => {
          runs += 1;
          controller.abort();
          return {};
        },
      } as any;
      const result = await app.getAgent().getSynthesizer().runAutonomousTdd(agent, "fix it", undefined, { signal: controller.signal });
      assert.equal(runs, 1);
      assert.equal(result.success, false);
      assert.equal(result.summary, "Stopped by operator.");
    });
  });

  test("every REPL slash command has a TUI counterpart", () => {
    const repl = fs.readFileSync(path.join(cliRoot, "src", "repl.ts"), "utf-8");
    const names = new Set([...repl.matchAll(/cmd === "([^"]+)"/g)].map((m) => m[1]));
    assert.ok(names.size >= 40, `found only ${names.size} REPL commands`);
    for (const name of names) assert.ok(findSlash(name), `/${name} is missing from SLASH_COMMANDS`);
  });

  test("every catalogue command has a handler", () => {
    for (const spec of [...SLASH_COMMANDS, BANG]) assert.ok(hasHandler(spec.name), spec.name);
  });
});
