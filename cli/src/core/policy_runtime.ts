/**
 * GV-1 enforcement: the managed policy of this process.
 *
 * The two managed tiers (system and user) are read once per process, on first use, and kept frozen: a later change to
 * either file, to HOME or to anything else does not reach a running process. A managed file that exists and cannot be
 * used makes every use throw the same `ManagedPolicyError`; the files are not read again. A workspace's project file
 * is read per workspace (a process works in several: worktrees, a verify base tree) and merged under the tiers that
 * were already read, so a project file can only ever add restrictions to them.
 *
 * Who acts on it: index.ts reads it at startup (a broken managed file ends the process there); config.ts refuses at
 * launch what it disables; approval_policy.ts clamps every approval decision; dispatch_tool_call.ts applies its
 * command prefixes and egress allowlist; security.ts takes the protected paths, verification mode and inspector floor
 * from it; workspace_trust.ts asks it whether the trust variable counts; agent.ts clamps a runtime mode change.
 *
 * Nothing here reads an environment variable or a command-line argument, and nothing exported from here replaces,
 * relocates or switches off the process policy: `createPolicyHost` builds a separate host from explicit inputs (tests
 * use it), and the process host below is a module-private constant built from `resolveProductionPolicyInputs`.
 */
import * as path from "node:path";
import { resolveProductionPolicyInputs, type ProductionPolicyInputs } from "./managed_policy_inputs.js";
import {
  inspectManagedTiers,
  loadManagedTiers,
  loadProjectPolicy,
  ManagedPolicyError,
  MANAGED_POLICY_EXIT_CODE,
  recordProjectPolicyApproval,
  type LoadedPolicy,
  type ManagedTiers,
  type TierInspection,
} from "./managed_policy_load.js";
import { clampSandbox, clampSandboxNetwork, describeSource, mergePolicies, requiresHuman, type EffectivePolicy, type HumanEffect, type PolicySource } from "./managed_policy.js";

/** The managed tiers as read, and their merge (no project tier). Frozen. */
export interface ManagedPolicyState {
  tiers: ManagedTiers;
  effective: EffectivePolicy;
}

/** What the caller knows about trust in a workspace; this module reads neither the trust store nor the environment. */
export interface WorkspaceTrustFacts {
  /** The operator's trust store lists the workspace. */
  workspaceTrusted: boolean;
  /** `NEXUS_TRUST_WORKSPACE=1` was set. */
  envTrustRequested: boolean;
}

export interface PolicyHost {
  /** The managed tiers, read on the first call and never again. Throws the first call's `ManagedPolicyError` every time. */
  managed(): ManagedPolicyState;
  /** The policy in force in `workspace` (its real path): its project file merged under the managed tiers. */
  forWorkspace(workspace: string, trust: WorkspaceTrustFacts): LoadedPolicy;
  /**
   * Records the operator's approval of the workspace's current project file (by the hash of its bytes), so that its
   * relaxations apply until the file changes. Returns the hash, or undefined when there is no readable file to approve.
   */
  approveProjectPolicy(workspace: string, approvedAt: string): string | undefined;
  /** For diagnosis: each managed file read by itself, now (see `inspectManagedTiers`). Changes nothing `managed()` returns. */
  inspect(): TierInspection[];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) deepFreeze(member);
  }
  return value;
}

/** A host over explicit inputs. `resolve` is called once for the managed tiers; only the approval store's path is taken from a later call. */
export function createPolicyHost(resolve: () => ProductionPolicyInputs): PolicyHost {
  let loaded: { inputs: ProductionPolicyInputs; state?: ManagedPolicyState; error?: ManagedPolicyError } | undefined;
  const managed = (): ManagedPolicyState => {
    if (!loaded) {
      const inputs = resolve();
      try {
        const tiers = loadManagedTiers(inputs);
        loaded = { inputs, state: deepFreeze({ tiers, effective: mergePolicies(tiers.system, tiers.user) }) };
      } catch (error) {
        if (!(error instanceof ManagedPolicyError)) throw error;
        loaded = { inputs, error };
      }
    }
    if (loaded.error) throw loaded.error;
    return loaded.state!;
  };
  const forWorkspace = (workspace: string, trust: WorkspaceTrustFacts): LoadedPolicy => {
    const { tiers } = managed();
    return loadProjectPolicy(tiers, { workspace, trust: { ...trust, storePath: resolve().trustStorePath }, fs: loaded!.inputs.fs });
  };
  return {
    managed,
    forWorkspace,
    approveProjectPolicy(workspace, approvedAt) {
      const sha256 = forWorkspace(workspace, { workspaceTrusted: true, envTrustRequested: false }).project.sha256;
      if (sha256 === undefined) return undefined;
      recordProjectPolicyApproval({ fs: loaded!.inputs.fs, storePath: resolve().trustStorePath, workspace, sha256, approvedAt });
      return sha256;
    },
    inspect: () => inspectManagedTiers(resolve()),
  };
}

