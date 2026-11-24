/**
 * BG-2: the pure part of schedules (core/schedule.ts): what a cron expression, an interval and a one-shot time accept,
 * and the slot a trigger names next. Every time is UTC; a gap in service never produces a burst of slots.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cronNextAfter, describeTrigger, MAX_SLOT_SCAN, nextAfter, parseCron, parseEvery, parseOnceAt, scanSlots, ScheduleSpecError, validateTrigger, type ScheduleTrigger } from "../src/core/schedule.js";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
const cron = (expr: string): ScheduleTrigger => ({ kind: "cron", expr });
const next = (expr: string, after: string) => iso(nextAfter(cron(expr), 0, at(after)));

test("cron: accepted expressions", () => {
  for (const expr of ["*/5 * * * *", "0 3 * * 1-5", "0,30 9-17 * * *", "0 0 1 1 *", "15 14 1 * *", "0 22 * * 7", "0-59/15 * * * *", "0 0 29 2 *", "5 4 * * 0"]) {
    assert.doesNotThrow(() => parseCron(expr), expr);
  }
  assert.deepEqual([...parseCron("0 22 * * 7").dayOfWeek.allowed], [0], "7 is Sunday, the same as 0");
  assert.deepEqual([...parseCron("*/20 * * * *").minute.allowed], [0, 20, 40]);
});

test("cron: invalid strings are refused with a reason that names the field", () => {
  const table: Array<[string, RegExp]> = [
    ["", /5 fields/],
    ["* * * *", /5 fields/],
    ["* * * * * *", /5 fields/],
    ["0 0 0 0 0 0", /5 fields/],
    ["*/0 * * * *", /step of 0/],
    ["60 * * * *", /outside 0-59/],
    ["* 24 * * *", /outside 0-23/],
    ["* * 0 * *", /outside 1-31/],
    ["* * 32 * *", /outside 1-31/],
    ["* * * 13 *", /outside 1-12/],
    ["* * * 0 *", /outside 1-12/],
    ["* * * * 8", /outside 0-7/],
    ["* * * JAN *", /names such as MON or JAN/],
    ["* * * * MON", /names such as MON or JAN/],
    ["@daily", /shortcuts/],
    ["@reboot", /shortcuts/],
    ["5-1 * * * *", /backwards/],
    ["1-2-3 * * * *", /not a range/],
    ["1/5 * * * *", /needs '\*' or a range/],
    ["*/100 * * * *", /step '100' is not a number/],
    ["*/61 * * * *", /larger than/],
    ["0-5/9 * * * *", /larger than/],
    ["1,,2 * * * *", /empty list item/],
    ["*/5/2 * * * *", /more than one/],
    ["-1 * * * *", /not a number/],
    ["1.5 * * * *", /not a number/],
    ["0x10 * * * *", /not a number/],
    [" * * * * *", /single spaces/],
    ["*  * * * *", /single spaces/],
    ["*\t* * * *", /single spaces|5 fields/],
    ["* * * * *\n", /single spaces/],
    ["* * * * ;", /not a number/],
    ["*".repeat(101), /at most 100/],
    ["١ * * * *", /single spaces/],
  ];
  for (const [expr, pattern] of table) {
    assert.throws(() => parseCron(expr), (error: unknown) => error instanceof ScheduleSpecError && pattern.test(error.message), `${JSON.stringify(expr)} -> ${pattern}`);
  }
});

test("cron: slots closer than five minutes are refused like an interval below the floor (validateTrigger), the rest are accepted", () => {
  // Includes a restricted day-of-month list whose consecutive days wrap midnight in one minute (59,0 at 23,0 on 1,2).
  for (const expr of ["* * * * *", "*/4 * * * *", "0,2 * * * *", "0-4 3 * * *", "1,58 0,23 * * *", "59,0 23,0 1,2 * *"]) {
    assert.throws(() => validateTrigger({ kind: "cron", expr }), (error: unknown) => error instanceof ScheduleSpecError && /at least 5 minutes apart/.test(error.message), expr);
  }
  for (const expr of ["*/5 * * * *", "0,5 * * * *", "58,3 * * * *", "0 3 * * 1-5", "59 23 * * 1", "56 23 * * 1,2", "0 0,12 1 * *", "59,0 23,0 1,15 * *"]) {
    assert.doesNotThrow(() => validateTrigger({ kind: "cron", expr }), expr);
  }
  // The pure slot functions still accept a one-minute expression: the floor is a rule of what may be scheduled.
  assert.equal(nextAfter(cron("* * * * *"), 0, at("2026-01-01T00:00:30Z")) , at("2026-01-01T00:01:00Z"));
});

test("cron: expressions that never name a real date are refused at validateTrigger", () => {
  for (const expr of ["0 0 30 2 *", "0 0 31 2 *", "0 0 31 4 *"]) {
    assert.throws(() => validateTrigger({ kind: "cron", expr }), (error: unknown) => error instanceof ScheduleSpecError && /never matches/.test(error.message), expr);
  }
});

