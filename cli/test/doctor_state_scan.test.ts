/**
 * A very large ~/.nexus must not make `nexus doctor` lie about the endpoint. Reported against 1.2.2: with 1.5 million
 * files of old upgrade backups under ~/.nexus/backups, the permissions check walked the tree in one synchronous pass,
 * held the event loop for about 150 s, and every other check's timer expired: "endpoint.reachable: The endpoint did
 * not answer" for a gateway that answered in 10 ms, plus tui, shell and engine "did not finish within 5000 ms".
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATE_SCAN_MAX_ENTRIES, runDoctor, type DoctorReport } from "../src/doctor.js";
import type { HarnessConfig } from "../src/types.js";

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const find = (report: DoctorReport, id: string) => report.findings.filter((f) => f.id === id);
let workspace: string;
let savedHome: string | undefined;
let server: http.Server;
let endpoint: string;
const homes: string[] = [];

before(async () => {
  savedHome = process.env.HOME;
  workspace = tmp("nexus-doctor-scan-ws-");
  // An endpoint that answers after a short delay: the request is in flight while the state scan runs.
  server = http.createServer((req, res) => {
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url?.includes("/models") ? { data: [{ id: "m" }] } : { choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }));
    }, 60);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  endpoint = `http://127.0.0.1:${(server.address() as any).port}/v1`;
});
after(async () => {
  process.env.HOME = savedHome;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of [workspace, ...homes]) fs.rmSync(dir, { recursive: true, force: true });
});

const cfg = (): HarnessConfig => ({ endpoint, model: "m", maxSteps: 30, temperature: 0, workspace, shell: "bash" }) as HarnessConfig;

/** A home whose ~/.nexus holds `count` private files under backups/, spread over directories of 500. */
function homeWithBackups(count: number): string {
  const home = tmp("nexus-doctor-scan-home-");
  homes.push(home);
  process.env.HOME = home;
  const nexus = path.join(home, ".nexus");
  for (const dir of ["sessions", "tasks"]) fs.mkdirSync(path.join(nexus, dir), { recursive: true, mode: 0o700 });
  fs.chmodSync(nexus, 0o700);
  const backup = path.join(nexus, "backups", "state-backup-2026-11-12T00-00-00-000Z", "state", "tasks");
  for (let i = 0; i < count; i++) {
    if (i % 500 === 0) fs.mkdirSync(path.join(backup, `d${i / 500}`), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(backup, `d${Math.floor(i / 500)}`, `t${i}.json`), "", { mode: 0o600 });
  }
  return home;
}

describe("doctor on a very large state directory", () => {
  test("the endpoint is still reported reachable, timers keep firing, and the scan says it was partial", async () => {
    const home = homeWithBackups(20_000);
    // Something to find in live state: it must be reported even though the scan stops later, in the backups.
    const exposed = path.join(home, ".nexus", "sessions", "exposed.json");
    fs.writeFileSync(exposed, "{}", { mode: 0o644 });
    fs.chmodSync(exposed, 0o644);

    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    let report: DoctorReport;
    // The entry limit, not the clock, ends the scan: the result does not depend on how fast the host's disk is.
    process.env.NEXUS_DOCTOR_STATE_SCAN_ENTRIES = "5000";
    try {
      report = await runDoctor({ home, timeoutMs: 20_000, config: cfg() });
    } finally {
      delete process.env.NEXUS_DOCTOR_STATE_SCAN_ENTRIES;
      clearInterval(timer);
    }

    const reachable = find(report, "endpoint.reachable");
    assert.equal(reachable.length, 1);
    assert.equal(reachable[0].status, "pass", `endpoint.reachable: ${reachable[0].explanation}`);

    const permissions = find(report, "state.permissions");
    const partial = permissions.find((f) => /Only part of ~\/\.nexus was checked/.test(f.explanation));
    assert.ok(partial, `a partial-scan finding is reported; got: ${permissions.map((f) => f.explanation).join(" | ")}`);
    assert.equal(partial!.status, "warn");
    assert.match(partial!.explanation, /: 5000 entries were examined before the limit of 5000 entries was reached\. The rest was not checked\./);
    assert.ok(partial!.evidence?.some((e) => /stopped in \.nexus\/backups\//.test(e)), "it stopped inside the backups, not in live state");
    assert.ok(!permissions.some((f) => f.status === "pass"), "a tree that was only partly read is never reported as private");
    assert.ok(permissions.some((f) => f.explanation.includes("sessions/exposed.json")), "live state was examined first and its problem reported");
    // 5000 entries with a turn of the event loop every 500: the scan gave way at least nine times.
    assert.ok(ticks >= 5, `timers fired while the doctor ran (${ticks} ticks)`);
  });

  test("the scan itself gives the event loop a turn: a timer fires between its start and its end", async () => {
    const home = homeWithBackups(6_000);
    let firedDuringScan = 0;
    process.env.NEXUS_DOCTOR_STATE_SCAN_ENTRIES = "100000";
    const timer = setInterval(() => { firedDuringScan++; }, 0);
    try {
      const report = await runDoctor({ home, timeoutMs: 20_000, config: cfg() });
      assert.deepEqual(find(report, "state.permissions").map((f) => f.status), ["pass"], "6000 private files are scanned in full");
    } finally {
      delete process.env.NEXUS_DOCTOR_STATE_SCAN_ENTRIES;
      clearInterval(timer);
    }
    assert.ok(firedDuringScan >= 5, `timers fired (${firedDuringScan})`);
  });

  test("an unusable entry limit falls back to the default", async () => {
    const home = homeWithBackups(300);
    for (const value of ["0", "-5", "1.5", "many", ""]) {
      process.env.NEXUS_DOCTOR_STATE_SCAN_ENTRIES = value;
      try {
        const report = await runDoctor({ home, timeoutMs: 20_000, config: cfg() });
        assert.deepEqual(find(report, "state.permissions").map((f) => f.status), ["pass"], `limit ${JSON.stringify(value)}`);
      } finally {
        delete process.env.NEXUS_DOCTOR_STATE_SCAN_ENTRIES;
      }
    }
  });

  test("a small state directory is scanned in full and reported private, with no partial-scan warning", async () => {
    const home = homeWithBackups(300);
    const report = await runDoctor({ home, timeoutMs: 20_000, config: cfg() });
    const permissions = find(report, "state.permissions");
    assert.deepEqual(permissions.map((f) => f.status), ["pass"], permissions.map((f) => f.explanation).join(" | "));
  });

  test("a readable file inside the backups is found when the scan reaches it", async () => {
    const home = homeWithBackups(300);
    const leaked = path.join(home, ".nexus", "backups", "state-backup-2026-11-12T00-00-00-000Z", "state", "tasks", "d0", "t7.json");
    fs.chmodSync(leaked, 0o644);
    const report = await runDoctor({ home, timeoutMs: 20_000, config: cfg() });
    const permissions = find(report, "state.permissions");
    assert.ok(permissions.some((f) => f.status === "warn" && f.explanation.includes("t7.json")), permissions.map((f) => f.explanation).join(" | "));
  });

  test("the entry limit is a number a real state directory can exceed only by being enormous", () => {
    assert.ok(STATE_SCAN_MAX_ENTRIES >= 100_000);
  });
});
