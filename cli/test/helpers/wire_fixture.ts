/**
 * Wire-fixture harness (PF-1): replays a recorded session against the real `SidecarServer` and reports where the
 * sidecar's output departs from the recording. The model is the scripted gateway of `helpers/fixtures.ts`; nothing
 * else is faked, so a recording is what a client sees on the sidecar's stdout for the lines it wrote to its stdin.
 *
 * A recording is `test/fixtures/wire/<name>.json`:
 *
 *   { "description": "...",
 *     "gateway": [ <Reply>, ... ],        the scripted model's answer to the 1st, 2nd, ... chat request
 *     "steps": [
 *       { "expect": [ <event>, ... ] },                      step 1: connect; what the sidecar sends unasked
 *       { "send": { "v": 1, "type": ... }, "expect": [...] },  a line the client writes, then every event up to idle
 *       { "raw": "not json", "malformed": "why", "expect": [...] },
 *       { "send": { "v": 1, "type": "shutdown" }, "expect": [], "closes": true } ] }
 *
 * `send` is written as one JSON line; `raw` is written as it stands (for lines that are not JSON). A line that is
 * deliberately not a valid command carries `malformed` with the reason: every other line must validate against the
 * command schema, and a line marked `malformed` must not. `closes` marks the step at which the sidecar shuts down.
 * Every event the sidecar emits must validate against the event schema.
 *
 * Matching. An expected event must equal the emitted one exactly (same fields, same values, same order of events),
 * except where the recording holds one of these strings:
 *
 *   "<any:string>" "<any:number>" "<any:array>"   any value of that JSON type
 *   "<id:NAME>"                                   any non-empty string; every later "<id:NAME>" must be that string
 *   "...<workspace>..."  "...<workspace-name>..." the run's temporary workspace path, and its last component
 *
 * Recording. `record()` runs the steps and writes what the sidecar really sent into `expect`, putting the placeholders
 * above where VARIES says a value changes from run to run (and wherever a captured id or the workspace path appears
 * again). To regenerate every recording: `NEXUS_WIRE_RECORD=1 node --import tsx --test test/protocol_wire.test.ts`
 * (with a throwaway HOME), then review the diff. To add one: write the file with `send` steps and empty `expect`
 * arrays, and regenerate.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import "./leak_guard.js";
import { ApplicationCore } from "../../src/core/app.js";
import { SidecarServer } from "../../src/sidecar.js";
import { PROTOCOL_VERSION } from "../../src/protocol.js";
import { startGateway, makeRepo, makeHome, type Reply } from "./fixtures.js";
import { validate, type Schema } from "./json_schema.js";

export interface WireStep {
  send?: Record<string, unknown>;
  raw?: string;
  malformed?: string;
  expect: unknown[];
  closes?: true;
}

export interface WireRecording {
  description: string;
  gateway: Reply[];
  steps: WireStep[];
}

/**
 * Values that differ between two runs of the same steps, by event type and field path: the recorder writes the
 * placeholder instead of the value. Everything not listed is recorded, and replayed, exactly.
 */
const VARIES: Record<string, Record<string, string>> = {
  // `commands` is the slash catalogue of this build, not part of the session; the schema still checks each entry.
  hello: { pid: "<any:number>", commands: "<any:array>" },
  // `context_tokens` is an estimate over the system prompt, which changes with the prompt text and the host.
  "session.state": { session: "<id:session>", context_tokens: "<any:number>" },
  "turn.result": {
    "turn.finishedAt": "<id:finished>",
    "turn.tokenAccounting.lastRequest.promptTokens": "<any:number>",
    "turn.tokenAccounting.lastRequest.clientEstimate": "<any:number>",
  },
  "tool.detail": { duration_ms: "<any:number>" },
};

const WIRE_DIR = fileURLToPath(new URL("../fixtures/wire/", import.meta.url));
const SCHEMA_FILE = fileURLToPath(new URL(`../../../docs/protocol/sidecar-v${PROTOCOL_VERSION}.schema.json`, import.meta.url));
const schema: Schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8"));
const EVENT = { $ref: "#/$defs/SidecarEvent" };
const COMMAND = { $ref: "#/$defs/SidecarCommand" };

export function recordingNames(): string[] {
  return fs.readdirSync(WIRE_DIR).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -".json".length)).sort();
}

export const recordingFile = (name: string): string => path.join(WIRE_DIR, `${name}.json`);

export function loadRecording(name: string): WireRecording {
  return JSON.parse(fs.readFileSync(recordingFile(name), "utf8"));
}

