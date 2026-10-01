import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FlightRecorder } from "../src/flight.js";
import { InformationFlowBoundary } from "../src/core/egress.js";
import { AuthorityAdmissionEngine } from "../src/core/authority.js";

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

test("rehydrated local tool arguments remain usable while flight evidence stays redacted, including fullAccess runs", () => {
  const boundary = new InformationFlowBoundary();
  const credential = `ghp_${"r".repeat(36)}`;
  const quarantined = boundary.evaluateEgress({ token: credential }, "https://example.invalid", {
    taskId: "task-synthetic",
    sessionId: "session-synthetic",
    sourceBoundary: "HOST_LOCAL",
  });
  assert.equal(quarantined.allowed, true);
  const localArgs = boundary.rehydrate(quarantined.sanitizedPayload, {
    taskId: "task-synthetic",
    sessionId: "session-synthetic",
    isAuthorizedSink: true,
  }).rehydrated;
  assert.equal(localArgs.token, credential, "authorized local execution lost its credential");

  InformationFlowBoundary.setGlobalInstance(boundary);
  const authority = new AuthorityAdmissionEngine({ fullAccess: true });
  assert.equal(authority.isFullAccess(), true);
  const flight = recorder("flight-rehydrated-synthetic");
  flight.recordToolCall(1, "restored", "use_credential", localArgs);
  const disk = fs.readFileSync(flight.getLogPath(), "utf8");
  assert.equal(disk.includes(credential), false);
  assert.match(disk, /\[REDACTED:GITHUB_TOKEN\]/);
});

test("FlightRecorder fails closed without appending when classifier sanitization fails", () => {
  const boundary = new InformationFlowBoundary();
  const secret = `ghp_${"f".repeat(36)}`;
  boundary.classifyText = () => { throw new Error(`synthetic classifier failure: ${secret}`); };
  InformationFlowBoundary.setGlobalInstance(boundary);
  const flight = recorder("flight-sanitizer-failure");

  assert.throws(() => flight.recordToolCall(1, "failure", "run_command", { token: secret }), (error: Error) => {
    assert.equal(error.message.includes(secret), false, "sanitizer diagnostics exposed inspected plaintext");
    return error.message === "Flightlog sanitization failed; event was not persisted";
  });
  assert.equal(fs.existsSync(flight.getLogPath()), false, "sanitizer failure created a durable flightlog");
});
