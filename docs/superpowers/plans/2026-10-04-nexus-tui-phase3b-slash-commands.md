# Nexus TUI Phase 3B: Slash Commands and Default Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every slash command of the readline REPL works in the live TUI (with completion and help), `!command` runs a shell command directly, the sidecar checkpoints and saves the session around turns like the REPL does, and `harness` with no arguments opens the live TUI (`harness --repl` keeps the readline REPL).

**Architecture:** A sidecar-side router (`cli/src/slash/`) implements the REPL's ~45 commands against the same managers the REPL uses and returns structured outcomes instead of printing: a reply (text, optional diff colouring, optional composer text) or a turn (a prompt the sidecar runs with a checkpoint first). The REPL is not modified. The sidecar announces the command catalogue in `hello`; Rust parses what the operator typed (`slash.rs`), handles quit/help locally, sends the rest as `slash` commands, renders replies as transcript blocks, and offers a completion list above the composer.

**Tech Stack:** TypeScript (Node 24, `node:test`, commander), Rust 2024 (ratatui 0.30.2, crossterm 0.29), bash (`harness.sh`), util-linux `script` for the terminal routing test.

**Spec:** `docs/superpowers/specs/2026-10-04-nexus-ratatui-live-default-design.md` (sections 3, 4, 5, 6 phase 3). **Depends on:** plan 3A (`docs/superpowers/plans/2026-10-04-nexus-tui-phase3a-interaction-core.md`) merged first; code below assumes its `Composer`, `Focus`, `Overlay`, `LiveLayout`, `render_help` and `composer_hint`.

---

## Before you start

- Work in an isolated worktree (superpowers:using-git-worktrees) branched from a main that contains plan 3A. The main checkout has unrelated uncommitted Cloudflare/Issue 12 files; never stage them.
- Build once: `make build`. The sidecar tests and `!command` need the release `harness-core` binary and `cli/dist`.
- Rust tests: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui > /tmp/t.txt 2>&1`, then read `/tmp/t.txt`. Baseline after 3A: 100 tests pass. An `rtk` shell wrapper alters piped cargo output; always redirect to a file.
- CLI tests: `cd cli && node --import tsx --test test/*.test.ts > /tmp/cli.txt 2>&1` (never `npx tsx --test`). Baseline after 3A: 307 tests, 306 pass; the only failure is `SCAN-001 & SCAN-004: Security gates script passes on clean codebase` (and its parent `WP-11` suite). One file: `node --import tsx --test test/slash_router.test.ts`.
- Run edits and test commands strictly one after another. Never batch an edit with a test run.
- Format only files you touch: `rustfmt --edition 2024 <file>`. If rustfmt reorders the `#[path] mod` declarations in `core/src/bin/nexus_tui.rs`, restore the order.
- After TS changes: `cd cli && npm run build`, commit the changed `cli/dist` files with the task. Revert any `package-lock.json` change.
- Tests that construct `ApplicationCore` must point `HOME` at a temporary directory first: sessions, checkpoints, prompt history and the audit log live under `~/.nexus`.
- Never read or print `cli/.env`. Never push.

## Decisions (binding for this plan)

- **One router, REPL untouched.** The router re-implements each command's REPL behaviour against the same managers (`SessionManager`, `CheckpointManager`, `HunkStager`, `KnowledgeGraph`, `SkillManager`, MCP and plugin managers, `TeamOrchestrator`, `SynthesizerEngine`). Output is plain text; the sidecar strips terminal escapes, redacts secrets and caps it at 32,000 characters.
- **REPL prompts become one-step forms.** `/commit` without a message replies with the suggestion and puts `/commit <suggested message>` into the composer to edit and send. `/mcp add` takes one line: `/mcp add <name> stdio <command...>` or `/mcp add <name> sse|websocket <url>`. `/paste` puts the clipboard into the composer instead of asking to send it. Composer text is not redacted: it goes back to the operator who owns it.
- **Commands that start a turn:** `/history run <n>`, `/history <n>`, `!<n>` and `/image <path> [prompt]`. The sidecar answers with `slash.result` carrying `prompt` (the label shown as the user line), then runs a normal turn under the same id, with a checkpoint first and a session save after. `/tdd` runs its agent phases under the slash id (assistant and tool events stream with that `turn_id`), honours review-mode approvals and cancel (between phases too), and ends with a `slash.result`.
- **Cancel.** Prompt turns, turn-starting commands, `/tdd` and `/image` are cancellable. Other commands finish on their own; a cancel while one runs produces a `notice` saying so.
- **Busy.** One activity at a time: a prompt, or a command. Anything else gets `BUSY`. The sidecar reports `busy: true` before a command starts, so synchronous commands such as `/test` show as busy.
- **Per-turn bookkeeping (REPL parity).** Before every turn: `createCheckpoint("Turn: <first 30 chars>")` (`"Vision: …"` for images). If that throws, the turn does not start and the error names the reason (the REPL behaves the same). After every turn: save the session (id from `--resume` or a new one). Submitted prompts join the in-memory history that `/history` and `!<n>` read; the REPL history file is read at startup and never written by the sidecar.
- **Sidecar options** match `harness repl`: endpoint, model, workspace, max steps, temperature, shell, fallback, context limit, dry run, read only, sandbox, worktree, authoritative verifier, record flight, planner/coder model and endpoint, approve, resume.
- **Typed input.** A draft starting with `!` followed by text is a direct shell command (`!<n>` reruns prompt n). A draft starting with `/` is a command when its first word contains no further `/`; `/etc/hosts is broken` stays a prompt. `/exit`, `/quit`, `/q` quit; `/help` and `/?` open the help panel; `/tui` says the live view is already open. Everything else goes to the sidecar, which reports unknown commands.
- **Completion.** While the draft is a single `/word` with the cursor at its end, up to six matching commands show above the composer. Up/Down move the highlight, Tab completes, Enter completes and runs (or waits for input when the usage has a required `<argument>` outside brackets), Esc hides the list until the draft changes.
- **Rendering.** The typed command is echoed in accent colour; its reply follows indented, red when it failed, with `+`/`-`/`@@` colouring for diffs. `/clear` clears the transcript. Sidecar notices render as quiet `·` lines. The help panel lists the catalogue after the keys.
- **Default entry.** `harness` with no arguments execs the live TUI when `core/target/release/nexus-tui` exists and both stdin and stdout are terminals; otherwise it runs the REPL (with a one-line note on stderr when the TUI is not built). `harness --repl [options]` runs the REPL. `harness --live [sidecar options]` stays.
- **Out of scope here:** per-hunk patch approval (phase 4), tool/evidence detail and receipt overlays (plan 3C), persistent prompt history written by the TUI.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `cli/src/slash/catalog.ts` | Create | `SlashSpec`, `SLASH_COMMANDS`, `BANG`, `SlashHost`, outcomes, `findSlash`, `slashCatalog`, helpers |
| `cli/src/slash/router.ts` | Create | `routeSlash` dispatch, `hasHandler` |
| `cli/src/slash/session_commands.ts` | Create | help, status, clear, compact, mode, model, shell, cd, tokens, sessions, save, resume, history, export, init, onboard, theme, tui, exit; `recall` |
| `cli/src/slash/workspace_commands.ts` | Create | diff, git, stage, commit, checkpoint, checkpoints, undo, worktree, audit, test, copy, paste |
| `cli/src/slash/extension_commands.ts` | Create | plan, knowledge, skills, skill, mcp, plugins, browse, image, tdd, team, recover, `!` |
| `cli/src/synthesizer.ts` | Modify | `runAutonomousTdd` takes `{ signal, onConfirm }` and stops between phases |
| `cli/src/protocol.ts` | Modify | `hello.commands`, `slash.result` fields, `notice`, `MAX_SLASH_OUTPUT`, export `stripEscapes` |
| `cli/src/sidecar.ts` | Modify | Router wiring, jobs, cancel notices, checkpoints, session save/resume, history, REPL option parity |
| `cli/test/slash_router.test.ts` | Create | Router tests |
| `cli/test/sidecar.test.ts` | Modify | Isolated HOME, updated hello/status tests, new session and slash tests |
| `cli/test/harness_entry.test.ts` | Create | `harness.sh` routing |
| `harness.sh` | Modify | Default entry |
| `core/src/bin/nexus_tui.rs` | Modify | `#[path]` for `slash` |
| `core/src/bin/nexus_tui/protocol.rs` | Modify | `SlashSpec`, `Hello.commands`, `SlashResult`, `Notice`, `Command::Slash` |
| `core/src/bin/nexus_tui/slash.rs` | Create | `parse`, `matches`, `needs_args` |
| `core/src/bin/nexus_tui/composer.rs` | Modify | `at_end()` |
| `core/src/bin/nexus_tui/live_state.rs` | Modify | Command entries, invocation, results, notices, completion |
| `core/src/bin/nexus_tui/live_view.rs` | Modify | Command/output/info rendering, completion list, help commands, hint |
| `core/src/bin/nexus_tui/live.rs` | Modify | Slash round-trip test |

---

### Task 1: Slash catalogue, router and session commands

**Files:**
- Create: `cli/src/slash/catalog.ts`, `cli/src/slash/router.ts`, `cli/src/slash/session_commands.ts`
- Create: `cli/test/slash_router.test.ts`
- Modify: `cli/src/protocol.ts` (export `stripEscapes`)

- [ ] **Step 1: Write the failing tests**

Create `cli/test/slash_router.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cli && node --import tsx --test test/slash_router.test.ts > /tmp/s1.txt 2>&1`
Expected: FAIL: cannot find module `../src/slash/catalog.js`.

- [ ] **Step 3: Implement**

1. In `cli/src/protocol.ts` change `function stripEscapes(text: string): string {` to `export function stripEscapes(text: string): string {`.

2. Create `cli/src/slash/catalog.ts`:

```ts
/**
 * Slash commands the live TUI runs through the sidecar. The list mirrors the readline REPL (`cli/src/repl.ts`);
 * the TUI builds completion and help from `usage` and `summary`, so both are operator-facing text.
 */
import type { ConfirmHandler } from "../agent.js";
import type { CheckpointManager } from "../checkpoint.js";
import type { ApplicationCore } from "../core/app.js";

export interface SlashSpec {
  name: string;
  usage: string;
  summary: string;
  aliases?: string[];
  /** Cancel stops it. Commands that resolve to a turn become cancellable when the turn starts. */
  cancellable?: boolean;
}

/** What the sidecar lets a command read and change. */
export interface SlashHost {
  readonly app: ApplicationCore;
  mode(): "auto" | "review";
  setMode(mode: "auto" | "review"): void;
  sessionId(): string;
  setSessionId(id: string): void;
  checkpoints(): CheckpointManager;
  setWorkspace(dir: string): void;
  saveSession(title?: string): void;
  resumeSession(id?: string): { ok: boolean; message: string };
  /** Earlier prompts, oldest first: the REPL history file, then this session's prompts. */
  history(): string[];
  /** Approval callback for agent runs a command starts; undefined in auto mode. */
  confirm(signal: AbortSignal): ConfirmHandler | undefined;
}

export interface SlashContext {
  host: SlashHost;
  args: string;
  signal: AbortSignal;
}

export interface SlashReply {
  kind: "reply";
  command: string;
  success: boolean;
  output: string;
  /** "diff" asks the client to colour unified-diff lines. */
  format?: "diff";
  /** Text for the client to put into the composer. */
  composer?: string;
}

/** The command resolved to a prompt: the sidecar checkpoints, then runs it as a turn under the command's id. */
export interface SlashTurn {
  kind: "turn";
  command: string;
  prompt: string | any[];
  label: string;
  checkpoint: string;
}

export type SlashOutcome = SlashReply | SlashTurn;
export type SlashHandler = (ctx: SlashContext) => SlashOutcome | Promise<SlashOutcome>;

export const NOT_A_REPO = "This workspace is not inside a git repository.";

