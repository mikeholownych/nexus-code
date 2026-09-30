import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

export type FlightEventType =
  | "session_start"
  | "turn_start"
  | "thought"
  | "tool_call"
  | "tool_result"
  | "durable_state"
  | "file_diff"
  | "turn_end"
  | "session_end";

export interface FlightEvent {
  eventId: string;
  timestamp: string;
  type: FlightEventType;
  step?: number;
  payload: Record<string, any>;
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
 */
export class FlightRecorder {
  private workspace: string;
  private flightId: string;
  private flightLogPath: string;
  private isRecording: boolean = false;
  private startTime: number = Date.now();

  constructor(workspace: string, flightId?: string) {
    this.workspace = path.resolve(workspace);
    this.flightId = flightId || `flight-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`;
    const flightsDir = path.join(this.workspace, ".nexus", "flights");
    if (!fs.existsSync(flightsDir)) {
      fs.mkdirSync(flightsDir, { recursive: true });
    }
    this.flightLogPath = path.join(flightsDir, `${this.flightId}.flightlog`);
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
    const event: FlightEvent = {
      eventId: `evt-${randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      type,
      step,
      payload,
    };
    try {
      fs.appendFileSync(this.flightLogPath, JSON.stringify(event) + "\n", "utf-8");
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
      endpoint: config.endpoint,
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

  public static loadFlight(workspace: string, flightIdOrPath: string): { manifest: FlightManifest; events: FlightEvent[] } {
    let fullPath = flightIdOrPath;
    if (!fs.existsSync(fullPath)) {
      const candidate = path.join(path.resolve(workspace), ".nexus", "flights", flightIdOrPath.endsWith(".flightlog") ? flightIdOrPath : `${flightIdOrPath}.flightlog`);
      if (fs.existsSync(candidate)) {
        fullPath = candidate;
      } else {
        throw new Error(`Flight log not found: ${flightIdOrPath}`);
      }
    }

    const lines = fs.readFileSync(fullPath, "utf-8").split("\n").filter((l) => l.trim().length > 0);
    const events: FlightEvent[] = [];
    let manifest: FlightManifest | undefined;

    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as FlightEvent;
        events.push(ev);
        if (ev.type === "session_start" && !manifest) {
          manifest = ev.payload as FlightManifest;
        }
      } catch {}
    }

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

    return { manifest, events };
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
