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
import type { Command } from "commander";
import pc from "picocolors";
import { buildConfig } from "./config.js";
import { DecisionRejected, newOperation, type DurableOperationState, type OperationEvent, type OperationPolicy, type WorkUnitSpec } from "./core/operation.js";
import { AgentWorkUnitExecutor, applyOperatorDecision, driveOperation, OperationStore, resourcesFromConfig } from "./core/operation_runner.js";
import { credentialFingerprint, type ResourceDescriptor } from "./core/resources.js";
import { createOperationAccountIdentity } from "./core/account_identity.js";
import { credentialStorageHome, operatorSetting } from "./client.js";
import { baseUrlSetting, originOf, providerDefinition } from "./providers.js";
import { providerApiKey } from "./credentials.js";
import type { HarnessConfig } from "./types.js";

interface OperationSpec {
  id?: string;
  objective: string;
  units: WorkUnitSpec[];
  resources?: Array<Partial<ResourceDescriptor> & { id: string; endpoint?: string; model: string }>;
  discoverCatalog?: boolean;
  policy?: Partial<OperationPolicy>;
}

function normalizeResources(spec: OperationSpec, config: HarnessConfig, identity: ReturnType<typeof createOperationAccountIdentity>): ResourceDescriptor[] {
  if (!spec.resources?.length) return resourcesFromConfig(config, identity);
  const configOrigin = new URL(config.endpoint.replace(/\/+$/, "")).origin;
  return spec.resources.map((r) => {
    const def = providerDefinition(r.providerId);
    if (r.providerId && !def) throw new Error(`Resource ${r.id}: unknown providerId '${r.providerId}'.`);
    const base = def ? (r.endpoint || operatorSetting(baseUrlSetting(def.id)) || def.baseUrl || "") : "";
    if (def && !originOf(base)) throw new Error(`Resource ${r.id}: provider '${def.id}' needs an endpoint (base URL).`);
    if (!def && !r.endpoint) throw new Error(`Resource ${r.id}: endpoint is required unless providerId is given.`);
    const plain = (r.endpoint ?? "").replace(/\/+$/, "");
    // A provider base URL carries its own API path; only plain endpoints get the legacy /v1 suffix.
    const endpoint = def ? base.replace(/\/+$/, "") : plain.endsWith("/v1") ? plain : `${plain}/v1`;
    const provider = r.provider ?? (def ? def.id : new URL(endpoint).origin);
    const key = r.apiKeyEnv ? process.env[r.apiKeyEnv] : def ? providerApiKey(def.id, def.credentialEnv) : provider === configOrigin ? config.apiKey : undefined;
    const account = r.account ?? credentialFingerprint(key, identity);
    return {
      ...r,
      endpoint,
      provider,
      capabilities: r.capabilities ?? ["tools"],
      ...(account ? { account, accountIdentitySource: r.account !== undefined ? "explicit" as const : "credential" as const } : {}),
    } as ResourceDescriptor;
  });
}

function printEvent(e: OperationEvent): void {
  const color = e.type === "OPERATION_BLOCKED" || e.type === "WORK_BLOCKED" ? pc.red : e.type.startsWith("RESOURCE_") ? pc.dim : e.type === "OPERATION_COMPLETED" ? pc.green : pc.cyan;
  console.log(color(`◆ ${e.message}`));
}

function printStatus(op: DurableOperationState): void {
  console.log(pc.bold(`Operation ${op.id}: ${op.status}`) + pc.dim(`  (${op.objective})`));
  for (const u of op.units) {
    const extra =
      u.status === "PARKED" ? ` — ${u.parked!.reason}; wakes ${u.parked!.wakeAt}` :
      u.status === "BLOCKED" ? ` — ${u.blocked!.reason}` :
      u.status === "COMPLETE" ? ` — on ${u.result!.resourceId}` :
      u.assignment ? ` — ${u.assignment.resourceId}` : "";
    console.log(`  ${u.status.padEnd(22)} ${u.title}${pc.dim(extra)}`);
  }
  if (op.wait) console.log(pc.yellow(`Waiting until ${op.wait.wakeAt}: ${op.wait.reason}`));
  for (const d of op.blocked?.decisions ?? []) {
    console.log(pc.red(`Decision ${d.id} needed: ${d.question}`));
    for (const o of d.options) console.log(pc.red(`  [${o.id}] ${o.label}`));
    if (d.options.length) console.log(pc.dim(`  nexus operation decide ${op.id} ${d.id} <option> [--note <text>]`));
  }
}

