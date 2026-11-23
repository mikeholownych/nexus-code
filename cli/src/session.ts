import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import { ChatMessage } from "./types.js";
import {
  DurableTaskState,
  DurableStateManager,
  TaskRecoveryOptions,
  TaskRecoveryResult,
  CURRENT_STATE_SCHEMA_VERSION,
  WORKTREE_BINDING_VERSION,
  CorruptStateError,
  UnsupportedSchemaVersionError,
} from "./core/state.js";
import { withStateStoreGuard } from "./core/state_store_guard.js";
import { WorkspacePath } from "./core/workspace_path.js";
import { isManagedWorktreePath, isNamedWorktreePath, protectArchivedMessages } from "./core/persistence_protection.js";
import { insertedBlockPresent, isCompactionRecord } from "./core/compaction_record.js";
import { appendLinesDurably, readArchiveLines, type ArchiveRead, ensurePrivateDir, writePrivateFile } from "./core/durable_file.js";
import { persistableEndpoint } from "./core/endpoint_identity.js";
import { WorktreeManager } from "./worktree.js";
import { buildSessionContextInventory, isContextInventorySnapshot, isInferenceContextManifest, markInterruptedInferenceManifestsUnknown, markPersistedContextFreshnessUnknown } from "./core/context_inventory.js";

// Re-export core state primitives
export * from "./core/state.js";

export class AmbiguousSessionResumeError extends Error {
  public readonly prefix: string;
  public readonly candidates: string[];
  constructor(prefix: string, candidates: string[]) {
    super(`Ambiguous session ID prefix '${prefix}'. Matches: ${candidates.join(", ")}`);
    this.name = "AmbiguousSessionResumeError";
    this.prefix = prefix;
    this.candidates = candidates;
  }
}

/**
 * Upgraded SessionData envelope conforming to DurableTaskState (PERS-001..PERS-004).
 */
export interface SessionData extends DurableTaskState {
  id: string;
  workspace: string;
  model: string;
}

export interface SessionIndexEntry {
  id: string;
  cleanId: string;
  title: string;
  updatedAt: string;
  workspace: string;
  messageCount: number;
  mtime: number;
  pinned?: boolean;
}

export interface SessionIndexData {
  version: 1;
  updatedAt: string;
  sessions: Record<string, SessionIndexEntry>;
}

/** Where interactive sessions are saved unless a directory is given. */
export function defaultSessionsDir(): string {  if (process.env.NEXUS_STATE_DIR) {
    return path.join(process.env.NEXUS_STATE_DIR, "sessions");
  }
  return path.join(os.homedir(), ".nexus", "sessions");
}

/** Cryptographically unpredictable base36 suffix; the length stays inside the
 *  egress classifier's session-id whitelist (session_\d{8}_\d{6}_[a-z0-9]{1,8}). */
function randomBase36Suffix(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  while (suffix.length < length) {
    for (const byte of randomBytes(length)) {
      // Rejection sampling keeps the base-36 mapping unbiased (36 * 7 = 252).
      if (byte >= 252) continue;
      if (suffix.length < length) suffix += alphabet[byte % 36];
    }
  }
  return suffix;
}

/** The longest prefix of `messages` no longer than `n` that does not end inside a tool exchange (a call without all its results). */
function completeExchangePrefix(messages: ChatMessage[], n: number): number {
  let end = n;
  while (end > 1) {
    let owner = end - 1;
    while (owner > 0 && messages[owner].role === "tool") owner--;
    const head = messages[owner];
    const calls = head.role === "assistant" ? head.tool_calls ?? [] : [];
    if (!calls.length) return end;
    const answered = new Set(messages.slice(owner + 1, end).filter((x) => x.role === "tool").map((x) => x.tool_call_id));
    if (calls.every((c) => answered.has(c.id))) return end;
    end = owner;
  }
  return end;
}

export class SessionManager {
  private sessionsDir: string;
  private stateManager: DurableStateManager;
  private readonly selectedWorkspace: (() => WorkspacePath) | undefined;