export function reply(command: string, output: string, success = true, extra: Pick<SlashReply, "format" | "composer"> = {}): SlashReply {
  return { kind: "reply", command, success, output, ...extra };
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `!command` and `!<n>`; kept out of the completion catalogue because it is not typed after a slash. */
export const BANG: SlashSpec = { name: "!", usage: "!<command>", summary: "Run a shell command directly; !<n> runs prompt n again" };

export const SLASH_COMMANDS: SlashSpec[] = [
  { name: "help", usage: "/help", summary: "List the slash commands", aliases: ["?"] },
  { name: "status", usage: "/status", summary: "Workspace, model, mode, endpoint and session" },
  { name: "clear", usage: "/clear", summary: "Reset the conversation context", aliases: ["reset"] },
  { name: "compact", usage: "/compact [--llm]", summary: "Condense earlier messages to free context" },
  { name: "mode", usage: "/mode [auto|review]", summary: "Run edits and commands freely, or ask first" },
  { name: "model", usage: "/model [name]", summary: "List available models or switch" },
  { name: "shell", usage: "/shell [bash|zsh|sh]", summary: "Show or switch the command shell" },
  { name: "cd", usage: "/cd [path]", summary: "Show or change the workspace directory" },
  { name: "tokens", usage: "/tokens", summary: "Context window use and session token totals", aliases: ["cost"] },
  { name: "diff", usage: "/diff", summary: "Uncommitted changes as a diff" },
  { name: "git", usage: "/git", summary: "Short git status" },
  { name: "stage", usage: "/stage [reset]", summary: "Unstaged hunks, or unstage everything" },
  { name: "commit", usage: "/commit [message]", summary: "Commit; without a message, suggests one" },
  { name: "checkpoint", usage: "/checkpoint [name|diff <id> [base]|prune [n]]", summary: "Save, compare or prune workspace snapshots" },
  { name: "checkpoints", usage: "/checkpoints", summary: "List workspace snapshots" },
  { name: "undo", usage: "/undo", summary: "Roll the workspace back to the last snapshot" },
  { name: "worktree", usage: "/worktree [status|merge|discard]", summary: "Manage the speculative git worktree" },
  { name: "audit", usage: "/audit [count]", summary: "Recent tool executions" },
  { name: "test", usage: "/test [pattern]", summary: "Run the project's test suite" },
  { name: "copy", usage: "/copy [diff|code|last]", summary: "Copy the diff, code blocks or the last reply" },
  { name: "paste", usage: "/paste", summary: "Put the clipboard into the composer" },
  { name: "sessions", usage: "/sessions", summary: "Saved sessions" },
  { name: "save", usage: "/save [name]", summary: "Save this session" },
  { name: "resume", usage: "/resume [id]", summary: "Load a saved session (the latest by default)" },
  { name: "history", usage: "/history [query|run <n>]", summary: "Search earlier prompts or run one again", cancellable: true },
  { name: "export", usage: "/export [md|json]", summary: "Write the session transcript into the workspace" },
  { name: "init", usage: "/init", summary: "Create a project rules file" },
  { name: "onboard", usage: "/onboard", summary: "Scan the workspace and write a tailored AGENTS.md" },
  { name: "plan", usage: "/plan [add <phase>|start <n>|done <n>|clear]", summary: "Show or edit the active plan" },
  { name: "knowledge", usage: "/knowledge [set <key> <rule>|delete <key>]", summary: "Persistent project knowledge" },
  { name: "skills", usage: "/skills", summary: "Discovered agent skills" },
  { name: "skill", usage: "/skill <name> | init <name>", summary: "Show a skill or scaffold a new one" },
  { name: "mcp", usage: "/mcp [add|resources|resource <uri>|prompts|prompt <name>]", summary: "MCP servers, tools, resources and prompts" },
  { name: "plugins", usage: "/plugins", summary: "Loaded plugins" },
  { name: "browse", usage: "/browse <url>", summary: "Open a URL in the headless browser" },
  { name: "image", usage: "/image <path> [prompt]", summary: "Send an image to the vision model", cancellable: true },
  { name: "tdd", usage: "/tdd <issue>", summary: "Run a RED → GREEN → REFACTOR cycle", cancellable: true },
  { name: "team", usage: "/team <role|full> <objective>", summary: "Delegate to researcher, architect, implementer, tester or the full team" },
  { name: "theme", usage: "/theme [name]", summary: "Show or save the colour theme" },
  { name: "recover", usage: "/recover [task-id]", summary: "Recover durable task state" },
  { name: "tui", usage: "/tui", summary: "This is the live view" },
  { name: "exit", usage: "/exit", summary: "Quit Nexus", aliases: ["quit", "q"] },
];

/** The catalogue as announced in `hello`. */
export function slashCatalog(): Array<Pick<SlashSpec, "name" | "usage" | "summary">> {
  return SLASH_COMMANDS.map(({ name, usage, summary }) => ({ name, usage, summary }));
}

export function findSlash(command: string): SlashSpec | undefined {
  const name = command.trim().replace(/^\//, "").toLowerCase();
  if (name === BANG.name) return BANG;
  return SLASH_COMMANDS.find((spec) => spec.name === name || spec.aliases?.includes(name));
}
```

3. Create `cli/src/slash/router.ts`:

```ts
/** Runs one slash command for the sidecar. Handlers never write to stdout; everything comes back as an outcome. */
import { stripEscapes } from "../protocol.js";
import { SlashHandler, SlashHost, SlashOutcome, errorText, findSlash, reply } from "./catalog.js";
import { SESSION_HANDLERS } from "./session_commands.js";

const HANDLERS: Record<string, SlashHandler> = { ...SESSION_HANDLERS };

export function hasHandler(name: string): boolean {
  return Object.hasOwn(HANDLERS, name);
}

export async function routeSlash(host: SlashHost, command: string, args: string, signal: AbortSignal): Promise<SlashOutcome> {
  const spec = findSlash(command);
  const name = spec?.name ?? command.trim().replace(/^\//, "").toLowerCase();
  const handler = spec && hasHandler(spec.name) ? HANDLERS[spec.name] : undefined;
  if (!handler) return reply(name, `Unknown command: /${name}. Type /help for the list.`, false);
  try {
    const outcome = await handler({ host, args, signal });
    return outcome.kind === "reply" ? { ...outcome, output: stripEscapes(outcome.output) } : outcome;
  } catch (err) {
    return reply(name, `${name === "!" ? "!" : `/${name}`} failed: ${errorText(err)}`, false);
  }
}
```

4. Create `cli/src/slash/session_commands.ts`:

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { LocalLlmClient } from "../client.js";
import { writeProtectedTextFile } from "../core/persistence_protection.js";
import { getGitInfo, scaffoldProjectRules } from "../git.js";
import { scanAndOnboardWorkspace } from "../onboard.js";
import { ThemeManager } from "../theme.js";
import { renderTokenGauge } from "../tokens.js";
import { SLASH_COMMANDS, SlashContext, SlashHandler, SlashOutcome, errorText, oneLine, reply } from "./catalog.js";

function help(): SlashOutcome {
  const width = Math.max(...SLASH_COMMANDS.map((spec) => spec.usage.length));
  return reply("help", SLASH_COMMANDS.map((spec) => `${spec.usage.padEnd(width)}  ${spec.summary}`).join("\n"));
}

function status({ host }: SlashContext): SlashOutcome {
  const config = host.app.getConfig();
  const git = getGitInfo(config.workspace);
  const rows: Array<[string, string]> = [
    ["workspace", config.workspace],
    ["git", git.isRepo ? git.formattedBadge : "not a repository"],
    ["model", config.model],
    ["mode", host.mode()],
    ["endpoint", config.endpoint],
    ["shell", config.shell],
    ["messages", String(host.app.getAgent().getHistoryCount())],
    ["session", host.sessionId()],
  ];
  return reply("status", rows.map(([label, value]) => `${label.padEnd(10)}${value}`).join("\n"));
}

function clear({ host }: SlashContext): SlashOutcome {
  host.app.getAgent().resetConversation();
  return reply("clear", "Conversation context reset.");
}

async function compact({ host, args }: SlashContext): Promise<SlashOutcome> {
  return reply("compact", await host.app.getAgent().compactConversation(args.includes("--llm")));
}

function mode({ host, args }: SlashContext): SlashOutcome {
  const wanted = args.trim().toLowerCase();
  if (wanted === "auto" || wanted === "autonomous") {
    host.setMode("auto");
    return reply("mode", "Mode: auto. Edits and commands run without asking.");
  }
  if (wanted === "review" || wanted === "ask") {
    host.setMode("review");
    return reply("mode", "Mode: review. Edits and commands wait for your approval.");
  }
  return reply("mode", `Current mode: ${host.mode()}. Use /mode auto or /mode review.`, !wanted);
}

async function model({ host, args }: SlashContext): Promise<SlashOutcome> {
  const config = host.app.getConfig();
  const name = args.trim();
  if (name) {
    config.model = name;
    host.app.getAgent().setModel(name);
    return reply("model", `Model: ${name}`);
  }
  try {
    const models = await new LocalLlmClient(config).listModels();
    return reply("model", ["Available models:", ...models.map((m) => (m === config.model ? `* ${m} (active)` : `  ${m}`))].join("\n"));
  } catch (err) {
    return reply("model", `Could not list models from ${config.endpoint}: ${errorText(err)}`, false);
  }
}

function shell({ host, args }: SlashContext): SlashOutcome {
  const config = host.app.getConfig();
  const name = args.trim();
  if (!name) return reply("shell", `Active shell: ${config.shell}`);
  config.shell = name;
  host.app.getAgent().setShell(name);
  return reply("shell", `Shell: ${name}`);
}

function cd({ host, args }: SlashContext): SlashOutcome {
  const config = host.app.getConfig();
  if (!args.trim()) return reply("cd", `Workspace: ${config.workspace}`);
  const target = path.resolve(config.workspace, args.trim());
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return reply("cd", `Not a directory: ${target}`, false);
  host.setWorkspace(target);
  return reply("cd", `Workspace: ${target}`);
}

function tokens({ host }: SlashContext): SlashOutcome {
  const agent = host.app.getAgent();
  const lines = [renderTokenGauge(agent.getContextBudget()).trim()];
  const total = agent.getTokenStats();
  if (total.total > 0) {
    lines.push("", `Session usage: ${total.prompt.toLocaleString()} prompt, ${total.completion.toLocaleString()} completion (${total.total.toLocaleString()} total tokens)`);
  }
  return reply("tokens", lines.join("\n"));
}

function sessions({ host }: SlashContext): SlashOutcome {
  const list = host.app.getSessionManager().listSessions();
  if (!list.length) return reply("sessions", "No saved sessions yet.");
  const rows = list.slice(0, 10).map((s) => `${s.id === host.sessionId() ? "*" : " "} ${s.id}  ${s.updatedAt.slice(0, 19)}  ${oneLine(s.title)} · ${s.messageCount} messages`);
  return reply("sessions", [...rows, "", "Load one with /resume <id>."].join("\n"));
}

function save({ host, args }: SlashContext): SlashOutcome {
  if (host.app.getAgent().getMessages().length <= 1) return reply("save", "Nothing to save yet: the conversation is empty.", false);
  if (args.trim()) host.setSessionId(args.trim());
  host.saveSession("Snapshot");
  return reply("save", `Session saved as ${host.sessionId()}.`);
}

function resume({ host, args }: SlashContext): SlashOutcome {
  const result = host.resumeSession(args.trim() || undefined);
  return reply("resume", result.message, result.ok);
}

/** Resolves history item `raw` (1-based) to a turn, or an out-of-range reply. */
export function recall(items: string[], raw: string, command: string): SlashOutcome {
  const index = Number.parseInt(raw, 10) - 1;
  if (!(index >= 0 && index < items.length)) return reply(command, `History index out of range: ${raw}`, false);
  const prompt = items[index];
  return { kind: "turn", command, prompt, label: prompt, checkpoint: `Turn: ${prompt.slice(0, 30)}` };
}

function history({ host, args }: SlashContext): SlashOutcome {
  const items = host.history();
  const query = args.trim();
  const run = query.startsWith("run ") ? query.slice(4).trim() : /^\d+$/.test(query) ? query : undefined;
  if (run !== undefined) return recall(items, run, "history");
  if (query) {
    const lower = query.toLowerCase();
    const hits = items.map((item, index) => ({ item, index })).filter(({ item }) => item.toLowerCase().includes(lower));
    if (!hits.length) return reply("history", `No history items match "${query}".`);
    return reply("history", hits.map(({ item, index }) => `[${index + 1}] ${oneLine(item)}`).join("\n"));
  }
  if (!items.length) return reply("history", "No prompt history yet.");
  const start = Math.max(0, items.length - 20);
  const rows = items.slice(start).map((item, offset) => `[${start + offset + 1}] ${oneLine(item)}`);
  return reply("history", [...rows, "", "Run one again with /history run <n> or !<n>."].join("\n"));
}

function exportSession({ host, args }: SlashContext): SlashOutcome {
  const session = host.app.getSessionManager().loadSession(host.sessionId());
  if (!session || session.messages.length === 0) return reply("export", "Nothing to export yet: this session has not been saved.", false);
  const json = args.trim().toLowerCase() === "json";
  const out = path.join(host.app.getConfig().workspace, `nexus-session-${session.id}.${json ? "json" : "md"}`);
  if (json) {
    writeProtectedTextFile(out, JSON.stringify(session, null, 2));
  } else {
    let md = `# Nexus Code Session Export\n\n- **Session ID:** \`${session.id}\`\n- **Workspace:** \`${session.workspace}\`\n- **Date:** ${session.createdAt}\n- **Model:** \`${session.model}\`\n\n---\n\n`;
    for (const m of session.messages) {
      if (m.role === "system") continue;
      const who = m.role === "user" ? "User" : m.role === "assistant" ? "Nexus" : `Tool (${m.name})`;
      md += `### ${who}\n\n${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}\n\n---\n\n`;
    }
    writeProtectedTextFile(out, md);
  }
  return reply("export", `Transcript written to ${out}`);
}

function init({ host }: SlashContext): SlashOutcome {
  return reply("init", `Project instructions file ready at: ${scaffoldProjectRules(host.app.getConfig().workspace)}`);
}

function onboard({ host }: SlashContext): SlashOutcome {
  const report = scanAndOnboardWorkspace(host.app.getConfig().workspace, true);
  return reply("onboard", [
    `Onboarded ${report.projectName}.`,
    `Stack: ${report.languages.join(", ") || "general"}`,
    `Commands: build ${report.buildCommands[0] || "none"} · test ${report.testCommands[0] || "none"} · lint ${report.lintCommands[0] || "none"}`,
    "Wrote a tailored AGENTS.md.",
  ].join("\n"));
}

function theme({ args }: SlashContext): SlashOutcome {
  const themes = new ThemeManager();
  const name = args.trim();
  if (!name) {
    const rows = themes.listThemes().map((t) => `${t === themes.getThemeName() ? "*" : " "} ${t}`);
    return reply("theme", [...rows, "", "Save one with /theme <name>."].join("\n"));
  }
  return themes.saveConfiguredTheme(name)
    ? reply("theme", `Theme saved: ${name}`)
    : reply("theme", `Unknown theme ${name}. Options: ${themes.listThemes().join(", ")}`, false);
}

export const SESSION_HANDLERS: Record<string, SlashHandler> = {
  help,
  status,
  clear,
  compact,
  mode,
  model,
  shell,
  cd,
  tokens,
  sessions,
  save,
  resume,
  history,
  export: exportSession,
  init,
  onboard,
  theme,
  tui: () => reply("tui", "You are already in the live view."),
  exit: () => reply("exit", "Press q, or ctrl+c with an empty composer, to quit."),
};
```

- [ ] **Step 4: Run the tests**

Run: `cd cli && node --import tsx --test test/slash_router.test.ts > /tmp/s1.txt 2>&1`
Expected: PASS, 13 tests. If the `init` test fails on the path, print `init.output` and check `scaffoldProjectRules` in `cli/src/git.ts`; do not weaken the assertion to `success`.

- [ ] **Step 5: Full CLI suite, build, commit**

Run: `cd cli && node --import tsx --test test/*.test.ts > /tmp/cli1.txt 2>&1` — expected 320 tests, only the known `SCAN-001 & SCAN-004` failure. Then:

```bash
cd cli && npm run build && cd ..
git add cli/src/slash cli/src/protocol.ts cli/test/slash_router.test.ts cli/dist
git commit -m "feat(sidecar): slash catalogue, router and session commands"
```

---

### Task 2: Workspace commands

**Files:**
- Create: `cli/src/slash/workspace_commands.ts`
- Modify: `cli/src/slash/router.ts`
- Modify: `cli/test/slash_router.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `cli/test/slash_router.test.ts`:

```ts
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
      const paste = await reply("paste");
      if (paste.success) assert.equal(typeof paste.composer, "string");
      else assert.match(paste.output, /^Clipboard error: /);
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cli && node --import tsx --test test/slash_router.test.ts > /tmp/s2.txt 2>&1`
Expected: the 8 new tests FAIL with `Unknown command: /diff` and similar.

- [ ] **Step 3: Implement**

1. Create `cli/src/slash/workspace_commands.ts`:

```ts
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { copyToClipboard, readFromClipboard } from "../clipboard.js";
import { commitChanges, generateConventionalCommit, getGitInfo } from "../git.js";
import { HunkStager } from "../stager.js";
import { runTestSuite } from "../tester.js";
import { NOT_A_REPO, SlashContext, SlashHandler, SlashOutcome, errorText, reply } from "./catalog.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

function workspace(ctx: SlashContext): string {
  return ctx.host.app.getConfig().workspace;
}

function diff(ctx: SlashContext): SlashOutcome {
  const cwd = workspace(ctx);
  if (!getGitInfo(cwd).isRepo) return reply("diff", NOT_A_REPO, false);
  try {
    const out = git(cwd, ["diff"]);
    return out.trim() ? reply("diff", out.trimEnd(), true, { format: "diff" }) : reply("diff", "Working tree clean: no uncommitted changes.");
  } catch (err) {
    return reply("diff", `git diff failed: ${errorText(err)}`, false);
  }
}

function gitStatus(ctx: SlashContext): SlashOutcome {
  const cwd = workspace(ctx);
  if (!getGitInfo(cwd).isRepo) return reply("git", NOT_A_REPO, false);
  try {
    return reply("git", git(cwd, ["status", "--short"]).trimEnd() || "Working tree clean.");
  } catch (err) {
    return reply("git", `git status failed: ${errorText(err)}`, false);
  }
}

function stage(ctx: SlashContext): SlashOutcome {
  const cwd = workspace(ctx);
  if (!getGitInfo(cwd).isRepo) return reply("stage", NOT_A_REPO, false);
  const stager = new HunkStager(cwd);
  if (ctx.args.trim() === "reset") {
    stager.unstage();
    return reply("stage", "Unstaged all changes.");
  }
  const summary = stager.getStatusSummary();
  if (!summary.files.length) return reply("stage", "No unstaged hunks in the working tree.");
  const lines = [`${summary.files.length} modified files, ${summary.unstagedHunkCount} hunks`];
  for (const file of summary.files) {
    lines.push("", `${file.newPath} (${file.hunks.length} hunks)`);
    file.hunks.forEach((hunk, index) => {
      lines.push(`  [hunk ${index + 1}] ${hunk.header}`);
      lines.push(...hunk.lines.slice(0, 5).map((line) => `    ${line}`));
      if (hunk.lines.length > 5) lines.push(`    … ${hunk.lines.length - 5} more lines`);
    });
  }
  lines.push("", "Unstage with /stage reset, or commit with /commit.");
  return reply("stage", lines.join("\n"));
}

function commit(ctx: SlashContext): SlashOutcome {
  const cwd = workspace(ctx);
  const info = getGitInfo(cwd);
  if (!info.isRepo) return reply("commit", NOT_A_REPO, false);
  if (info.dirtyCount === 0) return reply("commit", "Working tree clean: nothing to commit.");
  const message = ctx.args.trim();
  if (!message) {
    const suggestion = generateConventionalCommit(cwd);
    return reply(
      "commit",
      `${suggestion.files.length} changed files. Suggested message:\n  ${suggestion.message}\n\nThe composer now holds /commit with this message: edit it and press enter to commit.`,
      true,
      { composer: `/commit ${suggestion.message}` },
    );
  }
  const result = commitChanges(cwd, message);
  return result.success ? reply("commit", `Committed ${result.hash ?? ""}: ${message}`) : reply("commit", `Commit failed: ${result.error}`, false);
}

function checkpoint(ctx: SlashContext): SlashOutcome {
  const manager = ctx.host.checkpoints();
  const [sub, ...rest] = ctx.args.trim().split(/\s+/).filter(Boolean);
  if (sub?.toLowerCase() === "diff") {
    const [id, base] = rest;
    if (!id) return reply("checkpoint", "Usage: /checkpoint diff <id> [base-id]", false);
    const result = manager.getDiff(id, base);
    if (!result.success) return reply("checkpoint", `Diff failed: ${result.error}`, false);
    return result.diff.trim()
      ? reply("checkpoint", result.diff.trimEnd(), true, { format: "diff" })
      : reply("checkpoint", `No changes between ${id} and ${base ?? "the working tree"}.`);
  }
  if (sub?.toLowerCase() === "prune") {
    const keep = Number.parseInt(rest[0] ?? "20", 10);
    return reply("checkpoint", manager.pruneCheckpoints(Number.isNaN(keep) ? 20 : keep).message);
  }
  const created = manager.createCheckpoint(ctx.args.trim() || undefined);
  return reply("checkpoint", `Checkpoint saved: ${created.name} (${created.id})`);
}

function checkpoints(ctx: SlashContext): SlashOutcome {
  const list = ctx.host.checkpoints().listCheckpoints();
  if (!list.length) return reply("checkpoints", "No saved checkpoints.");
  const rows = list.map((cp, index) => `${index + 1}. ${cp.id}  ${cp.name}  (${cp.timestamp})`);
  return reply("checkpoints", [...rows, "", "Compare with /checkpoint diff <id>, roll back with /undo."].join("\n"));
}

function undo(ctx: SlashContext): SlashOutcome {
  const result = ctx.host.checkpoints().rollbackLast();
  return reply("undo", result.message, result.success);
}

function worktree(ctx: SlashContext): SlashOutcome {
  const agent = ctx.host.app.getAgent();
  const active = agent.getActiveWorktree();
  const sub = ctx.args.trim().toLowerCase();
  if (sub === "merge" || sub === "discard") {
    if (!active) return reply("worktree", `No active speculative worktree to ${sub}.`, false);
    if (sub === "merge") {
      const result = agent.mergeActiveWorktree();
      return result.success
        ? reply("worktree", `Merged ${result.commitsMerged} speculative commit(s) from ${result.branch}.`)
        : reply("worktree", `Merge failed: ${result.error}`, false);
    }
    const result = agent.discardActiveWorktree();
    return result.success ? reply("worktree", "Discarded the active speculative worktree.") : reply("worktree", `Discard failed: ${result.error}`, false);
  }
  const lines: string[] = [];
  if (active) lines.push(`* active: ${active.branch} at ${active.worktreePath}`);
  lines.push(...agent.getWorktreeManager().listWorktrees().map((wt) => `• ${wt.taskId}  ${wt.branch}  ${wt.path}`));
  return reply("worktree", lines.length ? lines.join("\n") : "No speculative worktrees. Start Nexus with --worktree to isolate changes.");
}

function audit(ctx: SlashContext): SlashOutcome {
  const file = path.join(os.homedir(), ".nexus", "audit.log");
  if (!fs.existsSync(file)) return reply("audit", "No audit records yet.");
  const limit = Number.parseInt(ctx.args.trim(), 10) || 15;
  const records = fs
    .readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const rows = records.map((r) => {
    const row = `${String(r.timestamp ?? "").slice(11, 19)}  ${r.success ? "PASS" : "FAIL"}  ${String(r.tool ?? "").padEnd(16)} ${String(r.duration_ms ?? 0).padStart(6)}ms`;
    return r.error ? `${row}\n    error: ${r.error}` : row;
  });
  return reply("audit", rows.join("\n") || "No audit records yet.");
}

function test(ctx: SlashContext): SlashOutcome {
  const result = runTestSuite(workspace(ctx), ctx.args.trim() || undefined);
  const lines = [`$ ${result.command}`, result.success ? "Test suite passed." : "Test suite failed."];
  if (!result.success && result.failures.length) lines.push("", "Failing tests:", ...result.failures.slice(0, 10).map((f) => `  • ${f}`));
  if (!result.success && result.diagnostics.length) {
    lines.push("", "Diagnostics:", ...result.diagnostics.slice(0, 5).map((d) => `  • [${d.severity.toUpperCase()}] ${d.file || "unknown"}:${d.line || "?"} ${d.message}`));
  }
  return reply("test", lines.join("\n"), result.success);
}

function lastAssistant(ctx: SlashContext): string {
  const messages = ctx.host.app.getAgent().getMessages();
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].content;
    if (messages[i].role === "assistant" && content) return typeof content === "string" ? content : JSON.stringify(content);
  }
  return "";
}

function copy(ctx: SlashContext): SlashOutcome {
  const what = ctx.args.trim().toLowerCase() || "last";
  let text: string;
  let label: string;
  if (what === "diff") {
    const cwd = workspace(ctx);
    if (!getGitInfo(cwd).isRepo) return reply("copy", NOT_A_REPO, false);
    text = git(cwd, ["diff"]);
    if (!text.trim()) return reply("copy", "No uncommitted changes to copy.", false);
    label = `the git diff (${text.split("\n").length} lines)`;
  } else {
    const last = lastAssistant(ctx);
    if (!last) return reply("copy", "No assistant reply to copy yet.", false);
    const blocks = what === "code" ? [...last.matchAll(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g)].map((m) => m[1].trimEnd()) : [];
    text = blocks.length ? blocks.join("\n\n// ────────────────────────────\n\n") : last;
    label = blocks.length ? `${blocks.length} code block(s)` : `the last reply (${last.length} chars)`;
  }
  const result = copyToClipboard(text);
  return result.success ? reply("copy", `Copied ${label} to the clipboard.`) : reply("copy", `Clipboard error: ${result.error}`, false);
}

function paste(): SlashOutcome {
  const result = readFromClipboard();
  if (!result.success || !result.text) return reply("paste", `Clipboard error: ${result.error || "the clipboard is empty"}`, false);
  return reply("paste", `Pasted ${result.text.length} characters into the composer.`, true, { composer: result.text });
}

export const WORKSPACE_HANDLERS: Record<string, SlashHandler> = {
  diff,
  git: gitStatus,
  stage,
  commit,
  checkpoint,
  checkpoints,
  undo,
  worktree,
  audit,
  test,
  copy,
  paste,
};
```

2. In `cli/src/slash/router.ts` add `import { WORKSPACE_HANDLERS } from "./workspace_commands.js";` and change the table to `const HANDLERS: Record<string, SlashHandler> = { ...SESSION_HANDLERS, ...WORKSPACE_HANDLERS };`.

- [ ] **Step 4: Run the tests**

Run: `cd cli && node --import tsx --test test/slash_router.test.ts > /tmp/s2.txt 2>&1`
Expected: PASS, 21 tests.

- [ ] **Step 5: Full CLI suite, build, commit**

Run the full CLI suite (expected 328 tests, only the known failure), then:

```bash
cd cli && npm run build && cd ..
git add cli/src/slash cli/test/slash_router.test.ts cli/dist
git commit -m "feat(sidecar): git, checkpoint, test and clipboard slash commands"
```

---

### Task 3: Extension and turn commands, cancellable TDD

**Files:**
- Create: `cli/src/slash/extension_commands.ts`
- Modify: `cli/src/slash/router.ts`
- Modify: `cli/src/synthesizer.ts` (`runAutonomousTdd`, lines 238-320)
- Modify: `cli/test/slash_router.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `cli/test/slash_router.test.ts`:

```ts
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
```

(The PNG bytes are the 8-byte signature plus a 1×1 IHDR chunk; `encodeImageFile` checks the extension and size, not pixel data.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd cli && node --import tsx --test test/slash_router.test.ts > /tmp/s3.txt 2>&1`
Expected: the new tests FAIL (unknown commands; `runAutonomousTdd` runs all phases; the handler coverage test names `plan`). The REPL parity test passes already, because the catalogue is complete.

- [ ] **Step 3: Make TDD cancellable and approval-aware**

In `cli/src/synthesizer.ts`:

1. Add `import type { ConfirmHandler } from "./agent.js";` below the existing `import { AutonomousAgent } from "./agent.js";`.
2. Change the signature to:

```ts
  public async runAutonomousTdd(
    agent: AutonomousAgent,
    issuePrompt: string,
    reproductionHint?: string,
    options: { signal?: AbortSignal; onConfirm?: ConfirmHandler } = {}
  ): Promise<TddRunResult> {
```

3. Replace `await agent.run(redPrompt);` with:

```ts
    await agent.run(redPrompt, options.onConfirm, { signal: options.signal });
    if (options.signal?.aborted) return this.stopped();
```

4. Replace `await agent.run(greenPrompt);` with:

```ts
    await agent.run(greenPrompt, options.onConfirm, { signal: options.signal });
    if (options.signal?.aborted) return this.stopped();
```

5. Replace `await agent.run(healingPrompt);` with:

```ts
      if (options.signal?.aborted) return this.stopped();
      await agent.run(healingPrompt, options.onConfirm, { signal: options.signal });
      if (options.signal?.aborted) return this.stopped();
```

6. Add this method to the class, after `runAutonomousTdd`:

```ts
  private stopped(): TddRunResult {
    return { success: false, finalPhase: this.state.currentPhase, summary: "Stopped by operator.", state: this.getState() };
  }
```

The REPL calls `runAutonomousTdd(agent, arg)` and keeps its behaviour.

- [ ] **Step 4: Implement the commands**

1. Create `cli/src/slash/extension_commands.ts`:

```ts
import * as path from "node:path";
import { encodeImageFile, formatVisionContent } from "../image.js";
import type { McpClientManager } from "../mcp.js";
import { AgentRole, TeamOrchestrator } from "../team.js";
import { SlashContext, SlashHandler, SlashOutcome, reply } from "./catalog.js";
import { recall } from "./session_commands.js";

const IMAGE_PROMPT = "Please analyze this image, describe its contents, and provide relevant technical solutions.";
const ROLES = ["researcher", "architect", "implementer", "tester"];

function planLines(phases: Array<{ name: string; status: string }>): string[] {
  return phases.map((p, index) => `${index + 1}. ${p.status === "completed" ? "[x]" : p.status === "in_progress" ? "[~]" : "[ ]"} ${p.name}`);
}

function plan({ host, args }: SlashContext): SlashOutcome {
  const agent = host.app.getAgent();
  const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const phases = [...agent.getActivePlan()];
  const show = (lead: string) => reply("plan", [lead, ...planLines(agent.getActivePlan())].filter(Boolean).join("\n"));
  switch (sub?.toLowerCase()) {
    case "add": {
      const name = rest.join(" ");
      if (!name) return reply("plan", "Usage: /plan add <phase description>", false);
      agent.setActivePlan([...phases, { name, status: "pending" }]);
      return show(`Added: ${name}`);
    }
    case "start":
    case "done":
    case "complete": {
      const index = Number.parseInt(rest[0] ?? "", 10) - 1;
      if (!(index >= 0 && index < phases.length)) return reply("plan", `Phase number must be 1..${phases.length}.`, false);
      const started = sub.toLowerCase() === "start";
      phases[index] = { ...phases[index], status: started ? "in_progress" : "completed" };
      agent.setActivePlan(phases);
      return show(`Phase ${index + 1} ${started ? "in progress" : "completed"}.`);
    }
    case "clear":
      agent.setActivePlan([]);
      return reply("plan", "Plan cleared.");
    default:
      return phases.length ? show("") : reply("plan", "No active plan. Add a phase with /plan add <description>.");
  }
}

function knowledge({ host, args }: SlashContext): SlashOutcome {
  const graph = host.app.getAgent().getKnowledgeGraph();
  const [sub, key, ...value] = args.trim().split(/\s+/).filter(Boolean);
  const action = sub?.toLowerCase();
  if (action === "set" && key) {
    const entry = graph.set(key, value.join(" "), "rule");
    return reply("knowledge", `Saved [${entry.category}] ${entry.key}`);
  }
  if (action === "delete" && key) return graph.delete(key) ? reply("knowledge", `Deleted ${key}`) : reply("knowledge", `Not found: ${key}`, false);
  const entries = graph.list();
  return entries.length
    ? reply("knowledge", entries.map((e) => `• [${e.category}] ${e.key}: ${e.value}`).join("\n"))
    : reply("knowledge", "No knowledge entries. Add one with /knowledge set <key> <rule>.");
}

function skills({ host }: SlashContext): SlashOutcome {
  const list = host.app.getAgent().getSkillManager().listSkills();
  if (!list.length) return reply("skills", "No skills found. Add one under ~/.nexus/skills/<name>/SKILL.md or .nexus/skills/, or run /skill init <name>.");
  return reply("skills", [...list.flatMap((s) => [`• ${s.name} (${s.path})`, `    ${s.description}`]), "", "Show one with /skill <name>."].join("\n"));
}

function skill({ host, args }: SlashContext): SlashOutcome {
  const manager = host.app.getAgent().getSkillManager();
  const text = args.trim();
  if (!text) return reply("skill", "Usage: /skill <name> or /skill init <name>", false);
  if (text === "init" || text.startsWith("init ")) {
    const name = text.slice(4).trim();
    if (!name) return reply("skill", "Usage: /skill init <name>", false);
    return reply("skill", `Scaffolded ${name} at ${manager.scaffoldSkill(name).skillPath}`);
  }
  const found = manager.getSkill(text);
  return found ? reply("skill", `${found.name} · ${found.path}\n\n${found.content}`) : reply("skill", `Skill ${text} not found. /skills lists the available ones.`, false);
}

async function mcpAdd(manager: McpClientManager, words: string[]): Promise<SlashOutcome> {
  const usage = "Usage: /mcp add <name> stdio <command...>  or  /mcp add <name> sse|websocket <url>";
  const [name, transport, ...rest] = words;
  if (!name || !transport || !rest.length) return reply("mcp", usage, false);
  const kind = transport.toLowerCase();
  let config: Record<string, unknown>;
  if (kind === "stdio") config = { transport: "stdio", command: rest[0], args: rest.slice(1) };
  else if (kind === "sse" || kind === "websocket") config = { transport: kind, url: rest[0] };
  else return reply("mcp", usage, false);
  const result = await manager.addServer(name, config as any, true);
  return result.success
    ? reply("mcp", `Connected to ${name}: ${result.toolCount} tools, ${result.resourceCount} resources, ${result.promptCount} prompts. Saved to ~/.config/nexus/mcp.json.`)
    : reply("mcp", `Connection failed: ${result.error}`, false);
}

async function mcp({ host, args }: SlashContext): Promise<SlashOutcome> {
  const agent = host.app.getAgent();
  await agent.initExtensibility();
  const manager = agent.getMcpManager();
  const words = args.trim().split(/\s+/).filter(Boolean);
  switch (words[0]?.toLowerCase()) {
    case "add":
      return mcpAdd(manager, words.slice(1));
    case "resources": {
      const resources = manager.listResources();
      if (!resources.length) return reply("mcp", "Connected servers expose no resources.");
      const rows = resources.map((r) => `• ${r.name} (${r.uri}) [${r.server}]${r.description ? `\n    ${r.description}` : ""}`);
      return reply("mcp", [...rows, "", "Read one with /mcp resource <uri>."].join("\n"));
    }
    case "resource": {
      const uri = words.slice(1).join(" ");
      if (!uri) return reply("mcp", "Usage: /mcp resource <uri>", false);
      const result = await manager.readResource(uri);
      return result.success ? reply("mcp", result.content || "(empty)") : reply("mcp", `Could not read ${uri}: ${result.error}`, false);
    }
    case "prompts": {
      const prompts = manager.listPrompts();
      if (!prompts.length) return reply("mcp", "Connected servers expose no prompt templates.");
      const rows = prompts.map((p) => {
        const params = p.arguments?.length ? ` (args: ${p.arguments.map((a: any) => a.name).join(", ")})` : "";
        return `• ${p.name}${params} [${p.server}]${p.description ? `\n    ${p.description}` : ""}`;
      });
      return reply("mcp", [...rows, "", "Show one with /mcp prompt <name>."].join("\n"));
    }
    case "prompt": {
      const name = words[1];
      if (!name) return reply("mcp", "Usage: /mcp prompt <name>", false);
      const result = await manager.getPrompt(name);
      return result.success
        ? reply("mcp", [result.description ?? "", JSON.stringify(result.messages, null, 2)].filter(Boolean).join("\n\n"))
        : reply("mcp", `Could not fetch ${name}: ${result.error}`, false);
    }
    default: {
      const servers = manager.listServers();
      if (!servers.length) return reply("mcp", "No MCP servers configured. Add one with /mcp add <name> stdio <command...>.");
      const lines = servers.flatMap((s) => [
        `• ${s.name} [${s.connected ? "connected" : "disconnected"} · ${s.transport}] ${s.command ?? ""}`.trimEnd(),
        `    tools ${s.toolCount} · resources ${s.resourceCount} · prompts ${s.promptCount}`,
      ]);
      const tools = manager.getToolDefinitions();
      if (tools.length) lines.push("", "Tools:", ...tools.map((t) => `  ${t.function.name}: ${t.function.description}`));
      return reply("mcp", lines.join("\n"));
    }
  }
}

async function plugins({ host }: SlashContext): Promise<SlashOutcome> {
  const agent = host.app.getAgent();
  await agent.initExtensibility();
  const list = agent.getPluginManager().listPlugins();
  if (!list.length) return reply("plugins", "No plugins loaded from ~/.nexus/plugins/ or ~/.config/opencode/plugins/.");
  return reply("plugins", list.map((p) => `• ${p.name}: ${p.description} (custom tools: ${p.customToolCount})`).join("\n"));
}

async function browse({ host, args }: SlashContext): Promise<SlashOutcome> {
  const url = args.trim();
  if (!url) return reply("browse", "Usage: /browse <url>", false);
  const page = await host.app.getAgent().getBrowserDriver().navigate(url);
  return reply("browse", `${page.title} · HTTP ${page.status}\n\n${page.contentSnippet.slice(0, 300)}…`, page.status === 200);
}

function image({ host, args }: SlashContext): SlashOutcome {
  const [file, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (!file) return reply("image", "Usage: /image <path> [prompt]", false);
  const prompt = rest.join(" ") || IMAGE_PROMPT;
  const encoded = encodeImageFile(file, host.app.getConfig().workspace);
  if (!encoded.success) return reply("image", `Could not load the image: ${encoded.error}`, false);
  return {
    kind: "turn",
    command: "image",
    prompt: formatVisionContent(prompt, encoded.dataUri),
    label: `${prompt} [image ${path.basename(encoded.filePath)}]`,
    checkpoint: `Vision: ${prompt.slice(0, 30)}`,
  };
}

async function tdd({ host, args, signal }: SlashContext): Promise<SlashOutcome> {
  const issue = args.trim();
  if (!issue) return reply("tdd", "Usage: /tdd <issue description>", false);
  const agent = host.app.getAgent();
  const result = await agent.getSynthesizer().runAutonomousTdd(agent, issue, undefined, { signal, onConfirm: host.confirm(signal) });
  return result.success
    ? reply("tdd", "TDD cycle completed: RED → GREEN → REFACTOR verified.")
    : reply("tdd", `TDD cycle ended at ${result.finalPhase}: ${result.summary}`, false);
}

async function team({ host, args }: SlashContext): Promise<SlashOutcome> {
  const [role, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const objective = rest.join(" ");
  if (!role || !objective) return reply("team", "Usage: /team <researcher|architect|implementer|tester|full> <objective>", false);
  const name = role.toLowerCase();
  if (name !== "full" && !ROLES.includes(name)) return reply("team", `Unknown role ${role}. Roles: ${[...ROLES, "full"].join(", ")}`, false);
  const orchestrator = new TeamOrchestrator(host.app.getConfig());
  if (name === "full") {
    const result = await orchestrator.runFullWorkflow(objective);
    return reply("team", result.finalReport, result.success);
  }
  const result = await orchestrator.executeRoleTask(name as AgentRole, objective);
  return reply("team", `${name.toUpperCase()} summary:\n${result.summary}\n\n${(result.durationMs / 1000).toFixed(1)}s · ${result.steps} steps`, result.success);
}

async function recover({ host, args }: SlashContext): Promise<SlashOutcome> {
  const result = await host.app.executeSlashCommand("recover", args);
  return reply("recover", result.output, result.success);
}

async function bang({ host, args }: SlashContext): Promise<SlashOutcome> {
  const line = args.trim();
  if (!line) return reply("!", "Usage: !<shell command> or !<history number>", false);
  if (/^\d+$/.test(line)) return recall(host.history(), line, "!");
  const receipt = await host.app.executeOperatorCommand(line);
  const parts = [receipt.output ?? "", receipt.error ?? ""].map((text) => text.trimEnd()).filter(Boolean);
  if (!receipt.success && receipt.status === "DENIED") parts.push("Execution denied by the authority admission gate.");
  return reply("!", parts.join("\n") || (receipt.success ? "(no output)" : "Command failed."), receipt.success);
}

export const EXTENSION_HANDLERS: Record<string, SlashHandler> = {
  plan,
  knowledge,
  skills,
  skill,
  mcp,
  plugins,
  browse,
  image,
  tdd,
  team,
  recover,
  "!": bang,
};
```

2. In `cli/src/slash/router.ts` add `import { EXTENSION_HANDLERS } from "./extension_commands.js";` and change the table to `const HANDLERS: Record<string, SlashHandler> = { ...SESSION_HANDLERS, ...WORKSPACE_HANDLERS, ...EXTENSION_HANDLERS };`.

- [ ] **Step 5: Run the tests**

Run: `cd cli && node --import tsx --test test/slash_router.test.ts > /tmp/s3.txt 2>&1`
Expected: PASS, 31 tests. If `!` reports `DENIED`, print the receipt and check the operator domain policy in `cli/src/core/authority.ts`; do not change the test command.

- [ ] **Step 6: Full CLI suite, build, commit**

Run the full CLI suite (expected 338 tests, only the known failure), then:

```bash
cd cli && npm run build && cd ..
git add cli/src/slash cli/src/synthesizer.ts cli/test/slash_router.test.ts cli/dist
git commit -m "feat(sidecar): extension, turn and direct-shell slash commands; cancellable TDD"
```

---

### Task 4: Sidecar wiring: protocol, jobs, sessions and options

**Files:**
- Modify: `cli/src/protocol.ts`
- Modify: `cli/src/sidecar.ts`
- Modify: `cli/test/sidecar.test.ts`

- [ ] **Step 1: Isolate HOME in the sidecar tests and write the failing tests**

In `cli/test/sidecar.test.ts`:

1. Change the sidecar import to `import { SidecarOptions, SidecarServer } from "../src/sidecar.js";` and add `import { slashCatalog } from "../src/slash/catalog.js";`.

2. Replace `withSidecar` with:

```ts
async function withSidecar(
  script: (n: number) => Reply,
  mode: "auto" | "review",
  fn: (rig: Rig) => Promise<void>,
  onShutdown?: () => void,
  setup?: (app: ApplicationCore) => Partial<SidecarOptions>,
): Promise<void> {
  const gw = await startGateway(script);
  const repo = makeRepo();
  const home = makeHome();
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash" } as any);
  const events: any[] = [];
  const server = new SidecarServer({ app, mode, write: (line) => events.push(JSON.parse(line)), onShutdown, ...setup?.(app) });
  server.start();
  try {
    await fn({ server, events, repo, app, send: (msg) => server.handleLine(JSON.stringify({ v: 1, ...msg })) });
  } finally {
    await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
    await server.idle();
    app.shutdown();
    await gw.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}
```

and add `app: ApplicationCore;` to the `Rig` interface.

3. In "start announces the protocol and an idle session" change the first assertion to:

```ts
      assert.deepEqual(events[0], { v: 1, type: "hello", protocol: 1, pid: process.pid, commands: slashCatalog() });
```

4. Replace the test "slash status replies with slash.result" with:

```ts
  test("slash status replies with slash.result", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events, send }) => {
      await send({ type: "slash", id: "s1", command: "status" });
      await server.idle();
      const reply = events.find((e) => e.type === "slash.result");
      assert.equal(reply.id, "s1");
      assert.equal(reply.command, "status");
      assert.equal(reply.success, true);
      assert.match(reply.output, /^model\s+m$/m);
      const order = events.slice(2).map((e) => (e.type === "session.state" ? `state:${e.busy}` : e.type));
      assert.deepEqual(order, ["state:true", "slash.result", "state:false"]);
    });
  });
```

5. Add a new `describe` block at the end of the `SidecarServer` describes (before `const cliRoot`):

```ts
describe("SidecarServer: sessions and slash commands", () => {
  test("a prompt turn is checkpointed first, saved after, and joins the history", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events, app, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "what is here?" });
      await server.idle();
      const checkpoints = app.getCheckpointManager().listCheckpoints();
      assert.equal(checkpoints.length, 1);
      assert.equal(checkpoints[0].name, "Turn: what is here?");
      const sessions = app.getSessionManager().listSessions();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].title, "what is here?");
      await send({ type: "slash", id: "s1", command: "history" });
      await server.idle();
      assert.match(events.find((e) => e.type === "slash.result").output, /^\[1\] what is here\?$/m);
    });
  });

  test("a diff reply is marked for diff colouring", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events, repo, send }) => {
      fs.writeFileSync(path.join(repo, "base.txt"), "changed\n");
      await send({ type: "slash", id: "s1", command: "diff" });
      await server.idle();
      const reply = events.find((e) => e.type === "slash.result");
      assert.equal(reply.format, "diff");
      assert.match(reply.output, /^\+changed$/m);
    });
  });

  test("a command that resolves to a prompt runs it as a turn under the command id", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "what is here?" });
      await server.idle();
      const before = events.length;
      await send({ type: "slash", id: "s1", command: "history", args: "run 1" });
      await server.idle();
      const later = events.slice(before);
      const reply = later.find((e) => e.type === "slash.result");
      assert.equal(reply.prompt, "what is here?");
      assert.equal(reply.output, "");
      const result = later.find((e) => e.type === "turn.result");
      assert.equal(result.turn_id, "s1");
      assert.ok(later.indexOf(reply) < later.indexOf(result));
    });
  });

  test("/mode review makes later writes wait for approval", async () => {
    await withSidecar(writeTurn, "auto", async ({ server, events, send }) => {
      await send({ type: "slash", id: "s1", command: "mode", args: "review" });
      await server.idle();
      assert.equal(events.filter((e) => e.type === "session.state").at(-1).mode, "review");
      await send({ type: "prompt.submit", id: "t1", text: "make x" });
      const req = await waitForEvent(events, (e) => e.type === "approval.request");
      await send({ type: "deny", id: req.id });
      await server.idle();
    });
  });

  test("cancelling a command that cannot stop says so and lets it finish", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events, send }) => {
      await send({ type: "slash", id: "s1", command: "!", args: "sleep 0.5; echo done-sleeping" });
      await send({ type: "cancel" });
      await server.idle();
      assert.equal(events.find((e) => e.type === "notice").text, "! cannot be cancelled; it finishes on its own.");
      const reply = events.find((e) => e.type === "slash.result");
      assert.equal(reply.success, true);
      assert.match(reply.output, /done-sleeping/);
    });
  });

  test("cancelling /tdd stops it with an honest result", async () => {
    await withSidecar(() => ({ kind: "text", content: "slow answer", delayMs: 3000 }), "auto", async ({ server, events, send }) => {
      const started = Date.now();
      await send({ type: "slash", id: "s1", command: "tdd", args: "fix the parser" });
      await new Promise((r) => setTimeout(r, 200));
      await send({ type: "cancel" });
      await server.idle();
      assert.ok(Date.now() - started < 2500, "stopped well before the gateway replied");
      const reply = events.find((e) => e.type === "slash.result");
      assert.equal(reply.success, false);
      assert.match(reply.output, /Stopped by operator\./);
    });
  });

  test("--resume restores a saved session and says so", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ events, app }) => {
      assert.equal(events[2].type, "notice");
      assert.equal(events[2].text, "Resumed session old-session (2 messages).");
      assert.deepEqual(app.getAgent().getMessages().map((m) => m.content), ["s", "earlier question"]);
    }, undefined, (app) => {
      const now = new Date().toISOString();
      app.getSessionManager().saveSession({
        id: "old-session",
        title: "earlier",
        createdAt: now,
        updatedAt: now,
        workspace: app.getConfig().workspace,
        model: "m",
        messages: [{ role: "system", content: "s" }, { role: "user", content: "earlier question" }] as any,
      });
      return { resume: "old-session" };
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cli && node --import tsx --test test/sidecar.test.ts > /tmp/s4.txt 2>&1`
Expected: FAIL: `SidecarOptions` has no `resume`; `hello` lacks `commands`; the new tests fail.

- [ ] **Step 3: Protocol**

In `cli/src/protocol.ts`:

1. Add `import type { SlashSpec } from "./slash/catalog.js";` below the existing imports, and `export const MAX_SLASH_OUTPUT = 32_000;` below `MAX_SUMMARY`.
2. Change the `hello` member of `SidecarEvent` to:

```ts
  | { type: "hello"; protocol: number; pid: number; commands: Array<Pick<SlashSpec, "name" | "usage" | "summary">> }
```

3. Replace the `slash.result` member with:

```ts
  | {
      type: "slash.result";
      id: string;
      command: string;
      success: boolean;
      output: string;
      /** "diff": colour unified-diff lines. */
      format?: "diff";
      /** Text for the client to put into the composer. */
      composer?: string;
      /** The command started a turn with this prompt; the turn's events follow under the same id. */
      prompt?: string;
    }
  | { type: "notice"; text: string }
