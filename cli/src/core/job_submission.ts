/**
 * BG-1/BG-2: how a job submission is made, for `nexus job start` and for a schedule that fires. One function, so a
 * scheduled run passes the same checks as a command-line one: a fresh worktree from the current HEAD, the unattended
 * spec form, the operator's own verifier and deliverables, and the runner's own refusal rules.
 */
import { normalizeTrustedDeliverableFiles } from "../config.js";
import { validateOperationSpec } from "../operation_cli.js";
import { chooseJobIds, specDigest, submissionProblem, unattendedSpec } from "./job_runner.js";
import { parseJobSubmission, RunnerStoreError, type JobBudgets, type JobOrigin, type JobPolicy, type JobProvider, type JobSubmission } from "./runner_store.js";

export interface JobSubmissionInput {
  /** Real path of the repository. */
  workspace: string;
  /** The operation spec as the operator gave it (a prompt becomes one unit). */
  given: unknown;
  policy: JobPolicy;
  verifier: string | null;
  /** Workspace-relative deliverable files, as the operator typed them. */
  deliverableFiles: unknown;
  provider: JobProvider;
  budgets: JobBudgets;
  origin: JobOrigin;
}

/** The one-unit spec a prompt stands for: a researcher for a read-only job, an implementer for one that may write. */
export function promptSpec(prompt: string, writable: boolean): Record<string, unknown> {
  return { objective: prompt, units: [{ id: "task", title: "task", role: writable ? "implementer" : "researcher", prompt }] };
}

/** The submission and its frozen spec. Throws `RunnerStoreError` (exit 2 at the command line) when the job cannot be submitted. */
export function buildJobSubmission(input: JobSubmissionInput): { job: JobSubmission; spec: Record<string, unknown> } {
  validateOperationSpec(input.given);
  const given = input.given;
  let chosen: ReturnType<typeof chooseJobIds>;
  try {
    chosen = chooseJobIds(input.workspace, given.units.map((unit) => unit.id));
  } catch (error: any) {
    throw new RunnerStoreError(`A background job runs in a fresh Git worktree: ${String(error?.message ?? error)}.`);
  }
  const { baseCommit, ...ids } = chosen;
  const spec = unattendedSpec(given, { ...ids, baseCommit });
  let deliverables: string[];
  try {
    deliverables = normalizeTrustedDeliverableFiles(input.workspace, input.deliverableFiles);
  } catch (error: any) {
    throw new RunnerStoreError(String(error?.message ?? error));
  }
  const job = parseJobSubmission({
    ...ids,
    workspace: input.workspace,
    baseCommit,
    specSha256: specDigest(spec),
    origin: input.origin,
    unattended: true,
    policy: input.policy,
    verifier: input.verifier,
    deliverables,
    provider: input.provider,
    budgets: input.budgets,
  });
  const problem = submissionProblem(job, spec);
  if (problem) throw new RunnerStoreError(problem);
  return { job, spec };
}
