import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ChatMessage, ToolCall } from "../types.js";
import { ExecutionSpine, ExecutionReceipt } from "./spine.js";
import { ExecutionTracker, REPEAT_THRESHOLD, actionKind, backoffMs, type ObservationVerdict } from "./execution_tracking.js";
import { fileSignature, readCoverage, readRequests } from "./observation_identity.js";
import { redactSecrets, safeTerminal } from "../ui.js";
import { getGitInfo } from "../git.js";
import { extractCompilerDiagnostics, formatDiagnosticHints } from "../diagnostics.js";
import { calculateContextBudget, countTokens } from "../tokens.js";
import { discoverVerifier } from "../tester.js";
import { groupsTriggeredBy } from "./tool_groups.js";
import { snapshotTests } from "./independent_check.js";
import { InferenceError } from "../client.js";
import { TurnResult, InterruptionRecord, InferenceFailure, CapacityRecord, ModelStop, ProviderRecoveryRecord, assertTurnResultInvariants, deepFreezeTurn, summarizeTurn } from "./turn.js";
import { withDurableSync } from "./durable_file.js";
import { ProviderRecoveryController, RecoveryCancelled, recoveryPolicyFromEnv } from "./provider_recovery.js";
import { amendObjective, blockedRequirements, carryUnresolvedConflicts, createLedger, gatingRequirements, isNewObjective, openRequirements, supersededBy, trackingOf } from "./objective.js";
import { snapshot } from "../file_diff.js";
import { buildBlockedRequirementQuestion, buildSteeringConflictQuestion } from "./needs_input.js";
import { safeOperatorText } from "../protocol.js";
import { TurnEvidence, TurnReason } from "./turn.js";
import { DEFAULT_REPEATED_CALL_HARD, DEFAULT_REPEATED_CALL_SOFT, judgeRepeatedCalls, makeCallRecord, pushCall, repeatedCallHistory, type CallClass, type CallRecord } from "./repeated_calls.js";
import pc from "picocolors";
import { ConfirmHandler, CompactionCommitError, ContextBudgetError, LedgerNotRetainedError, observationKey, recoveryDenialMessage, notExecutedMessage, observationPresence, unreacquiredRemovals, STEP_NOTICE, CUT_NOTICE, truncatedReplyNotice, harnessNoteMessage, READ_ONLY_TOOLS, foldVoluminousOutput, stepPosition, triggerNotification } from "./agent_support.js";
import type { AutonomousAgent } from "../agent.js";

