/**
 * D-04 (docs/v1.1.4/TUI-AUDIT.md): the turn verdict must follow from this turn's evidence.
 *
 * Each scenario drives a real turn against a local OpenAI-compatible gateway in review mode (the audit's
 * `package.json` with `scripts.test`), answering approvals the way the operator did, and checks the classification
 * the TUI and the REPL both render: outcome/reason plus `turnEvidence` (did the workspace change during this turn,
 * were changes carried in, how many actions were denied, which verifier runs happened and when).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { getGitInfo } from "../src/git.js";
import { summarizeTurn, type TurnResult } from "../src/core/turn.js";

type Reply = { kind: "tools"; calls: Array<{ name: string; args: any }> } | { kind: "text"; content: string };
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

function stream(r: Reply): string {
  let out = "";
  if (r.kind === "text") out += sse({ choices: [{ index: 0, delta: { content: r.content } }] });
  else {
    r.calls.forEach((c, i) => {
      out += sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${i}_${Math.random().toString(36).slice(2, 7)}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] });
    });
  }
  return out + sse({ choices: [{ index: 0, delta: {}, finish_reason: r.kind === "tools" ? "tool_calls" : "stop" }] }) + "data: [DONE]\n\n";
}

/** Scripted like the audit's fake model: the first request of each turn gets `first`, every later one plain text. */
async function gateway(firsts: Array<Reply | Reply[]>): Promise<{ url: string; close(): Promise<void> }> {
  let turn = -1;
  let step = 0;
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "m" }] }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const last = body.messages?.at(-1);
      // A new operator prompt starts a turn; tool results continue it.
      if (last?.role === "user" && !String(last.content).startsWith("[Nexus")) { turn++; step = 0; } else step++;
      // A turn's script is one reply, or a list of replies by step; after the script the model says "Done.".
      const script = firsts[turn];
      const reply = (Array.isArray(script) ? script[step] : step === 0 ? script : undefined) ?? { kind: "text" as const, content: "Done." };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(stream(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function auditRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-d04-"));
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# Demo\n\nA small repository.\n");
  fs.writeFileSync(path.join(repo, "package.json"), '{"name":"demo","scripts":{"test":"echo ok"}}');
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: repo, stdio: "ignore" });
  return repo;
}

const write = { kind: "tools" as const, calls: [{ name: "write_file", args: { path: "src/new.ts", content: "export const a = 1;\n" } }] };
const del = { kind: "tools" as const, calls: [{ name: "delete_file", args: { path: "base.txt" } }] };
const echo = { kind: "tools" as const, calls: [{ name: "run_command", args: { command: "for i in 1 2 3; do echo step $i; done" } }] };
const touch = { kind: "tools" as const, calls: [{ name: "run_command", args: { command: "echo made > made.txt" } }] };
const hello = { kind: "text" as const, content: "Hello." };
const knowledge = { kind: "tools" as const, calls: [{ name: "manage_knowledge", args: { action: "set", key: "k", value: "v" } }] };

/** Runs one turn per prompt; `deny` names the tools the operator denies (everything else, verifier included, is approved). */
async function turns(firsts: Array<Reply | Reply[]>, deny: string[] = [], setup?: (repo: string) => void): Promise<{ results: TurnResult[]; repo: string; agent: AutonomousAgent }> {
  const gw = await gateway(firsts);
  const repo = auditRepo();
  setup?.(repo);
  const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash", approvalMode: "review" } as any);
  const results: TurnResult[] = [];
  try {
    for (let i = 0; i < firsts.length; i++) {
      results.push(await agent.runTurn(`go ${i}`, async (tool) => !deny.includes(tool)));
    }
    return { results, repo, agent };
  } finally {
    agent.shutdown();
    await gw.close();
  }
}