test("cron: next slots across hours, days, month ends, years and leap days", () => {
  assert.equal(next("*/15 * * * *", "2026-01-01T00:07:30Z"), "2026-01-01T00:15:00.000Z");
  assert.equal(next("*/15 * * * *", "2026-01-01T00:15:00Z"), "2026-01-01T00:30:00.000Z", "strictly after: the slot at the instant itself is not the next one");
  assert.equal(next("0 3 * * *", "2026-01-01T03:00:00Z"), "2026-01-02T03:00:00.000Z");
  assert.equal(next("0 0 31 * *", "2026-04-01T00:00:00Z"), "2026-05-31T00:00:00.000Z", "April has no 31st");
  assert.equal(next("0 0 1 * *", "2026-12-31T23:59:59Z"), "2027-01-01T00:00:00.000Z", "year end");
  assert.equal(next("0 0 29 2 *", "2026-03-01T00:00:00Z"), "2028-02-29T00:00:00.000Z", "the next leap day is two years away");
  assert.equal(next("0 0 29 2 *", "2028-02-29T00:00:00Z"), "2032-02-29T00:00:00.000Z");
  assert.equal(next("59 23 28 2 *", "2026-02-28T23:59:00Z"), "2027-02-28T23:59:00.000Z");
  assert.equal(next("0 12 * * 1", "2026-11-24T00:00:00Z"), "2026-11-30T12:00:00.000Z", "2026-11-24 is a Tuesday; the next Monday");
  assert.equal(next("0 0 13 * 5", "2026-11-01T00:00:00Z"), "2026-11-06T00:00:00.000Z", "day-of-month and day-of-week both restricted: either matches (a Friday comes first)");
  assert.equal(next("0 0 * * 5", "2026-11-01T00:00:00Z"), "2026-11-06T00:00:00.000Z");
});

test("cron: February with a restricted month keeps its remaining days", () => {
  assert.equal(next("0 0 * 2 *", "2026-02-27T12:00:00Z"), "2026-02-28T00:00:00.000Z");
  assert.equal(next("0 0 * 2 *", "2026-02-28T00:00:00Z"), "2027-02-01T00:00:00.000Z");
  assert.equal(next("0 0 * 2 *", "2028-02-28T00:00:00Z"), "2028-02-29T00:00:00.000Z");
});

test("cron: there is no daylight saving and a day always has twenty-four hours", () => {
  // The days of the common DST changes: the hour is neither skipped nor doubled.
  assert.equal(next("30 2 * * *", "2026-03-08T00:00:00Z"), "2026-03-08T02:30:00.000Z");
  assert.equal(next("30 1 * * *", "2026-11-01T00:00:00Z"), "2026-11-01T01:30:00.000Z");
  assert.equal(next("30 1 * * *", "2026-11-01T01:30:00Z"), "2026-11-02T01:30:00.000Z");
  const day = at("2026-03-09T00:00:00Z") - at("2026-03-08T00:00:00Z");
  assert.equal(day, 24 * 3600 * 1000);
});

test("cron: an expression that never matches within the horizon has no next slot", () => {
  assert.equal(cronNextAfter(parseCron("0 0 30 2 *"), at("2026-01-01T00:00:00Z")), undefined, "30 February does not exist");
  assert.equal(cronNextAfter(parseCron("0 0 31 4 *"), at("2026-01-01T00:00:00Z")), undefined, "April has no 31st");
  assert.equal(nextAfter(cron("0 0 30 2 *"), 0, at("2026-01-01T00:00:00Z")), undefined);
});

test("every: slots keep their phase from the anchor and never come in a burst", () => {
  const anchor = at("2026-11-24T00:00:00Z");
  const trigger: ScheduleTrigger = { kind: "every", seconds: 3600 };
  assert.equal(iso(nextAfter(trigger, anchor, anchor)), "2026-11-24T01:00:00.000Z", "the first run is one period after creation");
  assert.equal(iso(nextAfter(trigger, anchor, at("2026-11-24T01:00:00Z"))), "2026-11-24T02:00:00.000Z");
  assert.equal(iso(nextAfter(trigger, anchor, at("2026-11-24T01:59:59Z"))), "2026-11-24T02:00:00.000Z");
  // Three days later (the runner was down): the next slot is on the old grid, not "now + 1h".
  assert.equal(iso(nextAfter(trigger, anchor, at("2026-11-27T05:20:00Z"))), "2026-11-27T06:00:00.000Z");
  assert.equal(iso(nextAfter(trigger, anchor, anchor - 10 * 3600_000)), "2026-11-24T01:00:00.000Z", "a clock before the anchor still starts at the first slot");
});

