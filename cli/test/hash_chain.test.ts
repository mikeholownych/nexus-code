/**
 * GV-3: the flight recorder and the verification-configuration attempt log are hash-chained, so a record that was
 * changed, removed or reordered is found when the log is read. What a chain cannot show (records cut from the end)
 * is asserted too, so the limit stays stated rather than assumed away.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { CHAIN_GENESIS, canonicalJson, describeChain, linkRecord, verifyChain, type ChainLink } from "../src/core/hash_chain.js";
import { InformationFlowBoundary } from "../src/core/egress.js";
import { FlightPlayer, FlightRecorder } from "../src/flight.js";
import { SecurityManager } from "../src/security.js";
import { CLI_DIR } from "./helpers/audit_fixture.js";
import { makeHome } from "./helpers/fixtures.js";

const tempDirs: string[] = [];
const tempHomes: string[] = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  for (const home of tempHomes) fs.rmSync(home, { recursive: true, force: true });
});
function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gv3-"));
  tempDirs.push(dir);
  return dir;
}

function chainOf(contents: object[]): Array<object & { chain: ChainLink }> {
  const out: Array<object & { chain: ChainLink }> = [];
  for (const content of contents) out.push(linkRecord(content, out[out.length - 1]?.chain));
  return out;
}
/** As the records come back from disk. */
const reread = <T>(records: T[]): T[] => records.map((r) => JSON.parse(JSON.stringify(r)));

describe("canonical JSON", () => {
  test("key order does not change the text; nesting, arrays and dropped members follow JSON.stringify", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    assert.equal(canonicalJson({ a: 1, b: undefined, c: () => 1 }), '{"a":1}');
    assert.equal(canonicalJson([undefined, 1]), "[null,1]");
    assert.equal(canonicalJson({ when: new Date(0) }), '{"when":"1970-01-01T00:00:00.000Z"}');
    assert.equal(canonicalJson("x\n "), JSON.stringify("x\n "));
  });
});

