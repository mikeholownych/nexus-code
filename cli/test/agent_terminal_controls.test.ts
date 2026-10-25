import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeRepo, startGateway } from "./helpers/fixtures.js";

const hostileControls = "safe\x1b]52;c;cGF5bG9hZA==\x07\x1b[2Jafter\x9b31m";
const hostilePrompt = `${hostileControls} ghp_${"Q".repeat(36)}`;

async function runAgentInChild(endpoint: string, workspace: string, method: "run" | "runTurn", prompt: string): Promise<{ stdout: string; stderr: string }> {
  const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = `
    import { AutonomousAgent } from "./src/agent.js";
    const probe = JSON.parse(process.env.NEXUS_TERMINAL_PROBE_ARGS);
    const agent = new AutonomousAgent({ endpoint: probe.endpoint, model: "m", maxSteps: 2, temperature: 0, workspace: probe.workspace, shell: "bash", approvalMode: "auto", fullAccess: true });
    let observed = "";
    agent.setObserver({ onAssistantDelta: (delta) => { observed += delta; } });
    try { await agent[probe.method](probe.prompt); }
    finally { agent.shutdown(); }
    process.stderr.write("NEXUS_OBSERVER_MATCH=" + (observed === probe.expected ? "yes" : "no") + "\\n");
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-"], {
    cwd: cliRoot,
    env: {
      ...process.env,
      NEXUS_TERMINAL_PROBE_ARGS: JSON.stringify({ endpoint, workspace, method, prompt, expected: hostileControls }),
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(source);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, stderr);
  return { stdout, stderr };
}

test("streamed assistant text is safe to display while observers retain the original response", async () => {
  const gateway = await startGateway(() => ({
    kind: "text",
    content: hostileControls,
    chunks: ["safe\x1b", "]52;c;cGF5bG9hZA==\x07\x1b[", "2Jafter\x9b", "31m"],
  }));
  const repo = makeRepo();
  try {
    const { stdout: output, stderr } = await runAgentInChild(gateway.url, repo, "runTurn", "review this");
    const assistantStart = output.indexOf("💭 Assistant: ");
    assert.notEqual(assistantStart, -1, "the assistant stream should be displayed");
    const assistantEnd = output.indexOf("\n\n", assistantStart);
    const assistantOutput = output.slice(assistantStart, assistantEnd === -1 ? undefined : assistantEnd);
    for (const sequence of ["\x1b]52", "\x07", "\x1b[2J", "\x9b31m"]) {
      assert.equal(assistantOutput.includes(sequence), false, `assistant text included raw terminal control ${JSON.stringify(sequence)}`);
    }
    assert.ok(assistantOutput.includes("safe"), "ordinary text before a control sequence must remain visible");
    assert.ok(assistantOutput.includes("after"), "ordinary text after a control sequence must remain visible");
    assert.ok(assistantOutput.includes("␛"), "ESC should be rendered visibly");
    assert.ok(stderr.includes("NEXUS_OBSERVER_MATCH=yes"), "terminal formatting must not modify the response delivered to observers");
  } finally {
    await gateway.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("the echoed task prompt is sanitized at the terminal display boundary", async () => {
  const gateway = await startGateway(() => ({ kind: "text", content: "done" }));
  const repo = makeRepo();
  try {
    const { stdout: output } = await runAgentInChild(gateway.url, repo, "run", hostilePrompt);
    for (const sequence of ["\x1b]52", "\x07", "\x1b[2J", "\x9b31m"]) {
      assert.equal(output.includes(sequence), false, `prompt echo included raw terminal control ${JSON.stringify(sequence)}`);
    }
    assert.ok(output.includes("␛"), "ESC should be rendered visibly");
    assert.ok(output.includes("safe"), "ordinary prompt text before a control sequence must remain visible");
    assert.ok(output.includes("after"), "ordinary prompt text after a control sequence must remain visible");
    assert.ok(output.includes("[REDACTED"), "secret-like prompt text should be redacted before echo");
  } finally {
    await gateway.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
