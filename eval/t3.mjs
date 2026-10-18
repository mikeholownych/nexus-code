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
  }
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
 * Drives one T3 session over the sidecar protocol. `write(line)` sends a command line to the sidecar. Feed every
 * stdout line to `handleLine`; `done` resolves once the probe turn has finished and shutdown was sent.
 */
export function createT3Driver(task, write) {
  const send = (command) => write(`${JSON.stringify({ v: PROTOCOL, ...command })}\n`);
  const state = { phase: "starting", toolCalls: 0, steeringSent: [], acks: {}, objectiveTurn: null, probeTurn: null, probeText: "", protocolErrors: [], events: 0 };
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const finish = () => {
    if (state.phase === "done") return;
    state.phase = "done";
    send({ type: "shutdown" });
    resolveDone(state);
  };
  const handleLine = (line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { state.protocolErrors.push("unparseable sidecar line"); return; }
    state.events++;
    if (event.v !== PROTOCOL) { state.protocolErrors.push(`protocol version ${event.v}`); return; }
    if (event.type === "hello" && state.phase === "starting") {
      state.phase = "objective";
      send({ type: "prompt.submit", id: "t3-objective", text: task.objective });
    } else if (event.type === "tool.start" && state.phase === "objective") {
      state.toolCalls++;
      for (const item of task.steering) {
        if (state.toolCalls >= item.afterToolCalls && !state.steeringSent.includes(item.id)) {
          state.steeringSent.push(item.id);
          send({ type: "steer", id: `t3-${item.id}`, text: item.text });
        }
      }
    } else if (event.type === "steer.ack") {
      const id = String(event.id ?? "").replace(/^t3-/, "");
      (state.acks[id] ??= []).push(event.status);
    } else if (event.type === "assistant.delta" && state.phase === "probe") {
      state.probeText += String(event.text ?? "");
    } else if (event.type === "turn.result") {
      if (state.phase === "objective") {
        state.objectiveTurn = event.turn ?? null;
        state.phase = "probe";
        send({ type: "prompt.submit", id: "t3-probe", text: probePrompt(task) });
      } else if (state.phase === "probe") {
        state.probeTurn = event.turn ?? null;
        finish();
      }
    } else if (event.type === "approval.request") {
      // The sidecar runs with --yes; an approval request is unexpected. Deny it (never approve on the agent's behalf).
      state.protocolErrors.push(`unexpected approval request for ${event.tool ?? "a tool"}`);
      send({ type: "deny", id: event.id });
    } else if (event.type === "error") {
      state.protocolErrors.push(`${event.code ?? "error"}: ${String(event.message ?? "").slice(0, 200)}`);
    }
  };
  return { handleLine, done, state, abort: finish };
}

/**
 * Compactions committed in the run, counted from the run's isolated HOME: ids a saved record lists in
 * history.committedCompactions that also have archived originals (a compactionId in a *.history.jsonl line).
 */
export function countCompactions(home) {
  const committed = new Set();
  const archived = new Set();
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const item = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(item);
      else if (entry.isFile() && entry.name.endsWith(".history.jsonl")) {
        for (const line of fs.readFileSync(item, "utf8").split("\n")) {
          try { const id = JSON.parse(line).compactionId; if (typeof id === "string") archived.add(id); } catch {}
        }
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          const ids = JSON.parse(fs.readFileSync(item, "utf8"))?.history?.committedCompactions;
          if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") committed.add(id);
        } catch {}
      }
    }
  };
  visit(home);
  return [...committed].filter((id) => archived.has(id)).length;
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

/**
 * Scores one T3 run. `runCommand(command)` runs a constraint command in the final workspace (isolated, like hidden
 * tests) and resolves to { pass }. A steering item is honoured only when Nexus applied it and its constraint holds.
 */
export async function scoreT3Run({ task, ws, baseline, driver, compactions, runCommand }) {
  const steering = [];
  for (const item of task.steering) {
    const statuses = driver.acks[item.id] ?? [];
    const applied = statuses.includes("applied");
    let constraintHolds;
    if (item.constraint.kind === "file-unchanged") constraintHolds = baseline[item.id] !== null && digest(ws, item.constraint.path) === baseline[item.id];
    else if (item.constraint.kind === "file-absent") constraintHolds = !fs.existsSync(path.join(ws, item.constraint.path));
    else constraintHolds = (await runCommand(item.constraint.command)).pass;
    steering.push({ id: item.id, sent: driver.steeringSent.includes(item.id), statuses, applied, constraintHolds, honoured: applied && constraintHolds });
  }
  let answers = null;
  const match = /\{[\s\S]*\}/.exec(driver.probeText);
  if (match) { try { answers = JSON.parse(match[0]); } catch {} }
  const facts = task.facts.map((fact) => {
    const exists = fs.existsSync(path.join(ws, fact.path));
    const answer = answers && typeof answers[fact.id] === "string" ? answers[fact.id].toLowerCase() : null;
    return { id: fact.id, exists, answer, falseAbsence: exists && answer === "absent", falsePresence: !exists && answer === "present" };
  });
  const steps = driver.objectiveTurn?.steps?.used ?? 0;
  return {
    steps,
    compactions,
    // A run that is not long enough, or never compacted twice, does not exercise T3: it is reported, never dropped.
    eligible: steps >= T3_MIN_STEPS && compactions >= T3_MIN_COMPACTIONS,
    steering,
    steeringHonoured: steering.filter((s) => s.honoured).length,
    probeAnswered: answers !== null && facts.every((f) => f.answer === "present" || f.answer === "absent"),
    facts,
    falseAbsences: facts.filter((f) => f.falseAbsence).length,
    protocolErrors: driver.protocolErrors,
  };
}
