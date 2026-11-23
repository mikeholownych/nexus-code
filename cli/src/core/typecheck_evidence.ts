/**
 * Type-check evidence for a caller that has no agent (`nexus verify`).
 *
 * MIRROR: this reproduces how core/completion_oracle.ts turns project type-checks into TypecheckEvidence and decides
 * which of them stop a passing verifier from counting (`runTypecheckOracleImpl`: the per-check order, the fields of each
 * record, the status priority of the combined record) and how it captures the pre-change baseline
 * (`captureTypecheckBaselineImpl`). The two must change together until the agent adopts this module;
 * test/typecheck_evidence.test.ts pins this side and compares it with the agent's function on the same inputs.
 *
 * What the agent's oracle also does and this module does not, because a caller without an agent has none of it: a
 * separate approval of each type-check command, the attempt ledger (an unchanged failing check is not rerun), files
 * changed through the shell, the candidate id, and the rule for a baseline lost across a resume.
 *
 * One deliberate difference: the baseline is keyed by tool and configuration path, where the agent keys it by command.
 * The agent runs both sides in one directory; here they run in two, and a command can embed its directory (Cargo's
 * target directory), so the same project would have two commands.
 */
import { safeTerminal } from "../ui.js";
import { runTypecheck, type DiscoveredTypecheck, type TimedExecutor, type TypecheckMode, type TypecheckRun } from "../tester.js";
import { foldVoluminousOutput } from "./agent_support.js";
import type { TypecheckEvidence } from "./turn.js";

type Status = TypecheckEvidence["status"];

/** completion_oracle.ts: the combined record takes the first of these statuses that any project has. */
export const TYPECHECK_STATUS_PRIORITY: readonly Status[] = ["FAILED", "TIMED_OUT", "UNAVAILABLE", "NOT_APPLICABLE", "ENVIRONMENT", "PREEXISTING", "PASSED"];

/** Why an enforced check stops a passing verifier from counting. UNAVAILABLE: it could not be run at all (no tool, a configuration this checker cannot stand for, an incomplete project scan). */
export type TypecheckBlockKind = "FAILED" | "TIMED_OUT" | "UNAVAILABLE";

export interface TypecheckBlock {
  kind: TypecheckBlockKind;
  message: string;
}

export interface TypecheckProjectEvidence {
  evidence: TypecheckEvidence;
  /** Present only for an enforced check that blocks. */
  block?: TypecheckBlock;
}

/** The baseline's key for a project: the same on the base and on the head whatever directory each ran in. */
export const typecheckProjectKey = (check: Pick<DiscoveredTypecheck, "tool" | "configPath">): string => `${check.tool}\n${check.configPath}`;

/**
 * The evidence for one discovered project. `run` is absent when the project was not run: discovery already says why
 * (`skipReason`, `missingTool`), or the shared budget was used up before its turn.
 *
 * Blocking, exactly as the agent decides it for an enforced check: FAILED and TIMED_OUT block; so does a check that was
 * never run (skipped, tool missing at discovery, budget used up). ENVIRONMENT, PREEXISTING and a tool that turned out to
 * be unusable when probed (UNAVAILABLE from the run) are recorded and do NOT block.
 */
export function typecheckProjectEvidence(
  check: DiscoveredTypecheck,
  enforced: boolean,
  attempt: { budgetSecs: number; run?: TypecheckRun; baseline?: ReadonlySet<string> },
  at: string,
): TypecheckProjectEvidence {
  const named = { tool: check.tool, command: check.command, configPath: check.configPath, configSha256: check.configSha256, ...(check.toolSha256 ? { toolSha256: check.toolSha256 } : {}) };
  const blocked = (kind: TypecheckBlockKind, message: string) => (enforced ? { block: { kind, message } } : {});
  if (check.skipReason) {
    return {
      evidence: { status: check.discoveryIncomplete ? "UNAVAILABLE" : "NOT_APPLICABLE", ...named, enforced, scope: check.skipReason, at },
      ...blocked("UNAVAILABLE", check.discoveryIncomplete
        ? `workspace type-check discovery was incomplete: ${check.skipReason}`
        : `${check.tool} type-check under ${check.configPath} was not run: ${check.skipReason}`),
    };
  }
  if (check.missingTool) {
    return {
      evidence: { status: "UNAVAILABLE", ...named, enforced, scope: `${check.tool} is not installed, so nothing was type-checked under ${check.configPath}`, at },
      ...blocked("UNAVAILABLE", `${check.tool} type-check under ${check.configPath} is unavailable because ${check.tool} is not installed.`),
    };
  }
  const { run, baseline, budgetSecs } = attempt;
  if (!run) {
    return {
      evidence: { status: "TIMED_OUT", enforced, ...named, scope: `not run: aggregate type-check budget of ${budgetSecs}s exhausted`, at },
      ...blocked("TIMED_OUT", `${check.tool} type-check under ${check.configPath} was not run because the aggregate ${budgetSecs}s type-check budget was exhausted.`),
    };
  }
  const excerpt = `(untrusted compiler output)\n${safeTerminal(foldVoluminousOutput(run.output || "", 30, 2000))}`;
  const evidence: TypecheckEvidence = {
    status: run.status, enforced, ...named,
    ...(run.version ? { toolVersion: run.version } : {}),
    exitCode: run.exitCode,
    ...(run.errorCount !== undefined ? { errorCount: run.errorCount, firstDiagnostics: (run.firstDiagnostics ?? []).map((d) => safeTerminal(d)) } : {}),
    ...(baseline ? { baselineErrorCount: baseline.size } : {}),
    ...(run.introducedCount !== undefined ? { introducedCount: run.introducedCount } : {}),
    scope: `under ${check.configPath}`,
    ...(run.status === "PASSED" ? {} : { excerpt }),
    at,
  };
  if (run.status !== "FAILED" && run.status !== "TIMED_OUT") return { evidence };
  return {
    evidence,
    ...blocked(run.status, `${check.tool} type-check ${run.status === "FAILED" ? "failed" : `timed out after ${budgetSecs}s`} under ${check.configPath} (sha256 ${check.configSha256.slice(0, 12)}). Command: ${check.command}\n${excerpt}`),
  };
}