```

- [ ] **Step 4: Sidecar**

In `cli/src/sidecar.ts`:

1. Imports: add `import * as os from "node:os";`, `import type { AgentObserver } from "./agent.js";`, `import { CheckpointManager } from "./checkpoint.js";`, `import { redactForPersistence } from "./core/persistence_protection.js";`, `import { SlashHost, SlashOutcome, SlashSpec, errorText, findSlash, slashCatalog } from "./slash/catalog.js";`, `import { routeSlash } from "./slash/router.js";`. Change the turn import to `import { TurnResult, failedTurnFromError, lifecycleStatusForTurn, summarizeTurn } from "./core/turn.js";` and add `MAX_SLASH_OUTPUT` and `stripEscapes` to the `./protocol.js` import list.

2. Extend `SidecarOptions`:

```ts
  /** Session to continue: an id, or "latest". */
  resume?: string;
  /** Prompt history file; defaults to ~/.nexus_history. */
  historyFile?: string;
```

3. Add fields after `private shutdownPromise?: Promise<void>;`:

```ts
  private readonly resume?: string;
  private readonly history: string[];
  private sessionId: string;
  private checkpointManager: CheckpointManager;
  /** The running slash command; undefined for prompt turns and for commands that became turns. */
  private activeSpec?: SlashSpec;
