import { isReadOnlyWorktreeArgs } from "./worktrunk/command.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { format as formatDiagnostic } from "node:util";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { AgentObserver } from "./agent.js";
import type { StartupEndpointProblem } from "./core/provider_recovery.js";
import { autoDetectModel, buildConfig, loadEnvironment, operatorConfigLoadError } from "./config.js";
import { withDurableSync, writePrivateFile } from "./core/durable_file.js";
import { isNexusDirPermissive } from "./doctor.js";
import { ApplicationCore } from "./core/app.js";
import { redactForPersistence, redactPathForOutput, SensitivePersistenceError } from "./core/persistence_protection.js";
import { TurnResult, failedTurnFromError, lifecycleStatusForTurn, summarizeTurn } from "./core/turn.js";
import { getGitInfo } from "./git.js";
import { redactSecrets, redactSecretPatterns } from "./ui.js";
import { approvalReview } from "./approval_review.js";
import { EvidenceLedger, LastTurn, MAX_DETAIL, MAX_DIFF_DETAIL, MAX_EVIDENCE, ReceiptSection, receiptSections, redactedJson } from "./evidence.js";
import { countDiffLines, previewDiff, visibleControls } from "./file_diff.js";
import type { ChatMessage, ApprovalMode } from "./types.js";
import { isWorkspaceTrusted } from "./workspace_trust.js";
import { STEERING_PREFIX } from "./core/objective.js";

/** Messages of a resumed conversation sent to the client, and the characters kept of each. */
const HISTORY_ENTRIES = 60;
const HISTORY_CHARS = 4000;
type CheckpointChoice = "read_only" | "without_checkpoint" | "retry" | "allow_sensitive" | "cancel" | "other";

