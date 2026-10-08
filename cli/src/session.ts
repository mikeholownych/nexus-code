import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ChatMessage } from "./types.js";
import {
  DurableTaskState,
  DurableStateManager,
  TaskRecoveryOptions,
  TaskRecoveryResult,
  CURRENT_STATE_SCHEMA_VERSION,
} from "./core/state.js";
import { WorkspacePath } from "./core/workspace_path.js";

// Re-export core state primitives
export * from "./core/state.js";

/**
 * Upgraded SessionData envelope conforming to DurableTaskState (PERS-001..PERS-004).
 */
export interface SessionData extends DurableTaskState {
  id: string;
  workspace: string;
  model: string;
}

export class SessionManager {
  private sessionsDir: string;
  private stateManager: DurableStateManager;
  private readonly selectedWorkspace: (() => WorkspacePath) | undefined;

  constructor(customDir?: string, selectedWorkspace?: () => WorkspacePath) {
    this.sessionsDir = customDir || path.join(os.homedir(), ".nexus", "sessions");
    this.selectedWorkspace = selectedWorkspace;
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
    this.stateManager = new DurableStateManager({ baseDir: this.sessionsDir });
  }

  public getStateManager(): DurableStateManager {
    return this.stateManager;
  }

  public generateSessionId(): string {
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const timestamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const rand = Math.random().toString(36).substring(2, 6);
    return `session_${timestamp}_${rand}`;
  }

  /**
   * Atomically saves session data conforming to the DurableTaskState envelope.
   */
  public saveSession(session: Partial<SessionData> & { id: string }, workspacePath?: WorkspacePath): void {
    const selectedWorkspace = this.currentSelectedWorkspace();
    if (workspacePath && (!selectedWorkspace || !selectedWorkspace.matches(workspacePath.value))) {
      throw new Error("Session workspace identity is not selected by the application");
    }
    if (selectedWorkspace) this.stateManager.setWorkspacePaths([selectedWorkspace]);
    const taskId = session.taskId || session.id;
    const sessionId = session.sessionId || session.id;
    const workspace = session.workspace || session.workspacePath || process.cwd();

    const fullState: SessionData = {
      schemaVersion: session.schemaVersion || CURRENT_STATE_SCHEMA_VERSION,
      taskId,
      sessionId,
      id: sessionId,
      title: session.title || "Active Session",
      workspacePath: workspace,
      workspace,
      model: session.model || "default",
      createdAt: session.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: session.status || "in_progress",
      activePlan: session.activePlan || [],
      milestones: session.milestones || [],
      worktreeBinding: session.worktreeBinding || null,
      candidateId: session.candidateId || null,
      candidateIdentity: session.candidateIdentity || null,
      validationReceipts: session.validationReceipts || [],
      currentOperation: session.currentOperation || null,
      messages: session.messages || [],
      ...(session.unverifiedChangesPending !== undefined ? { unverifiedChangesPending: session.unverifiedChangesPending } : {}),
      durableNotes: session.durableNotes,
      compactionProvenance: session.compactionProvenance,
      cognitiveRouting: session.cognitiveRouting,
      tokenStats: session.tokenStats,
    };

    this.stateManager.saveTaskState(fullState, selectedWorkspace ? [selectedWorkspace] : []);
  }

  /**
   * Loads session with strict integrity and schema validation, migrating legacy session files if needed.
   */
  public loadSession(sessionId: string): SessionData | null {
    let cleanId = sessionId.replace(/\.json$/, "");
    let targetId = cleanId;

    if (!this.stateManager.hasTaskState(cleanId)) {
      // Find matching session if partial ID was supplied
      const all = this.listSessions();
      const match = all.find((s) => s.id.startsWith(cleanId) || s.id.includes(cleanId));
      if (match) {
        targetId = match.id;
      } else {
        return null;
      }
    }

    try {
      const workspacePath = this.workspacePathFromSessionFile(targetId);
      const state = this.stateManager.loadTaskState(targetId, undefined, [workspacePath]);
      return state as SessionData;
    } catch {
      return null;
    }
  }

  /**
   * Recovers a session, validating candidate state on disk and detecting interrupted operations.
   */
  public recoverSession(
    sessionId: string,
    options?: TaskRecoveryOptions
  ): TaskRecoveryResult | null {
    let cleanId = sessionId.replace(/\.json$/, "");
    if (!this.stateManager.hasTaskState(cleanId)) {
      const all = this.listSessions();
      const match = all.find((s) => s.id.startsWith(cleanId) || s.id.includes(cleanId));
      if (match) {
        cleanId = match.id;
      } else {
        return null;
      }
    }

    try {
      const workspacePath = this.workspacePathFromSessionFile(cleanId);
      return this.stateManager.recoverTaskState(cleanId, {
        ...options,
        workspacePaths: [workspacePath],
      });
    } catch {
      return null;
    }
  }

  public getLatestSession(): SessionData | null {
    const list = this.listSessions();
    if (list.length === 0) return null;
    return this.loadSession(list[0].id);
  }

  public listSessions(): Array<{
    id: string;
    title: string;
    updatedAt: string;
    workspace: string;
    messageCount: number;
  }> {
    if (!fs.existsSync(this.sessionsDir)) return [];

    const files = fs.readdirSync(this.sessionsDir).filter((f) => f.endsWith(".json"));
    const results: Array<{
      id: string;
      title: string;
      updatedAt: string;
      workspace: string;
      messageCount: number;
      mtime: number;
    }> = [];

    for (const file of files) {
      try {
        const fullPath = path.join(this.sessionsDir, file);
        const stat = fs.statSync(fullPath);
        const content = fs.readFileSync(fullPath, "utf-8");
        const data = JSON.parse(content);
        const cleanId = file.replace(/\.json$/, "");
        results.push({
          id: data.sessionId || data.taskId || data.id || cleanId,
          title: data.title || "Untitled Session",
          updatedAt: data.updatedAt || stat.mtime.toISOString(),
          workspace: data.workspacePath || data.workspace || "~",
          messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
          mtime: stat.mtimeMs,
        });
      } catch {
        // ignore corrupted files in listing
      }
    }

    results.sort((a, b) => b.mtime - a.mtime);
    return results.map(({ mtime, ...rest }) => rest);
  }

  private workspacePathFromSessionFile(taskId: string): WorkspacePath {
    const selected = this.currentSelectedWorkspace();
    if (!selected) throw new Error("Session recovery requires an independently selected workspace");
    selected.assertCurrent();
    this.stateManager.setWorkspacePaths([selected]);
    const filePath = this.stateManager.getStateFilePath(taskId);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const value = raw?.workspacePath || raw?.workspace;
    if (typeof value !== "string") throw new Error("Session record has no workspace identity");
    if (!selected.matches(value) || (raw?.workspacePath && raw.workspacePath !== selected.value) ||
        (raw?.workspace && raw.workspace !== selected.value)) {
      throw new Error("Session workspace does not match the application's selected workspace");
    }
    return selected;
  }

  private currentSelectedWorkspace(): WorkspacePath | undefined {
    return this.selectedWorkspace?.();
  }
}
