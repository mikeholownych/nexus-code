# Nexus TUI Phase 3C: Tool Detail and Receipt Overlays Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the live TUI the operator can select any tool call in the transcript and open its full record (redacted arguments, output, status, duration), and can open a receipt for the last turn (execution, outcome, verifier evidence and the active validation receipt), each in a scrollable overlay.

**Architecture:** The sidecar gives every tool call a session-unique evidence id, sends it on `tool.start`/`tool.end`, and keeps the latest 200 calls in a ledger of redacted, escape-stripped, capped records. Two read-only commands, `tool.detail` and `receipt`, are answered by matching events at any time, even mid-turn. The receipt is a list of labelled sections the sidecar projects from the last `TurnResult` and `ApplicationCore.getActiveValidationReceipt()`. The client renders what it is given and decides nothing. In Rust, transcript focus gains tool selection (`[`/`]`, Enter for details, `v` for the receipt); `/receipt` opens the receipt from the composer. Panels open immediately in a loading state and fill when the matching answer arrives.

**Tech Stack:** TypeScript (Node 24, `node:test`), Rust 2024 (ratatui 0.30.2, crossterm 0.29, serde, serde_json).

**Spec:** `docs/superpowers/specs/2026-10-04-nexus-ratatui-live-default-design.md` (phase 3: tool/evidence detail and validation receipt overlays). **Depends on:** plans 3A (`…-phase3a-interaction-core.md`) and 3B (`…-phase3b-slash-commands.md`) merged first; code below assumes their `Overlay`, `LiveLayout`, `note_layout`, `scroll_overlay`, `on_help_key`, `render_transcript`, `modal`, `modal_block`, `composer_hint`, `HELP`, slash catalogue, `SlashHost` and `observerFor`.

---

## Before you start

- Work in an isolated worktree (superpowers:using-git-worktrees) branched from a main that contains plans 3A and 3B. The main checkout has unrelated uncommitted Cloudflare/Issue 12 files; never stage them.
- Build once: `make build`.
- Rust tests: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui > /tmp/t.txt 2>&1`, then read `/tmp/t.txt`. Baseline after 3B: 114 tests pass. Always redirect cargo output to a file (an `rtk` wrapper alters piped output).
- CLI tests: `cd cli && node --import tsx --test test/*.test.ts > /tmp/cli.txt 2>&1`. Baseline after 3B: 350 tests; the only failure is `SCAN-001 & SCAN-004: Security gates script passes on clean codebase` (and its parent `WP-11` suite).
- Run edits and test commands strictly one after another. Never batch an edit with a test run.
- Format only files you touch: `rustfmt --edition 2024 <file>`. Restore the `#[path] mod` order in `core/src/bin/nexus_tui.rs` if rustfmt changes it.
- After TS changes: `cd cli && npm run build` and commit the changed `cli/dist` files with the task. Revert any `package-lock.json` change.
- Never read or print `cli/.env`. Never push.

## Decisions (binding for this plan)

- **Evidence ids** are `e1`, `e2`, … per sidecar process. Model call ids can repeat across turns, evidence ids cannot. Both `tool.start` and `tool.end` carry the id; the Rust client keeps it on the transcript's tool entry.
- **Ledger:** the latest 200 calls, oldest dropped first. A record holds the tool, subject, pretty-printed arguments, status (`running`, `succeeded`, `failed`), output (with the error appended on failure), and duration. Arguments and output are escape-stripped, redacted with `redactSecrets` and capped at 64,000 characters. A dropped or unknown id answers `error` code `NOT_FOUND`.
- **Receipt sections**, in order: "Last turn" (result heading, execution, outcome, reason, detail, steps, model stop, interruption, inference failure, pending unverified changes, finish time), "Verifier" (the turn's `verification`), "Validation receipt" (the active `ValidationReceipt`). An empty section carries a note explaining why. Free text is redacted. `/receipt` in the readline-free sidecar router returns the same sections as plain text.
- **Read-only commands never wait.** `tool.detail` and `receipt` are answered immediately while a turn or command runs; they are not jobs and never produce `BUSY`.
- **Keys.** In transcript focus: `[` selects the previous (older) tool call, `]` the next; the first press selects the newest. Selection moves the window just enough to show the call, once; scrolling afterwards is free. Enter opens the selected call's details (Enter without a selection still returns to the composer). `v` opens the receipt. Esc clears the selection, a second Esc returns to the composer; entering transcript focus starts without a selection. In a panel: arrows, page keys, Home/End scroll; Esc, Enter, `q` or `?` close; Ctrl-C closes. An approval request replaces any open panel.
- **Panels** cover the transcript area (status strip and composer hint stay visible), open immediately with a loading line, ignore answers for other request ids, and show a failed request's error inside the panel rather than in the transcript.
- **Count baseline after 3B:** 3A added eight Rust tests (review) and one CLI test (`tui_multiline_e2e.test.ts`), and the 3B multiline-draft rule added parse assertions only. Add 8 to every Rust count and 1 to every CLI count in this plan, unless 3B's final verification recorded different numbers, in which case use those. `tui_multiline_e2e.test.ts` must keep passing.
- **Out of scope:** per-hunk patch approval (phase 4), opening records of hidden tools (`task_completed` and the like are not in the transcript), persisting the ledger across restarts.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `cli/src/evidence.ts` | Create | `EvidenceLedger`, `receiptSections`, `receiptText` |
| `cli/test/evidence.test.ts` | Create | Ledger and receipt projection tests |
| `cli/src/protocol.ts` | Modify | `evidence` on tool events, `tool.detail`/`receipt` events and commands, `NOT_FOUND` |
| `cli/src/sidecar.ts` | Modify | Ledger in the observer, last turn, read-only command handling, `SlashHost.receipt` |
| `cli/src/slash/catalog.ts` | Modify | `/receipt` entry, `SlashHost.receipt` |
| `cli/src/slash/session_commands.ts` | Modify | `/receipt` handler |
| `cli/test/protocol.test.ts`, `cli/test/sidecar.test.ts`, `cli/test/slash_router.test.ts` | Modify | New command, evidence and receipt tests |
| `core/src/bin/nexus_tui/protocol.rs` | Modify | `ToolStart.evidence`, `ToolDetail`, `Receipt`, `ReceiptSection`, two commands |
| `core/src/bin/nexus_tui/slash.rs` | Modify | `Invocation::Receipt` |
| `core/src/bin/nexus_tui/live_state.rs` | Modify | `Entry::Tool.evidence`, selection, panels, answers, follow |
| `core/src/bin/nexus_tui/live_view.rs` | Modify | Selection highlight and follow, detail and receipt panels, hints, help rows |
| `core/src/bin/nexus_tui/live.rs` | Modify | Detail round-trip test |

---

### Task 1: Evidence ledger and receipt projection

**Files:**
- Create: `cli/src/evidence.ts`
- Create: `cli/test/evidence.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `cli/test/evidence.test.ts`:

```ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ValidationReceipt } from "../src/core/candidate.js";
import type { TurnResult } from "../src/core/turn.js";
import { EvidenceLedger, MAX_DETAIL, receiptSections, receiptText } from "../src/evidence.js";

function clock(...times: number[]): () => number {
  return () => times.shift() ?? 0;
}

const verifiedTurn: TurnResult = {
  execution: "COMPLETED",
  outcome: "VERIFIED",
  acceptance: "NOT_REQUESTED",
  modelStop: "TASK_COMPLETED_TOOL",
  finalOutputComplete: true,
  verification: { status: "PASSED", command: "npm test", source: "discovered", exitSuccess: true, outputSha256: "abc123", candidateId: "cand-1", at: "2026-10-04T10:00:00.000Z" },
  interruption: null,
  inferenceFailure: null,
  steps: { used: 4, max: 30, limitReached: false },
  unverifiedChangesPending: false,
  finishedAt: "2026-10-04T10:00:01.000Z",
};

describe("evidence ledger", () => {
  test("each call gets a new id and a running record that the end fills in", () => {
    const ledger = new EvidenceLedger(200, clock(1000, 1250, 2000));
    const first = ledger.start("t1", "read_file", "a.ts", { path: "a.ts" });
    assert.equal(first, "e1");
    assert.deepEqual(ledger.get(first), {
      evidence: "e1",
      turnId: "t1",
      tool: "read_file",
      subject: "a.ts",
      args: '{\n  "path": "a.ts"\n}',
      status: "running",
      output: "",
      startedAt: 1000,
      durationMs: null,
    });
    ledger.end(first, true, "const a = 1;");
    assert.equal(ledger.get(first)?.status, "succeeded");
    assert.equal(ledger.get(first)?.output, "const a = 1;");
    assert.equal(ledger.get(first)?.durationMs, 250);
    assert.equal(ledger.start("t2", "read_file", "a.ts", { path: "a.ts" }), "e2");
  });

  test("a failed call keeps its output and appends the error", () => {
    const ledger = new EvidenceLedger();
    const id = ledger.start("t1", "run_command", "make", { command: "make" });
    ledger.end(id, false, "partial output", "exit code 2");
    assert.equal(ledger.get(id)?.status, "failed");
    assert.equal(ledger.get(id)?.output, "partial output\nexit code 2");
  });

  test("secrets and terminal escapes are removed and long output is capped", () => {
    const ledger = new EvidenceLedger();
    const id = ledger.start("t1", "write_file", "env.ts", { path: "env.ts", content: "token = sk-abcdefghijklmnopqrstuvwxyz123456" });
    assert.equal(ledger.get(id)?.args.includes("sk-abcdefghij"), false);
    ledger.end(id, true, "\x1b[31mred\x1b[0m " + "x".repeat(MAX_DETAIL + 6000));
    const output = ledger.get(id)?.output ?? "";
    assert.ok(output.startsWith("red x"));
    assert.ok(output.endsWith("…[truncated 6004 chars]"), output.slice(-40));
  });

  test("only the latest records are kept", () => {
    const ledger = new EvidenceLedger(2);
    const ids = ["a", "b", "c"].map((name) => ledger.start("t1", "read_file", name, { path: name }));
    assert.equal(ledger.get(ids[0]), undefined);
    assert.equal(ledger.get(ids[1])?.subject, "b");
    assert.equal(ledger.get(ids[2])?.subject, "c");
    ledger.end(ids[0], true, "late");
    assert.equal(ledger.get(ids[0]), undefined);
  });
});

describe("receipt projection", () => {
  test("before any turn every section says why it is empty", () => {
    const sections = receiptSections(null, null);
    assert.deepEqual(sections.map((s) => [s.title, s.rows.length]), [["Last turn", 0], ["Verifier", 0], ["Validation receipt", 0]]);
    assert.equal(sections[0].note, "No turn has finished in this session yet.");
    assert.equal(sections[1].note, "Nothing to report until a turn finishes.");
    assert.match(sections[2].note ?? "", /^No validation receipt is active\./);
  });

  test("a verified turn with a receipt lists every field, redacted", () => {
    const receipt: ValidationReceipt = {
      receiptId: "rcpt-1",
      candidateId: "cand-1",
      verifierCommand: "API_KEY=supersecretvalue npm test",
      exitCode: 0,
      stdoutHash: "def456",
      timestamp: "2026-10-04T10:00:02.000Z",
      status: "PASSED",
      materialDependencies: [],
    };
    const sections = receiptSections({ heading: "TURN VERIFIED", turn: verifiedTurn }, receipt);
    assert.deepEqual(sections[0].rows, [
      ["result", "TURN VERIFIED"],
      ["execution", "COMPLETED"],
      ["outcome", "VERIFIED"],
      ["steps", "4 of 30"],
      ["model stop", "TASK_COMPLETED_TOOL"],
      ["finished", "2026-10-04T10:00:01.000Z"],
    ]);
    assert.deepEqual(sections[1].rows, [
      ["status", "PASSED"],
      ["command", "npm test"],
      ["source", "discovered"],
      ["exit", "success"],
      ["output sha256", "abc123"],
      ["candidate", "cand-1"],
      ["at", "2026-10-04T10:00:00.000Z"],
    ]);
    const command = sections[2].rows.find(([label]) => label === "command")?.[1] ?? "";
    assert.equal(command.includes("supersecretvalue"), false);
    const text = receiptText(sections);
    assert.match(text, /^Last turn\n  result        TURN VERIFIED$/m);
    assert.match(text, /^Validation receipt\n  status        PASSED$/m);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cli && node --import tsx --test test/evidence.test.ts > /tmp/c1.txt 2>&1`
Expected: FAIL: cannot find module `../src/evidence.js`.

- [ ] **Step 3: Implement**

Create `cli/src/evidence.ts`:

```ts
/**
 * Evidence the live TUI opens after the fact: each tool call's full record, and the receipt for the last turn.
 * Everything here is a redacted projection; nothing decides an outcome.
 */