/** The one record for all projects: the highest-priority project's fields, with every project under `projects`. */
export function combineTypecheckEvidence(results: readonly TypecheckEvidence[]): TypecheckEvidence {
  const primary = TYPECHECK_STATUS_PRIORITY.map((status) => results.find((item) => item.status === status)).find((item) => item !== undefined) ?? results[0];
  return { ...primary, scope: results.length === 1 ? primary.scope : `${results.length} project check(s)`, projects: [...results] };
}

/** The record when nothing was checked and nothing is wrong with that: type-checking is off, or the tree has no project. */
export function typecheckNotApplicable(mode: TypecheckMode, at: string): TypecheckEvidence {
  return { status: "NOT_APPLICABLE", scope: mode === "off" ? "disabled by NEXUS_TYPECHECK / typecheck setting" : "no configured type-check project found", at };
}

/** The reason an enforced type-check gives, the worst first; undefined when nothing blocks. */
export function worstTypecheckBlock(blocks: readonly TypecheckBlock[]): TypecheckBlock | undefined {
  return (["FAILED", "TIMED_OUT", "UNAVAILABLE"] as const).map((kind) => blocks.find((block) => block.kind === kind)).find((block) => block !== undefined);
}

export interface TypecheckBaselineRecord {
  tool: string;
  configPath: string;
  /** NOT_RUN: discovery already ruled the project out (skipped, or its tool is missing). */
  status: TypecheckRun["status"] | "NOT_RUN";
  /** Located errors on the base; present when the base run can serve as a baseline. */
  errorCount?: number;
}

/**
 * The errors that exist before the change, per project (captureTypecheckBaselineImpl): a base run that passed gives an
 * empty set, one whose errors are all located gives their signatures, and any other run gives no baseline, so on the
 * head an error in an untouched file then counts as it would without one (PREEXISTING).
 */
export async function captureTypecheckBaseline(input: {
  checks: readonly DiscoveredTypecheck[];
  execute: TimedExecutor;
  workspace: string;
  deadlineSecs: number;
}): Promise<{ baselines: Map<string, ReadonlySet<string>>; records: TypecheckBaselineRecord[] }> {
  const baselines = new Map<string, ReadonlySet<string>>();
  const records: TypecheckBaselineRecord[] = [];
  for (const check of input.checks) {
    const named = { tool: check.tool, configPath: check.configPath };
    if (check.skipReason || check.missingTool) {
      records.push({ ...named, status: "NOT_RUN" });
      continue;
    }
    const run = await runTypecheck(check, input.execute, input.workspace, new Set(), input.deadlineSecs);
    const signatures = run.status === "PASSED" ? new Set<string>() : run.status === "PREEXISTING" ? new Set(run.signatures ?? []) : undefined;
    if (signatures) baselines.set(typecheckProjectKey(check), signatures);
    records.push({ ...named, status: run.status, ...(signatures ? { errorCount: signatures.size } : {}) });
  }
  return { baselines, records };
}

/**
 * Runs every discovered project against one shared budget and returns the combined evidence and what blocks
 * (runTypecheckOracleImpl). `checks` must not be empty. `modified` holds absolute paths inside `workspace`.
 */
export async function collectTypecheckEvidence(input: {
  checks: readonly DiscoveredTypecheck[];
  enforced: boolean;
  execute: TimedExecutor;
  workspace: string;
  modified: ReadonlySet<string>;
  budgetSecs: number;
  baselines?: ReadonlyMap<string, ReadonlySet<string>>;
  now?: () => number;
}): Promise<{ evidence: TypecheckEvidence; blocks: TypecheckBlock[] }> {
  const now = input.now ?? Date.now;
  const at = () => new Date(now()).toISOString();
  const deadline = now() + Math.max(0, input.budgetSecs) * 1000;
  const results: TypecheckEvidence[] = [];
  const blocks: TypecheckBlock[] = [];
  for (const check of input.checks) {
    const baseline = input.baselines?.get(typecheckProjectKey(check));
    let run: TypecheckRun | undefined;
    if (!check.skipReason && !check.missingTool) {
      const remainingSecs = Math.ceil((deadline - now()) / 1000);
      if (remainingSecs > 0) run = await runTypecheck(check, input.execute, input.workspace, input.modified, remainingSecs, baseline);
    }
    const project = typecheckProjectEvidence(check, input.enforced, { budgetSecs: input.budgetSecs, run, baseline }, at());
    results.push(project.evidence);
    if (project.block) blocks.push(project.block);
  }
  return { evidence: combineTypecheckEvidence(results), blocks };
}
