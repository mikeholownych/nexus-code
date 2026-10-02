import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FlightRecorder } from "../src/flight.js";
import { InformationFlowBoundary } from "../src/core/egress.js";
import { AutonomousAgent } from "../src/agent.js";

const tempDirs: string[] = [];
const originalBoundary = InformationFlowBoundary.getGlobalInstance();

function recorder(id: string): FlightRecorder {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cred003-"));
  tempDirs.push(workspace);
  return new FlightRecorder(workspace, id);
}

after(() => {
  InformationFlowBoundary.setGlobalInstance(originalBoundary);
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("FlightRecorder irreversibly sanitizes nested secrets before appended disk writes", () => {
  const flight = recorder("flight-nested-synthetic");
  const github = `ghp_${"g".repeat(36)}`;
  const openAi = `sk-${"o".repeat(24)}`;
  const bearer = "syntheticBearerToken123456";

  flight.recordToolCall(1, "safe-before", "read_file", { path: "src/auth.ts", note: "ordinary evidence" });
  flight.startSession({ model: "test-model", endpoint: "local-test", taskPrompt: `Authorization: Bearer ${bearer}` });
  flight.recordToolCall(2, "sensitive", "run_command", {
    command: `curl -H 'Authorization: Bearer ${bearer}'`,
    nested: [{ credentials: { github, model: openAi }, api_key: "contextValueForTest123" }],
  });
  flight.recordTurnStart(2, `Request includes ${openAi}`);
  flight.recordThought(2, `Inspecting ${github}`, `Authorization: Bearer ${bearer}`);
  flight.recordToolResult(2, "sensitive", "run_command", false, `failed using ${github}`, 9, `Bearer ${bearer}`);
  flight.recordToolCall(3, "safe-after", "read_file", { path: "src/other.ts", note: "ordinary follow-up" });

  const bytes = fs.readFileSync(flight.getLogPath(), "utf8");
  for (const secret of [github, openAi, bearer]) assert.equal(bytes.includes(secret), false, `plaintext survived: ${secret}`);
  assert.match(bytes, /\[REDACTED:GITHUB_TOKEN\]/);
  assert.match(bytes, /\[REDACTED:OPENAI_API_KEY\]/);
  assert.match(bytes, /\[REDACTED:BEARER_AUTH_HEADER\]/);
  assert.match(bytes, /\[REDACTED:KEY_VALUE_SECRET\]/);

  const lines = bytes.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 7);
  assert.equal(lines[0].payload.arguments.path, "src/auth.ts");
  assert.equal(lines[0].payload.arguments.note, "ordinary evidence");
  assert.match(lines[1].payload.taskPrompt, /\[REDACTED:BEARER_AUTH_HEADER\]/);
  assert.equal(lines[2].payload.arguments.nested[0].credentials.github, "[REDACTED:GITHUB_TOKEN]");
  assert.equal(lines[2].payload.arguments.nested[0].api_key, "[REDACTED:KEY_VALUE_SECRET]");
  assert.match(lines[3].payload.prompt, /\[REDACTED:OPENAI_API_KEY\]/);
  assert.match(lines[4].payload.reasoning, /\[REDACTED:BEARER_AUTH_HEADER\]/);
  assert.equal(lines[5].payload.success, false);
  assert.match(lines[5].payload.error, /\[REDACTED:BEARER_AUTH_HEADER\]/);
  assert.equal(lines[6].payload.arguments.path, "src/other.ts");
});

test("rehydrated local tool arguments execute under fullAccess while flight and audit evidence stay redacted", async () => {
  const boundary = new InformationFlowBoundary();
  const credential = `ghp_${"r".repeat(36)}`;
  const quarantined = boundary.evaluateEgress({ token: credential, phases: [] }, "https://example.invalid", {
    taskId: "default_task",
    sessionId: "default_session",
    sourceBoundary: "HOST_LOCAL",
  });
  assert.equal(quarantined.allowed, true);
  InformationFlowBoundary.setGlobalInstance(boundary);
  const baseWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cred003-agent-"));
  tempDirs.push(baseWorkspace);
  const workspace = path.join(baseWorkspace, `workspace-${credential}`);
  fs.mkdirSync(workspace, { recursive: true });
  const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cred003-audit-home-"));
  tempDirs.push(auditHome);
  const previousHome = process.env.HOME;
  process.env.HOME = auditHome;
  const agent: any = new AutonomousAgent({
    endpoint: "http://127.0.0.1:1/v1",
    model: "synthetic-test",
    maxSteps: 1,
    temperature: 0,
    workspace,
    shell: "bash",
    fullAccess: true,
    recordFlight: true,
  });
  let executedArgs: Record<string, unknown> | undefined;
  try {
    assert.equal(agent.authorityEngine.isFullAccess(), true);
    agent.spine.registerHandler("update_plan", async (args: Record<string, unknown>) => {
      executedArgs = args;
      return { success: true, output: "synthetic local execution completed" };
    });
    const result = await agent.dispatchToolCall({
      id: "synthetic-restored-call",
      function: { name: "update_plan", arguments: JSON.stringify(quarantined.sanitizedPayload) },
    }, 1);
    assert.equal(result.receipt.success, true);
    assert.deepEqual(executedArgs, { token: credential, phases: [] }, "authorized local capability did not receive restored plaintext");

    const flight = agent.getFlightRecorder() as FlightRecorder;
    const flightDisk = fs.readFileSync(flight.getLogPath(), "utf8");
    assert.equal(flightDisk.includes(credential), false);
    assert.match(flightDisk, /\[REDACTED:GITHUB_TOKEN\]/);

    const auditPath = path.join(auditHome, ".nexus", "audit.log");
    const auditDisk = fs.readFileSync(auditPath, "utf8");
    assert.equal(auditDisk.includes(credential), false, "workspace metadata plaintext survived in audit log");
    assert.match(auditDisk, /\[REDACTED:GITHUB_TOKEN\]/);
    assert.match(auditDisk, /"tool":"update_plan"/);
  } finally {
    agent.shutdown();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("classifier failure skips flight and audit persistence without blocking authorized execution", async () => {
  const boundary = new InformationFlowBoundary();
  const secret = `ghp_${"f".repeat(36)}`;
  boundary.classifyText = () => { throw new Error(`synthetic classifier failure: ${secret}`); };
  InformationFlowBoundary.setGlobalInstance(boundary);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cred003-failure-"));
  tempDirs.push(workspace);
  const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cred003-failure-home-"));
  tempDirs.push(auditHome);
  const previousHome = process.env.HOME;
  process.env.HOME = auditHome;
  const agent: any = new AutonomousAgent({
    endpoint: "http://127.0.0.1:1/v1",
    model: "synthetic-test",
    maxSteps: 1,
    temperature: 0,
    workspace,
    shell: "bash",
    fullAccess: true,
    recordFlight: true,
  });
  let executedArgs: Record<string, unknown> | undefined;
  try {
    assert.match(agent.getInitialStatePersistenceFailure(), /restart recovery is unavailable/);
    assert.equal(agent.getInitialStatePersistenceFailure().includes(secret), false);
    agent.spine.registerHandler("update_plan", async (args: Record<string, unknown>) => {
      executedArgs = args;
      return { success: true, output: "execution survived sanitizer failure" };
    });
    const result = await agent.dispatchToolCall({
      id: "synthetic-failure-call",
      function: { name: "update_plan", arguments: JSON.stringify({ token: secret, phases: [] }) },
    }, 1);
    assert.equal(result.receipt.success, true);
    assert.deepEqual(executedArgs, { token: secret, phases: [] });
    const flight = agent.getFlightRecorder() as FlightRecorder;
    assert.equal(fs.existsSync(flight.getLogPath()), false, "sanitizer failure created a durable flightlog");
    assert.equal(fs.existsSync(path.join(auditHome, ".nexus", "audit.log")), false, "audit sanitizer failure wrote a record");
  } finally {
    agent.shutdown();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
