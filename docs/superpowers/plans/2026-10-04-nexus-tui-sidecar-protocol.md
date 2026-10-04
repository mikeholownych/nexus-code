# Nexus TUI Sidecar Protocol (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A headless Node sidecar (`cli/dist/sidecar.js`) that runs the existing Nexus agent and speaks the versioned NDJSON protocol from the design spec over stdio, ready for the Ratatui app to drive in phase 2.

**Architecture:** `SidecarServer` (pure, injectable writer) wraps `ApplicationCore`, turns protocol commands into agent calls, and turns agent activity into protocol events through a new optional `AgentObserver` on `AutonomousAgent`. A thin `main()` captures the real stdout writer for protocol lines and diverts every other stdout write (banners, spinners, `console.log`) so stdout carries nothing but NDJSON. Config loading moves from `index.ts` into `config.ts` so the CLI and the sidecar share it.

**Tech Stack:** TypeScript (NodeNext ESM, strict), Node `node:test` via `tsx --test`, commander, existing Rust `harness-core` tool engine.

**Spec:** `docs/superpowers/specs/2026-10-04-nexus-ratatui-live-default-design.md` (sections 3, 5, 6 phase 1, 7).

---

## Before you start

- Work in an isolated worktree (superpowers:using-git-worktrees). The main checkout has many unrelated uncommitted Cloudflare/Issue 12 files; never stage them.
- Build the Rust core once so tool calls work in tests: `make build-core` (from repo root).
- Baseline: `npm --prefix cli test` currently has **2 known failures** in `security_gates.test.ts` (npm `EALLOWSCRIPTS`). Every "full suite" step below expects exactly those 2 failures and nothing else.
- All commands run from the repo root unless a step says otherwise.

## Protocol decisions refined from the spec

These are binding for this plan and phase 2:

- Every line is `{"v":1,"type":...}`. `turn_id` **is** the `id` of the `prompt.submit` that started the turn, so no separate acknowledgement message is needed.
- `slash.result` is added as the reply to `slash` (the spec requires replies for requests carrying `id`).
- `tool.end` carries `call_id` as its evidence reference; there is no separate `ref` field.
- Tool labels ("Reading file", etc.) are a presentation concern for the Rust UI; the protocol sends the raw `tool` name plus a redacted `subject`.
- Session persistence from the sidecar, `harness` default-entry changes, and all Rust work are **not** in this plan (phases 2–3).

## File structure

| File | Status | Responsibility |
|---|---|---|
| `cli/src/config.ts` | Create | Env-file loading, `buildConfig`, `autoDetectModel` (moved/extracted from `index.ts`) |
| `cli/src/index.ts` | Modify | Import config helpers instead of defining them |
| `cli/src/protocol.ts` | Create | Protocol types, `encodeEvent`, `parseCommand`, redaction/capping helpers |
| `cli/src/agent.ts` | Modify | `AgentObserver` interface, `setObserver`, 4 observer call sites, `getCompletionSummary` |
| `cli/src/sidecar.ts` | Create | `SidecarServer` + `main()` stdio entry point |
| `cli/test/helpers/fixtures.ts` | Create | Fake SSE gateway, temp repo/home, wait helpers (not matched by `test/*.test.ts`) |
| `cli/test/config.test.ts` | Create | Config extraction tests |
| `cli/test/protocol.test.ts` | Create | Protocol parsing/encoding tests |
| `cli/test/agent_observer.test.ts` | Create | Observer seam tests |
| `cli/test/sidecar.test.ts` | Create | In-process server tests + subprocess stdout-purity tests |
| `cli/dist/*` | Rebuild | Tracked build output; rebuilt and committed in the last task |

---

### Task 1: Extract config loading into `config.ts`

**Files:**
- Create: `cli/src/config.ts`
- Modify: `cli/src/index.ts` (lines 7, 31–43, 52–99)
- Create: `cli/test/helpers/fixtures.ts`
- Test: `cli/test/config.test.ts`

- [ ] **Step 1: Create the shared test fixtures**

Create `cli/test/helpers/fixtures.ts`:

```ts
import http from "node:http";
import type { Socket } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

export type Reply =
  | { kind: "tools"; calls: Array<{ name: string; args: unknown }>; content?: string; delayMs?: number }
  | { kind: "text"; content: string; delayMs?: number }
  | { kind: "http"; status: number; body?: string; delayMs?: number };

export interface Gateway {
  url: string;
  requests: unknown[];
  close(): Promise<void>;
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function streamBody(r: Extract<Reply, { kind: "tools" | "text" }>): string {
  let out = "";
  if (r.kind === "text") out += sse({ choices: [{ index: 0, delta: { content: r.content } }] });
  else {
    if (r.content) out += sse({ choices: [{ index: 0, delta: { content: r.content } }] });
    r.calls.forEach((c, i) => {
      out += sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${i}_${Math.random().toString(36).slice(2, 7)}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] });
    });
  }
  out += sse({ choices: [{ index: 0, delta: {}, finish_reason: r.kind === "tools" ? "tool_calls" : "stop" }] });
  return out + "data: [DONE]\n\n";
}

/** Deterministic OpenAI-compatible gateway. `script(n)` decides the reply to the n-th chat request (1-based). */
export async function startGateway(script: (n: number) => Reply): Promise<Gateway> {
  const requests: unknown[] = [];
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "m" }] }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = {};
      try { body = JSON.parse(raw); } catch {}
      requests.push(body);
      const r = script(requests.length);
      const respond = () => {
        if (res.writableEnded || res.destroyed) return;
        if (r.kind === "http") {
          res.statusCode = r.status;
          res.end(r.body ?? "{}");
        } else if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(streamBody(r));
        } else {
          res.setHeader("content-type", "application/json");
          const message = r.kind === "text"
            ? { role: "assistant", content: r.content }
            : { role: "assistant", content: r.content ?? null, tool_calls: r.calls.map((c, i) => ({ id: `call_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
          res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: "stop" }] }));
        }
      };
      if (r.delayMs) setTimeout(respond, r.delayMs); else respond();
    });
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Temporary git repository with one committed file. */
export function makeRepo(files: Record<string, string> = {}): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sidecar-"));
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), content);
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: repo, stdio: "ignore" });
  return repo;
}

export function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-home-"));
}

export async function waitUntil(cond: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function waitForEvent(events: any[], pred: (e: any) => boolean, timeoutMs = 10000): Promise<any> {
  try {
    await waitUntil(() => events.some(pred), timeoutMs);
  } catch {
    throw new Error(`timed out waiting for event; saw: ${events.map((e) => e.type).join(", ")}`);
  }
  return events.find(pred);
}
```

- [ ] **Step 2: Write the failing config test**

Create `cli/test/config.test.ts`:

```ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildConfig, autoDetectModel } from "../src/config.js";
import { startGateway } from "./helpers/fixtures.js";

