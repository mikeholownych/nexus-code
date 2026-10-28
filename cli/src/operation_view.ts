/**
 * Read-only projection of a durable operation for the operator: the unit DAG, resource eligibility, the open decision
 * and the event stream. Nothing here drives, mutates or resumes an operation — commands do that. The view is built from
 * a persisted `DurableOperationState` plus the same `ResourceRegistry` eligibility rules the scheduler uses, so a
 * displayed fact is never a second implementation of a scheduling decision.
 */
import type { DurableOperationState, OperationEvent, WorkUnit } from "./core/operation.js";
import { ResourceRegistry, type Eligibility, type ResourceConditionRecord, type ResourceDescriptor } from "./core/resources.js";
import { safeTerminal } from "./ui.js";

export const OPERATION_VIEW_SCHEMA_VERSION = 1;

export interface OperationViewUnit {
  id: string;
  title: string;
  role?: string;
  status: WorkUnit["status"];
  /** Why the unit is not running, when it is not. */
  detail?: string;
  dependsOn: string[];
  required: boolean;
  /** How many units must complete before this one is due. */
  depth: number;
  /** True when the unit already has a durable conversation to continue. */
  durable: boolean;
  runs: number;
  assignment?: { resourceId: string; model: string; since: string };
  parkedUntil?: string;
  blocked?: { reason: string; decisionId: string };
  result?: { summary: string; completedAt: string; resourceId: string; outcome: string };
}

export interface OperationViewResource {
  id: string;
  provider: string;
  model: string;
  rank?: number;
  capabilities: string[];
  contextLength?: number;
  taskClass?: string;
  eligible: boolean;
  /** Present when ineligible: the active conditions that block it. */
  blocking?: Array<{ condition: string; reason: string; scope: string; eligibleAt?: string }>;
  /** Earliest time the resource is expected back, when the block is temporary. */
  eligibleAt?: string;
}

export interface OperationViewDecisionOption {
  id: string;
  label: string;
}

export interface OperationViewDecision {
  id: string;
  unitId: string;
  cause: string;
  question: string;
  options: OperationViewDecisionOption[];
  /** The command an operator can run to apply the decision. */
  command: string;
}

export interface OperationViewEvent {
  type: OperationEvent["type"];
  at: string;
  message: string;
  unitId?: string;
  resourceId?: string;
}

export interface OperationViewDag {
  nodes: Array<{ id: string; status: WorkUnit["status"]; dependsOn: string[]; required: boolean }>;
  edges: Array<{ from: string; to: string }>;
  /** Longest chain of unfinished units; deterministic (ties broken by unit id). */
  criticalPath: string[];
  /** Dependency ids that name no unit in this operation. */
  missingDependencies: string[];
  /** Ids that participate in a dependency cycle (should be empty; shown rather than hidden). */
  cycles: string[];
}

export interface OperationView {
  schemaVersion: typeof OPERATION_VIEW_SCHEMA_VERSION;
  id: string;
  objective: string;
  status: DurableOperationState["status"];
  createdAt: string;
  updatedAt: string;
  /** True when no further transition is expected without an operator decision. */
  terminal: boolean;
  counts: {
    total: number;
    complete: number;
    running: number;
    ready: number;
    blocked: number;
    parked: number;
    /** Units that cannot run yet because a dependency has not completed. */
    waiting: number;
  };
  units: OperationViewUnit[];
  resources: OperationViewResource[];
  wait?: { since: string; wakeAt: string; reason: string; parkedUnits: string[] };
  decisions: OperationViewDecision[];
  dag: OperationViewDag;
  events: OperationViewEvent[];
}

export interface WatchOptions {
  /** Read the current persisted state. Called before every render. */
  load: () => DurableOperationState;
  /** Render one snapshot; defaults to `renderOperationView`. */
  render?: (state: DurableOperationState) => string;
  intervalMs?: number;
  signal?: AbortSignal;
  /** Injected for tests; defaults to a timer that resolves early on abort. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  write?: (text: string) => void;
  /** Clear the screen between snapshots (TTY only). Default false. */
  clear?: boolean;
  /** Stop after this many renders (tests); 0 means until terminal/aborted. */
  maxRenders?: number;
  /** Consecutive read failures tolerated before the watch gives up. Default 5. */
  maxReadFailures?: number;
  now?: () => number;
}

export interface WatchResult {
  renders: number;
  stopped: "terminal" | "aborted" | "limit" | "unreadable";
}

/** A sleep that resolves early on abort and removes its listener on every path (no per-poll leak). */
const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });

/**
 * Render an operation until it reaches a terminal state or the caller aborts. Read-only: the only input is `load`, so
 * this cannot drive, resume or mutate the operation. A transient read failure is reported and retried; after
 * `maxReadFailures` consecutive failures the watch gives up rather than pretending the operation vanished.
 */
