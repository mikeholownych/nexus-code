import * as fs from "node:fs";
import * as path from "node:path";
import { PolicyContext } from "./approval_policy.js";
import { isWorkspaceTrusted } from "../workspace_trust.js";
import { safeTerminal } from "../ui.js";
import { workspaceChangedPaths } from "../git.js";
import { buildNeedsInput } from "./needs_input.js";
import { runTestSuiteWithExecutor, discoverTypechecks, runTypecheck, typecheckMode, discoverVerifier, describeVerifier, hasExecutedTests } from "../tester.js";
import { isInlineProgramVerifier, snapshotVerifierDefinitionWithReason, judgeWithoutCopy, prepareBaselineTestsCopy, snapshotTests, type ChangeBaseline, type Independence } from "./independent_check.js";
import { TypecheckEvidence } from "./turn.js";
import { createHash } from "node:crypto";
import { failedCheckFrom, attemptEvidence, priorAttempt, recordAttempt } from "./objective.js";
import { DEFAULT_VERIFIER_TIMEOUT_SECS, ConfirmHandler, foldVoluminousOutput } from "./agent_support.js";

/**
 * `askHeadless`: with no operator present, record the decision as a NEEDS_INPUT question (VC-9) instead of only
 * refusing. The baseline captures pass false: they run before any change and a refusal there ends nothing.
 */
