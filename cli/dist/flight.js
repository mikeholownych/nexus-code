import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
/**
 * Deterministic Flight Recorder for Agentic Code Execution
 * Records prompts, thoughts, tool calls, diffs, and durable state transitions into
 * append-only .flightlog archives for exact post-mortem replay and audit.
 */
export class FlightRecorder {
    workspace;
    flightId;
    flightLogPath;
    isRecording = false;
    startTime = Date.now();
    constructor(workspace, flightId) {
        this.workspace = path.resolve(workspace);
        this.flightId = flightId || `flight-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`;
        const flightsDir = path.join(this.workspace, ".nexus", "flights");
        if (!fs.existsSync(flightsDir)) {
            fs.mkdirSync(flightsDir, { recursive: true });
        }
        this.flightLogPath = path.join(flightsDir, `${this.flightId}.flightlog`);
    }
    getFlightId() {
        return this.flightId;
    }
    getLogPath() {
        return this.flightLogPath;
    }
    isSessionActive() {
        return this.isRecording;
    }
    appendEvent(type, step, payload) {
        const event = {
            eventId: `evt-${randomUUID().slice(0, 8)}`,
            timestamp: new Date().toISOString(),
            type,
            step,
            payload,
        };
        try {
            fs.appendFileSync(this.flightLogPath, JSON.stringify(event) + "\n", "utf-8");
        }
        catch {
            // Ignore flightlog append errors in restricted environments
        }
        return event;
    }
    startSession(config) {
        this.isRecording = true;
        this.startTime = Date.now();
        let initialCommit;
        let initialBranch;
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
        }
        catch { }
        const manifest = {
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
    recordTurnStart(step, taskPrompt) {
        return this.appendEvent("turn_start", step, { prompt: taskPrompt });
    }
    recordThought(step, thoughtText, reasoningText) {
        return this.appendEvent("thought", step, {
            thought: thoughtText,
            reasoning: reasoningText,
        });
    }
    recordToolCall(step, callId, toolName, args) {
        return this.appendEvent("tool_call", step, {
            callId,
            toolName,
            arguments: args,
        });
    }
    recordToolResult(step, callId, toolName, success, output, durationMs, error) {
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
    recordDurableState(step, state) {
        return this.appendEvent("durable_state", step, { state });
    }
    recordFileDiff(step, path, diff, replacements) {
        return this.appendEvent("file_diff", step, {
            path,
            diffSnippet: diff.slice(0, 2000),
            replacements: replacements || 1,
        });
    }
    recordSessionEnd(summary, success, tokenStats) {
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
    static listFlights(workspace) {
        const flightsDir = path.join(path.resolve(workspace), ".nexus", "flights");
        if (!fs.existsSync(flightsDir))
            return [];
        const files = fs.readdirSync(flightsDir).filter((f) => f.endsWith(".flightlog"));
        const manifests = [];
        for (const file of files) {
            const fullPath = path.join(flightsDir, file);
            try {
                const firstLine = fs.readFileSync(fullPath, "utf-8").split("\n")[0];
                if (firstLine) {
                    const parsed = JSON.parse(firstLine);
                    if (parsed.type === "session_start" && parsed.payload) {
                        manifests.push(parsed.payload);
                    }
                }
            }
            catch { }
        }
        return manifests.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
    }
    static loadFlight(workspace, flightIdOrPath) {
        let fullPath = flightIdOrPath;
        if (!fs.existsSync(fullPath)) {
            const candidate = path.join(path.resolve(workspace), ".nexus", "flights", flightIdOrPath.endsWith(".flightlog") ? flightIdOrPath : `${flightIdOrPath}.flightlog`);
            if (fs.existsSync(candidate)) {
                fullPath = candidate;
            }
            else {
                throw new Error(`Flight log not found: ${flightIdOrPath}`);
            }
        }
        const lines = fs.readFileSync(fullPath, "utf-8").split("\n").filter((l) => l.trim().length > 0);
        const events = [];
        let manifest;
        for (const line of lines) {
            try {
                const ev = JSON.parse(line);
                events.push(ev);
                if (ev.type === "session_start" && !manifest) {
                    manifest = ev.payload;
                }
            }
            catch { }
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
    static async replay(events, onEvent, delayMs = 0) {
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