async function drive(op: DurableOperationState, config: HarnessConfig, store: OperationStore, discoverCatalog: boolean, json: boolean): Promise<void> {
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
    if (json) console.log(JSON.stringify(out, null, 2));
    else printStatus(out);
    process.exitCode = out.status === "COMPLETE" ? 0 : out.status === "CANCELLED" ? 130 : 2;
  } finally {
    process.off("SIGINT", onSignal);
  }
}

export function registerOperationCommands(program: Command): void {
  const op = program.command("operation").description("[experimental] Convergence-scheduled multi-unit operations (reroute, park, wait, resume)");
  const common = (c: Command) =>
    c
      .option("-e, --endpoint <url>", "Default endpoint (for resources not listed in the spec)")
      .option("-m, --model <name>", "Default model")
      .option("--provider <id>", "Default cloud provider (openrouter, openai, anthropic, compatible)")
      .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
      .option("-s, --max-steps <number>", "Maximum steps per work unit", "30")
      .option("-t, --temperature <number>", "Model temperature", "0.2")
      .option("--shell <type>", "Shell for tools", "bash")
      .option("--context-limit <tokens>", "Context admission limit (default: 65536)")
      .option("--discover", "Read provider /v1/models metadata (capabilities, context, serving capacity)")
      .option("-j, --json", "Print the final operation state as JSON");

  common(op.command("run").argument("<spec>", "Operation spec JSON file"))
    .description("Start an operation from a work-unit spec")
    .action(async (specPath: string, options: any) => {
      const spec = JSON.parse(fs.readFileSync(path.resolve(specPath), "utf-8")) as OperationSpec;
      const config = buildConfig(options);
      const store = new OperationStore(config.workspace);
      const id = spec.id ?? `op-${randomUUID().slice(0, 8)}`;
      const createdAt = Date.now();
      const identity = createOperationAccountIdentity(credentialStorageHome());
      const state = newOperation(id, spec.objective, spec.units, normalizeResources(spec, config, identity), createdAt, spec.policy);
      if (!options.json) console.log(pc.bold(`Operation ${state.id}`) + pc.dim(` — resume after a restart with: nexus operation resume ${state.id}`));
      await drive(state, config, store, Boolean(options.discover || spec.discoverCatalog), Boolean(options.json));
    });

  common(op.command("resume").argument("[id]", "Operation id (default: latest waiting/running operation in this workspace)"))
    .description("Resume an operation from durable state (after a restart, the wait continues or re-evaluates if overdue)")
    .action(async (id: string | undefined, options: any) => {
      const config = buildConfig(options);
      const store = new OperationStore(config.workspace);
      const state = id ? store.load(id) : store.latestResumable();
      if (!state) throw new Error("No waiting or running operation in this workspace.");
      if (state.status === "CANCELLED") state.status = "RUNNING";
      await drive(state, config, store, Boolean(options.discover), Boolean(options.json));
    });

  common(op.command("decide").argument("<id>", "Operation id").argument("<decision>", "Decision id (e.g. review#1)").argument("<option>", "Option id"))
    .option("--note <text>", "Operator note (required to revise a unit)")
    .option("--no-resume", "Record the decision without resuming the operation")
    .description("Apply an operator decision to a blocked unit, then resume the operation")
    .action(async (id: string, decisionId: string, optionId: string, options: any) => {
      const config = buildConfig(options);
      const store = new OperationStore(config.workspace);
      let state: DurableOperationState;
      try {
        state = applyOperatorDecision(store, id, decisionId, optionId, options.note, { onEvent: printEvent });
      } catch (err) {
        if (!(err instanceof DecisionRejected)) throw err;
        console.error(pc.red(`Decision rejected: ${err.message}`));
        process.exitCode = 2;
        return;
      }
      if (options.resume === false) return void printStatus(state);
      await drive(state, config, store, Boolean(options.discover), Boolean(options.json));
    });

  op.command("status")
    .argument("[id]", "Operation id (default: all operations in this workspace)")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .option("-j, --json", "JSON output")
    .description("Show operation state, parked work, wake time and pending decisions")
    .action((id: string | undefined, options: any) => {
      const store = new OperationStore(path.resolve(options.workspace ?? process.cwd()));
      const ops = id ? [store.loadForInspection(id)] : store.listForInspection();
      if (options.json) return void console.log(JSON.stringify(ops, null, 2));
      if (!ops.length) return void console.log("No operations in this workspace.");
      ops.forEach(printStatus);
    });
}
