import * as fs from "node:fs";
import * as path from "node:path";
import { PolicyContext } from "./approval_policy.js";
import { isWorkspaceTrusted } from "../workspace_trust.js";
import { safeTerminal } from "../ui.js";
import { workspaceChangedPaths } from "../git.js";
import { runTestSuiteWithExecutor, discoverTypecheck, runTypecheck, typecheckMode, discoverVerifier, describeVerifier, hasExecutedTests } from "../tester.js";
import { isInlineProgramVerifier, snapshotVerifierDefinitionWithReason, judgeWithoutCopy, prepareBaselineTestsCopy, snapshotTests, type ChangeBaseline, type Independence } from "./independent_check.js";
import { TypecheckEvidence } from "./turn.js";
import { createHash } from "node:crypto";
import { failedCheckFrom, attemptEvidence, priorAttempt, recordAttempt } from "./objective.js";
import { DEFAULT_VERIFIER_TIMEOUT_SECS, ConfirmHandler, foldVoluminousOutput } from "./agent_support.js";

export async function ensureVerifierApprovedImpl(this: any, command: string, confirmHandler?: ConfirmHandler, origin?: string, binding?: string): Promise<boolean> {
  const isTrusted = isWorkspaceTrusted(this.config.workspace, this.isReadOnly());
  const mode = this.getApprovalMode();
  const policyContext: PolicyContext = {
    mode,
    trusted: isTrusted,
    sandbox: this.config.sandbox,
    approvedEgressOrigins: this.approvedEgressOrigins,
    fullAccess: Boolean(this.config.fullAccess) && !this.isReadOnly(),
  };

  if (!this.approvalPolicy.requiresDecision("exec", policyContext)) {
    return true;
  }

  const desc = describeVerifier(this.config.workspace, command);
  const verifierCmd = desc?.command || command;
  const baseDigest = desc?.digest || createHash("sha256").update(verifierCmd).digest("hex");
  const digest = binding ? createHash("sha256").update(`${baseDigest}\n${binding}`).digest("hex") : baseDigest;
  const cacheKey = `${this.config.workspace}:${verifierCmd}:${digest}`;

  if (this.approvedVerifiers.has(cacheKey)) {
    return true;
  }

  const onConfirm = confirmHandler ?? this.activeTurn?.onConfirm;
  if (!onConfirm) {
    return false;
  }

  const approved = await onConfirm("verifier", {
    command: verifierCmd,
    script: desc?.script,
    detail: origin ? `${origin}${desc?.evidence ? `\n${desc.evidence}` : ""}` : desc?.evidence,
    digest,
  });

  if (approved) {
    this.approvedVerifiers.add(cacheKey);
    return true;
  }
  return false;
}

