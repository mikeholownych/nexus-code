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
import { buildConfig, mergeOperationPolicy } from "./config.js";
import { DecisionRejected, newOperation, type DurableOperationState, type OperationEvent, type OperationPolicy, type WorkUnitSpec } from "./core/operation.js";
import { AgentWorkUnitExecutor, applyOperatorDecision, driveOperation, OperationLockedError, OperationStore, resourcesFromConfig } from "./core/operation_runner.js";
import { buildOperationView, renderOperationView, watchOperation } from "./operation_view.js";
import { ensureIntegrationWorktree, newOperationGitState, planOperationGit } from "./core/operation_git.js";
import { ContextCheckpointError, createContextCheckpoint, listContextCheckpoints, restoreContextCheckpoint } from "./core/operation_checkpoints.js";
import { safeTerminal } from "./ui.js";
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
  /** Opt-in Git isolation: each unit runs on its own worktree/branch; completions merge into an operation branch. */
  git?: { isolate?: boolean; baseRef?: string };
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
  console.log(color(`◆ ${safeTerminal(e.message)}`));
}

function printStatus(op: DurableOperationState): void {
  console.log(pc.bold(`Operation ${op.id}: ${op.status}`) + pc.dim(`  (${safeTerminal(op.objective)})`));
  for (const u of op.units) {
    const extra =
      u.status === "PARKED" ? ` — ${u.parked!.reason}; wakes ${u.parked!.wakeAt}` :
      u.status === "BLOCKED" ? ` — ${u.blocked!.reason}` :
      u.status === "COMPLETE" ? ` — on ${u.result!.resourceId}` :
      u.assignment ? ` — ${u.assignment.resourceId}` : "";
    console.log(`  ${u.status.padEnd(22)} ${safeTerminal(u.title)}${pc.dim(safeTerminal(extra))}`);
  }
  if (op.wait) console.log(pc.yellow(`Waiting until ${op.wait.wakeAt}: ${safeTerminal(op.wait.reason)}`));
  for (const d of op.blocked?.decisions ?? []) {
    console.log(pc.red(`Decision ${d.id} needed: ${safeTerminal(d.question)}`));
    for (const o of d.options) console.log(pc.red(`  [${o.id}] ${safeTerminal(o.label)}`));
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
      const policy = mergeOperationPolicy(config.operationPolicy, spec.policy);
      const state = newOperation(id, spec.objective, spec.units, normalizeResources(spec, config, identity), createdAt, policy);
      if (spec.git?.isolate) {
        try {
          const plan = planOperationGit(config.workspace, state.id, spec.git.baseRef);
          const gitState = newOperationGitState(plan);
          ensureIntegrationWorktree(plan, gitState);
          state.git = gitState;
        } catch (error: any) {
          // Leave any partially created pair in place: it is visible in `git worktree list` and may be the very state the
          // error asks the operator to repair. Deleting it could destroy work from an earlier same-id operation.
          console.error(pc.red(`Cannot start an isolated operation: ${error?.message ?? error}`));
          process.exitCode = 2;
          return;
        }
      }
      if (!options.json) {
        console.log(pc.bold(`Operation ${state.id}`) + pc.dim(` — resume after a restart with: nexus operation resume ${state.id}`));
        if (state.git) {
          console.log(pc.dim(`  isolated: units run on their own worktrees; integrations land on ${state.git.integrationBranch} (${state.git.integrationWorktree})`));
        }
      }
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
    .option("--dag", "Read-only view: work-unit DAG, resource eligibility and the open decision")
    .option("--events <count>", "Events to include with --dag (newest kept)", "20")
    .description("Show operation state, parked work, wake time and pending decisions")
    .action((id: string | undefined, options: any) => {
      const store = new OperationStore(path.resolve(options.workspace ?? process.cwd()));
      if (options.dag) {
        const eventsText = String(options.events);
        const eventLimit = Number(eventsText);
        if (!eventsText.trim() || !Number.isFinite(eventLimit) || eventLimit < 0) {
          console.error(pc.red(`--events must be a non-negative number (got '${options.events}')`));
          process.exitCode = 2;
          return;
        }
        // The view path never takes the operation lock, so it can inspect an operation another process is driving.
        // The state loader may still migrate or quarantine a legacy/corrupt record, exactly as `status` does.
        let ops: DurableOperationState[];
        try {
          ops = id ? [store.load(id)] : store.list();
        } catch (error: any) {
          console.error(pc.red(`Cannot read operation ${id ?? "(all)"}: ${safeTerminal(String(error?.message ?? error))}`));
          process.exitCode = 2;
          return;
        }
        const views = ops.map((state) => buildOperationView(state, { events: Math.floor(eventLimit) }));
        if (options.json) return void console.log(JSON.stringify(views, null, 2));
        if (!views.length) return void console.log("No operations in this workspace.");
        const width = process.stdout.isTTY ? process.stdout.columns ?? 0 : 0;
        views.forEach((view) => console.log(renderOperationView(view, { width })));
        return;
      }
      const ops = id ? [store.loadForInspection(id)] : store.listForInspection();
      if (options.json) return void console.log(JSON.stringify(ops, null, 2));
      if (!ops.length) return void console.log("No operations in this workspace.");
      ops.forEach(printStatus);
    });

  op.command("checkpoint")
    .argument("<id>", "Operation id")
    .argument("<unit>", "Work unit id")
    .option("--name <name>", "Checkpoint name (default: a timestamp)")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .description("Snapshot a settled unit's conversation so it can be restored later")
    .action((id: string, unitId: string, options: any) => {
      const store = new OperationStore(path.resolve(options.workspace ?? process.cwd()));
      const name = options.name ?? `cp-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      try {
        // Checkpointing mutates the operation document; hold the driver lock for the whole read-modify-write.
        const release = store.acquire(id);
        try {
          const state = store.load(id);
          const record = createContextCheckpoint(store.manager, state, unitId, name);
          store.save(state);
          console.log(pc.bold(`Checkpoint ${record.name}`) + pc.dim(` — ${record.messages} messages, ${record.bytes} bytes`));
          console.log(pc.dim(`  restore with: nexus operation restore ${id} ${unitId} ${record.name}`));
        } finally {
          release();
        }
      } catch (error: any) {
        if (error instanceof OperationLockedError) {
          console.error(pc.red(`Operation ${id} is being driven by another process; checkpoint it when the driver is stopped.`));
          process.exitCode = 2;
          return;
        }
        if (!(error instanceof ContextCheckpointError)) {
          console.error(pc.red(`Cannot checkpoint ${id}: ${safeTerminal(String(error?.message ?? error))}`));
          process.exitCode = 2;
          return;
        }
        console.error(pc.red(`Checkpoint rejected: ${safeTerminal(error.message)}`));
        process.exitCode = 2;
      }
    });

  op.command("checkpoints")
    .argument("<id>", "Operation id")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .option("-j, --json", "JSON output")
    .description("List the operation's context checkpoints")
    .action((id: string, options: any) => {
      const store = new OperationStore(path.resolve(options.workspace ?? process.cwd()));
      let state: DurableOperationState;
      try {
        state = store.load(id);
      } catch (error: any) {
        console.error(pc.red(`Cannot read operation ${id}: ${safeTerminal(String(error?.message ?? error))}`));
        process.exitCode = 2;
        return;
      }
      const checkpoints = listContextCheckpoints(state);
      if (options.json) return void console.log(JSON.stringify(checkpoints, null, 2));
      if (!checkpoints.length) return void console.log("No context checkpoints for this operation.");
      for (const checkpoint of checkpoints) {
        console.log(`  ${checkpoint.name.padEnd(28)} ${checkpoint.unitId.padEnd(20)} ${checkpoint.at}  ${checkpoint.messages} messages`);
      }
    });

  op.command("restore")
    .argument("<id>", "Operation id")
    .argument("<unit>", "Work unit id")
    .argument("<name>", "Checkpoint name")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .description("Restore a unit's conversation from a checkpoint (verification restarts fail-closed)")
    .action((id: string, unitId: string, name: string, options: any) => {
      const store = new OperationStore(path.resolve(options.workspace ?? process.cwd()));
      try {
        const release = store.acquire(id);
        try {
          const state = store.load(id);
          const restored = restoreContextCheckpoint(store.manager, state, unitId, name);
          store.save(state);
          console.log(pc.bold(`Restored ${unitId} from ${name}`) + pc.dim(` — ${restored.record.messages} messages`));
          if (restored.backup) console.log(pc.dim(`  previous task state kept at ${restored.backup}`));
          console.log(pc.yellow(`The restored conversation is recovered as unverified; resume with: nexus operation resume ${id}`));
        } finally {
          release();
        }
      } catch (error: any) {
        if (error instanceof OperationLockedError) {
          console.error(pc.red(`Operation ${id} is being driven by another process; restore it when the driver is stopped.`));
          process.exitCode = 2;
          return;
        }
        if (!(error instanceof ContextCheckpointError)) {
          console.error(pc.red(`Cannot restore ${id}: ${safeTerminal(String(error?.message ?? error))}`));
          process.exitCode = 2;
          return;
        }
        console.error(pc.red(`Restore rejected: ${safeTerminal(error.message)}`));
        process.exitCode = 2;
      }
    });

  op.command("watch")
    .argument("[id]", "Operation id (default: the only operation in this workspace)")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .option("--interval <seconds>", "Refresh interval (minimum 0.25)", "2")
    .option("--events <count>", "Events to include (newest kept)", "20")
    .description("Watch an operation read-only until it completes or you stop it (Ctrl-C)")
    .action(async (id: string | undefined, options: any) => {
      const store = new OperationStore(path.resolve(options.workspace ?? process.cwd()));
      const intervalSecs = Number(options.interval);
      const eventsText = String(options.events);
      const eventLimit = Number(eventsText);
      if (!Number.isFinite(intervalSecs) || intervalSecs <= 0 || !eventsText.trim() || !Number.isFinite(eventLimit) || eventLimit < 0) {
        console.error(pc.red("--interval must be a positive number of seconds and --events a non-negative number"));
        process.exitCode = 2;
        return;
      }
      let target = id;
      if (!target) {
        let operations: DurableOperationState[];
        try {
          operations = store.list();
        } catch (error: any) {
          console.error(pc.red(`Cannot read operations: ${safeTerminal(String(error?.message ?? error))}`));
          process.exitCode = 2;
          return;
        }
        if (!operations.length) {
          console.error(pc.red("No operations in this workspace."));
          process.exitCode = 2;
          return;
        }
        if (operations.length > 1) {
          console.error(pc.red("More than one operation in this workspace; pass an id:"));
          for (const operation of operations) {
            const id = safeTerminal(operation.id).replace(/[\r\n\t]+/g, " ");
            const status = safeTerminal(operation.status).replace(/[\r\n\t]+/g, " ");
            const objective = safeTerminal(operation.objective).replace(/[\r\n\t]+/g, " ");
            console.error(`  ${id}  ${status}  ${objective}`);
          }
          process.exitCode = 2;
          return;
        }
        target = operations[0].id;
      }
      const watchId = target;
      if (!process.stdout.isTTY) {
        // A pipe is not a live view; render the current snapshot once so scripts get an answer instead of a hang.
        let state: DurableOperationState;
        try {
          state = store.load(watchId);
        } catch (error: any) {
          console.error(pc.red(`Cannot read operation ${watchId}: ${safeTerminal(String(error?.message ?? error))}`));
          process.exitCode = 2;
          return;
        }
        const view = buildOperationView(state, { events: Math.floor(eventLimit) });
        console.log(renderOperationView(view));
        process.exitCode = state.status === "COMPLETE" ? 0 : state.status === "CANCELLED" ? 130 : 2;
        return;
      }
      const controller = new AbortController();
      const onSignal = () => controller.abort();
      process.once("SIGINT", onSignal);
      try {
        const result = await watchOperation({
          load: () => store.load(watchId),
          render: (state) =>
            renderOperationView(buildOperationView(state, { events: Math.floor(eventLimit) }), {
              width: process.stdout.columns ?? 0,
            }),
          intervalMs: Math.max(250, Math.round(intervalSecs * 1000)),
          signal: controller.signal,
          clear: true,
        });
        let status: DurableOperationState["status"] | undefined;
        try {
          status = store.load(watchId).status;
        } catch {
          status = undefined;
        }
        process.exitCode =
          result.stopped === "terminal" && status === "COMPLETE" ? 0 :
          result.stopped === "aborted" || status === "CANCELLED" ? 130 : 2;
      } finally {
        process.off("SIGINT", onSignal);
      }
    });
}