export async function ensureVerifierApprovedImpl(this: any, command: string, confirmHandler?: ConfirmHandler, origin?: string, binding?: string, askHeadless = true): Promise<boolean> {
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
    if (!askHeadless) return false;
    const decision = this.headlessDecision(buildNeedsInput(
      "verifier_approval",
      `Run ${verifierCmd.slice(0, 160)} as the verifier${origin ? ` (${origin.slice(0, 120)})` : ""}?`,
      { command: verifierCmd.slice(0, 200), digest: digest.slice(0, 16) },
      verifierCmd,
      digest,
    ));
    if (decision !== "approve") return false;
    this.approvedVerifiers.add(cacheKey);
    return true;
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
  const checks = discoverTypechecks(this.config.workspace);
  if (!checks.length) return skipped("no configured type-check project found");
  const enforced = mode === "enforce";
  const ledger = this.objective;
  const current = opts.current;
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
  const results: TypecheckEvidence[] = [];
  const blockingMessages: string[] = [];
  const typecheckDeadline = Date.now() + Math.max(0, opts.budgetSecs) * 1000;
  for (const check of checks) {
    const named = { tool: check.tool, command: check.command, configPath: check.configPath, configSha256: check.configSha256, ...(check.toolSha256 ? { toolSha256: check.toolSha256 } : {}) };
    if (check.skipReason) {
      results.push({ status: check.discoveryIncomplete ? "UNAVAILABLE" : "NOT_APPLICABLE", ...named, enforced, scope: check.skipReason, candidateId: opts.candidateId, at: at() });
      if (enforced) blockingMessages.push(check.discoveryIncomplete
        ? `workspace type-check discovery was incomplete: ${check.skipReason}`
        : `${check.tool} type-check under ${check.configPath} was not run: ${check.skipReason}`);
      continue;
    }
    if (check.missingTool) {
      results.push({ status: "UNAVAILABLE", ...named, enforced, scope: `${check.tool} is not installed, so nothing was type-checked under ${check.configPath}`, candidateId: opts.candidateId, at: at() });
      if (enforced) blockingMessages.push(`${check.tool} type-check under ${check.configPath} is unavailable because ${check.tool} is not installed.`);
      continue;
    }
    const prior = ledger && current && enforced ? priorAttempt(ledger, check.command, current) : undefined;
    if (ledger && current && prior?.status === "FAILED" && (this.lastTypecheck?.command === check.command || this.lastTypecheck?.projects?.some((project: TypecheckEvidence) => project.command === check.command))) {
      recordAttempt(ledger, { command: check.command, ...current, status: "SKIPPED_UNCHANGED_INPUTS", ...(prior.failedCheck ? { failedCheck: prior.failedCheck } : {}) });
      results.push(this.lastTypecheck);
      blockingMessages.push(`${check.command} already failed on these exact inputs (attempt #${prior.n}).${prior.failedCheck ? ` Failed check: ${prior.failedCheck}` : ""}`);
      continue;
    }
    if (!(await this.ensureVerifierApproved(check.command, opts.onConfirm, "type-check for the task", check.toolSha256, enforced))) {
      const denied: TypecheckEvidence = { status: "NOT_APPLICABLE", ...named, enforced, scope: "type-check not approved", candidateId: opts.candidateId, at: at() };
      results.push(denied);
      if (enforced) blockingMessages.push(`type-check execution was not approved (${check.command})`);
      continue;
    }
    this.activity("verifying", { tool: check.command });
    const baseline = this.typecheckBaseline.get(check.command);
    const remainingSecs = Math.ceil((typecheckDeadline - Date.now()) / 1000);
    if (remainingSecs <= 0) {
      const timedOut: TypecheckEvidence = { status: "TIMED_OUT", enforced, ...named, scope: `not run: aggregate type-check budget of ${opts.budgetSecs}s exhausted`, candidateId: opts.candidateId, at: at() };
      results.push(timedOut);
      if (enforced) blockingMessages.push(`${check.tool} type-check under ${check.configPath} was not run because the aggregate ${opts.budgetSecs}s type-check budget was exhausted.`);
      continue;
    }
    const run = await runTypecheck(check, (command, timeout_secs) => this.bridge.executeTool("run_command", { command, timeout_secs }), this.config.workspace, modified, remainingSecs, baseline);
    // Without the pre-change signatures, PREEXISTING means only that the current compiler failed. On resume that
    // output cannot show whether the errors predate the task or were introduced by its edits, so never accept it as
    // an attributed baseline result.
    const resumedWithoutBaseline = this.typecheckBaselineUnavailableAfterResume && !baseline && run.status === "PREEXISTING";
    const resultStatus = resumedWithoutBaseline ? "UNAVAILABLE" : run.status;
    const resultScope = resumedWithoutBaseline
      ? "pre-change type-check baseline is unavailable after resume; current diagnostics cannot be attributed"
      : `under ${check.configPath}`;
    const excerpt = `(untrusted compiler output)\n${safeTerminal(foldVoluminousOutput(run.output || "", 30, 2000))}`;
    const evidence: TypecheckEvidence = {
      status: resultStatus, enforced, ...named,
      ...(run.version ? { toolVersion: run.version } : {}),
      exitCode: run.exitCode,
      ...(run.errorCount !== undefined ? { errorCount: run.errorCount, firstDiagnostics: (run.firstDiagnostics ?? []).map((d) => safeTerminal(d)) } : {}),
      ...(baseline ? { baselineErrorCount: baseline.size } : {}),
      ...(run.introducedCount !== undefined ? { introducedCount: run.introducedCount } : {}),
      ...(shellChanged.length ? { shellChangedFiles: shellChanged.slice(0, 20) } : {}),
      scope: resultScope,
      ...(run.status === "PASSED" ? {} : { excerpt }), candidateId: opts.candidateId, at: at(),
    };
    results.push(evidence);
    const failedOrTimedOut = run.status === "FAILED" || run.status === "TIMED_OUT";
    const blocking = failedOrTimedOut || resumedWithoutBaseline;
    if (ledger && current && (failedOrTimedOut || run.status === "PASSED")) recordAttempt(ledger, {
      command: check.command, ...current, mutationSeq: this.mutationSeq,
      status: run.status === "PASSED" ? "PASSED" : run.status === "TIMED_OUT" ? "TIMED_OUT" : "FAILED",
      ...(failedOrTimedOut ? {
        failedCheck: safeTerminal(run.firstDiagnostics?.[0] ?? run.status).slice(0, 240),
        ...attemptEvidence(run.output, run.exitCode, { timedOut: run.status === "TIMED_OUT" }),
        ...(run.status === "FAILED" ? { classification: "CANDIDATE_FAILED" as const, failingTests: (run.firstDiagnostics ?? []).map((d) => safeTerminal(d).slice(0, 240)) } : {}),
      } : {}),
    });
    if (enforced && blocking) {
      const what = resumedWithoutBaseline
        ? "could not be attributed because its pre-change baseline was not retained across resume"
        : run.status === "FAILED" ? "failed" : `timed out after ${opts.budgetSecs}s`;
      blockingMessages.push(`${check.tool} type-check ${what} under ${check.configPath} (sha256 ${check.configSha256.slice(0, 12)}). Command: ${check.command}\n${excerpt}`);
    }
  }
  const priority: TypecheckEvidence["status"][] = ["FAILED", "TIMED_OUT", "UNAVAILABLE", "NOT_APPLICABLE", "ENVIRONMENT", "PREEXISTING", "PASSED"];
  const primary = priority.map((status) => results.find((item) => item.status === status)).find((item) => item !== undefined) ?? results[0];
  const evidence: TypecheckEvidence = { ...primary, scope: results.length === 1 ? primary.scope : `${results.length} project check(s)`, projects: results };
  this.lastTypecheck = evidence;
  return { evidence, ...(blockingMessages.length ? { block: `Verification Oracle: tests passed, but a mandatory project type-check did not complete successfully; changes are NOT verified.\n${blockingMessages.join("\n\n") }\nFix the type errors or resolve the unavailable approval, then call task_completed again.` } : {}) };
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
    const approved = await this.ensureVerifierApproved(command, confirmHandler, undefined, undefined, false);
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
    for (const check of discoverTypechecks(this.config.workspace)) {
      if (check.skipReason || check.missingTool) continue;
      if (!(await this.ensureVerifierApproved(check.command, confirmHandler, "type-check baseline (before the change)", check.toolSha256, false))) continue;
      this.activity("verifying", { tool: `${check.command} (before the change)` });
      const run = await runTypecheck(check, (command, timeout_secs) => this.bridge.executeTool("run_command", { command, timeout_secs }), this.config.workspace, new Set(), deadlineSecs);
      if (run.status === "PASSED") this.typecheckBaseline.set(check.command, new Set());
      else if (run.status === "PREEXISTING") this.typecheckBaseline.set(check.command, new Set(run.signatures ?? []));
    }
  } catch {}
}
