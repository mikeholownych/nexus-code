/**
 * BG-2: when a schedule is due. Pure: no clock, no file, no process. Triggers are `cron` (five fields), `every` (a
 * fixed number of seconds) and `once` (one instant). Every time is UTC: there is no time zone, so there is no daylight
 * saving shift, and a day always has 24 hours. Leap seconds do not exist here (Unix time), so a cron minute is always
 * 60 seconds. Leap days are real: `0 0 29 2 *` fires on 29 February only.
 *
 * A slot is one instant a trigger names. `nextAfter` gives the first slot strictly after an instant; it is the only
 * way the runner advances a schedule, so a slot can never be produced twice.
 */

export type ScheduleTrigger =
  | { kind: "cron"; expr: string }
  | { kind: "every"; seconds: number }
  | { kind: "once"; at: string };

export const MIN_EVERY_SECONDS = 300;
export const MAX_EVERY_SECONDS = 30 * 24 * 60 * 60;
export const MAX_CRON_LENGTH = 100;
/** How far a cron expression is searched for its next slot. Four years and a day: enough for 29 February. */
export const CRON_HORIZON_MS = 1462 * 24 * 60 * 60 * 1000;
/** The most slots one scan counts; a longer gap is reported as "at least" this many. */
export const MAX_SLOT_SCAN = 20_000;

export class ScheduleSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleSpecError";
  }
}

const MINUTE = 60_000;

// ---------------------------------------------------------------- cron

interface CronField {
  /** The allowed values; a bit per value. */
  allowed: ReadonlySet<number>;
  /** The field started with `*`: it does not restrict, and day-of-month and day-of-week then combine with AND. */
  star: boolean;
}

export interface CronSpec {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

const FIELD_NAMES = ["minute", "hour", "day-of-month", "month", "day-of-week"] as const;
const RANGES: ReadonlyArray<readonly [number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseNumber(field: string, text: string): number {
  if (!/^\d{1,2}$/.test(text)) throw new ScheduleSpecError(`cron ${field}: '${text.slice(0, 20)}' is not a number (names such as MON or JAN are not accepted).`);
  return Number(text);
}

function parseCronField(index: number, text: string): CronField {
  const field = FIELD_NAMES[index];
  const [min, max] = RANGES[index];
  if (text === "") throw new ScheduleSpecError(`cron ${field} is empty.`);
  const allowed = new Set<number>();
  for (const part of text.split(",")) {
    if (part === "") throw new ScheduleSpecError(`cron ${field} has an empty list item.`);
    const [rangeText, stepText, ...rest] = part.split("/");
    if (rest.length) throw new ScheduleSpecError(`cron ${field}: '${part.slice(0, 20)}' has more than one '/'.`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,2}$/.test(stepText)) throw new ScheduleSpecError(`cron ${field}: step '${stepText.slice(0, 20)}' is not a number.`);
      step = Number(stepText);
      if (step < 1) throw new ScheduleSpecError(`cron ${field}: a step of 0 never advances.`);
    }
    let from: number;
    let to: number;
    if (rangeText === "*") {
      from = min;
      // Day-of-week 7 is Sunday, an alias of 0 that `*` does not add twice.
      to = index === 4 ? 6 : max;
    } else if (rangeText.includes("-")) {
      const [a, b, ...more] = rangeText.split("-");
      if (more.length) throw new ScheduleSpecError(`cron ${field}: '${rangeText.slice(0, 20)}' is not a range.`);
      from = parseNumber(field, a);
      to = parseNumber(field, b);
      if (from > to) throw new ScheduleSpecError(`cron ${field}: the range ${from}-${to} is backwards.`);
    } else {
      from = parseNumber(field, rangeText);
      // `5/10` (a start with a step) is not standard cron; only a single value or a range or `*` takes a step.
      if (stepText !== undefined) throw new ScheduleSpecError(`cron ${field}: a step needs '*' or a range ('${part.slice(0, 20)}').`);
      to = from;
    }
    if (from < min || to > max) throw new ScheduleSpecError(`cron ${field}: ${from === to ? from : `${from}-${to}`} is outside ${min}-${max}.`);
    if (step > to - from + 1) throw new ScheduleSpecError(`cron ${field}: the step ${step} is larger than the range ${from}-${to}.`);
    for (let value = from; value <= to; value += step) allowed.add(index === 4 && value === 7 ? 0 : value);
  }
  return { allowed, star: text.startsWith("*") };
}