export async function runTypecheckOracleImpl(this: any, opts: {
    candidateId?: string;
    current?: { inputs: string; epoch: string; mutationSeq: number; external: string };
    budgetSecs: number;
    onConfirm?: ConfirmHandler;
    configured: boolean;
  }): Promise<{ evidence: TypecheckEvidence; block?: string }> {
  const at = () => new Date().toISOString();
  const mode = typecheckMode(this.config.typecheck, opts.configured);
  const skipped = (scope: string, extra: Partial<TypecheckEvidence> = {}) => ({
    evidence: (this.lastTypecheck = { status: "NOT_APPLICABLE" as const, scope, candidateId: opts.candidateId, ...extra, at: at() }),
  });
  if (mode === "off") return skipped("disabled by NEXUS_TYPECHECK / typecheck setting");
  const check = discoverTypecheck(this.config.workspace);
  if (!check) return skipped("no tsconfig.json or Cargo.toml found");
  const named = { tool: check.tool, command: check.command, configPath: check.configPath, configSha256: check.configSha256, ...(check.toolSha256 ? { toolSha256: check.toolSha256 } : {}) };
  if (check.skipReason) return skipped(check.skipReason, named);
  // Not installed: nothing was checked. Said plainly, with no approval prompt for a tool that cannot run, never a pass.
  if (check.missingTool) {
    return { evidence: (this.lastTypecheck = { status: "UNAVAILABLE" as const, scope: `${check.tool} is not installed, so nothing was type-checked under ${check.configPath}`, ...named, enforced: mode === "enforce", candidateId: opts.candidateId, at: at() }) };
  }
  const enforced = mode === "enforce";
  const ledger = this.objective;
  const current = opts.current;
  const prior = ledger && current && enforced ? priorAttempt(ledger, check.command, current) : undefined;
  if (ledger && current && prior?.status === "FAILED" && this.lastTypecheck?.command === check.command) {
    recordAttempt(ledger, { command: check.command, ...current, status: "SKIPPED_UNCHANGED_INPUTS", ...(prior.failedCheck ? { failedCheck: prior.failedCheck } : {}) });
    return {
      evidence: this.lastTypecheck,
      block: `Verification Oracle: ${check.command} already failed on these exact workspace inputs (attempt #${prior.n}); nothing it checks has changed, so it was not run again.\n${prior.failedCheck ? `Failed check: ${prior.failedCheck}\n` : ""}Fix the type errors, then call task_completed again.`,
    };
  }
  if (!(await this.ensureVerifierApproved(check.command, opts.onConfirm, "type-check for the task", check.toolSha256))) {
    return enforced
      ? { evidence: (this.lastTypecheck = { status: "NOT_APPLICABLE" as const, scope: "type-check not approved", ...named, enforced, candidateId: opts.candidateId, at: at() }), block: `Verification Oracle: type-check execution was not approved by operator (${check.command}).` }
      : skipped("type-check not approved", named);
  }
  this.activity("verifying", { tool: check.command });
  // Modified = what an edit tool touched plus what the workspace diff shows changed since the task began (a shell
  // command, a formatter or a generator edits files no edit tool reported).
  const modified = new Set<string>(this.modifiedFiles);
  const shellChanged: string[] = [];
  try {
    for (const file of workspaceChangedPaths(this.config.workspace)) {
      if (modified.has(file) || this.preTaskChanged?.has(file)) continue;
      modified.add(file);
      shellChanged.push(path.relative(this.config.workspace, file));
    }
  } catch {}
  const baseline = this.typecheckBaseline?.command === check.command ? this.typecheckBaseline.signatures : undefined;
  const run = await runTypecheck(
    check,
    (command, timeout_secs) => this.bridge.executeTool("run_command", { command, timeout_secs }),
    this.config.workspace,
    modified,
    opts.budgetSecs,
    baseline,
  );
  const excerpt = `(untrusted compiler output)\n${safeTerminal(foldVoluminousOutput(run.output || "", 30, 2000))}`;
  const evidence: TypecheckEvidence = {
    status: run.status,
    enforced,
    ...named,
    ...(run.version ? { toolVersion: run.version } : {}),
    exitCode: run.exitCode,
    ...(run.errorCount !== undefined ? { errorCount: run.errorCount, firstDiagnostics: (run.firstDiagnostics ?? []).map((d) => safeTerminal(d)) } : {}),
    ...(baseline ? { baselineErrorCount: baseline.size } : {}),
    ...(run.introducedCount !== undefined ? { introducedCount: run.introducedCount } : {}),
    ...(shellChanged.length ? { shellChangedFiles: shellChanged.slice(0, 20) } : {}),
    scope: `under ${check.configPath}`,
    ...(run.status === "PASSED" ? {} : { excerpt }),
    candidateId: opts.candidateId,
    at: at(),
  };
  this.lastTypecheck = evidence;
  const blocking = run.status === "FAILED" || run.status === "TIMED_OUT";
  if (ledger && current && (blocking || run.status === "PASSED")) {
    recordAttempt(ledger, {
      command: check.command,
      ...current,
      mutationSeq: this.mutationSeq,
      status: run.status === "PASSED" ? "PASSED" : run.status === "TIMED_OUT" ? "TIMED_OUT" : "FAILED",
      ...(blocking
        ? {
            failedCheck: safeTerminal(run.firstDiagnostics?.[0] ?? run.status).slice(0, 240),
            ...attemptEvidence(run.output, run.exitCode, { timedOut: run.status === "TIMED_OUT" }),
            ...(run.status === "FAILED" ? { classification: "CANDIDATE_FAILED" as const, failingTests: (run.firstDiagnostics ?? []).map((d) => safeTerminal(d).slice(0, 240)) } : {}),
          }
        : {}),
    });
  }
  if (!enforced || !blocking) return { evidence };
  const what = run.status === "FAILED" ? "failed" : `timed out after ${opts.budgetSecs}s`;
  return {
    evidence,
    block: `Verification Oracle: tests passed, but the ${check.tool} type-check ${what} under ${check.configPath} (sha256 ${check.configSha256.slice(0, 12)}), so the changes are NOT verified.\nCommand: ${check.command}\n${excerpt}\nFix the type errors, then call task_completed again.`,
  };
}