describe("chain", () => {
  const base = [{ type: "a", payload: { n: 1 } }, { type: "b", payload: { text: "héllo ✓" } }, { type: "c", payload: {} }, { type: "d", payload: { list: [1, 2] } }];

  test("a log read back as written is intact, and the first link starts from the genesis value", () => {
    const records = reread(chainOf(base));
    assert.equal((records[0] as any).chain.prev, CHAIN_GENESIS);
    assert.deepEqual((records as any[]).map((r) => r.chain.seq), [0, 1, 2, 3]);
    const verdict = verifyChain(records);
    assert.equal(verdict.status, "intact");
    assert.equal(verdict.status === "intact" && verdict.head?.seq, 3);
    assert.equal(describeChain(verdict), "chain intact (4 records)");
  });

  test("a hash does not depend on the order in which a record's members are stored", () => {
    const [record] = reread(chainOf([{ b: 2, a: 1 }]));
    const reordered = { chain: (record as any).chain, a: 1, b: 2 };
    assert.equal(verifyChain([reordered]).status, "intact");
  });

  test("a changed record is reported as edited, at its position", () => {
    const records = reread(chainOf(base)) as any[];
    records[2].payload = { injected: true };
    const verdict = verifyChain(records);
    assert.deepEqual([verdict.status, (verdict as any).at, (verdict as any).problem], ["broken", 2, "edited"]);
    assert.match(describeChain(verdict), /CHAIN BROKEN at position 3 of 4: record 2 was changed/);
  });

  test("a removed record is reported where the gap is; so are a swap and a duplicate", () => {
    const removed = reread(chainOf(base));
    removed.splice(1, 1);
    assert.deepEqual([(verifyChain(removed) as any).at, (verifyChain(removed) as any).problem], [1, "out_of_order"]);
    const swapped = reread(chainOf(base));
    [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    assert.deepEqual([(verifyChain(swapped) as any).at, (verifyChain(swapped) as any).problem], [1, "out_of_order"]);
    const duplicated = reread(chainOf(base));
    duplicated.splice(2, 0, JSON.parse(JSON.stringify(duplicated[1])));
    assert.deepEqual([(verifyChain(duplicated) as any).at, (verifyChain(duplicated) as any).problem], [2, "out_of_order"]);
  });

  test("a record removed from the front is reported: the new first record does not start the chain", () => {
    const records = reread(chainOf(base));
    records.shift();
    assert.deepEqual([(verifyChain(records) as any).at, (verifyChain(records) as any).problem], [0, "out_of_order"]);
  });

  test("an inserted record that carries its own consistent hash still fails, because it does not follow its neighbour", () => {
    const records = reread(chainOf(base)) as any[];
    const forged = linkRecord({ type: "forged", payload: {} }, undefined);
    forged.chain.seq = 2;
    records.splice(2, 0, forged);
    assert.equal(verifyChain(records).status, "broken");
    assert.equal((verifyChain(records) as any).at, 2);
  });

  test("a record without a link, an unreadable line and a malformed link are each reported as unlinked", () => {
    const plain = reread(chainOf(base)) as any[];
    plain.splice(1, 0, { type: "plain", payload: {} });
    assert.deepEqual([(verifyChain(plain) as any).at, (verifyChain(plain) as any).problem], [1, "unlinked"]);
    const garbage = reread(chainOf(base)) as any[];
    garbage[3] = null;
    assert.deepEqual([(verifyChain(garbage) as any).at, (verifyChain(garbage) as any).problem], [3, "unlinked"]);
    const malformed = reread(chainOf(base)) as any[];
    malformed[0].chain.hash = "not-a-hash";
    assert.deepEqual([(verifyChain(malformed) as any).at, (verifyChain(malformed) as any).problem], [0, "unlinked"]);
  });

  test("a log with no links at all is unchained, not broken; an empty one is intact", () => {
    assert.deepEqual(verifyChain([{ type: "a" }, { type: "b" }]), { status: "unchained", records: 2 });
    assert.match(describeChain(verifyChain([{ type: "a" }])), /not chained .* integrity cannot be checked/);
    assert.deepEqual(verifyChain([]), { status: "intact", records: 0 });
    // Unreadable lines alone are not "written before chaining".
    assert.equal(verifyChain([null]).status, "broken");
  });

  test("malformed chain metadata is broken even when every record has it", () => {
    const verdict = verifyChain([
      { type: "a", chain: { seq: "bad", prev: "not-a-hash", hash: "not-a-hash" } },
      { type: "b", chain: null },
    ]);
    assert.deepEqual([verdict.status, (verdict as any).at, (verdict as any).problem], ["broken", 0, "unlinked"]);
  });

  test("LIMIT: records cut from the end leave a shorter chain that still verifies", () => {
    const records = reread(chainOf(base));
    records.pop();
    records.pop();
    assert.equal(verifyChain(records).status, "intact", "a chain alone cannot show tail truncation");
  });
});

describe("flight recorder", () => {
  function recordFlight(id: string): { ws: string; file: string } {
    const ws = workspace();
    const flight = new FlightRecorder(ws, id);
    flight.startSession({ model: "m", endpoint: "http://127.0.0.1:1/v1", taskPrompt: "do the thing" });
    flight.recordTurnStart(1, "do the thing");
    flight.recordToolCall(1, "c1", "read_file", { path: "a.ts" });
    flight.recordToolResult(1, "c1", "read_file", true, "contents", 3);
    flight.recordFileDiff(2, "a.ts", "@@ -1 +1 @@\n-a\n+b");
    flight.recordSessionEnd("done", true);
    return { ws, file: flight.getLogPath() };
  }
  const lines = (file: string): string[] => fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const write = (file: string, rows: string[]): void => fs.writeFileSync(file, rows.join("\n") + "\n");

  test("a recorded flight reads back intact and closed, each record linked to the one before", () => {
    const { ws, file } = recordFlight("flight-intact");
    const parsed = lines(file).map((l) => JSON.parse(l));
    assert.deepEqual(parsed.map((e) => e.chain.seq), [0, 1, 2, 3, 4, 5]);
    for (let i = 1; i < parsed.length; i++) assert.equal(parsed[i].chain.prev, parsed[i - 1].chain.hash);
    const { events, integrity } = FlightPlayer.loadFlight(ws, "flight-intact");
    assert.equal(events.length, 6);
    assert.deepEqual([integrity.chain.status, integrity.closed], ["intact", true]);
    assert.equal(FlightPlayer.describeIntegrity(integrity), "chain intact (6 records), closed by its session end");
  });

  test("a failed append is reported to the caller and makes later flight evidence unverifiable", () => {
    const ws = workspace();
    const flight = new FlightRecorder(ws, "flight-append-failure");
    flight.startSession({ model: "m", endpoint: "http://127.0.0.1:1/v1" });
    const file = flight.getLogPath();
    const saved = `${file}.saved`;
    fs.renameSync(file, saved);
    fs.mkdirSync(file);

    let skipped: ReturnType<typeof flight.recordToolCall>;
    try {
      skipped = flight.recordToolCall(1, "c1", "read_file", { path: "a.ts" });
    } finally {
      fs.rmdirSync(file);
      fs.renameSync(saved, file);
    }

    assert.equal(skipped.payload.recordingSkipped, true);
    assert.equal(skipped.payload.reason, "append_failed");
    assert.equal(skipped.chain, undefined, "a skipped event must not look like a persisted chain record");

    flight.recordSessionEnd("done", true);
    const { integrity } = FlightPlayer.loadFlight(ws, "flight-append-failure");
    assert.deepEqual([integrity.chain.status, integrity.closed], ["broken", true]);
    assert.match(FlightPlayer.describeIntegrity(integrity), /CHAIN BROKEN/);
  });

  test("a sanitization failure does not let later flight evidence appear complete", () => {
    const ws = workspace();
    const flight = new FlightRecorder(ws, "flight-sanitization-failure");
    flight.startSession({ model: "m", endpoint: "http://127.0.0.1:1/v1" });
    const boundary = InformationFlowBoundary.getGlobalInstance();
    const redact = boundary.redactForTelemetry;
    boundary.redactForTelemetry = (() => { throw new Error("classifier detail must not escape"); }) as typeof redact;
    const warnings: string[] = [];
    const emitWarning = process.emitWarning;
    process.emitWarning = ((warning: string | Error) => { warnings.push(String(warning)); }) as typeof process.emitWarning;
    let skipped: ReturnType<typeof flight.recordToolCall>;
    try {
      skipped = flight.recordToolCall(1, "c1", "read_file", { path: "a.ts" });
    } finally {
      boundary.redactForTelemetry = redact;
    }

    assert.equal(skipped.payload.recordingSkipped, true);
    assert.equal(skipped.payload.reason, "sanitization_failed");
    // A new process/recorder must preserve the known omission and must not resume the chain.
    let integrity: ReturnType<typeof FlightPlayer.loadFlight>["integrity"];
    try {
      const resumed = new FlightRecorder(ws, "flight-sanitization-failure");
      resumed.recordSessionEnd("done", true);
      resumed.recordThought(2, "still degraded");
      integrity = FlightPlayer.loadFlight(ws, "flight-sanitization-failure").integrity;
    } finally {
      process.emitWarning = emitWarning;
    }
    assert.deepEqual([integrity.chain.status, integrity.recordingSkipped], ["broken", true]);
    assert.match(FlightPlayer.describeIntegrity(integrity), /recording skipped one or more events/);
    assert.equal(warnings.length, 2, "each recorder warns once, including after resuming a degraded log");
    assert.match(warnings[0], /replay evidence is incomplete/);
    assert.doesNotMatch(fs.readFileSync(flight.getLogPath(), "utf8"), /classifier detail must not escape/);
    assert.ok(lines(flight.getLogPath()).some((line) => JSON.parse(line).type === "recording_gap"));
  });

  test("a skip on the first record is reported as missing evidence, not legacy unchained history", () => {
    const ws = workspace();
    const flight = new FlightRecorder(ws, "flight-first-skip");
    const boundary = InformationFlowBoundary.getGlobalInstance();
    const redact = boundary.redactForTelemetry;
    const emitWarning = process.emitWarning;
    process.emitWarning = (() => {}) as typeof process.emitWarning;
    boundary.redactForTelemetry = (() => { throw new Error("private classifier detail"); }) as typeof redact;
    try {
      flight.startSession({ model: "m", endpoint: "http://127.0.0.1:1/v1" });
    } finally {
      boundary.redactForTelemetry = redact;
      process.emitWarning = emitWarning;
    }
    const { integrity } = FlightPlayer.loadFlight(ws, "flight-first-skip");
    assert.equal(integrity.recordingSkipped, true);
    assert.match(FlightPlayer.describeIntegrity(integrity), /recording skipped one or more events/);
    assert.doesNotMatch(FlightPlayer.describeIntegrity(integrity), /written before hash chaining/);
    const home = makeHome();
    tempHomes.push(home);
    const replay = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", "replay", "flight-first-skip", "-w", ws, "--delay", "0"], {
      cwd: CLI_DIR,
      encoding: "utf8",
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
    });
    assert.deepEqual([replay.status, replay.stderr], [0, ""]);
    assert.match(replay.stdout, /Record integrity: recording skipped one or more events; replay evidence is incomplete/);
  });

  test("editing one record on disk is detected at that record", () => {
    const { ws, file } = recordFlight("flight-edited");
    const rows = lines(file);
    assert.ok(rows[3].includes('"success":true'));
    rows[3] = rows[3].replace('"success":true', '"success":false');
    write(file, rows);
    const { integrity } = FlightPlayer.loadFlight(ws, "flight-edited");
    assert.deepEqual([integrity.chain.status, (integrity.chain as any).at, (integrity.chain as any).problem], ["broken", 3, "edited"]);
    assert.match(FlightPlayer.describeIntegrity(integrity), /CHAIN BROKEN at position 4 of 6/);
  });

  test("`replay` prints the chain verdict, so an edited log is named at the CLI (GV-3)", () => {
    const { ws, file } = recordFlight("flight-replay-edited");
    const rows = lines(file);
    rows[3] = rows[3].replace('"success":true', '"success":false');
    write(file, rows);
    const home = makeHome();
    tempHomes.push(home);
    const out = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/index.ts", "replay", "flight-replay-edited", "-w", ws, "--delay", "0"],
      {
        cwd: CLI_DIR,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          XDG_DATA_HOME: path.join(home, ".local/share"),
          XDG_STATE_HOME: path.join(home, ".local/state"),
          XDG_CACHE_HOME: path.join(home, ".cache"),
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
      },
    );
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /Record integrity: CHAIN BROKEN at position 4 of 6/);
  });

  test("removing a record from the middle is detected where the gap is", () => {
    const { ws, file } = recordFlight("flight-gap");
    const rows = lines(file);
    rows.splice(2, 1);
    write(file, rows);
    const { integrity } = FlightPlayer.loadFlight(ws, "flight-gap");
    assert.deepEqual([integrity.chain.status, (integrity.chain as any).at, (integrity.chain as any).problem], ["broken", 2, "out_of_order"]);
  });

  test("cutting records off the end leaves an intact chain that is reported as not closed", () => {
    const { ws, file } = recordFlight("flight-cut");
    write(file, lines(file).slice(0, 4));
    const { integrity } = FlightPlayer.loadFlight(ws, "flight-cut");
    assert.deepEqual([integrity.chain.status, integrity.closed], ["intact", false]);
    assert.match(FlightPlayer.describeIntegrity(integrity), /not closed: no session end \(still recording, stopped early, or records are missing from the end\)/);
  });

  test("a line that is not a record is reported, and is still left out of the replayed events", () => {
    const { ws, file } = recordFlight("flight-garbage");
    const rows = lines(file);
    rows.splice(1, 0, "{not json");
    write(file, rows);
    const { events, integrity } = FlightPlayer.loadFlight(ws, "flight-garbage");
    assert.equal(events.length, 6);
    assert.deepEqual([integrity.chain.status, (integrity.chain as any).at, (integrity.chain as any).problem], ["broken", 1, "unlinked"]);
  });

  test("a flight log written before chaining reads as unchained, and replays as before", () => {
    const ws = workspace();
    const dir = path.join(ws, ".nexus", "flights");
    fs.mkdirSync(dir, { recursive: true });
    const legacy = [
      { eventId: "evt-1", timestamp: "2026-01-01T00:00:00.000Z", type: "session_start", step: 0, payload: { flightId: "legacy", recordedAt: "2026-01-01T00:00:00.000Z", workspace: ws, model: "m", endpoint: "e", status: "in_progress" } },
      { eventId: "evt-2", timestamp: "2026-01-01T00:00:01.000Z", type: "session_end", payload: { summary: "ok", success: true, durationMs: 1 } },
    ];
    fs.writeFileSync(path.join(dir, "legacy.flightlog"), legacy.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const { manifest, events, integrity } = FlightPlayer.loadFlight(ws, "legacy");
    assert.equal(manifest.flightId, "legacy");
    assert.equal(events.length, 2);
    assert.equal(integrity.chain.status, "unchained");
    assert.match(FlightPlayer.describeIntegrity(integrity), /not chained/);
    // A recorder that continues it keeps it unchained: links are not started half way through a log.
    new FlightRecorder(ws, "legacy").recordThought(1, "later");
    const after = FlightPlayer.loadFlight(ws, "legacy");
    assert.equal(after.events.length, 3);
    assert.equal(after.integrity.chain.status, "unchained");
  });

  test("a second recorder on the same flight continues the chain from the last record", () => {
    const { ws, file } = recordFlight("flight-resumed");
    const again = new FlightRecorder(ws, "flight-resumed");
    again.recordThought(7, "second process");
    again.recordSessionEnd("done again", true);
    const parsed = lines(file).map((l) => JSON.parse(l));
    assert.deepEqual(parsed.map((e) => e.chain.seq), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual([FlightPlayer.loadFlight(ws, "flight-resumed").integrity.chain.status, FlightPlayer.loadFlight(ws, "flight-resumed").integrity.closed], ["intact", true]);
  });

  test("records appended to a broken log do not hide the break", () => {
    const { ws, file } = recordFlight("flight-broken-resumed");
    const rows = lines(file);
    rows[1] = rows[1].replace("do the thing", "do another thing");
    write(file, rows);
    new FlightRecorder(ws, "flight-broken-resumed").recordThought(9, "after the edit");
    const { events, integrity } = FlightPlayer.loadFlight(ws, "flight-broken-resumed");
    assert.equal(events.length, 7);
    assert.deepEqual([integrity.chain.status, (integrity.chain as any).at, (integrity.chain as any).problem], ["broken", 1, "edited"]);
  });

  test("the link covers the record as stored: a redacted payload verifies, and the secret is not on disk", () => {
    const ws = workspace();
    const flight = new FlightRecorder(ws, "flight-redacted");
    const secret = `ghp_${"z".repeat(36)}`;
    flight.startSession({ model: "m", endpoint: "e", taskPrompt: `use ${secret}` });
    flight.recordToolCall(1, "c1", "run_command", { command: `curl -H 'Authorization: Bearer ${secret}'` });
    flight.recordSessionEnd("done", true);
    assert.equal(fs.readFileSync(flight.getLogPath(), "utf8").includes(secret), false);
    assert.equal(FlightPlayer.loadFlight(ws, "flight-redacted").integrity.chain.status, "intact");
  });
});

