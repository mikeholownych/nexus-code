/**
 * Git-aware isolated operations: every unit runs on its own worktree/branch created from the operation's integration
 * tip, and a completed unit is committed and merged into an operation integration worktree before the scheduler sees it
 * as complete. The operator's checkout is never touched, and nothing here runs when the operation did not opt in
 * (`state.git` absent).
 *
 * Integration is the only place the operation writes Git history. It is idempotent: a recorded receipt, or a branch
 * whose tip is already an ancestor of the integration branch, is recognised on resume, so a crash between the merge and
 * the persisted transition does not merge twice. A textual conflict aborts the merge, leaves both branches intact, and
 * returns a decision for the operator. A mechanically clean merge whose merged tree fails the unit's verifier is reset
 * and reported as an integration failure.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureGitExclude } from "./git_exclude.js";
import { verifierTimeoutSecs } from "../tester.js";
import type {
  IntegrationReceipt,
  OperationGitState,
  OperationGitUnit,
  UnitRunResult,
  WorkUnit,
} from "./operation.js";

const GIT_TIMEOUT_MS = 300_000;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS }).trim();
}

function gitResult(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS });
    return { ok: true, stdout, stderr: "" };
  } catch (error: any) {
    return { ok: false, stdout: String(error?.stdout ?? ""), stderr: String(error?.stderr ?? error?.message ?? "") };
  }
}

/** Filesystem- and ref-safe name; the hash keeps two ids that sanitise the same apart. */
export function gitSlug(value: string): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "unit";
  return `${clean}-${createHash("sha256").update(value).digest("hex").slice(0, 8)}`;
}

export interface OperationGitPlan {
  key: string;
  repoRoot: string;
  baseRef: string;
  baseCommit: string;
  integrationBranch: string;
  integrationWorktree: string;
  baseDir: string;
}

