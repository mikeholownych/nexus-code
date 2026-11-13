import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promptWorkspaceTrust, trustedProjectRules, TrustPromptInput } from "../src/startup_trust.js";
import { AutonomousAgent } from "../src/agent.js";

function mockTerminal(isTTY = true, columns = 80) {
  const input = new PassThrough() as unknown as TrustPromptInput & { isRaw: boolean };
  input.isTTY = isTTY;
  input.isRaw = false;
  input.setRawMode = ((value: boolean) => { input.isRaw = value; return input; }) as TrustPromptInput["setRawMode"];

  const output = new PassThrough() as PassThrough & { isTTY: boolean };
  output.isTTY = isTTY;
  output.columns = columns;
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString(); });
  return { input, output, get text() { return text; } };
}

function workspaceWithInstructions(): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-trust-prompt-"));
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "project instruction\n");
  return workspace;
}

function displayWidth(value: string): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let width = 0;
  for (const { segment } of segmenter.segment(value)) {
    const widths = [...segment].map((character) => {
      const point = character.codePointAt(0)!;
      if (character === "\u200d" || /[\p{Mark}\p{Format}]/u.test(character)) return 0;
      return point >= 0x1100 && (
        point <= 0x115f || point === 0x2329 || point === 0x232a ||
        (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f) ||
        (point >= 0xac00 && point <= 0xd7a3) || (point >= 0xf900 && point <= 0xfaff) ||
        (point >= 0xfe10 && point <= 0xfe19) || (point >= 0xfe30 && point <= 0xfe6f) ||
        (point >= 0xff00 && point <= 0xff60) || (point >= 0xffe0 && point <= 0xffe6) ||
        (point >= 0x1f000 && point <= 0x1faff) || (point >= 0x20000 && point <= 0x3fffd)
      ) ? 2 : 1;
    });
    width += Math.max(0, ...widths);
  }
  return width;
}