  constructor(customDir?: string, selectedWorkspace?: () => WorkspacePath) {
    this.sessionsDir = customDir || defaultSessionsDir();
    this.selectedWorkspace = selectedWorkspace;
    ensurePrivateDir(this.sessionsDir);
    this.stateManager = new DurableStateManager({ baseDir: this.sessionsDir });
    this.sessionsDir = this.stateManager.getBaseDir();
  }

  public getStateManager(): DurableStateManager {
    return this.stateManager;
  }

  public generateSessionId(): string {
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const timestamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `session_${timestamp}_${randomBase36Suffix(8)}`;
  }

  /**
   * Atomically saves session data conforming to the DurableTaskState envelope.
   */
  public saveSession(session: Partial<SessionData> & { id: string }, workspacePath?: WorkspacePath): void {
    return withStateStoreGuard(this.sessionsDir, () => this.saveSessionLocked(session, workspacePath));
  }

  private saveSessionLocked(
    session: Partial<SessionData> & { id: string },
    workspacePath?: WorkspacePath,
    forkWorkspaceIdentity?: WorkspacePath,
  ): void {
    const selectedWorkspace = forkWorkspaceIdentity ?? this.currentSelectedWorkspace();
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
      ...(session.endpoint ? { endpoint: persistableEndpoint(session.endpoint) } : {}),
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
      // Present-or-absent, not defaulted: an explicit null is a recorded "none", and absence must not invent a value.
      ...(session.providerRecovery !== undefined ? { providerRecovery: session.providerRecovery } : {}),
      ...(session.operation !== undefined ? { operation: session.operation } : {}),
      ...(session.changeBaseline !== undefined ? { changeBaseline: session.changeBaseline } : {}),
      messages: session.messages || [],
      contextInventory: isContextInventorySnapshot(session.contextInventory) &&
          (!session.contextInventory.sessionId || session.contextInventory.sessionId === sessionId) &&
          (!session.contextInventory.workspace || path.resolve(session.contextInventory.workspace) === path.resolve(workspace))
        ? session.contextInventory
        : buildSessionContextInventory({ ...session, id: sessionId, taskId, sessionId, workspace, messages: session.messages || [] }),
      ...(Array.isArray(session.inferenceContextManifests)
        ? { inferenceContextManifests: session.inferenceContextManifests.filter(isInferenceContextManifest).slice(-24).map((manifest) => ({ ...manifest, sessionId })) }
        : {}),
      ...(session.pinned !== undefined ? { pinned: session.pinned } : {}),
      ...(session.unverifiedChangesPending !== undefined ? { unverifiedChangesPending: session.unverifiedChangesPending } : {}),
      durableNotes: session.durableNotes,
      compactionProvenance: session.compactionProvenance,
      cognitiveRouting: session.cognitiveRouting,
      tokenStats: session.tokenStats,
      ...(session.lastTurn !== undefined ? { lastTurn: session.lastTurn } : {}),
      ...(session.objective !== undefined ? { objective: session.objective } : {}),
      ...(session.findings !== undefined ? { findings: session.findings } : {}),
      ...(session.verificationConfigAttempts !== undefined ? { verificationConfigAttempts: session.verificationConfigAttempts } : {}),
      ...(session.commandRuleDecisions !== undefined ? { commandRuleDecisions: session.commandRuleDecisions } : {}),
      ...(session.history !== undefined ? { history: session.history } : {}),
      ...(session.forkedFrom !== undefined ? { forkedFrom: session.forkedFrom } : {}),
    };

