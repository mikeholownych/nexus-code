import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { HarnessConfig } from "../types.js";
import { registerBridgeCapabilities } from "../tools.js";
import { PolicyContext } from "./approval_policy.js";
import { describeSource } from "./managed_policy.js";
import { approvalDecisionSource, clampApprovalSettings, humanRequirementForEffect } from "./policy_runtime.js";
import { isWorkspaceTrusted } from "../workspace_trust.js";
import { MAX_SKILL_MATCHES, oneLine } from "../skills.js";
import { formatDiagnosticHints } from "../diagnostics.js";
import { captureVerificationState, recordVerificationIfEligible } from "../worktrunk/verification.js";
import { runTestSuiteWithExecutor, discoverVerifier, hasExecutedTests, isVerifierDeliverableBound, isFilteredVerifierCommand } from "../tester.js";
import { TOOL_GROUPS } from "./tool_groups.js";
import { readWorkspaceTestSnapshot, snapshotVerifierDefinitionWithReason, requiresWorkspaceVerifierDefinitionBinding, trustedDeliverablesFromBaseline, testsChangedSince, verifierDefinitionChangedSince, verifierDefinitionMatchesSnapshot, tddRedTestsMatchSnapshot, type Independence } from "./independent_check.js";
import { VerificationEvidence } from "./turn.js";
import { createHash } from "node:crypto";
import { getBuildIdentity } from "../build_identity.js";
import { canonicalJson } from "./hash_chain.js";
import { unmetObligationsMessage } from "./regression_obligations.js";
import { RequirementUpdate, applyRequirementUpdates, invalidateVerified, isHardRequirement, readObjective, blockedRequirements, failedCheckFrom, attemptEvidence, describeAttemptEvidence, gatingRequirements, openRequirements, priorAttempt, convergenceSignal, convergenceHistory, recordAttempt } from "./objective.js";
import { readArchive, readFindings } from "./findings.js";
import { readToolOutput, resolveMaskedOutput } from "./tool_output_mask.js";
import { snapshot } from "../file_diff.js";
import pc from "picocolors";
import { collectMaterialDependencies } from "../material_deps.js";
import { DEFAULT_VERIFIER_TIMEOUT_SECS, foldVoluminousOutput, externalInputsFingerprint, RESUMED_WINDOW_REASON } from "./agent_support.js";
import type { AutonomousAgent } from "../agent.js";
import { ROLE_PROFILES, isReadOnlyRole, roleToolAllowList, type AgentRole } from "./roles.js";
import { acquireTransientDelegationSlot, createDelegationOutcome, delegationRuntimeLimits, resolveDelegationContract } from "./delegation_contract.js";
import { isSpecialistRole, missingSpecialistInputs, specialistInputsProblem } from "./specialist_profiles.js";

function sha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function verifierDefinitionSha256(verifier: Map<string, string> | undefined): string | null {
  if (!verifier || verifier.size === 0) return null;
  const files = [...verifier.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, content]) => [file, createHash("sha256").update(content, "utf8").digest("hex")]);
  return canonicalSha256(files);
}

export interface TestSnapshotDigest {
  digest: string | null;
  /** The honest reason a digest could not be taken, distinct from a digest that changed between two reads. */
  problem?: string;
}

/**
 * A digest of every discoverable test file as it stands at one moment, hashed as raw bytes. The verifier binding below
 * compares the digest taken before the verifier with one taken after it, so a test that rewrites itself while it runs
 * - even one restored to its base content before exit - cannot be judged on its post-run content. An incomplete
 * discovery or unreadable file fails closed with the reason why, not a claim that the files changed.
 */
export function testSnapshotDigest(workspace: string): TestSnapshotDigest {
  const snapshot = readWorkspaceTestSnapshot(workspace);
  if (!snapshot.files) return { digest: null, problem: snapshot.problem };
  const hash = createHash("sha256");
  const length = Buffer.alloc(4);
  for (const [file, bytes] of [...snapshot.files].sort(([a], [b]) => a.localeCompare(b))) {
    length.writeUInt32BE(bytes.length);
    hash.update(file).update("\0").update(length).update(bytes);
  }
  return { digest: hash.digest("hex") };
}