import type { ValidationReceipt } from "./core/candidate.js";
import type { TurnResult } from "./core/turn.js";
import { capText, stripEscapes } from "./protocol.js";
import { redactSecrets } from "./ui.js";

export const MAX_DETAIL = 64_000;
export const MAX_EVIDENCE = 200;

export type EvidenceStatus = "running" | "succeeded" | "failed";

export interface EvidenceRecord {
  evidence: string;
  turnId: string;
  tool: string;
  subject: string;
  /** Arguments as pretty-printed JSON. */
  args: string;
  status: EvidenceStatus;
  output: string;
  startedAt: number;
  durationMs: number | null;
}

function clean(text: string): string {
  return capText(redactSecrets(stripEscapes(text)), MAX_DETAIL);
}

/** The latest tool calls of this session; the oldest is dropped first. */
export class EvidenceLedger {
  private readonly records = new Map<string, EvidenceRecord>();
  private seq = 0;

  constructor(
    private readonly limit: number = MAX_EVIDENCE,
    private readonly now: () => number = Date.now,
  ) {}

  start(turnId: string, tool: string, subject: string, args: Record<string, unknown>): string {
    const evidence = `e${++this.seq}`;
    this.records.set(evidence, {
      evidence,
      turnId,
      tool,
      subject,
      args: clean(JSON.stringify(args ?? {}, null, 2)),
      status: "running",
      output: "",
      startedAt: this.now(),
      durationMs: null,
    });
    for (const oldest of this.records.keys()) {
      if (this.records.size <= this.limit) break;
      this.records.delete(oldest);
    }
    return evidence;
  }

  end(evidence: string, success: boolean, output: string, error?: string): void {
    const record = this.records.get(evidence);
    if (!record) return;
    const parts = success || !error || error === output ? [output] : [output, error];
    record.status = success ? "succeeded" : "failed";
    record.output = clean(parts.filter(Boolean).join("\n"));
    record.durationMs = Math.max(0, this.now() - record.startedAt);
  }

  get(evidence: string): EvidenceRecord | undefined {
    return this.records.get(evidence);
  }
}

export type ReceiptRow = [string, string];

export interface ReceiptSection {
  title: string;
  rows: ReceiptRow[];
  /** Why the section is empty, or a footnote. */
  note?: string;
}

/** The last turn as reported in `turn.result`. */
export interface LastTurn {
  heading: string;
  turn: TurnResult;
}

export function receiptSections(last: LastTurn | null, receipt: ValidationReceipt | null): ReceiptSection[] {
  return [turnSection(last), verifierSection(last?.turn ?? null), validationSection(receipt)];
}

function turnSection(last: LastTurn | null): ReceiptSection {
  if (!last) return { title: "Last turn", rows: [], note: "No turn has finished in this session yet." };
  const t = last.turn;
  const rows: ReceiptRow[] = [
    ["result", clean(last.heading)],
    ["execution", t.execution],
    ["outcome", t.outcome],
  ];
  if (t.reason) rows.push(["reason", t.reason]);
  if (t.detail) rows.push(["detail", clean(t.detail)]);
  rows.push(["steps", `${t.steps.used} of ${t.steps.max}${t.steps.limitReached ? " · limit reached" : ""}`]);
  rows.push(["model stop", t.modelStop]);
  if (t.interruption) {
    rows.push(["interrupted", `during ${t.interruption.phase.replace(/_/g, " ")}`]);
    if (t.interruption.outstandingTool) rows.push(["outstanding", clean(t.interruption.outstandingTool)]);
  }
  if (t.inferenceFailure) {
    const failure = t.inferenceFailure;
    rows.push(["inference", `${failure.kind} (${failure.origin}): ${clean(failure.message)}`]);
  }
  if (t.unverifiedChangesPending) rows.push(["pending", "workspace changes that no passing verifier run covers"]);
  rows.push(["finished", t.finishedAt]);
  return { title: "Last turn", rows };
}

function verifierSection(turn: TurnResult | null): ReceiptSection {
  const v = turn?.verification;
  if (!v) return { title: "Verifier", rows: [], note: turn ? "No verifier ran for this turn." : "Nothing to report until a turn finishes." };
  const rows: ReceiptRow[] = [["status", v.status]];
  if (v.command) rows.push(["command", clean(v.command)]);
  if (v.source) rows.push(["source", v.source]);
  if (v.exitSuccess !== undefined) rows.push(["exit", v.exitSuccess ? "success" : "failure"]);
  if (v.outputSha256) rows.push(["output sha256", v.outputSha256]);
  if (v.candidateId) rows.push(["candidate", v.candidateId]);
  rows.push(["at", v.at]);
  return { title: "Verifier", rows };
}

function validationSection(receipt: ValidationReceipt | null): ReceiptSection {
  if (!receipt) {
    return {
      title: "Validation receipt",
      rows: [],
      note: "No validation receipt is active. Authoritative verifier runs (--authoritative-verifier) record one.",
    };
  }
  const rows: ReceiptRow[] = [
    ["status", receipt.status],
    ["receipt", receipt.receiptId],
    ["command", clean(receipt.verifierCommand)],
    ["exit code", String(receipt.exitCode)],
    ["stdout sha256", receipt.stdoutHash],
    ["candidate", receipt.candidateId],
    ["recorded", receipt.timestamp],
  ];
  if (receipt.invalidationReason) {
    rows.push(["invalidated", `${clean(receipt.invalidationReason)}${receipt.invalidatedAt ? ` (${receipt.invalidatedAt})` : ""}`]);
  }
  return { title: "Validation receipt", rows };
}

