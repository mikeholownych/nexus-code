/**
 * BG-1/BG-2: what a run with no operator present may do ("unattended means stricter"). Pure: the worker of a detached
 * job applies it, and schedules only add triggers on top.
 *
 * An unattended run is never in auto mode, never has full access and never remembers a grant. Its approval policy is
 * review mode with one prompt removed (writes inside the job's fresh worktree, when the job was started with
 * worktree-write); every command and every egress call still needs a decision, and with nobody to give one the call is
 * denied and the turn ends BLOCKED with its question.
 */
import type { HarnessConfig } from "../types.js";
import { ApprovalPolicy, type PolicyContext } from "./approval_policy.js";
import type { EffectClass } from "./capabilities.js";
import type { EffectivePolicy } from "./managed_policy.js";
import { humanRequirementForEffect, managedPolicy } from "./policy_runtime.js";
import type { JobPolicy, JobRecord } from "./runner_store.js";

export const UNATTENDED_SURFACE = "unattended";

/**
 * Removed from the worker's environment before any configuration or trust is read. The runner's environment comes
 * from systemd or a shell the operator does not see per job, so none of these may widen what a job can do.
 */
export const UNATTENDED_ENV_SCRUB = ["NEXUS_TRUST_WORKSPACE", "NEXUS_APPROVAL_MODE", "NEXUS_SANDBOX_NETWORK", "NEXUS_EGRESS_POLICY"] as const;

/** Deletes the scrubbed variables from `env` and returns the names that were set. */
export function scrubUnattendedEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const name of UNATTENDED_ENV_SCRUB) {
    if (env[name] === undefined) continue;
    delete env[name];
    removed.push(name);
  }
  return removed;
}

/** A configuration an unattended run must not start with. The worker ends the job FAILED with reason `UNATTENDED_CLAMP`. */
export class UnattendedClampError extends Error {
  readonly reason = "UNATTENDED_CLAMP";
  constructor(problem: string) {
    super(`Refusing to start an unattended run: ${problem}.`);
    this.name = "UnattendedClampError";
  }
}

export type UnattendedJob = Pick<JobRecord, "workspace" | "policy" | "verifier" | "deliverables" | "provider" | "budgets">;

/** The approval mode a job policy runs under. There is no entry for auto. */
export function unattendedApprovalMode(policy: JobPolicy): "review" | "read-only" {
  return policy === "worktree-write" ? "review" : "read-only";
}

/** The options the normal `buildConfig` is called with for a job. Nothing here comes from the environment. */
export function unattendedOptions(job: UnattendedJob): Record<string, unknown> {
  return {
    workspace: job.workspace,
    // An explicit flag outranks NEXUS_APPROVAL_MODE in buildConfig's precedence, wherever that variable is set.
    ...(job.policy === "worktree-write" ? { approve: true } : { readOnly: true }),
    sandbox: "auto",
    maxTotalSteps: job.budgets.maxTotalSteps,
    maxToolInvocations: job.budgets.maxToolInvocations,
    maxInferenceSubmissions: job.budgets.maxInferenceSubmissions,
    maxTurnMinutes: job.budgets.maxTurnMinutes,
    ...(job.verifier !== null ? { authoritativeVerifier: job.verifier } : {}),
    ...(job.deliverables.length ? { deliverableFile: [...job.deliverables] } : {}),
    ...job.provider,
  };
}

/**
 * Throws unless `config` is one an unattended run of this policy may use. `sandboxNetwork` is the process's own answer
 * (`sandboxNetworkEnabled()`): an operator settings file can switch the sandbox's network on, and that also refuses.
 */
export function assertUnattended(config: HarnessConfig, policy: JobPolicy, sandboxNetwork: boolean): void {
  const mode = unattendedApprovalMode(policy);
  if (config.approvalMode !== mode) throw new UnattendedClampError(`the approval mode is ${String(config.approvalMode)}, not ${mode}`);
  if (config.fullAccess) throw new UnattendedClampError("full access is on");
  if (config.yes) throw new UnattendedClampError("--yes is set");
  if (config.dryRun) throw new UnattendedClampError("dry-run is on, so its receipts would not describe real work");
  if (config.surface !== UNATTENDED_SURFACE) throw new UnattendedClampError("the run is not marked unattended");
  if (!config.sandbox || String(config.sandbox).trim().toLowerCase() === "none") throw new UnattendedClampError("the sandbox is off");
  if (sandboxNetwork) throw new UnattendedClampError("network access inside the sandbox is on");
}

/**
 * The configuration of a job: the operator's own configuration through the normal `buildConfig`, then the clamp, then
 * the postcondition. `buildConfig` applies managed policy as for any run, so policy can only tighten what this allows.
 */
export function unattendedConfig(job: UnattendedJob, buildConfig: (options: Record<string, unknown>) => HarnessConfig, sandboxNetwork: boolean): HarnessConfig {
  const config = buildConfig(unattendedOptions(job));
  config.surface = UNATTENDED_SURFACE;
  config.fullAccess = false;
  config.yes = false;
  config.sandbox = "auto";
  assertUnattended(config, job.policy, sandboxNetwork);
  return config;
}

/**
 * The approval policy of an unattended run. It answers as review mode does, with every remembered egress approval
 * ignored, and removes one prompt: a workspace write when the job policy is worktree-write (the workspace is the job's
 * own fresh worktree, and file tools refuse paths outside it). Managed `require_human` still asks for that write.
 * The mode the agent passes in is not consulted, so nothing that sets a mode can loosen this.
 */
export class UnattendedApprovalPolicy extends ApprovalPolicy {
  constructor(
    private readonly jobPolicy: JobPolicy,
    private readonly managed: () => EffectivePolicy = managedPolicy,
  ) {
    super(managed);
  }

  public override requiresDecision(effect: EffectClass, context: PolicyContext): boolean {
    if (effect === "write_workspace" && this.jobPolicy === "worktree-write") {
      return Boolean(context.policyRequiresHuman || humanRequirementForEffect(this.managed(), effect));
    }
    return super.requiresDecision(effect, { ...context, mode: "review", fullAccess: false, approvedEgressOrigins: undefined });
  }
}
