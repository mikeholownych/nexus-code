import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { InformationFlowBoundary } from "./core/egress.js";
import { ensurePrivateDir, appendPrivateFile } from "./core/durable_file.js";
import { ensureGitExclude } from "./core/git_exclude.js";
import { persistableEndpoint } from "./core/endpoint_identity.js";
import { describeChain, linkRecord, verifyChain, type ChainLink, type ChainVerdict } from "./core/hash_chain.js";
import type { SandboxDenialEvent } from "./sandbox_events.js";

export type FlightEventType =
  | "session_start"
  | "turn_start"
  | "thought"
  | "tool_call"
  | "tool_result"
  | "durable_state"
  | "file_diff"
  | "middleware_rewrite"
  | "sandbox_denial"
  | "sandbox_violation"
  | "sandbox_unavailable"
  | "turn_end"
  | "session_end";

export interface FlightEvent {
  eventId: string;
  timestamp: string;
  type: FlightEventType;
  step?: number;
  payload: Record<string, any>;
  /** Link to the record before this one (GV-3). Absent in flight logs written before v1.3.0. */
  chain?: ChainLink;
}

/**
 * Whether a flight log reads back as it was written. `chain` is the record chain's verdict. `closed` says whether the
 * log ends with its `session_end` record: an intact chain that is not closed is still being recorded, belongs to a
 * process that stopped early, or lost records from its end (a chain alone cannot tell those apart).
 */
export interface FlightIntegrity {
  chain: ChainVerdict;
  closed: boolean;
}

export interface FlightManifest {
  flightId: string;
  recordedAt: string;
  workspace: string;
  model: string;
  endpoint: string;
  initialCommit?: string;
  initialBranch?: string;
  totalSteps?: number;
  taskPrompt?: string;
  status: "in_progress" | "completed" | "failed";
  summary?: string;
}

/**
 * Deterministic Flight Recorder for Agentic Code Execution
 * Records prompts, thoughts, tool calls, diffs, and durable state transitions into
 * append-only .flightlog archives for exact post-mortem replay and audit.
 * Each record is hash-chained to the one before it (core/hash_chain.ts), so a changed, removed or reordered
 * record is found when the log is read (FlightPlayer.loadFlight).
 */
export class FlightRecorder {
  private workspace: string;
  private flightId: string;
  private flightLogPath: string;
  private isRecording: boolean = false;
  private startTime: number = Date.now();
  /** Link of the last record written; undefined before the first. */
  private lastLink: ChainLink | undefined;
  /** False when this recorder continues a log written before chaining: such a log stays unchained. */
  private chained = true;

  constructor(workspace: string, flightId?: string) {
    this.workspace = path.resolve(workspace);
    this.flightId = flightId || `flight-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`;
    ensureGitExclude(this.workspace);
    const flightsDir = path.join(this.workspace, ".nexus", "flights");
    ensurePrivateDir(flightsDir);
    this.flightLogPath = path.join(flightsDir, `${this.flightId}.flightlog`);
    this.resumeChain();
  }

  /**
   * Continue the chain of a log that already exists (a recorder given an earlier flight id). A log that is intact
   * continues from its last link. One written before chaining stays unchained. A broken one is left as it is and new
   * records are appended unchained after it, so the break stays visible and is not papered over by fresh links.
   */
  private resumeChain(): void {
    let text: string;
    try {
      text = fs.readFileSync(this.flightLogPath, "utf-8");
    } catch {
      return;
    }
    const verdict = verifyChain(parseFlightLines(text));
    if (verdict.status === "intact") this.lastLink = verdict.head;
    else this.chained = false;
  }

  public getFlightId(): string {
    return this.flightId;
  }

  public getLogPath(): string {
    return this.flightLogPath;
  }

  public isSessionActive(): boolean {
    return this.isRecording;
  }

