/**
 * /team: an orchestration strategy over the convergence foundation.
 *
 * A team is a durable operation whose work units are roles with real dependencies. Every role runs through the same
 * lower path as any scheduled unit — a truthful agent turn with provider recovery and context admission, on a
 * resource chosen by qualification and eligibility, with durable state, replay safety and cancellation — and the
 * team is COMPLETE only when every required role is COMPLETE. A role whose turn did not establish a result is
 * BLOCKED on a decision, never reported as done.
 */
import { randomUUID } from "node:crypto";
import { isRequired, newOperation } from "./core/operation.js";
import { AgentWorkUnitExecutor, driveOperation, OperationStore, resourcesFromConfig } from "./core/operation_runner.js";
import { ROLE_PROFILES, ROLE_REQUIREMENTS, roleRequirements } from "./core/roles.js";
export { ROLE_PROFILES, ROLE_REQUIREMENTS } from "./core/roles.js";
export const TEAM_ROLES = ["researcher", "architect", "implementer", "tester", "reviewer"];
const UNIT_ID = { researcher: "research", architect: "design", implementer: "implement", tester: "verify", reviewer: "review" };
/** Role turns keep the step bound the team has always used. */
const ROLE_MAX_STEPS = 15;
/**
 * The work graph for a team target. The full workflow's chain is a genuine data dependency (design needs the
 * research, implementation needs the design, verification needs the implementation). Independent review needs only
 * the implementation, so it runs alongside verification, and must use a model the implementation did not use.
 */
export function teamUnits(target, objective, opts = {}) {
    const unit = (role, dependsOn, independentOf) => ({
        id: UNIT_ID[role],
        title: ROLE_PROFILES[role].title,
        role,
        prompt: objective,
        dependsOn,
        requires: roleRequirements(role, independentOf ? { independentOf } : {}),
        ...(ROLE_REQUIREMENTS[role].taskClass ? { taskClass: ROLE_REQUIREMENTS[role].taskClass } : {}),
    });
    if (target !== "full")
        return [unit(target, [])];
    const units = [unit("researcher", []), unit("architect", ["research"]), unit("implementer", ["design"]), unit("tester", ["implement"])];
    if (opts.independentReview)
        units.push(unit("reviewer", ["implement"], ["implement"]));
    return units;
}
export class TeamOrchestrator {
    config;
    opts;
    constructor(config, opts = {}) {
        this.config = config;
        this.opts = opts;
    }
    plan(target, objective) {
        const now = this.opts.clock?.now() ?? Date.now();
        const resources = this.opts.resources ?? resourcesFromConfig(this.config);
        return newOperation(this.opts.id ?? `team-${randomUUID().slice(0, 8)}`, objective, teamUnits(target, objective, this.opts), resources, now);
    }
    async run(target, objective) {
        return this.drive(this.plan(target, objective));
    }
    async drive(state) {
        const store = this.opts.store ?? new OperationStore(this.config.workspace);
        const executor = this.opts.executor ?? new AgentWorkUnitExecutor({ baseConfig: { ...this.config, maxSteps: Math.min(this.config.maxSteps, ROLE_MAX_STEPS) } });
        const operation = await driveOperation(state, {
            store,
            executor,
            signal: this.opts.signal,
            ...(this.opts.clock ? { clock: this.opts.clock } : {}),
            ...(this.opts.onEvent ? { onEvent: this.opts.onEvent } : {}),
            ...(this.opts.maxInProcessWaitMs !== undefined ? { maxInProcessWaitMs: this.opts.maxInProcessWaitMs } : {}),
        });
        const success = operation.status === "COMPLETE";
        return { operation, success, report: teamReport(operation) };
    }
}
function independence(op, u) {
    const of = u.requires.independentOf ?? [];
    if (!of.length || u.status !== "COMPLETE")
        return "";
    if (u.result?.overriding?.some((r) => r.includes("not independent")))
        return " — NOT independent (operator decision)";
    const others = of.flatMap((id) => op.units.find((x) => x.id === id)?.modelsUsed ?? []);
    return ` — independent of ${of.join(", ")} (${u.modelsUsed.join(", ")} vs ${others.join(", ") || "none"})`;
}
function unitLine(op, u) {
    const head = `[${(u.role ?? u.id).toUpperCase()}] ${u.status}${isRequired(u) ? "" : " (advisory)"}`;
    switch (u.status) {
        case "COMPLETE":
            return [`${head} on ${u.result.resourceId} (${u.result.outcome})${independence(op, u)}`, `  ${u.result.summary}`];
        case "PARKED":
            return [`${head} — ${u.parked.reason}; eligible again ${u.parked.wakeAt}`];
        case "BLOCKED":
            if (!u.blocked)
                return [`${head}${u.dropped ? " — dropped by operator" : ""}`];
            return [
                `${head} — ${u.blocked.reason}`,
                `  Decision ${u.blocked.decision.id}: ${u.blocked.decision.question}`,
                ...u.blocked.decision.options.map((o) => `    [${o.id}] ${o.label}`),
                `  Apply with: nexus operation decide ${op.id} ${u.blocked.decision.id} <option> [--note <text>]`,
            ];
        case "WAITING_ON_DEPENDENCY":
            return [`${head} — needs ${u.dependsOn.filter((d) => op.units.find((x) => x.id === d)?.status !== "COMPLETE").join(", ")}`];
        default:
            return [`${head}${u.assignment ? ` on ${u.assignment.resourceId}` : ""}`];
    }
}
export function teamReport(op) {
    const lines = [`=== Team ${op.id}: ${op.status} ===`, `Objective: ${op.objective}`, ""];
    for (const u of op.units)
        lines.push(...unitLine(op, u), "");
    if (op.wait)
        lines.push(`Waiting until ${op.wait.wakeAt}: ${op.wait.reason}`);
    lines.push(op.status === "COMPLETE" ? "Result: COMPLETE" : `Result: NOT COMPLETE (${op.status})`);
    if (op.status === "WAITING" || op.status === "CANCELLED")
        lines.push(`Resume with: nexus operation resume ${op.id}`);
    return lines.join("\n");
}
