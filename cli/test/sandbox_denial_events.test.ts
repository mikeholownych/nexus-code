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
import { sandboxDenialEvent, sandboxDenialFromError, sandboxEngineLabel } from "../src/sandbox_events.js";

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

test("only confinement refusals become typed events, with engine, profile and a category", () => {
  const engine = sandboxEngineLabel("bwrap");
  const unavailable = sandboxDenialFromError("Bubblewrap (bwrap) is not available, so the worker cannot be isolated.", engine, "run_command");
  assert.ok(unavailable);
  assert.deepEqual([unavailable.kind, unavailable.engine, unavailable.profile, unavailable.category, unavailable.operation], ["unavailable", "bwrap", "default", "engine", "run_command"]);
  assert.match(unavailable.reason, /not available/);
  assert.ok(!Number.isNaN(Date.parse(unavailable.at)));

  const violation = sandboxDenialFromError("Read-only mode violation: command operands escaped the pinned workspace.", "auto", "run_command");
  assert.ok(violation);
  assert.deepEqual([violation.kind, violation.category], ["violation", "filesystem"]);

  const network = sandboxDenialFromError("sandbox network access is refused by managed policy", "docker", "run_command");
  assert.ok(network);
  assert.deepEqual([network.kind, network.category], ["denied", "network"]);

  assert.equal(sandboxDenialFromError("Execution was rejected by the user.", engine, "run_command"), undefined);
  assert.equal(sandboxDenialFromError(undefined, engine, "run_command"), undefined);
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
  const event = sandboxDenialFromError("Docker is requested but not available or daemon is not running.", "docker", "run_command")!;
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