/** The sections as plain text, for clients without the receipt panel. */
export function receiptText(sections: ReceiptSection[]): string {
  return sections
    .map((s) => [s.title, ...s.rows.map(([label, value]) => `  ${label.padEnd(14)}${value}`), ...(s.note ? [`  ${s.note}`] : [])].join("\n"))
    .join("\n\n");
}
```

(`stripEscapes` is exported from `protocol.ts` by plan 3B.)

- [ ] **Step 4: Run the tests**

Run: `cd cli && node --import tsx --test test/evidence.test.ts > /tmp/c1.txt 2>&1`
Expected: PASS, 6 tests. The truncation count is 6004: the 4 characters `red ` plus the 6000 over the cap (escapes are stripped before capping).

- [ ] **Step 5: Full CLI suite, build, commit**

Run the full CLI suite (expected 356 tests, only the known failure), then:

```bash
cd cli && npm run build && cd ..
git add cli/src/evidence.ts cli/test/evidence.test.ts cli/dist
git commit -m "feat(sidecar): tool evidence ledger and turn receipt projection"
```

---

### Task 2: Protocol and sidecar: evidence ids, details and receipts

**Files:**
- Modify: `cli/src/protocol.ts`, `cli/src/sidecar.ts`
- Modify: `cli/src/slash/catalog.ts`, `cli/src/slash/session_commands.ts`
- Modify: `cli/test/protocol.test.ts`, `cli/test/sidecar.test.ts`, `cli/test/slash_router.test.ts`

- [ ] **Step 1: Write the failing tests**

1. In `cli/test/protocol.test.ts`, add to "accepts every command type":

```ts
    assert.deepEqual(parseCommand('{"v":1,"type":"tool.detail","id":"d1","evidence":"e3"}'), { type: "tool.detail", id: "d1", evidence: "e3" });
    assert.deepEqual(parseCommand('{"v":1,"type":"receipt","id":"r1"}'), { type: "receipt", id: "r1" });
```

and add a test to the `protocol: parseCommand` describe:

```ts
  test("tool.detail needs an evidence id and receipt needs a request id", () => {
    assert.throws(() => parseCommand('{"v":1,"type":"tool.detail","id":"d1"}'), (err: unknown) => err instanceof ProtocolError && err.id === "d1" && /requires evidence/.test(err.message));
    assert.throws(() => parseCommand('{"v":1,"type":"receipt"}'), /receipt requires id/);
  });
```

2. In `cli/test/slash_router.test.ts`, add `import { receiptSections } from "../src/evidence.js";`, add `receipt: () => receiptSections(null, null),` to the `host` object in `withRig`, and add to the session-commands describe:

```ts
  test("receipt reports that no turn has finished yet", async () => {
    await withRig(async ({ reply }) => {
      assert.match((await reply("receipt")).output, /^Last turn\n  No turn has finished in this session yet\.$/m);
    });
  });
