/**
 * `nexus operation run|resume|status`: convergence-scheduled operations from a work-unit spec.
 *
 * Spec (JSON): { "objective": string, "id"?: string, "units": WorkUnitSpec[], "resources"?: ResourceDescriptor[],
 * "discoverCatalog"?: boolean, "policy"?: Partial<OperationPolicy> }. Without "resources" the configured endpoint,
 * fallbacks and planner/coder models are the resources.
 *
 * `nexus operation decide <id> <decision> <option>` applies an operator decision to a BLOCKED unit: it is validated
 * against the persisted decision, recorded on the unit, and the operation is re-evaluated (and resumed unless
 * --no-resume). /team operations are ordinary operations and use the same commands.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import pc from "picocolors";
import { buildConfig } from "./config.js";
import { DecisionRejected, newOperation } from "./core/operation.js";
import { AgentWorkUnitExecutor, applyOperatorDecision, driveOperation, OperationStore, resourcesFromConfig } from "./core/operation_runner.js";
import { credentialFingerprint } from "./core/resources.js";
function normalizeResources(spec, config) {
    if (!spec.resources?.length)
        return resourcesFromConfig(config);
    const configOrigin = new URL(config.endpoint.replace(/\/+$/, "")).origin;
    return spec.resources.map((r) => {
        const endpoint = r.endpoint.replace(/\/+$/, "").endsWith("/v1") ? r.endpoint.replace(/\/+$/, "") : `${r.endpoint.replace(/\/+$/, "")}/v1`;
        const provider = r.provider ?? new URL(endpoint).origin;
        const key = r.apiKeyEnv ? process.env[r.apiKeyEnv] : provider === configOrigin ? config.apiKey : undefined;
        const account = r.account ?? credentialFingerprint(key);
        return { ...r, endpoint, provider, capabilities: r.capabilities ?? ["tools"], ...(account ? { account } : {}) };
    });
}
function printEvent(e) {
    const color = e.type === "OPERATION_BLOCKED" || e.type === "WORK_BLOCKED" ? pc.red : e.type.startsWith("RESOURCE_") ? pc.dim : e.type === "OPERATION_COMPLETED" ? pc.green : pc.cyan;
    console.log(color(`◆ ${e.message}`));
}
function printStatus(op) {
    console.log(pc.bold(`Operation ${op.id}: ${op.status}`) + pc.dim(`  (${op.objective})`));
    for (const u of op.units) {
        const extra = u.status === "PARKED" ? ` — ${u.parked.reason}; wakes ${u.parked.wakeAt}` :
            u.status === "BLOCKED" ? ` — ${u.blocked.reason}` :
                u.status === "COMPLETE" ? ` — on ${u.result.resourceId}` :
                    u.assignment ? ` — ${u.assignment.resourceId}` : "";
        console.log(`  ${u.status.padEnd(22)} ${u.title}${pc.dim(extra)}`);
    }
    if (op.wait)
        console.log(pc.yellow(`Waiting until ${op.wait.wakeAt}: ${op.wait.reason}`));
    for (const d of op.blocked?.decisions ?? []) {
        console.log(pc.red(`Decision ${d.id} needed: ${d.question}`));
        for (const o of d.options)
            console.log(pc.red(`  [${o.id}] ${o.label}`));
        if (d.options.length)
            console.log(pc.dim(`  nexus operation decide ${op.id} ${d.id} <option> [--note <text>]`));
    }
}
async function drive(op, config, store, discoverCatalog, json) {
    const controller = new AbortController();
    const onSignal = () => controller.abort();
    process.once("SIGINT", onSignal);
    try {
        const out = await driveOperation(op, {
            store,
            signal: controller.signal,
            executor: new AgentWorkUnitExecutor({ baseConfig: config, discoverCatalog }),
            ...(json ? {} : { onEvent: printEvent }),
        });
        if (json)
            console.log(JSON.stringify(out, null, 2));
        else
            printStatus(out);
        process.exitCode = out.status === "COMPLETE" ? 0 : out.status === "CANCELLED" ? 130 : 2;
    }
    finally {
        process.off("SIGINT", onSignal);
    }
}
export function registerOperationCommands(program) {
    const op = program.command("operation").description("Convergence-scheduled multi-unit operations (reroute, park, wait, resume)");
    const common = (c) => c
        .option("-e, --endpoint <url>", "Default endpoint (for resources not listed in the spec)")
        .option("-m, --model <name>", "Default model")
        .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
        .option("-s, --max-steps <number>", "Maximum steps per work unit", "30")
        .option("-t, --temperature <number>", "Model temperature", "0.2")
        .option("--shell <type>", "Shell for tools", "bash")
        .option("--context-limit <tokens>", "Context admission limit (default: 65536)")
        .option("--discover", "Read provider /v1/models metadata (capabilities, context, serving capacity)")
        .option("-j, --json", "Print the final operation state as JSON");
    common(op.command("run").argument("<spec>", "Operation spec JSON file"))
        .description("Start an operation from a work-unit spec")
        .action(async (specPath, options) => {
        const spec = JSON.parse(fs.readFileSync(path.resolve(specPath), "utf-8"));
        const config = buildConfig(options);
        const store = new OperationStore(config.workspace);
        const state = newOperation(spec.id ?? `op-${randomUUID().slice(0, 8)}`, spec.objective, spec.units, normalizeResources(spec, config), Date.now(), spec.policy);
        if (!options.json)
            console.log(pc.bold(`Operation ${state.id}`) + pc.dim(` — resume after a restart with: nexus operation resume ${state.id}`));
        await drive(state, config, store, Boolean(options.discover || spec.discoverCatalog), Boolean(options.json));
    });
    common(op.command("resume").argument("[id]", "Operation id (default: latest waiting/running operation in this workspace)"))
        .description("Resume an operation from durable state (after a restart, the wait continues or re-evaluates if overdue)")
        .action(async (id, options) => {
        const config = buildConfig(options);
        const store = new OperationStore(config.workspace);
        const state = id ? store.load(id) : store.latestResumable();
        if (!state)
            throw new Error("No waiting or running operation in this workspace.");
        if (state.status === "CANCELLED")
            state.status = "RUNNING";
        await drive(state, config, store, Boolean(options.discover), Boolean(options.json));
    });
    common(op.command("decide").argument("<id>", "Operation id").argument("<decision>", "Decision id (e.g. review#1)").argument("<option>", "Option id"))
        .option("--note <text>", "Operator note (required to revise a unit)")
        .option("--no-resume", "Record the decision without resuming the operation")
        .description("Apply an operator decision to a blocked unit, then resume the operation")
        .action(async (id, decisionId, optionId, options) => {
        const config = buildConfig(options);
        const store = new OperationStore(config.workspace);
        let state;
        try {
            state = applyOperatorDecision(store, id, decisionId, optionId, options.note, { onEvent: printEvent });
        }
        catch (err) {
            if (!(err instanceof DecisionRejected))
                throw err;
            console.error(pc.red(`Decision rejected: ${err.message}`));
            process.exitCode = 2;
            return;
        }
        if (options.resume === false)
            return void printStatus(state);
        await drive(state, config, store, Boolean(options.discover), Boolean(options.json));
    });
    op.command("status")
        .argument("[id]", "Operation id (default: all operations in this workspace)")
        .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
        .option("-j, --json", "JSON output")
        .description("Show operation state, parked work, wake time and pending decisions")
        .action((id, options) => {
        const store = new OperationStore(path.resolve(options.workspace ?? process.cwd()));
        const ops = id ? [store.load(id)] : store.list();
        if (options.json)
            return void console.log(JSON.stringify(ops, null, 2));
        if (!ops.length)
            return void console.log("No operations in this workspace.");
        ops.forEach(printStatus);
    });
}