export async function watchOperation(options: WatchOptions): Promise<WatchResult> {
  const intervalMs = Math.max(0, options.intervalMs ?? 2_000);
  const sleep = options.sleep ?? defaultSleep;
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const render = options.render ?? ((state) => renderOperationView(buildOperationView(state, { now: options.now?.() })));
  let renders = 0;
  let failures = 0;
  for (;;) {
    if (options.signal?.aborted) return { renders, stopped: "aborted" };
    let state: DurableOperationState;
    try {
      state = options.load();
      failures = 0;
    } catch (error: any) {
      failures += 1;
      if (failures >= (options.maxReadFailures ?? 5)) return { renders, stopped: "unreadable" };
      write(`could not read the operation: ${String(error?.message ?? error)}
`);
      await sleep(intervalMs, options.signal);
      continue;
    }
    if (options.clear) write("\x1b[2J\x1b[H");
    write(`${render(state)}\n`);
    renders += 1;
    if (state.status === "COMPLETE" || state.status === "CANCELLED") return { renders, stopped: "terminal" };
    if (options.maxRenders && renders >= options.maxRenders) return { renders, stopped: "limit" };
    await sleep(intervalMs, options.signal);
  }
}

export interface OperationViewOptions {
  /** Maximum events to include (newest kept). Default 20. */
  events?: number;
  /** Clock for eligibility; defaults to now. */
  now?: number;
}

function detailFor(unit: WorkUnit): string | undefined {
  switch (unit.status) {
    case "PARKED":
      return unit.parked
        ? `${unit.parked.reason}${unit.parked.wakeAt ? `; wakes ${unit.parked.wakeAt}` : ""}`
        : undefined;
    case "BLOCKED":
      return unit.blocked?.reason;
    case "WAITING_ON_DEPENDENCY":
      return unit.dependsOn.length ? `after ${unit.dependsOn.join(", ")}` : undefined;
    case "COMPLETE":
      return unit.result ? `${unit.result.outcome} on ${unit.result.resourceId}` : undefined;
    case "RUNNING":
      return unit.assignment ? `${unit.assignment.resourceId} (${unit.assignment.model})` : "assigned";
    default:
      return undefined;
  }
}

/** Depth = 1 + max(depth of dependencies); units in a cycle get the depth reached before the cycle was detected. */
function unitDepths(units: WorkUnit[]): { depth: Map<string, number>; missing: string[]; cycles: string[] } {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const depth = new Map<string, number>();
  const stack: string[] = [];
  const cycles = new Set<string>();
  const missing = new Set<string>();

  const visit = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const unit = byId.get(id);
    if (!unit) {
      missing.add(id);
      return 0;
    }
    const at = stack.indexOf(id);
    if (at !== -1) {
      // Every unit on the cycle participates, not only the one the recursion re-entered.
      for (const member of stack.slice(at)) cycles.add(member);
      return 0;
    }
    stack.push(id);
    let value = 0;
    for (const dep of unit.dependsOn) value = Math.max(value, visit(dep) + 1);
    stack.pop();
    depth.set(id, value);
    return value;
  };

  for (const unit of units) visit(unit.id);
  return { depth, missing: [...missing].sort(), cycles: [...cycles].sort() };
}

function criticalPath(units: WorkUnit[]): string[] {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const unfinished = new Map(units.filter((unit) => unit.status !== "COMPLETE").map((unit) => [unit.id, unit]));
  if (!unfinished.size) return [];

  // Longest chain of not-yet-complete units; a completed dependency ends that branch.
  const chain = new Map<string, string[]>();
  const build = (id: string, seen: Set<string>): string[] => {
    const known = chain.get(id);
    if (known) return known;
    if (seen.has(id)) return [];
    seen.add(id);
    let best: string[] = [];
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!unfinished.has(dep)) continue;
      const candidate = [...build(dep, seen), id];
      if (candidate.length > best.length || (candidate.length === best.length && candidate.join(">") < best.join(">"))) {
        best = candidate;
      }
    }
    if (!best.length) best = [id];
    seen.delete(id);
    chain.set(id, best);
    return best;
  };

  let best: string[] = [];
  for (const id of [...unfinished.keys()].sort()) {
    const candidate = build(id, new Set());
    if (candidate.length > best.length || (candidate.length === best.length && candidate.join(">") < best.join(">"))) {
      best = candidate;
    }
  }
  return best;
}