export function readOnlySlashAllowed(command: string, args: string): boolean {
  const spec = findSlash(command);
  const name = spec?.name ?? command.trim().replace(/^\//, "").toLowerCase();
  const value = args.trim().toLowerCase();
  if (["help", "status", "tokens", "diff", "git", "checkpoints", "audit", "receipt", "sessions", "exit", "mode", "clear", "history", "skills"].includes(name)) return true;
  if (name === "checkpoint") return value === "diff" || value.startsWith("diff ");
  if (name === "worktree") return isReadOnlyWorktreeArgs(value);
  if (name === "plan" || name === "requirements" || name === "knowledge") return !value;
  if (name === "skill") return !value || !/^(init)(?:\s|$)/.test(value);
  if (name === "theme") return !value;
  return false;
}
import {
  DIFF_PREVIEW_CHARS,
  HistoryEntry,
  DIFF_PREVIEW_LINES,
  MAX_PASTE,
  MAX_SLASH_OUTPUT,
  MAX_SUMMARY,
  TOOL_PREVIEW_LINES,
  MAX_TEXT_FIELD,
  PROTOCOL_VERSION,
  SteerStatus,
  ProtocolError,
  SidecarCommand,
  SidecarEvent,
  capText,
  encodeEvent,
  parseCommand,
  projectTurn,
  providerRecoveryStatus,
  noProviderNotice,
  noProviderRefusal,
  toolSubject,
  toolSummary,
} from "./protocol.js";
import { OSC52_MAX_BYTES } from "./clipboard.js";
import { SlashHost, SlashOutcome, SlashSpec, errorText, findSlash, slashCatalog } from "./slash/catalog.js";
import { routeSlash } from "./slash/router.js";
import { surfaceFacts } from "./surface_facts.js";
import { buildCatalog } from "./model_catalog.js";
import { cancelLocalEndpointSetup, clearLocalEndpointSetup, clearLocalEndpointSetupAfterSelectionFailure, connectWithKey, disconnect, prepareLocalEndpoint, selectModel, startSignIn } from "./provider_connect.js";
import { isHarnessNote, withHarnessProvenance } from "./harness_notes.js";
import { persistableEndpoint } from "./core/endpoint_identity.js";

export interface SidecarOptions {
  app: ApplicationCore;
  /** Receives complete protocol lines (each ends with "\n"). */
  write: (line: string) => void;
  mode?: ApprovalMode;
  onShutdown?: () => void;
  /** Session to continue: an id, or "latest". */
  resume?: string;
  /** Prompt history file; defaults to ~/.nexus_history. */
  historyFile?: string;
}

/** Drives one ApplicationCore from protocol commands and reports its activity as protocol events. */
export class SidecarServer {
  private readonly app: ApplicationCore;
  private readonly write: (line: string) => void;
  private readonly onShutdown: () => void;
  private mode: ApprovalMode;
  private alwaysApprove = false;
  private activeTurn?: Promise<void>;
  private turnAbort?: AbortController;
  private pendingApproval?: { id: string; settle: (approved: boolean) => void };
  private pendingCheckpointChoice?: { id: string; choices: readonly CheckpointChoice[]; settle: (choice: CheckpointChoice) => void };
  private approvalSeq = 0;
  private shutdownPromise?: Promise<void>;
  private readonly resume?: string;
  private readonly history: string[];
  private sessionId: string;
  /** The running slash command; undefined for prompt turns and for commands that became turns. */
  private activeSpec?: SlashSpec;
  private readonly evidence = new EvidenceLedger();
  /** Evidence id → the complete diff written for that call (outlives the in-memory record). */
  private readonly diffFiles = new Map<string, string>();
  private lastTurn: LastTurn | null = null;
  /** Steering ids already received: a resend is acknowledged, never applied twice. */
  private readonly steerSeen = new Set<string>();
  /** Steering that arrived as a turn was finishing: it starts a follow-up turn once that turn ends. */
  private followUps: Array<{ id: string; text: string }> = [];
  /** /compact requests made while a command (not an agent turn) ran: run as their own job when it finishes. */
  private pendingCompactions: Array<{ ids: string[]; llm: boolean }> = [];
  /** Title of the session record (the latest turn's prompt), kept by saves made outside a turn. */
  private sessionTitle?: string;
  private readonly startupProbeAbort = new AbortController();
  /** Why start-up found no usable provider (D-07); cleared when a later probe succeeds. A prompt re-checks it before a turn starts. */
  private providerProblem?: StartupEndpointProblem;
  /** The start-up probe in flight (at most 3 s); a prompt waits for it so it is gated like any later one. */
  private startupProbe: Promise<void> = Promise.resolve();

  constructor(options: SidecarOptions) {
    this.app = options.app;
    this.write = options.write;
    const config = this.app.getConfig();
    this.mode = options.mode ?? config.approvalMode ?? (config.readOnly ? "read-only" : config.fullAccess ? "auto" : "review");
    this.app.getAgent().setApprovalMode(this.mode);
    this.onShutdown = options.onShutdown ?? (() => {});
    this.resume = options.resume;
    this.sessionId = this.app.getSessionManager().generateSessionId();
    // Compaction archives the originals beside the current session before the session names it as committed.
    this.app.getAgent().setArchiveSink((compactionId, messages) => this.app.getSessionManager().appendArchivedHistory(this.sessionId, messages, compactionId));
    // Outside a turn (an operator /compact), a commit still writes this session's record.
    this.app.getAgent().setProgressListener(() => this.saveSession(this.sessionTitle));
    this.history = loadPromptHistory(options.historyFile ?? path.join(os.homedir(), ".nexus_history"));
  }

  start(): void {
    this.emit({ type: "hello", protocol: PROTOCOL_VERSION, pid: process.pid, commands: slashCatalog() });
    let resumed: { ok: boolean; message: string } | undefined;
    try {
      resumed = this.resume ? this.resumeSession(this.resume) : undefined;
    } catch (err) {
      resumed = { ok: false, message: `Could not resume ${this.resume ?? "latest"}: ${errorText(err)}` };
    }
    // A resume that found nothing to restore is a fresh start: the model detection it skipped runs now.
    if (this.resume && !resumed?.ok) void this.app.getAgent().detectPlaceholderModel();
    this.emitSessionState();
    if (resumed) this.emit({ type: "notice", text: resumed.message });
    if (isNexusDirPermissive()) {
      this.emit({ type: "notice", text: "your Nexus state is readable by other users; run `nexus doctor --fix`" });
    }
    this.startupProbe = this.app.getAgent().probeEndpointProblem(this.startupProbeAbort.signal).then((problem) => {
      if (problem && !this.shutdownPromise) {
        // Only "nothing answers" gates prompts. A rejection on /models is a warning: the chat path refreshes tokens and
        // may accept a key the model list refuses, so the turn is left to decide.
        if (problem.blocking) this.providerProblem = problem;
        this.emit({ type: "notice", ...noProviderNotice(problem) });
      }
    }).catch(() => {});
  }

  /** Resolves once no turn is running. */
  async idle(): Promise<void> {
    while (this.activeTurn) await this.activeTurn;
  }

  async handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let command: SidecarCommand;
    try {
      command = parseCommand(line);
    } catch (err) {
      const id = err instanceof ProtocolError ? err.id : undefined;
      this.emit({ type: "error", ...(id ? { id } : {}), code: "BAD_REQUEST", message: (err as Error).message });
      return;
    }
    switch (command.type) {
      case "prompt.submit":
        this.submit(command.id, command.text);
        return;
      case "steer":
        this.steer(command.id, command.text);
        return;
      case "cancel":
        this.cancel();
        return;
      case "approve":
        this.resolveApproval(command.id, true, command.always);
        return;
      case "deny":
        this.resolveApproval(command.id, false, false);
        return;
      case "checkpoint.choice":
        this.resolveCheckpointChoice(command.id, command.choice);
        return;
      case "slash":
        this.slash(command.id, command.command, command.args);
        return;
      case "tool.detail":
      case "receipt":
        try {
          if (command.type === "tool.detail") this.toolDetail(command.id, command.evidence);
          else this.emit({ type: "receipt", id: command.id, sections: this.receipt() });
        } catch (err) {
          const message = errorText(err);
          this.emit({ type: "error", id: command.id, code: "INTERNAL", message });
        }
        return;
      case "models.list":
        if (this.app.getAgent().getApprovalMode() === "read-only") {
          this.emit({ type: "error", id: command.id, code: "BUSY", message: "Provider discovery is disabled while the session is in read-only mode." });
          return;
        }
        void this.modelsList(command.id);
        return;
      case "model.select":
        if (this.app.getAgent().getApprovalMode() === "read-only") {
          this.emit({ type: "error", id: command.id, code: "BUSY", message: "Model changes are disabled while the session is in read-only mode." });
          return;
        }
        this.modelSelect(command.id, command.provider, command.model);
        return;
      case "provider.connect":
        if (this.app.getAgent().getApprovalMode() === "read-only") {
          this.emit({ type: "provider.result", id: command.id, provider: command.provider, success: false, message: "Provider connections are disabled while the session is in read-only mode." });
          return;
        }
        void this.providerConnect(command.id, command.provider, command.method, command.key, command.endpoint);
        return;
      case "provider.cancel":
        this.signIns.get(command.id)?.cancel();
        this.signIns.delete(command.id);
        cancelLocalEndpointSetup(command.id);
        return;
      case "provider.local-cancel":
        clearLocalEndpointSetup(command.id);
        return;
      case "provider.disconnect": {
        if (this.app.getAgent().getApprovalMode() === "read-only") {
          this.emit({ type: "provider.result", id: command.id, provider: command.provider, success: false, message: "Provider changes are disabled while the session is in read-only mode." });
          return;
        }
        const r = disconnect(command.provider);
        this.emit({ type: "provider.result", id: command.id, provider: command.provider, success: r.ok, message: r.message });
        return;
      }
      case "shutdown":
        await this.shutdown();
        return;
    }
  }

  /** Sign-ins in progress, by request id (provider.cancel stops one). */
  private signIns = new Map<string, { cancel(): void }>();

  private async modelsList(id: string): Promise<void> {
    try {
      const catalog = await buildCatalog(this.app.getConfig());
      this.emit({ type: "models.catalog", id, ...catalog });
    } catch (err) {
      this.emit({ type: "error", id, code: "INTERNAL", message: errorText(err) });
    }
  }

  /** Switching models between turns is the operator's choice; during a turn it is refused like any command. */
  private modelSelect(id: string, provider: string, model: string): void {
    if (this.rejectBusy(id)) return;
    const r = selectModel(this.app.getAgent(), this.app.getConfig(), { provider, model });
    if (!r.ok && provider === "appliance") clearLocalEndpointSetupAfterSelectionFailure();
    this.emit({ type: "model.result", id, success: r.ok, message: r.message });
    if (r.ok) this.emitSessionState();
  }

  private async providerConnect(id: string, provider: string, method: string, key?: string, endpoint?: string): Promise<void> {
    const result = (success: boolean, message: string) =>
      this.emit({ type: "provider.result", id, provider: provider, success, message: message });
    try {
      if (provider === "appliance" && method === "local-endpoint") {
        if (!endpoint) {
          result(false, "An endpoint URL is required.");
          return;
        }
        const prepared = await prepareLocalEndpoint(this.app.getConfig(), endpoint, key ?? "", id);
        if (!prepared.cancelled) result(prepared.ok, prepared.message);
        return;
      }
      if (method === "api-key") {
        const r = await connectWithKey(this.app.getConfig(), provider, key ?? "");
        result(r.ok, r.message);
        return;
      }
      if (endpoint !== undefined) {
        result(false, "Endpoint URLs are only accepted for local endpoint setup.");
        return;
      }
      const signIn = await startSignIn(this.app.getConfig(), provider, method);
      this.signIns.set(id, signIn);
      this.emit({
        type: "provider.auth",
        id,
        provider,
        url: signIn.prompt.url,
        ...(signIn.prompt.userCode ? { user_code: signIn.prompt.userCode } : {}),
        instructions: signIn.prompt.instructions,
      });
      const r = await signIn.done;
      this.signIns.delete(id);
      result(r.ok, r.message);
    } catch (err) {
      this.signIns.delete(id);
      result(false, String((err as Error).message ?? err));
    }
  }

  private steerAck(id: string, status: SteerStatus, message: string, text?: string): void {
    this.emit({ type: "steer.ack", id, status, message, ...(text !== undefined ? { text: text } : {}) });
  }

  /**
   * Operator steering while work runs. Held by the agent and applied at its next step boundary; if the turn is already
   * finishing it starts a follow-up turn; if nothing is running it starts a turn. Never applied twice, never dropped
   * without telling the client (which then gets the text back).
   */
  private steer(id: string, text: string): void {
    // Seen by this process, or recorded in the session's objective ledger (applied before a restart and resume).
    if (this.steerSeen.has(id) || this.app.getAgent().getObjective()?.steering.some((s) => s.id === id)) {
      this.steerAck(id, "duplicate", "Already received; it is not applied again.");
      return;
    }
    this.steerSeen.add(id);
    if (this.shutdownPromise) {
      this.steerAck(id, "rejected", "The sidecar is shutting down; your message was not applied.", text);
      return;
    }
    if (!this.activeTurn) {
      this.runJob(id, undefined, (signal) =>
        this.gatedTurn(id, text, signal, {
          admitted: () => {
            this.history.push(text.trim());
            this.steerAck(id, "applied", "Nothing was running, so your message started a new turn.");
          },
          refused: (message) => this.steerAck(id, "cancelled", `${message} Your message is back in the composer.`, text),
        }),
      );
      return;
    }
    if (this.activeSpec) {
      const name = this.activeSpec.name === "!" ? "!" : `/${this.activeSpec.name}`;
      this.steerAck(id, "rejected", `${name} is running, and steering applies to agent turns; your message is back in the composer.`, text);
      return;
    }
    const queued = this.app.getAgent().queueSteering(id, text);
    if (queued.status === "queued") {
      this.history.push(text.trim());
      this.steerAck(id, "queued", "Steering queued; the agent applies it at its next step.");
      return;
    }
    if (queued.status === "duplicate") {
      this.steerAck(id, "duplicate", "Already received; it is not applied again.");
      return;
    }
    this.followUps.push({ id, text });
    this.steerAck(id, "deferred", "The turn is finishing; your message starts a follow-up turn as soon as it ends.");
  }

  /** Runs deferred steering as one follow-up turn under the first message's id. */
  private startFollowUp(): void {
    const followUps = this.followUps;
    this.followUps = [];
    const id = followUps[0].id;
    const text = followUps.map((f) => f.text).join("\n\n");
    this.runJob(id, undefined, (signal) =>
      this.gatedTurn(id, text, signal, {
        admitted: () => {
          for (const f of followUps) {
            this.history.push(f.text.trim());
            this.steerAck(f.id, "applied", "Applied as a follow-up turn.");
          }
        },
        refused: (message) => {
          for (const f of followUps) this.steerAck(f.id, "cancelled", `${message} Your message is back in the composer.`, f.text);
        },
      }),
    );
  }

  private cancel(): void {
    for (const f of this.followUps) this.steerAck(f.id, "cancelled", "Cancelled with the turn before it could start; your message is back in the composer.", f.text);
    this.followUps = [];
    this.dropPendingCompactions("cancelled with the running work");
    const spec = this.activeSpec;
    if (this.activeTurn && spec && !spec.cancellable) {
      const name = spec.name === "!" ? "!" : `/${spec.name}`;
      this.emit({ type: "notice", text: `${name} cannot be cancelled; it finishes on its own.` });
      return;
    }
    this.turnAbort?.abort(new Error("operator cancel"));
  }

  /** Reports BUSY for `id` when a turn or command is running or the sidecar is shutting down. */
  private rejectBusy(id: string): boolean {
    if (!this.shutdownPromise && !this.activeTurn) return false;
    const message = this.shutdownPromise ? "The sidecar is shutting down." : "A turn or command is running; cancel it or wait for its result.";
    this.emit({ type: "error", id, code: "BUSY", message });
    return true;
  }

  /**
   * /compact while a turn or command runs. During an agent turn the agent holds it until the turn's next step boundary
   * (after the in-flight inference and its tool batch, approvals included, have settled) or the turn's end. While another
   * command runs, it waits here and runs as its own job afterwards. Each request is acknowledged now (notice) and gets
   * its outcome later (slash.result for its id). A duplicate shares the queued request's outcome; at most one request
   * per kind (default, --llm) waits; cancellation and shutdown end waiting requests with that outcome.
   */
  private queueCompaction(id: string, llm: boolean): void {
    const queued = this.app.getAgent().requestCompaction(id, llm);
    if (queued.status !== "no_active_turn") {
      this.emit({ type: "notice", text: queued.message });
      return;
    }
    const existing = this.pendingCompactions.find((p) => p.llm === llm);
    if (existing) {
      existing.ids.push(id);
      this.emit({ type: "notice", text: `A /compact${llm ? " --llm" : ""} is already waiting; this request shares its outcome.` });
      return;
    }
    this.pendingCompactions.push({ ids: [id], llm });
    this.emit({ type: "notice", text: `/compact${llm ? " --llm" : ""} queued: it runs when the current command finishes.` });
  }

  private compactionResult(ids: string[], ok: boolean, message: string): void {
    for (const id of ids) this.emit({ type: "slash.result", id, command: "compact", success: ok, output: message });
  }

  /** Ends waiting /compact requests that will not run. */
  private dropPendingCompactions(reason: string): void {
    for (const p of this.pendingCompactions) this.compactionResult(p.ids, false, `/compact was not run: ${reason}.`);
    this.pendingCompactions = [];
  }

  /** Runs one turn or command as the session's only activity. Busy is reported before `body` starts. */
  private runJob(id: string, spec: SlashSpec | undefined, body: (signal: AbortSignal) => Promise<void>): void {
    const abort = new AbortController();
    this.turnAbort = abort;
    this.activeSpec = spec;
    let settle!: () => void;
    this.activeTurn = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.emitSessionState();
    void body(abort.signal)
      .catch((err) => this.emit({ type: "error", id, code: "INTERNAL", message: errorText(err) }))
      .finally(() => {
        this.activeTurn = undefined;
        this.turnAbort = undefined;
        this.activeSpec = undefined;
        // Queued /compact runs before anything else starts, without an idle state in between.
        if (this.pendingCompactions.length && !this.shutdownPromise) {
          const pending = this.pendingCompactions;
          this.pendingCompactions = [];
          settle();
          this.runJob(pending[0].ids[0], findSlash("compact"), async (signal) => {
            for (const p of pending) {
              const result = await this.app.getAgent().compactNow(p.llm, signal);
              this.compactionResult(p.ids, result.ok, result.message);
            }
          });
          return;
        }
        if (this.pendingCompactions.length) this.dropPendingCompactions("the sidecar is shutting down");
        // Deferred steering starts its turn without an idle state in between, so nothing can slip into the gap.
        if (this.followUps.length && !this.shutdownPromise) {
          settle();
          this.startFollowUp();
          return;
        }
        this.emitSessionState();
        settle();
      });
  }

  private submit(id: string, text: string): void {
    if (this.rejectBusy(id)) return;
    this.runJob(id, undefined, (signal) =>
      this.gatedTurn(id, text, signal, {
        admitted: () => this.history.push(text.trim()),
        refused: (message) => this.emit({ type: "error", id, code: "NO_PROVIDER", message }),
      }),
    );
  }

  /**
   * The one way a prompt, a steer that starts a turn and a follow-up start a turn. When start-up found nothing answering,
   * it waits for that probe, asks again (the operator may have connected a provider or started a server since) and
   * refuses with the reason rather than entering a retry loop. A cancelled probe says nothing about the provider: the
   * gate stays and the turn does not run.
   */
  private async gatedTurn(
    id: string,
    text: string | any[],
    signal: AbortSignal,
    hooks: { admitted?: () => void; refused: (message: string) => void },
    turnArgs?: { title?: string; checkpoint?: string; step?: boolean },
  ): Promise<void> {
    // Cancelled while the gate was checking: the message is reported back (never silently dropped), not run.
    const cancelled = "Cancelled before it was sent.";
    await this.startupProbe;
    // With no known problem a cancel is the turn's own business (it reports INTERRUPTED); only the gate reports it here.
    if (this.providerProblem) {
      const problem = await this.app.getAgent().probeEndpointProblem(signal);
      if (signal.aborted) return hooks.refused(cancelled);
      this.providerProblem = problem?.blocking ? problem : undefined;
      if (this.providerProblem) {
        hooks.refused(noProviderRefusal(this.providerProblem));
        return;
      }
    }
    hooks.admitted?.();
    await this.turn(id, text, turnArgs?.title ?? String(text), turnArgs?.checkpoint ?? `Turn: ${String(text).slice(0, 30)}`, signal, turnArgs?.step);
  }

  private observerFor(turnId: string): AgentObserver {
    const open = new Map<number, string>();
    // The evidence ledger is a sink of its own, so its copy of the tool name is sanitized before it is stored; the events carry the raw name.
    return {
      onAssistantDelta: (delta) => this.emit({ type: "assistant.delta", turn_id: turnId, text: delta }),
      onToolStart: ({ dispatch, callId, tool: rawTool, args }) => {
        const tool = rawTool;
        const subject = toolSubject(args);
        const evidence = this.evidence.start(turnId, redactThenCap(rawTool, 200), subject, args);
        open.set(dispatch, evidence);
        this.emit({ type: "tool.start", turn_id: turnId, call_id: callId, tool, subject, evidence });
      },
      onToolEnd: ({ dispatch, callId, tool: rawTool, success, output, error }) => {
        const tool = rawTool;
        const evidence = open.get(dispatch) ?? "";
        open.delete(dispatch);
        this.evidence.end(evidence, success, output, error);
        const summary = toolSummary(success, output, error);
        this.emit({
          type: "tool.end", turn_id: turnId, call_id: callId, tool, success, evidence,
          ...summary,
        });
      },
      onProviderRecovery: ({ record, discardedPartialOutput }) => {
        const status = providerRecoveryStatus(record, discardedPartialOutput);
        if (status) this.emit({ type: "notice", ...status });
      },
      onStreamStall: ({ stalled, silentSecs }) =>
        this.emit({ type: "stream.stall", turn_id: turnId, stalled, silent_secs: silentSecs }),
      onActivity: ({ phase, step, segment, tool, subject }) =>
        this.emit({
          type: "activity",
          turn_id: turnId,
          phase,
          step,
          segment,
          ...this.budget(),
          ...(tool ? { tool: tool } : {}),
          ...(subject ? { subject: subject } : {}),
        }),
      onFileChange: ({ dispatch, callId, path: file, change }) => {
        const evidence = open.get(dispatch) ?? "";
        const safe = formatSafeSidecarText(change.diff);
        const fullPath = this.keepOperationDiff(evidence, callId, safe);
        this.evidence.attachDiff(evidence, safe, fullPath);
        const { preview, truncated, totalLines } = previewDiff(safe, DIFF_PREVIEW_LINES, DIFF_PREVIEW_CHARS);
        this.emit({
          type: "file.diff",
          turn_id: turnId,
          call_id: callId,
          evidence,
          path: file,
          kind: change.kind,
          added: change.added,
          removed: change.removed,
          preview,
          truncated,
          total_lines: totalLines,
          diff_lines: countDiffLines(safe),
          hunks: change.hunks ?? 0,
          ...(fullPath ? { full_path: fullPath } : {}),
          ...(change.note ? { note: change.note } : {}),
        });
      },
      onContinuation: ({ kind, n, max, detail }) => {
        const text =
          kind === "requirements"
            ? `Requirements still open (${redactThenCap(detail, 120)}): Nexus asked the agent to continue (${n} of ${max}).`
            : `The agent repeated ${redactThenCap(detail, 200)} with an unchanged result: Nexus told it to change approach (${n} of ${max}).`;
        this.emit({ type: "notice", text: text });
      },
      onNotice: (text) => this.emit({ type: "notice", text: text }),
      onCompaction: ({ id, ok, message }) => this.compactionResult([id], ok, message),
      onSteering: ({ id, status, step, text, reason }) => {
        if (status === "applied") this.steerAck(id, "applied", `Applied at step ${step}.`);
        else this.steerAck(id, "cancelled", `Not applied: ${reason ?? "the turn ended first"}. Your message is back in the composer.`, text);
      },
    };
  }

  /** The running turn's budget as the client shows it: total steps (across segments) and the time limit. */
  private budget(): { max_steps: number; max_minutes?: number } {
    const config = this.app.getConfig();
    const continuation = config.continuation;
    // Only limits the operator set are shown as limits; an unbounded budget sends none (the client shows "step N").
    if (!continuation) return { max_steps: config.maxSteps };
    return {
      ...(Number.isFinite(continuation.maxTotalSteps) ? { max_steps: continuation.maxTotalSteps } : {}),
      ...(Number.isFinite(continuation.maxTurnMinutes) ? { max_minutes: continuation.maxTurnMinutes } : {}),
    } as { max_steps: number; max_minutes?: number };
  }

  private confirmFor(turnId: string, signal: AbortSignal) {
    return (tool: string, args: Record<string, any>) => {
      if (this.alwaysApprove) return Promise.resolve(true);
      return this.requestApproval(turnId, signal, tool, args);
    };
  }

  /** One agent turn: checkpoint, run, save the session, report the result. `step`: one cycle of the unfinished objective. */
  private async turn(turnId: string, prompt: string | any[], label: string, checkpoint: string, signal: AbortSignal, step = false): Promise<void> {
    const agent = this.app.getAgent();
    let allowSensitiveCheckpoint = false;
    try {
      agent.enterNamedWorktreeBeforeTurn(); // the snapshot is of the worktree the turn edits
    } catch (err) {
      this.emit({ type: "error", id: turnId, code: "INTERNAL", message: formatSafeSidecarText(errorText(err)) });
      return;
    }
    if (this.app.getConfig().readOnly) {
      // Read-only turns cannot change the workspace, so a workspace rollback snapshot is unnecessary.
      agent.setCheckpointReadOnlyFallback(false);
    } else {
      let checkpointReady = false;
      while (!checkpointReady) {
        try {
          this.app.getCheckpointManager().createCheckpoint(
            checkpoint,
            allowSensitiveCheckpoint ? { allowSensitive: true } : undefined,
          );
          const previousApprovalMode = agent.getApprovalMode();
          agent.setCheckpointReadOnlyFallback(false);
          if (agent.getApprovalMode() !== previousApprovalMode) this.emitSessionState();
          checkpointReady = true;
        } catch (err) {
          const sensitiveContentBlocked = err instanceof SensitivePersistenceError;
          const failure = capText(
            formatSafeSidecarText(errorText(err))
              .replace(/\s+/g, " ")
              .trim()
              .replace(/;\s*no checkpoint was written\.?$/i, ""),
            100,
          );
          const message = sensitiveContentBlocked
            ? undefined
            : `Checkpoint failed: ${failure}. No checkpoint was written. Choose 1 read-only, 2 continue without a rollback checkpoint, 3 retry checkpoint normally, 4 cancel this turn, or 5 re-enter the instruction.`;
          const choices: readonly CheckpointChoice[] = sensitiveContentBlocked
            ? ["read_only", "without_checkpoint", "allow_sensitive", "cancel", "other"]
            : ["read_only", "without_checkpoint", "retry", "cancel", "other"];
          const choice = await this.requestCheckpointChoice(turnId, signal, message, choices);
          if (choice === "cancel" || choice === "other") {
            const message = choice === "other"
              ? "This turn was not started. Enter a different instruction in the composer."
              : "This turn was cancelled before it started.";
            this.emit({ type: "error", id: turnId, code: "INTERNAL", message });
            return;
          }
          if (choice === "read_only") {
            agent.setCheckpointReadOnlyFallback(true);
            this.emit({ type: "notice", text: "Continuing this turn in read-only mode as requested. Workspace changes, unsafe commands, external actions, and delegation are disabled." });
            this.emitSessionState();
            checkpointReady = true;
          } else if (choice === "without_checkpoint") {
            const previousApprovalMode = agent.getApprovalMode();
            agent.setCheckpointReadOnlyFallback(false);
            if (agent.getApprovalMode() !== previousApprovalMode) this.emitSessionState();
            this.emit({ type: "notice", text: "Continuing in the current mode without a rollback checkpoint, as requested." });
            checkpointReady = true;
          } else if (choice === "retry") {
            this.emit({ type: "notice", text: "Retrying checkpoint without changing sensitive-persistence settings. The turn remains paused until the retry succeeds or you choose another option." });
          } else if (choice === "allow_sensitive") {
            allowSensitiveCheckpoint = true;
            this.emit({ type: "notice", text: "Retrying checkpoint with sensitive persistence allowed, as requested; this may persist sensitive workspace content. The turn will wait until the retry succeeds or you choose another option." });
          }
        }
      }
    }
    if (typeof prompt === "string" && !step) {
      const decision = agent.objectiveDecision(prompt);
      if (decision.kind === "amend") {
        this.emit({
          type: "notice",
          text: `This message continues the unfinished objective (${decision.unresolved} unresolved requirement${decision.unresolved === 1 ? "" : "s"}); its numbered items, if any, are added to it. /requirements clear starts a new objective.`,
        });
      }
    }
    agent.setObserver(this.observerFor(turnId));
    this.sessionTitle = label;
    // Work done so far, and changes still awaiting verification, survive the process ending mid-turn.
    agent.setProgressListener(() => this.saveSession(label));
    let turn: TurnResult;
    try {
      turn = await agent.runTurn(prompt, this.confirmFor(turnId, signal), step ? { signal, step: true, resume: true } : { signal });
    } catch (err) {
      turn = failedTurnFromError(err, this.app.getConfig().maxSteps, agent.hasUnverifiedChanges());
    } finally {
      agent.setObserver(undefined);
      agent.setProgressListener(() => this.saveSession(this.sessionTitle));
    }
    let saved: boolean;
    try {
      saved = withDurableSync(() => this.saveSession(label, turn));
    } catch (err) {
      saved = false;
      this.emit({ type: "notice", text: `The session could not be saved: ${errorText(err)}` });
    }
    const { heading, line } = summarizeTurn(turn);
    const projected = projectTurn(turn);
    this.lastTurn = { heading, turn: projected };
    const summary = turn.execution === "COMPLETED" ? agent.getCompletionSummary() : undefined;
    this.emit({
      type: "turn.result",
      turn_id: turnId,
      heading: heading,
      line: line,
      turn: projected,
      model_summary: summary
        ? { summary: summary.summary, ...(summary.notes ? { notes: summary.notes } : {}) }
        : null,
      saved,
    });
  }

  private requestApproval(turnId: string, signal: AbortSignal, tool: string, args: Record<string, any>): Promise<boolean> {
    if (this.alwaysApprove) return Promise.resolve(true);
    if (signal.aborted) return Promise.resolve(false);
    const id = `approval-${++this.approvalSeq}`;
    return new Promise<boolean>((resolve) => {
      const onAbort = () => settle(false);
      const settle = (approved: boolean) => {
        signal.removeEventListener("abort", onAbort);
        this.pendingApproval = undefined;
        resolve(approved);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pendingApproval = { id, settle };
      this.emit({
        type: "approval.request",
        id,
        turn_id: turnId,
        tool,
        subject: toolSubject(args),
        preview: redactedJson(args),
        review: approvalReview(tool, args, this.app.getConfig().workspace),
      });
    });
  }

  private resolveApproval(id: string, approved: boolean, always: boolean): void {
    const pending = this.pendingApproval;
    if (!pending || pending.id !== id) {
      this.emit({ type: "error", id, code: "NO_PENDING_APPROVAL", message: `No pending approval with id ${id}.` });
      return;
    }
    if (approved && always) {
      this.alwaysApprove = true;
      this.mode = "auto";
      this.app.getAgent().setApprovalMode("auto");
      this.emitSessionState();
    }
    pending.settle(approved);
  }

  private requestCheckpointChoice(
    turnId: string,
    signal: AbortSignal,
    message = "Sensitive content blocked the checkpoint. Choose 1 read-only, 2 continue without a rollback checkpoint, 3 create a checkpoint anyway (may persist sensitive content), 4 cancel this turn, or 5 re-enter the instruction.",
    choices: readonly CheckpointChoice[] = ["read_only", "without_checkpoint", "allow_sensitive", "cancel", "other"],
  ): Promise<CheckpointChoice> {
    if (signal.aborted) return Promise.resolve("cancel");
    const id = `checkpoint-choice-${++this.approvalSeq}`;
    return new Promise((resolve) => {
      const settle = (choice: CheckpointChoice) => {
        signal.removeEventListener("abort", onAbort);
        this.pendingCheckpointChoice = undefined;
        resolve(choice);
      };
      const onAbort = () => settle("cancel");
      signal.addEventListener("abort", onAbort, { once: true });
      this.pendingCheckpointChoice = { id, choices, settle };
      this.emit({
        type: "checkpoint.choice.request",
        id,
        turn_id: turnId,
        message,
      });
    });
  }

  private resolveCheckpointChoice(id: string, choice: CheckpointChoice): void {
    const pending = this.pendingCheckpointChoice;
    if (!pending || pending.id !== id) {
      this.emit({ type: "error", id, code: "NOT_FOUND", message: `No pending checkpoint choice with id ${id}.` });
      return;
    }
    if (!pending.choices.includes(choice)) {
      this.emit({ type: "error", id, code: "BAD_REQUEST", message: "That choice is not available for this checkpoint failure." });
      return;
    }
    pending.settle(choice);
  }

  private slash(id: string, command: string, args: string): void {
    if (this.app.getAgent().getApprovalMode() === "read-only" && !readOnlySlashAllowed(command, args)) {
      this.emit({
        type: "slash.result",
        id,
        command: command.trim().replace(/^\//, "").toLowerCase(),
        success: false,
        output: "This command is disabled while the session is in read-only mode.",
      });
      return;
    }
    // /compact while work runs is queued, never refused or run concurrently: see queueCompaction.
    if (command.trim().replace(/^\//, "").toLowerCase() === "compact" && this.activeTurn && !this.shutdownPromise) {
      this.queueCompaction(id, args.split(/\s+/).includes("--llm"));
      return;
    }
    // Read-only diagnostics run beside a turn: they touch no conversation or workspace state the turn uses.
    if (this.activeTurn && !this.shutdownPromise && busySafe(command, args)) {
      void this.busySafeSlash(id, command, args);
      return;
    }
    if (this.rejectBusy(id)) return;
    this.runJob(id, findSlash(command), async (signal) => {
      const agent = this.app.getAgent();
      agent.setObserver(this.observerFor(id));
      let outcome: SlashOutcome;
      try {
        outcome = await routeSlash(this.slashHost(id), command, args, signal);
      } finally {
        agent.setObserver(undefined);
      }
      if (outcome.kind === "turn") {
        this.activeSpec = undefined;
        await this.gatedTurn(
          id,
          outcome.prompt,
          signal,
          {
            admitted: () => this.emit({ type: "slash.result", id, command: outcome.command, success: true, output: "", prompt: outcome.label }),
            refused: (message) => this.emit({ type: "error", id, code: "NO_PROVIDER", message }),
          },
          { title: outcome.title ?? outcome.label, checkpoint: outcome.checkpoint, step: outcome.step },
        );
        return;
      }
      if (outcome.command === "clear" && outcome.success) this.lastTurn = null;
      this.emit({
        type: "slash.result",
        id,
        command: outcome.command,
        success: outcome.success,
        // A diff keeps what the files say: control characters are made visible rather than removed.
        output: outcome.output,
        ...(outcome.format ? { format: outcome.format } : {}),
        ...(outcome.composer !== undefined ? { composer: outcome.composer } : {}),
        ...(outcome.clipboard !== undefined ? { clipboard: outcome.clipboard } : {}),
      });
    });
  }

  private async busySafeSlash(id: string, command: string, args: string): Promise<void> {
    try {
      const outcome = await routeSlash(this.slashHost(id), command, args, new AbortController().signal);
      if (outcome.kind !== "reply") throw new Error(`/${command} cannot start a turn while another is running`);
      this.emit({
        type: "slash.result",
        id,
        command: outcome.command,
        success: outcome.success,
        output: outcome.output,
        ...(outcome.clipboard !== undefined ? { clipboard: outcome.clipboard } : {}),
      });
    } catch (err) {
      this.emit({ type: "error", id, code: "INTERNAL", message: errorText(err) });
    }
  }

  private slashHost(id: string): SlashHost {
    return {
      app: this.app,
      mode: () => this.app.getAgent().getApprovalMode(),
      setMode: (mode) => {
        this.mode = mode as ApprovalMode;
        this.app.getAgent().setApprovalMode(this.mode);
        if (this.mode !== "auto") this.alwaysApprove = false;
        this.emitSessionState();
      },
      sessionId: () => this.sessionId,
      setSessionId: (sessionId) => {
        this.sessionId = sessionId;
      },
      checkpoints: () => this.app.getCheckpointManager(),
      setWorkspace: (dir) => this.setWorkspace(dir),
      saveSession: (title) => this.saveSession(title),
      resumeSession: (sessionId) => this.resumeSession(sessionId),
      history: () => this.history,
      confirm: (signal) => this.confirmFor(id, signal),
      requestApproval: (tool, args, signal) => this.requestApproval(id, signal, tool, args),
      receipt: () => this.receipt(),
    };
  }

  /**
   * Writes an operation's complete (already redacted) diff beside the saved session, so it can be reviewed whole
   * after the in-memory record is cut to MAX_DIFF_DETAIL or dropped with the oldest records. Returns its path, or
   * undefined when it could not be written (the in-memory record is then the only copy, and says so).
   */
  private keepOperationDiff(evidence: string, callId: string, diff: string): string | undefined {
    if (!diff) return undefined;
    try {
      const name = `${evidence}-${callId}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
      const file = this.app.getSessionManager().operationDiffPath(this.sessionId, name);
      writePrivateFile(file, diff.endsWith("\n") ? diff : `${diff}\n`);
      this.diffFiles.set(evidence, file);
      return file;
    } catch {
      return undefined;
    }
  }

  private toolDetail(id: string, evidence: string): void {
    const record = this.evidence.get(evidence);
    const kept = this.diffFiles.get(evidence);
    if (!record && kept) {
      // The record was dropped with the oldest; the complete diff is still on disk.
      let diff = "";
      try {
        diff = fs.readFileSync(kept, "utf8").replace(/\n$/, "");
      } catch {}
      if (diff) {
        this.emit({
          type: "tool.detail",
          id,
          evidence,
          tool: "",
          subject: "",
          status: "succeeded",
          args: "(not kept: only the latest " + MAX_EVIDENCE + " tool calls keep their arguments and output)",
          output: "",
          duration_ms: null,
          diff: diff,
          diff_chars: diff.length,
          diff_path: kept,
        });
        return;
      }
    }
    if (!record) {
      const message = `No record of tool call ${evidence}; only the latest ${MAX_EVIDENCE} are kept.`;
      this.emit({ type: "error", id, code: "NOT_FOUND", message });
      return;
    }
    this.emit({
      type: "tool.detail",
      id,
      evidence,
      tool: record.tool,
      subject: record.subject,
      status: record.status,
      args: record.args,
      output: record.output,
      duration_ms: record.durationMs,
      ...(record.diff ? { diff: record.diff, diff_chars: record.diffChars ?? record.diff.length } : {}),
      ...(record.diffPath ? { diff_path: record.diffPath } : {}),
    });
  }

  private receipt(): ReceiptSection[] {
    return receiptSections(this.lastTurn, this.app.getActiveValidationReceipt() ?? null, this.app.getAgent().getObjective());
  }

  private setWorkspace(dir: string): void {
    this.app.getAgent().setWorkspace(dir);
    this.app.getConfig().workspace = dir; // the app's checkpoint manager follows the workspace
  }

  /** Same record the REPL saves after each turn. Skipped (false) while the conversation holds only the system prompt; true once written. */
  private saveSession(title?: string, turn?: TurnResult): boolean {
    const agent = this.app.getAgent();
    const messages = agent.getMessages();
    if (messages.length <= 1) return false;
    const config = this.app.getConfig();
    const now = new Date().toISOString();
    const manager = this.app.getSessionManager();
    // Originals compaction replaced are archived beside the session by the agent's archive sink before this record
    // (which names the committed compactions in `history`) is written.
    const receipt = this.app.getActiveValidationReceipt();
    const lastTurn = turn ?? agent.getLastTurnResult();
    // The recovery fields live in the agent's durable checkpoint; the session record replaces the whole task record.
    const durableState = this.app.getTaskState();
    manager.saveSession(
      {
        id: this.sessionId,
        title: title ? title.slice(0, 60).replace(/\n/g, " ") : "Active Session",
        createdAt: now,
        updatedAt: now,
        workspace: config.workspace,
        model: config.model,
        endpoint: persistableEndpoint(config.endpoint),
        messages,
        unverifiedChangesPending: agent.hasUnverifiedChanges(),
        tokenStats: agent.getTokenStats(),
        // The authoritative task state, not only the conversation: plan, milestones, receipts, objective and history.
        activePlan: agent.getActivePlan(),
        milestones: agentMilestones(agent),
        validationReceipts: receipt ? [receipt] : [],
        objective: agent.getObjective() ?? null,
        findings: agent.getFindings(),
        history: agent.getHistoryCompleteness(),
        providerRecovery: durableState.providerRecovery,
        operation: durableState.operation,
        changeBaseline: durableState.changeBaseline,
        ...(turn ? { status: lifecycleStatusForTurn(turn) } : {}),
        ...(lastTurn ? { lastTurn } : {}),
      },
      agent.getWorkspacePathIdentity(),
    );
    return true;
  }

  private resumeSession(id?: string): { ok: boolean; message: string } {
    const manager = this.app.getSessionManager();
    let session;
    try {
      session = !id || id === "latest" ? manager.getLatestSession() : manager.loadSession(id);
    } catch (err: any) {
      return { ok: false, message: err.message };
    }
    if (!session) return { ok: false, message: `Session not found: ${id || "latest"}` };
    if (!Array.isArray(session.messages)) return { ok: false, message: `Session ${session.id} is unreadable: it has no message list.` };
    if (session.workspace && fs.existsSync(session.workspace)) this.setWorkspace(session.workspace);
    this.sessionId = session.id;
    // What compaction replaced stays searchable after a resume (read_archive): only compactions this record committed.
    const archiveNotice = this.app.getAgent().restoreConversation(session, (committed) => this.app.getSessionManager().readArchivedHistory(session.id, committed));
    if (archiveNotice) this.emit({ type: "notice", text: archiveNotice });
    if (Array.isArray(session.activePlan)) this.app.getAgent().setActivePlan(session.activePlan);
    this.lastTurn = null;
    this.emitHistory(session.id, withHarnessProvenance(session.messages), session.lastTurn);
    // The count of the conversation is in the history header shown just before; this names the session.
    return { ok: true, message: `Resumed session ${session.id}.` };
  }

  /**
   * The resumed conversation for the client to show, in order: operator prompts, steering, the agent's replies, the
   * tools it called (name and subject; results stay in the session record), and the last turn's outcome. Nexus's own
   * prompts (continuation, recovery) and the runtime context appended to prompts are left out; text is redacted and
   * bounded, and only the latest HISTORY_ENTRIES entries are sent.
   */
  private emitHistory(sessionId: string, messages: ChatMessage[], lastTurn?: TurnResult | null): void {
    const text = (m: ChatMessage) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("") : "");
    const entries: HistoryEntry[] = [];
    for (const m of messages) {
      const body = text(m);
      if (m.role === "user") {
        if (!body.trim() || isHarnessNote(m)) continue;
        // Steering is stored as "[Operator steering <id>]: text": shown as steering, without the marker.
        const typed = body.replace(/(\n+\[(?:Git Status|Active Plan): [^\n]*\])+\s*$/, "");
        if (typed.startsWith(STEERING_PREFIX)) entries.push({ role: "steering", text: typed.slice(typed.indexOf("]:") + 2).trim() });
        else entries.push({ role: "user", text: typed });
      } else if (m.role === "assistant") {
        if (body.trim()) entries.push({ role: "assistant", text: body });
        for (const call of m.tool_calls ?? []) {
          let args: Record<string, any> = {};
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {}
          entries.push({ role: "tool", tool: call.function.name, text: toolSubject(args) });
        }
      }
    }
    if (lastTurn) {
      const { heading, line } = summarizeTurn(lastTurn);
      entries.push({ role: "outcome", heading: heading, text: line, turn: projectTurn(lastTurn) });
    }
    const conversation = entries.filter((e) => e.role !== "tool" && e.role !== "outcome").length;
    this.emit({ type: "history", session: sessionId, total: conversation, messages: entries.slice(-HISTORY_ENTRIES) });
  }

  private shutdown(): Promise<void> {
    for (const signIn of this.signIns.values()) signIn.cancel();
    this.signIns.clear();
    this.shutdownPromise ??= (async () => {
      this.startupProbeAbort.abort();
      this.turnAbort?.abort(new Error("sidecar shutdown"));
      await this.idle();
      this.app.shutdown();
      this.onShutdown();
    })();
    return this.shutdownPromise;
  }

  private emitSessionState(): void {
    const config = this.app.getConfig();
    const facts = surfaceFacts(this.app, this.sessionId);
    const git = getGitInfo(config.workspace);
    const trusted = isWorkspaceTrusted(config.workspace, Boolean(config.readOnly));
    const sandboxStatus = config.sandbox ? (typeof config.sandbox === "string" ? config.sandbox : "on") : "off";
    this.emit({
      type: "session.state",
      workspace: config.workspace,
      workspace_name: path.basename(config.workspace),
      model: facts.model,
      mode: facts.mode,
      git: git.isRepo ? { branch: git.branch, dirty: git.dirtyCount } : null,
      busy: Boolean(this.activeTurn),
      session: facts.session,
      read_only: facts.read_only,
      context_tokens: facts.context_tokens,
      context_limit: facts.context_limit,
      endpoint_kind: facts.endpoint_kind,
      posture: {
        mode: facts.mode,
        sandbox: sandboxStatus,
        trusted,
      },
    });
  }

  private emit(event: SidecarEvent): void {
    const safe = formatSafeSidecarEvent(event);
    if (safe) this.write(encodeEvent(safe));
  }
}

/** Commands that may run while a turn is in progress: diagnosis without repairs. */
function busySafe(command: string, args: string): boolean {
  const name = command.trim().replace(/^\//, "").toLowerCase();
  return name === "doctor" && !args.split(/\s+/).includes("--fix");
}

/** Serialize a diagnostic only after the canonical credential classifier has sanitized it. */
export function formatSafeSidecarDiagnostic(args: readonly unknown[]): string {
  try {
    const serialized = formatDiagnostic(...args);
    // Canonical sanitizer failure suppresses the complete diagnostic; never fall through to raw text.
    return redactSecrets(redactForPersistence(serialized));
  } catch {
    return "[diagnostic suppressed: credential sanitization failed]";
  }
}

export function formatSafeSidecarStdoutSummary(chunk: string | Uint8Array): string {
  const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
  // Chunks may split a credential across calls. Keep content out of debug logs entirely.
  return `[sidecar debug] stdout chunk suppressed (${bytes} bytes)\n`;
}

export { formatSafeSidecarText } from "./safe_text.js";
import { formatSafeSidecarText } from "./safe_text.js";

/**
 * For a limit that applies to a fragment inside a larger sentence (so it cannot be a field limit): redact the full
 * fragment first, then cut. The sentence is still sanitized once more as part of its event.
 */
export function redactThenCap(value: string, max: number): string {
  return capText(formatSafeSidecarText(value), max);
}

/** Event fields holding filesystem paths: redacted per path component, not as prose (see redactPathForOutput). */
const PATH_FIELDS: Partial<Record<SidecarEvent["type"], readonly string[]>> = {
  "session.state": ["workspace", "workspace_name"],
  "file.diff": ["path", "full_path"],
  "tool.detail": ["diff_path"],
};

/**
 * Characters kept per free-text string field (text from the model, a tool, the operator or a provider). Applied after
 * redaction, so a cut can never split a credential. Each limit is at least the cap the field's producer already
 * applies, and a value the producer already cut with `capText` keeps its own `…[truncated N chars]` count (see
 * limitEventFields), so this changes nothing that is sent today; it bounds the field if a producer stops capping. Event types not
 * listed are structured or bounded elsewhere (paths: PATH_FIELDS; history: HISTORY_LIMITS); the coverage test in
 * test/sidecar_projection.test.ts classifies every protocol event type.
 */
export const FIELD_LIMITS: Partial<Record<SidecarEvent["type"], Readonly<Record<string, number>>>> = {
  "assistant.delta": { text: 64_000 },
  "steer.ack": { message: MAX_TEXT_FIELD, text: 64_000 },
  "file.diff": { path: 400, preview: 2 * DIFF_PREVIEW_CHARS, note: MAX_TEXT_FIELD },
  activity: { tool: 200, subject: 200 },
  "tool.start": { tool: 200, subject: MAX_TEXT_FIELD },
  // summary: protocol toolSummary caps at MAX_SUMMARY; preview: TOOL_PREVIEW_LINES rows of at most 400 characters.
  "tool.end": { tool: 200, summary: MAX_SUMMARY, preview: TOOL_PREVIEW_LINES * 401 },
  "tool.detail": { tool: 200, subject: MAX_TEXT_FIELD, args: MAX_DETAIL, output: MAX_DETAIL, diff: MAX_DIFF_DETAIL },
  "approval.request": { tool: 200, subject: MAX_TEXT_FIELD, preview: MAX_TEXT_FIELD },
  "checkpoint.choice.request": { message: MAX_TEXT_FIELD },
  "turn.result": { heading: MAX_TEXT_FIELD, line: MAX_TEXT_FIELD },
  "slash.result": { output: MAX_SLASH_OUTPUT, prompt: MAX_TEXT_FIELD, composer: MAX_PASTE, clipboard: OSC52_MAX_BYTES },
  notice: { text: MAX_TEXT_FIELD, detail: MAX_TEXT_FIELD },
  error: { message: MAX_TEXT_FIELD },
  "provider.auth": { instructions: MAX_TEXT_FIELD },
  "provider.result": { message: MAX_TEXT_FIELD },
  "model.result": { message: MAX_TEXT_FIELD },
};

/** Characters kept of a resumed conversation's entries: tool names and subjects are short, messages are bounded. */
const HISTORY_LIMITS = { toolName: 80, toolSubject: 200, text: HISTORY_CHARS } as const;

/** Longest `…[truncated N chars]` marker capText appends after the kept text. */
const CAP_MARKER_ROOM = 40;
const CAP_MARKER = /…\[truncated \d+ chars\]$/;

function limitEventFields(event: any): void {
  for (const [field, max] of Object.entries(FIELD_LIMITS[event.type as SidecarEvent["type"]] ?? {})) {
    const value = event[field];
    if (typeof value !== "string") continue;
    // Already cut to this limit by its producer: keep the producer's count of what was dropped. A model- or tool-supplied
    // text that fakes the marker only spoofs that count; the skip is bounded, since the value is at most max + CAP_MARKER_ROOM.
    if (value.length <= max + CAP_MARKER_ROOM && CAP_MARKER.test(value)) continue;
    event[field] = capText(value, max);
  }
  if (event.type === "history") {
    for (const entry of event.messages as HistoryEntry[]) {
      if (entry.role === "outcome") continue;
      if (entry.role === "tool") {
        if (typeof entry.tool === "string") entry.tool = capText(entry.tool, HISTORY_LIMITS.toolName);
        entry.text = capText(entry.text, HISTORY_LIMITS.toolSubject);
      } else {
        entry.text = capText(entry.text, HISTORY_LIMITS.text);
      }
    }
  }
}

/** Every string in the value, made safe for the protocol: literal credential patterns removed, controls made visible. */
function finishStrings<T>(value: T): T {
  if (typeof value === "string") return visibleControls(redactSecretPatterns(value)) as T;
  if (Array.isArray(value)) return value.map(finishStrings) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, finishStrings(nested)])) as T;
  }
  return value;
}

/**
 * The single sanitizing stage for protocol events. call sites hand over full, raw text; this redacts it once (the
 * canonical classifier over the whole structure, so keys and nested projected records are covered, plus the literal
 * patterns and terminal-control handling), treats path fields component-wise so generated directory names are not
 * mistaken for credentials, and only then cuts each field to its limit. Fails closed: if classification throws the
 * event is dropped, never serialized half-sanitized.
 */
export function formatSafeSidecarEvent(event: SidecarEvent): SidecarEvent | undefined {
  try {
    const staged: any = { ...event };
    const paths: Record<string, string> = {};
    for (const field of PATH_FIELDS[event.type] ?? []) {
      if (typeof staged[field] !== "string") continue;
      paths[field] = visibleControls(redactSecretPatterns(redactPathForOutput(staged[field])));
      staged[field] = "[NEXUS_PATH]";
    }
    const safe: any = finishStrings(redactForPersistence(staged));
    Object.assign(safe, paths);
    limitEventFields(safe);
    return safe as SidecarEvent;
  } catch {
    return undefined;
  }
}

/** Milestones the agent recorded in its own durable task state (update_plan completions); empty when unreadable. */
function agentMilestones(agent: ReturnType<ApplicationCore["getAgent"]>): any[] {
  try {
    const manager = agent.getStateManager();
    return manager.hasTaskState(agent.getTaskId()) ? manager.loadTaskState(agent.getTaskId()).milestones ?? [] : [];
  } catch {
    return [];
  }
}

/** Prompt history from the REPL's file, redacted; empty when the file is missing or unreadable. */
function loadPromptHistory(file: string): string[] {
  try {
    return redactForPersistence(fs.readFileSync(file, "utf-8"))
      .split("\n")
      .filter((line) => line.trim());
  } catch {
    return [];
  }
}

/**
 * Process entry point. Stdout is reserved for protocol lines: the real writer is captured first, then every
 * other stdout write (agent banners, spinners, console.log) is dropped, or sent to stderr with NEXUS_DEBUG=1.
 */
async function main(argv: string[]): Promise<void> {
  const protocolWrite = process.stdout.write.bind(process.stdout);
  const debug = process.env.NEXUS_DEBUG === "1";
  const toStderr = (...args: unknown[]): void => {
    if (debug) process.stderr.write(`${formatSafeSidecarDiagnostic(args)}\n`);
  };

  const program = new Command()
    .name("nexus-sidecar")
    .option("-e, --endpoint <url>", "Local LLM endpoint")
    .option("-m, --model <name>", "Model name")
    .option("-w, --workspace <path>", "Workspace directory")
    .option("-s, --max-steps <number>", "Steps per segment (continuation checkpoints there instead of stopping)")
    .option("--max-total-steps <number>", "Continuation: an explicit total-step limit for one turn (default: none; progressing work continues)")
    .option("--strict-token-count", "Refuse a request the connection could not count on a worker (default: proceed on the labelled estimate)")
    .option("--max-turn-minutes <number>", "Continuation: an explicit wall-clock limit for one turn in minutes (default: none)")
    .option("--stagnation-steps <number>", "Continuation: stop after this many steps without progress (default 12)")
    .option("--no-continuation", "End a turn at --max-steps instead of continuing while it makes progress")
    .option("-t, --temperature <number>", "Model temperature")
    .option("--shell <type>", "Shell for commands", "bash")
    .option("--fallback <urls>", "Comma-separated fallback LLM endpoints")
    .option("--context-limit <tokens>", "Model context window limit in tokens")
    .option("--dry-run", "Simulate file modifications without writing changes to disk")
    .option("--read-only", "Reject all mutating tool executions and commands")
    .option("--sandbox [mode]", "Isolate command execution using bubblewrap or Docker")
    .option("--worktree", "Isolate execution inside an ephemeral git worktree")
    .option("--worktree-branch <name>", "Run inside the named git worktree for this branch (created if missing); kept after the run, merge it with `nexus worktree merge`")
    .option("--authoritative-verifier <command>", "Trusted command that must pass before any task completion; its success may authorize automatic worktree merge")
    .option("--deliverable-file <path>", "Operator-declared workspace-relative product file used for VERIFIED binding (repeatable)", (value: string, previous: string[] = []) => [...previous, value], [])
    .option("--record-flight", "Record execution into an append-only .flightlog")
    .option("--planner-model <name>", "Deep reasoning model for planning")
    .option("--planner-endpoint <url>", "Inference endpoint for the planner model")
    .option("--coder-model <name>", "Model for code implementation")
    .option("--coder-endpoint <url>", "Inference endpoint for the coder model")
    .option("--approve", "Require operator approval before edits and shell commands")
    .option("-y, --yes", "Run non-interactively without approval prompts (forces auto mode)")
    .option("--mode <mode>", "Execution mode: auto, review, or read-only (default: review; folder trust does not change it)")
    .option("-r, --resume [id]", "Resume a saved session (the latest when no id is given)")
    .parse(argv);

  // Commander help is ordinary CLI output, before protocol-only stdout
  // handling begins. Parsing help and metadata invocations is read-only: do
  // it before restore recovery, then hold a lifetime lease before any normal
  // startup state is read or used. The packaged TUI may launch this entry
  // point directly, without passing through index.ts.
  (process.stdout as any).write = (chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
    if (debug && (typeof chunk === "string" || chunk instanceof Uint8Array)) {
      process.stderr.write(formatSafeSidecarStdoutSummary(chunk));
    }
    const done = typeof encoding === "function" ? encoding : cb;
    if (typeof done === "function") (done as () => void)();
    return true;
  };
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.debug = toStderr;
  console.error = (...args: unknown[]) => process.stderr.write(`${formatSafeSidecarDiagnostic(args)}\n`);
  const home = process.env.HOME || os.homedir();
  const { acquireClientLease, releaseClientLease } = await import("./core/client_lease.js");
  const { hasPendingStateRestore, recoverPendingStateRestore } = await import("./core/state_restore.js");
  if (hasPendingStateRestore(home) && !recoverPendingStateRestore(home)) {
    throw new Error("Pending state restore could not be recovered; no state was admitted");
  }
  const lease = acquireClientLease(home);
  process.once("exit", () => releaseClientLease(lease));
  loadEnvironment();
  const configLoadError = operatorConfigLoadError();
  if (configLoadError) throw new Error(`Configuration error: ${configLoadError.message}`);
  const options = program.opts();
  const config = await autoDetectModel(buildConfig(options), { resuming: Boolean(options.resume) });
  config.surface = "tui";
  const app = new ApplicationCore(config);
  const server = new SidecarServer({
    app,
    mode: config.approvalMode,
    resume: typeof options.resume === "string" ? options.resume : options.resume ? "latest" : undefined,
    write: (line) => {
      protocolWrite(line);
    },
    onShutdown: () => process.exit(0),
  });

  const report = (err: unknown) => process.stderr.write(`nexus sidecar: ${formatSafeSidecarDiagnostic([err])}\n`);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    server.handleLine(line).catch(report);
  });
  const requestShutdown = () => {
    server.handleLine(JSON.stringify({ v: PROTOCOL_VERSION, type: "shutdown" })).catch(report);
  };
  input.on("close", requestShutdown);
  process.stdout.on("error", requestShutdown);
  server.start();
}

/** True when argv[1] names this module, comparing real paths so a symlinked launcher still counts. */
function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return fs.realpathSync(path.resolve(argv1)) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  main(process.argv).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`nexus sidecar failed to start: ${formatSafeSidecarText(message)}\n`);
    process.exit(1);
  });
}