describe("verification-configuration attempt log", () => {
  function managerWithAttempts(): SecurityManager {
    const manager = new SecurityManager(workspace());
    manager.recordVerificationAttempt("test/a.test.ts", "test" as any, "edit_file", "blocked" as any, "implementer");
    manager.recordVerificationAttempt(".github/workflows/ci.yml", "ci" as any, "write_file", "blocked" as any);
    manager.recordVerificationAttempt("test/b.test.ts", "test" as any, "run_command", "auto-recorded" as any, "tester");
    return manager;
  }

  test("attempts are linked as they are recorded and verify after a save and restore", () => {
    const manager = managerWithAttempts();
    assert.equal(manager.verificationAttemptsIntegrity().status, "intact");
    const saved = JSON.parse(JSON.stringify(manager.getVerificationAttempts()));
    assert.deepEqual(saved.map((a: any) => a.chain.seq), [0, 1, 2]);
    const next = new SecurityManager(workspace());
    next.restoreVerificationAttempts(saved);
    next.recordVerificationAttempt("test/c.test.ts", "test" as any, "edit_file", "blocked" as any);
    assert.deepEqual(next.getVerificationAttempts().map((a) => a.chain?.seq), [0, 1, 2, 3]);
    assert.equal(next.verificationAttemptsIntegrity().status, "intact");
  });

  test("a saved attempt whose decision was rewritten is detected, and later attempts do not hide it", () => {
    const saved = JSON.parse(JSON.stringify(managerWithAttempts().getVerificationAttempts()));
    saved[0].decision = "approved";
    const next = new SecurityManager(workspace());
    next.restoreVerificationAttempts(saved);
    const before = next.verificationAttemptsIntegrity();
    assert.deepEqual([before.status, (before as any).at, (before as any).problem], ["broken", 0, "edited"]);
    next.recordVerificationAttempt("test/d.test.ts", "test" as any, "edit_file", "blocked" as any);
    assert.equal(next.getVerificationAttempts().length, 4, "nothing is dropped");
    const afterwards = next.verificationAttemptsIntegrity();
    assert.deepEqual([afterwards.status, (afterwards as any).at], ["broken", 0]);
  });

  test("a saved attempt that was deleted from the middle is detected", () => {
    const saved = JSON.parse(JSON.stringify(managerWithAttempts().getVerificationAttempts()));
    saved.splice(1, 1);
    const next = new SecurityManager(workspace());
    next.restoreVerificationAttempts(saved);
    const verdict = next.verificationAttemptsIntegrity();
    assert.deepEqual([verdict.status, (verdict as any).at, (verdict as any).problem], ["broken", 1, "out_of_order"]);
  });

  test("attempts saved before chaining stay unchained; a session with none starts a chain", () => {
    const legacy = [{ path: "test/a.test.ts", class: "test", tool: "edit_file", decision: "blocked", role: null, timestamp: "2026-01-01T00:00:00.000Z" }];
    const old = new SecurityManager(workspace());
    old.restoreVerificationAttempts(legacy as any);
    old.recordVerificationAttempt("test/b.test.ts", "test" as any, "edit_file", "blocked" as any);
    assert.equal(old.verificationAttemptsIntegrity().status, "unchained");
    const fresh = new SecurityManager(workspace());
    fresh.restoreVerificationAttempts(undefined);
    fresh.recordVerificationAttempt("test/b.test.ts", "test" as any, "edit_file", "blocked" as any);
    assert.equal(fresh.verificationAttemptsIntegrity().status, "intact");
    assert.equal(fresh.getVerificationAttempts()[0].chain?.seq, 0);
  });
});