export async function captureChangeBaselineImpl(this: any, confirmHandler?: ConfirmHandler): Promise<void> {
  // What was already changed when the task began (carried changes included), so only later shell changes are the candidate's.
  if (!this.preTaskChanged) {
    try {
      this.preTaskChanged = new Set(workspaceChangedPaths(this.config.workspace));
    } catch {}
  }
  // A new conversation does not make candidate writes from an interrupted or
  // resumed task trustworthy. Do not establish a discovered-verifier baseline
  // from a workspace that still carries an unverified-change obligation.
  if (this.hasPendingModifications || this.verificationBaselineInvalidated || this.changeBaseline !== undefined || this.config.dryRun || this.isReadOnly()) return;
  const configured = this.config.authoritativeVerifierCommand?.trim();
  const command = configured || discoverVerifier(this.config.workspace)?.command;
  if (!command) {
    this.changeBaseline = null;
    return;
  }
  this.judgeReceiptBaselineOnce(); // see the field: verification proceeds, no receipt is issued
  try {
    const tests = snapshotTests(this.config.workspace);
    const trustedDeliverables = [...(this.config.trustedDeliverableFiles ?? [])];
    const definition = this.verifierDefinitionAtCapture(command, trustedDeliverables);
    if (configured) {
      this.changeBaseline = { command, failed: false, tests, ...definition, trustedDeliverables, at: new Date().toISOString() };
      if (this.durable) {
        try {
          this.checkpointDurableState("configured verifier baseline captured");
        } catch (err: any) {
          this.reportPersistenceFailure("baseline", err);
        }
      }
      return;
    }
    const approved = await this.ensureVerifierApproved(command, confirmHandler);
    if (!approved) {
      this.changeBaseline = null;
      return;
    }
    this.activity("verifying", { tool: `${command} (before the change)` });
    const deadlineSecs = this.config.verifierTimeoutSecs ?? DEFAULT_VERIFIER_TIMEOUT_SECS;
    const run = await runTestSuiteWithExecutor(this.config.workspace, (c) => this.bridge.executeTool("run_command", { command: c, timeout_secs: deadlineSecs }), command);
    this.changeBaseline = { command, failed: !run.success, tests, ...definition, trustedDeliverables, at: new Date().toISOString() };
    this.turnVerifierRuns.push({ command, phase: "before_change", passed: run.success });
    await captureTypecheckBaselineImpl.call(this, confirmHandler, deadlineSecs);
    if (this.durable) {
      try {
        this.checkpointDurableState("baseline captured");
      } catch (err: any) {
        this.reportPersistenceFailure("baseline", err);
      }
    }
  } catch {
    this.changeBaseline = null;
  }
}

export function verifierDefinitionAtCaptureImpl(this: any, command: string, trustedDeliverables: readonly string[]): Pick<ChangeBaseline, "verifier" | "verifierUnbindableReason"> {
  const definition = snapshotVerifierDefinitionWithReason(this.config.workspace, command, trustedDeliverables);
  return definition.verifier || isInlineProgramVerifier(command) ? { verifier: definition.verifier } : { verifier: null, verifierUnbindableReason: definition.reason };
}

