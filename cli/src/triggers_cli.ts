/**
 * `nexus triggers`: list trigger trust status, approve or revoke a workspace's trigger specs (BG-3 trust model).
 *
 * Approving a trigger is the act of a person at a terminal: there is no `--yes`, and without a terminal nothing is
 * approved. A trigger spec's bytes are pinned by SHA-256; changed bytes are a different spec and need a new approval.
 *
 * The trigger firer (core/trigger_firer.ts, run by `nexus runner serve`) builds on this trust surface. This CLI is the trust surface it
 * builds on: `nexus triggers list` shows what is approved and what is not, `approve` pins a spec by hash, `revoke`
 * withdraws approval. A firer reads `triggerMayRun` from trigger_trust.ts before starting any run.
 */

import * as path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import {
  triggerTrustStorePath,
  readTriggerTrustStore,
  approveTrigger,
  revokeTrigger,
  triggerTrustEntry,
  entryForSpec,
  triggerMayRun,
  workspaceMayHaveTriggers,
  decideTriggerTrust,
} from "./core/trigger_trust.js";
import {
  type TriggerSpec,
  type TriggerTrustEntry,
} from "./core/trigger_spec.js";
import { parseTriggerFile, specSha256 } from "./core/trigger_load.js";
import { globToRegExp, isExcludedEventPath, resolveInside, specPathProblem, workspaceKey } from "./core/trigger_paths.js";
import { planTriggerRun, type TriggerEvent } from "./core/trigger_run.js";
import { limiterView, queueRelease, readTriggerState, triggerStatePaths, type TriggerRuntime, type TriggerStateDoc } from "./core/trigger_state.js";
import { runnerAlive } from "./core/job_runner.js";
import { runnerPaths } from "./core/runner_store.js";
import { realWorkspace } from "./workspace_trust.js";
import { hookLine } from "./core/hook_runner.js";

export interface TriggersCliDeps {
  /** Asks a yes/no question on the terminal. */
  confirm?: (question: string) => Promise<boolean>;
  /** Whether there is a terminal to ask on. */
  interactive?: () => boolean;
  /** The clock (epoch ms) that quarantines and rate windows are read against. Tests only. */
  now?: () => number;
}

/** The terminal ended or was closed before an answer: nothing was approved. */
export class NoAnswerError extends Error {
  constructor() {
    super("no answer was given (the input ended or was closed)");
    this.name = "NoAnswerError";
  }
}

/** Asks on the terminal. Only the exact text `yes` approves: no case folding, no trimming. Throws `NoAnswerError` at end of input. */
export async function confirmOnTerminal(question: string, io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}): Promise<boolean> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: io.input ?? process.stdin, output: io.output ?? process.stdout });
  try {
    const answer = await new Promise<string>((resolve, reject) => {
      rl.once("close", () => reject(new NoAnswerError()));
      rl.question(question).then(resolve, () => reject(new NoAnswerError()));
    });
    return answer === "yes";
  } finally {
    rl.close();
  }
}

const workspaceOf = (options: { workspace?: string }) => path.resolve(options.workspace ?? process.cwd());

/** One trigger as `nexus triggers list` shows it. */
interface ListedTrigger {
  id: string;
  kind: string;
  policy: string;
  status: "approved" | "not_approved" | "changed" | "absent";
  sha256?: string;
  problem?: string;
  bounds: string;
}

/** The most of one field `approve` prints; a longer one is not shown in full and so is not approved. */
export const APPROVE_FIELD_CAP = 4000;


/** A value as JSON with every control and non-ASCII character escaped, so what is printed is what is hashed. */
const shown = (value: unknown): string =>
  JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/**
 * Everything approving `spec` authorises, as lines to print: each field of the canonical spec, in full. Any field
 * longer than `APPROVE_FIELD_CAP` is cut with a count and sets `complete: false` (approval is refused).
 */
