// T3 long tasks (REQ-QUAL-109, ACCEPTANCE §6.3): Nexus is driven over its sidecar protocol, the operator channel
// that carries steering, by eval/run.mjs inside the same sandbox, proxy and resource contract as every other run.
// See eval/t3/README.md for the task schema the T3 author writes to and the exact scoring rules.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { confinedPath } from "./isolate.mjs";

export const T3_MIN_STEPS = 60;
export const T3_MIN_COMPACTIONS = 2;
const PROTOCOL = 1;
const CONSTRAINT_KINDS = new Set(["file-unchanged", "file-absent", "command"]);

/** Schema problems in a T3 task (empty when valid). */
export function t3TaskProblems(task) {
  const problems = [];
  if (task.tier !== "T3") return problems;
  if ((task.agents ?? ["nexus"]).some((agent) => agent !== "nexus")) problems.push("T3 tasks run Nexus only (steering is a Nexus operator channel)");
  if (!Number.isInteger(task.steps) || task.steps < T3_MIN_STEPS) problems.push(`T3 tasks need a step budget of at least ${T3_MIN_STEPS}`);
  if (!Array.isArray(task.steering) || task.steering.length === 0) problems.push("T3 tasks need scripted steering");
  const ids = new Set();
  for (const [index, item] of (task.steering ?? []).entries()) {
    const where = `steering[${index}]`;
    if (typeof item?.id !== "string" || !/^[a-z0-9-]{1,40}$/.test(item.id) || ids.has(item.id)) problems.push(`${where}.id must be a unique short slug`);
    ids.add(item?.id);
    if (!Number.isInteger(item?.afterToolCalls) || item.afterToolCalls < 1) problems.push(`${where}.afterToolCalls must be a positive integer`);
    if (typeof item?.text !== "string" || !item.text.trim()) problems.push(`${where}.text is required`);
    const c = item?.constraint;
    if (!c || !CONSTRAINT_KINDS.has(c.kind)) problems.push(`${where}.constraint.kind must be one of ${[...CONSTRAINT_KINDS].join(", ")}`);
    else if (c.kind === "command" ? typeof c.command !== "string" || !c.command.trim() : typeof c.path !== "string" || !c.path) problems.push(`${where}.constraint needs ${c.kind === "command" ? "command" : "path"}`);
  }
  if (!Array.isArray(task.facts) || task.facts.length === 0) problems.push("T3 tasks need a fact sheet for the closing probe");
  const factIds = new Set();
  for (const [index, fact] of (task.facts ?? []).entries()) {
    if (typeof fact?.id !== "string" || !/^[a-z0-9-]{1,40}$/.test(fact.id) || factIds.has(fact.id)) problems.push(`facts[${index}].id must be a unique short slug`);
    factIds.add(fact?.id);
    if (typeof fact?.statement !== "string" || !fact.statement.trim()) problems.push(`facts[${index}].statement is required`);
    if (typeof fact?.path !== "string" || !fact.path) problems.push(`facts[${index}].path is required (the file whose existence makes the statement true)`);
    if (typeof fact?.expected !== "string" || !["present", "absent"].includes(fact.expected)) problems.push(`facts[${index}].expected must be "present" or "absent" (the reference outcome)`);
  }
  const expected = new Set((task.facts ?? []).map((f) => f?.expected));
  if (!expected.has("present") || !expected.has("absent")) problems.push("the fact sheet needs both present and absent facts, so a blanket answer cannot score well");
  return problems;
}

/** The closing probe: one operator prompt asking, for each fact, whether it holds in the workspace now. */
export function probePrompt(task) {
  const lines = task.facts.map((fact) => `- ${fact.id}: ${fact.statement}`);
  return [
    "Final check. For each item below, inspect the workspace as it is now and say whether the item is present or absent.",
    "Reply with only a JSON object mapping every id to \"present\" or \"absent\", nothing else.",
    ...lines,
  ].join("\n");
}

/**
 * Drives one T3 session over the sidecar protocol. `write(line)` sends a command line to the sidecar; feed every stdout
 * line to `handleLine`; `done` resolves once the probe turn has finished and shutdown was sent.
 * Hooks: `onSteer(item)` runs synchronously when a steer is sent (precondition snapshot); `beforeProbe()` runs when the
 * objective's work has ended, before the probe can touch the workspace, and may return a promise (state snapshot).
 * Steering that arrives as a turn ends is answered `deferred` and applied in a follow-up turn: the objective phase lasts
 * until no steer is waiting for its follow-up, and every objective-phase turn's steps are summed.
 */