/** Parses five space-separated fields: minute hour day-of-month month day-of-week. Numbers, `*`, ranges, steps and lists only. */
export function parseCron(expr: string): CronSpec {
  if (typeof expr !== "string" || expr.length > MAX_CRON_LENGTH) throw new ScheduleSpecError(`a cron expression is at most ${MAX_CRON_LENGTH} characters.`);
  if (expr !== expr.trim() || /\s{2,}|[^\x20-\x7e]/.test(expr)) throw new ScheduleSpecError("a cron expression has single spaces between its fields and nothing else (no tabs, no surrounding blanks).");
  if (expr.startsWith("@")) throw new ScheduleSpecError("cron shortcuts such as @daily are not accepted; write the five fields.");
  const fields = expr.split(" ");
  if (fields.length !== 5) throw new ScheduleSpecError(`a cron expression has 5 fields (minute hour day-of-month month day-of-week); '${expr.slice(0, 40)}' has ${fields.length}.`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((text, index) => parseCronField(index, text));
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

/**
 * The smallest gap, in minutes, between two slots: within a day, and across midnight between any two consecutive
 * calendar days that both match (checked over four years, 2024 to 2027, so month ends, 29 February and year ends are all
 * seen). A trigger must not fire more often than `every` may: five minutes.
 */
export function cronMinGapMinutes(spec: CronSpec): number {
  const slots: number[] = [];
  for (const hour of [...spec.hour.allowed].sort((a, b) => a - b)) for (const minute of [...spec.minute.allowed].sort((a, b) => a - b)) slots.push(hour * 60 + minute);
  let gap = Infinity;
  for (let i = 1; i < slots.length; i++) gap = Math.min(gap, slots[i] - slots[i - 1]);
  const matches = (day: number) => {
    const d = new Date(day);
    return spec.month.allowed.has(d.getUTCMonth() + 1) && dayMatches(spec, d);
  };
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < 1461 && slots.length > 0; i++) {
    if (matches(start + i * 86_400_000) && matches(start + (i + 1) * 86_400_000)) {
      gap = Math.min(gap, 1440 + slots[0] - slots[slots.length - 1]);
      break;
    }
  }
  return gap;
}

function dayMatches(spec: CronSpec, date: Date): boolean {
  const dom = spec.dayOfMonth.allowed.has(date.getUTCDate());
  const dow = spec.dayOfWeek.allowed.has(date.getUTCDay());
  // Vixie cron: when both fields are restricted a day matches either; when one is `*`, both must hold.
  return spec.dayOfMonth.star || spec.dayOfWeek.star ? dom && dow : dom || dow;
}

/** The first minute strictly after `afterMs` that `spec` names, or undefined when none falls within the horizon. */
export function cronNextAfter(spec: CronSpec, afterMs: number): number | undefined {
  const limit = afterMs + CRON_HORIZON_MS;
  let at = Math.floor(afterMs / MINUTE) * MINUTE + MINUTE;
  while (at <= limit) {
    const d = new Date(at);
    const [y, m, day, h] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()];
    if (!spec.month.allowed.has(m + 1)) at = Date.UTC(y, m + 1, 1);
    else if (!dayMatches(spec, d)) at = Date.UTC(y, m, day + 1);
    else if (!spec.hour.allowed.has(h)) at = Date.UTC(y, m, day, h + 1);
    else if (!spec.minute.allowed.has(d.getUTCMinutes())) at += MINUTE;
    else return at;
  }
  return undefined;
}

// ---------------------------------------------------------------- every, once

/** `300`, `300s`, `5m`, `2h`, `1d`: a number of seconds, between five minutes and thirty days. */
export function parseEvery(text: string): number {
  const match = /^(\d{1,9})([smhd]?)$/.exec(text.trim());
  if (!match) throw new ScheduleSpecError(`'${text.slice(0, 30)}' is not an interval; write seconds or a number with s, m, h or d (for example 15m).`);
  const seconds = Number(match[1]) * ({ "": 1, s: 1, m: 60, h: 3600, d: 86_400 } as Record<string, number>)[match[2]];
  if (seconds < MIN_EVERY_SECONDS || seconds > MAX_EVERY_SECONDS) throw new ScheduleSpecError(`an interval is from ${MIN_EVERY_SECONDS} seconds (5m) to ${MAX_EVERY_SECONDS} seconds (30d); got ${seconds}.`);
  return seconds;
}

const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

/** A UTC instant written `YYYY-MM-DDTHH:MM:SSZ`; a date that does not exist (30 February) is refused rather than rolled over. */
export function parseOnceAt(text: string): string {
  const match = ISO_UTC.exec(text);
  if (!match) throw new ScheduleSpecError(`'${text.slice(0, 40)}' is not a UTC time; write it as 2026-12-01T03:00:00Z (the Z is required: there is no local time).`);
  const [y, mo, d, h, mi, s] = match.slice(1, 7).map(Number);
  const ms = Date.parse(text);
  const check = new Date(ms);
  if (Number.isNaN(ms) || check.getUTCFullYear() !== y || check.getUTCMonth() + 1 !== mo || check.getUTCDate() !== d || check.getUTCHours() !== h || check.getUTCMinutes() !== mi || check.getUTCSeconds() !== s) {
    throw new ScheduleSpecError(`'${text}' is not a real date and time.`);
  }
  return new Date(ms).toISOString();
}

