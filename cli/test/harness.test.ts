import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import * as http from "node:http";
import { HARNESS_TOOLS, isSafeOutboundUrl } from "../src/tools.js";
import { parseModelResponse } from "../src/parser.js";
import { redactSecrets } from "../src/ui.js";
import { CheckpointManager } from "../src/checkpoint.js";
import { SkillManager } from "../src/skills.js";
import { extractCompilerDiagnostics, formatDiagnosticHints } from "../src/diagnostics.js";
import { generateConventionalCommit } from "../src/git.js";
import { AutonomousAgent } from "../src/agent.js";
import { SecurityManager } from "../src/security.js";
import { countTokens, calculateContextBudget, renderTokenGauge } from "../src/tokens.js";
import { selectRelevantFewShots } from "../src/fewshots.js";
import { LocalLlmClient } from "../src/client.js";

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

  test("RustCoreBridge executes tool via persistent RPC daemon", async () => {
    const { RustCoreBridge } = await import("../src/tools.js");
    const bridge = new RustCoreBridge(process.cwd());
    try {
      const res = await bridge.executeTool("file_info", { path: "package.json" });
      assert.strictEqual(res.success, true);
      const parsed = JSON.parse(res.output);
      assert.strictEqual(parsed.exists, true);
      assert.strictEqual(parsed.path, "package.json");
    } finally {
      bridge.shutdown();
    }
  });

  test("RustCoreBridge handles concurrent parallel tool calls", async () => {
    const { RustCoreBridge } = await import("../src/tools.js");
    const bridge = new RustCoreBridge(process.cwd());
    try {
      const results = await Promise.all([
        bridge.executeTool("file_info", { path: "package.json" }),
        bridge.executeTool("file_info", { path: "tsconfig.json" }),
        bridge.executeTool("file_tree", { max_depth: 1 }),
      ]);
      assert.strictEqual(results.length, 3);
      assert.ok(results.every((r) => r.success));
    } finally {
      bridge.shutdown();
    }
  });

  test("CheckpointManager handles pruning and diff inspection", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus_cp_diff_test_"));
    try {
      const cm = new CheckpointManager(tmpDir);
      const cp1 = cm.createCheckpoint("Snapshot 1");
      const cp2 = cm.createCheckpoint("Snapshot 2");

      const list = cm.listCheckpoints();
      assert.ok(list.length >= 2);

      const diffRes = cm.getDiff(cp1.id);
      assert.strictEqual(diffRes.success, true);

      const pruneRes = cm.pruneCheckpoints(1);
      assert.strictEqual(pruneRes.prunedCount >= 1, true);
      assert.strictEqual(cm.listCheckpoints().length, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("McpServer responds to initialize, tools/list, and tools/call", async () => {
    const { McpServer } = await import("../src/mcp.js");
    const server = new McpServer(process.cwd());
    try {
      // 1. Handshake
      const initRes = await server.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      assert.strictEqual(initRes.id, 1);
      assert.strictEqual(initRes.result.serverInfo.name, "nexus-code");

      // 2. Query tools
      const listRes = await server.handleMessage({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      });
      assert.strictEqual(listRes.id, 2);
      assert.ok(Array.isArray(listRes.result.tools));
      assert.ok(listRes.result.tools.some((t: any) => t.name === "file_info"));

      // 3. Execute tool call via server
      const callRes = await server.handleMessage({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "file_info",
          arguments: { path: "package.json" },
        },
      });
      assert.strictEqual(callRes.id, 3);
      assert.strictEqual(callRes.result.isError, false);
      assert.ok(callRes.result.content[0].text.includes("package.json"));
    } finally {
      server.shutdown();
    }
  });

  test("extractCompilerDiagnostics parses rust and typescript errors into actionable hints", () => {
    const rawRustError = `
error[E0308]: mismatched types
  --> src/main.rs:42:15
   |
42 |     let x: u32 = "hello";
   |            ---   ^^^^^^^ expected \`u32\`, found \`&str\`
`;
    const rustDiags = extractCompilerDiagnostics(rawRustError);
    assert.strictEqual(rustDiags.length, 1);
    assert.strictEqual(rustDiags[0].file, "src/main.rs");
    assert.strictEqual(rustDiags[0].line, 42);
    assert.strictEqual(rustDiags[0].code, "E0308");

    const rawTsError = `src/index.ts:18:5 - error TS2322: Type 'number' is not assignable to type 'string'.`;
    const tsDiags = extractCompilerDiagnostics(rawTsError);
    assert.strictEqual(tsDiags.length, 1);
    assert.strictEqual(tsDiags[0].file, "src/index.ts");
    assert.strictEqual(tsDiags[0].line, 18);
    assert.strictEqual(tsDiags[0].code, "TS2322");

    const hints = formatDiagnosticHints([...rustDiags, ...tsDiags]);
    assert.ok(hints.includes("[Automated Diagnostic Hints & Error Locations]:"));
    assert.ok(hints.includes("src/main.rs:42:15"));
    assert.ok(hints.includes("src/index.ts:18:5"));
  });

  test("generateConventionalCommit creates valid conventional commit messages", () => {
    const commit = generateConventionalCommit(process.cwd());
    assert.ok(commit.message.length > 0);
    assert.ok(/^(feat|fix|docs|test|chore)\([^)]+\):/.test(commit.message));
  });

  test("isSafeOutboundUrl blocks SSRF threats and permits valid public URLs", () => {
    assert.strictEqual(isSafeOutboundUrl("http://localhost:8080").safe, false);
    assert.strictEqual(isSafeOutboundUrl("http://127.0.0.1:3000").safe, false);
    assert.strictEqual(isSafeOutboundUrl("http://169.254.169.254/latest/meta-data").safe, false);
    assert.strictEqual(isSafeOutboundUrl("http://10.0.1.5:8080/secret").safe, false);
    assert.strictEqual(isSafeOutboundUrl("http://192.168.1.1/admin").safe, false);
    assert.strictEqual(isSafeOutboundUrl("ftp://example.com/file.txt").safe, false);

    assert.strictEqual(isSafeOutboundUrl("https://raw.githubusercontent.com/org/repo/main/README.md").safe, true);
    assert.strictEqual(isSafeOutboundUrl("https://api.example.com/v1/data").safe, true);
  });

  test("AutonomousAgent completes multi-turn loop using mock OpenAI-compatible LLM server", async () => {
    let callCount = 0;
    const mockServer = http.createServer((req, res) => {
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          callCount++;
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          });

          if (callCount === 1) {
            // First turn: model decides to inspect package.json
            const chunk1 = {
              choices: [{
                delta: {
                  content: "I will check the metadata of package.json first.",
                  tool_calls: [{
                    index: 0,
                    id: "call_mock_1",
                    type: "function",
                    function: {
                      name: "file_info",
                      arguments: JSON.stringify({ path: "package.json" }),
                    },
                  }],
                },
              }],
            };
            res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          } else {
            // Second turn: model concludes the task
            const chunk2 = {
              choices: [{
                delta: {
                  content: "The package file is verified.",
                  tool_calls: [{
                    index: 0,
                    id: "call_mock_2",
                    type: "function",
                    function: {
                      name: "task_completed",
                      arguments: JSON.stringify({ summary: "Metadata inspected successfully." }),
                    },
                  }],
                },
              }],
            };
            res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", () => resolve()));
    const port = (mockServer.address() as any).port;

    const agent = new AutonomousAgent({
      endpoint: `http://127.0.0.1:${port}/v1`,
      model: "mock-model",
      workspace: process.cwd(),
      maxSteps: 4,
      shell: "bash",
    });

    try {
      await agent.runTurn("Inspect package.json metadata");
      assert.strictEqual(callCount, 2);
      const history = agent.getHistory();
      assert.ok(history.length >= 3, "Expected at least 3 messages in history");
    } finally {
      agent.shutdown();
      mockServer.close();
    }
  });

  test("SecurityManager enforces default blocked commands and protected paths", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus_sec_test_"));
    try {
      const sm = new SecurityManager(tmpDir);
      assert.strictEqual(sm.isCommandBlocked("rm -rf /").blocked, true);
      assert.strictEqual(sm.isCommandBlocked("rm -rf /*").blocked, true);
      assert.strictEqual(sm.isCommandBlocked("shutdown -h now").blocked, true);
      assert.strictEqual(sm.isCommandBlocked("git status").blocked, false);

      assert.strictEqual(sm.isPathProtected(".git").protected, true);
      assert.strictEqual(sm.isPathProtected(".git/config").protected, true);
      assert.strictEqual(sm.isPathProtected(".env").protected, true);
      assert.strictEqual(sm.isPathProtected("src/index.ts").protected, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("SecurityManager loads custom .nexus-security.json policy", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus_sec_custom_"));
    try {
      const customPolicy = {
        blockedCommands: ["curl evil.com", "npm publish"],
        protectedPaths: ["config/secrets.json", "private"],
        allowedDomains: ["api.github.com", "crates.io"],
      };
      fs.writeFileSync(path.join(tmpDir, ".nexus-security.json"), JSON.stringify(customPolicy));

      const sm = new SecurityManager(tmpDir);
      assert.strictEqual(sm.isCommandBlocked("curl evil.com").blocked, true);
      assert.strictEqual(sm.isCommandBlocked("npm publish").blocked, true);
      assert.strictEqual(sm.isPathProtected("config/secrets.json").protected, true);
      assert.strictEqual(sm.isPathProtected("private/key.pem").protected, true);
      assert.deepStrictEqual(sm.getPolicy().allowedDomains, ["api.github.com", "crates.io"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("RustCoreBridge dry-run mode intercepts mutations without modifying disk", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus_dryrun_test_"));
    const { RustCoreBridge } = await import("../src/tools.js");
    const bridge = new RustCoreBridge(tmpDir, "bash", undefined, true, false);
    try {
      // 1. write_file simulation
      const resWrite = await bridge.executeTool("write_file", {
        path: "simulated.txt",
        content: "Hello Dry Run!",
      });
      assert.strictEqual(resWrite.success, true);
      const parsedWrite = JSON.parse(resWrite.output);
      assert.strictEqual(parsedWrite.dry_run, true);
      assert.strictEqual(fs.existsSync(path.join(tmpDir, "simulated.txt")), false);

      // 2. mutating command simulation
      const resCmd = await bridge.executeTool("run_command", {
        command: "touch dummy_file.txt",
      });
      assert.strictEqual(resCmd.success, true);
      assert.ok(resCmd.output.includes("DRY-RUN SIMULATION"));
      assert.strictEqual(fs.existsSync(path.join(tmpDir, "dummy_file.txt")), false);

      // 3. safe command allowed in dry-run
      const resSafe = await bridge.executeTool("run_command", {
        command: "echo 'safe probe'",
      });
      assert.strictEqual(resSafe.success, true);
      assert.ok(resSafe.output.includes("safe probe"));
    } finally {
      bridge.shutdown();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("RustCoreBridge read-only mode blocks file edits and non-safe commands", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus_readonly_test_"));
    const { RustCoreBridge } = await import("../src/tools.js");
    const bridge = new RustCoreBridge(tmpDir, "bash", undefined, false, true);
    try {
      const resWrite = await bridge.executeTool("write_file", {
        path: "blocked.txt",
        content: "Should fail",
      });
      assert.strictEqual(resWrite.success, false);
      assert.ok(resWrite.error?.includes("Read-only mode violation"));

      const resCmd = await bridge.executeTool("run_command", {
        command: "rm -f something.txt",
      });
      assert.strictEqual(resCmd.success, false);
      assert.ok(resCmd.error?.includes("Read-only mode violation"));
    } finally {
      bridge.shutdown();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("BPE Token Accounting accurately counts subwords and computes budget", () => {
    const text = "function calculateTotal(items: Item[]): number {\n  return items.reduce((a, b) => a + b.price, 0);\n}";
    const tokens = countTokens(text);
    assert.ok(tokens > 15 && tokens < 40, `Unexpected token count: ${tokens}`);

    const messages = [
      { role: "system" as const, content: "You are an assistant." },
      { role: "user" as const, content: "Fix the bug in utils.ts" },
      { role: "assistant" as const, content: "<thought>Let's check the code.</thought>" },
      { role: "tool" as const, name: "read_file", content: text },
    ];
    const budget = calculateContextBudget(messages, HARNESS_TOOLS, 32768);
    assert.ok(budget.systemPromptTokens > 0);
    assert.ok(budget.userTokens > 0);
    assert.ok(budget.assistantTokens > 0);
    assert.ok(budget.toolOutputTokens > 0);
    assert.ok(budget.toolsDefinitionTokens > 100);
    assert.strictEqual(budget.contextLimit, 32768);

    const gauge = renderTokenGauge(budget);
    assert.ok(gauge.includes("Context Window & Token Accounting Gauge"));
    assert.ok(gauge.includes("Tool Definitions"));
    assert.ok(gauge.includes("Tool Output Payloads"));
  });

  test("LocalLlmClient executes automatic failover when primary endpoint fails", async () => {
    // 1. Primary server that always returns 503 Service Unavailable
    const primaryServer = http.createServer((req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "GPU VRAM Out of Memory" }));
    });
    await new Promise<void>((resolve) => primaryServer.listen(0, "127.0.0.1", () => resolve()));
    const primaryPort = (primaryServer.address() as any).port;

    // 2. Backup server that succeeds
    const backupServer = http.createServer((req, res) => {
      if (req.url?.includes("/chat/completions")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chat_backup_123",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Response from backup server!" },
                finish_reason: "stop",
              },
            ],
          })
        );
      } else if (req.url?.includes("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "backup-model" }] }));
      }
    });
    await new Promise<void>((resolve) => backupServer.listen(0, "127.0.0.1", () => resolve()));
    const backupPort = (backupServer.address() as any).port;

    try {
      const client = new LocalLlmClient({
        endpoint: `http://127.0.0.1:${primaryPort}/v1`,
        fallbackEndpoints: [`http://127.0.0.1:${backupPort}/v1`],
        model: "test-model",
        workspace: process.cwd(),
        maxSteps: 5,
        shell: "bash",
        temperature: 0.1,
      });

      // Failover in chatCompletion
      const reply = await client.chatCompletion([{ role: "user", content: "Ping" }], []);
      assert.strictEqual(reply.content, "Response from backup server!");
      assert.ok(client.getActiveEndpoint().includes(String(backupPort)));

      // Failover in listModels
      const models = await client.listModels();
      assert.deepStrictEqual(models, ["backup-model"]);
    } finally {
      primaryServer.close();
      backupServer.close();
    }
  });

  test("AutonomousAgent context compaction distills discarded history into structured memory", async () => {
    const agent = new AutonomousAgent({
      endpoint: "http://localhost:1234/v1",
      model: "test-model",
      workspace: process.cwd(),
      maxSteps: 10,
      shell: "bash",
    });

    try {
      // Simulate an extended 8-message conversation with edits, reads, and commands
      const history = [
        { role: "system" as const, content: "System Prompt" },
        { role: "user" as const, content: "Refactor database access" },
        {
          role: "assistant" as const,
          content: "<thought>Identified connection pool bottleneck in db.ts</thought>",
          tool_calls: [
            {
              id: "c1",
              type: "function" as const,
              function: { name: "read_file", arguments: JSON.stringify({ path: "src/db.ts" }) },
            },
          ],
        },
        { role: "tool" as const, name: "read_file", tool_call_id: "c1", content: "file content" },
        {
          role: "assistant" as const,
          content: "Now patching db.ts connection logic",
          tool_calls: [
            {
              id: "c2",
              type: "function" as const,
              function: { name: "edit_file", arguments: JSON.stringify({ path: "src/db.ts", target_content: "a", replacement_content: "b" }) },
            },
            {
              id: "c3",
              type: "function" as const,
              function: { name: "run_command", arguments: JSON.stringify({ command: "cargo test" }) },
            },
          ],
        },
        { role: "tool" as const, name: "edit_file", tool_call_id: "c2", content: "success" },
        { role: "tool" as const, name: "run_command", tool_call_id: "c3", content: "test passed" },
        { role: "user" as const, content: "Next step please" },
        { role: "assistant" as const, content: "Ready to proceed" },
      ];

      agent.setMessages(history);
      assert.strictEqual(agent.getHistoryCount(), 9);

      const report = await agent.compactConversation(false);
      assert.ok(report.includes("Compacted context"));
      assert.strictEqual(agent.getHistoryCount(), 6); // system + summary + last 4

      const summaryMsg = agent.getMessages()[1];
      assert.strictEqual(summaryMsg.role, "system");
      assert.ok(summaryMsg.content?.includes("Structured Context Memory"));
      assert.ok(summaryMsg.content?.includes("src/db.ts"), "Missing touched file path in summary");
      assert.ok(summaryMsg.content?.includes("cargo test"), "Missing command in summary");
      assert.ok(summaryMsg.content?.includes("connection pool bottleneck"), "Missing key decision in summary");
    } finally {
      agent.shutdown();
    }
  });

  test("selectRelevantFewShots injects task-specific exemplars", () => {
    const editShot = selectRelevantFewShots("Please edit and refactor the calc function to fix bug");
    assert.ok(editShot.includes("edit_file"));
    assert.ok(editShot.includes("target_content"));

    const testShot = selectRelevantFewShots("We have failing compiler errors and diagnostic cargo test");
    assert.ok(testShot.includes("run_command"));
    assert.ok(testShot.includes("npm test") || testShot.includes("cargo test") || testShot.includes("FAIL"));

    const planShot = selectRelevantFewShots("Formulate a multi-step architecture plan for migration phases");
    assert.ok(planShot.includes("update_plan"));
    assert.ok(planShot.includes("phases"));
  });
});



