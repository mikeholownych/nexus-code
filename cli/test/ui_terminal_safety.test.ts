import { test } from "node:test";
import assert from "node:assert/strict";
import { TerminalUI } from "../src/ui.js";

function capture(run: (ui: TerminalUI) => void): string {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    run(new TerminalUI());
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

test("TerminalUI never emits terminal control sequences from untrusted display text", () => {
  const payload = "safe\x1b]52;c;cGF5bG9hZA==\x07\x1b[2Jafter\x9b31m";
  const rendered = capture((ui) => {
    ui.printToolCall("read_file", { path: payload });
    ui.printToolResult("read_file", true, `${payload}\nsecond line`);
    ui.printToolResult("run_command", false, `error ${payload}`);
    ui.renderPlan([{ name: `plan ${payload}`, status: "in_progress", detail: `detail ${payload}` }]);
    ui.renderDiff(`- old ${payload}\n+ new ${payload}`);
    ui.renderCode(`const value = "${payload}";`, "ts");
    const previousDebug = process.env.NEXUS_DEBUG;
    process.env.NEXUS_DEBUG = "1";
    try { ui.printThought(`thought ${payload}`); } finally {
      if (previousDebug === undefined) delete process.env.NEXUS_DEBUG;
      else process.env.NEXUS_DEBUG = previousDebug;
    }
    ui.turnSummary({
      execution: "FAILED",
      outcome: "NOT_ESTABLISHED",
      reason: "UNHANDLED_ERROR",
      detail: payload,
      inferenceFailure: { kind: "transport", origin: payload, httpStatus: 500, message: payload },
      steps: { used: 0, max: 1, limitReached: false },
    } as any);
  });

  for (const sequence of ["\x1b]52", "\x07", "\x1b[2J", "\x9b31m"]) {
    assert.equal(rendered.includes(sequence), false, `raw terminal sequence escaped: ${JSON.stringify(sequence)}`);
  }
  assert.ok(rendered.includes("\u241b"), "ESC should be shown as a visible stand-in");
});