export function describeTriggerSpec(spec: TriggerSpec): { lines: string[]; sha256: string; complete: boolean } {
  const sha256 = specSha256(spec);
  let complete = true;
  const field = (label: string, value: string): string => {
    const text = shown(value);
    if (text.length <= APPROVE_FIELD_CAP) return `  ${label}: ${text}`;
    complete = false;
    return `  ${label}: ${text.slice(0, APPROVE_FIELD_CAP)}\n    [${text.length - APPROVE_FIELD_CAP} more characters, not shown: refuse to approve a spec you cannot read in full]`;
  };
  const lines = [`${spec.event.kind} trigger ${shown(spec.id)}  canonical sha256 ${sha256}`];
  lines.push(`  kind: ${spec.event.kind}`);
  for (const p of [...(spec.event.paths ?? [])].sort()) lines.push(field("event.path", p));
  for (const o of [...(spec.event.allowedOrigins ?? [])].sort()) lines.push(field("event.allowedOrigin", o));
  if (spec.event.kind === "webhook" && spec.event.allowedOrigins === undefined) lines.push("  event.allowedOrigins: none (any origin)");
  if (spec.event.secret !== undefined) lines.push("  secret: an inline secret is configured (not shown; it sits in the repository file)");
  else if (spec.event.secretEnv !== undefined) lines.push(field("secret: read from environment variable", spec.event.secretEnv));
  else lines.push("  secret: none");
  lines.push(field("action.prompt", spec.action.prompt));
  lines.push(`  action.policy: ${spec.action.policy}`);
  lines.push(spec.action.verifier != null ? field("action.verifier", spec.action.verifier) : "  action.verifier: none");
  lines.push(`  rate: ${spec.rate.maxPerMinute}/minute, ${spec.rate.maxPerHour}/hour, ${spec.rate.maxPerDay}/day`);
  lines.push(`  bounds: ${boundsText(spec)}`);
  return { lines, sha256, complete };
}

function boundsText(spec: TriggerSpec): string {
  return `${spec.bounds.maxToolInvocations} tools / ${spec.bounds.maxRounds} rounds / ${spec.bounds.maxTurnMinutes} min`;
}

function listTriggers(workspace: string, entries: TriggerTrustEntry[]): ListedTrigger[] {
  const triggerFile = path.join(workspace, ".nexus", "triggers.json");
  const parsed = parseTriggerFile(triggerFile);
  if (parsed.problem) return [{ id: triggerFile, kind: "—", policy: "—", status: "absent", problem: parsed.problem, bounds: "—" }];
  const listed: ListedTrigger[] = [];
  for (const spec of parsed.specs) {
    const id: { scope: string; key: string } = { scope: realWorkspace(workspace), key: spec.id };
    const entry = triggerTrustEntry(entries, id);
    // status is per spec: compare each spec's own canonical hash
    const status: ListedTrigger["status"] = !entry ? "not_approved" : entry.sha256 === specSha256(spec) ? "approved" : "changed";
    listed.push({
      id: spec.id,
      kind: spec.event.kind,
      policy: spec.action.policy,
      status,
      sha256: entry?.sha256,
      bounds: boundsText(spec),
    });
  }
  return listed;
}

function printTrigger(entry: ListedTrigger): void {
  const colour = entry.status === "approved" ? pc.green : entry.status === "changed" ? pc.yellow : pc.dim;
  console.log(`${pc.bold(entry.id)}  ${entry.kind}  ${entry.policy}  ${colour(entry.status)}${entry.sha256 ? pc.dim(`  sha256 ${entry.sha256}`) : ""}  ${entry.bounds}`);
  if (entry.problem) console.log(`  ${pc.red(hookLine(entry.problem))}`);
}

