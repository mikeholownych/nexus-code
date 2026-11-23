/**
 * VR-3: sandbox refusals are typed receipt and flight records. They carry engine, profile and reason; they are never
 * an approval and never raise a verdict. No model, no network: the classifier is pure and the recorder is local.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FlightPlayer, FlightRecorder } from "../src/flight.js";
import { sandboxDenialEvent, sandboxEngineLabel } from "../src/sandbox_events.js";
import { dispatchToolCallImpl } from "../src/core/dispatch_tool_call.js";
import { mergePolicies } from "../src/core/managed_policy.js";
import { NO_COMMAND_RULES } from "../src/core/command_rules.js";

const dirs: string[] = [];
function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vr3-"));
  dirs.push(dir);
  return dir;
}
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

test("the engine label is profile-agnostic and normalises the config forms", () => {
  assert.equal(sandboxEngineLabel("bwrap"), "bwrap");
  assert.equal(sandboxEngineLabel(" DOCKER "), "docker");
  assert.equal(sandboxEngineLabel("none"), "none");
  assert.equal(sandboxEngineLabel(true), "auto");
  assert.equal(sandboxEngineLabel(false), "none");
  assert.equal(sandboxEngineLabel(undefined), "none");
});

test("structured sandbox denials become typed receipt and flight events through dispatch", async () => {
  const dir = workspace();
  const flight = new FlightRecorder(dir, "vr3-dispatch");
  flight.startSession({ model: "test-model", endpoint: "local-test", taskPrompt: "deny me" });
  const recorded: any[] = [];
  const agent: any = {
    config: { workspace: dir, sandbox: "bwrap" },
    flightRecorder: flight,
    ui: { stopSpinner() {}, printToolCall() {}, startSpinner() {}, printToolResult() {} },
    activity() {},
    capabilityRegistry: { getByToolName() { return undefined; } },
    getApprovalMode() { return "auto"; },
    isReadOnly() { return false; },
    trustedWorkspaceExtensions: false,
    checkpointReadOnlyFallback: false,
    commandRules: { decide() { return { decision: "allow" }; } },
    managedPolicy: undefined,
    skillManager: { getActive() { return []; } },
    commandRules: NO_COMMAND_RULES,
    commandRuleDecisions: [],
    syncVerificationAttempts() {},
    commandRulesNotice: undefined,
    bridge: { getSecurityManager() { return { getEffectivePolicy() { return mergePolicies(); }, setShellChangeObserver() {}, verificationEditDecision() { return { allowed: true }; } }; } },
    approvalPolicy: { requiresDecision() { return false; } },
    pluginManager: { notifyToolCall() {}, notifyToolResult() {} },
    mayWrite() { return true; },
    captureChangeBaseline() {},
    durable: false,
    modifiedFiles: new Set<string>(),
    hasPendingModifications: false,
    objective: null,
    getEffectiveTools() { return []; },
    recordSandboxDenialEvent(event: any) { recorded.push(event); },
  };
  const receipt = {
    success: false,
    output: "",
    error: "Read-only mode violation: filesystem-isolated shell execution is unavailable. No supported sandbox engine is available.",
    durationMs: 1,
    sandboxDenial: { kind: "unavailable", category: "engine", reason: "No supported sandbox engine is available." },
  };
  agent.spine = {
    execute: async () => ({
      invocationId: "c1", taskId: "t1", actor: "agent", executionDomain: "agent_orchestration",
      capabilityId: "run_command", toolName: "run_command", targetResources: [],
      success: false, output: "", error: receipt.error, durationMs: 1, candidateMutated: false,
      status: "FAILED", timestamp: new Date().toISOString(), simulated: false,
      sandboxEvents: [{ kind: "unavailable", engine: "bwrap", profile: "default", operation: "run_command", category: "engine", reason: "No supported sandbox engine is available.", at: new Date().toISOString() }],
    }),
  };

  const out = await dispatchToolCallImpl.call(agent, { id: "c1", type: "function", function: { name: "run_command", arguments: "{\"command\":\"echo hi\"}" } }, 1, "agent");

  assert.equal(out.receipt.success, false);
  assert.equal(out.receipt.sandboxEvents?.length, 1);
  assert.deepEqual([out.receipt.sandboxEvents![0].kind, out.receipt.sandboxEvents![0].engine, out.receipt.sandboxEvents![0].category, out.receipt.sandboxEvents![0].profile], ["unavailable", "bwrap", "engine", "default"]);
  assert.equal(recorded.length, 1);

  const replayed = FlightPlayer.loadFlight(dir, "vr3-dispatch");
  const denial = replayed.events.find((entry) => entry.type === "sandbox_unavailable");
  assert.ok(denial);
  assert.equal(denial.payload.reason, "No supported sandbox engine is available.");
});

test("ordinary errors with sandbox-like text do not become sandbox denial events", async () => {
  const dir = workspace();
  const flight = new FlightRecorder(dir, "vr3-no-false-positive");
  flight.startSession({ model: "test-model", endpoint: "local-test", taskPrompt: "no false positives" });
  const recorded: any[] = [];
  const agent: any = {
    config: { workspace: dir, sandbox: "bwrap" },
    flightRecorder: flight,
    ui: { stopSpinner() {}, printToolCall() {}, startSpinner() {}, printToolResult() {} },
    activity() {},
    capabilityRegistry: { getByToolName() { return undefined; } },
    getApprovalMode() { return "auto"; },
    isReadOnly() { return false; },
    trustedWorkspaceExtensions: false,
    checkpointReadOnlyFallback: false,
    commandRules: { decide() { return { decision: "allow" }; } },
    managedPolicy: undefined,
    skillManager: { getActive() { return []; } },
    commandRules: NO_COMMAND_RULES,
    commandRuleDecisions: [],
    syncVerificationAttempts() {},
    commandRulesNotice: undefined,
    bridge: { getSecurityManager() { return { getEffectivePolicy() { return mergePolicies(); }, setShellChangeObserver() {}, verificationEditDecision() { return { allowed: true }; } }; } },
    approvalPolicy: { requiresDecision() { return false; } },
    pluginManager: { notifyToolCall() {}, notifyToolResult() {} },
    mayWrite() { return true; },
    captureChangeBaseline() {},
    durable: false,
    modifiedFiles: new Set<string>(),
    hasPendingModifications: false,
    objective: null,
    getEffectiveTools() { return []; },
    recordSandboxDenialEvent(event: any) { recorded.push(event); },
  };
  agent.spine = {
    execute: async () => ({
      invocationId: "c2", taskId: "t1", actor: "agent", executionDomain: "agent_orchestration",
      capabilityId: "read_file", toolName: "read_file", targetResources: [],
      success: false, output: "", error: "ENOENT: no such file or directory, open '/home/u/ws/Dockerfile'",
      durationMs: 1, candidateMutated: false, status: "FAILED", timestamp: new Date().toISOString(), simulated: false,
    }),
  };

  const out = await dispatchToolCallImpl.call(agent, { id: "c2", type: "function", function: { name: "read_file", arguments: "{\"path\":\"Dockerfile\"}" } }, 1, "agent");

  assert.equal(out.receipt.sandboxEvents, undefined);
  assert.deepEqual(recorded, []);
  const replayed = FlightPlayer.loadFlight(dir, "vr3-no-false-positive");
  assert.equal(replayed.events.some((entry) => String(entry.type).startsWith("sandbox_")), false);
});

test("an event is one line, bounded, and carries no verdict", () => {
  const event = sandboxDenialEvent({ kind: "denied", engine: "docker", operation: "run_command", category: "policy", reason: "refused\nwith a second line", profile: "odd\nprofile" });
  assert.equal(event.reason, "refused with a second line");
  assert.equal(event.profile, "odd profile");
  assert.equal(event.reason.includes("\n"), false);
  assert.ok(!("verdict" in event));
});

test("the flight recorder writes a typed denial that replays with an intact chain and no verdict", () => {
  const dir = workspace();
  const flight = new FlightRecorder(dir, "vr3-flight");
  flight.startSession({ model: "test-model", endpoint: "local-test", taskPrompt: "deny me" });
  const event = sandboxDenialEvent({ kind: "unavailable", engine: "docker", operation: "run_command", category: "engine", reason: "Docker is requested but not available or daemon is not running." });
  const written = flight.recordSandboxDenial(1, event);
  flight.recordSessionEnd("blocked by sandbox", false);

  assert.equal(written.type, "sandbox_unavailable");
  const replayed = FlightPlayer.loadFlight(dir, "vr3-flight");
  const denial = replayed.events.find((entry) => entry.type === "sandbox_unavailable");
  assert.ok(denial);
  assert.equal(denial.payload.engine, "docker");
  assert.equal(denial.payload.profile, "default");
  assert.match(String(denial.payload.reason), /daemon is not running/);
  assert.ok(!("verdict" in denial.payload), "a flight denial stays evidence, never a verdict");
  assert.equal(replayed.integrity.chain.status, "intact");

  const raw = fs.readFileSync(flight.getLogPath(), "utf8");
  assert.equal(raw.includes("sandbox_unavailable"), true);
  assert.equal(raw.includes("SANDBOX_UNAVAILABLE"), false, "the flight event is a typed refusal, not a verify reason");
});

import { ExecutionSpine } from "../src/core/spine.js";

test("ExecutionSpine converts structured sandboxDenial into receipt sandboxEvents with engine from context", async () => {
  const spine = new ExecutionSpine();
  spine.registerHandler("run_command", async () => ({
    success: false,
    output: "",
    error: "Read-only mode violation: filesystem-isolated shell execution is unavailable. No supported sandbox engine is available.",
    sandboxDenial: { kind: "unavailable" as const, category: "engine" as const, reason: "No supported sandbox engine is available." },
  }));

  const receipt = await spine.execute(
    { invocationId: "inv-1", taskId: "task-1", toolName: "run_command", args: { command: "echo hi" } },
    { workspaceRoot: "/tmp/ws", metadata: { sandbox: "bwrap" } },
  );

  assert.equal(receipt.success, false);
  assert.equal(receipt.sandboxEvents?.length, 1);
  assert.equal(receipt.sandboxEvents?.[0].engine, "bwrap");
  assert.equal(receipt.sandboxEvents?.[0].kind, "unavailable");
  assert.equal(receipt.sandboxEvents?.[0].category, "engine");
  assert.equal(receipt.sandboxEvents?.[0].operation, "run_command");
  assert.equal(receipt.sandboxEvents?.[0].profile, "default");
  assert.ok(!("verdict" in (receipt.sandboxEvents?.[0] ?? {})));
});