const processHost = createPolicyHost(resolveProductionPolicyInputs);

/** The policy host of this process. */
export function processPolicyHost(): PolicyHost {
  return processHost;
}

/** The effective managed policy of this process (system and user tiers). Throws `ManagedPolicyError`. */
export function managedPolicy(): EffectivePolicy {
  return processHost.managed().effective;
}

/**
 * Startup: reads the managed tiers now. A managed policy that exists and cannot be used ends the process: the two
 * lines of the error on stderr, exit code 2. Commands that must run with a broken policy do not call this.
 */
export function requireManagedPolicyAtStartup(): void {
  try {
    processHost.managed();
  } catch (error) {
    if (!(error instanceof ManagedPolicyError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exit(MANAGED_POLICY_EXIT_CODE);
  }
}

const told = new Set<string>();

/** Tells the operator something a policy decided, once per process, on stderr. */
export function emitPolicyNotice(notice: string): void {
  if (told.has(notice)) return;
  told.add(notice);
  process.stderr.write(`${notice}\n`);
}

/** A refusal that quotes a name a configuration file chose (an MCP server, a plugin file), made safe to print: control characters become `?`. */
export function printableRefusal(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

/** How a project file whose relaxations were not applied gets approved in this release. */
export function approvalHint(policy: LoadedPolicy): string | undefined {
  if (policy.effective.verification.relaxationStatus !== "not_approved") return undefined;
  return `nexus: to apply the relaxations of ${policy.project.file}, review the file and approve it with \`nexus trust ${path.dirname(policy.project.file)}\`; a later change to the file needs a new approval.`;
}

/**
 * `nexus verify` builds no session configuration, so its own flags meet the policy here: `--yes` under
 * `approval.disable_yes`, `--sandbox none` under `sandbox.required`, `--sandbox-network` under
 * `sandbox.forbid_network`. Returns the refusal (it names the policy source), or undefined. With no `--sandbox` verify
 * already confines every run and stops when no engine can, so `sandbox.required` has nothing to switch on.
 */
export function verifyFlagRefusal(policy: EffectivePolicy, flags: { yes: boolean; sandboxNone: boolean; sandboxNetwork: boolean }): string | undefined {
  const noYes = policy.approval.disable_yes;
  if (flags.yes && noYes.value) return `--yes is refused: managed policy disables it. ${describeSource(noYes.source)}`;
  const sandbox = clampSandbox(policy, flags.sandboxNone ? { mode: "none", origin: "--sandbox none" } : { mode: "auto" });
  if (!sandbox.allowed) return sandbox.message;
  const network = clampSandboxNetwork(policy, flags.sandboxNetwork, "--sandbox-network");
  return network.allowed ? undefined : network.message;
}

/** The approval settings a tool call is decided under. Structurally the `PolicyContext` members this module clamps. */
interface ApprovalSettings {
  mode: "auto" | "review" | "read-only";
  fullAccess?: boolean;
  policyRequiresHuman?: boolean;
}

/** Why a call needs a human decision whatever the approval mode: the text to show and the tier it comes from. */
export interface HumanRequirement {
  message: string;
  source: PolicySource;
}

const HUMAN_EFFECTS: readonly string[] = ["exec", "write_workspace", "egress"] satisfies HumanEffect[];

/** `approval.require_human` against a call's effect class. */
export function humanRequirementForEffect(policy: EffectivePolicy, effect: string): HumanRequirement | undefined {
  if (!HUMAN_EFFECTS.includes(effect)) return undefined;
  const answer = requiresHuman(policy, effect as HumanEffect);
  return answer.required ? { message: answer.message!, source: answer.source } : undefined;
}

/**
 * The approval settings as the policy lets them stand, whatever built them: mode `auto` becomes `review` under
 * `approval.disable_auto`, full access is dropped under `approval.disable_full_access`, and `human` (a managed
 * `prompt` rule or `approval.require_human`) makes the call ask in every mode. Restrict-only: nothing is ever raised.
 */
export function clampApprovalSettings<T extends ApprovalSettings>(policy: EffectivePolicy, settings: T, human?: HumanRequirement): T {
  const mode = settings.mode === "auto" && policy.approval.disable_auto.value ? "review" : settings.mode;
  const fullAccess = Boolean(settings.fullAccess) && !policy.approval.disable_full_access.value && mode === settings.mode;
  return { ...settings, mode, fullAccess, ...(human ? { policyRequiresHuman: true } : {}) };
}

/** The tier to name beside a decision the approval mode made: the tier that disabled what was asked for, else the default. */
export function approvalDecisionSource(policy: EffectivePolicy, asked: ApprovalSettings): PolicySource {
  if (asked.mode === "auto" && policy.approval.disable_auto.value) return policy.approval.disable_auto.source;
  if (asked.fullAccess && policy.approval.disable_full_access.value) return policy.approval.disable_full_access.source;
  return { tier: "default", key: "approval.mode" };
}

export { describeSource };