function resourceView(
  resource: ResourceDescriptor,
  eligibility: Eligibility,
  conditions: ResourceConditionRecord[],
): OperationViewResource {
  const blocking = eligibility.eligible
    ? undefined
    : eligibility.blocking.map((condition) => ({
        condition: condition.condition,
        reason: condition.reason,
        scope: condition.scope,
        ...(condition.eligibleAt ? { eligibleAt: condition.eligibleAt } : {}),
      }));
  return {
    id: resource.id,
    provider: resource.provider,
    model: resource.model,
    ...(resource.rank !== undefined ? { rank: resource.rank } : {}),
    capabilities: [...resource.capabilities],
    ...(resource.contextLength !== undefined ? { contextLength: resource.contextLength } : {}),
    ...(resource.taskClass ? { taskClass: resource.taskClass } : {}),
    eligible: eligibility.eligible,
    ...(blocking ? { blocking } : {}),
    ...(eligibility.eligibleAt !== undefined ? { eligibleAt: new Date(eligibility.eligibleAt).toISOString() } : {}),
  };
}

/**
 * Project a persisted operation. Pure: the state is read, never modified, and no scheduling decision is recomputed —
 * only the facts the operator needs to see what Nexus is doing and why.
 */
export function buildOperationView(
  state: DurableOperationState,
  options: OperationViewOptions = {},
): OperationView {
  const now = options.now ?? Date.now();
  const registry = new ResourceRegistry(state.resources, state.conditions, { now: () => now, random: () => 0.5 });
  const { depth, missing, cycles } = unitDepths(state.units);
  const edges = state.units.flatMap((unit) => unit.dependsOn.map((from) => ({ from, to: unit.id })));
  const eventLimit = Math.max(0, options.events ?? 20);
  const events: OperationViewEvent[] = (eventLimit === 0 ? [] : state.events.slice(-eventLimit)).map((event) => ({
    type: event.type,
    at: event.at,
    message: event.message,
    ...(event.unitId ? { unitId: event.unitId } : {}),
    ...(event.resourceId ? { resourceId: event.resourceId } : {}),
  }));

  const decisionIds = new Set<string>();
  const openDecisions = [
    ...(state.blocked?.decisions ?? []),
    ...state.units.flatMap((unit) => (unit.blocked ? [unit.blocked.decision] : [])),
  ].filter((decision) => {
    if (decisionIds.has(decision.id)) return false;
    decisionIds.add(decision.id);
    return true;
  });

  const units: OperationViewUnit[] = state.units.map((unit) => ({
    id: unit.id,
    title: unit.title,
    ...(unit.role ? { role: unit.role } : {}),
    status: unit.status,
    ...(detailFor(unit) ? { detail: detailFor(unit) } : {}),
    dependsOn: [...unit.dependsOn],
    required: unit.required !== false,
    depth: depth.get(unit.id) ?? 0,
    durable: Boolean(unit.agentTaskId),
    runs: unit.runs,
    ...(unit.assignment ? { assignment: { ...unit.assignment } } : {}),
    ...(unit.parked?.wakeAt ? { parkedUntil: unit.parked.wakeAt } : {}),
    ...(unit.blocked ? { blocked: { reason: unit.blocked.reason, decisionId: unit.blocked.decision.id } } : {}),
    ...(unit.result
      ? {
          result: {
            summary: unit.result.summary,
            completedAt: unit.result.completedAt,
            resourceId: unit.result.resourceId,
            outcome: unit.result.outcome,
          },
        }
      : {}),
  }));

  const count = (status: WorkUnit["status"]) => state.units.filter((unit) => unit.status === status).length;

  return {
    schemaVersion: OPERATION_VIEW_SCHEMA_VERSION,
    id: state.id,
    objective: state.objective,
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    terminal: state.status === "COMPLETE" || state.status === "CANCELLED",
    counts: {
      total: state.units.length,
      complete: count("COMPLETE"),
      running: count("RUNNING"),
      blocked: count("BLOCKED"),
      parked: count("PARKED"),
      ready: count("RUNNABLE"),
      waiting: count("WAITING_ON_DEPENDENCY"),
    },
    units,
    resources: state.resources.map((resource) => resourceView(resource, registry.eligibility(resource, now), state.conditions)),
    ...(state.wait ? { wait: { ...state.wait, parkedUnits: [...state.wait.parkedUnits] } } : {}),
    decisions: openDecisions.map((decision) => ({
      id: decision.id,
      unitId: decision.unitId,
      cause: decision.cause,
      question: decision.question,
      options: decision.options.map((option) => ({ id: option.id, label: option.label })),
      command: `nexus operation decide ${state.id} ${decision.id} <option> [--note <text>]`,
    })),
    dag: {
      nodes: state.units.map((unit) => ({
        id: unit.id,
        status: unit.status,
        dependsOn: [...unit.dependsOn],
        required: unit.required !== false,
      })),
      edges,
      criticalPath: criticalPath(state.units),
      missingDependencies: missing,
      cycles,
    },
    events,
  };
}