```

3. In `cli/test/sidecar.test.ts` add, before `const cliRoot`:

```ts
describe("SidecarServer: evidence and receipts", () => {
  test("tool events share one evidence id per call, and tool.detail returns the full record", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "what is here?" });
      await server.idle();
      const start = events.find((e) => e.type === "tool.start");
      const end = events.find((e) => e.type === "tool.end");
      assert.match(start.evidence, /^e\d+$/);
      assert.equal(end.evidence, start.evidence);
      await send({ type: "tool.detail", id: "d1", evidence: start.evidence });
      const detail = events.find((e) => e.type === "tool.detail");
      assert.equal(detail.id, "d1");
      assert.equal(detail.evidence, start.evidence);
      assert.equal(detail.tool, "list_dir");
      assert.equal(detail.subject, ".");
      assert.equal(detail.status, "succeeded");
      assert.deepEqual(JSON.parse(detail.args), { path: "." });
      assert.match(detail.output, /base\.txt/);
      assert.equal(typeof detail.duration_ms, "number");
    });
  });

  test("an unknown evidence id is NOT_FOUND", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ events, send }) => {
      await send({ type: "tool.detail", id: "d1", evidence: "e999" });
      const error = events.find((e) => e.type === "error");
      assert.equal(error.id, "d1");
      assert.equal(error.code, "NOT_FOUND");
      assert.equal(error.message, "No record of tool call e999; only the latest 200 are kept.");
    });
  });

  test("a running call's record is available before it finishes", async () => {
    const slowCommand = (n: number): Reply => n === 1
      ? { kind: "tools", calls: [{ name: "run_command", args: { command: "sleep 1; echo slept" } }] }
      : { kind: "text", content: "ok" };
    await withSidecar(slowCommand, "auto", async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "wait for it" });
      const start = await waitForEvent(events, (e) => e.type === "tool.start");
      await send({ type: "tool.detail", id: "d1", evidence: start.evidence });
      assert.equal(events.find((e) => e.type === "tool.detail" && e.id === "d1").status, "running");
      assert.equal(events.some((e) => e.type === "error" && e.code === "BUSY"), false);
      await server.idle();
      await send({ type: "tool.detail", id: "d2", evidence: start.evidence });
      const done = events.find((e) => e.type === "tool.detail" && e.id === "d2");
      assert.equal(done.status, "succeeded");
      assert.match(done.output, /slept/);
    });
  });

  test("the receipt describes the last turn and says when no validation receipt exists", async () => {
    await withSidecar(readOnlyTurn, "auto", async ({ server, events, send }) => {
      await send({ type: "receipt", id: "r1" });
      assert.equal(events.find((e) => e.type === "receipt" && e.id === "r1").sections[0].note, "No turn has finished in this session yet.");
      await send({ type: "prompt.submit", id: "t1", text: "what is here?" });
      await server.idle();
      await send({ type: "receipt", id: "r2" });
      const sections = events.find((e) => e.type === "receipt" && e.id === "r2").sections;
      assert.deepEqual(sections[0].rows.slice(0, 3), [["result", "TURN ENDED - NO CHANGES TO VERIFY"], ["execution", "COMPLETED"], ["outcome", "NOT_REQUIRED"]]);
      assert.match(sections.find((s: any) => s.title === "Validation receipt").note, /^No validation receipt is active\./);
    });
  });

  test("a receipt is answered while a turn is running", async () => {
    await withSidecar(() => ({ kind: "text", content: "slow", delayMs: 1500 }), "auto", async ({ events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: "go" });
      await send({ type: "receipt", id: "r1" });
      assert.ok(events.some((e) => e.type === "receipt" && e.id === "r1"));
      assert.equal(events.some((e) => e.type === "error" && e.code === "BUSY"), false);
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cli && node --import tsx --test test/protocol.test.ts test/sidecar.test.ts test/slash_router.test.ts > /tmp/c2.txt 2>&1`
Expected: the new tests FAIL (unknown message type `tool.detail`, no `evidence` on tool events, `Unknown command: /receipt`).

- [ ] **Step 3: Protocol**

In `cli/src/protocol.ts`:

1. Add `import type { EvidenceStatus, ReceiptSection } from "./evidence.js";` below the existing imports.
2. Change `ErrorCode` to `"BAD_REQUEST" | "BUSY" | "NO_PENDING_APPROVAL" | "NOT_FOUND" | "INTERNAL"`.
3. Replace the `tool.start` and `tool.end` members of `SidecarEvent` with:

```ts
  | { type: "tool.start"; turn_id: string; call_id: string; tool: string; subject: string; evidence: string }
  | { type: "tool.end"; turn_id: string; call_id: string; tool: string; success: boolean; summary: string; lines: number; evidence: string }
```

4. Add after the `notice` member:

```ts
  | {
      type: "tool.detail";
      id: string;
      evidence: string;
      tool: string;
      subject: string;
      status: EvidenceStatus;
      args: string;
      output: string;
      duration_ms: number | null;
    }
  | { type: "receipt"; id: string; sections: ReceiptSection[] }
```

5. Add to `SidecarCommand` before `shutdown`:

```ts
  | { type: "tool.detail"; id: string; evidence: string }
  | { type: "receipt"; id: string }
```

6. In `parseCommand`, add before `case "shutdown":`:

```ts
    case "tool.detail": {
      const requestId = requireId("tool.detail");
      const evidence = msg.evidence;
      if (typeof evidence !== "string" || !evidence) throw new ProtocolError("tool.detail requires evidence", requestId);
      return { type: "tool.detail", id: requestId, evidence };
    }
    case "receipt":
      return { type: "receipt", id: requireId("receipt") };
```

- [ ] **Step 4: Slash command**

1. In `cli/src/slash/catalog.ts`, add `import type { ReceiptSection } from "../evidence.js";`, add to `SlashHost` after `confirm`:

```ts
  /** Receipt sections for the last turn and the active validation receipt. */
  receipt(): ReceiptSection[];
```

and add to `SLASH_COMMANDS` after the `audit` entry:

```ts
  { name: "receipt", usage: "/receipt", summary: "Turn outcome, verifier evidence and validation receipt" },
```

2. In `cli/src/slash/session_commands.ts`, add `import { receiptText } from "../evidence.js";` and add to `SESSION_HANDLERS`:

```ts
  receipt: ({ host }) => reply("receipt", receiptText(host.receipt())),
```

- [ ] **Step 5: Sidecar**

In `cli/src/sidecar.ts`:

1. Add `import { EvidenceLedger, LastTurn, MAX_EVIDENCE, ReceiptSection, receiptSections } from "./evidence.js";`.
2. Add fields after `private activeSpec?: SlashSpec;`:

```ts
  private readonly evidence = new EvidenceLedger();
  private lastTurn: LastTurn | null = null;
```

3. In `handleLine`, add before `case "shutdown":`:

```ts
      case "tool.detail":
        this.toolDetail(command.id, command.evidence);
        return;
      case "receipt":
        this.emit({ type: "receipt", id: command.id, sections: this.receipt() });
        return;
```

4. Replace `observerFor` with:

```ts
  private observerFor(turnId: string): AgentObserver {
    const open = new Map<string, string>();
    return {
      onAssistantDelta: (delta) => this.emit({ type: "assistant.delta", turn_id: turnId, text: redactSecrets(delta) }),
      onToolStart: ({ callId, tool, args }) => {
        const subject = toolSubject(args);
        const evidence = this.evidence.start(turnId, tool, subject, args);
        open.set(callId, evidence);
        this.emit({ type: "tool.start", turn_id: turnId, call_id: callId, tool, subject, evidence });
      },
      onToolEnd: ({ callId, tool, success, output, error }) => {
        const evidence = open.get(callId) ?? "";
        open.delete(callId);
        this.evidence.end(evidence, success, output, error);
        this.emit({ type: "tool.end", turn_id: turnId, call_id: callId, tool, success, evidence, ...toolSummary(success, output, error) });
      },
    };
  }
```

5. In `turn()`, project the turn once and remember it. Directly after `const { heading, line } = summarizeTurn(turn);` add:

```ts
    const projected = projectTurn(turn);
    this.lastTurn = { heading, turn: projected };
```

and change `turn: projectTurn(turn),` in the emitted event to `turn: projected,`.

6. Add to `slashHost` the member `receipt: () => this.receipt(),`.

7. Add these methods after `slashHost`:

```ts
  private toolDetail(id: string, evidence: string): void {
    const record = this.evidence.get(evidence);
    if (!record) {
      const message = `No record of tool call ${evidence}; only the latest ${MAX_EVIDENCE} are kept.`;
      this.emit({ type: "error", id, code: "NOT_FOUND", message });
      return;
    }
    this.emit({
      type: "tool.detail",
      id,
      evidence,
      tool: record.tool,
      subject: record.subject,
      status: record.status,
      args: record.args,
      output: record.output,
      duration_ms: record.durationMs,
    });
  }

  private receipt(): ReceiptSection[] {
    return receiptSections(this.lastTurn, this.app.getActiveValidationReceipt());
  }
```

- [ ] **Step 6: Run the tests**

Run: `cd cli && node --import tsx --test test/protocol.test.ts test/sidecar.test.ts test/slash_router.test.ts test/evidence.test.ts > /tmp/c2.txt 2>&1`
Expected: PASS. If "a running call's record…" sees `failed` instead of `succeeded`, print `done.output`; when `run_command` is refused by the authority gate, the output says so: report it rather than changing the command.

- [ ] **Step 7: Full CLI suite, build, commit**

Run the full CLI suite (expected 363 tests, only the known failure), then:

```bash
cd cli && npm run build && cd ..
git add cli/src/protocol.ts cli/src/sidecar.ts cli/src/slash cli/test/protocol.test.ts cli/test/sidecar.test.ts cli/test/slash_router.test.ts cli/dist
git commit -m "feat(sidecar): evidence ids on tool events, tool.detail and receipt commands"
```

---

### Task 3: Rust protocol, `/receipt` parsing and evidence on tool entries

**Files:**
- Modify: `core/src/bin/nexus_tui/protocol.rs`
- Modify: `core/src/bin/nexus_tui/slash.rs`
- Modify: `core/src/bin/nexus_tui/live_state.rs`

- [ ] **Step 1: Write the failing tests**

1. In the test module of `protocol.rs` add:

```rust
    #[test]
    fn evidence_details_and_receipts_parse() {
        assert!(matches!(
            parse_event(r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"c1","tool":"read_file","subject":"a.ts","evidence":"e4"}"#),
            Ok(Event::ToolStart { ref evidence, .. }) if evidence == "e4"
        ));
        assert_eq!(
            parse_event(r#"{"v":1,"type":"tool.detail","id":"d1","evidence":"e4","tool":"read_file","subject":"a.ts","status":"running","args":"{}","output":"","duration_ms":null}"#),
            Ok(Event::ToolDetail {
                id: "d1".into(),
                status: "running".into(),
                args: "{}".into(),
                output: String::new(),
                duration_ms: None,
            })
        );
        assert_eq!(
            parse_event(r#"{"v":1,"type":"receipt","id":"r1","sections":[{"title":"Last turn","rows":[["outcome","VERIFIED"]]},{"title":"Validation receipt","rows":[],"note":"None yet."}]}"#),
            Ok(Event::Receipt {
                id: "r1".into(),
                sections: vec![
                    ReceiptSection {
                        title: "Last turn".into(),
                        rows: vec![("outcome".into(), "VERIFIED".into())],
                        note: None,
                    },
                    ReceiptSection {
                        title: "Validation receipt".into(),
                        rows: Vec::new(),
                        note: Some("None yet.".into()),
                    },
                ],
            })
        );
    }
```

2. In `commands_encode_as_single_versioned_lines` add to the array:

```rust
            (
                Command::ToolDetail {
                    id: "d1".into(),
                    evidence: "e4".into(),
                },
                serde_json::json!({"v":1,"type":"tool.detail","id":"d1","evidence":"e4"}),
            ),
            (
                Command::Receipt { id: "r1".into() },
                serde_json::json!({"v":1,"type":"receipt","id":"r1"}),
            ),
```

3. In `parses_every_rendered_event_type`, the expected `Event::ToolStart { … }` gains `evidence: String::new(),`.

4. In `slash.rs` test `parse_separates_local_remote_and_prompt_drafts` add `assert_eq!(parse("/receipt"), Some(Invocation::Receipt));`.

- [ ] **Step 2: Run to verify they fail**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui > /tmp/r3.txt 2>&1`
Expected: compile errors: no `evidence` field, `Event::ToolDetail`, `Event::Receipt`, `ReceiptSection`, `Command::ToolDetail`, `Command::Receipt`, `Invocation::Receipt`.

- [ ] **Step 3: Implement**

1. `protocol.rs`: add after `SlashSpec`:

```rust
/// One block of the turn receipt: labelled rows, or a note saying why there are none.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ReceiptSection {
    pub title: String,
    #[serde(default)]
    pub rows: Vec<(String, String)>,
    #[serde(default)]
    pub note: Option<String>,
}
```

Change `ToolStart` to:

```rust
    #[serde(rename = "tool.start")]
    ToolStart {
        call_id: String,
        tool: String,
        subject: String,
        /// Handle for this call's full record in the sidecar; empty from sidecars that keep none.
        #[serde(default)]
        evidence: String,
    },
```

Add before `Error`:

```rust
    #[serde(rename = "tool.detail")]
    ToolDetail {
        id: String,
        status: String,
        args: String,
        output: String,
        #[serde(default)]
        duration_ms: Option<u64>,
    },
    #[serde(rename = "receipt")]
    Receipt {
        id: String,
        sections: Vec<ReceiptSection>,
    },
```

Add to `Command` before `Shutdown`:

```rust
    #[serde(rename = "tool.detail")]
    ToolDetail { id: String, evidence: String },
    #[serde(rename = "receipt")]
    Receipt { id: String },
```

2. `slash.rs`: add `Receipt,` to `Invocation` after `AlreadyLive`, and `"receipt" => Invocation::Receipt,` to the `match name.as_str()` in `parse` after the `"tui"` arm.

3. `live_state.rs`:
   - Add `evidence: String,` to `Entry::Tool` after `summary`.
   - In `apply`, change the `Event::ToolStart` arm's pattern to `Event::ToolStart { call_id, tool, subject, evidence }` and add `evidence,` to the pushed `Entry::Tool`.
   - Add `Event::ToolDetail { .. } | Event::Receipt { .. } => {}` before `Event::Unknown => {}` (Task 4 implements them).
   - In `invoke`, add `Invocation::Receipt => None,` (Task 4 opens the panel).
   - In the test module, every `Entry::Tool { … }` literal (six of them) gains `evidence: String::new(),`.

- [ ] **Step 4: Run the tests**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui > /tmp/r3.txt 2>&1`
Expected: PASS, 115 tests (114 + 1 new protocol test; the other changes extend existing tests).

- [ ] **Step 5: Commit**

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/protocol.rs core/src/bin/nexus_tui/slash.rs core/src/bin/nexus_tui/live_state.rs
git add core/src/bin/nexus_tui/protocol.rs core/src/bin/nexus_tui/slash.rs core/src/bin/nexus_tui/live_state.rs
git commit -m "feat(tui): evidence, tool.detail and receipt protocol types"
```

---

### Task 4: Tool selection and panels in the live state

**Files:**
- Modify: `core/src/bin/nexus_tui/live_state.rs`
- Modify: `core/src/bin/nexus_tui/live_view.rs` (placeholder arms and one literal only)

- [ ] **Step 1: Write the failing tests**

Add to the test module of `live_state.rs`:

```rust
    fn tool_call(state: &mut LiveState, call: &str, evidence: &str) {
        state.apply(ev(&format!(
            r#"{{"v":1,"type":"tool.start","turn_id":"t1","call_id":"{call}","tool":"read_file","subject":"{call}.ts","evidence":"{evidence}"}}"#
        )));
        state.apply(ev(&format!(
            r#"{{"v":1,"type":"tool.end","turn_id":"t1","call_id":"{call}","tool":"read_file","success":true,"summary":"ok","lines":1,"evidence":"{evidence}"}}"#
        )));
    }

    #[test]
    fn brackets_select_tool_calls_newest_first() {
        let mut state = ready();
        tool_call(&mut state, "a", "e1");
        state.transcript.push(Entry::Info("between".into()));
        tool_call(&mut state, "b", "e2");
        state.on_key(key(KeyCode::Tab));
        assert_eq!(state.selected, None);
        state.on_key(key(KeyCode::Char('[')));
        assert_eq!(state.selected, Some(2));
        assert!(state.follow);
        state.on_key(key(KeyCode::Char('[')));
        assert_eq!(state.selected, Some(0));
        state.on_key(key(KeyCode::Char('[')));
        assert_eq!(state.selected, Some(0), "the oldest call stays selected");
        state.on_key(key(KeyCode::Char(']')));
        assert_eq!(state.selected, Some(2));
        state.on_key(key(KeyCode::Esc));
        assert_eq!((state.selected, state.focus), (None, Focus::Transcript));
        state.on_key(key(KeyCode::Esc));
        assert_eq!(state.focus, Focus::Composer);
        state.on_key(key(KeyCode::Tab));
        state.on_key(key(KeyCode::Char(']')));
        assert_eq!(state.selected, Some(2));
        state.on_key(key(KeyCode::Tab));
        assert_eq!((state.selected, state.focus), (None, Focus::Composer));
    }

    #[test]
    fn enter_on_a_selected_tool_requests_its_detail_and_the_answer_fills_the_panel() {
        let mut state = ready();
        tool_call(&mut state, "a", "e7");
        state.on_key(key(KeyCode::Tab));
        state.on_key(key(KeyCode::Char('[')));
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::ToolDetail {
                id: "d1".into(),
                evidence: "e7".into()
            }))
        );
        assert!(matches!(
            &state.overlay,
            Some(Overlay::Detail(Detail { request, tool, subject, record: Loaded::Waiting, .. }))
                if request == "d1" && tool == "read_file" && subject == "a.ts"
        ));
        state.apply(ev(r#"{"v":1,"type":"tool.detail","id":"d0","evidence":"e7","tool":"read_file","subject":"a.ts","status":"succeeded","args":"{}","output":"stale","duration_ms":1}"#));
        assert!(matches!(
            &state.overlay,
            Some(Overlay::Detail(Detail { record: Loaded::Waiting, .. }))
        ));
        state.apply(ev(r#"{"v":1,"type":"tool.detail","id":"d1","evidence":"e7","tool":"read_file","subject":"a.ts","status":"succeeded","args":"{\n  \"path\": \"a.ts\"\n}","output":"const a = 1;","duration_ms":12}"#));
        assert!(matches!(
            &state.overlay,
            Some(Overlay::Detail(Detail { record: Loaded::Ready(record), .. }))
                if record.output == "const a = 1;" && record.duration_ms == Some(12) && record.status == "succeeded"
        ));
        state.on_key(key(KeyCode::Esc));
        assert_eq!(state.overlay, None);
        assert_eq!(state.focus, Focus::Transcript);
    }

    #[test]
    fn a_tool_without_a_record_says_so_and_failed_requests_stay_in_the_panel() {
        let mut state = ready();
        tool_call(&mut state, "a", "");
        state.on_key(key(KeyCode::Tab));
        state.on_key(key(KeyCode::Char('[')));
        assert_eq!(state.on_key(key(KeyCode::Enter)), None);
        assert_eq!(
            state.transcript.last(),
            Some(&Entry::Info("This tool call has no recorded details.".into()))
        );
        tool_call(&mut state, "b", "e9");
        state.on_key(key(KeyCode::Char(']')));
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        let before = state.transcript.len();
        state.apply(ev(r#"{"v":1,"type":"error","id":"d1","code":"NOT_FOUND","message":"No record of tool call e9."}"#));
        assert!(matches!(
            &state.overlay,
            Some(Overlay::Detail(Detail { record: Loaded::Failed(message), .. }))
                if message == "NOT_FOUND: No record of tool call e9."
        ));
        assert_eq!(state.transcript.len(), before);
    }

    #[test]
    fn v_and_slash_receipt_open_the_receipt_panel() {
        let mut state = ready();
        state.on_key(key(KeyCode::Tab));
        assert_eq!(
            state.on_key(key(KeyCode::Char('v'))),
            Some(Action::Send(Command::Receipt { id: "r1".into() }))
        );
        state.apply(ev(r#"{"v":1,"type":"receipt","id":"r1","sections":[{"title":"Last turn","rows":[["outcome","VERIFIED"]]},{"title":"Validation receipt","rows":[],"note":"No validation receipt is active."}]}"#));
        assert!(matches!(
            &state.overlay,
            Some(Overlay::Receipt(ReceiptPanel { sections: Loaded::Ready(sections), .. }))
                if sections.len() == 2 && sections[0].rows == vec![("outcome".to_string(), "VERIFIED".to_string())]
        ));
        state.on_key(key(KeyCode::Esc));
        state.on_key(key(KeyCode::Esc));
        assert_eq!(state.focus, Focus::Composer);
        type_text(&mut state, "/receipt");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::Receipt { id: "r2".into() }))
        );
        assert!(!state.session.busy);
        assert!(state.transcript.is_empty());
    }

    #[test]
    fn ctrl_c_closes_a_panel_and_approvals_take_its_place() {
        let mut state = ready();
        state.on_key(key(KeyCode::Tab));
        assert!(state.on_key(key(KeyCode::Char('v'))).is_some());
        assert_eq!(state.on_key(ctrl('c')), None);
        assert_eq!(state.overlay, None);
        assert!(state.on_key(key(KeyCode::Char('v'))).is_some());
        state.apply(ev(r#"{"v":1,"type":"approval.request","id":"approval-1","turn_id":"t1","tool":"write_file","subject":"x.txt","preview":"{}"}"#));
        assert!(matches!(state.overlay, Some(Overlay::Approval(_))));
    }

    #[test]
    fn the_frame_moves_the_window_to_the_selection_once() {
        let mut state = ready();
        state.follow = true;
        state.note_layout(LiveLayout {
            transcript_rows: 10,
            scroll_limit: 40,
            followed: Some(12),
            ..LiveLayout::default()
        });
        assert_eq!((state.scroll_back, state.follow), (12, false));
        state.note_layout(LiveLayout {
            transcript_rows: 10,
            scroll_limit: 40,
            ..LiveLayout::default()
        });
        assert_eq!(state.scroll_back, 12);
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui live_state:: > /tmp/r4.txt 2>&1`
Expected: compile errors: no `selected`, `follow`, `Detail`, `Loaded`, `ReceiptPanel`, `LiveLayout.followed`.

- [ ] **Step 3: Implement**

In `core/src/bin/nexus_tui/live_state.rs`:

1. Change the protocol import to also bring `ReceiptSection`.
2. Add after the `Approval` struct:

```rust
/// A panel's content: requested from the sidecar, then filled by its answer.
#[derive(Clone, Debug, PartialEq)]
pub enum Loaded<T> {
    Waiting,
    Ready(T),
    Failed(String),
}

/// A tool call's full record as the sidecar keeps it.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolRecord {
    pub status: String,
    pub args: String,
    pub output: String,
    pub duration_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Detail {
    /// Request id; answers for other ids are ignored.
    pub request: String,
    pub tool: String,
    pub subject: String,
    pub record: Loaded<ToolRecord>,
    pub scroll: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReceiptPanel {
    pub request: String,
    pub sections: Loaded<Vec<ReceiptSection>>,
    pub scroll: usize,
}
```

3. Add `Detail(Detail),` and `Receipt(ReceiptPanel),` to `Overlay`.
4. Add to `LiveLayout`:

```rust
    /// Set when the frame moved the transcript window to show the selected tool call: the `scroll_back` it drew.
    pub followed: Option<usize>,
```

and add `..LiveLayout::default()` to the three `LiveLayout { … }` literals in the 3A tests of this file (they name all four earlier fields).

5. Add fields to `LiveState` after `slash_dismissed` and initialise them in `new()` (`selected: None, follow: false, panel_seq: 0`):

```rust
    /// Transcript index of the selected tool call (transcript focus only).
    pub selected: Option<usize>,
    /// The next frame should move the window to show the selection.
    pub follow: bool,
    panel_seq: u64,
```

6. In `apply`, replace the placeholder `Event::ToolDetail { .. } | Event::Receipt { .. } => {}` arm with:

```rust
            Event::ToolDetail {
                id,
                status,
                args,
                output,
                duration_ms,
            } => {
                if let Some(Overlay::Detail(detail)) = &mut self.overlay
                    && detail.request == id
                {
                    detail.record = Loaded::Ready(ToolRecord {
                        status,
                        args,
                        output,
                        duration_ms,
                    });
                }
            }
            Event::Receipt { id, sections } => {
                if let Some(Overlay::Receipt(panel)) = &mut self.overlay
                    && panel.request == id
                {
                    panel.sections = Loaded::Ready(sections);
                }
            }
```

and add this arm directly before the existing `Event::Error { id, code, message } =>` arm:

```rust
            Event::Error {
                id: Some(id),
                code,
                message,
            } if self.waiting_panel() == Some(id.as_str()) => {
                let message = format!("{code}: {message}");
                match &mut self.overlay {
                    Some(Overlay::Detail(detail)) => detail.record = Loaded::Failed(message),
                    Some(Overlay::Receipt(panel)) => panel.sections = Loaded::Failed(message),
                    _ => {}
                }
            }
```

7. In the `Event::SlashResult` arm, inside `if command == "clear" && success {`, add `self.selected = None;`.
8. In `invoke`, replace `Invocation::Receipt => None,` with `Invocation::Receipt => self.open_receipt(),`.
9. In `on_key`:
   - Change the overlay arm `Some(Overlay::Help { .. }) => {` to `Some(Overlay::Help { .. } | Overlay::Detail(_) | Overlay::Receipt(_)) => {` (panels share the help panel's keys).
   - Replace the `KeyCode::Tab` arm with:

```rust
            KeyCode::Tab => {
                self.focus = match self.focus {
                    Focus::Composer => Focus::Transcript,
                    Focus::Transcript => Focus::Composer,
                };
                self.selected = None;
                None
            }
```

   - Replace the `KeyCode::Esc if self.focus == Focus::Transcript` arm with:

```rust
            KeyCode::Esc if self.focus == Focus::Transcript => {
                if self.selected.take().is_none() {
                    self.focus = Focus::Composer;
                }
                None
            }
```

10. In `on_ctrl_c`, change `Some(Overlay::Help { .. }) => {` to `Some(Overlay::Help { .. } | Overlay::Detail(_) | Overlay::Receipt(_)) => {`.
11. In `on_transcript_key`, add these arms at the top of the `match key.code`:

```rust
            KeyCode::Char('[') => self.select_tool(true),
            KeyCode::Char(']') => self.select_tool(false),
            KeyCode::Char('v') => return self.open_receipt(),
            KeyCode::Enter if self.selected.is_some() => return self.open_detail(),
```

12. In `scroll_overlay` and `note_layout`, extend the `if let Some(Overlay::Approval(Approval { scroll, .. }) | Overlay::Help { scroll })` patterns with `| Overlay::Detail(Detail { scroll, .. }) | Overlay::Receipt(ReceiptPanel { scroll, .. })`. At the top of `note_layout` add:

```rust
        if let Some(back) = layout.followed {
            self.scroll_back = back;
            self.follow = false;
        }
```

13. Add these methods to `impl LiveState`:

```rust
    /// Moves the tool selection one call older or newer; the first press selects the newest call.
    fn select_tool(&mut self, older: bool) {
        let tools: Vec<usize> = self
            .transcript
            .iter()
            .enumerate()
            .filter(|(_, entry)| matches!(entry, Entry::Tool { .. }))
            .map(|(index, _)| index)
            .collect();
        let Some(&newest) = tools.last() else {
            return;
        };
        self.selected = Some(match self.selected.filter(|index| tools.contains(index)) {
            None => newest,
            Some(current) if older => tools
                .iter()
                .rev()
                .copied()
                .find(|&index| index < current)
                .unwrap_or(current),
            Some(current) => tools
                .iter()
                .copied()
                .find(|&index| index > current)
                .unwrap_or(current),
        });
        self.follow = true;
    }

    fn open_detail(&mut self) -> Option<Action> {
        let found = self.selected.and_then(|index| match self.transcript.get(index) {
            Some(Entry::Tool {
                tool,
                subject,
                evidence,
                ..
            }) => Some((tool.clone(), subject.clone(), evidence.clone())),
            _ => None,
        });
        let Some((tool, subject, evidence)) = found else {
            self.selected = None;
            return None;
        };
        if evidence.is_empty() {
            self.transcript
                .push(Entry::Info("This tool call has no recorded details.".into()));
            return None;
        }
        self.panel_seq += 1;
        let request = format!("d{}", self.panel_seq);
        self.overlay = Some(Overlay::Detail(Detail {
            request: request.clone(),
            tool,
            subject,
            record: Loaded::Waiting,
            scroll: 0,
        }));
        Some(Action::Send(Command::ToolDetail {
            id: request,
            evidence,
        }))
    }

    fn open_receipt(&mut self) -> Option<Action> {
        if self.link != Link::Ready {
            return None;
        }
        self.panel_seq += 1;
        let request = format!("r{}", self.panel_seq);
        self.overlay = Some(Overlay::Receipt(ReceiptPanel {
            request: request.clone(),
            sections: Loaded::Waiting,
            scroll: 0,
        }));
        Some(Action::Send(Command::Receipt { id: request }))
    }

    /// Request id of the open detail or receipt panel while it waits for its answer.
    fn waiting_panel(&self) -> Option<&str> {
        match &self.overlay {
            Some(Overlay::Detail(Detail {
                request,
                record: Loaded::Waiting,
                ..
            }))
            | Some(Overlay::Receipt(ReceiptPanel {
                request,
                sections: Loaded::Waiting,
                ..
            })) => Some(request.as_str()),
            _ => None,
        }
    }
```

14. `live_view.rs` must still compile: in the overlay match of `render_live` add `Some(Overlay::Detail(_) | Overlay::Receipt(_)) => {}` (Task 5 renders them).

- [ ] **Step 4: Run the tests**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui > /tmp/r4.txt 2>&1`
Expected: PASS, 121 tests (115 + 6). The 3A transcript-focus tests (Enter or a typed character returns to the composer) still pass: those arms come after the new ones and apply when nothing is selected.

- [ ] **Step 5: Commit**

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/live_state.rs core/src/bin/nexus_tui/live_view.rs
git add core/src/bin/nexus_tui/live_state.rs core/src/bin/nexus_tui/live_view.rs
git commit -m "feat(tui): tool selection, detail and receipt panels in live state"
```

---

### Task 5: Selection highlight, follow, and the two panels

**Files:**
- Modify: `core/src/bin/nexus_tui/live_view.rs`

- [ ] **Step 1: Write the failing tests**

In the test module of `live_view.rs` add (the tests reach the panels through keys, so no new imports are needed):

```rust
    fn with_tool(evidence: &str) -> LiveState {
        let mut state = ready();
        feed(
            &mut state,
            &[
                &format!(r#"{{"v":1,"type":"tool.start","turn_id":"t1","call_id":"a","tool":"read_file","subject":"a.ts","evidence":"{evidence}"}}"#),
                r#"{"v":1,"type":"tool.end","turn_id":"t1","call_id":"a","tool":"read_file","success":true,"summary":"ok","lines":1}"#,
            ],
        );
        state
    }

    fn press(state: &mut LiveState, code: KeyCode) {
        state.on_key(KeyEvent::new(code, KeyModifiers::NONE));
    }

    /// Background and foreground of the cell where `text` starts.
    fn cell_at(state: &LiveState, width: u16, height: u16, text: &str) -> (Color, Color) {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| {
                render_live(frame, state);
            })
            .unwrap();
        let lines = rows(&terminal.backend().to_string());
        let row = lines.iter().position(|line| line.contains(text)).unwrap();
        let column = lines[row].find(text).unwrap();
        let x = u16::try_from(lines[row][..column].chars().count()).unwrap();
        let cell = &terminal.backend().buffer()[(x, u16::try_from(row).unwrap())];
        (cell.bg, cell.fg)
    }

    #[test]
    fn the_selected_tool_is_highlighted_while_the_transcript_has_focus() {
        let mut state = with_tool("e1");
        press(&mut state, KeyCode::Tab);
        press(&mut state, KeyCode::Char('['));
        assert_eq!(cell_at(&state, 80, 20, "a.ts").0, SELECTED);
        press(&mut state, KeyCode::Tab);
        assert_ne!(cell_at(&state, 80, 20, "a.ts").0, SELECTED);
    }

    #[test]
    fn selecting_a_tool_above_the_window_scrolls_it_into_view_once() {
        let mut state = with_tool("e1");
        let long: Vec<String> = (1..=60).map(|n| format!("line {n}")).collect();
        state.transcript.push(Entry::Assistant {
            turn_id: "t1".into(),
            text: long.join("\n"),
        });
        press(&mut state, KeyCode::Tab);
        press(&mut state, KeyCode::Char('['));
        let (screen, layout) = draw_measured(&state, 80, 20);
        assert_shows(&screen, &["a.ts"]);
        let back = layout.followed.expect("the frame followed the selection");
        assert!(back > 0);
        state.note_layout(layout);
        assert_eq!((state.scroll_back, state.follow), (back, false));
        let (_, again) = draw_measured(&state, 80, 20);
        assert_eq!(again.followed, None);
    }

    #[test]
    fn the_detail_panel_shows_status_arguments_and_output() {
        let mut state = with_tool("e1");
        press(&mut state, KeyCode::Tab);
        press(&mut state, KeyCode::Char('['));
        press(&mut state, KeyCode::Enter);
        assert_shows(
            &draw(&state, 80, 24),
            &["Tool call", "Loading the recorded call…", "esc close · ↑↓ scroll"],
        );
        feed(
            &mut state,
            &[r#"{"v":1,"type":"tool.detail","id":"d1","evidence":"e1","tool":"read_file","subject":"a.ts","status":"succeeded","args":"{\n  \"path\": \"a.ts\"\n}","output":"const a = 1;\nconst b = 2;","duration_ms":1500}"#],
        );
        assert_shows(
            &draw(&state, 80, 24),
            &[
                "Read a.ts",
                "succeeded · 1.5 s",
                "Arguments",
                "\"path\": \"a.ts\"",
                "Output",
                "const b = 2;",
            ],
        );
    }

    #[test]
    fn the_receipt_panel_lists_sections_rows_and_notes() {
        let mut state = ready();
        press(&mut state, KeyCode::Tab);
        assert_shows(
            &draw(&state, 100, 24),
            &["[ ] tools · enter details · v receipt · tab back"],
        );
        press(&mut state, KeyCode::Char('v'));
        feed(
            &mut state,
            &[r#"{"v":1,"type":"receipt","id":"r1","sections":[{"title":"Last turn","rows":[["execution","COMPLETED"],["outcome","VERIFIED"]]},{"title":"Validation receipt","rows":[],"note":"No validation receipt is active."}]}"#],
        );
        assert_shows(
            &draw(&state, 100, 24),
            &[
                "Receipt",
                "Last turn",
                "outcome",
                "Validation receipt",
                "No validation receipt is active.",
            ],
        );
        assert_eq!(cell_at(&state, 100, 24, "VERIFIED").1, Color::Green);
    }
```

Also update the 3A test that asserts `"transcript · ↑↓ scroll · tab back"`: change that expected string to `"transcript · ↑↓ scroll · [ ] tools · enter details · v receipt · tab back"`.

- [ ] **Step 2: Run to verify they fail**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui live_view:: > /tmp/r5.txt 2>&1`
Expected: compile error (no `SELECTED`), then, once it exists, the new tests fail (no highlight, no follow, empty panels, old hint).

- [ ] **Step 3: Implement**

In `core/src/bin/nexus_tui/live_view.rs`:

1. Extend the live_state import with `Detail, Loaded, ReceiptPanel, ToolRecord` and the protocol import to `use crate::protocol::{ReceiptSection, SlashSpec};`.
2. Add below the imports:

```rust
/// Background of the selected tool call in the transcript.
const SELECTED: Color = Color::Rgb(38, 52, 66);
```

3. In `render_live`, replace the transcript arm `_ => { layout.scroll_limit = render_transcript(…); }` with:

```rust
        _ => {
            let selected = state.selected.filter(|_| state.focus == Focus::Transcript);
            let (limit, back) = render_transcript(
                frame,
                rows[1],
                &state.transcript,
                state.scroll_back,
                selected,
                state.follow,
            );
            layout.scroll_limit = limit;
            layout.followed = state.follow.then_some(back);
        }
```

and replace the placeholder `Some(Overlay::Detail(_) | Overlay::Receipt(_)) => {}` overlay arm with:

```rust
        Some(Overlay::Detail(detail)) => {
            (layout.overlay_rows, layout.overlay_limit) = render_detail(frame, rows[1], detail);
        }
        Some(Overlay::Receipt(panel)) => {
            (layout.overlay_rows, layout.overlay_limit) = render_receipt(frame, rows[1], panel);
        }
```

4. Replace `render_transcript` with:

```rust
/// Renders the transcript window `scroll_back` rows above the newest line, with `selected` highlighted. With
/// `follow`, the window first moves the least distance that shows the whole selected entry (its top when it is
/// taller than the window). Only the entries needed to fill the window are laid out. Returns the largest useful
/// `scroll_back` (`usize::MAX` when the walk stopped before the first entry) and the `scroll_back` drawn.
fn render_transcript(
    frame: &mut Frame,
    area: Rect,
    transcript: &[Entry],
    scroll_back: usize,
    selected: Option<usize>,
    follow: bool,
) -> (usize, usize) {
    let height = usize::from(area.height);
    let mut back = scroll_back;
    let mut target = selected.filter(|_| follow);
    let mut tail = Vec::new();
    let mut total = 0;
    let mut reached_top = true;
    for (index, entry) in transcript.iter().enumerate().rev() {
        let below = total;
        let highlight = selected == Some(index);
        for line in entry_lines(entry, index == 0).into_iter().rev() {
            let line = if highlight {
                line.patch_style(Style::default().bg(SELECTED))
            } else {
                line
            };
            let rows = wrapped_rows(&line, area.width);
            total += rows;
            tail.push((line, rows));
        }
        if target == Some(index) {
            back = back.min(below).max(total.saturating_sub(height));
            target = None;
        }
        if target.is_none() && total >= height.saturating_add(back) {
            reached_top = false;
            break;
        }
    }
    let limit = if reached_top {
        total.saturating_sub(height)
    } else {
        usize::MAX
    };
    let back = back.min(limit);
    let first_row = total.saturating_sub(height + back);
    tail.reverse();
    let mut skipped = 0;
    let mut covered = 0;
    let mut lines = Vec::new();
    for (line, rows) in tail {
        if skipped + rows <= first_row {
            skipped += rows;
            continue;
        }
        if covered >= height + (first_row - skipped) {
            break;
        }
        covered += rows;
        lines.push(line);
    }
    let offset = u16::try_from(first_row - skipped).unwrap_or(u16::MAX);
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((offset, 0)),
        area,
    );
    if back > 0 {
        render_scroll_badge(frame, area, back);
    }
    (limit, back)
}
```

5. Add the panels:

```rust
fn panel_keys() -> Line<'static> {
    let key = Style::default().fg(ACCENT).add_modifier(Modifier::BOLD);
    Line::from(vec![
        Span::styled(" esc", key),
        Span::raw(" close  "),
        Span::styled("↑↓", key),
        Span::raw(" scroll "),
    ])
}

/// Renders wrapped `lines` from wrapped row `scroll`; returns the visible rows and the largest useful scroll.
fn scroll_body(frame: &mut Frame, area: Rect, lines: Vec<Line<'_>>, scroll: usize) -> (usize, usize) {
    let rows = usize::from(area.height);
    let total: usize = lines.iter().map(|line| wrapped_rows(line, area.width)).sum();
    let limit = total.saturating_sub(rows);
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((u16::try_from(scroll.min(limit)).unwrap_or(u16::MAX), 0)),
        area,
    );
    (rows, limit)
}

fn duration(ms: u64) -> String {
    if ms < 1000 {
        format!("{ms} ms")
    } else {
        format!("{:.1} s", ms as f64 / 1000.0)
    }
}

/// Draws a tool call's full record; returns the rows available to it and the largest useful scroll.
fn render_detail(frame: &mut Frame, area: Rect, detail: &Detail) -> (usize, usize) {
    let muted = Style::default().fg(MUTED);
    let rect = modal(area, area.width, area.height);
    let block = modal_block(" Tool call ").title_bottom(panel_keys());
    let inner = block.inner(rect);
    frame.render_widget(Clear, rect);
    frame.render_widget(block, rect);
    let [head, body] =
        Layout::vertical([Constraint::Length(2), Constraint::Min(1)]).areas(inner);
    let mut title = vec![
        Span::styled(
            tool_verb(&detail.tool),
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(format!(" {}", detail.subject), muted),
    ];
    let lines = match &detail.record {
        Loaded::Waiting => vec![Line::from(Span::styled("Loading the recorded call…", muted))],
        Loaded::Failed(message) => vec![Line::from(Span::styled(
            message.as_str(),
            Style::default().fg(Color::Red),
        ))],
        Loaded::Ready(record) => {
            let (label, color) = match record.status.as_str() {
                "succeeded" => ("succeeded", Color::Green),
                "failed" => ("failed", Color::Red),
                _ => ("running", ACCENT),
            };
            title.push(Span::styled(format!("  {label}"), Style::default().fg(color)));
            if let Some(ms) = record.duration_ms {
                title.push(Span::styled(format!(" · {}", duration(ms)), muted));
            }
            record_lines(record)
        }
    };
    frame.render_widget(Paragraph::new(Line::from(title)), head);
    scroll_body(frame, body, lines, detail.scroll)
}

fn record_lines(record: &ToolRecord) -> Vec<Line<'_>> {
    let heading = Style::default()
        .fg(Color::White)
        .add_modifier(Modifier::BOLD);
    let white = Style::default().fg(Color::White);
    let mut lines = vec![Line::from(Span::styled("Arguments", heading))];
    lines.extend(
        record
            .args
            .split('\n')
            .map(|row| Line::from(Span::styled(expand_tabs(row), white))),
    );
    lines.push(Line::default());
    lines.push(Line::from(Span::styled("Output", heading)));
    if record.output.is_empty() {
        let empty = if record.status == "running" {
            "(still running)"
        } else {
            "(no output)"
        };
        lines.push(Line::from(Span::styled(empty, Style::default().fg(MUTED))));
    } else {
        lines.extend(
            record
                .output
                .split('\n')
                .map(|row| Line::from(Span::styled(expand_tabs(row), white))),
        );
    }
    lines
}

/// Draws the receipt panel; returns its visible rows and the largest useful scroll.
fn render_receipt(frame: &mut Frame, area: Rect, panel: &ReceiptPanel) -> (usize, usize) {
    let muted = Style::default().fg(MUTED);
    let lines = match &panel.sections {
        Loaded::Waiting => vec![Line::from(Span::styled("Loading the receipt…", muted))],
        Loaded::Failed(message) => vec![Line::from(Span::styled(
            message.as_str(),
            Style::default().fg(Color::Red),
        ))],
        Loaded::Ready(sections) => receipt_lines(sections),
    };
    let wanted = u16::try_from(lines.len() + 2).unwrap_or(u16::MAX);
    let rect = modal(area, 96, wanted);
    let block = modal_block(" Receipt ").title_bottom(panel_keys());
    let inner = block.inner(rect);
    frame.render_widget(Clear, rect);
    frame.render_widget(block, rect);
    scroll_body(frame, inner, lines, panel.scroll)
}

fn receipt_lines(sections: &[ReceiptSection]) -> Vec<Line<'_>> {
    let heading = Style::default()
        .fg(Color::White)
        .add_modifier(Modifier::BOLD);
    let muted = Style::default().fg(MUTED);
    let mut lines = Vec::new();
    for (index, section) in sections.iter().enumerate() {
        if index > 0 {
            lines.push(Line::default());
        }
        lines.push(Line::from(Span::styled(section.title.as_str(), heading)));
        for (label, value) in &section.rows {
            lines.push(Line::from(vec![
                Span::styled(format!("  {label:<15}"), muted),
                Span::styled(value.as_str(), Style::default().fg(verdict_color(value))),
            ]));
        }
        if let Some(note) = &section.note {
            lines.push(Line::from(Span::styled(format!("  {note}"), muted)));
        }
    }
    lines
}

/// Colours outcome words in the receipt; every other value stays white.
fn verdict_color(value: &str) -> Color {
    match value {
        "PASSED" | "VERIFIED" | "COMPLETED" | "success" => Color::Green,
        "FAILED" | "INVALIDATED" | "NOT_ESTABLISHED" | "INTERRUPTED" | "BLOCKED" | "LIMIT_REACHED"
        | "failure" => Color::Red,
        "UNVERIFIED" => Color::Yellow,
        _ => Color::White,
    }
}
```

6. In `composer_hint`, replace the arms

```rust
        _ if state.overlay.is_some() => " esc close help ",
        _ if state.focus == Focus::Transcript => " transcript · ↑↓ scroll · tab back ",
```

with

```rust
        _ if matches!(state.overlay, Some(Overlay::Help { .. })) => " esc close help ",
        _ if state.overlay.is_some() => " esc close · ↑↓ scroll ",
        _ if state.focus == Focus::Transcript => {
            " transcript · ↑↓ scroll · [ ] tools · enter details · v receipt · tab back "
        }
```

(The 3B completion arm stays between the overlay arms and the transcript arm.)

7. Add three rows to `HELP` after `("pgup / pgdn", "scroll the transcript"),`:

```rust
    ("[ / ]", "in the transcript: select the previous / next tool call"),
    ("enter", "in the transcript: open the selected tool call's details"),
    ("v", "in the transcript: open the receipt for the last turn"),
```

- [ ] **Step 4: Run the tests**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui > /tmp/r5.txt 2>&1`
Expected: PASS, 125 tests (121 + 4). The 3A scrolling tests (`scroll_limit` of 67, `usize::MAX` while scrolled) must still pass unchanged: without a selection, `render_transcript` walks and draws as before.

- [ ] **Step 5: Commit**

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/live_view.rs
git add core/src/bin/nexus_tui/live_view.rs
git commit -m "feat(tui): tool selection highlight, tool detail and receipt panels"
```

---

### Task 6: Tool detail round trip through a sidecar process

**Files:**
- Modify: `core/src/bin/nexus_tui/live.rs` (tests only)

- [ ] **Step 1: Write the test**

Change the test module's `use crate::live_state::Entry;` to `use crate::live_state::{Detail, Entry, Loaded, Overlay};` and add:

```rust
    #[test]
    fn a_tool_detail_round_trips_through_the_sidecar() {
        let script = format!(
            r#"{HELLO}
echo '{{"v":1,"type":"tool.start","turn_id":"t1","call_id":"a","tool":"read_file","subject":"a.ts","evidence":"e1"}}'
echo '{{"v":1,"type":"tool.end","turn_id":"t1","call_id":"a","tool":"read_file","success":true,"summary":"ok","lines":1,"evidence":"e1"}}'
read cmd
case "$cmd" in *'"type":"tool.detail"'*) ;; *) exit 9;; esac
case "$cmd" in *'"evidence":"e1"'*) ;; *) exit 9;; esac
case "$cmd" in *'"id":"d1"'*) ;; *) exit 9;; esac
echo '{{"v":1,"type":"tool.detail","id":"d1","evidence":"e1","tool":"read_file","subject":"a.ts","status":"succeeded","args":"{{}}","output":"const a = 1;","duration_ms":3}}'
read shutdown
case "$shutdown" in *'"type":"shutdown"'*) exit 0;; *) exit 8;; esac"#
        );
        let mut app = LiveApp::start(fake_sidecar(&script));
        pump_until(&mut app, |s| {
            s.transcript
                .iter()
                .any(|e| matches!(e, Entry::Tool { evidence, .. } if evidence == "e1"))
        });
        for code in [KeyCode::Tab, KeyCode::Char('[')] {
            assert_eq!(app.state.on_key(KeyEvent::new(code, KeyModifiers::NONE)), None);
        }
        let send = app
            .state
            .on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .expect("enter requests the detail");
        assert!(app.handle(send));
        pump_until(&mut app, |s| {
            matches!(&s.overlay, Some(Overlay::Detail(Detail { record: Loaded::Ready(record), .. }))
                if record.output == "const a = 1;")
        });
        assert_eq!(app.state.link, Link::Ready);
        assert_eq!(
            app.state
                .on_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            None
        );
        let quit = app
            .state
            .on_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
        assert_eq!(quit, Some(Action::Quit));
        assert!(!app.handle(quit.unwrap()));
    }