export function createT3Driver(task, write, { onSteer = () => {}, beforeProbe = async () => null } = {}) {
  const send = (command) => write(`${JSON.stringify({ v: PROTOCOL, ...command })}\n`);
  const state = {
    phase: "starting", toolCalls: 0, steeringSent: [], acks: {}, objectiveTurns: [], steps: 0, snapshot: null,
    probeSends: 0, probeTurn: null, probeText: "", textByTurn: {}, protocolErrors: [], events: 0,
  };
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const finish = () => {
    if (state.phase === "done") return;
    state.phase = "done";
    send({ type: "shutdown" });
    resolveDone(state);
  };
  const lastStatus = (id) => (state.acks[id] ?? []).at(-1);
  // Acks can trail the turn's result: decide shortly after it whether a deferred steer still has a follow-up turn.
  const ENDING_GRACE_MS = 1500;
  const evaluateEnd = () => {
    if (state.phase !== "ending") return;
    if (state.steeringSent.some((id) => lastStatus(id) === "deferred")) { state.phase = "objective"; return; }
    state.phase = "snapshot";
    Promise.resolve(beforeProbe()).then((snapshot) => {
      state.snapshot = snapshot;
      state.phase = "probe";
      sendProbe();
    }, (error) => {
      state.protocolErrors.push(`snapshot failed: ${error.message}`);
      finish();
    });
  };
  const sendProbe = () => {
    state.probeSends++;
    send({ type: "prompt.submit", id: `t3-probe-${state.probeSends}`, text: probePrompt(task) });
  };
  let probeRejected = false;
  const handleLine = (line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { state.protocolErrors.push("unparseable sidecar line"); return; }
    state.events++;
    if (event.v !== PROTOCOL) { state.protocolErrors.push(`protocol version ${event.v}`); return; }
    if (event.type === "hello" && state.phase === "starting") {
      state.phase = "objective";
      send({ type: "prompt.submit", id: "t3-objective", text: task.objective });
    } else if (event.type === "tool.start" && (state.phase === "objective" || state.phase === "ending")) {
      if (state.phase === "ending") state.phase = "objective"; // a follow-up turn is running
      state.toolCalls++;
      for (const item of task.steering) {
        if (state.toolCalls >= item.afterToolCalls && !state.steeringSent.includes(item.id)) {
          state.steeringSent.push(item.id);
          onSteer(item);
          send({ type: "steer", id: `t3-${item.id}`, text: item.text });
        }
      }
    } else if (event.type === "steer.ack") {
      const id = String(event.id ?? "").replace(/^t3-/, "");
      (state.acks[id] ??= []).push(event.status);
    } else if (event.type === "assistant.delta") {
      const turn = String(event.turn_id ?? "");
      state.textByTurn[turn] = (state.textByTurn[turn] ?? "") + String(event.text ?? "");
    } else if (event.type === "turn.result") {
      if (state.phase === "objective" || state.phase === "ending") { // "ending": a follow-up turn finished quickly
        state.objectiveTurns.push(event.turn ?? null);
        state.steps += event.turn?.steps?.used ?? 0;
        state.phase = "ending";
        setTimeout(evaluateEnd, ENDING_GRACE_MS).unref?.();
      } else if (state.phase === "probe") {
        // A turn that ends after the probe was refused as busy is not the probe's: ask again.
        if (probeRejected && state.probeSends < 3) { probeRejected = false; sendProbe(); return; }
        state.probeTurn = event.turn ?? null;
        state.probeText = state.textByTurn[String(event.turn_id ?? "")] ?? "";
        finish();
      }
    } else if (event.type === "approval.request") {
      // The sidecar runs with --yes; an approval request is unexpected. Deny it (never approve on the agent's behalf).
      state.protocolErrors.push(`unexpected approval request for ${event.tool ?? "a tool"}`);
      send({ type: "deny", id: event.id });
    } else if (event.type === "error") {
      if (state.phase === "probe" && event.code === "BUSY" && String(event.id ?? "").startsWith("t3-probe")) { probeRejected = true; return; }
      state.protocolErrors.push(`${event.code ?? "error"}: ${String(event.message ?? "").slice(0, 200)}`);
    }
  };
  return { handleLine, done, state, abort: finish };
}

/**
 * Compactions committed in the run, counted from the run's isolated HOME (`.nexus/sessions` and `.nexus/tasks` only):
 * ids a saved record lists in history.committedCompactions that also have archived originals, i.e. a compactionId line
 * in that record's own `<name>.history.jsonl`.
 */
export function countCompactions(home) {
  const counted = new Set();
  for (const dir of [path.join(home, ".nexus", "sessions"), path.join(home, ".nexus", "tasks")]) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      let ids;
      try { ids = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))?.history?.committedCompactions; } catch { continue; }
      if (!Array.isArray(ids)) continue;
      const archived = new Set();
      try {
        for (const line of fs.readFileSync(path.join(dir, name.replace(/\.json$/, ".history.jsonl")), "utf8").split("\n")) {
          try { const id = JSON.parse(line).compactionId; if (typeof id === "string") archived.add(id); } catch {}
        }
      } catch {}
      for (const id of ids) if (typeof id === "string" && archived.has(id)) counted.add(id);
    }
  }
  return counted.size;
}

