/**
 * Wire-level conformance (PF-1, release gate G-2): each recorded session under fixtures/wire replays against the real
 * sidecar, event for event. The harness, the recording format and how to regenerate are in helpers/wire_fixture.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import "./helpers/leak_guard.js";
import { loadRecording, record, recordingFile, recordingNames, recordingText, replay, writeRecording, type WireRecording } from "./helpers/wire_fixture.js";

const names = recordingNames();
const recordings = new Map<string, WireRecording>();

for (const name of names) {
  test(`the recorded session "${name}" replays through the real sidecar`, async () => {
    if (process.env.NEXUS_WIRE_RECORD) writeRecording(name, await record(loadRecording(name)));
    const recording = loadRecording(name);
    recordings.set(name, recording);
    assert.equal(fs.readFileSync(recordingFile(name), "utf8"), recordingText(recording), "a recording is written by the recorder, one event per line");
    assert.ok(recording.steps.length >= 2 && recording.steps.some((step) => step.expect.length > 0), "a recording expects something");
    await replay(recording);
  });
}

test("the recordings cover start-up and negotiation, a complete turn, and error handling", () => {
  assert.deepEqual(names, ["errors", "negotiation", "negotiation_unsupported", "turn"]);
  const expected = (name: string): any[] => (recordings.get(name) ?? loadRecording(name)).steps.flatMap((step) => step.expect);
  const types = (name: string): string[] => expected(name).map((event) => event.type);
  const codes = (name: string): string[] => expected(name).filter((event) => event.type === "error").map((event) => event.code);

  assert.deepEqual(types("negotiation"), ["hello", "session.state", "initialized", "error"]);
  assert.deepEqual(types("negotiation_unsupported"), ["hello", "session.state", "error", "error", "initialized"]);
  assert.deepEqual(codes("negotiation_unsupported"), ["UNSUPPORTED_PROTOCOL", "UNSUPPORTED_PROTOCOL"]);

  const turn = types("turn");
  for (const type of ["session.state", "activity", "tool.start", "tool.end", "assistant.delta", "turn.result", "tool.detail", "receipt"]) assert.ok(turn.includes(type), `the turn recording has ${type}`);
  assert.ok(turn.indexOf("tool.start") < turn.indexOf("tool.end") && turn.indexOf("tool.end") < turn.indexOf("assistant.delta") && turn.indexOf("assistant.delta") < turn.indexOf("turn.result"));
  assert.equal(expected("turn").find((event) => event.type === "turn.result").turn.execution, "COMPLETED");

  assert.deepEqual(codes("errors"), ["BAD_REQUEST", "BAD_REQUEST", "BAD_REQUEST", "BAD_REQUEST", "BAD_REQUEST", "NO_PENDING_APPROVAL", "NOT_FOUND"]);
  const steps = loadRecording("errors").steps;
  assert.equal(steps.filter((step) => step.malformed !== undefined).length, 4);
  const cancel = steps.find((step) => step.send?.type === "cancel" && step.malformed === undefined);
  assert.deepEqual(cancel?.expect, [], "cancel with nothing running is accepted in silence");
  assert.equal(steps.at(-1)?.send?.type, "shutdown");
  assert.equal(steps.at(-1)?.closes, true);
});

test("a recording that does not match is reported with its step number: the harness cannot pass vacuously", async () => {
  const mutate = async (change: (recording: WireRecording) => void): Promise<string> => {
    const recording = structuredClone(loadRecording("negotiation"));
    change(recording);
    try {
      await replay(recording);
    } catch (err) {
      return (err as Error).message;
    }
    return "";
  };
  // A changed value in one expected event.
  assert.match(await mutate((r) => { (r.steps[1].expect[0] as any).protocol = 7; }), /^step 2 \(send initialize\), event 1 \(initialized\): \$\.protocol: expected 7, got 1$/m);
  // A field the sidecar does not send, an event it does not send, and an id that must repeat and does not.
  assert.match(await mutate((r) => { (r.steps[0].expect[0] as any).added = true; }), /^step 1 \(connect\), event 1 \(hello\): \$: missing field added$/m);
  assert.match(await mutate((r) => { r.steps[2].expect.push({ v: 1, type: "notice", text: "never sent" }); }), /^step 3 \(send initialize\): expected 2 events \(error, notice\), the sidecar sent 1 \(error\)$/m);
  assert.match(await mutate((r) => { (r.steps[1].expect[0] as any).id = "<id:session>"; }), /^step 2 \(send initialize\), event 1 \(initialized\): \$\.id: expected <id:session> to be "session_[^"]+" again, got "i1"$/m);
  // A line that is not a valid command must be marked, and a marked line must really be invalid.
  assert.match(await mutate((r) => { delete (r.steps[1].send as any).client; }), /^step 2 \(send initialize\): the line is not a valid command \(.*missing required client.*\); mark it "malformed"/m);
  assert.match(await mutate((r) => { r.steps[1].malformed = "it is not"; }), /^step 2 \(send initialize\): marked malformed, but the line is a valid command$/m);
  assert.match(await mutate((r) => { r.steps[1].closes = true; }), /^step 2 \(send initialize\): the recording expects the sidecar to shut down, and it did not$/m);
});