```

4. At the end of the constructor add:

```ts
    this.resume = options.resume;
    this.checkpointManager = this.app.getCheckpointManager();
    this.sessionId = this.app.getSessionManager().generateSessionId();
    this.history = loadPromptHistory(options.historyFile ?? path.join(os.homedir(), ".nexus_history"));
```

5. Replace `start()` with:

```ts
  start(): void {
    this.emit({ type: "hello", protocol: PROTOCOL_VERSION, pid: process.pid, commands: slashCatalog() });
    const resumed = this.resume ? this.resumeSession(this.resume) : undefined;
    this.emitSessionState();
    if (resumed) this.emit({ type: "notice", text: resumed.message });
  }
```

6. In `handleLine`, replace the `cancel` case body with `this.cancel(); return;` and the `slash` case body with `this.slash(command.id, command.command, command.args); return;` (no `await`: a running command must not block `cancel`).

7. Replace `submit` and `runTurn` with the following, and replace the old `slash` method too:

```ts
  private cancel(): void {
    const spec = this.activeSpec;
    if (this.activeTurn && spec && !spec.cancellable) {
      const name = spec.name === "!" ? "!" : `/${spec.name}`;
      this.emit({ type: "notice", text: `${name} cannot be cancelled; it finishes on its own.` });
      return;
    }
    this.turnAbort?.abort(new Error("operator cancel"));
  }

  /** Reports BUSY for `id` when a turn or command is running or the sidecar is shutting down. */
  private rejectBusy(id: string): boolean {
    if (!this.shutdownPromise && !this.activeTurn) return false;
    const message = this.shutdownPromise ? "The sidecar is shutting down." : "A turn or command is running; cancel it or wait for its result.";
    this.emit({ type: "error", id, code: "BUSY", message });
    return true;
  }

  /** Runs one turn or command as the session's only activity. Busy is reported before `body` starts. */
  private runJob(id: string, spec: SlashSpec | undefined, body: (signal: AbortSignal) => Promise<void>): void {
    const abort = new AbortController();
    this.turnAbort = abort;
    this.activeSpec = spec;
    let settle!: () => void;
    this.activeTurn = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.emitSessionState();
    void body(abort.signal)
      .catch((err) => this.emit({ type: "error", id, code: "INTERNAL", message: redactSecrets(errorText(err)) }))
      .finally(() => {
        this.activeTurn = undefined;
        this.turnAbort = undefined;
        this.activeSpec = undefined;
        this.emitSessionState();
        settle();
      });
  }

  private submit(id: string, text: string): void {
    if (this.rejectBusy(id)) return;
    this.history.push(text.trim());
    this.runJob(id, undefined, (signal) => this.turn(id, text, text, `Turn: ${text.slice(0, 30)}`, signal));
  }

  private observerFor(turnId: string): AgentObserver {
    return {
      onAssistantDelta: (delta) => this.emit({ type: "assistant.delta", turn_id: turnId, text: redactSecrets(delta) }),
      onToolStart: ({ callId, tool, args }) => this.emit({ type: "tool.start", turn_id: turnId, call_id: callId, tool, subject: toolSubject(args) }),
      onToolEnd: ({ callId, tool, success, output, error }) =>
        this.emit({ type: "tool.end", turn_id: turnId, call_id: callId, tool, success, ...toolSummary(success, output, error) }),
    };
  }

  private confirmFor(turnId: string, signal: AbortSignal) {
    return this.mode === "review"
      ? (tool: string, args: Record<string, any>) => this.requestApproval(turnId, signal, tool, args)
      : undefined;
  }

  /** One agent turn: checkpoint, run, save the session, report the result. */
  private async turn(turnId: string, prompt: string | any[], label: string, checkpoint: string, signal: AbortSignal): Promise<void> {
    try {
      this.checkpointManager.createCheckpoint(checkpoint);
    } catch (err) {
      const message = `No checkpoint could be saved, so the turn did not start: ${redactSecrets(errorText(err))}`;
      this.emit({ type: "error", id: turnId, code: "INTERNAL", message });
      return;
    }
    const agent = this.app.getAgent();
    agent.setObserver(this.observerFor(turnId));
    let turn: TurnResult;
    try {
      turn = await agent.runTurn(prompt, this.confirmFor(turnId, signal), { signal });
    } catch (err) {
      turn = failedTurnFromError(err, this.app.getConfig().maxSteps);
    } finally {
      agent.setObserver(undefined);
    }
    try {
      this.saveSession(label, turn);
    } catch (err) {
      this.emit({ type: "notice", text: `The session could not be saved: ${redactSecrets(errorText(err))}` });
    }
    const { heading, line } = summarizeTurn(turn);
    const summary = turn.execution === "COMPLETED" ? agent.getCompletionSummary() : undefined;
    this.emit({
      type: "turn.result",
      turn_id: turnId,
      heading,
      line: redactSecrets(line),
      turn: projectTurn(turn),
      model_summary: summary
        ? { summary: redactSecrets(summary.summary), ...(summary.notes ? { notes: redactSecrets(summary.notes) } : {}) }
        : null,
    });
  }

  private slash(id: string, command: string, args: string): void {
    if (this.rejectBusy(id)) return;
    this.runJob(id, findSlash(command), async (signal) => {
      const agent = this.app.getAgent();
      agent.setObserver(this.observerFor(id));
      let outcome: SlashOutcome;
      try {
        outcome = await routeSlash(this.slashHost(id), command, args, signal);
      } finally {
        agent.setObserver(undefined);
      }
      if (outcome.kind === "turn") {
        this.activeSpec = undefined;
        this.emit({ type: "slash.result", id, command: outcome.command, success: true, output: "", prompt: capText(redactSecrets(outcome.label)) });
        await this.turn(id, outcome.prompt, outcome.label, outcome.checkpoint, signal);
        return;
      }
      this.emit({
        type: "slash.result",
        id,
        command: outcome.command,
        success: outcome.success,
        output: capText(redactSecrets(stripEscapes(outcome.output)), MAX_SLASH_OUTPUT),
        ...(outcome.format ? { format: outcome.format } : {}),
        ...(outcome.composer !== undefined ? { composer: outcome.composer } : {}),
      });
    });
  }

  private slashHost(id: string): SlashHost {
    return {
      app: this.app,
      mode: () => this.mode,
      setMode: (mode) => {
        this.mode = mode;
        if (mode === "review") this.alwaysApprove = false;
      },
      sessionId: () => this.sessionId,
      setSessionId: (sessionId) => {
        this.sessionId = sessionId;
      },
      checkpoints: () => this.checkpointManager,
      setWorkspace: (dir) => this.setWorkspace(dir),
      saveSession: (title) => this.saveSession(title),
      resumeSession: (sessionId) => this.resumeSession(sessionId),
      history: () => this.history,
      confirm: (signal) => this.confirmFor(id, signal),
    };
  }

  private setWorkspace(dir: string): void {
    this.app.getConfig().workspace = dir;
    this.app.getAgent().setWorkspace(dir);
    this.checkpointManager = new CheckpointManager(dir);
  }

  /** Same record the REPL saves after each turn. Skipped while the conversation holds only the system prompt. */
  private saveSession(title?: string, turn?: TurnResult): void {
    const agent = this.app.getAgent();
    const messages = agent.getMessages();
    if (messages.length <= 1) return;
    const config = this.app.getConfig();
    const now = new Date().toISOString();
    this.app.getSessionManager().saveSession(
      {
        id: this.sessionId,
        title: title ? title.slice(0, 60).replace(/\n/g, " ") : "Active Session",
        createdAt: now,
        updatedAt: now,
        workspace: config.workspace,
        model: config.model,
        messages,
        tokenStats: agent.getTokenStats(),
        ...(turn ? { status: lifecycleStatusForTurn(turn), lastTurn: turn } : {}),
      },
      agent.getWorkspacePathIdentity(),
    );
  }

  private resumeSession(id?: string): { ok: boolean; message: string } {
    const manager = this.app.getSessionManager();
    const session = !id || id === "latest" ? manager.getLatestSession() : manager.loadSession(id);
    if (!session) return { ok: false, message: `Session not found: ${id || "latest"}` };
    this.sessionId = session.id;
    if (session.workspace && fs.existsSync(session.workspace)) this.setWorkspace(session.workspace);
    this.app.getAgent().setMessages(session.messages);
    return { ok: true, message: `Resumed session ${session.id} (${session.messages.length} messages).` };
  }