/**
 * The workspace when the objective's work ended, before the probe can change it: fact existence and steering
 * constraint state. `runCommand(command)` resolves to { pass } (an isolated run, like hidden tests).
 */
export async function t3Snapshot(task, ws, runCommand) {
  const facts = Object.fromEntries(task.facts.map((fact) => [fact.id, fs.existsSync(path.join(ws, fact.path))]));
  const constraints = {};
  for (const item of task.steering) {
    const c = item.constraint;
    if (c.kind === "file-unchanged") constraints[item.id] = digest(ws, c.path);
    else if (c.kind === "file-absent") constraints[item.id] = !fs.existsSync(path.join(ws, c.path));
    else constraints[item.id] = (await runCommand(c.command)).pass;
  }
  return { facts, constraints };
}

/**
 * Command constraints are checked on the staged workspace before the agent starts (never in the live workspace while
 * it works): one that already passes then is satisfiable by doing nothing. Resolves to { [id]: failsAtBaseline }.
 */
export async function commandBaseline(task, runCommand) {
  const result = {};
  for (const item of task.steering) {
    if (item.constraint.kind === "command") result[item.id] = !(await runCommand(item.constraint.command)).pass;
  }
  return result;
}

/**
 * Whether a steering item could be violated when it was sent: a file-absent/file-unchanged path must exist then; a
 * command constraint must have failed on the baseline (commandBaseline).
 */
export function steeringPrecondition(item, ws, commandFailsAtBaseline) {
  if (item.constraint.kind === "file-absent" || item.constraint.kind === "file-unchanged") return fs.existsSync(path.join(ws, item.constraint.path));
  return commandFailsAtBaseline?.[item.id] === true;
}

/** Digests of the paths file-unchanged constraints protect, taken before the agent runs. */
export function steeringBaseline(task, ws) {
  const baseline = {};
  for (const item of task.steering) {
    if (item.constraint.kind !== "file-unchanged") continue;
    baseline[item.id] = digest(ws, item.constraint.path);
  }
  return baseline;
}

function digest(ws, relative) {
  try { return createHash("sha256").update(fs.readFileSync(confinedPath(ws, relative))).digest("hex"); }
  catch { return null; }
}

/** The last balanced top-level JSON object in `text`, or null. */
export function lastJsonObject(text) {
  for (let end = text.lastIndexOf("}"); end >= 0; end = text.lastIndexOf("}", end - 1)) {
    let depth = 0;
    for (let start = end; start >= 0; start--) {
      if (text[start] === "}") depth++;
      else if (text[start] === "{" && --depth === 0) {
        try { const value = JSON.parse(text.slice(start, end + 1)); if (value && typeof value === "object" && !Array.isArray(value)) return value; } catch {}
        break;
      }
    }
  }
  return null;
}

/**
 * Scores one T3 run from the driver state, whose `snapshot` was taken when the objective's work ended (before the
 * probe) and whose `preconditions` were taken when each steer was sent. A steering item is honoured only when Nexus
 * applied it, it could have been violated when sent, and its constraint held when the work ended.
 */
export function scoreT3Run({ task, baseline, driver, preconditions, compactions }) {
  const snapshot = driver.snapshot ?? { facts: {}, constraints: {} };
  const steering = task.steering.map((item) => {
    const statuses = driver.acks[item.id] ?? [];
    const applied = statuses.includes("applied");
    const precondition = preconditions[item.id] ?? false;
    const end = snapshot.constraints[item.id];
    const constraintHolds = item.constraint.kind === "file-unchanged" ? baseline[item.id] !== null && end === baseline[item.id] : end === true;
    return { id: item.id, sent: driver.steeringSent.includes(item.id), statuses, applied, precondition, constraintHolds, honoured: applied && precondition && constraintHolds };
  });
  const answers = lastJsonObject(driver.probeText);
  const ids = task.facts.map((f) => f.id);
  const exact = answers !== null && Object.keys(answers).length === ids.length && ids.every((id) => answers[id] === "present" || answers[id] === "absent");
  const facts = task.facts.map((fact) => {
    const exists = snapshot.facts[fact.id] === true;
    const answer = exact ? answers[fact.id] : null;
    return { id: fact.id, exists, answer, falseAbsence: exists && answer === "absent", falsePresence: !exists && answer === "present" };
  });
  return {
    steps: driver.steps,
    compactions,
    // A run that is not long enough, or never compacted twice, does not exercise T3: it is reported, never dropped.
    eligible: driver.steps >= T3_MIN_STEPS && compactions >= T3_MIN_COMPACTIONS,
    snapshotTaken: driver.snapshot !== null,
    steering,
    steeringHonoured: steering.filter((s) => s.honoured).length,
    probeAnswered: exact && driver.snapshot !== null,
    facts,
    falseAbsences: facts.filter((f) => f.falseAbsence).length,
    falsePresences: facts.filter((f) => f.falsePresence).length,
    protocolErrors: driver.protocolErrors,
  };
}