    this.stateManager.saveTaskState(fullState, selectedWorkspace ? [selectedWorkspace] : []);
    const committed = this.stateManager.loadTaskState(taskId, undefined, selectedWorkspace ? [selectedWorkspace] : []);
    this.updateIndexEntry({
      id: sessionId,
      cleanId: taskId.replace(/\.json$/, ""),
      title: committed.title || "Active Session",
      updatedAt: committed.updatedAt || new Date().toISOString(),
      workspace,
      messageCount: committed.messages.length,
      mtime: Date.now(),
      pinned: Boolean(committed.pinned),
    });
  }

  /**
   * Resolves a session ID by exact match or unique prefix (REQ-PER-104).
   * Throws AmbiguousSessionResumeError if a prefix matches multiple sessions.
   * Returns null if no matching session is found.
   */
  public resolveResumeId(prefix: string): string | null {
    return withStateStoreGuard(this.sessionsDir, () => this.resolveResumeIdLocked(prefix));
  }

  private resolveResumeIdLocked(prefix: string): string | null {
    const cleanId = prefix.replace(/\.json$/, "");
    if (!cleanId) return null;

    // 1. Exact match check against session file on disk
    const exactFilePath = path.join(this.sessionsDir, `${cleanId}.json`);
    if (fs.existsSync(exactFilePath)) {
      return cleanId;
    }

    if (!fs.existsSync(this.sessionsDir)) return null;

    // 2. Gather candidates for prefix matching
    const candidates = new Set<string>();
    const files = fs.readdirSync(this.sessionsDir);
    for (const file of files) {
      if (!file.endsWith(".json") || file === "index.json" || file.startsWith(".corrupt-")) continue;
      const id = file.replace(/\.json$/, "");
      if (id === cleanId) {
        return id;
      }
      if (id.startsWith(cleanId)) {
        candidates.add(id);
      }
    }

    // Also check index entries in case IDs differ
    const indexPath = this.getIndexPath();
    if (fs.existsSync(indexPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
        if (raw && typeof raw.sessions === "object") {
          for (const key of Object.keys(raw.sessions)) {
            const entry = raw.sessions[key];
            const sid = entry?.id || entry?.cleanId || key;
            if (sid === cleanId || key === cleanId) {
              return sid;
            }
            if (sid.startsWith(cleanId)) {
              candidates.add(sid);
            }
          }
        }
      } catch {}
    }

    const candidateList = Array.from(candidates).sort();
    if (candidateList.length === 1) {
      return candidateList[0];
    }
    if (candidateList.length > 1) {
      throw new AmbiguousSessionResumeError(cleanId, candidateList);
    }
    return null;
  }

  /**
   * Loads session with strict integrity and schema validation, migrating legacy session files if needed.
   */
  public loadSession(sessionId: string): SessionData | null {
    return withStateStoreGuard(this.sessionsDir, () => this.loadSessionLocked(sessionId));
  }

  private loadSessionLocked(sessionId: string): SessionData | null {
    const cleanId = sessionId.replace(/\.json$/, "");
    const targetId = this.resolveResumeId(cleanId);
    if (!targetId) {
      return null;
    }

    try {
      const workspacePath = this.workspacePathFromSessionFile(targetId);
      const state = this.stateManager.loadTaskState(
        targetId,
        undefined,
        workspacePath ? [workspacePath] : undefined
      );
      const session = state as SessionData;
      if (session.inferenceContextManifests !== undefined) {
        if (!Array.isArray(session.inferenceContextManifests) || session.inferenceContextManifests.length > 24 || !session.inferenceContextManifests.every(isInferenceContextManifest)) delete session.inferenceContextManifests;
        else session.inferenceContextManifests = markInterruptedInferenceManifestsUnknown(session.inferenceContextManifests);
      }
      // The inventory is diagnostic metadata, never execution authority. Ignore malformed or future-shaped optional
      // inventories without changing the backward-compatible session or promoting reconstructed facts to current.
      if (session.contextInventory !== undefined && !isContextInventorySnapshot(session.contextInventory)) delete session.contextInventory;
      else if (session.contextInventory) session.contextInventory = markPersistedContextFreshnessUnknown(session.contextInventory);
      return session;
    } catch (err: any) {
      if (
        err instanceof CorruptStateError ||
        err instanceof UnsupportedSchemaVersionError ||
        err instanceof AmbiguousSessionResumeError
      ) {
        throw err;
      }
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
    return withStateStoreGuard(this.sessionsDir, () => this.recoverSessionLocked(sessionId, options));
  }

  private recoverSessionLocked(
    sessionId: string,
    options?: TaskRecoveryOptions
  ): TaskRecoveryResult | null {
    const cleanId = sessionId.replace(/\.json$/, "");
    const targetId = this.resolveResumeId(cleanId);
    if (!targetId) {
      return null;
    }

    try {
      const workspacePath = this.workspacePathFromSessionFile(targetId);
      return this.stateManager.recoverTaskState(targetId, {
        ...options,
        workspacePaths: workspacePath ? [workspacePath] : undefined,
      });
    } catch (err: any) {
      if (
        err instanceof CorruptStateError ||
        err instanceof UnsupportedSchemaVersionError ||
        err instanceof AmbiguousSessionResumeError
      ) {
        throw err;
      }
      return null;
    }
  }

  /**
   * RD-6: forks a saved session into a new id holding its conversation up to `atMessage` (default: all of it). The
   * source is only read. The cut backs up to the last complete tool exchange. Compactions whose summary is still in the
   * kept conversation keep their record and archive lines (copied verbatim, so resume's audit still verifies them);
   * a compaction whose summary the cut removed is left out, rather than letting resume "undo" it into history the
   * operator did not choose. A bound source gets a new isolated worktree at the same branch and workspace snapshot.
   * The objective ledger is carried only by a fork of the whole conversation: it describes the source's later state,
   * which a truncated fork never reached.
   */
  public forkSession(sourceId: string, options: { atMessage?: number; newId?: string } = {}): {
    id: string; sourceId: string; atMessage: number; compactions: number; worktreePath?: string; branch?: string;
  } {
    return withStateStoreGuard(this.sessionsDir, () => {
      const source = this.loadSession(sourceId);
      if (!source) throw new Error(`Session not found: ${sourceId}`);
      const total = source.messages.length;
      const asked = options.atMessage ?? total;
      if (!Number.isInteger(asked) || asked < 1 || asked > total) throw new Error(`The fork point must be a whole number between 1 and ${total}.`);
      const atMessage = completeExchangePrefix(source.messages, asked);
      const whole = atMessage === total;
      const messages = source.messages.slice(0, atMessage);
      const id = options.newId ?? this.generateSessionId();
      if (!/^[A-Za-z0-9._-]{1,160}$/.test(id) || id === "." || id === "..") throw new Error("The new session id is not a safe persistence name.");
      if (this.stateManager.hasTaskState(id) || fs.existsSync(this.archivedHistoryPath(id))) throw new Error(`Session ${id} already exists.`);

      let forkWorktree: { manager: WorktreeManager; taskId: string; worktreePath: string; branch: string; createdAt: string } | undefined;
      const committed: string[] = Array.isArray((source.history as any)?.committedCompactions) ? (source.history as any).committedCompactions.filter((c: unknown): c is string => typeof c === "string") : [];
      const read = this.readArchivedHistory(source.id, new Set(committed));
      const kept = committed.filter((c) => {
        const record = read.byCompaction?.get(c)?.record;
        return !isCompactionRecord(record) || insertedBlockPresent(record, messages);
      });
      // The archive goes first: a record never names a compaction whose originals are not already on disk.
      const keep = new Set(kept);
      const lines: string[] = [];
      let archivedMessages = 0;
      let raw = "";
      try { raw = fs.readFileSync(this.archivedHistoryPath(source.id), "utf8"); } catch {}
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let parsed: { compactionId?: string };
        try { parsed = JSON.parse(line); } catch { continue; }
        if (parsed.compactionId !== undefined && !keep.has(parsed.compactionId)) continue;
        lines.push(line);
        archivedMessages++;
      }
      const at = new Date().toISOString();
      const archivePath = this.archivedHistoryPath(id);
      try {
        if (source.worktreeBinding) {
          const manager = new WorktreeManager(source.worktreeBinding.worktreePath);
          const created = manager.createSessionForkWorktree(source.worktreeBinding, id);
          forkWorktree = { manager, taskId: created.taskId, worktreePath: created.worktreePath, branch: created.branch, createdAt: new Date().toISOString() };
        }
        if (lines.length) appendLinesDurably(archivePath, lines);
        this.saveSessionLocked({
          id,
          title: `Fork of ${source.title || "session"}`.slice(0, 120),
          workspace: source.workspace,
          model: source.model,
          ...(source.endpoint ? { endpoint: source.endpoint } : {}),
          messages,
          ...(forkWorktree ? { worktreeBinding: {
            taskId: forkWorktree.taskId,
            worktreePath: forkWorktree.worktreePath,
            branch: forkWorktree.branch,
            createdAt: forkWorktree.createdAt,
            kind: "task" as const,
            bindingVersion: WORKTREE_BINDING_VERSION,
          } } : {}),
          history: { complete: kept.length === 0, compactions: kept.length, archivedMessages, committedCompactions: kept } as any,
          ...(source.findings !== undefined ? { findings: source.findings } : {}),
          ...(source.durableNotes !== undefined ? { durableNotes: source.durableNotes } : {}),
          ...(source.activePlan ? { activePlan: source.activePlan } : {}),
          ...(whole && source.objective !== undefined ? { objective: source.objective } : {}),
          forkedFrom: { sessionId: source.id, atMessage, at },
        }, undefined, forkWorktree ? WorkspacePath.fromSelectedWorkspace(forkWorktree.manager.getGitRoot()) : undefined);
      } catch (err) {
        if (this.stateManager.hasTaskState(id)) {
          throw new Error(`Fork ${id} was durably saved but could not be fully indexed; its workspace is preserved. ${err instanceof Error ? err.message : String(err)}`);
        }
        try { fs.rmSync(archivePath, { force: true }); } catch {}
        if (forkWorktree) {
          const removed = forkWorktree.manager.discardWorktree(forkWorktree.taskId);
          if (!removed.success) throw new Error(`Fork could not be saved and its worktree cleanup failed: ${removed.error || "unknown error"}`);
        }
        throw err;
      }
      return {
        id, sourceId: source.id, atMessage, compactions: kept.length,
        ...(forkWorktree ? { worktreePath: forkWorktree.worktreePath, branch: forkWorktree.branch } : {}),
      };
    });
  }

  /** Archive of messages context compaction replaced in this session (redacted JSON lines beside the record). */
  public archivedHistoryPath(sessionId: string): string {
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(sessionId)) throw new Error("Session identity is not a safe persistence name");
    return path.join(this.sessionsDir, `${sessionId}.history.jsonl`);
  }

  /** Where the complete diff of one file operation in this session is kept (redacted; mode 0600). */
  public operationDiffPath(sessionId: string, name: string): string {
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(sessionId) || !/^[A-Za-z0-9._-]{1,160}$/.test(name)) {
      throw new Error("Session identity is not a safe persistence name");
    }
    return path.join(this.sessionsDir, `${sessionId}.diffs`, `${name}.diff`);
  }

  /**
   * Appends the originals one compaction replaced, durably (fsync), tagged with the compaction's id. Written before any
   * record names the compaction as committed (see core/durable_file.ts).
   */
  public appendArchivedHistory(sessionId: string, messages: ChatMessage[], compactionId?: string, record?: unknown): void {
    if (!messages.length) return;
    withStateStoreGuard(this.sessionsDir, () => {
      const at = new Date().toISOString();
      const lines = protectArchivedMessages(messages).map((message, index) => JSON.stringify({ archivedAt: at, ...(compactionId ? { compactionId } : {}), ...(index === 0 && record !== undefined ? { record } : {}), message }));
      appendLinesDurably(this.archivedHistoryPath(sessionId), lines);
    });
  }

  /**
   * The archived originals, oldest first; empty when there is no archive. Unreadable lines are counted, not hidden.
   * With `committed` (the compaction ids the session record names), lines of compactions the record never committed are
   * set aside and counted, and committed compactions with no line are listed as missing.
   */
  public readArchivedHistory(sessionId: string, committed?: ReadonlySet<string>): ArchiveRead<ChatMessage> {
    return withStateStoreGuard(this.sessionsDir, () => readArchiveLines<ChatMessage>(this.archivedHistoryPath(sessionId), committed));
  }

  public getLatestSession(): SessionData | null {
    const list = this.listSessions();
    if (list.length === 0) return null;
    return this.loadSession(list[0].id);
  }

  public getSessionsDir(): string {
    return this.sessionsDir;
  }

  public getIndexPath(): string {
    return path.join(this.sessionsDir, "index.json");
  }

  private updateIndexEntry(entry: {
    id: string;
    cleanId: string;
    title: string;
    updatedAt: string;
    workspace: string;
    messageCount: number;
    mtime: number;
    pinned?: boolean;
  }): void {
    try {
      const indexPath = this.getIndexPath();
      let index: SessionIndexData | null = null;
      if (fs.existsSync(indexPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
          if (raw && raw.version === 1 && typeof raw.sessions === "object") {
            index = raw as SessionIndexData;
          }
        } catch {}
      }
      if (!index) {
        index = { version: 1, updatedAt: new Date().toISOString(), sessions: {} };
      }
      index.sessions[entry.cleanId] = entry;
      index.updatedAt = new Date().toISOString();
      writePrivateFile(indexPath, JSON.stringify(index, null, 2));
    } catch {
      // index update failure should not break session save
    }
  }

  public rebuildIndex(): SessionIndexData {
    return withStateStoreGuard(this.sessionsDir, () => this.rebuildIndexLocked());
  }

  private rebuildIndexLocked(): SessionIndexData {
    const indexPath = this.getIndexPath();
    const index: SessionIndexData = {
      version: 1,
      updatedAt: new Date().toISOString(),
      sessions: {},
    };

    if (!fs.existsSync(this.sessionsDir)) return index;

    const files = fs.readdirSync(this.sessionsDir);
    for (const file of files) {
      if (!file.endsWith(".json") || file === "index.json" || file.startsWith(".corrupt-")) continue;
      const cleanId = file.replace(/\.json$/, "");
      const fullPath = path.join(this.sessionsDir, file);
      try {
        const stat = fs.statSync(fullPath);
        const content = fs.readFileSync(fullPath, "utf-8");
        const data = JSON.parse(content);
        index.sessions[cleanId] = {
          id: data.sessionId || data.taskId || data.id || cleanId,
          cleanId,
          title: data.title || "Untitled Session",
          updatedAt: data.updatedAt || stat.mtime.toISOString(),
          workspace: data.workspacePath || data.workspace || "~",
          messageCount: data.schemaVersion === 2 ? (data.messageLog?.count ?? 0) : (Array.isArray(data.messages) ? data.messages.length : 0),
          mtime: stat.mtimeMs,
          pinned: Boolean(data.pinned),
        };
      } catch {
        // ignore corrupted files in index
      }
    }

    try {
      writePrivateFile(indexPath, JSON.stringify(index, null, 2));
    } catch {}

    return index;
  }

  public listSessions(): Array<{
    id: string;
    title: string;
    updatedAt: string;
    workspace: string;
    messageCount: number;
    pinned?: boolean;
  }> {
    return withStateStoreGuard(this.sessionsDir, () => this.listSessionsLocked());
  }

  private listSessionsLocked(): Array<{
    id: string;
    title: string;
    updatedAt: string;
    workspace: string;
    messageCount: number;
    pinned?: boolean;
  }> {
    if (!fs.existsSync(this.sessionsDir)) return [];

    const indexPath = this.getIndexPath();
    let index: SessionIndexData | null = null;

    if (fs.existsSync(indexPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
        if (raw && raw.version === 1 && typeof raw.sessions === "object") {
          index = raw as SessionIndexData;
        }
      } catch {
        index = null; // Rebuild on miss/corrupt
      }
    }

    const files = fs.readdirSync(this.sessionsDir);
    const sessionFiles = new Set<string>();
    for (const f of files) {
      if (f.endsWith(".json") && f !== "index.json" && !f.startsWith(".corrupt-")) {
        sessionFiles.add(f);
      }
    }

    if (!index) {
      index = this.rebuildIndex();
    } else {
      let dirty = false;
      // Remove deleted
      for (const key of Object.keys(index.sessions)) {
        if (!sessionFiles.has(`${key}.json`)) {
          delete index.sessions[key];
          dirty = true;
        }
      }
      // Check for new or updated files
      for (const file of sessionFiles) {
        const cleanId = file.replace(/\.json$/, "");
        const existing = index.sessions[cleanId];
        const fullPath = path.join(this.sessionsDir, file);
        try {
          const stat = fs.statSync(fullPath);
          if (!existing || stat.mtimeMs > existing.mtime) {
            const content = fs.readFileSync(fullPath, "utf-8");
            const data = JSON.parse(content);
            index.sessions[cleanId] = {
              id: data.sessionId || data.taskId || data.id || cleanId,
              cleanId,
              title: data.title || "Untitled Session",
              updatedAt: data.updatedAt || stat.mtime.toISOString(),
              workspace: data.workspacePath || data.workspace || "~",
              messageCount: data.schemaVersion === 2 ? (data.messageLog?.count ?? 0) : (Array.isArray(data.messages) ? data.messages.length : 0),
              mtime: stat.mtimeMs,
              pinned: Boolean(data.pinned),
            };
            dirty = true;
          }
        } catch {}
      }

      if (dirty) {
        try {
          index.updatedAt = new Date().toISOString();
          writePrivateFile(indexPath, JSON.stringify(index, null, 2));
        } catch {}
      }
    }

    const sessionList: SessionIndexEntry[] = Object.values(index.sessions);
    return sessionList
      .sort((a, b) => b.mtime - a.mtime)
      .map(({ mtime, cleanId, ...rest }) => rest);
  }

  private workspacePathFromSessionFile(taskId: string): WorkspacePath | undefined {
    const selected = this.currentSelectedWorkspace();
    if (!selected) return undefined;
    selected.assertCurrent();
    const filePath = this.stateManager.getStateFilePath(taskId);
    if (!fs.existsSync(filePath)) return selected;
    let raw: any;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return selected;
    }
    const value = raw?.workspacePath || raw?.workspace;
    if (typeof value !== "string") throw new Error("Session record has no workspace identity");
    if (selected.matches(value) && (!raw?.workspacePath || raw.workspacePath === selected.value) &&
        (!raw?.workspace || raw.workspace === selected.value)) {
      this.stateManager.setWorkspacePaths([selected]);
      return selected;
    }

    // A session can be opened from another checkout of the same repository. Accept that only when its durable
    // worktree binding proves a live Nexus-managed checkout owned by this repository's main checkout.
    const binding = raw?.worktreeBinding;
    if (binding && typeof binding.worktreePath === "string" && typeof raw?.taskId === "string") {
      const manager = new WorktreeManager(selected.value);
      const repository = WorkspacePath.fromSelectedWorkspace(manager.getGitRoot());
      const validBinding = isManagedWorktreePath(repository, binding.worktreePath, raw.taskId, binding)
        || isNamedWorktreePath(repository, binding.worktreePath, binding);
      if (repository.matches(value) && (!raw?.workspacePath || raw.workspacePath === value)
          && (!raw?.workspace || raw.workspace === value) && validBinding) {
        this.stateManager.setWorkspacePaths([selected, repository]);
        return repository;
      }
    }
    throw new Error("Session workspace does not match the application's selected workspace or a valid bound worktree in that repository");
  }

  private currentSelectedWorkspace(): WorkspacePath | undefined {
    return this.selectedWorkspace?.();
  }
}