const STATUS_MARK: Record<WorkUnit["status"], string> = {
  RUNNING: "▶",
  RUNNABLE: "·",
  WAITING_ON_DEPENDENCY: "·",
  PARKED: "◷",
  BLOCKED: "✖",
  COMPLETE: "✔",
};

export interface RenderOptions {
  /** Maximum width for titles; 0 disables truncation. */
  width?: number;
}

/** Untrusted operation text is made terminal-safe before it is measured or printed. */
function text(value: string, width: number): string {
  // safeTerminal redacts secrets and makes controls visible, but keeps LF/TAB; the view is line-oriented, so a
  // operation-supplied newline is folded rather than allowed to forge an extra line.
  const safe = safeTerminal(String(value)).replace(/[\r\n\t]+/g, " ");
  if (width <= 0 || safe.length <= width) return safe;
  return `${safe.slice(0, Math.max(0, width - 1))}…`;
}

/** Human-readable rendering of a view. Deterministic: same view, same text, no live terminal control characters. */
export function renderOperationView(view: OperationView, options: RenderOptions = {}): string {
  const width = options.width ?? 0;
  const lines: string[] = [];
  const counts = view.counts;
  lines.push(
    `Operation ${text(view.id, width)}: ${view.status} (${counts.complete}/${counts.total} complete` +
      `${counts.running ? `, ${counts.running} running` : ""}` +
      `${counts.ready ? `, ${counts.ready} ready` : ""}` +
      `${counts.blocked ? `, ${counts.blocked} blocked` : ""}` +
      `${counts.parked ? `, ${counts.parked} parked` : ""})`,
  );
  lines.push(`  ${text(view.objective, width)}`);
  lines.push(`  updated ${text(view.updatedAt, width)}`);

  if (view.units.length) {
    lines.push("", "Units");
    const ordered = [...view.units].sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
    for (const unit of ordered) {
      const indent = "  ".repeat(Math.min(unit.depth, 8));
      const mark = STATUS_MARK[unit.status] ?? "·";
      const role = unit.role ? ` [${text(unit.role, width)}]` : "";
      const runs = unit.runs > 1 ? ` · ${unit.runs} runs` : "";
      const durable = unit.durable ? " · durable" : "";
      lines.push(
        `${indent}${mark} ${text(unit.id, width)}${role} ${text(unit.title, width)}  ${unit.status}${runs}${durable}`,
      );
      if (unit.detail) lines.push(`${indent}  ${text(unit.detail, width)}`);
      if (unit.dependsOn.length) lines.push(`${indent}  after: ${unit.dependsOn.map((id) => text(id, width)).join(", ")}`);
    }
  }

  if (view.dag.criticalPath.length > 1) {
    lines.push("", `Critical path: ${view.dag.criticalPath.map((id) => text(id, width)).join(" → ")}`);
  }
  if (view.dag.missingDependencies.length) {
    lines.push(`Missing dependencies: ${view.dag.missingDependencies.map((id) => text(id, width)).join(", ")}`);
  }
  if (view.dag.cycles.length) lines.push(`Dependency cycle at: ${view.dag.cycles.map((id) => text(id, width)).join(", ")}`);

  if (view.resources.length) {
    lines.push("", "Resources");
    for (const resource of view.resources) {
      const state = resource.eligible
        ? "eligible"
        : `ineligible${resource.eligibleAt ? ` until ${text(resource.eligibleAt, width)}` : ""}`;
      lines.push(`  ${text(resource.id, width)} · ${text(resource.model, width)} · ${state}`);
      for (const blocking of resource.blocking ?? []) {
        lines.push(
          `    ${blocking.condition} (${blocking.scope}): ${text(blocking.reason, width)}`,
        );
      }
    }
  }

  if (view.wait) lines.push("", `Waiting until ${text(view.wait.wakeAt, width)}: ${text(view.wait.reason, width)}`);

  if (view.decisions.length) {
    for (const decision of view.decisions) {
      lines.push("", `Decision needed: ${text(decision.question, width)}`);
      lines.push(`  unit ${text(decision.unitId, width)} · ${text(decision.cause, width)}`);
      for (const option of decision.options) lines.push(`  [${text(option.id, width)}] ${text(option.label, width)}`);
      lines.push(`  ${text(decision.command, width)}`);
    }
  }

  if (view.events.length) {
    lines.push("", `Events (last ${view.events.length})`);
    for (const event of view.events) {
      const target = event.unitId ? ` ${text(event.unitId, width)}` : event.resourceId ? ` ${text(event.resourceId, width)}` : "";
      lines.push(`  ${text(event.at, width)} ${text(event.type, width)}${target}: ${text(event.message, width)}`);
    }
  }

  return lines.join("\n");
}