test("every: a three-day gap is counted exactly and has one first and one last slot", () => {
  const anchor = at("2026-11-20T00:00:00Z");
  const scan = scanSlots({ kind: "every", seconds: 3600 }, anchor, at("2026-11-21T00:00:00Z"), at("2026-11-24T00:00:00Z"));
  assert.equal(scan.count, 72);
  assert.equal(iso(scan.first), "2026-11-21T01:00:00.000Z");
  assert.equal(iso(scan.last), "2026-11-24T00:00:00.000Z");
  assert.equal(scan.truncated, false);
  assert.deepEqual(scanSlots({ kind: "every", seconds: 3600 }, anchor, at("2026-11-24T00:00:00Z"), at("2026-11-24T00:59:59Z")), { count: 0, first: undefined, last: undefined, truncated: false });
});

test("scanSlots on cron counts exactly and stops at its limit with a flag, never a burst of work", () => {
  const scan = scanSlots(cron("*/10 * * * *"), 0, at("2026-11-24T00:00:00Z"), at("2026-11-24T01:00:00Z"));
  assert.equal(scan.count, 6);
  assert.equal(iso(scan.first), "2026-11-24T00:10:00.000Z");
  assert.equal(iso(scan.last), "2026-11-24T01:00:00.000Z");
  const long = scanSlots(cron("* * * * *"), 0, at("2020-01-01T00:00:00Z"), at("2026-11-24T00:00:00Z"));
  assert.equal(long.truncated, true);
  assert.equal(long.count, MAX_SLOT_SCAN);
  const everyLong = scanSlots({ kind: "every", seconds: 300 }, 0, 0, at("2026-11-24T00:00:00Z"));
  assert.equal(everyLong.truncated, true);
  assert.equal(everyLong.count, MAX_SLOT_SCAN);
});

test("once: one slot, never again", () => {
  const trigger: ScheduleTrigger = { kind: "once", at: "2026-12-01T03:00:00.000Z" };
  assert.equal(iso(nextAfter(trigger, 0, at("2026-11-24T00:00:00Z"))), "2026-12-01T03:00:00.000Z");
  assert.equal(nextAfter(trigger, 0, at("2026-12-01T03:00:00Z")), undefined);
  assert.equal(nextAfter(trigger, 0, at("2027-01-01T00:00:00Z")), undefined);
  assert.equal(scanSlots(trigger, 0, at("2026-11-30T00:00:00Z"), at("2026-12-02T00:00:00Z")).count, 1);
});

test("intervals: accepted forms and the bounds", () => {
  assert.equal(parseEvery("300"), 300);
  assert.equal(parseEvery("300s"), 300);
  assert.equal(parseEvery("5m"), 300);
  assert.equal(parseEvery("2h"), 7200);
  assert.equal(parseEvery("30d"), 30 * 86_400);
  for (const bad of ["", "299", "4m", "31d", "0", "-5m", "5 m", "1.5h", "five", "5w", "9999999999", "1e3"]) {
    assert.throws(() => parseEvery(bad), ScheduleSpecError, JSON.stringify(bad));
  }
});

test("once times: UTC only, a real instant, normalised", () => {
  assert.equal(parseOnceAt("2026-12-01T03:00:00Z"), "2026-12-01T03:00:00.000Z");
  assert.equal(parseOnceAt("2028-02-29T23:59:59.5Z"), "2028-02-29T23:59:59.500Z");
  for (const bad of ["2026-12-01T03:00:00", "2026-12-01 03:00:00Z", "2026-12-01T03:00:00+01:00", "2026-12-01", "2026-02-30T00:00:00Z", "2027-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-12-01T24:00:00Z", "2026-12-01T03:60:00Z", "tomorrow", ""]) {
    assert.throws(() => parseOnceAt(bad), ScheduleSpecError, JSON.stringify(bad));
  }
});

test("validateTrigger normalises and refuses", () => {
  assert.deepEqual(validateTrigger({ kind: "once", at: "2026-12-01T03:00:00Z" }), { kind: "once", at: "2026-12-01T03:00:00.000Z" });
  assert.throws(() => validateTrigger({ kind: "every", seconds: 299 }), ScheduleSpecError);
  assert.throws(() => validateTrigger({ kind: "every", seconds: 300.5 }), ScheduleSpecError);
  assert.throws(() => validateTrigger({ kind: "cron", expr: "* * *" }), ScheduleSpecError);
  assert.throws(() => validateTrigger({ kind: "webhook" } as unknown as ScheduleTrigger), ScheduleSpecError);
});

test("descriptions", () => {
  assert.equal(describeTrigger(cron("0 3 * * *")), "cron 0 3 * * * (UTC)");
  assert.equal(describeTrigger({ kind: "every", seconds: 900 }), "every 15m");
  assert.equal(describeTrigger({ kind: "every", seconds: 7200 }), "every 2h");
  assert.equal(describeTrigger({ kind: "every", seconds: 90_000 }), "every 25h");
  assert.equal(describeTrigger({ kind: "once", at: "2026-12-01T03:00:00.000Z" }), "once at 2026-12-01T03:00:00.000Z");
});