export async function runTurnImpl(this: any, taskPrompt: string | any[], onConfirm?: ConfirmHandler, options?: { signal?: AbortSignal; resume?: boolean; tddRed?: boolean; step?: boolean }): Promise<TurnResult> {
  // The REPL calls runTurn directly. Route worktree-enabled turns through the
  // same establishment and resolution boundary as one-shot `run` tasks. A retained
  // named worktree is where the session keeps working; `run` reuses it.
  if (this.config.worktree && this.activeWorktree && this.activeWorktree.kind !== "named" && !this.worktreeRunTurnAuthorized) {
    throw new Error(`Cannot start a new task: unresolved worktree ${this.activeWorktree.taskId}; merge or discard it first.`);
  }
  if (this.config.worktree && !this.worktreeRunTurnAuthorized) {
    return await this.run(taskPrompt, onConfirm, options);
  }
  if (!this.config.worktree) this.assertNamedBindingCurrent();
  if (this.activeTurn) throw new Error("A turn is already active; wait for it to finish or cancel it.");
  const authoritativeVerifier = this.config.authoritativeVerifierCommand?.trim();
  if (authoritativeVerifier && this.changeBaseline === undefined) {
    // Capture workspace-resolved operator verifier files before plugins or the model can change them.
    // Existing pending work without an earlier snapshot remains unverified rather than being blessed retroactively.
    // A linked worktree the agent already worked in (an earlier session, another terminal) gives a baseline taken from
    // files the agent may have rewritten: verification proceeds as usual, but no receipt is issued on that baseline.
    this.judgeReceiptBaselineOnce();
    this.changeBaseline = {
      command: authoritativeVerifier,
      failed: false,
      tests: this.hasPendingModifications ? null : snapshotTests(this.config.workspace),
      ...(this.hasPendingModifications ? { verifier: null } : this.verifierDefinitionAtCapture(authoritativeVerifier, this.config.trustedDeliverableFiles ?? [])),
      trustedDeliverables: [...(this.config.trustedDeliverableFiles ?? [])],
      at: new Date().toISOString(),
    };
    if (this.durable) {
      try {
        this.checkpointDurableState("authoritative verifier definition captured");
      } catch (err: any) {
        this.reportPersistenceFailure("baseline", err);
      }
    }
  }
  await this.initExtensibility();
  const promptText = typeof taskPrompt === "string" ? taskPrompt : "[Multi-modal Vision Input]";
  for (const group of groupsTriggeredBy(promptText)) this.enabledToolGroups.add(group);
  await this.pluginManager.notifyTurnStart(promptText, this.config.workspace);

  const turn: NonNullable<AutonomousAgent["activeTurn"]> = {
    controller: new AbortController(),
    phase: "idle",
    step: 0,
    onConfirm,
    tddRed: options?.tddRed === true,
  };
  this.activeTurn = turn;
  const signal = turn.controller.signal;
  this.bridge.setTurnSignal(signal);
  if (options?.signal) {
    if (options.signal.aborted) this.requestCancel("external signal");
    else options.signal.addEventListener("abort", () => this.requestCancel("external signal"), { once: true });
  }
  this.completionSummary = undefined;
  this.turnPersistenceFailures = this.initialStatePersistenceFailure ? [this.initialStatePersistenceFailure] : [];
  this.objectiveBudgetPersistenceFailure = undefined;
  this.turnMutations = 0;
  this.turnToolCallSyntax = { native: 0, trailing: 0, structural: 0, invalid: 0, schema: 0 };
  this.turnConfiguredVerifier = "NOT_RUN";
  this.turnConvergence = undefined;
  this.turnConvergenceUpTo = undefined;
  this.turnRepeatedCall = undefined;
  this.pendingNeedsInput = undefined;
  this.furtherNeedsInput = [];
  this.turnCarriedChanges = this.hasPendingModifications;
  this.turnDenials = 0;
  this.turnFileWrites = 0;
  this.turnBackgroundCommands = 0;
  this.turnLatchLifted = false;
  this.turnVerifierRuns = [];
  this.turnStartState = undefined;
  // What compaction removed earlier in this conversation is still not in context, whichever way the turn began.
  this.turnRemovedObservations = new Set([...this.carriedRemovedObservations, ...unreacquiredRemovals(this.messages)]);
  this.findingsOutgrown = false;
  this.stepNoticeStep = 0;
  this.cutResponse = undefined;
  // Step notices speak for the turn that issued them; this turn has its own step budget.
  for (const message of this.messages) {
    if (message.role === "tool" && typeof message.content === "string") message.content = message.content.replace(CUT_NOTICE, "").replace(STEP_NOTICE, "");
  }
  this.carriedRemovedObservations = new Set();
  // The objective this turn works toward: a new one, or a short follow-up on the one still unresolved.
  const priorLedger = this.objective ? structuredClone(this.objective) : undefined;
  let continuingObjective = false;
  const isResume = Boolean(options?.resume);
  const isStep = Boolean(options?.step ?? this.config.step);
  if (typeof taskPrompt === "string" && this.durable) {
    let ledger = this.objective;
    continuingObjective = Boolean(ledger && (isResume || isStep || !isNewObjective(ledger, taskPrompt)));
    if (!ledger || (!isResume && !isStep && isNewObjective(ledger, taskPrompt))) {
      const carried = ledger?.steering.filter((s: any) => s.status === "queued") ?? [];
      const orphaned = ledger ? supersededBy(ledger) : undefined;
      ledger = createLedger(taskPrompt, undefined, this.unitId);
      ledger.steering.push(...carried);
      const prior = this.objective?.superseded ?? [];
      if (prior.length || orphaned) ledger.superseded = [...prior, ...(orphaned ? [orphaned] : [])];
    } else {
      if (this.unitId && !ledger.unitId) {
        ledger.unitId = this.unitId;
      }
      const isHarnessResume = /^\[(?:Nexus|Work unit resumed)/.test(taskPrompt);
      if (!isHarnessResume && !isStep && taskPrompt.trim() !== "") {
        // The unfinished objective is kept; numbered items in the follow-up are added as further requirements.
        amendObjective(ledger, taskPrompt);
      }
    }
    ledger.outcome = undefined;
    ledger.continuation = { ...ledger.continuation, segments: 1, lastProgressStep: 0, stopReason: undefined };
    this.objective = ledger;
    // VC-9 row 7: a steering conflict an earlier turn left unresolved is decided here if the operator answered its
    // question; the others are carried, so only the turn that left a conflict unresolved reports it.
    carryUnresolvedConflicts(
      ledger,
      (conflict) => {
        const answer = this.operatorAnswers.get(buildSteeringConflictQuestion(conflict, safeOperatorText).id);
        return answer === undefined ? undefined : answer === "approve";
      },
      (text) => safeOperatorText(text),
    );
  }

  let currentStep = 1;
  let stepsUsed = 0;
  const providerRecoveries: ProviderRecoveryRecord[] = [];
  const budget = this.config.continuation;
  const segmentSteps = Math.max(1, this.config.maxSteps);
  const maxTotalSteps = budget ? budget.maxTotalSteps : segmentSteps;
  let segment = 1;
  const tracker = this.objective && this.durable ? trackingOf(this.objective) : ExecutionTracker.fresh();

  try {
    if (this.flightRecorder) {
      if (!this.flightRecorder.isSessionActive()) {
        this.flightRecorder.startSession({
          model: this.config.model,
          endpoint: this.config.endpoint,
          taskPrompt: promptText,
        });
      }
      this.flightRecorder.recordTurnStart(1, promptText);
    }

    // Dynamic runtime state injected into turn-level context without invalidating system prompt prefix cache
    const gitInfo = getGitInfo(this.config.workspace);
    let runtimeContext = "";
    if (gitInfo.isRepo) {
      runtimeContext += `\n[Git Status: ${gitInfo.branch} (${gitInfo.dirtyCount} uncommitted dirty files)]`;
    }
    if (this.activePlan && this.activePlan.length > 0) {
      runtimeContext += `\n[Active Plan: ${this.activePlan.map((p: any, i: any) => `${i + 1}. [${p.status}] ${p.name}`).join(" -> ")}]`;
    }

    const skipPromptSubmission =
      (isStep || isResume) &&
      typeof taskPrompt === "string" &&
      taskPrompt.trim() === "" &&
      (this.messages.length > 0 || continuingObjective);

    const effectiveUserContent = typeof taskPrompt === "string"
      ? (runtimeContext ? `${taskPrompt}\n${runtimeContext}` : taskPrompt)
      : taskPrompt;

    const historyBeforeSubmission = this.messages.length;
    if (!skipPromptSubmission) {
      this.messages.push({
        role: "user",
        content: effectiveUserContent,
      });
      // Skills whose descriptions fit this message, written once right after it and never moved: every later
      // request extends the earlier ones, so the provider's prefix cache survives each new prompt.
      const skillNote = this.skillNoteFor(taskPrompt);
      if (skillNote) this.messages.push({ role: "user", content: skillNote, harness: "skill-note" });
      // The objective is durable before anything acts on it.
      this.persistProgress({ messages: true });
    }
    const pendingMessageChars = typeof effectiveUserContent === "string" ? effectiveUserContent.length : JSON.stringify(effectiveUserContent).length;

    let capacityBlock: CapacityRecord | null = null;
    let modelStop: ModelStop = "NONE";
    let finalOutputComplete = false;
    let previousReplyEmpty = false;
    // The previous step's reply was cut off at the output limit; a second one in a row ends the turn.
    let previousReplyTruncated = false;
    let capacityRetryAttempted = false;
    let inferenceFailure: InferenceFailure | null = null;
    let interruption: InterruptionRecord | null = null;
    let undispatched = 0;
    let persistenceFailure: string | undefined;

    const markInterrupted = (phase: InterruptionRecord["phase"], extra: Partial<InterruptionRecord> = {}) => {
      interruption = {
        requestedAt: turn.cancelRequestedAt || new Date().toISOString(),
        phase,
        undispatchedToolCalls: undispatched,
        ...extra,
      };
    };
    const cancelledToolMessage = (call: ToolCall) => ({
      role: "tool" as const,
      tool_call_id: call.id,
      name: call.function.name,
      content: "Cancelled by operator before execution. No action was taken.",
    });

    // Continuation: `maxSteps` is a segment, a durable checkpoint. The total-step budget is objective-scoped and
    // survives resumes; the active invocation also has a finite wall-clock limit. Without continuation
    // (`--no-continuation`), the first segment boundary ends the turn (LIMIT_REACHED, legacy).
    const turnDeadline = budget && Number.isFinite(budget.maxTurnMinutes) ? Date.now() + budget.maxTurnMinutes * 60_000 : Number.POSITIVE_INFINITY;
    let stopReason: TurnReason | undefined;
    let stopDetail: string | undefined;
    let completionNudges = 0;
    // Recovery state (notes, stage, refusals) lives in the tracker: in the ledger when durable, so compaction cannot
    // remove it and resume restores it.
    const allowedDenials = budget ? Math.max(1, budget.maxRecoveries) : 0;
    this.stateIdentityDisabled = false;
    this.stateIdentityUncertainty = undefined;
    tracker.beginTurn();
    if (continuingObjective) {
      const isHarnessResume = typeof taskPrompt === "string" && /^\[(?:Nexus|Work unit resumed)/.test(taskPrompt);
      if (!isHarnessResume && !options?.resume && !isStep) {
        tracker.operatorInput(tracker.data.cumulativeSteps, `operator follow-up: ${promptText.slice(0, 160)}`);
      }
    }
    let stateNow = this.workspaceStateIdentity();
    this.turnStartState = stateNow;
    tracker.noteState(stateNow);
    tracker.noteLedgerState(this.ledgerProgressIdentity());
    const noticedPolls = new Set<string>();
    const noticedThrash = new Set<string>();
    let stateUnknownNoted = false;
    const callRing: CallRecord[] = [];
    let repeatedCallNote: string | undefined;
    let loopedCall: { name: string; count: number; arguments: string; history: NonNullable<TurnResult["repeatedCall"]>["history"] } | undefined;

    while (modelStop === "NONE" && !interruption && !inferenceFailure && !persistenceFailure) {
      const convergence = this.turnConvergence as TurnResult["convergence"];
      if (convergence && !stopReason) {
        stopReason = "VERIFIER_NOT_CONVERGING";
        stopDetail = convergence.evidence;
        if (this.objective && this.turnConvergenceUpTo !== undefined) this.objective.convergenceResetAfter = this.turnConvergenceUpTo;
      }
      if (stopReason) break;
      const taskStepLimitReached = budget
        ? tracker.data.cumulativeSteps >= maxTotalSteps
        : currentStep > maxTotalSteps;
      if (taskStepLimitReached) {
        stopReason = budget ? "STEP_BUDGET_EXHAUSTED" : "STEP_LIMIT_REACHED";
        stopDetail = budget
          ? `objective step limit ${maxTotalSteps} reached (${tracker.data.cumulativeSteps} steps consumed across runs)`
          : `--no-continuation: ${segmentSteps} steps`;
        break;
      }
      if (Date.now() > turnDeadline) {
        stopReason = "TIME_BUDGET_EXHAUSTED";
        stopDetail = `operator time limit ${budget!.maxTurnMinutes} min`;
        break;
      }
      if (budget && tracker.data.stepsWithoutProgress >= budget.stagnationSteps) {
        stopReason = "STAGNATION_DETECTED";
        const loops = tracker.loops().slice(0, 2).map((r) => `${r.action} ×${r.count}`).join("; ");
        const thrash = tracker.reacquisitions().filter((r) => (r.reacquired ?? 0) >= 2).slice(0, 2).map((r) => `${r.action} re-read ×${r.reacquired} after compaction`).join("; ");
        stopDetail = `${tracker.data.stepsWithoutProgress} consecutive steps without progress${loops ? ` (repeated: ${loops})` : ""}${thrash ? ` (context thrash: ${thrash})` : ""}${this.stateIdentityUncertainty ? `; ${this.stateIdentityUncertainty}` : ""}`;
        tracker.stagnation(tracker.data.cumulativeSteps, "no_progress", stopDetail);
        break;
      }
      if (signal.aborted) {
        markInterrupted("between_steps");
        break;
      }
      // --step: one model/tool cycle per turn. Every path that continues the loop ends its cycle with endStep (recovery
      // note delivered, progress evaluated) and comes back here, so this one boundary covers the sequential, parallel-read
      // and notice paths alike; a stop set by the cycle or by the checks above (STAGNATION_DETECTED, a budget, a cancel)
      // is reported instead. currentStep advances only in endStep, so it is past 1 once this turn finished a cycle.
      if (isStep && currentStep > 1) {
        stopReason = "STEP_PAUSED";
        stopDetail = "paused after one model/tool cycle (--step)";
        break;
      }
      // Operator /compact queued during the previous step runs here: its inference and tool batch have settled.
      // False when a compaction that is not durable ends the turn.
      const drainQueuedCompactions = async (): Promise<boolean> => {
        // A `/compact --llm` stays queued while a resumed window covers the provider it calls (see drainCompactionQueue).
        if (!this.compactionQueue.length) return true;
        try {
          await this.drainCompactionQueue(currentStep, signal);
        } catch (err) {
          if (!(err instanceof CompactionCommitError)) throw err;
          persistenceFailure = err.outcome.message;
          return false;
        }
        return true;
      };
      if (!(await drainQueuedCompactions())) break;
      if (budget && currentStep > 1 && (currentStep - 1) % segmentSteps === 0) {
        segment++;
        if (this.objective) this.objective.continuation.segments = segment;
        withDurableSync(() => {
          try {
            this.checkpointDurableState(`continuation: segment ${segment} begins at step ${currentStep}`);
          } catch (err: any) {
            this.reportPersistenceFailure("continuation", err);
          }
          this.persistProgress({ messages: true });
        });
        console.warn(pc.dim(`↻ Continuing automatically: segment ${segment} begins at step ${currentStep}; the work is still progressing.`));
      }
      const cumulativeStep = tracker.beginStep();
      if (this.objective && this.durable) this.objective.continuation.totalSteps = tracker.data.cumulativeSteps;
      // Charge and persist this inference step before contacting a provider. If durable state cannot record the
      // consumed budget, stop here: a resume must not repeat an unaccounted request.
      if (this.durable && !this.persistProgress({ messages: true })) {
        persistenceFailure = this.turnPersistenceFailures.at(-1) ?? "The objective step budget could not be saved before inference.";
        stopReason = "PERSISTENCE_FAILED";
        break;
      }
      const stepStateBefore = stateNow;
      const verdicts: ObservationVerdict[] = [];
      /**
       * Evidence-backed progress earlier in this step, judged as endStep will judge it: new information, or a
       * successful change that moved the workspace to a state not seen before. A write that changes nothing (however
       * its arguments are spelled) is not progress. `except` is the verdict being judged, which never counts for itself.
       */
      const progressedThisStep = (except?: ObservationVerdict): boolean => {
        const earlier = verdicts.filter((v) => v !== except);
        if (earlier.some((v) => v.informative)) return true;
        if (!earlier.some((v) => v.classification === "ARTIFACT_MODIFIED")) return false;
        const now = inputStateFor();
        return now !== "unknown" && now !== stepStateBefore && !tracker.data.seenStates.includes(now);
      };
      let operatorInputApplied = this.applyQueuedSteering(currentStep) > 0;
      if (operatorInputApplied) {
        completionNudges = 0;
        tracker.operatorInput(cumulativeStep, "operator steering applied");
      }
      let pendingRecoveryNote: string | undefined;
      // The state each call ran on: the step's starting state until a call that may change the workspace has run.
      let callInputState = stepStateBefore;
      let stateMayHaveChanged = false;
      const inputStateFor = (): string => {
        if (stateMayHaveChanged) {
          callInputState = this.workspaceStateIdentity();
          stateMayHaveChanged = false;
        }
        return callInputState;
      };
      /** Whether an observation's output is in the conversation in full, as of now. */
      const presence = (): ((key: string) => boolean) => {
        const { presentCalls } = observationPresence(this.messages);
        return (id: string) => presentCalls.has(id);
      };
      /** Waits before re-running an unchanged poll or a transient failure on an unchanged state (see backoffMs). */
      const backoffBefore = async (call: ToolCall): Promise<void> => {
        const prior = tracker.priorRun(call.function.name, call.function.arguments, inputStateFor());
        if (!prior || !(prior.outcomeClass === "transient_failure" || (prior.actionKind === "external" && prior.outcomeClass === "success"))) return;
        const wait = backoffMs(prior.count);
        if (!wait) return;
        tracker.intervention(cumulativeStep, "backoff", `waited ${wait} ms before re-running ${prior.action} (${prior.outcomeClass === "transient_failure" ? "transient failure" : "unchanged result"} ×${prior.count} on an unchanged workspace)`);
        await this.backoffSleep(wait, signal);
      };
      const trackCall = (call: ToolCall, result: string, kind: CallClass, state: string) => {
        const name = call.function.name;
        const soft = this.config.repeatedCalls?.soft ?? DEFAULT_REPEATED_CALL_SOFT;
        pushCall(callRing, makeCallRecord(name, call.function.arguments, result, kind, state));
        const looped = judgeRepeatedCalls(callRing, soft, this.config.repeatedCalls?.hard ?? DEFAULT_REPEATED_CALL_HARD);
        if (looped.level === "hard") {
          loopedCall = { name, count: looped.count, arguments: safeTerminal(looped.arguments), history: repeatedCallHistory(callRing) };
        } else if (looped.level === "soft" && looped.count === soft) {
          repeatedCallNote = `[Nexus] You have called ${name} with the same arguments ${looped.count} times and got the same result each time (${safeTerminal(looped.arguments).slice(0, 120)}). Repeating it will not change the outcome; use the result you have or change approach.`;
        }
      };
      const observe = (call: ToolCall, receipt: ExecutionReceipt, reacquire = false) => {
        const name = call.function.name;
        const inputState = inputStateFor();
        // A recognised shell read (cat/head/sed) observes the workspace like read_file; its coverage counts only when
        // the model receives the output whole (run_command output is folded when long).
        const shellRead = name === "run_command" && readRequests(name, call.function.arguments, this.config.workspace) !== undefined;
        const delivered = !shellRead || foldVoluminousOutput(receipt.output ?? "") === (receipt.output ?? "");
        const coverage = (receipt.success && delivered ? readCoverage(name, call.function.arguments, receipt.output ?? "", this.config.workspace) : undefined)
          ?.map((c) => ({ ...c, sig: fileSignature(this.config.workspace, c.path) }));
        const verdict = tracker.observe(cumulativeStep, {
          name,
          args: call.function.arguments,
          success: receipt.success,
          text: receipt.success ? receipt.output ?? "" : `${receipt.error ?? ""}\n${receipt.output ?? ""}`,
          stateBefore: inputState,
          reacquire,
          kind: shellRead ? "observe_workspace" : undefined,
          coverage,
          callId: call.id,
          present: presence(),
        });
        verdicts.push(verdict);
        trackCall(call, `${receipt.success}\n${receipt.output ?? ""}\n${receipt.error ?? ""}`, verdict.poll ? "poll" : shellRead || actionKind(name) === "observe_workspace" ? "observer" : "command", inputState);
        if (verdict.thrash && !noticedThrash.has(verdict.key)) {
          // Not task repetition: compaction keeps removing what the work needs (context thrash), reported as such.
          noticedThrash.add(verdict.key);
          tracker.stagnation(cumulativeStep, "context_thrash", `${verdict.record.action} re-read ${verdict.record.reacquired} times after compaction removed its output; the context window does not hold the working set`);
          pendingRecoveryNote =
            `[Nexus] The output of ${name} has left your context ${verdict.record.reacquired} times through compaction and you re-read it each time. ` +
            `Before reading it again, write the facts you need from it into your work product or state them in a short message (with file and symbol references); they stay in context.`;
        }
        if (actionKind(name) !== "observe_workspace" && actionKind(name) !== "bookkeeping") stateMayHaveChanged = true;
        if (verdict.stateUnknown && verdict.record.count >= REPEAT_THRESHOLD && !stateUnknownNoted) {
          stateUnknownNoted = true;
          tracker.stagnation(cumulativeStep, "repetition_state_unknown", `${verdict.record.action} ×${verdict.record.count}: ${this.stateIdentityUncertainty ?? "workspace state unknown"}`);
        }
        if (!budget) return;
        if (verdict.poll) {
          if (verdict.record.count >= REPEAT_THRESHOLD && !noticedPolls.has(verdict.key)) {
            noticedPolls.add(verdict.key);
            pendingRecoveryNote =
              `[Nexus] ${name} returned the same result ${verdict.record.count} times on an unchanged workspace` +
              `${verdict.record.outcomeClass === "transient_failure" ? " (a transient failure)" : ""}. Nexus spaces further re-runs (up to ${Math.round(backoffMs(verdict.record.count + 1) / 1000)} s apart). ` +
              `If you are waiting for something outside the workspace, re-check sparingly; otherwise use the result you have or change approach.`;
          }
          return;
        }
        if (!verdict.loop && !verdict.equivalentLoop) return;
        // A semantic loop (the same lines through another read form) is reported by its file; an exact one by its call.
        const count = verdict.loop ? verdict.record.count : (verdict.equivalence?.count ?? 0) + 1;
        const what = verdict.loop
          ? `called ${name} with the same arguments ${count} times`
          : `obtained lines ${verdict.equivalence?.start}-${verdict.equivalence?.end} of ${verdict.equivalence?.path} ${count} times (most recently with ${name})`;
        tracker.stagnation(cumulativeStep, "repetition", `${verdict.record.action} ×${count} with the same result on an unchanged workspace -> ${verdict.record.outcome.slice(0, 160)}`);
        // This step already made progress: it ends the recovery episode at endStep, so a repeat in it neither
        // escalates nor exhausts recovery (later calls in the step still run).
        if (progressedThisStep(verdict)) return;
        const transition = tracker.recordUnproductive(cumulativeStep, verdict.record.action, inputState, budget.maxRecoveries, allowedDenials);
        if (transition.outcome === "exhausted") {
          stopReason = "STAGNATION_DETECTED";
          stopDetail = `repeated ${name} ${count} times with an unchanged result on an unchanged workspace after ${transition.note} recovery notes`;
          tracker.stagnation(cumulativeStep, "repetition_stop", stopDetail);
          return;
        }
        if (transition.sameStep) return;
        tracker.intervention(cumulativeStep, "recovery_note", `${verdict.record.action} ×${count} -> ${transition.outcome}`);
        try {
          this.observer?.onContinuation?.({ kind: "recovery", n: transition.note, max: budget.maxRecoveries, detail: name });
        } catch {}
        const header = `[Nexus recovery ${transition.note}/${budget.maxRecoveries}] You have ${what} on an unchanged workspace and received the same result each time. Repeating it will not change the outcome.`;
        pendingRecoveryNote = transition.outcome === "advisory"
          ? `${header} Use the result you already have or change approach; if the remaining work is blocked, ` +
            `record that with update_requirements (status "blocked" with the reason) and stop with a final message.`
          : `${header} From now on Nexus refuses, before they run, observations that would only return what this conversation already holds.` +
            // One live copy: the pinned ledger carries RECOVERY_REQUIRED on every request while constrained.
            (this.pinsLedger()
              ? ` The RECOVERY_REQUIRED section of the pinned objective ledger lists the evidence you already have, what is refused, what is permitted and the budget left; it is kept current on every request.`
              : `\n\n${this.recoveryContext(tracker, budget.stagnationSteps, promptText)}`);
      };
      /**
       * Refuses a call that would only re-observe what the conversation already holds, during constrained recovery.
       * Returns the tool message content when refused (the call is not executed), else undefined.
       */
      const refuse = (call: ToolCall): string | undefined => {
        if (!budget) return undefined;
        // An earlier call in this step already showed progress: recovery ends with this step, so nothing more in it is refused.
        if (progressedThisStep()) return undefined;
        const name = call.function.name;
        const denial = tracker.recoveryDenial(cumulativeStep, name, call.function.arguments, inputStateFor(), this.config.workspace, presence(), (p) => fileSignature(this.config.workspace, p));
        if (!denial) return undefined;
        const exhausted = tracker.recordDenial(cumulativeStep, denial);
        if (exhausted && !stopReason) {
          stopReason = "STAGNATION_DETECTED";
          const r = tracker.data.recovery;
          stopDetail = `recovery exhausted after ${r.notes} recovery notes: ${r.denials} equivalent observation(s) refused on an unchanged workspace (last: ${denial.action})`;
          tracker.stagnation(cumulativeStep, "recovery_exhausted", stopDetail);
        }
        return recoveryDenialMessage(denial, tracker.data.recovery, exhausted);
      };
      const endStep = () => {
        if (pendingRecoveryNote) {
          this.messages.push(harnessNoteMessage(pendingRecoveryNote));
        }
        if (repeatedCallNote && !pendingRecoveryNote) this.messages.push(harnessNoteMessage(repeatedCallNote));
        repeatedCallNote = undefined;
        const stateAfter = this.workspaceStateIdentity();
        const evaluation = tracker.evaluateStep(cumulativeStep, {
          stateBefore: stepStateBefore,
          stateAfter,
          verdicts,
          ledgerState: this.ledgerProgressIdentity(),
          operatorInput: operatorInputApplied,
        });
        stateNow = stateAfter;
        // A step that changed the workspace is not a loop: the hard stop waits for a step that did not.
        if (loopedCall && stateAfter === stepStateBefore && stateAfter !== "unknown" && !operatorInputApplied && !stopReason) {
          stopReason = "TOOL_CALL_LOOP";
          stopDetail = `${loopedCall.name} called ${loopedCall.count} times with identical arguments and an identical result (${loopedCall.arguments.slice(0, 120)})`;
          this.turnRepeatedCall = { tool: loopedCall.name, arguments: loopedCall.arguments.slice(0, 200), count: loopedCall.count, history: loopedCall.history };
        }
        loopedCall = undefined;
        if (this.pendingNeedsInput && !stopReason) {
          stopReason = "NEEDS_INPUT";
          stopDetail = this.pendingNeedsInput.prompt;
        }
        if (evaluation.progressed && this.objective) this.objective.continuation.lastProgressStep = currentStep;
        this.persistProgress({ messages: true });
        currentStep++;
      };
      turn.step = currentStep;
      this.ui.stepHeader(currentStep, maxTotalSteps);
      if (currentStep > 1 && this.flightRecorder) {
        this.flightRecorder.recordTurnStart(currentStep, promptText);
      }
      const requestId = randomUUID();
      const { client: activeClient } = this.selectCognitiveClient(currentStep, this.messages);
      // A resumed turn first waits out the provider window it was suspended in, before anything is sent to the
      // provider: the capability read and compaction admission (which can make auxiliary requests) included.
      const policy = this.recoveryPolicy ?? recoveryPolicyFromEnv();
      // When the provider may be asked again, while this step waits for it (kept if the wait is interrupted).
      let providerEligibleAt: string | undefined = this.latestCoveringWindow(activeClient);
      let resumedWait: ProviderRecoveryRecord | undefined;
      try {
        await this.waitOutResumedProviderWindow(policy, currentStep, turn, signal, activeClient, (r: any) => (resumedWait = r));
      } catch (err) {
        if (!(err instanceof RecoveryCancelled)) throw err;
        this.ui.stopSpinner(false, "Stopped while waiting for the inference provider");
        if (resumedWait) providerRecoveries.push(resumedWait);
        turn.phase = "inference";
        this.activeProviderRecovery = null;
        markInterrupted("provider_wait", providerEligibleAt ? { providerEligibleAt } : {});
        break;
      }
      providerEligibleAt = undefined;
      if (resumedWait) providerRecoveries.push(resumedWait);
      if (!(await drainQueuedCompactions())) break;
      await this.pendingModelDetection;
      await this.detectDeferredModel();
      // Provider limits for this step's connection (cached; re-read on change or after the TTL). Optional capability.
      await this.refreshCapabilities(activeClient, this.capabilitiesStale ?? "step", Boolean(this.capabilitiesStale), signal);
      this.capabilitiesStale = undefined;
      this.resizeSkillCatalog();
      try {
        await this.admitWithFindings(activeClient, currentStep, requestId, signal);
        await this.measureAdmission(activeClient, currentStep, requestId, signal);
      } catch (err) {
        if (err instanceof InferenceError && err.kind === "aborted") {
          markInterrupted("inference");
          break;
        }
        if (err instanceof CompactionCommitError) {
          // No inference or tool dispatch follows a compaction that is not durable (or not applied).
          persistenceFailure = err.outcome.message;
          break;
        }
        if (!(err instanceof ContextBudgetError)) throw err;
        // Fail-closed admission refused the request before any inference call. A refusal is a bounded
        // condition, not a crash. If no model call has happened in this turn the submission is withdrawn
        // from history so that retrying cannot stack duplicate user messages; if earlier steps already ran,
        // the conversation and tool evidence are kept untouched.
        const modelCalled = stepsUsed > 0;
        let retained = true;
        if (!modelCalled && this.isSubmissionTail(historyBeforeSubmission)) {
          this.messages.length = historyBeforeSubmission;
          retained = false;
          // The withdrawn submission is not the objective either.
          this.objective = priorLedger;
          this.persistProgress({ messages: true });
        }
        capacityBlock = {
          promptCountSource: err.count.source,
          ...(err.count.unmeasured ? { unmeasured: err.count.unmeasured } : {}),
          ...(err instanceof LedgerNotRetainedError ? { missingRequirements: err.missingRequirements } : {}),
          estimatedPromptTokens: err.estimatedTokens,
          completionReserveTokens: err.completionReserveTokens,
          toolResponseReserveTokens: err.toolResponseReserveTokens,
          contextLimit: err.contextLimit,
          step: currentStep,
          modelCalled,
          pendingMessageRetained: retained,
          pendingMessageChars,
        };
        break;
      }
      this.ui.startSpinner("Thinking and analyzing next step...");
      turn.phase = "inference";
      this.activity("inference");

      if (this.cognitiveRoutingEnabled && currentStep === 1) {
        process.stdout.write(pc.dim(`\n🧭 Dual-Model Routing: [Planner: ${this.plannerClient.getProviderId?.() ? `${this.plannerClient.getProviderId?.()}:` : ""}${this.plannerClient.getModel()} | Coder: ${this.coderClient.getProviderId?.() ? `${this.coderClient.getProviderId?.()}:` : ""}${this.coderClient.getModel()}]\n`));
      }

      let assistantMessage: ChatMessage;
      let streamedTokens = false;
      // Temporary provider failures are waited out here, at the inference boundary: history and tool state
      // are untouched while waiting, and a submission's output is used only once it is complete.
      const recovery = new ProviderRecoveryController(policy, this.recoveryClock, currentStep, {
        everSucceeded: typeof activeClient.hasEverSucceeded === "function" ? activeClient.hasEverSucceeded() : true,
        endpoint: activeClient.endpoint,
      });
      const lengthGuard = { step: currentStep, cutAfterMs: 0 };
      // Silence on the stream is told to the operator while the request is still waiting (the idle timeout is separate).
      activeClient.onStreamStall = (event: any) => {
        try {
          this.observer?.onStreamStall?.(event);
        } catch {}
      };
      try {
        assistantMessage = await recovery.run(requestId, {
          submit: (s) => this.submitGenAiRequest(activeClient, () =>
            this.submitGuardingLength(lengthGuard, this.requestMessages(this.messages), (request: any) =>
                activeClient.chatCompletionStream(
                  request,
                  this.getEffectiveTools(),
                  (token: string) => {
                    if (!streamedTokens) {
                      this.ui.stopSpinner(true);
                      process.stdout.write(pc.bold(pc.magenta("\n💭 Assistant: ")));
                      streamedTokens = true;
                    }
                    process.stdout.write(safeTerminal(token));
                    this.observer?.onAssistantDelta?.(token);
                  },
                  s.requestId,
                  signal,
                )),
          ),
          probe: (probeSignal, opts) =>
            typeof activeClient.probeAvailability === "function"
              ? activeClient.probeAvailability(probeSignal, { timeoutMs: policy.probeTimeoutMs, ...opts })
              : Promise.resolve({ available: true, condition: "AVAILABLE" as const }),
          // Output-limit failures are handled by the agent loop below, not provider recovery. They are
          // completed responses with unusable output, not provider availability failures.
          classify: (err) => (err instanceof InferenceError && err.kind !== "output_truncated" ? err.toFailure() : null),
          newRequestId: () => randomUUID(),
          onFailure: this.providerRecoveryHooks?.onFailure,
          shouldYield: this.providerRecoveryHooks?.shouldYield,
          onState: (record) => {
            if (streamedTokens && record.state === "RESUMED") process.stdout.write("\n");
            const discarded = streamedTokens && record.state === "WAITING";
            if (discarded) {
              process.stdout.write(pc.dim("\n[partial response discarded: the provider failed before completing it]\n"));
              streamedTokens = false;
            }
            if (record.state === "WAITING" && record.nextAttemptAt) providerEligibleAt = record.nextAttemptAt;
            this.onProviderRecoveryState(record, turn, discarded);
          },
        }, signal);
        if (streamedTokens) {
          process.stdout.write("\n\n");
        } else {
          this.ui.stopSpinner(true);
        }
      } catch (err: any) {
        if (err instanceof ContextBudgetError) {
          this.ui.stopSpinner(false, `Inference error: ${err.message}`);
          throw err;
        }
        if (streamedTokens) process.stdout.write("\n");
        if (err instanceof RecoveryCancelled) {
          this.ui.stopSpinner(false, "Stopped while waiting for the inference provider");
          markInterrupted("provider_wait", providerEligibleAt ? { providerEligibleAt } : {});
          break;
        }
        if (err instanceof InferenceError && err.kind === "aborted") {
          this.ui.stopSpinner(false, "Inference request aborted by operator");
          markInterrupted("inference");
          break;
        }
        // A reply cut off at the output limit: none of it runs. Once in a row the model is told why and asked for the
        // content in parts, and the turn goes on at the next step; the step counts as no progress.
        if (err instanceof InferenceError && err.kind === "output_truncated" && !previousReplyTruncated && currentStep < maxTotalSteps) {
          previousReplyTruncated = true;
          const allowance = activeClient.getOutputAllowance?.();
          const target = err.truncatedCalls.map((c) => `${c.name}${c.path ? ` ${c.path}` : ""} (${c.argumentChars} chars)`).join(", ") || "text";
          this.ui.stopSpinner(false, `Reply cut off at the output limit${allowance ? ` (${allowance} tokens)` : ""}; nothing from it ran`);
          console.warn(pc.dim(`↻ Asking the model to write it in parts: ${target}.`));
          tracker.intervention(cumulativeStep, "output_truncated", `reply cut off at the output limit (request ${err.requestId ?? requestId}): ${target}; nothing ran`);
          this.messages.push(harnessNoteMessage(truncatedReplyNotice(err.truncatedCalls, allowance, stepPosition(currentStep, maxTotalSteps))));
          stepsUsed = currentStep;
          endStep();
          continue;
        }
        this.ui.stopSpinner(false, `Inference error: ${err.message}`);
        console.error(`\nFatal error communicating with LLM server: ${err.message}`);
        inferenceFailure = err instanceof InferenceError
          ? err.toFailure()
          : { kind: "protocol_error", origin: "client", message: err?.message || String(err), requestId };
        if (inferenceFailure?.condition === "CAPACITY_REJECTED") {
          this.capabilitiesStale = "the provider rejected a request for capacity";
          if (!capacityRetryAttempted) {
            capacityRetryAttempted = true;
            const original = this.messages;
            const candidate = this.compactionCandidate(original, 1, 1200);
            const accepted = (candidate.messages.length < original.length || this.scaledBudget(candidate.messages, this.contextLimit()).totalActiveTokens < this.scaledBudget(original, this.contextLimit()).totalActiveTokens)
              ? candidate
              : this.compactionCandidate(original, 0, 0);
            for (const key of accepted.removedObservations) this.turnRemovedObservations.add(key);
            try {
              this.commitCompaction(original, accepted.messages, {
                trigger: "auto",
                step: currentStep,
                beforeTokens: this.scaledBudget(original, this.contextLimit()).totalActiveTokens,
                afterTokens: this.scaledBudget(accepted.messages, this.contextLimit()).totalActiveTokens,
                pressureOnly: false,
              });
            } catch {
              this.messages = accepted.messages;
            }
            this.ui.stopSpinner(false, "Provider rejected request for capacity; compacted context and retrying once at reduced budget...");
            tracker.intervention(cumulativeStep, "capacity_rejected_retry", "provider rejected request for capacity; retrying after compaction");
            inferenceFailure = null;
            stepsUsed = currentStep;
            endStep();
            continue;
          }
          const discovered = this.getProviderCapabilities()?.advertised?.contextLength ?? this.contextLimit();
          const actionableMsg = `The inference server rejected the request for context capacity (CAPACITY_REJECTED). Set --context-limit ${discovered} (or NEXUS_CONTEXT_LIMIT) to match the server's window.`;
          console.error(pc.red(`\n${actionableMsg}`));
          inferenceFailure = {
            ...inferenceFailure,
            message: actionableMsg,
          };
        }
        break;
      } finally {
        if (recovery.record) providerRecoveries.push(recovery.record);
        turn.phase = "inference";
        this.activeProviderRecovery = null;
      }
      stepsUsed = currentStep;
      previousReplyTruncated = false;
      this.noteAdmission(activeClient, currentStep);

      // Parse the response using hybrid parser
      const nativeTools = activeClient?.supportsNativeTools?.() ?? true;
      const parsed = this.parseNormalizedResponse(assistantMessage, nativeTools);
      this.addToolCallSyntax(parsed.toolCallSyntax);

      // Update cumulative token usage
      const promptEst = calculateContextBudget(
        this.requestMessages(this.messages),
        this.getEffectiveTools(),
        this.contextLimit()
      ).totalActiveTokens;
      const compContent = typeof assistantMessage.content === "string"
        ? assistantMessage.content
        : Array.isArray(assistantMessage.content)
        ? JSON.stringify(assistantMessage.content)
        : "";
      const compEst =
        countTokens(compContent) +
        countTokens(JSON.stringify(assistantMessage.tool_calls || []));
      // Provider connections report their own usage; estimates remain the measure where none is reported.
      const reported = activeClient.getProviderId?.() ? activeClient.getLastUsage?.() : undefined;
      this.totalTokens.prompt += reported?.inputTokens ?? promptEst;
      this.totalTokens.completion += reported?.outputTokens ?? compEst;
      this.totalTokens.total = this.totalTokens.prompt + this.totalTokens.completion;
      this.totalTokens.requests++;
      if (reported?.inputTokens !== undefined) this.totalTokens.reportedRequests++;
      else this.totalTokens.estimatedRequests++;

      // Print any thought or explanation text only if not already streamed
      if (parsed.thoughtText && !streamedTokens) {
        this.ui.printThought(parsed.thoughtText);
      }
      // Reasoning (<think> blocks) is kept apart from the reply: recorded, never shown as output or parsed for tools.
      if ((parsed.thoughtText || parsed.reasoningText) && this.flightRecorder) {
        this.flightRecorder.recordThought(currentStep, parsed.thoughtText, parsed.reasoningText);
      }

      // Cancellation observed after the response arrived: admit none of its actions. The assistant
      // message is dropped so the history never holds tool_calls without tool results.
      if (signal.aborted) {
        undispatched = parsed.toolCalls.length;
        markInterrupted("inference");
        break;
      }

      // Record assistant's response in history
      this.uniqueCallIds(parsed.toolCalls, tracker);
      this.messages.push({
        role: "assistant",
        content: assistantMessage.content || "",
        ...(parsed.toolCalls.length > 0 ? { tool_calls: parsed.toolCalls } : {}),
      });

      // The calls are durable before any of them runs: a crash mid-tool leaves them unsettled, not forgotten.
      if (parsed.toolCalls.length > 0) this.persistProgress({ messages: true });

      // No tool calls: the model stopped acting. That is a fact about the model, not evidence of success.
      if (parsed.toolCalls.length === 0) {
        // If a malformed or unknown tool call was dropped, give the model a notice and continue turn (ACC-VER-02)
        if (parsed.notices && parsed.notices.length > 0) {
          for (const notice of parsed.notices) {
            this.ui.stopSpinner(false, `[notice] ${notice}`);
            this.messages.push(harnessNoteMessage(`[Nexus: ${notice}]`));
          }
          this.persistProgress({ messages: true });
          endStep();
          continue;
        }

        // Steering that arrived while the model was answering is applied next step instead of being dropped.
        if (this.hasQueuedSteering()) {
          endStep();
          continue;
        }
        // An empty reply (no text either) is no answer. Once in a row, the model is told and the turn goes on.
        const replied = Boolean(parsed.thoughtText?.trim()) ||
          (typeof assistantMessage.content === "string" ? assistantMessage.content.trim() !== "" : Boolean(assistantMessage.content));
        if (!replied && !previousReplyEmpty) {
          previousReplyEmpty = true;
          if (currentStep < maxTotalSteps) {
            this.messages.push(harnessNoteMessage(`[Nexus: your reply was empty: no text and no tool call. It does not finish the task. This is ${stepPosition(currentStep, maxTotalSteps)}. Continue the task where you left off; call task_completed when it is done.]`));
          }
          this.persistProgress({ messages: true });
          endStep();
          continue;
        }
        // Stopping with acceptance requirements still open: ask (boundedly) for the rest, or for an explicit block.
        const open = budget && this.objective ? openRequirements(this.objective) : [];
        if (budget && open.length && completionNudges < budget.maxCompletionNudges) {
          completionNudges++;
          try {
            this.observer?.onContinuation?.({ kind: "requirements", n: completionNudges, max: budget.maxCompletionNudges, detail: open.map((r) => r.id).join(", ") });
          } catch {}
          this.messages.push(harnessNoteMessage(
            `[Nexus continuation ${completionNudges}/${budget.maxCompletionNudges}] The operator's acceptance requirements are still open: ` +
            `${open.map((r) => `${r.id} [${r.status}] ${r.text}`).join("; ")}. Continue working on them without waiting for the operator. ` +
            `If one cannot be done here, call update_requirements with status "blocked" (or "descoped") and a note giving the reason, then stop.`,
          ));
          this.persistProgress({ messages: true });
          endStep();
          continue;
        }
        modelStop = "FINAL_TEXT";
        finalOutputComplete = replied;
        break;
      }
      previousReplyEmpty = false;

      // Parallel execution optimization: if multiple tool calls in this turn are all read-only, execute concurrently through ExecutionSpine
      if (parsed.toolCalls.length > 1 && parsed.toolCalls.every((call: any) => READ_ONLY_TOOLS.has(call.function.name))) {
        this.ui.startSpinner(`Executing ${parsed.toolCalls.length} read operations in parallel...`);
        turn.phase = "tool";
        turn.currentTool = `${parsed.toolCalls.length} parallel reads`;
        const reacquiring = new Set(parsed.toolCalls.filter((call: any) => this.turnRemovedObservations.has(observationKey(call.function.name, call.function.arguments))));
        // Constrained recovery: each call is judged before any runs; refused calls do not run.
        const refused = new Map<ToolCall, string>();
        for (const call of parsed.toolCalls) {
          const content = stopReason ? notExecutedMessage(call, stopDetail ?? stopReason).content : refuse(call);
          if (content !== undefined) refused.set(call, content);
        }
        // A refusal that stopped the turn stops the whole batch: calls judged before it do not run either.
        if (stopReason) for (const call of parsed.toolCalls) if (!refused.has(call)) refused.set(call, notExecutedMessage(call, stopDetail ?? stopReason).content);
        const executed = await Promise.all(
          parsed.toolCalls.filter((call: any) => !refused.has(call)).map(async (call: any) => {
            const { receipt } = await this.dispatchToolCall(call, currentStep, "agent");
            return { call, toolName: call.function.name, receipt };
          })
        );
        this.ui.stopSpinner(true);
        turn.currentTool = undefined;

        // Results in call order; a refused call's message stands in its place.
        for (const call of parsed.toolCalls) {
          const refusal = refused.get(call);
          if (refusal !== undefined) {
            this.messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: refusal });
            continue;
          }
          const item = executed.find((entry) => entry.call === call)!;
          observe(item.call, item.receipt, reacquiring.has(item.call));
          let content = item.receipt.success
            ? item.receipt.output
            : `Error executing ${item.toolName}: ${item.receipt.error || "Unknown error"}`;
          if (item.toolName === "run_command") {
            const diags = extractCompilerDiagnostics((item.receipt.output || "") + "\n" + (item.receipt.error || ""));
            if (diags.length > 0) {
              content += formatDiagnosticHints(diags);
            }
          }
          this.messages.push({
            role: "tool",
            tool_call_id: item.call.id,
            name: item.toolName,
            content: item.receipt.success ? this.toolResultContent(item.call, content, currentStep, maxTotalSteps) : content,
          });
        }
        this.persistProgress({ messages: true });
        endStep();
        continue;
      }

      // Execute each tool call through ExecutionSpine
      for (let ci = 0; ci < parsed.toolCalls.length; ci++) {
        const call = parsed.toolCalls[ci];
        const toolName = call.function.name;
        // Admission check: no NEW tool dispatch begins once cancellation is observed.
        if (signal.aborted) {
          for (const rest of parsed.toolCalls.slice(ci)) this.messages.push(cancelledToolMessage(rest));
          undispatched = parsed.toolCalls.length - ci;
          markInterrupted(
            turn.toolInFlightAtCancel ? "tool_settling" : "tool_dispatch",
            turn.toolInFlightAtCancel ? { outstandingTool: turn.toolInFlightAtCancel, outstandingToolSettled: true } : {},
          );
          break;
        }
        let rawArgs: any = {};
        try {
          rawArgs =
            typeof call.function.arguments === "string"
              ? JSON.parse(call.function.arguments)
              : call.function.arguments;
        } catch {
          rawArgs = {};
        }

        // A decision only an operator can make stops the batch at the call that needed it.
        if (this.pendingNeedsInput && !stopReason) {
          stopReason = "NEEDS_INPUT";
          stopDetail = this.pendingNeedsInput.prompt;
        }
        // Recovery stopped the turn earlier in this batch: nothing more runs.
        if (stopReason) {
          for (const rest of parsed.toolCalls.slice(ci)) this.messages.push(notExecutedMessage(rest, stopDetail ?? stopReason));
          break;
        }
        // Constrained recovery: an observation that would only return what the conversation holds does not run.
        const refusal = refuse(call);
        if (refusal !== undefined) {
          this.messages.push({ role: "tool", tool_call_id: call.id, name: toolName, content: refusal });
          this.persistProgress({ messages: true });
          continue;
        }
        await backoffBefore(call);
        const reacquire = this.turnRemovedObservations.has(observationKey(toolName, call.function.arguments));
        turn.phase = "tool";
        turn.currentTool = toolName;
        const { receipt, shouldExit } = await this.dispatchToolCall(
          call,
          currentStep,
          "agent",
          onConfirm
        );
        turn.currentTool = undefined;
        observe(call, receipt, reacquire);

        let finalContent = receipt.success
          ? receipt.output
          : `Error executing ${toolName}: ${receipt.error || "Unknown error"}`;

        if (toolName === "run_command" || toolName === "run_tests") {
          const combined = (receipt.output || "") + "\n" + (receipt.error || "");
          const diags = extractCompilerDiagnostics(combined);
          if (diags.length > 0) {
            finalContent += formatDiagnosticHints(diags);
          }
          finalContent = foldVoluminousOutput(finalContent);
        }

        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: toolName,
          content: receipt.success ? this.toolResultContent(call, finalContent, currentStep, maxTotalSteps) : finalContent,
        });
        this.persistProgress({ messages: true });

        if (this.objectiveBudgetPersistenceFailure) {
          persistenceFailure = this.objectiveBudgetPersistenceFailure;
          stopReason = "PERSISTENCE_FAILED";
          stopDetail = this.objectiveBudgetPersistenceFailure;
        }

        if (shouldExit) {
          modelStop = "TASK_COMPLETED_TOOL";
          finalOutputComplete = true;
          break;
        }
      }
      if (interruption) break;

      // The tool that was running when the operator asked to stop has now settled.
      if (signal.aborted && modelStop === "NONE") {
        markInterrupted(turn.toolInFlightAtCancel ? "tool_settling" : "tool_dispatch", turn.toolInFlightAtCancel ? { outstandingTool: turn.toolInFlightAtCancel, outstandingToolSettled: true } : {});
        break;
      }
      // Steering that arrived while the agent was finishing is applied rather than ending on a stale objective.
      if (modelStop === "TASK_COMPLETED_TOOL" && this.hasQueuedSteering()) {
        modelStop = "NONE";
        finalOutputComplete = false;
      }

      endStep();
    }
    turn.closing = true;
    this.closeSteeringConflicts();
    // Queued /compact: run now that the last step has settled, or cancelled with the turn.
    if (this.compactionQueue.length) {
      try {
        await this.drainCompactionQueue(currentStep, undefined, interruption ? "the turn was cancelled" : persistenceFailure ? "the turn stopped on a persistence failure" : undefined, true);
      } catch (err) {
        if (!(err instanceof CompactionCommitError)) throw err;
        persistenceFailure ??= err.outcome.message;
      }
    }
    if (this.hasQueuedSteering()) {
      this.cancelQueuedSteering(
        interruption ? "the turn was cancelled before it could be applied" : `the turn ended (${stopReason ?? (inferenceFailure as InferenceFailure | null)?.kind ?? (capacityBlock ? "context capacity" : persistenceFailure ? "persistence failure" : "stopped")}) before it could be applied`,
      );
    }

    triggerNotification("Nexus Code", "Turn finished.", this.surface);

    try {
      this.knowledge.autoExtract(promptText, "");
    } catch {}

    const limitReached = !interruption && !inferenceFailure && !capacityBlock && !persistenceFailure && modelStop === "NONE" && stopReason !== undefined;
    const resultInput = {
      persistenceFailure,
      modelStop,
      finalOutputComplete,
      inferenceFailure,
      interruption,
      limitReached,
      capacityBlock,
      stepsUsed: stopReason === "STEP_BUDGET_EXHAUSTED" ? tracker.data.cumulativeSteps : (stepsUsed || Math.min(currentStep, maxTotalSteps)),
      providerRecoveries,
      maxSteps: maxTotalSteps,
      stopReason,
      stopDetail,
      ...(budget
        ? {
            continuation: {
              segments: segment,
              segmentSteps,
              ...(stopReason ? { stopReason } : {}),
              stepsWithoutProgress: tracker.data.stepsWithoutProgress,
              cumulativeSteps: tracker.data.cumulativeSteps,
              ...(tracker.loops().length ? { repeated: tracker.loops().slice(0, 5).map((r) => ({ action: r.action, count: r.count, firstStep: r.firstStep, lastStep: r.lastStep })) } : {}),
              ...(this.stateIdentityUncertainty ? { stateUncertainty: this.stateIdentityUncertainty } : {}),
            },
          }
        : {}),
    };
    let result = this.buildTurnResult(resultInput);
    if (this.objective) {
      if (this.durable) this.objective.continuation.totalSteps = tracker.data.cumulativeSteps;
      this.objective.continuation.stopReason = stopReason ?? (persistenceFailure ? "PERSISTENCE_FAILED" : undefined);
      this.objective.outcome = { ...this.objectiveOutcome(result), at: result.finishedAt };
      try {
        withDurableSync(() => this.checkpointDurableState(undefined, result));
      } catch (err: any) {
        this.reportPersistenceFailure("final_checkpoint", err);
        result = this.buildTurnResult(resultInput);
      }
    } else if (this.durable) {
      try {
        withDurableSync(() => this.checkpointDurableState(undefined, result));
      } catch (err: any) {
        this.reportPersistenceFailure("final_checkpoint", err);
        result = this.buildTurnResult(resultInput);
      }
    }
    this.lastTurnResult = result;
    if (this.flightRecorder) {
      this.flightRecorder.recordSessionEnd(
        `${summarizeTurn(result).heading}: ${summarizeTurn(result).line}`,
        result.execution === "COMPLETED" && (result.outcome === "VERIFIED" || result.outcome === "NOT_REQUIRED"),
        this.totalTokens
      );
    }
    this.ui.turnSummary(result, this.completionSummary);
    return result;
  } catch (err: any) {
    turn.closing = true;
    this.closeSteeringConflicts();
    if (this.compactionQueue.length) {
      try {
        await this.drainCompactionQueue(currentStep, undefined, "the turn failed unexpectedly");
      } catch {}
    }
    if (this.hasQueuedSteering()) {
      this.cancelQueuedSteering(
        `the turn failed unexpectedly (${redactSecrets(String(err?.message ?? err)).slice(0, 200)}) before it could be applied`
      );
    }
    const unhandledMessage = redactSecrets(err instanceof Error ? err.message : String(err));
    const resultInput = {
      unhandledError: unhandledMessage,
      modelStop: "NONE" as const,
      finalOutputComplete: false,
      inferenceFailure: null,
      interruption: null,
      limitReached: false,
      stepsUsed: stepsUsed || Math.min(currentStep, maxTotalSteps),
      providerRecoveries,
      maxSteps: maxTotalSteps,
      stopReason: "UNHANDLED_ERROR" as const,
      stopDetail: unhandledMessage.slice(0, 300),
      ...(budget
        ? {
            continuation: {
              segments: segment,
              segmentSteps,
              stopReason: "UNHANDLED_ERROR",
              stepsWithoutProgress: tracker.data.stepsWithoutProgress,
              cumulativeSteps: tracker.data.cumulativeSteps,
              ...(tracker.loops().length ? { repeated: tracker.loops().slice(0, 5).map((r) => ({ action: r.action, count: r.count, firstStep: r.firstStep, lastStep: r.lastStep })) } : {}),
              ...(this.stateIdentityUncertainty ? { stateUncertainty: this.stateIdentityUncertainty } : {}),
            },
          }
        : {}),
    };
    let result = this.buildTurnResult(resultInput);
    if (this.objective) {
      if (this.durable) this.objective.continuation.totalSteps = tracker.data.cumulativeSteps;
      this.objective.continuation.stopReason = "UNHANDLED_ERROR";
      this.objective.outcome = { ...this.objectiveOutcome(result), at: result.finishedAt };
    }
    if (this.durable) {
      try {
        withDurableSync(() => this.checkpointDurableState(undefined, result));
      } catch (saveErr: any) {
        this.reportPersistenceFailure("final_checkpoint", saveErr);
        result = this.buildTurnResult(resultInput);
      }
    }
    this.lastTurnResult = result;
    if (this.flightRecorder) {
      this.flightRecorder.recordSessionEnd(
        `${summarizeTurn(result).heading}: ${summarizeTurn(result).line}`,
        false,
        this.totalTokens
      );
    }
    this.ui.turnSummary(result, this.completionSummary);
    return result;
  } finally {
    this.activeTurn = undefined;
    this.bridge.setTurnSignal(undefined);
  }
}

