import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AutonomousAgent } from "../src/agent.js";

test("Nexus host identity remains explicit with a Claude model and activated client-specific skill", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-runtime-identity-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-runtime-identity-workspace-"));
  const oldHome = process.env.HOME;
  const oldXdg = process.env.XDG_CONFIG_HOME;
  let agent: AutonomousAgent | undefined;

  try {
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    const skillDir = path.join(home, ".nexus", "skills", "claude-client-setup");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: claude-client-setup\ndescription: Instructions with host-specific client branches\n---\nIf you are in Claude Code, install the Claude plugin. If you are another agent, use the generic setup.\n",
    );

    agent = new AutonomousAgent({
      endpoint: "http://127.0.0.1:11434/v1",
      model: "anthropic/claude-sonnet-4",
      workspace,
      maxSteps: 1,
      temperature: 0,
    });
    agent.resetConversation();

    const systemPrompt = agent.getMessages()[0].content;
    assert.equal(typeof systemPrompt, "string");
    const hostIdentityAt = systemPrompt.indexOf("### Runtime Identity");
    const availableSkillsAt = systemPrompt.indexOf("### Specialized Agent Skills Available:");
    assert.ok(availableSkillsAt >= 0, "the test skill should be visible to Nexus");
    assert.ok(hostIdentityAt > availableSkillsAt, "host identity must follow dynamic skill context");
    assert.match(systemPrompt, /You are Nexus Code, the agent host\./);
    assert.match(systemPrompt, /provider and model are components Nexus connects to; they do not define or replace the host application/);
    assert.match(systemPrompt, /Do not identify this runtime as Claude Code/);

    const skillHandler = (agent as unknown as { spine: { getHandler(name: string): (args: { name: string }) => Promise<{ success: boolean; output: string }> } })
      .spine.getHandler("activate_skill");
    assert.equal(typeof skillHandler, "function");
    const activated = await skillHandler({ name: "claude-client-setup" });
    assert.equal(activated.success, true);
    assert.match(activated.output, /Host application: Nexus Code\. Provider\/model identity does not change the host/);
    assert.match(activated.output, /If you are in Claude Code, install the Claude plugin/);
    assert.ok(
      activated.output.indexOf("Host application: Nexus Code") < activated.output.indexOf("If you are in Claude Code"),
      "Nexus should identify its host before passing client-specific skill instructions to the model",
    );
  } finally {
    agent?.shutdown();
    process.env.HOME = oldHome;
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