describe("D-04: the verdict follows this turn's evidence", () => {
  test("1. an approved verifier run before the change is reported as run, not as 'no verifier ran'", async () => {
    const { results: [r], repo } = await turns([write]);
    try {
      assert.equal(r.outcome, "UNVERIFIED", "the change itself was never checked");
      assert.equal(r.reason, "VERIFICATION_NOT_RUN");
      assert.equal(r.turnEvidence?.workspaceChanged, "yes");
      assert.deepEqual(r.turnEvidence?.verifierRuns, [{ command: "npm test", phase: "before_change", passed: true }]);
      assert.match(summarizeTurn(r).line, /npm test ran before the change; nothing checked the change itself/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("2a. a denied delete changes nothing: NOT_REQUIRED with the denial counted", async () => {
    const { results: [r], repo } = await turns([del], ["delete_file"]);
    try {
      assert.equal(r.outcome, "NOT_REQUIRED");
      assert.equal(r.turnEvidence?.workspaceChanged, "no");
      assert.equal(r.turnEvidence?.denied, 1);
      assert.ok(fs.existsSync(path.join(repo, "base.txt")));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("2b. a denied delete after an earlier change: still unverified, but this turn changed nothing", async () => {
    const { results: [, r], repo } = await turns([write, del], ["delete_file"]);
    try {
      assert.equal(r.outcome, "UNVERIFIED", "the earlier change is still unverified");
      assert.equal(r.turnEvidence?.workspaceChanged, "no");
      assert.equal(r.turnEvidence?.carriedChanges, true);
      assert.equal(r.turnEvidence?.denied, 1);
      assert.match(summarizeTurn(r).line, /no files changed this turn/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("3. a read-only run_command turn changes nothing: NOT_REQUIRED, no pending obligation", async () => {
    const { results: [r], repo } = await turns([echo]);
    try {
      assert.equal(r.outcome, "NOT_REQUIRED", `got ${r.outcome}/${r.reason}`);
      assert.equal(r.unverifiedChangesPending, false);
      assert.equal(r.turnEvidence?.workspaceChanged, "no");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("3b. a command that does write a file stays UNVERIFIED (the command latch is only lifted on proof)", async () => {
    const { results: [r], repo } = await turns([touch]);
    try {
      assert.equal(r.outcome, "UNVERIFIED");
      assert.equal(r.unverifiedChangesPending, true);
      assert.equal(r.turnEvidence?.workspaceChanged, "yes");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("3c. a turn that only records knowledge writes .nexus/knowledge.json, which is outside the comparison: NOT_REQUIRED", async () => {
    const { results: [r], repo } = await turns([knowledge]);
    try {
      assert.ok(fs.existsSync(path.join(repo, ".nexus", "knowledge.json")), "the knowledge file was written");
      assert.equal(r.outcome, "NOT_REQUIRED", `got ${r.outcome}/${r.reason}`);
      assert.equal(r.turnEvidence?.workspaceChanged, "no");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("4. a turn with no change says so, and the header agrees (0 changed)", async () => {
    const { results: [r], repo } = await turns([hello]);
    try {
      assert.equal(r.outcome, "NOT_REQUIRED");
      assert.equal(r.turnEvidence?.workspaceChanged, "no");
      assert.equal(getGitInfo(repo).dirtyCount, 0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("deleting a tracked file and writing it back unchanged still ends UNVERIFIED (a write tool ran)", async () => {
    const { results: [r], repo } = await turns([[
      { kind: "tools", calls: [{ name: "delete_file", args: { path: "base.txt" } }] },
      { kind: "tools", calls: [{ name: "write_file", args: { path: "base.txt", content: "base\n" } }] },
    ]]);
    try {
      assert.equal(fs.readFileSync(path.join(repo, "base.txt"), "utf-8"), "base\n");
      assert.equal(r.outcome, "UNVERIFIED", `got ${r.outcome}/${r.reason}`);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a gitignored write in a turn that carried changes in is not reported as 'no files changed this turn'", async () => {
    const write2 = { kind: "tools" as const, calls: [{ name: "write_file", args: { path: "build/new.js", content: "y\n" } }] };
    const { results: [, r], repo } = await turns([write, write2], [], (dir) => {
      fs.writeFileSync(path.join(dir, ".gitignore"), "build/\n");
    });
    try {
      assert.ok(fs.existsSync(path.join(repo, "build", "new.js")));
      assert.equal(r.turnEvidence?.carriedChanges, true);
      assert.equal(r.turnEvidence?.workspaceChanged, "yes", "a file-write tool ran, whatever the identity saw");
      assert.doesNotMatch(summarizeTurn(r).line, /no files changed this turn/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("building the verdict again (a failed final checkpoint rebuilds it) does not change the engineering outcome", async () => {
    const { results: [r], repo, agent } = await turns([echo]);
    try {
      assert.equal(r.outcome, "NOT_REQUIRED");
      const again = (agent as any).buildTurnResult({ modelStop: "FINAL_TEXT", finalOutputComplete: true, inferenceFailure: null, interruption: null, limitReached: false, stepsUsed: 2 }) as TurnResult;
      assert.equal(again.outcome, r.outcome, `rebuilt as ${again.outcome}/${again.reason}`);
      assert.equal(again.unverifiedChangesPending, false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a command that leaves a background process running keeps the obligation (the process may still write)", async () => {
    const bg = { kind: "tools" as const, calls: [{ name: "run_command", args: { command: "(sleep 2; echo late > late.txt) &" } }] };
    const { results: [r], repo } = await turns([bg]);
    try {
      assert.equal(r.outcome, "UNVERIFIED", `got ${r.outcome}/${r.reason}`);
      assert.equal(r.unverifiedChangesPending, true);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 2600));
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("run_command with background: true (no service_name, no shell &) keeps the obligation", async () => {
    // The documented way to run a managed process without blocking the turn: the text of the command shows nothing.
    const bg = { kind: "tools" as const, calls: [{ name: "run_command", args: { command: "sleep 2; echo late > late.txt", background: true } }] };
    const { results: [r], repo } = await turns([bg]);
    try {
      assert.equal(r.outcome, "UNVERIFIED", `got ${r.outcome}/${r.reason}`);
      assert.equal(r.unverifiedChangesPending, true);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 2600));
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a command that edits an already-dirty tracked café.ts is UNVERIFIED (git's default path quoting must not hide it)", async () => {
    const edit = { kind: "tools" as const, calls: [{ name: "run_command", args: { command: "echo changed >> café.ts" } }] };
    const { results: [r], repo } = await turns([edit], [], (dir) => {
      fs.writeFileSync(path.join(dir, "café.ts"), "one\n");
      execSync("git add . && git commit -qm cafe", { cwd: dir, stdio: "ignore" });
      fs.writeFileSync(path.join(dir, "café.ts"), "dirty before the turn\n");
    });
    try {
      assert.match(fs.readFileSync(path.join(repo, "café.ts"), "utf-8"), /changed/);
      assert.equal(r.outcome, "UNVERIFIED", `got ${r.outcome}/${r.reason}`);
      assert.equal(r.turnEvidence?.workspaceChanged, "yes");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a file name that is not valid UTF-8 makes the workspace state unknown: the turn stays UNVERIFIED", async () => {
    const edit = { kind: "tools" as const, calls: [{ name: "run_command", args: { command: "printf 'x' >> \"$(printf 'bad\\377.txt')\"" } }] };
    const { results: [r], repo } = await turns([edit], [], (dir) => {
      fs.writeFileSync(Buffer.concat([Buffer.from(dir + "/"), Buffer.from([0x62, 0x61, 0x64, 0xff, 0x2e, 0x74, 0x78, 0x74])]), "one\n");
    });
    try {
      assert.equal(r.outcome, "UNVERIFIED", `got ${r.outcome}/${r.reason}`);
      assert.equal(r.turnEvidence?.workspaceChanged, "unknown");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  describe("a real file write the workspace identity cannot see is never reported as no change", () => {
    const ignored = { ".gitignore": "build/\n", "build/old.js": "x\n" };
    async function ignoredTurn(script: Reply | Reply[]): Promise<{ r: TurnResult; repo: string }> {
      const gw = await gateway([script]);
      const repo = auditRepo();
      for (const [name, content] of Object.entries(ignored)) {
        fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
        fs.writeFileSync(path.join(repo, name), content);
      }
      execSync("git add .gitignore && git commit -qm ignore", { cwd: repo, stdio: "ignore" });
      const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash", approvalMode: "auto" } as any);
      try {
        return { r: await agent.runTurn("go"), repo };
      } finally {
        agent.shutdown();
        await gw.close();
      }
    }

    test("write_file into a gitignored directory stays UNVERIFIED", async () => {
      const { r, repo } = await ignoredTurn({ kind: "tools", calls: [{ name: "write_file", args: { path: "build/new.js", content: "y\n" } }] });
      try {
        assert.ok(fs.existsSync(path.join(repo, "build", "new.js")));
        assert.equal(r.outcome, "UNVERIFIED", `got ${r.outcome}/${r.reason}`);
        assert.equal(r.unverifiedChangesPending, true);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    test("delete_file of a gitignored file stays UNVERIFIED", async () => {
      const { r, repo } = await ignoredTurn({ kind: "tools", calls: [{ name: "delete_file", args: { path: "build/old.js" } }] });
      try {
        assert.equal(fs.existsSync(path.join(repo, "build", "old.js")), false);
        assert.equal(r.outcome, "UNVERIFIED", `got ${r.outcome}/${r.reason}`);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

  });

  describe("the REPL verdict line words the same facts as the TUI", () => {
    const turn = (over: Partial<TurnResult>, evidence: Partial<NonNullable<TurnResult["turnEvidence"]>>): TurnResult => ({
      execution: "COMPLETED", outcome: "UNVERIFIED", reason: "VERIFICATION_NOT_RUN", acceptance: "NOT_REQUESTED", modelStop: "FINAL_TEXT",
      finalOutputComplete: true, verification: null, interruption: null, inferenceFailure: null, steps: { used: 1, max: 6, limitReached: false },
      unverifiedChangesPending: true, finishedAt: "2026-11-10T00:00:00Z",
      turnEvidence: { workspaceChanged: "yes", carriedChanges: false, denied: 0, verifierRuns: [], ...evidence }, ...over,
    }) as TurnResult;
    const line = (t: TurnResult) => summarizeTurn(t).line;

    test("a completion run followed by a later edit is a run, not 'no verifier ran'", () => {
      const l = line(turn({}, { verifierRuns: [{ command: "npm test", phase: "before_change", passed: true }, { command: "npm test", phase: "completion", passed: true }] }));
      assert.match(l, /npm test ran, but the change was edited after it/);
    });

    test("the carried-change text appears only for VERIFICATION_NOT_RUN", () => {
      const carried = { workspaceChanged: "no" as const, carriedChanges: true };
      assert.match(line(turn({}, carried)), /no files changed this turn/);
      assert.doesNotMatch(line(turn({ reason: "NO_TESTS_EXECUTED" }, carried)), /no files changed this turn/);
      assert.doesNotMatch(line(turn({ reason: "NO_APPLICABLE_VERIFIER" }, carried)), /no files changed this turn/);
    });

    test("an unknown workspace state does not claim that files changed, like the TUI", () => {
      const l = line(turn({}, { workspaceChanged: "unknown" }));
      assert.match(l, /files may have changed/);
      assert.doesNotMatch(l, /no files changed this turn/);
    });

    test("a long verifier command is bounded in the line", () => {
      const l = line(turn({}, { verifierRuns: [{ command: "x".repeat(400), phase: "before_change", passed: true }] }));
      assert.ok(l.length < 260, `${l.length} chars`);
      assert.match(l, /…/);
    });
  });
});