export function setupSpineHandlersImpl(this: any): void {
  registerBridgeCapabilities(this.capabilityRegistry, this.bridge);

  this.spine.registerHandler("task_completed", async (args: any) => {
    const validCompletion =
      Boolean(args) &&
      typeof args === "object" &&
      !Array.isArray(args) &&
      typeof args.summary === "string" &&
      args.summary.trim().length > 0 &&
      (args.notes === undefined || typeof args.notes === "string");
    if (!validCompletion) {
      return {
        success: false,
        output: "",
        error:
          "Invalid task_completed payload: summary must be a non-empty string and notes, when present, must be a string.",
      };
    }

    // The operator's acceptance requirements gate completion; a coarse completed plan does not.
    if (this.objective && (this.depth === 0 || this.role === "implementer" || this.role === "tester")) {
      const open = openRequirements(this.objective);
      const blocked = blockedRequirements(this.objective);
      if (open.length || blocked.length) {
        const list = (items: typeof open) => items.map((r) => `${r.id} [${r.status}] ${r.text}${r.note ? ` (${r.note})` : ""}${isHardRequirement(r) && r.status === "implemented" ? ` (${r.kind}: done only when ${r.verifier && r.verifierSource === "operator" ? `its verifier '${r.verifier}' passes after your last change: mark it verified` : "the operator accepts it"})` : ""}`).join("\n  ");
        return {
          success: false,
          output: "",
          error:
            `Not complete: the operator's acceptance requirements are not all done.\n` +
            (open.length ? `Open:\n  ${list(open)}\n` : "") +
            (blocked.length ? `Blocked:\n  ${list(blocked)}\n` : "") +
            `Finish the open ones and record evidence with update_requirements (implemented/verified). ` +
            `A requirement that cannot be done here must be marked blocked or descoped with the reason; ` +
            `a blocked task is not completed — end with a final message stating the blocker instead of calling task_completed.`,
        };
      }
    }

    const worktreeHasChanges = this.activeWorktree
      ? this.worktreeManager.bindingHasChanges(this.activeWorktree)
      : false;
    let verifierSucceeded = false;
    let hasExecuted = false;
    // The linked worktree's state before the verifier runs: a receipt covers that state only.
    let verificationStateBefore: ReturnType<typeof captureVerificationState>;
    let isDeliverableBound = false;
    let noApplicableVerifier = false;

    // An operator-configured verifier gates every completion, not only one that follows changes.
    if (
      (this.hasPendingModifications || worktreeHasChanges || this.configuredVerifierGatesCompletion()) &&
      !this.config.dryRun &&
      !this.config.diagnosticRun &&
      !this.isReadOnly()
    ) {
      try {
        const configured = this.config.authoritativeVerifierCommand?.trim();
        const discovered = configured ? null : discoverVerifier(this.config.workspace);
        const verifierCommand = configured || discovered?.command;
        const source: "configured" | "discovered" = configured ? "configured" : "discovered";
        if (!verifierCommand) {
          // No repository evidence supports any verifier. Completion is allowed but honestly UNVERIFIED.
          noApplicableVerifier = true;
          this.verificationEvidence = { status: "NO_APPLICABLE_VERIFIER", at: new Date().toISOString() };
        } else {
          // Inputs the verifier would run on. A failure on exactly these inputs is not rerun: nothing it checks has
          // changed, so it would fail the same way and only cost time. The gate stays closed (evidence stays FAILED).
          let candidateId: string | undefined;
          try {
            candidateId = this.candidateTracker.computeCandidateIdentitySync(this.config.workspace).candidateId;
          } catch {}
          const current = candidateId ? { inputs: candidateId, epoch: this.epoch, mutationSeq: this.mutationSeq, external: externalInputsFingerprint(this.config.workspace) } : undefined;
          const bindsWorkspaceDefinition =
            source === "discovered" ||
            requiresWorkspaceVerifierDefinitionBinding(verifierCommand);
          const matchingBaseline =
            this.changeBaseline?.command === verifierCommand;
          const hasTddRedVerifier = Boolean(
            matchingBaseline && this.changeBaseline?.tddRedVerifier && this.changeBaseline.tddRedTests,
          );
          const tddRedVerifierMatches = Boolean(
            hasTddRedVerifier &&
            verifierDefinitionMatchesSnapshot(
              this.config.workspace,
              verifierCommand,
              this.changeBaseline!.tddRedVerifier!,
              this.config.trustedDeliverableFiles ?? [],
            ) &&
            tddRedTestsMatchSnapshot(this.config.workspace, this.changeBaseline!.tddRedTests!),
          );
          const verifierDefinitionChanged =
            matchingBaseline &&
            (hasTddRedVerifier
              ? !tddRedVerifierMatches
              : verifierDefinitionChangedSince(this.config.workspace, this.changeBaseline!));
          // After a restart the baseline is gone but the recorded unbound marker remains: honoured only while the
          // definition is still unbindable now, so a forged marker cannot excuse a bindable verifier.
          const recoveredUnbound = bindsWorkspaceDefinition && !matchingBaseline && this.recoveredUnboundVerifier?.command === verifierCommand
            ? snapshotVerifierDefinitionWithReason(this.config.workspace, verifierCommand, this.config.trustedDeliverableFiles ?? [])
            : undefined;
          const unboundReason = bindsWorkspaceDefinition && matchingBaseline && !hasTddRedVerifier && !this.changeBaseline?.verifier?.size
            ? this.changeBaseline?.verifierUnbindableReason
            : recoveredUnbound && !recoveredUnbound.verifier ? recoveredUnbound.reason : undefined;
          const unboundDetail = unboundReason
            ? `the verifier's definition could not be bound (${unboundReason}), so it was not verified unchanged (the candidate could have edited it) and the pass is regression evidence only`
            : undefined;
          if (
            bindsWorkspaceDefinition &&
            (!matchingBaseline || verifierDefinitionChanged) &&
            !this.activeTurn?.tddRed &&
            !unboundDetail
          ) {
            const detail = !matchingBaseline
            ? "The workspace-resolved verifier has no matching pre-change baseline. Its current output cannot establish verification; start a fresh task from an operator-reviewed trusted workspace baseline."
              : this.changeBaseline?.verifier
                ? "The workspace-resolved verifier definition changed after its baseline. Restore it or start a fresh task from a trusted baseline; its output cannot establish verification."
                : "The workspace-resolved verifier definition was not captured before this work. Its current output cannot establish verification; start a fresh task from an operator-reviewed trusted workspace baseline.";
            this.verificationEvidence = {
              status: "FAILED",
              command: verifierCommand,
              source,
              exitSuccess: false,
              hasExecutedTests: false,
              isDeliverableBound: false,
              independent: false,
              independenceDetail: detail,
              candidateId,
              at: new Date().toISOString(),
            };
            return {
              success: false,
              output: "",
              error: detail,
            };
          }
          const prior = this.objective && current ? priorAttempt(this.objective, verifierCommand, current) : undefined;
          if (prior && (prior.status === "FAILED" || prior.status === "TIMED_OUT") && this.objective && current) {
            recordAttempt(this.objective, { command: verifierCommand, ...current, status: "SKIPPED_UNCHANGED_INPUTS", ...(prior.failedCheck ? { failedCheck: prior.failedCheck } : {}), ...(prior.classification ? { classification: prior.classification } : {}), ...(prior.exitCode !== undefined ? { exitCode: prior.exitCode } : {}), ...(prior.failingTests ? { failingTests: prior.failingTests } : {}) });
            if (!this.verificationEvidence || this.verificationEvidence.status === "PASSED") {
              this.verificationEvidence = { status: prior.status, command: verifierCommand, source, exitSuccess: false, candidateId, ...(this.lastTypecheck ? { typecheck: this.lastTypecheck } : {}), at: prior.at };
            }
            return {
              success: false,
              output: "",
              error:
                `Verification Oracle: ${verifierCommand} already ${prior.status === "TIMED_OUT" ? "timed out" : "failed"} on these exact workspace inputs ` +
                `(attempt #${prior.n} at ${prior.at}; candidate ${current.inputs.slice(0, 12)}). No workspace file, mutating command or dependency/environment marker has changed since, so it was not run again.\n` +
                (prior.failedCheck ? `Failed check: ${prior.failedCheck}\n` : "") +
                (describeAttemptEvidence(prior) ? `Evidence: ${describeAttemptEvidence(prior)}\n` : "") +
                `Make a change that addresses the failure, then call task_completed again. If the failure is outside this task's scope, ` +
                `do not claim completion: mark the affected requirement blocked with update_requirements (giving the failed check as the reason) ` +
                `and end with a final message stating what remains and the next action.`,
            };
          }
          // Gate verifier execution through approval policy
          const onConfirm = this.activeTurn?.onConfirm;
          const approved = await this.ensureVerifierApproved(verifierCommand, onConfirm);
          if (!approved) {
            const isTrusted = isWorkspaceTrusted(this.config.workspace, this.isReadOnly());
            const mode = this.getApprovalMode();
            // GV-1: the refusal is worded under the same clamp as the tool gate, and names the tier that decided.
            const managed = this.bridge.getSecurityManager().getEffectivePolicy();
            const human = humanRequirementForEffect(managed, "exec");
            const askedContext: PolicyContext = {
              mode,
              trusted: isTrusted,
              sandbox: this.config.sandbox,
              approvedEgressOrigins: this.approvedEgressOrigins,
              fullAccess: Boolean(this.config.fullAccess) && !this.isReadOnly(),
            };
            const policyContext: PolicyContext = clampApprovalSettings(managed, askedContext, human);
            const decidedBy = approvalDecisionSource(managed, askedContext);
            const guidance = human
              ? human.message
              : decidedBy.tier !== "default"
                ? `Managed policy disables automatic approvals here. ${describeSource(decidedBy)}`
                : this.config.surface === "unattended"
                  ? "An unattended run never approves a command. Only the operator's own verifier (the exact --verifier command set when the job or schedule was made) runs without approval; this command is not it."
                  : `Run with --yes or --mode auto to explicitly select automatic approvals. ${describeSource(decidedBy)}`;
            const error = (!onConfirm && this.approvalPolicy.requiresDecision("exec", policyContext))
              ? `Error: Verifier '${verifierCommand}' requires operator approval (exec), but no operator is present (headless execution). ${guidance}`
              : `Verification Oracle: verifier execution was not approved by operator (${verifierCommand}).`;
            return {
              success: false,
              output: "",
              error,
            };
          }

          // The oracle owns the verifier's deadline (never an incidental bridge default); the runner enforces it.
          const deadlineSecs = this.config.verifierTimeoutSecs ?? DEFAULT_VERIFIER_TIMEOUT_SECS;
          this.activity("verifying", { tool: verifierCommand });
          verificationStateBefore = this.isRecordableWorktree() && !this.config.dryRun ? captureVerificationState(this.config.workspace) : undefined;
          const testsBeforeVerifier = testSnapshotDigest(this.config.workspace);
          const verifierStartedAt = Date.now();
          const testRes = await runTestSuiteWithExecutor(
            this.config.workspace,
            (command) => this.bridge.executeTool("run_command", { command, timeout_secs: deadlineSecs }),
            verifierCommand
          );
          const testsAfterVerifier = testSnapshotDigest(this.config.workspace);
          const snapshotProblem = testsBeforeVerifier.problem ?? testsAfterVerifier.problem;
          const testsMutatedDuringVerifier = testsBeforeVerifier.digest !== null && testsAfterVerifier.digest !== null && testsBeforeVerifier.digest !== testsAfterVerifier.digest;
          // A command that can outlive the call may write after the second digest too. Fail closed rather than
          // pretending that two digests bracket the whole interval in which the oracle could have been changed.
          const backgroundCommands = this.turnBackgroundCommands > 0;
          const verifierInputUnbound = snapshotProblem !== undefined || testsMutatedDuringVerifier || backgroundCommands;
          const inputMutationDetail = snapshotProblem
            ?? (backgroundCommands
              ? "a command in this turn can outlive the call and change workspace files while the verifier runs, so its pass cannot be bound to the tree that was committed"
              : testsMutatedDuringVerifier
                ? "test files changed while the verifier ran (including a test that restored itself before exit), so its pass cannot be bound to the tree that was committed"
                : undefined);
          // Configured or discovered, a verifier is evidence about the change only when its run shows tests that
          // executed and cover the changed files.
          hasExecuted = hasExecutedTests(testRes.rawOutput || "");
          const baselineTests = this.changeBaseline?.tests;
          const baselineTestsChanged = !baselineTests || testsChangedSince(this.config.workspace, baselineTests);
          // A generic current-invocation verifier cannot authenticate recovered scope or its
          // candidate-controlled tests. Only a verifier definition and test snapshot captured
          // before the current task's edits can bind workspace changes.
          const configuredTestsStable = source !== "configured" || !baselineTestsChanged;
          isDeliverableBound = (!this.verificationBaselineInvalidated && !verifierInputUnbound && hasExecuted && configuredTestsStable && isVerifierDeliverableBound(
            this.config.workspace,
            Array.from(this.modifiedFiles),
            verifierCommand,
            testRes.rawOutput || "",
            this.changeBaseline?.trustedDeliverables?.length
              ? trustedDeliverablesFromBaseline(this.changeBaseline)
              : new Set(this.config.trustedDeliverableFiles ?? []),
            baselineTests ?? undefined,
          ));
          // A passing verifier is not acceptance while the project's type-check fails under its own configuration.
          const typecheckOutcome = testRes.success
            ? await this.runTypecheckOracle({
                candidateId,
                current,
                budgetSecs: Math.max(30, deadlineSecs - Math.round((Date.now() - verifierStartedAt) / 1000)),
                onConfirm,
                configured: Boolean(configured),
              })
            : undefined;
          const typecheck = typecheckOutcome?.evidence;
          const typecheckBlock = typecheckOutcome?.block;
          const testsAndTypesPass = testRes.success && !typecheckBlock;
          // A discovered verifier's pass makes the change VERIFIED only on independent evidence (fail-before /
          // pass-after on tests the change did not write); the operator's configured verifier is their own check.
          const bindingDetail = unboundDetail ?? inputMutationDetail;
          const independence: Independence | undefined = bindingDetail
            ? { independent: false, detail: bindingDetail }
            : source === "discovered" && testsAndTypesPass && isDeliverableBound ? await this.judgeIndependence(verifierCommand, deadlineSecs, onConfirm) : undefined;
          const evidence: VerificationEvidence = {
            status: testsAndTypesPass ? "PASSED" : testRes.timedOut ? "TIMED_OUT" : "FAILED",
            command: verifierCommand,
            source,
            exitSuccess: testsAndTypesPass,
            hasExecutedTests: hasExecuted,
            ...(typecheck ? { typecheck } : {}),
            isDeliverableBound,
            ...(bindingDetail ? { definitionBound: false } : {}),
            ...(independence ? { independent: independence.independent, independenceDetail: independence.detail } : {}),
            ...(testRes.timedOut ? { deadlineSecs } : {}),
            outputSha256: createHash("sha256").update(testRes.rawOutput || "").digest("hex"),
            candidateId,
            at: new Date().toISOString(),
          };
          this.verificationEvidence = evidence;
          this.verificationEvidenceRawOutput = testRes.rawOutput || "";
          this.turnVerifierRuns.push({ command: verifierCommand, phase: "completion", passed: testsAndTypesPass });
          if (configured) this.turnConfiguredVerifier = testsAndTypesPass ? "PASSED" : "FAILED";
          if (this.objective && candidateId) {
            recordAttempt(this.objective, {
              command: verifierCommand,
              inputs: candidateId,
              epoch: this.epoch,
              // Read after the run: the verifier's own command is not a change to its inputs.
              mutationSeq: this.mutationSeq,
              external: externalInputsFingerprint(this.config.workspace),
              status: testRes.success ? "PASSED" : testRes.timedOut ? "TIMED_OUT" : "FAILED",
              isDeliverableBound,
              ...(independence ? { independent: independence.independent } : {}),
              filtered: isFilteredVerifierCommand(verifierCommand),
              ...(testRes.success ? {} : { failedCheck: failedCheckFrom(testRes.rawOutput || ""), ...attemptEvidence(testRes.rawOutput || "", testRes.exitCode, { timedOut: testRes.timedOut, executorFailed: testRes.executorFailed }) }),
            }, undefined, testRes.rawOutput || "");
          }
          if (testRes.timedOut) {
            const partial = foldVoluminousOutput(testRes.rawOutput || "(no output received)");
            return {
              success: false,
              output: "",
              error: `Verification Oracle: the selected verifier timed out after ${deadlineSecs}s, so the changes are NOT verified.\nCommand: ${testRes.command}\nThis is a timeout, not a test failure. The verifier's process tree was terminated, so it is safe to retry.\nPartial output:\n${partial}\nUse a faster verifier, or ask the operator to raise the verifier deadline (NEXUS_VERIFIER_TIMEOUT_SECS); do not claim completion until the verifier can finish.`,
            };
          }
          if (!testRes.success && this.activeTurn?.tddRed) {
            // The RED phase ends by recording the failing test itself; the unit executor validates this result
            // before any implementation. Normal task_completed still requires a passing verifier.
            this.completionSummary = {
              summary: args.summary || "TDD RED: failing test recorded.",
              notes: args.notes,
            };
            return {
              success: true,
              output: JSON.stringify({
                status: "tdd_red_recorded",
                verification: "FAILED",
                command: testRes.command,
                summary: this.completionSummary.summary,
              }),
            };
          }
          if (typecheckBlock) return { success: false, output: "", error: typecheckBlock };
          if (!testRes.success) {
            const signal = this.objective ? convergenceSignal(this.objective, this.config.continuation?.verifierConvergenceAttempts, verifierCommand) : undefined;
            if (this.objective && signal && signal.state !== "converging") {
              this.turnConvergenceUpTo = this.objective.verification.at(-1)?.n;
              this.turnConvergence = { state: signal.state, evidence: signal.evidence, attempts: convergenceHistory(signal.attempts) };
              return {
                success: false,
                output: "",
                error:
                  `Verification Oracle: ${testRes.command} is not converging: ${signal.evidence}. Retrying will not settle it, so Nexus stops here and nothing is verified. ` +
                  `The operator must decide whether to change the approach, fix the verifier or accept the current state; do not claim completion.`,
              };
            }
            const hints = formatDiagnosticHints(testRes.diagnostics);
            const evidenceLine = describeAttemptEvidence(attemptEvidence(testRes.rawOutput || "", testRes.exitCode, { timedOut: testRes.timedOut, executorFailed: testRes.executorFailed }));
            const oracleFailContent = `Verification Oracle: The selected verifier did not pass.\nCommand: ${testRes.command}\n${evidenceLine ? `Evidence: ${evidenceLine}\n` : ""}${foldVoluminousOutput(testRes.rawOutput || "")}${hints}\nResolve the verification failure before calling task_completed.`;
            return {
              success: false,
              output: "",
              error: oracleFailContent,
            };
          }
          verifierSucceeded = true;
          if (this.activeWorktree && !configured) {
            console.log(
              pc.yellow(
                `Verification command '${testRes.command}' passed, but no authoritative verifier is configured; changes will remain in the worktree.`
              )
            );
          }
        }
      } catch (err: any) {
        return {
          success: false,
          output: "",
          error: `Verification Oracle could not verify this worktree: ${err?.message || "test discovery failed"}.`,
        };
      }
    }

    // The obligation is discharged only by a passing run of the selected verifier (never by command text).
    // Zero executed tests does not discharge the obligation.
    if (!noApplicableVerifier && hasExecuted && verifierSucceeded && isDeliverableBound && this.verificationEvidence?.definitionBound !== false) {
      // With the latch set, no generic verifier can authenticate the recovered workspace or its oracle.
      // A trusted pre-change baseline must be established by a fresh task or a future authenticated verifier.
      if (this.verificationBaselineInvalidated) this.verificationBaselineInvalidated = false;
      this.setUnverifiedChanges(false);
    }
    // A passing deliverable-bound run inside a named (linked) worktree is recorded for `nexus worktree merge`, which
    // needs a verification for the exact state it merges. Recording never affects the task outcome. Recording runs
    // host-side Git in the worktree, so its `.git` pointer is verified first (the agent could have rewritten it).
    const recordableWorktree = this.isRecordableWorktree();
    // A validation receipt must identify the actual verifier output. If the digest is missing or malformed, retain the
    // worktree without issuing a receipt; a status/command pair alone cannot bind the evidence to a verifier run.
    const verifierOutputHash = this.verificationEvidence?.outputSha256;
    const isVerified = sha256Digest(verifierOutputHash) && this.verificationEvidence?.definitionBound !== false &&
      (this.verificationEvidence?.source === "configured" || this.verificationEvidence?.independent === true);
    const boundVerifierDefinitionSha256 = verifierDefinitionSha256(this.changeBaseline?.verifier);
    recordVerificationIfEligible(this.config.workspace, {
      unrecordableWorktree: !recordableWorktree || this.receiptBaselineUntrusted,
      dryRun: Boolean(this.config.dryRun),
      verifierSucceeded,
      hasExecuted,
      deliverableBound: isDeliverableBound,
      verified: isVerified,
      verifier: this.verificationEvidence?.command || this.config.authoritativeVerifierCommand?.trim() || "verifier",
      before: verificationStateBefore,
    });
    // Files a passing run covered are verified; ones it did not cover stay for a later run to cover.
    if (verifierSucceeded && hasExecuted && this.verificationEvidence?.isDeliverableBound && this.verificationEvidence.definitionBound !== false) {
      this.modifiedFiles.clear();
      this.changeBaseline = undefined;
    }
    if (this.activeWorktree) {
      const canValidate =
        verifierSucceeded &&
        isVerified &&
        this.config.authoritativeVerifierCommand?.trim() &&
        !this.config.dryRun &&
        !this.isReadOnly();

      if (canValidate && sha256Digest(verifierOutputHash)) {
        try {
          const candidateWorkspace = this.activeWorktree.worktreePath;
          const candidateIdentity = this.candidateTracker.computeCandidateIdentitySync(candidateWorkspace);
          const verifierCommand = this.config.authoritativeVerifierCommand?.trim() || "authoritative_verifier";
          const effectivePolicy = this.bridge.getSecurityManager().getEffectivePolicy();
          const buildIdentity = getBuildIdentity();
          const acceptancePolicySha256 = canonicalSha256({
            schemaVersion: 1,
            effectivePolicy,
            approvalMode: this.config.approvalMode ?? "review",
            fullAccess: Boolean(this.config.fullAccess),
            readOnly: this.isReadOnly(),
            sandbox: this.config.sandbox ?? false,
            trustedDeliverableFiles: [...(this.config.trustedDeliverableFiles ?? [])].sort(),
            verifierCommand,
            verifierDefinitionSha256: boundVerifierDefinitionSha256,
          });
          const receipt = this.candidateTracker.recordValidationReceipt({
            candidateId: candidateIdentity.candidateId,
            verifierCommand,
            exitCode: 0,
            stdoutHash: verifierOutputHash,
            status: "PASSED",
            evaluatorBinding: {
              evaluatorId: "authoritative_verifier",
              evaluatorType: "runTestSuiteWithExecutor",
              testSuite: this.config.authoritativeVerifierCommand?.trim(),
            },
            materialDependencies: collectMaterialDependencies(candidateWorkspace),
            evidence: {
              acceptanceIdentity: {
                schemaVersion: 1,
                sourceRevision: candidateIdentity.rootBaseSha,
                candidateDigest: candidateIdentity.manifestHash,
                candidateId: candidateIdentity.candidateId,
                verifierCommand,
                verifierExitCode: 0,
                verifierDefinitionSha256: boundVerifierDefinitionSha256,
                runtime: {
                  nexusBuild: buildIdentity,
                  nodeVersion: process.version,
                  platform: process.platform,
                  architecture: process.arch,
                },
                acceptancePolicySha256,
                independentApproval: "unavailable_single_maintainer",
              },
            },
          });
          this.activeValidationReceipt = receipt;
          try {
            if (!this.durable || !this.stateManager || !this.currentTaskId) {
              throw new Error("durable task state is unavailable");
            }
            this.stateManager.recordCandidateAndReceipt(this.currentTaskId, {
              candidateId: candidateIdentity.candidateId,
              candidateIdentity,
              receipt,
            });
            this.verifiedWorktreeCompletion = true;
          } catch (err: any) {
            this.verifiedWorktreeCompletion = false;
            this.acceptancePersistenceFailure = "Candidate validation receipt could not be durably persisted; verified acceptance is blocked.";
            this.candidateTracker.invalidateReceipts(
              "Candidate validation receipt was not durably persisted.",
              [candidateWorkspace],
              candidateWorkspace,
            );
            this.activeValidationReceipt = undefined;
            this.reportPersistenceFailure("candidate_receipt", err);
          }
        } catch {
          this.verifiedWorktreeCompletion = false;
        }
      } else {
        this.verifiedWorktreeCompletion = !worktreeHasChanges;
      }
    }
    // DV-3: after the verifier above has had its chance to replay, an operator-authorised obligation still unmet blocks completion.
    if (this.objective && (this.depth === 0 || this.role === "implementer" || this.role === "tester")) {
      const unmet = unmetObligationsMessage(this.objective);
      if (unmet) return { success: false, output: "", error: unmet };
    }
    this.completionSummary = { summary: args.summary || "Task completed.", notes: args.notes };
    return {
      success: true,
      output: JSON.stringify({
        status: "completed",
        summary: args.summary || "Task completed.",
        notes: args.notes || "",
        verification: noApplicableVerifier ? "NO_APPLICABLE_VERIFIER" : verifierSucceeded ? "PASSED" : "NOT_REQUIRED",
      }),
    };
  });

  this.spine.registerHandler("spawn_subagent", async (args: any, context: any) => {
    let limits;
    try { limits = delegationRuntimeLimits(); }
    catch (error: any) { return { success: false, output: "", error: `Delegation configuration is invalid: ${error.message}` }; }
    if (this.depth >= limits.maxDepth || context.metadata?.actor === "subagent") {
      return {
        success: false,
        output: "",
        error:
          "Error: Subagent depth limit reached. Solve the task directly without spawning additional subagents.",
      };
    }

    if (++this.delegatedChildrenStarted > limits.maxChildrenPerParent) {
      return { success: false, output: "", error: `Subagent not started: this parent reached its limit of ${limits.maxChildrenPerParent} delegated children.` };
    }

    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => !["prompt", "profile", "inputs", "max_steps"].includes(key))) {
      return { success: false, output: "", error: "Invalid delegation request. Only prompt, profile, inputs, and the ignored legacy max_steps field are accepted." };
    }
    const profile = args.profile === undefined ? "semantic_explorer" : args.profile;
    if (typeof profile !== "string" || !Object.hasOwn(ROLE_PROFILES, profile)) {
      return { success: false, output: "", error: "Invalid delegation profile." };
    }
    let requestedInputs: Record<string, string> = args.inputs === undefined ? {} : args.inputs;
    const inputsProblem = specialistInputsProblem(requestedInputs);
    if (inputsProblem) {
      return { success: false, output: "", error: `Invalid delegation inputs: ${inputsProblem}.` };
    }

    // A helper's agent builds its own clients from this config, so its first request would reach the provider a
    // resumed turn is still waiting out. Declined for now; the model can go on without it or ask again later.
    if (this.helperWindowOpen()) {
      return {
        success: false,
        output: "",
        error: `Subagent not started: ${RESUMED_WINDOW_REASON}. Continue without it, or start it in a later step.`,
      };
    }

    if (typeof args.prompt !== "string" || args.prompt.length > 8_000 || Object.values(requestedInputs).some((value) => (value as string).length > 2_000)) {
      return { success: false, output: "", error: "Delegation prompt or inputs exceed the bounded request size." };
    }
    const prompt = args.prompt.trim() || "Investigate the task";
    if (args.inputs === undefined && profile === "semantic_explorer") {
      requestedInputs = { target_query: prompt, focus_directories: "." };
    }
    if (isSpecialistRole(profile)) {
      const missing = missingSpecialistInputs(profile, requestedInputs);
      if (missing.length) return { success: false, output: "", error: `Profile '${profile}' requires inputs: ${missing.join(", ")}.` };
    }
    const subPrompt = `${prompt}${Object.keys(requestedInputs).length ? `\n\nAuthorized inputs:\n${Object.entries(requestedInputs).map(([key, value]) => `- ${key}: ${value}`).join("\n")}` : ""}`;
    // No step allowance: a helper stops on its report, on demonstrated lack of progress, or with the parent's turn
    // (cancellation). A `max_steps` argument from the model is not an operator limit and is ignored.
    const inheritedWorktreeScope = this.activeWorktree
      ? { workspace: this.activeWorktree.worktreePath, requireSandbox: true as const }
      : undefined;
    if (!isReadOnlyRole(profile) && !this.activeWorktree) {
      return { success: false, output: "", error: `Subagent not started: writable profile '${profile}' requires an established isolated worktree.` };
    }
    const profileTools = roleToolAllowList(profile) ?? new Set(ROLE_PROFILES[profile as AgentRole].recommendedTools);
    const parentTools = new Set(this.getEffectiveTools().map((tool: any) => tool.function.name));
    const parentGrants = this.authorityEngine.getGrants();
    const hasExplicitParentGrants = parentGrants.length > 0;
    const parentCapabilityAllowed = (name: string) => {
      if (!hasExplicitParentGrants) return true;
      const capabilityId = this.capabilityRegistry.getByToolName(name)?.id;
      return Boolean(capabilityId && parentGrants.some((grant: any) => {
        const actors = grant.actor === undefined ? ["*"] : Array.isArray(grant.actor) ? grant.actor : [grant.actor];
        const domains = grant.executionDomain === undefined ? ["*"] : Array.isArray(grant.executionDomain) ? grant.executionDomain : [grant.executionDomain];
        return (actors.includes("*") || actors.includes("agent")) &&
          (domains.includes("*") || domains.includes("agent_orchestration")) &&
          (grant.capabilities.includes("*") || grant.capabilities.includes(capabilityId) || grant.capabilities.includes(name));
      }));
    };
    const delegatedToolAllowList = [...profileTools].filter((name) => parentTools.has(name) && parentCapabilityAllowed(name));
    const permittedCapabilities = delegatedToolAllowList.map((name) => this.capabilityRegistry.getByToolName(name)?.id).filter(Boolean);
    const delegatedCapabilitySet = new Set(permittedCapabilities as string[]);
    const delegatedAuthorityGrants = hasExplicitParentGrants
      ? parentGrants.flatMap((grant: any) => {
          const actors = grant.actor === undefined ? ["*"] : Array.isArray(grant.actor) ? grant.actor : [grant.actor];
          const domains = grant.executionDomain === undefined ? ["*"] : Array.isArray(grant.executionDomain) ? grant.executionDomain : [grant.executionDomain];
          const capabilities = [...delegatedCapabilitySet].filter((capability) => grant.capabilities.includes("*") || grant.capabilities.includes(capability) ||
            delegatedToolAllowList.some((name) => this.capabilityRegistry.getByToolName(name)?.id === capability && grant.capabilities.includes(name)));
          if (!capabilities.length || !(actors.includes("*") || actors.includes("agent")) || !(domains.includes("*") || domains.includes("agent_orchestration"))) return [];
          return [{
            ...grant,
            actor: ["subagent"],
            executionDomain: ["subagent"],
            capabilities,
            scope: grant.scope === "full_access" ? "workspace" : grant.scope,
            readOnly: Boolean(grant.readOnly || this.isReadOnly() || isReadOnlyRole(profile)),
          }];
        })
      : undefined;
    if (hasExplicitParentGrants && delegatedAuthorityGrants!.length === 0) {
      delegatedAuthorityGrants!.push({ actor: ["subagent"], executionDomain: ["subagent"], capabilities: [], scope: "exact", resources: [] });
    }
    try {
      resolveDelegationContract({
        id: randomUUID(),
        parentId: this.currentTaskId || "interactive-turn",
        objective: prompt,
        profile,
        inputs: requestedInputs,
        authorizedScope: ["*"],
        permittedCapabilities: permittedCapabilities as string[],
        executionMode: "transient",
        requiresVerification: !isReadOnlyRole(profile),
        requiresIndependentReview: false,
      }, ["parent", "profile", "task", "session", "workspace"].map((source) => ({
        source: source as "parent" | "profile" | "task" | "session" | "workspace",
        authorizedScope: ["*"],
        permittedCapabilities: permittedCapabilities as string[],
      })));
    } catch (error: any) {
      return { success: false, output: "", error: `Subagent authority could not be resolved: ${error.message}` };
    }
    const subagentConfig: HarnessConfig = {
      ...this.config,
      role: undefined,
      fullAccess: false,
      readOnly: this.isReadOnly() || isReadOnlyRole(profile),
      approvalMode: this.isReadOnly() || isReadOnlyRole(profile) ? "read-only" : this.config.approvalMode,
      taskClass: "subagent",
      plannerTaskClass: "subagent",
      ...(inheritedWorktreeScope
        ? {
            workspace: inheritedWorktreeScope.workspace,
            sandbox: this.bridgeSandboxSetting() || "auto",
          }
        : {}),
    };

    const releaseDelegationSlot = acquireTransientDelegationSlot(limits.maxActiveChildren);
    if (!releaseDelegationSlot) return { success: false, output: "", error: "Subagent not started: the active delegated-child limit is full." };
    if (!this.delegatedBudget) this.delegatedBudget = { maxInferenceSteps: limits.maxInferenceSteps, steps: 0 };
    else this.delegatedBudget.maxInferenceSteps = Math.min(this.delegatedBudget.maxInferenceSteps, limits.maxInferenceSteps);
    const parentSignal: AbortSignal | undefined = this.activeTurn?.controller.signal;
    const delegatedController = new AbortController();
    const abortForParent = () => delegatedController.abort(parentSignal?.reason);
    if (parentSignal?.aborted) abortForParent();
    else parentSignal?.addEventListener("abort", abortForParent, { once: true });
    let timedOut = false;
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      delegatedController.abort(new Error("delegated execution deadline exceeded"));
    }, limits.maxDurationMs);
    deadlineTimer.unref?.();

    this.ui.startSpinner(`Spawning isolated subagent: "${subPrompt.slice(0, 45)}..."`);
    let subagent: any;
    const delegatedStartedAt = Date.now();
    try {
      subagent = new (this.constructor as any)(
        subagentConfig,
        this.depth + 1,
        inheritedWorktreeScope,
        { durable: false, role: profile as AgentRole, delegatedToolAllowList, delegatedAuthorityGrants, delegatedBudget: this.delegatedBudget }
      );
      subagent.inheritObjectiveBudget(this);
      subagent.inheritTraceContext(this);
      subagent.setOperatorAnswers(this.operatorAnswers);
      const subResult = await subagent.runSubagent(subPrompt, this.activeTurn?.onConfirm, delegatedController.signal);
      this.ui.stopSpinner(subResult.completed);
      if (subResult.needsInput?.length) this.acceptSubagentQuestions(subResult.needsInput);
      console.log(pc.cyan(`\n🤖 [Subagent Report Received]\n`));
      const stats = subagent.getTokenStats();
      const outcome = createDelegationOutcome({
        id: randomUUID(),
        parentId: this.currentTaskId || "interactive-turn",
        status: subResult.completed ? "COMPLETED" : timedOut ? "INTERRUPTED" : parentSignal?.aborted ? "CANCELLED" : subagent.turnMutations > 0 ? "UNKNOWN_EFFECT" : "FAILED",
        summary: (subResult.summary || subResult.reason || "Subagent returned no report.").slice(0, 8_000),
        evidence: [],
        uncertainty: subagent.turnMutations > 0 && !subResult.completed ? ["The child made workspace changes but did not complete; effect status requires reconciliation."] : [],
        resourceUsage: { inferenceRequests: stats.requests, toolCalls: Object.values(subagent.turnToolCallSyntax || {}).reduce((sum: number, value: any) => sum + Number(value || 0), 0), elapsedMs: Date.now() - delegatedStartedAt,
          inputTokens: { value: stats.prompt, source: stats.reportedRequests === stats.requests ? "reported" : "estimated" },
          outputTokens: { value: stats.completion, source: stats.reportedRequests === stats.requests ? "reported" : "estimated" } },
        outstandingObligations: subResult.completed ? [] : [subResult.reason || "Subagent completion was not established."],
      });
      if (!subResult.completed) {
        return { success: false, output: JSON.stringify(outcome), error: `Subagent did not complete: ${subResult.reason}` };
      }
      return {
        success: true,
        output: JSON.stringify(outcome),
      };
    } catch (subErr: any) {
      this.ui.stopSpinner(false);
      return {
        success: false,
        output: "",
        error: `Subagent failed with error: ${subErr.message}`,
      };
    } finally {
      clearTimeout(deadlineTimer);
      parentSignal?.removeEventListener("abort", abortForParent);
      releaseDelegationSlot();
      if (subagent) {
        const subStats = subagent.getTokenStats();
        this.totalTokens.prompt += subStats.prompt;
        this.totalTokens.completion += subStats.completion;
        this.totalTokens.total += subStats.total;
        this.totalTokens.requests += subStats.requests;
        this.totalTokens.reportedRequests += subStats.reportedRequests;
        this.totalTokens.estimatedRequests += subStats.estimatedRequests;
        // The subagent's tool calls are model output of this turn: count their syntax with the parent's.
        this.addToolCallSyntax(subagent.turnToolCallSyntax);

        // The child's workspace changes are this turn's changes: the parent's own completion must verify them.
        const childMutations = subagent.turnMutations;
        if (childMutations > 0 || subagent.turnCarriedChanges) {
          this.mutationSeq += subagent.mutationSeq;
          this.turnMutations += childMutations;
          this.turnFileWrites += subagent.turnFileWrites;
          this.turnBackgroundCommands += subagent.turnBackgroundCommands;
          this.verificationEvidence = undefined;
          if (this.objective) {
            invalidateVerified(this.objective, `subagent changed workspace`);
          }
          this.setUnverifiedChanges(true);
        }
        subagent.shutdown();
      }
    }
  });

  this.spine.registerHandler("hybrid_search", async (args: any) => {
    try {
      const matches = await this.hybridSearch.search(args.query || "", {
        mode: args.mode,
        path: args.path,
        limit: args.limit ? parseInt(args.limit, 10) : 10,
      });
      return {
        success: true,
        output: JSON.stringify(
          { query: args.query, totalMatches: matches.length, matches },
          null,
          2
        ),
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  });

  this.spine.registerHandler("browser_navigate", async (args: any) => {
    try {
      const nav = await this.browser.navigate(args.url || "");
      return { success: true, output: JSON.stringify(nav, null, 2) };
    } catch (err: any) {
      return {
        success: false,
        output: "",
        error: `Error executing browser_navigate: ${err.message}`,
      };
    }
  });

  this.spine.registerHandler("browser_screenshot", async (args: any) => {
    try {
      const shot = await this.browser.screenshot(args.output_path);
      return {
        success: true,
        output: JSON.stringify(
          { path: shot.path, width: shot.width, height: shot.height },
          null,
          2
        ),
      };
    } catch (err: any) {
      return {
        success: false,
        output: "",
        error: `Error executing browser_screenshot: ${err.message}`,
      };
    }
  });

  this.spine.registerHandler("browser_click", async (args: any) => {
    try {
      const clickRes = await this.browser.click(args.selector || "");
      return {
        success: clickRes.success,
        output: JSON.stringify(clickRes, null, 2),
        error: clickRes.success ? undefined : clickRes.message,
      };
    } catch (err: any) {
      return {
        success: false,
        output: "",
        error: `Error executing browser_click: ${err.message}`,
      };
    }
  });

  this.spine.registerHandler("browser_type", async (args: any) => {
    try {
      const typeRes = await this.browser.type(args.selector || "", args.text || "");
      return {
        success: typeRes.success,
        output: JSON.stringify(typeRes, null, 2),
        error: typeRes.success ? undefined : typeRes.message,
      };
    } catch (err: any) {
      return {
        success: false,
        output: "",
        error: `Error executing browser_type: ${err.message}`,
      };
    }
  });

  this.spine.registerHandler("browser_console_logs", async (args: any) => {
    try {
      const logs = this.browser.getConsoleLogs(args.limit ? parseInt(args.limit, 10) : 50);
      return {
        success: true,
        output: JSON.stringify({ totalLogs: logs.length, logs }, null, 2),
      };
    } catch (err: any) {
      return {
        success: false,
        output: "",
        error: `Error executing browser_console_logs: ${err.message}`,
      };
    }
  });

  this.spine.registerHandler("manage_knowledge", async (args: any) => {
    try {
      let output = "";
      const action = args.action || "list";
      if (action === "set") {
        const entry = this.knowledge.set(
          args.key || "custom-rule",
          args.value || "",
          args.category || "rule"
        );
        output = JSON.stringify({ status: "saved", entry }, null, 2);
      } else if (action === "get") {
        const entry = this.knowledge.get(args.key || "");
        output = JSON.stringify({ found: Boolean(entry), entry }, null, 2);
      } else if (action === "delete") {
        const deleted = this.knowledge.delete(args.key || "");
        output = JSON.stringify(
          { status: deleted ? "deleted" : "not_found", key: args.key },
          null,
          2
        );
      } else if (action === "query") {
        const entries = this.knowledge.query(args.key || args.value, args.category);
        output = JSON.stringify({ total: entries.length, entries }, null, 2);
      } else {
        const entries = this.knowledge.list();
        output = JSON.stringify({ total: entries.length, entries }, null, 2);
      }
      return { success: true, output };
    } catch (err: any) {
      return {
        success: false,
        output: "",
        error: `Error executing manage_knowledge: ${err.message}`,
      };
    }
  });

  this.spine.registerHandler("activate_skill", async (args: any) => {
    const skillName = args.name;
    const skill = this.skillManager.getSkill(skillName);
    if (!skill) {
      const untrusted = this.skillManager.getUntrustedSkill(skillName);
      if (untrusted) {
        return {
          success: false,
          output: "",
          error: `Error: Skill '${oneLine(String(skillName ?? "").slice(0, 200))}' is in an untrusted workspace and cannot be activated. Run 'nexus trust .' to trust this workspace.`,
        };
      }
      // No skill has that name: treat the text as a search. Matching advertises descriptions and activates nothing.
      const matches = this.skillManager.findSkills(String(skillName ?? ""), MAX_SKILL_MATCHES);
      if (!matches.length) {
        return { success: true, output: `No installed skill matches '${oneLine(String(skillName ?? "").slice(0, 200))}'. Nothing was activated; try other words describing the task.` };
      }
      return {
        success: true,
        output: `No skill is named '${oneLine(String(skillName))}'. Nothing was activated. Installed skills that match those words; call activate_skill again with an exact name to load one:\n${matches.map((s: any) => `- **${oneLine(s.name)}**: ${oneLine(s.description)}`).join("\n")}`,
      };
    }
    // WP-GS-01/02/05/06: activation identity + digest; revocation; optional qualification gate.
    const { parseSkillConstraints, skillContentDigest } = await import("./skill_activation.js");
    const { isSkillRevoked, recordSkillActivationLifecycle } = await import("./skills_lifecycle.js");
    const {
      skillRequireQualificationEnabled,
      isSkillQualified,
      invalidateQualificationIfDigestChanged,
    } = await import("./skills_qualification.js");
    if (isSkillRevoked(skill.name)) {
      return {
        success: false,
        output: "",
        error: `Error: Skill '${oneLine(skill.name)}' is revoked in the local skill lifecycle index. Clear the revoke entry under NEXUS_STATE_DIR/skills/index.json to re-enable.`,
      };
    }
    const digest = skillContentDigest(skill.content);
    invalidateQualificationIfDigestChanged(skill.name, digest);
    if (skillRequireQualificationEnabled() && !isSkillQualified(skill.name, digest)) {
      return {
        success: false,
        output: "",
        error: `Error: Skill '${oneLine(skill.name)}' is not qualified for digest ${digest.slice(0, 12)}…. Run \`nexus skills qualify ${skill.name}\` (or unset NEXUS_SKILL_REQUIRE_QUALIFICATION).`,
      };
    }
    const activation = this.skillActivations.activate({
      skillName: skill.name,
      sourcePath: skill.path,
      sourceClass: skill.isWorkspaceSkill ? "workspace" : "global",
      content: skill.content,
      taskId: this.currentTaskId || this.activeWorktree?.taskId || "task-default",
      constraints: parseSkillConstraints({
        allowedCapabilities: skill.allowedCapabilities,
        deniedCapabilities: skill.deniedCapabilities,
      }),
    });
    try {
      recordSkillActivationLifecycle({
        name: skill.name,
        contentDigest: activation.contentDigest,
        sourcePath: skill.path,
      });
    } catch {
      // Best-effort index write; activation still succeeds.
    }
    console.log(pc.green(`✔ Activated skill: ${pc.bold(skill.name)}`));
    return {
      success: true,
      output:
        `[Activated Skill: ${skill.name}] [source: ${oneLine(skill.path)}] [trust: ${skill.trusted ? "trusted" : "untrusted"}]` +
        ` [activation: ${activation.activationId}] [digest: ${activation.contentDigest}]\n` +
        `[Host application: Nexus Code. Provider/model identity does not change the host; select host-specific instructions for Nexus Code.]\n\n` +
        `${skill.content}`,
    };
  });

  this.spine.registerHandler("read_objective", async (args: any) => {
    if (!this.objective) return { success: false, output: "", error: "No operator objective is being tracked in this conversation." };
    const result = readObjective(this.objective, args ?? {});
    return result.ok ? { success: true, output: result.text } : { success: false, output: "", error: result.text };
  });

  this.spine.registerHandler("enable_tools", async (args: any) => {
    const asked: unknown[] = Array.isArray(args?.groups) ? args.groups : [];
    const known = asked.filter((g): g is string => typeof g === "string" && g in TOOL_GROUPS);
    if (!known.length) return { success: false, output: "", error: `enable_tools: name one or more of: ${Object.keys(TOOL_GROUPS).join(", ")}.` };
    for (const group of known) this.enabledToolGroups.add(group);
    return { success: true, output: `Enabled ${known.join(", ")}: ${known.flatMap((g) => TOOL_GROUPS[g].tools).join(", ")} available from your next step.` };
  });

  this.spine.registerHandler("read_archive", async (args: any) => {
    // CX-4: "tool-output:<id>" names a masked tool result; it resolves to the full output (live conversation, then archive).
    const masked = typeof args?.query === "string" ? resolveMaskedOutput(args.query, this.messages, this.archiveForReading) : undefined;
    if (masked !== undefined) return { success: true, output: masked };
    const result = readArchive(this.archiveForReading, args ?? {});
    return result.ok ? { success: true, output: result.text } : { success: false, output: "", error: result.text };
  });

  this.spine.registerHandler("read_tool_output", async (args: any) => {
    const result = readToolOutput(args?.id, this.messages, this.archiveForReading);
    return result.ok ? { success: true, output: result.text } : { success: false, output: "", error: result.text };
  });

  this.spine.registerHandler("read_findings", async (args: any) => {
    const result = readFindings(this.findingNotes, args ?? {});
    return result.ok ? { success: true, output: result.text } : { success: false, output: "", error: result.text };
  });

  this.spine.registerHandler("update_requirements", async (args: any) => {
    if (!this.objective) {
      return { success: false, output: "", error: "No operator objective is being tracked in this conversation." };
    }
    const updates: RequirementUpdate[] = Array.isArray(args?.requirements) ? args.requirements : [];
    const wantsVerified = updates.some((u) => u?.status === "verified");
    const ledger = this.objective;
    const refused: string[] = [];
    if (wantsVerified) {
      const claimed = updates.flatMap((u) => ledger.requirements.filter((r: any) => u?.status === "verified" && r.id === u.id && isHardRequirement(r) && r.verifier));
      for (const r of claimed) {
        const reason = await this.runRequirementVerifier(r, r.verifier!);
        if (reason) refused.push(reason);
      }
    }
    const state = wantsVerified ? this.verifierState() : undefined;
    const result = applyRequirementUpdates(
      ledger,
      updates,
      typeof args?.next_action === "string" ? args.next_action : undefined,
      undefined,
      wantsVerified ? this.currentPassingAttempt() : undefined,
      (command, id) => (state ? priorAttempt(ledger, command, state, id) : undefined),
    );
    result.errors.push(...refused);
    result.ok = result.ok && refused.length === 0;
    if (result.changed) {
      try {
        this.checkpointDurableState("requirements updated");
      } catch (err: any) {
        this.reportPersistenceFailure("requirements", err);
      }
    }
    const states = gatingRequirements(this.objective).map((r) => `${r.id}:${r.status}`);
    return {
      success: result.ok,
      output: JSON.stringify({ status: result.ok ? "requirements_updated" : "partially_applied", requirements: states, open: openRequirements(this.objective).map((r) => r.id) }),
      ...(result.ok ? {} : { error: `Some updates were rejected:\n- ${result.errors.join("\n- ")}\nRequirement states now: ${states.join(", ")}` }),
    };
  });

  this.spine.registerHandler("update_plan", async (args: any) => {
    const phases = Array.isArray(args.phases) ? args.phases : [];
    this.activePlan = phases;
    this.ui.renderPlan(this.activePlan);
    if (this.durable && this.stateManager && this.currentTaskId) {
      try {
        this.checkpointDurableState();
        for (let i = 0; i < phases.length; i++) {
          if (phases[i].status === "completed") {
            this.stateManager.recordMilestone(this.currentTaskId, {
              name: phases[i].name,
              phaseIndex: i,
              evidenceSummary: phases[i].detail,
              candidateId: this.activeValidationReceipt?.candidateId,
            });
          }
        }
      } catch (err: any) {
        this.reportPersistenceFailure("plan", err);
      }
    }
    return {
      success: true,
      output: JSON.stringify({
        status: "plan_updated",
        total_phases: this.activePlan.length,
        completed: this.activePlan.filter((p: any) => p.status === "completed").length,
        in_progress: this.activePlan.filter((p: any) => p.status === "in_progress").length,
      }),
    };
  });
}