describe("config", () => {
  test("buildConfig applies flags and defaults", () => {
    const config = buildConfig({ endpoint: "http://127.0.0.1:1/v1", model: "x", workspace: "rel-dir", maxSteps: "7", readOnly: true });
    assert.equal(config.endpoint, "http://127.0.0.1:1/v1");
    assert.equal(config.model, "x");
    assert.equal(config.workspace, path.resolve("rel-dir"));
    assert.equal(config.maxSteps, 7);
    assert.equal(config.readOnly, true);
    assert.equal(buildConfig({ endpoint: "e", model: "x" }).maxSteps, 30);
  });

  test("autoDetectModel replaces the placeholder with the first listed model", async () => {
    const gw = await startGateway(() => ({ kind: "text", content: "unused" }));
    try {
      const detected = await autoDetectModel(buildConfig({ endpoint: gw.url, model: "local-model" }));
      assert.equal(detected.model, "m");
      const explicit = await autoDetectModel(buildConfig({ endpoint: gw.url, model: "chosen" }));
      assert.equal(explicit.model, "chosen");
    } finally {
      await gw.close();
    }
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd cli && npx tsx --test test/config.test.ts`
Expected: FAIL — cannot find module `../src/config.js`.

- [ ] **Step 4: Create `cli/src/config.ts`**

The env-loading block and `buildConfig` body are moved verbatim from `index.ts` (comments preserved):

```ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { LocalLlmClient, readLatestAuthToken } from "./client.js";
import { HarnessConfig } from "./types.js";

const installEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");

/** Loads env files in precedence order; CLI flags are applied afterwards by buildConfig. */
export function loadEnvironment(): void {
  // 1. Installation directory defaults
  loadDotenv({ path: installEnv });
  // 2. Global user config (~/.config/nexus/config.env)
  const globalConfig = path.join(os.homedir(), ".config/nexus/config.env");
  if (fs.existsSync(globalConfig)) {
    loadDotenv({ path: globalConfig, override: true });
  }
  // 3. Current working directory overrides (skipped when cwd is the install directory: that file is the
  //    shipped default already applied in step 1 and must not outrank the user's global config)
  const cwdEnv = path.resolve(process.cwd(), ".env");
  if (cwdEnv !== installEnv) {
    loadDotenv({ path: cwdEnv, override: true });
  }
}

export function buildConfig(options: any): HarnessConfig {
  const endpoint = options.endpoint || process.env.LOCAL_LLM_ENDPOINT || "http://localhost:1234/v1";
  const model = options.model || process.env.LOCAL_LLM_MODEL || "local-model";
  const apiKey = options.apiKey || process.env.LOCAL_LLM_API_KEY || readLatestAuthToken() || "local";
  const workspace = options.workspace ? path.resolve(options.workspace) : process.cwd();
  const maxSteps = options.maxSteps ? parseInt(options.maxSteps, 10) : 30;
  const temperature = options.temperature ? parseFloat(options.temperature) : 0.2;
  const shell = options.shell || process.env.LOCAL_HARNESS_SHELL || "bash";
  const dryRun = Boolean(options.dryRun);
  const readOnly = Boolean(options.readOnly);
  const sandbox = options.sandbox ? (typeof options.sandbox === "string" ? options.sandbox : true) : undefined;
  const fallbackEndpoints = options.fallback ? options.fallback.split(",").map((s: string) => s.trim()) : undefined;
  const contextLimit = options.contextLimit ? parseInt(options.contextLimit, 10) : undefined;
  const worktree = Boolean(options.worktree);
  const authoritativeVerifierCommand = options.authoritativeVerifier;
  const recordFlight = Boolean(options.recordFlight || options.flight);
  const plannerModel = options.plannerModel || process.env.PLANNER_LLM_MODEL;
  const plannerEndpoint = options.plannerEndpoint || process.env.PLANNER_LLM_ENDPOINT;
  const coderModel = options.coderModel || process.env.CODER_LLM_MODEL;
  const coderEndpoint = options.coderEndpoint || process.env.CODER_LLM_ENDPOINT;
  const tdd = Boolean(options.tdd);
  const taskClass = process.env.NEXUS_TASK_CLASS || undefined;
  const plannerTaskClass = process.env.PLANNER_TASK_CLASS || undefined;
  return {
    taskClass,
    plannerTaskClass,
    endpoint,
    model,
    apiKey,
    workspace,
    maxSteps,
    temperature,
    shell,
    dryRun,
    readOnly,
    sandbox,
    fallbackEndpoints,
    contextLimit,
    worktree,
    authoritativeVerifierCommand,
    recordFlight,
    plannerModel,
    plannerEndpoint,
    coderModel,
    coderEndpoint,
    tdd,
  };
}

/** Replaces the "local-model" placeholder with the first model the gateway lists; unchanged if the gateway is unreachable. */
export async function autoDetectModel(config: HarnessConfig): Promise<HarnessConfig> {
  if (config.model !== "local-model") return config;
  try {
    const models = await new LocalLlmClient(config).listModels();
    if (models.length > 0) return { ...config, model: models[0] };
  } catch {
    // Keep the placeholder; the first inference request will surface the connection problem.
  }
  return config;
}
```

- [ ] **Step 5: Point `index.ts` at the new module**

In `cli/src/index.ts`:

1. Delete the import line `import { config as loadDotenv } from "dotenv";`.
2. Add after `import { KnowledgeGraph } from "./knowledge.js";`:
   ```ts
   import { buildConfig, loadEnvironment } from "./config.js";
   ```
3. Replace this whole block (currently lines 31–43):
   ```ts
   // 1. Installation directory defaults
   loadDotenv({ path: path.resolve(__dirname, "../.env") });
   // 2. Global user config (~/.config/nexus/config.env)
   const globalConfig = path.join(os.homedir(), ".config/nexus/config.env");
   if (fs.existsSync(globalConfig)) {
     loadDotenv({ path: globalConfig, override: true });
   }
   // 3. Current working directory overrides (skipped when cwd is the install directory: that file is the
   //    shipped default already applied in step 1 and must not outrank the user's global config)
   const cwdEnv = path.resolve(process.cwd(), ".env");
   if (cwdEnv !== path.resolve(__dirname, "../.env")) {
     loadDotenv({ path: cwdEnv, override: true });
   }
   ```
   with:
   ```ts
   loadEnvironment();
   ```
4. Delete the entire `function buildConfig(options: any): HarnessConfig { ... }` definition (currently lines 52–99). Leave every `buildConfig(options)` call site as is.

Keep `__filename`, `__dirname`, `os`, and `fs`; they are still used elsewhere in `index.ts`.

- [ ] **Step 6: Typecheck and run the new test**

Run: `cd cli && npx tsc --noEmit && npx tsx --test test/config.test.ts`
Expected: no type errors; 2 tests pass.

- [ ] **Step 7: Run the full CLI suite**

Run: `npm --prefix cli test`
Expected: all pass except the 2 known `security_gates.test.ts` failures.

- [ ] **Step 8: Commit**

```bash
git add cli/src/config.ts cli/src/index.ts cli/test/config.test.ts cli/test/helpers/fixtures.ts
git commit -m "refactor(cli): extract config loading into config.ts for reuse by the sidecar"
```

---

### Task 2: Protocol module

**Files:**
- Create: `cli/src/protocol.ts`
- Test: `cli/test/protocol.test.ts`

- [ ] **Step 1: Write the failing protocol tests**

Create `cli/test/protocol.test.ts`:

```ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { capText, encodeEvent, parseCommand, ProtocolError, toolSubject, toolSummary, MAX_TEXT_FIELD } from "../src/protocol.js";

describe("protocol: encodeEvent", () => {
  test("emits one versioned JSON line", () => {
    const line = encodeEvent({ type: "assistant.delta", turn_id: "t1", text: "hi" });
    assert.ok(line.endsWith("\n"));
    assert.equal(line.indexOf("\n"), line.length - 1);
    assert.deepEqual(JSON.parse(line), { v: 1, type: "assistant.delta", turn_id: "t1", text: "hi" });
  });
});

describe("protocol: parseCommand", () => {
  test("accepts every command type", () => {
    assert.deepEqual(parseCommand('{"v":1,"type":"prompt.submit","id":"t1","text":"fix it"}'), { type: "prompt.submit", id: "t1", text: "fix it" });
    assert.deepEqual(parseCommand('{"v":1,"type":"cancel"}'), { type: "cancel" });
    assert.deepEqual(parseCommand('{"v":1,"type":"approve","id":"a1"}'), { type: "approve", id: "a1", always: false });
    assert.deepEqual(parseCommand('{"v":1,"type":"approve","id":"a1","always":true}'), { type: "approve", id: "a1", always: true });
    assert.deepEqual(parseCommand('{"v":1,"type":"deny","id":"a1"}'), { type: "deny", id: "a1" });
    assert.deepEqual(parseCommand('{"v":1,"type":"slash","id":"s1","command":"status"}'), { type: "slash", id: "s1", command: "status", args: "" });
    assert.deepEqual(parseCommand('{"v":1,"type":"shutdown"}'), { type: "shutdown" });
  });

  test("rejects malformed input with ProtocolError, keeping the id when present", () => {
    assert.throws(() => parseCommand("not json"), ProtocolError);
    assert.throws(() => parseCommand("[1,2]"), ProtocolError);
    assert.throws(() => parseCommand('{"v":2,"type":"cancel"}'), /unsupported protocol version/);
    assert.throws(() => parseCommand('{"v":1,"type":"prompt.submit","text":"x"}'), /requires id/);
    assert.throws(() => parseCommand('{"v":1,"type":"bogus","id":"z"}'), (err: unknown) => err instanceof ProtocolError && err.id === "z");
    assert.throws(() => parseCommand('{"v":1,"type":"prompt.submit","id":"t9","text":"   "}'), (err: unknown) => err instanceof ProtocolError && err.id === "t9");
  });
});

describe("protocol: projection helpers", () => {
  test("capText truncates oversized fields and says so", () => {
    const capped = capText("x".repeat(MAX_TEXT_FIELD + 50));
    assert.ok(capped.startsWith("x".repeat(MAX_TEXT_FIELD)));
    assert.ok(capped.endsWith("…[truncated 50 chars]"));
    assert.equal(capText("short"), "short");
  });

  test("toolSubject picks the primary argument and redacts secrets", () => {
    assert.equal(toolSubject({ path: "src/a.ts" }), "src/a.ts");
    assert.equal(toolSubject({ command: "npm   test\n--watch" }), "npm test --watch");
    assert.equal(toolSubject({ command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'" }).includes("abcdefghijklmnop"), false);
    assert.equal(toolSubject({}), "");
  });

  test("toolSummary reports the first meaningful line and line count", () => {
    assert.deepEqual(toolSummary(true, "\nfirst line\nsecond\n"), { summary: "first line", lines: 2 });
    assert.deepEqual(toolSummary(true, ""), { summary: "Completed", lines: 0 });
    assert.deepEqual(toolSummary(false, "", "boom happened"), { summary: "boom happened", lines: 1 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx tsx --test test/protocol.test.ts`
Expected: FAIL — cannot find module `../src/protocol.js`.

- [ ] **Step 3: Implement `cli/src/protocol.ts`**

```ts
/**
 * Nexus sidecar protocol v1: newline-delimited JSON between the Ratatui client (parent) and the
 * Node agent sidecar (child). The sidecar projects agent state; it never asks the client to decide outcomes.
 */
import type { TurnResult } from "./core/turn.js";
import { redactSecrets } from "./ui.js";

export const PROTOCOL_VERSION = 1;
export const MAX_TEXT_FIELD = 8000;
export const MAX_SUMMARY = 160;

export type ErrorCode = "BAD_REQUEST" | "BUSY" | "NO_PENDING_APPROVAL" | "INTERNAL";

export interface ModelSummary {
  summary: string;
  notes?: string;
}

export type SidecarEvent =
  | { type: "hello"; protocol: number; pid: number }
  | {
      type: "session.state";
      workspace: string;
      workspace_name: string;
      model: string;
      mode: "auto" | "review";
      git: { branch: string; dirty: number } | null;
      busy: boolean;
    }
  | { type: "assistant.delta"; turn_id: string; text: string }
  | { type: "tool.start"; turn_id: string; call_id: string; tool: string; subject: string }
  | { type: "tool.end"; turn_id: string; call_id: string; tool: string; success: boolean; summary: string; lines: number }
  | { type: "approval.request"; id: string; turn_id: string; tool: string; subject: string; preview: string }
  | { type: "turn.result"; turn_id: string; heading: string; line: string; turn: TurnResult; model_summary: ModelSummary | null }
  | { type: "slash.result"; id: string; command: string; success: boolean; output: string }
  | { type: "error"; id?: string; code: ErrorCode; message: string };

export type SidecarCommand =
  | { type: "prompt.submit"; id: string; text: string }
  | { type: "cancel" }
  | { type: "approve"; id: string; always: boolean }
  | { type: "deny"; id: string }
  | { type: "slash"; id: string; command: string; args: string }
  | { type: "shutdown" };

export class ProtocolError extends Error {
  constructor(message: string, public readonly id?: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function encodeEvent(event: SidecarEvent): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...event }) + "\n";
}

export function parseCommand(line: string): SidecarCommand {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new ProtocolError("line is not valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProtocolError("message must be a JSON object");
  const msg = raw as Record<string, unknown>;
  const id = typeof msg.id === "string" && msg.id ? msg.id : undefined;
  if (msg.v !== PROTOCOL_VERSION) throw new ProtocolError(`unsupported protocol version: ${String(msg.v)}`, id);
  const requireId = (type: string): string => {
    if (!id) throw new ProtocolError(`${type} requires id`);
    return id;
  };
  switch (msg.type) {
    case "prompt.submit": {
      const requestId = requireId("prompt.submit");
      const text = msg.text;
      if (typeof text !== "string" || !text.trim()) throw new ProtocolError("prompt.submit requires non-empty text", requestId);
      return { type: "prompt.submit", id: requestId, text };
    }
    case "cancel":
      return { type: "cancel" };
    case "approve":
      return { type: "approve", id: requireId("approve"), always: msg.always === true };
    case "deny":
      return { type: "deny", id: requireId("deny") };
    case "slash": {
      const requestId = requireId("slash");
      const command = msg.command;
      if (typeof command !== "string" || !command.trim()) throw new ProtocolError("slash requires command", requestId);
      return { type: "slash", id: requestId, command, args: typeof msg.args === "string" ? msg.args : "" };
    }
    case "shutdown":
      return { type: "shutdown" };
    default:
      throw new ProtocolError(`unknown message type: ${String(msg.type)}`, id);
  }
}

export function capText(text: string, max: number = MAX_TEXT_FIELD): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

export function toolSubject(args: Record<string, any>): string {
  const subject = args.path ?? args.file_path ?? args.command ?? args.url ?? args.query ?? args.name ?? "";
  return redactSecrets(String(subject)).replace(/\s+/g, " ").trim().slice(0, 200);
}

export function toolSummary(success: boolean, output: string, error?: string): { summary: string; lines: number } {
  const text = redactSecrets(success ? output || "" : error || output || "").trim();
  const first = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? (success ? "Completed" : "Tool failed");
  return { summary: first.replace(/\s+/g, " ").slice(0, MAX_SUMMARY), lines: text ? text.split(/\r?\n/).length : 0 };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd cli && npx tsc --noEmit && npx tsx --test test/protocol.test.ts`
Expected: no type errors; all protocol tests pass.

- [ ] **Step 5: Commit**

```bash
git add cli/src/protocol.ts cli/test/protocol.test.ts
git commit -m "feat(cli): sidecar NDJSON protocol types, parser and projection helpers"
```

---

### Task 3: Agent observer seam

**Files:**
- Modify: `cli/src/agent.ts` (after line 69; field list near line 265; methods near line 791; call sites near lines 1698, 1741, 1857, 2016)
- Test: `cli/test/agent_observer.test.ts`

- [ ] **Step 1: Write the failing observer test**

Create `cli/test/agent_observer.test.ts`:

```ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { AutonomousAgent, AgentObserver } from "../src/agent.js";
import { startGateway, makeRepo } from "./helpers/fixtures.js";

describe("AgentObserver", () => {
  test("receives tool start/end and streamed assistant text in order", async () => {
    const gw = await startGateway((n) => n === 1
      ? { kind: "tools", calls: [{ name: "list_dir", args: { path: "." } }] }
      : { kind: "text", content: "There is one file." });
    const repo = makeRepo();
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash" } as any);
    const seen: string[] = [];
    let text = "";
    const observer: AgentObserver = {
      onToolStart: (e) => seen.push(`start:${e.tool}:${e.args.path}:${Boolean(e.callId)}`),
      onToolEnd: (e) => seen.push(`end:${e.tool}:${e.success}`),
      onAssistantDelta: (delta) => { if (!seen.includes("text")) seen.push("text"); text += delta; },
    };
    agent.setObserver(observer);
    try {
      const turn = await agent.runTurn("what is here?");
      assert.equal(turn.outcome, "NOT_REQUIRED");
      assert.deepEqual(seen, ["start:list_dir:.:true", "end:list_dir:true", "text"]);
      assert.equal(text, "There is one file.");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a denied tool reports onToolEnd with success=false", async () => {
    const gw = await startGateway((n) => n === 1
      ? { kind: "tools", calls: [{ name: "write_file", args: { path: "x.txt", content: "hi" } }] }
      : { kind: "text", content: "ok" });
    const repo = makeRepo();
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash" } as any);
    const ends: Array<{ tool: string; success: boolean }> = [];
    agent.setObserver({ onToolEnd: (e) => ends.push({ tool: e.tool, success: e.success }) });
    try {
      await agent.runTurn("make x", async () => false);
      assert.deepEqual(ends, [{ tool: "write_file", success: false }]);
      assert.equal(fs.existsSync(`${repo}/x.txt`), false);
      assert.equal(agent.getCompletionSummary(), undefined);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx tsx --test test/agent_observer.test.ts`
Expected: FAIL — `AgentObserver` is not exported / `agent.setObserver is not a function`.

- [ ] **Step 3: Add the interface**

In `cli/src/agent.ts`, directly after `export type ConfirmHandler = ...;` (line 69):

```ts

/** Structured projection of turn activity for non-terminal surfaces such as the TUI sidecar. Observers must not throw. */
export interface AgentObserver {
  onAssistantDelta?(text: string): void;
  onToolStart?(event: { callId: string; tool: string; args: Record<string, any> }): void;
  onToolEnd?(event: { callId: string; tool: string; success: boolean; output: string; error?: string }): void;
}
```

- [ ] **Step 4: Add the field and accessors**

Add next to `private completionSummary?: ...;` (near line 266):

```ts
  private observer?: AgentObserver;
```

Add directly after the `getUi()` method (near line 793):

```ts
  public setObserver(observer: AgentObserver | undefined): void {
    this.observer = observer;
  }

  public getCompletionSummary(): { summary: string; notes?: string } | undefined {
    return this.completionSummary;
  }
```

- [ ] **Step 5: Add the four call sites**

1. In `dispatchToolCall`, after `this.ui.printToolCall(toolName, args);`:
   ```ts
       this.observer?.onToolStart?.({ callId: call.id, tool: toolName, args });
   ```
2. In the rejected-confirmation branch, immediately before its `return { receipt, shouldExit: false };`:
   ```ts
           this.observer?.onToolEnd?.({ callId: call.id, tool: toolName, success: false, output: "", error: cancelMsg });
   ```
3. After the `this.ui.printToolResult(toolName, receipt.success, receipt.output, receipt.error);` call near the end of `dispatchToolCall`:
   ```ts
       this.observer?.onToolEnd?.({ callId: call.id, tool: toolName, success: receipt.success, output: receipt.output, error: receipt.error });
   ```
4. In `runTurn`'s streaming callback, after `process.stdout.write(token);`:
   ```ts
                 this.observer?.onAssistantDelta?.(token);
   ```

- [ ] **Step 6: Run the observer test and the turn-semantics suite**

Run: `cd cli && npx tsc --noEmit && npx tsx --test test/agent_observer.test.ts test/turn_semantics.test.ts`
Expected: no type errors; all tests in both files pass.

- [ ] **Step 7: Commit**

```bash
git add cli/src/agent.ts cli/test/agent_observer.test.ts
git commit -m "feat(agent): optional AgentObserver for structured turn activity"
```

---

### Task 4: `SidecarServer` — session, turns, errors

**Files:**
- Create: `cli/src/sidecar.ts`
- Test: `cli/test/sidecar.test.ts`

- [ ] **Step 1: Write the failing server tests**

Create `cli/test/sidecar.test.ts`:

```ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ApplicationCore } from "../src/core/app.js";
import { SidecarServer } from "../src/sidecar.js";
import { startGateway, makeRepo, waitForEvent, Reply } from "./helpers/fixtures.js";

interface Rig {
  server: SidecarServer;
  events: any[];
  repo: string;
  send(msg: Record<string, unknown>): Promise<void>;
}

async function withSidecar(script: (n: number) => Reply, mode: "auto" | "review", fn: (rig: Rig) => Promise<void>, onShutdown?: () => void): Promise<void> {
  const gw = await startGateway(script);
  const repo = makeRepo();
  const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash" } as any);
  const events: any[] = [];
  const server = new SidecarServer({ app, mode, write: (line) => events.push(JSON.parse(line)), onShutdown });
  server.start();
  try {
    await fn({ server, events, repo, send: (msg) => server.handleLine(JSON.stringify({ v: 1, ...msg })) });
  } finally {
    await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
    await server.idle();
    app.shutdown();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

const readOnlyTurn = (n: number): Reply => n === 1
  ? { kind: "tools", calls: [{ name: "list_dir", args: { path: "." } }] }
  : { kind: "text", content: "There is one file." };

describe("SidecarServer: session and turns", () => {
  test("start announces the protocol and an idle session", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ events, repo }) => {
      assert.deepEqual(events[0], { v: 1, type: "hello", protocol: 1, pid: process.pid });
      const state = events[1];
      assert.equal(state.type, "session.state");
      assert.equal(state.workspace, repo);
      assert.equal(state.workspace_name, path.basename(repo));
      assert.equal(state.model, "m");
      assert.equal(state.mode, "auto");
      assert.equal(state.busy, false);
      assert.ok(state.git && typeof state.git.branch === "string" && typeof state.git.dirty === "number");
    });
  });

  test("a read-only turn streams tool and text events, then a truthful turn.result", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "what is here?" });
      await server.idle();
      const turnEvents = events.slice(2);
      assert.deepEqual(turnEvents[0], { ...turnEvents[0], type: "session.state", busy: true });
      const start = turnEvents.find((e) => e.type === "tool.start");
      assert.equal(start.turn_id, "t1");
      assert.equal(start.tool, "list_dir");
      assert.equal(start.subject, ".");
      const end = turnEvents.find((e) => e.type === "tool.end");
      assert.equal(end.call_id, start.call_id);
      assert.equal(end.success, true);
      const text = turnEvents.filter((e) => e.type === "assistant.delta").map((e) => e.text).join("");
      assert.equal(text, "There is one file.");
      const result = turnEvents.find((e) => e.type === "turn.result");
      assert.equal(result.turn_id, "t1");
      assert.equal(result.turn.execution, "COMPLETED");
      assert.equal(result.turn.outcome, "NOT_REQUIRED");
      assert.equal(result.heading, "TURN ENDED - NO CHANGES TO VERIFY");
      assert.deepEqual(turnEvents.at(-1), { ...turnEvents.at(-1), type: "session.state", busy: false });
      const order = turnEvents.map((e) => e.type);
      assert.ok(order.indexOf("tool.end") < order.indexOf("assistant.delta"));
      assert.ok(order.indexOf("assistant.delta") < order.indexOf("turn.result"));
      for (const e of events) assert.equal(e.v, 1);
    });
  });

  test("an inference failure is projected as FAILED, not success", async () => {
    await withSidecar(() => ({ kind: "http", status: 500, body: '{"error":"boom"}' }), "auto", async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "do work" });
      await server.idle();
      const result = events.find((e) => e.type === "turn.result");
      assert.equal(result.turn.execution, "FAILED");
      assert.equal(result.turn.reason, "INFERENCE_FAILED");
      assert.equal(result.model_summary, null);
    });
  });

  test("a second prompt while busy is rejected with BUSY", async () => {
    await withSidecar(() => ({ kind: "text", content: "slow", delayMs: 1500 }), "auto", async ({ events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "one" });
      await send({ type: "prompt.submit", id: "t2", text: "two" });
      const busy = await waitForEvent(events, (e) => e.type === "error" && e.id === "t2");
      assert.equal(busy.code, "BUSY");
    });
  });

  test("malformed lines produce BAD_REQUEST errors", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events }) => {
      await server.handleLine("not json");
      await server.handleLine(JSON.stringify({ v: 1, type: "prompt.submit", id: "x", text: "" }));
      const errors = events.filter((e) => e.type === "error");
      assert.equal(errors.length, 2);
      assert.equal(errors[0].code, "BAD_REQUEST");
      assert.equal(errors[0].id, undefined);
      assert.equal(errors[1].code, "BAD_REQUEST");
      assert.equal(errors[1].id, "x");
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx tsx --test test/sidecar.test.ts`
Expected: FAIL — cannot find module `../src/sidecar.js`.

- [ ] **Step 3: Implement the server (approval/slash/shutdown included so Task 5 only adds tests)**

Create `cli/src/sidecar.ts`:

```ts
import * as path from "node:path";
import { ApplicationCore } from "./core/app.js";
import { TurnResult, failedTurnFromError, summarizeTurn } from "./core/turn.js";
import { getGitInfo } from "./git.js";
import { redactSecrets } from "./ui.js";
import {
  PROTOCOL_VERSION,
  ProtocolError,
  SidecarCommand,
  SidecarEvent,
  capText,
  encodeEvent,
  parseCommand,
  toolSubject,
  toolSummary,
} from "./protocol.js";

export interface SidecarOptions {
  app: ApplicationCore;
  /** Receives complete protocol lines (each ends with "\n"). */
  write: (line: string) => void;
  mode: "auto" | "review";
  onShutdown?: () => void;
}

/** Drives one ApplicationCore from protocol commands and reports its activity as protocol events. */
export class SidecarServer {
  private readonly app: ApplicationCore;
  private readonly write: (line: string) => void;
  private readonly onShutdown: () => void;
  private readonly mode: "auto" | "review";
  private alwaysApprove = false;
  private activeTurn?: Promise<void>;
  private turnAbort?: AbortController;
  private pendingApproval?: { id: string; settle: (approved: boolean) => void };
  private approvalSeq = 0;

  constructor(options: SidecarOptions) {
    this.app = options.app;
    this.write = options.write;
    this.mode = options.mode;
    this.onShutdown = options.onShutdown ?? (() => {});
  }

  start(): void {
    this.emit({ type: "hello", protocol: PROTOCOL_VERSION, pid: process.pid });
    this.emitSessionState();
  }

  /** Resolves once no turn is running. */
  async idle(): Promise<void> {
    while (this.activeTurn) await this.activeTurn;
  }

  async handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let command: SidecarCommand;
    try {
      command = parseCommand(line);
    } catch (err) {
      const id = err instanceof ProtocolError ? err.id : undefined;
      this.emit({ type: "error", ...(id ? { id } : {}), code: "BAD_REQUEST", message: (err as Error).message });
      return;
    }
    switch (command.type) {
      case "prompt.submit":
        this.submit(command.id, command.text);
        return;
      case "cancel":
        this.turnAbort?.abort(new Error("operator cancel"));
        return;
      case "approve":
        this.resolveApproval(command.id, true, command.always);
        return;
      case "deny":
        this.resolveApproval(command.id, false, false);
        return;
      case "slash":
        await this.slash(command.id, command.command, command.args);
        return;
      case "shutdown":
        await this.shutdown();
        return;
    }
  }

  private submit(id: string, text: string): void {
    if (this.activeTurn) {
      this.emit({ type: "error", id, code: "BUSY", message: "A turn is already running; cancel it or wait for its result." });
      return;
    }
    const abort = new AbortController();
    this.turnAbort = abort;
    this.activeTurn = this.runTurn(id, text, abort.signal).finally(() => {
      this.activeTurn = undefined;
      this.turnAbort = undefined;
      this.emitSessionState();
    });
    this.emitSessionState();
  }

  private async runTurn(turnId: string, text: string, signal: AbortSignal): Promise<void> {
    const agent = this.app.getAgent();
    agent.setObserver({
      onAssistantDelta: (delta) => this.emit({ type: "assistant.delta", turn_id: turnId, text: redactSecrets(delta) }),
      onToolStart: ({ callId, tool, args }) => this.emit({ type: "tool.start", turn_id: turnId, call_id: callId, tool, subject: toolSubject(args) }),
      onToolEnd: ({ callId, tool, success, output, error }) =>
        this.emit({ type: "tool.end", turn_id: turnId, call_id: callId, tool, success, ...toolSummary(success, output, error) }),
    });
    const confirm = this.mode === "review"
      ? (tool: string, args: Record<string, any>) => this.requestApproval(turnId, signal, tool, args)
      : undefined;
    let turn: TurnResult;
    try {
      turn = await agent.runTurn(text, confirm, { signal });
    } catch (err) {
      turn = failedTurnFromError(err, this.app.getConfig().maxSteps);
    } finally {
      agent.setObserver(undefined);
    }
    const { heading, line } = summarizeTurn(turn);
    const summary = turn.execution === "COMPLETED" ? agent.getCompletionSummary() : undefined;
    this.emit({
      type: "turn.result",
      turn_id: turnId,
      heading,
      line: redactSecrets(line),
      turn,
      model_summary: summary
        ? { summary: redactSecrets(summary.summary), ...(summary.notes ? { notes: redactSecrets(summary.notes) } : {}) }
        : null,
    });
  }

  private requestApproval(turnId: string, signal: AbortSignal, tool: string, args: Record<string, any>): Promise<boolean> {
    if (this.alwaysApprove) return Promise.resolve(true);
    if (signal.aborted) return Promise.resolve(false);
    const id = `approval-${++this.approvalSeq}`;
    return new Promise<boolean>((resolve) => {
      const onAbort = () => settle(false);
      const settle = (approved: boolean) => {
        signal.removeEventListener("abort", onAbort);
        this.pendingApproval = undefined;
        resolve(approved);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pendingApproval = { id, settle };
      this.emit({
        type: "approval.request",
        id,
        turn_id: turnId,
        tool,
        subject: toolSubject(args),
        preview: capText(redactSecrets(JSON.stringify(args, null, 2))),
      });
    });
  }

  private resolveApproval(id: string, approved: boolean, always: boolean): void {
    const pending = this.pendingApproval;
    if (!pending || pending.id !== id) {
      this.emit({ type: "error", id, code: "NO_PENDING_APPROVAL", message: `No pending approval with id ${id}.` });
      return;
    }
    if (approved && always) this.alwaysApprove = true;
    pending.settle(approved);
  }

  private async slash(id: string, command: string, args: string): Promise<void> {
    try {
      const result = await this.app.executeSlashCommand(command, args);
      this.emit({ type: "slash.result", id, command: result.command, success: result.success, output: capText(redactSecrets(result.output)) });
    } catch (err) {
      this.emit({ type: "error", id, code: "INTERNAL", message: redactSecrets(err instanceof Error ? err.message : String(err)) });
    }
  }

  private async shutdown(): Promise<void> {
    this.turnAbort?.abort(new Error("sidecar shutdown"));
    await this.idle();
    this.app.shutdown();
    this.onShutdown();
  }

  private emitSessionState(): void {
    const config = this.app.getConfig();
    const git = getGitInfo(config.workspace);
    this.emit({
      type: "session.state",
      workspace: config.workspace,
      workspace_name: path.basename(config.workspace),
      model: config.model,
      mode: this.mode,
      git: git.isRepo ? { branch: git.branch, dirty: git.dirtyCount } : null,
      busy: Boolean(this.activeTurn),
    });
  }

  private emit(event: SidecarEvent): void {
    this.write(encodeEvent(event));
  }
}
```

Note: the test rig calls `app.shutdown()` itself after `idle()`, so it never sends `shutdown` except in the dedicated test in Task 5.

- [ ] **Step 4: Run the tests**

Run: `cd cli && npx tsc --noEmit && npx tsx --test test/sidecar.test.ts`
Expected: no type errors; 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add cli/src/sidecar.ts cli/test/sidecar.test.ts
git commit -m "feat(cli): SidecarServer projects agent turns as protocol events"
```

---

### Task 5: Approvals, cancellation, slash, shutdown

**Files:**
- Modify: `cli/test/sidecar.test.ts` (append)

`SidecarServer` already contains this behaviour from Task 4; this task proves it. If any test fails, fix `cli/src/sidecar.ts`, not the test's expectations.

- [ ] **Step 1: Append the tests**

Append to `cli/test/sidecar.test.ts`:

```ts
const writeTurn = (n: number): Reply => n === 1
  ? { kind: "tools", calls: [{ name: "write_file", args: { path: "x.txt", content: "hi" } }] }
  : { kind: "text", content: "ok" };

describe("SidecarServer: approvals", () => {
  test("deny keeps the file unwritten and reports the tool as failed", async () => {
    await withSidecar(writeTurn, "review", async ({ server, events, repo, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "make x" });
      const req = await waitForEvent(events, (e) => e.type === "approval.request");
      assert.equal(req.turn_id, "t1");
      assert.equal(req.tool, "write_file");
      assert.equal(req.subject, "x.txt");
      assert.ok(req.preview.includes("x.txt"));
      await send({ type: "deny", id: req.id });
      await server.idle();
      assert.equal(fs.existsSync(path.join(repo, "x.txt")), false);
      const end = events.find((e) => e.type === "tool.end" && e.tool === "write_file");
      assert.equal(end.success, false);
      assert.ok(events.some((e) => e.type === "turn.result"));
    });
  });

  test("approve lets the write happen", async () => {
    await withSidecar(writeTurn, "review", async ({ server, events, repo, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "make x" });
      const req = await waitForEvent(events, (e) => e.type === "approval.request");
      await send({ type: "approve", id: req.id });
      await server.idle();
      assert.equal(fs.readFileSync(path.join(repo, "x.txt"), "utf-8"), "hi");
    });
  });

  test("approve with always=true stops asking for the rest of the session", async () => {
    const script = (n: number): Reply => n === 1
      ? { kind: "tools", calls: [{ name: "write_file", args: { path: "a.txt", content: "a" } }] }
      : n === 2
        ? { kind: "tools", calls: [{ name: "write_file", args: { path: "b.txt", content: "b" } }] }
        : { kind: "text", content: "done" };
    await withSidecar(script, "review", async ({ server, events, repo, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "make files" });
      const req = await waitForEvent(events, (e) => e.type === "approval.request");
      await send({ type: "approve", id: req.id, always: true });
      await server.idle();
      assert.equal(events.filter((e) => e.type === "approval.request").length, 1);
      assert.ok(fs.existsSync(path.join(repo, "a.txt")));
      assert.ok(fs.existsSync(path.join(repo, "b.txt")));
    });
  });

  test("an unknown approval id is reported, not ignored", async () => {
    await withSidecar(writeTurn, "review", async ({ events, send }) => {
      await send({ type: "approve", id: "approval-999" });
      const err = events.find((e) => e.type === "error");
      assert.equal(err.code, "NO_PENDING_APPROVAL");
      assert.equal(err.id, "approval-999");
    });
  });
});

describe("SidecarServer: cancellation", () => {
  test("cancel during inference ends the turn INTERRUPTED promptly", async () => {
    await withSidecar(() => ({ kind: "text", content: "slow answer", delayMs: 3000 }), "auto", async ({ server, events, send }) => {
      const started = Date.now();
      await send({ type: "prompt.submit", id: "t1", text: "x" });
      await new Promise((r) => setTimeout(r, 200));
      await send({ type: "cancel" });
      await server.idle();
      assert.ok(Date.now() - started < 2500, "turn ended well before the gateway replied");
      const result = events.find((e) => e.type === "turn.result");
      assert.equal(result.turn.execution, "INTERRUPTED");
      assert.equal(result.turn.outcome, "NOT_ESTABLISHED");
    });
  });

  test("cancel sent immediately after submit is not lost", async () => {
    await withSidecar(() => ({ kind: "text", content: "slow answer", delayMs: 3000 }), "auto", async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "x" });
      await send({ type: "cancel" });
      await server.idle();
      assert.equal(events.find((e) => e.type === "turn.result").turn.execution, "INTERRUPTED");
    });
  });

  test("cancel while an approval is pending denies it and interrupts the turn", async () => {
    await withSidecar(writeTurn, "review", async ({ server, events, repo, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "make x" });
      await waitForEvent(events, (e) => e.type === "approval.request");
      await send({ type: "cancel" });
      await server.idle();
      assert.equal(fs.existsSync(path.join(repo, "x.txt")), false);
      assert.equal(events.find((e) => e.type === "turn.result").turn.execution, "INTERRUPTED");
    });
  });
});

describe("SidecarServer: slash and shutdown", () => {
  test("slash status replies with slash.result", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ events, send }) => {
      await send({ type: "slash", id: "s1", command: "status" });
      const reply = events.find((e) => e.type === "slash.result");
      assert.equal(reply.id, "s1");
      assert.equal(reply.command, "status");
      assert.equal(reply.success, true);
      assert.equal(JSON.parse(reply.output).model, "m");
    });
  });

  test("shutdown calls onShutdown", async () => {
    let shutdowns = 0;
    await withSidecar(readOnlyTurn, "auto", async ({ send }) => {
      await send({ type: "shutdown" });
      assert.equal(shutdowns, 1);
    }, () => shutdowns++);
  });
});
```

- [ ] **Step 2: Run the sidecar tests**

Run: `cd cli && npx tsx --test test/sidecar.test.ts`
Expected: all 14 tests pass. (The shutdown test calls `app.shutdown()` twice — once via the server and once in the rig's `finally`. `AutonomousAgent.shutdown()` stops child processes and is safe to call twice; if it is not, guard the rig's `finally` with a `shutdownCalled` flag rather than changing the agent.)

- [ ] **Step 3: Commit**

```bash
git add cli/test/sidecar.test.ts cli/src/sidecar.ts
git commit -m "test(cli): sidecar approvals, cancellation, slash and shutdown"
```

---

### Task 6: Sidecar process entry point and stdout purity

**Files:**
- Modify: `cli/src/sidecar.ts` (append `main()`)
- Modify: `cli/test/sidecar.test.ts` (append subprocess tests)

- [ ] **Step 1: Append the failing subprocess tests**

Add these imports at the top of `cli/test/sidecar.test.ts`, next to the existing ones:

```ts
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeHome, waitUntil } from "./helpers/fixtures.js";
```

Append:

```ts
const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidecarSrc = path.join(cliRoot, "src", "sidecar.ts");

function spawnSidecar(gwUrl: string, repo: string, home: string) {
  const child = spawn(process.execPath, ["--import", "tsx", sidecarSrc, "-w", repo, "-e", gwUrl, "-m", "m"], {
    cwd: cliRoot,
    env: { ...process.env, HOME: home, NEXUS_DEBUG: "0" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, exited, lines: () => stdout.split("\n").filter(Boolean), stderr: () => stderr };
}

describe("sidecar process", () => {
  test("stdout carries only NDJSON protocol lines across a full turn", async () => {
    const gw = await startGateway(readOnlyTurn);
    const repo = makeRepo();
    const home = makeHome();
    const proc = spawnSidecar(gw.url, repo, home);
    try {
      await waitUntil(() => proc.lines().some((l) => l.includes('"type":"hello"')), 20000);
      proc.child.stdin.write(JSON.stringify({ v: 1, type: "prompt.submit", id: "t1", text: "what is here?" }) + "\n");
      await waitUntil(() => proc.lines().some((l) => l.includes('"type":"turn.result"')), 30000);
      proc.child.stdin.write(JSON.stringify({ v: 1, type: "shutdown" }) + "\n");
      assert.equal(await proc.exited, 0, proc.stderr());
      const messages = proc.lines().map((l) => JSON.parse(l));
      for (const m of messages) {
        assert.equal(m.v, 1);
        assert.equal(typeof m.type, "string");
      }
      assert.equal(messages.find((m) => m.type === "turn.result").turn.outcome, "NOT_REQUIRED");
    } finally {
      proc.child.kill("SIGKILL");
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("closing stdin shuts the sidecar down cleanly", async () => {
    const gw = await startGateway(readOnlyTurn);
    const repo = makeRepo();
    const home = makeHome();
    const proc = spawnSidecar(gw.url, repo, home);
    try {
      await waitUntil(() => proc.lines().some((l) => l.includes('"type":"hello"')), 20000);
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx tsx --test --test-name-pattern="sidecar process" test/sidecar.test.ts`
Expected: FAIL — both tests time out waiting for `hello` (the module has no entry point yet).

- [ ] **Step 3: Append `main()` to `cli/src/sidecar.ts`**

Add these imports at the top of `cli/src/sidecar.ts` with the others:

```ts
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { autoDetectModel, buildConfig, loadEnvironment } from "./config.js";
```

Append at the end of the file:

```ts
/**
 * Process entry point. Stdout is reserved for protocol lines: the real writer is captured first, then every
 * other stdout write (agent banners, spinners, console.log) is dropped, or sent to stderr with NEXUS_DEBUG=1.
 */
async function main(argv: string[]): Promise<void> {
  const protocolWrite = process.stdout.write.bind(process.stdout);
  const debug = process.env.NEXUS_DEBUG === "1";
  (process.stdout as any).write = (chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
    if (debug) process.stderr.write(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array));
    const done = typeof encoding === "function" ? encoding : cb;
    if (typeof done === "function") (done as () => void)();
    return true;
  };
  const toStderr = (...args: unknown[]): void => {
    if (debug) process.stderr.write(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n");
  };
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.debug = toStderr;

  loadEnvironment();
  const program = new Command()
    .name("nexus-sidecar")
    .option("-e, --endpoint <url>", "Local LLM endpoint")
    .option("-m, --model <name>", "Model name")
    .option("-w, --workspace <path>", "Workspace directory")
    .option("-s, --max-steps <number>", "Maximum steps per turn")
    .option("--shell <type>", "Shell for commands", "bash")
    .option("--approve", "Require operator approval before edits and shell commands")
    .parse(argv);
  const options = program.opts();
  const config = await autoDetectModel(buildConfig(options));
  const app = new ApplicationCore(config);
  const server = new SidecarServer({
    app,
    mode: options.approve ? "review" : "auto",
    write: (line) => {
      protocolWrite(line);
    },
    onShutdown: () => process.exit(0),
  });

  const report = (err: unknown) => process.stderr.write(`nexus sidecar: ${err instanceof Error ? err.message : String(err)}\n`);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    server.handleLine(line).catch(report);
  });
  input.on("close", () => {
    server.handleLine(JSON.stringify({ v: PROTOCOL_VERSION, type: "shutdown" })).catch(report);
  });
  server.start();
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  main(process.argv).catch((err) => {
    process.stderr.write(`nexus sidecar failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the whole sidecar test file**

Run: `cd cli && npx tsc --noEmit && npx tsx --test test/sidecar.test.ts`
Expected: no type errors; all 16 tests pass.

- [ ] **Step 5: Commit**

```bash
git add cli/src/sidecar.ts cli/test/sidecar.test.ts
git commit -m "feat(cli): sidecar stdio entry point with protocol-only stdout"
```

---

### Task 7: Build, full verification, tracked dist

**Files:**
- Rebuild: `cli/dist/*` (tracked)

- [ ] **Step 1: Full build**

Run: `make build`
Expected: cargo release build and `tsc` both succeed; `cli/dist/sidecar.js`, `cli/dist/protocol.js`, `cli/dist/config.js` exist.

- [ ] **Step 2: Smoke-test the built sidecar**

Run:

```bash
printf '%s\n' '{"v":1,"type":"shutdown"}' | node cli/dist/sidecar.js -w "$PWD" -m m -e http://127.0.0.1:9/v1; echo "exit=$?"
```

Expected: exactly two JSON lines (`"type":"hello"` then `"type":"session.state"` with `"busy":false`), then `exit=0`. Any other stdout line is a defect.

- [ ] **Step 3: Confirm the existing CLI still starts**

Run: `node cli/dist/index.js --version && node cli/dist/index.js --help`
Expected: prints `1.2.1` and the command list, exit 0.

- [ ] **Step 4: Full test suites**

Run: `cargo test --manifest-path core/Cargo.toml && npm --prefix cli test`
Expected: cargo tests pass; CLI suite passes except the 2 known `security_gates.test.ts` failures.

- [ ] **Step 5: Commit the rebuilt dist**

```bash
git add cli/dist
git status --short cli/dist
git commit -m "build(cli): rebuild dist with sidecar protocol"
```

Confirm `git status --short` shows no other staged paths before committing.

---

## Not in this plan (next plans)

- **Phase 2:** Rust protocol client in `nexus-tui` (spawn sidecar, parse events, live spectator view, stderr capture for the crash screen).
- **Phase 3:** composer, approval modal, Ctrl-C/Esc wiring, `harness` default entry and `--repl` in `harness.sh`/`index.ts`, session persistence from the sidecar (the REPL's `saveCurrentSession` equivalent).
- **Phase 4:** visual polish, README/first-run docs, PTY evidence.