export async function judgeIndependenceImpl(this: any, command: string, deadlineSecs: number, confirmHandler?: ConfirmHandler): Promise<Independence> {
  const judged = judgeWithoutCopy(this.config.workspace, command, this.changeBaseline);
  if (judged !== "needs-copy") return judged;
  const approved = await this.ensureVerifierApproved(command, confirmHandler);
  if (!approved) return { independent: false, detail: "verifier execution was not approved" };
  // Nexus edited test files: run the tests as they were before the change against the changed code.
  const dir = prepareBaselineTestsCopy(this.config.workspace, this.changeBaseline!.tests!, this.changeBaseline!.verifier!);
  if (!dir) return { independent: false, detail: "the workspace is too large to rerun the pre-change tests without Nexus's own test edits" };
  try {
    this.activity("verifying", { tool: `${command} (tests as they were before the change)` });
    const quoted = `'${dir.replace(/'/g, `'\\''`)}'`;
    const run = await runTestSuiteWithExecutor(this.config.workspace, (c) => this.bridge.executeTool("run_command", { command: `cd ${quoted} && ${c}`, timeout_secs: deadlineSecs }), command);
    return run.success && hasExecutedTests(run.rawOutput || "")
      ? { independent: true, detail: "tests that failed before the change pass after it, with Nexus's own test edits set aside" }
      : { independent: false, detail: "it passes only with tests Nexus wrote or edited; the tests as they were before the change still fail" };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function runRequirementVerifierImpl(this: any, requirement: { id: string; verifierSource?: string }, command: string): Promise<string | undefined> {
  const ledger = this.objective;
  const state = this.verifierState();
  if (!ledger || !state || priorAttempt(ledger, command, state, requirement.id)) return undefined;
  const onConfirm = this.activeTurn?.onConfirm;
  const origin = `${requirement.verifierSource === "operator" ? "operator-declared" : "model-declared"} verifier for ${requirement.id}: ${command}`;
  if (!(await this.ensureVerifierApproved(command, onConfirm, origin))) {
    return `${requirement.id}: verifier execution was not approved${onConfirm ? "" : " (it requires operator approval and no operator is present)"}`;
  }
  const deadlineSecs = this.config.verifierTimeoutSecs ?? DEFAULT_VERIFIER_TIMEOUT_SECS;
  this.activity("verifying", { tool: command });
  const run = await runTestSuiteWithExecutor(this.config.workspace, (c) => this.bridge.executeTool("run_command", { command: c, timeout_secs: deadlineSecs }), command);
  // The state after the run: a verifier that writes build output must still be able to verify what it produced.
  const after = this.verifierState();
  if (after) {
    recordAttempt(ledger, {
      command,
      ...after,
      status: run.success ? "PASSED" : run.timedOut ? "TIMED_OUT" : "FAILED",
      requirementId: requirement.id,
      ...(run.success ? {} : { failedCheck: failedCheckFrom(run.rawOutput || ""), ...attemptEvidence(run.rawOutput || "", run.exitCode, { timedOut: run.timedOut, executorFailed: run.executorFailed }) }),
    });
  }
  this.turnVerifierRuns.push({ command, phase: "completion", passed: run.success });
  return undefined;
}


/**
 * VC-6: the type-check errors that exist before the change, so an error that appears in an untouched file (a caller the
 * change broke) is told apart from one that was already there. Only where cheap: tsc, go vet, pyright and mypy, not
 * cargo, whose first check compiles dependencies. Nothing is recorded when the tool is missing, the run is not approved,
 * times out or cannot be attributed; completion then behaves as before.
 */
export async function captureTypecheckBaselineImpl(this: any, confirmHandler: ConfirmHandler | undefined, deadlineSecs: number): Promise<void> {
  try {
    if (typecheckMode(this.config.typecheck, Boolean(this.config.authoritativeVerifierCommand?.trim())) === "off") return;
    const check = discoverTypecheck(this.config.workspace);
    if (!check || check.skipReason || check.missingTool || check.tool === "cargo") return;
    if (!(await this.ensureVerifierApproved(check.command, confirmHandler, "type-check baseline (before the change)", check.toolSha256))) return;
    this.activity("verifying", { tool: `${check.command} (before the change)` });
    const run = await runTypecheck(check, (command, timeout_secs) => this.bridge.executeTool("run_command", { command, timeout_secs }), this.config.workspace, new Set(), deadlineSecs);
    if (run.status === "PASSED") this.typecheckBaseline = { command: check.command, signatures: new Set() };
    else if (run.status === "PREEXISTING") this.typecheckBaseline = { command: check.command, signatures: new Set(run.signatures ?? []) };
  } catch {}
}