/** One event (or reply) per line, so a changed event is one changed line in review. */
export function recordingText(recording: WireRecording): string {
  const list = (items: unknown[], indent: string) => (items.length ? `[\n${items.map((item) => `${indent}  ${JSON.stringify(item)}`).join(",\n")}\n${indent}]` : "[]");
  const steps = recording.steps.map((step) => {
    const fields = [
      ...(step.send !== undefined ? [`"send": ${JSON.stringify(step.send)}`] : []),
      ...(step.raw !== undefined ? [`"raw": ${JSON.stringify(step.raw)}`] : []),
      ...(step.malformed !== undefined ? [`"malformed": ${JSON.stringify(step.malformed)}`] : []),
      `"expect": ${list(step.expect, "      ")}`,
      ...(step.closes ? [`"closes": true`] : []),
    ];
    return `    {\n${fields.map((field) => `      ${field}`).join(",\n")}\n    }`;
  });
  return `{\n  "description": ${JSON.stringify(recording.description)},\n  "gateway": ${list(recording.gateway, "  ")},\n  "steps": [\n${steps.join(",\n")}\n  ]\n}\n`;
}

export function writeRecording(name: string, recording: WireRecording): void {
  fs.writeFileSync(recordingFile(name), recordingText(recording));
}

interface Observed {
  /** Per step: the events the sidecar emitted, and whether it shut down during the step. */
  steps: Array<{ events: any[]; closed: boolean }>;
  workspace: string;
  /** Chat requests the sidecar made to the scripted model. */
  modelRequests: number;
  /** Lines and events that break the schema rules above. */
  problems: string[];
}

const stepLabel = (step: WireStep, index: number): string =>
  `step ${index + 1} (${step.send ? `send ${String(step.send.type)}` : step.raw !== undefined ? "raw line" : "connect"})`;