export function buildTurnResultImpl(this: any, input: {
    /** A compaction the next action depended on could not be committed: the turn stopped (PERSISTENCE_FAILED). */
    persistenceFailure?: string;
    modelStop: ModelStop;
    finalOutputComplete: boolean;
    inferenceFailure: InferenceFailure | null;
    interruption: InterruptionRecord | null;
    limitReached: boolean;
    capacityBlock?: CapacityRecord | null;
    stepsUsed: number;
    providerRecoveries?: ProviderRecoveryRecord[];
    /** Step budget of this turn (the continuation total, or `maxSteps` for a single-segment turn). */
    maxSteps?: number;
    stopReason?: TurnReason;
    stopDetail?: string;
    continuation?: TurnResult["continuation"];
    unhandledError?: string;
  }): TurnResult {
  const evidence = this.verificationEvidence ?? null;
  const recoveries = input.providerRecoveries ?? [];
  const lastRecovery = recoveries[recoveries.length - 1];
  const ledger = (this.depth === 0 || this.role === "implementer" || this.role === "tester") ? this.objective : undefined;
  const open = ledger ? openRequirements(ledger) : [];
  const blocked = ledger ? blockedRequirements(ledger) : [];
  const gating = ledger ? gatingRequirements(ledger) : [];
  const lastFailure = ledger ? [...ledger.verification].reverse().find((a) => !a.requirementId && (a.status === "FAILED" || a.status === "TIMED_OUT")) : undefined;
  const objective: TurnResult["objective"] | undefined = gating.length
    ? {
        status: open.length ? "incomplete" : blocked.length ? "blocked" : "completed",
        remaining: [...open, ...blocked].map((r) => `${r.id} [${r.status === "descoped" ? "descoped, needs operator acceptance" : r.status}] ${r.text}${r.note ? ` (${r.note})` : ""}`),
        // Done by the model's own report only: no passing verifier run is bound to them.
        implementedOnly: gating.filter((r) => r.status === "implemented").map((r) => r.id),
        ...(lastFailure?.failedCheck && evidence?.status !== "PASSED" ? { failedCheck: lastFailure.failedCheck } : {}),
        ...(ledger?.nextAction ? { nextAction: ledger.nextAction } : {}),
      }
    : undefined;
  const workspaceChanged = this.turnWorkspaceChanged();
  // Running a command latches the verification obligation, because a command can change files. When the turn ended
  // normally, nothing was pending before it, no worktree holds its work, no verifier result is held (a verifier that
  // ran is the evidence), and the workspace is exactly as the turn found it, the latch caught nothing: there is no
  // change to verify (TUI-AUDIT D-04). A command that changed any file leaves the identity different.
  const endedNormally = !input.interruption && !input.unhandledError && !input.persistenceFailure && !input.inferenceFailure &&
    !input.capacityBlock && !input.limitReached;
  // A file-write tool (write_file, edit_file, patch_file, delete_file) that succeeded is a change by definition, even
  // when the workspace identity cannot see its target (a gitignored build/ directory): never lifted.
  // The decision is kept for the turn: lifting clears the pending flag, and a rebuilt verdict must not flip to UNVERIFIED.
  // A command that may have left a process running is never lifted: the process can still write after the turn.
  const latchCaughtNothing = this.turnLatchLifted || (endedNormally && this.hasPendingModifications && !this.turnCarriedChanges &&
    !this.activeWorktree && !evidence && this.turnFileWrites === 0 && this.turnBackgroundCommands === 0 && workspaceChanged === "no");
  if (latchCaughtNothing) this.turnLatchLifted = true;
  if (latchCaughtNothing) {
    this.setUnverifiedChanges(false);
    // A later change takes a fresh pre-change baseline: the workspace may change between turns.
    this.changeBaseline = undefined;
  }
  const turnEvidence: TurnEvidence = {
    workspaceChanged,
    carriedChanges: this.turnCarriedChanges,
    denied: this.turnDenials,
    verifierRuns: [...this.turnVerifierRuns],
  };
  const base = {
    ...(recoveries.length ? { providerRecovery: recoveries } : {}),
    ...this.pendingWindowField(),
    acceptance: "NOT_REQUESTED" as const,
    modelStop: input.modelStop,
    finalOutputComplete: input.finalOutputComplete,
    verification: evidence,
    interruption: input.interruption,
    inferenceFailure: input.inferenceFailure,
    steps: { used: input.stepsUsed, max: input.maxSteps ?? this.config.maxSteps, limitReached: input.limitReached && input.stopReason !== "VERIFIER_NOT_CONVERGING" && input.stopReason !== "TOOL_CALL_LOOP" },
    unverifiedChangesPending: this.hasPendingModifications,
    finishedAt: new Date().toISOString(),
    ...(input.continuation ? { continuation: input.continuation } : {}),
    ...(objective ? { objective } : {}),
    ...(this.turnPersistenceFailures.length ? { persistence: { durable: false as const, failures: [...new Set(this.turnPersistenceFailures)].slice(0, 8) } } : {}),
    ...(this.durable ? { tokenAccounting: this.tokenAccounting() } : {}),
    ...(Object.values(this.turnToolCallSyntax).some((n: any) => n > 0) ? { toolCallSyntax: { ...this.turnToolCallSyntax } } : {}),
    turnEvidence,
  };

  if (input.interruption) {
    return deepFreezeTurn(assertTurnResultInvariants({
      ...base, execution: "INTERRUPTED", outcome: "NOT_ESTABLISHED", reason: "OPERATOR_INTERRUPT", finalOutputComplete: false,
    }));
  }
  if (input.unhandledError) {
    return deepFreezeTurn(assertTurnResultInvariants({
      ...base, execution: "FAILED", outcome: "NOT_ESTABLISHED", reason: "UNHANDLED_ERROR", detail: input.unhandledError.slice(0, 300), finalOutputComplete: false,
    }));
  }
  if (input.persistenceFailure) {
    return deepFreezeTurn(assertTurnResultInvariants({
      ...base, execution: "FAILED", outcome: "NOT_ESTABLISHED", reason: "PERSISTENCE_FAILED", detail: input.persistenceFailure.slice(0, 300), finalOutputComplete: false,
    }));
  }
  if (input.inferenceFailure) {
    const exhaustedDetail =
      lastRecovery?.state === "EXHAUSTED"
        ? `; provider recovery exhausted after ${lastRecovery.submissions.length} submissions, ${Math.round(lastRecovery.waitedMs / 1000)}s waiting` +
          (lastRecovery.everSucceeded === false ? " — run `nexus doctor`, check LOCAL_LLM_ENDPOINT in ~/.config/nexus/config.env, or use /connect" : "")
        : "";
    return deepFreezeTurn(assertTurnResultInvariants({
      ...base, execution: "FAILED", outcome: "NOT_ESTABLISHED", reason: "INFERENCE_FAILED",
      detail: `${input.inferenceFailure.kind}/${input.inferenceFailure.origin}${input.inferenceFailure.httpStatus ? ` HTTP ${input.inferenceFailure.httpStatus}` : ""}${exhaustedDetail}`,
      finalOutputComplete: false,
    }));
  }
  if (input.capacityBlock) {
    const c = input.capacityBlock;
    return deepFreezeTurn(assertTurnResultInvariants({
      ...base, execution: "BLOCKED", outcome: "NOT_ESTABLISHED", reason: "CONTEXT_CAPACITY_EXCEEDED",
      detail: `${c.estimatedPromptTokens}+${c.completionReserveTokens}+${c.toolResponseReserveTokens}>${c.contextLimit}`,
      finalOutputComplete: false, capacity: c,
    }));
  }
  if (input.limitReached && input.stopReason === "VERIFIER_NOT_CONVERGING" && this.turnConvergence) {
    return deepFreezeTurn(assertTurnResultInvariants({
      ...base, execution: "BLOCKED", outcome: "NOT_ESTABLISHED", reason: "VERIFIER_NOT_CONVERGING",
      detail: this.turnConvergence.evidence.slice(0, 300), finalOutputComplete: false, convergence: this.turnConvergence,
    }));
  }
  if (input.limitReached && input.stopReason === "NEEDS_INPUT" && this.pendingNeedsInput) {
    return deepFreezeTurn(assertTurnResultInvariants({
      ...base, execution: "BLOCKED", outcome: "NOT_ESTABLISHED", reason: "NEEDS_INPUT",
      detail: this.pendingNeedsInput.prompt.slice(0, 300), finalOutputComplete: false, needsInput: this.pendingNeedsInput,
      ...(this.furtherNeedsInput.length ? { furtherNeedsInput: [...this.furtherNeedsInput] } : {}),
    }));
  }
  if (input.limitReached && input.stopReason === "TOOL_CALL_LOOP" && this.turnRepeatedCall) {
    return deepFreezeTurn(assertTurnResultInvariants({
      ...base, execution: "BLOCKED", outcome: "NOT_ESTABLISHED", reason: "TOOL_CALL_LOOP",
      detail: input.stopDetail, finalOutputComplete: false, repeatedCall: this.turnRepeatedCall,
    }));
  }
  if (input.limitReached) {
    const stepPaused = input.stopReason === "STEP_PAUSED";
    return deepFreezeTurn(assertTurnResultInvariants({
      ...base,
      execution: "LIMIT_REACHED",
      outcome: "NOT_ESTABLISHED",
      reason: input.stopReason ?? "STEP_LIMIT_REACHED",
      ...(stepPaused ? { stepPaused: true } : {}),
      ...(input.stopDetail ? { detail: input.stopDetail } : {}),
      finalOutputComplete: false,
    }));
  }
  // A finished turn with operator requirements still open or blocked established nothing about the objective, whatever
  // the verifier said about the code (a failing verifier is the more specific reason and is reported below).
  const requirementsIncomplete = open.length > 0 || blocked.length > 0;
  // VC-9 row 8: in a headless run (`nexus run`) nobody is there to read "R3 is blocked" and reply, so a requirement the
  // model marked blocked ends the turn BLOCKED / NEEDS_INPUT with the blocker as a question. Other surfaces have an
  // operator or a client and keep REQUIREMENTS_INCOMPLETE; so does a requirement that is only still open.
  const blockedByModel = this.config.surface === "headless" && this.depth === 0 ? blocked.filter((r) => r.status === "blocked") : [];
  const blockedRequirementTurn = (): TurnResult | undefined => {
    if (!blockedByModel.length) return undefined;
    const [first, ...rest] = blockedByModel.map((r) => buildBlockedRequirementQuestion(r));
    const further = rest.filter((q, i) => q.id !== first.id && rest.findIndex((x) => x.id === q.id) === i);
    return deepFreezeTurn(assertTurnResultInvariants({
      ...base, execution: "BLOCKED", outcome: "NOT_ESTABLISHED", reason: "NEEDS_INPUT",
      detail: first.prompt.slice(0, 300), needsInput: first,
      ...(further.length ? { furtherNeedsInput: further } : {}),
    }));
  };
  // VC-9 row 7: steering that would drop a requirement went undecided in this turn (nobody could be asked, or the turn
  // closed first). It was not applied, so what the turn did is not what the operator last asked for: a turn that would
  // otherwise report completion ends BLOCKED / NEEDS_INPUT with the decision as the question.
  const steeringConflictTurn = (): TurnResult | undefined => {
    const undecided = (ledger?.steeringConflicts ?? []).filter((c: any) => c.status === "unresolved" && !c.carried);
    if (!undecided.length) return undefined;
    const [first, ...rest] = undecided.map((c: any) => buildSteeringConflictQuestion(c, safeOperatorText));
    return deepFreezeTurn(assertTurnResultInvariants({
      ...base, execution: "BLOCKED", outcome: "NOT_ESTABLISHED", reason: "NEEDS_INPUT",
      detail: first.prompt.slice(0, 300), needsInput: first,
      ...(rest.length ? { furtherNeedsInput: rest } : {}),
    }));
  };
  const incompleteDetail = () =>
    [open.length ? `open: ${open.map((r) => r.id).join(", ")}` : "", blocked.length ? `blocked: ${blocked.map((r) => `${r.id} (${r.note ?? "no reason"})`).join(", ")}` : ""]
      .filter(Boolean)
      .join("; ")
      .slice(0, 300);

  // A result that rests on observations compaction removed and the model never re-read may be recalled, not observed.
  const contextEvidenceLost = () => {
    const lost = Array.from(this.turnRemovedObservations);
    return deepFreezeTurn(assertTurnResultInvariants({
      ...base, execution: "COMPLETED", outcome: "UNVERIFIED", reason: "CONTEXT_EVIDENCE_NOT_RETAINED",
      detail: `${lost.length} tool output(s) removed by context compaction and not re-read: ${lost.slice(0, 3).join("; ")}`.slice(0, 300),
    }));
  };
  // A diagnostic run works on a snapshot of a failing candidate and is never integrated: its report is the result, and
  // no verifier can establish it (the candidate fails by definition), so what it wrote (reproduction scratch files in
  // a worktree that is never integrated) is not pending verification.
  const undecidedSteering = steeringConflictTurn();
  if (undecidedSteering) return undecidedSteering;
  if (this.config.diagnosticRun && !requirementsIncomplete) {
    if (this.turnRemovedObservations.size > 0) return contextEvidenceLost();
    return deepFreezeTurn(assertTurnResultInvariants({ ...base, unverifiedChangesPending: false, execution: "COMPLETED", outcome: "NOT_REQUIRED" }));
  }
  // Execution COMPLETED: derive the engineering outcome strictly from verifier evidence.
  if (this.hasPendingModifications) {
    if (evidence?.status === "PASSED" && evidence?.hasExecutedTests === false) {
      return deepFreezeTurn(assertTurnResultInvariants({
        ...base,
        execution: "COMPLETED",
        outcome: "UNVERIFIED",
        reason: "NO_TESTS_EXECUTED",
        detail: "Passing test run executed zero tests.",
      }));
    }
    if (evidence?.status === "FAILED") {
      return deepFreezeTurn(assertTurnResultInvariants({ ...base, execution: "COMPLETED", outcome: "NOT_ESTABLISHED", reason: "VERIFIER_FAILED", detail: evidence.command }));
    }
    if (evidence?.status === "TIMED_OUT") {
      return deepFreezeTurn(assertTurnResultInvariants({ ...base, execution: "COMPLETED", outcome: "NOT_ESTABLISHED", reason: "VERIFIER_TIMED_OUT", detail: `${evidence.command} (deadline ${evidence.deadlineSecs}s)` }));
    }
    if (requirementsIncomplete) {
      return blockedRequirementTurn() ?? deepFreezeTurn(assertTurnResultInvariants({ ...base, execution: "COMPLETED", outcome: "NOT_ESTABLISHED", reason: "REQUIREMENTS_INCOMPLETE", detail: incompleteDetail() }));
    }
    // A current task may have a trustworthy pre-change verifier snapshot but no operator-declared
    // deliverable scope. Its passing tests are regression evidence only; keep the obligation pending.
    // Recovered work is different: the snapshot itself is unauthenticated, so even that evidence
    // cannot support REGRESSION_FREE until a trusted baseline exists.
    // The recovered unbound marker is the exception: it never claims more than regression evidence.
    if (
      (!this.verificationBaselineInvalidated || (evidence?.definitionBound === false && this.recoveredUnboundVerifier?.command === evidence.command)) &&
      evidence?.status === "PASSED" &&
      evidence.hasExecutedTests === true &&
      (evidence.isDeliverableBound === false || evidence.definitionBound === false)
    ) {
      return deepFreezeTurn(assertTurnResultInvariants({
        ...base,
        execution: "COMPLETED",
        outcome: "REGRESSION_FREE",
        reason: "REGRESSION_FREE",
        detail: evidence.definitionBound === false
          ? `Tests pass, but ${evidence.independenceDetail ?? "the verifier's definition could not be bound, so it was not verified unchanged (the candidate could have edited it) and the pass is regression evidence only"}.`
          : "Passing test run did not cover the modified deliverables.",
      }));
    }
    const noVerifier = evidence?.status === "NO_APPLICABLE_VERIFIER" ||
      (!evidence && !this.config.authoritativeVerifierCommand?.trim() && !discoverVerifier(this.config.workspace));
    if (noVerifier && this.turnRemovedObservations.size > 0) {
      const lost = Array.from(this.turnRemovedObservations);
      return deepFreezeTurn(assertTurnResultInvariants({
        ...base,
        execution: "COMPLETED",
        outcome: "UNVERIFIED",
        reason: "CONTEXT_EVIDENCE_NOT_RETAINED",
        detail: `${lost.length} tool output(s) removed by context compaction and not re-read: ${lost.slice(0, 3).join("; ")}`.slice(0, 300),
      }));
    }
    return deepFreezeTurn(assertTurnResultInvariants({
      ...base, execution: "COMPLETED", outcome: "UNVERIFIED",
      reason: noVerifier ? "NO_APPLICABLE_VERIFIER" : "VERIFICATION_NOT_RUN",
    }));
  }
  if (requirementsIncomplete) {
    return blockedRequirementTurn() ?? deepFreezeTurn(assertTurnResultInvariants({ ...base, execution: "COMPLETED", outcome: "NOT_ESTABLISHED", reason: "REQUIREMENTS_INCOMPLETE", detail: incompleteDetail() }));
  }
  if ((this.turnMutations > 0 && !latchCaughtNothing) || this.turnCarriedChanges) {
    if (evidence?.status === "PASSED") {
      if (evidence.hasExecutedTests === false) {
        return deepFreezeTurn(assertTurnResultInvariants({
          ...base,
          execution: "COMPLETED",
          outcome: "UNVERIFIED",
          reason: "NO_TESTS_EXECUTED",
          detail: "Passing test run executed zero tests.",
        }));
      }
      // The verifier passed on the change; it does not show the change's content rests on what the model saw. Output
      // that left context during the turn and was not read again is counted on the result (CTX-03).
      const contextQualifier = this.turnRemovedObservations.size ? { contextNotRetained: this.turnRemovedObservations.size } : {};
      if (evidence.definitionBound === false) {
        return deepFreezeTurn(assertTurnResultInvariants({
          ...base,
          ...contextQualifier,
          execution: "COMPLETED",
          outcome: "REGRESSION_FREE",
          reason: "REGRESSION_FREE",
          detail: `Tests pass, but ${evidence.independenceDetail ?? "the verifier's definition could not be bound, so it was not verified unchanged (the candidate could have edited it) and the pass is regression evidence only"}.`,
        }));
      }
      if (evidence.isDeliverableBound === false) {
        return deepFreezeTurn(assertTurnResultInvariants({
          ...base,
          ...contextQualifier,
          execution: "COMPLETED",
          outcome: "REGRESSION_FREE",
          reason: "REGRESSION_FREE",
          detail: "Passing test run did not cover the modified deliverables.",
        }));
      }
      if (evidence.source !== "configured" && evidence.independent !== true) {
        return deepFreezeTurn(assertTurnResultInvariants({
          ...base,
          ...contextQualifier,
          execution: "COMPLETED",
          outcome: "REGRESSION_FREE",
          reason: "REGRESSION_FREE",
          detail: `Tests pass, but ${evidence.independenceDetail ?? "nothing independent of Nexus shows the change"}.`,
        }));
      }
      return deepFreezeTurn(assertTurnResultInvariants({ ...base, ...contextQualifier, execution: "COMPLETED", outcome: "VERIFIED" }));
    }
    // Defensive: changes were made, nothing is pending, yet no passing evidence is held.
    return deepFreezeTurn(assertTurnResultInvariants({ ...base, execution: "COMPLETED", outcome: "UNVERIFIED", reason: "VERIFICATION_NOT_RUN" }));
  }
  // The operator's verifier refused this turn's completion and the turn ended anyway (e.g. with a final answer).
  if (this.turnConfiguredVerifier === "FAILED" && (evidence?.status === "FAILED" || evidence?.status === "TIMED_OUT")) {
    return deepFreezeTurn(assertTurnResultInvariants({
      ...base, execution: "COMPLETED", outcome: "NOT_ESTABLISHED",
      reason: evidence.status === "FAILED" ? "VERIFIER_FAILED" : "VERIFIER_TIMED_OUT", detail: evidence.command,
    }));
  }
  // The operator's verifier must pass before any completion; a turn that ended without it passing (a final answer
  // without task_completed, or a dry-run or read-only turn, which never runs it) is not verified.
  if (this.configuredVerifierGatesCompletion() && this.turnConfiguredVerifier !== "PASSED") {
    return deepFreezeTurn(assertTurnResultInvariants({ ...base, execution: "COMPLETED", outcome: "UNVERIFIED", reason: "VERIFICATION_NOT_RUN" }));
  }
  // No verifier backs a read-only result, so it rests on the observations the model saw. If compaction removed some
  // and the model never re-read them, the result may be recalled rather than observed: it is not established.
  if (this.turnRemovedObservations.size > 0) return contextEvidenceLost();
  return deepFreezeTurn(assertTurnResultInvariants({ ...base, execution: "COMPLETED", outcome: "NOT_REQUIRED" }));
}