```

Keep `requestApproval` (with the 3A `review` field), `resolveApproval`, `shutdown`, `emitSessionState` and `emit` as they are.

8. Add below the class (before `main`):

```ts
/** Prompt history from the REPL's file, redacted; empty when the file is missing or unreadable. */
function loadPromptHistory(file: string): string[] {
  try {
    return redactForPersistence(fs.readFileSync(file, "utf-8"))
      .split("\n")
      .filter((line) => line.trim());
  } catch {
    return [];
  }
}
```

9. In `main`, replace the option list with the `harness repl` set and pass `resume`:

```ts
  const program = new Command()
    .name("nexus-sidecar")
    .option("-e, --endpoint <url>", "Local LLM endpoint")
    .option("-m, --model <name>", "Model name")
    .option("-w, --workspace <path>", "Workspace directory")
    .option("-s, --max-steps <number>", "Maximum steps per turn")
    .option("-t, --temperature <number>", "Model temperature")
    .option("--shell <type>", "Shell for commands", "bash")
    .option("--fallback <urls>", "Comma-separated fallback LLM endpoints")
    .option("--context-limit <tokens>", "Model context window limit in tokens")
    .option("--dry-run", "Simulate file modifications without writing changes to disk")
    .option("--read-only", "Reject all mutating tool executions and commands")
    .option("--sandbox [mode]", "Isolate command execution using bubblewrap or Docker")
    .option("--worktree", "Isolate execution inside an ephemeral git worktree")
    .option("--authoritative-verifier <command>", "Trusted command whose success may authorize automatic worktree merge")
    .option("--record-flight", "Record execution into an append-only .flightlog")
    .option("--planner-model <name>", "Deep reasoning model for planning")
    .option("--planner-endpoint <url>", "Inference endpoint for the planner model")
    .option("--coder-model <name>", "Model for code implementation")
    .option("--coder-endpoint <url>", "Inference endpoint for the coder model")
    .option("--approve", "Require operator approval before edits and shell commands")
    .option("-r, --resume [id]", "Resume a saved session (the latest when no id is given)")
    .parse(argv);
```

and in the `new SidecarServer({ ... })` call add:

```ts
    resume: typeof options.resume === "string" ? options.resume : options.resume ? "latest" : undefined,
