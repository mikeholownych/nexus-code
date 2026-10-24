/**
 * SPEC-01 §3 rule 8 & ACC-SAFE-09: Verifier executions that Nexus initiates itself
 * (change baseline, completion oracle, independence copy, /test) are exec-class actions.
 * - In review mode, the first verifier run requires a one-time approval with command and script body.
 * - Explicit auto mode runs without asking regardless of workspace trust.
 * - Approvals are cached per (workspace, command, digest) for the session.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { isWorkspaceTrusted, setWorkspaceTrusted } from "../src/workspace_trust.js";
import { describeVerifier } from "../src/tester.js";
import { startGateway } from "./helpers/provider_fixture.js";

function setupRepo(name: string): { ws: string; sentinelPath: string } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `nexus-vg-${name}-`));
  const sentinelPath = path.join(ws, "sentinel.txt");
  const testScript = `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(sentinelPath)}, 'ok');`;
  fs.writeFileSync(path.join(ws, "test.js"), testScript);
  fs.writeFileSync(
    path.join(ws, "package.json"),
    JSON.stringify(
      {
        name: "vg-fixture",
        scripts: {
          test: "node test.js",
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(ws, "file.txt"), "hello\n");
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm init", {
    cwd: ws,
    stdio: "ignore",
  });
  return { ws, sentinelPath };
}

describe("ACC-SAFE-09: Verifier Gating", () => {
  test("describeVerifier extracts command, script body from package.json, and sha256 digest", () => {
    const { ws } = setupRepo("describe");
    try {
      const desc = describeVerifier(ws);
      assert.ok(desc, "verifier should be discovered");
      assert.equal(desc.command, "npm test");
      assert.equal(desc.script, "node test.js");
      assert.equal(desc.evidence, "package.json:scripts.test");
      assert.ok(/^[0-9a-f]{64}$/.test(desc.digest), `digest should be sha256 hex: ${desc.digest}`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  for (const trusted of [false, true]) {
    test(`${trusted ? "trusted" : "untrusted"} repo in review mode prompts for verifier and script body, writes sentinel only after approval, and caches session decision`, async () => {
    const savedHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vg-home-"));
    process.env.HOME = tempHome;

    const { ws, sentinelPath } = setupRepo(`review-${trusted ? "trusted" : "untrusted"}`);
    if (trusted) setWorkspaceTrusted(ws, true);
    const replies = [
      {
        kind: "tools" as const,
        calls: [{ name: "edit_file", args: { path: "file.txt", old_content: "hello\n", new_content: "world\n" } }],
      },
      {
        kind: "tools" as const,
        calls: [{ name: "task_completed", args: { summary: "Finished editing file" } }],
      },
      { kind: "text" as const, content: "Done." },
    ];
    const gw = await startGateway((n) => replies[Math.min(n, replies.length) - 1]);
    const agent = new AutonomousAgent({
      endpoint: gw.url,
      model: "m",
      workspace: ws,
      shell: "bash",
      approvalMode: "review",
    } as any);

    const promptLog: Array<{ tool: string; args: any }> = [];
    try {
      assert.equal(isWorkspaceTrusted(ws), trusted, `repo trust should be ${trusted}`);

      await agent.runTurn("make changes and finish", async (tool, args) => {
        promptLog.push({ tool, args });
        if (tool === "edit_file") {
          // Sentinel must NOT be written before verifier is approved!
          assert.equal(fs.existsSync(sentinelPath), false, "sentinel must not exist when edit_file is prompted");
          return true;
        }
        if (tool === "verifier") {
          // Sentinel must NOT be written before operator confirms verifier!
          assert.equal(fs.existsSync(sentinelPath), false, "sentinel must not exist before verifier is confirmed");
          assert.equal(args.command, "npm test");
          assert.equal(args.script, "node test.js");
          assert.equal(args.detail, "package.json:scripts.test");
          assert.ok(args.digest, "digest must be provided");
          return true;
        }
        return true;
      });

      // Sentinel was written by the approved verifier execution!
      assert.equal(fs.existsSync(sentinelPath), true, "sentinel must be written after verifier was approved and executed");

      // Verifier should be prompted exactly once because session caching applies
      const verifierPrompts = promptLog.filter((p) => p.tool === "verifier");
      assert.equal(verifierPrompts.length, 1, "verifier should only be prompted once during the session");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(tempHome, { recursive: true, force: true });
      process.env.HOME = savedHome;
    }
    });
  }

  test("denied verifier does not execute verifier and sentinel is not written", async () => {
    const savedHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vg-home-"));
    process.env.HOME = tempHome;

    const { ws, sentinelPath } = setupRepo("denied");
    const replies = [
      {
        kind: "tools" as const,
        calls: [{ name: "edit_file", args: { path: "file.txt", old_content: "hello\n", new_content: "world\n" } }],
      },
      { kind: "text" as const, content: "Done." },
    ];
    const gw = await startGateway((n) => replies[Math.min(n, replies.length) - 1]);
    const agent = new AutonomousAgent({
      endpoint: gw.url,
      model: "m",
      workspace: ws,
      shell: "bash",
      approvalMode: "review",
    } as any);

    try {
      await agent.runTurn("make change", async (tool) => {
        if (tool === "edit_file") return true;
        if (tool === "verifier") return false; // Reject verifier execution
        return false;
      });

      assert.equal(fs.existsSync(sentinelPath), false, "sentinel must NOT be written when verifier was denied");
      assert.equal(fs.readFileSync(path.join(ws, "file.txt"), "utf-8"), "world\n", "file edit still succeeded");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(tempHome, { recursive: true, force: true });
      process.env.HOME = savedHome;
    }
  });

  for (const trusted of [false, true]) {
    test(`${trusted ? "trusted" : "untrusted"} repo in explicitly configured auto mode runs verifier without prompts`, async () => {
    const savedHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vg-home-"));
    process.env.HOME = tempHome;

    const { ws, sentinelPath } = setupRepo(`auto-${trusted ? "trusted" : "untrusted"}`);
    if (trusted) setWorkspaceTrusted(ws, true);

    const replies = [
      {
        kind: "tools" as const,
        calls: [{ name: "edit_file", args: { path: "file.txt", old_content: "hello\n", new_content: "world\n" } }],
      },
      { kind: "text" as const, content: "Done." },
    ];
    const gw = await startGateway((n) => replies[Math.min(n, replies.length) - 1]);
    const agent = new AutonomousAgent({
      endpoint: gw.url,
      model: "m",
      workspace: ws,
      shell: "bash",
      approvalMode: "auto",
    } as any);

    const promptLog: string[] = [];
    try {
      assert.equal(isWorkspaceTrusted(ws), trusted, `repo trust should be ${trusted}`);

      await agent.runTurn("make change", async (tool) => {
        promptLog.push(tool);
        return true;
      });

      assert.equal(promptLog.length, 0, "explicit auto mode should not depend on workspace trust");
      assert.equal(fs.existsSync(sentinelPath), true, "sentinel should be created automatically");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(tempHome, { recursive: true, force: true });
      process.env.HOME = savedHome;
    }
    });
  }

  test("headless execution refuses verifier output without a matching pre-change baseline", async () => {
    const savedHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vg-home-"));
    process.env.HOME = tempHome;

    const { ws } = setupRepo("headless");
    fs.writeFileSync(path.join(ws, "file.txt"), "modified\n");

    const replies = [
      {
        kind: "tools" as const,
        calls: [{ name: "task_completed", args: { summary: "Attempting completion without prior approval" } }],
      },
      { kind: "text" as const, content: "Done." },
    ];
    const gw = await startGateway((n) => replies[Math.min(n, replies.length) - 1]);
    const agent = new AutonomousAgent({
      endpoint: gw.url,
      model: "m",
      workspace: ws,
      shell: "bash",
      approvalMode: "review",
    } as any);

    try {
      // Simulate unverified modification
      (agent as any).hasPendingModifications = true;
      // Headless execution: no onConfirm handler passed
      await agent.runTurn("finish task");

      const lastReq = gw.requests.at(-1);
      const toolRes = lastReq?.body?.messages?.find((m: any) => m.role === "tool");
      assert.ok(toolRes, "tool response should exist");
      assert.match(
        String(toolRes.content),
        /no matching pre-change baseline\. Its current output cannot establish verification/,
        "headless execution must reject a verifier result without a trusted pre-change baseline",
      );
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(tempHome, { recursive: true, force: true });
      process.env.HOME = savedHome;
    }
  });

  test("headless execution on untrusted workspace denies verifier execution without an operator", async () => {
    const savedHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vg-home-"));
    process.env.HOME = tempHome;

    const { ws, sentinelPath } = setupRepo("headless-approval");
    const replies = [
      {
        kind: "tools" as const,
        calls: [{ name: "task_completed", args: { summary: "Attempting completion without approval" } }],
      },
      { kind: "text" as const, content: "Done." },
    ];
    const gw = await startGateway((n) => replies[Math.min(n, replies.length) - 1]);
    const agent = new AutonomousAgent({
      endpoint: gw.url,
      model: "m",
      workspace: ws,
      shell: "bash",
      approvalMode: "review",
      authoritativeVerifierCommand: "npm test",
    } as any);

    try {
      // Capture a pre-change binding so the request reaches the independent approval gate.
      await (agent as any).captureChangeBaseline();
      fs.writeFileSync(path.join(ws, "file.txt"), "modified\n");
      (agent as any).hasPendingModifications = true;

      // Headless execution has no onConfirm handler and must not execute the verifier.
      await agent.runTurn("finish task");

      const lastReq = gw.requests.at(-1);
      const toolRes = lastReq?.body?.messages?.find((m: any) => m.role === "tool");
      assert.ok(toolRes, "tool response should exist");
      assert.match(
        String(toolRes.content),
        /requires operator approval \(exec\), but no operator is present/,
        "headless execution without an operator must deny verifier execution",
      );
      assert.equal(fs.existsSync(sentinelPath), false, "the verifier must not execute without operator approval");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(tempHome, { recursive: true, force: true });
      process.env.HOME = savedHome;
    }
  });
});