/** A trigger from stored or typed parts, validated. The returned trigger is the normal form (an `at` is a full ISO string). */
export function validateTrigger(value: ScheduleTrigger): ScheduleTrigger {
  if (value.kind === "cron") {
    const spec = parseCron(value.expr);
    if (cronNextAfter(spec, Date.UTC(2024, 0, 1) - 1) === undefined) throw new ScheduleSpecError(`cron '${value.expr.slice(0, 60)}' never matches a date (for example 31 February).`);
    const gap = cronMinGapMinutes(spec);
    if (gap < MIN_EVERY_SECONDS / 60) throw new ScheduleSpecError(`cron '${value.expr.slice(0, 60)}' runs every ${gap} minute${gap === 1 ? "" : "s"} at times; slots are at least ${MIN_EVERY_SECONDS / 60} minutes apart, as for --every.`);
    return { kind: "cron", expr: value.expr };
  }
  if (value.kind === "every") {
    if (!Number.isSafeInteger(value.seconds) || value.seconds < MIN_EVERY_SECONDS || value.seconds > MAX_EVERY_SECONDS) {
      throw new ScheduleSpecError(`an interval is from ${MIN_EVERY_SECONDS} to ${MAX_EVERY_SECONDS} seconds.`);
    }
    return { kind: "every", seconds: value.seconds };
  }
  if (value.kind === "once") return { kind: "once", at: parseOnceAt(value.at) };
  throw new ScheduleSpecError("a trigger is cron, every or once.");
}

// ---------------------------------------------------------------- slots

/**
 * The first slot strictly after `afterMs`, as epoch milliseconds, or undefined when the trigger has none (a `once`
 * already past, a cron that never matches). `anchorMs` is where an `every` schedule's phase starts: its slots are
 * `anchor + k * seconds` for k >= 1, so a gap in service never shifts the phase.
 */
export function nextAfter(trigger: ScheduleTrigger, anchorMs: number, afterMs: number): number | undefined {
  if (trigger.kind === "cron") return cronNextAfter(parseCron(trigger.expr), afterMs);
  if (trigger.kind === "once") {
    const at = Date.parse(trigger.at);
    return at > afterMs ? at : undefined;
  }
  const step = trigger.seconds * 1000;
  const k = Math.max(1, Math.floor((afterMs - anchorMs) / step) + 1);
  return anchorMs + k * step;
}

export interface SlotScan {
  /** Slots in `(afterMs, uptoMs]`, counted up to the scan limit. */
  count: number;
  first: number | undefined;
  last: number | undefined;
  /** The scan stopped at its limit: `count` is a lower bound and `last` the last slot counted. */
  truncated: boolean;
}

/** The slots in `(afterMs, uptoMs]`: how many, the first and the last. Bounded by `limit` (`MAX_SLOT_SCAN`). */
export function scanSlots(trigger: ScheduleTrigger, anchorMs: number, afterMs: number, uptoMs: number, limit = MAX_SLOT_SCAN): SlotScan {
  const scan: SlotScan = { count: 0, first: undefined, last: undefined, truncated: false };
  if (trigger.kind === "every") {
    // Arithmetic: a long gap costs nothing.
    const step = trigger.seconds * 1000;
    const k0 = Math.max(1, Math.floor((afterMs - anchorMs) / step) + 1);
    const k1 = Math.floor((uptoMs - anchorMs) / step);
    if (k1 < k0) return scan;
    const total = k1 - k0 + 1;
    scan.count = Math.min(total, limit);
    scan.first = anchorMs + k0 * step;
    scan.last = anchorMs + (k0 + scan.count - 1) * step;
    scan.truncated = total > limit;
    return scan;
  }
  let cursor = afterMs;
  for (;;) {
    const slot = nextAfter(trigger, anchorMs, cursor);
    if (slot === undefined || slot > uptoMs) return scan;
    if (scan.count >= limit) {
      scan.truncated = true;
      return scan;
    }
    scan.count++;
    scan.first ??= slot;
    scan.last = slot;
    cursor = slot;
  }
}

/** A short description for listings: `cron 0 3 * * 1-5 (UTC)`, `every 15m`, `once at ...`. */
export function describeTrigger(trigger: ScheduleTrigger): string {
  if (trigger.kind === "cron") return `cron ${trigger.expr} (UTC)`;
  if (trigger.kind === "once") return `once at ${trigger.at}`;
  const s = trigger.seconds;
  return `every ${s % 86_400 === 0 ? `${s / 86_400}d` : s % 3600 === 0 ? `${s / 3600}h` : s % 60 === 0 ? `${s / 60}m` : `${s}s`}`;
}