```

(`"args":"{{}}"` is `{}` after `format!`. Replies avoid backslashes because `sh` is `dash`, whose `echo` expands them.)

- [ ] **Step 2: Run it**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui live:: > /tmp/r6.txt 2>&1`
Expected: PASS. A crash with exit 9 means the `tool.detail` command line was wrong; print what the fake received.

- [ ] **Step 3: Full Rust suite and commit**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui > /tmp/r6.txt 2>&1` — expected 126 tests and no warnings from `nexus_tui` files.

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/live.rs
git add core/src/bin/nexus_tui/live.rs
git commit -m "test(tui): tool detail round trip through a sidecar process"
```

---

### Task 7: Full verification and PTY smoke

**Files:**
- No source changes expected. Clippy fix-ups only, committed as `fix(tui): clippy findings in phase 3c`.

- [ ] **Step 1: Build, lint, test**

```bash
make build > /tmp/v-build.txt 2>&1
command cargo clippy --manifest-path core/Cargo.toml --bin nexus-tui --all-targets > /tmp/v-clippy.txt 2>&1
command cargo test --manifest-path core/Cargo.toml > /tmp/v-test.txt 2>&1
cd cli && node --import tsx --test test/*.test.ts > /tmp/v-cli.txt 2>&1
```

Expected: build succeeds; no clippy findings in `core/src/bin/nexus_tui.rs` or `core/src/bin/nexus_tui/`; 126 tests in `nexus-tui` and every other cargo test pass; CLI suite 363 tests with only the known `SCAN-001 & SCAN-004` failure.

