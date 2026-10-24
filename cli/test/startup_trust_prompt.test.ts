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
    assert.match(rendered, /Trust remembered for this folder/);
    assert.match(rendered, /Includes future project config changes/);
    assert.match(rendered, /Tool approvals follow your settings/);
    assert.match(rendered, /Mode default if unset:/);
    assert.match(rendered, /trusted=auto, untrusted=review/);
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
    assert.match(rendered, /�abc/);
    assert.equal(rendered.includes("\u200b"), false);
    assert.equal(rendered.includes("\u2060"), false);
    assert.match(rendered, /�def/);
    assert.match(rendered, /�ghi/);
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