```

- [ ] **Step 5: Run the tests**

Run: `cd cli && node --import tsx --test test/sidecar.test.ts > /tmp/s4.txt 2>&1`
Expected: PASS, every test in the file including the 7 new ones.

- [ ] **Step 6: Full CLI suite, build, commit**

Run the full CLI suite (expected 345 tests, only the known failure), then:

```bash
cd cli && npm run build && cd ..
git add cli/src/protocol.ts cli/src/sidecar.ts cli/test/sidecar.test.ts cli/dist
git commit -m "feat(sidecar): run slash commands, checkpoint and save turns, resume sessions"
```

---

### Task 5: Rust protocol, slash parsing and composer end check

**Files:**
- Modify: `core/src/bin/nexus_tui/protocol.rs`
- Create: `core/src/bin/nexus_tui/slash.rs`
- Modify: `core/src/bin/nexus_tui.rs` (module declarations)
- Modify: `core/src/bin/nexus_tui/composer.rs`
- Modify: `core/src/bin/nexus_tui/live_state.rs` (Hello arms and one test)
- Modify: `core/src/bin/nexus_tui/sidecar.rs` (two test patterns)

- [ ] **Step 1: Write the failing tests**

1. In the test module of `protocol.rs` add:

```rust
    #[test]
    fn hello_carries_the_catalogue_and_slash_results_and_notices_parse() {
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"hello","protocol":1,"pid":1,"commands":[{"name":"diff","usage":"/diff","summary":"Uncommitted changes as a diff"}]}"#
            ),
            Ok(Event::Hello {
                protocol: 1,
                commands: vec![SlashSpec {
                    name: "diff".into(),
                    usage: "/diff".into(),
                    summary: "Uncommitted changes as a diff".into()
                }]
            })
        );
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"slash.result","id":"s1","command":"diff","success":true,"output":"-a\n+b","format":"diff"}"#
            ),
            Ok(Event::SlashResult {
                id: "s1".into(),
                command: "diff".into(),
                success: true,
                output: "-a\n+b".into(),
                format: Some("diff".into()),
                composer: None,
                prompt: None,
            })
        );
        assert!(matches!(
            parse_event(r#"{"v":1,"type":"slash.result","id":"s2","command":"history","success":true,"output":"","prompt":"fix it"}"#),
            Ok(Event::SlashResult { prompt: Some(ref prompt), .. }) if prompt == "fix it"
        ));
        assert_eq!(
            parse_event(r#"{"v":1,"type":"notice","text":"Resumed session a (4 messages)."}"#),
            Ok(Event::Notice {
                text: "Resumed session a (4 messages).".into()
            })
        );
    }
```

2. In `commands_encode_as_single_versioned_lines` add to the array:

```rust
            (
                Command::Slash {
                    id: "s1".into(),
                    command: "diff".into(),
                    args: String::new(),
                },
                serde_json::json!({"v":1,"type":"slash","id":"s1","command":"diff","args":""}),
            ),
```

3. In `parses_every_rendered_event_type` change `Ok(Event::Hello { protocol: 1 })` to `Ok(Event::Hello { protocol: 1, commands: Vec::new() })`. In `unknown_event_types_are_tolerated` change the JSON to `r#"{"v":1,"type":"future.event","x":1}"#`.

4. Create `core/src/bin/nexus_tui/slash.rs` with its tests:

```rust
//! Slash commands typed into the composer: which ones the live view handles itself, which go to the sidecar,
//! and which catalogue entries complete a partly typed name.
use crate::protocol::SlashSpec;

#[derive(Clone, Debug, PartialEq)]
pub enum Invocation {
    Quit,
    Help,
    AlreadyLive,
    /// Runs in the sidecar. `command` is lowercase without the slash; `!` marks a direct shell command.
    Remote { command: String, args: String },
}

/// Reads a submitted draft. `None` means an ordinary prompt: no leading `/` or `!`, or a leading path such as
/// `/etc/hosts is wrong`.
pub fn parse(draft: &str) -> Option<Invocation> {
    let text = draft.trim();
    if let Some(rest) = text.strip_prefix('!') {
        let args = rest.trim();
        return (!args.is_empty()).then(|| Invocation::Remote {
            command: "!".into(),
            args: args.into(),
        });
    }
    let rest = text.strip_prefix('/')?;
    let (name, args) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    if name.is_empty() || name.contains('/') {
        return None;
    }
    let name = name.to_lowercase();
    Some(match name.as_str() {
        "exit" | "quit" | "q" => Invocation::Quit,
        "help" | "?" => Invocation::Help,
        "tui" => Invocation::AlreadyLive,
        _ => Invocation::Remote {
            command: name,
            args: args.trim().into(),
        },
    })
}

/// Catalogue entries whose name starts with the typed `/prefix`. Empty unless the draft is a single `/word`.
pub fn matches<'a>(commands: &'a [SlashSpec], draft: &str) -> Vec<&'a SlashSpec> {
    let Some(typed) = draft.strip_prefix('/') else {
        return Vec::new();
    };
    if typed.contains(|c: char| c.is_whitespace() || c == '/') {
        return Vec::new();
    }
    let typed = typed.to_lowercase();
    commands
        .iter()
        .filter(|spec| spec.name.starts_with(&typed))
        .collect()
}

/// True when the usage has a required `<argument>` outside `[optional]` brackets.
pub fn needs_args(usage: &str) -> bool {
    let mut depth = 0usize;
    for c in usage.chars() {
        match c {
            '[' => depth += 1,
            ']' => depth = depth.saturating_sub(1),
            '<' if depth == 0 => return true,
            _ => {}
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote(command: &str, args: &str) -> Invocation {
        Invocation::Remote {
            command: command.into(),
            args: args.into(),
        }
    }

    fn catalogue(names: &[&str]) -> Vec<SlashSpec> {
        names
            .iter()
            .map(|name| SlashSpec {
                name: (*name).into(),
                usage: format!("/{name}"),
                summary: String::new(),
            })
            .collect()
    }

    fn names(found: Vec<&SlashSpec>) -> Vec<&str> {
        found.iter().map(|spec| spec.name.as_str()).collect()
    }

    #[test]
    fn parse_separates_local_remote_and_prompt_drafts() {
        assert_eq!(parse("/quit"), Some(Invocation::Quit));
        assert_eq!(parse("  /Q "), Some(Invocation::Quit));
        assert_eq!(parse("/exit"), Some(Invocation::Quit));
        assert_eq!(parse("/help"), Some(Invocation::Help));
        assert_eq!(parse("/?"), Some(Invocation::Help));
        assert_eq!(parse("/tui"), Some(Invocation::AlreadyLive));
        assert_eq!(parse("/Diff"), Some(remote("diff", "")));
        assert_eq!(
            parse("/commit fix: parser\n\nbody"),
            Some(remote("commit", "fix: parser\n\nbody"))
        );
        assert_eq!(parse("!git status"), Some(remote("!", "git status")));
        assert_eq!(parse("!3"), Some(remote("!", "3")));
        assert_eq!(parse("!"), None);
        assert_eq!(parse("/"), None);
        assert_eq!(parse("/etc/hosts is wrong"), None);
        assert_eq!(parse("fix /diff"), None);
    }

    #[test]
    fn matches_complete_a_single_slash_word() {
        let commands = catalogue(&["diff", "git", "help", "history"]);
        assert_eq!(names(matches(&commands, "/h")), vec!["help", "history"]);
        assert_eq!(
            names(matches(&commands, "/")),
            vec!["diff", "git", "help", "history"]
        );
        assert_eq!(names(matches(&commands, "/HI")), vec!["history"]);
        assert!(matches(&commands, "/diff ").is_empty());
        assert!(matches(&commands, "/x").is_empty());
        assert!(matches(&commands, "diff").is_empty());
        assert!(matches(&commands, "/etc/").is_empty());
    }

    #[test]
    fn needs_args_ignores_optional_arguments() {
        assert!(needs_args("/tdd <issue>"));
        assert!(needs_args("/image <path> [prompt]"));
        assert!(needs_args("/skill <name> | init <name>"));
        assert!(!needs_args("/history [query|run <n>]"));
        assert!(!needs_args("/checkpoint [name|diff <id> [base]|prune [n]]"));
        assert!(!needs_args("/diff"));
    }
}
```

5. In the test module of `composer.rs` add:

```rust
    #[test]
    fn at_end_follows_the_cursor() {
        let mut composer = Composer::from("ab");
        assert!(composer.at_end());
        composer.left();
        assert!(!composer.at_end());
        composer.line_end();
        assert!(composer.at_end());
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui > /tmp/r5.txt 2>&1`
Expected: compile errors: no `SlashSpec`, `Command::Slash`, `Event::SlashResult`, `Event::Notice`, module `slash`, `Composer::at_end`.

- [ ] **Step 3: Implement**

1. `protocol.rs`: add after `ModelSummary`:

```rust
/// One entry of the slash-command catalogue the sidecar announces in `hello`.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct SlashSpec {
    pub name: String,
    pub usage: String,
    pub summary: String,
}
```

Change the `Hello` variant to:

```rust
    #[serde(rename = "hello")]
    Hello {
        protocol: u64,
        #[serde(default)]
        commands: Vec<SlashSpec>,
    },
```

Add before `Error`:

```rust
    #[serde(rename = "slash.result")]
    SlashResult {
        id: String,
        command: String,
        success: bool,
        output: String,
        #[serde(default)]
        format: Option<String>,
        #[serde(default)]
        composer: Option<String>,
        /// Set when the command started a turn with this prompt; the turn's events follow under the same id.
        #[serde(default)]
        prompt: Option<String>,
    },
    #[serde(rename = "notice")]
    Notice { text: String },
```

Change the doc comment on `Unknown` to `/// Event types newer than this client.`. In the tests of `core/src/bin/nexus_tui/sidecar.rs`, the two `matches!` patterns `SidecarMsg::Event(Event::Hello { protocol: 1 })` become `SidecarMsg::Event(Event::Hello { protocol: 1, .. })`. Add to `Command` before `Shutdown`:

```rust
    #[serde(rename = "slash")]
    Slash {
        id: String,
        command: String,
        args: String,
    },
```

2. `core/src/bin/nexus_tui.rs`: add `#[path = "nexus_tui/slash.rs"] mod slash;` after the `composer` declaration, matching the style of the other `#[path]` lines.

3. `composer.rs`: add to `impl Composer`:

```rust
    pub fn at_end(&self) -> bool {
        self.cursor == self.text.len()
    }
```

4. `live_state.rs`: replace the two `Event::Hello` arms in `apply` with:

```rust
            Event::Hello { protocol, commands } if protocol == PROTOCOL_VERSION => {
                self.commands = commands;
                self.link = Link::Ready;
            }
            Event::Hello { protocol, .. } => self.fail(
                format!("The agent sidecar speaks protocol {protocol}; this view needs protocol {PROTOCOL_VERSION}."),
                None,
                Vec::new(),
            ),
```

add the field `pub commands: Vec<SlashSpec>,` to `LiveState` (initialised to `Vec::new()` in `new()`), change the protocol import to `use crate::protocol::{Command, Event, PROTOCOL_VERSION, SlashSpec};`, add the arms `Event::SlashResult { .. } | Event::Notice { .. } => {}` before `Event::Unknown => {}` (Task 6 implements them), and in the test `a_protocol_mismatch_fails_the_link` change `Event::Hello { protocol: 2 }` to `Event::Hello { protocol: 2, commands: Vec::new() }`.

- [ ] **Step 4: Run the tests**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui > /tmp/r5.txt 2>&1`
Expected: PASS, 105 tests (100 + 1 protocol + 3 slash + 1 composer). `dead_code` warnings for `slash` items are expected until Task 6.

- [ ] **Step 5: Commit**

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/protocol.rs core/src/bin/nexus_tui/slash.rs core/src/bin/nexus_tui/composer.rs core/src/bin/nexus_tui/live_state.rs core/src/bin/nexus_tui.rs
git add core/src/bin/nexus_tui.rs core/src/bin/nexus_tui/protocol.rs core/src/bin/nexus_tui/slash.rs core/src/bin/nexus_tui/composer.rs core/src/bin/nexus_tui/live_state.rs
git commit -m "feat(tui): slash protocol types, draft parsing and completion matching"
```

---

### Task 6: Slash commands in the live state

**Files:**
- Modify: `core/src/bin/nexus_tui/live_state.rs`
- Modify: `core/src/bin/nexus_tui/live_view.rs` (placeholder arms only)

- [ ] **Step 1: Write the failing tests**

Add to the test module of `live_state.rs` (it already has `ready`, `ev`, `key`, `ctrl`, `type_text`):

```rust
    const IDLE_STATE: &str = r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":null,"busy":false}"#;

    fn hello_with(commands: &[(&str, &str)]) -> Event {
        Event::Hello {
            protocol: 1,
            commands: commands
                .iter()
                .map(|(name, usage)| SlashSpec {
                    name: (*name).into(),
                    usage: (*usage).into(),
                    summary: format!("{name} summary"),
                })
                .collect(),
        }
    }

    #[test]
    fn slash_commands_go_to_the_sidecar_and_results_land_in_the_transcript() {
        let mut state = ready();
        type_text(&mut state, "/diff");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::Slash {
                id: "s1".into(),
                command: "diff".into(),
                args: String::new()
            }))
        );
        assert_eq!(state.transcript, vec![Entry::Command("/diff".into())]);
        assert!(state.session.busy);
        state.apply(ev(r#"{"v":1,"type":"slash.result","id":"s1","command":"diff","success":true,"output":"-a\n+b","format":"diff"}"#));
        assert_eq!(
            state.transcript.last(),
            Some(&Entry::Output {
                success: true,
                text: "-a\n+b".into(),
                diff: true
            })
        );
        assert_eq!(state.pending, None);
        state.apply(ev(IDLE_STATE));
        type_text(&mut state, "!ls -la");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::Slash {
                id: "s2".into(),
                command: "!".into(),
                args: "ls -la".into()
            }))
        );
    }

    #[test]
    fn local_commands_never_reach_the_sidecar() {
        let mut state = ready();
        type_text(&mut state, "/help");
        assert_eq!(state.on_key(key(KeyCode::Enter)), None);
        assert_eq!(state.overlay, Some(Overlay::Help { scroll: 0 }));
        state.on_key(key(KeyCode::Esc));
        type_text(&mut state, "/tui");
        assert_eq!(state.on_key(key(KeyCode::Enter)), None);
        assert_eq!(
            state.transcript.last(),
            Some(&Entry::Info("You are already in the live view.".into()))
        );
        assert!(!state.session.busy);
        type_text(&mut state, "/etc/hosts is wrong");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::PromptSubmit {
                id: "t1".into(),
                text: "/etc/hosts is wrong".into()
            }))
        );
        state.apply(ev(IDLE_STATE));
        type_text(&mut state, "/quit");
        assert_eq!(state.on_key(key(KeyCode::Enter)), Some(Action::Quit));
    }

    #[test]
    fn a_command_that_starts_a_turn_stays_pending_until_the_turn_result() {
        let mut state = ready();
        type_text(&mut state, "/history run 1");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::Slash {
                id: "s1".into(),
                command: "history".into(),
                args: "run 1".into()
            }))
        );
        state.apply(ev(r#"{"v":1,"type":"slash.result","id":"s1","command":"history","success":true,"output":"","prompt":"fix it"}"#));
        assert_eq!(state.pending.as_deref(), Some("s1"));
        assert_eq!(
            state.transcript,
            vec![
                Entry::Command("/history run 1".into()),
                Entry::User("fix it".into())
            ]
        );
        state.apply(ev(r#"{"v":1,"type":"assistant.delta","turn_id":"s1","text":"On it."}"#));
        state.apply(ev(r#"{"v":1,"type":"turn.result","turn_id":"s1","heading":"TURN ENDED - NO CHANGES TO VERIFY","line":"No files changed","turn":{"execution":"COMPLETED","outcome":"NOT_REQUIRED"},"model_summary":null}"#));
        assert_eq!(state.pending, None);
        assert!(matches!(state.transcript.last(), Some(Entry::Banner { .. })));
        state.apply(ev(IDLE_STATE));
        type_text(&mut state, "/status");
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        state.apply(ev(
            r#"{"v":1,"type":"error","id":"s2","code":"INTERNAL","message":"boom"}"#,
        ));
        assert!(
            !state.session.busy,
            "an error for the pending command unlocks the composer"
        );
    }

    #[test]
    fn clear_paste_and_notices_change_the_view() {
        let mut state = ready();
        state.transcript.push(Entry::User("old".into()));
        type_text(&mut state, "/clear");
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        state.apply(ev(r#"{"v":1,"type":"slash.result","id":"s1","command":"clear","success":true,"output":"Conversation context reset."}"#));
        assert_eq!(
            state.transcript,
            vec![Entry::Output {
                success: true,
                text: "Conversation context reset.".into(),
                diff: false
            }]
        );
        state.apply(ev(IDLE_STATE));
        type_text(&mut state, "/paste");
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        state.apply(ev(r#"{"v":1,"type":"slash.result","id":"s2","command":"paste","success":true,"output":"Pasted 11 characters into the composer.","composer":"pasted text"}"#));
        assert_eq!(state.composer, "pasted text");
        state.apply(ev(
            r#"{"v":1,"type":"notice","text":"Resumed session a (4 messages)."}"#,
        ));
        assert_eq!(
            state.transcript.last(),
            Some(&Entry::Info("Resumed session a (4 messages).".into()))
        );
    }

    #[test]
    fn completion_lists_matches_and_tab_or_enter_completes() {
        let mut state = ready();
        state.apply(hello_with(&[
            ("diff", "/diff"),
            ("help", "/help"),
            ("history", "/history [query|run <n>]"),
            ("tdd", "/tdd <issue>"),
        ]));
        let shown = |state: &LiveState| {
            state.completion().map(|(found, pick)| {
                (
                    found.iter().map(|spec| spec.name.clone()).collect::<Vec<_>>(),
                    pick,
                )
            })
        };
        type_text(&mut state, "/h");
        assert_eq!(
            shown(&state),
            Some((vec!["help".to_string(), "history".to_string()], 0))
        );
        state.on_key(key(KeyCode::Down));
        assert_eq!(shown(&state).unwrap().1, 1);
        state.on_key(key(KeyCode::Up));
        assert_eq!(shown(&state).unwrap().1, 0);
        assert_eq!(state.on_key(key(KeyCode::Tab)), None);
        assert_eq!(state.composer, "/help ");
        assert_eq!(shown(&state), None);
        assert_eq!(
            state.focus,
            Focus::Composer,
            "tab completed instead of switching focus"
        );
        state.on_key(ctrl('l'));
        type_text(&mut state, "/hi");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::Slash {
                id: "s1".into(),
                command: "history".into(),
                args: String::new()
            }))
        );
        state.apply(ev(IDLE_STATE));
        type_text(&mut state, "/td");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            None,
            "a command with a required argument waits for it"
        );
        assert_eq!(state.composer, "/tdd ");
        state.on_key(ctrl('l'));
        type_text(&mut state, "/d");
        state.on_key(key(KeyCode::Esc));
        assert_eq!(shown(&state), None);
        state.on_key(key(KeyCode::Backspace));
        assert_eq!(shown(&state).map(|(found, _)| found.len()), Some(4));
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui live_state:: > /tmp/r6.txt 2>&1`
Expected: compile errors: no `Entry::Command`, `Entry::Output`, `Entry::Info`, `completion`.

- [ ] **Step 3: Implement**

In `core/src/bin/nexus_tui/live_state.rs`:

1. Add `use crate::slash::{self, Invocation};` after the protocol import.
2. Add to `Entry` (after `Notice(String),`):

```rust
    /// A slash or `!` command as the operator typed it.
    Command(String),
    /// What a command reported. `diff` asks for unified-diff colouring.
    Output {
        success: bool,
        text: String,
        diff: bool,
    },
    /// A quiet informational line from the sidecar or the view.
    Info(String),
```

3. Add fields to `LiveState` after `commands` and initialise them in `new()` (`slash_seq: 0, slash_pick: 0, slash_dismissed: false`):

```rust
    slash_seq: u64,
    /// Highlighted completion row.
    slash_pick: usize,
    /// Esc hid the completion list; editing the draft shows it again.
    slash_dismissed: bool,
```

4. Replace the placeholder `Event::SlashResult { .. } | Event::Notice { .. } => {}` arm in `apply` with:

```rust
            Event::SlashResult {
                id,
                command,
                success,
                output,
                format,
                composer,
                prompt,
            } => {
                if command == "clear" && success {
                    self.transcript.clear();
                    self.scroll_back = 0;
                }
                if !output.is_empty() || !success {
                    self.transcript.push(Entry::Output {
                        success,
                        text: output,
                        diff: format.as_deref() == Some("diff"),
                    });
                }
                if let Some(text) = composer {
                    self.composer.insert(&text);
                }
                match prompt {
                    // The command started a turn under its id; `turn.result` releases the composer.
                    Some(prompt) => self.transcript.push(Entry::User(prompt)),
                    None if self.pending.as_deref() == Some(id.as_str()) => self.pending = None,
                    None => {}
                }
            }
            Event::Notice { text } => self.transcript.push(Entry::Info(text)),
```

5. Replace `submit` with:

```rust
    fn submit(&mut self) -> Option<Action> {
        if self.link != Link::Ready
            || self.connecting()
            || self.session.busy
            || self.composer.text().trim().is_empty()
        {
            return None;
        }
        let text = self.composer.take();
        self.scroll_back = 0;
        self.focus = Focus::Composer;
        if let Some(invocation) = slash::parse(&text) {
            return self.invoke(text, invocation);
        }
        self.turn_seq += 1;
        self.transcript.push(Entry::User(text.clone()));
        self.session.busy = true;
        let id = format!("t{}", self.turn_seq);
        self.pending = Some(id.clone());
        Some(Action::Send(Command::PromptSubmit { id, text }))
    }

    fn invoke(&mut self, typed: String, invocation: Invocation) -> Option<Action> {
        match invocation {
            Invocation::Quit => Some(Action::Quit),
            Invocation::Help => {
                self.overlay = Some(Overlay::Help { scroll: 0 });
                None
            }
            Invocation::AlreadyLive => {
                self.transcript
                    .push(Entry::Info("You are already in the live view.".into()));
                None
            }
            Invocation::Remote { command, args } => {
                self.slash_seq += 1;
                let id = format!("s{}", self.slash_seq);
                self.transcript.push(Entry::Command(typed));
                self.session.busy = true;
                self.pending = Some(id.clone());
                Some(Action::Send(Command::Slash { id, command, args }))
            }
        }
    }

    /// Slash commands matching the draft while it is a bare `/word` with the cursor at its end, and the
    /// highlighted row.
    pub fn completion(&self) -> Option<(Vec<&SlashSpec>, usize)> {
        if self.slash_dismissed
            || self.overlay.is_some()
            || self.focus != Focus::Composer
            || !self.composer.at_end()
        {
            return None;
        }
        let found = slash::matches(&self.commands, self.composer.text());
        if found.is_empty() {
            return None;
        }
        let pick = self.slash_pick.min(found.len() - 1);
        Some((found, pick))
    }

    /// Keys the completion list takes while it is shown. `None` lets the key through to the composer.
    fn on_completion_key(&mut self, key: KeyEvent) -> Option<Option<Action>> {
        let (count, pick, chosen) = {
            let (found, pick) = self.completion()?;
            (found.len(), pick, found[pick].clone())
        };
        match key.code {
            KeyCode::Up => self.slash_pick = (pick + count - 1) % count,
            KeyCode::Down => self.slash_pick = (pick + 1) % count,
            KeyCode::Esc => self.slash_dismissed = true,
            KeyCode::Tab => self.complete(&chosen.name),
            KeyCode::Enter if key.modifiers.is_empty() => {
                self.complete(&chosen.name);
                if slash::needs_args(&chosen.usage) {
                    return Some(None);
                }
                return Some(self.submit());
            }
            _ => return None,
        }
        Some(None)
    }

    fn complete(&mut self, name: &str) {
        self.composer.clear();
        self.composer.insert(&format!("/{name} "));
    }
```

6. In `on_key`, right after the `match self.overlay { ... }` block (before `let page = ...`), add:

```rust
        if let Some(action) = self.on_completion_key(key) {
            return action;
        }
```

7. At the top of `on_composer_key` (after the `shift` binding), add:

```rust
        self.slash_pick = 0;
        self.slash_dismissed = false;
```

8. In `live_view.rs` `entry_lines`, add placeholder arms so it compiles (Task 7 renders them): `Entry::Command(_) | Entry::Output { .. } | Entry::Info(_) => {}`.

9. Add `SlashSpec` to the test module imports if the compiler asks (`use crate::protocol::{parse_event, SlashSpec};`).

- [ ] **Step 4: Run the tests**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui > /tmp/r6.txt 2>&1`
Expected: PASS, 110 tests (105 + 5). The 3A tests for Tab focus, Esc cancel and `?` help must still pass unchanged: completion only takes keys while its list is shown.

- [ ] **Step 5: Commit**

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/live_state.rs core/src/bin/nexus_tui/live_view.rs
git add core/src/bin/nexus_tui/live_state.rs core/src/bin/nexus_tui/live_view.rs
git commit -m "feat(tui): slash and ! commands, results, notices and completion in live state"
```

---

### Task 7: Rendering commands, replies, completion and command help

**Files:**
- Modify: `core/src/bin/nexus_tui/live_view.rs`

- [ ] **Step 1: Write the failing tests**

Add to the test module of `live_view.rs` (add `use crate::protocol::SlashSpec;` to its imports):

```rust
    fn spec(name: &str, usage: &str, summary: &str) -> SlashSpec {
        SlashSpec {
            name: name.into(),
            usage: usage.into(),
            summary: summary.into(),
        }
    }

    #[test]
    fn commands_replies_and_info_render_in_the_transcript() {
        let mut state = ready();
        state.transcript = vec![
            Entry::Command("/diff".into()),
            Entry::Output {
                success: true,
                text: "diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new".into(),
                diff: true,
            },
            Entry::Output {
                success: false,
                text: "Commit failed: nothing staged".into(),
                diff: false,
            },
            Entry::Info("Resumed session a.".into()),
        ];
        let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
        terminal
            .draw(|frame| {
                render_live(frame, &state);
            })
            .unwrap();
        let screen = terminal.backend().to_string();
        assert_shows(
            &screen,
            &[
                "› /diff",
                "  -old",
                "  +new",
                "  Commit failed: nothing staged",
                "  · Resumed session a.",
            ],
        );
        let lines = rows(&screen);
        for (text, color) in [
            ("+new", Color::Green),
            ("-old", Color::Red),
            ("Commit failed", Color::Red),
        ] {
            let row = lines.iter().position(|line| line.contains(text)).unwrap();
            let column = lines[row].find(text).unwrap();
            let x = u16::try_from(lines[row][..column].chars().count()).unwrap();
            let y = u16::try_from(row).unwrap();
            assert_eq!(terminal.backend().buffer()[(x, y)].fg, color, "{text}");
        }
    }

    #[test]
    fn the_completion_list_sits_above_the_composer_with_the_pick_highlighted() {
        let mut state = ready();
        state.commands = vec![
            spec("help", "/help", "List the slash commands"),
            spec("history", "/history [query|run <n>]", "Search earlier prompts"),
        ];
        for c in "/h".chars() {
            state.on_key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE));
        }
        state.on_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
        terminal
            .draw(|frame| {
                render_live(frame, &state);
            })
            .unwrap();
        let screen = terminal.backend().to_string();
        assert_shows(
            &screen,
            &[
                "/help",
                "List the slash commands",
                "/history [query|run <n>]",
                "tab complete · enter run · esc close",
            ],
        );
        let lines = rows(&screen);
        let picked = lines
            .iter()
            .position(|line| line.contains("Search earlier prompts"))
            .unwrap();
        let composer = lines
            .iter()
            .position(|line| line.starts_with("› /h"))
            .unwrap();
        assert_eq!(
            picked + 2,
            composer,
            "the list ends right above the composer border"
        );
        let y = u16::try_from(picked).unwrap();
        assert_eq!(terminal.backend().buffer()[(1, y)].bg, ACCENT);
    }

    #[test]
    fn help_lists_the_slash_commands_after_the_keys() {
        let mut state = ready();
        state.commands = vec![spec("diff", "/diff", "Uncommitted changes as a diff")];
        state.overlay = Some(crate::live_state::Overlay::Help { scroll: 0 });
        assert_shows(
            &draw(&state, 100, 40),
            &["Keys", "!command", "Commands", "/diff", "Uncommitted changes as a diff"],
        );
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui live_view:: > /tmp/r7.txt 2>&1`
Expected: the three new tests FAIL (entries render nothing, no completion list, no commands in help).

- [ ] **Step 3: Implement**

In `core/src/bin/nexus_tui/live_view.rs`:

1. Add `use crate::protocol::SlashSpec;` to the imports.
2. Replace the placeholder `Entry::Command(_) | Entry::Output { .. } | Entry::Info(_) => {}` arm in `entry_lines` with:

```rust
        Entry::Command(text) => {
            lines.push(Line::default());
            for (index, row) in text.split('\n').enumerate() {
                lines.push(Line::from(vec![
                    Span::styled(if index == 0 { "› " } else { "  " }, prompt),
                    Span::styled(expand_tabs(row), Style::default().fg(ACCENT)),
                ]));
            }
        }
        Entry::Output {
            success,
            text,
            diff,
        } => {
            let base = if *success {
                white
            } else {
                Style::default().fg(Color::Red)
            };
            lines.extend(text.split('\n').map(|row| {
                let style = if !*diff {
                    base
                } else if row.starts_with('+') && !row.starts_with("+++") {
                    Style::default().fg(Color::Green)
                } else if row.starts_with('-') && !row.starts_with("---") {
                    Style::default().fg(Color::Red)
                } else if row.starts_with("@@") {
                    Style::default().fg(Color::Cyan)
                } else if row.starts_with(' ') {
                    white
                } else {
                    muted
                };
                Line::from(Span::styled(format!("  {}", expand_tabs(row)), style))
            }));
        }
        Entry::Info(text) => lines.push(Line::from(Span::styled(
            format!("  · {}", one_line(text)),
            muted,
        ))),
```

3. In `render_live`, right after `render_composer(frame, inner, state, &composer);` add:

```rust
    if let Some((found, pick)) = state.completion() {
        render_completion(frame, rows[1], &found, pick);
    }
```

and change the help arm of the overlay match to `render_help(frame, rows[1], *scroll, &state.commands)`.

4. Add:

```rust
const MAX_COMPLETION_ROWS: usize = 6;

/// Slash-command completion: up to six rows at the bottom of the transcript area, the highlighted one in accent.
fn render_completion(frame: &mut Frame, area: Rect, found: &[&SlashSpec], pick: usize) {
    let shown = found
        .len()
        .min(MAX_COMPLETION_ROWS)
        .min(usize::from(area.height));
    if shown == 0 {
        return;
    }
    let first = (pick + 1).saturating_sub(shown);
    let width = found
        .iter()
        .map(|spec| spec.usage.chars().count())
        .max()
        .unwrap_or(0)
        .min(40);
    let lines: Vec<Line> = found
        .iter()
        .enumerate()
        .skip(first)
        .take(shown)
        .map(|(index, spec)| {
            let style = if index == pick {
                Style::default().fg(Color::Black).bg(ACCENT)
            } else {
                Style::default().fg(Color::White).bg(SURFACE)
            };
            Line::from(Span::styled(
                format!(" {:<width$}  {} ", spec.usage, spec.summary),
                style,
            ))
        })
        .collect();
    let height = u16::try_from(shown).unwrap_or(0);
    let rect = Rect::new(area.x, area.bottom() - height, area.width, height);
    frame.render_widget(Clear, rect);
    frame.render_widget(
        Paragraph::new(lines).style(Style::default().bg(SURFACE)),
        rect,
    );
}
```

5. Add two rows to `HELP`, after `("ctrl+l", "clear the draft"),`:

```rust
    ("/", "slash commands: type / to list them, tab completes"),
    ("!command", "run a shell command directly; !n runs prompt n again"),
```

6. Replace `render_help` with:

```rust
/// Draws the help panel: keys, then the sidecar's slash commands. Returns its visible rows and largest scroll.
fn render_help(frame: &mut Frame, area: Rect, scroll: usize, commands: &[SlashSpec]) -> (usize, usize) {
    let key = Style::default().fg(ACCENT).add_modifier(Modifier::BOLD);
    let heading = Style::default()
        .fg(Color::White)
        .add_modifier(Modifier::BOLD);
    let white = Style::default().fg(Color::White);
    let mut lines: Vec<Line> = HELP
        .iter()
        .map(|(keys, text)| {
            if keys.is_empty() {
                Line::from(Span::styled(*text, heading))
            } else {
                Line::from(vec![
                    Span::styled(format!("  {keys:<17}"), key),
                    Span::styled(*text, white),
                ])
            }
        })
        .collect();
    if !commands.is_empty() {
        let width = commands
            .iter()
            .map(|spec| spec.usage.chars().count())
            .max()
            .unwrap_or(0)
            .min(34);
        lines.push(Line::default());
        lines.push(Line::from(Span::styled("Commands", heading)));
        lines.extend(commands.iter().map(|spec| {
            Line::from(vec![
                Span::styled(format!("  {:<width$}  ", spec.usage), key),
                Span::styled(spec.summary.as_str(), white),
            ])
        }));
    }
    let wanted = u16::try_from(lines.len() + 2).unwrap_or(u16::MAX);
    let rect = modal(area, 96, wanted);
    let block = modal_block(" Help ");
    let inner = block.inner(rect);
    frame.render_widget(Clear, rect);
    frame.render_widget(block, rect);
    let rows = usize::from(inner.height);
    let limit = lines.len().saturating_sub(rows);
    frame.render_widget(
        Paragraph::new(lines).scroll((u16::try_from(scroll.min(limit)).unwrap_or(0), 0)),
        inner,
    );
    (rows, limit)
}
```

7. In `composer_hint`, add after the `_ if state.overlay.is_some() => " esc close help ",` arm:

```rust
        _ if state.completion().is_some() => " tab complete · enter run · esc close ",
```

- [ ] **Step 4: Run the tests**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui > /tmp/r7.txt 2>&1`
Expected: PASS, 113 tests (110 + 3). The 3A help test (`help_lists_the_keys`, 100×30) must still pass: with no commands the panel is the keys plus the two new rows.

- [ ] **Step 5: Commit**

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/live_view.rs
git add core/src/bin/nexus_tui/live_view.rs
git commit -m "feat(tui): render command replies, slash completion and command help"
```

---

### Task 8: Slash round trip through a sidecar process

**Files:**
- Modify: `core/src/bin/nexus_tui/live.rs` (tests only)

- [ ] **Step 1: Write the test**

Add to the test module of `live.rs`:

```rust
    #[test]
    fn a_slash_command_round_trips_through_the_sidecar() {
        let script = format!(
            r#"{HELLO}
read cmd
case "$cmd" in *'"type":"slash"'*) ;; *) exit 9;; esac
case "$cmd" in *'"command":"diff"'*) ;; *) exit 9;; esac
case "$cmd" in *'"id":"s1"'*) ;; *) exit 9;; esac
echo '{{"v":1,"type":"session.state","workspace":"/w","workspace_name":"w","model":"m","mode":"auto","git":null,"busy":true}}'
echo '{{"v":1,"type":"slash.result","id":"s1","command":"diff","success":true,"output":"+added line","format":"diff"}}'
echo '{{"v":1,"type":"session.state","workspace":"/w","workspace_name":"w","model":"m","mode":"auto","git":null,"busy":false}}'
read shutdown
case "$shutdown" in *'"type":"shutdown"'*) exit 0;; *) exit 8;; esac"#
        );
        let mut app = LiveApp::start(fake_sidecar(&script));
        pump_until(&mut app, |s| s.link == Link::Ready && s.session.model == "m");
        for c in "/diff".chars() {
            assert_eq!(
                app.state
                    .on_key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)),
                None
            );
        }
        let send = app
            .state
            .on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .expect("enter sends the command");
        assert!(app.handle(send));
        pump_until(&mut app, |s| {
            !s.session.busy
                && s.transcript.iter().any(|e| {
                    matches!(e, Entry::Output { text, diff: true, .. } if text == "+added line")
                })
        });
        assert_eq!(app.state.link, Link::Ready);
        let quit = app
            .state
            .on_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
        assert_eq!(quit, Some(Action::Quit));
        assert!(!app.handle(quit.unwrap()));
    }
```

(Replies avoid backslash escapes: `sh` is `dash`, whose `echo` would turn `\n` into a real newline and split the JSON line.)

- [ ] **Step 2: Run it**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui live:: > /tmp/r8.txt 2>&1`
Expected: PASS. If it times out with the link crashed (exit 9), print the line the fake received; the slash command shape is wrong.

- [ ] **Step 3: Full Rust suite and commit**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui > /tmp/r8.txt 2>&1` — expected 114 tests, zero warnings from `nexus_tui` files (check `grep -n "warning" /tmp/r8.txt`).

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/live.rs
git add core/src/bin/nexus_tui/live.rs
git commit -m "test(tui): slash command round trip through a sidecar process"
```

---

### Task 9: `harness` opens the live TUI

**Files:**
- Modify: `harness.sh`
- Create: `cli/test/harness_entry.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `cli/test/harness_entry.test.ts`:

```ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const harness = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "harness.sh");

interface Checkout {
  root: string;
  node: string;
  calls(): string[];
}

/** A copy of harness.sh in a fake checkout whose node and nexus-tui only record how they were called. */
function fakeCheckout(withTui: boolean): Checkout {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-entry-")));
  fs.copyFileSync(harness, path.join(root, "harness.sh"));
  fs.mkdirSync(path.join(root, "cli", "dist"), { recursive: true });
  const log = path.join(root, "calls.log");
  const recorder = `#!/bin/sh\necho "$(basename "$0") $*" >> "${log}"\n`;
  const node = path.join(root, "fake-node");
  fs.writeFileSync(node, recorder, { mode: 0o755 });
  if (withTui) {
    fs.mkdirSync(path.join(root, "core", "target", "release"), { recursive: true });
    fs.writeFileSync(path.join(root, "core", "target", "release", "nexus-tui"), recorder, { mode: 0o755 });
  }
  return { root, node, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf-8").trim().split("\n") : []) };
}

/** Runs harness.sh with a pseudo-terminal on stdin and stdout (util-linux `script`), like an operator's shell. */
function inTerminal(checkout: Checkout, args: string[]) {
  const command = ["bash", path.join(checkout.root, "harness.sh"), ...args].map((a) => `'${a}'`).join(" ");
  return spawnSync("script", ["-qec", command, "/dev/null"], { env: { ...process.env, NODE_EXEC: checkout.node }, encoding: "utf-8", input: "" });
}

/** Runs harness.sh with pipes, like a script or CI job. */
function piped(checkout: Checkout, args: string[]) {
  return spawnSync("bash", [path.join(checkout.root, "harness.sh"), ...args], { env: { ...process.env, NODE_EXEC: checkout.node }, encoding: "utf-8", input: "" });
}

describe("harness.sh entry", () => {
  test("no arguments in a terminal open the live TUI", () => {
    const c = fakeCheckout(true);
    try {
      assert.equal(inTerminal(c, []).status, 0);
      assert.deepEqual(c.calls(), [`nexus-tui --live --sidecar ${c.root}/cli/dist/sidecar.js --node ${c.node} --`]);
    } finally {
      fs.rmSync(c.root, { recursive: true, force: true });
    }
  });

  test("no arguments without a terminal run the REPL", () => {
    const c = fakeCheckout(true);
    try {
      assert.equal(piped(c, []).status, 0);
      assert.deepEqual(c.calls(), [`fake-node ${c.root}/cli/dist/index.js repl`]);
    } finally {
      fs.rmSync(c.root, { recursive: true, force: true });
    }
  });

  test("an unbuilt TUI falls back to the REPL and says why", () => {
    const c = fakeCheckout(false);
    try {
      const run = inTerminal(c, []);
      assert.equal(run.status, 0);
      assert.match(run.stdout, /the live TUI is not built/);
      assert.deepEqual(c.calls(), [`fake-node ${c.root}/cli/dist/index.js repl`]);
    } finally {
      fs.rmSync(c.root, { recursive: true, force: true });
    }
  });

  test("--repl keeps the readline REPL with its options", () => {
    const c = fakeCheckout(true);
    try {
      assert.equal(inTerminal(c, ["--repl", "-m", "x"]).status, 0);
      assert.deepEqual(c.calls(), [`fake-node ${c.root}/cli/dist/index.js repl -m x`]);
    } finally {
      fs.rmSync(c.root, { recursive: true, force: true });
    }
  });

  test("--live passes sidecar options after one separator", () => {
    const c = fakeCheckout(true);
    try {
      assert.equal(inTerminal(c, ["--live", "--approve"]).status, 0);
      assert.deepEqual(c.calls(), [`nexus-tui --live --sidecar ${c.root}/cli/dist/sidecar.js --node ${c.node} -- --approve`]);
    } finally {
      fs.rmSync(c.root, { recursive: true, force: true });
    }
  });
});
```

(`script` merges the child's stderr into its stdout, which is why the fallback note is read from `run.stdout`.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd cli && node --import tsx --test test/harness_entry.test.ts > /tmp/e1.txt 2>&1`
Expected: "no arguments in a terminal open the live TUI", "an unbuilt TUI falls back…" and "--repl keeps…" FAIL (the script still starts the REPL and does not know `--repl`). If `script` is missing, install util-linux; do not skip the tests.

- [ ] **Step 3: Implement**

In `harness.sh`, replace the lines from `# If no arguments provided, drop into the interactive REPL` through the `--live` branch's `exec "$TUI_BIN" --live ... -- "$@"` line (lines 14–24; the next line is `elif [[ "$1" == "check" ]] ...`) with:

```bash
TUI_BIN="$SCRIPT_DIR/core/target/release/nexus-tui"

run_tui() {
  exec "$TUI_BIN" --live --sidecar "$SCRIPT_DIR/cli/dist/sidecar.js" --node "$NODE_EXEC" -- "$@"
}

# No arguments: the live TUI when it is built and both ends are a terminal; otherwise the readline REPL.
if [[ $# -eq 0 ]]; then
  if [[ -x "$TUI_BIN" && -t 0 && -t 1 ]]; then
    run_tui
  fi
  if [[ ! -x "$TUI_BIN" ]]; then
    echo "nexus: the live TUI is not built (run 'make build' in $SCRIPT_DIR); starting the REPL." >&2
  fi
  exec "$NODE_EXEC" "$SCRIPT_DIR/cli/dist/index.js" repl
elif [[ "$1" == "--repl" ]]; then
  shift
  exec "$NODE_EXEC" "$SCRIPT_DIR/cli/dist/index.js" repl "$@"
elif [[ "$1" == "--live" ]]; then
  shift
  if [[ ! -x "$TUI_BIN" ]]; then
    echo "nexus-tui is not built. Run 'make build' in $SCRIPT_DIR first." >&2
    exit 1
  fi
  run_tui "$@"
```

The remaining `elif [[ "$1" == "check" ]] ...` and `else ... run "$@"` branches stay as they are. Confirm with `bash -n harness.sh`.

- [ ] **Step 4: Run the tests**

Run: `cd cli && node --import tsx --test test/harness_entry.test.ts > /tmp/e1.txt 2>&1`
Expected: PASS, 5 tests. Then the full CLI suite: 350 tests, only the known failure.

- [ ] **Step 5: Commit**

```bash
git add harness.sh cli/test/harness_entry.test.ts
git commit -m "feat(harness): open the live TUI by default; --repl keeps the readline REPL"
```

---

### Task 10: Full verification and PTY smoke

**Files:**
- No source changes expected. Clippy fix-ups only, committed as `fix(tui): clippy findings in phase 3b`.

- [ ] **Step 1: Build, lint, test**

```bash
make build > /tmp/v-build.txt 2>&1
command cargo clippy --manifest-path core/Cargo.toml --bin nexus-tui --all-targets > /tmp/v-clippy.txt 2>&1
command cargo test --manifest-path core/Cargo.toml > /tmp/v-test.txt 2>&1
cd cli && node --import tsx --test test/*.test.ts > /tmp/v-cli.txt 2>&1
```

Expected: build succeeds; no clippy findings in `core/src/bin/nexus_tui.rs` or `core/src/bin/nexus_tui/`; 114 tests in `nexus-tui` and all other cargo tests pass; CLI suite 350 tests with only the known `SCAN-001 & SCAN-004` failure.

- [ ] **Step 2: PTY smokes**

Reuse the 3A PTY driver (`/tmp/nexus_live_pty.py`: 100×30 pseudo-terminal, `pyte` screen, answers `\x1b[?u` with `\x1b[?0u` and `\x1b[c` with `\x1b[?62c`); recreate it from the 3A plan's Task 10 if it is gone. Run in a temporary git repo under `/tmp` (never the worktree) with the real gateway at `127.0.0.1:18010` up. Never read `cli/.env`.

1. **Default entry:** `cd /tmp/<repo> && <worktree>/harness.sh` (no arguments). Expect the live view (status strip with the repo name), not the readline prompt.
2. **Completion:** type `/`; expect the completion list above the composer. Type `di`; expect `/diff` highlighted. Press Enter; expect `› /diff` and "Working tree clean: no uncommitted changes."
3. **Diff colouring:** `echo changed > base.txt` in another shell (or `!sh -c 'echo changed > base.txt'`), then `/diff`; expect `+changed` in green and `-base` in red.
4. **Direct shell:** `!git status --short`; expect ` M base.txt`.
5. **Commit form:** `/commit`; expect the suggestion and the composer holding `/commit <message>`; press Enter; expect `Committed …`.
6. **Turn bookkeeping:** prompt "List the files here, then stop."; after the banner, `/checkpoints` lists `Turn: List the files here, then st…`, `/sessions` shows the session, `/history` shows the prompt, and `!1` reruns it (a user line, then a new banner).
7. **Help:** `?` with an empty composer; expect the keys, then "Commands" with `/diff` and the rest; Esc closes.
8. **Fallback:** `<worktree>/harness.sh < /dev/null | cat` starts the readline REPL (no alternate screen); type nothing, it exits on EOF.

After the smokes, `pgrep -af 'sidecar.js|nexus-core rpc|nexus-tui'` must show nothing you started.

- [ ] **Step 3: Knowledge graph and commit any fix-ups**

```bash
graphify update .
git status --short
```

Expected: clean apart from `graphify-out/` (not committed by this plan), or only the clippy fix-up commit from Step 1.

---

## Self-review notes

- Spec coverage for phase 3: slash commands (Tasks 1–8), default entry with `--repl` escape hatch (Task 9). Together with 3A: multi-line composer, approval modal, Ctrl-C cancel. Detail and receipt overlays are plan 3C.
- REPL parity is enforced by a test that reads every `cmd === "…"` name from `cli/src/repl.ts` (Task 3), and by a test that every catalogue entry has a handler.
- Interactive REPL prompts (commit accept/edit, MCP wizard, paste confirmation) are replaced by one-step forms; the REPL itself keeps them.
- Test counts: CLI 307 → 320 (Task 1) → 328 (Task 2) → 338 (Task 3) → 345 (Task 4) → 350 (Task 9); Rust 100 → 105 (Task 5) → 110 (Task 6) → 113 (Task 7) → 114 (Task 8).
- Known limits: `/team` and other non-cancellable commands run to completion; synchronous commands (`/test`, `/onboard`) block the sidecar's event loop while they run, so a cancel is read only afterwards (the notice then says it cannot stop them); `/theme` saves the REPL theme, which the TUI starts honouring in phase 4.
