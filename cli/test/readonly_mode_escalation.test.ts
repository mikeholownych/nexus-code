import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApplicationCore } from "../src/core/app.js";
import { SidecarServer } from "../src/sidecar.js";

test("an explicit read-only launch stays read-only after /mode auto and cannot run mutating slash commands", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-readonly-mode-repo-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-readonly-mode-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const events: any[] = [];
  const app = new ApplicationCore({
    endpoint: "http://127.0.0.1:9/v1",
    model: "m",
    maxSteps: 1,
    temperature: 0,
    workspace: repo,
    shell: "bash",
    readOnly: true,
    approvalMode: "read-only",
    fullAccess: false,
  } as any);
  const server = new SidecarServer({ app, mode: "read-only", write: (line) => events.push(JSON.parse(line)) });
  try {
    server.start();
    assert.equal(app.getAgent().getApprovalMode(), "read-only");

    await server.handleLine(JSON.stringify({ v: 1, type: "slash", id: "mode-1", command: "mode", args: "auto" }));
    await server.idle();
    assert.equal(
      app.getAgent().getApprovalMode(),
      "read-only",
      "a read-only launch must not be lowered by /mode auto",
    );
    assert.match(
      events.find((event) => event.type === "slash.result" && event.id === "mode-1")?.output ?? "",
      /read-only/i,
    );

    await server.handleLine(JSON.stringify({ v: 1, type: "slash", id: "skill-1", command: "skill", args: "init leaked" }));
    await server.idle();
    const result = events.find((event) => event.type === "slash.result" && event.id === "skill-1");
    assert.equal(result?.success, false, "a mutating slash command must stay disabled in read-only mode");
    assert.match(result?.output ?? "", /disabled while the session is in read-only mode/i);
    assert.equal(
      fs.existsSync(path.join(repo, ".nexus", "skills", "leaked", "SKILL.md")),
      false,
      "read-only mode wrote a scaffolded skill",
    );

    await server.handleLine(JSON.stringify({ v: 1, type: "slash", id: "mode-2", command: "mode", args: "review" }));
    await server.idle();
    assert.equal(app.getAgent().getApprovalMode(), "read-only", "a read-only launch must not be lowered by /mode review");
    assert.match(
      events.find((event) => event.type === "slash.result" && event.id === "mode-2")?.output ?? "",
      /read-only/i,
    );

    await server.handleLine(JSON.stringify({ v: 1, type: "models.list", id: "models-1" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const catalogError = events.find((event) => event.type === "error" && event.id === "models-1");
    assert.equal(catalogError?.code, "BUSY", "provider discovery must stay disabled in read-only mode");

    await server.handleLine(JSON.stringify({ v: 1, type: "provider.connect", id: "provider-1", provider: "openai", method: "api-key", key: "synthetic-test-key" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const providerResult = events.find((event) => event.type === "provider.result" && event.id === "provider-1");
    assert.equal(providerResult?.success, false, "provider connections must stay disabled in read-only mode");

    assert.equal(
      events.filter((event) => event.type === "session.state").at(-1)?.mode,
      "read-only",
      "the reported session mode stayed read-only",
    );
  } finally {
    await server.handleLine(JSON.stringify({ v: 1, type: "cancel" })).catch(() => {});
    await server.idle().catch(() => {});
    app.shutdown();
    process.env.HOME = previousHome;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
