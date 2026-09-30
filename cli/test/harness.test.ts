import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import { HARNESS_TOOLS } from "../src/tools.js";
import { parseModelResponse } from "../src/parser.js";
import { redactSecrets } from "../src/ui.js";
import { CheckpointManager } from "../src/checkpoint.js";
import { SkillManager } from "../src/skills.js";

describe("Nexus Code Test Suite", () => {
  test("HARNESS_TOOLS definitions include all parity tools", () => {
    const toolNames = HARNESS_TOOLS.map((t) => t.function.name);
    assert.ok(toolNames.includes("read_file"), "Missing read_file");
    assert.ok(toolNames.includes("write_file"), "Missing write_file");
    assert.ok(toolNames.includes("edit_file"), "Missing edit_file");
    assert.ok(toolNames.includes("patch_file"), "Missing patch_file");
    assert.ok(toolNames.includes("batch_read"), "Missing batch_read");
    assert.ok(toolNames.includes("file_tree"), "Missing file_tree");
    assert.ok(toolNames.includes("file_info"), "Missing file_info");
    assert.ok(toolNames.includes("run_command"), "Missing run_command");
    assert.ok(toolNames.includes("update_plan"), "Missing update_plan");
    assert.ok(toolNames.includes("activate_skill"), "Missing activate_skill");
    assert.ok(toolNames.includes("task_completed"), "Missing task_completed");
  });

  test("redactSecrets properly cleans sensitive tokens and credentials", () => {
    const raw = "Connecting with Bearer bAGOhOwLeY7Mabcdef123456789 and sk-proj-1234567890abcdef12345 and password='supersecretpass123'";
    const scrubbed = redactSecrets(raw);
    assert.ok(!scrubbed.includes("bAGOhOwLeY7M"), "Bearer token not scrubbed");
    assert.ok(!scrubbed.includes("sk-proj-"), "API key not scrubbed");
    assert.ok(!scrubbed.includes("supersecretpass123"), "Password not scrubbed");
    assert.ok(scrubbed.includes("[REDACTED"), "Missing redaction tag");
  });

  test("parseModelResponse handles thinking and tool calls", () => {
    const mockMessage = {
      role: "assistant" as const,
      content: "<thought>Let's inspect the directory structure first.</thought>\n```json\n{\"tool\": \"file_tree\", \"arguments\": {\"max_depth\": 2}}\n```",
    };
    const parsed = parseModelResponse(mockMessage);
    assert.ok(parsed.thoughtText.includes("Let's inspect the directory structure"), "Failed to extract thought");
    assert.strictEqual(parsed.toolCalls.length, 1, "Failed to parse json tool call");
    assert.strictEqual(parsed.toolCalls[0].function.name, "file_tree");
  });

  test("CheckpointManager creates and records snapshots", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus_cp_test_"));
    try {
      const cm = new CheckpointManager(tmpDir);
      const cp = cm.createCheckpoint("Test Snapshot");
      assert.ok(cp.id.startsWith("cp_"));
      assert.strictEqual(cp.name, "Test Snapshot");

      const list = cm.listCheckpoints();
      assert.ok(list.length >= 1);
      assert.strictEqual(list[0].id, cp.id);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("SkillManager discovers and formats prompt section", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus_skill_test_"));
    const skillDir = path.join(tmpDir, "skills", "sample-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: sample-skill\ndescription: A test skill for unit testing\n---\nSkill content here.`
    );

    try {
      const sm = new SkillManager(tmpDir);
      const skills = sm.listSkills();
      assert.ok(skills.some((s) => s.name === "sample-skill"));

      const prompt = sm.getPromptSection();
      assert.ok(prompt.includes("sample-skill"));
      assert.ok(prompt.includes("A test skill for unit testing"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