  private appendEvent(type: FlightEventType, step: number | undefined, payload: Record<string, any>): FlightEvent {
    // Flightlogs are durable telemetry. Sanitize the complete event before its
    // only write path; a classifier failure must not fall through to plaintext
    // or prevent the authorized local capability from executing.
    const eventId = `evt-${randomUUID().slice(0, 8)}`;
    const timestamp = new Date().toISOString();
    let sanitizedPayload: Record<string, any>;
    try {
      sanitizedPayload = InformationFlowBoundary.getGlobalInstance().redactForTelemetry(payload);
    } catch {
      // Do not propagate classifier diagnostics that could echo inspected input.
      return {
        eventId,
        timestamp,
        type,
        step,
        payload: { recordingSkipped: true, reason: "sanitization_failed" },
      };
    }
    const content: FlightEvent = {
      eventId,
      timestamp,
      type,
      step,
      payload: sanitizedPayload,
    };
    // The link is computed over the sanitized record, the one that is stored.
    const event: FlightEvent = this.chained ? linkRecord(content, this.lastLink) : content;
    try {
      appendPrivateFile(this.flightLogPath, JSON.stringify(event) + "\n");
      // Advance only once the record is on disk: a failed write must not leave a gap in the sequence.
      if (event.chain) this.lastLink = event.chain;
    } catch {
      // Ignore flightlog append errors in restricted environments
    }
    return event;
  }

  public startSession(config: {
    model: string;
    endpoint: string;
    taskPrompt?: string;
  }): FlightManifest {
    this.isRecording = true;
    this.startTime = Date.now();

    let initialCommit: string | undefined;
    let initialBranch: string | undefined;

    try {
      initialCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: this.workspace,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      initialBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: this.workspace,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {}

    const manifest: FlightManifest = {
      flightId: this.flightId,
      recordedAt: new Date().toISOString(),
      workspace: this.workspace,
      model: config.model,
      endpoint: persistableEndpoint(config.endpoint),
      initialCommit,
      initialBranch,
      taskPrompt: config.taskPrompt,
      status: "in_progress",
    };

    this.appendEvent("session_start", 0, manifest);
    return manifest;
  }

  public recordTurnStart(step: number, taskPrompt: string): FlightEvent {
    return this.appendEvent("turn_start", step, { prompt: taskPrompt });
  }

  public recordThought(step: number, thoughtText: string, reasoningText?: string): FlightEvent {
    return this.appendEvent("thought", step, {
      thought: thoughtText,
      reasoning: reasoningText,
    });
  }

  public recordToolCall(step: number, callId: string, toolName: string, args: Record<string, any>): FlightEvent {
    return this.appendEvent("tool_call", step, {
      callId,
      toolName,
      arguments: args,
    });
  }

  public recordToolResult(
    step: number,
    callId: string,
    toolName: string,
    success: boolean,
    output: string,
    durationMs: number,
    error?: string,
  ): FlightEvent {
    return this.appendEvent("tool_result", step, {
      callId,
      toolName,
      success,
      outputLength: output.length,
      outputSnippet: output.slice(0, 1000),
      durationMs,
      error,
    });
  }

  /**
   * VR-3: a typed sandbox refusal. It is durable evidence for replay and export, never a verdict or an approval.
   * The event is sanitized and chained by `appendEvent` like every other flight record.
   */
  public recordSandboxDenial(step: number, event: SandboxDenialEvent): FlightEvent {
    const type: FlightEventType = event.kind === "violation"
      ? "sandbox_violation"
      : event.kind === "unavailable"
        ? "sandbox_unavailable"
        : "sandbox_denial";
    return this.appendEvent(type, step, event);
  }

  public recordDurableState(step: number, state: Record<string, any>): FlightEvent {
    return this.appendEvent("durable_state", step, { state });
  }

  public recordFileDiff(step: number, path: string, diff: string, replacements?: number): FlightEvent {
    return this.appendEvent("file_diff", step, {
      path,
      diffSnippet: diff.slice(0, 2000),
      replacements: replacements || 1,
    });
  }

  public recordSessionEnd(summary: string, success: boolean, tokenStats?: { prompt: number; completion: number; total: number }): FlightEvent {
    this.isRecording = false;
    const durationMs = Date.now() - this.startTime;
    return this.appendEvent("session_end", undefined, {
      summary,
      success,
      durationMs,
      tokenStats,
    });
  }

  public recordMiddlewareRewrite(
    step: number | undefined,
    payload: {
      kind: "middleware_rewrite";
      plugin: string;
      tool: string;
      phase: "pre" | "post";
      before_digest: string;
      after_digest: string;
    }
  ): FlightEvent {
    return this.appendEvent("middleware_rewrite", step, payload);
  }
}

/** The records of a flight log in file order; `null` marks a non-empty line that is not a JSON object. */
function parseFlightLines(text: string): Array<FlightEvent | null> {
  const records: Array<FlightEvent | null> = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      records.push(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as FlightEvent) : null);
    } catch {
      records.push(null);
    }
  }
  return records;
}