/** Runs the recording's steps against a real sidecar in a temporary workspace and HOME. */
async function observe(recording: WireRecording): Promise<Observed> {
  const gw = await startGateway((n) => recording.gateway[n - 1] ?? { kind: "http", status: 500, body: '{"error":"the recording scripts no further model reply"}' });
  const repo = makeRepo();
  // The branch name `git init` picks is host configuration; the recording must not depend on it.
  execFileSync("git", ["branch", "-M", "main"], { cwd: repo, stdio: "ignore" });
  const home = makeHome();
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash", approvalMode: "auto", fullAccess: true } as any);
  const events: any[] = [];
  let closed = false;
  const server = new SidecarServer({ app, mode: "auto", write: (line) => events.push(JSON.parse(line)), onShutdown: () => { closed = true; } });
  const observed: Observed = { steps: [], workspace: repo, modelRequests: 0, problems: [] };
  try {
    for (const [index, step] of recording.steps.entries()) {
      const label = stepLabel(step, index);
      const from = events.length;
      closed = false;
      if (step.send === undefined && step.raw === undefined) {
        if (index !== 0) throw new Error(`${label}: only the first step may be the connect step (no send, no raw)`);
        server.start();
      } else {
        if (index === 0) throw new Error("step 1 must be the connect step (no send, no raw)");
        const line = step.raw ?? JSON.stringify(step.send);
        let errors: string[];
        try {
          errors = validate(JSON.parse(line), COMMAND, schema);
        } catch {
          errors = ["not JSON"];
        }
        if (step.malformed === undefined && errors.length) observed.problems.push(`${label}: the line is not a valid command (${errors.join("; ")}); mark it "malformed" if that is intended`);
        if (step.malformed !== undefined && !errors.length) observed.problems.push(`${label}: marked malformed, but the line is a valid command`);
        await server.handleLine(line);
      }
      await server.idle();
      const emitted = events.slice(from);
      emitted.forEach((event, at) => {
        const errors = validate(event, EVENT, schema);
        if (errors.length) observed.problems.push(`${label}, event ${at + 1} (${String(event?.type)}): not valid against the schema: ${errors.join("; ")}`);
      });
      observed.steps.push({ events: emitted, closed });
    }
  } finally {
    await server.handleLine(JSON.stringify({ v: PROTOCOL_VERSION, type: "cancel" }));
    await server.idle();
    app.shutdown();
    observed.modelRequests = gw.requests.length;
    await gw.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
  return observed;
}

const jsonType = (value: unknown): string => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
const shown = (value: unknown): string => {
  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
};

/** Where `actual` first departs from `expected` (see "Matching" above), or undefined. `ids` holds the captures so far. */
function mismatch(expected: unknown, actual: unknown, at: string, workspace: string, ids: Map<string, string>): string | undefined {
  if (typeof expected === "string") {
    const any = /^<any:(string|number|array)>$/.exec(expected);
    if (any) return jsonType(actual) === any[1] ? undefined : `${at}: expected any ${any[1]}, got ${shown(actual)}`;
    const id = /^<id:([\w-]+)>$/.exec(expected);
    if (id) {
      if (typeof actual !== "string" || !actual) return `${at}: expected a non-empty string for ${expected}, got ${shown(actual)}`;
      const bound = ids.get(id[1]);
      if (bound === undefined) ids.set(id[1], actual);
      else if (bound !== actual) return `${at}: expected ${expected} to be ${shown(bound)} again, got ${shown(actual)}`;
      return undefined;
    }
    const literal = expected.replaceAll("<workspace-name>", path.basename(workspace)).replaceAll("<workspace>", workspace);
    return literal === actual ? undefined : `${at}: expected ${shown(literal)}, got ${shown(actual)}`;
  }
  if (jsonType(expected) !== jsonType(actual)) return `${at}: expected ${shown(expected)}, got ${shown(actual)}`;
  if (Array.isArray(expected)) {
    const items = actual as unknown[];
    if (expected.length !== items.length) return `${at}: expected ${expected.length} items, got ${items.length}`;
    for (let i = 0; i < expected.length; i += 1) {
      const found = mismatch(expected[i], items[i], `${at}[${i}]`, workspace, ids);
      if (found) return found;
    }
    return undefined;
  }
  if (expected && typeof expected === "object") {
    const want = expected as Record<string, unknown>;
    const got = actual as Record<string, unknown>;
    for (const key of Object.keys(got)) if (!Object.hasOwn(want, key)) return `${at}: unexpected field ${key} = ${shown(got[key])}`;
    for (const key of Object.keys(want)) {
      if (!Object.hasOwn(got, key)) return `${at}: missing field ${key}`;
      const found = mismatch(want[key], got[key], `${at}.${key}`, workspace, ids);
      if (found) return found;
    }
    return undefined;
  }
  return expected === actual ? undefined : `${at}: expected ${shown(expected)}, got ${shown(actual)}`;
}

/** Every way the observed run departs from the recording, each naming its step; empty when the replay conforms. */
function divergences(recording: WireRecording, observed: Observed): string[] {
  const found = [...observed.problems];
  const ids = new Map<string, string>();
  recording.steps.forEach((step, index) => {
    const label = stepLabel(step, index);
    const { events, closed } = observed.steps[index];
    const types = (list: any[]) => list.map((event) => String(event?.type)).join(", ") || "nothing";
    if (events.length !== step.expect.length) {
      found.push(`${label}: expected ${step.expect.length} events (${types(step.expect)}), the sidecar sent ${events.length} (${types(events)})`);
    } else {
      events.forEach((event, at) => {
        const problem = mismatch(step.expect[at], event, "$", observed.workspace, ids);
        if (problem) found.push(`${label}, event ${at + 1} (${String(event?.type)}): ${problem}`);
      });
    }
    if (closed !== Boolean(step.closes)) found.push(`${label}: ${closed ? "the sidecar shut down, which the recording does not expect" : "the recording expects the sidecar to shut down, and it did not"}`);
  });
  if (observed.modelRequests !== recording.gateway.length) found.push(`the sidecar made ${observed.modelRequests} model requests; the recording scripts ${recording.gateway.length}`);
  return found;
}

/** Replays the recording; throws an error listing each divergence with its step number. */
export async function replay(recording: WireRecording): Promise<void> {
  const found = divergences(recording, await observe(recording));
  if (found.length) throw new Error(`the replay diverges from the recording:\n${found.join("\n")}`);
}

/** Runs the recording's steps and returns it with `expect` and `closes` taken from what the sidecar really did. */
export async function record(recording: WireRecording): Promise<WireRecording> {
  const observed = await observe(recording);
  if (observed.problems.length) throw new Error(observed.problems.join("\n"));
  const captured = new Map<string, string>();
  const at = (event: any, dotted: string) => {
    const keys = dotted.split(".");
    const last = keys.pop() as string;
    const holder = keys.reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), event);
    return holder && typeof holder === "object" && Object.hasOwn(holder, last) ? { holder, last } : undefined;
  };
  // First the listed fields (which also gives each captured id its value), then every other place those values appear.
  const steps = observed.steps.map(({ events }) => structuredClone(events));
  for (const event of steps.flat()) {
    for (const [dotted, placeholder] of Object.entries(VARIES[event.type] ?? {})) {
      const found = at(event, dotted);
      if (!found) continue;
      const id = /^<id:([\w-]+)>$/.exec(placeholder);
      if (id && typeof found.holder[found.last] === "string") captured.set(found.holder[found.last], placeholder);
      found.holder[found.last] = placeholder;
    }
  }
  const name = path.basename(observed.workspace);
  const generalize = (value: unknown): unknown => {
    if (typeof value === "string") return captured.get(value) ?? value.replaceAll(observed.workspace, "<workspace>").replaceAll(name, "<workspace-name>");
    if (Array.isArray(value)) return value.map(generalize);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, generalize(nested)]));
    return value;
  };
  return {
    description: recording.description,
    gateway: recording.gateway,
    steps: recording.steps.map((step, index) => {
      const { closes: _closes, ...kept } = step;
      return { ...kept, expect: generalize(steps[index]) as unknown[], ...(observed.steps[index].closed ? { closes: true as const } : {}) };
    }),
  };
}