export function registerTriggerCommands(program: Command, deps: TriggersCliDeps = {}): void {
  const confirm = deps.confirm ?? confirmOnTerminal;
  const clock = deps.now ?? Date.now;
  const interactive = deps.interactive ?? (() => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    return Boolean(stdin.isTTY) && Boolean(stdout.isTTY);
  });

  const triggers = program.command("triggers").description("Event triggers: approvals, status and dry runs (BG-3; docs/TRIGGERS.md)");

  triggers
    .command("list")
    .description("Show this workspace's trigger specs and whether each is approved")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .option("-j, --json", "Print the listing as JSON")
    .action((options: { workspace?: string; json?: boolean }) => {
      const workspace = workspaceOf(options);
      const entries = readTriggerTrustStore().entries;
      const trusted = workspaceMayHaveTriggers(workspace);
      const listed = listTriggers(workspace, entries);
      if (options.json) {
        console.log(JSON.stringify({ workspace, trusted, triggers: listed }, null, 2));
      } else {
        console.log(`Workspace: ${workspace}`);
        console.log(`Trusted for triggers: ${trusted ? "yes" : "no"}`);
        if (!trusted) console.log(pc.yellow("  Trust it with `nexus trust <workspace>` before any trigger can run here."));
        if (!listed.length) {
          console.log("  (no trigger specs in .nexus/triggers.json)");
        }
        for (const entry of listed) printTrigger(entry);
      }
    });

  triggers
    .command("approve")
    .description("Approve this workspace's .nexus/triggers.json as it is now (a later change needs a new approval)")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .option("--sha256 <hex>", "Approve only if the file has this SHA-256 (you are still asked; approving needs a terminal)")
    .action(async (options: { workspace?: string; sha256?: string }) => {
      const workspace = workspaceOf(options);
      const refuse = (message: string, code = 1) => {
        console.error(pc.red(message));
        process.exitCode = code;
      };
      const triggerFile = path.join(workspace, ".nexus", "triggers.json");
      const parsed = parseTriggerFile(triggerFile);
      if (!parsed.specs.length) return refuse(`There is no usable trigger spec in ${triggerFile}${parsed.problem ? ": " + parsed.problem : ""}.`);
      if (!workspaceMayHaveTriggers(workspace))
        return refuse(`Not approved: ${workspace} is not trusted for triggers. Run \`nexus trust ${workspace}\` first.`, 2);

      const rawSha256 = parsed.rawSha256 ?? "";
      console.log(`${shown(triggerFile)}\nfile sha256 ${rawSha256}\nApproving authorises each of these to run unattended when its event fires, exactly as printed:`);
      const described = parsed.specs.map((spec) => ({ spec, ...describeTriggerSpec(spec) }));
      for (const d of described) for (const line of d.lines) console.log(line);

      // Approving is the act of a person: a tool call of the agent has no terminal.
      if (!interactive()) {
        return refuse("Not approved: approving triggers needs a person at a terminal (standard input and output are not both a terminal). Review the file, then run `nexus triggers approve` yourself in a terminal.", 2);
      }
      const unreadable = described.filter((d) => !d.complete).map((d) => d.spec.id);
      if (unreadable.length) return refuse(`Not approved: ${unreadable.join(", ")} cannot be shown in full (a field is over ${APPROVE_FIELD_CAP} characters). Refuse to approve a spec you cannot read in full; shorten it.`, 2);
      const pinned = options.sha256?.trim().toLowerCase();
      if (pinned !== undefined && pinned !== rawSha256)
        return refuse(`Not approved: --sha256 does not match the file, whose SHA-256 is ${rawSha256}.`, 2);

      const now = new Date().toISOString();
      const scope = realWorkspace(workspace);
      let approved = 0;
      for (const d of described) {
        // The answer is about THIS hash: the first 12 hex digits of what was just printed in full.
        let yes: boolean;
        try {
          yes = await confirm(`Type "yes" (exactly, lowercase) to approve trigger ${d.spec.id} with canonical sha256 ${d.sha256.slice(0, 12)}…: `);
        } catch (error) {
          if (approved > 0) console.log(`Approved ${approved} trigger${approved === 1 ? "" : "s"} before the input ended.`);
          return refuse(`Not approved: ${d.spec.id}: ${error instanceof Error ? error.message : String(error)}.`, 2);
        }
        if (!yes) {
          console.log(`Not approved: ${d.spec.id}.`);
          continue;
        }
        approveTrigger(entryForSpec(scope, d.spec, now), { workspaceTrusted: true });
        approved++;
      }
      if (approved === 0) return refuse("Not approved.", 0);
      console.log(`Approved ${approved} trigger${approved === 1 ? "" : "s"} for ${scope}. Undo with \`nexus triggers revoke\`.`);
    });

  triggers
    .command("revoke")
    .description("Withdraw the approval of a trigger in this workspace")
    .argument("<id>", "Trigger id to revoke")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .action((id: string, options: { workspace?: string }) => {
      const workspace = workspaceOf(options);
      const removed = revokeTrigger({ scope: realWorkspace(workspace), key: id });
      console.log(removed ? `No longer approved: trigger ${id}` : `There was no approval for trigger ${id}.`);
    });

  triggers
    .command("status")
    .description("Show every trigger's state, or one trigger's trust decision (exit 0 when that trigger may run)")
    .argument("[id]", "Trigger id (default: all in this workspace)")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .action((id: string | undefined, options: { workspace?: string }) => {
      const workspace = workspaceOf(options);
      const real = realWorkspace(workspace);
      const parsed = parseTriggerFile(path.join(workspace, ".nexus", "triggers.json"));
      const entries = readTriggerTrustStore().entries;
      const runner = readRunnerState();
      const ids = id !== undefined ? [id] : [...new Set([...parsed.specs.map((s) => s.id), ...entries.filter((e) => e.scope === real).map((e) => e.key)])];
      if (id === undefined) {
        console.log(`Workspace: ${workspace}`);
        console.log(`Trusted for triggers: ${workspaceMayHaveTriggers(workspace) ? "yes" : "no"}`);
        if (parsed.problem) console.log(`  spec file: ${hookLine(parsed.problem, 400)}`);
        if (runner.problem) console.log(`  ${pc.yellow(hookLine(runner.problem, 400))}`);
        else if (runner.doc?.listener) console.log(`  webhook listener: ${runner.doc.listener.host}:${runner.doc.listener.port} (pid ${runner.doc.listener.pid})`);
        if (runner.doc?.limiterProblem) console.log(`  ${pc.red(hookLine(runner.doc.limiterProblem, 400))}`);
        if (!ids.length) console.log("  (no triggers)");
      }
      let mayRun = false;
      for (const one of ids) mayRun = printTriggerStatus(one, { now: clock(), workspace, real, parsed, entries, runner });
      process.exitCode = id !== undefined && !mayRun ? 1 : 0;
    });

  triggers
    .command("release")
    .description("Clear a trigger's quarantine (the runner applies it); needs a person at a terminal, like approve")
    .argument("<id>", "Trigger id")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .option("--limiter", "Also unlock the whole rate limiter after its stored state was refused")
    .action(async (id: string, options: { workspace?: string; limiter?: boolean }) => {
      const real = realWorkspace(workspaceOf(options));
      const refuse = (message: string, code = 2) => {
        console.error(pc.red(message));
        process.exitCode = code;
      };
      const runner = readRunnerState();
      const view = runner.doc ? limiterView(runner.doc.limiter, real, id, clock()) : undefined;
      console.log(`trigger ${shown(id)} in ${shown(real)}`);
      console.log(view?.quarantine ? `  quarantined: ${shown(view.quarantine.reason)}${view.quarantine.until ? ` until ${view.quarantine.until}` : " until an operator releases it"}` : "  quarantined: no (as of the runner's last state)");
      if (runner.doc?.limiterProblem) console.log(`  limiter: ${shown(runner.doc.limiterProblem)}`);
      if (!interactive()) return refuse("Not released: releasing needs a person at a terminal (standard input and output are not both a terminal).");
      let yes: boolean;
      try {
        yes = await confirm(`Type "yes" (exactly, lowercase) to release trigger ${id}${options.limiter ? " and unlock the limiter" : ""}: `);
      } catch (error) {
        return refuse(`Not released: ${error instanceof Error ? error.message : String(error)}.`);
      }
      if (!yes) return refuse("Not released.", 0);
      queueRelease(triggerStatePaths(runnerPaths()), { workspace: real, id, limiter: options.limiter === true }, new Date(clock()));
      console.log(runnerAlive(runnerPaths()) ? "Release requested: the runner applies it within a few seconds." : "Release requested: no runner is running; it is applied when `nexus runner serve` starts.");
    });

  triggers
    .command("fire-test")
    .description("Dry-run one event against a trigger: what would fire and what would be refused. Starts nothing, records nothing")
    .argument("<id>", "Trigger id")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .option("--path <path...>", "file-change: workspace-relative paths that changed")
    .option("--body <text>", "webhook: the request body")
    .action((id: string, options: { workspace?: string; path?: string[]; body?: string }) => {
      process.exitCode = fireTest(id, workspaceOf(options), options, clock()) ? 0 : 1;
    });
}