- [ ] **Step 2: PTY smoke**

Use the PTY driver from plans 3A/3B (`/tmp/nexus_live_pty.py`), a temporary git repo under `/tmp`, and the real gateway at `127.0.0.1:18010`. Never read `cli/.env`.

1. `harness` (no arguments) in the repo. Prompt: "Read base.txt, then stop." Wait for the banner.
2. Tab, then `[`: the read call is highlighted; the hint shows `[ ] tools · enter details · v receipt`.
3. Enter: the "Tool call" panel shows `Read base.txt`, `succeeded · … ms`, the arguments (`"path": "base.txt"`) and the file's content under Output. ↓ and PgDn scroll; Esc closes; focus stays in the transcript.
4. `v`: the receipt shows "Last turn" with `execution COMPLETED` and `outcome NOT_REQUIRED`, "Verifier" with "No verifier ran for this turn." (or the verifier rows, if one ran), and "Validation receipt" with its note. Esc, Esc returns to the composer.
5. `/receipt` + Enter opens the same panel.
6. Long-transcript follow: ask "List every file under core/src, then stop." in the Nexus checkout copy, scroll to the bottom, press Tab and `[` several times; the window follows the selected call upward, and PgDn afterwards scrolls freely.

Afterwards `pgrep -af 'sidecar.js|nexus-core rpc|nexus-tui'` shows nothing you started.

- [ ] **Step 3: Knowledge graph**

```bash
graphify update .
git status --short
```

Expected: clean apart from `graphify-out/` (not committed by this plan) or the clippy fix-up commit.

---

## Self-review notes

- Spec coverage: with plans 3A and 3B, every phase-3 overlay is in: approval (3A), help (3A, command list in 3B), tool/evidence detail and validation receipt (this plan). Slash commands and the default entry are 3B.
- The client decides nothing: status words, receipt rows and notes come from the sidecar; the view only colours known outcome words.
- Evidence safety: arguments and output pass `stripEscapes`, `redactSecrets` and a 64,000-character cap before they leave the sidecar; the ledger is bounded; receipt free text is redacted.
- Test counts: CLI 350 → 356 (Task 1) → 363 (Task 2); Rust 114 → 115 (Task 3) → 121 (Task 4) → 125 (Task 5) → 126 (Task 6).
- Known limits: `v` in transcript focus no longer starts a draft with "v" (type in the composer, or press Tab first); records of calls older than the latest 200 answer `NOT_FOUND`; the selection is a transcript index, so `/clear` drops it.