/** Where the operation's worktrees live, and what it integrates into. Reads Git; writes nothing. */
export function planOperationGit(workspace: string, operationId: string, baseRef = "HEAD"): OperationGitPlan {
  let repoRoot: string;
  try {
    repoRoot = git(workspace, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new Error(`git isolation needs a Git repository (${workspace} is not one)`);
  }
  let baseCommit: string;
  try {
    baseCommit = git(repoRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
  } catch {
    throw new Error(`git isolation base '${baseRef}' does not name a commit`);
  }
  const key = gitSlug(operationId);
  const baseDir = path.join(repoRoot, ".nexus", "worktrees", `op-${key}`);
  return {
    key,
    repoRoot,
    baseRef,
    baseCommit,
    integrationBranch: `nexus/op-${key}/integration`,
    integrationWorktree: path.join(baseDir, "integration"),
    baseDir,
  };
}

/** Fresh persisted state for a newly planned isolated operation. */
export function newOperationGitState(plan: OperationGitPlan): OperationGitState {
  return {
    isolate: true,
    repoRoot: plan.repoRoot,
    baseRef: plan.baseRef,
    baseCommit: plan.baseCommit,
    integrationBranch: plan.integrationBranch,
    integrationWorktree: plan.integrationWorktree,
    baseDir: plan.baseDir,
    units: {},
  };
}

export type IntegrateResult =
  | { kind: "integrated" | "nothing"; receipt: IntegrationReceipt }
  | { kind: "conflict"; files: string[]; tip: string }
  | { kind: "failed"; reason: string };

/**
 * Create the integration worktree/branch if it is not there yet. Recovery reuses an existing checkout; a worktree that
 * exists while its branch is gone, or vice versa, is a broken pair and fails closed.
 */
export function ensureIntegrationWorktree(plan: OperationGitPlan, state: OperationGitState, options: { hasHistory?: boolean } = {}): void {
  const branchExists = gitResult(plan.repoRoot, ["rev-parse", "--verify", `refs/heads/${plan.integrationBranch}`]).ok;
  const worktreeExists = fs.existsSync(plan.integrationWorktree);
  if (branchExists && worktreeExists) return;
  if (!branchExists && worktreeExists) {
    throw new Error("the integration worktree exists but its branch is gone; restore the branch or remove the worktree");
  }
  if (!branchExists && !worktreeExists && options.hasHistory) {
    // Recreating from baseCommit would silently drop every integrated unit; only the operator can restore it.
    throw new Error(
      "the integration branch and worktree are gone but this operation already integrated work; restore the branch or start a new operation",
    );
  }
  ensureGitExclude(plan.repoRoot);
  fs.mkdirSync(plan.baseDir, { recursive: true });
  // A missing worktree with the branch still present is repaired in place (the branch is the source of truth).
  gitResult(plan.repoRoot, ["worktree", "prune", "--expire", "now"]);
  const added = branchExists
    ? gitResult(plan.repoRoot, ["worktree", "add", plan.integrationWorktree, plan.integrationBranch])
    : gitResult(plan.repoRoot, ["worktree", "add", "-b", plan.integrationBranch, plan.integrationWorktree, plan.baseCommit]);
  if (!added.ok) throw new Error(`cannot create the integration worktree: ${added.stderr.trim() || "git worktree add failed"}`);
}

/** Remove an integration worktree/branch created for an operation that could not start. */
export function discardIntegrationWorktree(plan: OperationGitPlan): void {
  if (fs.existsSync(plan.integrationWorktree)) {
    gitResult(plan.repoRoot, ["worktree", "remove", "--force", plan.integrationWorktree]);
  }
  gitResult(plan.repoRoot, ["branch", "-D", plan.integrationBranch]);
}

export interface UnitGitPreparation {
  workspace: string;
  branch: string;
  /** True when an existing worktree was reused (resume/retry). */
  reused: boolean;
}

export class OperationGit {
  /** Empty directory used as `core.hooksPath` for mechanical integration commits/merges. */
  private readonly hooksDir: string;

  constructor(
    private readonly plan: OperationGitPlan,
    private readonly state: OperationGitState,
    private readonly options: { verifyTimeoutSecs?: number } = {},
  ) {
    this.hooksDir = path.join(plan.baseDir, "no-hooks");
  }

  currentTip(): string {
    return git(this.plan.integrationWorktree, ["rev-parse", "HEAD"]);
  }

  /**
   * Receipts whose integrated commit is no longer an ancestor of the integration tip: the branch was rewritten or
   * rewound in place. The operation must stop rather than continue on a tree that silently lost accepted work.
   */
  historyProblems(receipts: readonly IntegrationReceipt[]): Array<{ unitId: string; integratedCommit: string }> {
    const problems: Array<{ unitId: string; integratedCommit: string }> = [];
    for (const receipt of receipts) {
      const reachable = receipt.integratedCommit &&
        gitResult(this.plan.integrationWorktree, ["merge-base", "--is-ancestor", receipt.integratedCommit, "HEAD"]).ok;
      if (!reachable) problems.push({ unitId: receipt.unitId, integratedCommit: receipt.integratedCommit });
    }
    return problems;
  }

  /**
   * Give the unit a worktree branched from the integration tip. A recorded worktree is reused so a retry or a resume
   * continues on the same files; an operator restart throws the old worktree and branch away first.
   */
  prepareUnit(unit: WorkUnit, options: { restart?: boolean } = {}): UnitGitPreparation {
    const recorded = this.state.units[unit.id];
    const branch = recorded?.branch ?? `nexus/op-${this.plan.key}/${gitSlug(unit.id)}`;
    const worktree = recorded?.worktree ?? path.join(this.plan.baseDir, "units", gitSlug(unit.id));

    const restart = Boolean(options.restart && recorded);
    let restartBranch = branch;
    if (restart) {
      // The worktree may be gone while its registration survives; prune before deleting the branch, or `branch -D`
      // refuses and the restart silently resumes the old work.
      this.removeWorktree(recorded!.worktree);
      gitResult(this.plan.repoRoot, ["worktree", "prune", "--expire", "now"]);
      gitResult(this.plan.repoRoot, ["branch", "-D", recorded!.branch]);
    }

    if (fs.existsSync(worktree) && !restart) {
      const existing = this.state.units[unit.id];
      if (!existing) {
        throw new Error(`worktree ${worktree} exists but is not recorded for unit ${unit.id}; remove it or restart the unit`);
      }
      return { workspace: worktree, branch: existing.branch, reused: true };
    }
    if (fs.existsSync(worktree) && restart) gitResult(this.plan.repoRoot, ["worktree", "remove", "--force", worktree]);

    let branchExists = gitResult(this.plan.repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]).ok;
    if (restart && branchExists) {
      // Still checked out elsewhere: a restart must start from the tip, so use a fresh branch rather than resume it.
      restartBranch = `${branch}-${gitSlug(`${unit.id}-${Date.now()}`)}`;
      branchExists = false;
    }
    const add = () => branchExists
      ? gitResult(this.plan.repoRoot, ["worktree", "add", worktree, restartBranch])
      : gitResult(this.plan.repoRoot, ["worktree", "add", "-b", restartBranch, worktree, this.currentTip()]);
    // A worktree directory that disappeared outside Nexus leaves a registration behind; prune it, then add.
    gitResult(this.plan.repoRoot, ["worktree", "prune", "--expire", "now"]);
    let added = add();
    if (!added.ok && /already registered|missing but already registered/i.test(added.stderr)) {
      gitResult(this.plan.repoRoot, ["worktree", "remove", "--force", worktree]);
      gitResult(this.plan.repoRoot, ["worktree", "prune", "--expire", "now"]);
      added = add();
    }
    if (!added.ok) throw new Error(`cannot create a worktree for ${unit.id}: ${added.stderr.trim() || "git worktree add failed"}`);

    const baseCommit = branchExists
      ? gitResult(this.plan.repoRoot, ["merge-base", this.plan.integrationBranch, restartBranch]).stdout.trim() || this.currentTip()
      : this.currentTip();
    // Only now is the old record replaced; a failed add leaves the previous entry intact so a retry can restart.
    this.state.units[unit.id] = { branch: restartBranch, worktree, baseCommit };
    return { workspace: worktree, branch: restartBranch, reused: false };
  }

  /**
   * Commit the unit's working tree, merge its branch into the integration branch, and re-run its verifier on the merged
   * tree before the receipt is recorded. A conflict aborts the merge; a verification failure resets it.
   */
  async integrate(unit: WorkUnit, result: Extract<UnitRunResult, { kind: "completed" }>): Promise<IntegrateResult> {
    const entry = this.state.units[unit.id];
    if (!entry) return { kind: "failed", reason: `unit ${unit.id} has no worktree recorded` };
    if (entry.integratedCommit) {
      return {
        kind: "nothing",
        receipt: {
          unitId: unit.id,
          branch: entry.branch,
          commit: entry.integratedCommit,
          integratedCommit: entry.integratedCommit,
          mergedAt: new Date().toISOString(),
          files: [],
          outcome: result.outcome,
          summary: result.summary,
          verification: "ALREADY_INTEGRATED",
        },
      };
    }
    const worktreeMissing = !fs.existsSync(entry.worktree);
    const recoveredCommit = worktreeMissing ? this.mergedUnitCommit(entry) : undefined;
    if (worktreeMissing && !recoveredCommit) {
      return { kind: "failed", reason: `unit ${unit.id}'s worktree is missing (${entry.worktree})` };
    }

    if (!worktreeMissing) {
      const branch = gitResult(entry.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (!branch.ok || branch.stdout.trim() !== entry.branch) {
        return { kind: "failed", reason: `unit ${unit.id}'s worktree is not on its recorded branch ${entry.branch}` };
      }

      // Uncommitted agent work is the normal case; commit it without touching ignored build output.
      const dirty = gitResult(entry.worktree, ["status", "--porcelain"]).stdout.trim();
      if (dirty) {
        const added = gitResult(entry.worktree, ["add", "-A"]);
        if (!added.ok) return { kind: "failed", reason: `cannot stage ${unit.id}: ${added.stderr.trim()}` };
        const committed = gitResult(entry.worktree, [
          ...this.mechanicalGitConfig(), "commit", "--no-verify", "-q", "-m", `nexus: ${unit.title}`,
        ]);
        if (!committed.ok) {
          return { kind: "failed", reason: `cannot commit ${unit.id}: ${committed.stderr.trim() || "git commit failed"}` };
        }
      }
    }
    const commit = recoveredCommit ?? git(entry.worktree, ["rev-parse", "HEAD"]);
    if (commit === entry.baseCommit) {
      const tip = this.currentTip();
      this.state.units[unit.id] = { ...entry, integratedCommit: tip };
      return {
        kind: "nothing",
        receipt: {
          unitId: unit.id,
          branch: entry.branch,
          commit,
          integratedCommit: tip,
          mergedAt: new Date().toISOString(),
          files: [],
          outcome: result.outcome,
          summary: result.summary,
          verification: "NO_CHANGES",
        },
      };
    }

    const tip = this.currentTip();
    // A branch already contained in the integration tip (crash after the merge) is recorded, not merged twice.
    if (gitResult(this.plan.integrationWorktree, ["merge-base", "--is-ancestor", commit, "HEAD"]).ok) {
      // The merge happened before a crash. The merged tree can no longer be reset safely, so the verifier is a
      // post-hoc check: a failure is reported for the operator, not silently recorded as verified.
      const posthoc = result.verification?.command && result.verification.status === "PASSED" && result.verification.hasExecutedTests
        ? this.verifyMerged(result.verification.command)
        : undefined;
      const integrity = posthoc ? this.integrationIntegrity(commit, tip) : undefined;
      if (integrity && !integrity.ok) {
        const reason = integrity.reason ?? "integration verification changed the integration history";
        const restoration = this.restoreIntegration(tip);
        return { kind: "failed", reason: restoration ? `${reason}; ${restoration}` : reason };
      }
      if (posthoc) this.cleanIntegrationWorktree();
      if (posthoc && !posthoc.ok) {
        // Do not record this as integrated: a retry must re-check the merged tree (and may add the missing work).
        return { kind: "failed", reason: `${posthoc.reason ?? "integration verification failed"} (the merge is already in place; inspect and retry or stop)` };
      }
      this.state.units[unit.id] = { ...entry, integratedCommit: tip };
      return {
        kind: "nothing",
        receipt: {
          unitId: unit.id,
          branch: entry.branch,
          commit,
          integratedCommit: tip,
          mergedAt: new Date().toISOString(),
          files: [],
          outcome: result.outcome,
          summary: result.summary,
          verification: posthoc ? "PASSED_POSTHOC" : "ALREADY_MERGED",
        },
      };
    }

    this.abortStaleMerge();
    if (gitResult(this.plan.integrationWorktree, ["status", "--porcelain"]).stdout.trim()) {
      return { kind: "failed", reason: "the integration worktree has uncommitted changes; clean it before integrating" };
    }

    // Integration is mechanical: no commit hooks or signing, because the merged tree is re-verified instead. The unit's
    // own commit uses the same settings so a signing prompt cannot hang a headless operation.
    const merged = gitResult(this.plan.integrationWorktree, [
      ...this.mechanicalGitConfig(),
      "merge", "--no-ff", "--no-verify", "-m", `nexus: integrate ${unit.id} — ${unit.title}`, entry.branch,
    ]);
    if (!merged.ok) {
      const conflicted = gitResult(this.plan.integrationWorktree, ["diff", "--name-only", "--diff-filter=U"]).stdout
        .split("\n").map((line) => line.trim()).filter(Boolean).sort();
      gitResult(this.plan.integrationWorktree, ["merge", "--abort"]);
      return { kind: "conflict", files: conflicted, tip };
    }

    const mergedTip = this.currentTip();
    const verification = result.verification?.command && result.verification.status === "PASSED" && result.verification.hasExecutedTests
      ? this.verifyMerged(result.verification.command)
      : undefined;
    const integrity = verification ? this.integrationIntegrity(commit, mergedTip) : undefined;
    if (verification && (!verification.ok || (integrity && !integrity.ok))) {
      // The merge is mechanically clean but the merged tree does not pass the unit's verifier: undo it.
      const reason = integrity?.reason ?? verification.reason ?? "integration verification failed";
      const restoration = this.restoreIntegration(tip);
      return { kind: "failed", reason: restoration ? `${reason}; ${restoration}` : reason };
    }
    if (verification) this.cleanIntegrationWorktree();

    const integratedCommit = this.currentTip();
    const files = gitResult(this.plan.repoRoot, ["diff", "--name-only", tip, integratedCommit]).stdout
      .split("\n").map((line) => line.trim()).filter(Boolean).sort();
    const receipt: IntegrationReceipt = {
      unitId: unit.id,
      branch: entry.branch,
      commit,
      integratedCommit,
      mergedAt: new Date().toISOString(),
      files,
      outcome: result.outcome,
      summary: result.summary,
      verification: verification ? "PASSED" : "NOT_RUN",
    };
    this.state.units[unit.id] = { ...entry, integratedCommit };
    return { kind: "integrated", receipt };
  }

  /** Remove a completed unit's clean worktree (its branch and receipt stay). */
  disposeUnit(unitId: string): void {
    const entry = this.state.units[unitId];
    if (entry) this.removeWorktree(entry.worktree, true);
  }

  /** A missing worktree is recoverable only when its retained branch is already merged. */
  canRecoverMissingWorktree(unitId: string): boolean {
    const entry = this.state.units[unitId];
    return Boolean(
      entry && entry.integratedCommit === undefined && !fs.existsSync(entry.worktree) && this.mergedUnitCommit(entry),
    );
  }

  /** Integrity check at runner start: an unmerged missing worktree fails closed instead of rerunning blind. */
  missingWorktrees(): Array<{ unitId: string; worktree: string }> {
    return Object.entries(this.state.units)
      .filter(([, entry]) =>
        entry.integratedCommit === undefined && !fs.existsSync(entry.worktree) && !this.mergedUnitCommit(entry))
      .map(([unitId, entry]) => ({ unitId, worktree: entry.worktree }));
  }

  /** Drop clean remaining unit worktrees; branches, dirty files and the integration worktree stay. */
  disposeAllUnits(): void {
    for (const entry of Object.values(this.state.units)) this.removeWorktree(entry.worktree, true);
  }

  unitState(unitId: string): OperationGitUnit | undefined {
    return this.state.units[unitId];
  }

  /** Fixed author, no signing and no hooks (pre or post): integration must not depend on the operator's Git config. */
  private mechanicalGitConfig(): string[] {
    const base = ["-c", "user.name=Nexus", "-c", "user.email=nexus@localhost", "-c", "commit.gpgsign=false"];
    try {
      fs.mkdirSync(this.hooksDir, { recursive: true });
      return [...base, "-c", `core.hooksPath=${this.hooksDir}`];
    } catch {
      // Without a usable hooks directory, `--no-verify` still skips pre-commit/commit-msg; post-* hooks may run.
      return base;
    }
  }

  private abortStaleMerge(): void {
    try {
      const gitDirPath = git(this.plan.integrationWorktree, ["rev-parse", "--git-dir"]);
      const gitDir = path.isAbsolute(gitDirPath) ? gitDirPath : path.resolve(this.plan.integrationWorktree, gitDirPath);
      if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) {
        gitResult(this.plan.integrationWorktree, ["merge", "--abort"]);
      }
    } catch {
      // No readable git dir: the merge command below reports the real problem.
    }
  }

  /** Remove what a verifier may have written on top of the merge; the merge commit itself is untouched. */
  private cleanIntegrationWorktree(): void {
    gitResult(this.plan.integrationWorktree, ["reset", "--hard", "HEAD"]);
    gitResult(this.plan.integrationWorktree, ["clean", "-fd"]);
  }

  private integrationIntegrity(commit: string, expectedTip: string): { ok: boolean; reason?: string } {
    const branch = gitResult(this.plan.integrationWorktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!branch.ok || branch.stdout.trim() !== this.plan.integrationBranch) {
      return { ok: false, reason: "integration verification moved the worktree off the integration branch" };
    }
    const head = gitResult(this.plan.integrationWorktree, ["rev-parse", "HEAD"]);
    if (!head.ok || head.stdout.trim() !== expectedTip) {
      return { ok: false, reason: "integration verification changed the integration tip; it was rewritten or rewound" };
    }
    if (!gitResult(this.plan.integrationWorktree, ["merge-base", "--is-ancestor", commit, "HEAD"]).ok) {
      return { ok: false, reason: "integration branch no longer contains the unit commit; it was rewritten or rewound" };
    }
    return { ok: true };
  }

  private restoreIntegration(commit: string): string | undefined {
    const restored = gitResult(this.plan.integrationWorktree, [
      "checkout", "--force", "-B", this.plan.integrationBranch, commit,
    ]);
    if (!restored.ok) return `could not restore the integration branch: ${restored.stderr.trim() || "git checkout failed"}`;
    const cleaned = gitResult(this.plan.integrationWorktree, ["clean", "-fd"]);
    if (!cleaned.ok) return `could not clean the restored integration worktree: ${cleaned.stderr.trim() || "git clean failed"}`;
    return undefined;
  }

  private mergedUnitCommit(entry: OperationGitUnit): string | undefined {
    const resolved = gitResult(this.plan.repoRoot, ["rev-parse", "--verify", `refs/heads/${entry.branch}^{commit}`]);
    const commit = resolved.stdout.trim();
    if (!resolved.ok || !commit || commit === entry.baseCommit) return undefined;
    return gitResult(this.plan.integrationWorktree, ["merge-base", "--is-ancestor", commit, "HEAD"]).ok
      ? commit
      : undefined;
  }

  private removeWorktree(worktree: string, preserveIfNotClean = false): void {
    if (!fs.existsSync(worktree)) return;
    if (preserveIfNotClean) {
      const status = gitResult(worktree, ["status", "--porcelain", "--ignored"]);
      if (!status.ok || status.stdout.trim()) return;
    }
    gitResult(this.plan.repoRoot, ["worktree", "remove", "--force", worktree]);
  }

  /** Re-run the unit's verifier on the merged tree. The unit's own evidence already proved it executed tests. */
  private verifyMerged(command: string): { ok: boolean; reason?: string } {
    const deadlineMs = (this.options.verifyTimeoutSecs ?? verifierTimeoutSecs()) * 1000;
    try {
      execFileSync("bash", ["-c", command], {
        cwd: this.plan.integrationWorktree,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: deadlineMs,
      });
      return { ok: true };
    } catch (error: any) {
      const timedOut = error?.signal === "SIGTERM" || error?.code === "ETIMEDOUT";
      const tail = String(error?.stderr || error?.stdout || "").trim().split("\n").slice(-6).join("\n");
      return {
        ok: false,
        reason:
          `integration verification failed on the merged tree: ${command}${timedOut ? " (timed out)" : ""}` +
          (tail ? `\n${tail}` : ""),
      };
    }
  }
}