interface RunnerState {
  doc?: TriggerStateDoc;
  problem?: string;
}

function readRunnerState(): RunnerState {
  try {
    return { doc: readTriggerState(triggerStatePaths(runnerPaths())) };
  } catch (error) {
    return { problem: `the runner's trigger state cannot be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

interface StatusContext {
  now: number;
  workspace: string;
  real: string;
  parsed: ReturnType<typeof parseTriggerFile>;
  entries: TriggerTrustEntry[];
  runner: RunnerState;
}

/** The one word that says where a trigger stands. */
function stateWord(decision: ReturnType<typeof decideTriggerTrust>, runtime: TriggerRuntime | undefined, view: ReturnType<typeof limiterView>): string {
  if (!decision.workspaceTrusted) return "untrusted-workspace";
  if (decision.status === "MATCH") return view.quarantine ? "quarantined" : "approved";
  if (decision.status === "MISMATCH") return "changed";
  if (decision.status === "NEW") return runtime?.status === "revoked" || runtime?.seenApproved ? "revoked" : "not approved";
  return decision.status === "REMOVED" ? "removed" : "absent";
}

/** Prints one trigger's state and returns whether it may run now. */
function printTriggerStatus(id: string, ctx: StatusContext): boolean {
  const spec = ctx.parsed.specs.find((s) => s.id === id);
  const decision = decideTriggerTrust(ctx.entries, ctx.real, spec, spec ? specSha256(spec) : undefined);
  const runtime = ctx.runner.doc?.triggers.find((t) => t.workspace === ctx.real && t.id === id);
  const view = limiterView(ctx.runner.doc?.limiter, ctx.real, id, ctx.now);
  const may = triggerMayRun(decision);
  console.log(`trigger ${hookLine(id, 80)} in ${ctx.workspace}`);
  console.log(`  trusted: ${decision.workspaceTrusted ? "yes" : "no"} (the trusted-workspaces store; NEXUS_TRUST_WORKSPACE=1 does not count for triggers)`);
  if (ctx.parsed.problem) console.log(`  spec file: ${hookLine(ctx.parsed.problem, 400)}`);
  console.log(`  status: ${decision.status}`);
  console.log(`  may run: ${may ? "yes" : "no"}`);
  console.log(`  ${decision.reason}`);
  console.log(`  state: ${stateWord(decision, runtime, view)}`);
  if (!ctx.runner.doc) {
    console.log(ctx.runner.problem ? `  runner: ${hookLine(ctx.runner.problem, 400)}` : "  runner: no trigger state recorded (the runner records it once it has seen an approved trigger; is `nexus runner serve` running?)");
    return may;
  }
  if (runtime) {
    console.log(`  armed: ${runtime.armed ? "yes" : "no"}${runtime.note ? ` (${hookLine(runtime.note, 300)})` : ""}${runtime.watchedDirs !== undefined ? `; ${runtime.watchedDirs} director${runtime.watchedDirs === 1 ? "y" : "ies"} watched` : ""}`);
    console.log(`  fired: ${runtime.fired}${runtime.lastFire ? `; last ${runtime.lastFire.at} job ${runtime.lastFire.jobId} event ${runtime.lastFire.eventId}` : ""}`);
    console.log(`  refused: ${runtime.refused}${runtime.lastRefusal ? `; last ${runtime.lastRefusal.at}: ${hookLine(runtime.lastRefusal.reason, 400)}` : ""}`);
    const d = runtime.dropped;
    console.log(`  dropped: rate-limited ${d.rateLimited}, quarantined ${d.quarantined}, previous job running ${d.overlap}, over the pending bound ${d.pending}, outside the workspace ${d.escape}, repeated event ${d.duplicate}`);
    if (runtime.webhookPath) console.log(`  webhook: POST ${runtime.webhookPath}${ctx.runner.doc.listener ? ` on ${ctx.runner.doc.listener.host}:${ctx.runner.doc.listener.port}` : " (the runner has no listener open)"}`);
  } else console.log("  runner: it has not recorded this trigger yet");
  if (spec) console.log(`  rate used: ${view.used.minute}/${spec.rate.maxPerMinute} per minute, ${view.used.hour}/${spec.rate.maxPerHour} per hour, ${view.used.day}/${spec.rate.maxPerDay} per day`);
  if (view.quarantine) console.log(`  quarantine: ${hookLine(view.quarantine.reason, 200)}${view.quarantine.until ? ` until ${view.quarantine.until}` : " until an operator releases it"}; clear it with \`nexus triggers release ${id}\``);
  if (ctx.runner.doc.limiterProblem) console.log(`  limiter: ${hookLine(ctx.runner.doc.limiterProblem, 400)}`);
  return may;
}

/** The dry run. Returns whether the event would start a job. Reads the same files the firer reads and starts nothing. */
function fireTest(id: string, workspace: string, options: { path?: string[]; body?: string }, nowMs: number): boolean {
  const real = realWorkspace(workspace);
  const parsed = parseTriggerFile(path.join(real, ".nexus", "triggers.json"));
  const refusals: string[] = [];
  const spec = parsed.specs.find((s) => s.id === id);
  if (parsed.problem) refusals.push(parsed.problem);
  if (!spec) {
    console.log(`REFUSED: no trigger ${shown(id)} in ${shown(real)}`);
    return false;
  }
  const sha = specSha256(spec);
  const decision = decideTriggerTrust(readTriggerTrustStore().entries, real, spec, sha);
  console.log(`trigger ${shown(id)} (${spec.event.kind}) canonical sha256 ${sha}`);
  console.log(`  approval: ${decision.status}${triggerMayRun(decision) ? "" : ` - ${decision.reason}`}`);
  if (!triggerMayRun(decision)) refusals.push(decision.reason);
  const pathProblem = specPathProblem(real, spec);
  if (pathProblem) refusals.push(pathProblem);

  let event: TriggerEvent | undefined;
  if (spec.event.kind === "file-change") {
    const matchers = (spec.event.paths ?? []).map(globToRegExp);
    const counted: string[] = [];
    for (const raw of options.path ?? []) {
      const rel = raw.split(path.sep).join("/");
      const why = rel.startsWith("/") || rel.split("/").includes("..") ? "not a workspace-relative path"
        : isExcludedEventPath(rel) ? "never an event (.git, .nexus, trigger files)"
        : !matchers.some((m) => m.test(rel)) ? "matches none of the trigger's paths"
        : resolveInside(real, path.join(real, rel)) === undefined ? "resolves outside the workspace"
        : undefined;
      console.log(`  path ${shown(rel)}: ${why ? `ignored: ${why}` : "would count"}`);
      if (!why) counted.push(rel);
    }
    if (!(options.path ?? []).length) refusals.push("give at least one --path to test");
    else if (!counted.length) refusals.push("none of the paths would count as an event");
    event = { id: "fc-dry-run", kind: "file-change", paths: counted };
  } else {
    const name = spec.event.secretEnv;
    const secret = spec.event.secret ?? (name ? process.env[name] : undefined);
    console.log(`  secret: ${spec.event.secret ? "inline (in the repository file)" : name ? `${name} ${secret && secret.length >= 16 ? "is set in this shell" : "is NOT set (or under 16 characters) in this shell; the runner needs it in its own environment"}` : "none"}`);
    console.log(`  delivery: POST /hook/${workspaceKey(real)}/${id} with X-Nexus-Timestamp, X-Nexus-Delivery and X-Nexus-Signature (signatures are not checked here)`);
    const body = Buffer.from(options.body ?? "", "utf8");
    event = { id: "wh-dry-run", kind: "webhook", body, bodyBytes: body.length };
  }

  const runner = readRunnerState();
  const view = limiterView(runner.doc?.limiter, real, id, nowMs);
  if (view.quarantine) refusals.push(`quarantined: ${view.quarantine.reason}`);
  if (view.used.minute >= spec.rate.maxPerMinute || view.used.hour >= spec.rate.maxPerHour || view.used.day >= spec.rate.maxPerDay) refusals.push("rate limit reached (per the runner's last state)");
  if (runner.doc?.limiterProblem) refusals.push(runner.doc.limiterProblem);

  if (event && !refusals.length) {
    try {
      const plan = planTriggerRun({ workspace: real, spec, event, approvedSha256: sha });
      console.log(`  job: ${plan.job.policy}, fresh worktree from ${plan.job.baseCommit.slice(0, 12)}, unattended, budgets ${shown(plan.job.budgets)}`);
      console.log(`  prompt: ${shown(Object.values((plan.spec as { units: Array<{ prompt: string }> }).units)[0]!.prompt)}`);
    } catch (error) {
      refusals.push(`the job could not be submitted: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (refusals.length) {
    for (const r of refusals) console.log(`REFUSED: ${hookLine(r, 500)}`);
    console.log("WOULD NOT FIRE (nothing was started or recorded)");
    return false;
  }
  console.log("WOULD FIRE (nothing was started or recorded)");
  return true;
}