test("trust prompt offers explicit trust, continue-untrusted, and exit choices", async () => {
  const workspace = workspaceWithInstructions();
  const terminal = mockTerminal(true, 40);
  let trusted = false;
  try {
    const decision = promptWorkspaceTrust(workspace, {
      ...terminal,
      trustStore: {
        isTrusted: () => trusted,
        trust: () => { trusted = true; },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const rendered = terminal.text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
    assert.match(rendered, /Trust this folder\?/);
    assert.match(rendered, /AGENTS\.md/);
    assert.match(rendered, /Trust and continue/);
    assert.match(rendered, /Continue without trusting/);
    assert.match(rendered, /Exit/);
    const flat = rendered.split("\n").map((row) => row.trim()).join(" ").replace(/\s+/g, " ");
    assert.match(flat, /Trusting is remembered for this folder; the other choices ask again next time\./);
    assert.match(flat, /including any that change later\./);
    assert.match(flat, /Trust does not change tool approvals; those follow your permission settings\./);
    assert.ok(rendered.split("\n").every((line) => displayWidth(line) <= 40), rendered);

    terminal.input.emit("keypress", undefined, { name: "down" });
    terminal.input.emit("keypress", "\r", { name: "return" });
    assert.equal(await decision, "untrusted");
    assert.equal(trusted, false);
    assert.equal(terminal.input.isRaw, false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("trust prompt neutralizes bidi controls and fits wide Unicode paths by terminal cells", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-trust-bidi-"));
  const workspace = path.join(parent, `項目-${"界".repeat(30)}-\u202eabc-\u200bdef-\u2060ghi`);
  fs.mkdirSync(workspace);
  const terminal = mockTerminal(true, 40);
  try {
    const decision = promptWorkspaceTrust(workspace, {
      ...terminal,
      trustStore: { isTrusted: () => false, trust: () => {} },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const rendered = terminal.text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
    assert.equal(rendered.includes("\u202e"), false);
    // The path wraps across rows, so its pieces are read with the row breaks removed.
    const unwrapped = rendered.replace(/\n/g, "");
    assert.match(unwrapped, /�abc/);
    assert.equal(rendered.includes("\u200b"), false);
    assert.equal(rendered.includes("\u2060"), false);
    assert.match(unwrapped, /�def/);
    assert.match(unwrapped, /�ghi/);
    assert.ok(rendered.split("\n").every((line) => displayWidth(line) <= 40), rendered);
    terminal.input.emit("keypress", "\u001b", { name: "escape" });
    assert.equal(await decision, "exit");
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("trust choice persists workspace trust and returns trusted", async () => {
  const workspace = workspaceWithInstructions();
  const terminal = mockTerminal();
  let trusted = false;
  try {
    const decision = promptWorkspaceTrust(workspace, {
      ...terminal,
      trustStore: {
        isTrusted: () => trusted,
        trust: () => { trusted = true; },
      },
    });
    terminal.input.emit("keypress", "\r", { name: "return" });
    assert.equal(await decision, "trusted");
    assert.equal(trusted, true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("a trust-store write failure leaves the operator free to continue without trust", async () => {
  const workspace = workspaceWithInstructions();
  const terminal = mockTerminal();
  try {
    const decision = promptWorkspaceTrust(workspace, {
      ...terminal,
      trustStore: {
        isTrusted: () => false,
        trust: () => { throw new Error("store unavailable"); },
      },
    });
    terminal.input.emit("keypress", "\r", { name: "return" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(terminal.text, /Trust was not saved: store unavailable/);
    terminal.input.emit("keypress", "\u001b[B", { name: "down" });
    terminal.input.emit("keypress", "\r", { name: "return" });
    assert.equal(await decision, "untrusted");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("escape exits without recording trust", async () => {
  const workspace = workspaceWithInstructions();
  const terminal = mockTerminal();
  let trusted = false;
  try {
    const decision = promptWorkspaceTrust(workspace, {
      ...terminal,
      trustStore: {
        isTrusted: () => false,
        trust: () => { trusted = true; },
      },
    });
    terminal.input.emit("keypress", "\u001b", { name: "escape" });
    assert.equal(await decision, "exit");
    assert.equal(trusted, false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("a terminal that cannot enter prompt mode exits instead of silently choosing", async () => {
  const workspace = workspaceWithInstructions();
  const terminal = mockTerminal();
  terminal.input.setRawMode = (() => { throw new Error("raw mode unavailable"); }) as TrustPromptInput["setRawMode"];
  try {
    assert.equal(await promptWorkspaceTrust(workspace, {
      ...terminal,
      trustStore: { isTrusted: () => false, trust: () => assert.fail("No trust choice was made") },
    }), "exit");
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(terminal.text, /could not open the trust prompt/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the Exit menu item exits without persisting trust", async () => {
  const workspace = workspaceWithInstructions();
  const terminal = mockTerminal();
  try {
    const decision = promptWorkspaceTrust(workspace, {
      ...terminal,
      trustStore: { isTrusted: () => false, trust: () => assert.fail("Exit must not record trust") },
    });
    terminal.input.emit("keypress", "\u001b[B", { name: "down" });
    terminal.input.emit("keypress", "\u001b[B", { name: "down" });
    terminal.input.emit("keypress", "\r", { name: "return" });
    assert.equal(await decision, "exit");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("workspace paths cannot inject terminal control sequences into the trust screen", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-trust-\u001b[31m"));
  const terminal = mockTerminal();
  try {
    const decision = promptWorkspaceTrust(workspace, {
      ...terminal,
      trustStore: { isTrusted: () => false, trust: () => {} },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(terminal.text.includes("\u001b[31m"), false);
    terminal.input.emit("keypress", "\u001b", { name: "escape" });
    assert.equal(await decision, "exit");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("non-interactive startup continues without trust or project instructions", async () => {
  const workspace = workspaceWithInstructions();
  const terminal = mockTerminal(false);
  let trusted = false;
  try {
    assert.equal(await promptWorkspaceTrust(workspace, {
      ...terminal,
      trustStore: {
        isTrusted: () => false,
        trust: () => { trusted = true; },
      },
    }), "untrusted");
    assert.equal(trusted, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(terminal.text, /Project instructions and workspace integrations stay unloaded/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("project instructions load only for trusted workspaces", () => {
  const workspace = workspaceWithInstructions();
  try {
    assert.equal(trustedProjectRules(workspace, () => false), null);
    assert.match(trustedProjectRules(workspace, () => true) ?? "", /project instruction/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("AutonomousAgent omits project rules until workspace trust is explicit", () => {
  const workspace = workspaceWithInstructions();
  const savedTrust = process.env.NEXUS_TRUST_WORKSPACE;
  let untrustedAgent: AutonomousAgent | undefined;
  let trustedAgent: AutonomousAgent | undefined;
  try {
    delete process.env.NEXUS_TRUST_WORKSPACE;
    untrustedAgent = new AutonomousAgent({
      endpoint: "http://127.0.0.1:9/v1",
      model: "test-model",
      maxSteps: 1,
      temperature: 0,
      workspace,
      shell: "bash",
      approvalMode: "review",
    } as any, 0, { durable: false });
    const untrustedPrompt = String(untrustedAgent.getMessages()[0].content);
    assert.equal(untrustedPrompt.includes("project instruction"), false);

    process.env.NEXUS_TRUST_WORKSPACE = "1";
    trustedAgent = new AutonomousAgent({
      endpoint: "http://127.0.0.1:9/v1",
      model: "test-model",
      maxSteps: 1,
      temperature: 0,
      workspace,
      shell: "bash",
      approvalMode: "review",
    } as any, 0, { durable: false });
    assert.equal(String(trustedAgent.getMessages()[0].content).includes("project instruction"), true);
  } finally {
    untrustedAgent?.shutdown();
    trustedAgent?.shutdown();
    if (savedTrust === undefined) delete process.env.NEXUS_TRUST_WORKSPACE;
    else process.env.NEXUS_TRUST_WORKSPACE = savedTrust;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

/** The prompt as drawn at `columns`, escape sequences removed, rows split. */
async function trustScreen(workspace: string, columns: number): Promise<string[]> {
  const terminal = mockTerminal(true, columns);
  const decision = promptWorkspaceTrust(workspace, { ...terminal, trustStore: { isTrusted: () => false, trust: () => {} } });
  await new Promise((resolve) => setImmediate(resolve));
  const rows = terminal.text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
  terminal.input.emit("keypress", "\u001b", { name: "escape" });
  await decision;
  return rows;
}

const TRUST_SENTENCES = [
  "Trusting this folder lets Nexus load its project instructions and workspace integrations, including any that change later.",
  "Trusting is remembered for this folder; the other choices ask again next time.",
  "Trust does not change tool approvals; those follow your permission settings.",
];

test("D-21: the trust copy wraps at the terminal width at 100, 60 and 40 columns, every sentence whole, no word split", async () => {
  const workspace = workspaceWithInstructions();
  try {
    for (const columns of [100, 60, 40]) {
      const rows = await trustScreen(workspace, columns);
      const screen = rows.join("\n");
      assert.ok(rows.every((row) => displayWidth(row) <= columns), `${columns}: a row is wider than the terminal\n${screen}`);
      const flat = rows.map((row) => row.trim()).join(" ").replace(/\s+/g, " ");
      for (const sentence of TRUST_SENTENCES) assert.ok(flat.includes(sentence), `${columns}: "${sentence}" is not intact\n${screen}`);
      // Wrapped on word boundaries: no copy row ends or starts mid-word, so a sentence is the same words in the same order.
      for (const row of rows) assert.doesNotMatch(row, /\s$/, `${columns}: trailing space\n${screen}`);
      assert.equal(rows.find((row) => row), "Trust this folder?");
      assert.ok(rows.some((row) => /^› Trust and continue$/.test(row)), screen);
      assert.ok(rows.some((row) => row === "  Continue without trusting"), screen);
      assert.ok(rows.some((row) => row === "  Exit"), screen);
      assert.ok(rows.some((row) => /Enter/.test(row) && /Esc/.test(row)), `${columns}: the key hint is shown\n${screen}`);
      assert.ok(rows.some((row) => /AGENTS\.md/.test(row)), screen);
    }
    // Wide terminal: the copy uses the width (the old copy broke a sentence at about 40 columns on any terminal).
    const wide = await trustScreen(workspace, 100);
    assert.ok(wide.some((row) => row.startsWith("Trusting this folder lets Nexus load its project instructions and workspace")), wide.join("\n"));
    assert.ok(!wide.some((row) => row.trim() === "workspace integrations."), "no orphaned fragment line");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("D-21: a terminal that reports no width (0 or missing columns, e.g. a pty without a window size) draws at 80, not one character per row", async () => {
  const workspace = workspaceWithInstructions();
  try {
    const at80 = await trustScreen(workspace, 80);
    for (const unknown of [0, undefined, Number.NaN, -3]) {
      const terminal = mockTerminal(true, 80);
      (terminal.output as { columns?: number }).columns = unknown;
      const decision = promptWorkspaceTrust(workspace, { ...terminal, trustStore: { isTrusted: () => false, trust: () => {} } });
      await new Promise((resolve) => setImmediate(resolve));
      const rows = terminal.text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
      terminal.input.emit("keypress", "\u001b", { name: "escape" });
      await decision;
      assert.deepEqual(rows, at80, `columns=${String(unknown)} must draw exactly as 80 columns`);
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("D-21: a long path is wrapped whole across rows, never cut, and tiny terminals never overflow or hang", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-trust-long-"));
  const workspace = path.join(parent, "a-very-long-project-directory-name-that-exceeds-a-narrow-terminal");
  fs.mkdirSync(workspace);
  try {
    for (const columns of [40, 24, 10, 3, 1]) {
      const rows = await trustScreen(workspace, columns);
      const widest = Math.max(...rows.map(displayWidth));
      // Below the width of one wide glyph or the choice marker nothing can fit; above it, no row overflows.
      if (columns >= 4) assert.ok(widest <= columns, `${columns}: widest row ${widest}\n${rows.join("\n")}`);
      if (columns >= 24) {
        const joined = rows.join("");
        assert.ok(joined.includes(workspace), `${columns}: the whole path is shown\n${rows.join("\n")}`);
      }
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("D-21: the prompt is drawn again at the new width when the terminal is resized, and stops listening when it is answered", async () => {
  const workspace = workspaceWithInstructions();
  const terminal = mockTerminal(true, 100);
  try {
    const decision = promptWorkspaceTrust(workspace, { ...terminal, trustStore: { isTrusted: () => false, trust: () => {} } });
    await new Promise((resolve) => setImmediate(resolve));
    const mark = terminal.text.length;
    terminal.output.columns = 40;
    terminal.output.emit("resize");
    const redrawn = terminal.text.slice(mark).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
    assert.ok(redrawn.length > 5 && redrawn.every((row) => displayWidth(row) <= 40), redrawn.join("\n"));
    terminal.input.emit("keypress", "\u001b", { name: "escape" });
    assert.equal(await decision, "exit");
    assert.equal(terminal.output.listenerCount("resize"), 0, "no listener is left behind");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