/**
 * Replay player for deterministic flight logs.
 */
export class FlightPlayer {
  public static listFlights(workspace: string): FlightManifest[] {
    const flightsDir = path.join(path.resolve(workspace), ".nexus", "flights");
    if (!fs.existsSync(flightsDir)) return [];

    const files = fs.readdirSync(flightsDir).filter((f) => f.endsWith(".flightlog"));
    const manifests: FlightManifest[] = [];

    for (const file of files) {
      const fullPath = path.join(flightsDir, file);
      try {
        const firstLine = fs.readFileSync(fullPath, "utf-8").split("\n")[0];
        if (firstLine) {
          const parsed = JSON.parse(firstLine);
          if (parsed.type === "session_start" && parsed.payload) {
            manifests.push(parsed.payload as FlightManifest);
          }
        }
      } catch {}
    }

    return manifests.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }

  public static loadFlight(workspace: string, flightIdOrPath: string): { manifest: FlightManifest; events: FlightEvent[]; integrity: FlightIntegrity } {
    let fullPath = flightIdOrPath;
    if (!fs.existsSync(fullPath)) {
      const candidate = path.join(path.resolve(workspace), ".nexus", "flights", flightIdOrPath.endsWith(".flightlog") ? flightIdOrPath : `${flightIdOrPath}.flightlog`);
      if (fs.existsSync(candidate)) {
        fullPath = candidate;
      } else {
        throw new Error(`Flight log not found: ${flightIdOrPath}`);
      }
    }

    const records = parseFlightLines(fs.readFileSync(fullPath, "utf-8"));
    const events: FlightEvent[] = [];
    let manifest: FlightManifest | undefined;

    for (const ev of records) {
      // An unreadable line is still left out of the replay, as before; the chain verdict reports it.
      if (!ev) continue;
      events.push(ev);
      if (ev.type === "session_start" && !manifest) {
        manifest = ev.payload as FlightManifest;
      }
    }
    const last = records[records.length - 1];
    const integrity: FlightIntegrity = { chain: verifyChain(records), closed: Boolean(last && last.type === "session_end") };

    if (!manifest) {
      manifest = {
        flightId: path.basename(fullPath, ".flightlog"),
        recordedAt: new Date().toISOString(),
        workspace,
        model: "unknown",
        endpoint: "unknown",
        status: "completed",
      };
    }

    return { manifest, events, integrity };
  }

  /** One line for the operator: what reading the log back established about it. */
  public static describeIntegrity(integrity: FlightIntegrity): string {
    const chain = describeChain(integrity.chain);
    if (integrity.chain.status !== "intact" || integrity.chain.records === 0) return chain;
    return integrity.closed
      ? `${chain}, closed by its session end`
      : `${chain}, not closed: no session end (still recording, stopped early, or records are missing from the end)`;
  }

  public static async replay(
    events: FlightEvent[],
    onEvent?: (e: FlightEvent) => void,
    delayMs: number = 0,
  ): Promise<void> {
    for (const ev of events) {
      if (onEvent) {
        onEvent(ev);
      }
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}
